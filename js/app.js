import * as gcal from "./gcal.js?v=20261028t";
import { attachPartPicker, vendorLinks } from "./part_picker.js?v=20261028t";
import { initShiftCalendar, renderShiftCalendar, isDeptVisible } from "./shift_calendar.js?v=20261028t";
import { initInventoryCategories, loadInventoryCategories, renderFilterTabs, matchesFilter, groupOf, fillCategorySelect, isValidCategory, kindOf, isToolItem, toolCategories, OTHER_TOOLS } from "./inventory_categories.js?v=20261028v";
import { initPinLogin, loadPinStatus, setPin, clearPinSession } from "./pin_login.js?v=20261028t";
import { initActivity, loadShopSession } from "./activity.js?v=20261028t";
import { initAnalytics } from "./analytics.js?v=20261028t";
import { initDuties } from "./duties.js?v=20261028t";
import { initScoutHub } from "./scouting.js?v=20261028t";

/* Supabase Configuration */
const SUPABASE_URL = "https://wdzrttyxcedkaifzkjvp.supabase.co";
const SUPABASE_PUBLIC_KEY = "sb_publishable_5jyFdRU5d501M8YWZT2Fsg_7mwovAkD";

const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("YOUR_PROJECT_REF") && SUPABASE_PUBLIC_KEY && !SUPABASE_PUBLIC_KEY.includes("YOUR_SUPABASE");
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let supabase = null;
let currentUser = null;
let currentProfile = null;
let allItems = [];
let allCheckouts = [];
let allTasks = [];
let allPartsNeeded = [];
let allShifts = [];
let allSpending = [];
let spendingPeriodFilter = "all";
let editingSpendingId = null;
let taskDrag = null;
let teamMembers = [];
let shiftAssignSelected = new Set();
let activeCategory = "All";
let activeInventoryKind = "all";
let activePlannerSubsystem = "All";
let activePartsFilter = "All";
let activeShiftDept = "All";
let currentView = "inventory";
let editingItemId = null;
let editingTaskId = null;
let editingShiftId = null;
let checkingOutItem = null;
let channel = null;

/* Light/Dark Segmented Controller */
function initTheme() {
  // v2: the clean redesign defaults to light; earlier versions auto-saved "dark" for everyone
  let saved = null;
  try { saved = localStorage.getItem("nyx_theme_v2"); } catch (e) {}
  applyTheme(saved || "light");
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try { localStorage.setItem("nyx_theme_v2", theme); } catch (e) {}
  
  const darkBtn = $("#theme-btn-dark");
  const lightBtn = $("#theme-btn-light");
  
  if (theme === "light") {
    if (lightBtn) { lightBtn.classList.add("active"); lightBtn.setAttribute("aria-checked", "true"); }
    if (darkBtn) { darkBtn.classList.remove("active"); darkBtn.setAttribute("aria-checked", "false"); }
  } else {
    if (darkBtn) { darkBtn.classList.add("active"); darkBtn.setAttribute("aria-checked", "true"); }
    if (lightBtn) { lightBtn.classList.remove("active"); lightBtn.setAttribute("aria-checked", "false"); }
  }
}

$("#theme-btn-dark").addEventListener("click", () => applyTheme("dark"));
$("#theme-btn-light").addEventListener("click", () => applyTheme("light"));
initTheme();

function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function message(text, isError) {
  const el = $("#auth-message");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden", "error");
  if (isError) el.classList.add("error");
}

function toast(text, isError) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("error", !!isError);
  el.classList.remove("hidden");
  window.clearTimeout(el._timer);
  el._timer = window.setTimeout(() => el.classList.add("hidden"), 4000);
}

function authMode(mode) {
  const signIn = mode === "signin";
  $("#signin-form").classList.toggle("hidden", !signIn);
  $("#signup-form").classList.toggle("hidden", signIn);
  $("#show-signin").classList.toggle("active", signIn);
  $("#show-signup").classList.toggle("active", !signIn);
  $("#auth-title").textContent = signIn ? "Sign in" : "Create account";
  $("#auth-subtitle").textContent = signIn ? "" : "New accounts need approval from a team lead.";
  $("#auth-subtitle").hidden = signIn;
  // PIN sign-in is offered on the sign-in tab only
  $("#pin-form")?.classList.add("hidden");
  $("#pin-or")?.classList.toggle("hidden", !signIn);
  $("#show-pin-login")?.classList.toggle("hidden", !signIn);
  $(".auth-switch")?.classList.remove("hidden");
  $("#auth-message").classList.add("hidden");
}

/* Roles: admins run the site (members, roles, audit log, analytics); spending is admins + moderators;
   moderators share the day-to-day admin work (inventory, parts, shifts, planner, scouting, sign-ups). */
function isStaff(p = currentProfile) { return !!(p?.is_admin || p?.is_moderator); }
function roleLabel(p) { return p?.is_admin ? "ADMIN" : p?.is_moderator ? "MODERATOR" : "MEMBER"; }

let currentAppPage = "dashboard"; // "dashboard", "strategy", or "secrets"
let currentStratTab = "playbook"; // "playbook", "rankings", "scouting", "simulator", "lookup"

function screens(which) {
  const isWorkspace = which === "inventory";
  document.body.classList.toggle("is-auth", which === "auth");
  $("#auth-screen").classList.toggle("hidden", which !== "auth");
  $("#pending-screen").classList.toggle("hidden", which !== "pending");
  const elSidebar = $("#app-sidebar");
  if (elSidebar) elSidebar.classList.toggle("hidden", !isWorkspace);
  const elMobBottomBar = $("#mobile-bottom-bar");
  if (elMobBottomBar) elMobBottomBar.classList.toggle("hidden", !isWorkspace);

  if (isWorkspace) {
    switchPage(currentAppPage);
  } else {
    $("#inventory-screen")?.classList.add("hidden");
    $("#strategy-screen")?.classList.add("hidden");
    $("#secrets-screen")?.classList.add("hidden");
    $("#duties-screen")?.classList.add("hidden");
    $("#analytics-screen")?.classList.add("hidden");
  }
  window.nyxStartup?.finish();
}

function switchPage(pageName) {
  // Guard secrets page: visible to everyone with secret role
  if (pageName === "secrets" && !currentProfile?.is_secret) {
    toast("Restricted Area: Secret Role required.", true);
    pageName = "dashboard";
  }

  currentAppPage = pageName;
  syncSidebarSubnav();
  $("#sidebar-btn-dashboard")?.classList.toggle("active", pageName === "dashboard");
  $("#sidebar-btn-strategy")?.classList.toggle("active", pageName === "strategy");
  $("#sidebar-btn-duties")?.classList.toggle("active", pageName === "duties");
  $("#sidebar-btn-analytics")?.classList.toggle("active", pageName === "analytics");
  $("#analytics-screen")?.classList.toggle("hidden", pageName !== "analytics");
  $("#mob-btn-duties")?.classList.toggle("active", pageName === "duties");
  $("#duties-screen")?.classList.toggle("hidden", pageName !== "duties");
  $("#sidebar-btn-secrets")?.classList.toggle("active", pageName === "secrets");
  $("#mob-btn-dashboard")?.classList.toggle("active", pageName === "dashboard");
  $("#mob-btn-strategy")?.classList.toggle("active", pageName === "strategy");
  $("#mob-btn-secrets")?.classList.toggle("active", pageName === "secrets");
  $("#inventory-screen")?.classList.toggle("hidden", pageName !== "dashboard");
  $("#strategy-screen")?.classList.toggle("hidden", pageName !== "strategy");
  $("#secrets-screen")?.classList.toggle("hidden", pageName !== "secrets");

  // Close mobile sidebar drawer if open
  $("#app-sidebar")?.classList.remove("open");
  $("#sidebar-backdrop")?.classList.remove("active");

  if (pageName === "analytics") {
    if (!currentProfile?.is_admin) return switchPage("dashboard");
    initAnalytics({ getClient: () => supabase, getProfile: () => currentProfile, toast, esc, logAction, myName: () => myShiftName() });
  } else if (pageName === "duties") {
    initDuties({ getClient: () => supabase, getUser: () => currentUser, getProfile: () => currentProfile, toast, esc, logAction });
  } else if (pageName === "strategy") {
    initStrategyCenter();
  } else if (pageName === "secrets") {
    initSecretsCenter();
  }
}

/* Sidebar sub-navigation mirrors the view tabs (visibility, active state, counts) */
function syncSidebarSubnav() {
  $$("#sidebar-subnav .sidebar-sublink").forEach(link => {
    const tab = document.querySelector(`.viewtab[data-view="${link.dataset.subview}"]`);
    link.classList.toggle("hidden", !tab || tab.classList.contains("hidden"));
    link.classList.toggle("active", currentAppPage === "dashboard" && link.dataset.subview === currentView);
    const badge = link.querySelector("[data-badge]");
    if (badge) {
      const n = document.getElementById(badge.dataset.badge)?.textContent || "";
      badge.textContent = n && n !== "0" ? n : "";
    }
  });
}

$("#sidebar-subnav")?.addEventListener("click", e => {
  const link = e.target.closest("[data-subview]");
  if (!link) return;
  switchPage("dashboard");
  switchView(link.dataset.subview);
  if (window.innerWidth <= 1024) $("#sidebar-close-btn")?.click();
});

const viewTabsEl = document.querySelector(".viewtabs");
if (viewTabsEl) new MutationObserver(syncSidebarSubnav).observe(viewTabsEl, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });

function switchView(viewName) {
  currentView = viewName;
  syncSidebarSubnav();
  $$(".viewtab").forEach(tab => tab.classList.toggle("active", tab.dataset.view === viewName));
  $$("#mobile-view-options .sheet-option").forEach(opt => opt.classList.toggle("active", opt.dataset.view === viewName));

  const viewLabels = {
    "inventory": "Parts & Tools",
    "checkouts": "Active Checkouts",
    "parts-needed": "Parts Needed",
    "shifts": "Shifts",
    "planner": "Planner",
    "spending": "Spending",
    "members": "Members",
    "logs": "Audit Log"
  };

  const elMobileViewLbl = $("#mobile-current-view-label");
  if (elMobileViewLbl && viewLabels[viewName]) {
    elMobileViewLbl.textContent = viewLabels[viewName];
  }

  const elAuditBtn = $("#admin-audit-logs-btn");
  if (elAuditBtn) {
    elAuditBtn.classList.toggle("btn--primary", viewName === "logs");
    elAuditBtn.classList.toggle("btn--ghost", viewName !== "logs");
  }
  $("#view-inventory").classList.toggle("hidden", viewName !== "inventory");
  $("#view-checkouts").classList.toggle("hidden", viewName !== "checkouts");
  $("#view-parts-needed").classList.toggle("hidden", viewName !== "parts-needed");
  $("#view-shifts").classList.toggle("hidden", viewName !== "shifts");
  $("#view-planner").classList.toggle("hidden", viewName !== "planner");
  $("#view-spending").classList.toggle("hidden", viewName !== "spending");
  $("#view-members").classList.toggle("hidden", viewName !== "members");
  $("#view-logs").classList.toggle("hidden", viewName !== "logs");

  if (viewName === "spending" && isStaff()) loadSpending();
  if (viewName === "logs" && currentProfile?.is_admin) loadLogs();
}

async function logAction(action, entityType, entityId, details) {
  if (!supabase || !currentUser) return;
  try {
    await supabase.from("activity_logs").insert({
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      details: details || {},
      user_id: currentUser.id,
      user_name: currentProfile?.full_name || currentUser.email || "Team Member"
    });
  } catch (err) {
    console.error("Log error:", err);
  }
}

async function signOut() {
  clearPinSession();
  if (channel && supabase) {
    await supabase.removeChannel(channel);
    channel = null;
  }
  if (supabase) await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  allItems = [];
  allCheckouts = [];
  allTasks = [];
  allPartsNeeded = [];
  allShifts = [];
  allSpending = [];
  $("#app-sidebar")?.classList.add("hidden");
  screens("auth");
  authMode("signin");
}

async function checkUser(user) {
  currentUser = user;
  try {
    const { data, error } = await supabase.from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error) {
      screens("auth");
      message("Could not load your team profile: " + error.message, true);
      return;
    }

  currentProfile = data;

  if (!data.is_approved) {
    screens("pending");
    return;
  }

  const name = data.full_name || user.email || "Team Member";
  const depts = (data.departments && data.departments.length) ? data.departments.join(" · ").toUpperCase() : "GENERAL";
  const roleParts = [];
  if (data.is_admin) roleParts.push("ADMIN");
  else if (data.is_moderator) roleParts.push("MODERATOR");
  if (data.is_strategy) roleParts.push("STRATEGY");
  if (data.is_secret) roleParts.push("SECRET");
  const roleLabel = roleParts.length > 0 ? roleParts.join(" & ") : "MEMBER";
  const elName = $("#profile-name"); if (elName) elName.textContent = name;
  const elAvatar = $("#profile-avatar"); if (elAvatar) elAvatar.textContent = name.trim().charAt(0).toUpperCase();
  const elRole = $("#profile-role"); if (elRole) elRole.textContent = `${depts} · ${roleLabel}`;

  const elSideName = $("#sidebar-username"); if (elSideName) elSideName.textContent = name;
  const elSideAvatar = $("#sidebar-avatar"); if (elSideAvatar) elSideAvatar.textContent = name.trim().charAt(0).toUpperCase();
  const elSideDept = $("#sidebar-userdept"); if (elSideDept) elSideDept.textContent = `${depts} · ${roleLabel}`;

  // Admin & Secret visibility controls
  const elAddItm = $("#add-item-button"); if (elAddItm) elAddItm.classList.toggle("hidden", !isStaff(data));
  const elAddPn = $("#add-part-needed-btn"); if (elAddPn) elAddPn.classList.toggle("hidden", !isStaff(data));
  const elAddTsk = $("#add-task-btn"); if (elAddTsk) elAddTsk.classList.toggle("hidden", !isStaff(data));
  const elAddShift = $("#add-shift-btn"); if (elAddShift) elAddShift.classList.toggle("hidden", !isStaff(data));
  const elTabSpend = $("#tab-spending"); if (elTabSpend) elTabSpend.classList.toggle("hidden", !isStaff(data));
  const elTabMem = $("#tab-members"); if (elTabMem) elTabMem.classList.toggle("hidden", !data.is_admin);
  const elAdminAuditBtn = $("#admin-audit-logs-btn"); if (elAdminAuditBtn) elAdminAuditBtn.classList.toggle("hidden", !data.is_admin);
  const elSecretSideBtn = $("#sidebar-btn-secrets"); if (elSecretSideBtn) elSecretSideBtn.classList.toggle("hidden", !data.is_secret);
  const elCatBtn = $("#manage-categories-btn"); if (elCatBtn) elCatBtn.classList.toggle("hidden", !data.is_admin);
  const elAnalyticsBtn = $("#sidebar-btn-analytics"); if (elAnalyticsBtn) elAnalyticsBtn.classList.toggle("hidden", !data.is_admin);
  loadShopSession();
  const elSecretMobBtn = $("#mob-btn-secrets"); if (elSecretMobBtn) elSecretMobBtn.classList.toggle("hidden", !data.is_secret);

  await Promise.all([loadItems(), loadCheckouts(), loadTasks(), loadPartsNeeded(), loadShifts()]);

  if (data.is_admin) {
    await Promise.all([loadMembers(), loadSpending()]);
  }
  if (data.is_secret) {
    loadSecretIntel();
  }
  screens("inventory");

  // Subscribe to realtime changes
  if (!channel) {
    channel = supabase.channel("nyx-realtime-workspace")
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, () => loadItems(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "tool_checkouts" }, () => {
        loadCheckouts(true);
        loadItems(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "planner_tasks" }, () => loadTasks(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "parts_needed" }, () => loadPartsNeeded(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "team_shifts" }, () => loadShifts(true))
      .on("postgres_changes", { event: "*", schema: "public", table: "spending_records" }, () => {
        if (isStaff()) loadSpending(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "activity_logs" }, () => {
        if (currentView === "logs" && currentProfile?.is_admin) loadLogs();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "strategy_plays" }, () => {
        loadSavedPlays(true);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "secret_personnel_intel" }, () => {
        if (currentProfile?.is_secret) loadSecretIntel(true);
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") {
          const elSync = $("#last-sync");
          if (elSync) elSync.textContent = "Live sync connected";
        }
      });
  }
  } catch (err) {
    console.error("checkUser error:", err);
    window.nyxStartup?.fail("Couldn't load your workspace. Please try again.");
    toast("Workspace load error: " + err.message, true);
  }
}

/* Load Inventory Items */
async function loadItems(quiet) {
  if (!supabase || !currentUser) return;
  const list = $("#items-list");
  if (!quiet && list) list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">Loading inventory…</div>';

  await loadInventoryCategories();
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, category, quantity, unit, location, notes, is_tool, part_number, min_quantity, updated_at")
    .order("category")
    .order("name");

  if (error) {
    if (list) list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">Inventory error: ${esc(error.message)}</div>`;
    return;
  }

  allItems = data || [];
  renderItems();
  const elSync = $("#last-sync");
  if (elSync) elSync.textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/* Load Shifts (Everyone can edit) */
async function loadShifts(quiet) {
  if (!supabase || !currentUser) return;
  const list = $("#shifts-list");
  if (!quiet && list) list.innerHTML = '<div style="padding:40px; text-align:center; grid-column:1/-1;" class="muted">Loading lab shifts…</div>';

  const { data, error } = await supabase
    .from("team_shifts")
    .select("id, title, department, shift_date, start_time, end_time, location, attendees, notes, created_by_name, created_at")
    .order("shift_date", { ascending: true });

  if (error) {
    if (list) list.innerHTML = `<div style="padding:40px; text-align:center; grid-column:1/-1;" class="muted">Error: ${esc(error.message)}</div>`;
    return;
  }

  allShifts = data || [];
  renderShifts();
  syncShiftCalendar();
}

/* Google-Calendar-style shift calendar */
initShiftCalendar({
  getShifts: () => allShifts,
  isAdmin: () => isStaff(),
  myName: () => myShiftName(),
  esc,
  cardHtml: s => shiftCardHtml(s),
  showList: show => { const l = $("#shifts-list"); if (l) l.hidden = !show; },
  onFilterChange: () => renderShifts(),
  onCreate: prefill => openShiftModal(null, prefill),
  onMove: async (shift, patch) => {
    if (!isStaff()) return renderShifts();
    const before = { shift_date: shift.shift_date, start_time: shift.start_time, end_time: shift.end_time };
    Object.assign(shift, patch);   // optimistic
    renderShifts();
    const { error } = await supabase.from("team_shifts").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", shift.id);
    if (error) {
      Object.assign(shift, before);
      renderShifts();
      return toast("Couldn't move shift: " + error.message, true);
    }
    await logAction("SHIFT_UPDATED", "team_shifts", shift.id, { title: shift.title, from: before, to: patch, via: "calendar drag" });
    toast(`Moved "${shift.title}" to ${new Date(patch.shift_date + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${patch.start_time}–${patch.end_time}.`);
    loadShifts(true);
  },
});

/* Google Calendar: push this member's shift sign-ups to their calendar */
function myShiftName() {
  return currentProfile?.full_name || currentUser?.email || "Team Member";
}

async function syncShiftCalendar({ interactive = false, announce = false } = {}) {
  if (!gcal.isConfigured()) return;
  try {
    if (interactive) await gcal.requestToken();
    const res = await gcal.syncShifts(allShifts, myShiftName());
    if (announce && !res.skipped) {
      toast(res.added || res.removed
        ? `Google Calendar updated (${res.added} added/updated, ${res.removed} removed).`
        : "Google Calendar is up to date.");
    }
  } catch (err) {
    if (interactive || announce) toast("Google Calendar sync failed: " + err.message, true);
  }
  updateGcalButton();
}

function updateGcalButton() {
  const btn = $("#gcal-connect-btn");
  if (!btn) return;
  btn.classList.toggle("hidden", !gcal.isConfigured());
  btn.textContent = gcal.isConnected() ? "Google Calendar: Synced ✓" : "Sync to Google Calendar";
}

$("#gcal-connect-btn")?.addEventListener("click", async () => {
  if (gcal.isConnected() && confirm("Stop syncing shifts to Google Calendar? Events already added stay on your calendar.\n\nPress Cancel to re-sync now instead.")) {
    gcal.disconnect();
    updateGcalButton();
    toast("Google Calendar sync turned off.");
    return;
  }
  await syncShiftCalendar({ interactive: true, announce: true });
});

/* Load Parts Needed (Everyone views) */
async function loadPartsNeeded(quiet) {
  if (!supabase || !currentUser) return;
  const list = $("#parts-needed-list");
  if (!quiet && list) list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">Loading needed parts…</div>';

  const { data, error } = await supabase
    .from("parts_needed")
    .select("id, part_name, subsystem, quantity, vendor, part_number, url, priority, status, estimated_cost, notes, updated_at")
    .order("created_at", { ascending: false });

  if (error) {
    if (list) list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">Error: ${esc(error.message)}</div>`;
    return;
  }

  allPartsNeeded = data || [];
  renderPartsNeeded();
}

/* Load Tool Checkouts */
async function loadCheckouts(quiet) {
  if (!supabase || !currentUser) return;
  const { data, error } = await supabase
    .from("tool_checkouts")
    .select("id, item_id, user_id, user_name, quantity, status, checked_out_at, notes, inventory_items(name, location)")
    .eq("status", "checked_out")
    .order("checked_out_at", { ascending: false });

  if (!error) {
    allCheckouts = data || [];
    renderCheckouts();
  }
}

/* Load Planner Tasks */
async function loadTasks(quiet) {
  if (!supabase || !currentUser) return;
  const { data, error } = await supabase
    .from("planner_tasks")
    .select("id, title, description, subsystem, status, priority, due_date, assigned_to, position, created_by, created_by_name, created_at, updated_at")
    .order("position", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false });

  if (!error) {
    allTasks = data || [];
    renderTasks();
  }
}

/* Load Spending (admins and moderators) */
async function loadSpending(quiet) {
  if (!supabase || !isStaff()) return;
  const list = $("#spending-list");
  if (!quiet && list) list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">Loading spending ledger…</div>';

  const { data, error } = await supabase
    .from("spending_records")
    .select("id, title, vendor, amount, category, order_date, order_number, notes, receipt_url, receipt_data, season_period, edit_history, created_by_name, created_at, updated_at")
    .order("order_date", { ascending: false });

  if (error) {
    if (list) list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">Error loading spending: ${esc(error.message)}</div>`;
    return;
  }

  allSpending = data || [];
  renderSpending();
}

function stockStatus(x) {
  const qty = Number(x.quantity) || 0;
  if (qty <= 0) return "out";
  return qty <= Number(x.min_quantity ?? 1) ? "low" : "in";
}
function stockPill(x) {
  const st = stockStatus(x);
  const label = { in: "In stock", low: "Low stock", out: "Out of stock" }[st];
  return `<span class="stock-pill stock-pill--${st}">${label}</span>`;
}
function renderStockBar() {
  const counts = { in: 0, low: 0, out: 0 };
  allItems.forEach(x => counts[stockStatus(x)]++);
  const el = $("#stock-breakdown");
  if (!el) return;
  const total = allItems.length || 1;
  el.innerHTML = `
    <div class="stockbar">${["in", "low", "out"].map(k => counts[k] ? `<i class="stockbar-${k}" style="flex:${counts[k] / total}"></i>` : "").join("")}</div>
    <div class="stocklegend"><span class="dot-in"></span>In stock <b>${counts.in}</b><span class="dot-low"></span>Low <b>${counts.low}</b><span class="dot-out"></span>Out <b>${counts.out}</b></div>`;
}

function renderItems() {
  renderStockBar();
  const toolsCount = allItems.filter(isToolItem).length;
  $("#inv-count-all").textContent = allItems.length;
  $("#inv-count-parts").textContent = allItems.length - toolsCount;
  $("#inv-count-tools").textContent = toolsCount;
  $$('[data-inventory-kind]').forEach(button => {
    const active = button.dataset.inventoryKind === activeInventoryKind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const elStatItems = $("#stat-items"); if (elStatItems) elStatItems.textContent = allItems.length;
  const elBadgeAll = $("#badge-all"); if (elBadgeAll) elBadgeAll.textContent = allItems.length;

  const tabs = $("#inv-filter-tabs");
  const scopedItems = allItems.filter(x => activeInventoryKind === "all" || isToolItem(x) === (activeInventoryKind === "tool"));
  if (tabs) renderFilterTabs(tabs, scopedItems, activeCategory, activeInventoryKind);
  $("#mobile-current-filter-inv-label").textContent = activeCategory === "All" ? "All categories" : activeCategory;

  const searchInput = $("#search-items");
  const q = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const stock = $("#inventory-stock").value;
  const sort = $("#inventory-sort").value;
  const shown = scopedItems.filter(x => {
    if (!matchesFilter(x, activeCategory)) return false;
    if (stock !== "all" && stockStatus(x) !== stock) return false;
    if (!q) return true;
    return [x.name, x.category, x.location, x.notes, x.part_number].join(" ").toLowerCase().includes(q);
  });
  $("#inventory-results").textContent = `${shown.length} of ${allItems.length} items · Grouped by category`;
  $("#inventory-reset").hidden = activeInventoryKind === "all" && activeCategory === "All" && stock === "all" && !q;

  const list = $("#items-list");
  if (!list) return;

  if (!shown.length) {
    list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">' +
      (allItems.length ? "No items match these filters. Clear filters or try a different search." : "No inventory items recorded yet.") +
      '</div>';
    return;
  }

  // Parts first, then tools, each grouped by category (in the admins' category order)
  const withinGroup = (a, b) => (sort === "quantity" ? Number(a.quantity) - Number(b.quantity)
    : sort === "location" ? (a.location || "Shop").localeCompare(b.location || "Shop", undefined, { numeric: true }) : 0)
    || a.name.localeCompare(b.name, undefined, { numeric: true });
  const grouped = shown.map(x => ({ x, g: groupOf(x) })).sort((a, b) => a.g.key.localeCompare(b.g.key) || withinGroup(a.x, b.x));
  const groupSize = new Map();
  grouped.forEach(({ g }) => groupSize.set(g.key, (groupSize.get(g.key) || 0) + 1));
  let lastSection = null, lastGroup = null;
  list.innerHTML = grouped.map(({ x, g }) => {
    let head = "";
    if (g.section !== lastSection) {
      lastSection = g.section;
      head += `<div class="inv-section"><i class=${g.section === "Tools" ? "fa-screwdriver-wrench" : "fa-box"} aria-hidden=true></i> ${g.section}</div>`;
    }
    if (g.key !== lastGroup) {
      lastGroup = g.key;
      head += `<div class="inv-group">${esc(g.name)} <span>${groupSize.get(g.key)}</span></div>`;
    }
    return head + itemRowHtml(x);
  }).join("");
}

function itemRowHtml(x) {
  const isAdmin = isStaff();
  {
    const isLow = Number(x.quantity) <= Number(x.min_quantity || 1);
    const itemCheckouts = allCheckouts.filter(c => c.item_id === x.id);
    const checkedOutQty = itemCheckouts.reduce((sum, c) => sum + c.quantity, 0);

    return `
      <article class="itemrow">
        <div>
          <div class="itemname">
            ${esc(x.name)}
            ${x.is_tool ? '<span class="pill tool">Tool</span>' : ''}
            ${x.part_number ? `<span class="parttag">${esc(x.part_number)}</span>` : ''}
          </div>
          <div class="itemnotes">${esc(x.notes || "No details provided")}</div>
          ${itemCheckouts.length ? `
            <div class="checkout-banner">
              <span><i class=fa-triangle-exclamation aria-hidden=true></i> ${checkedOutQty} in use (${itemCheckouts.map(c => esc(c.user_name)).join(", ")})</span>
              ${itemCheckouts.filter(c => c.user_id === currentUser?.id || isAdmin).map(c => `
                <button class="actionbtn" style="padding:2px 6px; font-size:10px;" data-action="return-direct" data-id="${c.id}" title="Return ${esc(c.user_name)}'s checkout">Return (${esc(c.user_name)})</button>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <div class="subsys">
          <span class="pill ${esc(x.category)}">${esc(x.category)}</span>
        </div>

        <div class="location muted">${esc(x.location || "Shop")}</div>

        <div class="stockcell">
        <div class="quantity">
          ${isAdmin ? `
            <button class="qtybtn" data-action="qtyminus" data-id="${esc(x.id)}" aria-label="Decrease">−</button>
          ` : ''}
          <span class="qtynum ${isLow ? 'low' : ''}">${Number(x.quantity)}</span>
          ${isAdmin ? `
            <button class="qtybtn" data-action="qtyplus" data-id="${esc(x.id)}" aria-label="Increase">+</button>
          ` : ''}
          <span class="muted">${esc(x.unit || "pcs")}</span>
        </div>
        ${stockPill(x)}
        </div>

        <div class="actions">
          <button class="actionbtn" data-action="label-qr" data-id="${esc(x.id)}" title="Print bin label & QR code">Label</button>
          ${x.is_tool ? `
            <button class="actionbtn checkout" data-action="checkout" data-id="${esc(x.id)}">Borrow</button>
          ` : ''}
          ${isAdmin ? `
            <button class="actionbtn" data-action="edit" data-id="${esc(x.id)}">Edit</button>
            <button class="actionbtn delete" data-action="delete" data-id="${esc(x.id)}">Delete</button>
          ` : ''}
        </div>
      </article>
    `;
  }
}

/* Render Shifts & Calendar */
function renderShifts() {
  const elStatShifts = $("#stat-shifts"); if (elStatShifts) elStatShifts.textContent = allShifts.length;
  const elBadgeShifts = $("#badge-shifts"); if (elBadgeShifts) elBadgeShifts.textContent = allShifts.length;

  const filtered = allShifts.filter(s => isDeptVisible(s.department));
  renderShiftCalendar();

  const list = $("#shifts-list");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = '<div style="padding:40px; text-align:center; grid-column:1/-1;" class="muted">' +
      (allShifts.length ? "No shifts scheduled for this department." : "No upcoming lab shifts scheduled yet. Admins can click '＋ Schedule Shift' above!") +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map(shiftCardHtml).join("");
}

/* One shift as a card (Schedule view and the calendar's details popover) */
function shiftCardHtml(s) {
  const myName = currentProfile?.full_name || currentUser?.email || "Team Member";
  const isAdmin = isStaff();
  {
    const attendees = Array.isArray(s.attendees) ? s.attendees : [];
    const isAttending = attendees.includes(myName);

    function formatTime(t) {
      if (!t) return "";
      const [h, m] = t.split(":");
      const d = new Date(); d.setHours(Number(h), Number(m));
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }

    const timeStr = `${formatTime(s.start_time)} – ${formatTime(s.end_time)}`;
    const dateObj = new Date(s.shift_date + "T00:00:00");
    const dateStr = dateObj.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    const isWeekly = s.notes && s.notes.includes("[🔁 Weekly Shift]");
    const cleanNotes = s.notes ? s.notes.replace("[🔁 Weekly Shift]", "").trim() : "";

    return `
      <article class="shift-card" data-shift-id="${s.id}">
        <div class="shift-header">
          <div>
            <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
              <span class="pill ${esc(s.department.replace(/\s+/g, ''))}">${esc(s.department)}</span>
              ${isWeekly ? `<span class="pill pill-weekly" title="Repeats weekly series"><i class=fa-repeat aria-hidden=true></i> Weekly</span>` : ''}
            </div>
            <div class="shift-title" style="margin-top:8px;">${esc(s.title)}</div>
          </div>
          ${isAdmin ? `
            <div style="display:flex; gap:4px;">
              <button class="actionbtn" data-action="edit-shift" data-id="${s.id}" title="Edit shift"><i class=fa-pen aria-hidden=true></i></button>
              <button class="actionbtn delete" data-action="delete-shift" data-id="${s.id}" title="Remove shift"><i class=fa-trash-can aria-hidden=true></i></button>
            </div>
          ` : ''}
        </div>

        <div class="shift-time">
          <span><i class=fa-calendar-days aria-hidden=true></i> ${dateStr}</span> · <span><i class=fa-clock aria-hidden=true></i> ${timeStr}</span>
        </div>

        <div class="shift-loc">
          <span><i class=fa-location-dot aria-hidden=true></i> ${esc(s.location || "Main Shop")}</span>
        </div>

        ${cleanNotes ? `<div class="muted small">${esc(cleanNotes)}</div>` : ''}

        <div class="shift-roster">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b class="mono small" style="color:var(--text-muted)">ROSTER (${attendees.length})</b>
            <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
            ${isAdmin ? `<button class="btn btn--sm btn--ghost" data-action="assign-shift" data-id="${s.id}" title="Assign members"><i class=fa-users aria-hidden=true></i> Assign</button>` : ''}
            ${isAttending ? `
              <button class="btn btn--sm btn--ghost" data-action="toggle-attend-shift" data-id="${s.id}" style="color:var(--red); border-color:rgba(248,113,113,.3);" title="Remove yourself from this shift">
                ✕ Leave Shift
              </button>
            ` : `
              <button class="btn btn--sm btn--primary" data-action="toggle-attend-shift" data-id="${s.id}">
                ＋ Join Shift
              </button>
            `}
            </div>
          </div>
          ${isAttending && !gcal.isConnected() ? `
            <a class="muted small" href="${esc(gcal.templateLink(s))}" target="_blank" rel="noopener" style="display:inline-block; margin-top:4px;"><i class=fa-calendar-days aria-hidden=true></i> Add to Google Calendar</a>
          ` : ''}
          <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
            ${attendees.length ? attendees.map(a => {
              const canRemove = isAdmin || a === myName;
              return `
                <span class="attendee-pill ${a === myName ? 'is-me' : ''}">
                  ${esc(a)}${a === myName ? ' (You)' : ''}
                  ${canRemove ? `
                    <button class="attendee-remove-btn" type="button" data-action="remove-attendee" data-id="${s.id}" data-attendee="${esc(a)}" title="${a === myName ? 'Leave shift' : `Remove ${esc(a)}`}">×</button>
                  ` : ''}
                </span>
              `;
            }).join('') : '<span class="muted small">No members signed up yet</span>'}
          </div>
        </div>
      </article>
    `;
  }
}

/* Render Parts Needed (Viewable by everyone, editable by admins) */
function renderPartsNeeded() {
  const neededUnarrived = allPartsNeeded.filter(p => p.status !== "arrived");
  const elSpn = $("#stat-parts-needed"); if (elSpn) elSpn.textContent = neededUnarrived.length;
  const elBpn = $("#badge-parts-needed"); if (elBpn) elBpn.textContent = neededUnarrived.length;

  const filtered = allPartsNeeded.filter(p => {
    if (activePartsFilter === "All") return true;
    return p.status === activePartsFilter;
  });

  const list = $("#parts-needed-list");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">' +
      (allPartsNeeded.length ? "No parts match this status filter." : "No robot parts currently in the ordering queue. Admins can add parts needed above!") +
      '</div>';
    return;
  }

  const isAdmin = isStaff();

  list.innerHTML = filtered.map(p => {
    const subsysClass = p.subsystem.replace(/[\s\/]/g, "");
    return `
      <article class="itemrow" style="grid-template-columns: minmax(220px, 2.5fr) minmax(110px, 1.2fr) minmax(110px, 1fr) minmax(120px, 1.2fr) minmax(130px, 1.4fr);">
        <div>
          <div class="itemname">
            ${esc(p.part_name)}
            <span class="prio ${esc(p.priority)}">${esc(p.priority)}</span>
          </div>
          <div class="itemnotes">
            ${p.part_number ? `PN: ${esc(p.part_number)} · ` : ''}
            ${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">Vendor Link ↗</a> · ` : ''}
            ${esc(p.notes || "No notes")}
          </div>
        </div>

        <div class="subsys">
          <span class="pill ${esc(subsysClass)}">${esc(p.subsystem)}</span>
        </div>

        <div>
          <strong class="mono" style="font-size:14px;">${p.quantity}</strong> pcs
          <div class="muted small">${esc(p.vendor || "Vendor TBD")}</div>
        </div>

        <div>
          <span class="status-badge ${esc(p.status)}">${esc(p.status.toUpperCase())}</span>
          ${Number(p.estimated_cost) > 0 ? `<div class="mono small muted" style="margin-top:2px;">~$${Number(p.estimated_cost).toFixed(2)}</div>` : ''}
        </div>

        <div class="actions">
          ${isAdmin ? `
            <select class="actionbtn" data-action="quick-status-pn" data-id="${p.id}" style="padding:3px 6px; font-size:11px;">
              <option value="needed" ${p.status==='needed'?'selected':''}>Needed</option>
              <option value="ordered" ${p.status==='ordered'?'selected':''}>Ordered</option>
              <option value="shipped" ${p.status==='shipped'?'selected':''}>Shipped</option>
              <option value="arrived" ${p.status==='arrived'?'selected':''}>Arrived</option>
            </select>
            <button class="actionbtn delete" data-action="delete-pn" data-id="${p.id}" title="Delete request"><i class=fa-trash-can aria-hidden=true></i></button>
          ` : `
            <span class="muted small mono">${p.status === 'arrived' ? 'In shop' : 'Pending order'}</span>
          `}
        </div>
      </article>
    `;
  }).join("");
}

function renderCheckouts() {
  const elSc = $("#stat-checkouts"); if (elSc) elSc.textContent = allCheckouts.length;
  const elBc = $("#badge-checkouts"); if (elBc) elBc.textContent = allCheckouts.length;

  const list = $("#checkouts-list");
  if (!list) return;

  if (!allCheckouts.length) {
    list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">All tools are currently in the shop! No active checkouts.</div>';
    return;
  }

  list.innerHTML = allCheckouts.map(c => {
    const itemName = c.inventory_items?.name || "Tool";
    const location = c.inventory_items?.location || "Shop";
    const canReturn = c.user_id === currentUser.id || isStaff();

    return `
      <article class="itemrow" style="grid-template-columns: minmax(180px, 2fr) minmax(130px, 1.2fr) minmax(130px, 1.2fr) minmax(100px, 1fr) 110px;">
        <div>
          <div class="itemname"><i class=fa-screwdriver-wrench aria-hidden=true></i> ${esc(itemName)}</div>
          <div class="itemnotes">Location: ${esc(location)} · ${esc(c.notes || "No notes")}</div>
        </div>
        <div>
          <span class="mono small" style="color:var(--accent-bright)">${esc(c.user_name)}</span>
        </div>
        <div class="muted small mono">
          ${new Date(c.checked_out_at).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
        </div>
        <div class="mono">
          <strong>${c.quantity}</strong> pcs
        </div>
        <div>
          ${canReturn ? `
            <button class="btn btn--primary btn--sm" data-action="checkin" data-id="${c.id}" data-item="${c.item_id}" data-name="${esc(itemName)}">Check In</button>
          ` : '<span class="muted small">In Use</span>'}
        </div>
      </article>
    `;
  }).join("");
}

function renderTasks() {
  if (taskDrag?.active) return; // endTaskDrag re-renders once the card lands
  const activeTasks = allTasks.filter(t => t.status !== "done");
  const elSt = $("#stat-tasks"); if (elSt) elSt.textContent = activeTasks.length;
  const elBp = $("#badge-planner"); if (elBp) elBp.textContent = activeTasks.length;

  const filtered = allTasks.filter(t => {
    if (activePlannerSubsystem === "All") return true;
    return t.subsystem === activePlannerSubsystem;
  });

  const todoTasks = filtered.filter(t => t.status === "todo");
  const inProgTasks = filtered.filter(t => t.status === "in_progress");
  const doneTasks = filtered.filter(t => t.status === "done");

  const elCt = $("#count-todo"); if (elCt) elCt.textContent = todoTasks.length;
  const elCip = $("#count-in-progress"); if (elCip) elCip.textContent = inProgTasks.length;
  const elCd = $("#count-done"); if (elCd) elCd.textContent = doneTasks.length;

  const isAdmin = isStaff();

  function renderCard(t) {
    const subsysClass = t.subsystem.replace(/[\s\/]/g, "");
    return `
      <div class="task-card" data-task-id="${t.id}" title="Drag to move">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
          <span class="pill ${esc(subsysClass)}">${esc(t.subsystem)}</span>
          <span class="prio ${esc(t.priority)}">${esc(t.priority)}</span>
        </div>
        <div class="task-title">${esc(t.title)}</div>
        ${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ''}
        <div class="task-meta">
          <span class="task-assignee">${t.assigned_to ? `@${esc(t.assigned_to)}` : '<em class="muted">Unassigned</em>'}</span>
          ${t.due_date ? `<span class="task-date"><i class=fa-calendar-days aria-hidden=true></i> ${esc(t.due_date)}</span>` : ''}
        </div>
        <div class="task-actions">
          <div style="display:flex; gap:5px;">
            ${t.status === "todo" ? `
              <button class="task-stepbtn" data-action="move-status" data-id="${t.id}" data-newstatus="in_progress">Start <i class=fa-bolt aria-hidden=true></i></button>
            ` : ''}
            ${t.status === "in_progress" ? `
              <button class="task-stepbtn" data-action="move-status" data-id="${t.id}" data-newstatus="done">Done <i class=fa-circle-check aria-hidden=true></i></button>
            ` : ''}
            ${t.status === "done" ? `
              <button class="task-stepbtn" data-action="move-status" data-id="${t.id}" data-newstatus="in_progress">Reopen ↺</button>
            ` : ''}
          </div>
          ${isAdmin ? `
            <div style="display:flex; gap:4px;">
              <button class="actionbtn" data-action="edit-task" data-id="${t.id}" title="Edit task"><i class=fa-pen aria-hidden=true></i></button>
              <button class="actionbtn delete" data-action="delete-task" data-id="${t.id}" title="Delete task"><i class=fa-trash-can aria-hidden=true></i></button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  const elTasksTodo = $("#tasks-todo"); if (elTasksTodo) elTasksTodo.innerHTML = todoTasks.length ? todoTasks.map(renderCard).join("") : '<div class="muted small" style="text-align:center; padding:30px 10px;">No pending tasks</div>';
  const elTasksInp = $("#tasks-in-progress"); if (elTasksInp) elTasksInp.innerHTML = inProgTasks.length ? inProgTasks.map(renderCard).join("") : '<div class="muted small" style="text-align:center; padding:30px 10px;">No tasks currently active</div>';
  const elTasksDone = $("#tasks-done"); if (elTasksDone) elTasksDone.innerHTML = doneTasks.length ? doneTasks.map(renderCard).join("") : '<div class="muted small" style="text-align:center; padding:30px 10px;">No completed tasks yet</div>';
}

/* Planner drag & drop (Trello-style). Mouse drags after a small move; touch needs a long-press so scrolling still works. */
const TASK_COLUMNS = { "tasks-todo": "todo", "tasks-in-progress": "in_progress", "tasks-done": "done" };

function taskColumnAt(x, y) {
  for (const id of Object.keys(TASK_COLUMNS)) {
    const col = document.getElementById(id);
    const box = col?.closest(".planner-col");
    if (!box) continue;
    const r = box.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return col;
  }
  return null;
}

function beginTaskDrag(card, x, y) {
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add("task-card--ghost");
  Object.assign(ghost.style, { width: r.width + "px", left: r.left + "px", top: r.top + "px" });
  document.body.appendChild(ghost);

  const placeholder = document.createElement("div");
  placeholder.className = "task-card-placeholder";
  placeholder.style.height = r.height + "px";
  card.after(placeholder);
  card.classList.add("task-card--dragging");
  document.body.classList.add("is-dragging-task");

  taskDrag.active = true;
  Object.assign(taskDrag, { ghost, placeholder, offX: x - r.left, offY: y - r.top });
  navigator.vibrate?.(15);
}

function moveTaskDrag(x, y) {
  const { ghost, placeholder } = taskDrag;
  taskDrag.lastX = x;
  taskDrag.lastY = y;
  if (!taskDrag.scrollRaf) taskDrag.scrollRaf = requestAnimationFrame(autoScrollTaskDrag);
  ghost.style.left = x - taskDrag.offX + "px";
  ghost.style.top = y - taskDrag.offY + "px";

  const col = taskColumnAt(x, y);
  $$(".task-dropzone--over").forEach(el => el.classList.remove("task-dropzone--over"));
  if (!col) return;
  col.classList.add("task-dropzone--over");

  const siblings = [...col.querySelectorAll(".task-card:not(.task-card--dragging)")];
  const before = siblings.find(el => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  if (before) col.insertBefore(placeholder, before);
  else col.appendChild(placeholder);
  col.querySelector(":scope > .muted")?.classList.add("hidden");
}

/* Keep scrolling while the pointer rests near the top/bottom edge, so stacked mobile columns are reachable */
function autoScrollTaskDrag() {
  if (!taskDrag?.active) return;
  taskDrag.scrollRaf = null;
  const edge = Math.min(90, window.innerHeight * 0.15);
  const y = taskDrag.lastY;
  let dy = 0;
  if (y < edge) dy = -Math.ceil((edge - y) / 5);
  else if (y > window.innerHeight - edge) dy = Math.ceil((y - (window.innerHeight - edge)) / 5);
  if (!dy) return;
  const before = window.scrollY;
  window.scrollBy(0, dy);
  if (window.scrollY !== before) moveTaskDrag(taskDrag.lastX, taskDrag.lastY);
  else taskDrag.scrollRaf = requestAnimationFrame(autoScrollTaskDrag);
}

async function endTaskDrag() {
  const { ghost, placeholder, card, id } = taskDrag;
  if (taskDrag.scrollRaf) cancelAnimationFrame(taskDrag.scrollRaf);
  const col = placeholder.parentElement;
  taskDrag = null;
  ghost.remove();
  card.classList.remove("task-card--dragging");
  document.body.classList.remove("is-dragging-task");
  $$(".task-dropzone--over").forEach(el => el.classList.remove("task-dropzone--over"));

  const newStatus = col && TASK_COLUMNS[col.id];
  if (!newStatus) { placeholder.remove(); renderTasks(); return; }

  // New order of the destination column, with the dragged card where the placeholder sits
  const orderedIds = [...col.children]
    .map(el => el === placeholder ? id : el.dataset.taskId)
    .filter(Boolean);
  placeholder.remove();

  const task = allTasks.find(t => t.id === id);
  if (!task) return;
  const previousStatus = task.status;

  const updates = [];
  orderedIds.forEach((tid, i) => {
    const t = allTasks.find(x => x.id === tid);
    if (!t) return;
    const position = (i + 1) * 1000;
    const status = tid === id ? newStatus : t.status;
    if (t.position !== position || t.status !== status) {
      t.position = position;
      t.status = status;
      updates.push({ id: tid, position, status });
    }
  });
  allTasks.sort((a, b) => (a.position ?? -Infinity) - (b.position ?? -Infinity));
  renderTasks();
  if (!updates.length) return;

  const now = new Date().toISOString();
  const results = await Promise.all(updates.map(u =>
    supabase.from("planner_tasks").update({ status: u.status, position: u.position, updated_at: now }).eq("id", u.id)
  ));
  const failed = results.find(r => r.error);
  if (failed) {
    toast("Failed to move task: " + failed.error.message, true);
    await loadTasks(true);
    return;
  }

  if (previousStatus !== newStatus) {
    const logType = newStatus === "done" ? "PLANNER_TASK_COMPLETED" : "PLANNER_TASK_UPDATED";
    await logAction(logType, "planner_tasks", id, {
      title: task.title,
      previous_status: previousStatus,
      new_status: newStatus,
      status: newStatus,
      subsystem: task.subsystem || "General",
      assigned_to: task.assigned_to || "",
      via: "drag"
    });
    toast(newStatus === "done" ? "Task marked complete!" : `Moved "${task.title}" to ${newStatus === "todo" ? "To Do" : "In Progress"}.`);
  }
}

document.addEventListener("pointerdown", e => {
  const card = e.target.closest(".task-card");
  if (!card || e.button > 0 || e.target.closest("button, a, input, select, textarea")) return;
  taskDrag = { card, id: card.dataset.taskId, startX: e.clientX, startY: e.clientY, active: false, pointerId: e.pointerId, touch: e.pointerType !== "mouse" };
  if (taskDrag.touch) {
    taskDrag.timer = setTimeout(() => {
      if (taskDrag && !taskDrag.active) beginTaskDrag(card, taskDrag.startX, taskDrag.startY);
    }, 280);
  }
});

document.addEventListener("pointermove", e => {
  if (!taskDrag || e.pointerId !== taskDrag.pointerId) return;
  const dist = Math.hypot(e.clientX - taskDrag.startX, e.clientY - taskDrag.startY);
  if (!taskDrag.active) {
    if (taskDrag.touch) {
      if (dist > 8) { clearTimeout(taskDrag.timer); taskDrag = null; } // user is scrolling
      return;
    }
    if (dist < 5) return;
    beginTaskDrag(taskDrag.card, e.clientX, e.clientY);
  }
  e.preventDefault();
  moveTaskDrag(e.clientX, e.clientY);
}, { passive: false });

// Block native scrolling while a touch drag is active
document.addEventListener("touchmove", e => { if (taskDrag?.active) e.preventDefault(); }, { passive: false });

function finishTaskPointer(e) {
  if (!taskDrag || e.pointerId !== taskDrag.pointerId) return;
  clearTimeout(taskDrag.timer);
  if (taskDrag.active) endTaskDrag();
  else taskDrag = null;
}
document.addEventListener("pointerup", finishTaskPointer);
document.addEventListener("pointercancel", finishTaskPointer);

/* Season kickoff: purchases dated on/after this are in-season, earlier ones are offseason */
const SEASON_KICKOFF = "2027-01-09";
const SEASON_YEAR = SEASON_KICKOFF.slice(0, 4);
const KICKOFF_LABEL = new Date(SEASON_KICKOFF + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

{
  const pill = $("#spending-inseason-pill"); if (pill) pill.textContent = `In-Season ${SEASON_YEAR} (${KICKOFF_LABEL}+)`;
  const lbl = $("#spending-kickoff-label"); if (lbl) lbl.textContent = `Kickoff Threshold: ${KICKOFF_LABEL}`;
  const opt = $("#spend-season-auto-option"); if (opt) opt.textContent = `Auto (Kickoff is ${KICKOFF_LABEL})`;
}

/* Helper: determine season period */
function getSeasonPeriod(orderDate, chosenPeriod) {
  if (chosenPeriod && chosenPeriod !== "auto") return chosenPeriod;
  if (!orderDate) return "inseason";
  return orderDate < SEASON_KICKOFF ? "offseason" : "inseason";
}

/* Render Spending (admins and moderators) */
function renderSpending() {
  if (!isStaff()) return;

  // Filter based on period tab
  const filtered = allSpending.filter(s => {
    const period = s.season_period || getSeasonPeriod(s.order_date);
    if (spendingPeriodFilter === "inseason") return period === "inseason";
    if (spendingPeriodFilter === "offseason") return period === "offseason";
    return true;
  });

  const total = filtered.reduce((sum, s) => sum + Number(s.amount || 0), 0);
  const elSta = $("#spending-total-amt"); if (elSta) elSta.textContent = "$" + total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const elStc = $("#spending-total-count"); if (elStc) elStc.textContent = filtered.length;

  const elLbl = $("#spending-total-label");
  if (elLbl) {
    if (spendingPeriodFilter === "inseason") elLbl.textContent = `${SEASON_YEAR} IN-SEASON TOTAL SPENT`;
    else if (spendingPeriodFilter === "offseason") elLbl.textContent = "OFFSEASON TOTAL SPENT";
    else elLbl.textContent = "ALL-TIME TOTAL SPENT";
  }

  // Find top vendor in filtered set
  const vendorTotals = {};
  filtered.forEach(s => {
    const v = s.vendor || "Other";
    vendorTotals[v] = (vendorTotals[v] || 0) + Number(s.amount || 0);
  });
  let topV = "None", maxV = 0;
  for (const [v, amt] of Object.entries(vendorTotals)) {
    if (amt > maxV) { maxV = amt; topV = v; }
  }
  const elStv = $("#spending-top-vendor"); if (elStv) elStv.textContent = topV + (maxV > 0 ? ` ($${maxV.toFixed(0)})` : '');

  const list = $("#spending-list");
  if (!list) return;

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">No purchases found for "${spendingPeriodFilter === 'all' ? 'All' : spendingPeriodFilter}". Click "＋ Record Purchase" to track orders!</div>`;
    return;
  }

  list.innerHTML = filtered.map(s => {
    const period = s.season_period || getSeasonPeriod(s.order_date);
    const hasReceipt = Boolean(s.receipt_data || s.receipt_url);
    const historyCount = Array.isArray(s.edit_history) ? s.edit_history.length : 0;

    return `
    <article class="itemrow spend-row" style="grid-template-columns: 105px minmax(180px, 2fr) minmax(110px, 1.1fr) minmax(100px, 1fr) 95px 105px 110px;">
      <div class="mono small muted spend-date">${s.order_date || '—'}</div>
      <div class="spend-main">
        <div class="itemname" style="display:flex; align-items:center; gap:6px;">
          <span>${esc(s.title)}</span>
          ${historyCount > 0 ? `<button class="actionbtn" data-action="view-history" data-id="${s.id}" style="font-size:10px; padding:1px 6px; border-radius:4px; background:rgba(245, 158, 11, 0.15); color:#fbbf24; border:1px solid rgba(245, 158, 11, 0.3);" title="View ${historyCount} version edit(s)">v${historyCount + 1} history</button>` : ''}
        </div>
        <div class="itemnotes">${s.order_number ? `PO: ${esc(s.order_number)} · ` : ''}${esc(s.notes || "No notes")}</div>
      </div>
      <div class="spend-vendor"><b>${esc(s.vendor)}</b></div>
      <div class="spend-period">
        ${period === 'inseason'
          ? '<span class="pill" style="background:rgba(16, 185, 129, 0.15); color:#34d399; border:1px solid rgba(16, 185, 129, 0.3);"><i class=fa-bolt aria-hidden=true></i> In-Season</span>'
          : '<span class="pill" style="background:rgba(148, 163, 184, 0.15); color:#cbd5e1; border:1px solid rgba(148, 163, 184, 0.3);"><i class=fa-screwdriver-wrench aria-hidden=true></i> Offseason</span>'
        }
      </div>
      <div class="spend-receipt">
        ${hasReceipt ? `
          <button type="button" class="actionbtn" data-action="view-receipt" data-id="${s.id}" style="color:#60a5fa; border:1px solid rgba(96, 165, 250, 0.3); background:rgba(96, 165, 250, 0.1); padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600;" title="View attached receipt / card charge"><i class=fa-camera aria-hidden=true></i> View</button>
        ` : `
          <span class="small" style="color:#f87171; font-weight:600;" title="Receipt screenshot required — click to attach"><i class=fa-triangle-exclamation aria-hidden=true></i> Needed</span>
        `}
      </div>
      <div class="spend-amount"><strong class="mono" style="color:var(--green); font-size:14px;">$${Number(s.amount).toFixed(2)}</strong></div>
      <div class="actions spend-actions" style="display:flex; gap:4px; justify-content:flex-end;">
        <button class="actionbtn" data-action="edit-spending" data-id="${s.id}" title="Edit purchase order"><i class=fa-pen aria-hidden=true></i></button>
        <button class="actionbtn delete" data-action="delete-spending" data-id="${s.id}" title="Delete record"><i class=fa-trash-can aria-hidden=true></i></button>
      </div>
    </article>
  `}).join("");
}

/* Load Admin Members List */
async function loadMembers() {
  if (!supabase || !currentProfile?.is_admin) return;
  const list = $("#admin-members-list");
  const { data, error } = await supabase.from("profiles").select("*").order("created_at");
  if (error) {
    if (list) list.innerHTML = `<div style="padding:20px;" class="muted">Could not load members: ${esc(error.message)}</div>`;
    return;
  }

  const pending = (data || []).filter(p => !p.is_approved);
  const active = (data || []).filter(p => p.is_approved);
  teamMembers = active.map(p => ({ id: p.id, full_name: p.full_name, departments: p.departments || [] }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const elBm = $("#badge-members"); if (elBm) elBm.textContent = pending.length;

  if (!list) return;

  let html = '';
  if (pending.length) {
    html += '<div style="padding:14px 20px; background:rgba(251, 191, 36, .1); font-weight:700; color:var(--amber); font-size:12px; border-bottom:1px solid var(--line);">WAITING FOR APPROVAL (' + pending.length + ')</div>';
    html += pending.map(p => `
      <div class="itemrow" style="grid-template-columns: 2fr 1.5fr auto;">
        <div>
          <b>${esc(p.full_name)}</b>
          <div class="muted small mono">Registered ${new Date(p.created_at).toLocaleDateString()}</div>
        </div>
        <span class="pill" style="border-color:var(--amber); color:var(--amber)">Pending</span>
        <div>
          <button class="btn btn--primary btn--sm" data-action="approve-member" data-id="${p.id}" data-name="${esc(p.full_name)}">Approve</button>
        </div>
      </div>
    `).join("");
  }

  html += '<div style="padding:14px 20px; background:rgba(255,255,255,.02); font-weight:700; font-size:12px; border-bottom:1px solid var(--line);">APPROVED TEAM MEMBERS (' + active.length + ')</div>';
  html += active.map(p => {
    const depts = (p.departments && p.departments.length) ? p.departments.join(", ") : "Mechanical";
    return `
      <div class="itemrow" style="grid-template-columns: 2fr 1fr auto;">
        <div>
          <b>${esc(p.full_name)}</b>
          ${p.is_admin ? '<span class="pill" style="border-color:var(--accent-bright); color:var(--accent-bright); font-size:10px;">Admin</span>' : ''}
          <div class="muted small mono">${depts} ${p.id === currentUser.id ? '(You)' : ''}</div>
        </div>
        <div class="role-toggles">
          ${[["is_admin", "Admin"], ["is_moderator", "Moderator"], ["is_strategy", "Strategy"], ["is_secret", "Secret"]].map(([flag, label]) => `
            <label class="role-toggle ${p[flag] ? "is-on" : ""}" title="${p.id === currentUser.id && flag === "is_admin" ? "You can't remove your own admin role" : `Toggle ${label} for ${esc(p.full_name)}`}">
              <input type="checkbox" data-role-flag="${flag}" data-id="${p.id}" data-name="${esc(p.full_name)}" ${p[flag] ? "checked" : ""} ${p.id === currentUser.id && flag === "is_admin" ? "disabled" : ""}>
              <span>${label}</span>
            </label>`).join("")}
        </div>
        <div style="display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;">
          ${p.id !== currentUser.id ? `
            <button class="btn btn--danger btn--sm" data-action="revoke-member" data-id="${p.id}" data-name="${esc(p.full_name)}">Revoke</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join("");

  list.innerHTML = html;
}

/* Load Admin Audit Logs */
let allAuditLogs = [];

function formatActionBadge(action) {
  const icons = {
    ITEM_CREATED: "<i class=fa-box aria-hidden=true></i> ITEM ADDED",
    ITEM_UPDATED: "<i class=fa-arrows-rotate aria-hidden=true></i> ITEM UPDATED",
    ITEM_DELETED: "<i class=fa-trash-can aria-hidden=true></i> ITEM REMOVED",
    TOOL_CHECKOUT: "<i class=fa-screwdriver-wrench aria-hidden=true></i> TOOL BORROWED",
    TOOL_CHECKIN: "<i class=fa-rotate-left aria-hidden=true></i> TOOL RETURNED",
    PLANNER_TASK_CREATED: "<i class=fa-clipboard-list aria-hidden=true></i> TASK CREATED",
    PLANNER_TASK_UPDATED: "<i class=fa-bolt aria-hidden=true></i> TASK UPDATED",
    PLANNER_TASK_COMPLETED: "<i class=fa-circle-check aria-hidden=true></i> TASK FINISHED",
    PLANNER_TASK_DELETED: "<i class=fa-trash-can aria-hidden=true></i> TASK REMOVED",
    PART_NEEDED_CREATED: "<i class=fa-cart-shopping aria-hidden=true></i> PART REQUESTED",
    PART_STATUS_UPDATED: "<i class=fa-tag aria-hidden=true></i> PART STATUS",
    PART_NEEDED_DELETED: "<i class=fa-trash-can aria-hidden=true></i> PART REMOVED",
    SPENDING_RECORDED: "<i class=fa-sack-dollar aria-hidden=true></i> SPENDING ADDED",
    SPENDING_DELETED: "<i class=fa-trash-can aria-hidden=true></i> SPENDING REMOVED",
    SHIFT_CREATED: "<i class=fa-calendar-days aria-hidden=true></i> SHIFT SCHEDULED",
    SHIFT_ATTENDED: "<i class=fa-hand aria-hidden=true></i> SHIFT SIGNUP",
    SHIFT_LEFT: "<i class=fa-person-walking-arrow-right aria-hidden=true></i> LEFT SHIFT",
    SHIFT_ATTENDEE_REMOVED: "<i class=fa-ban aria-hidden=true></i> ROSTER REMOVAL",
    SHIFT_DELETED: "<i class=fa-trash-can aria-hidden=true></i> SHIFT REMOVED",
    PLAYBOOK_SAVED: "<i class=fa-bullseye aria-hidden=true></i> PLAYBOOK SAVED",
    PLAYBOOK_DELETED: "<i class=fa-trash-can aria-hidden=true></i> PLAYBOOK REMOVED",
    SCOUTING_SUBMITTED: "<i class=fa-chart-column aria-hidden=true></i> MATCH SCOUTED",
    SCOUTING_DELETED: "<i class=fa-trash-can aria-hidden=true></i> SCOUT RECORD REMOVED",
    MEMBER_APPROVED: "<i class=fa-circle-check aria-hidden=true></i> ACCESS APPROVED",
    MEMBER_REVOKED: "<i class=fa-ban aria-hidden=true></i> ACCESS REVOKED",
    USER_LOGIN: "<i class=fa-key aria-hidden=true></i> USER SIGNED IN"
  };
  const label = icons[action] || action.replace(/_/g, " ");
  return `<span class="logaction ${esc(action)}">${label}</span>`;
}

function renderVerboseLogDetails(log) {
  const a = log.action;
  const d = log.details || {};
  let narrative = "";
  let pills = [];

  switch (a) {
    case "ITEM_CREATED":
      narrative = `Added new catalog item: <strong>${esc(d.name || "Item")}</strong> (${esc(d.qty != null ? d.qty : 0)} ${esc(d.unit || "pcs")})`;
      if (d.category) pills.push(`<b>Category:</b> ${esc(d.category)}`);
      if (d.location) pills.push(`<b>Location:</b> ${esc(d.location)}`);
      if (d.is_tool) pills.push(`<b>Type:</b> Shop Tool`);
      if (d.part_number) pills.push(`<b>P/N:</b> ${esc(d.part_number)}`);
      if (d.min_quantity) pills.push(`<b>Min Qty:</b> ${esc(d.min_quantity)}`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;

    case "ITEM_UPDATED":
      if (d.delta != null) {
        const sign = Number(d.delta) > 0 ? `+${d.delta}` : `${d.delta}`;
        const diffClass = Number(d.delta) >= 0 ? "pos" : "neg";
        narrative = `Adjusted inventory quantity for <strong>${esc(d.name || "Item")}</strong>: <span class="log-diff-pill ${diffClass}">${sign}</span> → New total: <strong>${esc(d.qty != null ? d.qty : (d.new_qty != null ? d.new_qty : 0))} ${esc(d.unit || "pcs")}</strong>`;
        if (d.previous_qty != null) pills.push(`<b>Previous:</b> ${esc(d.previous_qty)}`);
        if (d.location) pills.push(`<b>Location:</b> ${esc(d.location)}`);
      } else {
        narrative = `Updated item details for <strong>${esc(d.name || "Item")}</strong>`;
        if (d.qty != null) pills.push(`<b>Quantity:</b> ${esc(d.qty)} ${esc(d.unit || "pcs")}`);
        if (d.category) pills.push(`<b>Category:</b> ${esc(d.category)}`);
        if (d.location) pills.push(`<b>Location:</b> ${esc(d.location)}`);
        if (d.is_tool != null) pills.push(`<b>Type:</b> ${d.is_tool ? "Shop Tool" : "Component"}`);
        if (d.part_number) pills.push(`<b>P/N:</b> ${esc(d.part_number)}`);
        if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      }
      break;

    case "ITEM_DELETED":
      narrative = `Removed item <strong>${esc(d.name || "Item")}</strong> permanently from inventory catalog.`;
      if (d.category) pills.push(`<b>Category:</b> ${esc(d.category)}`);
      if (d.quantity != null) pills.push(`<b>Had Quantity:</b> ${esc(d.quantity)}`);
      if (d.location) pills.push(`<b>Stored at:</b> ${esc(d.location)}`);
      break;

    case "TOOL_CHECKOUT":
      narrative = `Checked out <strong>${esc(d.qty || 1)} × ${esc(d.name || "Tool")}</strong> from shop stock.`;
      if (d.user_name) pills.push(`<b>Borrower:</b> ${esc(d.user_name)}`);
      if (d.expected_return) pills.push(`<b>Due Back:</b> ${esc(d.expected_return)}`);
      if (d.notes) pills.push(`<b>Purpose:</b> ${esc(d.notes)}`);
      break;

    case "TOOL_CHECKIN":
      narrative = `Returned <strong>${esc(d.qty || 1)} × ${esc(d.name || "Tool")}</strong> back to shop inventory.`;
      if (d.user_name) pills.push(`<b>Returned By:</b> ${esc(d.user_name)}`);
      if (d.duration) pills.push(`<b>Duration:</b> ${esc(d.duration)}`);
      break;

    case "PLANNER_TASK_CREATED":
      narrative = `Created team task: <strong>${esc(d.title || "Task")}</strong>`;
      if (d.subsystem) pills.push(`<b>Subsystem:</b> ${esc(d.subsystem)}`);
      if (d.priority) pills.push(`<b>Priority:</b> ${esc(d.priority.toUpperCase())}`);
      if (d.status) pills.push(`<b>Initial Status:</b> ${esc(d.status)}`);
      if (d.assigned_to) pills.push(`<b>Assignee:</b> ${esc(d.assigned_to)}`);
      if (d.due_date) pills.push(`<b>Due:</b> ${esc(d.due_date)}`);
      if (d.description) pills.push(`<b>Desc:</b> ${esc(d.description)}`);
      break;

    case "PLANNER_TASK_UPDATED":
    case "PLANNER_TASK_COMPLETED":
      if (d.previous_status && d.new_status) {
        narrative = `Task <strong>${esc(d.title || "Task")}</strong> moved: <span class="pill" style="font-size:10px;">${esc(d.previous_status)}</span> ➔ <span class="pill" style="font-size:10px; color:var(--accent-bright);">${esc(d.new_status)}</span>`;
      } else {
        narrative = `${a === "PLANNER_TASK_COMPLETED" ? "Completed" : "Updated"} task: <strong>${esc(d.title || "Task")}</strong> (Status: ${esc(d.status || "in_progress")})`;
      }
      if (d.subsystem) pills.push(`<b>Subsystem:</b> ${esc(d.subsystem)}`);
      if (d.priority) pills.push(`<b>Priority:</b> ${esc(d.priority)}`);
      if (d.assigned_to) pills.push(`<b>Assignee:</b> ${esc(d.assigned_to)}`);
      if (d.due_date) pills.push(`<b>Due:</b> ${esc(d.due_date)}`);
      break;

    case "PLANNER_TASK_DELETED":
      narrative = `Deleted task <strong>${esc(d.title || "Task")}</strong> from team planner board.`;
      if (d.subsystem) pills.push(`<b>Subsystem:</b> ${esc(d.subsystem)}`);
      break;

    case "PART_NEEDED_CREATED":
      narrative = `Requested robot order: <strong>${esc(d.quantity || 1)} × ${esc(d.part_name || "Part")}</strong>`;
      if (d.subsystem) pills.push(`<b>Subsystem:</b> ${esc(d.subsystem)}`);
      if (d.vendor) pills.push(`<b>Vendor:</b> ${esc(d.vendor)}`);
      if (d.priority) pills.push(`<b>Priority:</b> ${esc(d.priority)}`);
      if (d.estimated_cost != null && Number(d.estimated_cost) > 0) pills.push(`<b>Est Cost:</b> $${Number(d.estimated_cost).toFixed(2)}`);
      if (d.part_number) pills.push(`<b>P/N:</b> ${esc(d.part_number)}`);
      if (d.url) pills.push(`<b>Link:</b> <a href="${esc(d.url)}" target="_blank" rel="noopener" style="color:var(--accent-soft); text-decoration:underline;">Product Page</a>`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;

    case "PART_STATUS_UPDATED":
      if (d.previous_status && d.new_status) {
        narrative = `Updated tracking for <strong>${esc(d.part_name || "Part")}</strong>: <span class="pill" style="font-size:10px;">${esc(d.previous_status)}</span> ➔ <strong style="color:var(--accent-bright);">${esc(d.new_status)}</strong>`;
      } else {
        narrative = `Updated tracking for <strong>${esc(d.part_name || "Part")}</strong> to status: <strong style="color:var(--accent-bright);">${esc(d.status || d.new_status)}</strong>`;
      }
      if (d.vendor) pills.push(`<b>Vendor:</b> ${esc(d.vendor)}`);
      if (d.quantity) pills.push(`<b>Qty:</b> ${esc(d.quantity)}`);
      break;

    case "PART_NEEDED_DELETED":
      narrative = `Removed <strong>${esc(d.part_name || "Part")}</strong> from parts ordering queue.`;
      if (d.vendor) pills.push(`<b>Vendor:</b> ${esc(d.vendor)}`);
      if (d.quantity) pills.push(`<b>Qty:</b> ${esc(d.quantity)}`);
      break;

    case "SPENDING_RECORDED":
      narrative = `Logged PO purchase: <strong>${esc(d.title || "Purchase")}</strong> for <strong>$${Number(d.amount || 0).toFixed(2)}</strong> at <strong>${esc(d.vendor || "Vendor")}</strong>`;
      if (d.category) pills.push(`<b>Category:</b> ${esc(d.category)}`);
      if (d.order_number) pills.push(`<b>PO / Order #:</b> ${esc(d.order_number)}`);
      if (d.order_date) pills.push(`<b>Date:</b> ${esc(d.order_date)}`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;

    case "SPENDING_DELETED":
      narrative = `Deleted spending record <strong>${esc(d.title || "Record")}</strong> ($${Number(d.amount || 0).toFixed(2)} at ${esc(d.vendor || "Vendor")}).`;
      break;

    case "SHIFT_CREATED":
      narrative = `Scheduled lab shift: <strong>${esc(d.title || "Lab Shift")}</strong> (${esc(d.shift_date || "")} · ${esc(d.start_time || "")} - ${esc(d.end_time || "")})`;
      if (d.department) pills.push(`<b>Dept:</b> ${esc(d.department)}`);
      if (d.location) pills.push(`<b>Location:</b> ${esc(d.location)}`);
      if (d.repeatWeekly) pills.push(`<b>Recurring:</b> ${esc(d.repeatCount || 4)} weeks series`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;

    case "SHIFT_ATTENDED":
      narrative = `<strong>${esc(d.member_name || log.user_name)}</strong> signed up for lab shift: <strong>${esc(d.shift_title || "Shift")}</strong> on ${esc(d.shift_date || "")}`;
      if (d.department) pills.push(`<b>Dept:</b> ${esc(d.department)}`);
      if (d.location) pills.push(`<b>Location:</b> ${esc(d.location)}`);
      break;

    case "SHIFT_LEFT":
      narrative = `<strong>${esc(d.member_name || log.user_name)}</strong> removed themselves from shift: <strong>${esc(d.shift_title || "Shift")}</strong> on ${esc(d.shift_date || "")}`;
      if (d.department) pills.push(`<b>Dept:</b> ${esc(d.department)}`);
      break;

    case "SHIFT_ATTENDEE_REMOVED":
      narrative = `Removed <strong>${esc(d.removed_attendee || "Member")}</strong> from shift roster: <strong>${esc(d.shift_title || "Shift")}</strong>`;
      break;

    case "SHIFT_DELETED":
      narrative = `Removed lab shift <strong>${esc(d.title || "Shift")}</strong> on ${esc(d.shift_date || "")} from schedule.${d.series ? " (Deleted entire weekly series)" : ""}`;
      if (d.department) pills.push(`<b>Dept:</b> ${esc(d.department)}`);
      break;

    case "PLAYBOOK_SAVED":
      narrative = `Saved strategy whiteboard play: <strong>${esc(d.play_name || "Play")}</strong>`;
      if (d.strokes_count != null) pills.push(`<b>Strokes Drawn:</b> ${esc(d.strokes_count)}`);
      if (d.match_context) pills.push(`<b>Context:</b> ${esc(d.match_context)}`);
      break;

    case "PLAYBOOK_DELETED":
      narrative = `Deleted saved playbook: <strong>${esc(d.play_name || "Play")}</strong>`;
      break;

    case "SCOUTING_SUBMITTED":
      narrative = `Logged match scouting data for <strong>Team ${esc(d.team_num || "")}</strong> in <strong>Match ${esc(d.match_type || "Q")}${esc(d.match_num || "")}</strong> (${esc(d.event_name || "Competition")})`;
      if (d.est_points != null) pills.push(`<b>Est Points:</b> <strong style="color:var(--green);">${esc(d.est_points)}</strong>`);
      if (d.auto_fuel != null) pills.push(`<b>Auto Fuel:</b> ${esc(d.auto_fuel)}`);
      if (d.tele_fuel != null) pills.push(`<b>Teleop Fuel:</b> ${esc(d.tele_fuel)}`);
      if (d.climb) pills.push(`<b>Endgame Climb:</b> ${esc(d.climb)}`);
      if (d.died) pills.push(`<b style="color:#f87171;">ROBOT BROKE</b>`);
      if (d.scout_name) pills.push(`<b>Scout:</b> ${esc(d.scout_name)}`);
      if (d.station) pills.push(`<b>Station:</b> ${esc(d.station)}`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;

    case "SCOUTING_DELETED":
      narrative = `Deleted match scouting log for <strong>Team ${esc(d.team_num || "")}</strong> (Match ${esc(d.match_type || "Q")}${esc(d.match_num || "")})`;
      break;

    case "MEMBER_APPROVED":
      narrative = `Granted verified team access to <strong>${esc(d.member_name || "Member")}</strong>`;
      if (d.email) pills.push(`<b>Email:</b> ${esc(d.email)}`);
      break;

    case "MEMBER_REVOKED":
      narrative = `Revoked workspace access for <strong>${esc(d.member_name || "Member")}</strong>`;
      break;

    case "USER_LOGIN":
      narrative = `Authenticated session for <strong>${esc(log.user_name || "Team Member")}</strong>`;
      if (d.email) pills.push(`<b>Email:</b> ${esc(d.email)}`);
      if (d.ip) pills.push(`<b>Origin:</b> ${esc(d.ip)}`);
      break;

    default:
      narrative = `Performed <strong>${esc(a)}</strong> on ${esc(log.entity_type || "system")}`;
      if (d.title) pills.push(`<b>Title:</b> ${esc(d.title)}`);
      if (d.name) pills.push(`<b>Name:</b> ${esc(d.name)}`);
      if (d.part_name) pills.push(`<b>Part:</b> ${esc(d.part_name)}`);
      if (d.amount != null) pills.push(`<b>Amount:</b> $${Number(d.amount).toFixed(2)}`);
      if (d.qty != null) pills.push(`<b>Qty:</b> ${esc(d.qty)}`);
      if (d.status) pills.push(`<b>Status:</b> ${esc(d.status)}`);
      if (d.notes) pills.push(`<b>Notes:</b> ${esc(d.notes)}`);
      break;
  }

  const pillsHtml = pills.length ? `<div class="log-pill-cloud">${pills.map(p => `<span class="log-pill">${p}</span>`).join("")}</div>` : "";
  const rawJson = JSON.stringify(d, null, 2);
  const rawDetailsHtml = Object.keys(d).length > 0 ? `
    <details class="log-raw-details">
      <summary>View Raw JSON Payload ▾</summary>
      <pre>${esc(rawJson)}</pre>
    </details>
  ` : "";

  return `
    <div>
      <div class="log-narrative">${narrative}</div>
      ${pillsHtml}
      ${rawDetailsHtml}
    </div>
  `;
}

function renderAuditLogs() {
  const list = $("#logs-list");
  if (!list) return;

  const searchTerm = ($("#log-search-input")?.value || "").toLowerCase().trim();
  const filterCat = $("#log-action-filter")?.value || "ALL";

  let filtered = allAuditLogs;

  if (filterCat !== "ALL") {
    filtered = filtered.filter(log => {
      const a = log.action || "";
      if (filterCat === "INVENTORY") return a.startsWith("ITEM_");
      if (filterCat === "CHECKOUTS") return a.startsWith("TOOL_");
      if (filterCat === "PLANNER") return a.startsWith("PLANNER_");
      if (filterCat === "PARTS") return a.startsWith("PART_");
      if (filterCat === "SHIFTS") return a.startsWith("SHIFT_");
      if (filterCat === "SPENDING") return a.startsWith("SPENDING_");
      if (filterCat === "STRATEGY") return a.startsWith("PLAYBOOK_");
      if (filterCat === "SCOUTING") return a.startsWith("SCOUTING_");
      if (filterCat === "MEMBERS") return a.startsWith("MEMBER_");
      return true;
    });
  }

  if (searchTerm) {
    filtered = filtered.filter(log => {
      const actor = (log.user_name || "").toLowerCase();
      const action = (log.action || "").toLowerCase();
      const detailsStr = JSON.stringify(log.details || {}).toLowerCase();
      return actor.includes(searchTerm) || action.includes(searchTerm) || detailsStr.includes(searchTerm);
    });
  }

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">${allAuditLogs.length ? "No matching audit log entries found for current filters." : "No activity logged yet."}</div>`;
    return;
  }

  list.innerHTML = filtered.map(log => {
    const dObj = new Date(log.created_at);
    const dateFormatted = dObj.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const timeFormatted = dObj.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    return `
      <article class="logrow">
        <div class="logtime">
          <strong>${dateFormatted}</strong><br>
          <span style="opacity:0.8;">${timeFormatted}</span>
        </div>
        <div>
          ${formatActionBadge(log.action)}
        </div>
        <div>
          ${renderVerboseLogDetails(log)}
        </div>
        <div style="padding-top:2px;">
          <strong class="mono small" style="color:var(--accent-bright); display:block; word-break:break-word;">${esc(log.user_name || "Member")}</strong>
          <small class="muted" style="font-size:10px;">${esc(log.entity_type || "")}</small>
        </div>
      </article>
    `;
  }).join("");
}

async function loadLogs() {
  if (!supabase || !currentProfile?.is_admin) return;
  const list = $("#logs-list");
  if (!list) return;
  list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">Loading audit records…</div>';

  const { data, error } = await supabase
    .from("activity_logs")
    .select("id, action, entity_type, entity_id, details, user_name, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">Could not load logs: ${esc(error.message)}</div>`;
    return;
  }

  allAuditLogs = data || [];
  renderAuditLogs();
}

$("#log-search-input")?.addEventListener("input", renderAuditLogs);
$("#log-action-filter")?.addEventListener("change", renderAuditLogs);

/* Modals */
function openProfileModal() {
  if (!currentProfile) return;
  $("#prof-name").value = currentProfile.full_name || "";
  $("#prof-email").value = currentUser?.email || "";
  const depts = currentProfile.departments || ["Mechanical"];
  $$("input[name='prof-dept']").forEach(cb => {
    cb.checked = depts.includes(cb.value);
  });
  $("#prof-discord").value = currentProfile.discord_id || "";
  loadPinStatus();
  $("#profile-modal").classList.remove("hidden");
  $("#prof-name").focus();

  // Loaded separately so a database without the discord_id column can't break sign-in
  supabase.from("profiles").select("discord_id").eq("id", currentUser.id).single().then(({ data }) => {
    if (data && !$("#prof-discord").value) {
      currentProfile.discord_id = data.discord_id || "";
      $("#prof-discord").value = currentProfile.discord_id;
    }
  });
}

/* Claude MCP connector: personal keys for the Supabase "mcp" edge function */
const MCP_ENDPOINT = `${SUPABASE_URL}/functions/v1/mcp`;
let lastConnectorUrl = "";

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function openClaudeConnect() {
  if (!currentProfile) return;
  $("#claude-connect-who").textContent = `${currentProfile.full_name} (${roleLabel(currentProfile).toLowerCase()})`;
  $("#claude-connect-new").classList.add("hidden");
  $("#claude-connect-url").value = "";
  lastConnectorUrl = "";
  $("#claude-connect-modal").classList.remove("hidden");
  await renderClaudeKeys();
}

async function renderClaudeKeys() {
  const list = $("#claude-key-list");
  list.innerHTML = '<div class="muted small">Loading…</div>';
  const { data, error } = await supabase.from("mcp_tokens")
    .select("id, label, token_hint, created_at, last_used_at")
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    list.innerHTML = `<div class="muted small">Could not load keys: ${esc(error.message)}</div>`;
    return;
  }
  list.innerHTML = data.length ? data.map(k => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; background:rgba(255,255,255,0.04); border:1px solid var(--line-glass); border-radius:8px; padding:10px 12px;">
      <div class="small">
        <b>${esc(k.label)}</b> <span class="mono muted">${esc(k.token_hint)}</span><br>
        <span class="muted">Created ${new Date(k.created_at).toLocaleDateString()} · ${k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : "never used"}</span>
      </div>
      <button class="btn btn--danger btn--sm" type="button" data-revoke-key="${esc(k.id)}">Revoke</button>
    </div>
  `).join("") : '<div class="muted small">No connectors yet. Generate one to link Claude.</div>';
}

async function generateClaudeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = "nyx_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const btn = $("#generate-claude-key-btn");
  btn.disabled = true;
  const { error } = await supabase.from("mcp_tokens").insert({
    user_id: currentUser.id,
    token_hash: await sha256Hex(key),
    token_hint: `${key.slice(0, 8)}…${key.slice(-4)}`,
    label: "Claude"
  });
  btn.disabled = false;
  if (error) {
    toast("Could not create connector: " + error.message, true);
    return;
  }
  await logAction("MCP_CONNECTOR_CREATED", "mcp_tokens", null, { member_name: currentProfile?.full_name });
  lastConnectorUrl = `${MCP_ENDPOINT}?key=${key}`;
  $("#claude-connect-url").value = lastConnectorUrl;
  $("#claude-connect-new").classList.remove("hidden");
  await renderClaudeKeys();
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied.`);
  } catch {
    toast("Copy failed — select the text and copy it manually.", true);
  }
}

$("#open-claude-connect-btn")?.addEventListener("click", openClaudeConnect);
$("#close-claude-connect-modal")?.addEventListener("click", () => $("#claude-connect-modal").classList.add("hidden"));
$("#generate-claude-key-btn")?.addEventListener("click", generateClaudeKey);
$("#copy-claude-url-btn")?.addEventListener("click", () => copyText(lastConnectorUrl, "Connector URL"));
$("#copy-claude-code-cmd-btn")?.addEventListener("click", () => copyText(`claude mcp add --transport http nyx-dashboard "${lastConnectorUrl}"`, "Claude Code command"));
$("#claude-key-list")?.addEventListener("click", async e => {
  const id = e.target.closest("[data-revoke-key]")?.dataset.revokeKey;
  if (!id || !confirm("Revoke this connector? Claude will lose access immediately.")) return;
  const { error } = await supabase.from("mcp_tokens").update({ revoked_at: new Date().toISOString() }).eq("id", id);
  if (error) {
    toast("Could not revoke: " + error.message, true);
    return;
  }
  await logAction("MCP_CONNECTOR_REVOKED", "mcp_tokens", id, { member_name: currentProfile?.full_name });
  toast("Connector revoked.");
  await renderClaudeKeys();
});

function closeProfileModal() {
  $("#profile-modal").classList.add("hidden");
}

function openShiftModal(shift, prefill) {
  if (!isStaff()) {
    toast("Only admins and moderators can schedule or edit shifts.", true);
    return;
  }
  editingShiftId = shift ? shift.id : null;
  $("#shift-form").reset();
  $("#shift-modal-title").textContent = shift ? "Edit Shift" : "Schedule Shift";
  $("#save-shift-btn").textContent = shift ? "Save Changes ↗" : "Schedule Shift";
  $("#shift-title").value = shift ? shift.title : "";
  $("#shift-dept").value = shift ? shift.department : (activeShiftDept !== "All" ? activeShiftDept : "Mechanical");
  $("#shift-date").value = shift ? shift.shift_date : new Date().toISOString().slice(0, 10);
  $("#shift-start").value = shift ? shift.start_time : "16:00";
  $("#shift-end").value = shift ? shift.end_time : "19:30";
  $("#shift-location").value = shift ? (shift.location || "Main Shop") : "Main Shop";
  $("#shift-notes").value = shift ? (shift.notes || "").replace("[🔁 Weekly Shift]", "").trim() : "";

  if (!shift && prefill) {
    $("#shift-date").value = prefill.shift_date;
    $("#shift-start").value = prefill.start_time;
    $("#shift-end").value = prefill.end_time;
  }
  shiftAssignSelected = new Set(shift ? (shift.attendees || []) : [myShiftName()]);
  const ftm = $("#shift-full-team");
  if (ftm) ftm.checked = !!shift && shift.department === "All Departments" && teamMembers.length > 0 && teamMembers.every(m => (shift.attendees || []).includes(m.full_name));
  $("#shift-assign-search").value = "";
  renderShiftAssignList();

  const recurrenceRow = $("#shift-recurrence-row");
  if (recurrenceRow) recurrenceRow.classList.toggle("hidden", !!shift);
  const repeatCb = $("#shift-repeat-weekly");
  if (repeatCb) repeatCb.checked = false;
  const repeatOpts = $("#shift-repeat-options");
  if (repeatOpts) repeatOpts.classList.add("hidden");

  $("#shift-modal").classList.remove("hidden");
  $("#shift-title").focus();
}

/* Admin member picker inside the shift modal */
function renderShiftAssignList() {
  const list = $("#shift-assign-list");
  if (!list) return;
  const q = ($("#shift-assign-search")?.value || "").trim().toLowerCase();
  const known = new Set(teamMembers.map(m => m.full_name));
  // Keep people already on the roster even if they are not in the member list (e.g. renamed)
  const extra = [...shiftAssignSelected].filter(n => !known.has(n)).map(n => ({ full_name: n, departments: [] }));
  const people = [...teamMembers, ...extra].filter(m => !q || m.full_name.toLowerCase().includes(q) || m.departments.join(" ").toLowerCase().includes(q));

  list.innerHTML = people.length ? people.map(m => `
    <label class="assign-chip ${shiftAssignSelected.has(m.full_name) ? "is-on" : ""}">
      <input type="checkbox" value="${esc(m.full_name)}" ${shiftAssignSelected.has(m.full_name) ? "checked" : ""}>
      <span>${esc(m.full_name)}</span>
      ${m.departments.length ? `<small>${esc(m.departments.map(d => d.slice(0, 4)).join(" · "))}</small>` : ""}
    </label>
  `).join("") : `<div class="muted small" style="padding:8px;">${teamMembers.length ? "No members match." : "Member list not loaded yet."}</div>`;
  $("#shift-assign-count").textContent = `(${shiftAssignSelected.size})`;
}

$("#shift-assign-list")?.addEventListener("change", e => {
  const cb = e.target.closest("input[type=checkbox]");
  if (!cb) return;
  cb.checked ? shiftAssignSelected.add(cb.value) : shiftAssignSelected.delete(cb.value);
  cb.closest(".assign-chip")?.classList.toggle("is-on", cb.checked);
  $("#shift-assign-count").textContent = `(${shiftAssignSelected.size})`;
});
$("#shift-assign-search")?.addEventListener("input", renderShiftAssignList);
/* Full team meeting: whole team, everyone marked as attending */
$("#shift-full-team")?.addEventListener("change", e => {
  if (e.target.checked) {
    $("#shift-dept").value = "All Departments";
    teamMembers.forEach(m => shiftAssignSelected.add(m.full_name));
  }
  renderShiftAssignList();
});
$("#shift-assign-quick")?.addEventListener("click", e => {
  const mode = e.target.closest("[data-assign-dept]")?.dataset.assignDept;
  if (!mode) return;
  if (mode === "__clear") {
    shiftAssignSelected.clear();
    $("#shift-full-team").checked = false;
  } else if (mode === "__all") {
    teamMembers.forEach(m => shiftAssignSelected.add(m.full_name));
  } else {
    const dept = $("#shift-dept").value;
    teamMembers
      .filter(m => dept === "All Departments" || m.departments.includes(dept))
      .forEach(m => shiftAssignSelected.add(m.full_name));
  }
  renderShiftAssignList();
});

function closeShiftModal() {
  $("#shift-modal").classList.add("hidden");
  editingShiftId = null;
}

function openItemModal(item) {
  if (!isStaff()) {
    toast("Only admins and moderators can add or edit inventory items.", true);
    return;
  }
  editingItemId = item ? item.id : null;
  $("#item-form").reset();
  $("#modal-title").textContent = item ? "Edit Inventory Item" : "Add Inventory Item";
  $("#save-item-button").textContent = item ? "Save Changes ↗" : "Save Item ↗";
  $("#item-name").value = item ? item.name : "";
  const defaultCat = isValidCategory(activeCategory) ? activeCategory
    : activeCategory === "ToolsOnly" || activeCategory === OTHER_TOOLS ? (toolCategories()[0]?.name || "Miscellaneous") : "Mechanical";
  fillCategorySelect($("#item-category"), item ? item.category : defaultCat);
  $("#item-is-tool").value = item ? (item.is_tool ? "true" : "false") : (kindOf(defaultCat) === "tool" || activeCategory === "ToolsOnly" ? "true" : "false");
  $("#item-quantity").value = item ? item.quantity : 1;
  $("#item-min-quantity").value = item ? (item.min_quantity ?? 1) : 1;
  $("#item-unit").value = item ? (item.unit || "pcs") : "pcs";
  $("#item-part-number").value = item ? (item.part_number || "") : "";
  $("#item-location").value = item ? (item.location || "") : "";
  $("#item-notes").value = item ? (item.notes || "") : "";
  $("#item-modal").classList.remove("hidden");
  $("#item-name").focus();
}

function closeItemModal() {
  $("#item-modal").classList.add("hidden");
  editingItemId = null;
}

/* Part pickers: inventory + team presets + FRCDesign COTS library */
function vendorNote(entry) {
  const links = vendorLinks(entry.vendors);
  const names = entry.vendorNames.length ? entry.vendorNames.join(" / ") : "vendor unlisted";
  return `COTS · ${entry.category} · ${names}${links.length ? ` (${links.map(l => l[1].replace(/^https?:\/\/(www\.)?/, "")).join(", ")})` : ""}`;
}

attachPartPicker($("#item-name"), {
  getInventory: () => allItems,
  onPick: entry => {
    if (entry.type === "inventory") {
      if (entry.item.id === editingItemId) return;
      if (confirm(`"${entry.item.name}" is already in inventory (${entry.item.quantity} ${entry.item.unit || "pcs"}${entry.item.location ? ` at ${entry.item.location}` : ""}).\n\nOpen it to update the count instead of adding a duplicate?`)) {
        openItemModal(entry.item);
      } else {
        $("#item-name").value = entry.item.name;
      }
      return;
    }
    if (entry.type === "preset") {
      const p = entry.preset;
      $("#item-name").value = p.name || "";
      $("#item-category").value = p.tool ? (toolCategories()[0]?.name || p.cat || "Mechanical") : (p.cat || "Mechanical");
      $("#item-is-tool").value = p.tool ? "true" : "false";
      $("#item-unit").value = p.unit || "pcs";
      $("#item-part-number").value = p.pn || "";
      if (p.notes && !$("#item-notes").value.trim()) $("#item-notes").value = p.notes;
      return;
    }
    $("#item-name").value = entry.name;
    $("#item-category").value = entry.appCategory;
    $("#item-is-tool").value = "false";
    if (!$("#item-notes").value.trim()) $("#item-notes").value = vendorNote(entry);
  }
});

attachPartPicker($("#pn-part-name"), {
  getInventory: () => allItems,
  onPick: entry => {
    $("#pn-part-name").value = entry.name;
    if (entry.type === "inventory") {
      if (entry.item.part_number) $("#pn-part-number").value = entry.item.part_number;
      toast(`We already have ${entry.item.quantity} ${entry.item.unit || "pcs"}${entry.item.location ? ` at ${entry.item.location}` : ""}.`);
    } else if (entry.type === "preset") {
      if (entry.preset.pn) $("#pn-part-number").value = entry.preset.pn;
      $("#pn-subsystem").value = entry.preset.cat === "Electrical" ? "Electrical" : "Mechanical";
    } else {
      $("#pn-subsystem").value = entry.appCategory;
      if (entry.vendorNames.length) $("#pn-vendor").value = entry.vendorNames.join(" / ");
      const link = vendorLinks(entry.vendors)[0];
      if (link && !$("#pn-url").value.trim()) $("#pn-url").placeholder = `Product link (vendor: ${link[1]})`;
    }
  }
});

function openCheckoutModal(item) {
  checkingOutItem = item;
  $("#checkout-form").reset();
  $("#checkout-modal-title").textContent = `Check Out: ${item.name}`;
  $("#checkout-item-desc").textContent = `Available in shop: ${item.quantity} ${item.unit || 'pcs'} · Stored at: ${item.location || 'Shop'}`;
  $("#checkout-qty").max = item.quantity;
  $("#checkout-qty").value = 1;
  $("#checkout-modal").classList.remove("hidden");
  $("#checkout-qty").focus();
}

function closeCheckoutModal() {
  $("#checkout-modal").classList.add("hidden");
  checkingOutItem = null;
}

function openPartNeededModal() {
  if (!isStaff()) return;
  $("#part-needed-form").reset();
  $("#pn-quantity").value = 1;
  $("#pn-cost").value = "0.00";
  $("#part-needed-modal").classList.remove("hidden");
  $("#pn-part-name").focus();
}

function closePartNeededModal() {
  $("#part-needed-modal").classList.add("hidden");
}

function openTaskModal(task) {
  if (!isStaff()) {
    toast("Only admins and moderators can create or edit planner tasks.", true);
    return;
  }
  editingTaskId = task ? task.id : null;
  $("#task-form").reset();
  $("#task-modal-title").textContent = task ? "Edit Planner Task" : "Add Planner Task";
  $("#save-task-btn").textContent = task ? "Save Changes ↗" : "Save Task ↗";
  $("#task-title").value = task ? task.title : "";
  $("#task-subsystem").value = task ? task.subsystem : (activePlannerSubsystem !== "All" ? activePlannerSubsystem : "Mechanical");
  $("#task-priority").value = task ? task.priority : "medium";
  $("#task-status").value = task ? task.status : "todo";
  $("#task-due-date").value = task ? (task.due_date || "") : "";
  $("#task-assignee").value = task ? (task.assigned_to || "") : "";
  $("#task-desc").value = task ? (task.description || "") : "";
  $("#task-modal").classList.remove("hidden");
  $("#task-title").focus();
}

function closeTaskModal() {
  $("#task-modal").classList.add("hidden");
  editingTaskId = null;
}

function openSpendingModal(recordToEdit) {
  if (!isStaff()) return;
  $("#spending-form").reset();
  $("#spend-receipt-data").value = "";
  $("#spend-receipt-file").value = "";
  $("#spend-receipt-preview-wrap").classList.add("hidden");
  $("#spend-receipt-preview-img").src = "";

  const titleEl = $("#spending-modal-title");
  const saveBtn = $("#save-spending-btn");
  const reasonWrap = $("#spend-edit-reason-wrap");
  const reasonInput = $("#spend-edit-reason");

  if (recordToEdit && recordToEdit.id) {
    editingSpendingId = recordToEdit.id;
    if (titleEl) titleEl.textContent = "Edit Purchase Record";
    if (saveBtn) saveBtn.textContent = "Save Changes & Log History";
    if (reasonWrap) reasonWrap.classList.remove("hidden");
    if (reasonInput) {
      reasonInput.required = true;
      reasonInput.value = "";
    }

    $("#spend-title").value = recordToEdit.title || "";
    $("#spend-vendor").value = recordToEdit.vendor || "";
    $("#spend-amount").value = recordToEdit.amount != null ? recordToEdit.amount : "";
    $("#spend-category").value = recordToEdit.category || "Robot Hardware";
    $("#spend-date").value = recordToEdit.order_date || new Date().toISOString().slice(0, 10);
    $("#spend-order-number").value = recordToEdit.order_number || "";
    $("#spend-notes").value = recordToEdit.notes || "";
    const autoPeriod = getSeasonPeriod(recordToEdit.order_date);
    $("#spend-season-period").value = !recordToEdit.season_period || recordToEdit.season_period === autoPeriod ? "auto" : recordToEdit.season_period;

    if (recordToEdit.receipt_data || recordToEdit.receipt_url) {
      const src = recordToEdit.receipt_data || recordToEdit.receipt_url;
      $("#spend-receipt-data").value = src;
      $("#spend-receipt-preview-img").src = src;
      $("#spend-receipt-preview-wrap").classList.remove("hidden");
    }
  } else {
    editingSpendingId = null;
    if (titleEl) titleEl.textContent = "Record Purchase Order";
    if (saveBtn) saveBtn.textContent = "Save Record";
    if (reasonWrap) reasonWrap.classList.add("hidden");
    if (reasonInput) {
      reasonInput.required = false;
      reasonInput.value = "";
    }
    $("#spend-date").value = new Date().toISOString().slice(0, 10);
    $("#spend-season-period").value = "auto";
  }

  $("#spending-modal").classList.remove("hidden");
  $("#spend-title").focus();
}

function closeSpendingModal() {
  $("#spending-modal").classList.add("hidden");
  editingSpendingId = null;
}

/* Save User Profile (Name & Departments) */
$("#profile-form").addEventListener("submit", async e => {
  e.preventDefault();
  const full_name = $("#prof-name").value.trim();
  const selectedDepts = Array.from($$("input[name='prof-dept']:checked")).map(cb => cb.value);

  if (!full_name) {
    toast("Name cannot be empty.", true);
    return;
  }

  const deptsToSave = selectedDepts.length ? selectedDepts : ["Mechanical"];
  const discord_id = $("#prof-discord").value.trim();
  if (discord_id && !/^\d{17,20}$/.test(discord_id)) {
    toast("Discord User ID should be 17–20 digits (Copy User ID in Discord), not your username.", true);
    $("#prof-discord").focus();
    return;
  }

  const btn = $("#save-profile-btn");
  btn.disabled = true;

  const { error } = await supabase.from("profiles").update({
    full_name,
    departments: deptsToSave
  }).eq("id", currentUser.id);

  btn.disabled = false;

  if (error) {
    toast("Failed to update profile: " + error.message, true);
    return;
  }

  if (discord_id !== (currentProfile.discord_id || "")) {
    const { error: discordError } = await supabase.from("profiles").update({ discord_id }).eq("id", currentUser.id);
    if (discordError) toast("Profile saved, but the Discord ID couldn't be: " + discordError.message, true);
    else currentProfile.discord_id = discord_id;
  }

  currentProfile.full_name = full_name;
  currentProfile.departments = deptsToSave;

  const elName = $("#profile-name"); if (elName) elName.textContent = full_name;
  const elAvatar = $("#profile-avatar"); if (elAvatar) elAvatar.textContent = full_name.trim().charAt(0).toUpperCase();
  const elRole = $("#profile-role"); if (elRole) elRole.textContent = `${deptsToSave.join(" · ").toUpperCase()} · ${roleLabel(currentProfile)}`;

  const elSideName = $("#sidebar-username"); if (elSideName) elSideName.textContent = full_name;
  const elSideAvatar = $("#sidebar-avatar"); if (elSideAvatar) elSideAvatar.textContent = full_name.trim().charAt(0).toUpperCase();
  const elSideDept = $("#sidebar-userdept"); if (elSideDept) elSideDept.textContent = `${deptsToSave.join(" · ").toUpperCase()} · ${roleLabel(currentProfile)}`;

  closeProfileModal();
  toast("Profile & departments updated!");
});

function addDaysToDateString(dateStr, days) {
  const parts = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* Save Shift (admins and moderators) */
$("#shift-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isStaff()) {
    toast("Only admins and moderators can schedule or edit shifts.", true);
    return;
  }
  const title = $("#shift-title").value.trim();
  const department = $("#shift-dept").value;
  const shift_date = $("#shift-date").value;
  const start_time = $("#shift-start").value;
  const end_time = $("#shift-end").value;
  const location = $("#shift-location").value.trim() || "Main Shop";
  const notes = $("#shift-notes").value.trim();

  if (!title || !shift_date || !start_time || !end_time) {
    toast("Please enter all required shift fields.", true);
    return;
  }

  const repeatWeekly = !editingShiftId && !!$("#shift-repeat-weekly")?.checked;
  const repeatCount = repeatWeekly ? (parseInt($("#shift-repeat-count")?.value, 10) || 8) : 1;

  const btn = $("#save-shift-btn");
  btn.disabled = true;

  const attendees = [...shiftAssignSelected];
  const wasEditing = editingShiftId;
  const previousAttendees = wasEditing ? (allShifts.find(s => s.id === wasEditing)?.attendees || []) : [];
  const payload = {
    title, department, shift_date, start_time, end_time, location, notes, attendees,
    updated_at: new Date().toISOString()
  };

  let result;
  if (editingShiftId) {
    result = await supabase.from("team_shifts").update(payload).eq("id", editingShiftId);
  } else if (repeatWeekly) {
    const seriesTag = "[🔁 Weekly Shift]";
    const fullNotes = notes ? (notes.includes(seriesTag) ? notes : `${notes} ${seriesTag}`) : seriesTag;
    const shiftsToInsert = [];
    const myName = currentProfile?.full_name || currentUser.email || "Team Member";

    for (let i = 0; i < repeatCount; i++) {
      const weekDate = addDaysToDateString(shift_date, i * 7);
      shiftsToInsert.push({
        title,
        department,
        shift_date: weekDate,
        start_time,
        end_time,
        location,
        notes: fullNotes,
        attendees,
        created_by: currentUser.id,
        created_by_name: myName,
        updated_at: new Date().toISOString()
      });
    }
    result = await supabase.from("team_shifts").insert(shiftsToInsert);
  } else {
    const myName = currentProfile?.full_name || currentUser.email || "Team Member";
    result = await supabase.from("team_shifts").insert({
      ...payload,
      created_by: currentUser.id,
      created_by_name: myName
    });
  }

  btn.disabled = false;
  if (result.error) {
    toast("Could not save shift: " + result.error.message, true);
    return;
  }

  await logAction(wasEditing ? "SHIFT_UPDATED" : "SHIFT_CREATED", "team_shifts", wasEditing || "new", { title, department, shift_date, repeatWeekly, repeatCount, attendees });
  const added = attendees.filter(n => !previousAttendees.includes(n));
  const removed = previousAttendees.filter(n => !attendees.includes(n));
  if (added.length || removed.length) {
    await logAction("SHIFT_ASSIGNED", "team_shifts", wasEditing || "new", { shift_title: title, shift_date, assigned: added, unassigned: removed });
  }
  closeShiftModal();
  await loadShifts();
  toast(wasEditing ? `Shift updated · ${attendees.length} assigned.` : (repeatWeekly ? `Scheduled ${repeatCount} weekly shifts · ${attendees.length} assigned each week!` : `Shift scheduled · ${attendees.length} assigned!`));
});

/* Item Save (Admin only) */
async function saveItem(e) {
  e.preventDefault();
  if (!isStaff()) {
    toast("Only admins and moderators can save inventory items.", true);
    return;
  }

  const name = $("#item-name").value.trim();
  const category = $("#item-category").value;
  const is_tool = $("#item-is-tool").value === "true";
  const quantity = Number($("#item-quantity").value);
  const min_quantity = Number($("#item-min-quantity").value) || 1;
  const unit = $("#item-unit").value.trim() || "pcs";
  const part_number = $("#item-part-number").value.trim();
  const location = $("#item-location").value.trim();
  const notes = $("#item-notes").value.trim();

  const keepsOldCategory = editingItemId && allItems.find(i => i.id === editingItemId)?.category === category;
  if (!name || !(isValidCategory(category) || keepsOldCategory) || !Number.isInteger(quantity) || quantity < 0) {
    toast("Please enter a valid item name and whole quantity.", true);
    return;
  }

  const btn = $("#save-item-button");
  btn.disabled = true;

  const payload = {
    name, category, is_tool, quantity, min_quantity, unit, part_number, location, notes,
    updated_by: currentUser.id
  };

  let result;
  if (editingItemId) {
    result = await supabase.from("inventory_items").update(payload).eq("id", editingItemId);
  } else {
    result = await supabase.from("inventory_items").insert({ ...payload, created_by: currentUser.id });
  }

  btn.disabled = false;
  if (result.error) {
    toast("Could not save item: " + result.error.message, true);
    return;
  }

  const prevItem = editingItemId ? allItems.find(x => x.id === editingItemId) : null;
  await logAction(
    editingItemId ? "ITEM_UPDATED" : "ITEM_CREATED",
    "inventory_items",
    editingItemId || "new",
    {
      name,
      category,
      is_tool,
      qty: quantity,
      unit,
      location,
      min_quantity,
      part_number,
      notes,
      ...(prevItem ? {
        previous_qty: prevItem.quantity,
        previous_location: prevItem.location,
        previous_category: prevItem.category
      } : {})
    }
  );

  closeItemModal();
  await loadItems();
  toast(editingItemId ? "Item updated." : "Item added to inventory.");
}

/* Part Needed Save (Admin only) */
async function savePartNeeded(e) {
  e.preventDefault();
  if (!isStaff()) return;

  const part_name = $("#pn-part-name").value.trim();
  const subsystem = $("#pn-subsystem").value;
  const quantity = Number($("#pn-quantity").value) || 1;
  const vendor = $("#pn-vendor").value.trim();
  const priority = $("#pn-priority").value;
  const status = $("#pn-status").value;
  const estimated_cost = Number($("#pn-cost").value) || 0.00;
  const part_number = $("#pn-part-number").value.trim();
  const url = $("#pn-url").value.trim();
  const notes = $("#pn-notes").value.trim();

  if (!part_name) {
    toast("Part name is required.", true);
    return;
  }

  const btn = $("#save-part-needed-btn");
  btn.disabled = true;

  const payload = {
    part_name, subsystem, quantity, vendor, priority, status,
    estimated_cost, part_number, url, notes,
    created_by: currentUser.id
  };

  const { error } = await supabase.from("parts_needed").insert(payload);
  btn.disabled = false;

  if (error) {
    toast("Failed to save needed part: " + error.message, true);
    return;
  }

  await logAction("PART_NEEDED_CREATED", "parts_needed", null, {
    part_name,
    quantity,
    subsystem,
    vendor,
    priority,
    status,
    estimated_cost,
    part_number,
    url,
    notes
  });
  closePartNeededModal();
  await loadPartsNeeded();
  toast("Part added to robot ordering queue.");
}

/* Task Save (Admin only) */
async function saveTask(e) {
  e.preventDefault();
  if (!isStaff()) {
    toast("Only admins and moderators can create or edit tasks.", true);
    return;
  }

  const title = $("#task-title").value.trim();
  const subsystem = $("#task-subsystem").value;
  const priority = $("#task-priority").value;
  const status = $("#task-status").value;
  const due_date = $("#task-due-date").value || null;
  const assigned_to = $("#task-assignee").value.trim();
  const description = $("#task-desc").value.trim();

  if (!title) {
    toast("Task title is required.", true);
    return;
  }

  const btn = $("#save-task-btn");
  btn.disabled = true;

  const payload = {
    title, subsystem, priority, status, due_date, assigned_to, description,
    updated_at: new Date().toISOString()
  };

  let result;
  if (editingTaskId) {
    result = await supabase.from("planner_tasks").update(payload).eq("id", editingTaskId);
  } else {
    result = await supabase.from("planner_tasks").insert({
      ...payload,
      created_by: currentUser.id,
      created_by_name: currentProfile?.full_name || currentUser.email || "Team Member"
    });
  }

  btn.disabled = false;
  if (result.error) {
    toast("Could not save task: " + result.error.message, true);
    return;
  }

  const prevTask = editingTaskId ? allTasks.find(t => t.id === editingTaskId) : null;
  await logAction(
    editingTaskId ? "PLANNER_TASK_UPDATED" : "PLANNER_TASK_CREATED",
    "planner_tasks",
    editingTaskId || "new",
    {
      title,
      subsystem,
      status,
      priority,
      assigned_to,
      due_date,
      description,
      ...(prevTask ? { previous_status: prevTask.status, previous_assignee: prevTask.assigned_to } : {})
    }
  );

  closeTaskModal();
  await loadTasks();
  toast(editingTaskId ? "Task updated." : "Task added to team planner.");
}

/* Spending Save (admins and moderators) - supports Editing + Receipt Screenshot + Auto Season Period + Version History */
async function saveSpending(e) {
  e.preventDefault();
  if (!isStaff()) return;

  const title = $("#spend-title").value.trim();
  const vendor = $("#spend-vendor").value.trim();
  const amount = Number($("#spend-amount").value);
  const category = $("#spend-category").value;
  const order_date = $("#spend-date").value || new Date().toISOString().slice(0, 10);
  const order_number = $("#spend-order-number").value.trim();
  const notes = $("#spend-notes").value.trim();
  const chosenPeriod = $("#spend-season-period").value;
  const season_period = getSeasonPeriod(order_date, chosenPeriod);
  const receipt_data = $("#spend-receipt-data").value.trim();
  const editReason = $("#spend-edit-reason")?.value.trim() || "";

  if (!title || !vendor || isNaN(amount) || amount < 0) {
    toast("Enter a valid title, vendor, and amount.", true);
    return;
  }

  // Force screenshot of receipt or credit card charge
  if (!receipt_data) {
    toast("A receipt / credit card charge screenshot is mandatory for expense verification.", true);
    $("#spend-receipt-file")?.focus();
    return;
  }

  if (editingSpendingId && !editReason) {
    toast("Please enter the reason for editing this expense (for version history).", true);
    $("#spend-edit-reason")?.focus();
    return;
  }

  const btn = $("#save-spending-btn");
  btn.disabled = true;

  if (editingSpendingId) {
    const existing = allSpending.find(s => s.id === editingSpendingId);
    const existingHistory = Array.isArray(existing?.edit_history) ? [...existing.edit_history] : [];

    const changes = {};
    if (existing) {
      if (existing.title !== title) changes.title = { from: existing.title, to: title };
      if (existing.vendor !== vendor) changes.vendor = { from: existing.vendor, to: vendor };
      if (Number(existing.amount) !== amount) changes.amount = { from: existing.amount, to: amount };
      if (existing.category !== category) changes.category = { from: existing.category, to: category };
      if (existing.order_date !== order_date) changes.order_date = { from: existing.order_date, to: order_date };
      if ((existing.order_number || "") !== order_number) changes.order_number = { from: existing.order_number || "", to: order_number };
      if ((existing.notes || "") !== notes) changes.notes = { from: existing.notes || "", to: notes };
      if ((existing.receipt_data || existing.receipt_url || "") !== receipt_data) {
        changes.receipt = { from: existing.receipt_data || existing.receipt_url ? "previous screenshot" : "none", to: "new screenshot uploaded" };
      }
      if ((existing.season_period || getSeasonPeriod(existing.order_date)) !== season_period) {
        changes.season_period = { from: existing.season_period || getSeasonPeriod(existing.order_date), to: season_period };
      }
    }

    const versionEntry = {
      version: existingHistory.length + 1,
      edited_at: new Date().toISOString(),
      edited_by: currentUser.id,
      edited_by_name: currentProfile?.full_name || "Admin",
      reason: editReason,
      changes: Object.keys(changes).length ? changes : { note: "Receipt or metadata updated" }
    };

    existingHistory.push(versionEntry);

    const updatePayload = {
      title,
      vendor,
      amount,
      category,
      order_date,
      order_number,
      notes,
      season_period,
      receipt_data,
      edit_history: existingHistory,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase.from("spending_records").update(updatePayload).eq("id", editingSpendingId);
    btn.disabled = false;

    if (error) {
      toast("Failed to update spending record: " + error.message, true);
      return;
    }

    await logAction("SPENDING_UPDATED", "spending_records", editingSpendingId, {
      title,
      amount,
      vendor,
      reason: editReason,
      changes
    });

    closeSpendingModal();
    await loadSpending();
    toast(`Updated expense: $${amount.toFixed(2)} at ${vendor} (v${existingHistory.length} saved)`);
  } else {
    const payload = {
      title,
      vendor,
      amount,
      category,
      order_date,
      order_number,
      notes,
      season_period,
      receipt_data,
      edit_history: [],
      created_by: currentUser.id,
      created_by_name: currentProfile?.full_name || "Admin"
    };

    const { error } = await supabase.from("spending_records").insert(payload);
    btn.disabled = false;

    if (error) {
      toast("Failed to record spending: " + error.message, true);
      return;
    }

    await logAction("SPENDING_RECORDED", "spending_records", null, {
      title,
      vendor,
      amount,
      category,
      order_date,
      order_number,
      season_period,
      notes
    });

    closeSpendingModal();
    await loadSpending();
    toast(`Recorded purchase: $${amount.toFixed(2)} at ${vendor}`);
  }
}

/* Update Quantity Quick Buttons (Admin only) */
async function updateQty(id, delta) {
  if (!isStaff()) {
    toast("Only admins and moderators can adjust inventory quantities directly.", true);
    return;
  }
  const item = allItems.find(x => x.id === id);
  if (!item) return;
  const prevQty = Number(item.quantity);
  const newQty = Math.max(0, prevQty + delta);
  const { error } = await supabase.from("inventory_items").update({ quantity: newQty, updated_by: currentUser.id }).eq("id", id);
  if (error) {
    toast("Could not update quantity: " + error.message, true);
  } else {
    await logAction("ITEM_UPDATED", "inventory_items", id, {
      name: item.name,
      delta,
      previous_qty: prevQty,
      new_qty: newQty,
      qty: newQty,
      unit: item.unit || "pcs",
      location: item.location || ""
    });
    await loadItems(true);
  }
}

/* Event Listeners */
$("#show-signin").addEventListener("click", () => authMode("signin"));
$("#show-signup").addEventListener("click", () => authMode("signup"));

$("#signin-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!supabase) { message("Database not configured. Please wait or reload.", true); return; }
  const b = e.submitter || e.target.querySelector("button[type='submit']");
  if (b) b.disabled = true;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: $("#signin-email").value.trim(),
      password: $("#signin-password").value
    });
    if (error) {
      if (b) b.disabled = false;
      message(error.message, true);
      return;
    }
    await logAction("USER_LOGIN", "auth", data.user?.id, {
      email: data.user?.email || $("#signin-email").value.trim(),
      client_timestamp: new Date().toISOString()
    });
    await checkUser(data.user);
  } catch (err) {
    console.error("Sign in error:", err);
    message("Sign in failed: " + (err.message || err), true);
  } finally {
    if (b) b.disabled = false;
  }
});

$("#signup-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!supabase) { message("Database not configured.", true); return; }
  const name = $("#signup-name").value.trim();
  const email = $("#signup-email").value.trim();
  const password = $("#signup-password").value;

  if (name.split(/\s+/).length < 2) {
    message("Please enter both your first and last name.", true);
    return;
  }

  const b = e.submitter; b.disabled = true;
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: {
      data: { full_name: name },
      emailRedirectTo: location.origin + location.pathname
    }
  });
  b.disabled = false;
  if (error) { message(error.message, true); return; }
  if (!data.session) {
    message("Confirmation email sent. After verifying your email, sign in. An admin must approve you.", false);
  } else {
    message("Account created. Waiting for team admin approval.", false);
    await checkUser(data.user);
  }
});

$("#forgot-password").addEventListener("click", async () => {
  if (!supabase) return;
  const email = $("#signin-email").value.trim();
  if (!email) { message("Please enter your team email above first.", true); return; }
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + location.pathname
  });
  message(error ? error.message : "Password reset link sent to your email.", !!error);
});

$("#recovery-form").addEventListener("submit", async e => {
  e.preventDefault();
  const newPassword = $("#new-password").value;
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    toast("Password update failed: " + error.message, true);
  } else {
    $("#recovery-modal").classList.add("hidden");
    toast("Password updated successfully!");
  }
});

$("#signout-button").addEventListener("click", signOut);
$("#pending-signout").addEventListener("click", signOut);

// Profile button triggers
$("#open-profile-btn").addEventListener("click", (e) => {
  if (e.target.id === "signout-button") return;
  openProfileModal();
});
$("#edit-profile-action").addEventListener("click", openProfileModal);
$("#close-profile-modal").addEventListener("click", closeProfileModal);
$("#cancel-profile-modal").addEventListener("click", closeProfileModal);
$("#profile-modal").addEventListener("click", e => { if (e.target.id === "profile-modal") closeProfileModal(); });

// Admin Audit Logs quick button (under user chip)
$("#admin-audit-logs-btn").addEventListener("click", () => switchView("logs"));

$$(".viewtab").forEach(tab => {
  tab.addEventListener("click", () => switchView(tab.dataset.view));
});

$("#add-item-button").addEventListener("click", () => openItemModal(null));
$("#close-modal").addEventListener("click", closeItemModal);
$("#cancel-modal").addEventListener("click", closeItemModal);
$("#item-modal").addEventListener("click", e => { if (e.target.id === "item-modal") closeItemModal(); });
$("#item-form").addEventListener("submit", saveItem);

$("#close-checkout-modal").addEventListener("click", closeCheckoutModal);
$("#cancel-checkout-modal").addEventListener("click", closeCheckoutModal);
$("#checkout-modal").addEventListener("click", e => { if (e.target.id === "checkout-modal") closeCheckoutModal(); });

$("#add-shift-btn").addEventListener("click", () => openShiftModal(null));
$("#close-shift-modal").addEventListener("click", closeShiftModal);
$("#cancel-shift-modal").addEventListener("click", closeShiftModal);
$("#shift-modal").addEventListener("click", e => { if (e.target.id === "shift-modal") closeShiftModal(); });
$("#shift-repeat-weekly")?.addEventListener("change", e => {
  $("#shift-repeat-options")?.classList.toggle("hidden", !e.target.checked);
});

$("#add-part-needed-btn").addEventListener("click", openPartNeededModal);
$("#close-part-needed-modal").addEventListener("click", closePartNeededModal);
$("#cancel-part-needed-modal").addEventListener("click", closePartNeededModal);
$("#part-needed-modal").addEventListener("click", e => { if (e.target.id === "part-needed-modal") closePartNeededModal(); });
$("#part-needed-form").addEventListener("submit", savePartNeeded);

$("#add-task-btn").addEventListener("click", () => openTaskModal(null));
$("#close-task-modal").addEventListener("click", closeTaskModal);
$("#cancel-task-modal").addEventListener("click", closeTaskModal);
$("#task-modal").addEventListener("click", e => { if (e.target.id === "task-modal") closeTaskModal(); });
$("#task-form").addEventListener("submit", saveTask);

$("#add-spending-btn").addEventListener("click", openSpendingModal);
$("#close-spending-modal").addEventListener("click", closeSpendingModal);
$("#cancel-spending-modal").addEventListener("click", closeSpendingModal);
$("#spending-modal").addEventListener("click", e => { if (e.target.id === "spending-modal") closeSpendingModal(); });
$("#spending-form").addEventListener("submit", saveSpending);

/* Confirm Check Out (All approved members can borrow) */
$("#checkout-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!checkingOutItem) return;
  const qty = Number($("#checkout-qty").value);
  const notes = $("#checkout-notes").value.trim();

  if (qty <= 0) {
    toast("Please enter a valid quantity.", true);
    return;
  }

  const { error } = await supabase.from("tool_checkouts").insert({
    item_id: checkingOutItem.id,
    user_id: currentUser.id,
    user_name: currentProfile?.full_name || currentUser.email || "Team Member",
    quantity: qty,
    notes: notes,
    status: "checked_out"
  });

  if (error) {
    toast("Could not check out tool: " + error.message, true);
    return;
  }

  await logAction("TOOL_CHECKOUT", "tool_checkouts", checkingOutItem.id, {
    name: checkingOutItem.name,
    qty,
    notes,
    user_name: currentProfile?.full_name || currentUser.email || "Team Member",
    location: checkingOutItem.location || "Shop"
  });

  closeCheckoutModal();
  await Promise.all([loadCheckouts(true), loadItems(true)]);
  toast(`Checked out ${qty} × ${checkingOutItem.name}.`);
});

const elSearchItems = $("#search-items");
if (elSearchItems) elSearchItems.addEventListener("input", renderItems);
$(".inventory-kinds")?.addEventListener("click", e => {
  const button = e.target.closest("[data-inventory-kind]");
  if (!button) return;
  activeInventoryKind = button.dataset.inventoryKind;
  activeCategory = "All";
  renderItems();
});
$("#inventory-stock")?.addEventListener("change", renderItems);
$("#inventory-sort")?.addEventListener("change", renderItems);
$("#inventory-reset")?.addEventListener("click", () => {
  activeInventoryKind = "all";
  activeCategory = "All";
  $("#search-items").value = "";
  $("#inventory-stock").value = "all";
  renderItems();
  $("#search-items").focus();
});

/* Inventory category tabs are rendered from the categories list, so listen on the container */
$("#inv-filter-tabs")?.addEventListener("click", e => {
  const b = e.target.closest("[data-category]");
  if (!b) return;
  activeCategory = b.dataset.category;
  renderItems();
});
/* Picking a tool category marks the item as a tool, and the reverse */
$("#item-category")?.addEventListener("change", e => {
  const kind = kindOf(e.target.value);
  if (kind) $("#item-is-tool").value = kind === "tool" ? "true" : "false";
});

$$(".catbtn").forEach(b => b.addEventListener("click", () => {
  if (b.dataset.category) {
    activeCategory = b.dataset.category;
    renderItems();
  } else if (b.dataset.shiftDept) {
    activeShiftDept = b.dataset.shiftDept;
    $$("[data-shift-dept]").forEach(btn => btn.classList.toggle("active", btn.dataset.shiftDept === activeShiftDept));
    renderShifts();
  } else if (b.dataset.plannerCat) {
    activePlannerSubsystem = b.dataset.plannerCat;
    $$("[data-planner-cat]").forEach(btn => btn.classList.toggle("active", btn.dataset.plannerCat === activePlannerSubsystem));
    renderTasks();
  } else if (b.dataset.partsFilter) {
    activePartsFilter = b.dataset.partsFilter;
    $$("[data-parts-filter]").forEach(btn => btn.classList.toggle("active", btn.dataset.partsFilter === activePartsFilter));
    renderPartsNeeded();
  }
}));

/* Item List Actions */
$("#items-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  const id = b.dataset.id;
  const isAdmin = isStaff();

  if (action === "label-qr") {
    const item = allItems.find(x => x.id === id);
    if (item) openBarcodeModal(item);
  } else if (action === "edit") {
    if (!isAdmin) return;
    const item = allItems.find(x => x.id === id);
    if (item) openItemModal(item);
  } else if (action === "checkout") {
    const item = allItems.find(x => x.id === id);
    if (item) openCheckoutModal(item);
  } else if (action === "qtyplus") {
    if (!isAdmin) return;
    await updateQty(id, 1);
  } else if (action === "qtyminus") {
    if (!isAdmin) return;
    await updateQty(id, -1);
  } else if (action === "delete") {
    if (!isAdmin) return;
    const item = allItems.find(x => x.id === id);
    if (!item) return;
    if (confirm(`Are you sure you want to delete "${item.name}" from the inventory catalog?`)) {
      // Optimistic instant UI update
      allItems = allItems.filter(x => x.id !== id);
      renderItems();
      renderStats();

      const { error } = await supabase.from("inventory_items").delete().eq("id", id);
      if (error) {
        toast("Delete failed: " + error.message, true);
        await loadItems(true);
      } else {
        await logAction("ITEM_DELETED", "inventory_items", id, {
          name: item.name,
          category: item.category,
          quantity: item.quantity,
          location: item.location,
          is_tool: item.is_tool
        });
        toast("Item deleted.");
      }
    }
  } else if (action === "return-direct") {
    const co = allCheckouts.find(c => c.id === id);
    if (co && co.user_id !== currentUser?.id && !isStaff()) {
      toast("You can only return tools that you checked out.", true);
      return;
    }

    const { error } = await supabase.from("tool_checkouts").update({
      status: "returned",
      returned_at: new Date().toISOString()
    }).eq("id", id);

    if (error) {
      toast("Return failed: " + error.message, true);
    } else {
      await logAction("TOOL_CHECKIN", "tool_checkouts", id, {
        checkout_id: id,
        name: co?.item_name || "Tool",
        qty: co?.quantity || 1,
        user_name: currentProfile?.full_name || currentUser.email || "Team Member"
      });
      await Promise.all([loadCheckouts(true), loadItems(true)]);
      toast("Tool returned to shop.");
    }
  }
});

/* Shifts Actions: Join/Leave, Edit, Delete (Everyone can edit) */
$("#view-shifts").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  const id = b.dataset.id;
  const shift = allShifts.find(s => s.id === id);
  const myName = currentProfile?.full_name || currentUser?.email || "Team Member";

  if (action === "toggle-attend-shift" && shift) {
    let attendees = Array.isArray(shift.attendees) ? [...shift.attendees] : [];
    const isAttending = attendees.includes(myName);
    if (isAttending) {
      attendees = attendees.filter(a => a !== myName);
    } else {
      attendees.push(myName);
    }

    const { error } = await supabase.from("team_shifts").update({
      attendees,
      updated_at: new Date().toISOString()
    }).eq("id", id);

    if (error) {
      toast("Failed to update roster: " + error.message, true);
    } else {
      await logAction(
        isAttending ? "SHIFT_LEFT" : "SHIFT_ATTENDED",
        "team_shifts",
        id,
        {
          shift_title: shift.title,
          shift_date: shift.shift_date,
          department: shift.department,
          location: shift.location,
          member_name: myName
        }
      );
      await loadShifts(true);
      if (gcal.isConnected()) {
        await syncShiftCalendar({ interactive: true });
        toast(isAttending ? "Left shift and removed it from your Google Calendar." : "Signed up! Shift added to your Google Calendar");
      } else {
        toast(isAttending ? "Removed yourself from shift roster." : "Signed up for shift!");
      }
    }
  } else if (action === "remove-attendee" && shift) {
    const target = b.dataset.attendee;
    const isAdmin = isStaff();
    if (!isAdmin && target !== myName) {
      toast("Only admins and moderators can remove other members from the shift roster.", true);
      return;
    }
    const attendees = (Array.isArray(shift.attendees) ? shift.attendees : []).filter(a => a !== target);
    const { error } = await supabase.from("team_shifts").update({
      attendees,
      updated_at: new Date().toISOString()
    }).eq("id", id);

    if (error) {
      toast("Failed to remove attendee: " + error.message, true);
    } else {
      await logAction("SHIFT_ATTENDEE_REMOVED", "team_shifts", id, { shift_title: shift.title, removed_attendee: target });
      await loadShifts(true);
      toast(target === myName ? "Removed yourself from shift roster." : `Removed ${target} from shift roster.`);
    }
  } else if (action === "assign-shift" && shift) {
    if (!isStaff()) return;
    openShiftModal(shift);
    setTimeout(() => {
      $(".assign-box")?.scrollIntoView({ block: "center" });
      $("#shift-assign-search")?.focus();
    }, 50);
  } else if (action === "edit-shift" && shift) {
    if (!isStaff()) {
      toast("Only admins and moderators can edit shifts.", true);
      return;
    }
    openShiftModal(shift);
  } else if (action === "delete-shift" && shift) {
    if (!isStaff()) {
      toast("Only admins and moderators can remove shifts from the schedule.", true);
      return;
    }
    const isWeekly = shift.notes && shift.notes.includes("[🔁 Weekly Shift]");
    let deleteAll = false;
    if (isWeekly) {
      deleteAll = confirm(`"${shift.title}" is part of a recurring weekly series.\n\nClick OK to remove this and ALL upcoming weekly shifts for "${shift.title}".\n\nClick CANCEL if you only want to remove this single date (${shift.shift_date}).`);
      if (!deleteAll) {
        if (!confirm(`Remove ONLY the shift on ${shift.shift_date}?`)) return;
      }
    } else {
      if (!confirm(`Remove shift "${shift.title}" on ${shift.shift_date}?`)) return;
    }

    let error;
    // Optimistic instant UI update
    if (deleteAll) {
      allShifts = allShifts.filter(s => !(s.title === shift.title && s.department === shift.department && s.shift_date >= shift.shift_date));
    } else {
      allShifts = allShifts.filter(s => s.id !== id);
    }
    renderShifts();

    if (deleteAll) {
      const res = await supabase.from("team_shifts")
        .delete()
        .eq("title", shift.title)
        .eq("department", shift.department)
        .gte("shift_date", shift.shift_date);
      error = res.error;
    } else {
      const res = await supabase.from("team_shifts").delete().eq("id", id);
      error = res.error;
    }

    if (error) {
      toast("Failed to delete shift: " + error.message, true);
      await loadShifts(true);
    } else {
      await logAction("SHIFT_DELETED", "team_shifts", id, { title: shift.title, department: shift.department, series: deleteAll });
      toast(deleteAll ? "All upcoming weekly shifts removed." : "Shift removed from calendar.");
    }
  }
});

/* Parts Needed Actions */
$("#parts-needed-list").addEventListener("change", async e => {
  if (e.target.dataset.action === "quick-status-pn") {
    const id = e.target.dataset.id;
    const newStatus = e.target.value;
    const { error } = await supabase.from("parts_needed").update({
      status: newStatus,
      updated_at: new Date().toISOString()
    }).eq("id", id);

    const targetPart = allPartsNeeded.find(p => p.id === id);
    if (error) {
      toast("Failed to update status: " + error.message, true);
    } else {
      await logAction("PART_STATUS_UPDATED", "parts_needed", id, {
        part_name: targetPart?.part_name || "Part",
        previous_status: targetPart?.status || "needed",
        new_status: newStatus,
        status: newStatus,
        vendor: targetPart?.vendor || "",
        quantity: targetPart?.quantity || 1
      });
      await loadPartsNeeded(true);
      toast(`Status updated to ${newStatus}.`);
    }
  }
});

$("#parts-needed-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  const id = b.dataset.id;

  if (action === "delete-pn" && isStaff()) {
    if (confirm("Remove this needed part from the list?")) {
      // Optimistic instant UI update
      allPartsNeeded = allPartsNeeded.filter(p => p.id !== id);
      renderPartsNeeded();

      const targetPn = allPartsNeeded.find(p => p.id === id);
      const { error } = await supabase.from("parts_needed").delete().eq("id", id);
      if (error) {
        toast("Failed to delete: " + error.message, true);
        await loadPartsNeeded(true);
      } else {
        await logAction("PART_NEEDED_DELETED", "parts_needed", id, {
          part_name: targetPn?.part_name || "Part",
          vendor: targetPn?.vendor || "",
          quantity: targetPn?.quantity || 1,
          status: targetPn?.status || "needed"
        });
        toast("Part removed from queue.");
      }
    }
  }
});

/* Checkouts View Action: Check In (Borrower or Staff) */
$("#checkouts-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action='checkin']");
  if (!b) return;
  const checkoutId = b.dataset.id;
  const itemName = b.dataset.name;

  const coRecord = allCheckouts.find(c => c.id === checkoutId);
  if (coRecord && coRecord.user_id !== currentUser?.id && !isStaff()) {
    toast("You can only return tools that you checked out.", true);
    return;
  }

  const { error } = await supabase.from("tool_checkouts").update({
    status: "returned",
    returned_at: new Date().toISOString()
  }).eq("id", checkoutId);

  if (error) {
    toast("Check-in failed: " + error.message, true);
  } else {
    await logAction("TOOL_CHECKIN", "tool_checkouts", checkoutId, {
      name: itemName,
      qty: coRecord?.quantity || 1,
      user_name: currentProfile?.full_name || currentUser.email || "Team Member"
    });
    await Promise.all([loadCheckouts(true), loadItems(true)]);
    toast(`Returned ${itemName} to shop.`);
  }
});

/* Planner Actions: Anyone can update status; only admins edit/delete */
$("#view-planner").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  const id = b.dataset.id;
  const task = allTasks.find(t => t.id === id);
  const isAdmin = isStaff();

  if (action === "move-status") {
    const newStatus = b.dataset.newstatus;
    const { error } = await supabase.from("planner_tasks").update({
      status: newStatus,
      updated_at: new Date().toISOString()
    }).eq("id", id);

    if (error) {
      toast("Failed to update status: " + error.message, true);
    } else {
      const logType = newStatus === "done" ? "PLANNER_TASK_COMPLETED" : "PLANNER_TASK_UPDATED";
      await logAction(logType, "planner_tasks", id, {
        title: task?.title,
        previous_status: task?.status || "todo",
        new_status: newStatus,
        status: newStatus,
        subsystem: task?.subsystem || "General",
        assigned_to: task?.assigned_to || ""
      });
      await loadTasks(true);
      toast(newStatus === "done" ? "Task marked complete!" : "Task moved to in progress.");
    }
  } else if (action === "edit-task") {
    if (!isAdmin) return;
    if (task) openTaskModal(task);
  } else if (action === "delete-task") {
    if (!isAdmin) return;
    if (confirm(`Delete task "${task?.title}"?`)) {
      // Optimistic instant UI update
      allTasks = allTasks.filter(t => t.id !== id);
      renderTasks();

      const { error } = await supabase.from("planner_tasks").delete().eq("id", id);
      if (error) {
        toast("Delete failed: " + error.message, true);
        await loadTasks(true);
      } else {
        await logAction("PLANNER_TASK_DELETED", "planner_tasks", id, {
          title: task?.title,
          subsystem: task?.subsystem,
          assigned_to: task?.assigned_to
        });
        toast("Task removed.");
      }
    }
  }
});

/* Spending Actions (Edit, Delete, Receipt View, History View) */
$("#spending-list").addEventListener("click", async e => {
  const deleteBtn = e.target.closest("button[data-action='delete-spending']");
  const editBtn = e.target.closest("button[data-action='edit-spending']");
  const receiptBtn = e.target.closest("button[data-action='view-receipt']");
  const historyBtn = e.target.closest("button[data-action='view-history']");

  if (editBtn && isStaff()) {
    const id = editBtn.dataset.id;
    const item = allSpending.find(s => s.id === id);
    if (item) openSpendingModal(item);
    return;
  }

  if (receiptBtn) {
    const id = receiptBtn.dataset.id;
    const item = allSpending.find(s => s.id === id);
    if (item && (item.receipt_data || item.receipt_url)) {
      openReceiptViewer(item);
    } else {
      toast("No receipt image attached to this record.", true);
    }
    return;
  }

  if (historyBtn) {
    const id = historyBtn.dataset.id;
    const item = allSpending.find(s => s.id === id);
    if (item) openSpendingHistory(item);
    return;
  }

  if (deleteBtn && isStaff()) {
    const id = deleteBtn.dataset.id;
    if (confirm("Delete this purchase order record?")) {
      const targetSpend = allSpending.find(s => s.id === id);
      allSpending = allSpending.filter(s => s.id !== id);
      renderSpending();

      const { error } = await supabase.from("spending_records").delete().eq("id", id);
      if (error) {
        toast("Failed to delete record: " + error.message, true);
        await loadSpending(true);
      } else {
        await logAction("SPENDING_DELETED", "spending_records", id, {
          title: targetSpend?.title,
          amount: targetSpend?.amount,
          vendor: targetSpend?.vendor,
          category: targetSpend?.category
        });
        toast("Purchase record deleted.");
      }
    }
  }
});

/* Spending Season Filter Tabs */
$("#spending-season-filter-tabs")?.addEventListener("click", e => {
  const pill = e.target.closest(".filterpill");
  if (!pill) return;
  $$("#spending-season-filter-tabs .filterpill").forEach(p => p.classList.remove("active"));
  pill.classList.add("active");
  spendingPeriodFilter = pill.dataset.period || "all";
  renderSpending();
});

/* Receipt File Upload with Image Compression (to avoid 500MB bloat) */
$("#spend-receipt-file")?.addEventListener("change", e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    toast("Please choose an image file (PNG, JPG, WebP).", true);
    return;
  }

  const reader = new FileReader();
  reader.onload = evt => {
    const rawData = evt.target.result;
    // Compress image via offscreen canvas to optimize storage
    const img = new Image();
    img.onload = () => {
      const maxDim = 1200;
      let width = img.width;
      let height = img.height;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      const compressedData = canvas.toDataURL("image/jpeg", 0.78);

      $("#spend-receipt-data").value = compressedData;
      $("#spend-receipt-preview-img").src = compressedData;
      $("#spend-receipt-preview-wrap").classList.remove("hidden");
    };
    img.src = rawData;
  };
  reader.readAsDataURL(file);
});

$("#spend-receipt-remove-btn")?.addEventListener("click", () => {
  $("#spend-receipt-data").value = "";
  $("#spend-receipt-file").value = "";
  $("#spend-receipt-preview-img").src = "";
  $("#spend-receipt-preview-wrap").classList.add("hidden");
});

/* Receipt Viewer Modal Logic */
function openReceiptViewer(record) {
  const src = record.receipt_data || record.receipt_url;
  if (!src) return;
  const modal = $("#receipt-modal");
  const img = $("#receipt-modal-img");
  const title = $("#receipt-modal-title");
  const caption = $("#receipt-modal-caption");

  if (title) title.textContent = `Receipt: ${record.title} ($${Number(record.amount).toFixed(2)})`;
  if (caption) caption.textContent = `Vendor: ${record.vendor} · Date: ${record.order_date || '—'}`;
  if (img) img.src = src;

  const downloadBtn = $("#download-receipt-img-btn");
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = src;
      a.download = `Receipt_${(record.vendor || "order").replace(/\s+/g, "_")}_${record.order_date || "2026"}.jpg`;
      a.click();
    };
  }

  modal?.classList.remove("hidden");
}

function closeReceiptViewer() {
  $("#receipt-modal")?.classList.add("hidden");
}

$("#close-receipt-modal")?.addEventListener("click", closeReceiptViewer);
$("#receipt-modal")?.addEventListener("click", e => { if (e.target.id === "receipt-modal") closeReceiptViewer(); });

/* Version History Modal Logic */
function openSpendingHistory(record) {
  const modal = $("#spending-history-modal");
  const list = $("#spending-history-list");
  const title = $("#spending-history-modal-title");

  if (title) title.textContent = `History: ${record.title} (${record.vendor})`;

  const history = Array.isArray(record.edit_history) ? record.edit_history : [];
  if (!history.length) {
    list.innerHTML = `<div class="muted small" style="padding:20px; text-align:center;">No previous edits recorded for this entry.</div>`;
  } else {
    list.innerHTML = history.slice().reverse().map(h => {
      const changeItems = Object.entries(h.changes || {}).map(([key, diff]) => {
        if (diff && typeof diff === 'object' && 'from' in diff && 'to' in diff) {
          return `<li><b>${esc(key)}:</b> <span style="text-decoration:line-through; opacity:0.6;">${esc(String(diff.from))}</span> ➔ <span style="color:#34d399;">${esc(String(diff.to))}</span></li>`;
        }
        return `<li><b>${esc(key)}:</b> ${esc(JSON.stringify(diff))}</li>`;
      }).join("");

      return `
        <div style="background:rgba(255,255,255,0.04); border:1px solid var(--line-glass); border-radius:8px; padding:12px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <strong style="color:#fbbf24; font-size:13px;">Version ${h.version || '—'}</strong>
            <span class="mono muted small">${h.edited_at ? new Date(h.edited_at).toLocaleString() : '—'}</span>
          </div>
          <div class="small" style="margin-bottom:6px;">
            <span class="muted">Edited by:</span> <b>${esc(h.edited_by_name || "Admin")}</b>
          </div>
          <div class="small" style="margin-bottom:8px; background:rgba(251, 191, 36, 0.1); border-left:3px solid #fbbf24; padding:6px 10px; border-radius:4px;">
            <span class="muted">Reason:</span> <i>"${esc(h.reason || "No reason given")}"</i>
          </div>
          <div class="small">
            <span class="muted">Modifications:</span>
            <ul style="margin:4px 0 0 16px; padding:0; display:flex; flex-direction:column; gap:2px;">
              ${changeItems || '<li>Metadata updated</li>'}
            </ul>
          </div>
        </div>
      `;
    }).join("");
  }

  modal?.classList.remove("hidden");
}

function closeSpendingHistory() {
  $("#spending-history-modal")?.classList.add("hidden");
}

$("#close-spending-history-modal")?.addEventListener("click", closeSpendingHistory);
$("#spending-history-modal")?.addEventListener("click", e => { if (e.target.id === "spending-history-modal") closeSpendingHistory(); });

/* Admin Member Actions */
$("#admin-members-list").addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const id = b.dataset.id;
  const name = b.dataset.name;
  const action = b.dataset.action;

  if (action === "approve-member" || action === "revoke-member") {
    const approve = action === "approve-member";
    const { error } = await supabase.from("profiles").update({ is_approved: approve }).eq("id", id);
    if (error) {
      toast("Member update failed: " + error.message, true);
    } else {
      await logAction(approve ? "MEMBER_APPROVED" : "MEMBER_REVOKED", "profiles", id, {
        member_name: name,
        approved: approve,
        timestamp: new Date().toISOString()
      });
      await loadMembers();
      toast(approve ? `Approved ${name}.` : `Revoked access for ${name}.`);
    }
  }
});

/* Member roles (admins): Admin / Strategy / Secret. The profiles trigger only allows admins to change these. */
$("#admin-members-list").addEventListener("change", async e => {
  const cb = e.target.closest("input[data-role-flag]");
  if (!cb || !currentProfile?.is_admin) return;
  const { roleFlag: flag, id, name } = cb.dataset;
  const label = { is_admin: "Admin", is_moderator: "Moderator", is_strategy: "Strategy", is_secret: "Secret" }[flag];
  if (id === currentUser.id && flag === "is_admin" && !cb.checked) { cb.checked = true; return; }
  if (flag === "is_moderator" && cb.checked && !confirm(`Make ${name} a moderator? Moderators can manage inventory, parts, shifts, the planner, scouting and sign-ups, but not members, roles, spending, the audit log or analytics.`)) { cb.checked = false; return; }
  if (flag === "is_admin" && cb.checked && !confirm(`Make ${name} an admin? Admins can manage everything, including other members' roles.`)) { cb.checked = false; return; }
  cb.disabled = true;
  const { error } = await supabase.from("profiles").update({ [flag]: cb.checked }).eq("id", id);
  cb.disabled = false;
  if (error) {
    cb.checked = !cb.checked;
    toast(`Couldn't change ${label} for ${name}: ${error.message}`, true);
    return;
  }
  cb.closest(".role-toggle")?.classList.toggle("is-on", cb.checked);
  await logAction("MEMBER_ROLE_CHANGED", "profiles", id, { member_name: name, role: label, granted: cb.checked });
  if (id === currentUser.id) currentProfile[flag] = cb.checked;
  toast(`${cb.checked ? "Granted" : "Removed"} ${label} for ${name}.`);
});

/* Refresh logs */
$("#refresh-logs-btn").addEventListener("click", loadLogs);

/* Supabase Initialization */
async function initSupabase() {
  if (!configured) {
    const elNotice = $("#setup-notice");
    if (elNotice) elNotice.classList.remove("hidden");
    window.nyxStartup?.fail("The workspace isn't configured yet. Contact your team admin.");
    return;
  }

  const elNotice = $("#setup-notice");
  if (elNotice) elNotice.classList.add("hidden");

  try {
    let createClientFn = window.supabase?.createClient;
    if (!createClientFn) {
      try {
        const mod = await import("https://esm.sh/@supabase/supabase-js@2");
        createClientFn = mod.createClient;
      } catch (importErr) {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://unpkg.com/@supabase/supabase-js@2";
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
        createClientFn = window.supabase?.createClient;
      }
    }

    if (!createClientFn) {
      throw new Error("Could not load Supabase client library.");
    }

    supabase = createClientFn(SUPABASE_URL, SUPABASE_PUBLIC_KEY);

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        screens("auth");
        const elRec = $("#recovery-modal");
        if (elRec) elRec.classList.remove("hidden");
      } else if (event === "SIGNED_OUT") {
        screens("auth");
        currentUser = null;
        currentProfile = null;
      } else if (event === "SIGNED_IN" && session && !currentUser) {
        setTimeout(() => checkUser(session.user), 0);
      }
    });

    const { data, error } = await supabase.auth.getSession();
    if (error) {
      throw error;
    }
    if (data?.session) {
      await checkUser(data.session.user);
    } else {
      screens("auth");
    }
  } catch (err) {
    console.error("Supabase init error:", err);
    window.nyxStartup?.fail("Couldn't connect to your workspace. Check your connection and try again.");
    const elNotice = $("#setup-notice");
    if (elNotice) {
      elNotice.classList.remove("hidden");
      elNotice.innerHTML = `<b>Database connection issue:</b> ${esc(err.message || err)}`;
    }
    message("Could not initialize Supabase: " + err.message, true);
  }
}

/* ==========================================================================
   STRATEGY, SCOUTING, PLAYBOOK & SIMULATOR ENGINE (STATBOTICS & 2026 REBUILT)
   ========================================================================== */

let frcTeamsData = (typeof window !== "undefined" && Array.isArray(window.FRC_TEAMS_DATA) && window.FRC_TEAMS_DATA.length > 0)
  ? window.FRC_TEAMS_DATA
  : [
  { team: 4414, name: "HighTide", location: "Ventura, CA, USA", epa: 356.9, auto_epa: 75.1, teleop_epa: 195.9, endgame_epa: 86.0, winrate: 97.2, rank: 1, record: "70-2-0", rookie: 2022 },
  { team: 254, name: "The Cheesy Poofs", location: "San Jose, CA, USA", epa: 328.1, auto_epa: 78.5, teleop_epa: 169.9, endgame_epa: 79.8, winrate: 91.5, rank: 2, record: "65-6-0", rookie: 1999 },
  { team: 7769, name: "The CREW", location: "Sterling Heights, MI, USA", epa: 311.6, auto_epa: 67.8, teleop_epa: 175.4, endgame_epa: 68.5, winrate: 93.3, rank: 3, record: "70-5-0", rookie: 2019 },
  { team: 1323, name: "MadTown Robotics", location: "Madera, CA, USA", epa: 310.0, auto_epa: 73.8, teleop_epa: 169.6, endgame_epa: 66.6, winrate: 94.5, rank: 4, record: "69-4-0", rookie: 2004 },
  { team: 2056, name: "OP Robotics", location: "Stoney Creek, ON, Canada", epa: 302.2, auto_epa: 83.9, teleop_epa: 169.0, endgame_epa: 49.3, winrate: 86.3, rank: 5, record: "63-10-0", rookie: 2007 },
  { team: 1690, name: "Orbit", location: "Binyamina, Israel", epa: 295.4, auto_epa: 67.5, teleop_epa: 165.9, endgame_epa: 62.1, winrate: 80.0, rank: 6, record: "16-4-0", rookie: 2005 },
  { team: 27, name: "Team RUSH", location: "Clarkston, MI, USA", epa: 295.1, auto_epa: 74.0, teleop_epa: 154.6, endgame_epa: 66.6, winrate: 88.2, rank: 7, record: "58-8-0", rookie: 1997 },
  { team: 1114, name: "Simbotics", location: "St. Catharines, ON, Canada", epa: 287.6, auto_epa: 73.1, teleop_epa: 140.5, endgame_epa: 73.9, winrate: 89.9, rank: 8, record: "62-7-0", rookie: 2003 },
  { team: 2481, name: "Roboteers", location: "Tremont, IL, USA", epa: 285.0, auto_epa: 62.6, teleop_epa: 152.8, endgame_epa: 69.6, winrate: 86.8, rank: 9, record: "54-8-1", rookie: 2008 },
  { team: 5687, name: "The Outliers", location: "Bath, ME, USA", epa: 282.7, auto_epa: 74.0, teleop_epa: 155.1, endgame_epa: 53.6, winrate: 83.8, rank: 10, record: "62-12-1", rookie: 2015 },
  { team: 1678, name: "Citrus Circuits", location: "Davis, CA, USA", epa: 290.7, auto_epa: 61.7, teleop_epa: 159.4, endgame_epa: 69.6, winrate: 87.5, rank: 11, record: "59-8-0", rookie: 2005 },
  { team: 2910, name: "Jack in the Bot", location: "Mill Creek, WA, USA", epa: 278.4, auto_epa: 64.2, teleop_epa: 148.5, endgame_epa: 65.7, winrate: 84.1, rank: 12, record: "49-9-1", rookie: 2009 },
  { team: 118, name: "The Robonauts", location: "Houston, TX, USA", epa: 275.2, auto_epa: 62.1, teleop_epa: 147.0, endgame_epa: 66.1, winrate: 83.0, rank: 13, record: "48-10-0", rookie: 1997 },
  { team: 971, name: "Spartan Robotics", location: "Mountain View, CA, USA", epa: 271.8, auto_epa: 60.5, teleop_epa: 146.2, endgame_epa: 65.1, winrate: 82.0, rank: 14, record: "45-10-0", rookie: 2002 },
  { team: 3310, name: "Black Hawk Robotics", location: "Heath, TX, USA", epa: 268.5, auto_epa: 59.8, teleop_epa: 144.5, endgame_epa: 64.2, winrate: 81.5, rank: 15, record: "44-10-1", rookie: 2010 },
  { team: 148, name: "Robowranglers", location: "Greenville, TX, USA", epa: 265.4, auto_epa: 58.0, teleop_epa: 143.2, endgame_epa: 64.2, winrate: 80.5, rank: 16, record: "42-10-0", rookie: 1992 },
  { team: 973, name: "Greybots", location: "Atascadero, CA, USA", epa: 262.1, auto_epa: 57.5, teleop_epa: 141.0, endgame_epa: 63.6, winrate: 79.5, rank: 17, record: "40-11-0", rookie: 2002 },
  { team: 3476, name: "Code Orange", location: "Irvine, CA, USA", epa: 259.6, auto_epa: 56.4, teleop_epa: 140.2, endgame_epa: 63.0, winrate: 78.5, rank: 18, record: "38-11-0", rookie: 2010 },
  { team: 359, name: "Hawaiian Kids", location: "Waialua, HI, USA", epa: 256.3, auto_epa: 55.2, teleop_epa: 138.5, endgame_epa: 62.6, winrate: 78.0, rank: 19, record: "39-11-0", rookie: 2000 },
  { team: 604, name: "Quixilver", location: "San Jose, CA, USA", epa: 253.7, auto_epa: 54.8, teleop_epa: 137.1, endgame_epa: 61.8, winrate: 77.2, rank: 20, record: "37-11-1", rookie: 2001 },
  { team: 11744, name: "NYX Robotics", location: "San Diego, CA, USA", epa: 215.4, auto_epa: 48.6, teleop_epa: 112.5, endgame_epa: 54.3, winrate: 72.5, rank: 140, record: "22-8-0", rookie: 2026 },
  { team: 1538, name: "The Holy Cows", location: "San Diego, CA, USA", epa: 248.2, auto_epa: 53.0, teleop_epa: 134.5, endgame_epa: 60.7, winrate: 76.0, rank: 22, record: "35-11-0", rookie: 2005 },
  { team: 2485, name: "WARLords", location: "San Diego, CA, USA", epa: 242.5, auto_epa: 51.5, teleop_epa: 132.0, endgame_epa: 59.0, winrate: 74.8, rank: 24, record: "33-11-0", rookie: 2008 },
  { team: 3128, name: "Aluminum Narwhals", location: "San Diego, CA, USA", epa: 239.1, auto_epa: 50.8, teleop_epa: 130.4, endgame_epa: 57.9, winrate: 74.0, rank: 26, record: "32-11-1", rookie: 2009 }
];

let strategyPlays = [];
let strategyInitialized = false;
let playbookInitialized = false;
let activeTool = "pen";
let activeColor = "#a855f7";
let activeWidth = 4;
let playHistory = [];
let isDrawing = false;
let currentPath = [];
let shapeStart = null;
let draggedItem = null;
let draggedOffset = { x: 0, y: 0 };

/* Choreo FRC Multi-Trajectory Simulation State */
let isChoreoSimulating = false;
let choreoAnimId = null;
let choreoSimRobots = []; // Array of active simulating robots: [{ x, y, heading, speed, label, color, trajectory, currentIndex }]
let choreoSpeedMultiplier = 1.0;
let currentSortMetric = "epa";
let currentSearchQuery = "";

/* Switch Strategy Subtabs */
function switchStratTab(tabName) {
  currentStratTab = tabName;
  $$("#strategy-tabs .viewtab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.stratView === tabName);
  });
  $$("#mobile-strat-options .sheet-option").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.stratView === tabName);
  });

  const stratLabels = {
    "playbook": "Tactical Field Playbook",
    "rankings": "FRC Rankings & Statbotics",
    "scouting": "Match Scouting Form",
    "simulator": "Match Simulator",
    "lookup": "Team Deep Dive"
  };

  const elMobileStratLbl = $("#mobile-current-strat-label");
  if (elMobileStratLbl && stratLabels[tabName]) {
    elMobileStratLbl.textContent = stratLabels[tabName];
  }

  $("#view-strat-playbook")?.classList.toggle("hidden", tabName !== "playbook");
  $("#view-strat-rankings")?.classList.toggle("hidden", tabName !== "rankings");
  $("#view-strat-scouting")?.classList.toggle("hidden", tabName !== "scouting");
  $("#view-strat-simulator")?.classList.toggle("hidden", tabName !== "simulator");
  $("#view-strat-lookup")?.classList.toggle("hidden", tabName !== "lookup");

  if (tabName === "playbook") {
    setTimeout(renderCanvas, 50);
  }
}

/* Initialize Strategy Center */
function initStrategyCenter() {
  if (!strategyInitialized) {
    strategyInitialized = true;
    initPlaybook();
    initSimulator();
    initScoutingSystem();
    initScoutHub({
      getClient: () => supabase,
      getUser: () => currentUser,
      getProfile: () => currentProfile,
      getRecords: () => scoutingRecords,
      toast,
      esc,
      logAction,
    });
    renderRankings();
    loadSavedPlays();
    populateSimulatorSelectors();

    // Strategy Subtabs Click
    $$("#strategy-tabs .viewtab").forEach(tab => {
      tab.addEventListener("click", () => switchStratTab(tab.dataset.stratView));
    });

    // Statbotics live sync button
    $("#strat-sync-btn")?.addEventListener("click", () => syncStatboticsData(false));

    // Real-time automatic sync on initial strategy visit
    syncStatboticsData(true);

    // Rankings search & sort
    $("#strat-team-search")?.addEventListener("input", e => {
      currentSearchQuery = e.target.value.trim().toLowerCase();
      rankingsCurrentPage = 1;
      renderRankings();
    });

    $$("#strat-sort-tabs .catbtn").forEach(btn => {
      btn.addEventListener("click", () => {
        $$("#strat-sort-tabs .catbtn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentSortMetric = btn.dataset.sort;
        rankingsCurrentPage = 1;
        renderRankings();
      });
    });

    // Team lookup form
    $("#team-lookup-form")?.addEventListener("submit", handleTeamLookup);
  }
}

/* --------------------------------------------------------------------------
   LIVE 2026 STATBOTICS SYNC FUNCTION
   -------------------------------------------------------------------------- */
let isSyncingStatbotics = false;
let lastStatboticsSyncTime = 0;

async function syncSingleTeamStatbotics(t) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    // Query 2026 year first, fallback to team summary
    let res = await fetch(`https://api.statbotics.io/v3/team_year/${t.team}/2026`, { signal: controller.signal });
    if (!res.ok) {
      res = await fetch(`https://api.statbotics.io/v3/team/${t.team}`, { signal: controller.signal });
    }
    clearTimeout(tid);
    if (res.ok) {
      const d = await res.json();
      if (d) {
        const epaVal = d.epa?.breakdown?.total_points?.mean ?? d.epa_end ?? d.epa ?? (d.norm_epa?.current ? (d.norm_epa.current - 1500) / 10 + 40 : null);
        if (epaVal != null && !isNaN(epaVal)) {
          t.epa = Number(Number(epaVal).toFixed(1));
          t.auto_epa = Number((d.epa?.breakdown?.auto_points?.mean ?? d.auto_epa_end ?? d.auto_epa ?? (epaVal * 0.25)).toFixed(1));
          t.teleop_epa = Number((d.epa?.breakdown?.teleop_points?.mean ?? d.teleop_epa_end ?? d.teleop_epa ?? (epaVal * 0.58)).toFixed(1));
          t.endgame_epa = Number((d.epa?.breakdown?.endgame_points?.mean ?? d.endgame_epa_end ?? d.endgame_epa ?? (epaVal * 0.17)).toFixed(1));
          if (d.record?.winrate != null) t.winrate = Number((d.record.winrate * 100).toFixed(1));
          return true;
        }
      }
    }
  } catch (e) {}
  return false;
}

async function syncStatboticsData(silent = false) {
  if (isSyncingStatbotics) return;
  isSyncingStatbotics = true;

  const syncBtn = $("#strat-sync-btn");
  if (syncBtn && !silent) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = `<i class=fa-hourglass-half aria-hidden=true></i> Live Syncing Statbotics…`;
  }
  if (!silent) toast("Fetching real-time 2026 metrics from Statbotics...");

  // Sync teams in concurrent batches of 4
  let updatedCount = 0;
  const batchSize = 4;
  for (let i = 0; i < frcTeamsData.length; i += batchSize) {
    const batch = frcTeamsData.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(t => syncSingleTeamStatbotics(t)));
    updatedCount += results.filter(Boolean).length;
    // Keep UI responsive
    if (i === 0 && !silent) renderRankings();
  }

  isSyncingStatbotics = false;
  lastStatboticsSyncTime = Date.now();

  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.innerHTML = `<i class=fa-arrows-rotate aria-hidden=true></i> Live Sync Connected`;
  }

  renderRankings();
  populateSimulatorSelectors();
  if (!silent) {
    toast(updatedCount > 0 ? `Real-time sync complete: Updated ${updatedCount} teams from Statbotics!` : "Real-time sync active (data up to date).");
  }
}

/* --------------------------------------------------------------------------
   TACTICAL FIELD PLAYBOOK (CANVAS)
   -------------------------------------------------------------------------- */
function drawField(ctx, width, height) {
  // Field carpet mat - sleek dark theme to match Nyx Dashboard
  ctx.fillStyle = "#0c0d12";
  ctx.fillRect(0, 0, width, height);

  // Field carpet subtle tactical grid
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  // Field Perimeter Border (Neon Accent & Dark Wall)
  ctx.strokeStyle = "rgba(168, 85, 247, 0.4)";
  ctx.lineWidth = 4;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  // Inner field background tint
  ctx.fillStyle = "#12141c";
  ctx.fillRect(14, 14, width - 28, height - 28);

  // Center Line (Vertical White/Purple Divider)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(width / 2, 12); ctx.lineTo(width / 2, height - 12); ctx.stroke();

  // Auto Line - Red Alliance
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(width * 0.31, 12); ctx.lineTo(width * 0.31, height - 12); ctx.stroke();
  // Auto Line - Blue Alliance
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(width * 0.69, 12); ctx.lineTo(width * 0.69, height - 12); ctx.stroke();

  // Driver Station Player Area Extensions (Beyond perimeter walls)
  // Red side extension lines
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(12, 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(12, height - 12); ctx.lineTo(12, height); ctx.stroke();
  // Blue side extension lines
  ctx.strokeStyle = "#3b82f6";
  ctx.beginPath(); ctx.moveTo(width - 12, 0); ctx.lineTo(width - 12, 12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(width - 12, height - 12); ctx.lineTo(width - 12, height); ctx.stroke();

  // 1. CENTER FUEL STACK (Yellow Fuel Matrix in Center Field)
  const centerW = 76, centerH = 170;
  const cx = width / 2 - centerW / 2;
  const cy = height / 2 - centerH / 2;
  ctx.fillStyle = "rgba(234, 179, 8, 0.08)";
  ctx.fillRect(cx, cy, centerW, centerH);
  ctx.strokeStyle = "rgba(234, 179, 8, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx, cy, centerW, centerH);

  // Center dividing line between upper/lower fuel matrix
  ctx.beginPath(); ctx.moveTo(cx, height / 2); ctx.lineTo(cx + centerW, height / 2); ctx.stroke();

  // Draw fuel ball matrix
  ctx.fillStyle = "#eab308";
  ctx.strokeStyle = "#ca8a04";
  ctx.lineWidth = 1;
  const cols = 6;
  const rows = 16;
  const stepX = centerW / (cols + 1);
  const stepY = centerH / (rows + 1);
  for (let c = 1; c <= cols; c++) {
    for (let r = 1; r <= rows; r++) {
      const bx = cx + c * stepX;
      const by = cy + r * stepY;
      ctx.beginPath();
      ctx.arc(bx, by, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // 2. CORNER FUEL HOPPERS / DEPOTS (From official diagram)
  function drawFuelDepotBox(x, y, isRed) {
    ctx.save();
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 2.5;
    ctx.fillStyle = isRed ? "rgba(239, 68, 68, 0.15)" : "rgba(59, 130, 246, 0.15)";
    ctx.fillRect(x, y, 32, 42);
    ctx.strokeRect(x, y, 32, 42);
    // Draw fuel inside
    ctx.fillStyle = "#eab308";
    ctx.strokeStyle = "#ca8a04";
    ctx.lineWidth = 1;
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 4; r++) {
        ctx.beginPath();
        ctx.arc(x + 6 + c * 10, y + 6 + r * 10, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Red Left Wall Fuel Depot (Upper Left)
  drawFuelDepotBox(12, 105, true);
  // Red Outside Driver Station Bottom Fuel (Bottom Left)
  drawFuelDepotBox(-22, height - 54, true);

  // Blue Right Wall Fuel Depot (Lower Right)
  drawFuelDepotBox(width - 44, height - 147, false);
  // Blue Outside Driver Station Top Fuel (Top Right)
  drawFuelDepotBox(width - 10, 14, false);

  // 3. DRIVER STATIONS & TOWER CLIMBERS (Dark Box Structures on Walls)
  function drawTowerWallBase(x, y, isRed) {
    ctx.fillStyle = "#181a24";
    ctx.fillRect(x, y, 48, 56);
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x, y, 48, 56);

    // Diagonal truss lines
    ctx.strokeStyle = isRed ? "rgba(239, 68, 68, 0.4)" : "rgba(59, 130, 246, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x + 48, y + 56);
    ctx.moveTo(x + 48, y); ctx.lineTo(x, y + 56);
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 9px JetBrains Mono";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("TOWER", x + 24, y + 28);
  }

  // Red driver wall tower base (Mid-left)
  drawTowerWallBase(12, height / 2 - 28, true);
  // Blue driver wall tower base (Mid-right)
  drawTowerWallBase(width - 60, height / 2 - 28, false);

  // Driver Station ID labels
  ctx.font = "bold 11px JetBrains Mono";
  ctx.fillStyle = "#ef4444";
  ctx.textAlign = "left";
  ctx.fillText("R1", 18, 65);
  ctx.fillText("R2", 18, 165);
  ctx.fillText("R3", 18, height - 95);

  ctx.fillStyle = "#3b82f6";
  ctx.textAlign = "right";
  ctx.fillText("B3", width - 18, 145);
  ctx.fillText("B2", width - 18, height - 165);
  ctx.fillText("B1", width - 18, height - 65);

  // 4. VERTICAL FIELD STRUCTURES (BUMPS, HUBS, TRENCHES)
  function drawRebuiltFieldStructure(cx, isRed) {
    ctx.save();
    const color = isRed ? "#991b1b" : "#1e40af";
    const lightColor = isRed ? "#f87171" : "#60a5fa";

    // Full Vertical Structure Runway (Bump & Trench Platform)
    ctx.fillStyle = isRed ? "rgba(185, 28, 28, 0.4)" : "rgba(29, 78, 216, 0.4)";
    ctx.fillRect(cx - 26, 95, 52, height - 190);
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 26, 95, 52, height - 190);

    // Top & Bottom Outrigger Guide Rails extending beyond field perimeter
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 4;
    // Top extension
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, 95);
    ctx.stroke();
    // Bottom extension
    ctx.beginPath();
    ctx.moveTo(cx, height - 95);
    ctx.lineTo(cx, height);
    ctx.stroke();

    // Bottom Catch / Cradle Ring
    ctx.beginPath();
    ctx.arc(cx, height - 95, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Top Notch / Entry Guide
    ctx.fillStyle = isRed ? "#7f1d1d" : "#1e3a8a";
    ctx.fillRect(cx - 26, 95, 52, 14);

    // Labels for Trench & Bump
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 9px JetBrains Mono";
    ctx.textAlign = "center";
    ctx.fillText("TRENCH", cx, 125);
    ctx.fillText("BUMP", cx, height - 120);

    // CENTRAL HUB UNIT (Hexagonal Upper Funnel with Lower Collector Catch Basin)
    const hy = height / 2;

    // Outer catch ring
    ctx.strokeStyle = "rgba(148, 163, 184, 0.5)";
    ctx.lineWidth = 2.5;
    ctx.strokeRect(cx - 36, hy - 36, 72, 72);

    // Outer Hexagon
    ctx.beginPath();
    const rOuter = 28;
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const hx = cx + rOuter * Math.cos(angle);
      const h_y = hy + rOuter * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, h_y);
      else ctx.lineTo(hx, h_y);
    }
    ctx.closePath();
    ctx.fillStyle = isRed ? "rgba(220, 38, 38, 0.3)" : "rgba(37, 99, 235, 0.3)";
    ctx.fill();
    ctx.strokeStyle = isRed ? "#ef4444" : "#3b82f6";
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Inner Hexagon Target (Dark Opening)
    ctx.beginPath();
    const rInner = 16;
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const hx = cx + rInner * Math.cos(angle);
      const h_y = hy + rInner * Math.sin(angle);
      if (i === 0) ctx.moveTo(hx, h_y);
      else ctx.lineTo(hx, h_y);
    }
    ctx.closePath();
    ctx.fillStyle = "#0f172a";
    ctx.fill();
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Center Hub Text
    ctx.fillStyle = "#facc15";
    ctx.font = "bold 8px JetBrains Mono";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HUB", cx, hy);

    ctx.restore();
  }

  // Red Side Vertical Structure (Left)
  drawRebuiltFieldStructure(width * 0.33, true);
  // Blue Side Vertical Structure (Right)
  drawRebuiltFieldStructure(width * 0.67, false);

  // Field Watermark
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.font = "bold 20px Space Grotesk, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("2026 FIRST REBUILT — TACTICAL FIELD", width / 2, 42);
}

function drawArrowHead(ctx, fromX, fromY, toX, toY, color, width) {
  const headlen = 15;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - headlen * Math.cos(angle - Math.PI / 6), toY - headlen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(toX - headlen * Math.cos(angle + Math.PI / 6), toY - headlen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function renderCanvas() {
  const canvas = $("#field-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  drawField(ctx, canvas.width, canvas.height);

  playHistory.forEach(action => {
    if (action.type === 'pen' && action.points.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = action.color;
      ctx.lineWidth = action.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      action.points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    } else if (action.type === 'line') {
      ctx.beginPath();
      ctx.strokeStyle = action.color;
      ctx.lineWidth = action.width;
      ctx.lineCap = 'round';
      ctx.moveTo(action.start.x, action.start.y);
      ctx.lineTo(action.end.x, action.end.y);
      ctx.stroke();
    } else if (action.type === 'arrow') {
      drawArrowHead(ctx, action.start.x, action.start.y, action.end.x, action.end.y, action.color, action.width);
    } else if (action.type === 'token') {
      ctx.beginPath();
      ctx.arc(action.x, action.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = action.color;
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px JetBrains Mono";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(action.label, action.x, action.y);
    } else if (action.type === 'piece') {
      if (action.kind === 'fuel') {
        ctx.beginPath();
        ctx.arc(action.x, action.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = "#eab308";
        ctx.fill();
        ctx.strokeStyle = "#fef08a";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = "#000000";
        ctx.font = "bold 8px JetBrains Mono";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("F", action.x, action.y);
      } else {
        // Artifact / Relic
        ctx.fillStyle = "#10b981";
        ctx.strokeStyle = "#a7f3d0";
        ctx.lineWidth = 2;
        ctx.fillRect(action.x - 10, action.y - 10, 20, 20);
        ctx.strokeRect(action.x - 10, action.y - 10, 20, 20);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 9px JetBrains Mono";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("A", action.x, action.y);
      }
    }
  });

  // Draw all Choreo Multi-Trajectory Simulated Robots
  if (Array.isArray(choreoSimRobots) && choreoSimRobots.length > 0) {
    choreoSimRobots.forEach(bot => drawChoreoGhostRobot(ctx, bot));
  }
}

function drawChoreoGhostRobot(ctx, bot) {
  ctx.save();
  ctx.translate(bot.x, bot.y);
  ctx.rotate(bot.heading);

  const bSize = 34;
  const half = bSize / 2;
  const botColor = bot.color || (bot.alliance === "blue" ? "#3b82f6" : "#a855f7");

  // Swerve Chassis Bumper with neon border
  ctx.shadowColor = botColor;
  ctx.shadowBlur = 14;

  ctx.fillStyle = botColor === "#3b82f6" ? "rgba(30, 58, 138, 0.9)" : botColor === "#ef4444" ? "rgba(153, 27, 27, 0.9)" : "rgba(88, 28, 135, 0.9)";
  ctx.fillRect(-half, -half, bSize, bSize);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2.5;
  ctx.strokeRect(-half, -half, bSize, bSize);

  // 4 Swerve Module Pods in corners
  const podR = 4;
  ctx.fillStyle = "#facc15";
  [
    [-half + 5, -half + 5],
    [half - 5, -half + 5],
    [half - 5, half - 5],
    [-half + 5, half - 5]
  ].forEach(([px, py]) => {
    ctx.beginPath();
    ctx.arc(px, py, podR, 0, Math.PI * 2);
    ctx.fill();
  });

  // Robot Direction / Front Intake Indicator Arrow
  ctx.beginPath();
  ctx.moveTo(0, -half + 4);
  ctx.lineTo(half - 6, 0);
  ctx.lineTo(0, half - 4);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Robot Center Label (e.g. R1, R2, B1, NYX)
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 9px JetBrains Mono";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(bot.label || "BOT", 0, 0);

  ctx.restore();

  // Trajectory Waypoint / Speed Telemetry HUD
  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.strokeStyle = botColor;
  ctx.lineWidth = 1;
  ctx.fillRect(bot.x + 20, bot.y - 24, 105, 36);
  ctx.strokeRect(bot.x + 20, bot.y - 24, 105, 36);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 9px JetBrains Mono";
  ctx.fillText(`${bot.label || "CHOREO"} SWERVE`, bot.x + 24, bot.y - 14);
  ctx.fillStyle = "#a7f3d0";
  ctx.fillText(`v: ${bot.speed ? bot.speed.toFixed(1) : "3.8"} m/s`, bot.x + 24, bot.y - 3);
  ctx.restore();
}

function initPlaybook() {
  if (playbookInitialized) return;
  playbookInitialized = true;

  const canvas = $("#field-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  renderCanvas();

  let activePointerId = null;

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY != null ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  }

  // Touch gesture isolation: prevent browser pinch/zoom/scroll from creating multi-touch artifacts
  canvas.addEventListener("touchstart", e => {
    if (e.touches.length > 1) {
      // Two-finger pinch or zoom: cancel any active drawing cleanly without bugging out
      if (isDrawing) {
        isDrawing = false;
        activePointerId = null;
        currentPath = [];
        shapeStart = null;
        renderCanvas();
      }
      return;
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchmove", e => {
    if (e.touches.length > 1) {
      if (isDrawing) {
        isDrawing = false;
        activePointerId = null;
        currentPath = [];
        shapeStart = null;
        renderCanvas();
      }
      return;
    }
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener("touchend", e => {
    if (e.touches.length === 0 && isDrawing) {
      stopDrawing(e);
    }
  }, { passive: false });

  // Pointer events with single active pointer lock
  canvas.addEventListener("pointerdown", e => {
    if (activePointerId !== null && activePointerId !== e.pointerId) {
      e.preventDefault();
      return;
    }
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    const coords = getCanvasCoords(e);
    isDrawing = true;
    if (activeTool === "pen") {
      currentPath = [coords];
    } else if (activeTool === "line" || activeTool === "arrow") {
      shapeStart = coords;
    } else if (activeTool === "token-red") {
      const redCount = playHistory.filter(a => a.type === 'token' && a.label?.startsWith('R')).length;
      playHistory.push({ type: 'token', x: coords.x, y: coords.y, label: `R${(redCount % 3) + 1}`, color: '#ef4444' });
      renderCanvas();
      isDrawing = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointerId = null;
    } else if (activeTool === "token-blue") {
      const blueCount = playHistory.filter(a => a.type === 'token' && a.label?.startsWith('B')).length;
      playHistory.push({ type: 'token', x: coords.x, y: coords.y, label: `B${(blueCount % 3) + 1}`, color: '#3b82f6' });
      renderCanvas();
      isDrawing = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointerId = null;
    } else if (activeTool === "piece-fuel") {
      playHistory.push({ type: 'piece', x: coords.x, y: coords.y, kind: 'fuel' });
      renderCanvas();
      isDrawing = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointerId = null;
    } else if (activeTool === "piece-relic") {
      playHistory.push({ type: 'piece', x: coords.x, y: coords.y, kind: 'relic' });
      renderCanvas();
      isDrawing = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      activePointerId = null;
    } else if (activeTool === "eraser") {
      eraseAtPoint(coords.x, coords.y);
    }
  });

  function eraseAtPoint(x, y) {
    const eraserRadius = 30;
    const initialLen = playHistory.length;
    playHistory = playHistory.filter(action => {
      if (action.type === 'token' || action.type === 'piece') {
        return Math.hypot(action.x - x, action.y - y) > eraserRadius;
      }
      if (action.type === 'pen' && action.points && action.points.length > 0) {
        // Keep pen strokes whose points don't come within radius of eraser
        const hits = action.points.some(pt => Math.hypot(pt.x - x, pt.y - y) <= eraserRadius);
        return !hits;
      }
      if (action.type === 'line' || action.type === 'arrow') {
        if (!action.start || !action.end) return true;
        // Check distance to line segment
        const d = distToSegment({ x, y }, action.start, action.end);
        return d > eraserRadius;
      }
      return true;
    });
    if (playHistory.length !== initialLen) {
      renderCanvas();
    }
  }

  function distToSegment(p, v, w) {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  }

  canvas.addEventListener("pointermove", e => {
    if (!isDrawing || (activePointerId !== null && e.pointerId !== activePointerId)) return;
    const coords = getCanvasCoords(e);
    if (activeTool === "eraser") {
      eraseAtPoint(coords.x, coords.y);
      return;
    }
    if (activeTool === "pen") {
      currentPath.push(coords);
      ctx.beginPath();
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = activeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const len = currentPath.length;
      if (len > 1) {
        ctx.moveTo(currentPath[len - 2].x, currentPath[len - 2].y);
        ctx.lineTo(currentPath[len - 1].x, currentPath[len - 1].y);
        ctx.stroke();
      }
    } else if (activeTool === "line" && shapeStart) {
      renderCanvas();
      ctx.beginPath();
      ctx.strokeStyle = activeColor;
      ctx.lineWidth = activeWidth;
      ctx.moveTo(shapeStart.x, shapeStart.y);
      ctx.lineTo(coords.x, coords.y);
      ctx.stroke();
    } else if (activeTool === "arrow" && shapeStart) {
      renderCanvas();
      drawArrowHead(ctx, shapeStart.x, shapeStart.y, coords.x, coords.y, activeColor, activeWidth);
    }
  });

  const stopDrawing = (e) => {
    if (!isDrawing) return;
    if (e && activePointerId !== null && e.pointerId !== activePointerId) return;
    isDrawing = false;
    if (activePointerId !== null && canvas.hasPointerCapture && canvas.hasPointerCapture(activePointerId)) {
      try { canvas.releasePointerCapture(activePointerId); } catch (_) {}
    }
    activePointerId = null;



    const coords = e ? getCanvasCoords(e) : null;
    if (activeTool === "pen" && currentPath.length > 1) {
      playHistory.push({ type: 'pen', points: [...currentPath], color: activeColor, width: activeWidth });
      currentPath = [];
      renderCanvas();
    } else if (activeTool === "line" && shapeStart && coords) {
      playHistory.push({ type: 'line', start: shapeStart, end: coords, color: activeColor, width: activeWidth });
      shapeStart = null;
      renderCanvas();
    } else if (activeTool === "arrow" && shapeStart && coords) {
      playHistory.push({ type: 'arrow', start: shapeStart, end: coords, color: activeColor, width: activeWidth });
      shapeStart = null;
      renderCanvas();
    }
  };

  canvas.addEventListener("pointerup", stopDrawing);
  canvas.addEventListener("pointercancel", stopDrawing);

  // Tool buttons
  $$(".playbook-toolbar .tool-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".playbook-toolbar .tool-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeTool = btn.dataset.tool;
      if (activeTool === "move") {
        canvas.style.cursor = "grab";
        canvas.style.touchAction = "pan-y pan-x";
      } else {
        canvas.style.cursor = "crosshair";
        canvas.style.touchAction = "none";
      }
    });
  });

  // Color swatches
  $$(".playbook-toolbar .swatch").forEach(swatch => {
    swatch.addEventListener("click", () => {
      $$(".playbook-toolbar .swatch").forEach(s => s.classList.remove("active"));
      swatch.classList.add("active");
      activeColor = swatch.dataset.color;
    });
  });

  // Size buttons
  $$(".playbook-toolbar .size-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".playbook-toolbar .size-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeWidth = parseInt(btn.dataset.size, 10);
    });
  });

  // Undo, Clear, Export
  $("#field-undo-btn")?.addEventListener("click", () => {
    if (playHistory.length > 0) {
      playHistory.pop();
      renderCanvas();
    }
  });

  $("#field-clear-btn")?.addEventListener("click", () => {
    if (playHistory.length === 0) return;
    if (confirm("Clear all tactical marks on the field?")) {
      playHistory = [];
      renderCanvas();
      toast("Field cleared.");
    }
  });

  $("#field-export-btn")?.addEventListener("click", () => {
    const link = document.createElement("a");
    const name = ($("#playbook-plan-name")?.value.trim() || "nyx-rebuilt-play").toLowerCase().replace(/[^a-z0-9]/g, "-");
    link.download = `${name}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
    toast("Exported playbook image!");
  });

  // Choreo Simulation Trigger
  $("#field-choreo-play-btn")?.addEventListener("click", toggleChoreoSimulation);

  // Save Play
  $("#playbook-save-btn")?.addEventListener("click", savePlaybookPlay);

  // Fullscreen Playbook & Apple Whiteboard Drawer Toggle
  const fsBtn = $("#field-fullscreen-btn");
  const pbContainer = $(".playbook-container");
  const toolsToggleBtn = $("#field-tools-toggle-btn");
  const floatFsBtn = $("#field-float-fs-btn");
  const floatUndoBtn = $("#field-float-undo-btn");
  const floatClearBtn = $("#field-float-clear-btn");

  function toggleToolsDrawer(force) {
    if (!pbContainer) return;
    const isOpen = force !== undefined ? force : !pbContainer.classList.contains("tools-drawer-open");
    pbContainer.classList.toggle("tools-drawer-open", isOpen);
    toolsToggleBtn?.classList.toggle("is-open", isOpen);
  }

  function togglePlaybookFullscreen(force) {
    if (!pbContainer) return;
    const isActive = force !== undefined ? force : !pbContainer.classList.contains("fullscreen-active");
    pbContainer.classList.toggle("fullscreen-active", isActive);
    if (!isActive) {
      pbContainer.classList.remove("tools-drawer-open");
      toolsToggleBtn?.classList.remove("is-open");
    }
    if (fsBtn) fsBtn.innerHTML = isActive ? "✕ Exit Fullscreen" : "<i class=fa-expand aria-hidden=true></i> Fullscreen";
    setTimeout(renderCanvas, 60);
  }

  fsBtn?.addEventListener("click", () => togglePlaybookFullscreen());
  floatFsBtn?.addEventListener("click", () => togglePlaybookFullscreen(false));
  toolsToggleBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleToolsDrawer();
  });

  floatUndoBtn?.addEventListener("click", () => {
    if (playHistory.length > 0) {
      playHistory.pop();
      renderCanvas();
      toast("Undid last action.");
    }
  });

  floatClearBtn?.addEventListener("click", () => {
    if (playHistory.length === 0) return;
    if (confirm("Clear all tactical marks on the field?")) {
      playHistory = [];
      renderCanvas();
      toast("Field cleared.");
    }
  });

  // Close tools popover when user starts drawing or clicks outside
  canvas.addEventListener("pointerdown", () => {
    if (pbContainer.classList.contains("tools-drawer-open")) {
      toggleToolsDrawer(false);
    }
  });

  // Listen for orientation change on mobile devices: auto-fullscreen landscape field when in strategy tab
  function handleOrientationChange() {
    const isMobile = window.innerWidth <= 950 || window.innerHeight <= 600;
    const isLandscape = window.innerWidth > window.innerHeight;
    if (isMobile && isLandscape && currentAppPage === "strategy" && currentStratTab === "playbook") {
      document.body.classList.add("auto-landscape-playbook");
      togglePlaybookFullscreen(true);
    } else if (pbContainer && pbContainer.classList.contains("fullscreen-active") && !isLandscape && isMobile) {
      // Return to standard view when rotated back to portrait
      togglePlaybookFullscreen(false);
    }
  }

  window.addEventListener("resize", handleOrientationChange);
  window.addEventListener("orientationchange", handleOrientationChange);
}

/* Choreo Multi-Robot Trajectory Solver & Swerve Optimizer */
function toggleChoreoSimulation() {
  const btn = $("#field-choreo-play-btn");
  if (isChoreoSimulating) {
    stopChoreoSimulation();
    if (btn) {
      btn.innerHTML = `▶ Simulate Path (Choreo)`;
      btn.classList.remove("btn--danger");
      btn.classList.add("btn--primary");
    }
    toast("Choreo simulation paused.");
    return;
  }

  // Discover all paths associated with robots or drawn freehand
  const robotTracks = extractAllChoreoRobotTracks();

  if (!robotTracks.length) {
    toast("Place a robot token (Red Bot / Blue Bot) and draw a line/arrow from it!", true);
    return;
  }

  // Build optimized Choreo trajectories for each robot track
  choreoSimRobots = robotTracks.map(track => {
    const trajectory = generateChoreoTrajectory(track.waypoints);
    return {
      label: track.label,
      color: track.color,
      alliance: track.alliance,
      trajectory: trajectory,
      currentIndex: 0,
      x: trajectory[0].x,
      y: trajectory[0].y,
      heading: trajectory[0].heading,
      speed: trajectory[0].speed
    };
  });

  isChoreoSimulating = true;
  if (btn) {
    btn.innerHTML = `<i class=fa-stop aria-hidden=true></i> Stop Simulation (${choreoSimRobots.length} bot${choreoSimRobots.length > 1 ? "s" : ""})`;
    btn.classList.remove("btn--primary");
    btn.classList.add("btn--danger");
  }

  toast(`Running Choreo simulation for ${choreoSimRobots.length} robot${choreoSimRobots.length > 1 ? "s" : ""} simultaneously!`);
  runMultiChoreoAnimation();
}

function stopChoreoSimulation() {
  isChoreoSimulating = false;
  if (choreoAnimId) {
    cancelAnimationFrame(choreoAnimId);
    choreoAnimId = null;
  }
  choreoSimRobots = [];
  renderCanvas();
  const btn = $("#field-choreo-play-btn");
  if (btn) {
    btn.innerHTML = `▶ Simulate Path (Choreo)`;
    btn.classList.remove("btn--danger");
    btn.classList.add("btn--primary");
  }
}

function extractAllChoreoRobotTracks() {
  const tracks = [];
  const tokens = playHistory.filter(item => item.type === "token");
  const drawnPaths = playHistory.filter(item => item.type === "pen" || item.type === "arrow" || item.type === "line");
  const usedDrawnIndices = new Set();

  // 1. For every robot token on field, check if a drawn line/path starts from or near it (within 45px)
  tokens.forEach((tok, tokIdx) => {
    const matchingPaths = [];

    drawnPaths.forEach((path, pIdx) => {
      let startPt = null;
      let waypoints = [];

      if (path.type === "pen" && path.points && path.points.length > 1) {
        startPt = path.points[0];
        const step = Math.max(1, Math.floor(path.points.length / 25));
        for (let i = 0; i < path.points.length; i += step) {
          waypoints.push({ x: path.points[i].x, y: path.points[i].y });
        }
        waypoints.push(path.points[path.points.length - 1]);
      } else if (path.type === "arrow" || path.type === "line") {
        startPt = path.start;
        waypoints = [{ x: path.start.x, y: path.start.y }, { x: path.end.x, y: path.end.y }];
      }

      if (startPt && Math.hypot(startPt.x - tok.x, startPt.y - tok.y) <= 45) {
        usedDrawnIndices.add(pIdx);
        // Prepend exact robot position as start of path
        waypoints.unshift({ x: tok.x, y: tok.y });
        matchingPaths.push(waypoints);
      }
    });

    if (matchingPaths.length > 0) {
      // Robot has at least one path leading from it
      matchingPaths.forEach((pts, pSubIdx) => {
        tracks.push({
          label: tok.label || (tok.color === "#3b82f6" ? `B${tokIdx + 1}` : `R${tokIdx + 1}`),
          color: tok.color || (tok.label?.startsWith("B") ? "#3b82f6" : "#ef4444"),
          alliance: tok.label?.startsWith("B") || tok.color === "#3b82f6" ? "blue" : "red",
          waypoints: pts
        });
      });
    }
  });

  // 2. If no robot tokens were paired with drawn paths, assign any remaining drawn paths to autonomous robots
  drawnPaths.forEach((path, pIdx) => {
    if (usedDrawnIndices.has(pIdx)) return;

    const waypoints = [];
    if (path.type === "pen" && path.points && path.points.length > 1) {
      const step = Math.max(1, Math.floor(path.points.length / 25));
      for (let i = 0; i < path.points.length; i += step) {
        waypoints.push({ x: path.points[i].x, y: path.points[i].y });
      }
      waypoints.push(path.points[path.points.length - 1]);
    } else if (path.type === "arrow" || path.type === "line") {
      waypoints.push({ x: path.start.x, y: path.start.y });
      waypoints.push({ x: path.end.x, y: path.end.y });
    }

    if (waypoints.length >= 2) {
      const trackNum = tracks.length + 1;
      const pathColor = path.color || "#a855f7";
      tracks.push({
        label: `BOT ${trackNum}`,
        color: pathColor,
        alliance: pathColor === "#3b82f6" ? "blue" : pathColor === "#ef4444" ? "red" : "purple",
        waypoints: waypoints
      });
    }
  });

  // 3. If there are robot tokens but no lines drawn, connect tokens in sequence
  if (tracks.length === 0 && tokens.length >= 2) {
    const waypoints = tokens.map(tok => ({ x: tok.x, y: tok.y }));
    tracks.push({
      label: tokens[0].label || "BOT 1",
      color: tokens[0].color || "#a855f7",
      alliance: tokens[0].label?.startsWith("B") ? "blue" : "red",
      waypoints: waypoints
    });
  }

  return tracks;
}

function generateChoreoTrajectory(waypoints) {
  // Cubic Catmull-Rom interpolation with swerve kinematic profiling
  const trajectoryPoints = [];
  const totalWaypoints = waypoints.length;

  for (let i = 0; i < totalWaypoints - 1; i++) {
    const p0 = waypoints[Math.max(0, i - 1)];
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    const p3 = waypoints[Math.min(totalWaypoints - 1, i + 2)];

    const segmentDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(10, Math.floor(segmentDist / 4));

    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;

      // Catmull-Rom spline formula
      const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );

      // Tangent / velocity vector
      const dx = 0.5 * ((-p0.x + p2.x) + 2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t + 3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t2);
      const dy = 0.5 * ((-p0.y + p2.y) + 2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t + 3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t2);

      const heading = Math.atan2(dy, dx);
      const speed = Math.min(4.8, Math.max(1.2, Math.hypot(dx, dy) * 0.05));

      trajectoryPoints.push({ x, y, heading, speed });
    }
  }

  const last = waypoints[waypoints.length - 1];
  trajectoryPoints.push({ x: last.x, y: last.y, heading: 0, speed: 0 });
  return trajectoryPoints;
}

function runMultiChoreoAnimation() {
  function step() {
    if (!isChoreoSimulating || !choreoSimRobots.length) return;

    choreoSimRobots.forEach(bot => {
      if (bot.currentIndex >= bot.trajectory.length) {
        bot.currentIndex = 0;
      }
      const state = bot.trajectory[bot.currentIndex];
      bot.x = state.x;
      bot.y = state.y;
      bot.heading = state.heading;
      bot.speed = state.speed;
      bot.currentIndex++;
    });

    renderCanvas();
    choreoAnimId = requestAnimationFrame(step);
  }

  choreoAnimId = requestAnimationFrame(step);
}

/* Save Playbook Play to Supabase & localStorage */
async function savePlaybookPlay() {
  const input = $("#playbook-plan-name");
  const name = input ? input.value.trim() : "";
  if (!name) {
    toast("Please enter a name for this strategy play.", true);
    input?.focus();
    return;
  }

  const canvas = $("#field-canvas");
  const thumb = canvas ? canvas.toDataURL("image/png") : "";
  const myName = currentProfile?.full_name || currentUser?.email || "Team Member";

  const newPlay = {
    id: "play_" + Date.now(),
    name,
    history: playHistory,
    thumbnail: thumb,
    created_by: currentUser?.id || null,
    created_by_name: myName,
    created_at: new Date().toISOString()
  };

  // 1. Mirror in localStorage
  strategyPlays.unshift(newPlay);
  try {
    localStorage.setItem("nyx_strategy_plays", JSON.stringify(strategyPlays.slice(0, 30)));
  } catch (e) {
    console.warn("localStorage quota exceeded:", e);
  }

  // 2. Persist in Supabase
  if (supabase && currentUser) {
    try {
      await supabase.from("strategy_plays").insert({
        name,
        drawing_data: JSON.stringify(playHistory),
        created_by: currentUser.id,
        created_by_name: myName
      });
      await logAction("PLAYBOOK_SAVED", "strategy_plays", null, {
        play_name: name,
        strokes_count: playHistory.length,
        match_context: $("#strat-sim-match-type")?.value || "General Strategy"
      });
    } catch (err) {
      console.warn("Supabase strategy play insert notice:", err);
    }
  }

  toast(`Saved playbook: "${name}"`);
  renderSavedPlays();
}

/* Load Saved Plays */
async function loadSavedPlays() {
  // Load from localStorage first
  try {
    const raw = localStorage.getItem("nyx_strategy_plays");
    if (raw) strategyPlays = JSON.parse(raw);
  } catch (e) {}

  // Then sync from Supabase if available
  if (supabase) {
    try {
      const { data, error } = await supabase.from("strategy_plays")
        .select("id, name, drawing_data, notes, created_by, created_by_name, created_at")
        .order("created_at", { ascending: false })
        .limit(20);

      if (!error && Array.isArray(data) && data.length > 0) {
        data.forEach(item => {
          if (!strategyPlays.some(p => p.id === item.id)) {
            let hist = [];
            try { hist = JSON.parse(item.drawing_data); } catch (e) {}
            strategyPlays.push({
              id: item.id,
              name: item.name,
              history: hist,
              notes: item.notes || "",
              created_by: item.created_by || null,
              created_by_name: item.created_by_name || "Team Member",
              created_at: item.created_at
            });
          }
        });
      }
    } catch (err) {
      console.warn("Could not sync strategy_plays from Supabase:", err);
    }
  }

  renderSavedPlays();
}

function renderSavedPlays() {
  const grid = $("#saved-plays-grid");
  const countEl = $("#saved-plays-count-text");
  if (countEl) countEl.textContent = `Saved Plays (${strategyPlays.length})`;
  if (!grid) return;

  if (!strategyPlays.length) {
    grid.innerHTML = '<div class="muted small" style="padding:20px; text-align:center; grid-column:1/-1;">No saved plays yet. Draw a route above and click "Save Play"!</div>';
    return;
  }

  grid.innerHTML = strategyPlays.map(play => `
    <article class="play-card" data-play-id="${play.id}">
      <div class="play-card-body">
        <div class="play-card-title">${esc(play.name)}</div>
        <div class="play-card-meta">
          <span>By ${esc(play.created_by_name || 'Team Member')}</span>
          <span>${new Date(play.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
        </div>
        ${play.notes ? `
          <details class="small" style="margin:6px 0;">
            <summary style="cursor:pointer; color:var(--accent-bright);"><i class=fa-clipboard-list aria-hidden=true></i> Strategy notes</summary>
            <div style="white-space:pre-wrap; margin-top:6px; color:var(--text-muted); max-height:240px; overflow-y:auto;">${esc(play.notes)}</div>
          </details>
        ` : ''}
        <div class="play-card-actions">
          <button class="btn btn--sm btn--primary" data-action="load-play" data-id="${play.id}">Load <i class=fa-palette aria-hidden=true></i></button>
          ${(!play.created_by || play.created_by === currentUser?.id || currentProfile?.is_admin || play.created_by_name === (currentProfile?.full_name || currentUser?.email)) ? `
            <button class="actionbtn delete" data-action="delete-play" data-id="${play.id}" title="Delete play"><i class=fa-trash-can aria-hidden=true></i></button>
          ` : ''}
        </div>
      </div>
    </article>
  `).join("");
}

// Click events for saved plays
$("#saved-plays-grid")?.addEventListener("click", async e => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  const id = b.dataset.id;
  const play = strategyPlays.find(p => p.id === id);

  if (action === "load-play" && play) {
    playHistory = Array.isArray(play.history) ? [...play.history] : [];
    renderCanvas();
    if ($("#playbook-plan-name")) $("#playbook-plan-name").value = play.name;
    window.scrollTo({ top: $("#field-canvas").offsetTop - 80, behavior: 'smooth' });
    toast(`Loaded play "${play.name}"`);
  } else if (action === "delete-play" && play) {
    const isOwner = play.created_by ? play.created_by === currentUser?.id : play.created_by_name === (currentProfile?.full_name || currentUser?.email);
    if (!isOwner && !currentProfile?.is_admin) {
      toast("Only the author or an admin can delete this strategy play.", true);
      return;
    }
    const playName = play.name;
    // Instant optimistic removal from memory & UI
    strategyPlays = strategyPlays.filter(p => p.id !== id);
    try {
      localStorage.setItem("nyx_strategy_plays", JSON.stringify(strategyPlays));
    } catch (err) {}
    renderSavedPlays();
    toast(`Play "${playName}" deleted`);

    // Background sync to Supabase (match uuid or custom id)
    const targetPlay = strategyPlays.find(p => String(p.id) === String(id));
    if (supabase) {
      supabase.from("strategy_plays").delete().eq("id", id).then(() => {
        logAction("PLAYBOOK_DELETED", "strategy_plays", id, {
          play_name: targetPlay?.name || "Strategy Play"
        });
      }).catch(err => {
        console.warn("Background delete failed:", err);
      });
    }
  }
});

/* --------------------------------------------------------------------------
   FRC TEAM RANKINGS & STATBOTICS TABLE
   -------------------------------------------------------------------------- */
let rankingsCurrentPage = 1;
const RANKINGS_PAGE_SIZE = 50;

function renderRankings() {
  const list = $("#strat-rankings-list");
  if (!list) return;

  let filtered = frcTeamsData.filter(t => {
    if (!currentSearchQuery) return true;
    return (
      String(t.team).includes(currentSearchQuery) ||
      t.name.toLowerCase().includes(currentSearchQuery) ||
      t.location.toLowerCase().includes(currentSearchQuery)
    );
  });

  // Sort
  filtered.sort((a, b) => {
    if (currentSortMetric === "epa") return b.epa - a.epa;
    if (currentSortMetric === "auto_epa") return b.auto_epa - a.auto_epa;
    if (currentSortMetric === "teleop_epa") return b.teleop_epa - a.teleop_epa;
    if (currentSortMetric === "endgame_epa") return b.endgame_epa - a.endgame_epa;
    if (currentSortMetric === "scout_matches") return (b.scout_matches || 0) - (a.scout_matches || 0);
    if (currentSortMetric === "winrate") return b.winrate - a.winrate;
    return a.team - b.team;
  });

  const countBadge = $("#badge-strat-count");
  if (countBadge) countBadge.textContent = filtered.length;

  const pagDiv = $("#strat-rankings-pagination");

  if (!filtered.length) {
    list.innerHTML = '<div style="padding:40px; text-align:center;" class="muted">No teams match your search query. Try team number or city!</div>';
    if (pagDiv) pagDiv.innerHTML = "";
    return;
  }

  // Calculate pagination
  const totalPages = Math.ceil(filtered.length / RANKINGS_PAGE_SIZE) || 1;
  if (rankingsCurrentPage > totalPages) rankingsCurrentPage = totalPages;
  if (rankingsCurrentPage < 1) rankingsCurrentPage = 1;

  const startIndex = (rankingsCurrentPage - 1) * RANKINGS_PAGE_SIZE;
  const pageTeams = filtered.slice(startIndex, startIndex + RANKINGS_PAGE_SIZE);

  list.innerHTML = pageTeams.map((t, localIdx) => {
    const globalRank = startIndex + localIdx + 1;
    const isNyx = t.team === 11744;
    const scoutCount = t.scout_matches || 0;
    return `
      <article class="itemrow" style="grid-template-columns: 60px minmax(180px, 2fr) minmax(110px, 1fr) 85px 75px 75px 85px 85px 80px 100px; ${isNyx ? 'background:rgba(139,92,246,0.08); border-left:3px solid var(--accent);' : ''}">
        <div>
          <span class="rank-badge ${globalRank <= 3 ? 'top3' : ''}">#${globalRank}</span>
        </div>
        <div>
          <div class="itemname">
            <strong>${t.team}</strong> • <a href="https://www.statbotics.io/team/${t.team}" target="_blank" rel="noopener noreferrer" style="color:var(--text); text-decoration:none;" title="View on Statbotics">${esc(t.name)} ↗</a>
            ${isNyx ? '<span class="pill Business" style="font-size:9px;">HOME TEAM</span>' : ''}
          </div>
          <div class="itemnotes">Rookie: ${t.rookie || '-'} • Record: ${esc(t.record || '-')}</div>
        </div>
        <div class="muted small">${esc(t.location)}</div>
        <div>
          <strong class="mono" style="font-size:14px; color:var(--accent-bright);">${t.epa.toFixed(1)}</strong>
        </div>
        <div class="mono small">${t.auto_epa.toFixed(1)}</div>
        <div class="mono small">${t.teleop_epa.toFixed(1)}</div>
        <div class="mono small">${t.endgame_epa.toFixed(1)}</div>
        <div>
          ${scoutCount > 0 ? `<span class="pill" style="background:var(--accent-dim); color:var(--accent-soft); font-size:10px; font-weight:700;">${scoutCount} match${scoutCount > 1 ? 'es' : ''}</span>` : '<span class="muted small">-</span>'}
        </div>
        <div>
          <span class="pill" style="color:${t.winrate >= 80 ? 'var(--green)' : 'var(--text)'}; font-size:10px;">${t.winrate.toFixed(1)}%</span>
        </div>
        <div class="actions">
          <button class="btn btn--sm btn--ghost" data-action="quick-sim" data-team="${t.team}">Simulate <i class=fa-bolt aria-hidden=true></i></button>
        </div>
      </article>
    `;
  }).join("");

  if (pagDiv) {
    pagDiv.innerHTML = `
      <div class="muted small">
        Showing <strong>${startIndex + 1}</strong> – <strong>${Math.min(startIndex + RANKINGS_PAGE_SIZE, filtered.length)}</strong> of <strong>${filtered.length.toLocaleString()}</strong> teams
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        <button class="btn btn--ghost btn--sm" id="strat-pag-prev" ${rankingsCurrentPage === 1 ? 'disabled' : ''}>← Prev</button>
        <span class="muted small mono" style="padding:0 8px;">Page ${rankingsCurrentPage} of ${totalPages}</span>
        <button class="btn btn--ghost btn--sm" id="strat-pag-next" ${rankingsCurrentPage === totalPages ? 'disabled' : ''}>Next →</button>
      </div>
    `;

    $("#strat-pag-prev")?.addEventListener("click", () => {
      if (rankingsCurrentPage > 1) {
        rankingsCurrentPage--;
        renderRankings();
        list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });

    $("#strat-pag-next")?.addEventListener("click", () => {
      if (rankingsCurrentPage < totalPages) {
        rankingsCurrentPage++;
        renderRankings();
        list.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  }
}

// Quick simulate click from rankings
$("#strat-rankings-list")?.addEventListener("click", e => {
  const b = e.target.closest("button[data-action='quick-sim']");
  if (!b) return;
  const teamNum = parseInt(b.dataset.team, 10);
  switchStratTab("simulator");
  const sel = $("#sim-red-1");
  if (sel) {
    sel.value = String(teamNum);
    updateSimTotals();
  }
  toast(`Loaded Team ${teamNum} into Red Alliance Captain!`);
});

/* --------------------------------------------------------------------------
   MATCH SIMULATOR (MONTE CARLO 1,000 ITERATIONS)
   -------------------------------------------------------------------------- */
function buildTeamOptionsHtml(filterQuery, currentVal) {
  let list = [...frcTeamsData];
  if (filterQuery) {
    const q = filterQuery.toLowerCase().trim();
    list = list.filter(t => String(t.team).includes(q) || (t.name || "").toLowerCase().includes(q));
  }
  // Ensure currently selected team is present even if filter excludes it
  if (currentVal && !list.some(t => String(t.team) === String(currentVal))) {
    const currTeam = getTeamByNum(parseInt(currentVal, 10));
    if (currTeam) list.unshift(currTeam);
  }
  list.sort((a, b) => b.epa - a.epa);
  return list.map(t => `
    <option value="${t.team}">${t.team} — ${esc(t.name)} (EPA: ${t.epa.toFixed(1)})</option>
  `).join("");
}

function populateSimulatorSelectors() {
  const selects = [
    $("#sim-red-1"), $("#sim-red-2"), $("#sim-red-3"),
    $("#sim-blue-1"), $("#sim-blue-2"), $("#sim-blue-3")
  ];

  selects.forEach((sel, idx) => {
    if (!sel) return;
    const currentVal = sel.value || (
      idx === 0 ? "11744" : idx === 1 ? "254" : idx === 2 ? "1678" :
      idx === 3 ? "4414" : idx === 4 ? "1323" : "971"
    );
    sel.innerHTML = buildTeamOptionsHtml("", currentVal);
    sel.value = currentVal;

    if (!sel._hasListener) {
      sel.addEventListener("change", updateSimTotals);
      sel._hasListener = true;
    }
  });

  // Attach search listeners for all 6 robot slot search bars
  $$(".sim-slot-search").forEach(input => {
    if (input._hasListener) return;
    input._hasListener = true;
    input.addEventListener("input", e => {
      const targetId = input.dataset.target;
      const sel = $(`#${targetId}`);
      if (!sel) return;
      const currentVal = sel.value;
      const q = e.target.value.trim();
      sel.innerHTML = buildTeamOptionsHtml(q, currentVal);
      if (currentVal) sel.value = currentVal;
      updateSimTotals();
    });
  });

  updateSimTotals();
}

function getTeamByNum(num) {
  return frcTeamsData.find(t => t.team === num) || {
    team: num, name: `Team ${num}`, epa: 45.0, auto_epa: 10.0, teleop_epa: 25.0, endgame_epa: 10.0
  };
}

function updateSimTotals() {
  const r1 = getTeamByNum(parseInt($("#sim-red-1")?.value || "11744", 10));
  const r2 = getTeamByNum(parseInt($("#sim-red-2")?.value || "254", 10));
  const r3 = getTeamByNum(parseInt($("#sim-red-3")?.value || "1678", 10));

  const b1 = getTeamByNum(parseInt($("#sim-blue-1")?.value || "4414", 10));
  const b2 = getTeamByNum(parseInt($("#sim-blue-2")?.value || "1323", 10));
  const b3 = getTeamByNum(parseInt($("#sim-blue-3")?.value || "971", 10));

  const redTotal = (r1.epa + r2.epa + r3.epa).toFixed(1);
  const blueTotal = (b1.epa + b2.epa + b3.epa).toFixed(1);

  if ($("#sim-red-total-epa")) $("#sim-red-total-epa").textContent = `Total EPA: ${redTotal}`;
  if ($("#sim-blue-total-epa")) $("#sim-blue-total-epa").textContent = `Total EPA: ${blueTotal}`;
}

function initSimulator() {
  $("#run-sim-btn")?.addEventListener("click", runMonteCarloSimulation);

  $("#sim-preset-nyx")?.addEventListener("click", () => {
    if ($("#sim-red-1")) $("#sim-red-1").value = "11744";
    if ($("#sim-red-2")) $("#sim-red-2").value = "254";
    if ($("#sim-red-3")) $("#sim-red-3").value = "1678";
    if ($("#sim-blue-1")) $("#sim-blue-1").value = "4414";
    if ($("#sim-blue-2")) $("#sim-blue-2").value = "1323";
    if ($("#sim-blue-3")) $("#sim-blue-3").value = "971";
    updateSimTotals();
    runMonteCarloSimulation();
  });

  $("#sim-preset-finals")?.addEventListener("click", () => {
    if ($("#sim-red-1")) $("#sim-red-1").value = "254";
    if ($("#sim-red-2")) $("#sim-red-2").value = "1678";
    if ($("#sim-red-3")) $("#sim-red-3").value = "2910";
    if ($("#sim-blue-1")) $("#sim-blue-1").value = "4414";
    if ($("#sim-blue-2")) $("#sim-blue-2").value = "1323";
    if ($("#sim-blue-3")) $("#sim-blue-3").value = "2056";
    updateSimTotals();
    runMonteCarloSimulation();
  });
}

function runMonteCarloSimulation() {
  const redTeams = [
    getTeamByNum(parseInt($("#sim-red-1")?.value || "11744", 10)),
    getTeamByNum(parseInt($("#sim-red-2")?.value || "254", 10)),
    getTeamByNum(parseInt($("#sim-red-3")?.value || "1678", 10))
  ];
  const blueTeams = [
    getTeamByNum(parseInt($("#sim-blue-1")?.value || "4414", 10)),
    getTeamByNum(parseInt($("#sim-blue-2")?.value || "1323", 10)),
    getTeamByNum(parseInt($("#sim-blue-3")?.value || "971", 10))
  ];

  const redAuto = redTeams.reduce((s, t) => s + (t ? t.auto_epa : 10), 0);
  const redTele = redTeams.reduce((s, t) => s + (t ? t.teleop_epa : 25), 0);
  const redEnd = redTeams.reduce((s, t) => s + (t ? t.endgame_epa : 10), 0);
  const redMean = redAuto + redTele + redEnd;

  const blueAuto = blueTeams.reduce((s, t) => s + (t ? t.auto_epa : 10), 0);
  const blueTele = blueTeams.reduce((s, t) => s + (t ? t.teleop_epa : 25), 0);
  const blueEnd = blueTeams.reduce((s, t) => s + (t ? t.endgame_epa : 10), 0);
  const blueMean = blueAuto + blueTele + blueEnd;

  const numSims = 1000;
  const stdDev = 14;
  let redWins = 0, blueWins = 0, ties = 0;
  let totalRedScore = 0, totalBlueScore = 0;
  let redFuelRP = 0, blueFuelRP = 0;
  let redTowerRP = 0, blueTowerRP = 0;

  function randomNormal(mean, std) {
    let u1 = Math.random();
    let u2 = Math.random();
    while (u1 === 0) u1 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * std;
  }

  for (let i = 0; i < numSims; i++) {
    const rScore = Math.max(0, randomNormal(redMean, stdDev));
    const bScore = Math.max(0, randomNormal(blueMean, stdDev));

    totalRedScore += rScore;
    totalBlueScore += bScore;

    if (rScore > bScore + 0.5) redWins++;
    else if (bScore > rScore + 0.5) blueWins++;
    else ties++;

    if (rScore >= 95) redFuelRP++;
    if (rScore >= 110) redTowerRP++;
    if (bScore >= 95) blueFuelRP++;
    if (bScore >= 110) blueTowerRP++;
  }

  const redWinPct = Math.round((redWins / numSims) * 100);
  const blueWinPct = Math.round((blueWins / numSims) * 100);
  const avgRed = (totalRedScore / numSims).toFixed(1);
  const avgBlue = (totalBlueScore / numSims).toFixed(1);

  // Render results
  $("#sim-results-card")?.classList.remove("hidden");
  if ($("#sim-run-timestamp")) $("#sim-run-timestamp").textContent = new Date().toLocaleTimeString();

  const elProbRed = $("#sim-prob-red");
  if (elProbRed) {
    elProbRed.style.width = `${Math.max(15, redWinPct)}%`;
    elProbRed.textContent = `RED ${redWinPct}%`;
  }
  const elProbBlue = $("#sim-prob-blue");
  if (elProbBlue) {
    elProbBlue.style.width = `${Math.max(15, blueWinPct)}%`;
    elProbBlue.textContent = `BLUE ${blueWinPct}%`;
  }

  if ($("#sim-score-red")) $("#sim-score-red").textContent = avgRed;
  if ($("#sim-score-blue")) $("#sim-score-blue").textContent = avgBlue;

  if ($("#sim-phase-auto")) $("#sim-phase-auto").textContent = `${redAuto.toFixed(1)} vs ${blueAuto.toFixed(1)}`;
  if ($("#sim-phase-teleop")) $("#sim-phase-teleop").textContent = `${redTele.toFixed(1)} vs ${blueTele.toFixed(1)}`;
  if ($("#sim-phase-endgame")) $("#sim-phase-endgame").textContent = `${redEnd.toFixed(1)} vs ${blueEnd.toFixed(1)}`;

  if ($("#sim-rp-fuel")) $("#sim-rp-fuel").textContent = `${Math.round(redFuelRP / 10)}% vs ${Math.round(blueFuelRP / 10)}%`;
  if ($("#sim-rp-tower")) $("#sim-rp-tower").textContent = `${Math.round(redTowerRP / 10)}% vs ${Math.round(blueTowerRP / 10)}%`;

  const diff = (redMean - blueMean).toFixed(1);
  const fav = redMean >= blueMean ? "Red Alliance" : "Blue Alliance";
  const favPct = redMean >= blueMean ? redWinPct : blueWinPct;
  const autoAdv = redAuto > blueAuto
    ? `Red Alliance holds an Autonomous advantage (+${(redAuto - blueAuto).toFixed(1)} pts)`
    : `Blue Alliance controls the Auto Phase (+${(blueAuto - redAuto).toFixed(1)} pts)`;
  const endAdv = redEnd >= blueEnd
    ? `Red has high Tower climb consistency (${redEnd.toFixed(1)} pts)`
    : `Blue has higher Tower climb consistency (${blueEnd.toFixed(1)} pts)`;

  if ($("#sim-analysis-text")) {
    $("#sim-analysis-text").textContent = `${fav} is favored to win with a ${favPct}% probability over 1,000 simulated matches (projected spread: ${Math.abs(diff)} pts). ${autoAdv}. In the endgame, ${endAdv}. Key match dynamic: rapid Fuel cycling through upper hubs and locking in all three Tower climbs.`;
  }

  toast(`Simulation completed! ${fav} predicted win: ${favPct}%`);
}

/* --------------------------------------------------------------------------
   TEAM DEEP DIVE LOOKUP
   -------------------------------------------------------------------------- */
async function handleTeamLookup(e) {
  if (e) {
    if (typeof e.preventDefault === "function") e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
  }
  const input = $("#lookup-team-num");
  const num = parseInt(input?.value, 10);
  if (!num || isNaN(num) || num <= 0) {
    toast("Please enter a valid team number (e.g. 11744, 254).", true);
    input?.focus();
    return;
  }

  const resultContainer = $("#team-lookup-result");
  if (!resultContainer) return;
  resultContainer.innerHTML = `<div style="padding:40px; text-align:center;" class="muted"><span class="spinner" style="display:inline-block; margin-right:8px;"><i class=fa-hourglass-half aria-hidden=true></i></span> Fetching metrics for FRC Team ${num}…</div>`;

  let teamObj = frcTeamsData.find(t => t.team === num);

  // Try Statbotics v3 team_year 2026 or team endpoint
  if (!teamObj) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3500);

      // Try 2026 team_year first, then team metadata
      let res = await fetch(`https://api.statbotics.io/v3/team_year/${num}/2026`, { signal: controller.signal });
      if (!res.ok) {
        res = await fetch(`https://api.statbotics.io/v3/team/${num}`, { signal: controller.signal });
      }
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data && (data.team || data.team_number)) {
          const tNum = data.team || data.team_number || num;
          const epaTotal = data.epa_end || data.epa || (data.norm_epa?.current ? (data.norm_epa.current - 1500) / 10 + 40 : 48.0);
          const autoVal = data.auto_epa_end || data.auto_epa || (epaTotal * 0.25);
          const teleVal = data.teleop_epa_end || data.teleop_epa || (epaTotal * 0.58);
          const endVal = data.endgame_epa_end || data.endgame_epa || (epaTotal * 0.17);
          const winRate = data.winrate != null ? Number((data.winrate * 100).toFixed(1)) : 68.0;

          teamObj = {
            team: tNum,
            name: data.name || `Team ${tNum}`,
            location: data.state ? `${data.state}, ${data.country || 'USA'}` : (data.country || "USA"),
            epa: Number(Number(epaTotal).toFixed(1)),
            auto_epa: Number(Number(autoVal).toFixed(1)),
            teleop_epa: Number(Number(teleVal).toFixed(1)),
            endgame_epa: Number(Number(endVal).toFixed(1)),
            winrate: winRate,
            rank: data.rank || data.epa_rank || 180,
            record: data.record ? `${data.record.wins || 22}-${data.record.losses || 9}-${data.record.ties || 0}` : "22-9-0",
            rookie: data.rookie_year || 2022
          };
        }
      }
    } catch (err) {
      // Gracefully fall back below
    }
  }

  // Fallback intelligent projection based on team number age
  if (!teamObj) {
    const isLegacy = num < 1000;
    const isMid = num < 5000;
    const estRookie = num < 500 ? 1999 : num < 2000 ? 2006 : num < 5000 ? 2014 : num < 8000 ? 2019 : 2024;
    const estEpa = isLegacy ? 56.4 : isMid ? 49.2 : 41.8;

    teamObj = {
      team: num,
      name: `Team ${num}`,
      location: "FIRST Robotics Competition",
      epa: estEpa,
      auto_epa: Number((estEpa * 0.25).toFixed(1)),
      teleop_epa: Number((estEpa * 0.58).toFixed(1)),
      endgame_epa: Number((estEpa * 0.17).toFixed(1)),
      winrate: isLegacy ? 78.5 : isMid ? 67.2 : 60.5,
      rank: isLegacy ? 65 : isMid ? 240 : 490,
      record: isLegacy ? "38-11-0" : isMid ? "27-14-1" : "18-12-0",
      rookie: estRookie
    };
  }

  // Render Result Card
  resultContainer.innerHTML = `
    <div class="card" style="border: 1px solid var(--accent-line); margin-top: 16px;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
        <div>
          <span class="eyebrow" style="margin-bottom:4px;">TEAM SCOUTING REPORT · 2026 REBUILT</span>
          <h2 style="margin:0;">${teamObj.team} · ${esc(teamObj.name)}</h2>
          <p class="muted small">${esc(teamObj.location)} · Rookie Season: ${teamObj.rookie || '—'}</p>
        </div>
        <div>
          <span class="rank-badge ${teamObj.rank <= 3 ? 'top3' : ''}" style="font-size:14px; width:auto; padding:6px 14px;">Rank #${teamObj.rank}</span>
        </div>
      </div>

      <div class="sim-stats-grid" style="margin: 20px 0;">
        <div class="sim-stat-box">
          <small>TOTAL EPA</small>
          <strong style="color:var(--accent-bright); font-size:24px;">${teamObj.epa.toFixed(1)}</strong>
        </div>
        <div class="sim-stat-box">
          <small>AUTO EPA</small>
          <strong style="font-size:24px;">${teamObj.auto_epa.toFixed(1)}</strong>
        </div>
        <div class="sim-stat-box">
          <small>TELEOP EPA</small>
          <strong style="font-size:24px;">${teamObj.teleop_epa.toFixed(1)}</strong>
        </div>
        <div class="sim-stat-box">
          <small>ENDGAME / TOWER EPA</small>
          <strong style="font-size:24px; color:var(--green);">${teamObj.endgame_epa.toFixed(1)}</strong>
        </div>
      </div>

      <div style="display:flex; justify-content:space-between; padding:12px 16px; background:rgba(255,255,255,.02); border-radius:8px; border:1px solid var(--line); font-size:13px;">
        <span>Season Match Record: <b class="mono">${esc(teamObj.record)}</b></span>
        <span>Win Rate: <b class="mono" style="color:var(--green);">${teamObj.winrate.toFixed(1)}%</b></span>
      </div>

      <div style="margin-top:16px; display:flex; justify-content:space-between; align-items:center;">
        <span class="muted small">Source: <a href="https://www.statbotics.io/team/${teamObj.team}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-bright); text-decoration:underline;">statbotics.io/team/${teamObj.team}</a></span>
        <button class="btn btn--primary btn--sm" id="load-team-into-sim-btn" type="button">Load into Match Simulator <i class=fa-bolt aria-hidden=true></i></button>
      </div>
    </div>
  `;

  // Simulator launcher button hook
  $("#load-team-into-sim-btn")?.addEventListener("click", () => {
    switchStratTab("simulator");
    const sel = $("#sim-red-1");
    if (sel) {
      // Check if team already exists in selector, otherwise create an option
      let opt = Array.from(sel.options).find(o => o.value === String(teamObj.team));
      if (!opt) {
        opt = document.createElement("option");
        opt.value = String(teamObj.team);
        opt.textContent = `${teamObj.team} - ${teamObj.name} (EPA ${teamObj.epa.toFixed(1)})`;
        sel.appendChild(opt);
      }
      sel.value = String(teamObj.team);
      updateSimTotals();
    }
    toast(`Loaded Team ${teamObj.team} into Simulator!`);
  });
}

/* --------------------------------------------------------------------------
   MATCH SCOUTING SYSTEM (OFFLINE-FIRST & SUPABASE SYNCED)
   -------------------------------------------------------------------------- */
let scoutingRecords = [];
let scoutingCounters = {
  autoFuel: 0,
  autoMiss: 0,
  teleFuel: 0,
  teleMiss: 0
};

function initScoutingSystem() {
  loadScoutingRecords();
  setupScoutingEvents();
  updateScoutCalculatedPoints();
}

function loadScoutingRecords() {
  try {
    const raw = localStorage.getItem("nyx_scouting_records");
    if (raw) scoutingRecords = JSON.parse(raw);
  } catch (err) {
    scoutingRecords = [];
  }
  incorporateScoutingIntoRankings();
  renderScoutingRecords();

  // Also fetch from Supabase if table exists
  if (supabase && currentUser) {
    supabase.from("match_scouting_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200)
      .then(({ data, error }) => {
        if (!error && data) {
          // Track deleted IDs in local storage so deleted remote rows are not resurrected
          let deletedIds = new Set();
          try {
            const rawDel = localStorage.getItem("nyx_deleted_scouting_ids");
            if (rawDel) deletedIds = new Set(JSON.parse(rawDel));
          } catch (e) {}

          const localMap = new Map(scoutingRecords.map(r => [r.id, r]));
          let added = false;
          data.forEach(remoteRow => {
            if (deletedIds.has(remoteRow.id)) return;
            if (!localMap.has(remoteRow.id)) {
              scoutingRecords.push(remoteRow);
              added = true;
            }
          });
          if (added) {
            try { localStorage.setItem("nyx_scouting_records", JSON.stringify(scoutingRecords.slice(0, 100))); } catch (e) {}
            incorporateScoutingIntoRankings();
            renderScoutingRecords();
          }
        }
      })
      .catch(() => {});
  }
}

function incorporateScoutingIntoRankings() {
  // Aggregate stats per team
  const teamAgg = new Map();
  scoutingRecords.forEach(rec => {
    const num = Number(rec.team_num);
    if (!num) return;
    if (!teamAgg.has(num)) {
      teamAgg.set(num, { count: 0, autoFuel: 0, teleFuel: 0, climbPts: 0, totalPts: 0 });
    }
    const stat = teamAgg.get(num);
    stat.count++;
    stat.autoFuel += (rec.auto_fuel || 0);
    stat.teleFuel += (rec.tele_fuel || 0);
    const cPt = rec.climb === 'L3' ? 30 : rec.climb === 'L2' ? 20 : rec.climb === 'L1' ? 10 : 0;
    stat.climbPts += cPt;
    stat.totalPts += ((rec.auto_fuel || 0) + (rec.tele_fuel || 0) + (rec.auto_climb ? 15 : 0) + cPt);
  });

  // Blend into frcTeamsData
  teamAgg.forEach((stat, num) => {
    let t = frcTeamsData.find(item => item.team === num);
    const avgPts = stat.totalPts / stat.count;
    const avgAuto = stat.autoFuel / stat.count;
    const avgTele = stat.teleFuel / stat.count;
    const avgEnd = stat.climbPts / stat.count;

    if (t) {
      t.scout_matches = stat.count;
      // Weighted blending: 60% Statbotics baseline + 40% observed scouting data
      t.auto_epa = Number(((t.auto_epa * 0.6) + (avgAuto * 0.4)).toFixed(1));
      t.teleop_epa = Number(((t.teleop_epa * 0.6) + (avgTele * 0.4)).toFixed(1));
      t.endgame_epa = Number(((t.endgame_epa * 0.6) + (avgEnd * 0.4)).toFixed(1));
      t.epa = Number((t.auto_epa + t.teleop_epa + t.endgame_epa).toFixed(1));
    } else {
      // Add newly scouted team into rankings list!
      frcTeamsData.push({
        team: num,
        name: `Team ${num}`,
        location: "Scouted Competitor",
        epa: Number(avgPts.toFixed(1)),
        auto_epa: Number(avgAuto.toFixed(1)),
        teleop_epa: Number(avgTele.toFixed(1)),
        endgame_epa: Number(avgEnd.toFixed(1)),
        winrate: 65.0,
        rank: Math.max(50, 400 - Math.round(avgPts * 4)),
        record: `${stat.count}-0-0`,
        rookie: 2024,
        scout_matches: stat.count
      });
    }
  });

  renderRankings();
}

function updateScoutCalculatedPoints() {
  const autoClimb = $("#scout-auto-climb")?.checked ? 15 : 0;
  const climbVal = document.querySelector('input[name="scout-climb"]:checked')?.value || "none";
  const climbPts = climbVal === 'L3' ? 30 : climbVal === 'L2' ? 20 : climbVal === 'L1' ? 10 : 0;
  const total = (scoutingCounters.autoFuel || 0) + (scoutingCounters.teleFuel || 0) + autoClimb + climbPts;

  const elTotal = $("#scout-est-total-pts");
  if (elTotal) elTotal.textContent = total;
}

function setupScoutingEvents() {
  // Stepper buttons (+1, +3, +5, +10, -1)
  $$(".scout-step-btns button").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.stepTarget;
      const delta = parseInt(btn.dataset.delta, 10) || 0;
      if (!target || !(target in scoutingCounters)) return;

      scoutingCounters[target] = Math.max(0, scoutingCounters[target] + delta);
      const displayEl = $(`#val-${target.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`);
      if (displayEl) displayEl.textContent = scoutingCounters[target];

      updateScoutCalculatedPoints();
    });
  });

  // Re-calculate on climb or auto climb change
  $$('input[name="scout-climb"]').forEach(r => r.addEventListener("change", updateScoutCalculatedPoints));
  $("#scout-auto-climb")?.addEventListener("change", updateScoutCalculatedPoints);

  // Auto-fill scout name from profile
  const elScoutName = $("#scout-name");
  if (elScoutName && !elScoutName.value) {
    elScoutName.value = currentProfile?.full_name || currentUser?.email?.split('@')[0] || "";
  }

  // Reset form button
  $("#scout-form-reset-btn")?.addEventListener("click", resetScoutingForm);

  // Form submit
  $("#scout-entry-form")?.addEventListener("submit", async e => {
    e.preventDefault();
    const teamNum = parseInt($("#scout-team-num")?.value, 10);
    const matchNum = parseInt($("#scout-match-num")?.value, 10);
    const scoutName = $("#scout-name")?.value.trim() || "Anonymous";
    const eventName = $("#scout-event")?.value.trim() || "2026 Event";
    const eventKey = $("#scout-event-key")?.value || "";
    const tags = [...document.querySelectorAll('input[name="scout-tag"]:checked')].map(cb => cb.value);
    const matchType = $("#scout-match-type")?.value || "qm";
    const station = document.querySelector('input[name="scout-station"]:checked')?.value || "R1";
    const climb = document.querySelector('input[name="scout-climb"]:checked')?.value || "none";
    const driver = parseInt(document.querySelector('input[name="scout-driver"]:checked')?.value || "5", 10);
    const defense = parseInt(document.querySelector('input[name="scout-defense"]:checked')?.value || "0", 10);
    const notes = $("#scout-notes")?.value.trim() || "";
    const allianceScore = parseInt($("#scout-final-alliance-score")?.value, 10) || null;

    if (!teamNum || !matchNum) {
      toast("Please enter both Team # and Match #.", true);
      return;
    }

    const autoClimb = $("#scout-auto-climb")?.checked || false;
    const climbPts = climb === 'L3' ? 30 : climb === 'L2' ? 20 : climb === 'L1' ? 10 : 0;
    const estPoints = (scoutingCounters.autoFuel || 0) + (scoutingCounters.teleFuel || 0) + (autoClimb ? 15 : 0) + climbPts;

    const record = {
      id: "scout_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      team_num: teamNum,
      match_num: matchNum,
      match_type: matchType,
      event_name: eventName,
      event_key: eventKey,
      scout_name: scoutName,
      scout_id: currentUser?.id || null,
      station,
      auto_fuel: scoutingCounters.autoFuel,
      auto_miss: scoutingCounters.autoMiss,
      auto_moved: $("#scout-auto-moved")?.checked || false,
      auto_depot: $("#scout-auto-depot")?.checked || false,
      auto_climb: autoClimb,
      tele_fuel: scoutingCounters.teleFuel,
      tele_miss: scoutingCounters.teleMiss,
      nav_bump: $("#scout-nav-bump")?.checked || false,
      nav_trench: $("#scout-nav-trench")?.checked || false,
      intake_floor: $("#scout-intake-floor")?.checked || false,
      hp_feed: $("#scout-hp-feed")?.checked || false,
      climb,
      driver_rating: driver,
      defense_rating: defense,
      rating_scale: 10,
      tags,
      died: $("#scout-died")?.checked || false,
      tipped: $("#scout-tipped")?.checked || false,
      notes,
      alliance_score: allianceScore,
      est_points: estPoints,
      created_at: new Date().toISOString()
    };

    // 1. Save in local storage
    scoutingRecords.unshift(record);
    try {
      localStorage.setItem("nyx_scouting_records", JSON.stringify(scoutingRecords.slice(0, 100)));
    } catch (err) {}

    // 2. Persist to Supabase if available
    if (supabase && currentUser) {
      const row = {
        id: record.id,
        team_num: record.team_num,
        match_num: record.match_num,
        match_type: record.match_type,
        event_name: record.event_name,
        scout_name: record.scout_name,
        station: record.station,
        auto_fuel: record.auto_fuel,
        tele_fuel: record.tele_fuel,
        climb: record.climb,
        est_points: record.est_points,
        notes: record.notes,
        raw_data: JSON.stringify(record),
        created_by: currentUser.id
      };
      // event_key/tags columns exist once schema.sql section 14 is applied; fall back without them
      supabase.from("match_scouting_logs").insert({ ...row, event_key: record.event_key, tags: record.tags })
        .then(res => res.error && /event_key|tags|column/i.test(res.error.message)
          ? supabase.from("match_scouting_logs").insert(row)
          : res)
        .then(({ error }) => {
        if (error) console.warn("Supabase scouting upload notice:", error.message);
        else {
          logAction("SCOUTING_SUBMITTED", "match_scouting_logs", record.id, {
            team_num: record.team_num,
            match_num: record.match_num,
            match_type: record.match_type,
            event_name: record.event_name,
            est_points: record.est_points,
            auto_fuel: record.auto_fuel,
            tele_fuel: record.tele_fuel,
            climb: record.climb,
            died: record.died,
            scout_name: record.scout_name,
            station: record.station,
            notes: record.notes
          });
        }
      }).catch(() => {});
    }

    // Refresh UI & stats
    incorporateScoutingIntoRankings();
    renderScoutingRecords();
    toast(`Match ${matchType.toUpperCase()}${matchNum} for Team ${teamNum} recorded (${estPoints} pts)!`);

    // Reset counters and advance match number for rapid scouting
    const nextMatch = matchNum + 1;
    resetScoutingForm();
    if ($("#scout-match-num")) $("#scout-match-num").value = nextMatch;
    document.dispatchEvent(new CustomEvent("nyx:scout-saved", { detail: record }));
    if (!eventKey && $("#scout-team-num")) $("#scout-team-num").focus();
  });

  // Export CSV
  $("#scout-export-csv-btn")?.addEventListener("click", exportScoutingCSV);
}

function resetScoutingForm() {
  scoutingCounters = { autoFuel: 0, autoMiss: 0, teleFuel: 0, teleMiss: 0 };
  $("#val-auto-fuel") && ($("#val-auto-fuel").textContent = "0");
  $("#val-auto-miss") && ($("#val-auto-miss").textContent = "0");
  $("#val-tele-fuel") && ($("#val-tele-fuel").textContent = "0");
  $("#val-tele-miss") && ($("#val-tele-miss").textContent = "0");

  $("#scout-auto-moved") && ($("#scout-auto-moved").checked = false);
  $("#scout-auto-depot") && ($("#scout-auto-depot").checked = false);
  $("#scout-auto-climb") && ($("#scout-auto-climb").checked = false);
  $("#scout-nav-bump") && ($("#scout-nav-bump").checked = false);
  $("#scout-nav-trench") && ($("#scout-nav-trench").checked = false);
  $("#scout-intake-floor") && ($("#scout-intake-floor").checked = false);
  $("#scout-hp-feed") && ($("#scout-hp-feed").checked = false);
  $("#scout-died") && ($("#scout-died").checked = false);
  $("#scout-tipped") && ($("#scout-tipped").checked = false);
  $("#scout-notes") && ($("#scout-notes").value = "");
  $("#scout-final-alliance-score") && ($("#scout-final-alliance-score").value = "");

  const defaultClimb = document.querySelector('input[name="scout-climb"][value="none"]');
  if (defaultClimb) defaultClimb.checked = true;
  $$('input[name="scout-tag"]').forEach(cb => { cb.checked = false; });
  const defaultDriver = document.querySelector('input[name="scout-driver"][value="5"]');
  if (defaultDriver) defaultDriver.checked = true;
  const defaultDefense = document.querySelector('input[name="scout-defense"][value="0"]');
  if (defaultDefense) defaultDefense.checked = true;

  updateScoutCalculatedPoints();
}

function renderScoutingRecords() {
  const list = $("#scout-records-list");
  const countBadge = $("#badge-scout-count");
  const tableCount = $("#scout-table-count");
  if (countBadge) countBadge.textContent = scoutingRecords.length;
  if (tableCount) tableCount.textContent = scoutingRecords.length;
  if (!list) return;

  if (!scoutingRecords.length) {
    list.innerHTML = `<div style="padding: 30px; text-align: center;" class="muted">No match scouting records logged yet. Fill out the form above to record matches!</div>`;
    return;
  }

  list.innerHTML = scoutingRecords.map(r => {
    const isAdmin = isStaff();
    return `
    <article class="itemrow" style="grid-template-columns: 70px 70px 80px 80px 85px 80px 70px 80px 1fr 60px;">
      <div class="mono" style="font-weight:700;">${r.match_type?.toUpperCase() || 'Q'}${r.match_num}</div>
      <div>
        <strong style="color:var(--accent-bright); font-size:14px;">${r.team_num}</strong>
      </div>
      <div class="muted small">${esc(r.scout_name || '—')}</div>
      <div class="mono small" style="color:#facc15;">${r.auto_fuel}</div>
      <div class="mono small" style="color:#facc15;">${r.tele_fuel}</div>
      <div>
        <span class="pill ${r.climb === 'L3' ? 'Electrical' : r.climb === 'L2' ? 'Software' : r.climb === 'L1' ? 'Mechanical' : ''}" style="font-size:10px;">${r.climb === 'none' ? 'None' : r.climb}</span>
      </div>
      <div>
        <strong class="mono" style="color:var(--green); font-size:14px;">${r.est_points || 0}</strong>
      </div>
      <div>
        ${r.died ? '<span class="pill" style="color:#f87171; border-color:#f87171; font-size:9px;">BROKE</span>' : '<span class="muted small">OK</span>'}
      </div>
      <div class="muted small" style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(r.notes || '')}">
        ${esc(r.notes || '—')}
      </div>
      <div>
        ${isAdmin ? `
          <button class="btn btn--danger btn--sm" data-action="delete-scout-log" data-id="${r.id}" style="padding:4px 8px; font-size:11px;" title="Delete match log (Admin only)">✕</button>
        ` : '<span class="muted small mono">—</span>'}
      </div>
    </article>
    `;
  }).join("");
}

// Delete scout record (Restricted to Admins)
$("#scout-records-list")?.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action='delete-scout-log']");
  if (!btn) return;
  if (!isStaff()) {
    toast("Permission Denied: Only team admins can delete scouting logs.", true);
    return;
  }
  const id = btn.dataset.id;
  if (!id) return;

  if (confirm("Delete this scouting record? This action will update team ranking stats.")) {
    // Instant DOM removal
    const rowEl = btn.closest(".itemrow") || btn.closest("article");
    if (rowEl) rowEl.remove();

    scoutingRecords = scoutingRecords.filter(r => String(r.id) !== String(id));
    try {
      localStorage.setItem("nyx_scouting_records", JSON.stringify(scoutingRecords));
      // Store deleted ID
      const rawDel = localStorage.getItem("nyx_deleted_scouting_ids");
      const delList = rawDel ? JSON.parse(rawDel) : [];
      if (!delList.includes(id)) {
        delList.push(id);
        localStorage.setItem("nyx_deleted_scouting_ids", JSON.stringify(delList.slice(-200)));
      }
    } catch (e) {}

    // Instant local rerender & badge recalculation
    incorporateScoutingIntoRankings();
    renderScoutingRecords();
    toast("Scouting record deleted.");

    const targetScout = scoutingRecords.find(r => String(r.id) === String(id));
    // Background asynchronous DB removal
    if (supabase) {
      supabase.from("match_scouting_logs").delete().eq("id", id).then(({ error }) => {
        if (error) console.warn("Supabase scouting delete warning:", error.message);
        else {
          logAction("SCOUTING_DELETED", "match_scouting_logs", id, {
            team_num: targetScout?.team_num,
            match_num: targetScout?.match_num,
            match_type: targetScout?.match_type
          });
        }
      }).catch(err => console.warn(err));
    }
  }
});

function exportScoutingCSV() {
  if (!scoutingRecords.length) {
    toast("No scouting records to export yet.", true);
    return;
  }
  const headers = ["ID", "Team", "Match", "Type", "Scout", "Station", "AutoFuel", "AutoMiss", "AutoMoved", "AutoClimb", "TeleFuel", "TeleMiss", "Climb", "DriverRating", "DefenseRating", "Died", "EstPoints", "Notes", "Timestamp"];
  const rows = scoutingRecords.map(r => [
    r.id, r.team_num, r.match_num, r.match_type, `"${(r.scout_name || '').replace(/"/g, '""')}"`,
    r.station, r.auto_fuel, r.auto_miss, r.auto_moved, r.auto_climb, r.tele_fuel, r.tele_miss,
    r.climb, r.driver_rating, r.defense_rating, r.died, r.est_points,
    `"${(r.notes || '').replace(/"/g, '""')}"`, r.created_at
  ]);

  const csvContent = [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `nyx_scouting_rebuilt_2026_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Exported scouting CSV!");
}

/* --------------------------------------------------------------------------
   SECRET INTEL SYSTEM (RESTRICTED TO SECRET ROLE ADMINS)
   -------------------------------------------------------------------------- */
let secretDossiers = [];
let secretsEventsBound = false;

function initSecretsCenter() {
  if (!currentProfile?.is_secret) {
    toast("Restricted access: Secret Role required.", true);
    return;
  }
  loadSecretIntel();
  if (!secretsEventsBound) {
    setupSecretsEvents();
    secretsEventsBound = true;
  }
}

async function loadSecretIntel(quiet) {
  try {
    const raw = localStorage.getItem("nyx_secret_intel");
    if (raw && !quiet && (!secretDossiers || secretDossiers.length === 0)) {
      secretDossiers = JSON.parse(raw);
      renderSecretIntel();
    }
  } catch (err) {
    secretDossiers = [];
  }

  // Load directly from Supabase for all team members with secret clearance
  if (supabase && currentUser) {
    try {
      const { data, error } = await supabase.from("secret_personnel_intel")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Secret personnel intel load error:", error);
        if (!quiet) toast("Cloud database sync notice: " + error.message, true);
      } else if (Array.isArray(data)) {
        secretDossiers = data;
        try {
          localStorage.setItem("nyx_secret_intel", JSON.stringify(secretDossiers.slice(0, 100)));
        } catch (e) {}
        renderSecretIntel();
      }
    } catch (e) {
      console.error("Could not query secret intel from remote database:", e);
    }
  }
}

function renderSecretIntel() {
  const list = $("#secret-intel-list");
  const countBadge = $("#secret-dossier-count");
  if (countBadge) countBadge.textContent = secretDossiers.length;
  if (!list) return;

  const q = ($("#secret-search-input")?.value || "").toLowerCase().trim();
  const filtered = secretDossiers.filter(d => {
    if (!q) return true;
    return (
      String(d.team_num).includes(q) ||
      (d.team_name || "").toLowerCase().includes(q) ||
      (d.person_name || "").toLowerCase().includes(q) ||
      (d.person_role || "").toLowerCase().includes(q) ||
      (d.intel_notes || "").toLowerCase().includes(q)
    );
  });

  if (!filtered.length) {
    list.innerHTML = `<div style="padding:40px; text-align:center;" class="muted">${secretDossiers.length === 0 ? 'No classified dossiers logged yet. Use the form above to log observations.' : 'No dossiers match your search filter.'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(d => {
    const isAuthor = d.logged_by === currentUser?.id;
    const canDelete = isAuthor || !!currentProfile?.is_admin;
    const votes = (d.votes && typeof d.votes === "object") ? d.votes : {};
    
    // Calculate aggregate score: +1 for each up vote, -1 for each down vote
    let score = 0;
    Object.values(votes).forEach(v => {
      if (v === 1 || v === "up") score += 1;
      else if (v === -1 || v === "down") score -= 1;
    });

    const myVote = votes[currentUser?.id]; // 1, -1, or undefined
    const isUp = score > 0;
    const isDown = score < 0;

    const scoreColor = isUp ? "#10b981" : isDown ? "#f43f5e" : "var(--text-muted)";
    const scoreText = score > 0 ? `+${score}` : `${score}`;

    return `
    <article class="card" style="border: 1px solid ${isUp ? 'rgba(16, 185, 129, 0.4)' : isDown ? 'rgba(244, 63, 94, 0.4)' : 'rgba(255, 255, 255, 0.1)'}; background: ${isUp ? 'rgba(16, 185, 129, 0.04)' : isDown ? 'rgba(244, 63, 94, 0.04)' : 'rgba(255, 255, 255, 0.02)'}; margin-bottom: 14px; padding: 16px 18px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="display:flex; align-items:center; gap:8px;">
            <strong style="color:var(--text); font-size:17px;">Team ${d.team_num}</strong>
            ${d.team_name ? `<span class="muted small">· ${esc(d.team_name)}</span>` : ''}
            <span class="pill" style="border-color:#f43f5e; color:#f43f5e; font-size:10px;">CONFIDENTIAL</span>
          </div>
          <div style="margin-top:4px;">
            <span class="mono small" style="color:var(--accent-bright); font-weight:700; font-size:14px;">Role / Responsibility: ${esc(d.person_role)}</span>
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:12px;">
          <!-- Numerical Voting Controls (Author cannot vote; others can vote Up or Down once) -->
          <div style="display:flex; align-items:center; gap:6px; background:rgba(0,0,0,0.3); border:1px solid var(--line); border-radius:8px; padding:4px 8px;">
            ${isAuthor ? `
              <span class="muted small mono" title="Loggers cannot vote on their own entries" style="padding:0 4px;">Logger (No Vote)</span>
            ` : `
              <button class="btn btn--sm ${myVote === 1 || myVote === 'up' ? 'btn--primary' : 'btn--ghost'}" data-action="vote-secret" data-id="${d.id}" data-val="up" style="padding:3px 8px; font-size:12px; ${myVote === 1 || myVote === 'up' ? 'background:#10b981; border-color:#10b981; color:#fff;' : 'color:#10b981;'}" title="Rank Up (+1)">
                ▲ +1
              </button>
            `}

            <span class="mono" style="font-weight:700; font-size:15px; min-width:32px; text-align:center; color:${scoreColor};" title="Total Ranking Score">
              ${scoreText}
            </span>

            ${!isAuthor ? `
              <button class="btn btn--sm ${myVote === -1 || myVote === 'down' ? 'btn--danger' : 'btn--ghost'}" data-action="vote-secret" data-id="${d.id}" data-val="down" style="padding:3px 8px; font-size:12px; ${myVote === -1 || myVote === 'down' ? 'background:#f43f5e; border-color:#f43f5e; color:#fff;' : 'color:#f43f5e;'}" title="Rank Down (-1)">
                ▼ -1
              </button>
            ` : ''}
          </div>

          <span class="muted small mono">${new Date(d.created_at).toLocaleDateString()}</span>
          ${canDelete ? `
            <button class="btn btn--danger btn--sm" data-action="delete-secret-dossier" data-id="${d.id}" style="padding:4px 8px; font-size:11px;" title="${currentProfile?.is_admin && !isAuthor ? 'Admin Delete Entry' : 'Delete Entry'}">✕</button>
          ` : ''}
        </div>
      </div>

      <div style="margin-top: 10px; display:flex; justify-content:space-between; font-size:11px;" class="muted mono">
        <span>Logged by: ${esc(d.logged_by_name || 'Secret Admin')} ${isAuthor ? '(You)' : ''}</span>
        <span>ID: ${d.id.slice(0, 10)}</span>
      </div>
    </article>
    `;
  }).join("");
}

function setupSecretsEvents() {
  $("#btn-refresh-secrets")?.addEventListener("click", async () => {
    toast("Syncing with cloud database...");
    await loadSecretIntel();
    toast("Cloud database synchronized!");
  });
  $("#secret-scout-form")?.addEventListener("submit", async e => {
    e.preventDefault();
    if (!currentProfile?.is_secret) {
      toast("Access Denied: Secret clearance required.", true);
      return;
    }

    const teamNum = parseInt($("#secret-team-num")?.value, 10);
    const teamName = $("#secret-team-name")?.value.trim() || "";
    const personRole = $("#secret-person-role")?.value.trim() || "";

    if (!teamNum || !personRole) {
      toast("Please enter team number and role / responsibility.", true);
      return;
    }

    const dossier = {
      id: "sec_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
      team_num: teamNum,
      team_name: teamName,
      person_name: personRole,
      person_role: personRole,
      votes: {}, // Numerical votes map: { userId: 1 or -1 }
      intel_notes: "",
      logged_by: currentUser.id,
      logged_by_name: currentProfile?.full_name || currentUser.email,
      created_at: new Date().toISOString()
    };

    // 1. Local persistence & instant UI update
    secretDossiers.unshift(dossier);
    try {
      localStorage.setItem("nyx_secret_intel", JSON.stringify(secretDossiers.slice(0, 100)));
    } catch (err) {}

    renderSecretIntel();
    toast(`Classified entry for Team ${teamNum} recorded!`);

    // Reset form
    $("#secret-scout-form")?.reset();
    $("#secret-team-num")?.focus();

    // 2. Supabase Cloud Persistence with immediate feedback
    if (supabase) {
      try {
        const { error: dbErr } = await supabase.from("secret_personnel_intel").insert(dossier);
        if (dbErr) {
          console.error("Secret dossier insert failed:", dbErr);
          toast("Database sync failed: " + dbErr.message + " (Saved locally)", true);
        } else {
          toast(`Dossier for Team ${teamNum} synced to cloud database!`);
        }
      } catch (err) {
        console.error("Secret intel db sync exception:", err);
      }
    }
  });

  // Vote (+1 / -1) & delete dossier clicks
  $("#secret-intel-list")?.addEventListener("click", async e => {
    const voteBtn = e.target.closest("button[data-action='vote-secret']");
    if (voteBtn) {
      const id = voteBtn.dataset.id;
      const val = voteBtn.dataset.val === "up" ? 1 : -1;
      const item = secretDossiers.find(d => d.id === id);
      if (!item) return;

      if (item.logged_by === currentUser?.id) {
        toast("Loggers cannot vote on their own entries.", true);
        return;
      }

      if (!item.votes || typeof item.votes !== "object") {
        item.votes = {};
      }

      const currentVote = item.votes[currentUser?.id];
      if (currentVote === val) {
        // Toggle off vote if clicked same button again
        delete item.votes[currentUser?.id];
        toast(`Vote removed.`);
      } else {
        // Vote once: +1 or -1
        item.votes[currentUser?.id] = val;
        toast(val === 1 ? `Ranked Team ${item.team_num} UP (+1)! ▲` : `Ranked Team ${item.team_num} DOWN (-1)! ▼`);
      }

      // Optimistic instant rerender
      try { localStorage.setItem("nyx_secret_intel", JSON.stringify(secretDossiers)); } catch (err) {}
      renderSecretIntel();

      // Cloud database sync
      if (supabase) {
        try {
          const { error: voteErr } = await supabase.from("secret_personnel_intel")
            .update({ votes: item.votes })
            .eq("id", id);
          if (voteErr) {
            console.error("Vote sync error:", voteErr);
            toast("Vote cloud sync failed: " + voteErr.message, true);
          }
        } catch (err) {
          console.error("Vote sync exception:", err);
        }
      }
      return;
    }

    const btn = e.target.closest("button[data-action='delete-secret-dossier']");
    if (!btn) return;
    const id = btn.dataset.id;
    if (!id) return;

    if (confirm("Permanently destroy this classified intelligence entry?")) {
      // Instant DOM removal
      const cardEl = btn.closest(".card") || btn.closest("article");
      if (cardEl) cardEl.remove();

      secretDossiers = secretDossiers.filter(d => d.id !== id);
      try { localStorage.setItem("nyx_secret_intel", JSON.stringify(secretDossiers)); } catch (e) {}
      renderSecretIntel();

      if (supabase) {
        try {
          const { error: delErr } = await supabase.from("secret_personnel_intel").delete().eq("id", id);
          if (delErr) {
            console.error("Delete secret dossier error:", delErr);
            toast("Cloud delete failed: " + delErr.message, true);
          } else {
            toast("Classified entry permanently deleted.");
          }
        } catch (err) {
          console.error("Delete error:", err);
        }
      } else {
        toast("Entry deleted locally.");
      }
    }
  });
}

/* Sidebar & Mobile Navigation listeners */
$("#sidebar-btn-dashboard")?.addEventListener("click", () => switchPage("dashboard"));
$("#sidebar-btn-strategy")?.addEventListener("click", () => switchPage("strategy"));
$("#sidebar-btn-secrets")?.addEventListener("click", () => switchPage("secrets"));
$("#sidebar-open-profile-btn")?.addEventListener("click", openProfileModal);

// Mobile Bottom Nav Bar Clicks
$("#mob-btn-dashboard")?.addEventListener("click", () => switchPage("dashboard"));
$("#mob-btn-strategy")?.addEventListener("click", () => switchPage("strategy"));
$("#mob-btn-duties")?.addEventListener("click", () => switchPage("duties"));
$("#sidebar-btn-duties")?.addEventListener("click", () => switchPage("duties"));
$("#sidebar-btn-analytics")?.addEventListener("click", () => switchPage("analytics"));

/* Inventory categories (admins create; parts vs tools) */
initInventoryCategories({ getClient: () => supabase, getProfile: () => currentProfile, getItems: () => allItems, reloadItems: () => loadItems(true), toast, esc, logAction });

/* Sign in with PIN */
initPinLogin({ url: SUPABASE_URL, publicKey: SUPABASE_PUBLIC_KEY, getClient: () => supabase, getUser: () => currentUser, getProfile: () => currentProfile, toast, message, signOut });

/* Activity: active-time tracking per feature + shop check-in */
initActivity({
  getClient: () => supabase,
  getUser: () => (currentProfile?.is_approved ? currentUser : null),
  getFeature: () => currentAppPage === "dashboard" ? currentView : currentAppPage === "strategy" ? `strategy:${currentStratTab}` : currentAppPage,
  myName: () => myShiftName(),
  toast,
  logAction,
});
$("#mob-btn-secrets")?.addEventListener("click", () => switchPage("secrets"));
$("#mob-btn-menu")?.addEventListener("click", () => {
  const sb = $("#app-sidebar");
  const bd = $("#sidebar-backdrop");
  if (sb) sb.classList.toggle("open");
  if (bd) bd.classList.toggle("active");
});

function toggleSidebar(forceState) {
  const sb = $("#app-sidebar");
  const bd = $("#sidebar-backdrop");
  const isMobile = window.innerWidth <= 1024;

  if (isMobile) {
    if (forceState === false) {
      sb?.classList.remove("open");
      bd?.classList.remove("active");
    } else {
      sb?.classList.toggle("open");
      bd?.classList.toggle("active");
    }
  } else {
    // Desktop: toggle collapsed state on body and persist in localStorage
    const willCollapse = forceState === false ? true : !document.body.classList.contains("sidebar-collapsed");
    document.body.classList.toggle("sidebar-collapsed", willCollapse);
    try { localStorage.setItem("nyx_sidebar_collapsed", willCollapse ? "1" : "0"); } catch(e){}
  }
}

// Restore desktop sidebar collapsed preference
try {
  if (window.innerWidth > 1024 && localStorage.getItem("nyx_sidebar_collapsed") === "1") {
    document.body.classList.add("sidebar-collapsed");
  }
} catch(e){}

$("#sidebar-toggle-btn")?.addEventListener("click", () => toggleSidebar());
$("#sidebar-close-btn")?.addEventListener("click", () => toggleSidebar(false));

$("#sidebar-backdrop")?.addEventListener("click", () => {
  $("#app-sidebar")?.classList.remove("open");
  $("#sidebar-backdrop")?.classList.remove("active");
});


// Auto-refresh secret intel periodically so votes and new entries sync seamlessly
setInterval(() => {
  if (currentAppPage === "secrets" && currentProfile?.is_secret) {
    loadSecretIntel(true);
  }
}, 10000);

// Auto-refresh Statbotics real-time metrics periodically when in strategy center
setInterval(() => {
  if (currentAppPage === "strategy") {
    syncStatboticsData(true);
  }
}, 60000);


/* --------------------------------------------------------------------------
   MOBILE VERTICAL POPUP SHEETS CONTROLLER (Zero Horizontal Scroll UI)
   -------------------------------------------------------------------------- */
function initMobilePopupSheets() {
  function openSheet(sheetId) {
    const sheet = $(sheetId);
    if (!sheet) return;
    sheet.classList.remove("hidden");
    document.body.classList.add("modal-open");
  }

  function closeSheet(sheetId) {
    const sheet = $(sheetId);
    if (!sheet) return;
    sheet.classList.add("hidden");
    if (!$$(".bottom-sheet-backdrop:not(.hidden)").length && !$$(".modalback:not(.hidden)").length) {
      document.body.classList.remove("modal-open");
    }
  }

  // Close backdrops on click outside
  $$(".bottom-sheet-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", e => {
      if (e.target === backdrop) {
        closeSheet("#" + backdrop.id);
      }
    });
  });

  // 1. Dashboard View Picker
  $("#mobile-view-picker-trigger")?.addEventListener("click", () => {
    // Sync badge counts
    const bAll = $("#badge-all")?.textContent || "0";
    const bCheck = $("#badge-checkouts")?.textContent || "0";
    const bPn = $("#badge-parts-needed")?.textContent || "0";
    const bShifts = $("#badge-shifts")?.textContent || "0";
    const bPlan = $("#badge-planner")?.textContent || "0";
    const bMem = $("#badge-members")?.textContent || "0";

    const elMAll = $("#m-badge-all"); if (elMAll) elMAll.textContent = bAll;
    const elMCheck = $("#m-badge-checkouts"); if (elMCheck) elMCheck.textContent = bCheck;
    const elMPn = $("#m-badge-parts-needed"); if (elMPn) elMPn.textContent = bPn;
    const elMShifts = $("#m-badge-shifts"); if (elMShifts) elMShifts.textContent = bShifts;
    const elMPlan = $("#m-badge-planner"); if (elMPlan) elMPlan.textContent = bPlan;
    const elMMem = $("#m-badge-members"); if (elMMem) elMMem.textContent = bMem;

    // Admin-only items
    const isAdmin = !!currentProfile?.is_admin;
    $("#m-tab-spending")?.classList.toggle("hidden", !isAdmin);
    $("#m-tab-members")?.classList.toggle("hidden", !isAdmin);

    openSheet("#mobile-view-sheet-modal");
  });
  $("#close-view-sheet")?.addEventListener("click", () => closeSheet("#mobile-view-sheet-modal"));

  $$("#mobile-view-options .sheet-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const v = opt.dataset.view;
      if (v) switchView(v);
      closeSheet("#mobile-view-sheet-modal");
    });
  });

  // 2. Strategy Subtabs Picker
  $("#mobile-strat-picker-trigger")?.addEventListener("click", () => {
    const bStrat = $("#badge-strat-count")?.textContent || "0";
    const bScout = $("#badge-scout-count")?.textContent || "0";
    const elMStrat = $("#m-badge-strat-count"); if (elMStrat) elMStrat.textContent = bStrat;
    const elMScout = $("#m-badge-scout-count"); if (elMScout) elMScout.textContent = bScout;

    openSheet("#mobile-strat-sheet-modal");
  });
  $("#close-strat-sheet")?.addEventListener("click", () => closeSheet("#mobile-strat-sheet-modal"));

  $$("#mobile-strat-options .sheet-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const sv = opt.dataset.stratView;
      if (sv) switchStratTab(sv);
      closeSheet("#mobile-strat-sheet-modal");
    });
  });

  // 3. Inventory Subsystem Category Filter Picker
  $("#mobile-filter-inv-trigger")?.addEventListener("click", () => {
    // Same options as the desktop tabs, rebuilt so admin-created categories appear
    const tabs = [...document.querySelectorAll("#inv-filter-tabs [data-category]")];
    $("#mobile-filter-inv-options").innerHTML = tabs.map(t => {
      const n = t.querySelector("span")?.textContent || "0";
      const label = t.textContent.replace(/\s*\d+\s*$/, "").trim();
      return `<button type="button" class="sheet-option ${t.dataset.category === activeCategory ? "active" : ""}" data-category="${esc(t.dataset.category)}">
        <div class="sheet-option-title">${esc(label)}</div><span class="sheet-badge">${esc(n)}</span></button>`;
    }).join("");
    openSheet("#mobile-filter-inv-modal");
  });
  $("#close-filter-inv-sheet")?.addEventListener("click", () => closeSheet("#mobile-filter-inv-modal"));

  $("#mobile-filter-inv-options")?.addEventListener("click", e => {
    const opt = e.target.closest(".sheet-option");
    if (!opt) return;
    activeCategory = opt.dataset.category;
    renderItems();
    const elLbl = $("#mobile-current-filter-inv-label");
    if (elLbl) elLbl.textContent = activeCategory === "ToolsOnly" ? "All tools" : activeCategory;
    closeSheet("#mobile-filter-inv-modal");
  });

  // 4. Strategy Statbotics Sort Picker
  $("#mobile-sort-strat-trigger")?.addEventListener("click", () => {
    $$("#mobile-sort-strat-options .sheet-option").forEach(opt => {
      opt.classList.toggle("active", opt.dataset.sort === currentSortMetric);
    });
    openSheet("#mobile-sort-strat-modal");
  });
  $("#close-sort-strat-sheet")?.addEventListener("click", () => closeSheet("#mobile-sort-strat-modal"));

  $$("#mobile-sort-strat-options .sheet-option").forEach(opt => {
    opt.addEventListener("click", () => {
      const sort = opt.dataset.sort;
      if (sort) {
        currentSortMetric = sort;
        $$("#strat-sort-tabs .catbtn").forEach(b => b.classList.toggle("active", b.dataset.sort === sort));
        const sortLabels = {
          "epa": "Sort by Total EPA",
          "auto_epa": "Auto EPA",
          "teleop_epa": "Teleop EPA",
          "endgame_epa": "Tower Climb EPA",
          "scout_matches": "Scouted Matches",
          "winrate": "Win Rate %"
        };
        const elLbl = $("#mobile-current-sort-label");
        if (elLbl && sortLabels[sort]) elLbl.textContent = sortLabels[sort];
        rankingsCurrentPage = 1;
        renderRankings();
      }
      closeSheet("#mobile-sort-strat-modal");
    });
  });
}


/* --------------------------------------------------------------------------
   CSV EXPORTERS FOR INVENTORY, PARTS NEEDED, AND SPENDING
   -------------------------------------------------------------------------- */
function downloadCSV(filename, csvContent) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportInventoryCSV() {
  if (!allItems || !allItems.length) {
    toast("No inventory items to export.", true);
    return;
  }
  const headers = ["ID", "Name", "Category", "IsTool", "Quantity", "MinQuantity", "Unit", "Location", "PartNumber", "Notes", "UpdatedAt"];
  const rows = allItems.map(item => [
    item.id,
    `"${(item.name || '').replace(/"/g, '""')}"`,
    item.category || '',
    item.is_tool ? 'Yes' : 'No',
    item.quantity ?? 0,
    item.min_quantity ?? 1,
    `"${(item.unit || 'pcs').replace(/"/g, '""')}"`,
    `"${(item.location || '').replace(/"/g, '""')}"`,
    `"${(item.part_number || '').replace(/"/g, '""')}"`,
    `"${(item.notes || '').replace(/"/g, '""')}"`,
    item.updated_at || ''
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  downloadCSV(`nyx11744_inventory_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast(`Exported ${allItems.length} inventory items to CSV!`);
}

function exportPartsNeededCSV() {
  if (!allPartsNeeded || !allPartsNeeded.length) {
    toast("No parts needed records to export.", true);
    return;
  }
  const headers = ["ID", "PartName", "Subsystem", "Quantity", "Vendor", "Priority", "Status", "EstimatedCost", "PartNumber", "URL", "Notes", "CreatedAt"];
  const rows = allPartsNeeded.map(p => [
    p.id,
    `"${(p.part_name || '').replace(/"/g, '""')}"`,
    p.subsystem || 'Mechanical',
    p.quantity ?? 1,
    `"${(p.vendor || '').replace(/"/g, '""')}"`,
    p.priority || 'medium',
    p.status || 'needed',
    p.estimated_cost ?? 0,
    `"${(p.part_number || '').replace(/"/g, '""')}"`,
    `"${(p.url || '').replace(/"/g, '""')}"`,
    `"${(p.notes || '').replace(/"/g, '""')}"`,
    p.created_at || ''
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  downloadCSV(`nyx11744_robot_parts_needed_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast(`Exported ${allPartsNeeded.length} parts needed records to CSV!`);
}

function exportSpendingCSV() {
  if (!allSpending || !allSpending.length) {
    toast("No spending records to export.", true);
    return;
  }
  const headers = ["ID", "Title", "Vendor", "Amount", "Category", "OrderDate", "OrderNumber", "Notes", "LoggedBy", "CreatedAt"];
  const rows = allSpending.map(s => [
    s.id,
    `"${(s.title || '').replace(/"/g, '""')}"`,
    `"${(s.vendor || '').replace(/"/g, '""')}"`,
    s.amount ?? 0,
    s.category || 'Mechanical',
    s.order_date || '',
    `"${(s.order_number || '').replace(/"/g, '""')}"`,
    `"${(s.notes || '').replace(/"/g, '""')}"`,
    `"${(s.created_by_name || 'Admin').replace(/"/g, '""')}"`,
    s.created_at || ''
  ]);
  const csv = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
  downloadCSV(`nyx11744_spending_ledger_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  toast(`Exported ${allSpending.length} purchase orders to CSV!`);
}

$("#export-inventory-csv-btn")?.addEventListener("click", exportInventoryCSV);
$("#export-parts-needed-csv-btn")?.addEventListener("click", exportPartsNeededCSV);
$("#export-spending-csv-btn")?.addEventListener("click", exportSpendingCSV);

/* --------------------------------------------------------------------------
   UNIVERSAL COMMAND PALETTE (CTRL+K / CMD+K) & KEYBOARD SHORTCUTS
   -------------------------------------------------------------------------- */
const commandList = [
  { id: "goto-inventory", label: "Go to Shop Inventory", icon: "<i class=fa-box aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("inventory"); } },
  { id: "goto-checkouts", label: "Go to Active Checkouts", icon: "<i class=fa-screwdriver-wrench aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("checkouts"); } },
  { id: "goto-parts", label: "Go to Robot Parts Needed", icon: "<i class=fa-robot aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("parts-needed"); } },
  { id: "goto-shifts", label: "Go to Lab Shifts & Calendar", icon: "<i class=fa-calendar-days aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("shifts"); } },
  { id: "goto-planner", label: "Go to Team Planner", icon: "<i class=fa-clipboard-list aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("planner"); } },
  { id: "goto-spending", label: "Go to Spending & Budget Tracker", icon: "<i class=fa-sack-dollar aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("spending"); } },
  { id: "goto-members", label: "Go to Member Permissions & Access", icon: "<i class=fa-users aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("members"); } },
  { id: "goto-logs", label: "Go to Audit & Activity Logs", icon: "<i class=fa-lock aria-hidden=true></i>", category: "Navigation", run: () => { screens("inventory"); views("logs"); } },
  { id: "goto-playbook", label: "Go to Strategy Tactical Whiteboard", icon: "<i class=fa-bullseye aria-hidden=true></i>", category: "Strategy", run: () => { screens("strategy"); stratViews("playbook"); } },
  { id: "goto-rankings", label: "Go to Statbotics Team Rankings", icon: "<i class=fa-chart-column aria-hidden=true></i>", category: "Strategy", run: () => { screens("strategy"); stratViews("rankings"); } },
  { id: "goto-scouting", label: "Go to Match Scouting Sheet", icon: "<i class=fa-pen-to-square aria-hidden=true></i>", category: "Strategy", run: () => { screens("strategy"); stratViews("scouting"); } },
  { id: "goto-simulator", label: "Go to Match Simulator (Monte Carlo)", icon: "<i class=fa-dice aria-hidden=true></i>", category: "Strategy", run: () => { screens("strategy"); stratViews("simulator"); } },
  { id: "action-theme", label: "Toggle Dark / Light Mode", icon: "<i class=fa-circle-half-stroke aria-hidden=true></i>", category: "Settings", run: () => {
    const isDark = document.documentElement.getAttribute("data-theme") !== "light";
    setTheme(isDark ? "light" : "dark");
  }},
  { id: "action-profile", label: "Edit My Name & Departments", icon: "<i class=fa-gear aria-hidden=true></i>", category: "Profile", run: () => openProfileModal() },
  { id: "action-add-item", label: "Add New Inventory Item", icon: "＋", category: "Action", run: () => openItemModal() },
  { id: "action-add-shift", label: "Schedule Lab Shift", icon: "＋", category: "Action", run: () => openShiftModal() },
  { id: "action-add-task", label: "Create Team Task", icon: "＋", category: "Action", run: () => openTaskModal() }
];

function openCommandPalette() {
  const modal = $("#command-palette-modal");
  const input = $("#command-palette-input");
  if (!modal || !input) return;
  modal.classList.remove("hidden");
  input.value = "";
  renderCommandPaletteResults("");
  input.focus();
}

function closeCommandPalette() {
  $("#command-palette-modal")?.classList.add("hidden");
}

function renderCommandPaletteResults(query) {
  const container = $("#command-palette-results");
  if (!container) return;
  const q = query.toLowerCase().trim();

  // Search built-in commands
  let matchedCmds = commandList.filter(cmd => {
    if (cmd.id === "goto-spending" || cmd.id === "goto-members" || cmd.id === "goto-logs") {
      if (!currentProfile?.is_admin) return false;
    }
    if ((cmd.id === "action-add-item" || cmd.id === "action-add-shift") && !isStaff()) return false;
    return !q || cmd.label.toLowerCase().includes(q) || cmd.category.toLowerCase().includes(q);
  });

  // Search items directly
  const matchedItems = (allItems || []).filter(item => {
    return q && (item.name.toLowerCase().includes(q) || (item.location || '').toLowerCase().includes(q) || (item.part_number || '').toLowerCase().includes(q));
  }).slice(0, 5);

  let html = "";

  if (matchedCmds.length) {
    html += matchedCmds.map(cmd => `
      <div class="cmd-item" data-cmd-id="${cmd.id}">
        <div class="cmd-item-left">
          <span class="cmd-item-icon">${cmd.icon}</span>
          <strong>${esc(cmd.label)}</strong>
        </div>
        <span class="cmd-item-badge">${esc(cmd.category)}</span>
      </div>
    `).join("");
  }

  if (matchedItems.length) {
    html += `<div style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint); margin:8px 6px 4px;">SHOP INVENTORY MATCHES</div>`;
    html += matchedItems.map(item => `
      <div class="cmd-item" data-item-id="${item.id}">
        <div class="cmd-item-left">
          <span class="cmd-item-icon"><i class=fa-box aria-hidden=true></i></span>
          <span><strong>${esc(item.name)}</strong> · ${item.quantity} ${esc(item.unit || 'pcs')}</span>
        </div>
        <span class="cmd-item-badge">${esc(item.location || 'Shop')}</span>
      </div>
    `).join("");
  }

  if (!html) {
    html = `<div style="padding:24px; text-align:center;" class="muted">No commands or items matching "${esc(query)}"</div>`;
  }

  container.innerHTML = html;
}

$("#command-palette-input")?.addEventListener("input", e => {
  renderCommandPaletteResults(e.target.value);
});

$("#command-palette-results")?.addEventListener("click", e => {
  const cmdRow = e.target.closest(".cmd-item");
  if (!cmdRow) return;

  const cmdId = cmdRow.dataset.cmdId;
  const itemId = cmdRow.dataset.itemId;

  if (cmdId) {
    const cmd = commandList.find(c => c.id === cmdId);
    if (cmd) {
      closeCommandPalette();
      cmd.run();
    }
  } else if (itemId) {
    const item = allItems.find(x => x.id === itemId);
    closeCommandPalette();
    if (item) {
      screens("inventory");
      views("inventory");
      $("#search-items").value = item.name;
      renderItems();
    }
  }
});

$("#global-command-trigger")?.addEventListener("click", openCommandPalette);

window.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const modal = $("#command-palette-modal");
    if (modal && !modal.classList.contains("hidden")) {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
  } else if (e.key === "Escape") {
    closeCommandPalette();
    $("#barcode-modal")?.classList.add("hidden");
  }
});

$("#command-palette-modal")?.addEventListener("click", e => {
  if (e.target.id === "command-palette-modal") closeCommandPalette();
});

/* --------------------------------------------------------------------------
   ITEM QR LABEL GENERATOR & MODAL
   -------------------------------------------------------------------------- */
function openBarcodeModal(item) {
  if (!item) return;
  const modal = $("#barcode-modal");
  if (!modal) return;

  $("#barcode-item-name").textContent = item.name;
  $("#barcode-part-num").textContent = item.part_number ? `P/N: ${item.part_number}` : `CAT: ${item.category.toUpperCase()}`;
  $("#barcode-location").textContent = `STORAGE: ${item.location || 'Main Shop Bin'} · QTY: ${item.quantity} ${item.unit || 'pcs'}`;

  // QR Code generator using quick lightweight SVG QR
  const qrContainer = $("#barcode-qr-container");
  const encodedData = encodeURIComponent(`NYX11744-ITEM:${item.id}|${item.name}`);
  qrContainer.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodedData}" alt="QR Label" width="160" height="160" style="border: 2px solid #000; border-radius: 8px;" />`;

  modal.classList.remove("hidden");
}

$("#close-barcode-modal")?.addEventListener("click", () => {
  $("#barcode-modal")?.classList.add("hidden");
});

$("#print-barcode-btn")?.addEventListener("click", () => {
  window.print();
});

initMobilePopupSheets();
initSupabase();
