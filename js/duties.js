/* Competition sign-ups: members mark which roles they want in each time block (pit crew, scouting,
 * drive team, …); admins assign people from one central grid. Separate from build shifts and
 * from per-match scout assignments. Tables: duty_roles, duty_blocks, duty_prefs, duty_assignments. */

let ctx = null;
const state = { roles: [], blocks: [], prefs: [], assigns: [], members: [], tab: "mine", openCell: null, assignView: "grid", missing: false };

const $ = s => document.querySelector(s);
const esc = v => ctx.esc(v);
const db = () => ctx.getClient();
const me = () => ctx.getUser();
const isAdmin = () => !!(ctx.getProfile()?.is_admin || ctx.getProfile()?.is_moderator);   // admins and moderators
const myName = () => ctx.getProfile()?.full_name || me()?.email || "Member";

const pref = (uid, roleId, blockId) => state.prefs.find(p => p.user_id === uid && p.role_id === roleId && p.block_id === blockId)?.level || "";
const assignedIn = (roleId, blockId) => state.assigns.filter(a => a.role_id === roleId && a.block_id === blockId);
const assignmentOf = (uid, blockId) => state.assigns.find(a => a.user_id === uid && a.block_id === blockId);
const roleName = id => state.roles.find(r => r.id === id)?.name || "";
const blockLabel = id => state.blocks.find(b => b.id === id)?.label || "";
const loadOf = uid => state.assigns.filter(a => a.user_id === uid).length;

let started = false;
export function initDuties(context) {
  ctx = context;
  if (started) return render();
  started = true;
  $("#duties-tabs")?.addEventListener("click", e => {
    const b = e.target.closest("[data-duty-tab]");
    if (!b) return;
    state.tab = b.dataset.dutyTab;
    render();
  });
  ensureModal();
  load();
  try {
    let ch = db().channel("nyx-duties");
    ["duty_roles", "duty_blocks", "duty_prefs", "duty_assignments"].forEach(t => {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t }, () => { clearTimeout(state.t); state.t = setTimeout(load, 300); });
    });
    ch.subscribe();
  } catch { /* realtime optional */ }
}

async function load() {
  const [r, b, p, a, m] = await Promise.all([
    db().from("duty_roles").select("*").order("sort"),
    db().from("duty_blocks").select("*").order("sort"),
    db().from("duty_prefs").select("*"),
    db().from("duty_assignments").select("*"),
    db().from("profiles").select("id, full_name, departments").eq("is_approved", true),
  ]);
  state.missing = !!r.error && /relation|does not exist|schema cache/i.test(r.error.message);
  state.roles = r.data || [];
  state.blocks = b.data || [];
  state.prefs = p.data || [];
  state.assigns = a.data || [];
  state.members = (m.data || []).sort((x, y) => x.full_name.localeCompare(y.full_name));
  render();
}

function render() {
  const host = $("#duties-body");
  if (!host) return;
  document.querySelectorAll("#duties-tabs [data-duty-tab]").forEach(b => {
    if (b.dataset.admin !== undefined) b.hidden = !isAdmin();
    b.classList.toggle("active", b.dataset.dutyTab === state.tab);
  });
  if (!isAdmin() && state.tab !== "mine") state.tab = "mine";
  if (state.missing) {
    host.innerHTML = `<div class="scout-card scout-warn-box">Sign-up tables aren't in the database yet — an admin needs to run <code>supabase/schema.sql</code>.</div>`;
    return;
  }
  if (!state.roles.length || !state.blocks.length) {
    host.innerHTML = `<div class="scout-card scout-picker-empty" style="margin:20px;">No roles or time blocks yet. ${isAdmin() ? "Add them under <b>Setup</b>." : "An admin needs to set them up."}</div>`;
    if (state.tab === "setup") renderSetup(host);
    return;
  }
  if (state.tab === "assign") renderAssign(host);
  else if (state.tab === "setup") renderSetup(host);
  else renderMine(host);
}

/* ---------- member view ---------- */

function renderMine(host) {
  const uid = me()?.id;
  const mine = state.assigns.filter(a => a.user_id === uid).sort((x, y) => blockSort(x.block_id) - blockSort(y.block_id));
  const counts = { want: 0, can: 0 };
  state.prefs.filter(p => p.user_id === uid).forEach(p => counts[p.level]++);
  host.innerHTML = `
    <div class="duty-mine-head">
      <div class="scout-card duty-assigned">
        <div class="scout-phase-title"><span>My assignments</span></div>
        ${mine.length ? mine.map(a => `<div class="duty-assign-row"><b>${esc(blockLabel(a.block_id))}</b><span>${esc(roleName(a.role_id))}</span></div>`).join("")
          : `<p class="muted small" style="margin:0;">Nothing assigned yet. Mark what you'd like below and an admin will place you.</p>`}
      </div>
      <div class="duty-legend">
        <span><i class="duty-dot want"></i>★ Want — I'd like this</span>
        <span><i class="duty-dot can"></i>✓ Can — happy to if needed</span>
        <span class="muted">Tap a cell to cycle. ${counts.want} wants · ${counts.can} cans</span>
      </div>
    </div>
    ${gridHtml((role, block) => {
      const lvl = pref(uid, role.id, block.id);
      const a = assignmentOf(uid, block.id);
      const here = a && a.role_id === role.id;
      return `<button type="button" class="duty-cell ${lvl} ${here ? "is-assigned" : ""}" data-pref-role="${role.id}" data-pref-block="${block.id}" aria-label="${esc(role.name)} ${esc(block.label)}: ${here ? "assigned" : lvl || "not selected"}">
        ${here ? "Assigned" : lvl === "want" ? "★ Want" : lvl === "can" ? "✓ Can" : ""}
      </button>`;
    })}`;
  host.querySelectorAll("[data-pref-role]").forEach(b => b.onclick = () => cyclePref(b.dataset.prefRole, b.dataset.prefBlock));
}

async function cyclePref(roleId, blockId) {
  const uid = me().id;
  const cur = pref(uid, roleId, blockId);
  const next = cur === "" ? "want" : cur === "want" ? "can" : "";
  // optimistic
  state.prefs = state.prefs.filter(p => !(p.user_id === uid && p.role_id === roleId && p.block_id === blockId));
  if (next) state.prefs.push({ user_id: uid, role_id: roleId, block_id: blockId, level: next, user_name: myName() });
  render();
  const res = next
    ? await db().from("duty_prefs").upsert({ user_id: uid, role_id: roleId, block_id: blockId, level: next, user_name: myName(), updated_at: new Date().toISOString() })
    : await db().from("duty_prefs").delete().eq("user_id", uid).eq("role_id", roleId).eq("block_id", blockId);
  if (res.error) { ctx.toast("Couldn't save: " + res.error.message, true); load(); }
}

/* ---------- shared grid ---------- */

const blockSort = id => state.blocks.findIndex(b => b.id === id);
function gridHtml(cell) {
  return `<div class="duty-grid-wrap"><table class="duty-grid">
    <thead><tr><th>Role</th>${state.blocks.map(b => `<th>${esc(b.label)}</th>`).join("")}</tr></thead>
    <tbody>${state.roles.map(r => `<tr>
      <th><span class="duty-role">${esc(r.name)}</span>${r.description ? `<span class="duty-desc">${esc(r.description)}</span>` : ""}</th>
      ${state.blocks.map(b => `<td>${cell(r, b)}</td>`).join("")}
    </tr>`).join("")}</tbody>
  </table></div>`;
}

/* ---------- admin: central assignment ---------- */

function renderAssign(host) {
  const filled = state.roles.reduce((n, r) => n + state.blocks.reduce((m, b) => m + Math.min(r.capacity, assignedIn(r.id, b.id).length), 0), 0);
  const needed = state.roles.reduce((n, r) => n + r.capacity * state.blocks.length, 0);
  const responded = new Set(state.prefs.map(p => p.user_id)).size;
  host.innerHTML = `
    <div class="scout-pane-head" style="padding-left:0; padding-right:0;">
      <div><h3 style="margin:0;">Assign roles</h3><span class="muted small">${filled}/${needed} slots filled · ${responded} of ${state.members.length} members have signed up</span></div>
      <div class="picks-actions">
        <div class="duty-toggle">
          <button type="button" class="${state.assignView === "grid" ? "active" : ""}" data-assign-view="grid">By role</button>
          <button type="button" class="${state.assignView === "people" ? "active" : ""}" data-assign-view="people">By person</button>
        </div>
        <button type="button" class="btn btn--primary btn--sm" id="duty-autofill">Auto-fill open slots</button>
        <button type="button" class="btn btn--ghost btn--sm" id="duty-clear">Clear all</button>
      </div>
    </div>
    ${state.assignView === "people" ? peopleHtml() : gridHtml((role, block) => {
      const got = assignedIn(role.id, block.id);
      const want = state.members.filter(m => pref(m.id, role.id, block.id) === "want").length;
      const can = state.members.filter(m => pref(m.id, role.id, block.id) === "can").length;
      const full = got.length >= role.capacity;
      return `<button type="button" class="duty-cell admin ${full ? "is-full" : got.length ? "is-partial" : ""}" data-open-role="${role.id}" data-open-block="${block.id}">
        <span class="duty-cap">${got.length}/${role.capacity}</span>
        <span class="duty-names">${got.map(a => esc(a.user_name.split(" ")[0])).join(", ")}</span>
        <span class="duty-interest">★${want} ✓${can}</span>
      </button>`;
    })}`;
  host.querySelectorAll("[data-assign-view]").forEach(b => b.onclick = () => { state.assignView = b.dataset.assignView; render(); });
  host.querySelectorAll("[data-open-role]").forEach(b => b.onclick = () => openCell(b.dataset.openRole, b.dataset.openBlock));
  $("#duty-autofill").onclick = autoFill;
  $("#duty-clear").onclick = async () => {
    if (!confirm("Remove every role assignment?")) return;
    const { error } = await db().from("duty_assignments").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) return ctx.toast(error.message, true);
    await load();
  };
}

function peopleHtml() {
  return `<div class="duty-grid-wrap"><table class="duty-grid">
    <thead><tr><th>Member</th>${state.blocks.map(b => `<th>${esc(b.label)}</th>`).join("")}<th>Total</th></tr></thead>
    <tbody>${state.members.map(m => `<tr>
      <th><span class="duty-role">${esc(m.full_name)}</span>${state.prefs.some(p => p.user_id === m.id) ? "" : `<span class="duty-desc">hasn't signed up</span>`}</th>
      ${state.blocks.map(b => {
        const a = assignmentOf(m.id, b.id);
        const wants = state.roles.filter(r => pref(m.id, r.id, b.id) === "want").map(r => r.name);
        return `<td><div class="duty-person-cell ${a ? "is-assigned" : ""}">${a ? esc(roleName(a.role_id)) : wants.length ? `<span class="muted">★ ${esc(wants.join(", "))}</span>` : ""}</div></td>`;
      }).join("")}
      <td><b>${loadOf(m.id)}</b></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function openCell(roleId, blockId) {
  const role = state.roles.find(r => r.id === roleId);
  const block = state.blocks.find(b => b.id === blockId);
  const got = assignedIn(roleId, blockId);
  const rank = m => {
    const lvl = pref(m.id, roleId, blockId);
    return (lvl === "want" ? 0 : lvl === "can" ? 1 : 2) * 1000 + loadOf(m.id);
  };
  const candidates = state.members.filter(m => !got.some(a => a.user_id === m.id)).sort((a, b) => rank(a) - rank(b) || a.full_name.localeCompare(b.full_name));
  const row = m => {
    const lvl = pref(m.id, roleId, blockId);
    const other = assignmentOf(m.id, blockId);
    return `<div class="duty-cand">
      <span><b>${esc(m.full_name)}</b> ${lvl === "want" ? '<span class="duty-tag want">★ Wants</span>' : lvl === "can" ? '<span class="duty-tag can">✓ Can</span>' : ""}
        <span class="muted small">${loadOf(m.id)} assigned${other ? ` · now ${esc(roleName(other.role_id))} this block` : ""}</span></span>
      <button type="button" class="btn btn--ghost btn--sm" data-add-user="${m.id}">${other ? "Move here" : "Assign"}</button>
    </div>`;
  };
  openModal(`${role.name} · ${block.label}`, `${got.length} of ${role.capacity} assigned`, `
    <h4>Assigned</h4>
    ${got.length ? got.map(a => `<div class="duty-cand"><span><b>${esc(a.user_name)}</b> <span class="muted small">by ${esc(a.assigned_by_name || "admin")}</span></span><button type="button" class="btn btn--danger btn--sm" data-remove-assign="${a.id}">Remove</button></div>`).join("") : `<p class="muted small">No one yet.</p>`}
    <h4>Candidates</h4>
    <div class="duty-cands">${candidates.map(row).join("") || `<p class="muted small">Everyone is assigned.</p>`}</div>`);
  document.querySelectorAll("[data-add-user]").forEach(b => b.onclick = async () => {
    await assign(roleId, blockId, b.dataset.addUser);
    openCell(roleId, blockId);
  });
  document.querySelectorAll("[data-remove-assign]").forEach(b => b.onclick = async () => {
    const { error } = await db().from("duty_assignments").delete().eq("id", b.dataset.removeAssign);
    if (error) return ctx.toast(error.message, true);
    await load();
    openCell(roleId, blockId);
  });
}

async function assign(roleId, blockId, uid, quiet) {
  const m = state.members.find(x => x.id === uid);
  await db().from("duty_assignments").delete().eq("block_id", blockId).eq("user_id", uid); // one role per block
  const { error } = await db().from("duty_assignments").insert({ role_id: roleId, block_id: blockId, user_id: uid, user_name: m?.full_name || "", assigned_by_name: myName() });
  if (error) { ctx.toast("Couldn't assign: " + error.message, true); return false; }
  if (!quiet) {
    ctx.logAction("DUTY_ASSIGNED", "duty_assignments", null, { member_name: m?.full_name, role: roleName(roleId), block: blockLabel(blockId) });
    await load();
  }
  return true;
}

/* Fill each open slot with people who want it, then people who can, least-loaded first; never double-book a block */
async function autoFill() {
  const plan = [];
  const taken = new Set(state.assigns.map(a => `${a.block_id}:${a.user_id}`));
  const counts = new Map(state.members.map(m => [m.id, loadOf(m.id)]));
  for (const b of state.blocks) {
    for (const level of ["want", "can"]) {
      for (const r of state.roles) {
        let open = r.capacity - assignedIn(r.id, b.id).length - plan.filter(p => p.role_id === r.id && p.block_id === b.id).length;
        if (open <= 0) continue;
        const pool = state.members
          .filter(m => pref(m.id, r.id, b.id) === level && !taken.has(`${b.id}:${m.id}`))
          .sort((x, y) => counts.get(x.id) - counts.get(y.id) || Math.random() - 0.5);
        for (const m of pool.slice(0, open)) {
          plan.push({ role_id: r.id, block_id: b.id, user_id: m.id, user_name: m.full_name, assigned_by_name: myName() });
          taken.add(`${b.id}:${m.id}`);
          counts.set(m.id, counts.get(m.id) + 1);
        }
      }
    }
  }
  if (!plan.length) return ctx.toast("Nothing to fill — open slots have no matching sign-ups.");
  if (!confirm(`Assign ${plan.length} people to open slots based on their sign-ups? Existing assignments stay.`)) return;
  const { error } = await db().from("duty_assignments").insert(plan);
  if (error) return ctx.toast("Auto-fill failed: " + error.message, true);
  ctx.logAction("DUTY_AUTOFILL", "duty_assignments", null, { count: plan.length });
  await load();
  ctx.toast(`Auto-filled ${plan.length} slots.`);
}

/* ---------- admin: setup ---------- */

function renderSetup(host) {
  host.innerHTML = `
    <div class="duty-setup">
      <div class="scout-card">
        <div class="scout-phase-title"><span>Roles</span></div>
        ${state.roles.map(r => `<div class="duty-setup-row">
          <input value="${esc(r.name)}" data-role-field="name" data-id="${r.id}" aria-label="Role name">
          <input value="${esc(r.description)}" data-role-field="description" data-id="${r.id}" placeholder="Description" aria-label="Description">
          <label class="assign-range">Need <input type="number" min="0" max="30" value="${r.capacity}" data-role-field="capacity" data-id="${r.id}" aria-label="People needed"></label>
          <button type="button" class="actionbtn delete" data-del-role="${r.id}" aria-label="Delete role">Delete</button>
        </div>`).join("")}
        <div class="duty-setup-row">
          <input id="new-role-name" placeholder="New role, e.g. Pit Runner">
          <button type="button" class="btn btn--primary btn--sm" id="add-role">Add role</button>
        </div>
      </div>
      <div class="scout-card">
        <div class="scout-phase-title"><span>Time blocks</span></div>
        ${state.blocks.map(b => `<div class="duty-setup-row">
          <input value="${esc(b.label)}" data-block-field="label" data-id="${b.id}" aria-label="Block label">
          <button type="button" class="actionbtn delete" data-del-block="${b.id}" aria-label="Delete block">Delete</button>
        </div>`).join("")}
        <div class="duty-setup-row">
          <input id="new-block-label" placeholder="e.g. Sat Morning, Practice Day">
          <button type="button" class="btn btn--primary btn--sm" id="add-block">Add block</button>
        </div>
        <p class="muted small">Deleting a role or block also removes its sign-ups and assignments.</p>
      </div>
    </div>`;
  host.querySelectorAll("[data-role-field]").forEach(i => i.onchange = () => saveField("duty_roles", i.dataset.id, i.dataset.roleField, i.dataset.roleField === "capacity" ? Number(i.value) || 0 : i.value.trim()));
  host.querySelectorAll("[data-block-field]").forEach(i => i.onchange = () => saveField("duty_blocks", i.dataset.id, "label", i.value.trim()));
  host.querySelectorAll("[data-del-role]").forEach(b => b.onclick = () => removeRow("duty_roles", b.dataset.delRole, roleName(b.dataset.delRole)));
  host.querySelectorAll("[data-del-block]").forEach(b => b.onclick = () => removeRow("duty_blocks", b.dataset.delBlock, blockLabel(b.dataset.delBlock)));
  $("#add-role").onclick = async () => {
    const name = $("#new-role-name").value.trim();
    if (!name) return;
    const { error } = await db().from("duty_roles").insert({ name, capacity: 2, sort: (state.roles.at(-1)?.sort || 0) + 10 });
    if (error) return ctx.toast(error.message, true);
    await load();
  };
  $("#add-block").onclick = async () => {
    const label = $("#new-block-label").value.trim();
    if (!label) return;
    const { error } = await db().from("duty_blocks").insert({ label, sort: (state.blocks.at(-1)?.sort || 0) + 10 });
    if (error) return ctx.toast(error.message, true);
    await load();
  };
}

async function saveField(table, id, field, value) {
  if (field !== "description" && field !== "capacity" && !value) return render();
  const { error } = await db().from(table).update({ [field]: value }).eq("id", id);
  if (error) { ctx.toast(error.message, true); return load(); }
  ctx.toast("Saved.");
  await load();
}
async function removeRow(table, id, label) {
  if (!confirm(`Delete “${label}”? Its sign-ups and assignments are removed too.`)) return;
  const { error } = await db().from(table).delete().eq("id", id);
  if (error) return ctx.toast(error.message, true);
  await load();
}

/* ---------- modal ---------- */

function ensureModal() {
  if ($("#duty-modal")) return;
  const el = document.createElement("div");
  el.id = "duty-modal";
  el.className = "modalback hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `<div class="modal" style="max-width:560px;">
    <div class="modalhead"><div><h2 id="duty-modal-title"></h2><p class="muted small" id="duty-modal-sub"></p></div>
    <button class="close" type="button" data-close aria-label="Close">×</button></div>
    <div id="duty-modal-body"></div></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", e => { if (e.target === el || e.target.closest("[data-close]")) { el.classList.add("hidden"); render(); } });
}
function openModal(title, sub, html) {
  $("#duty-modal-title").textContent = title;
  $("#duty-modal-sub").textContent = sub;
  $("#duty-modal-body").innerHTML = html;
  $("#duty-modal").classList.remove("hidden");
}
