# Nyx Dashboard — FRC Team 11744

A modern, responsive shared tools/parts inventory, robot parts ordering tracker, team planner, and budget management system for **Team NYX 11744** (San Diego, CA). Styled with the official [nyx11744.org](https://nyx11744.org/) visual identity and logo.

## Key Features

- **Clean Light & Dark Mode**: A flat, low-distraction layout (light by default) with a sidebar menu, stock status at a glance, and a Light/Dark switch in the top bar.
- **Searchable Part Picker**: The item name field in *Add Item* and *Parts Needed* searches everything we already have (with stock and location), the team's quick-fill presets, and all ~570 COTS parts from the [FRCDesign library](https://app.frcdesign.org/app/library/frc-design-lib) with their vendors. Picking an item we already stock offers to update it instead of adding a duplicate. Refresh the COTS list with `python3 tools/update_cots_catalog.py`.
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
- **Competition Sign-ups**: a separate page where members mark the roles they want (★ Want / ✓ Can) per time block — pit crew, match & pit scouting, drive team, strategy, safety, spirit, media. Admins assign from one grid (capacity, who wants what, conflicts, auto-fill by preference and load, by-person view) and edit roles and blocks under Setup.
- **Shift Calendar (Google Calendar style)**: Day, 3-day, Week, Month and Schedule views with Today / ‹ › navigation, a mini month, and department checkboxes. Admins drag shifts to move them (between days too), drag the bottom edge to change the end time, and drag across empty time to create a shift; everyone clicks a shift to see details and join or leave. Shortcuts: T, D, X, W, M, A, J/K, C.
- **Member Roles**: admins toggle Admin / Moderator / Strategy / Secret for each member on the Members tab (you can't remove your own admin role). **Moderators** do the day-to-day admin work — inventory, parts needed, shifts and assignments, planner tasks, scouting events/assignments/primary pick list, competition sign-ups, returning tools — while **admins** alone manage members and roles, spending, the audit log and analytics. The database enforces this (`is_team_staff()` vs `is_team_admin()`).
- **Analytics (admins)**: active time per feature (idle and hidden tabs excluded), shop hours from member check-ins (12h cap per visit), scheduled shift hours, daily activity, who is at the shop now, and a sortable per-member table of checkouts, inventory edits, tasks done, scouting and all actions.
- **Shop check-in**: a button in the top bar for members to check in and out of the shop.
- **Shift Assignments & Discord Reminders 🔔**: Admins assign members to shifts (one-click "whole department", applies to every week of a weekly series). A Discord bot posts a morning schedule, a heads-up ~2 hours before each shift, and a ping when someone is newly scheduled, @mentioning members who added their Discord User ID in their profile.
- **Scouting Hub (modelled on 4414 HighTide's workflow)** — *Strategy & Scouting → Scouting*:
  - **Event:** an admin imports the event's teams and qualification schedule from The Blue Alliance (TBA read key stays in that admin's browser) or enters team numbers by hand; one event is marked active for everyone.
  - **Match:** scouts step to a match, see its six robots and claim one — the database allows only one scout per robot per match. Phone-first form with stepper counters, 1–10 driver/defense ratings and quick tags.
  - **Assign (admins only):** a match × robot grid to choose who scouts each robot, a range tool ("Priya on Red 2 for Q1–Q15"), and auto-rotate (six scouts on duty per shift, rotating through everyone selected). Assigned scouts get their robot pre-filled and a "Next: Q12 · 254" shortcut.
  - **Pit:** a grid of every team showing scouted / not scouted, with a quick capabilities checklist.
  - **Teams:** each team's pit answers, every match report and averages (fuel, accuracy, climb, driver/defense, tags).
  - **Pick lists:** every scout keeps their own tiered pick lists (Tier 1–3, Do Not Pick, Uncategorized; drag to sort). Admins merge everyone's latest list into the team's primary list with a consensus score per team.
- **Scouting-driven Strategy via Claude 🧠**: Through the connector, Claude can pull aggregated team scouting reports (accuracy, climbs, reliability, recent form) with live Statbotics EPA, rank teams for pick lists, build a match brief for any alliance vs. opponents, log entries from photos of paper scouting sheets, and save its written plan to the playbook (*Strategy → Saved Plays → 📋 Strategy notes*).
- **Spending Seasons & Audit Trail**: Purchases before kickoff (`SEASON_KICKOFF`, currently Jan 9, 2027) are offseason; on/after are in-season. Every purchase requires a receipt/card-charge screenshot, and admin edits require a reason and are kept as a version history.

## Database Setup & Updates

1. In your **Supabase Dashboard**, open the **SQL Editor**.
2. Run the complete script in [`supabase/schema.sql`](file:///C:/Users/Raymond%20Liu/.gemini/antigravity/scratch/nyx_inventory/supabase/schema.sql).
   * It creates `parts_needed` and `spending_records` tables with full RLS policies.
   * It ensures only admins can write to inventory, tasks, parts needed, and spending records.
   * It registers Realtime publications for live team synchronization.

## Custom Domain (dashboard.nyx11744.org)

1. **Porkbun → nyx11744.org → DNS:** add a record — Type `CNAME`, Host `dashboard`, Answer `boyazo.github.io`, TTL `600`.
2. **GitHub (repo admin) → Settings → Pages → Custom domain:** enter `dashboard.nyx11744.org`, Save, wait for the DNS check, then tick **Enforce HTTPS**. (This site deploys with GitHub Actions, so the domain is set here rather than with a `CNAME` file.)
3. **Supabase → Authentication → URL Configuration:** Site URL `https://dashboard.nyx11744.org`; add `https://dashboard.nyx11744.org/**` to Redirect URLs (keep the github.io one until everyone has switched).
4. **Google Cloud → Clients → your web client:** add `https://dashboard.nyx11744.org` to Authorized JavaScript origins.

The old `boyazo.github.io/nyx_inventory` address redirects to the new domain automatically.

## One-command Supabase Setup

Someone with access to the Supabase project (or invited to its organization) runs, from the repo root:

```bash
brew install supabase/tap/supabase && supabase login && bash tools/setup_supabase.sh
```

It applies `schema.sql`, deploys the Claude connector and Discord bot functions, asks for the Discord webhook (and optional bot token for nickname auto-linking) without echoing them, generates the cron secret, starts the 15-minute reminder schedule and posts a test message. The sections below describe the same steps manually.

## Claude Connector (MCP) Setup

1. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project: `supabase link --project-ref wdzrttyxcedkaifzkjvp`.
2. Deploy the server: `supabase functions deploy mcp --no-verify-jwt` (Claude authenticates with each member's connector key, not a Supabase JWT).
3. In the app, click **🤖 Connect Claude → Generate Connector**, then add the URL in Claude under *Settings → Connectors → Add custom connector*.

## Discord Shift Bot Setup

1. Re-run [`supabase/schema.sql`](supabase/schema.sql) (adds `profiles.discord_id` and `shift_notifications`).
2. In Discord, open the channel for reminders → **Edit Channel → Integrations → Webhooks → New Webhook**, name it "NYX Shift Bot", and **Copy Webhook URL**.
3. Set the function secrets and deploy:
   ```bash
   supabase secrets set DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." CRON_SECRET="$(openssl rand -hex 24)"
   supabase functions deploy discord-reminders --no-verify-jwt
   ```
   Optional secrets: `DIGEST_HOUR` (default `7`, Pacific), `REMINDER_LEAD_MINUTES` (default `120`).
4. Open [`supabase/discord_reminders.sql`](supabase/discord_reminders.sql), paste the same `CRON_SECRET`, and run it in the SQL Editor. The bot then checks every 15 minutes.
5. **Auto-link members by nickname (recommended):** in the [Discord Developer Portal](https://discord.com/developers/applications) create an application → **Bot** → turn on **Server Members Intent** → **Reset Token**. Invite it with OAuth2 → URL Generator → scope `bot` (no permissions needed). Then:
   ```bash
   supabase secrets set DISCORD_BOT_TOKEN="..." DISCORD_GUILD_ID="your-server-id"
   ```
   Every 15 minutes, members without a Discord ID are matched to the server member whose nickname is their full name, else their unique first name, else first name + last initial when first names repeat (e.g. "Raymond L"). Ambiguous names are skipped.
6. Members can also paste their **Discord User ID** under *Edit Departments*; a manually entered ID always wins. Members with no ID are listed by name instead of pinged.

The first run records the existing rosters quietly, so only *new* assignments are announced.

## Google Calendar Setup

1. In Google Cloud Console, enable the **Google Calendar API** and create an OAuth client of type *Web application*.
2. Add the site origin (`https://dashboard.nyx11744.org`, plus `https://boyazo.github.io` while the old address is still used) under *Authorized JavaScript origins*, and configure the OAuth consent screen with the `calendar.events` scope.
3. Paste the client id into `GOOGLE_CLIENT_ID` in [`js/gcal.js`](js/gcal.js). The *Sync to Google Calendar* button appears once it is set.

## Season Rollover

Update `SEASON_KICKOFF` in [`js/app.js`](js/app.js) and [`supabase/functions/mcp/index.ts`](supabase/functions/mcp/index.ts) each year once kickoff is announced.

## Publishing & Admin Bootstrap

1. Push to `main`; GitHub Actions automatically publishes the updated site to GitHub Pages.
2. To grant the first user admin privileges, copy their Auth UUID in Supabase Dashboard and run:
   ```sql
   update public.profiles set is_approved = true, is_admin = true where id = 'YOUR-AUTH-USER-UUID';
   ```
