# FRC NYX 11744 — Shared Inventory

A responsive shared tools/parts inventory website for Team NYX 11744. Members register with their real first and last name, email, and password. A team admin approves each new account. Approved members share the same inventory from any device.

## Features

- Secure email/password authentication using Supabase Auth (the app does not store raw passwords).
- Required first and last name at registration; names are self-reported, not identity verification.
- Team admin can approve and revoke member access.
- Four subsystems: Mechanical, Electrical, Software, and Miscellaneous.
- Add, edit, delete, and adjust quantity for inventory items.
- Quantity, unit, storage location, notes, search, category filter, and low-stock indicators.
- Shared PostgreSQL database with row-level security and live refresh subscription.

## 1. Set up the shared database

1. Create a project at https://supabase.com.
2. In the Supabase dashboard, open **SQL Editor** and run the complete file `supabase/schema.sql`.
3. In Project Settings / API, copy the project URL and the publishable key (or legacy anon key). Never use the `service_role` key or any secret key in the website.

## 2. Connect the website to Supabase

1. Open `index.html` on GitHub and edit the two constants near the bottom of its script:
   - `SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"`
   - `SUPABASE_PUBLIC_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY"`
2. Replace the placeholders with your project's URL and public/publishable key, then save the change.
3. These two values are for browser use. **Never put a Supabase service_role or secret key into the website or repository.**
4. The inventory is a single shared cloud database, not a per-browser list.

## 3. Publish with GitHub Pages

A GitHub Actions workflow has been added at `.github/workflows/pages.yml`. It publishes the static website automatically when `index.html` changes on `main`.

1. Open this repository's **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source, if the setting is available.
3. Push/commit the website changes to `main`; check the **Actions** tab to follow deployment.
4. When the first deployment completes, the Pages address appears in **Settings → Pages** and in the deployment workflow summary.
5. In Supabase Authentication → URL Configuration, add the published site's URL to allowed redirect URLs. Configure email confirmation to suit team needs.
6. In Supabase → Database → Publications, confirm `public.inventory_items` is enabled under `supabase_realtime`. The updated SQL attempts to add it automatically when you run the schema.

## 3A. Confirm team sync works

1. Open the published Pages URL in two separate browsers or devices.
2. Create a member account in each browser. Confirm the email if Supabase requests it.
3. Promote the first trusted account to admin using the SQL below, then sign out and back in.
4. Use the admin's Team Access panel to approve the second account.
5. Sign in on both devices. Add a harmless test item from one and verify it appears on the other. Change its quantity and verify the edit is reflected on both.
6. If other members don't see updates immediately, refresh once to confirm the common database is working, then check the Realtime publication and the browser's error message.

**How the sync works:** each signed-in browser connects to the same Supabase project URL and public/publishable key. Inventory records live in that one shared PostgreSQL database; they do not live inside each person's browser. Supabase Realtime notifies the other open browsers when `inventory_items` changes. Each user needs their own login; never share passwords.

### Repository visibility and cost

This repository is currently **private**. GitHub Pages is available for **public repositories on GitHub Free**; publishing Pages from a private repository requires a plan that supports it, such as GitHub Pro. GitHub Pages sites are publicly accessible by default, including sites built from private repositories when the plan allows private-source Pages. Do not publish until you are comfortable with the site being public. I have not changed the repository visibility.

## 4. Bootstrap the first admin

New accounts begin unapproved, so registration alone does not grant inventory access.

1. Register your own account through the website and confirm your email if prompted.
2. In Supabase Dashboard, open Authentication / Users and copy your account UUID.
3. In SQL Editor, replace the placeholder below with the real UUID and run:

    update public.profiles set is_approved=true, is_admin=true where id='YOUR-AUTH-USER-UUID';

4. Sign out and back in. The Team Access section appears for the admin, who can approve teammates after they register.

## Security notes

A public Supabase publishable/anon key is expected in frontend code; row-level security protects inventory data. Do not put Supabase service_role or secret keys in the repository, website, build environment, or screenshots. Use unique passwords, keep admin access limited to trusted team leads/coaches, and do not put sensitive student information in inventory notes. The real-name field collects a self-reported name and does not independently verify identity.

## GitHub Pages limitations

GitHub Pages hosts the frontend only; it does not run a server-side database or authentication backend. Supabase is still needed for secure logins and a shared inventory that synchronizes across users.
