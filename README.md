# FRC NYX 11744 — Shared Inventory & Workspace Planner

A modern, responsive shared tools/parts inventory and collaborative team workspace planner for **Team NYX 11744** (San Diego, CA). Styled with the official [nyx11744.org](https://nyx11744.org/) visual identity and logo.

Members register with their real name, email, and password. A team admin approves each account. Approved members share live inventory, check out shop tools, and coordinate tasks on the build planner.

## Key Features

- **Official Nyx Brand & Logo**: Integrated high-resolution logo from `nyx11744.org`, Space Grotesk & JetBrains Mono typography, glowing midnight palette, and sleek dark components.
- **Collaborative Team Planner 📋**: A live 3-stage board (`To Do`, `In Progress`, `Completed`) where members can add milestones, assign subteams (Mechanical, Electrical, Software, CAD, Business), set priorities, and track build deliverables with real-time updates.
- **Tool & Equipment Checkouts**: Mark items as tools/equipment. Approved team members can check out tools with quantities and return notes; active checkouts display in real time with quick return actions.
- **Admin-Only Audit & Activity Logs**: Protected event logging table with Row Level Security (RLS). Every item creation, modification, deletion, checkout, return, planner update, and member status change is logged and only visible to team administrators.
- **Password Recovery Flow**: Integrated Supabase password reset modal allowing users returning from a recovery link to safely change their password.
- **Subsystem & Tool Filters**: Filter inventory by Mechanical, Electrical, Software, Miscellaneous, or Tools Only.
- **Part Numbers & Minimum Stock Thresholds**: Track vendor codes (REV, WCP, AndyMark) and custom low-stock alert thresholds.
- **Row-Level Security & Realtime Sync**: PostgreSQL tables protected by role-based RLS policies and live WebSocket subscriptions.

## Database Setup & Updates

1. In your **Supabase Dashboard**, open the **SQL Editor**.
2. Run the complete script in [`supabase/schema.sql`](file:///C:/Users/Raymond%20Liu/.gemini/antigravity/scratch/nyx_inventory/supabase/schema.sql).
   * It creates `planner_tasks`, `tool_checkouts`, and `activity_logs` tables.
   * It applies column migrations if your tables already exist.
   * It sets up strict Row-Level Security so **only team admins** can query activity logs, while allowing all approved members to contribute to the planner.
   * It registers Realtime publications for live team synchronization.

## Publishing & Admin Bootstrap

1. Commit and push to `main`; the GitHub Actions workflow at `.github/workflows/pages.yml` automatically publishes the updated site to GitHub Pages.
2. To grant the first user admin privileges, copy their Auth UUID in Supabase Dashboard and run:
   ```sql
   update public.profiles set is_approved = true, is_admin = true where id = 'YOUR-AUTH-USER-UUID';
   ```
3. Admins will see the **Member Access** approval panel and the **Audit Logs 🔒** tab.
