# FRC NYX 11744 — Shared Inventory

A responsive shared tools/parts inventory website for Team NYX 11744. Members register with their real first and last name, email, and password. A team admin approves each new account. Approved members share the same live inventory from any device.

## Features

- Secure email/password authentication using Supabase Auth (the app does not store raw passwords).
- Required first and last name at registration; names are self-reported, not identity verification.
- Team admin can approve and revoke member access.
- Four subsystems: Mechanical, Electrical, Software, and Miscellaneous.
- Add, edit, delete, and adjust quantity for inventory items.
- Quantity, unit, storage location, notes, search, category filter, and low-stock indicators.
- Shared PostgreSQL database with row-level security and live refresh subscription.

## Set up the database

1. Create a project at https://supabase.com.
2. In the Supabase dashboard, open SQL Editor and run the complete file supabase/schema.sql.
3. In Project Settings / API, copy the project URL and the publishable key (or legacy anon key). Never use the service_role or any secret key in the website.

## Connect the website

1. Open index.html on GitHub and edit the two constants near the bottom of its script:
   - SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co"
   - SUPABASE_PUBLIC_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
2. Save/commit the changes.
3. Host the static site using GitHub Pages, Netlify, or Vercel. The entry point is index.html; no build step is required.
4. In Supabase Authentication URL Configuration, add the site's URL and local development URL (if used) to allowed redirect URLs. Configure email confirmation according to team needs.
5. The inventory is a single shared cloud database, not a per-browser list.

## Bootstrap the first admin

New accounts begin unapproved, so registration alone does not grant access.

1. Register your own account in the website and confirm your email if prompted.
2. In Supabase Dashboard, open Authentication / Users and copy your account UUID.
3. In SQL Editor, replace the placeholder with the real UUID and run:

    update public.profiles set is_approved=true, is_admin=true where id='YOUR-AUTH-USER-UUID';

4. Sign out and back in. The Team Access section appears for the admin, who can approve teammates after they register.

## Publishing notes

The repository is currently private. GitHub Pages on the Free plan generally requires a public repository; if you keep this repo private, use a host such as Netlify or Vercel instead, or adjust the repository/plan settings. Before sharing the deployed URL, ensure the Supabase database policies are installed and you have tested signed-out access is blocked.

A public Supabase publishable/anon key is expected in frontend code; row-level security protects inventory data. Do not put Supabase service_role or secret keys in the repository, website, build environment prefixed with VITE_, or screenshots. Use unique passwords, keep admin access limited to trusted team leads/coaches, and do not put sensitive student information in inventory notes.
