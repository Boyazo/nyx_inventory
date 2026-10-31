/* Trello-style boards: Hardware, Software, Business & Marketing, and the team timeline.
 * Lists of cards with labels, members, dates and checklists; drag cards between lists
 * (long-press on touch). Board and Timeline views. Staff manage boards and lists; any member works cards.
 * Tables: boards, board_lists, board_cards. */

let ctx = null;
const state = {
  boards: [], lists: [], cards: [], members: [], boardId: null, view: "board", openCard: null,
  filter: { q: "", label: "", mine: false, due: "" }, loaded: false, missing: false, pending: false,
};

const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();
const me = () => ctx.getUser();
const isStaff = () => !!(ctx.getProfile()?.is_admin || ctx.getProfile()?.is_moderator);
const myName = () => ctx.getProfile()?.full_name || me()?.email || "Member";
const board = () => state.boards.find(b => b.id === state.boardId);
const listsOf = bid => state.lists.filter(l => l.board_id === bid).sort((a, b) => a.sort - b.sort);
const cardsOf = lid => state.cards.filter(c => c.list_id === lid).sort((a, b) => a.position - b.position);
const listOf = c => state.lists.find(l => l.id === c.list_id);
const isDoneList = l => /^(done|complete|completed|shipped|finished)$/i.test(l?.name || "");
const canDelete = c => isStaff() || c.created_by === me()?.id;

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = s => new Date(s + "T00:00:00");
const today = () => iso(new Date());
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const fmt = s => s ? parse(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };

const PALETTE = ["#5b3ce6", "#2563eb", "#0e7490", "#138a4b", "#b26b00", "#db2777", "#7c3aed", "#475569", "#c2410c", "#0d9488"];
function labelColor(name) {
  if (/urgent|blocked|bug|deadline/i.test(name)) return "#d33a3a";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");

function dueInfo(c) {
  if (!c.due_date) return null;
  const done = isDoneList(listOf(c));
  const n = daysBetween(today(), c.due_date);
  const cls = done ? "done" : n < 0 ? "overdue" : n <= 2 ? "soon" : "";
  const title = done ? "Complete" : n < 0 ? `Overdue by ${-n} day${n === -1 ? "" : "s"}` : n === 0 ? "Due today" : `Due in ${n} day${n === 1 ? "" : "s"}`;
  return { cls, title, n };
}

/* ---------- lifecycle ---------- */
let started = false;
export function initBoards(context) {
  ctx = context;
  if (started) return render();
  started = true;
  try {
    state.boardId = localStorage.getItem("nyx-board");
    state.view = localStorage.getItem("nyx-board-view") || "board";
  } catch { /* storage optional */ }
  ensureModal();
  load();
  try {
    let ch = db().channel("nyx-boards");
    ["boards", "board_lists", "board_cards"].forEach(t => {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, () => { clearTimeout(state.t); state.t = setTimeout(softReload, 350); });
    });
    ch.subscribe();
  } catch { /* realtime optional */ }
}

function softReload() {
  if (drag?.active) { state.pending = true; return; }
  load();
}

async function load() {
  const [b, l, c, m] = await Promise.all([
    db().from("boards").select("*").order("sort"),
    db().from("board_lists").select("*").order("sort"),
    db().from("board_cards").select("*").order("position"),
    db().from("profiles").select("id, full_name").eq("is_approved", true),
  ]);
  state.missing = !!b.error && /relation|does not exist|schema cache/i.test(b.error.message);
  state.boards = b.data || [];
  state.lists = l.data || [];
  state.cards = c.data || [];
  state.members = (m.data || []).map(x => x.full_name).filter(Boolean).sort((x, y) => x.localeCompare(y));
  if (!board()) state.boardId = state.boards[0]?.id || null;
  state.loaded = true;
  render();
  const modal = $("#bd-modal");
  if (state.openCard && !modal.classList.contains("hidden") && !modal.contains(document.activeElement)) renderCardModal();
}

/* ---------- rendering ---------- */
function render() {
  const host = $("#boards-body");
  if (!host) return;
  if (state.missing) {
    host.innerHTML = `<div class="scout-card scout-warn-box" style="margin:20px;">Board tables aren't in the database yet — an admin needs to run <code>supabase/schema.sql</code>.</div>`;
    return;
  }
  if (!state.loaded) { host.innerHTML = `<div class="muted" style="padding:20px;">Loading…</div>`; return; }
  const b = board();
  const f = state.filter;
  const labels = b ? [...new Set([...(b.labels || []), ...state.cards.filter(c => c.board_id === b.id).flatMap(c => c.labels || [])])] : [];
  host.innerHTML = `
    <nav class="bd-tabs" aria-label="Boards">
      ${state.boards.map(x => {
        const open = state.cards.filter(c => c.board_id === x.id && !isDoneList(listOf(c))).length;
        return `<button type="button" class="bd-tab ${x.id === state.boardId ? "active" : ""}" data-board="${x.id}" style="--bd-color:${esc(x.color)}">
          <span class="bd-dot"></span>${esc(x.short || x.name)}<span class="bd-tab-count">${open}</span></button>`;
      }).join("")}
      ${isStaff() ? `<button type="button" class="bd-tab bd-tab--add" id="bd-add-board" title="New board">＋ Board</button>` : ""}
    </nav>
    ${b ? `
    <div class="bd-bar" style="--bd-color:${esc(b.color)}">
      <div class="bd-bar-title">
        <h3>${esc(b.name)}</h3>
        ${b.description ? `<span class="muted small">${esc(b.description)}</span>` : ""}
      </div>
      <div class="bd-filters">
        <input type="search" id="bd-search" placeholder="Filter cards" value="${esc(f.q)}" aria-label="Filter cards">
        <select id="bd-label" aria-label="Label filter"><option value="">All labels</option>${labels.map(l => `<option ${f.label === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <select id="bd-due" aria-label="Due filter">
          <option value="">Any date</option>
          <option value="overdue" ${f.due === "overdue" ? "selected" : ""}>Overdue</option>
          <option value="week" ${f.due === "week" ? "selected" : ""}>Due in 7 days</option>
          <option value="none" ${f.due === "none" ? "selected" : ""}>No due date</option>
        </select>
        <button type="button" class="catbtn ${f.mine ? "active" : ""}" id="bd-mine">My cards</button>
        <div class="duty-toggle" role="group" aria-label="View">
          <button type="button" class="${state.view === "board" ? "active" : ""}" data-bd-view="board"><i class=fa-table-columns aria-hidden=true></i> Board</button>
          <button type="button" class="${state.view === "timeline" ? "active" : ""}" data-bd-view="timeline"><i class=fa-bars-progress aria-hidden=true></i> Timeline</button>
        </div>
        ${isStaff() ? `<button type="button" class="ss-icon" id="bd-board-menu" aria-label="Board options" title="Board options"><i class=fa-ellipsis aria-hidden=true></i></button>` : ""}
      </div>
    </div>
    ${state.view === "timeline" ? timelineHtml(b) : boardHtml(b)}` : `<div class="scout-card" style="margin:20px;">No boards yet. ${isStaff() ? "Create one with ＋ Board." : "An admin or moderator needs to create one."}</div>`}`;
  bind(host);
}

function matches(c) {
  const f = state.filter;
  if (f.q && !`${c.title} ${c.description} ${(c.labels || []).join(" ")} ${(c.assignees || []).join(" ")}`.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.label && !(c.labels || []).includes(f.label)) return false;
  if (f.mine && !(c.assignees || []).includes(myName())) return false;
  if (f.due === "none" && c.due_date) return false;
  if (f.due === "overdue" && !(c.due_date && c.due_date < today() && !isDoneList(listOf(c)))) return false;
  if (f.due === "week" && !(c.due_date && c.due_date >= today() && c.due_date <= addDays(today(), 7))) return false;
  return true;
}

function boardHtml(b) {
  return `<div class="bd-board" id="bd-board">
    ${listsOf(b.id).map(l => {
      const cards = cardsOf(l.id);
      const shown = cards.filter(matches);
      return `<section class="bd-list ${isDoneList(l) ? "is-done" : ""}" data-list="${l.id}">
        <header class="bd-list-head">
          <span class="bd-list-name" ${isStaff() ? `contenteditable="true" spellcheck="false"` : ""} data-list-name="${l.id}">${esc(l.name)}</span>
          <span class="bd-list-count">${shown.length === cards.length ? cards.length : `${shown.length}/${cards.length}`}</span>
          ${isStaff() ? `<button type="button" class="ss-icon" data-list-menu="${l.id}" aria-label="List options"><i class=fa-ellipsis aria-hidden=true></i></button>` : ""}
        </header>
        <div class="bd-cards" data-list-cards="${l.id}">${shown.map(cardHtml).join("")}</div>
        <div class="bd-composer" data-composer="${l.id}">
          <button type="button" class="bd-add-card" data-add-card="${l.id}">＋ Add a card</button>
        </div>
      </section>`;
    }).join("")}
    ${isStaff() ? `<div class="bd-list bd-list--new"><button type="button" class="bd-add-card" id="bd-add-list">＋ Add another list</button></div>` : ""}
  </div>`;
}

function cardHtml(c) {
  const due = dueInfo(c);
  const cl = c.checklist || [];
  const cdone = cl.filter(i => i.done).length;
  return `<article class="bd-card" data-card="${c.id}" tabindex="0" aria-label="${esc(c.title)}">
    ${(c.labels || []).length ? `<div class="bd-labels">${c.labels.map(l => `<span class="bd-label" style="--lc:${labelColor(l)}">${esc(l)}</span>`).join("")}</div>` : ""}
    <div class="bd-card-title">${esc(c.title)}</div>
    <div class="bd-badges">
      ${due ? `<span class="bd-badge bd-due ${due.cls}" title="${due.title}"><i class=fa-clock aria-hidden=true></i> ${c.start_date ? `${fmt(c.start_date)} – ` : ""}${fmt(c.due_date)}</span>` : ""}
      ${c.description ? `<span class="bd-badge" title="Has a description"><i class=fa-align-left aria-hidden=true></i></span>` : ""}
      ${cl.length ? `<span class="bd-badge ${cdone === cl.length ? "complete" : ""}" title="Checklist"><i class=fa-square-check aria-hidden=true></i> ${cdone}/${cl.length}</span>` : ""}
      <span class="bd-avatars">${(c.assignees || []).slice(0, 4).map(n => `<span class="bd-avatar" title="${esc(n)}">${esc(initials(n))}</span>`).join("")}${(c.assignees || []).length > 4 ? `<span class="bd-avatar">+${c.assignees.length - 4}</span>` : ""}</span>
    </div>
  </article>`;
}

function timelineHtml(b) {
  const cards = state.cards.filter(c => c.board_id === b.id && matches(c));
  const dated = cards.filter(c => c.due_date || c.start_date);
  const undated = cards.length - dated.length;
  if (!dated.length) return `<div class="bd-timeline-empty scout-card">No cards with dates${undated ? ` (${undated} without dates)` : ""}. Open a card and set a start or due date to see it here.</div>`;
  const starts = dated.map(c => c.start_date || c.due_date);
  const ends = dated.map(c => c.due_date || c.start_date);
  let from = [today(), ...starts].sort()[0];
  let to = [...ends].sort().at(-1);
  from = addDays(from, -((parse(from).getDay() + 1) % 7)); // back to Saturday, matching the build-week rhythm
  to = addDays(to < today() ? today() : to, 7);
  const span = daysBetween(from, to) + 1;
  const pos = d => daysBetween(from, d) / span * 100;
  const weeks = [];
  for (let d = from; d <= to; d = addDays(d, 7)) weeks.push(d);
  const rows = listsOf(b.id).map(l => ({ l, cards: dated.filter(c => c.list_id === l.id).sort((a, b) => (a.start_date || a.due_date).localeCompare(b.start_date || b.due_date)) })).filter(r => r.cards.length);
  return `<div class="bd-timeline">
    <div class="bd-tl-scroll" style="--bd-color:${esc(b.color)}">
      <div class="bd-tl-grid" style="min-width:${Math.max(720, weeks.length * 90)}px">
        <div class="bd-tl-scale">${weeks.map(w => `<span style="left:${pos(w)}%">${fmt(w)}</span>`).join("")}</div>
        <div class="bd-tl-rows">
          ${weeks.map(w => `<i class="bd-tl-tick" style="left:${pos(w)}%"></i>`).join("")}
          <i class="bd-tl-today" style="left:${pos(today()) + 50 / span}%" title="Today"></i>
          ${rows.map(r => `<div class="bd-tl-group">${esc(r.l.name)}</div>
            ${r.cards.map(c => {
              const s = c.start_date || c.due_date, e = c.due_date || c.start_date;
              const due = dueInfo(c);
              const color = c.labels?.[0] ? labelColor(c.labels[0]) : b.color;
              return `<div class="bd-tl-row"><button type="button" class="bd-tl-bar ${due?.cls || ""}" data-card="${c.id}" style="left:${pos(s)}%; width:max(${(daysBetween(s, e) + 1) / span * 100}%, 10px); --lc:${esc(color)}"
                title="${esc(c.title)} · ${fmt(s)}${s !== e ? ` – ${fmt(e)}` : ""}"><span>${esc(c.title)}</span></button></div>`;
            }).join("")}`).join("")}
        </div>
      </div>
    </div>
    ${undated ? `<p class="muted small" style="padding:0 20px 16px;">${undated} card${undated === 1 ? "" : "s"} without dates aren't shown.</p>` : ""}
  </div>`;
}

/* ---------- interaction ---------- */
function bind(host) {
  host.querySelectorAll("[data-board]").forEach(b => b.onclick = () => {
    state.boardId = b.dataset.board;
    state.filter.label = "";
    try { localStorage.setItem("nyx-board", state.boardId); } catch { /* storage optional */ }
    render();
  });
  $("#bd-add-board")?.addEventListener("click", addBoard);
  const search = $("#bd-search");
  if (search) search.oninput = () => { state.filter.q = search.value; rerenderKeepingFocus("#bd-search"); };
  $("#bd-label")?.addEventListener("change", e => { state.filter.label = e.target.value; render(); });
  $("#bd-due")?.addEventListener("change", e => { state.filter.due = e.target.value; render(); });
  $("#bd-mine")?.addEventListener("click", () => { state.filter.mine = !state.filter.mine; render(); });
  host.querySelectorAll("[data-bd-view]").forEach(b => b.onclick = () => {
    state.view = b.dataset.bdView;
    try { localStorage.setItem("nyx-board-view", state.view); } catch { /* storage optional */ }
    render();
  });
  $("#bd-board-menu")?.addEventListener("click", e => { e.stopPropagation(); boardMenu(e.currentTarget); });

  host.querySelectorAll("[data-card]").forEach(el => {
    el.addEventListener("click", () => { if (!suppressClick) openCard(el.dataset.card); });
    el.addEventListener("keydown", e => { if (e.key === "Enter") openCard(el.dataset.card); });
  });
  host.querySelectorAll("[data-add-card]").forEach(b => b.onclick = () => openComposer(b.dataset.addCard));
  $("#bd-add-list")?.addEventListener("click", addList);
  host.querySelectorAll("[data-list-menu]").forEach(b => b.onclick = e => { e.stopPropagation(); listMenu(b, b.dataset.listMenu); });
  host.querySelectorAll("[data-list-name][contenteditable]").forEach(el => {
    const original = el.textContent;
    el.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } if (e.key === "Escape") { el.textContent = original; el.blur(); } };
    el.onblur = async () => {
      const v = el.textContent.trim();
      if (!v || v === original) { el.textContent = original; return; }
      const l = state.lists.find(x => x.id === el.dataset.listName);
      l.name = v;
      const { error } = await db().from("board_lists").update({ name: v }).eq("id", l.id);
      if (error) { ctx.toast(error.message, true); load(); }
    };
  });
}

function rerenderKeepingFocus(sel) {
  const el = $(sel);
  const pos = el?.selectionStart;
  render();
  const n = $(sel);
  if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* not a text input */ } }
}

function openComposer(listId) {
  const box = $(`[data-composer="${listId}"]`);
  box.innerHTML = `<textarea class="bd-composer-input" rows="2" placeholder="Card title — Enter to add"></textarea>
    <div class="bd-composer-actions"><button type="button" class="btn btn--primary btn--sm" data-c-add>Add card</button><button type="button" class="ss-icon" data-c-cancel aria-label="Cancel"><i class=fa-xmark aria-hidden=true></i></button></div>`;
  const ta = box.querySelector("textarea");
  ta.focus();
  const add = async () => {
    const title = ta.value.trim();
    if (!title) return;
    ta.value = "";
    await addCard(listId, title);
    openComposer(listId);
  };
  ta.onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); add(); } if (e.key === "Escape") render(); };
  box.querySelector("[data-c-add]").onclick = add;
  box.querySelector("[data-c-cancel]").onclick = () => render();
}

async function addCard(listId, title) {
  const last = cardsOf(listId).at(-1);
  const row = { board_id: state.boardId, list_id: listId, title, position: (last?.position || 0) + 1000, created_by: me()?.id, created_by_name: myName() };
  const { data, error } = await db().from("board_cards").insert(row).select().single();
  if (error) return ctx.toast("Couldn't add card: " + error.message, true);
  state.cards.push(data);
  ctx.logAction("BOARD_CARD_CREATED", "board_cards", data.id, { title, board: board()?.name, list: state.lists.find(l => l.id === listId)?.name });
  render();
}

async function addList() {
  const name = prompt("List name:");
  if (!name?.trim()) return;
  const last = listsOf(state.boardId).at(-1);
  const { error } = await db().from("board_lists").insert({ board_id: state.boardId, name: name.trim(), sort: (last?.sort || 0) + 1000 });
  if (error) return ctx.toast(error.message, true);
  load();
}

async function addBoard() {
  const name = prompt("Board name (e.g. Outreach, Drive Team):");
  if (!name?.trim()) return;
  const short = prompt("Short tab name (optional):", name.trim().split(/\s+/).map(w => w[0]).join("").toUpperCase()) || "";
  const { data, error } = await db().from("boards").insert({ name: name.trim(), short: short.trim(), sort: (state.boards.at(-1)?.sort || 0) + 10 }).select().single();
  if (error) return ctx.toast(error.message, true);
  await db().from("board_lists").insert(["To Do", "In Progress", "Done"].map((n, i) => ({ board_id: data.id, name: n, sort: (i + 1) * 1000 })));
  state.boardId = data.id;
  load();
}

function popover() {
  let el = $("#bd-popover");
  if (!el) {
    el = document.createElement("div");
    el.id = "bd-popover";
    el.className = "ss-popover hidden";
    document.body.appendChild(el);
    document.addEventListener("click", e => { if (!el.contains(e.target)) el.classList.add("hidden"); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") el.classList.add("hidden"); });
  }
  return el;
}
function place(el, anchor) {
  el.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  el.style.left = Math.min(window.innerWidth - el.offsetWidth - 12, Math.max(12, r.right - el.offsetWidth)) + "px";
  el.style.top = (r.bottom + el.offsetHeight + 12 > window.innerHeight ? Math.max(12, r.top - el.offsetHeight - 6) : r.bottom + 6) + "px";
}

function listMenu(anchor, listId) {
  const el = popover();
  const lists = listsOf(state.boardId);
  const i = lists.findIndex(l => l.id === listId);
  el.innerHTML = `<div class="ss-menu">
    <button type="button" data-a="left" ${i === 0 ? "disabled" : ""}><i class=fa-arrow-left aria-hidden=true></i> Move left</button>
    <button type="button" data-a="right" ${i === lists.length - 1 ? "disabled" : ""}><i class=fa-arrow-right aria-hidden=true></i> Move right</button>
    <button type="button" data-a="del" class="danger"><i class=fa-trash aria-hidden=true></i> Delete list</button>
  </div>`;
  el.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => {
    el.classList.add("hidden");
    const l = lists[i];
    if (b.dataset.a === "del") {
      const n = cardsOf(l.id).length;
      if (!confirm(`Delete the “${l.name}” list${n ? ` and its ${n} card${n === 1 ? "" : "s"}` : ""}?`)) return;
      const { error } = await db().from("board_lists").delete().eq("id", l.id);
      if (error) return ctx.toast(error.message, true);
      return load();
    }
    const other = lists[i + (b.dataset.a === "left" ? -1 : 1)];
    [l.sort, other.sort] = [other.sort, l.sort];
    render();
    await Promise.all([db().from("board_lists").update({ sort: l.sort }).eq("id", l.id), db().from("board_lists").update({ sort: other.sort }).eq("id", other.id)]);
  });
  place(el, anchor);
}

function boardMenu(anchor) {
  const el = popover();
  const b = board();
  el.innerHTML = `<div class="ss-menu bd-board-edit">
    <label>Name<input id="bd-e-name" value="${esc(b.name)}"></label>
    <label>Tab name<input id="bd-e-short" value="${esc(b.short)}"></label>
    <label>Description<input id="bd-e-desc" value="${esc(b.description)}"></label>
    <label>Labels <span class="muted small">(comma separated)</span><input id="bd-e-labels" value="${esc((b.labels || []).join(", "))}"></label>
    <label class="bd-color-row">Color <input type="color" id="bd-e-color" value="${esc(b.color)}"></label>
    <button type="button" class="btn btn--primary btn--sm" data-a="save">Save board</button>
    <button type="button" data-a="del" class="danger"><i class=fa-trash aria-hidden=true></i> Delete board</button>
  </div>`;
  el.querySelector("[data-a=save]").onclick = async () => {
    const patch = {
      name: $("#bd-e-name").value.trim() || b.name, short: $("#bd-e-short").value.trim(), description: $("#bd-e-desc").value.trim(),
      labels: $("#bd-e-labels").value.split(",").map(s => s.trim()).filter(Boolean), color: $("#bd-e-color").value,
    };
    el.classList.add("hidden");
    const { error } = await db().from("boards").update(patch).eq("id", b.id);
    if (error) return ctx.toast(error.message, true);
    Object.assign(b, patch);
    render();
  };
  el.querySelector("[data-a=del]").onclick = async () => {
    const n = state.cards.filter(c => c.board_id === b.id).length;
    if (prompt(`Delete the “${b.name}” board and all ${n} cards? Type the board name to confirm.`) !== b.name) return;
    el.classList.add("hidden");
    const { error } = await db().from("boards").delete().eq("id", b.id);
    if (error) return ctx.toast(error.message, true);
    ctx.logAction("BOARD_DELETED", "boards", b.id, { name: b.name, cards: n });
    state.boardId = null;
    load();
  };
  el.querySelectorAll("input").forEach(i => i.addEventListener("click", e => e.stopPropagation()));
  place(el, anchor);
}

/* ---------- card modal ---------- */
function ensureModal() {
  if ($("#bd-modal")) return;
  const el = document.createElement("div");
  el.id = "bd-modal";
  el.className = "modalback hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `<div class="modal bd-modal"><div id="bd-modal-body"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", e => { if (e.target === el || e.target.closest("[data-close]")) closeCard(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !el.classList.contains("hidden") && !e.target.closest?.("input, textarea")) closeCard(); });
}
function openCard(id) {
  state.openCard = id;
  renderCardModal();
  $("#bd-modal").classList.remove("hidden");
}
function closeCard() {
  const active = document.activeElement;
  if ($("#bd-modal").contains(active) && active.matches("input, textarea")) active.blur();
  state.openCard = null;
  $("#bd-modal").classList.add("hidden");
  render();
}

function renderCardModal() {
  const c = state.cards.find(x => x.id === state.openCard);
  const host = $("#bd-modal-body");
  if (!c) { $("#bd-modal").classList.add("hidden"); return; }
  const b = state.boards.find(x => x.id === c.board_id);
  const labels = [...new Set([...(b?.labels || []), ...state.cards.filter(x => x.board_id === c.board_id).flatMap(x => x.labels || [])])];
  const cl = c.checklist || [];
  const cdone = cl.filter(i => i.done).length;
  host.innerHTML = `
    <div class="modalhead bd-modal-head">
      <div style="flex:1; min-width:0;">
        <textarea class="bd-title-input" id="bd-c-title" rows="1" aria-label="Card title">${esc(c.title)}</textarea>
        <div class="muted small">in list
          <select id="bd-c-list" class="bd-inline-select" aria-label="List">${listsOf(c.board_id).map(l => `<option value="${l.id}" ${l.id === c.list_id ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select>
          · ${esc(b?.name || "")}</div>
      </div>
      <button class="close" type="button" data-close aria-label="Close">×</button>
    </div>
    <div class="bd-modal-grid">
      <div class="bd-field"><span class="bd-field-label">Labels</span>
        <div class="bd-chips">${labels.map(l => `<button type="button" class="bd-label bd-label--toggle ${(c.labels || []).includes(l) ? "on" : ""}" style="--lc:${labelColor(l)}" data-toggle-label="${esc(l)}">${esc(l)}</button>`).join("")}
          <input class="bd-chip-input" id="bd-c-newlabel" placeholder="+ label" aria-label="New label"></div>
      </div>
      <div class="bd-field"><span class="bd-field-label">Members</span>
        <div class="bd-chips">${(c.assignees || []).map(n => `<span class="bd-member">${esc(n)} <button type="button" data-unassign="${esc(n)}" aria-label="Remove ${esc(n)}">×</button></span>`).join("")}
          <select id="bd-c-assign" class="bd-inline-select" aria-label="Add member"><option value="">+ member</option>
            ${!(c.assignees || []).includes(myName()) ? `<option value="${esc(myName())}">Me (${esc(myName())})</option>` : ""}
            ${state.members.filter(n => !(c.assignees || []).includes(n) && n !== myName()).map(n => `<option>${esc(n)}</option>`).join("")}</select></div>
      </div>
      <div class="bd-field bd-dates"><span class="bd-field-label">Dates</span>
        <label>Start<input type="date" id="bd-c-start" value="${c.start_date || ""}"></label>
        <label>Due<input type="date" id="bd-c-due" value="${c.due_date || ""}"></label>
        ${dueInfo(c) ? `<span class="bd-badge bd-due ${dueInfo(c).cls}">${dueInfo(c).title}</span>` : ""}
      </div>
      <div class="bd-field bd-field--wide"><span class="bd-field-label">Description</span>
        <textarea id="bd-c-desc" rows="4" placeholder="Add more detail, links, specs…">${esc(c.description)}</textarea>
      </div>
      <div class="bd-field bd-field--wide"><span class="bd-field-label">Checklist ${cl.length ? `<span class="muted">${cdone}/${cl.length}</span>` : ""}</span>
        ${cl.length ? `<div class="ss-mini bd-cl-progress"><i style="width:${Math.round(cdone / cl.length * 100)}%"></i></div>` : ""}
        <div class="bd-checklist">${cl.map((it, i) => `<div class="bd-cl-item ${it.done ? "done" : ""}">
          <input type="checkbox" data-cl-toggle="${i}" ${it.done ? "checked" : ""} aria-label="Done">
          <span>${esc(it.text)}</span>
          <button type="button" class="ss-icon" data-cl-del="${i}" aria-label="Delete item"><i class=fa-xmark aria-hidden=true></i></button></div>`).join("")}</div>
        <input id="bd-c-cl-new" placeholder="Add an item — Enter" aria-label="New checklist item">
      </div>
    </div>
    <div class="bd-modal-foot">
      <span class="muted small">Added by ${esc(c.created_by_name || "—")} · ${new Date(c.created_at).toLocaleDateString()}</span>
      ${canDelete(c) ? `<button type="button" class="btn btn--danger btn--sm" id="bd-c-del"><i class=fa-trash aria-hidden=true></i> Delete card</button>` : ""}
    </div>`;

  const title = $("#bd-c-title");
  const fit = ta => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  fit(title);
  title.oninput = () => fit(title);
  title.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); title.blur(); } };
  title.onblur = () => { const v = title.value.trim(); if (v && v !== c.title) update(c, { title: v }); else title.value = c.title; };
  $("#bd-c-list").onchange = e => moveToList(c, e.target.value);
  host.querySelectorAll("[data-toggle-label]").forEach(b => b.onclick = () => {
    const l = b.dataset.toggleLabel;
    const next = (c.labels || []).includes(l) ? c.labels.filter(x => x !== l) : [...(c.labels || []), l];
    update(c, { labels: next }, true);
  });
  $("#bd-c-newlabel").onkeydown = e => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (v && !(c.labels || []).includes(v)) update(c, { labels: [...(c.labels || []), v] }, true);
  };
  $("#bd-c-assign").onchange = e => e.target.value && update(c, { assignees: [...(c.assignees || []), e.target.value] }, true);
  host.querySelectorAll("[data-unassign]").forEach(b => b.onclick = () => update(c, { assignees: c.assignees.filter(n => n !== b.dataset.unassign) }, true));
  $("#bd-c-start").onchange = e => update(c, { start_date: e.target.value || null }, true);
  $("#bd-c-due").onchange = e => update(c, { due_date: e.target.value || null }, true);
  const desc = $("#bd-c-desc");
  fit(desc);
  desc.oninput = () => fit(desc);
  desc.onblur = () => { if (desc.value !== c.description) update(c, { description: desc.value }); };
  host.querySelectorAll("[data-cl-toggle]").forEach(i => i.onchange = () => {
    const list = cl.map((x, j) => j === Number(i.dataset.clToggle) ? { ...x, done: i.checked } : x);
    update(c, { checklist: list }, true);
  });
  host.querySelectorAll("[data-cl-del]").forEach(b => b.onclick = () => update(c, { checklist: cl.filter((_, j) => j !== Number(b.dataset.clDel)) }, true));
  $("#bd-c-cl-new").onkeydown = e => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (!v) return;
    update(c, { checklist: [...cl, { text: v, done: false }] }, true).then(() => $("#bd-c-cl-new")?.focus());
  };
  $("#bd-c-del")?.addEventListener("click", async () => {
    if (!confirm(`Delete “${c.title}”?`)) return;
    const { error } = await db().from("board_cards").delete().eq("id", c.id);
    if (error) return ctx.toast(error.message, true);
    ctx.logAction("BOARD_CARD_DELETED", "board_cards", c.id, { title: c.title, board: b?.name });
    state.cards = state.cards.filter(x => x.id !== c.id);
    closeCard();
  });
}

async function update(c, patch, rerenderModal) {
  Object.assign(c, patch);
  if (rerenderModal) renderCardModal();
  const { error } = await db().from("board_cards").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", c.id);
  if (error) { ctx.toast("Couldn't save card: " + error.message, true); load(); }
}

async function moveToList(c, listId, position) {
  const from = listOf(c);
  const to = state.lists.find(l => l.id === listId);
  const pos = position ?? ((cardsOf(listId).at(-1)?.position || 0) + 1000);
  await update(c, { list_id: listId, position: pos });
  if (from?.id !== listId) {
    ctx.logAction(isDoneList(to) ? "BOARD_CARD_DONE" : "BOARD_CARD_MOVED", "board_cards", c.id, { title: c.title, board: board()?.name, from: from?.name, to: to?.name });
  }
  render();
}

/* ---------- drag & drop (mouse drags after a small move; touch needs a long-press) ---------- */
let drag = null;
let suppressClick = false;

document.addEventListener("pointerdown", e => {
  const card = e.target.closest?.("#bd-board .bd-card");
  if (!card || e.button > 0 || e.target.closest("button, a, input, select, textarea")) return;
  drag = { card, id: card.dataset.card, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, touch: e.pointerType !== "mouse" };
  if (drag.touch) drag.timer = setTimeout(() => { if (drag && !drag.active) beginDrag(drag.startX, drag.startY); }, 300);
});

document.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
  if (!drag.active) {
    if (drag.touch) { if (dist > 8) { clearTimeout(drag.timer); drag = null; } return; }
    if (dist < 5) return;
    beginDrag(e.clientX, e.clientY);
  }
  e.preventDefault();
  moveDrag(e.clientX, e.clientY);
}, { passive: false });

document.addEventListener("touchmove", e => { if (drag?.active) e.preventDefault(); }, { passive: false });
document.addEventListener("pointerup", e => { if (drag && e.pointerId === drag.pointerId) endDrag(); });
document.addEventListener("pointercancel", () => { if (drag?.active) endDrag(true); else drag = null; });

function beginDrag(x, y) {
  const { card } = drag;
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("bd-card--ghost");
  Object.assign(ghost.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
  document.body.appendChild(ghost);
  const ph = document.createElement("div");
  ph.className = "bd-placeholder";
  ph.style.height = r.height + "px";
  card.after(ph);
  card.classList.add("bd-card--dragging");
  document.body.classList.add("is-dragging-task");
  Object.assign(drag, { active: true, ghost, ph, offX: x - r.left, offY: y - r.top });
  navigator.vibrate?.(15);
}

function moveDrag(x, y) {
  drag.ghost.style.left = x - drag.offX + "px";
  drag.ghost.style.top = y - drag.offY + "px";
  drag.x = x; drag.y = y;
  const col = [...document.querySelectorAll("#bd-board [data-list-cards]")].find(el => {
    const r = el.closest(".bd-list").getBoundingClientRect();
    return x >= r.left && x <= r.right;
  });
  if (col) {
    const before = [...col.querySelectorAll(".bd-card:not(.bd-card--dragging)")].find(el => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (before) col.insertBefore(drag.ph, before); else col.appendChild(drag.ph);
  }
  if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
}

/* Scroll the board sideways (and the page up/down) when the pointer rests near an edge */
function autoScroll() {
  if (!drag?.active) return;
  drag.raf = null;
  const boardEl = $("#bd-board");
  const r = boardEl.getBoundingClientRect();
  const edge = 70;
  let dx = 0, dy = 0;
  if (drag.x < r.left + edge) dx = -Math.ceil((r.left + edge - drag.x) / 4);
  else if (drag.x > r.right - edge) dx = Math.ceil((drag.x - (r.right - edge)) / 4);
  if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 5);
  else if (drag.y > window.innerHeight - edge) dy = Math.ceil((drag.y - (window.innerHeight - edge)) / 5);
  if (!dx && !dy) return;
  boardEl.scrollLeft += dx;
  if (dy) window.scrollBy(0, dy);
  moveDrag(drag.x, drag.y);
}

async function endDrag(cancel) {
  const d = drag;
  drag = null;
  if (!d) return;
  clearTimeout(d.timer);
  if (!d.active) return;
  if (d.raf) cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.card.classList.remove("bd-card--dragging");
  document.body.classList.remove("is-dragging-task");
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 50);
  const col = d.ph.parentElement;
  const sibling = dir => { let el = d.ph[dir]; while (el && el.classList.contains("bd-card--dragging")) el = el[dir]; return el?.classList.contains("bd-card") ? el : null; };
  const prev = sibling("previousElementSibling");
  const next = sibling("nextElementSibling");
  d.ph.remove();
  if (cancel || !col) { render(); if (state.pending) { state.pending = false; load(); } return; }
  const c = state.cards.find(x => x.id === d.id);
  const pp = prev && state.cards.find(x => x.id === prev.dataset.card)?.position;
  const np = next && state.cards.find(x => x.id === next.dataset.card)?.position;
  const position = pp != null && np != null ? (pp + np) / 2 : pp != null ? pp + 1000 : np != null ? np - 1000 : 1000;
  const listId = col.dataset.listCards;
  if (c.list_id === listId && c.position === position) { render(); return; }
  await moveToList(c, listId, position);
  if (state.pending) { state.pending = false; load(); }
}
