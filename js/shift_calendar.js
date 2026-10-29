/* Google-Calendar-style view for build shifts.
 * Views: Day, 3 days, Week, Month, Schedule (the existing shift cards). Left rail: Create, mini month,
 * department checkboxes. Admins drag shifts to move them (across days too), drag the bottom edge to
 * change the end time, and drag across empty time to create a shift. Everyone clicks a shift for its
 * details card (join / leave). Keyboard: T today, D/X/W/M/A views, J/N next, K/P previous, C create. */

const DEPT_COLORS = {
  Mechanical: "#e8710a",
  Electrical: "#d39e00",
  Software: "#4285f4",
  Business: "#0b8043",
  "All Departments": "#8e24aa",
};
const DEPTS = Object.keys(DEPT_COLORS);
const HOUR_H = 48;          // px per hour in time views
const DAY_START = 6;        // first hour shown
const DAY_END = 24;
const SNAP = 15;            // minutes
const VIEWS = [["day", "Day", "D"], ["3day", "3 days", "X"], ["week", "Week", "W"], ["month", "Month", "M"], ["schedule", "Schedule", "A"]];
const LS = "nyx_shift_cal";

let ctx = null;
let host = null;
const st = { view: "week", cursor: today(), depts: new Set(DEPTS), popover: null };

/* ---------- dates (local, YYYY-MM-DD) ---------- */
function today() { return iso(new Date()); }
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parse(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
function addMonths(s, n) { const d = parse(s); d.setDate(1); d.setMonth(d.getMonth() + n); return iso(d); }
function startOfWeek(s) { const d = parse(s); d.setDate(d.getDate() - d.getDay()); return iso(d); }
const toMin = t => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const toTime = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtTime = m => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}${mm ? ":" + String(mm).padStart(2, "0") : ""}${h < 12 || h === 24 ? "am" : "pm"}`; };
const snap = m => Math.round(m / SNAP) * SNAP;

function visibleDays() {
  if (st.view === "day") return [st.cursor];
  if (st.view === "3day") return [0, 1, 2].map(i => addDays(st.cursor, i));
  const s = startOfWeek(st.cursor);
  return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(s, i));
}

/* ---------- public ---------- */
export function initShiftCalendar(context) {
  ctx = context;
  host = document.getElementById("shift-calendar");
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS) || "null"); } catch { /* storage unavailable */ }
  if (saved) {
    if (VIEWS.some(v => v[0] === saved.view)) st.view = saved.view;
    if (Array.isArray(saved.depts)) st.depts = new Set(saved.depts.filter(d => DEPTS.includes(d)));
  } else if (window.innerWidth < 700) {
    st.view = "3day";
  }

  host.addEventListener("click", onClick);
  host.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointerdown", e => {
    if (st.popover && !e.target.closest(".gcal-popover") && !e.target.closest(".gcal-ev, .gcal-chip")) closePopover();
  });
  setInterval(() => { if (isVisible()) placeNowLine(); }, 60000);
}

export function isDeptVisible(dept) {
  return st.depts.has(dept);
}

export function renderShiftCalendar() {
  if (!host) return;
  const scrollTop = host.querySelector(".gcal-scroll")?.scrollTop;
  host.innerHTML = `
    <div class="gcal">
      <aside class="gcal-rail">
        ${ctx.isAdmin() ? `<button type="button" class="gcal-create" data-cal="create"><span>＋</span> Create</button>` : ""}
        ${miniMonthHtml()}
        <div class="gcal-rail-title">Departments</div>
        ${DEPTS.map(d => `<label class="gcal-dept"><input type="checkbox" data-cal-dept="${d}" ${st.depts.has(d) ? "checked" : ""}><i style="--c:${DEPT_COLORS[d]}"></i>${d === "All Departments" ? "Full team" : d}</label>`).join("")}
      </aside>
      <section class="gcal-main">
        <div class="gcal-toolbar">
          ${ctx.isAdmin() ? `<button type="button" class="gcal-create gcal-create--compact" data-cal="create" aria-label="Create shift">＋</button>` : ""}
          <button type="button" class="gcal-btn" data-cal="today" title="Today (T)">Today</button>
          <button type="button" class="gcal-icon" data-cal="prev" aria-label="Previous (K)" title="Previous (K)">‹</button>
          <button type="button" class="gcal-icon" data-cal="next" aria-label="Next (J)" title="Next (J)">›</button>
          <h3 class="gcal-title">${titleText()}</h3>
          <div class="gcal-views" role="tablist">
            ${VIEWS.map(([k, label, key]) => `<button type="button" role="tab" class="${st.view === k ? "active" : ""}" data-cal-view="${k}" title="${label} (${key})">${label}</button>`).join("")}
          </div>
        </div>
        <div class="gcal-body">${st.view === "month" ? monthHtml() : st.view === "schedule" ? "" : timeHtml()}</div>
      </section>
    </div>`;
  ctx.showList(st.view === "schedule");
  if (st.view !== "month" && st.view !== "schedule") {
    const sc = host.querySelector(".gcal-scroll");
    if (sc) sc.scrollTop = scrollTop ?? defaultScroll();
    placeNowLine();
  }
}

/* ---------- rendering ---------- */
function shifts() {
  return ctx.getShifts().filter(s => st.depts.has(s.department) && s.shift_date && s.start_time);
}

function titleText() {
  const d = parse(st.cursor);
  if (st.view === "day") return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (st.view === "month" || st.view === "schedule") return d.toLocaleDateString([], { month: "long", year: "numeric" });
  const days = visibleDays();
  const a = parse(days[0]), b = parse(days.at(-1));
  return a.getMonth() === b.getMonth()
    ? a.toLocaleDateString([], { month: "long", year: "numeric" })
    : `${a.toLocaleDateString([], { month: "short" })} – ${b.toLocaleDateString([], { month: "short", year: "numeric" })}`;
}

function miniMonthHtml() {
  const first = parse(st.cursor); first.setDate(1);
  const start = startOfWeek(iso(first));
  const month = first.getMonth();
  const busy = new Set(ctx.getShifts().map(s => s.shift_date));
  const sel = new Set(st.view === "month" ? [] : visibleDays());
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  return `<div class="gcal-mini">
    <div class="gcal-mini-head">
      <b>${first.toLocaleDateString([], { month: "long", year: "numeric" })}</b>
      <span><button type="button" class="gcal-icon sm" data-cal="mini-prev" aria-label="Previous month">‹</button><button type="button" class="gcal-icon sm" data-cal="mini-next" aria-label="Next month">›</button></span>
    </div>
    <div class="gcal-mini-grid">
      ${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span class="dow">${d}</span>`).join("")}
      ${cells.map(c => `<button type="button" data-cal-date="${c}" class="${parse(c).getMonth() !== month ? "out" : ""} ${c === today() ? "today" : ""} ${sel.has(c) ? "sel" : ""} ${busy.has(c) ? "busy" : ""}">${parse(c).getDate()}</button>`).join("")}
    </div>
  </div>`;
}

function layoutDay(list) {
  // Side-by-side columns for overlapping shifts (greedy), like Google Calendar
  const evs = list.map(s => ({ s, a: toMin(s.start_time), b: Math.max(toMin(s.end_time), toMin(s.start_time) + SNAP) })).sort((x, y) => x.a - y.a || y.b - x.b);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    cluster.forEach(e => {
      let c = cols.findIndex(end => end <= e.a);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = e.b;
      e.col = c;
    });
    cluster.forEach(e => { e.cols = cols.length; out.push(e); });
    cluster = [];
  };
  evs.forEach(e => {
    if (e.a >= clusterEnd && cluster.length) flush();
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, e.b);
  });
  if (cluster.length) flush();
  return out;
}

function evHtml(e) {
  const s = e.s;
  const top = (Math.max(e.a, DAY_START * 60) - DAY_START * 60) / 60 * HOUR_H;
  const h = Math.max((Math.min(e.b, DAY_END * 60) - Math.max(e.a, DAY_START * 60)) / 60 * HOUR_H - 2, 18);
  const mine = (s.attendees || []).includes(ctx.myName());
  const short = h < 40;
  return `<div class="gcal-ev ${mine ? "is-mine" : ""} ${ctx.isAdmin() ? "can-drag" : ""} ${short ? "short" : ""}" data-ev="${s.id}"
      style="--c:${DEPT_COLORS[s.department] || "#5b3ce6"}; top:${top}px; height:${h}px; left:calc(${(e.col / e.cols) * 100}% + 1px); width:calc(${100 / e.cols}% - 3px);"
      title="${ctx.esc(s.title)} · ${fmtTime(e.a)} – ${fmtTime(e.b)}">
    <b>${ctx.esc(s.title)}</b>${short ? `<span>, ${fmtTime(e.a)}</span>` : `<span>${fmtTime(e.a)} – ${fmtTime(e.b)}</span><span>${ctx.esc(s.location || "")}${(s.attendees || []).length ? ` · 👥 ${(s.attendees || []).length}` : ""}</span>`}
    ${ctx.isAdmin() ? `<i class="gcal-resize" data-resize></i>` : ""}
  </div>`;
}

function timeHtml() {
  const days = visibleDays();
  const all = shifts();
  const hours = Array.from({ length: DAY_END - DAY_START }, (_, i) => DAY_START + i);
  return `<div class="gcal-time" style="--days:${days.length}; --hour:${HOUR_H}px;">
    <div class="gcal-head">
      <div class="gcal-gutter"></div>
      ${days.map(d => { const dt = parse(d); return `<button type="button" class="gcal-dayhead ${d === today() ? "today" : ""}" data-cal-goto="${d}"><span>${dt.toLocaleDateString([], { weekday: "short" }).toUpperCase()}</span><b>${dt.getDate()}</b></button>`; }).join("")}
    </div>
    <div class="gcal-scroll">
      <div class="gcal-grid" style="height:${(DAY_END - DAY_START) * HOUR_H}px">
        <div class="gcal-times">${hours.map(h => `<span style="top:${(h - DAY_START) * HOUR_H}px">${h === DAY_START ? "" : fmtTime(h * 60).toUpperCase()}</span>`).join("")}</div>
        ${days.map(d => `<div class="gcal-col ${d === today() ? "today" : ""}" data-date="${d}">${layoutDay(all.filter(s => s.shift_date === d)).map(evHtml).join("")}</div>`).join("")}
      </div>
    </div>
  </div>`;
}

function monthHtml() {
  const first = parse(st.cursor); first.setDate(1);
  const start = startOfWeek(iso(first));
  const month = first.getMonth();
  const all = shifts();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const rows = parse(cells[35]).getMonth() !== month ? 5 : 6;
  return `<div class="gcal-month" style="--rows:${rows}">
    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<div class="gcal-mdow">${d.toUpperCase()}</div>`).join("")}
    ${cells.slice(0, rows * 7).map(c => {
      const list = all.filter(s => s.shift_date === c).sort((a, b) => toMin(a.start_time) - toMin(b.start_time));
      return `<div class="gcal-mcell ${parse(c).getMonth() !== month ? "out" : ""}" data-date="${c}">
        <button type="button" class="gcal-mnum ${c === today() ? "today" : ""}" data-cal-goto="${c}">${parse(c).getDate()}</button>
        ${list.slice(0, 3).map(s => `<div class="gcal-chip ${ctx.isAdmin() ? "can-drag" : ""}" data-ev="${s.id}" style="--c:${DEPT_COLORS[s.department] || "#5b3ce6"}"><i></i>${fmtTime(toMin(s.start_time))} ${ctx.esc(s.title)}</div>`).join("")}
        ${list.length > 3 ? `<button type="button" class="gcal-more" data-cal-goto="${c}">${list.length - 3} more</button>` : ""}
      </div>`;
    }).join("")}
  </div>`;
}

function defaultScroll() {
  const days = new Set(visibleDays());
  const starts = shifts().filter(s => days.has(s.shift_date)).map(s => toMin(s.start_time));
  const first = Math.min(8 * 60, ...starts);
  return Math.max(0, (first - DAY_START * 60 - 30) / 60 * HOUR_H);
}

function placeNowLine() {
  host.querySelectorAll(".gcal-now").forEach(n => n.remove());
  const col = host.querySelector(`.gcal-col[data-date="${today()}"]`);
  if (!col) return;
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  if (m < DAY_START * 60) return;
  const line = document.createElement("div");
  line.className = "gcal-now";
  line.style.top = `${(m - DAY_START * 60) / 60 * HOUR_H}px`;
  col.appendChild(line);
}

/* ---------- navigation & clicks ---------- */
function setView(v) {
  st.view = v;
  save();
  renderShiftCalendar();
}
function step(dir) {
  if (st.view === "month" || st.view === "schedule") st.cursor = addMonths(st.cursor, dir);
  else st.cursor = addDays(st.cursor, dir * (st.view === "day" ? 1 : st.view === "3day" ? 3 : 7));
  renderShiftCalendar();
}
function save() {
  try { localStorage.setItem(LS, JSON.stringify({ view: st.view, depts: [...st.depts] })); } catch { /* storage unavailable */ }
}
function isVisible() { return host && host.offsetParent !== null; }

function onClick(e) {
  const b = e.target.closest("[data-cal], [data-cal-view], [data-cal-date], [data-cal-goto], [data-cal-dept]");
  if (!b) return;
  if (b.dataset.calView) return setView(b.dataset.calView);
  if (b.dataset.calDate) { st.cursor = b.dataset.calDate; return renderShiftCalendar(); }
  if (b.dataset.calGoto) { st.cursor = b.dataset.calGoto; return setView("day"); }
  if (b.dataset.calDept) {
    b.checked ? st.depts.add(b.dataset.calDept) : st.depts.delete(b.dataset.calDept);
    save();
    ctx.onFilterChange();
    return;
  }
  const a = b.dataset.cal;
  if (a === "today") { st.cursor = today(); renderShiftCalendar(); }
  else if (a === "prev") step(-1);
  else if (a === "next") step(1);
  else if (a === "mini-prev") { st.cursor = addMonths(st.cursor, -1); renderShiftCalendar(); }
  else if (a === "mini-next") { st.cursor = addMonths(st.cursor, 1); renderShiftCalendar(); }
  else if (a === "create") createAt(st.view === "month" || st.view === "schedule" ? st.cursor : visibleDays()[0], 16 * 60, 18 * 60);
}

function onKey(e) {
  if (!isVisible() || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (document.querySelector(".modalback:not(.hidden)")) return;
  const k = e.key.toLowerCase();
  const view = VIEWS.find(v => v[2].toLowerCase() === k);
  if (view) setView(view[0]);
  else if (k === "t") { st.cursor = today(); renderShiftCalendar(); }
  else if (k === "j" || k === "n") step(1);
  else if (k === "k" || k === "p") step(-1);
  else if (k === "c" && ctx.isAdmin()) createAt(st.view === "month" ? st.cursor : visibleDays()[0], 16 * 60, 18 * 60);
  else if (k === "escape") closePopover();
  else return;
  e.preventDefault();
}

function createAt(date, a, b) {
  closePopover();
  ctx.onCreate({ shift_date: date, start_time: toTime(a), end_time: toTime(Math.min(b, 23 * 60 + 59)) });
}

/* ---------- popover ---------- */
function openPopover(shift, anchor) {
  closePopover();
  const pop = document.createElement("div");
  pop.className = "gcal-popover";
  pop.innerHTML = `<button type="button" class="gcal-pop-close" aria-label="Close">×</button>${ctx.cardHtml(shift)}`;
  host.querySelector(".gcal").appendChild(pop);
  const r = anchor.getBoundingClientRect(), hr = host.querySelector(".gcal").getBoundingClientRect();
  const w = Math.min(380, hr.width - 16);
  pop.style.width = w + "px";
  let left = r.right - hr.left + 8;
  if (left + w > hr.width) left = Math.max(8, r.left - hr.left - w - 8);
  if (window.innerWidth < 700) left = (hr.width - w) / 2;
  pop.style.left = left + "px";
  pop.style.top = Math.max(8, Math.min(r.top - hr.top, hr.height - pop.offsetHeight - 8)) + "px";
  pop.querySelector(".gcal-pop-close").onclick = closePopover;
  st.popover = pop;
}
function closePopover() { st.popover?.remove(); st.popover = null; }

/* ---------- drag: move, resize, create ---------- */
let drag = null;

function colAt(x) {
  return [...host.querySelectorAll(".gcal-col")].find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
}
function minuteAt(col, y) {
  const r = col.getBoundingClientRect();
  return Math.max(DAY_START * 60, Math.min(DAY_END * 60, DAY_START * 60 + (y - r.top) / HOUR_H * 60));
}
function cellAt(x, y) {
  return [...host.querySelectorAll(".gcal-mcell")].find(c => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; });
}

function onPointerDown(e) {
  if (e.button > 0) return;
  const ev = e.target.closest(".gcal-ev, .gcal-chip");
  const col = e.target.closest(".gcal-col");
  const cell = e.target.closest(".gcal-mcell");
  if (e.target.closest("button, a, input, select")) return;
  const touch = e.pointerType !== "mouse";
  const base = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, active: false };

  if (ev) {
    const shift = ctx.getShifts().find(s => s.id === ev.dataset.ev);
    if (!shift) return;
    drag = { ...base, kind: ev.classList.contains("gcal-chip") ? "chip" : e.target.closest("[data-resize]") ? "resize" : "move", el: ev, shift,
      a: toMin(shift.start_time), b: Math.max(toMin(shift.end_time), toMin(shift.start_time) + SNAP), date: shift.shift_date };
    if (drag.kind === "move") drag.grab = minuteAt(ev.closest(".gcal-col"), e.clientY) - drag.a;
    if (!ctx.isAdmin()) drag.clickOnly = true;   // members can open shifts but not move them
  } else if (col && ctx.isAdmin()) {
    const m = snap(minuteAt(col, e.clientY) - SNAP / 2);
    drag = { ...base, kind: "create", col, a0: m, a: m, b: m + 60, date: col.dataset.date };
  } else if (cell && ctx.isAdmin()) {
    drag = { ...base, kind: "mcreate", date: cell.dataset.date };
  } else return;

  if (touch && drag.kind !== "mcreate" && !drag.clickOnly) drag.timer = setTimeout(() => { if (drag && !drag.active) begin(); }, 300);
}

function begin() {
  drag.active = true;
  closePopover();
  document.body.classList.add("gcal-dragging");
  if (drag.kind === "create") {
    drag.box = document.createElement("div");
    drag.box.className = "gcal-ev gcal-ev--new";
    drag.col.appendChild(drag.box);
    paintBox();
  } else if (drag.kind === "chip") {
    drag.ghost = drag.el.cloneNode(true);
    drag.ghost.classList.add("gcal-chip--ghost");
    Object.assign(drag.ghost.style, { width: drag.el.offsetWidth + "px" });
    document.body.appendChild(drag.ghost);
  } else {
    drag.el.classList.add("is-dragging");
  }
  navigator.vibrate?.(10);
}

function paintBox() {
  const top = (drag.a - DAY_START * 60) / 60 * HOUR_H;
  drag.box.style.cssText = `--c:var(--accent); top:${top}px; height:${Math.max((drag.b - drag.a) / 60 * HOUR_H - 2, 16)}px; left:1px; width:calc(100% - 3px);`;
  drag.box.innerHTML = `<b>(No title)</b><span>${fmtTime(drag.a)} – ${fmtTime(drag.b)}</span>`;
}

document.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id || drag.clickOnly) return;
  if (!drag.active) {
    const dist = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (drag.touch) { if (dist > 8) { clearTimeout(drag.timer); drag = null; } return; }
    if (dist < 4 || drag.kind === "mcreate") return;
    begin();
  }
  e.preventDefault();
  drag.lastY = e.clientY;
  if (drag.kind === "chip") {
    drag.ghost.style.left = e.clientX - 20 + "px";
    drag.ghost.style.top = e.clientY - 10 + "px";
    host.querySelectorAll(".gcal-mcell.drop").forEach(c => c.classList.remove("drop"));
    const cell = cellAt(e.clientX, e.clientY);
    if (cell) { cell.classList.add("drop"); drag.date = cell.dataset.date; }
    return;
  }
  const col = drag.kind === "move" ? (colAt(e.clientX) || drag.el.closest(".gcal-col")) : drag.el?.closest(".gcal-col") || drag.col;
  const m = minuteAt(col, e.clientY);
  if (drag.kind === "create") {
    const cur = snap(m);
    drag.a = Math.min(drag.a0, cur);           // dragging up extends the start
    drag.b = Math.max(drag.a0 + SNAP, cur);    // dragging down extends the end
    paintBox();
  } else if (drag.kind === "resize") {
    drag.b = Math.max(drag.a + SNAP, Math.min(DAY_END * 60, snap(m)));
    drag.el.style.height = `${(drag.b - drag.a) / 60 * HOUR_H - 2}px`;
    drag.el.querySelector("span").textContent = `${fmtTime(drag.a)} – ${fmtTime(drag.b)}`;
  } else {
    const dur = drag.b - drag.a;
    drag.a = Math.max(DAY_START * 60, Math.min(DAY_END * 60 - dur, snap(m - drag.grab)));
    drag.b = drag.a + dur;
    drag.date = col.dataset.date;
    if (drag.el.parentElement !== col) col.appendChild(drag.el);
    Object.assign(drag.el.style, { top: `${(drag.a - DAY_START * 60) / 60 * HOUR_H}px`, left: "1px", width: "calc(100% - 3px)" });
    const span = drag.el.querySelector("span");
    if (span) span.textContent = drag.el.classList.contains("short") ? `, ${fmtTime(drag.a)}` : `${fmtTime(drag.a)} – ${fmtTime(drag.b)}`;
  }
  autoScroll(e.clientY);
}, { passive: false });

function autoScroll(y) {
  const sc = host.querySelector(".gcal-scroll");
  if (!sc) return;
  const r = sc.getBoundingClientRect();
  if (y < r.top + 30) sc.scrollTop -= 12;
  else if (y > r.bottom - 30) sc.scrollTop += 12;
}

document.addEventListener("touchmove", e => { if (drag?.active) e.preventDefault(); }, { passive: false });

const end = e => {
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  clearTimeout(d.timer);
  drag = null;
  document.body.classList.remove("gcal-dragging");
  if (!d.active) {
    // a click
    if (d.kind === "move" || d.kind === "resize" || d.kind === "chip") openPopover(d.shift, d.el);
    else if (d.kind === "create") createAt(d.date, d.a0, d.a0 + 60);
    else if (d.kind === "mcreate" && !e.target.closest(".gcal-chip, .gcal-more, .gcal-mnum")) createAt(d.date, 16 * 60, 18 * 60);
    return;
  }
  if (d.kind === "create") { d.box.remove(); return createAt(d.date, d.a, d.b); }
  if (d.kind === "chip") { d.ghost.remove(); host.querySelectorAll(".gcal-mcell.drop").forEach(c => c.classList.remove("drop")); }
  d.el.classList.remove("is-dragging");
  const patch = { shift_date: d.date, start_time: toTime(d.a), end_time: toTime(d.b) };
  const changed = patch.shift_date !== d.shift.shift_date || toMin(patch.start_time) !== toMin(d.shift.start_time) || toMin(patch.end_time) !== toMin(d.shift.end_time);
  if (changed) ctx.onMove(d.shift, patch);
  else renderShiftCalendar();
};
document.addEventListener("pointerup", end);
document.addEventListener("pointercancel", e => { if (drag && e.pointerId === drag.id) { drag.box?.remove(); drag.ghost?.remove(); drag = null; document.body.classList.remove("gcal-dragging"); renderShiftCalendar(); } });
