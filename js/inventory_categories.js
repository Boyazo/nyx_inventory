/* Inventory categories: admin-created, each a "part" type or a "tool" type.
 * Items keep their category as text; the inventory is grouped Parts → Tools, then by category.
 * Falls back to the original four part categories until the inventory_categories table exists. */

const DEFAULTS = [
  { name: "Mechanical", kind: "part", sort: 10 }, { name: "Electrical", kind: "part", sort: 20 },
  { name: "Software", kind: "part", sort: 30 }, { name: "Miscellaneous", kind: "part", sort: 40 },
];
export const OTHER_TOOLS = "Other tools";

let ctx = null;
let cats = DEFAULTS.slice();
let tableReady = false;

const $ = s => document.querySelector(s);

export function initInventoryCategories(context) {
  ctx = context;
  $("#manage-categories-btn")?.addEventListener("click", openManager);
  $("#close-categories-modal")?.addEventListener("click", () => $("#categories-modal").classList.add("hidden"));
}

export async function loadInventoryCategories() {
  const { data, error } = await ctx.getClient().from("inventory_categories").select("*").order("sort");
  tableReady = !error;
  cats = !error && data?.length ? data : DEFAULTS.slice();
  return cats;
}

export const categories = () => cats;
export const partCategories = () => cats.filter(c => c.kind === "part");
export const toolCategories = () => cats.filter(c => c.kind === "tool");
export const kindOf = name => cats.find(c => c.name === name)?.kind || null;
export const isToolItem = x => !!x.is_tool || kindOf(x.category) === "tool";

/* Section + group an item belongs to, and a sort key that keeps groups in category order */
export function groupOf(x) {
  const tool = isToolItem(x);
  const known = cats.find(c => c.name === x.category);
  const name = tool ? (known?.kind === "tool" ? known.name : OTHER_TOOLS) : (known ? known.name : (x.category || "Uncategorized"));
  const order = tool ? (known?.kind === "tool" ? known.sort : 9999) : (known ? known.sort : 9998);
  return { section: tool ? "Tools" : "Parts", name, key: `${tool ? 1 : 0}-${String(order).padStart(5, "0")}-${name}` };
}

/* Filter tabs: All · each part category · All tools · each tool category */
export function renderFilterTabs(host, items, active) {
  const count = pred => items.filter(pred).length;
  const tab = (value, label, n, icon = "") =>
    `<button class="catbtn ${active === value ? "active" : ""}" data-category="${ctx.esc(value)}" type="button">${icon}${ctx.esc(label)} <span>${n}</span></button>`;
  const parts = partCategories().map(c => tab(c.name, c.name, count(x => !isToolItem(x) && x.category === c.name)));
  const tools = toolCategories().map(c => tab(c.name, c.name, count(x => isToolItem(x) && x.category === c.name)));
  const otherTools = count(x => isToolItem(x) && kindOf(x.category) !== "tool");
  host.innerHTML = [
    tab("All", "All", items.length),
    ...parts,
    `<span class="cat-divider" aria-hidden="true"></span>`,
    tab("ToolsOnly", "All tools", count(isToolItem), `<i class=fa-screwdriver-wrench aria-hidden=true></i> `),
    ...tools,
    otherTools ? tab(OTHER_TOOLS, OTHER_TOOLS, otherTools) : "",
  ].join("");
}

export function matchesFilter(x, active) {
  if (active === "All") return true;
  if (active === "ToolsOnly") return isToolItem(x);
  if (active === OTHER_TOOLS) return isToolItem(x) && kindOf(x.category) !== "tool";
  return x.category === active && (kindOf(active) === "tool" ? isToolItem(x) : !isToolItem(x));
}

/* Category <select> in the item form, grouped Parts / Tools */
export function fillCategorySelect(select, current) {
  const opt = c => `<option value="${ctx.esc(c.name)}" data-kind="${c.kind}">${ctx.esc(c.name)}</option>`;
  const parts = partCategories(), tools = toolCategories();
  const extra = current && !cats.some(c => c.name === current) ? `<option value="${ctx.esc(current)}">${ctx.esc(current)}</option>` : "";
  select.innerHTML = `${extra}<optgroup label="Parts">${parts.map(opt).join("")}</optgroup>${tools.length ? `<optgroup label="Tools">${tools.map(opt).join("")}</optgroup>` : ""}`;
  if (current) select.value = current;
}

export const isValidCategory = name => cats.some(c => c.name === name);

/* ---------- admin manager ---------- */
function openManager() {
  if (!ctx.getProfile()?.is_admin) return;
  renderManager();
  $("#categories-modal").classList.remove("hidden");
}

function renderManager() {
  const host = $("#categories-body");
  const items = ctx.getItems();
  const used = name => items.filter(x => x.category === name).length;
  const row = c => `
    <div class="cat-row">
      <input value="${ctx.esc(c.name)}" data-cat-rename="${ctx.esc(c.name)}" aria-label="Category name" maxlength="40">
      <span class="muted small">${used(c.name)} item${used(c.name) === 1 ? "" : "s"}</span>
      <button type="button" class="actionbtn delete" data-cat-delete="${ctx.esc(c.name)}" aria-label="Delete ${ctx.esc(c.name)}"><i class=fa-trash-can aria-hidden=true></i></button>
    </div>`;
  host.innerHTML = `
    ${tableReady ? "" : `<div class="scout-card scout-warn-box" style="margin:0 0 12px;">Custom categories start working once the database update (schema.sql) is applied.</div>`}
    <h4>Part categories</h4>
    ${partCategories().map(row).join("")}
    <h4>Tool categories</h4>
    ${toolCategories().map(row).join("") || `<p class="muted small">No tool categories yet.</p>`}
    <form id="cat-add-form" class="cat-add">
      <input id="cat-add-name" placeholder="New category, e.g. Pneumatics or Power Tools" maxlength="40" required>
      <select id="cat-add-kind" aria-label="Category type"><option value="part">Part</option><option value="tool">Tool</option></select>
      <button type="submit" class="btn btn--primary">Add</button>
    </form>
    <p class="muted small">Renaming moves every item in that category along with it. A category with items can't be deleted — move its items first.</p>`;

  host.querySelector("#cat-add-form").onsubmit = async e => {
    e.preventDefault();
    const name = $("#cat-add-name").value.trim();
    const kind = $("#cat-add-kind").value;
    if (!name) return;
    if (cats.some(c => c.name.toLowerCase() === name.toLowerCase())) return ctx.toast("That category already exists.", true);
    const sort = Math.max(0, ...cats.map(c => c.sort)) + 10;   // parts and tools are grouped separately, so "last" is enough
    const { error } = await ctx.getClient().from("inventory_categories").insert({ name, kind, sort });
    if (error) return ctx.toast("Couldn't add category: " + error.message, true);
    ctx.logAction("INVENTORY_CATEGORY_ADDED", "inventory_categories", null, { name, kind });
    await refresh();
  };
  host.querySelectorAll("[data-cat-rename]").forEach(input => input.onchange = async () => {
    const from = input.dataset.catRename, to = input.value.trim();
    if (!to || to === from) { input.value = from; return; }
    if (cats.some(c => c.name.toLowerCase() === to.toLowerCase())) { input.value = from; return ctx.toast("That name is already used.", true); }
    const { error } = await ctx.getClient().from("inventory_categories").update({ name: to }).eq("name", from);
    if (error) { input.value = from; return ctx.toast("Couldn't rename: " + error.message, true); }
    const moved = await ctx.getClient().from("inventory_items").update({ category: to }).eq("category", from);
    if (moved.error) ctx.toast("Renamed, but some items didn't move: " + moved.error.message, true);
    ctx.logAction("INVENTORY_CATEGORY_RENAMED", "inventory_categories", null, { from, to });
    await refresh();
  });
  host.querySelectorAll("[data-cat-delete]").forEach(b => b.onclick = async () => {
    const name = b.dataset.catDelete;
    if (used(name)) return ctx.toast(`Move the ${used(name)} item(s) in ${name} to another category first.`, true);
    if (!confirm(`Delete the ${name} category?`)) return;
    const { error } = await ctx.getClient().from("inventory_categories").delete().eq("name", name);
    if (error) return ctx.toast("Couldn't delete: " + error.message, true);
    ctx.logAction("INVENTORY_CATEGORY_DELETED", "inventory_categories", null, { name });
    await refresh();
  });
}

async function refresh() {
  await loadInventoryCategories();
  await ctx.reloadItems();
  renderManager();
}
