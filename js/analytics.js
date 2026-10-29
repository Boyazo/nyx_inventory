/* Admin analytics: who uses what, time on the site, time at the shop, and per-member activity.
 * Sources: activity_logs (every action), usage_stats (active minutes per feature per day),
 * shop_sessions (check-in/out), team_shifts (scheduled hours), profiles. */

const RANGES = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["all", "All time"]];
const SESSION_CAP_H = 12;   // an open or forgotten check-in counts at most this many hours
const FEATURE_LABELS = {
  inventory: "Inventory", checkouts: "Checkouts", "parts-needed": "Parts needed", shifts: "Shifts",
  planner: "Planner", spending: "Spending", members: "Members", logs: "Audit log",
  duties: "Competition sign-ups", analytics: "Analytics", secrets: "Secret intel",
  "strategy:playbook": "Strategy · Playbook", "strategy:rankings": "Strategy · Rankings",
  "strategy:scouting": "Scouting", "strategy:simulator": "Strategy · Simulator", "strategy:lookup": "Strategy · Team lookup",
};
const COLS = [
  ["name", "Member"], ["last", "Last active"], ["site", "Site time"], ["shop", "Shop hours"], ["shift", "Shift hours"],
  ["checkouts", "Checkouts"], ["inventory", "Inventory edits"], ["tasks", "Tasks done"], ["scouting", "Scouting"], ["actions", "All actions"],
];

let ctx = null;
const st = { range: "30", sort: "actions", dir: -1, data: null, loading: false };
const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();

let started = false;
export function initAnalytics(context) {
  ctx = context;
  if (!started) {
    started = true;
    const host = $("#analytics-body");
    host.addEventListener("click", onClick);
    host.addEventListener("pointermove", onHover);
    host.addEventListener("pointerleave", () => tip(null));
    host.addEventListener("focusin", e => { const t = e.target.closest("[data-tip]"); if (t) tip(t); });
    host.addEventListener("focusout", () => tip(null));
  }
  load();
}

/* ---------- data ---------- */
function sinceDate() {
  if (st.range === "all") return null;
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - Number(st.range) + 1);
  return d;
}
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function pageAll(build, max = 20000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) return { data: out, error };
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: out, error: null };
}

async function load() {
  const host = $("#analytics-body");
  if (!host) return;
  if (!ctx.getProfile()?.is_admin) { host.innerHTML = `<div class="scout-card scout-picker-empty">Analytics is for admins.</div>`; return; }
  st.loading = true;
  host.innerHTML = `<div class="muted" style="padding:30px;">Loading activity…</div>`;
  const since = sinceDate();
  const sinceIso = since?.toISOString();
  const [logs, usage, shop, shifts, members] = await Promise.all([
    pageAll(() => { let q = db().from("activity_logs").select("action, user_id, user_name, created_at").order("created_at", { ascending: true }); return since ? q.gte("created_at", sinceIso) : q; }),
    pageAll(() => { let q = db().from("usage_stats").select("user_id, day, feature, seconds, views"); return since ? q.gte("day", isoDay(since)) : q; }),
    pageAll(() => db().from("shop_sessions").select("*").order("started_at", { ascending: false })),
    pageAll(() => { let q = db().from("team_shifts").select("shift_date, start_time, end_time, attendees"); return since ? q.gte("shift_date", isoDay(since)) : q; }),
    db().from("profiles").select("id, full_name, departments, is_approved").eq("is_approved", true),
  ]);
  st.loading = false;
  st.missing = [usage, shop].some(r => r.error && /relation|does not exist|schema cache/i.test(r.error.message));
  st.data = compute({ since, logs: logs.data, usage: usage.data, shop: shop.data, shifts: shifts.data, members: members.data || [] });
  render();
}

const CHECKOUT = new Set(["TOOL_CHECKOUT"]);
const INVENTORY = new Set(["ITEM_CREATED", "ITEM_UPDATED", "ITEM_DELETED"]);
const TASKS_DONE = new Set(["PLANNER_TASK_COMPLETED"]);
const SCOUTING = new Set(["SCOUTING_SUBMITTED", "PIT_SCOUTED"]);
const PASSIVE = new Set(["USER_LOGIN"]);

function compute({ since, logs, usage, shop, shifts, members }) {
  const now = Date.now();
  const byId = new Map(members.map(m => [m.id, m]));
  const byName = new Map(members.map(m => [m.full_name.trim().toLowerCase(), m.id]));
  const row = id => {
    if (!per.has(id)) per.set(id, { id, name: byId.get(id)?.full_name || "Former member", last: 0, site: 0, shop: 0, shift: 0, checkouts: 0, inventory: 0, tasks: 0, scouting: 0, actions: 0 });
    return per.get(id);
  };
  const per = new Map();
  members.forEach(m => row(m.id));

  // actions
  const daily = new Map();
  const actionTotals = new Map();
  logs.forEach(l => {
    const t = new Date(l.created_at);
    const day = isoDay(t);
    daily.set(day, (daily.get(day) || 0) + 1);
    actionTotals.set(l.action, (actionTotals.get(l.action) || 0) + 1);
    if (!l.user_id) return;
    const r = row(l.user_id);
    if (!PASSIVE.has(l.action)) r.actions++;
    if (CHECKOUT.has(l.action)) r.checkouts++;
    if (INVENTORY.has(l.action)) r.inventory++;
    if (TASKS_DONE.has(l.action)) r.tasks++;
    if (SCOUTING.has(l.action)) r.scouting++;
    r.last = Math.max(r.last, t.getTime());
  });

  // site time
  const features = new Map();
  usage.forEach(u => {
    const r = row(u.user_id);
    r.site += u.seconds;
    r.last = Math.max(r.last, new Date(u.day + "T12:00:00").getTime());
    const f = features.get(u.feature) || { feature: u.feature, seconds: 0, views: 0, people: new Set() };
    f.seconds += u.seconds; f.views += u.views; f.people.add(u.user_id);
    features.set(u.feature, f);
  });

  // shop hours (clip to range, cap forgotten sessions)
  const rangeStart = since ? since.getTime() : 0;
  const inShop = [];
  shop.forEach(s => {
    const a = new Date(s.started_at).getTime();
    const capEnd = a + SESSION_CAP_H * 3600e3;
    const b = s.ended_at ? new Date(s.ended_at).getTime() : Math.min(now, capEnd);
    if (!s.ended_at) inShop.push({ ...s, stale: now > capEnd });
    const from = Math.max(a, rangeStart), to = Math.min(b, capEnd);
    if (to > from) row(s.user_id).shop += (to - from) / 3600e3;
  });

  // scheduled shift hours (shifts that already happened)
  const today = isoDay(new Date());
  const toMin = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
  shifts.forEach(s => {
    if (s.shift_date > today) return;
    const hrs = Math.max(0, toMin(s.end_time) - toMin(s.start_time)) / 60;
    (s.attendees || []).forEach(n => { const id = byName.get(String(n).trim().toLowerCase()); if (id) row(id).shift += hrs; });
  });

  // continuous day axis
  const days = [];
  const first = since || (logs[0] ? new Date(logs[0].created_at) : new Date());
  const d = new Date(first); d.setHours(0, 0, 0, 0);
  const end = new Date(); end.setHours(0, 0, 0, 0);
  while (d <= end && days.length < 400) { const k = isoDay(d); days.push({ day: k, n: daily.get(k) || 0 }); d.setDate(d.getDate() + 1); }

  const rows = [...per.values()];
  const active = rows.filter(r => r.actions > 0 || r.site > 0 || r.shop > 0);
  return {
    rows, days, inShop,
    features: [...features.values()].sort((a, b) => b.seconds - a.seconds),
    totals: {
      active: active.length,
      members: members.length,
      siteHours: rows.reduce((s, r) => s + r.site, 0) / 3600,
      shopHours: rows.reduce((s, r) => s + r.shop, 0),
      checkouts: actionTotals.get("TOOL_CHECKOUT") || 0,
      inventory: [...INVENTORY].reduce((s, k) => s + (actionTotals.get(k) || 0), 0),
      actions: logs.filter(l => !PASSIVE.has(l.action)).length,
    },
  };
}

/* ---------- rendering ---------- */
const fmtHours = h => (h > 0 && h < 1 ? `${Math.round(h * 60)}m` : `${h >= 10 ? Math.round(h) : h.toFixed(1)}h`);
const fmtMins = s => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)}m`);
const fmtAgo = t => {
  if (!t) return "—";
  const days = Math.floor((Date.now() - t) / 86400e3);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
};

function render() {
  const host = $("#analytics-body");
  const D = st.data;
  const T = D.totals;
  const rangeLabel = RANGES.find(r => r[0] === st.range)[1].toLowerCase();
  host.innerHTML = `
    <div class="an-toolbar">
      <div class="gcal-views" role="tablist" aria-label="Date range">
        ${RANGES.map(([k, l]) => `<button type="button" role="tab" class="${st.range === k ? "active" : ""}" data-range="${k}">${l}</button>`).join("")}
      </div>
      <button type="button" class="btn btn--ghost btn--sm" data-an="refresh"><i class=fa-arrows-rotate aria-hidden=true></i> Refresh</button>
    </div>
    ${st.missing ? `<div class="scout-card scout-warn-box" style="margin:0 0 14px;">Time tracking and shop check-ins start once the database update (schema.sql) is applied. Activity counts below already work.</div>` : ""}

    <div class="an-tiles">
      ${tile("Active members", `${T.active}<small> / ${T.members}</small>`, `did something in the last ${rangeLabel}`)}
      ${tile("Time on the site", fmtHours(T.siteHours), "active minutes, idle time excluded")}
      ${tile("Time at the shop", fmtHours(T.shopHours), "from check-ins")}
      ${tile("Tool checkouts", T.checkouts, "tools borrowed")}
      ${tile("Inventory edits", T.inventory, "items added, changed or removed")}
      ${tile("Actions", T.actions, "everything logged, sign-ins excluded")}
    </div>

    <div class="an-grid">
      <section class="an-card an-wide">
        <h3>Activity per day</h3>
        <p class="muted small">Logged actions across the team.</p>
        ${dayChart(D.days)}
      </section>

      <section class="an-card">
        <h3>Time by feature</h3>
        <p class="muted small">Active time on each part of the site.</p>
        ${barList(D.features.slice(0, 12).map(f => ({
          label: FEATURE_LABELS[f.feature] || f.feature, value: f.seconds, text: fmtMins(f.seconds),
          tip: `${FEATURE_LABELS[f.feature] || f.feature}: ${fmtMins(f.seconds)} · ${f.views} visits · ${f.people.size} ${f.people.size === 1 ? "person" : "people"}`,
        })), "No time recorded yet.")}
      </section>

      <section class="an-card">
        <h3>Shop hours by member</h3>
        <p class="muted small">Checked-in time, ${SESSION_CAP_H}h max per visit.</p>
        ${barList(D.rows.filter(r => r.shop > 0).sort((a, b) => b.shop - a.shop).slice(0, 12).map(r => ({
          label: r.name, value: r.shop, text: fmtHours(r.shop), tip: `${r.name}: ${fmtHours(r.shop)} at the shop · ${fmtHours(r.shift)} signed up for shifts`,
        })), "No one has checked in yet.")}
      </section>

      <section class="an-card">
        <h3>At the shop now</h3>
        ${D.inShop.length ? `<div class="an-inshop">${D.inShop.map(s => `
          <div class="an-inshop-row">
            <span><b>${esc(s.user_name)}</b> <span class="muted small">since ${new Date(s.started_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${s.stale ? " · forgot to check out?" : ""}</span></span>
            <button type="button" class="btn btn--ghost btn--sm" data-checkout-session="${s.id}" data-name="${esc(s.user_name)}">Check out</button>
          </div>`).join("")}</div>` : `<p class="muted small" style="margin:0;">Nobody is checked in.</p>`}
      </section>
    </div>

    <section class="an-card an-table-card">
      <h3>Members</h3>
      <p class="muted small">Click a column to sort. Site time counts only active use; shift hours are shifts signed up for that already happened.</p>
      <div class="an-table-wrap">
        <table class="an-table">
          <thead><tr>${COLS.map(([k, l]) => `<th scope="col" class="${k === "name" ? "" : "num"}"><button type="button" data-sort="${k}" aria-sort="${st.sort === k ? (st.dir < 0 ? "descending" : "ascending") : "none"}">${l}${st.sort === k ? ` <i class=${st.dir < 0 ? "fa-arrow-down" : "fa-arrow-up"} aria-hidden=true></i>` : ""}</button></th>`).join("")}</tr></thead>
          <tbody>${sortedRows().map(r => `<tr>
            <th scope="row">${esc(r.name)}</th>
            <td>${fmtAgo(r.last)}</td>
            <td class="num">${r.site ? fmtMins(r.site) : "—"}</td>
            <td class="num">${r.shop ? fmtHours(r.shop) : "—"}</td>
            <td class="num">${r.shift ? fmtHours(r.shift) : "—"}</td>
            <td class="num">${r.checkouts || "—"}</td>
            <td class="num">${r.inventory || "—"}</td>
            <td class="num">${r.tasks || "—"}</td>
            <td class="num">${r.scouting || "—"}</td>
            <td class="num"><b>${r.actions}</b></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>
    </section>`;
}

function tile(label, value, sub) {
  return `<div class="stat an-tile"><small>${label}</small><strong>${value}</strong><p class="muted">${sub}</p></div>`;
}

function dayChart(days) {
  if (!days.length || !days.some(d => d.n)) return `<p class="muted small">No activity in this range.</p>`;
  const max = Math.max(...days.map(d => d.n));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const label = (d, i) => {
    const every = Math.ceil(days.length / 8);
    return i % every === 0 ? new Date(d.day + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" }) : "";
  };
  return `<div class="an-days" style="--n:${days.length}">
    <div class="an-yaxis">${ticks.slice().reverse().map(v => `<span>${v}</span>`).join("")}</div>
    <div class="an-plot">
      <div class="an-bars">
        ${ticks.map(v => `<i class="an-gridline" style="bottom:${(v / top) * 100}%"></i>`).join("")}${days.map(d => `<button type="button" class="an-day" data-tip="${esc(new Date(d.day + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }))}: ${d.n} action${d.n === 1 ? "" : "s"}" aria-label="${d.day}: ${d.n} actions"><i style="height:${top ? (d.n / top) * 100 : 0}%"></i></button>`).join("")}</div>
      <div class="an-xaxis">${days.map((d, i) => `<span>${label(d, i)}</span>`).join("")}</div>
    </div>
  </div>`;
}

function niceStep(max) {
  if (max <= 4) return 1;
  const raw = max / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function barList(items, empty) {
  if (!items.length) return `<p class="muted small">${empty}</p>`;
  const max = Math.max(...items.map(i => i.value)) || 1;
  return `<div class="an-barlist">${items.map(i => `
    <div class="an-barrow" tabindex="0" data-tip="${esc(i.tip)}">
      <span class="an-barlabel">${esc(i.label)}</span>
      <span class="an-bartrack"><i style="width:${Math.max(2, (i.value / max) * 100)}%"></i></span>
      <span class="an-barval">${esc(i.text)}</span>
    </div>`).join("")}</div>`;
}

function sortedRows() {
  const k = st.sort;
  return st.data.rows.slice().sort((a, b) => (k === "name" ? a.name.localeCompare(b.name) * -st.dir : 0) || ((a[k] || 0) - (b[k] || 0)) * st.dir || a.name.localeCompare(b.name));
}

/* ---------- interaction ---------- */
async function onClick(e) {
  const r = e.target.closest("[data-range]");
  if (r) { st.range = r.dataset.range; return load(); }
  if (e.target.closest("[data-an=refresh]")) return load();
  const s = e.target.closest("[data-sort]");
  if (s) {
    st.dir = st.sort === s.dataset.sort ? -st.dir : (s.dataset.sort === "name" ? 1 : -1);
    st.sort = s.dataset.sort;
    return render();
  }
  const c = e.target.closest("[data-checkout-session]");
  if (c) {
    if (!confirm(`Check ${c.dataset.name} out of the shop now?`)) return;
    const { error } = await db().from("shop_sessions").update({ ended_at: new Date().toISOString(), ended_by_name: ctx.myName() }).eq("id", c.dataset.checkoutSession);
    if (error) return ctx.toast("Couldn't check out: " + error.message, true);
    ctx.logAction("SHOP_CHECK_OUT", "shop_sessions", c.dataset.checkoutSession, { member_name: c.dataset.name, by_admin: ctx.myName() });
    ctx.toast(`Checked ${c.dataset.name} out.`);
    load();
  }
}

let tipEl = null;
function tip(target, x, y) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "an-tooltip"; tipEl.setAttribute("role", "tooltip"); document.body.appendChild(tipEl); }
  if (!target) { tipEl.hidden = true; return; }
  tipEl.textContent = target.dataset.tip;
  tipEl.hidden = false;
  const r = target.getBoundingClientRect();
  const px = x ?? r.left + r.width / 2, py = y ?? r.top;
  const w = tipEl.offsetWidth;
  tipEl.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, px - w / 2)) + "px";
  tipEl.style.top = Math.max(8, py - tipEl.offsetHeight - 10) + "px";
}
function onHover(e) {
  const t = e.target.closest("[data-tip]");
  tip(t, e.clientX, e.clientY);
}
