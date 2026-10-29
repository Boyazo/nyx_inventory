/* Activity: (1) active time per feature on the site, (2) shop check-in / check-out.
 * Active time only counts while the tab is visible and the member interacted in the last minute,
 * so a forgotten open tab adds nothing. Totals go to usage_stats through track_usage(), which
 * caps each call server-side. */

const TICK = 5;          // seconds between samples
const IDLE_AFTER = 60;   // seconds without input before time stops counting
const FLUSH_EVERY = 30;  // seconds between uploads

let ctx = null;
let lastInput = Date.now();
let lastFeature = null;
let pending = new Map();   // feature -> { seconds, views }
let sinceFlush = 0;
let openSession = null;
let shopTimer = null;

const $ = s => document.querySelector(s);

export function initActivity(context) {
  ctx = context;
  ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(ev =>
    window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true }));
  setInterval(tick, TICK * 1000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });
  window.addEventListener("pagehide", flush);
  $("#shop-checkin-btn")?.addEventListener("click", toggleShop);
}

/* ---------- active time per feature ---------- */
function bucket(feature) {
  if (!pending.has(feature)) pending.set(feature, { seconds: 0, views: 0 });
  return pending.get(feature);
}

function tick() {
  if (!ctx.getUser()) return;
  const feature = ctx.getFeature();
  if (!feature) return;
  if (feature !== lastFeature) { bucket(feature).views++; lastFeature = feature; }
  const active = !document.hidden && Date.now() - lastInput < IDLE_AFTER * 1000;
  if (active) bucket(feature).seconds += TICK;
  sinceFlush += TICK;
  if (sinceFlush >= FLUSH_EVERY) flush();
}

async function flush() {
  sinceFlush = 0;
  if (!pending.size || !ctx.getClient() || !ctx.getUser()) return;
  const rows = [...pending].filter(([, v]) => v.seconds || v.views).map(([feature, v]) => ({ feature, ...v }));
  pending = new Map();
  if (!rows.length) return;
  const { error } = await ctx.getClient().rpc("track_usage", { p_rows: rows });
  if (error) {
    // put them back for the next attempt unless the function doesn't exist yet
    if (!/function|does not exist|schema cache/i.test(error.message)) rows.forEach(r => { const b = bucket(r.feature); b.seconds += r.seconds; b.views += r.views; });
  }
}

/* ---------- shop check-in ---------- */
export async function loadShopSession() {
  const user = ctx.getUser();
  const btn = $("#shop-checkin-btn");
  if (!user || !btn) return;
  const { data, error } = await ctx.getClient().from("shop_sessions").select("*").eq("user_id", user.id).is("ended_at", null).maybeSingle();
  if (error) { btn.hidden = true; return; }   // table not set up yet
  btn.hidden = false;
  openSession = data || null;
  renderShop();
}

const fmtDur = ms => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};

function renderShop() {
  const btn = $("#shop-checkin-btn");
  if (!btn) return;
  clearInterval(shopTimer);
  btn.classList.toggle("is-in", !!openSession);
  if (openSession) {
    const paint = () => {
      btn.innerHTML = `<i class=fa-location-dot aria-hidden=true></i><span class="shop-label">At shop · ${fmtDur(Date.now() - new Date(openSession.started_at))}</span><span class="shop-action">Check out</span>`;
    };
    paint();
    shopTimer = setInterval(paint, 30000);
    btn.title = "You're checked in at the shop. Click to check out.";
  } else {
    btn.innerHTML = `<i class=fa-location-dot aria-hidden=true></i><span class="shop-label">Check in at shop</span>`;
    btn.title = "Log time spent working at the shop";
  }
}

async function toggleShop() {
  const btn = $("#shop-checkin-btn");
  const db = ctx.getClient(), user = ctx.getUser();
  btn.disabled = true;
  if (openSession) {
    const { error } = await db.from("shop_sessions").update({ ended_at: new Date().toISOString(), ended_by_name: ctx.myName() }).eq("id", openSession.id);
    btn.disabled = false;
    if (error) return ctx.toast("Couldn't check out: " + error.message, true);
    const dur = fmtDur(Date.now() - new Date(openSession.started_at));
    ctx.logAction("SHOP_CHECK_OUT", "shop_sessions", openSession.id, { member_name: ctx.myName(), duration: dur });
    openSession = null;
    renderShop();
    ctx.toast(`Checked out — ${dur} at the shop.`);
  } else {
    const { data, error } = await db.from("shop_sessions").insert({ user_id: user.id, user_name: ctx.myName() }).select().single();
    btn.disabled = false;
    if (error) {
      if (/duplicate|unique/i.test(error.message)) return loadShopSession();
      return ctx.toast("Couldn't check in: " + error.message, true);
    }
    openSession = data;
    ctx.logAction("SHOP_CHECK_IN", "shop_sessions", data.id, { member_name: ctx.myName() });
    renderShop();
    ctx.toast("Checked in at the shop. Remember to check out when you leave.");
  }
}
