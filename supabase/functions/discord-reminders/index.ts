// NYX 11744 — Discord shift reminder bot.
//
// Runs every 15 minutes (pg_cron → supabase/discord_reminders.sql) and posts to a Discord channel
// through a webhook, @mentioning members who saved their Discord user id in their profile:
//   • Morning schedule:  once a day at DIGEST_HOUR (Pacific) — today's shifts + who's on, tomorrow preview
//   • Heads-up:          REMINDER_LEAD_MINUTES before each shift starts, pinging that shift's roster
//   • New assignments:   when someone is added to an upcoming shift (by an admin, Claude, or themselves)
// Each message is sent once; keys are recorded in public.shift_notifications.
//
// Secrets (supabase secrets set …):
//   DISCORD_WEBHOOK_URL   Channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL
//   CRON_SECRET           any long random string; the cron job sends it in the x-cron-secret header
// Optional: DIGEST_HOUR (default 7), REMINDER_LEAD_MINUTES (default 120), SITE_URL
// Optional auto-linking of Discord IDs by server nickname (needs a bot in the server):
//   DISCORD_BOT_TOKEN     Developer Portal → your app → Bot → Reset Token (enable "Server Members Intent")
//   DISCORD_GUILD_ID      the server id (right-click server icon → Copy Server ID)
//   Members whose profile has no Discord ID are matched by nickname: full name, then unique first
//   name, then first name + last initial when first names repeat. Manually entered IDs always win.
//
// Deploy: supabase functions deploy discord-reminders --no-verify-jwt
// Manual test: POST …/discord-reminders?mode=test   (posts a test message)
//              POST …/discord-reminders?dry=1       (returns what it would post, sends nothing)

import { createClient } from "npm:@supabase/supabase-js@2";

const TZ = "America/Los_Angeles";
const WEBHOOK = Deno.env.get("DISCORD_WEBHOOK_URL") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const DIGEST_HOUR = Number(Deno.env.get("DIGEST_HOUR") ?? 7);
const LEAD_MIN = Number(Deno.env.get("REMINDER_LEAD_MINUTES") ?? 120);
const SITE_URL = Deno.env.get("SITE_URL") || "https://boyazo.github.io/nyx_inventory/";
const BOT_TOKEN = Deno.env.get("DISCORD_BOT_TOKEN") || "";
const GUILD_ID = Deno.env.get("DISCORD_GUILD_ID") || "";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type Shift = {
  id: string; title: string; department: string; shift_date: string; start_time: string; end_time: string;
  location: string; attendees: string[]; notes: string;
};
type Post = { content: string; users: string[] };

/* ---------- time helpers (all shift times are Pacific wall-clock) ---------- */

function pacificNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map(p => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), hour: Number(parts.hour) };
}
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const addDays = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
};
const fmtTime = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const fmtDate = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const cleanNotes = (n: string) => (n || "").replace("[🔁 Weekly Shift]", "").trim();

/* ---------- formatting ---------- */

function mentionFor(names: string[], ids: Map<string, string>) {
  const users: string[] = [];
  const text = names.map(n => {
    const id = ids.get(n.trim().toLowerCase());
    if (id) { users.push(id); return `<@${id}>`; }
    return `**${n}**`;
  }).join(", ");
  return { text, users };
}

function shiftLine(s: Shift, ids: Map<string, string>) {
  const who = s.attendees?.length ? mentionFor(s.attendees, ids) : { text: "⚠️ *nobody scheduled yet*", users: [] };
  return {
    text: `**${s.title}** · ${s.department}\n🕒 ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · 📍 ${s.location || "Main Shop"}\n👥 ${who.text}`,
    users: who.users,
  };
}

/* ---------- discord ---------- */

function chunk(post: Post): Post[] {
  if (post.content.length <= 1900) return [post];
  const out: Post[] = [];
  let cur = "";
  for (const block of post.content.split("\n\n")) {
    if ((cur + "\n\n" + block).length > 1900 && cur) { out.push({ content: cur, users: post.users }); cur = block; }
    else cur = cur ? cur + "\n\n" + block : block;
  }
  if (cur) out.push({ content: cur, users: post.users });
  return out;
}

async function send(post: Post) {
  for (const part of chunk(post)) {
    const users = [...new Set(part.users)].filter(u => part.content.includes(`<@${u}>`)).slice(0, 100);
    const res = await fetch(WEBHOOK + (WEBHOOK.includes("?") ? "&" : "?") + "wait=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "NYX Shift Bot",
        content: part.content,
        allowed_mentions: { parse: [], users }, // only ping the people on the shift
      }),
    });
    if (res.status === 429) {
      const retry = Number((await res.json()).retry_after || 1);
      await new Promise(r => setTimeout(r, retry * 1000));
      await send(part);
    } else if (!res.ok) {
      throw new Error(`Discord webhook failed (${res.status}): ${await res.text()}`);
    }
  }
}

/* ---------- auto-link Discord IDs from server nicknames ---------- */

const nameWords = (s: string) => String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

async function fetchGuildMembers() {
  const members: { id: string; names: string[][] }[] = [];
  let after = "0";
  for (let page = 0; page < 10; page++) {
    const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000&after=${after}`, {
      headers: { Authorization: `Bot ${BOT_TOKEN}` },
    });
    if (!res.ok) throw new Error(`Discord member list failed (${res.status}) — is "Server Members Intent" enabled for the bot? ${await res.text()}`);
    const batch = await res.json();
    for (const m of batch) {
      if (m.user?.bot) continue;
      const names = [m.nick, m.user?.global_name, m.user?.username].filter(Boolean).map(nameWords).filter(w => w.length);
      members.push({ id: m.user.id, names });
    }
    if (batch.length < 1000) break;
    after = batch[batch.length - 1].user.id;
  }
  return members;
}

/* Returns profile id -> discord id for confident matches only */
export function matchByNickname(
  profiles: { id: string; full_name: string }[],
  members: { id: string; names: string[][] }[],
) {
  const out = new Map<string, string>();
  const firstOf = (w: string[]) => w[0] || "";
  const profileFirstCount = new Map<string, number>();
  for (const p of profiles) { const f = firstOf(nameWords(p.full_name)); profileFirstCount.set(f, (profileFirstCount.get(f) || 0) + 1); }
  const unique = (ids: string[]) => { const u = [...new Set(ids)]; return u.length === 1 ? u[0] : null; };

  for (const p of profiles) {
    const pw = nameWords(p.full_name);
    if (!pw.length) continue;
    const [first, ...rest] = pw;
    const lastInitial = rest.length ? rest[rest.length - 1][0] : "";

    // 1. full name (all words, in order)
    let id = unique(members.filter(m => m.names.some(n => n.join(" ") === pw.join(" "))).map(m => m.id));

    // 2. unique first name on both sides
    if (!id && profileFirstCount.get(first) === 1) {
      const sameFirst = members.filter(m => m.names.some(n => firstOf(n) === first));
      if (new Set(sameFirst.map(m => m.id)).size === 1) id = sameFirst[0].id;
    }

    // 3. duplicate first names: first name + last initial ("Raymond L", "Raymond L.", "Raymond Liu")
    if (!id && lastInitial) {
      id = unique(members.filter(m => m.names.some(n => firstOf(n) === first && n.length > 1 && n[n.length - 1][0] === lastInitial)).map(m => m.id));
    }

    if (id) out.set(p.id, id);
  }

  // Never give one Discord account to two profiles
  const counts = new Map<string, number>();
  for (const id of out.values()) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [pid, id] of out) if ((counts.get(id) || 0) > 1) out.delete(pid);
  return out;
}

async function autoLinkDiscordIds(profiles: { id: string; full_name: string; discord_id: string }[]) {
  if (!BOT_TOKEN || !GUILD_ID) return [];
  const missing = profiles.filter(p => !p.discord_id);
  if (!missing.length) return [];
  const taken = new Set(profiles.map(p => p.discord_id).filter(Boolean));
  const members = (await fetchGuildMembers()).filter(m => !taken.has(m.id));
  const matches = matchByNickname(missing, members);
  const linked: string[] = [];
  for (const [pid, did] of matches) {
    const { error } = await db.from("profiles").update({ discord_id: did }).eq("id", pid).eq("discord_id", "");
    if (!error) {
      const p = missing.find(x => x.id === pid)!;
      p.discord_id = did;
      linked.push(p.full_name);
    }
  }
  return linked;
}

/* ---------- main ---------- */

/* Keys sent in the last 45 days (older ones are pruned; the window covers every key we can still need) */
async function loadSentKeys() {
  const since = new Date(Date.now() - 45 * 86400_000).toISOString();
  await db.from("shift_notifications").delete().lt("sent_at", since);
  const sent = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("shift_notifications").select("key").range(from, from + 999);
    if (error) throw error;
    (data || []).forEach(r => sent.add(r.key));
    if (!data || data.length < 1000) return sent;
  }
}
async function markSent(keys: string[]) {
  if (keys.length) await db.from("shift_notifications").upsert(keys.map(key => ({ key })), { ignoreDuplicates: true });
}

async function run(dry: boolean) {
  const now = pacificNow();
  const tomorrow = addDays(now.date, 1);

  const [{ data: shifts, error: sErr }, { data: profiles, error: pErr }] = await Promise.all([
    db.from("team_shifts").select("id, title, department, shift_date, start_time, end_time, location, attendees, notes")
      .gte("shift_date", now.date).lte("shift_date", addDays(now.date, 21)).order("shift_date").order("start_time"),
    db.from("profiles").select("id, full_name, discord_id").eq("is_approved", true),
  ]);
  if (sErr) throw sErr;
  if (pErr) throw pErr;

  let linked: string[] = [];
  try {
    linked = dry ? [] : await autoLinkDiscordIds(profiles || []);
  } catch (err) {
    console.error("Discord auto-link skipped:", (err as Error).message);
  }

  const ids = new Map<string, string>();
  for (const p of profiles || []) if (p.discord_id) ids.set(p.full_name.trim().toLowerCase(), p.discord_id);

  const all = (shifts || []) as Shift[];
  const sent = await loadSentKeys();
  const posts: { key: string[]; post: Post }[] = [];

  // 1. Morning schedule
  const digestKey = `digest:${now.date}`;
  if (now.hour >= DIGEST_HOUR && !sent.has(digestKey)) {
    const today = all.filter(s => s.shift_date === now.date);
    const tmrw = all.filter(s => s.shift_date === tomorrow);
    if (today.length || tmrw.length) {
      const users: string[] = [];
      const blocks = [`☀️ **NYX Shift Schedule — ${fmtDate(now.date)}**`];
      if (today.length) {
        for (const s of today) { const l = shiftLine(s, ids); users.push(...l.users); blocks.push(l.text); }
      } else {
        blocks.push("No shifts today.");
      }
      if (tmrw.length) {
        blocks.push(`**Tomorrow (${fmtDate(tomorrow)}):** ` + tmrw.map(s => `${s.title} ${fmtTime(s.start_time)} (${s.attendees?.length || 0} on)`).join(" · "));
      }
      blocks.push(`Sign up or swap: <${SITE_URL}>`);
      posts.push({ key: [digestKey], post: { content: blocks.join("\n\n"), users } });
    } else {
      posts.push({ key: [digestKey], post: { content: "", users: [] } }); // nothing to say; still mark the day done
    }
  }

  // 2. Heads-up before each shift (key includes date+time so a rescheduled shift reminds again)
  const soon = all.filter(s => {
    if (s.shift_date !== now.date) return false;
    const until = toMin(s.start_time) - now.minutes;
    return until > 0 && until <= LEAD_MIN;
  });
  const soonKeys = soon.map(s => `reminder:${s.id}:${s.shift_date}:${s.start_time}`);
  soon.forEach((s, i) => {
    if (sent.has(soonKeys[i]) || !s.attendees?.length) return;
    const mins = toMin(s.start_time) - now.minutes;
    const when = mins >= 90 ? `in about ${Math.round(mins / 60)} hours` : `in ${mins} minutes`;
    const l = shiftLine(s, ids);
    const notes = cleanNotes(s.notes);
    posts.push({ key: [soonKeys[i]], post: { content: `⏰ **Shift starting ${when}!**\n${l.text}${notes ? `\n📝 ${notes}` : ""}`, users: l.users } });
  });

  // 3. Newly scheduled people on upcoming shifts
  const assignKeys: string[] = [];
  const byShift = new Map<string, { s: Shift; names: string[] }>();
  for (const s of all) for (const n of s.attendees || []) {
    const k = `assigned:${s.id}:${n.trim().toLowerCase()}`;
    assignKeys.push(k);
    byShift.set(k, { s, names: [n] });
  }
  const anyAssigned = [...sent].some(k => k.startsWith("assigned:"));
  const fresh = assignKeys.filter(k => !sent.has(k));

  if (!anyAssigned) {
    // First run: record the existing roster quietly instead of pinging everyone at once
    if (fresh.length) posts.push({ key: fresh, post: { content: "", users: [] } });
  } else if (fresh.length) {
    const grouped = new Map<string, { s: Shift; names: string[]; keys: string[] }>();
    for (const k of fresh) {
      const { s, names } = byShift.get(k)!;
      const g = grouped.get(s.id) || { s, names: [], keys: [] };
      g.names.push(...names); g.keys.push(k);
      grouped.set(s.id, g);
    }
    const users: string[] = [];
    const blocks = ["📌 **You're on the schedule**"];
    for (const { s, names } of grouped.values()) {
      const m = mentionFor(names, ids);
      users.push(...m.users);
      blocks.push(`${m.text} → **${s.title}** · ${fmtDate(s.shift_date)}, ${fmtTime(s.start_time)}–${fmtTime(s.end_time)} · 📍 ${s.location || "Main Shop"}`);
    }
    blocks.push(`Can't make it? Leave the shift in the app so someone can cover: <${SITE_URL}>`);
    posts.push({ key: fresh, post: { content: blocks.join("\n"), users } });
  }

  const report = posts.filter(p => p.post.content).map(p => p.post.content);
  if (!dry) {
    for (const p of posts) {
      if (p.post.content) await send(p.post);
      await markSent(p.key);
    }
  }
  return { now, sent: report.length, linked, messages: dry ? report : undefined };
}

Deno.serve(async req => {
  const url = new URL(req.url);
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!WEBHOOK) return new Response("DISCORD_WEBHOOK_URL is not set", { status: 500 });

  try {
    if (url.searchParams.get("mode") === "test") {
      await send({ content: "✅ **NYX Shift Bot is connected.** Shift reminders will post in this channel.", users: [] });
      return Response.json({ ok: true, test: true });
    }
    const result = await run(url.searchParams.get("dry") === "1");
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
});
