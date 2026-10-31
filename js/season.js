/* Build season schedule: a Notion-style checklist of weeks, gates and tasks with notes.
 * Every date is clickable: it shows what should be done by then and lets you view the schedule "as of" that day,
 * so the team can see whether it is on track. Admins and moderators edit; everyone reads.
 * Tables: season_sections, season_tasks. */
import { SEASON_TEMPLATE } from "./season_template.js?v=20261031a";

const SEASON = "2027";
let ctx = null;
const state = { sections: [], tasks: [], asOf: null, filter: "all", openNotes: new Set(), editingBody: null, focusTask: null, pendingReload: false, missing: false, loaded: false };

const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();
const isStaff = () => !!(ctx.getProfile()?.is_admin || ctx.getProfile()?.is_moderator);
const myName = () => ctx.getProfile()?.full_name || ctx.getUser()?.email || "Member";

/* ---------- dates (YYYY-MM-DD strings, local time) ---------- */
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = s => new Date(s + "T00:00:00");
const todayIso = () => iso(new Date());
const asOf = () => state.asOf || todayIso();
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const fmt = (s, opts = { month: "short", day: "numeric" }) => s ? parse(s).toLocaleDateString(undefined, opts) : "";
const fmtLong = s => fmt(s, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
const relDays = (s, from = asOf()) => {
  const n = daysBetween(from, s);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
};

/* ---------- derived status ---------- */
const sectionOf = id => state.sections.find(s => s.id === id);
const tasksOf = sid => state.tasks.filter(t => t.section_id === sid).sort((a, b) => a.sort - b.sort);
const dueOf = t => t.due_date || sectionOf(t.section_id)?.end_date || null;
const isOverdue = t => !t.done && dueOf(t) && dueOf(t) < asOf();
const dueBy = date => state.tasks.filter(t => dueOf(t) && dueOf(t) <= date);

function sectionStatus(s) {
  const ts = tasksOf(s.id);
  if (s.kind === "info" || !s.start_date || !s.end_date) return null;
  const A = asOf();
  if (ts.length && ts.every(t => t.done) && (!s.gate_date || s.gate_done)) return "done";
  if (A < s.start_date) return "upcoming";
  if (ts.some(isOverdue) || (s.gate_date && !s.gate_done && s.gate_date < A)) return "behind";
  const span = daysBetween(s.start_date, s.end_date) + 1;
  const elapsed = Math.min(1, (daysBetween(s.start_date, A) + 1) / span);
  const doneFrac = ts.length ? ts.filter(t => t.done).length / ts.length : 1;
  return doneFrac < elapsed - 0.34 ? "at-risk" : "on-track";
}
const STATUS_LABEL = { done: "Done", upcoming: "Upcoming", behind: "Behind", "at-risk": "At risk", "on-track": "On track" };
const gateStatus = s => s.gate_done ? "met" : s.gate_date < asOf() ? "missed" : daysBetween(asOf(), s.gate_date) <= 3 ? "soon" : "upcoming";

function health() {
  const A = asOf();
  const weeks = state.sections.filter(s => s.start_date && s.end_date);
  const first = weeks.map(s => s.start_date).sort()[0];
  const total = state.tasks.length;
  const done = state.tasks.filter(t => t.done).length;
  const expected = state.tasks.filter(t => dueOf(t) && dueOf(t) < A).length;
  const overdue = state.tasks.filter(isOverdue).sort((a, b) => dueOf(a).localeCompare(dueOf(b)));
  const missedGates = state.sections.filter(s => s.gate_date && !s.gate_done && s.gate_date < A);
  const oldest = [overdue[0] && dueOf(overdue[0]), ...missedGates.map(s => s.gate_date)].filter(Boolean).sort()[0];
  const daysBehind = oldest ? daysBetween(oldest, A) : 0;
  const status = first && A < first ? "pre" : !overdue.length && !missedGates.length ? "on-track" : daysBehind <= 3 && !missedGates.length ? "at-risk" : "behind";
  const firstOpen = weeks.filter(s => s.kind === "week").sort((a, b) => a.sort - b.sort).find(s => sectionStatus(s) !== "done");
  return { A, first, total, done, expected, overdue, missedGates, daysBehind, oldest, status, firstOpen };
}

/* ---------- lifecycle ---------- */
let started = false;
export function initSeason(context) {
  ctx = context;
  if (started) return render();
  started = true;
  ensurePopover();
  const host = $("#season-body");
  host.addEventListener("focusout", () => setTimeout(() => {
    if (state.pendingReload && !host.contains(document.activeElement)) { state.pendingReload = false; load(); }
  }, 50));
  load();
  try {
    let ch = db().channel("nyx-season");
    ["season_sections", "season_tasks"].forEach(t => {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, () => { clearTimeout(state.t); state.t = setTimeout(softReload, 400); });
    });
    ch.subscribe();
  } catch { /* realtime optional */ }
}

function softReload() {
  const host = $("#season-body");
  const a = document.activeElement;
  if (host?.contains(a) && (a.isContentEditable || a.tagName === "TEXTAREA" || a.tagName === "INPUT")) { state.pendingReload = true; return; }
  load();
}

async function load() {
  const [s, t] = await Promise.all([
    db().from("season_sections").select("*").eq("season", SEASON).order("sort"),
    db().from("season_tasks").select("*").order("sort"),
  ]);
  state.missing = !!s.error && /relation|does not exist|schema cache/i.test(s.error.message);
  state.sections = s.data || [];
  const ids = new Set(state.sections.map(x => x.id));
  state.tasks = (t.data || []).filter(x => ids.has(x.section_id));
  state.loaded = true;
  render();
}

/* ---------- rendering ---------- */
function render() {
  const host = $("#season-body");
  if (!host) return;
  if (state.missing) {
    host.innerHTML = `<div class="scout-card scout-warn-box">Season schedule tables aren't in the database yet — an admin needs to run <code>supabase/schema.sql</code>.</div>`;
    return;
  }
  if (!state.loaded) { host.innerHTML = `<div class="muted">Loading…</div>`; return; }
  if (!state.sections.length) {
    host.innerHTML = `<div class="scout-card ss-empty">
      <h3>No ${SEASON} schedule yet</h3>
      <p class="muted">${isStaff() ? "Start from the 2027 build season plan (10 weeks, 6 gates, competition checklist) and edit it from there." : "An admin or moderator needs to set up the schedule."}</p>
      ${isStaff() ? `<button type="button" class="btn btn--primary" id="ss-load-template">Load ${SEASON} build season template</button>` : ""}
    </div>`;
    $("#ss-load-template")?.addEventListener("click", loadTemplate);
    return;
  }
  const h = health();
  host.innerHTML = `
    <div class="ss-toolbar">
      <div class="ss-asof">
        <span class="muted small">Checking progress as of</span>
        <button type="button" class="ss-step" data-asof-step="-7" title="Back a week" aria-label="Back a week">‹</button>
        <input type="date" id="ss-asof-input" value="${h.A}" aria-label="As-of date">
        <button type="button" class="ss-step" data-asof-step="7" title="Forward a week" aria-label="Forward a week">›</button>
        ${state.asOf ? `<button type="button" class="btn btn--ghost btn--sm" id="ss-asof-today">Back to today</button>` : `<span class="ss-today-pill">Today</span>`}
      </div>
      <div class="duty-toggle" role="group" aria-label="Filter items">
        ${[["all", "All"], ["open", "Open"], ["overdue", `Overdue${h.overdue.length ? ` (${h.overdue.length})` : ""}`]].map(([k, l]) => `<button type="button" class="${state.filter === k ? "active" : ""}" data-ss-filter="${k}">${l}</button>`).join("")}
      </div>
    </div>
    ${healthHtml(h)}
    ${timelineHtml()}
    <div class="ss-sections">${state.sections.map(sectionHtml).join("")}</div>
    ${isStaff() ? `<div class="ss-add-section">
      <span class="muted small">Add section</span>
      <button type="button" class="btn btn--ghost btn--sm" data-add-section="week">＋ Week</button>
      <button type="button" class="btn btn--ghost btn--sm" data-add-section="checklist">＋ Checklist</button>
      <button type="button" class="btn btn--ghost btn--sm" data-add-section="info">＋ Text</button>
    </div>` : ""}`;
  bind(host);
  if (state.focusTask) {
    const el = host.querySelector(`[data-task="${state.focusTask}"] .ss-text`);
    state.focusTask = null;
    if (el) { el.focus(); placeCaretAtEnd(el); }
  }
}

function healthHtml(h) {
  const pct = n => h.total ? Math.round(n / h.total * 100) : 0;
  const bar = `<div class="ss-progress" title="${pct(h.done)}% done · ${pct(h.expected)}% was due before ${fmt(h.A)}">
      <div class="ss-progress-fill" style="width:${pct(h.done)}%"></div>
      ${h.status !== "pre" ? `<div class="ss-progress-expected" style="left:${pct(h.expected)}%"><span>should be here</span></div>` : ""}
    </div>`;
  let title, text;
  if (h.status === "pre") {
    title = `Kickoff ${relDays(h.first)}`;
    text = `The schedule starts ${fmtLong(h.first)}. Nothing is due yet.`;
  } else if (h.status === "on-track") {
    title = "On schedule";
    text = `Everything due before ${fmt(h.A)} is done.`;
  } else {
    title = h.status === "behind" ? `Behind schedule by ${h.daysBehind} day${h.daysBehind === 1 ? "" : "s"}` : "Slipping";
    const parts = [];
    if (h.overdue.length) parts.push(`${h.overdue.length} item${h.overdue.length === 1 ? "" : "s"} overdue`);
    if (h.missedGates.length) parts.push(`${h.missedGates.length} gate${h.missedGates.length === 1 ? "" : "s"} missed (${h.missedGates.map(s => esc(s.gate_label || s.label)).join(", ")})`);
    text = `${parts.join(" and ")}; the oldest was due ${fmtLong(h.oldest)}.${h.firstOpen ? ` Earliest unfinished: <b>${esc(h.firstOpen.label)} · ${esc(h.firstOpen.title)}</b>.` : ""}`;
  }
  return `<div class="ss-health ss-health--${h.status}">
    <div class="ss-health-main">
      <div><strong>${title}</strong><p>${text}</p></div>
      <div class="ss-health-stats">
        <span><b>${h.done}</b>/${h.total} done</span>
        ${h.status !== "pre" ? `<span><b>${h.expected}</b> due by ${fmt(h.A)}</span>` : ""}
        ${h.overdue.length ? `<button type="button" class="btn btn--ghost btn--sm" data-ss-filter="overdue">Show overdue</button>` : ""}
      </div>
    </div>
    ${bar}
  </div>`;
}

function timelineHtml() {
  const weeks = state.sections.filter(s => s.kind === "week" && s.start_date && s.end_date);
  if (!weeks.length) return "";
  const start = weeks.map(s => s.start_date).sort()[0];
  const end = weeks.map(s => s.end_date).sort().at(-1);
  const span = daysBetween(start, end) + 1;
  const pos = d => Math.max(0, Math.min(100, daysBetween(start, d) / span * 100));
  const months = [];
  for (let d = parse(start); iso(d) <= end; d.setMonth(d.getMonth() + 1, 1)) months.push(iso(d) < start ? start : iso(d));
  const gates = state.sections.filter(s => s.gate_date);
  const A = asOf();
  return `<div class="ss-timeline" aria-label="Build season timeline">
    <div class="ss-tl-head"><span class="muted small">Build season timeline · ${weeks.length} weeks, ${gates.length} gates — click anywhere to check progress on that day</span></div>
    <div class="ss-tl-track" data-tl-start="${start}" data-tl-span="${span}">
      ${months.map(m => `<span class="ss-tl-month" style="left:${pos(m)}%">${fmt(m, { month: "short" })}</span>`).join("")}
      ${weeks.map(s => {
        const st = sectionStatus(s);
        return `<button type="button" class="ss-tl-week ss-st--${st}" style="left:${pos(s.start_date)}%; width:${pos(addDays(s.end_date, 1)) - pos(s.start_date)}%"
          data-jump="${s.id}" title="${esc(s.label)} · ${esc(s.title)} (${fmt(s.start_date)}–${fmt(s.end_date)}): ${STATUS_LABEL[st]}">
          <span>${esc(s.label.replace(/^Week\s*/i, "W"))}</span></button>`;
      }).join("")}
      ${gates.map(s => `<button type="button" class="ss-tl-gate ss-gate--${gateStatus(s)}" style="left:${pos(s.gate_date)}%"
          data-date="${s.gate_date}" data-date-field="gate_date" data-section="${s.id}" title="Gate · ${fmt(s.gate_date)}: ${esc(s.gate_label)}"></button>`).join("")}
      ${A >= start && A <= end ? `<span class="ss-tl-now" style="left:${pos(A) + (100 / span) / 2}%"><span>${state.asOf ? fmt(A) : "Today"}</span></span>` : ""}
    </div>
  </div>`;
}

function dateChip(date, attrs, extraCls = "") {
  if (!date) return "";
  return `<button type="button" class="ss-date ${extraCls}" data-date="${date}" ${attrs}>${fmt(date)}</button>`;
}

function sectionHtml(s) {
  const staff = isStaff();
  const st = sectionStatus(s);
  const ts = tasksOf(s.id);
  const done = ts.filter(t => t.done).length;
  const A = asOf();
  const current = s.start_date && s.end_date && A >= s.start_date && A <= s.end_date && s.kind === "week";
  const groups = [];
  ts.forEach(t => { let g = groups.find(x => x.team === t.team); if (!g) groups.push(g = { team: t.team, tasks: [] }); g.tasks.push(t); });
  const visible = t => state.filter === "all" || (state.filter === "open" ? !t.done : isOverdue(t));
  const anyVisible = ts.some(visible) || (state.filter === "overdue" && s.gate_date && gateStatus(s) === "missed");
  if (state.filter !== "all" && s.kind !== "info" && !anyVisible) return "";
  if (state.filter === "overdue" && s.kind === "info") return "";
  const ce = staff ? `contenteditable="true" spellcheck="true"` : "";
  return `<section class="ss-section ss-kind-${s.kind} ${current ? "is-current" : ""} ss-st--${st || "none"}" id="ss-${s.id}" data-section="${s.id}">
    <header class="ss-sec-head">
      <div class="ss-sec-titles">
        <div class="ss-sec-meta">
          <span class="ss-label" ${ce} data-sec-field="label">${esc(s.label)}</span>
          ${s.start_date ? `<span class="ss-range">${dateChip(s.start_date, `data-date-field="start_date" data-section="${s.id}"`)}–${dateChip(s.end_date, `data-date-field="end_date" data-section="${s.id}"`)}</span>` : ""}
          ${current ? `<span class="ss-pill ss-pill--current">${state.asOf ? "That week" : "This week"}</span>` : ""}
          ${st ? `<span class="ss-pill ss-pill--${st}">${STATUS_LABEL[st]}</span>` : ""}
        </div>
        <h3 class="ss-title" ${ce} data-sec-field="title">${esc(s.title)}</h3>
      </div>
      <div class="ss-sec-side">
        ${ts.length ? `<span class="ss-count" title="${done} of ${ts.length} done"><span class="ss-mini"><i style="width:${Math.round(done / ts.length * 100)}%"></i></span>${done}/${ts.length}</span>` : ""}
        ${staff ? `<button type="button" class="ss-icon" data-sec-menu="${s.id}" aria-label="Section options" title="Section options"><i class=fa-ellipsis aria-hidden=true></i></button>` : ""}
      </div>
    </header>
    ${s.gate_date ? gateHtml(s) : ""}
    ${bodyHtml(s)}
    ${groups.map(g => `<div class="ss-group" data-team="${esc(g.team)}">
      ${g.team || s.kind === "week" ? `<div class="ss-team" ${ce} data-team-name="${esc(g.team)}">${esc(g.team)}</div>` : ""}
      ${g.tasks.filter(visible).map(taskHtml).join("")}
      ${staff && state.filter === "all" ? `<button type="button" class="ss-add" data-add-task="${esc(g.team)}">＋ Add item</button>` : ""}
    </div>`).join("")}
    ${staff && state.filter === "all" && s.kind !== "info" ? `<div class="ss-sec-foot">
      ${!groups.length ? `<button type="button" class="ss-add" data-add-task="">＋ Add item</button>` : ""}
      ${s.kind === "week" ? `<button type="button" class="ss-add" data-add-group>＋ Add group</button>` : ""}
    </div>` : ""}
    ${notesHtml(s)}
  </section>`;
}

function gateHtml(s) {
  const gs = gateStatus(s);
  return `<div class="ss-gate ss-gate--${gs}">
    <label class="ss-checkwrap"><input type="checkbox" class="ss-check" data-gate-check ${s.gate_done ? "checked" : ""} ${isStaff() ? "" : "disabled"} aria-label="Gate passed"></label>
    <span class="ss-gate-tag">Gate</span>
    <span class="ss-gate-text" ${isStaff() ? `contenteditable="true"` : ""} data-sec-field="gate_label">${esc(s.gate_label)}</span>
    ${dateChip(s.gate_date, `data-date-field="gate_date" data-section="${s.id}"`, gs === "missed" ? "is-overdue" : "")}
    ${s.gate_done ? `<span class="muted small">passed${s.gate_done_by_name ? ` · ${esc(s.gate_done_by_name)}` : ""}</span>` : gs === "missed" ? `<span class="ss-pill ss-pill--behind">Missed</span>` : ""}
  </div>`;
}

function bodyHtml(s) {
  if (state.editingBody === s.id) {
    return `<textarea class="ss-body-edit" data-body-edit rows="${Math.max(3, s.body.split("\n").length + 1)}" placeholder="Write a goal or notes. **bold**, - bullets">${esc(s.body)}</textarea>
      <p class="muted small ss-hint">Markdown: **bold**, *italic*, - bullet. Click outside to save.</p>`;
  }
  if (!s.body && !isStaff()) return "";
  return `<div class="ss-body ${isStaff() ? "is-editable" : ""}" data-body ${isStaff() ? `tabindex="0" title="Click to edit"` : ""}>${s.body ? md(s.body) : `<span class="muted">Click to add a description…</span>`}</div>`;
}

function notesHtml(s) {
  const open = state.openNotes.has("s:" + s.id);
  if (!s.notes && !isStaff()) return "";
  return `<div class="ss-sec-notes">
    <button type="button" class="ss-notes-toggle ${s.notes ? "has" : ""}" data-sec-notes><i class=fa-note-sticky aria-hidden=true></i> ${s.notes ? "Notes" : "Add notes"} ${open ? "▾" : "▸"}</button>
    ${open ? (isStaff() ? `<textarea class="ss-note-area" data-sec-notes-area rows="3" placeholder="Retro notes, blockers, decisions…">${esc(s.notes)}</textarea>` : `<div class="ss-note-read">${md(s.notes)}</div>`) : ""}
  </div>`;
}

function taskHtml(t) {
  const staff = isStaff();
  const over = isOverdue(t);
  const due = dueOf(t);
  const custom = !!t.due_date;
  const open = state.openNotes.has(t.id);
  const lateBy = over ? daysBetween(due, asOf()) : 0;
  return `<div class="ss-task ${t.done ? "is-done" : ""} ${over ? "is-overdue" : ""}" data-task="${t.id}">
    <div class="ss-task-row">
      <label class="ss-checkwrap"><input type="checkbox" class="ss-check" data-check ${t.done ? "checked" : ""} ${staff ? "" : "disabled"} aria-label="Done"></label>
      <div class="ss-text" ${staff ? `contenteditable="true"` : ""} data-task-text>${esc(t.text)}</div>
      <div class="ss-task-side">
        ${t.done && t.done_at ? `<span class="ss-doneby" title="Checked by ${esc(t.done_by_name)} on ${fmtLong(t.done_at.slice(0, 10))}">${esc((t.done_by_name || "").split(" ")[0])} · ${fmt(t.done_at.slice(0, 10))}</span>` : ""}
        ${due ? `<button type="button" class="ss-date ${over ? "is-overdue" : ""} ${custom ? "is-custom" : "is-default"}" data-date="${due}" data-date-field="due_date" data-task-id="${t.id}"
            title="${over ? `Overdue by ${lateBy} day${lateBy === 1 ? "" : "s"}` : `Due ${fmtLong(due)}`}">${over ? `${lateBy}d late` : fmt(due)}</button>` : ""}
        <button type="button" class="ss-icon ss-note-btn ${t.notes ? "has" : ""}" data-task-notes title="${t.notes ? "Notes" : "Add a note"}" aria-label="Notes"><i class=fa-note-sticky aria-hidden=true></i></button>
        ${staff ? `<button type="button" class="ss-icon ss-del" data-task-del title="Delete item" aria-label="Delete item"><i class=fa-xmark aria-hidden=true></i></button>` : ""}
      </div>
    </div>
    ${open ? (staff ? `<textarea class="ss-note-area" data-task-notes-area rows="2" placeholder="Add a note…">${esc(t.notes)}</textarea>` : `<div class="ss-note-read">${t.notes ? md(t.notes) : `<span class="muted">No notes.</span>`}</div>`) : t.notes ? `<div class="ss-note-preview" data-task-notes>${esc(t.notes.split("\n")[0])}</div>` : ""}
  </div>`;
}

/* Tiny markdown: paragraphs, - bullets, **bold**, *italic*, `code` */
function md(text) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*(?!\s)(.+?)\*(?=\W|$)/g, "$1<i>$2</i>").replace(/`(.+?)`/g, "<code>$1</code>");
  return text.split(/\n{2,}/).map(par => {
    const lines = par.split("\n");
    if (lines.every(l => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

/* ---------- interaction ---------- */
function bind(host) {
  host.querySelectorAll("[data-ss-filter]").forEach(b => b.onclick = () => { state.filter = b.dataset.ssFilter; render(); });
  host.querySelectorAll("[data-asof-step]").forEach(b => b.onclick = () => setAsOf(addDays(asOf(), Number(b.dataset.asofStep))));
  $("#ss-asof-input").onchange = e => e.target.value && setAsOf(e.target.value);
  $("#ss-asof-today")?.addEventListener("click", () => setAsOf(null));

  const track = host.querySelector(".ss-tl-track");
  track?.addEventListener("click", e => {
    if (e.target.closest("[data-date]")) return;
    const r = track.getBoundingClientRect();
    const day = Math.floor((e.clientX - r.left) / r.width * Number(track.dataset.tlSpan));
    setAsOf(addDays(track.dataset.tlStart, Math.max(0, day)));
    const wk = e.target.closest("[data-jump]");
    if (wk) document.getElementById("ss-" + wk.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  host.querySelectorAll("[data-date]").forEach(b => b.onclick = e => { e.stopPropagation(); openDatePopover(b); });

  host.querySelectorAll("[data-section]").forEach(sec => {
    if (!sec.classList.contains("ss-section")) return;
    const sid = sec.dataset.section;
    sec.querySelectorAll("[data-sec-field]").forEach(el => bindInlineText(el, v => saveSection(sid, { [el.dataset.secField]: v })));
    sec.querySelector("[data-gate-check]")?.addEventListener("change", e => {
      saveSection(sid, { gate_done: e.target.checked, gate_done_by_name: e.target.checked ? myName() : "" });
      if (e.target.checked) ctx.logAction("SEASON_GATE_PASSED", "season_sections", sid, { gate: sectionOf(sid)?.gate_label });
    });
    const body = sec.querySelector("[data-body].is-editable");
    if (body) {
      const edit = e => { if (e.target.closest("a")) return; state.editingBody = sid; render(); const ta = $(`#ss-${sid} [data-body-edit]`); ta?.focus(); };
      body.onclick = edit;
      body.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); edit(e); } };
    }
    const ta = sec.querySelector("[data-body-edit]");
    if (ta) {
      autosize(ta);
      ta.oninput = () => autosize(ta);
      ta.onblur = () => { state.editingBody = null; saveSection(sid, { body: ta.value.trim() }, true); };
      ta.onkeydown = e => { if (e.key === "Escape") ta.blur(); };
    }
    sec.querySelector("[data-sec-notes]")?.addEventListener("click", () => toggleNotes("s:" + sid));
    const na = sec.querySelector("[data-sec-notes-area]");
    if (na) { autosize(na); na.oninput = debounceSave(na, v => saveSection(sid, { notes: v })); }
    sec.querySelector("[data-sec-menu]")?.addEventListener("click", e => { e.stopPropagation(); openSectionMenu(e.currentTarget, sid); });
    sec.querySelectorAll("[data-add-task]").forEach(b => b.onclick = () => addTask(sid, b.dataset.addTask));
    sec.querySelector("[data-add-group]")?.addEventListener("click", () => {
      const name = prompt("Group name (e.g. CAD, Software, Whole team):");
      if (name?.trim()) addTask(sid, name.trim());
    });
    sec.querySelectorAll("[data-team-name]").forEach(el => bindInlineText(el, v => renameTeam(sid, el.dataset.teamName, v), true));
  });

  host.querySelectorAll("[data-task]").forEach(row => {
    const id = row.dataset.task;
    row.querySelector("[data-check]")?.addEventListener("change", e => toggleTask(id, e.target.checked));
    row.querySelectorAll("[data-task-notes]").forEach(b => b.onclick = () => toggleNotes(id));
    row.querySelector("[data-task-del]")?.addEventListener("click", () => deleteTask(id));
    const na = row.querySelector("[data-task-notes-area]");
    if (na) { autosize(na); na.oninput = debounceSave(na, v => saveTask(id, { notes: v })); }
    const text = row.querySelector("[data-task-text][contenteditable]");
    if (text) {
      text.onkeydown = e => {
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitTaskText(id, text); addTaskAfter(id); }
        else if (e.key === "Backspace" && !text.textContent.trim()) { e.preventDefault(); deleteTask(id, true); }
        else if (e.key === "Escape") text.blur();
        else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (e.altKey)) { e.preventDefault(); commitTaskText(id, text); moveTask(id, e.key === "ArrowUp" ? -1 : 1); }
      };
      text.onblur = () => commitTaskText(id, text);
      text.onpaste = plainPaste;
    }
  });

  host.querySelectorAll("[data-add-section]").forEach(b => b.onclick = () => addSection(b.dataset.addSection));
}

function bindInlineText(el, save, allowEmpty) {
  if (!el.isContentEditable) return;
  const original = el.textContent;
  el.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } else if (e.key === "Escape") { el.textContent = original; el.blur(); } };
  el.onpaste = plainPaste;
  el.onblur = () => {
    const v = el.textContent.replace(/\s+/g, " ").trim();
    if (v === original.trim()) return;
    if (!v && !allowEmpty) { el.textContent = original; return; }
    save(v);
  };
}

function plainPaste(e) {
  e.preventDefault();
  document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") || "").replace(/\s*\n\s*/g, " "));
}

function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; }
function debounceSave(ta, save) {
  let timer;
  return () => { autosize(ta); clearTimeout(timer); timer = setTimeout(() => save(ta.value), 600); };
}
function placeCaretAtEnd(el) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

function setAsOf(d) {
  state.asOf = d && d !== todayIso() ? d : null;
  render();
}
function toggleNotes(key) {
  state.openNotes.has(key) ? state.openNotes.delete(key) : state.openNotes.add(key);
  render();
  const area = key.startsWith("s:") ? $(`#ss-${key.slice(2)} [data-sec-notes-area]`) : $(`[data-task="${key}"] [data-task-notes-area]`);
  area?.focus();
}

/* ---------- writes ---------- */
async function saveSection(id, patch, rerender) {
  const s = sectionOf(id);
  if (s) Object.assign(s, patch);
  if (rerender || "gate_done" in patch) render();
  const { error } = await db().from("season_sections").update({ ...patch, updated_by_name: myName(), updated_at: new Date().toISOString() }).eq("id", id);
  if (error) { ctx.toast("Couldn't save: " + error.message, true); load(); }
}

async function saveTask(id, patch, rerender) {
  const t = state.tasks.find(x => x.id === id);
  if (t) Object.assign(t, patch);
  if (rerender) render();
  const { error } = await db().from("season_tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) { ctx.toast("Couldn't save: " + error.message, true); load(); }
}

function commitTaskText(id, el) {
  const t = state.tasks.find(x => x.id === id);
  const v = el.textContent.replace(/\s+/g, " ").trim();
  if (t && v && v !== t.text) saveTask(id, { text: v });
}

function toggleTask(id, done) {
  const t = state.tasks.find(x => x.id === id);
  saveTask(id, { done, done_at: done ? new Date().toISOString() : null, done_by_name: done ? myName() : "" }, true);
  if (done) ctx.logAction("SEASON_TASK_DONE", "season_tasks", id, { task: t?.text, week: sectionOf(t?.section_id)?.label });
}

async function addTask(sectionId, team, sort) {
  const ts = tasksOf(sectionId);
  const row = { section_id: sectionId, team: team || "", text: "New item", sort: sort ?? ((ts.at(-1)?.sort || 0) + 1000) };
  const { data, error } = await db().from("season_tasks").insert(row).select().single();
  if (error) return ctx.toast("Couldn't add: " + error.message, true);
  state.tasks.push(data);
  state.focusTask = data.id;
  render();
  const el = $(`[data-task="${data.id}"] .ss-text`);
  if (el) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
}

function addTaskAfter(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const siblings = tasksOf(t.section_id);
  const next = siblings[siblings.indexOf(t) + 1];
  addTask(t.section_id, t.team, next ? (t.sort + next.sort) / 2 : t.sort + 1000);
}

async function moveTask(id, dir) {
  const t = state.tasks.find(x => x.id === id);
  const group = tasksOf(t.section_id).filter(x => x.team === t.team);
  const i = group.indexOf(t), j = i + dir;
  if (j < 0 || j >= group.length) return;
  const other = group[j];
  [t.sort, other.sort] = [other.sort, t.sort];
  state.focusTask = id;
  render();
  await Promise.all([saveTask(t.id, { sort: t.sort }), saveTask(other.id, { sort: other.sort })]);
}

async function deleteTask(id, focusPrev) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  if (!focusPrev && t.text !== "New item" && !confirm(`Delete “${t.text}”?`)) return;
  const siblings = tasksOf(t.section_id);
  const prev = siblings[siblings.indexOf(t) - 1];
  state.tasks = state.tasks.filter(x => x.id !== id);
  if (focusPrev && prev) state.focusTask = prev.id;
  render();
  const { error } = await db().from("season_tasks").delete().eq("id", id);
  if (error) { ctx.toast("Couldn't delete: " + error.message, true); load(); }
}

async function renameTeam(sectionId, from, to) {
  const ids = tasksOf(sectionId).filter(t => t.team === from).map(t => t.id);
  state.tasks.forEach(t => { if (ids.includes(t.id)) t.team = to; });
  const { error } = await db().from("season_tasks").update({ team: to }).in("id", ids);
  if (error) { ctx.toast(error.message, true); load(); }
}

async function addSection(kind) {
  const last = state.sections.at(-1);
  const lastWeek = [...state.sections].reverse().find(s => s.end_date);
  const weekNo = state.sections.filter(s => s.kind === "week").length + 1;
  const start = lastWeek ? addDays(lastWeek.end_date, 1) : todayIso();
  const row = {
    season: SEASON, kind, sort: (last?.sort || 0) + 1000, updated_by_name: myName(),
    label: kind === "week" ? `Week ${weekNo}` : kind === "checklist" ? "Checklist" : "Note",
    title: kind === "week" ? "New week" : kind === "checklist" ? "New checklist" : "New section",
    start_date: kind === "info" ? null : start, end_date: kind === "info" ? null : addDays(start, 6),
  };
  const { data, error } = await db().from("season_sections").insert(row).select().single();
  if (error) return ctx.toast("Couldn't add: " + error.message, true);
  state.sections.push(data);
  if (kind !== "info") await addTask(data.id, kind === "week" ? "Whole team" : "");
  else render();
  document.getElementById("ss-" + data.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function loadTemplate() {
  const btn = $("#ss-load-template");
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  let sort = 0;
  for (const sec of SEASON_TEMPLATE) {
    sort += 1000;
    const { data, error } = await db().from("season_sections").insert({
      season: SEASON, kind: sec.kind || "week", label: sec.label, title: sec.title, body: sec.body || "",
      start_date: sec.start || null, end_date: sec.end || null,
      gate_label: sec.gate?.[0] || "", gate_date: sec.gate?.[1] || null, sort, updated_by_name: myName(),
    }).select().single();
    if (error) { ctx.toast("Couldn't load template: " + error.message, true); return load(); }
    const rows = [];
    Object.entries(sec.tasks || {}).forEach(([team, list]) => list.forEach(text => rows.push({ section_id: data.id, team, text, sort: (rows.length + 1) * 1000 })));
    if (rows.length) {
      const res = await db().from("season_tasks").insert(rows);
      if (res.error) { ctx.toast("Couldn't load tasks: " + res.error.message, true); return load(); }
    }
  }
  ctx.logAction("SEASON_TEMPLATE_LOADED", "season_sections", null, { season: SEASON });
  ctx.toast("2027 schedule loaded.");
  load();
}

/* Change a date; optionally push every later section (and custom due dates in them) by the same number of days */
async function changeDate(target, newDate, shiftLater) {
  const { sectionId, taskId, field, date: oldDate } = target;
  const delta = daysBetween(oldDate, newDate);
  if (!delta) return;
  const secUpdates = new Map(), taskUpdates = new Map();
  if (taskId) taskUpdates.set(taskId, { due_date: newDate });
  else secUpdates.set(sectionId, { [field]: newDate });
  if (shiftLater) {
    const base = sectionOf(sectionId || state.tasks.find(t => t.id === taskId)?.section_id);
    const shiftField = (s, f) => { if (s[f] && s[f] >= oldDate) { const u = secUpdates.get(s.id) || {}; if (!(f in u)) u[f] = addDays(s[f], delta); secUpdates.set(s.id, u); } };
    state.sections.filter(s => s.sort >= base.sort).forEach(s => {
      ["start_date", "end_date", "gate_date"].forEach(f => shiftField(s, f));
      tasksOf(s.id).forEach(t => { if (t.due_date && t.due_date >= oldDate && !taskUpdates.has(t.id)) taskUpdates.set(t.id, { due_date: addDays(t.due_date, delta) }); });
    });
  }
  secUpdates.forEach((u, id) => Object.assign(sectionOf(id), u));
  taskUpdates.forEach((u, id) => Object.assign(state.tasks.find(t => t.id === id), u));
  render();
  const now = new Date().toISOString();
  const results = await Promise.all([
    ...[...secUpdates].map(([id, u]) => db().from("season_sections").update({ ...u, updated_by_name: myName(), updated_at: now }).eq("id", id)),
    ...[...taskUpdates].map(([id, u]) => db().from("season_tasks").update({ ...u, updated_at: now }).eq("id", id)),
  ]);
  const failed = results.find(r => r.error);
  if (failed) { ctx.toast("Couldn't move dates: " + failed.error.message, true); return load(); }
  ctx.logAction("SEASON_DATES_SHIFTED", "season_sections", sectionId || taskId, { from: oldDate, to: newDate, days: delta, cascaded: !!shiftLater, changed: secUpdates.size + taskUpdates.size });
  ctx.toast(shiftLater ? `Moved ${secUpdates.size + taskUpdates.size} dates by ${delta > 0 ? "+" : ""}${delta} days.` : "Date updated.");
}

/* ---------- popovers ---------- */
function ensurePopover() {
  if ($("#ss-popover")) return;
  const el = document.createElement("div");
  el.id = "ss-popover";
  el.className = "ss-popover hidden";
  el.setAttribute("role", "dialog");
  document.body.appendChild(el);
  document.addEventListener("click", e => { if (!el.contains(e.target)) el.classList.add("hidden"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") el.classList.add("hidden"); });
  window.addEventListener("resize", () => el.classList.add("hidden"));
}

function placePopover(el, anchor) {
  el.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  let left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left));
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 6);
  el.style.left = left + "px";
  el.style.top = top + "px";
}

function openDatePopover(anchor) {
  const el = $("#ss-popover");
  const date = anchor.dataset.date;
  const field = anchor.dataset.dateField;
  const sectionId = anchor.dataset.section;
  const taskId = anchor.dataset.taskId;
  const task = taskId && state.tasks.find(t => t.id === taskId);
  const sec = sectionOf(sectionId || task?.section_id);
  const what = task ? `Due: ${esc(task.text)}` : field === "gate_date" ? `Gate: ${esc(sec.gate_label)}` : `${esc(sec.label)} ${field === "start_date" ? "starts" : "ends"}`;
  const due = dueBy(date);
  const open = due.filter(t => !t.done);
  const gatesBy = state.sections.filter(s => s.gate_date && s.gate_date <= date && !s.gate_done);
  const n = daysBetween(todayIso(), date);
  const verdict = n >= 0
    ? (open.length ? `${open.length} of ${due.length} item${due.length === 1 ? "" : "s"} due by then still open` : due.length ? `All ${due.length} items due by then are done` : "Nothing is due by then")
    : (open.length ? `<b class="ss-red">${open.length} of ${due.length} items due by then were not done</b>` : due.length ? `<b class="ss-green">Everything due by then is done</b>` : "Nothing was due by then");
  el.innerHTML = `
    <div class="ss-pop-date">${fmtLong(date)} <span class="muted">· ${relDays(date, todayIso())}</span></div>
    <div class="ss-pop-what">${what}</div>
    <div class="ss-pop-verdict">${verdict}${gatesBy.length ? `<br>${gatesBy.length} gate${gatesBy.length === 1 ? "" : "s"} not yet passed` : ""}</div>
    ${open.length ? `<ul class="ss-pop-list">${open.slice(0, 6).map(t => `<li>${esc(t.text)} <span class="muted">· ${esc(sectionOf(t.section_id)?.label || "")}</span></li>`).join("")}${open.length > 6 ? `<li class="muted">+${open.length - 6} more</li>` : ""}</ul>` : ""}
    <div class="ss-pop-actions">
      <button type="button" class="btn btn--primary btn--sm" data-pop-asof>Check progress as of this day</button>
    </div>
    ${isStaff() ? `<div class="ss-pop-edit">
      <label for="ss-pop-input">Reschedule</label>
      <div class="ss-pop-row"><input type="date" id="ss-pop-input" value="${date}">
      <button type="button" class="btn btn--ghost btn--sm" data-pop-save>Move</button></div>
      <label class="ss-pop-check"><input type="checkbox" id="ss-pop-shift" ${task ? "" : "checked"}> Shift every later date by the same amount</label>
      ${task?.due_date ? `<button type="button" class="textbtn" data-pop-reset>Reset to the week's end date</button>` : ""}
    </div>` : ""}`;
  el.querySelector("[data-pop-asof]").onclick = () => { el.classList.add("hidden"); setAsOf(date); };
  el.querySelector("[data-pop-save]")?.addEventListener("click", () => {
    const v = $("#ss-pop-input").value;
    el.classList.add("hidden");
    if (v && v !== date) changeDate({ sectionId: task ? null : sectionId, taskId: task?.id, field, date }, v, $("#ss-pop-shift").checked);
  });
  el.querySelector("[data-pop-reset]")?.addEventListener("click", () => { el.classList.add("hidden"); saveTask(task.id, { due_date: null }, true); });
  placePopover(el, anchor);
}

function openSectionMenu(anchor, sid) {
  const el = $("#ss-popover");
  const s = sectionOf(sid);
  const idx = state.sections.indexOf(s);
  el.innerHTML = `<div class="ss-menu">
    <button type="button" data-m="up" ${idx === 0 ? "disabled" : ""}><i class=fa-arrow-up aria-hidden=true></i> Move up</button>
    <button type="button" data-m="down" ${idx === state.sections.length - 1 ? "disabled" : ""}><i class=fa-arrow-down aria-hidden=true></i> Move down</button>
    ${s.kind !== "info" ? (s.gate_date ? `<button type="button" data-m="nogate"><i class=fa-flag aria-hidden=true></i> Remove gate</button>` : `<button type="button" data-m="gate"><i class=fa-flag aria-hidden=true></i> Add a gate</button>`) : ""}
    ${s.kind === "info" ? "" : s.start_date ? `<button type="button" data-m="nodates"><i class=fa-calendar-xmark aria-hidden=true></i> Remove dates</button>` : `<button type="button" data-m="dates"><i class=fa-calendar aria-hidden=true></i> Add dates</button>`}
    <button type="button" data-m="del" class="danger"><i class=fa-trash aria-hidden=true></i> Delete section</button>
  </div>`;
  el.querySelectorAll("[data-m]").forEach(b => b.onclick = async e => {
    e.stopPropagation();
    el.classList.add("hidden");
    const m = b.dataset.m;
    if (m === "up" || m === "down") {
      const other = state.sections[idx + (m === "up" ? -1 : 1)];
      const a = s.sort, c = other.sort;
      s.sort = c; other.sort = a;
      state.sections.sort((x, y) => x.sort - y.sort);
      render();
      await Promise.all([db().from("season_sections").update({ sort: s.sort }).eq("id", s.id), db().from("season_sections").update({ sort: other.sort }).eq("id", other.id)]);
    } else if (m === "gate") saveSection(sid, { gate_label: "New gate", gate_date: s.start_date || todayIso() }, true);
    else if (m === "nogate") saveSection(sid, { gate_label: "", gate_date: null, gate_done: false }, true);
    else if (m === "dates") saveSection(sid, { start_date: todayIso(), end_date: addDays(todayIso(), 6) }, true);
    else if (m === "nodates") saveSection(sid, { start_date: null, end_date: null }, true);
    else if (m === "del") {
      if (!confirm(`Delete “${s.label} · ${s.title}” and its ${tasksOf(sid).length} items?`)) return;
      state.sections = state.sections.filter(x => x.id !== sid);
      render();
      const { error } = await db().from("season_sections").delete().eq("id", sid);
      if (error) { ctx.toast(error.message, true); load(); }
      else ctx.logAction("SEASON_SECTION_DELETED", "season_sections", sid, { label: s.label, title: s.title });
    }
  });
  placePopover(el, anchor);
}
