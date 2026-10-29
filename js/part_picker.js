/* Searchable part picker attached to a text input.
 * Lists, in order: items already in our inventory, the team's quick-fill presets, and every COTS part
 * from the FRCDesign library. The input stays free text; picking a row calls onPick(entry). */
import { COTS_PARTS, COTS_CATEGORIES, ELECTRICAL_CATEGORIES, VENDORS, TEAM_PRESETS } from "./parts_catalog.js?v=20261028m";

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9#./]+/g, " ").trim();

const cots = COTS_PARTS.map(([name, cat, vendors]) => {
  const category = COTS_CATEGORIES[cat];
  const vendorNames = vendors.map(v => VENDORS[v]?.[0] || v);
  return {
    type: "cots", name, category, vendors, vendorNames,
    appCategory: ELECTRICAL_CATEGORIES.has(category) ? "Electrical" : "Mechanical",
    haystack: norm(`${name} ${category} ${vendors.join(" ")} ${vendorNames.join(" ")}`),
  };
});
const presets = TEAM_PRESETS.map(p => ({
  type: "preset", name: p.name, category: p.group, preset: p,
  haystack: norm(`${p.name} ${p.pn} ${p.notes} ${p.group}`),
}));

export function vendorLinks(codes) {
  return codes.map(c => VENDORS[c]).filter(v => v && v[1]);
}

// Every typed token must match the start of some word ("neo" finds "NEO 550", not "miscellaneous")
function matches(haystack, tokens) {
  if (!tokens.length) return true;
  const words = haystack.split(" ");
  return tokens.every(t => words.some(w => w.startsWith(t)));
}

export function attachPartPicker(input, { getInventory, onPick }) {
  const wrap = document.createElement("div");
  wrap.className = "part-picker";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");

  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "part-picker-browse";
  browse.textContent = "Browse ▾";
  browse.setAttribute("aria-label", "Browse parts");
  wrap.appendChild(browse);

  const panel = document.createElement("div");
  panel.className = "part-picker-panel hidden";
  panel.setAttribute("role", "listbox");
  wrap.appendChild(panel);

  let rows = [];
  let active = -1;

  function build() {
    const tokens = norm(input.value).split(" ").filter(Boolean);
    const inv = (getInventory() || []).map(i => ({
      type: "inventory", name: i.name, item: i,
      haystack: norm(`${i.name} ${i.part_number} ${i.location} ${i.category}`),
    })).filter(r => matches(r.haystack, tokens));
    const pre = presets.filter(r => matches(r.haystack, tokens));
    const lib = cots.filter(r => matches(r.haystack, tokens));
    const limit = tokens.length ? 150 : 600;

    rows = [];
    let html = "";
    const section = (title, list, cap, renderMeta) => {
      if (!list.length) return;
      html += `<div class="pp-section">${esc(title)} <span>${list.length}</span></div>`;
      let lastCat = null;
      for (const r of list.slice(0, cap)) {
        if (r.type === "cots" && r.category !== lastCat) {
          lastCat = r.category;
          html += `<div class="pp-subhead">${esc(r.category)}</div>`;
        }
        const idx = rows.push(r) - 1;
        html += `<div class="pp-row" role="option" data-idx="${idx}">
          <span class="pp-name">${esc(r.name)}</span>
          <span class="pp-meta">${renderMeta(r)}</span>
        </div>`;
      }
      if (list.length > cap) html += `<div class="pp-more">${list.length - cap} more — keep typing to narrow down</div>`;
    };

    section("In our inventory", inv, tokens.length ? 20 : 60, r => {
      const low = r.item.quantity <= (r.item.min_quantity ?? 0);
      return `<b class="${low ? "pp-low" : "pp-ok"}">${esc(r.item.quantity)} ${esc(r.item.unit || "pcs")}</b>${r.item.location ? ` · ${esc(r.item.location)}` : ""}`;
    });
    section("Team presets", pre, tokens.length ? 12 : 60, r => esc(r.preset.pn || r.category));
    section("FRCDesign COTS library", lib, limit, r =>
      r.vendors.length ? r.vendors.map(v => `<span class="pp-vendor" title="${esc(VENDORS[v]?.[0] || v)}">${esc(v)}</span>`).join("") : `<span class="pp-vendor pp-vendor--none">Vendor unlisted</span>`);

    if (!rows.length) html = `<div class="pp-empty">No matching parts — you can still type a custom name.</div>`;
    panel.innerHTML = html;
    active = -1;
  }

  function open() {
    build();
    panel.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  }
  function close() {
    panel.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
    active = -1;
  }
  function highlight(i) {
    const els = panel.querySelectorAll(".pp-row");
    els.forEach(el => el.classList.remove("is-active"));
    active = Math.max(0, Math.min(i, els.length - 1));
    els[active]?.classList.add("is-active");
    els[active]?.scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    const r = rows[i];
    if (!r) return;
    close();
    onPick(r);
  }

  input.addEventListener("input", open);
  input.addEventListener("click", open);
  browse.addEventListener("click", () => {
    if (panel.classList.contains("hidden")) { open(); input.focus(); } else close();
  });
  input.addEventListener("keydown", e => {
    if (panel.classList.contains("hidden") && (e.key === "ArrowDown" || e.key === "ArrowUp")) { open(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") { highlight(active + 1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { highlight(active - 1); e.preventDefault(); }
    else if (e.key === "Enter" && active >= 0 && !panel.classList.contains("hidden")) { choose(active); e.preventDefault(); }
    else if (e.key === "Escape" && !panel.classList.contains("hidden")) { close(); e.stopPropagation(); }
  });
  // mousedown (not click) so the input doesn't blur and close the panel first
  panel.addEventListener("mousedown", e => {
    const row = e.target.closest(".pp-row");
    e.preventDefault();
    if (row) choose(Number(row.dataset.idx));
  });
  document.addEventListener("pointerdown", e => { if (!wrap.contains(e.target)) close(); });

  return { open, close };
}
