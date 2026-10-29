/* Scouting hub, modelled on 4414 HighTide's scouting workflow:
 *  - Event: an admin imports the event's teams + qualification schedule from The Blue Alliance.
 *  - Match: scouts pick a match, see its six robots and claim one (one scout per robot per match).
 *  - Pit: a grid of every team (scouted / not scouted) with a quick capabilities checklist.
 *  - Teams: each team's pit answers, match reports and averages.
 *  - Pick lists: every scout keeps their own tiered lists; admins merge them into the team's
 *    primary list with a consensus score.
 * Match reports themselves are saved by the existing form in app.js (match_scouting_logs). */

const TIERS = [
  ["tier1", "Tier 1"],
  ["tier2", "Tier 2"],
  ["tier3", "Tier 3"],
  ["dnp", "Do Not Pick"],
  ["uncat", "Uncategorized"],
];
const PIT_CAPABILITIES = [
  ["hub", "Scores fuel in hub"], ["range", "Shoots from range"], ["moving", "Shoots while moving"],
  ["floor", "Floor intake"], ["outpost", "Outpost / HP intake"], ["bump", "Crosses bump"],
  ["trench", "Fits under trench"], ["l1", "Climb L1"], ["l2", "Climb L2"], ["l3", "Climb L3"],
  ["autoclimb", "Auto climb"], ["defense", "Can play defense"],
];
const CLIMB_PTS = { L1: 10, L2: 20, L3: 30 };
const LS_EVENT = "nyx_scout_event";
const LS_TBA = "nyx_tba_key";
const LS_LIST = "nyx_scout_open_list";

let ctx = null;
const state = {
  ready: false,
  missingTables: false,
  events: [],
  key: "",
  claims: [],
  pit: new Map(),
  lists: [],
  pane: "match",
  members: [],
  rotation: new Set(),
  openListId: null,
  teamFilter: "",
};

const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();
const me = () => ctx.getUser();
const profile = () => ctx.getProfile();
const isAdmin = () => !!profile()?.is_admin;
const myName = () => profile()?.full_name || me()?.email || "Scout";
const lsGet = k => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage unavailable */ } };

function event() { return state.events.find(e => e.event_key === state.key) || null; }
function teamsOf(ev = event()) { return (ev?.teams || []).slice().sort((a, b) => a.team - b.team); }
function teamInfo(num) { return teamsOf().find(t => t.team === Number(num)) || { team: Number(num), nickname: "" }; }

/* ---------- data ---------- */

export function initScoutHub(context) {
  ctx = context;
  $("#scout-subnav")?.addEventListener("click", e => {
    const b = e.target.closest("[data-scout-pane]");
    if (b) showPane(b.dataset.scoutPane);
  });
  document.addEventListener("nyx:scout-saved", async () => {
    if (event()) $("#scout-team-num").value = ""; // next match: pick a robot again
    await loadClaims();
    renderPicker();
  });
  $("#scout-match-num")?.addEventListener("change", renderPicker);
  ensureModal();
  load();
  subscribe();
  // Safety net if realtime drops: refresh claims while the match form is on screen
  setInterval(async () => {
    const pane = $("#scout-pane-match");
    if (!state.key || !pane || pane.hidden || pane.offsetParent === null || document.hidden) return;
    await loadClaims();
    renderPicker();
  }, 15000);
}

async function load() {
  const { data, error } = await db().from("scout_events").select("*").order("imported_at", { ascending: false });
  if (error) {
    state.missingTables = /relation|does not exist|schema cache/i.test(error.message);
    state.events = [];
  } else {
    state.events = data || [];
  }
  const saved = lsGet(LS_EVENT);
  state.key = state.events.some(e => e.event_key === saved) ? saved : (state.events.find(e => e.is_active)?.event_key || state.events[0]?.event_key || "");
  await Promise.all([loadClaims(), loadPit(), loadLists(), loadMembers()]);
  state.ready = true;
  renderAll();
}

async function loadClaims() {
  if (!state.key) { state.claims = []; return; }
  const { data } = await db().from("scout_claims").select("*").eq("event_key", state.key);
  state.claims = data || [];
}
async function loadMembers() {
  const { data } = await db().from("profiles").select("id, full_name, departments").eq("is_approved", true);
  state.members = (data || []).sort((a, b) => a.full_name.localeCompare(b.full_name));
}
async function loadPit() {
  state.pit = new Map();
  if (!state.key) return;
  const { data } = await db().from("pit_scouting").select("*").eq("event_key", state.key);
  (data || []).forEach(r => state.pit.set(r.team_num, r));
}
async function loadLists() {
  if (!state.key) { state.lists = []; return; }
  const { data } = await db().from("pick_lists").select("*").eq("event_key", state.key).order("created_at");
  state.lists = data || [];
  const saved = lsGet(LS_LIST);
  if (!state.lists.some(l => l.id === state.openListId)) {
    state.openListId = state.lists.some(l => l.id === saved) ? saved
      : (state.lists.find(l => l.owner_id === me()?.id && !l.is_primary)?.id || state.lists.find(l => l.is_primary)?.id || null);
  }
}

let reloadTimer = null;
function subscribe() {
  const reload = which => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      if (which === "scout_events") return load();
      if (which === "scout_claims") { await loadClaims(); renderPicker(); }
      if (which === "pit_scouting") { await loadPit(); renderPit(); renderTeams(); }
      if (which === "pick_lists") { if (!dragging) { await loadLists(); renderPicks(); renderTeams(); } }
    }, 250);
  };
  try {
    let ch = db().channel("nyx-scout-hub");
    ["scout_events", "scout_claims", "pit_scouting", "pick_lists"].forEach(t => {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, () => reload(t));
    });
    ch.subscribe();
  } catch { /* realtime optional */ }
}

/* ---------- stats from match reports ---------- */

function reportsFor(team) {
  const recs = ctx.getRecords() || [];
  return recs.filter(r => Number(r.team_num) === Number(team) && (!state.key || (r.event_key || "") === state.key));
}
function rating10(r, field) {
  const v = Number(r[field]);
  if (!Number.isFinite(v)) return null;
  return r.rating_scale === 10 ? v : v * 2; // reports before the 1–10 scale used 1–5 / 0–5
}
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d).replace(/\.0$/, ""));

function teamStats(team) {
  const rs = reportsFor(team);
  const made = rs.reduce((s, r) => s + (r.auto_fuel || 0) + (r.tele_fuel || 0), 0);
  const miss = rs.reduce((s, r) => s + (r.auto_miss || 0) + (r.tele_miss || 0), 0);
  const climbs = {};
  rs.forEach(r => { climbs[r.climb || "none"] = (climbs[r.climb || "none"] || 0) + 1; });
  const tags = {};
  rs.forEach(r => (r.tags || []).forEach(t => { tags[t] = (tags[t] || 0) + 1; }));
  const defense = rs.map(r => rating10(r, "defense_rating")).filter(v => v);
  return {
    count: rs.length,
    reports: rs.slice().sort((a, b) => a.match_num - b.match_num),
    autoFuel: avg(rs.map(r => r.auto_fuel || 0)),
    teleFuel: avg(rs.map(r => r.tele_fuel || 0)),
    accuracy: made + miss ? Math.round((made / (made + miss)) * 100) : null,
    points: avg(rs.map(r => r.est_points || 0)),
    climbPts: avg(rs.map(r => CLIMB_PTS[r.climb] || 0)),
    climbs,
    driver: avg(rs.map(r => rating10(r, "driver_rating")).filter(v => v != null)),
    defense: avg(defense),
    tags,
    broke: rs.filter(r => r.died).length,
  };
}

/* ---------- shell ---------- */

function showPane(p) {
  state.pane = p;
  document.querySelectorAll("#scout-subnav [data-scout-pane]").forEach(b => b.classList.toggle("active", b.dataset.scoutPane === p));
  if (p === "assign" && !isAdmin()) p = state.pane = "match";
  ["match", "pit", "teams", "picks", "event", "assign"].forEach(id => {
    const el = document.getElementById(`scout-pane-${id}`);
    if (el) el.hidden = id !== p;
  });
  renderAll();
}

function renderAll() {
  const assignTab = $("#scout-assign-tab");
  if (assignTab) assignTab.hidden = !isAdmin();
  renderChip();
  renderPicker();
  renderPit();
  renderTeams();
  renderPicks();
  renderEventPane();
  renderAssign();
}

function renderChip() {
  const chip = $("#scout-event-chip");
  if (!chip) return;
  const ev = event();
  if (state.missingTables) {
    chip.innerHTML = `<span class="scout-warn">Database setup pending (schema.sql)</span>`;
    return;
  }
  if (!state.events.length) {
    chip.innerHTML = `<span class="muted">No event imported</span>`;
    return;
  }
  chip.innerHTML = `
    <label class="sr-only" for="scout-event-select">Event</label>
    <select id="scout-event-select">
      ${state.events.map(e => `<option value="${esc(e.event_key)}" ${e.event_key === state.key ? "selected" : ""}>${esc(e.name || e.event_key)}${e.is_active ? " (active)" : ""}</option>`).join("")}
    </select>
    <span class="muted small">${ev ? `${(ev.teams || []).length} teams · ${(ev.matches || []).length} quals` : ""}</span>`;
  $("#scout-event-select").onchange = async e => {
    state.key = e.target.value;
    lsSet(LS_EVENT, state.key);
    state.openListId = null;
    await Promise.all([loadClaims(), loadPit(), loadLists()]);
    renderAll();
  };
}

/* ---------- match pane: robot picker + claims ---------- */

function currentMatchNum() { return parseInt($("#scout-match-num")?.value, 10) || 1; }

function renderPicker() {
  const host = $("#scout-robot-picker");
  if (!host || !ctx) return;
  const ev = event();
  const keyInput = $("#scout-event-key");
  const evInput = $("#scout-event");
  if (keyInput) keyInput.value = ev?.event_key || "";
  if (evInput) {
    if (ev) { evInput.value = ev.name || ev.event_key; evInput.readOnly = true; }
    else evInput.readOnly = false;
  }
  if (!ev) {
    host.innerHTML = `<div class="scout-card scout-picker-empty">
      <b>No event selected.</b> ${isAdmin() ? "Import one under <b>Event</b> to get the match schedule and robot claiming." : "Ask an admin to import the event under <b>Event</b>."}
      You can still scout by typing the team number below.</div>`;
    return;
  }
  const n = currentMatchNum();
  const match = (ev.matches || []).find(m => m.match_num === n);

  // Admin assignments: auto-fill this match and show the scout's next one
  const done = new Set((ctx.getRecords() || []).filter(r => (r.event_key || "") === ev.event_key).map(r => `${r.match_num}:${Number(r.team_num)}`));
  const myAssigned = state.claims.filter(c => c.scout_id === me()?.id && c.assigned_by_name).sort((a, b) => a.match_num - b.match_num);
  const mineHere = state.claims.find(c => c.match_num === n && c.scout_id === me()?.id);
  if (mineHere && match && !$("#scout-team-num").value) {
    $("#scout-team-num").value = mineHere.team_num;
    const idx = match.red.indexOf(mineHere.team_num);
    const station = idx >= 0 ? `R${idx + 1}` : `B${match.blue.indexOf(mineHere.team_num) + 1}`;
    const st = document.querySelector(`input[name="scout-station"][value="${station}"]`);
    if (st) st.checked = true;
  }
  const upcoming = myAssigned.filter(c => !done.has(`${c.match_num}:${c.team_num}`) && c.match_num >= n);
  const next = upcoming.find(c => c.match_num !== n) || null;
  const banner = myAssigned.length ? `
    <div class="assign-banner">
      <span><b>Your assignments:</b> ${upcoming.length ? `${upcoming.length} left` : "all done ✓"}${myAssigned.length ? ` · ${[...new Set(myAssigned.map(c => c.match_num))].length} matches total` : ""}</span>
      ${next ? `<button type="button" class="btn btn--ghost btn--sm" data-goto-match="${next.match_num}">Next: Q${next.match_num} · ${next.team_num} →</button>` : ""}
    </div>` : "";
  const head = banner + `
    <div class="scout-picker-head">
      <div>
        <div class="scout-phase-title" style="margin:0;"><span>Pick your robot</span></div>
        <span class="muted small">${match?.time ? `Scheduled ${new Date(match.time * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : (ev.matches || []).length ? "" : "Schedule not imported — choose a team below"}</span>
      </div>
      <div class="scout-stepper" aria-label="Match number">
        <button type="button" data-match-step="-1" aria-label="Previous match">−</button>
        <span>Q${n}</span>
        <button type="button" data-match-step="1" aria-label="Next match">+</button>
      </div>
    </div>`;

  let body;
  if (match) {
    const scouted = new Set();
    const recs = (ctx.getRecords() || []).filter(r => (r.event_key || "") === ev.event_key && r.match_num === n);
    recs.forEach(r => scouted.add(Number(r.team_num)));
    const slot = (team, station) => {
      const claim = state.claims.find(c => c.match_num === n && c.team_num === team);
      const mine = claim && claim.scout_id === me()?.id;
      const done = scouted.has(team);
      const info = teamInfo(team);
      const status = done ? "Scouted ✓" : mine ? (claim.assigned_by_name ? "Assigned to you" : "Yours — tap to release") : claim ? `${claim.assigned_by_name ? "Assigned" : "Claimed"}: ${esc(claim.scout_name)}` : "Open";
      return `<button type="button" class="robot-slot ${station[0] === "R" ? "red" : "blue"} ${mine ? "is-mine" : ""} ${claim && !mine ? "is-taken" : ""} ${done ? "is-done" : ""}"
        data-claim-team="${team}" data-station="${station}" ${claim && !mine ? "disabled" : ""}>
        <span class="robot-station">${station}</span>
        <strong>${team}</strong>
        <span class="robot-name">${esc(info.nickname || "")}</span>
        <span class="robot-status">${status}</span>
      </button>`;
    };
    body = `<div class="robot-grid">
      ${match.red.map((t, i) => slot(t, `R${i + 1}`)).join("")}
      ${match.blue.map((t, i) => slot(t, `B${i + 1}`)).join("")}
    </div>`;
  } else {
    body = `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <select id="scout-team-quickpick" style="max-width:320px;">
        <option value="">Choose a team…</option>
        ${teamsOf().map(t => `<option value="${t.team}">${t.team} ${esc(t.nickname || "")}</option>`).join("")}
      </select>
      <span class="muted small">${(ev.matches || []).length ? `Q${n} isn't in the imported schedule.` : ""}</span>
    </div>`;
  }
  host.innerHTML = `<div class="scout-card">${head}${body}</div>`;

  host.querySelectorAll("[data-match-step]").forEach(b => b.onclick = async () => {
    const el = $("#scout-match-num");
    el.value = Math.max(1, currentMatchNum() + Number(b.dataset.matchStep));
    $("#scout-team-num").value = "";
    renderPicker();
    await loadClaims();
    renderPicker();
  });
  host.querySelectorAll("[data-claim-team]").forEach(b => b.onclick = () => toggleClaim(Number(b.dataset.claimTeam), b.dataset.station));
  host.querySelectorAll("[data-goto-match]").forEach(b => b.onclick = () => {
    $("#scout-match-num").value = b.dataset.gotoMatch;
    $("#scout-team-num").value = "";
    renderPicker();
  });
  const qp = $("#scout-team-quickpick");
  if (qp) qp.onchange = () => { $("#scout-team-num").value = qp.value; };
}

async function toggleClaim(team, station) {
  const n = currentMatchNum();
  const mine = state.claims.find(c => c.match_num === n && c.scout_id === me()?.id);
  if (mine && mine.team_num === team) {
    if (mine.assigned_by_name && !confirm(`${mine.assigned_by_name} assigned you this robot. Release it so someone else can scout it?`)) return;
    await db().from("scout_claims").delete().eq("event_key", state.key).eq("match_num", n).eq("team_num", team);
    $("#scout-team-num").value = "";
    await loadClaims();
    return renderPicker();
  }
  if (mine) await db().from("scout_claims").delete().eq("event_key", state.key).eq("match_num", n).eq("scout_id", me().id);
  const { error } = await db().from("scout_claims").insert({ event_key: state.key, match_num: n, team_num: team, scout_id: me().id, scout_name: myName() });
  await loadClaims();
  if (error) {
    ctx.toast(/duplicate|unique/i.test(error.message) ? "Someone just claimed that robot — pick another." : "Couldn't claim robot: " + error.message, true);
    return renderPicker();
  }
  $("#scout-team-num").value = team;
  const st = document.querySelector(`input[name="scout-station"][value="${station}"]`);
  if (st) st.checked = true;
  if ($("#scout-match-type")) $("#scout-match-type").value = "qm";
  renderPicker();
  ctx.toast(`You're scouting ${team} (${station}) in Q${n}.`);
}

/* ---------- pit pane ---------- */

function renderPit() {
  const host = $("#scout-pane-pit");
  if (!host || host.hidden) return;
  const teams = teamsOf();
  if (!teams.length) { host.innerHTML = emptyEvent(); return; }
  const done = teams.filter(t => state.pit.has(t.team)).length;
  host.innerHTML = `
    <div class="scout-pane-head">
      <div><h3>Pit scouting</h3><span class="muted small">${done} of ${teams.length} teams scouted</span></div>
      <div class="scout-progress"><i style="width:${Math.round((done / teams.length) * 100)}%"></i></div>
    </div>
    <div class="pit-grid">
      ${teams.map(t => {
        const p = state.pit.get(t.team);
        return `<button type="button" class="pit-tile ${p ? "is-done" : ""}" data-pit-team="${t.team}">
          <strong>${t.team}</strong>
          <span class="pit-name">${esc(t.nickname || "")}</span>
          <span class="pit-status">${p ? `Scouted · ${esc(p.scouted_by_name || "")}` : "Not scouted"}</span>
        </button>`;
      }).join("")}
    </div>`;
  host.querySelectorAll("[data-pit-team]").forEach(b => b.onclick = () => openPitForm(Number(b.dataset.pitTeam)));
}

function openPitForm(team) {
  const info = teamInfo(team);
  const d = state.pit.get(team)?.data || {};
  openModal(`Pit scouting · ${team}`, info.nickname, `
    <form id="pit-form">
      <label>Capabilities</label>
      <div class="scout-tags">
        ${PIT_CAPABILITIES.map(([k, label]) => `<label><input type="checkbox" name="pit-cap" value="${k}" ${d.caps?.includes(k) ? "checked" : ""}><span>${label}</span></label>`).join("")}
      </div>
      <div class="formgrid" style="margin-top:12px;">
        <div>
          <label for="pit-drive">Drivetrain</label>
          <select id="pit-drive">${["", "Swerve", "Tank", "Mecanum", "Other"].map(o => `<option value="${o}" ${d.drivetrain === o ? "selected" : ""}>${o || "Choose…"}</option>`).join("")}</select>
        </div>
        <div>
          <label for="pit-capacity">Fuel capacity</label>
          <input id="pit-capacity" type="number" min="0" max="99" inputmode="numeric" value="${esc(d.capacity ?? "")}" placeholder="balls held">
        </div>
      </div>
      <label for="pit-auto">Auto routines</label>
      <input id="pit-auto" maxlength="120" value="${esc(d.auto || "")}" placeholder="e.g. 8-ball center, depot + climb">
      <label for="pit-notes">Robot notes</label>
      <textarea id="pit-notes" rows="2" maxlength="400" placeholder="Anything worth knowing">${esc(d.notes || "")}</textarea>
      <div class="modalactions">
        <button type="button" class="btn btn--ghost" data-close-modal>Cancel</button>
        <button type="submit" class="btn btn--primary">Save pit report</button>
      </div>
    </form>`);
  $("#pit-form").onsubmit = async e => {
    e.preventDefault();
    const data = {
      caps: [...document.querySelectorAll('input[name="pit-cap"]:checked')].map(c => c.value),
      drivetrain: $("#pit-drive").value,
      capacity: $("#pit-capacity").value === "" ? null : Number($("#pit-capacity").value),
      auto: $("#pit-auto").value.trim(),
      notes: $("#pit-notes").value.trim(),
    };
    const { error } = await db().from("pit_scouting").upsert({
      event_key: state.key, team_num: team, data, scouted_by: me().id, scouted_by_name: myName(), updated_at: new Date().toISOString(),
    });
    if (error) return ctx.toast("Couldn't save pit report: " + error.message, true);
    ctx.logAction("PIT_SCOUTED", "pit_scouting", `${state.key}:${team}`, { team_num: team, event_key: state.key });
    closeModal();
    await loadPit();
    renderPit();
    renderTeams();
    ctx.toast(`Pit report saved for ${team}.`);
  };
}

/* ---------- teams pane ---------- */

function referenceList() {
  return state.lists.find(l => l.id === state.openListId) || state.lists.find(l => l.is_primary) || null;
}
function tierOf(list, team) {
  if (!list) return null;
  for (const [k] of TIERS) if ((list.tiers?.[k] || []).includes(team)) return k;
  return "uncat";
}
const tierLabel = k => (TIERS.find(t => t[0] === k) || [, ""])[1];

function renderTeams() {
  const host = $("#scout-pane-teams");
  if (!host || host.hidden) return;
  const teams = teamsOf();
  if (!teams.length) { host.innerHTML = emptyEvent(); return; }
  const ref = referenceList();
  const q = state.teamFilter.trim().toLowerCase();
  const rows = teams.filter(t => !q || String(t.team).includes(q) || (t.nickname || "").toLowerCase().includes(q));
  host.innerHTML = `
    <div class="scout-pane-head">
      <div><h3>Teams</h3><span class="muted small">${ref ? `Tiers from “${esc(ref.name)}”` : "Create a pick list to see tiers here"}</span></div>
      <input type="search" id="scout-team-filter" placeholder="Search team # or name" value="${esc(state.teamFilter)}" style="max-width:240px;">
    </div>
    <div class="tablehead scout-team-row"><span>Team</span><span>Pit</span><span>Reports</span><span>Avg pts</span><span>Driver</span><span>Tier</span></div>
    ${rows.map(t => {
      const s = teamStats(t.team);
      const tier = tierOf(ref, t.team);
      return `<button type="button" class="itemrow scout-team-row" data-team-detail="${t.team}">
        <span><strong>${t.team}</strong> <span class="muted">${esc(t.nickname || "")}</span></span>
        <span>${state.pit.has(t.team) ? '<span class="stock-pill stock-pill--in">Scouted</span>' : '<span class="stock-pill stock-pill--out">Not scouted</span>'}</span>
        <span>${s.count}</span>
        <span>${fmt(s.points)}</span>
        <span>${fmt(s.driver)}</span>
        <span>${tier ? `<span class="tier-pill tier-${tier}">${tierLabel(tier)}</span>` : "—"}</span>
      </button>`;
    }).join("")}`;
  const f = $("#scout-team-filter");
  f.oninput = () => { state.teamFilter = f.value; const pos = f.selectionStart; renderTeams(); const nf = $("#scout-team-filter"); nf.focus(); nf.setSelectionRange(pos, pos); };
  host.querySelectorAll("[data-team-detail]").forEach(b => b.onclick = () => openTeamDetail(Number(b.dataset.teamDetail)));
}

function openTeamDetail(team) {
  const info = teamInfo(team);
  const s = teamStats(team);
  const pit = state.pit.get(team);
  const ref = referenceList();
  const tier = tierOf(ref, team);
  const loc = [info.city, info.state, info.country].filter(Boolean).join(", ");
  const climbs = Object.entries(s.climbs).map(([k, v]) => `${k === "none" ? "No climb" : k === "fail" ? "Failed" : k} ×${v}`).join(" · ") || "—";
  const tags = Object.entries(s.tags).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="pill">${esc(k)} ×${v}</span>`).join(" ");
  openModal(`${team} ${info.nickname || ""}`, loc, `
    <div class="team-detail-stats">
      ${[["Reports", s.count], ["Avg points", fmt(s.points)], ["Auto fuel", fmt(s.autoFuel)], ["Teleop fuel", fmt(s.teleFuel)],
         ["Accuracy", s.accuracy == null ? "—" : s.accuracy + "%"], ["Climb pts", fmt(s.climbPts)], ["Driver /10", fmt(s.driver)], ["Defense /10", fmt(s.defense)]]
        .map(([k, v]) => `<div><small>${k}</small><strong>${v}</strong></div>`).join("")}
    </div>
    <p class="small"><b>Climbs:</b> ${climbs}${s.broke ? ` · <span style="color:var(--red)">Broke down ×${s.broke}</span>` : ""}</p>
    ${tags ? `<p class="small"><b>Tags:</b> ${tags}</p>` : ""}
    <p class="small"><b>Tier:</b> ${tier ? `${tierLabel(tier)} <span class="muted">(${esc(ref.name)})</span>` : "—"}</p>
    <h4>Pit scouting</h4>
    ${pit ? `<div class="scout-tags">${(pit.data.caps || []).map(k => `<span class="pill">${esc((PIT_CAPABILITIES.find(c => c[0] === k) || [, k])[1])}</span>`).join("")}</div>
      <p class="small">${[pit.data.drivetrain, pit.data.capacity != null ? `holds ${pit.data.capacity}` : "", pit.data.auto].filter(Boolean).map(esc).join(" · ")}</p>
      ${pit.data.notes ? `<p class="small muted">${esc(pit.data.notes)}</p>` : ""}
      <p class="small muted">by ${esc(pit.scouted_by_name)}</p>`
      : `<p class="small muted">Not pit scouted yet. <button type="button" class="textbtn" id="detail-pit-btn">Scout now</button></p>`}
    <h4>Match reports</h4>
    ${s.reports.length ? `<div class="detail-reports">${s.reports.map(r => `
      <div class="detail-report">
        <b>Q${r.match_num}</b> <span class="muted small">${esc(r.scout_name || "")}</span>
        <span class="small">Auto ${r.auto_fuel || 0} · Tele ${r.tele_fuel || 0} · ${r.climb === "none" ? "No climb" : esc(r.climb || "")} · Driver ${fmt(rating10(r, "driver_rating"))}</span>
        ${(r.tags || []).length ? `<span class="small muted">${r.tags.map(esc).join(", ")}</span>` : ""}
        ${r.notes ? `<span class="small muted">“${esc(r.notes)}”</span>` : ""}
      </div>`).join("")}</div>` : `<p class="small muted">No match reports for this event yet.</p>`}
  `);
  const pb = $("#detail-pit-btn");
  if (pb) pb.onclick = () => openPitForm(team);
}

/* ---------- pick lists ---------- */

function canEdit(list) { return list && (list.is_primary ? isAdmin() : list.owner_id === me()?.id); }

function renderPicks() {
  const host = $("#scout-pane-picks");
  if (!host || host.hidden) return;
  if (!teamsOf().length) { host.innerHTML = emptyEvent(); return; }
  const primary = state.lists.find(l => l.is_primary);
  const mine = state.lists.filter(l => !l.is_primary && l.owner_id === me()?.id);
  const others = state.lists.filter(l => !l.is_primary && l.owner_id !== me()?.id);
  const open = state.lists.find(l => l.id === state.openListId) || null;
  const item = l => `<button type="button" class="picklist-item ${l.id === state.openListId ? "active" : ""}" data-open-list="${l.id}">
      <span>${l.is_primary ? "★ " : ""}${esc(l.name)}</span>
      <small>${l.is_primary ? "Team primary" : esc(l.owner_name)}</small>
    </button>`;

  host.innerHTML = `
    <div class="picks-layout">
      <aside class="picks-side">
        <div class="picks-side-group">
          <div class="picks-side-title">Primary</div>
          ${primary ? item(primary) : isAdmin() ? `<button type="button" class="btn btn--ghost btn--sm" id="create-primary">Create team primary list</button>` : `<span class="muted small">An admin hasn't created it yet.</span>`}
        </div>
        <div class="picks-side-group">
          <div class="picks-side-title">My lists <button type="button" class="textbtn" id="new-list">+ New</button></div>
          ${mine.map(item).join("") || `<span class="muted small">Make your own pick list — every scout's list feeds the team's.</span>`}
        </div>
        <div class="picks-side-group">
          <div class="picks-side-title">Teammates (${others.length})</div>
          ${others.map(item).join("") || `<span class="muted small">None yet.</span>`}
        </div>
      </aside>
      <section class="picks-main">${open ? boardHtml(open) : `<div class="muted" style="padding:30px;">Pick or create a list.</div>`}</section>
    </div>`;

  host.querySelectorAll("[data-open-list]").forEach(b => b.onclick = () => { state.openListId = b.dataset.openList; lsSet(LS_LIST, state.openListId); renderPicks(); renderTeams(); });
  $("#new-list")?.addEventListener("click", () => createList(false));
  $("#create-primary")?.addEventListener("click", () => createList(true));
  if (open) wireBoard(open);
}

function consensus() {
  // One vote per scout: their most recently updated personal list
  const latest = new Map();
  state.lists.filter(l => !l.is_primary).forEach(l => {
    const prev = latest.get(l.owner_id);
    if (!prev || new Date(l.updated_at) > new Date(prev.updated_at)) latest.set(l.owner_id, l);
  });
  const lists = [...latest.values()];
  const tally = new Map();
  lists.forEach(l => {
    const ranked = ["tier1", "tier2", "tier3", "dnp"].flatMap(k => (l.tiers?.[k] || []).map(team => ({ team, tier: k })));
    ranked.forEach(({ team, tier }, i) => {
      const t = tally.get(team) || { team, votes: 0, posSum: 0, tiers: { tier1: 0, tier2: 0, tier3: 0, dnp: 0 } };
      t.votes++;
      t.posSum += ranked.length > 1 ? i / (ranked.length - 1) : 0;
      t.tiers[tier]++;
      tally.set(team, t);
    });
  });
  const result = new Map();
  tally.forEach(t => {
    const avgPos = t.posSum / t.votes;
    let tier;
    if (t.tiers.dnp / t.votes >= 0.5) tier = "dnp";
    else {
      const pickVotes = [...Array(t.tiers.tier1).fill(1), ...Array(t.tiers.tier2).fill(2), ...Array(t.tiers.tier3).fill(3)].sort();
      tier = `tier${pickVotes[Math.floor((pickVotes.length - 1) / 2)]}`;
    }
    result.set(t.team, { tier, score: Math.round((1 - avgPos) * 100), votes: t.votes, avgPos });
  });
  return { result, voters: lists.length, names: lists.map(l => l.owner_name) };
}

function boardHtml(list) {
  const editable = canEdit(list);
  const all = teamsOf().map(t => t.team);
  const placed = new Set(["tier1", "tier2", "tier3", "dnp"].flatMap(k => list.tiers?.[k] || []));
  const cols = { ...Object.fromEntries(["tier1", "tier2", "tier3", "dnp"].map(k => [k, (list.tiers?.[k] || []).filter(t => all.includes(t))])), uncat: all.filter(t => !placed.has(t)) };
  const cons = list.is_primary ? consensus() : null;
  const card = team => {
    const info = teamInfo(team);
    const s = teamStats(team);
    const c = cons?.result.get(team);
    return `<div class="pick-card ${editable ? "is-draggable" : ""}" data-team="${team}">
      <div class="pick-card-top"><strong>${team}</strong><span class="pick-name">${esc(info.nickname || "")}</span>
        ${c ? `<span class="pick-consensus" title="Consensus from ${c.votes} list(s)">${c.score}</span>` : ""}</div>
      <div class="pick-card-meta">
        <span title="Pit scouting">${state.pit.has(team) ? "Pit ✓" : "No pit"}</span>
        <span title="Average driver rating">Drv ${fmt(s.driver)}</span>
        <span title="Average teleop fuel">Tele ${fmt(s.teleFuel)}</span>
        <span title="Average climb points">Climb ${fmt(s.climbPts, 0)}</span>
      </div>
      ${editable ? `<select class="pick-move" aria-label="Move ${team}">${TIERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>` : ""}
    </div>`;
  };
  return `
    <div class="picks-toolbar">
      <div>
        <h3>${list.is_primary ? "★ " : ""}${esc(list.name)}</h3>
        <span class="muted small">${list.is_primary ? `Team primary · admins edit${list.tiers?._merged_at ? ` · last merged ${new Date(list.tiers._merged_at).toLocaleString()} from ${list.tiers._merged_from?.length || 0} scouts` : ""}` : `by ${esc(list.owner_name)}${editable ? " · drag cards between tiers" : " · view only"}`}</span>
      </div>
      <div class="picks-actions">
        ${list.is_primary && isAdmin() ? `<button type="button" class="btn btn--primary btn--sm" id="merge-lists">Merge everyone's lists (${cons.voters})</button>` : ""}
        ${!list.is_primary && editable ? `<button type="button" class="btn btn--ghost btn--sm" id="rename-list">Rename</button><button type="button" class="btn btn--ghost btn--sm" id="delete-list">Delete</button>` : ""}
        ${!editable && !list.is_primary ? `<button type="button" class="btn btn--ghost btn--sm" id="copy-list">Copy to my lists</button>` : ""}
      </div>
    </div>
    <div class="pick-board" id="pick-board">
      ${TIERS.map(([k, label]) => `
        <div class="pick-col pick-col-${k}">
          <div class="pick-col-head">${label} <span>${cols[k].length}</span></div>
          <div class="pick-col-body" data-tier="${k}">${cols[k].map(card).join("") || ""}</div>
        </div>`).join("")}
    </div>`;
}

async function saveTiers(list, tiers) {
  const keep = Object.fromEntries(Object.entries(list.tiers || {}).filter(([k]) => k.startsWith("_")));
  list.tiers = { ...keep, ...tiers };
  list.updated_at = new Date().toISOString();
  const { error } = await db().from("pick_lists").update({ tiers: list.tiers, updated_at: list.updated_at }).eq("id", list.id);
  if (error) ctx.toast("Couldn't save pick list: " + error.message, true);
}

function tiersFromBoard() {
  const t = {};
  document.querySelectorAll("#pick-board .pick-col-body").forEach(col => {
    if (col.dataset.tier === "uncat") return;
    t[col.dataset.tier] = [...col.querySelectorAll(".pick-card")].map(c => Number(c.dataset.team));
  });
  return t;
}

function wireBoard(list) {
  $("#merge-lists")?.addEventListener("click", async () => {
    const { result, voters, names } = consensus();
    if (!voters) return ctx.toast("No personal pick lists to merge yet.", true);
    if (!confirm(`Replace the primary list with the consensus of ${voters} scout list(s)?\n\n${names.join(", ")}`)) return;
    const tiers = { tier1: [], tier2: [], tier3: [], dnp: [] };
    [...result.entries()].sort((a, b) => a[1].avgPos - b[1].avgPos || b[1].votes - a[1].votes).forEach(([team, r]) => tiers[r.tier].push(team));
    await saveTiers(list, { ...tiers, _merged_at: new Date().toISOString(), _merged_from: names });
    ctx.logAction("PICKLIST_MERGED", "pick_lists", list.id, { event_key: state.key, voters, names });
    renderPicks();
    ctx.toast(`Merged ${voters} pick lists into the primary list.`);
  });
  $("#rename-list")?.addEventListener("click", async () => {
    const name = prompt("Pick list name", list.name);
    if (!name?.trim()) return;
    list.name = name.trim();
    await db().from("pick_lists").update({ name: list.name }).eq("id", list.id);
    renderPicks();
  });
  $("#delete-list")?.addEventListener("click", async () => {
    if (!confirm(`Delete “${list.name}”?`)) return;
    await db().from("pick_lists").delete().eq("id", list.id);
    state.openListId = null;
    await loadLists();
    renderPicks();
  });
  $("#copy-list")?.addEventListener("click", () => createList(false, list));

  if (!canEdit(list)) return;
  document.querySelectorAll("#pick-board .pick-move").forEach(sel => {
    const card = sel.closest(".pick-card");
    sel.value = card.closest(".pick-col-body").dataset.tier;
    sel.onchange = async () => {
      document.querySelector(`#pick-board .pick-col-body[data-tier="${sel.value}"]`).appendChild(card);
      await saveTiers(list, tiersFromBoard());
      renderPicks();
    };
  });
  enableBoardDrag(list);
}

async function createList(primary = false, copyFrom = null) {
  const name = primary ? "Team primary" : (prompt("Name your pick list", copyFrom ? `${copyFrom.name} (copy)` : `${myName()}'s list`) || "").trim();
  if (!name) return;
  const tiers = copyFrom ? Object.fromEntries(["tier1", "tier2", "tier3", "dnp"].map(k => [k, [...(copyFrom.tiers?.[k] || [])]])) : {};
  const { data, error } = await db().from("pick_lists").insert({
    event_key: state.key, owner_id: me().id, owner_name: myName(), name, is_primary: primary, tiers,
  }).select().single();
  if (error) return ctx.toast("Couldn't create list: " + error.message, true);
  state.openListId = data.id;
  lsSet(LS_LIST, data.id);
  await loadLists();
  renderPicks();
}

/* Drag & drop between tiers (mouse drags immediately; touch needs a long-press so the page still scrolls) */
let dragging = null;
function enableBoardDrag(list) {
  const board = $("#pick-board");
  board.onpointerdown = e => {
    const card = e.target.closest(".pick-card.is-draggable");
    if (!card || e.button > 0 || e.target.closest("select, button")) return;
    const st = { card, list, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== "mouse", active: false };
    dragging = st;
    if (st.touch) st.timer = setTimeout(() => dragging === st && startDrag(st, st.x, st.y), 280);
  };
}
function startDrag(st, x, y) {
  const r = st.card.getBoundingClientRect();
  st.ghost = st.card.cloneNode(true);
  st.ghost.classList.add("pick-ghost");
  Object.assign(st.ghost.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
  document.body.appendChild(st.ghost);
  st.ph = document.createElement("div");
  st.ph.className = "pick-placeholder";
  st.ph.style.height = r.height + "px";
  st.card.after(st.ph);
  st.card.style.display = "none";
  st.offX = x - r.left; st.offY = y - r.top;
  st.active = true;
}
function moveDrag(x, y) {
  const st = dragging;
  st.ghost.style.left = x - st.offX + "px";
  st.ghost.style.top = y - st.offY + "px";
  st.lastY = y;
  const col = [...document.querySelectorAll("#pick-board .pick-col")].find(c => {
    const r = c.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  })?.querySelector(".pick-col-body");
  if (!col) return;
  const before = [...col.querySelectorAll(".pick-card")].filter(c => c !== st.card).find(c => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  before ? col.insertBefore(st.ph, before) : col.appendChild(st.ph);
}
document.addEventListener("pointermove", e => {
  const st = dragging;
  if (!st || e.pointerId !== st.id) return;
  if (!st.active) {
    const dist = Math.hypot(e.clientX - st.x, e.clientY - st.y);
    if (st.touch) { if (dist > 8) { clearTimeout(st.timer); dragging = null; } return; }
    if (dist < 5) return;
    startDrag(st, e.clientX, e.clientY);
  }
  e.preventDefault();
  moveDrag(e.clientX, e.clientY);
  if (!st.scroll) st.scroll = setInterval(() => {
    if (!dragging?.active) return;
    const edge = 80, y = dragging.lastY;
    if (y < edge) window.scrollBy(0, -12); else if (y > innerHeight - edge) window.scrollBy(0, 12);
  }, 16);
}, { passive: false });
document.addEventListener("touchmove", e => { if (dragging?.active) e.preventDefault(); }, { passive: false });
const endDrag = async e => {
  const st = dragging;
  if (!st || e.pointerId !== st.id) return;
  clearTimeout(st.timer);
  clearInterval(st.scroll);
  dragging = null;
  if (!st.active) return;
  st.ghost.remove();
  st.ph.replaceWith(st.card);
  st.card.style.display = "";
  await saveTiers(st.list, tiersFromBoard());
  renderPicks();
};
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", endDrag);

/* ---------- event pane (admin import) ---------- */

function renderEventPane() {
  const host = $("#scout-pane-event");
  if (!host || host.hidden) return;
  const list = state.events.map(e => `
    <div class="itemrow scout-event-row">
      <span><strong>${esc(e.name || e.event_key)}</strong> <span class="muted small">${esc(e.event_key)}</span></span>
      <span class="small">${(e.teams || []).length} teams · ${(e.matches || []).length} quals</span>
      <span>${e.is_active ? '<span class="stock-pill stock-pill--in">Active</span>' : isAdmin() ? `<button type="button" class="btn btn--ghost btn--sm" data-activate="${esc(e.event_key)}">Set active</button>` : ""}</span>
      <span>${isAdmin() ? `<button type="button" class="actionbtn" data-reimport="${esc(e.event_key)}">Refresh</button> <button type="button" class="actionbtn delete" data-delete-event="${esc(e.event_key)}">Delete</button>` : ""}</span>
    </div>`).join("");

  host.innerHTML = `
    ${state.missingTables ? `<div class="scout-card scout-warn-box">The scouting tables aren't in the database yet. An admin needs to run <code>supabase/schema.sql</code> (or <code>tools/setup_supabase.sh</code>).</div>` : ""}
    <div class="scout-pane-head"><div><h3>Events</h3><span class="muted small">The active event is what every scout sees by default.</span></div></div>
    ${list || `<p class="muted small" style="padding:0 20px;">No events imported yet.</p>`}
    ${isAdmin() ? `
    <div class="scout-card" style="margin:16px 20px;">
      <div class="scout-phase-title"><span>Import from The Blue Alliance</span></div>
      <div class="formgrid">
        <div><label for="tba-event-key">Event key</label><input id="tba-event-key" placeholder="e.g. 2027casd" autocapitalize="off"></div>
        <div><label for="tba-key">TBA read key <span class="muted small">(saved in this browser only)</span></label><input id="tba-key" type="password" value="${esc(lsGet(LS_TBA))}" placeholder="thebluealliance.com/account"></div>
      </div>
      <div class="modalactions" style="margin-top:12px;"><button type="button" class="btn btn--primary" id="tba-import">Import teams & schedule</button></div>
      <details style="margin-top:10px;">
        <summary class="small">No schedule yet? Add teams by number</summary>
        <div class="formgrid" style="margin-top:8px;">
          <div><label for="manual-event-key">Event key</label><input id="manual-event-key" placeholder="2027casd"></div>
          <div><label for="manual-event-name">Event name</label><input id="manual-event-name" placeholder="San Diego Regional"></div>
        </div>
        <label for="manual-teams">Team numbers</label>
        <textarea id="manual-teams" rows="3" placeholder="11744, 254, 1678 …"></textarea>
        <div class="modalactions"><button type="button" class="btn btn--ghost" id="manual-save">Save event</button></div>
      </details>
    </div>` : `<p class="muted small" style="padding:0 20px;">Admins import events. You can switch which event you're viewing from the selector above.</p>`}`;

  $("#tba-import")?.addEventListener("click", () => importFromTba($("#tba-event-key").value.trim().toLowerCase(), $("#tba-key").value.trim()));
  $("#manual-save")?.addEventListener("click", saveManualEvent);
  host.querySelectorAll("[data-activate]").forEach(b => b.onclick = () => setActive(b.dataset.activate));
  host.querySelectorAll("[data-reimport]").forEach(b => b.onclick = () => importFromTba(b.dataset.reimport, lsGet(LS_TBA)));
  host.querySelectorAll("[data-delete-event]").forEach(b => b.onclick = async () => {
    if (!confirm(`Delete event ${b.dataset.deleteEvent}? Match reports stay; claims and the event's teams/schedule are removed.`)) return;
    await db().from("scout_events").delete().eq("event_key", b.dataset.deleteEvent);
    await load();
  });
}

async function importFromTba(key, tbaKey) {
  if (!/^\d{4}[a-z0-9]+$/.test(key)) return ctx.toast("Enter an event key like 2027casd.", true);
  if (!tbaKey) return ctx.toast("Paste a TBA read key (free at thebluealliance.com/account).", true);
  lsSet(LS_TBA, tbaKey);
  const get = async path => {
    const res = await fetch(`https://www.thebluealliance.com/api/v3${path}`, { headers: { "X-TBA-Auth-Key": tbaKey } });
    if (res.status === 401) throw new Error("TBA rejected the read key.");
    if (res.status === 404) throw new Error(`Event ${key} not found on TBA.`);
    if (!res.ok) throw new Error(`TBA error ${res.status}`);
    return res.json();
  };
  try {
    ctx.toast(`Importing ${key} from The Blue Alliance…`);
    const [info, teams, matches] = await Promise.all([get(`/event/${key}/simple`), get(`/event/${key}/teams/simple`), get(`/event/${key}/matches/simple`)]);
    const num = k => Number(String(k).replace("frc", ""));
    const row = {
      event_key: key,
      name: info.name || key,
      teams: teams.map(t => ({ team: t.team_number, nickname: t.nickname, city: t.city, state: t.state_prov, country: t.country })).sort((a, b) => a.team - b.team),
      matches: matches.filter(m => m.comp_level === "qm")
        .map(m => ({ match_num: m.match_number, red: m.alliances.red.team_keys.map(num), blue: m.alliances.blue.team_keys.map(num), time: m.time || m.predicted_time || null }))
        .sort((a, b) => a.match_num - b.match_num),
      imported_by_name: myName(),
      imported_at: new Date().toISOString(),
    };
    await upsertEvent(row);
    ctx.toast(`Imported ${row.name}: ${row.teams.length} teams, ${row.matches.length} qualification matches.`);
  } catch (err) {
    ctx.toast("Import failed: " + err.message, true);
  }
}

async function saveManualEvent() {
  const key = $("#manual-event-key").value.trim().toLowerCase();
  const teams = [...new Set(($("#manual-teams").value.match(/\d+/g) || []).map(Number))].filter(n => n > 0).sort((a, b) => a - b);
  if (!key || !teams.length) return ctx.toast("Enter an event key and at least one team number.", true);
  const existing = state.events.find(e => e.event_key === key);
  await upsertEvent({
    event_key: key,
    name: $("#manual-event-name").value.trim() || existing?.name || key,
    teams: teams.map(t => existing?.teams?.find(x => x.team === t) || { team: t, nickname: "" }),
    matches: existing?.matches || [],
    imported_by_name: myName(),
    imported_at: new Date().toISOString(),
  });
  ctx.toast(`Saved ${key} with ${teams.length} teams.`);
}

async function upsertEvent(row) {
  const makeActive = !state.events.some(e => e.is_active) || state.events.find(e => e.event_key === row.event_key)?.is_active;
  const { error } = await db().from("scout_events").upsert({ ...row, is_active: !!makeActive });
  if (error) throw new Error(error.message);
  ctx.logAction("SCOUT_EVENT_IMPORTED", "scout_events", row.event_key, { name: row.name, teams: row.teams.length, matches: row.matches.length });
  state.key = row.event_key;
  lsSet(LS_EVENT, row.event_key);
  await load();
}

async function setActive(key) {
  await db().from("scout_events").update({ is_active: false }).eq("is_active", true);
  const { error } = await db().from("scout_events").update({ is_active: true }).eq("event_key", key);
  if (error) return ctx.toast("Couldn't set active event: " + error.message, true);
  await load();
}

/* ---------- assign pane (admins): who scouts which robot in which match ---------- */

const STATIONS = ["R1", "R2", "R3", "B1", "B2", "B3"];
const teamAt = (m, st) => (st[0] === "R" ? m.red : m.blue)[Number(st[1]) - 1];

function renderAssign() {
  const host = $("#scout-pane-assign");
  if (!host || host.hidden) return;
  if (!isAdmin()) { host.innerHTML = ""; return; }
  const ev = event();
  const matches = ev?.matches || [];
  if (!matches.length) {
    host.innerHTML = `<div class="scout-card scout-picker-empty" style="margin:20px;">${ev ? "This event has no imported match schedule yet. Import it from The Blue Alliance under <b>Event</b> to assign scouts." : emptyEvent()}</div>`;
    return;
  }
  const first = matches[0].match_num, last = matches[matches.length - 1].match_num;
  const claimAt = (n, team) => state.claims.find(c => c.match_num === n && c.team_num === team);
  const load = new Map();
  state.claims.forEach(c => load.set(c.scout_id, (load.get(c.scout_id) || 0) + 1));
  const memberOpts = sel => `<option value="">—</option>` + state.members.map(m => `<option value="${m.id}" ${m.id === sel ? "selected" : ""}>${esc(m.full_name)}</option>`).join("");
  const unassigned = matches.reduce((n, m) => n + STATIONS.filter(st => !claimAt(m.match_num, teamAt(m, st))).length, 0);

  host.innerHTML = `
    <div class="scout-pane-head">
      <div><h3>Assign scouts</h3><span class="muted small">Admins only · ${matches.length} matches · ${unassigned} robot slots unassigned. Assigned scouts see the robot as theirs on the Match tab.</span></div>
    </div>

    <div class="assign-tools">
      <div class="scout-card">
        <div class="scout-phase-title"><span>Assign a range</span></div>
        <div class="assign-row">
          <select id="as-scout" aria-label="Scout">${memberOpts("")}</select>
          <select id="as-station" aria-label="Station">${STATIONS.map(s => `<option>${s}</option>`).join("")}</select>
          <label class="assign-range">Q<input id="as-from" type="number" min="${first}" max="${last}" value="${first}" aria-label="From match"></label>
          <label class="assign-range">to Q<input id="as-to" type="number" min="${first}" max="${last}" value="${Math.min(last, first + 9)}" aria-label="To match"></label>
          <button type="button" class="btn btn--primary btn--sm" id="as-apply">Assign</button>
        </div>
      </div>
      <div class="scout-card">
        <div class="scout-phase-title"><span>Auto-rotate</span><span class="muted small">${state.rotation.size} selected</span></div>
        <div class="scout-tags" id="as-rotation">
          ${state.members.map(m => `<label><input type="checkbox" value="${m.id}" ${state.rotation.has(m.id) ? "checked" : ""}><span>${esc(m.full_name)}</span></label>`).join("")}
        </div>
        <div class="assign-row">
          <label class="assign-range">Shift of <input id="ar-block" type="number" min="1" max="30" value="6" aria-label="Matches per shift"> matches</label>
          <label class="assign-range">Q<input id="ar-from" type="number" min="${first}" max="${last}" value="${first}" aria-label="From match"></label>
          <label class="assign-range">to Q<input id="ar-to" type="number" min="${first}" max="${last}" value="${last}" aria-label="To match"></label>
          <button type="button" class="btn btn--primary btn--sm" id="ar-apply">Fill range</button>
          <button type="button" class="btn btn--ghost btn--sm" id="ar-clear">Clear range</button>
        </div>
        <p class="muted small" style="margin:6px 0 0;">Six scouts are on duty each shift; the rest rest. Shifts rotate through everyone you select.</p>
      </div>
    </div>

    <div class="assign-load">
      ${state.members.filter(m => load.has(m.id)).map(m => `<span class="pill">${esc(m.full_name)} · ${load.get(m.id)}</span>`).join("") || `<span class="muted small">No one assigned yet.</span>`}
    </div>

    <div class="assign-grid-wrap">
      <table class="assign-grid">
        <thead><tr><th>Match</th>${STATIONS.map(st => `<th class="${st[0] === "R" ? "red" : "blue"}">${st}</th>`).join("")}</tr></thead>
        <tbody>
          ${matches.map(m => `<tr>
            <th>Q${m.match_num}</th>
            ${STATIONS.map(st => {
              const team = teamAt(m, st);
              const c = claimAt(m.match_num, team);
              return `<td class="${st[0] === "R" ? "red" : "blue"} ${c ? "is-set" : ""}">
                <span class="assign-team">${team ?? "—"}</span>
                <select data-assign-match="${m.match_num}" data-assign-team="${team}" aria-label="Scout for Q${m.match_num} ${st}">${memberOpts(c?.scout_id || "")}</select>
              </td>`;
            }).join("")}
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  host.querySelectorAll("[data-assign-match]").forEach(sel => sel.onchange = async () => {
    const n = Number(sel.dataset.assignMatch), team = Number(sel.dataset.assignTeam);
    await assignSlots([{ n, team, scoutId: sel.value || null }]);
  });
  $("#as-apply").onclick = async () => {
    const scoutId = $("#as-scout").value;
    if (!scoutId) return ctx.toast("Choose a scout first.", true);
    const st = $("#as-station").value, from = Number($("#as-from").value), to = Number($("#as-to").value);
    const slots = matches.filter(m => m.match_num >= from && m.match_num <= to).map(m => ({ n: m.match_num, team: teamAt(m, st), scoutId }));
    await assignSlots(slots, `Assigned ${memberName(scoutId)} to ${st} for ${slots.length} matches.`);
  };
  $("#as-rotation").onchange = e => {
    const cb = e.target.closest("input");
    if (!cb) return;
    cb.checked ? state.rotation.add(cb.value) : state.rotation.delete(cb.value);
    host.querySelector(".assign-tools .scout-card:nth-child(2) .scout-phase-title span:last-child").textContent = `${state.rotation.size} selected`;
  };
  $("#ar-apply").onclick = async () => {
    const people = state.members.filter(m => state.rotation.has(m.id)).map(m => m.id);
    if (!people.length) return ctx.toast("Select the scouts to rotate.", true);
    const block = Math.max(1, Number($("#ar-block").value) || 6);
    const from = Number($("#ar-from").value), to = Number($("#ar-to").value);
    const range = matches.filter(m => m.match_num >= from && m.match_num <= to);
    if (!confirm(`Fill Q${from}–Q${to} by rotating ${people.length} scouts in ${block}-match shifts? This replaces existing assignments in that range.`)) return;
    const slots = rotationPlan(range, people, block);
    await clearRange(from, to);
    await assignSlots(slots, `Filled ${range.length} matches with ${people.length} scouts.`);
  };
  $("#ar-clear").onclick = async () => {
    const from = Number($("#ar-from").value), to = Number($("#ar-to").value);
    if (!confirm(`Remove every assignment and claim from Q${from} to Q${to}?`)) return;
    await clearRange(from, to);
    await loadClaims();
    renderAssign();
    ctx.toast(`Cleared Q${from}–Q${to}.`);
  };
}

/* Six on duty per shift; the on-duty group advances through the roster each shift so everyone rests in turn */
function rotationPlan(range, people, block) {
  const slots = [];
  range.forEach((m, i) => {
    const shift = Math.floor(i / block);
    const onDuty = Math.min(6, people.length);
    STATIONS.slice(0, onDuty).forEach((st, k) => {
      const scoutId = people[(shift * onDuty + k) % people.length];
      slots.push({ n: m.match_num, team: teamAt(m, st), scoutId });
    });
  });
  return slots;
}

const memberName = id => state.members.find(m => m.id === id)?.full_name || "Scout";

async function clearRange(from, to) {
  const { error } = await db().from("scout_claims").delete().eq("event_key", state.key).gte("match_num", from).lte("match_num", to);
  if (error) ctx.toast("Couldn't clear: " + error.message, true);
}

/* slots: [{ n, team, scoutId|null }]. Frees the robot and the scout's other robot in that match, then writes. */
async function assignSlots(slots, doneMsg) {
  const valid = slots.filter(s => s.team != null);
  const removals = [];
  valid.forEach(s => {
    removals.push(db().from("scout_claims").delete().eq("event_key", state.key).eq("match_num", s.n).eq("team_num", s.team));
  });
  await Promise.all(removals);
  const rows = valid.filter(s => s.scoutId).map(s => ({
    event_key: state.key, match_num: s.n, team_num: s.team, scout_id: s.scoutId, scout_name: memberName(s.scoutId),
    assigned_by_name: myName(), claimed_at: new Date().toISOString(),
  }));
  // A scout can only hold one robot per match: drop their other robot in these matches first
  const byScout = new Map();
  rows.forEach(r => byScout.set(r.scout_id, [...(byScout.get(r.scout_id) || []), r.match_num]));
  await Promise.all([...byScout].map(([sid, ns]) => db().from("scout_claims").delete().eq("event_key", state.key).eq("scout_id", sid).in("match_num", ns)));
  let error = null;
  for (let i = 0; i < rows.length && !error; i += 200) {
    ({ error } = await db().from("scout_claims").insert(rows.slice(i, i + 200)));
  }
  await loadClaims();
  renderAssign();
  renderPicker();
  if (error) return ctx.toast("Some assignments failed: " + error.message, true);
  ctx.logAction("SCOUT_ASSIGNMENTS", "scout_claims", state.key, { event_key: state.key, slots: rows.length });
  if (doneMsg) ctx.toast(doneMsg);
}

/* ---------- shared bits ---------- */

function emptyEvent() {
  return `<div class="scout-card scout-picker-empty" style="margin:20px;">${state.missingTables
    ? "Scouting tables aren't set up in the database yet — an admin needs to run <code>schema.sql</code>."
    : `No event selected. ${isAdmin() ? "Import one under <b>Event</b>." : "Ask an admin to import the event."}`}</div>`;
}

function ensureModal() {
  if ($("#scout-hub-modal")) return;
  const el = document.createElement("div");
  el.id = "scout-hub-modal";
  el.className = "modalback hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `<div class="modal" style="max-width:640px;">
    <div class="modalhead"><div><h2 id="scout-modal-title"></h2><p class="muted small" id="scout-modal-sub"></p></div>
    <button class="close" type="button" data-close-modal aria-label="Close">×</button></div>
    <div id="scout-modal-body"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", e => { if (e.target === el || e.target.closest("[data-close-modal]")) closeModal(); });
}
function openModal(title, sub, html) {
  $("#scout-modal-title").textContent = title;
  $("#scout-modal-sub").textContent = sub || "";
  $("#scout-modal-body").innerHTML = html;
  $("#scout-hub-modal").classList.remove("hidden");
}
function closeModal() { $("#scout-hub-modal")?.classList.add("hidden"); }
