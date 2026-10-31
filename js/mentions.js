/* @mentions for plain inputs and textareas, Slack/Discord style: type "@" and pick a teammate.
 * Text keeps "@Full Name"; renderMentions() turns known names into chips for display. */

let menu = null;
const active = { el: null, items: [], index: 0, start: 0 };

function ensureMenu() {
  if (menu) return menu;
  menu = document.createElement("div");
  menu.className = "mention-menu hidden";
  menu.setAttribute("role", "listbox");
  document.body.appendChild(menu);
  menu.addEventListener("mousedown", e => e.preventDefault());
  menu.addEventListener("click", e => {
    const b = e.target.closest("[data-i]");
    if (b) { active.index = Number(b.dataset.i); pick(); }
  });
  window.addEventListener("resize", close);
  return menu;
}

function close() {
  active.el = null;
  menu?.classList.add("hidden");
}

/* Names whose first letters of any word match the query ("@jo" finds "Joshua Lee" and "Ana Jones") */
export function matchNames(names, q) {
  const s = q.toLowerCase();
  return names.filter(n => !s || n.toLowerCase().startsWith(s) || n.toLowerCase().split(/\s+/).some(w => w.startsWith(s))).slice(0, 8);
}

const initials = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const escHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function showMentionMenu(items, rect, onPick, index = 0) {
  const m = ensureMenu();
  active.items = items;
  active.index = Math.min(index, items.length - 1);
  active.onPick = onPick;
  m.innerHTML = `<div class="docs-menu-title">People</div>` + items.map((n, i) => `<button type="button" class="${i === active.index ? "active" : ""}" data-i="${i}">
    <span class="bd-avatar">${escHtml(initials(n))}</span><span>${escHtml(n)}</span></button>`).join("");
  m.classList.remove("hidden");
  const h = m.offsetHeight;
  m.style.left = Math.min(window.innerWidth - m.offsetWidth - 12, Math.max(12, rect.left)) + "px";
  m.style.top = (rect.bottom + h + 12 > window.innerHeight ? Math.max(12, rect.top - h - 6) : rect.bottom + 6) + "px";
}
export function hideMentionMenu() { close(); }
export function mentionMenuOpen() { return !!menu && !menu.classList.contains("hidden"); }

/* Arrow/Enter/Tab/Escape while the menu is open; returns true when the key was used */
export function mentionKey(e) {
  if (!mentionMenuOpen()) return false;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    active.index = (active.index + (e.key === "ArrowDown" ? 1 : -1) + active.items.length) % active.items.length;
    menu.querySelectorAll("[data-i]").forEach((b, i) => b.classList.toggle("active", i === active.index));
  } else if (e.key === "Enter" || e.key === "Tab") pick();
  else if (e.key === "Escape") close();
  else return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  return true;
}

function pick() {
  const name = active.items[active.index];
  const cb = active.onPick;
  close();
  if (name && cb) cb(name);
}

/* Attach to an <input> or <textarea>. onChange runs after a name is inserted. */
export function attachMentions(el, getNames, onChange) {
  el.addEventListener("keydown", mentionKey, true);
  el.addEventListener("blur", () => setTimeout(() => { if (active.el === el) close(); }, 120));
  el.addEventListener("input", () => {
    const upto = el.value.slice(0, el.selectionStart);
    const m = upto.match(/(?:^|\s)@([\w.'-]{0,20})$/);
    const items = m ? matchNames(getNames(), m[1]) : [];
    if (!items.length) { if (active.el === el) close(); return; }
    active.el = el;
    active.start = el.selectionStart - m[1].length - 1;
    const r = el.getBoundingClientRect();
    showMentionMenu(items, { left: r.left, top: r.top, bottom: r.bottom }, name => {
      const before = el.value.slice(0, active.start);
      const after = el.value.slice(el.selectionStart).replace(/^[\w.'-]*/, "");
      const insert = `@${name} `;
      el.value = before + insert + after.replace(/^\s/, "");
      const pos = before.length + insert.length;
      el.focus();
      el.setSelectionRange(pos, pos);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      onChange?.(name);
    }, 0);
  });
}

/* Names from the roster that appear as @mentions in the text */
export function mentionedNames(text, names) {
  return names.filter(n => (text || "").includes("@" + n));
}

/* Wrap @Full Name (already HTML-escaped text) in chips; longest names first so "@Ana Jo" doesn't eat "@Ana Jones" */
export function renderMentions(html, names) {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const marks = [];
  sorted.forEach(n => {
    const needle = "@" + escHtml(n);
    html = html.split(needle).join(`\u0000${marks.push(n) - 1}\u0000`);
  });
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => `<span class="mention">@${escHtml(marks[i])}</span>`);
}
