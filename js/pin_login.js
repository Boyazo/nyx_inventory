/* "Sign in with PIN": number pad on the sign-in card, the PIN section in the profile, admins
 * setting PINs for members, and automatic sign-out for PIN sign-ins after 15 idle minutes.
 * The quick-login edge function checks PINs and throttles guessing; see its header. */

const IDLE_MS = 15 * 60_000;
const LS_PIN_SESSION = "nyx_pin_session";

let ctx = null;
let pin = "";
let busy = false;
let lastInput = Date.now();

const $ = s => document.querySelector(s);
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ } };

async function call(action, payload = {}, withSession = false) {
  const headers = { "Content-Type": "application/json", apikey: ctx.publicKey };
  if (withSession) {
    const { data } = await ctx.getClient().auth.getSession();
    if (data?.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res;
  try {
    res = await fetch(`${ctx.url}/functions/v1/quick-login`, { method: "POST", headers, body: JSON.stringify({ action, ...payload }) });
  } catch {
    return { error: "Couldn't reach the server. Check the connection." };
  }
  if (res.status === 404) return { error: "PIN sign-in isn't set up on the server yet." };
  return res.json().catch(() => ({ error: "Unexpected response." }));
}

export function initPinLogin(context) {
  ctx = context;

  $("#show-pin-login")?.addEventListener("click", () => showPin(true));
  $("#pin-back")?.addEventListener("click", () => showPin(false));
  $("#pin-form")?.querySelector(".pin-pad")?.addEventListener("click", e => {
    const b = e.target.closest("[data-pin]");
    if (!b || busy) return;
    const k = b.dataset.pin;
    if (k === "back") pin = pin.slice(0, -1);
    else if (k === "clear") pin = "";
    else if (pin.length < 6) pin += k;
    syncPin();
  });
  $("#pin-input")?.addEventListener("input", e => {
    pin = e.target.value.replace(/\D/g, "").slice(0, 6);
    syncPin();
  });
  $("#pin-form")?.addEventListener("submit", e => { e.preventDefault(); submit(); });
  $("#pin-reveal-done")?.addEventListener("click", () => $("#pin-reveal-modal").classList.add("hidden"));
  $("#pin-profile-new")?.addEventListener("click", () => setPin());
  $("#pin-profile-remove")?.addEventListener("click", removeOwnPin);

  // Idle sign-out, only for sessions that started with a PIN
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(ev =>
    window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
  setInterval(async () => {
    if (!lsGet(LS_PIN_SESSION) || !ctx.getUser()) return;
    if (Date.now() - lastInput > IDLE_MS) {
      lsSet(LS_PIN_SESSION, null);
      await ctx.signOut();
      ctx.toast("Signed out after 15 minutes of no activity.");
    }
  }, 30_000);
}

export function clearPinSession() { lsSet(LS_PIN_SESSION, null); }

/* ---------- sign-in card ---------- */
export function showPin(on) {
  pin = "";
  syncPin();
  ["#signin-form", "#pin-or", "#show-pin-login", ".auth-switch"].forEach(sel => $(sel)?.classList.toggle("hidden", on));
  $("#pin-form")?.classList.toggle("hidden", !on);
  $("#auth-title").textContent = on ? "Sign in with PIN" : "Sign in";
  $("#auth-message")?.classList.add("hidden");
  if (on) setTimeout(() => $("#pin-input")?.focus({ preventScroll: true }), 30);
}

function syncPin() {
  const input = $("#pin-input");
  if (input && input.value !== pin) input.value = pin;
  document.querySelectorAll("#pin-form .pin-dots i").forEach((d, i) => d.classList.toggle("on", i < pin.length));
  $("#pin-form")?.classList.remove("is-error");
  if (pin.length === 6) submit();
}

async function submit() {
  if (busy || pin.length !== 6) return;
  busy = true;
  $("#pin-form").classList.add("is-busy");
  const res = await call("login", { pin });
  if (res.token_hash) {
    const { error } = await ctx.getClient().auth.verifyOtp({ token_hash: res.token_hash, type: "magiclink" });
    busy = false;
    $("#pin-form").classList.remove("is-busy");
    if (error) return pinError("Couldn't finish signing in: " + error.message);
    lsSet(LS_PIN_SESSION, "1");
    lastInput = Date.now();
    pin = "";
    syncPin();
    ctx.toast(`Welcome, ${res.name.split(" ")[0]}.`);
    return;
  }
  busy = false;
  $("#pin-form").classList.remove("is-busy");
  pinError(res.error || "That PIN didn't match. Try again.");
}

function pinError(msg) {
  pin = "";
  syncPin();
  const f = $("#pin-form");
  f.classList.remove("is-error"); void f.offsetWidth; f.classList.add("is-error");
  ctx.message(msg, true);
  navigator.vibrate?.(60);
}

/* ---------- profile ---------- */
export async function loadPinStatus() {
  const box = $("#pin-profile");
  if (!box) return;
  const st = $("#pin-profile-status"), add = $("#pin-profile-new"), rm = $("#pin-profile-remove");
  if (ctx.getProfile()?.is_admin) {
    st.textContent = "Admin accounts sign in with email and password, so they don't get a PIN.";
    add.classList.add("hidden"); rm.classList.add("hidden");
    return;
  }
  const res = await call("status", {}, true);
  if (res.error) { st.textContent = res.error; add.classList.add("hidden"); rm.classList.add("hidden"); return; }
  add.classList.remove("hidden");
  add.textContent = res.has_code ? "New PIN" : "Create PIN";
  rm.classList.toggle("hidden", !res.has_code);
  st.textContent = res.has_code
    ? `You have a PIN${res.last_used_at ? `, last used ${new Date(res.last_used_at).toLocaleDateString()}` : ", not used yet"}. Lost it? Make a new one.`
    : "Sign in on any computer with a 6-digit PIN instead of your password.";
}

export async function setPin(userId = null, name = "") {
  if (userId && !confirm(`Give ${name} a new sign-in PIN? Any PIN they had stops working.`)) return;
  const res = await call("set_code", userId ? { user_id: userId } : {}, true);
  if (res.error) return ctx.toast(res.error, true);
  $("#pin-reveal-for").textContent = userId ? `PIN for ${res.name}` : "Your new PIN";
  $("#pin-reveal-code").textContent = `${res.code.slice(0, 3)} ${res.code.slice(3)}`;
  $("#pin-reveal-modal").classList.remove("hidden");
  if (!userId) loadPinStatus();
}

async function removeOwnPin() {
  if (!confirm("Remove your PIN? You'll sign in with email and password only.")) return;
  const res = await call("clear_code", {}, true);
  if (res.error) return ctx.toast(res.error, true);
  ctx.toast("PIN removed.");
  loadPinStatus();
}
