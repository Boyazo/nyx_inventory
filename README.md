# FRC NYX 11744 — Shared Inventory & Team Workspace

A modern, responsive shared tools/parts inventory, robot parts ordering tracker, team planner, and budget management system for **Team NYX 11744** (San Diego, CA). Styled with the official [nyx11744.org](https://nyx11744.org/) visual identity and logo.

## Key Features

- **Intuitive Light & Dark Mode**: Segmented pill switch in the topbar (`🌙 Dark` / `☀️ Light`) with automatic local persistence and smooth transitions.
- **Quick FRC Component Autofill Dropdown**: In the "Add / Edit Item" modal, an extensive FRC parts and tools dropdown with 30+ official components across Motors (Kraken, Falcon, NEO, CIM), Electronics (RoboRIO 2, PDH, PDP, CANivore, Limelight, Pigeon 2), Fasteners (10-32, 1/4-20, Rivets), Swerve (MK4i, MAXSwerve), Batteries, and Pit Tools that autofills name, category, tool status, part numbers, and units with one click.
- **Parts Needed for Robot 🤖 (Bill of Needs)**:
  - **Everyone can view**: Live tracking of mechanism parts needed, vendor links, quantities, and statuses (`Needed 🔴`, `Ordered 🟡`, `Shipped 🚚`, `Arrived in Shop 🟢`).
  - **Admins only edit**: Only coaches and team leads can add, update order status, or remove needed parts.
- **Tool & Equipment Checkouts**: Anyone approved can borrow tools and check them back in with real-time shop tracking.
- **Team Build Planner 📋**: A live 3-stage board (`To Do`, `In Progress`, `Completed`) where admins add milestones and any team member can advance task progress.
- **Spending & Budget Tracking 💰 (Admin Only)**: Dedicated ledger for recording purchase orders, vendor invoices, order dates, budget categories, and total season expenditures with Row Level Security.
- **Admin-Only Inventory & Task Management**: Only verified admins can add/edit/delete inventory items or create/delete planner tasks.
- **Admin Audit Logs 🔒**: Detailed event stream of all changes, checkouts, orders, and member approvals.

- **Drag-and-drop Planner**: Drag task cards between `To Do`, `In Progress` and `Completed` (and reorder within a column) like a Trello board. On phones, long-press a card to pick it up.
- **Google Calendar Shift Sync 📅**: Members click *Sync to Google Calendar* once; every shift they join is added to their Google Calendar and removed when they leave. Without it, joined shifts show a one-click *Add to Google Calendar* link.
- **Claude Connector 🤖 (MCP)**: *Connect Claude* generates a personal connector URL. Add it to Claude as a custom connector, then send Claude a photo (receipt, whiteboard, shelf, schedule) and it records purchases, creates tasks, schedules shifts and updates stock with your permissions.
- **Scouting-driven Strategy via Claude 🧠**: Through the connector, Claude can pull aggregated team scouting reports (accuracy, climbs, reliability, recent form) with live Statbotics EPA, rank teams for pick lists, build a match brief for any alliance vs. opponents, log entries from photos of paper scouting sheets, and save its written plan to the playbook (*Strategy → Saved Plays → 📋 Strategy notes*).
- **Spending Seasons & Audit Trail**: Purchases before kickoff (`SEASON_KICKOFF`, currently Jan 9, 2027) are offseason; on/after are in-season. Every purchase requires a receipt/card-charge screenshot, and admin edits require a reason and are kept as a version history.

## Database Setup & Updates

1. In your **Supabase Dashboard**, open the **SQL Editor**.
2. Run the complete script in [`supabase/schema.sql`](file:///C:/Users/Raymond%20Liu/.gemini/antigravity/scratch/nyx_inventory/supabase/schema.sql).
   * It creates `parts_needed` and `spending_records` tables with full RLS policies.
   * It ensures only admins can write to inventory, tasks, parts needed, and spending records.
   * It registers Realtime publications for live team synchronization.

## Claude Connector (MCP) Setup

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project: `supabase link --project-ref wdzrttyxcedkaifzkjvp`.
2. Deploy the server: `supabase functions deploy mcp --no-verify-jwt` (Claude authenticates with each member's connector key, not a Supabase JWT).
3. In the app, click **🤖 Connect Claude → Generate Connector**, then add the URL in Claude under *Settings → Connectors → Add custom connector*.

## Google Calendar Setup

1. In Google Cloud Console, enable the **Google Calendar API** and create an OAuth client of type *Web application*.
2. Add the site origin (e.g. `https://boyazo.github.io`) under *Authorized JavaScript origins*, and configure the OAuth consent screen with the `calendar.events` scope.
3. Paste the client id into `GOOGLE_CLIENT_ID` in [`js/gcal.js`](js/gcal.js). The *Sync to Google Calendar* button appears once it is set.

## Season Rollover

Update `SEASON_KICKOFF` in [`js/app.js`](js/app.js) and [`supabase/functions/mcp/index.ts`](supabase/functions/mcp/index.ts) each year once kickoff is announced.

## Publishing & Admin Bootstrap

1. Push to `main`; GitHub Actions automatically publishes the updated site to GitHub Pages.
2. To grant the first user admin privileges, copy their Auth UUID in Supabase Dashboard and run:
   ```sql
   update public.profiles set is_approved = true, is_admin = true where id = 'YOUR-AUTH-USER-UUID';
   ```
