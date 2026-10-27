# FRC NYX 11744 — Shared Inventory & Tool Tracking

A modern, responsive shared tools/parts inventory and shop management website for **Team NYX 11744** (San Diego, CA). Styled to match the official [nyx11744.org](https://nyx11744.org/) brand identity.

Members register with their real name, email, and password. A team admin approves each account. Approved members share live inventory and can check out shop tools across any device.

## Key Features

- **Official Nyx Brand & Theme**: Deep midnight violet background, Space Grotesk & JetBrains Mono typography, glowing ambient lighting, and sleek UI components matching `nyx11744.org`.
- **Tool & Equipment Checkouts**: Mark items as tools/equipment. Approved team members can check out tools with quantities and return notes; active checkouts display in real time with quick return actions.
- **Admin-Only Audit & Activity Logs**: Protected event logging table with Row Level Security (RLS). Every item creation, modification, deletion, checkout, return, and member status change is logged and only visible to team administrators.
- **Password Recovery Flow**: Integrated Supabase password reset modal allowing users returning from a recovery link to safely change their password.
- **CSV Export**: One-click download of the entire inventory catalog for pit packing, BOM tracking, or offline competition backups.
- **Subsystem & Tool Filters**: Filter by Mechanical, Electrical, Software, Miscellaneous, or Tools Only.
- **Part Numbers & Minimum Stock Thresholds**: Track vendor codes (REV, WCP, AndyMark) and custom low-stock alert thresholds.
- **Row-Level Security & Realtime Sync**: PostgreSQL tables protected by role-based RLS policies and live WebSocket subscriptions.

## Database Setup & Updates

1. In your **Supabase Dashboard**, open the **SQL Editor**.
2. Run the complete script in [`supabase/schema.sql`](file:///C:/Users/Raymond%20Liu/.gemini/antigravity/scratch/nyx_inventory/supabase/schema.sql).
   * It safely adds the `tool_checkouts` and `activity_logs` tables.
   * It applies column migrations (`is_tool`, `part_number`, `min_quantity`) if your tables already exist.
   * It sets up strict Row-Level Security so **only team admins** can query activity logs.
   * It registers Realtime publications for live team synchronization.

## Publishing & Admin Bootstrap

1. Push the repository to `main`; the GitHub Actions workflow at `.github/workflows/pages.yml` automatically deploys the updated site to GitHub Pages.
2. To grant the first user admin privileges, copy their Auth UUID in Supabase Dashboard and run:
   ```sql
   update public.profiles set is_approved = true, is_admin = true where id = 'YOUR-AUTH-USER-UUID';
   ```
3. Admins will see the **Member Access** approval panel and the **Audit Logs 🔒** tab.
