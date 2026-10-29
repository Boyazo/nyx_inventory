// Nyx Dashboard — "sign in with PIN": a personal, randomly assigned 6-digit code.
//
// Security model (PINs work from any computer, so guessing is what we defend against):
//  • PINs are unique; only an HMAC keyed with the service-role key is stored, so the database
//    never holds a readable PIN and a PIN is found without scanning everyone.
//  • Members may choose their own PIN. Obvious ones (000000, 123456, 121212…) are refused, and a
//    member can try at most 5 chosen PINs an hour. If a chosen PIN is already someone else's, the
//    request is refused AND that other PIN is cleared, so "that PIN is taken" never reveals a PIN
//    that still works.
//  • Per connection: 5 wrong PINs within 15 minutes locks that connection out for 15 minutes.
//  • Site-wide: more than 40 wrong PINs in an hour pauses PIN sign-in for 30 minutes (email and
//    password keep working), so spreading guesses across many connections doesn't pay off.
//  • Admins manage their own PINs. No other member, including another admin, may set or
//    remove an admin's PIN, since assigning one would allow signing in as that admin.
//  • A successful PIN returns a one-time Supabase magic-link token hash; the browser exchanges it
//    with verifyOtp() for a normal session. Nothing reusable is returned.
//
// Actions (POST JSON { action, ... }):
//   login       { pin }                                        → { token_hash, email, name }
//   set_code    { user_id?, pin? }  (self, or admin/moderator for others) → { code }   shown once
//               pin = the member's own choice (self only); without it a random PIN is made
//   clear_code  { user_id? }  (self, or admin/moderator)       → { ok }
//   status      {}            (signed-in member)               → { has_code, is_admin }
//
// Deploy: supabase functions deploy quick-login --no-verify-jwt   (login has no session yet)

import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const IP_MAX_FAILS = 5, IP_WINDOW_MS = 15 * 60_000, IP_LOCK_MS = 15 * 60_000;
const ALL_MAX_FAILS = 40, ALL_WINDOW_MS = 60 * 60_000, ALL_LOCK_MS = 30 * 60_000;
const CHOOSE_MAX = 5, CHOOSE_WINDOW_MS = 60 * 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

let hmacKey: CryptoKey | null = null;
async function codeHmac(code: string) {
  hmacKey ??= await crypto.subtle.importKey("raw", new TextEncoder().encode("nyx-quick-login:" + SERVICE), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(code)));
}
function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}

/* Easy-to-guess PINs: one digit repeated, a run up or down, or a repeated 2- or 3-digit pattern */
function isWeakPin(p: string) {
  if (/^(\d)\1{5}$/.test(p)) return true;
  const d = [...p].map(Number);
  const step = d[1] - d[0];
  if (Math.abs(step) === 1 && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return true;
  if (p === p.slice(0, 2).repeat(3) || p === p.slice(0, 3).repeat(2)) return true;
  return false;
}

/* The signed-in caller, from their Supabase session (Authorization header) */
async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const userClient = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data } = await userClient.auth.getUser();
  if (!data?.user) return null;
  const { data: p } = await db.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
  if (!p?.is_approved) return null;
  return { id: data.user.id, email: data.user.email, name: p.full_name as string, is_admin: !!p.is_admin, is_staff: !!(p.is_admin || p.is_moderator) };
}

async function log(user_id: string | null, user_name: string, action: string, details: Record<string, unknown>) {
  await db.from("activity_logs").insert({ action, entity_type: "quick_login", entity_id: null, user_id, user_name, details });
}

/* ---------- throttling ---------- */
async function bucket(key: string) {
  const { data } = await db.from("pin_attempts").select("*").eq("key", key).maybeSingle();
  return data || { key, failed_count: 0, window_start: null, locked_until: null };
}
const lockedFor = (b: any, now: number) => (b.locked_until && new Date(b.locked_until).getTime() > now ? new Date(b.locked_until).getTime() - now : 0);
async function recordFail(b: any, now: number, max: number, windowMs: number, lockMs: number) {
  const fresh = !b.window_start || now - new Date(b.window_start).getTime() > windowMs;
  const count = fresh ? 1 : b.failed_count + 1;
  await db.from("pin_attempts").upsert({
    key: b.key, failed_count: count,
    window_start: fresh ? new Date(now).toISOString() : b.window_start,
    locked_until: count >= max ? new Date(now + lockMs).toISOString() : null,
  });
  return count >= max;
}
const mins = (ms: number) => `${Math.ceil(ms / 60000)} minute${Math.ceil(ms / 60000) === 1 ? "" : "s"}`;

/* ---------- sign in with PIN ---------- */
async function login(req: Request, body: any) {
  const pin = String(body.pin ?? body.code ?? "").replace(/\D/g, "");
  if (pin.length !== 6) return json({ error: "Enter your 6-digit PIN." }, 400);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
  const now = Date.now();
  const [mine, all] = await Promise.all([bucket("ip:" + (await sha256(ip)).slice(0, 32)), bucket("all")]);
  const wait = Math.max(lockedFor(mine, now), lockedFor(all, now));
  if (wait) return json({ error: lockedFor(all, now) ? `PIN sign-in is paused for ${mins(wait)}. Use your email and password.` : `Too many wrong PINs. Try again in ${mins(wait)}.` }, 429);

  const fail = async () => {
    const [ipLocked, allLocked] = await Promise.all([
      recordFail(mine, now, IP_MAX_FAILS, IP_WINDOW_MS, IP_LOCK_MS),
      recordFail(all, now, ALL_MAX_FAILS, ALL_WINDOW_MS, ALL_LOCK_MS),
    ]);
    if (allLocked && !lockedFor(all, now)) await log(null, "PIN sign-in", "PIN_LOGIN_PAUSED", { reason: "too many wrong PINs site-wide" });
    return json({ error: ipLocked ? "Too many wrong PINs. Try again in 15 minutes." : "That PIN didn't match. Try again." }, 401);
  };

  const { data: row } = await db.from("quick_login_codes").select("user_id").eq("code_hmac", await codeHmac(pin)).maybeSingle();
  if (!row) return fail();
  const { data: p } = await db.from("profiles").select("*").eq("id", row.user_id).maybeSingle();
  if (!p?.is_approved) return fail();
  const { data: u, error: uErr } = await db.auth.admin.getUserById(row.user_id);
  if (uErr || !u?.user?.email) return json({ error: "Couldn't sign you in." }, 500);
  const { data: link, error: lErr } = await db.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
  if (lErr || !link?.properties?.hashed_token) return json({ error: "Couldn't sign you in." }, 500);

  await Promise.all([
    db.from("pin_attempts").delete().eq("key", mine.key),
    db.from("quick_login_codes").update({ last_used_at: new Date().toISOString() }).eq("user_id", row.user_id),
    log(row.user_id, p.full_name, "PIN_LOGIN", {}),
  ]);
  return json({ token_hash: link.properties.hashed_token, email: u.user.email, name: p.full_name });
}

/* ---------- codes ---------- */
async function setCode(req: Request, body: any) {
  const me = await caller(req);
  if (!me) return json({ error: "Sign in first." }, 401);
  const target = body.user_id && body.user_id !== me.id ? String(body.user_id) : me.id;
  if (target !== me.id && !me.is_staff) return json({ error: "Only admins and moderators can set codes for others." }, 403);

  const { data: tp } = await db.from("profiles").select("*").eq("id", target).maybeSingle();
  if (!tp?.is_approved) return json({ error: "That member isn't approved yet." }, 400);
  if (tp.is_admin && target !== me.id) return json({ error: "Admins can only manage their own PIN." }, 403);

  if (body.pin !== undefined && body.pin !== null && body.pin !== "") {
    if (target !== me.id) return json({ error: "Members choose their own PIN. For someone else, make a random one." }, 403);
    const pin = String(body.pin).replace(/\D/g, "");
    if (pin.length !== 6) return json({ error: "A PIN is exactly 6 digits." }, 400);
    if (isWeakPin(pin)) return json({ error: "That PIN is too easy to guess. Avoid repeats and runs like 123456." }, 400);

    const now = Date.now();
    const b = await bucket("set:" + me.id);
    const wait = lockedFor(b, now);
    if (wait) return json({ error: `Too many PIN changes. Try again in ${mins(wait)}.` }, 429);
    await recordFail(b, now, CHOOSE_MAX, CHOOSE_WINDOW_MS, CHOOSE_WINDOW_MS);   // counts every chosen PIN, kept or not

    const h = await codeHmac(pin);
    const { data: clash } = await db.from("quick_login_codes").select("user_id").eq("code_hmac", h).maybeSingle();
    if (clash && clash.user_id !== target) {
      await db.from("quick_login_codes").delete().eq("user_id", clash.user_id);
      await log(me.id, me.name, "PIN_CLASH_CLEARED", { reason: "a chosen PIN matched another member's, so theirs was cleared" });
      return json({ error: "That PIN can't be used. Pick a different one." }, 409);
    }
    const { error } = await db.from("quick_login_codes").upsert({
      user_id: target, code_hmac: h, created_at: new Date().toISOString(), last_used_at: null, created_by_name: me.name,
    });
    if (error) return json({ error: /duplicate|unique/i.test(error.message) ? "That PIN can't be used. Pick a different one." : error.message }, 409);
    await log(me.id, me.name, "PIN_SET", { member_name: tp.full_name, by_self: true, chosen: true });
    return json({ code: pin, name: tp.full_name, chosen: true });
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    const { error } = await db.from("quick_login_codes").upsert({
      user_id: target, code_hmac: await codeHmac(code), created_at: new Date().toISOString(), last_used_at: null, created_by_name: me.name,
    });
    if (!error) {
      await log(me.id, me.name, "PIN_SET", { member_name: tp.full_name, by_self: target === me.id });
      return json({ code, name: tp.full_name });
    }
    if (!/duplicate|unique/i.test(error.message)) return json({ error: error.message }, 500);   // collision → try another
  }
  return json({ error: "Couldn't find a free code, try again." }, 500);
}

async function clearCode(req: Request, body: any) {
  const me = await caller(req);
  if (!me) return json({ error: "Sign in first." }, 401);
  const target = body.user_id && body.user_id !== me.id ? String(body.user_id) : me.id;
  if (target !== me.id && !me.is_staff) return json({ error: "Only admins and moderators can remove codes for others." }, 403);
  if (target !== me.id) {
    const { data: tp, error } = await db.from("profiles").select("*").eq("id", target).maybeSingle();
    if (error || !tp) return json({ error: "Couldn't verify that member." }, 400);
    if (tp.is_admin) return json({ error: "Admins can only manage their own PIN." }, 403);
  }
  await db.from("quick_login_codes").delete().eq("user_id", target);
  await log(me.id, me.name, "PIN_REMOVED", { target });
  return json({ ok: true });
}

async function status(req: Request) {
  const me = await caller(req);
  if (!me) return json({ error: "Sign in first." }, 401);
  const { data } = await db.from("quick_login_codes").select("created_at, last_used_at").eq("user_id", me.id).maybeSingle();
  return json({ has_code: !!data, created_at: data?.created_at || null, last_used_at: data?.last_used_at || null, is_admin: me.is_admin });
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  try {
    switch (body.action) {
      case "login": return await login(req, body);
      case "set_code": return await setCode(req, body);
      case "clear_code": return await clearCode(req, body);
      case "status": return await status(req);
      default: return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    console.error(err);
    return json({ error: "Something went wrong." }, 500);
  }
});
