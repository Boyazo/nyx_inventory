-- NYX 11744 Workspace Database — "Born in the dark, built to dominate"
-- Run this entire script in Supabase Dashboard -> SQL Editor.
create extension if not exists pgcrypto;

-- 1. Profiles Table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  departments text[] not null default array['Mechanical']::text[],
  is_approved boolean not null default false,
  is_admin boolean not null default false,
  is_secret boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists departments text[] not null default array['Mechanical']::text[];
alter table public.profiles add column if not exists is_secret boolean not null default false;

-- 2. Inventory Items Table
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  category text not null check (category in ('Mechanical','Electrical','Software','Miscellaneous')),
  quantity integer not null default 0 check (quantity >= 0),
  unit text not null default 'pcs',
  location text not null default '',
  notes text not null default '',
  is_tool boolean not null default false,
  part_number text not null default '',
  min_quantity integer not null default 1 check (min_quantity >= 0),
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_items add column if not exists is_tool boolean not null default false;
alter table public.inventory_items add column if not exists part_number text not null default '';
alter table public.inventory_items add column if not exists min_quantity integer not null default 1;

create index if not exists inventory_items_category_idx on public.inventory_items(category);
create index if not exists inventory_items_name_idx on public.inventory_items(name);
create index if not exists inventory_items_is_tool_idx on public.inventory_items(is_tool);

-- 3. Tool Checkouts Table
create table if not exists public.tool_checkouts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  user_name text not null,
  quantity integer not null default 1 check (quantity > 0),
  status text not null default 'checked_out' check (status in ('checked_out', 'returned')),
  checked_out_at timestamptz not null default now(),
  returned_at timestamptz,
  notes text not null default ''
);

create index if not exists tool_checkouts_item_idx on public.tool_checkouts(item_id);
create index if not exists tool_checkouts_user_idx on public.tool_checkouts(user_id);
create index if not exists tool_checkouts_status_idx on public.tool_checkouts(status);

-- 4. Activity & Audit Logs Table (Admin Only View)
create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  user_id uuid references auth.users(id),
  user_name text not null default 'Team Member',
  created_at timestamptz not null default now()
);

create index if not exists activity_logs_created_at_idx on public.activity_logs(created_at desc);
create index if not exists activity_logs_action_idx on public.activity_logs(action);

-- 5. Collaborative Team Planner Table
create table if not exists public.planner_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  subsystem text not null check (subsystem in ('General', 'Mechanical', 'Electrical', 'Software', 'Design / CAD', 'Business')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date date,
  assigned_to text not null default '',
  created_by uuid not null references auth.users(id),
  created_by_name text not null default 'Team Member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists planner_tasks_status_idx on public.planner_tasks(status);
create index if not exists planner_tasks_subsystem_idx on public.planner_tasks(subsystem);

-- 6. Parts Needed for Robot Table (View: Everyone, Edit: Admin Only)
create table if not exists public.parts_needed (
  id uuid primary key default gen_random_uuid(),
  part_name text not null check (length(trim(part_name)) > 0),
  subsystem text not null check (subsystem in ('Mechanical', 'Electrical', 'Software', 'Design / CAD', 'General')),
  quantity integer not null default 1 check (quantity > 0),
  vendor text not null default '',
  part_number text not null default '',
  url text not null default '',
  priority text not null default 'high' check (priority in ('urgent', 'high', 'medium', 'low')),
  status text not null default 'needed' check (status in ('needed', 'ordered', 'shipped', 'arrived')),
  estimated_cost numeric(10,2) not null default 0.00 check (estimated_cost >= 0),
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists parts_needed_status_idx on public.parts_needed(status);
create index if not exists parts_needed_priority_idx on public.parts_needed(priority);

-- 7. Spending & Budget Tracking Table (Admin Only)
create table if not exists public.spending_records (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  vendor text not null default 'Other',
  amount numeric(10,2) not null check (amount >= 0),
  category text not null check (category in ('Robot Hardware', 'Electronics & Control', 'Tools & Equipment', 'Raw Materials', 'Pit & Safety', 'Other')),
  order_date date not null default current_date,
  order_number text not null default '',
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_by_name text not null default 'Admin',
  created_at timestamptz not null default now()
);

create index if not exists spending_records_order_date_idx on public.spending_records(order_date desc);

-- 8. Department Shifts & Calendar Table (Admins Schedule/Delete, All Members RSVP)
create table if not exists public.team_shifts (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) > 0),
  department text not null check (department in ('Mechanical', 'Electrical', 'Software', 'Business', 'All Departments')),
  shift_date date not null,
  start_time text not null,
  end_time text not null,
  location text not null default 'Main Shop',
  attendees text[] not null default array[]::text[],
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_by_name text not null default 'Admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists team_shifts_date_idx on public.team_shifts(shift_date);
create index if not exists team_shifts_department_idx on public.team_shifts(department);

-- 9. Strategy Plays & Field Whiteboards
create table if not exists public.strategy_plays (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  game_year text not null default '2026',
  drawing_data text not null,
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_by_name text not null default 'Team Member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists strategy_plays_created_at_idx on public.strategy_plays(created_at desc);

-- 10. Match Scouting Logs (Live 2026 REBUILT Match Data)
create table if not exists public.match_scouting_logs (
  id text primary key,
  team_num integer not null,
  match_num integer not null,
  match_type text not null default 'qm',
  event_name text not null default '2026 Event',
  scout_name text not null default 'Scout',
  station text not null default 'R1',
  auto_fuel integer not null default 0,
  tele_fuel integer not null default 0,
  climb text not null default 'none',
  est_points integer not null default 0,
  notes text not null default '',
  raw_data jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists match_scouting_team_idx on public.match_scouting_logs(team_num);
create index if not exists match_scouting_match_idx on public.match_scouting_logs(match_num);
create index if not exists match_scouting_created_at_idx on public.match_scouting_logs(created_at desc);

-- 10. Helper Functions & Triggers
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id, full_name, departments)
  values(
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), 'Team Member'),
    array['Mechanical']::text[]
  )
  on conflict(id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_team_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(select 1 from public.profiles
    where id=(select auth.uid()) and is_approved=true and is_admin=true);
$$;

create or replace function public.is_approved_member()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(select 1 from public.profiles
    where id=(select auth.uid()) and is_approved=true);
$$;

create or replace function public.set_inventory_updated_at()
returns trigger language plpgsql set search_path = public
as $$
begin
  new.updated_at=now();
  new.updated_by=auth.uid();
  return new;
end;
$$;
drop trigger if exists inventory_items_updated_at on public.inventory_items;
create trigger inventory_items_updated_at before update on public.inventory_items
for each row execute procedure public.set_inventory_updated_at();

-- 10. Row Level Security Policies
alter table public.profiles enable row level security;
alter table public.inventory_items enable row level security;
alter table public.tool_checkouts enable row level security;
alter table public.activity_logs enable row level security;
alter table public.planner_tasks enable row level security;
alter table public.parts_needed enable row level security;
alter table public.spending_records enable row level security;
alter table public.team_shifts enable row level security;

-- Profiles policies: users can read profiles, and edit their OWN name & departments!
drop policy if exists "Members read own profile; admins read all" on public.profiles;
create policy "Members read own profile; admins read all" on public.profiles
for select to authenticated using(id=(select auth.uid()) or (select public.is_team_admin()));

drop policy if exists "Members can update their own display name" on public.profiles;
drop policy if exists "Members can update their own profile" on public.profiles;
create policy "Members can update their own profile" on public.profiles
for update to authenticated using(id=(select auth.uid()))
with check(id=(select auth.uid()));

drop policy if exists "Admins update member approval" on public.profiles;
create policy "Admins update member approval" on public.profiles
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

-- Inventory items policies (Only Admins add/edit/delete; approved members read)
drop policy if exists "Approved team can read inventory" on public.inventory_items;
create policy "Approved team can read inventory" on public.inventory_items
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved team can add inventory" on public.inventory_items;
drop policy if exists "Only admins can add inventory" on public.inventory_items;
create policy "Only admins can add inventory" on public.inventory_items
for insert to authenticated with check((select public.is_team_admin()));

drop policy if exists "Approved team can edit inventory" on public.inventory_items;
drop policy if exists "Only admins can edit inventory" on public.inventory_items;
create policy "Only admins can edit inventory" on public.inventory_items
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

drop policy if exists "Approved team can delete inventory" on public.inventory_items;
drop policy if exists "Only admins can delete inventory" on public.inventory_items;
create policy "Only admins can delete inventory" on public.inventory_items
for delete to authenticated using((select public.is_team_admin()));

-- Tool checkouts policies (Anyone approved can borrow and check in)
drop policy if exists "Approved members can read tool checkouts" on public.tool_checkouts;
create policy "Approved members can read tool checkouts" on public.tool_checkouts
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved members can create tool checkouts" on public.tool_checkouts;
create policy "Approved members can create tool checkouts" on public.tool_checkouts
for insert to authenticated with check((select public.is_approved_member()) and user_id=(select auth.uid()));

drop policy if exists "Approved members can update tool checkouts" on public.tool_checkouts;
create policy "Approved members can update tool checkouts" on public.tool_checkouts
for update to authenticated using((select public.is_approved_member()) and (user_id=(select auth.uid()) or (select public.is_team_admin())))
with check((select public.is_approved_member()));

-- Activity logs policies (Only admins read)
drop policy if exists "Only admins can read activity logs" on public.activity_logs;
create policy "Only admins can read activity logs" on public.activity_logs
for select to authenticated using((select public.is_team_admin()));

drop policy if exists "Approved members can insert activity logs" on public.activity_logs;
create policy "Approved members can insert activity logs" on public.activity_logs
for insert to authenticated with check((select public.is_approved_member()));

-- Planner tasks policies (Admins create/delete; approved members update status)
drop policy if exists "Approved members can read planner tasks" on public.planner_tasks;
create policy "Approved members can read planner tasks" on public.planner_tasks
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved members can create planner tasks" on public.planner_tasks;
drop policy if exists "Only admins can create planner tasks" on public.planner_tasks;
create policy "Only admins can create planner tasks" on public.planner_tasks
for insert to authenticated with check((select public.is_team_admin()));

drop policy if exists "Approved members can update planner tasks" on public.planner_tasks;
create policy "Approved members can update planner tasks" on public.planner_tasks
for update to authenticated using((select public.is_approved_member()))
with check((select public.is_approved_member()));

drop policy if exists "Approved members can delete planner tasks" on public.planner_tasks;
drop policy if exists "Only admins can delete planner tasks" on public.planner_tasks;
create policy "Only admins can delete planner tasks" on public.planner_tasks
for delete to authenticated using((select public.is_team_admin()));

-- Parts Needed for Robot (Everyone approved can view, only admins add/edit/delete)
drop policy if exists "Approved members can read parts needed" on public.parts_needed;
create policy "Approved members can read parts needed" on public.parts_needed
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Only admins can insert parts needed" on public.parts_needed;
create policy "Only admins can insert parts needed" on public.parts_needed
for insert to authenticated with check((select public.is_team_admin()));

drop policy if exists "Only admins can update parts needed" on public.parts_needed;
create policy "Only admins can update parts needed" on public.parts_needed
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

drop policy if exists "Only admins can delete parts needed" on public.parts_needed;
create policy "Only admins can delete parts needed" on public.parts_needed
for delete to authenticated using((select public.is_team_admin()));

-- Spending Records (ONLY ADMINS can read, insert, update, delete)
drop policy if exists "Only admins can read spending" on public.spending_records;
create policy "Only admins can read spending" on public.spending_records
for select to authenticated using((select public.is_team_admin()));

drop policy if exists "Only admins can insert spending" on public.spending_records;
create policy "Only admins can insert spending" on public.spending_records
for insert to authenticated with check((select public.is_team_admin()));

drop policy if exists "Only admins can update spending" on public.spending_records;
create policy "Only admins can update spending" on public.spending_records
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

drop policy if exists "Only admins can delete spending" on public.spending_records;
create policy "Only admins can delete spending" on public.spending_records
for delete to authenticated using((select public.is_team_admin()));

-- Team Shifts (Admins schedule and delete; Approved members view & RSVP / update roster)
drop policy if exists "Approved members can read team shifts" on public.team_shifts;
create policy "Approved members can read team shifts" on public.team_shifts
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved members can insert team shifts" on public.team_shifts;
drop policy if exists "Only admins can insert team shifts" on public.team_shifts;
create policy "Only admins can insert team shifts" on public.team_shifts
for insert to authenticated with check((select public.is_team_admin()));

drop policy if exists "Approved members can update team shifts" on public.team_shifts;
create policy "Approved members can update team shifts" on public.team_shifts
for update to authenticated using((select public.is_approved_member()))
with check((select public.is_approved_member()));

drop policy if exists "Approved members can delete team shifts" on public.team_shifts;
drop policy if exists "Only admins can delete team shifts" on public.team_shifts;
create policy "Only admins can delete team shifts" on public.team_shifts
for delete to authenticated using((select public.is_team_admin()));

-- Strategy Plays Policies
drop policy if exists "Approved members can read strategy plays" on public.strategy_plays;
create policy "Approved members can read strategy plays" on public.strategy_plays
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved members can insert strategy plays" on public.strategy_plays;
create policy "Approved members can insert strategy plays" on public.strategy_plays
for insert to authenticated with check((select public.is_approved_member()));

drop policy if exists "Approved members can update strategy plays" on public.strategy_plays;
create policy "Approved members can update strategy plays" on public.strategy_plays
for update to authenticated using((select public.is_approved_member()))
with check((select public.is_approved_member()));

drop policy if exists "Approved members can delete strategy plays" on public.strategy_plays;
create policy "Approved members can delete strategy plays" on public.strategy_plays
for delete to authenticated using((select public.is_team_admin()) or created_by = auth.uid());

-- Scouting policies
alter table public.match_scouting_logs enable row level security;
drop policy if exists "Anyone can read scouting records" on public.match_scouting_logs;
create policy "Anyone can read scouting records" on public.match_scouting_logs
for select to authenticated using(true);

drop policy if exists "Approved members can insert scouting records" on public.match_scouting_logs;
create policy "Approved members can insert scouting records" on public.match_scouting_logs
for insert to authenticated with check((select public.is_approved_member()));

drop policy if exists "Admins or authors can delete scouting records" on public.match_scouting_logs;
create policy "Admins or authors can delete scouting records" on public.match_scouting_logs
for delete to authenticated using((select public.is_team_admin()));

-- 11. Secret Personnel Intel (Secret Admin Role Only)
create table if not exists public.secret_personnel_intel (
  id text primary key,
  team_num integer not null,
  team_name text not null default '',
  person_name text not null check (length(trim(person_name)) > 0),
  person_role text not null default '',
  intel_notes text not null default '',
  logged_by uuid references auth.users(id),
  logged_by_name text not null default 'Secret Agent',
  created_at timestamptz not null default now()
);

create or replace function public.is_secret_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and is_approved = true
      and is_admin = true
      and is_secret = true
  );
$$;

alter table public.secret_personnel_intel enable row level security;

drop policy if exists "Secret admins can select secret intel" on public.secret_personnel_intel;
create policy "Secret admins can select secret intel" on public.secret_personnel_intel
for select to authenticated using((select public.is_secret_admin()));

drop policy if exists "Secret admins can insert secret intel" on public.secret_personnel_intel;
create policy "Secret admins can insert secret intel" on public.secret_personnel_intel
for insert to authenticated with check((select public.is_secret_admin()));

drop policy if exists "Secret admins can delete secret intel" on public.secret_personnel_intel;
create policy "Secret admins can delete secret intel" on public.secret_personnel_intel
for delete to authenticated using((select public.is_secret_admin()));

-- 12. Realtime configuration
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inventory_items') then
      execute 'alter publication supabase_realtime add table public.inventory_items';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tool_checkouts') then
      execute 'alter publication supabase_realtime add table public.tool_checkouts';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_logs') then
      execute 'alter publication supabase_realtime add table public.activity_logs';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'planner_tasks') then
      execute 'alter publication supabase_realtime add table public.planner_tasks';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'parts_needed') then
      execute 'alter publication supabase_realtime add table public.parts_needed';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'spending_records') then
      execute 'alter publication supabase_realtime add table public.spending_records';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'team_shifts') then
      execute 'alter publication supabase_realtime add table public.team_shifts';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'strategy_plays') then
      execute 'alter publication supabase_realtime add table public.strategy_plays';
    end if;
  end if;
end
$$;
