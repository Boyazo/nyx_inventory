-- NYX 11744 shared inventory database.
-- Run this entire script in Supabase Dashboard -> SQL Editor.
create extension if not exists pgcrypto;

-- 1. Profiles Table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  is_approved boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

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

-- Alter existing columns if table already existed prior to update
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
create index if not exists planner_tasks_due_date_idx on public.planner_tasks(due_date);

-- 6. Helper Functions & Triggers
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id,full_name)
  values(new.id,coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'),''),'Team Member'))
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

-- 7. Row Level Security Policies
alter table public.profiles enable row level security;
alter table public.inventory_items enable row level security;
alter table public.tool_checkouts enable row level security;
alter table public.activity_logs enable row level security;
alter table public.planner_tasks enable row level security;

-- Profiles policies
drop policy if exists "Members read own profile; admins read all" on public.profiles;
create policy "Members read own profile; admins read all" on public.profiles
for select to authenticated using(id=(select auth.uid()) or (select public.is_team_admin()));

drop policy if exists "Members can update their own display name" on public.profiles;
create policy "Members can update their own display name" on public.profiles
for update to authenticated using(id=(select auth.uid()))
with check(id=(select auth.uid()));

drop policy if exists "Admins update member approval" on public.profiles;
create policy "Admins update member approval" on public.profiles
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

-- Inventory items policies:
-- Approved team can READ inventory
drop policy if exists "Approved team can read inventory" on public.inventory_items;
create policy "Approved team can read inventory" on public.inventory_items
for select to authenticated using((select public.is_approved_member()));

-- ONLY ADMINS can ADD inventory items
drop policy if exists "Approved team can add inventory" on public.inventory_items;
drop policy if exists "Only admins can add inventory" on public.inventory_items;
create policy "Only admins can add inventory" on public.inventory_items
for insert to authenticated with check((select public.is_team_admin()));

-- ONLY ADMINS can EDIT inventory items
drop policy if exists "Approved team can edit inventory" on public.inventory_items;
drop policy if exists "Only admins can edit inventory" on public.inventory_items;
create policy "Only admins can edit inventory" on public.inventory_items
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

-- ONLY ADMINS can DELETE inventory items
drop policy if exists "Approved team can delete inventory" on public.inventory_items;
drop policy if exists "Only admins can delete inventory" on public.inventory_items;
create policy "Only admins can delete inventory" on public.inventory_items
for delete to authenticated using((select public.is_team_admin()));

-- Tool checkouts policies:
-- ANY APPROVED MEMBER can read, borrow (create checkout), and check in (return checkout)
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

-- Activity logs policies: ONLY ADMINS CAN READ, approved members can insert
drop policy if exists "Only admins can read activity logs" on public.activity_logs;
create policy "Only admins can read activity logs" on public.activity_logs
for select to authenticated using((select public.is_team_admin()));

drop policy if exists "Approved members can insert activity logs" on public.activity_logs;
create policy "Approved members can insert activity logs" on public.activity_logs
for insert to authenticated with check((select public.is_approved_member()));

-- Planner tasks policies:
-- Approved members can READ tasks
drop policy if exists "Approved members can read planner tasks" on public.planner_tasks;
create policy "Approved members can read planner tasks" on public.planner_tasks
for select to authenticated using((select public.is_approved_member()));

-- ONLY ADMINS can CREATE tasks
drop policy if exists "Approved members can create planner tasks" on public.planner_tasks;
drop policy if exists "Only admins can create planner tasks" on public.planner_tasks;
create policy "Only admins can create planner tasks" on public.planner_tasks
for insert to authenticated with check((select public.is_team_admin()));

-- APPROVED MEMBERS can UPDATE task status or assignment
drop policy if exists "Approved members can update planner tasks" on public.planner_tasks;
create policy "Approved members can update planner tasks" on public.planner_tasks
for update to authenticated using((select public.is_approved_member()))
with check((select public.is_approved_member()));

-- ONLY ADMINS can DELETE planner tasks
drop policy if exists "Approved members can delete planner tasks" on public.planner_tasks;
drop policy if exists "Only admins can delete planner tasks" on public.planner_tasks;
create policy "Only admins can delete planner tasks" on public.planner_tasks
for delete to authenticated using((select public.is_team_admin()));

-- 8. Realtime configuration
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
  end if;
end
$$;
