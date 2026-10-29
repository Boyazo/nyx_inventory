// Nyx Dashboard (FRC Team 11744) — remote MCP server for Claude.
//
// Lets a team member add the workspace to Claude as a custom connector, then send Claude a photo
// (receipt, whiteboard, parts shelf, shift schedule…) and have it update inventory, tasks, shifts,
// parts needed and spending directly.
//
// Auth: each member generates a personal connector key in the app (Settings → Connect Claude).
// Only its SHA-256 hash is stored (public.mcp_tokens). The key travels in the connector URL:
//   https://<project>.supabase.co/functions/v1/mcp?key=<key>
// Every tool call runs with that member's role: approved members get member actions, admins get
// admin actions, mirroring the RLS policies in schema.sql. All writes go to activity_logs.
//
// Deploy:  supabase functions deploy mcp --no-verify-jwt
// (Claude does not send a Supabase JWT; the per-member key above is the credential.)

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SEASON_KICKOFF = "2027-01-09";
const SERVER_INFO = { name: "nyx-dashboard", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const db: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

type Member = { id: string; full_name: string; is_admin: boolean; is_staff: boolean };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
};

/* ---------- helpers ---------- */

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request): Promise<Member | null> {
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const key = url.searchParams.get("key") || bearer;
  if (!key || !key.startsWith("nyx_")) return null;

  const { data: token } = await db.from("mcp_tokens")
    .select("id, user_id").eq("token_hash", await sha256(key)).is("revoked_at", null).maybeSingle();
  if (!token) return null;

  const { data: profile } = await db.from("profiles")
    .select("*").eq("id", token.user_id).maybeSingle();
  if (!profile?.is_approved) return null;

  await db.from("mcp_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", token.id);
  return { id: profile.id, full_name: profile.full_name, is_admin: !!profile.is_admin, is_staff: !!(profile.is_admin || profile.is_moderator) };
}

class ToolError extends Error {}

const roleOf = (m: Member) => (m.is_admin ? "admin" : m.is_staff ? "moderator" : "member");
function requireAdmin(m: Member) {
  if (!m.is_admin) throw new ToolError("This action is admin-only in Nyx Dashboard.");
}
function requireStaff(m: Member) {
  if (!m.is_staff) throw new ToolError("This action needs an admin or moderator in Nyx Dashboard.");
}

function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new ToolError(res.error.message);
  return res.data;
}

async function log(m: Member, action: string, entity: string, id: string | null, details: Record<string, unknown>) {
  await db.from("activity_logs").insert({
    action, entity_type: entity, entity_id: id, user_id: m.id, user_name: m.full_name,
    details: { ...details, via: "claude_mcp" },
  });
}

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const seasonPeriod = (date: string) => (date < SEASON_KICKOFF ? "offseason" : "inseason");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

/* ---------- scouting helpers ---------- */

const GAME_YEAR = "2026"; // REBUILT; switch once the new game's scouting form ships

type ScoutRow = Record<string, any>;

function expandScout(r: ScoutRow) {
  let raw: Record<string, any> = {};
  try { raw = typeof r.raw_data === "string" ? JSON.parse(r.raw_data) : (r.raw_data || {}); } catch { /* old rows */ }
  return { ...raw, ...r, raw_data: undefined };
}

async function fetchScouting(filter: { teams?: number[]; event_name?: string; match_type?: string; limit?: number }) {
  let q = db.from("match_scouting_logs").select("*").order("created_at", { ascending: false }).limit(filter.limit ?? 1000);
  if (filter.teams?.length) q = q.in("team_num", filter.teams);
  if (filter.event_name) q = q.ilike("event_name", `%${filter.event_name}%`);
  if (filter.match_type) q = q.eq("match_type", filter.match_type);
  return (must(await q) as ScoutRow[]).map(expandScout);
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const rate = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) + "%" : null);
const nums = (rows: ScoutRow[], k: string) => rows.map(r => Number(r[k])).filter(n => Number.isFinite(n));

function summarizeTeam(team: number, rows: ScoutRow[]) {
  const mine = rows.filter(r => Number(r.team_num) === team).sort((a, b) => a.match_num - b.match_num);
  if (!mine.length) return { team, matches_scouted: 0 };
  const autoMade = nums(mine, "auto_fuel"), autoMiss = nums(mine, "auto_miss");
  const teleMade = nums(mine, "tele_fuel"), teleMiss = nums(mine, "tele_miss");
  const acc = (made: number[], miss: number[]) => {
    const m = made.reduce((a, b) => a + b, 0), x = miss.reduce((a, b) => a + b, 0);
    return m + x ? Math.round((m / (m + x)) * 100) + "%" : null;
  };
  const climbs: Record<string, number> = {};
  mine.forEach(r => { climbs[r.climb || "none"] = (climbs[r.climb || "none"] || 0) + 1; });
  const pts = nums(mine, "est_points");
  const recent = pts.slice(-3);
  return {
    team,
    matches_scouted: mine.length,
    avg_est_points: avg(pts),
    recent_3_avg_points: avg(recent),
    max_est_points: pts.length ? Math.max(...pts) : null,
    consistency_stdev: pts.length > 1 ? Math.round(Math.sqrt(pts.reduce((s, p) => s + (p - avg(pts)!) ** 2, 0) / pts.length) * 10) / 10 : null,
    auto: { avg_fuel: avg(autoMade), accuracy: acc(autoMade, autoMiss), mobility_rate: rate(mine.map(r => !!r.auto_moved)), auto_climb_rate: rate(mine.map(r => !!r.auto_climb)) },
    teleop: { avg_fuel: avg(teleMade), accuracy: acc(teleMade, teleMiss), floor_intake_rate: rate(mine.map(r => !!r.intake_floor)), hp_feed_rate: rate(mine.map(r => !!r.hp_feed)) },
    navigation: { bump_rate: rate(mine.map(r => !!r.nav_bump)), trench_rate: rate(mine.map(r => !!r.nav_trench)) },
    endgame_climbs: climbs,
    reliability: { died_rate: rate(mine.map(r => !!r.died)), tipped_rate: rate(mine.map(r => !!r.tipped)) },
    driver_rating_avg_of_10: avg(mine.map(r => (r.rating_scale === 10 ? 1 : 2) * Number(r.driver_rating)).filter(Number.isFinite)),
    defense_rating_avg_of_10: avg(mine.map(r => (r.rating_scale === 10 ? 1 : 2) * Number(r.defense_rating)).filter(n => Number.isFinite(n) && n > 0)),
    tags: Object.entries(mine.flatMap(r => r.tags || []).reduce((m: Record<string, number>, t: string) => ({ ...m, [t]: (m[t] || 0) + 1 }), {})).map(([t, n]) => `${t} ×${n}`),
    stations_played: [...new Set(mine.map(r => r.station))],
    scout_notes: mine.filter(r => r.notes).slice(-8).map(r => `M${r.match_num}: ${r.notes}`),
  };
}

async function statbotics(team: number, year = GAME_YEAR) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.statbotics.io/v3/team_year/${team}/${year}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const d = await res.json();
    const epa = d.epa || {};
    return {
      name: d.name, epa_total: epa.total_points?.mean ?? epa.norm, epa_breakdown: epa.breakdown ? pick(epa.breakdown, ["auto_points", "teleop_points", "endgame_points"]) : undefined,
      record: d.record ? `${d.record.wins}-${d.record.losses}-${d.record.ties}` : undefined, country_rank: epa.ranks?.country?.rank, total_rank: epa.ranks?.total?.rank,
    };
  } catch { return null; }
}

/* ---------- tool definitions ---------- */

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });
const int = (description: string) => ({ type: "integer", description });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

// Inventory categories are admin-defined (inventory_categories), so they're free text here
const SUBSYSTEMS = ["General", "Mechanical", "Electrical", "Software", "Design / CAD", "Business"];
const DEPTS = ["Mechanical", "Electrical", "Software", "Business", "All Departments"];
const SPEND_CATS = ["Robot Hardware", "Electronics & Control", "Tools & Equipment", "Raw Materials", "Pit & Safety", "Other"];
const PART_SUBSYSTEMS = ["Mechanical", "Electrical", "Software", "Design / CAD", "General"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  admin?: boolean;      // admins and moderators
  adminOnly?: boolean;  // admins only
  readOnly?: boolean;
  run: (m: Member, a: Record<string, any>) => Promise<unknown>;
};

const TOOLS: Tool[] = [
  {
    name: "whoami",
    description: "Show which NYX team member this connector acts as, their role, today's date and the season kickoff.",
    inputSchema: obj({}),
    readOnly: true,
    run: async m => ({ member: m.full_name, role: roleOf(m), today: today(), season_kickoff: SEASON_KICKOFF, current_period: seasonPeriod(today()) }),
  },

  /* Inventory */
  {
    name: "search_inventory",
    description: "Search shop inventory (parts and tools) by name, part number, location or notes. Use before adding items to avoid duplicates.",
    inputSchema: obj({ query: str("Text to match; empty lists everything"), category: str("Filter by category name"), low_stock_only: bool("Only items at or below their minimum quantity") }),
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("inventory_items").select("id, name, category, quantity, unit, location, part_number, is_tool, min_quantity, notes").order("name").limit(200);
      if (a.category) q = q.eq("category", a.category);
      if (a.query) {
        const t = String(a.query).replace(/[%,()]/g, " ");
        q = q.or(`name.ilike.%${t}%,part_number.ilike.%${t}%,location.ilike.%${t}%,notes.ilike.%${t}%`);
      }
      const items = must(await q) as any[];
      return a.low_stock_only ? items.filter(i => i.quantity <= i.min_quantity) : items;
    },
  },
  {
    name: "add_inventory_item",
    description: "Add a new part or tool to inventory (admin).",
    inputSchema: obj({
      name: str("Item name"), category: str("Category name, e.g. Mechanical, Electrical, Hand Tools, Power Tools"), quantity: int("Quantity on hand"),
      unit: str("Unit, e.g. pcs, ft, box"), location: str("Bin / shelf location"), part_number: str("Vendor part number"),
      is_tool: bool("True for tools that get checked out"), min_quantity: int("Low-stock threshold"), notes: str("Notes"),
    }, ["name", "category", "quantity"]),
    admin: true,
    run: async (m, a) => {
      const row = must(await db.from("inventory_items").insert({
        ...pick(a, ["name", "category", "quantity", "unit", "location", "part_number", "is_tool", "min_quantity", "notes"]),
        created_by: m.id, updated_by: m.id,
      }).select().single()) as any;
      await log(m, "ITEM_CREATED", "inventory_items", row.id, { name: row.name, qty: row.quantity, unit: row.unit, location: row.location });
      return row;
    },
  },
  {
    name: "update_inventory_item",
    description: "Update an inventory item by id (admin). Use adjust_quantity for relative stock changes (e.g. -3 used, +10 restocked) or quantity to set an exact count.",
    inputSchema: obj({
      id: str("Item id from search_inventory"), adjust_quantity: int("Add/subtract from current quantity"), quantity: int("Set exact quantity"),
      name: str("New name"), category: str("Category name"), unit: str("Unit"), location: str("Location"),
      part_number: str("Part number"), min_quantity: int("Low-stock threshold"), notes: str("Notes"),
    }, ["id"]),
    admin: true,
    run: async (m, a) => {
      const cur = must(await db.from("inventory_items").select("*").eq("id", a.id).single()) as any;
      const patch: Record<string, unknown> = pick(a, ["name", "category", "unit", "location", "part_number", "min_quantity", "notes", "quantity"]);
      if (typeof a.adjust_quantity === "number") patch.quantity = Math.max(0, cur.quantity + a.adjust_quantity);
      const row = must(await db.from("inventory_items").update({ ...patch, updated_by: m.id, updated_at: new Date().toISOString() }).eq("id", a.id).select().single()) as any;
      await log(m, "ITEM_UPDATED", "inventory_items", a.id, { name: row.name, previous_qty: cur.quantity, new_qty: row.quantity, qty: row.quantity, unit: row.unit, location: row.location });
      return row;
    },
  },

  /* Planner tasks */
  {
    name: "list_tasks",
    description: "List build planner tasks (To Do / In Progress / Completed board).",
    inputSchema: obj({ status: str("Filter by status", { enum: ["todo", "in_progress", "done"] }), subsystem: str("Filter by subsystem", { enum: SUBSYSTEMS }), assigned_to: str("Filter by assignee name") }),
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("planner_tasks").select("id, title, description, subsystem, status, priority, due_date, assigned_to, position")
        .order("position", { ascending: true, nullsFirst: true }).order("created_at", { ascending: false });
      if (a.status) q = q.eq("status", a.status);
      if (a.subsystem) q = q.eq("subsystem", a.subsystem);
      if (a.assigned_to) q = q.ilike("assigned_to", `%${a.assigned_to}%`);
      return must(await q);
    },
  },
  {
    name: "create_tasks",
    description: "Create one or more planner tasks (admin). Good for turning a photo of a whiteboard or to-do list into cards.",
    inputSchema: obj({
      tasks: {
        type: "array", minItems: 1, maxItems: 50,
        items: obj({
          title: str("Task title"), description: str("Details"), subsystem: str("Subsystem", { enum: SUBSYSTEMS }),
          status: str("Column", { enum: ["todo", "in_progress", "done"] }), priority: str("Priority", { enum: PRIORITIES }),
          due_date: str("YYYY-MM-DD"), assigned_to: str("Assignee name"),
        }, ["title"]),
      },
    }, ["tasks"]),
    admin: true,
    run: async (m, a) => {
      const rows = (a.tasks as any[]).map(t => ({
        subsystem: "General", status: "todo", priority: "medium", ...t, created_by: m.id, created_by_name: m.full_name,
      }));
      const created = must(await db.from("planner_tasks").insert(rows).select("id, title, status, subsystem")) as any[];
      for (const t of created) await log(m, "PLANNER_TASK_CREATED", "planner_tasks", t.id, { title: t.title, subsystem: t.subsystem, status: t.status });
      return created;
    },
  },
  {
    name: "update_task",
    description: "Move a task between columns or edit it. Any member may change status; other fields are admin-only.",
    inputSchema: obj({
      id: str("Task id"), status: str("New column", { enum: ["todo", "in_progress", "done"] }), title: str("Title"), description: str("Details"),
      subsystem: str("Subsystem", { enum: SUBSYSTEMS }), priority: str("Priority", { enum: PRIORITIES }), due_date: str("YYYY-MM-DD"), assigned_to: str("Assignee"),
    }, ["id"]),
    run: async (m, a) => {
      const patch = pick(a, ["status", "title", "description", "subsystem", "priority", "due_date", "assigned_to"]);
      if (Object.keys(patch).some(k => k !== "status")) requireStaff(m);
      const prev = must(await db.from("planner_tasks").select("status, title, subsystem, assigned_to").eq("id", a.id).single()) as any;
      const row = must(await db.from("planner_tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", a.id).select().single()) as any;
      await log(m, row.status === "done" && prev.status !== "done" ? "PLANNER_TASK_COMPLETED" : "PLANNER_TASK_UPDATED", "planner_tasks", a.id,
        { title: row.title, previous_status: prev.status, new_status: row.status, status: row.status, subsystem: row.subsystem, assigned_to: row.assigned_to });
      return row;
    },
  },

  /* Shifts */
  {
    name: "list_shifts",
    description: "List build shifts with rosters. Defaults to upcoming shifts.",
    inputSchema: obj({ from_date: str("YYYY-MM-DD, default today"), to_date: str("YYYY-MM-DD"), department: str("Department", { enum: DEPTS }) }),
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("team_shifts").select("id, title, department, shift_date, start_time, end_time, location, attendees, notes")
        .gte("shift_date", a.from_date || today()).order("shift_date").order("start_time");
      if (a.to_date) q = q.lte("shift_date", a.to_date);
      if (a.department) q = q.eq("department", a.department);
      return must(await q);
    },
  },
  {
    name: "create_shifts",
    description: "Schedule one or more build shifts (admin), e.g. from a photo of a meeting calendar. Times are 24h HH:MM, Pacific time.",
    inputSchema: obj({
      shifts: {
        type: "array", minItems: 1, maxItems: 60,
        items: obj({
          title: str("Shift title"), department: str("Department", { enum: DEPTS }), shift_date: str("YYYY-MM-DD"),
          start_time: str("HH:MM"), end_time: str("HH:MM"), location: str("Location"), notes: str("Notes"),
          attendees: { type: "array", items: { type: "string" }, description: "Full names of members to assign (they get a Discord ping)" },
          full_team: bool("Full team meeting: department becomes All Departments and every approved member is attending"),
        }, ["title", "department", "shift_date", "start_time", "end_time"]),
      },
    }, ["shifts"]),
    admin: true,
    run: async (m, a) => {
      const everyone = (a.shifts as any[]).some(s => s.full_team)
        ? ((must(await db.from("profiles").select("full_name").eq("is_approved", true)) as any[]).map(p => p.full_name))
        : [];
      const rows = (a.shifts as any[]).map(({ full_team, ...s }) => ({
        location: "Main Shop", ...s,
        department: full_team ? "All Departments" : s.department,
        attendees: full_team ? everyone : (s.attendees || []),
        created_by: m.id, created_by_name: m.full_name,
      }));
      const created = must(await db.from("team_shifts").insert(rows).select("id, title, shift_date, department")) as any[];
      for (const s of created) await log(m, "SHIFT_CREATED", "team_shifts", s.id, { title: s.title, department: s.department, shift_date: s.shift_date });
      return created;
    },
  },
  {
    name: "set_shift_attendance",
    description: "Sign a member up for, or remove them from, a shift. Members can only change their own attendance; admins can change anyone's.",
    inputSchema: obj({ id: str("Shift id"), attending: bool("true to join, false to leave"), member_name: str("Admin only: another member's full name") }, ["id", "attending"]),
    run: async (m, a) => {
      const name = a.member_name && a.member_name !== m.full_name ? (requireStaff(m), a.member_name) : m.full_name;
      const shift = must(await db.from("team_shifts").select("*").eq("id", a.id).single()) as any;
      const set = new Set<string>(shift.attendees || []);
      a.attending ? set.add(name) : set.delete(name);
      const row = must(await db.from("team_shifts").update({ attendees: [...set], updated_at: new Date().toISOString() }).eq("id", a.id).select().single());
      await log(m, a.attending ? "SHIFT_ATTENDED" : "SHIFT_LEFT", "team_shifts", a.id, { shift_title: shift.title, shift_date: shift.shift_date, member_name: name });
      return row;
    },
  },

  /* Parts needed */
  {
    name: "list_parts_needed",
    description: "List the robot's bill of needs (parts to order) and their order status.",
    inputSchema: obj({ status: str("Filter", { enum: ["needed", "ordered", "shipped", "arrived"] }) }),
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("parts_needed").select("id, part_name, subsystem, quantity, vendor, part_number, url, priority, status, estimated_cost, notes").order("created_at", { ascending: false });
      if (a.status) q = q.eq("status", a.status);
      return must(await q);
    },
  },
  {
    name: "upsert_part_needed",
    description: "Add a part to the bill of needs, or update one (pass id) e.g. to mark it ordered/shipped/arrived (admin).",
    inputSchema: obj({
      id: str("Existing part id to update"), part_name: str("Part name"), subsystem: str("Subsystem", { enum: PART_SUBSYSTEMS }), quantity: int("Quantity"),
      vendor: str("Vendor"), part_number: str("Part number"), url: str("Product link"), priority: str("Priority", { enum: PRIORITIES }),
      status: str("Status", { enum: ["needed", "ordered", "shipped", "arrived"] }), estimated_cost: num("Estimated cost USD"), notes: str("Notes"),
    }),
    admin: true,
    run: async (m, a) => {
      const fields = pick(a, ["part_name", "subsystem", "quantity", "vendor", "part_number", "url", "priority", "status", "estimated_cost", "notes"]);
      const row = a.id
        ? must(await db.from("parts_needed").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", a.id).select().single()) as any
        : must(await db.from("parts_needed").insert({ subsystem: "General", ...fields, created_by: m.id }).select().single()) as any;
      await log(m, a.id ? "PART_NEEDED_UPDATED" : "PART_NEEDED_ADDED", "parts_needed", row.id, { part_name: row.part_name, status: row.status, quantity: row.quantity });
      return row;
    },
  },

  /* Scouting & strategy */
  {
    name: "get_scouting_entries",
    description: "Raw match scouting entries (auto/teleop fuel made & missed, climb, driver/defense ratings, died/tipped, notes). Filter by team(s), event or match type.",
    inputSchema: obj({
      teams: { type: "array", items: { type: "integer" }, description: "Team numbers" }, event_name: str("Event name contains"),
      match_type: str("qm, sf, f…"), limit: int("Max rows, default 200"),
    }),
    readOnly: true,
    run: async (_m, a) => fetchScouting({ teams: a.teams, event_name: a.event_name, match_type: a.match_type, limit: a.limit ?? 200 }),
  },
  {
    name: "team_scouting_report",
    description: "Aggregated scouting profile per team (averages, accuracy, climb distribution, reliability, consistency, recent form, scout notes) plus live Statbotics EPA. Use for pick lists and opponent analysis.",
    inputSchema: obj({
      teams: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 60, description: "Team numbers" },
      event_name: str("Only use data from this event"), include_statbotics: bool("Fetch Statbotics EPA (default true)"),
    }, ["teams"]),
    readOnly: true,
    run: async (_m, a) => {
      const rows = await fetchScouting({ teams: a.teams, event_name: a.event_name });
      return Promise.all((a.teams as number[]).map(async t => ({
        ...summarizeTeam(t, rows),
        statbotics: a.include_statbotics === false ? undefined : await statbotics(t),
      })));
    },
  },
  {
    name: "rank_scouted_teams",
    description: "Rank every scouted team at an event by a metric — the starting point for an alliance-selection pick list.",
    inputSchema: obj({
      event_name: str("Event name contains (omit for all data)"),
      sort_by: str("Metric", { enum: ["avg_est_points", "recent_3_avg_points", "auto_fuel", "teleop_fuel", "climb_points", "reliability", "defense"] }),
      min_matches: int("Ignore teams with fewer scouted matches (default 2)"), exclude_teams: { type: "array", items: { type: "integer" }, description: "Already picked / declined" },
    }),
    readOnly: true,
    run: async (_m, a) => {
      const rows = await fetchScouting({ event_name: a.event_name });
      const climbPts: Record<string, number> = { L3: 30, L2: 20, L1: 10 };
      const skip = new Set<number>(a.exclude_teams || []);
      const teams = [...new Set(rows.map(r => Number(r.team_num)))].filter(t => !skip.has(t));
      const scored = teams.map(t => {
        const mine = rows.filter(r => Number(r.team_num) === t);
        const s = summarizeTeam(t, rows) as any;
        const key: Record<string, number | null> = {
          avg_est_points: s.avg_est_points, recent_3_avg_points: s.recent_3_avg_points,
          auto_fuel: s.auto?.avg_fuel, teleop_fuel: s.teleop?.avg_fuel,
          climb_points: avg(mine.map(r => climbPts[r.climb] || 0)),
          reliability: 100 - (avg(mine.map(r => (r.died || r.tipped ? 100 : 0))) ?? 0),
          defense: s.defense_rating_avg,
        };
        return { team: t, matches: s.matches_scouted, score: key[a.sort_by || "avg_est_points"] ?? 0, avg_est_points: s.avg_est_points, endgame_climbs: s.endgame_climbs, died_rate: s.reliability?.died_rate };
      }).filter(x => x.matches >= (a.min_matches ?? 2));
      return scored.sort((x, y) => (y.score ?? 0) - (x.score ?? 0)).map((x, i) => ({ rank: i + 1, ...x }));
    },
  },
  {
    name: "match_strategy_brief",
    description:
      "Everything needed to plan a match: scouting profiles + Statbotics for our alliance and the opponents, and predicted alliance scores. " +
      "Use the result to recommend roles (scorer / feeder / defender), auto paths, who climbs where, and which opponent to defend.",
    inputSchema: obj({
      our_alliance: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 4, description: "Our alliance team numbers (include 11744)" },
      opponents: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 4, description: "Opposing alliance team numbers" },
      event_name: str("Restrict scouting data to this event"),
    }, ["our_alliance", "opponents"]),
    readOnly: true,
    run: async (_m, a) => {
      const all = [...a.our_alliance, ...a.opponents] as number[];
      const rows = await fetchScouting({ teams: all, event_name: a.event_name });
      const profile = async (t: number) => ({ ...summarizeTeam(t, rows), statbotics: await statbotics(t) });
      const ours = await Promise.all((a.our_alliance as number[]).map(profile));
      const theirs = await Promise.all((a.opponents as number[]).map(profile));
      const predict = (ps: any[]) => Math.round(ps.reduce((s, p) => s + (p.recent_3_avg_points ?? p.avg_est_points ?? p.statbotics?.epa_total ?? 0), 0));
      return {
        our_alliance: ours, opponents: theirs,
        predicted_score: { ours: predict(ours), opponents: predict(theirs) },
        data_gaps: all.filter(t => !rows.some(r => Number(r.team_num) === t)).map(t => `No scouting data for ${t}; relying on Statbotics only`),
      };
    },
  },
  {
    name: "record_scouting_entries",
    description: "Log match scouting entries, e.g. transcribed from photos of paper scouting sheets. One entry per team per match.",
    inputSchema: obj({
      entries: {
        type: "array", minItems: 1, maxItems: 60,
        items: obj({
          team_num: int("Team number"), match_num: int("Match number"), match_type: str("qm, sf, f"), event_name: str("Event name"),
          scout_name: str("Who scouted"), station: str("R1-R3 / B1-B3"),
          auto_fuel: int("Auto fuel scored"), auto_miss: int("Auto misses"), auto_moved: bool("Left starting zone"), auto_climb: bool("Climbed in auto"),
          tele_fuel: int("Teleop fuel scored"), tele_miss: int("Teleop misses"), intake_floor: bool("Floor intake"), hp_feed: bool("Human player feed"),
          nav_bump: bool("Crossed bump"), nav_trench: bool("Used trench"), climb: str("Endgame climb", { enum: ["none", "L1", "L2", "L3"] }),
          driver_rating: int("1-10"), defense_rating: int("0-10 (0 = no defense)"), died: bool("Robot died"), tipped: bool("Tipped over"),
          event_key: str("TBA event key, e.g. 2027casd"), tags: { type: "array", items: { type: "string" }, description: "Quick tags: Fast, Accurate, Good driver, Plays defense, Shoots on the move, Tippy, Broke down, Inconsistent" },
          alliance_score: int("Final alliance score"), notes: str("Notes"),
        }, ["team_num", "match_num"]),
      },
    }, ["entries"]),
    run: async (m, a) => {
      const climbPts: Record<string, number> = { L3: 30, L2: 20, L1: 10 };
      const rows = (a.entries as any[]).map(e => {
        const rec = {
          match_type: "qm", event_name: `${GAME_YEAR} Event`, scout_name: m.full_name, station: "R1", climb: "none",
          auto_fuel: 0, tele_fuel: 0, auto_miss: 0, tele_miss: 0, driver_rating: 5, defense_rating: 0, notes: "", tags: [], event_key: "", ...e,
          rating_scale: 10,
        };
        rec.est_points = (rec.auto_fuel || 0) + (rec.tele_fuel || 0) + (rec.auto_climb ? 15 : 0) + (climbPts[rec.climb] || 0);
        rec.id = `scout_${Date.now()}_${crypto.randomUUID().slice(0, 4)}`;
        rec.created_at = new Date().toISOString();
        return {
          ...pick(rec, ["id", "team_num", "match_num", "match_type", "event_name", "event_key", "tags", "scout_name", "station", "auto_fuel", "tele_fuel", "climb", "est_points", "notes"]),
          raw_data: JSON.stringify(rec), created_by: m.id,
        };
      });
      const created = must(await db.from("match_scouting_logs").insert(rows).select("id, team_num, match_num, est_points")) as any[];
      for (const r of created) await log(m, "SCOUTING_SUBMITTED", "match_scouting_logs", r.id, { team_num: r.team_num, match_num: r.match_num, est_points: r.est_points });
      return created;
    },
  },
  {
    name: "list_strategy_plays",
    description: "List saved playbook entries and their written strategy notes.",
    inputSchema: obj({ query: str("Name contains") }),
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("strategy_plays").select("id, name, notes, game_year, created_by_name, created_at").order("created_at", { ascending: false }).limit(50);
      if (a.query) q = q.ilike("name", `%${a.query}%`);
      return must(await q);
    },
  },
  {
    name: "save_strategy_plan",
    description: "Save a written match/alliance strategy to the team playbook so drivers and drive coach can open it in the app (Strategy → Saved Plays). Use markdown-style plain text: roles, auto, teleop, endgame, defense, contingencies.",
    inputSchema: obj({ name: str("e.g. 'Q42 vs 254/1678/971'"), plan: str("The full written strategy") }, ["name", "plan"]),
    run: async (m, a) => {
      const row = must(await db.from("strategy_plays").insert({
        name: a.name, notes: a.plan, drawing_data: "[]", game_year: GAME_YEAR, created_by: m.id, created_by_name: `${m.full_name} (via Claude)`,
      }).select("id, name").single()) as any;
      await log(m, "PLAYBOOK_SAVED", "strategy_plays", row.id, { play_name: row.name, strokes_count: 0, match_context: "Claude strategy plan" });
      return row;
    },
  },

  /* Spending */
  {
    name: "list_purchases",
    description: "List recorded purchases (admin) with totals. Purchases before the season kickoff are offseason.",
    inputSchema: obj({ period: str("Filter", { enum: ["all", "offseason", "inseason"] }), missing_receipt_only: bool("Only purchases still missing a receipt screenshot") }),
    admin: true,   // spending: admins and moderators
    readOnly: true,
    run: async (_m, a) => {
      let q = db.from("spending_records").select("id, title, vendor, amount, category, order_date, order_number, notes, season_period, receipt_data, edit_history").order("order_date", { ascending: false });
      if (a.period && a.period !== "all") q = q.eq("season_period", a.period);
      let rows = (must(await q) as any[]).map(({ receipt_data, edit_history, ...r }) => ({ ...r, has_receipt: Boolean(receipt_data), versions: (edit_history?.length || 0) + 1 }));
      if (a.missing_receipt_only) rows = rows.filter(r => !r.has_receipt);
      return { total: rows.reduce((s, r) => s + Number(r.amount), 0).toFixed(2), count: rows.length, purchases: rows };
    },
  },
  {
    name: "record_purchase",
    description:
      "Record a team purchase from a receipt or card-charge screenshot (admin). Read vendor, date, total and items from the image. " +
      "Pass the screenshot as receipt_image_base64 when you can; otherwise the purchase is saved flagged 'receipt missing' and an admin must attach the screenshot in the app. " +
      "Season period is set automatically from order_date (kickoff " + SEASON_KICKOFF + ").",
    inputSchema: obj({
      title: str("Short description, e.g. 'Rivets + rivet gun'"), vendor: str("Store / vendor"), amount: num("Total charged in USD incl. tax & shipping"),
      category: str("Budget category", { enum: SPEND_CATS }), order_date: str("YYYY-MM-DD, default today"), order_number: str("Order / PO number"),
      notes: str("Items, card used, grant, etc."), season_period: str("Override the automatic period", { enum: ["offseason", "inseason"] }),
      receipt_image_base64: str("Receipt screenshot as base64 (JPEG/PNG), without the data: prefix"), receipt_mime_type: str("e.g. image/jpeg"),
    }, ["title", "vendor", "amount", "category"]),
    admin: true,   // spending: admins and moderators
    run: async (m, a) => {
      const order_date = a.order_date || today();
      const receipt_data = a.receipt_image_base64 ? `data:${a.receipt_mime_type || "image/jpeg"};base64,${a.receipt_image_base64}` : "";
      if (receipt_data.length > 3_000_000) throw new ToolError("Receipt image is too large; send a smaller screenshot (under ~2 MB).");
      const row = must(await db.from("spending_records").insert({
        ...pick(a, ["title", "vendor", "amount", "category", "order_number"]),
        notes: a.notes || "",
        order_date, season_period: a.season_period || seasonPeriod(order_date), receipt_data, edit_history: [],
        created_by: m.id, created_by_name: m.full_name,
      }).select("id, title, vendor, amount, order_date, season_period").single()) as any;
      await log(m, "SPENDING_RECORDED", "spending_records", row.id, { ...row, has_receipt: Boolean(receipt_data) });
      return { ...row, has_receipt: Boolean(receipt_data), reminder: receipt_data ? undefined : "Attach the receipt screenshot in the app (Spending → ✏️) — it's required." };
    },
  },
  {
    name: "edit_purchase",
    description: "Edit a recorded purchase (admin). A reason is required and the change is added to the purchase's version history.",
    inputSchema: obj({
      id: str("Purchase id"), reason: str("Why it's being changed"), title: str("Title"), vendor: str("Vendor"), amount: num("Amount USD"),
      category: str("Category", { enum: SPEND_CATS }), order_date: str("YYYY-MM-DD"), order_number: str("Order #"), notes: str("Notes"),
      season_period: str("Period", { enum: ["offseason", "inseason"] }), receipt_image_base64: str("Replacement receipt screenshot, base64"), receipt_mime_type: str("e.g. image/png"),
    }, ["id", "reason"]),
    admin: true,   // spending: admins and moderators
    run: async (m, a) => {
      const cur = must(await db.from("spending_records").select("*").eq("id", a.id).single()) as any;
      const patch: Record<string, any> = pick(a, ["title", "vendor", "amount", "category", "order_date", "order_number", "notes", "season_period"]);
      if (patch.order_date && !a.season_period) patch.season_period = seasonPeriod(patch.order_date);
      if (a.receipt_image_base64) patch.receipt_data = `data:${a.receipt_mime_type || "image/jpeg"};base64,${a.receipt_image_base64}`;

      const changes: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === "receipt_data") changes.receipt = { from: cur.receipt_data ? "previous screenshot" : "none", to: "new screenshot uploaded" };
        else if (String(cur[k] ?? "") !== String(v)) changes[k] = { from: cur[k], to: v };
      }
      const history = [...(cur.edit_history || []), {
        version: (cur.edit_history?.length || 0) + 1, edited_at: new Date().toISOString(), edited_by: m.id,
        edited_by_name: `${m.full_name} (via Claude)`, reason: a.reason, changes: Object.keys(changes).length ? changes : { note: "No field changes" },
      }];
      const row = must(await db.from("spending_records").update({ ...patch, edit_history: history, updated_at: new Date().toISOString() })
        .eq("id", a.id).select("id, title, vendor, amount, order_date, season_period").single());
      await log(m, "SPENDING_UPDATED", "spending_records", a.id, { title: cur.title, reason: a.reason, changes });
      return { ...row as any, version: history.length + 1 };
    },
  },
];

/* ---------- JSON-RPC / MCP plumbing ---------- */

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

function rpcResult(id: Rpc["id"], result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: Rpc["id"], code: number, message: string) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

async function handle(msg: Rpc, member: Member) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `You are connected to Nyx Dashboard, FRC Team 11744's workspace, as ${member.full_name} (${roleOf(member)}). ` +
          "When the user sends a photo, work out every change it implies (purchases from receipts, tasks from whiteboards, shifts from schedules, stock counts from shelves), " +
          "check existing records first to avoid duplicates, make the changes with these tools, then summarize exactly what changed. " +
          "For strategy questions, pull scouting with team_scouting_report / match_strategy_brief / rank_scouted_teams, ground every recommendation in those numbers, " +
          "call out thin data, and offer to save the plan with save_strategy_plan. " +
          `Dates are Pacific time; the build season kicks off ${SEASON_KICKOFF}.`,
      });
    }
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.filter(t => (!t.admin || member.is_staff) && (!t.adminOnly || member.is_admin)).map(t => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, destructiveHint: false },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find(t => t.name === msg.params?.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${msg.params?.name}`);
      try {
        if (tool.adminOnly) requireAdmin(member);
        else if (tool.admin) requireStaff(member);
        const out = await tool.run(member, msg.params?.arguments || {});
        return rpcResult(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `Unexpected error: ${(err as Error).message}`;
        return rpcResult(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return msg.id === undefined ? null : rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const member = await authenticate(req);
  if (!member) {
    return Response.json(rpcError(null, -32001, "Invalid or revoked NYX connector key. Generate a new one in the app under Connect Claude."), { status: 401, headers: CORS });
  }

  let body: Rpc | Rpc[];
  try { body = await req.json(); }
  catch { return Response.json(rpcError(null, -32700, "Parse error"), { status: 400, headers: CORS }); }

  const batch = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(batch.map(m => handle(m, member)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202, headers: CORS });
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
});
