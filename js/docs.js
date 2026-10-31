/* Team docs: Notion-style pages with a block editor.
 * Type "/" for blocks, or markdown shortcuts (# heading, - list, 1. list, [] to-do, > quote, ``` code, --- divider).
 * Pages nest; any member writes; staff can lock a page. Autosaves. Table: team_docs. */

import { matchNames, showMentionMenu, hideMentionMenu, mentionMenuOpen, mentionKey } from "./mentions.js?v=20261031b";

let ctx = null;
const state = {
  docs: [], members: [], currentId: null, loaded: false, missing: false, search: "", expanded: new Set(), navOpen: false,
  saveTimer: null, saving: false, dirty: false, lastSavedAt: null, lastEditAt: 0, remoteChanged: false,
};

const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();
const me = () => ctx.getUser();
const isStaff = () => !!(ctx.getProfile()?.is_admin || ctx.getProfile()?.is_moderator);
const myName = () => ctx.getProfile()?.full_name || me()?.email || "Member";
const uid = () => Math.random().toString(36).slice(2, 10);
const current = () => state.docs.find(d => d.id === state.currentId);
const canEdit = d => !!d && (!d.locked || isStaff());
const canDelete = d => !!d && (isStaff() || (d.created_by === me()?.id && !d.locked));

const TYPES = [
  { type: "p", label: "Text", hint: "Plain paragraph", icon: "fa-paragraph", keys: "text paragraph" },
  { type: "h1", label: "Heading 1", hint: "Big section heading", icon: "fa-heading", keys: "h1 heading title" },
  { type: "h2", label: "Heading 2", hint: "Medium heading", icon: "fa-heading", keys: "h2 heading subtitle" },
  { type: "h3", label: "Heading 3", hint: "Small heading", icon: "fa-heading", keys: "h3 heading" },
  { type: "ul", label: "Bulleted list", hint: "Simple bullets", icon: "fa-list-ul", keys: "bullet list ul" },
  { type: "ol", label: "Numbered list", hint: "1, 2, 3", icon: "fa-list-ol", keys: "numbered list ol" },
  { type: "todo", label: "To-do", hint: "Checkbox item", icon: "fa-square-check", keys: "todo checkbox task check" },
  { type: "quote", label: "Quote", hint: "Pull quote", icon: "fa-quote-left", keys: "quote blockquote" },
  { type: "callout", label: "Callout", hint: "Highlighted note", icon: "fa-lightbulb", keys: "callout note info warning" },
  { type: "code", label: "Code", hint: "Monospace block", icon: "fa-code", keys: "code snippet" },
  { type: "divider", label: "Divider", hint: "Horizontal line", icon: "fa-minus", keys: "divider line hr separator" },
];
const PLACEHOLDER = { p: "Type '/' for commands", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", ul: "List", ol: "List", todo: "To-do", quote: "Quote", callout: "Callout", code: "Code" };
const LISTS = new Set(["ul", "ol", "todo"]);
const EMOJI = ["📄", "📘", "📝", "📌", "📐", "⚙️", "🔧", "🔩", "⚡", "🔋", "💻", "🧠", "🤖", "🎯", "🏁", "🏆", "📣", "💰", "🤝", "📸", "📅", "✅", "⚠️", "🧪", "🛠️", "📦", "🚚", "🧭", "🗂️", "💡"];

const TEMPLATES = {
  meeting: { icon: "📝", title: "Meeting notes", blocks: [["callout", "Date · attendees · facilitator"], ["h2", "Agenda"], ["ul", ""], ["h2", "Decisions"], ["ul", ""], ["h2", "Action items"], ["todo", ""]] },
  design: { icon: "📐", title: "Design review", blocks: [["h2", "Problem"], ["p", ""], ["h2", "Options considered"], ["ol", ""], ["h2", "Chosen design and why"], ["p", ""], ["h2", "Risks / open questions"], ["ul", ""], ["h2", "Next steps"], ["todo", ""]] },
  howto: { icon: "🛠️", title: "How-to guide", blocks: [["callout", "What this guide is for and who should use it"], ["h2", "You'll need"], ["ul", ""], ["h2", "Steps"], ["ol", ""], ["h2", "Troubleshooting"], ["p", ""]] },
  mechanism: { icon: "⚙️", title: "Mechanism doc", blocks: [["h2", "Purpose"], ["p", ""], ["h2", "Specs"], ["ul", "Motors / ratios:"], ["ul", "Sensors:"], ["ul", "Weight:"], ["h2", "CAD and drawings"], ["p", ""], ["h2", "Test log"], ["p", ""], ["h2", "Known issues"], ["todo", ""]] },
};

/* ---------- lifecycle ---------- */
let started = false;
export function initDocs(context) {
  ctx = context;
  if (started) { renderNav(); return; }
  started = true;
  try { JSON.parse(localStorage.getItem("nyx-docs-expanded") || "[]").forEach(id => state.expanded.add(id)); } catch { /* storage optional */ }
  try { state.currentId = localStorage.getItem("nyx-docs-current"); } catch { /* storage optional */ }
  ensureFloating();
  load();
  try {
    db().channel("nyx-docs").on("postgres_changes", { event: "*", schema: "public", table: "team_docs" }, onRemote).subscribe();
  } catch { /* realtime optional */ }
  window.addEventListener("beforeunload", () => { if (state.dirty) save(); });
}

async function load() {
  const [{ data, error }, m] = await Promise.all([
    db().from("team_docs").select("*").order("sort").order("created_at"),
    db().from("profiles").select("full_name").eq("is_approved", true),
  ]);
  state.members = (m.data || []).map(x => x.full_name).filter(Boolean).sort((a, b) => a.localeCompare(b));
  state.missing = !!error && /relation|does not exist|schema cache/i.test(error.message);
  state.docs = data || [];
  state.loaded = true;
  if (!current()) state.currentId = state.docs.find(d => !d.parent_id)?.id || null;
  renderAll();
}

function onRemote(payload) {
  const row = payload.new?.id ? payload.new : null;
  const oldId = payload.old?.id;
  if (payload.eventType === "DELETE") {
    state.docs = state.docs.filter(d => d.id !== oldId);
    if (state.currentId === oldId) { state.currentId = null; renderAll(); } else renderNav();
    return;
  }
  if (!row) return;
  const i = state.docs.findIndex(d => d.id === row.id);
  const sameTime = (a, b) => !!a && !!b && new Date(a).getTime() === new Date(b).getTime();
  // Our own save, or a metadata-only change (lock, move) that didn't touch the content
  const mine = sameTime(row.updated_at, state.lastSavedAt) || (i >= 0 && sameTime(row.updated_at, state.docs[i].updated_at));
  if (mine && i >= 0) Object.assign(state.docs[i], { locked: row.locked, parent_id: row.parent_id, sort: row.sort });
  if (row.id === state.currentId && !mine) {
    const idle = !state.dirty && Date.now() - state.lastEditAt > 4000;
    if (i >= 0) state.docs[i] = row; else state.docs.push(row);
    if (idle) renderPage(); else { state.remoteChanged = true; renderStatus(); }
  } else if (!mine) {
    if (i >= 0) state.docs[i] = row; else state.docs.push(row);
  }
  renderNav();
}

/* ---------- layout ---------- */
function renderAll() {
  const host = $("#docs-body");
  if (!host) return;
  if (state.missing) {
    host.innerHTML = `<div class="scout-card scout-warn-box" style="margin:20px;">Docs tables aren't in the database yet — an admin needs to run <code>supabase/schema.sql</code>.</div>`;
    return;
  }
  host.innerHTML = `<div class="docs-layout ${state.navOpen ? "nav-open" : ""}">
    <aside class="docs-nav" aria-label="Pages">
      <div class="docs-nav-head">
        <input type="search" id="docs-search" placeholder="Search pages" value="${esc(state.search)}" aria-label="Search pages">
        <button type="button" class="btn btn--primary btn--sm" id="docs-new" title="New page"><i class=fa-plus aria-hidden=true></i> New</button>
      </div>
      <div class="docs-tree" id="docs-tree"></div>
    </aside>
    <article class="docs-page" id="docs-page"></article>
  </div>`;
  $("#docs-search").oninput = e => { state.search = e.target.value; renderNav(); };
  $("#docs-new").onclick = () => createDoc(null);
  renderNav();
  renderPage();
}

function children(parentId) {
  return state.docs.filter(d => (d.parent_id || null) === parentId).sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at));
}
function ancestors(d) {
  const out = [];
  let p = d && state.docs.find(x => x.id === d.parent_id);
  while (p && out.length < 20) { out.unshift(p); p = state.docs.find(x => x.id === p.parent_id); }
  return out;
}
const plainText = d => (d.blocks || []).map(b => (b.html || "").replace(/<[^>]+>/g, " ")).join(" ");

function renderNav() {
  const tree = $("#docs-tree");
  if (!tree) return;
  if (!state.loaded) { tree.innerHTML = `<p class="muted small">Loading…</p>`; return; }
  const q = state.search.trim().toLowerCase();
  if (q) {
    const hits = state.docs.filter(d => (d.title || "").toLowerCase().includes(q) || plainText(d).toLowerCase().includes(q));
    tree.innerHTML = hits.length ? hits.map(d => rowHtml(d, 0, false)).join("") : `<p class="muted small" style="padding:8px;">No pages match.</p>`;
  } else {
    const walk = (pid, depth) => children(pid).map(d => {
      const kids = children(d.id);
      const open = state.expanded.has(d.id);
      return rowHtml(d, depth, kids.length ? (open ? "open" : "closed") : "") + (open ? walk(d.id, depth + 1) : "");
    }).join("");
    tree.innerHTML = walk(null, 0) || `<p class="muted small" style="padding:8px;">No pages yet.</p>`;
  }
  tree.querySelectorAll("[data-open-doc]").forEach(b => b.onclick = e => {
    if (e.target.closest("[data-toggle], [data-add-child]")) return;
    openDoc(b.dataset.openDoc);
  });
  tree.querySelectorAll("[data-toggle]").forEach(b => b.onclick = () => toggleExpand(b.dataset.toggle));
  tree.querySelectorAll("[data-add-child]").forEach(b => b.onclick = () => createDoc(b.dataset.addChild));
}

function rowHtml(d, depth, caret) {
  return `<div class="docs-row ${d.id === state.currentId ? "active" : ""}" style="padding-left:${6 + depth * 14}px" data-open-doc="${d.id}" role="button" tabindex="0">
    <span class="docs-caret" ${caret ? `data-toggle="${d.id}"` : ""}>${caret === "open" ? "▾" : caret === "closed" ? "▸" : ""}</span>
    <span class="docs-row-icon">${esc(d.icon || "📄")}</span>
    <span class="docs-row-title">${esc(d.title || "Untitled")}</span>
    ${d.locked ? `<i class=fa-lock aria-hidden=true title="Locked"></i>` : ""}
    <button type="button" class="docs-row-add" data-add-child="${d.id}" title="Add a page inside" aria-label="Add a page inside">+</button>
  </div>`;
}

function toggleExpand(id, force) {
  if (force ?? !state.expanded.has(id)) state.expanded.add(id); else state.expanded.delete(id);
  try { localStorage.setItem("nyx-docs-expanded", JSON.stringify([...state.expanded])); } catch { /* storage optional */ }
  renderNav();
}

async function openDoc(id) {
  if (state.dirty) await save();
  state.currentId = id;
  state.navOpen = false;
  $(".docs-layout")?.classList.remove("nav-open");
  try { localStorage.setItem("nyx-docs-current", id); } catch { /* storage optional */ }
  ancestors(current()).forEach(a => state.expanded.add(a.id));
  renderNav();
  renderPage();
  // On phones the page list sits above the page, so bring the page into view
  if (window.innerWidth <= 860) $("#docs-page")?.scrollIntoView({ block: "start", behavior: "smooth" });
}

/* ---------- page ---------- */
function renderPage() {
  const page = $("#docs-page");
  if (!page) return;
  const d = current();
  state.remoteChanged = false;
  if (!d) {
    page.innerHTML = `<div class="docs-empty">
      <div class="docs-empty-icon">📘</div>
      <h2>Team docs</h2>
      <p class="muted">Write build guides, design reviews, meeting notes and how-tos. Pages can nest inside each other.</p>
      <div class="docs-templates">${templateButtons()}</div>
    </div>`;
    bindTemplates(page, null);
    return;
  }
  const editable = canEdit(d);
  const crumbs = ancestors(d);
  page.innerHTML = `
    <div class="docs-topbar">
      <button type="button" class="ss-icon docs-nav-toggle" id="docs-nav-toggle" aria-label="Show pages"><i class=fa-bars aria-hidden=true></i></button>
      <div class="docs-crumbs">${crumbs.map(c => `<button type="button" data-crumb="${c.id}">${esc(c.icon || "📄")} ${esc(c.title || "Untitled")}</button><span>/</span>`).join("")}<span class="docs-crumb-cur">${esc(d.title || "Untitled")}</span></div>
      <div class="docs-status" id="docs-status"></div>
      <button type="button" class="ss-icon" id="docs-page-menu" aria-label="Page options" title="Page options"><i class=fa-ellipsis aria-hidden=true></i></button>
    </div>
    <div class="docs-sheet ${editable ? "" : "is-readonly"}">
      <button type="button" class="docs-icon" id="docs-icon" ${editable ? "" : "disabled"} title="Change icon">${esc(d.icon || "📄")}</button>
      <h1 class="docs-title" id="docs-title" ${editable ? `contenteditable="true"` : ""} data-placeholder="Untitled">${esc(d.title)}</h1>
      ${d.locked ? `<div class="docs-locked"><i class=fa-lock aria-hidden=true></i> Locked${isStaff() ? " — only admins and moderators can edit" : ". Ask an admin or moderator to change it."}</div>` : ""}
      <div class="docs-blocks" id="docs-blocks"></div>
      ${editable ? `<div class="docs-tail" id="docs-tail" title="Click to add a block"></div>` : ""}
      ${editable && !(d.blocks || []).some(b => b.html || b.type === "divider") ? `<div class="docs-templates docs-templates--inline"><span class="muted small">Start from a template:</span>${templateButtons()}</div>` : ""}
      ${children(d.id).length ? `<div class="docs-subpages"><div class="muted small">Pages inside</div>${children(d.id).map(c => `<button type="button" class="docs-subpage" data-crumb="${c.id}">${esc(c.icon || "📄")} ${esc(c.title || "Untitled")}</button>`).join("")}</div>` : ""}
    </div>`;
  const blocks = $("#docs-blocks");
  const list = (d.blocks || []).length ? d.blocks : [{ id: uid(), type: "p", html: "" }];
  list.forEach(b => blocks.appendChild(blockEl(b, editable)));
  renumber();
  renderStatus();
  bindPage(d, editable);
}

function templateButtons() {
  return Object.entries(TEMPLATES).map(([k, t]) => `<button type="button" class="btn btn--ghost btn--sm" data-template="${k}">${t.icon} ${t.title}</button>`).join("");
}
function bindTemplates(root, d) {
  root.querySelectorAll("[data-template]").forEach(b => b.onclick = async () => {
    const t = TEMPLATES[b.dataset.template];
    const blocks = t.blocks.map(([type, html]) => ({ id: uid(), type, html: esc(html) }));
    if (!d) return createDoc(null, { title: t.title, icon: t.icon, blocks });
    d.blocks = blocks;
    if (!d.title) d.title = t.title;
    if (!d.icon) d.icon = t.icon;
    renderPage();
    markDirty(true);
  });
}

function renderStatus() {
  const el = $("#docs-status");
  const d = current();
  if (!el || !d) return;
  if (state.remoteChanged) {
    el.innerHTML = `<button type="button" class="btn btn--ghost btn--sm" id="docs-reload">${esc(d.updated_by_name || "Someone")} edited this page · Show latest</button>`;
    $("#docs-reload").onclick = () => renderPage();
    return;
  }
  el.textContent = state.saving ? "Saving…" : state.dirty ? "Unsaved…" : d.updated_at ? `Edited ${ago(d.updated_at)}${d.updated_by_name ? ` by ${d.updated_by_name}` : ""}` : "";
}
function ago(ts) {
  const s = Math.round((Date.now() - new Date(ts)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function blockEl(b, editable) {
  const el = document.createElement("div");
  el.className = `db-block db-${b.type}${b.checked ? " is-checked" : ""}`;
  el.dataset.bid = b.id || uid();
  el.dataset.type = b.type;
  if (b.type === "divider") {
    el.innerHTML = `${gutter(editable)}<hr>`;
    return el;
  }
  const tag = b.type === "code" ? "pre" : "div";
  el.innerHTML = `${gutter(editable)}
    ${b.type === "todo" ? `<input type="checkbox" class="db-check" ${b.checked ? "checked" : ""} ${editable ? "" : "disabled"} aria-label="Done">` : ""}
    ${b.type === "ol" ? `<span class="db-num"></span>` : ""}
    ${b.type === "callout" ? `<span class="db-callout-icon">💡</span>` : ""}
    <${tag} class="db-text" ${editable ? `contenteditable="true"` : ""} data-placeholder="${PLACEHOLDER[b.type] || ""}"></${tag}>`;
  el.querySelector(".db-text").innerHTML = b.type === "code" ? esc(b.text ?? "") : sanitize(b.html || "");
  return el;
}
const gutter = editable => editable ? `<div class="db-gutter" contenteditable="false"><button type="button" class="db-plus" tabindex="-1" title="Add block below" aria-label="Add block below">+</button><button type="button" class="db-handle" tabindex="-1" title="Drag to move · click for options" aria-label="Block options">⋮⋮</button></div>` : "";

function renumber() {
  let n = 0;
  document.querySelectorAll("#docs-blocks > .db-block").forEach(el => {
    if (el.dataset.type === "ol") { n++; el.querySelector(".db-num").textContent = n + "."; } else n = 0;
  });
}

/* ---------- serialisation ---------- */
function serialize() {
  return [...document.querySelectorAll("#docs-blocks > .db-block")].map(el => {
    const type = el.dataset.type;
    const b = { id: el.dataset.bid, type };
    if (type === "divider") return b;
    const t = el.querySelector(".db-text");
    if (type === "code") b.text = t.innerText.replace(/\n$/, "");
    else b.html = sanitize(t.innerHTML);
    if (type === "todo") b.checked = el.querySelector(".db-check").checked;
    return b;
  });
}

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escText = s => s.replace(/\u200B/g, "").replace(/[&<>"]/g, c => ESC_MAP[c]);
const INLINE = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", S: "s", STRIKE: "s", DEL: "s", CODE: "code", MARK: "mark" };
/* Keep only inline formatting and safe links */
function sanitize(html) {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html").body.firstChild;
  const walk = node => {
    let out = "";
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) { out += escText(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === "SCRIPT" || n.tagName === "STYLE") return;
      const tag = n.tagName, inner = walk(n);
      if (tag === "BR") out += "<br>";
      else if (tag === "A") {
        const href = n.getAttribute("href") || "";
        out += /^(https?:\/\/|mailto:)/i.test(href) ? `<a href="${escText(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
      } else if (INLINE[tag]) out += inner ? `<${INLINE[tag]}>${inner}</${INLINE[tag]}>` : "";
      else if (tag === "DIV" || tag === "P") out += (out && !out.endsWith("<br>") ? "<br>" : "") + inner;
      else if (tag === "SPAN" && n.hasAttribute("data-mention")) out += `<span class="mention" data-mention="" contenteditable="false">${inner}</span>`;
      else if (tag === "SPAN" && /font-weight:\s*(bold|[6-9]00)/.test(n.getAttribute("style") || "")) out += `<b>${inner}</b>`;
      else out += inner;
    });
    return out;
  };
  return walk(root).replace(/(<br>)+$/, "");
}

/* ---------- saving ---------- */
function markDirty(now) {
  state.dirty = true;
  state.lastEditAt = Date.now();
  renderStatus();
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, now ? 0 : 700);
}

async function save() {
  clearTimeout(state.saveTimer);
  const d = current();
  if (!d || !state.dirty || !canEdit(d)) return;
  const titleEl = $("#docs-title");
  if (titleEl) d.title = titleEl.textContent.replace(/\s+/g, " ").trim();
  if ($("#docs-blocks")) d.blocks = serialize();
  const now = new Date().toISOString();
  state.dirty = false;
  state.saving = true;
  state.lastSavedAt = now;
  d.updated_at = now;
  d.updated_by_name = myName();
  renderStatus();
  const { error } = await db().from("team_docs").update({ title: d.title, icon: d.icon, blocks: d.blocks, updated_at: now, updated_by_name: d.updated_by_name }).eq("id", d.id);
  state.saving = false;
  if (error) { state.dirty = true; ctx.toast("Couldn't save page: " + error.message, true); }
  renderStatus();
  renderNav();
}

async function createDoc(parentId, init = {}) {
  if (state.dirty) await save();
  const siblings = children(parentId);
  const row = {
    parent_id: parentId, title: init.title || "", icon: init.icon || "", blocks: init.blocks || [{ id: uid(), type: "p", html: "" }],
    sort: (siblings.at(-1)?.sort || 0) + 1000, created_by: me()?.id, created_by_name: myName(), updated_by_name: myName(),
  };
  const { data, error } = await db().from("team_docs").insert(row).select().single();
  if (error) return ctx.toast("Couldn't create page: " + error.message, true);
  state.docs.push(data);
  if (parentId) state.expanded.add(parentId);
  ctx.logAction("DOC_CREATED", "team_docs", data.id, { title: data.title || "Untitled" });
  await openDoc(data.id);
  const t = $("#docs-title");
  if (t && !data.title) t.focus();
}

async function deleteDoc(d) {
  const count = (function n(id) { return children(id).reduce((s, c) => s + 1 + n(c.id), 0); })(d.id);
  if (!confirm(`Delete “${d.title || "Untitled"}”${count ? ` and the ${count} page${count === 1 ? "" : "s"} inside it` : ""}? This can't be undone.`)) return;
  state.dirty = false;
  clearTimeout(state.saveTimer);
  const { error } = await db().from("team_docs").delete().eq("id", d.id);
  if (error) return ctx.toast("Couldn't delete: " + error.message, true);
  ctx.logAction("DOC_DELETED", "team_docs", d.id, { title: d.title });
  const gone = new Set([d.id]);
  let grew = true;
  while (grew) { grew = false; state.docs.forEach(x => { if (x.parent_id && gone.has(x.parent_id) && !gone.has(x.id)) { gone.add(x.id); grew = true; } }); }
  state.docs = state.docs.filter(x => !gone.has(x.id));
  state.currentId = d.parent_id || state.docs.find(x => !x.parent_id)?.id || null;
  renderAll();
}

/* ---------- editor events ---------- */
function bindPage(d, editable) {
  const page = $("#docs-page");
  page.querySelectorAll("[data-crumb]").forEach(b => b.onclick = () => openDoc(b.dataset.crumb));
  $("#docs-nav-toggle").onclick = () => { state.navOpen = !state.navOpen; $(".docs-layout").classList.toggle("nav-open", state.navOpen); };
  $("#docs-page-menu").onclick = e => { e.stopPropagation(); pageMenu(e.currentTarget, d); };
  bindTemplates(page.querySelector(".docs-templates--inline") || document.createElement("div"), d);
  if (!editable) {
    page.querySelectorAll(".db-text a").forEach(a => a.target = "_blank");
    return;
  }
  $("#docs-icon").onclick = e => { e.stopPropagation(); iconPicker(e.currentTarget, d); };
  const title = $("#docs-title");
  title.oninput = () => { markDirty(); const cur = $(".docs-crumb-cur"); if (cur) cur.textContent = title.textContent || "Untitled"; };
  title.onpaste = e => { e.preventDefault(); document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " ")); };
  title.onkeydown = e => {
    if (e.key === "Enter" || (e.key === "ArrowDown")) {
      e.preventDefault();
      const first = $("#docs-blocks .db-text");
      if (first) focusAt(first, "start");
    }
  };
  $("#docs-tail").onclick = () => {
    const last = $("#docs-blocks > .db-block:last-child");
    if (last && last.dataset.type === "p" && !last.querySelector(".db-text").textContent) return focusAt(last.querySelector(".db-text"), "end");
    insertAfter(last, { type: "p", html: "" });
  };

  const blocks = $("#docs-blocks");
  blocks.addEventListener("input", onInput);
  blocks.addEventListener("keydown", onKeyDown);
  blocks.addEventListener("paste", onPaste);
  blocks.addEventListener("change", e => {
    if (!e.target.matches(".db-check")) return;
    e.target.closest(".db-block").classList.toggle("is-checked", e.target.checked);
    markDirty(true);
  });
  blocks.addEventListener("click", e => {
    const a = e.target.closest(".db-text a");
    if (a && (e.metaKey || e.ctrlKey)) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); return; }
    const handle = e.target.closest(".db-handle");
    if (handle) { e.stopPropagation(); blockMenu(handle, handle.closest(".db-block")); return; }
    const plus = e.target.closest(".db-plus");
    if (plus) {
      const el = insertAfter(plus.closest(".db-block"), { type: "p", html: "" });
      document.execCommand("insertText", false, "/");
      onInput({ target: el.querySelector(".db-text") });
    }
  });
  blocks.addEventListener("pointerdown", onHandleDown);
}

const blockOf = node => node?.closest?.(".db-block") || node?.parentElement?.closest(".db-block");
const textOf = block => block?.querySelector(".db-text");

function caretInfo(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const pre = document.createRange(); pre.selectNodeContents(el); pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange(); post.selectNodeContents(el); post.setStart(r.endContainer, r.endOffset);
  return { range: r, collapsed: r.collapsed, before: pre.toString(), atStart: r.collapsed && pre.toString().length === 0 && !pre.cloneContents().querySelector?.("br"), atEnd: r.collapsed && post.toString().length === 0 };
}

function focusAt(el, where) {
  el.focus();
  const r = document.createRange();
  if (typeof where === "number") {
    // character offset
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = where, node;
    while ((node = walker.nextNode())) {
      if (left <= node.length) { r.setStart(node, left); break; }
      left -= node.length;
    }
    if (!node) { r.selectNodeContents(el); r.collapse(false); }
  } else { r.selectNodeContents(el); r.collapse(where === "start"); }
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

function insertAfter(ref, b, focus = "start") {
  const el = blockEl({ id: uid(), ...b }, true);
  if (ref) ref.after(el); else $("#docs-blocks").appendChild(el);
  renumber();
  const t = textOf(el);
  if (t && focus) focusAt(t, focus);
  markDirty();
  return el;
}

function convert(block, type, opts = {}) {
  const t = textOf(block);
  const b = { id: block.dataset.bid, type, checked: !!opts.checked };
  if (type === "code") b.text = t ? t.innerText : "";
  else if (type !== "divider") b.html = t ? (block.dataset.type === "code" ? escText(t.innerText).replace(/\n/g, "<br>") : t.innerHTML) : "";
  const el = blockEl(b, true);
  block.replaceWith(el);
  renumber();
  if (type === "divider") {
    const next = el.nextElementSibling;
    if (next && textOf(next)) focusAt(textOf(next), "start"); else insertAfter(el, { type: "p", html: "" });
  } else focusAt(textOf(el), opts.caret ?? "start");
  markDirty();
  return el;
}

function onInput(e) {
  const t = e.target.closest?.(".db-text");
  if (!t) return;
  if (t.innerHTML === "<br>") t.innerHTML = "";
  const block = blockOf(t);
  if (block.dataset.type !== "code" && t.textContent === "---") { t.textContent = ""; convert(block, "divider"); return; }
  if (block.dataset.type !== "code" && t.textContent === "```") { t.textContent = ""; convert(block, "code"); return; }
  if (block.dataset.type !== "code") inlineMarkdown();
  const info = caretInfo(t);
  const m = info && info.collapsed && block.dataset.type !== "code" ? info.before.match(/(?:^|\s)\/([\w ]{0,20})$/) : null;
  if (m) openSlash(block, m[1]); else closeSlash();
  const at = !m && info && info.collapsed && block.dataset.type !== "code" ? info.before.replace(/\u200B/g, "").match(/(?:^|\s)@([\w.'-]{0,20})$/) : null;
  const people = at ? matchNames(state.members, at[1]) : [];
  if (people.length) {
    const r = info.range.getClientRects()[0] || t.getBoundingClientRect();
    showMentionMenu(people, r, name => insertMention(t, at[1], name));
  } else if (mentionMenuOpen()) hideMentionMenu();
  markDirty();
}

/* Replace the typed "@query" with a mention chip */
function insertMention(t, query, name) {
  t.focus();
  const sel = getSelection();
  for (let i = 0; i < query.length + 1; i++) sel.modify("extend", "backward", "character");
  sel.getRangeAt(0).deleteContents();
  document.execCommand("insertHTML", false, `<span class="mention" data-mention="" contenteditable="false">@${escText(name)}</span>&nbsp;`);
  markDirty();
}

/* Typing the closing marker of **bold**, *italic*, ~~strike~~ or `code` formats the text, as in Notion */
function inlineMarkdown() {
  const sel = getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const node = sel.anchorNode;
  if (node?.nodeType !== 3 || node.parentElement.closest("code")) return;
  const upto = node.nodeValue.slice(0, sel.anchorOffset);
  let m = upto.match(/(\*\*|~~|`)([^*~`]+?)\1$/), tag;
  if (m) tag = { "**": "b", "~~": "s", "`": "code" }[m[1]];
  else if ((m = upto.match(/(?:^|[^*\w])\*([^*\s][^*]*?)\*$/))) { m = [m[0].slice(m[0].indexOf("*")), "*", m[1]]; tag = "i"; }
  if (!m || !m[2].trim()) return;
  const after = node.splitText(sel.anchorOffset);
  node.nodeValue = upto.slice(0, upto.length - m[0].length);
  const el = document.createElement(tag);
  el.textContent = m[2];
  node.after(el);
  // A zero-width space keeps the caret outside the new element (stripped when saving)
  after.nodeValue = "\u200B" + after.nodeValue;
  const r = document.createRange();
  r.setStart(after, 1);
  sel.removeAllRanges(); sel.addRange(r);
}

const SHORTCUTS = { "#": "h1", "##": "h2", "###": "h3", "-": "ul", "*": "ul", "+": "ul", "1.": "ol", "[]": "todo", "[ ]": "todo", "[x]": "todo", ">": "quote", '"': "quote", "!": "callout" };

function onKeyDown(e) {
  const t = e.target.closest?.(".db-text");
  if (!t) return;
  if (mentionKey(e)) return;
  const block = blockOf(t);
  const type = block.dataset.type;

  if (slash.open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveSlash(e.key === "ArrowDown" ? 1 : -1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); chooseSlash(); return; }
    if (e.key === "Escape") { e.preventDefault(); closeSlash(); return; }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); addLink(); return; }
  if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); wrapInline("code"); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); document.execCommand("strikeThrough"); markDirty(); return; }
  if (e.altKey && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveBlock(block, e.key === "ArrowUp" ? -1 : 1); return; }
  if (mod && e.key === "Enter" && type === "todo") { e.preventDefault(); const c = block.querySelector(".db-check"); c.checked = !c.checked; block.classList.toggle("is-checked", c.checked); markDirty(); return; }

  const info = caretInfo(t);
  if (!info) return;

  if (e.key === " " && type === "p" && info.collapsed && SHORTCUTS[info.before] && info.before === info.before.trim()) {
    e.preventDefault();
    const key = info.before;
    for (let i = 0; i < key.length; i++) getSelection().modify("extend", "backward", "character");
    getSelection().getRangeAt(0).deleteContents();
    convert(block, SHORTCUTS[key], { checked: key === "[x]" });
    return;
  }

  if (e.key === "Enter" && !e.shiftKey) {
    if (type === "code") {
      if (mod) { e.preventDefault(); insertAfter(block, { type: "p", html: "" }); }
      else { e.preventDefault(); document.execCommand("insertLineBreak"); }
      return;
    }
    e.preventDefault();
    const empty = !t.textContent && !t.querySelector("br");
    if (LISTS.has(type) || type === "quote" || type === "callout") {
      if (empty) { convert(block, "p"); return; }
    }
    const nextType = LISTS.has(type) ? type : "p";
    if (info.atStart && !empty) {
      const el = blockEl({ id: uid(), type: nextType, html: "" }, true);
      block.before(el);
      renumber();
      markDirty();
      return;
    }
    const r = info.range;
    r.deleteContents();
    const tail = document.createRange();
    tail.setStart(r.endContainer, r.endOffset);
    tail.setEnd(t, t.childNodes.length);
    const holder = document.createElement("div");
    holder.appendChild(tail.extractContents());
    if (t.innerHTML === "<br>") t.innerHTML = "";
    insertAfter(block, { type: nextType, html: sanitize(holder.innerHTML) }, "start");
    return;
  }

  if (e.key === "Backspace" && info.atStart && info.collapsed) {
    if (type !== "p") { e.preventDefault(); convert(block, "p"); return; }
    const prev = block.previousElementSibling;
    if (!prev) return;
    e.preventDefault();
    if (prev.dataset.type === "divider") { prev.remove(); renumber(); markDirty(); return; }
    mergeInto(prev, block);
    return;
  }

  if (e.key === "Delete" && info.atEnd && info.collapsed) {
    const next = block.nextElementSibling;
    if (!next) return;
    e.preventDefault();
    if (next.dataset.type === "divider") { next.remove(); markDirty(); return; }
    mergeInto(block, next);
    return;
  }

  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && info.collapsed) {
    const up = e.key === "ArrowUp";
    if (!onEdgeLine(t, info.range, up)) return;
    let sib = up ? block.previousElementSibling : block.nextElementSibling;
    while (sib && !textOf(sib)) sib = up ? sib.previousElementSibling : sib.nextElementSibling;
    if (!sib && up) { e.preventDefault(); const title = $("#docs-title"); title.focus(); focusAt(title, "end"); return; }
    if (!sib) return;
    e.preventDefault();
    focusAt(textOf(sib), up ? "end" : "start");
  }
}

function onEdgeLine(el, range, up) {
  const rects = range.getClientRects();
  const box = el.getBoundingClientRect();
  if (!rects.length) return true;
  const r = rects[0];
  const line = parseFloat(getComputedStyle(el).lineHeight) || 22;
  return up ? r.top - box.top < line * 0.75 : box.bottom - r.bottom < line * 0.75;
}

function mergeInto(target, source) {
  const tt = textOf(target), st = textOf(source);
  const offset = tt.textContent.length;
  if (target.dataset.type === "code") tt.textContent += st.innerText;
  else tt.innerHTML = sanitize(tt.innerHTML + (source.dataset.type === "code" ? escText(st.innerText) : st.innerHTML));
  source.remove();
  renumber();
  focusAt(tt, offset);
  markDirty();
}

function moveBlock(block, dir) {
  const sib = dir < 0 ? block.previousElementSibling : block.nextElementSibling;
  if (!sib) return;
  const sel = getSelection();
  const r = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  if (dir < 0) sib.before(block); else sib.after(block);
  if (r) { sel.removeAllRanges(); sel.addRange(r); }
  renumber();
  markDirty();
}

function onPaste(e) {
  const t = e.target.closest?.(".db-text");
  if (!t) return;
  e.preventDefault();
  const text = (e.clipboardData.getData("text/plain") || "").replace(/\r/g, "");
  const block = blockOf(t);
  if (block.dataset.type === "code" || !text.includes("\n")) {
    if (block.dataset.type !== "code" && /^https?:\/\/\S+$/.test(text.trim()) && !getSelection().isCollapsed) {
      document.execCommand("createLink", false, text.trim());
    } else document.execCommand("insertText", false, text);
    markDirty();
    return;
  }
  const lines = text.split("\n").filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1));
  document.execCommand("insertText", false, lines.shift() || "");
  let ref = block;
  for (const line of lines) {
    const m = line.match(/^\s*(#{1,3}|[-*+]|\d+[.)]|\[[ x]?\]|>)\s+(.*)$/);
    let type = "p", body = line, checked = false;
    if (m) {
      const k = m[1];
      type = k.startsWith("#") ? "h" + k.length : /^[-*+]$/.test(k) ? "ul" : /^\d/.test(k) ? "ol" : k.startsWith("[") ? "todo" : "quote";
      checked = k === "[x]";
      body = m[2];
    } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) type = "divider";
    ref = insertAfter(ref, { type, checked, html: escText(body) }, false);
  }
  if (textOf(ref)) focusAt(textOf(ref), "end");
  markDirty();
}

function addLink() {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0).cloneRange();
  const url = prompt("Link URL:", "https://");
  if (!url || !/^(https?:\/\/|mailto:)/i.test(url.trim())) return;
  sel.removeAllRanges(); sel.addRange(range);
  if (range.collapsed) document.execCommand("insertHTML", false, `<a href="${escText(url.trim())}">${escText(url.trim())}</a>`);
  else document.execCommand("createLink", false, url.trim());
  markDirty();
}

function wrapInline(tag) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const holder = document.createElement("div");
  holder.appendChild(r.cloneContents());
  const already = holder.querySelector(tag) || r.commonAncestorContainer.parentElement?.closest(tag);
  if (already && r.commonAncestorContainer.parentElement?.closest(tag)) {
    const el = r.commonAncestorContainer.parentElement.closest(tag);
    el.replaceWith(...el.childNodes);
  } else {
    document.execCommand("insertHTML", false, `<${tag}>${escText(r.toString())}</${tag}>`);
  }
  markDirty();
}

/* ---------- slash menu ---------- */
const slash = { open: false, block: null, query: "", index: 0, items: [] };

function openSlash(block, query) {
  const menu = $("#docs-slash");
  const q = query.trim().toLowerCase();
  slash.items = TYPES.filter(t => !q || t.label.toLowerCase().includes(q) || t.keys.includes(q));
  if (!slash.items.length) return closeSlash();
  if (slash.query !== query || slash.block !== block) slash.index = 0;
  Object.assign(slash, { open: true, block, query });
  menu.innerHTML = `<div class="docs-menu-title">Blocks</div>` + slash.items.map((t, i) => `<button type="button" class="${i === slash.index ? "active" : ""}" data-i="${i}">
    <span class="docs-menu-icon"><i class=${t.icon} aria-hidden=true></i></span><span><b>${t.label}</b><small>${t.hint}</small></span></button>`).join("");
  menu.querySelectorAll("[data-i]").forEach(b => {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { slash.index = Number(b.dataset.i); chooseSlash(); };
  });
  menu.classList.remove("hidden");
  const r = getSelection().getRangeAt(0).getClientRects()[0] || textOf(block).getBoundingClientRect();
  const h = menu.offsetHeight;
  menu.style.left = Math.min(window.innerWidth - menu.offsetWidth - 12, Math.max(12, r.left)) + "px";
  menu.style.top = (r.bottom + h + 12 > window.innerHeight ? Math.max(12, r.top - h - 6) : r.bottom + 6) + "px";
}
function moveSlash(d) {
  slash.index = (slash.index + d + slash.items.length) % slash.items.length;
  $("#docs-slash").querySelectorAll("[data-i]").forEach((b, i) => { b.classList.toggle("active", i === slash.index); if (i === slash.index) b.scrollIntoView({ block: "nearest" }); });
}
function closeSlash() {
  slash.open = false;
  $("#docs-slash")?.classList.add("hidden");
}
function chooseSlash() {
  const item = slash.items[slash.index];
  const block = slash.block;
  closeSlash();
  if (!item || !block?.isConnected) return;
  const t = textOf(block);
  t.focus();
  const n = slash.query.length + 1;
  const sel = getSelection();
  for (let i = 0; i < n; i++) sel.modify("extend", "backward", "character");
  sel.getRangeAt(0).deleteContents();
  if (t.innerHTML === "<br>") t.innerHTML = "";
  if (item.type === "divider") {
    if (!t.textContent) convert(block, "divider");
    else { const el = blockEl({ id: uid(), type: "divider" }, true); block.after(el); insertAfter(el, { type: "p", html: "" }); }
    return;
  }
  convert(block, item.type, { caret: "end" });
}

/* ---------- block handle: click for menu, drag to move ---------- */
let drag = null;
function onHandleDown(e) {
  const h = e.target.closest(".db-handle");
  if (!h || e.button > 0) return;
  e.preventDefault();
  const block = h.closest(".db-block");
  drag = { block, startY: e.clientY, active: false, pointerId: e.pointerId };
  const move = ev => {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (!drag.active && Math.abs(ev.clientY - drag.startY) < 5) return;
    if (!drag.active) {
      drag.active = true;
      block.classList.add("is-dragging");
      drag.line = document.createElement("div");
      drag.line.className = "db-drop-line";
      document.body.classList.add("is-dragging-task");
    }
    const others = [...document.querySelectorAll("#docs-blocks > .db-block")].filter(x => x !== block);
    const before = others.find(x => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
    if (before) before.before(drag.line); else $("#docs-blocks").appendChild(drag.line);
    drag.before = before || null;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("is-dragging-task");
    const d = drag; drag = null;
    if (!d) return;
    if (!d.active) return; // a plain click opens the menu (see the click handler)
    d.line.remove();
    block.classList.remove("is-dragging");
    if (d.before) d.before.before(block); else $("#docs-blocks").appendChild(block);
    renumber();
    markDirty();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function blockMenu(anchor, block) {
  const menu = $("#docs-popover");
  menu.innerHTML = `<div class="ss-menu">
    <div class="docs-menu-title">Turn into</div>
    <div class="docs-turn">${TYPES.filter(t => t.type !== "divider").map(t => `<button type="button" data-turn="${t.type}" class="${block.dataset.type === t.type ? "active" : ""}" title="${t.label}"><i class=${t.icon} aria-hidden=true></i> ${t.label}</button>`).join("")}</div>
    <button type="button" data-a="up"><i class=fa-arrow-up aria-hidden=true></i> Move up</button>
    <button type="button" data-a="down"><i class=fa-arrow-down aria-hidden=true></i> Move down</button>
    <button type="button" data-a="dup"><i class=fa-copy aria-hidden=true></i> Duplicate</button>
    <button type="button" data-a="del" class="danger"><i class=fa-trash aria-hidden=true></i> Delete</button>
  </div>`;
  menu.querySelectorAll("[data-turn]").forEach(b => b.onclick = () => { menu.classList.add("hidden"); convert(block, b.dataset.turn, { caret: "end" }); });
  menu.querySelectorAll("[data-a]").forEach(b => b.onclick = () => {
    menu.classList.add("hidden");
    const a = b.dataset.a;
    if (a === "up" || a === "down") moveBlock(block, a === "up" ? -1 : 1);
    else if (a === "dup") {
      const copy = block.cloneNode(true);
      copy.dataset.bid = uid();
      block.after(copy); renumber(); markDirty();
    } else if (a === "del") {
      const next = block.nextElementSibling || block.previousElementSibling;
      block.remove();
      if (!$("#docs-blocks").children.length) insertAfter(null, { type: "p", html: "" });
      else if (next && textOf(next)) focusAt(textOf(next), "start");
      renumber(); markDirty();
    }
  });
  placePopover(menu, anchor);
}

function pageMenu(anchor, d) {
  const menu = $("#docs-popover");
  menu.innerHTML = `<div class="ss-menu">
    ${canEdit(d) ? `<button type="button" data-a="child"><i class=fa-file-circle-plus aria-hidden=true></i> Add a page inside</button>` : ""}
    ${isStaff() ? `<button type="button" data-a="lock"><i class=${d.locked ? "fa-lock-open" : "fa-lock"} aria-hidden=true></i> ${d.locked ? "Unlock page" : "Lock page (staff-only edits)"}</button>` : ""}
    ${!d.parent_id ? "" : `<button type="button" data-a="top"><i class=fa-arrow-turn-up aria-hidden=true></i> Move to top level</button>`}
    <button type="button" data-a="copy"><i class=fa-clipboard aria-hidden=true></i> Copy as Markdown</button>
    <div class="docs-menu-meta muted small">Created by ${esc(d.created_by_name || "—")}<br>Last edit ${esc(d.updated_by_name || "—")} · ${ago(d.updated_at)}</div>
    ${canDelete(d) ? `<button type="button" data-a="del" class="danger"><i class=fa-trash aria-hidden=true></i> Delete page</button>` : ""}
  </div>`;
  menu.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => {
    menu.classList.add("hidden");
    const a = b.dataset.a;
    if (a === "child") createDoc(d.id);
    else if (a === "lock") {
      if (state.dirty) await save();
      const { error } = await db().from("team_docs").update({ locked: !d.locked }).eq("id", d.id);
      if (error) return ctx.toast(error.message, true);
      d.locked = !d.locked;
      ctx.logAction(d.locked ? "DOC_LOCKED" : "DOC_UNLOCKED", "team_docs", d.id, { title: d.title });
      renderNav(); renderPage();
    } else if (a === "top") {
      const { error } = await db().from("team_docs").update({ parent_id: null }).eq("id", d.id);
      if (error) return ctx.toast(error.message, true);
      d.parent_id = null; renderNav(); renderPage();
    } else if (a === "copy") {
      if (state.dirty) await save();
      try { await navigator.clipboard.writeText(toMarkdown(d)); ctx.toast("Copied as Markdown."); } catch { ctx.toast("Couldn't copy to clipboard.", true); }
    } else if (a === "del") deleteDoc(d);
  });
  placePopover(menu, anchor);
}

function toMarkdown(d) {
  const inline = html => {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    const walk = n => [...n.childNodes].map(c => {
      if (c.nodeType === 3) return c.nodeValue;
      const inner = walk(c);
      return { B: `**${inner}**`, I: `*${inner}*`, S: `~~${inner}~~`, CODE: "`" + inner + "`", BR: "\n", A: `[${inner}](${c.getAttribute?.("href")})` }[c.tagName] ?? inner;
    }).join("");
    return walk(div);
  };
  let n = 0;
  const lines = (d.blocks || []).map(b => {
    n = b.type === "ol" ? n + 1 : 0;
    const t = inline(b.html);
    return { p: t, h1: `# ${t}`, h2: `## ${t}`, h3: `### ${t}`, ul: `- ${t}`, ol: `${n}. ${t}`, todo: `- [${b.checked ? "x" : " "}] ${t}`, quote: `> ${t}`, callout: `> 💡 ${t}`, code: "```\n" + (b.text || "") + "\n```", divider: "---" }[b.type] ?? t;
  });
  return `# ${d.icon ? d.icon + " " : ""}${d.title || "Untitled"}\n\n${lines.join("\n\n")}\n`;
}

function iconPicker(anchor, d) {
  const menu = $("#docs-popover");
  menu.innerHTML = `<div class="docs-emoji">${EMOJI.map(e => `<button type="button" data-e="${e}">${e}</button>`).join("")}</div>
    <button type="button" class="textbtn" data-e="">Remove icon</button>`;
  menu.querySelectorAll("[data-e]").forEach(b => b.onclick = () => {
    menu.classList.add("hidden");
    d.icon = b.dataset.e;
    $("#docs-icon").textContent = d.icon || "📄";
    markDirty(true);
    renderNav();
  });
  placePopover(menu, anchor);
}

/* ---------- floating UI: slash menu, popover, selection toolbar ---------- */
function ensureFloating() {
  if ($("#docs-slash")) return;
  const slashEl = document.createElement("div");
  slashEl.id = "docs-slash";
  slashEl.className = "docs-slash hidden";
  const pop = document.createElement("div");
  pop.id = "docs-popover";
  pop.className = "ss-popover docs-popover hidden";
  const bar = document.createElement("div");
  bar.id = "docs-format";
  bar.className = "docs-format hidden";
  bar.innerHTML = [["bold", "<b>B</b>", "Bold (Ctrl+B)"], ["italic", "<i>I</i>", "Italic (Ctrl+I)"], ["underline", "<u>U</u>", "Underline (Ctrl+U)"], ["strikeThrough", "<s>S</s>", "Strikethrough"], ["code", "&lt;/&gt;", "Inline code (Ctrl+E)"], ["link", `<i class=fa-link aria-hidden=true></i>`, "Link (Ctrl+K)"]]
    .map(([c, l, title]) => `<button type="button" data-fmt="${c}" title="${title}" aria-label="${title}">${l}</button>`).join("");
  document.body.append(slashEl, pop, bar);
  bar.addEventListener("mousedown", e => e.preventDefault());
  bar.addEventListener("click", e => {
    const b = e.target.closest("[data-fmt]");
    if (!b) return;
    const c = b.dataset.fmt;
    if (c === "link") addLink();
    else if (c === "code") wrapInline("code");
    else { document.execCommand(c); markDirty(); }
  });
  document.addEventListener("click", e => {
    if (!pop.contains(e.target)) pop.classList.add("hidden");
    if (!slashEl.contains(e.target) && !e.target.closest?.(".db-plus")) closeSlash();
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") pop.classList.add("hidden"); });
  document.addEventListener("selectionchange", () => {
    const sel = getSelection();
    const t = sel.rangeCount && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest(".db-text[contenteditable]");
    if (!t || sel.isCollapsed || blockOf(t).dataset.type === "code") { bar.classList.add("hidden"); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    bar.classList.remove("hidden");
    bar.style.left = Math.min(window.innerWidth - bar.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - bar.offsetWidth / 2)) + "px";
    bar.style.top = Math.max(8, r.top - bar.offsetHeight - 8) + "px";
  });
}

function placePopover(el, anchor) {
  el.classList.remove("hidden");
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = Math.min(window.innerWidth - w - 12, Math.max(12, r.left)) + "px";
  el.style.top = (r.bottom + h + 12 > window.innerHeight ? Math.max(12, r.top - h - 6) : r.bottom + 6) + "px";
}
