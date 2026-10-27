-- NYX 11744 shared inventory database.
-- Run this entire script in Supabase Dashboard -> SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  is_approved boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  category text not null check (category in ('Mechanical','Electrical','Software','Miscellaneous')),
  quantity integer not null default 0 check (quantity >= 0),
  unit text not null default 'pcs',
  location text not null default '',
  notes text not null default '',
  created_by uuid not null references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists inventory_items_category_idx on public.inventory_items(category);
create index if not exists inventory_items_name_idx on public.inventory_items(name);

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

alter table public.profiles enable row level security;
alter table public.inventory_items enable row level security;

drop policy if exists "Members read own profile; admins read all" on public.profiles;
create policy "Members read own profile; admins read all" on public.profiles
for select to authenticated using(id=(select auth.uid()) or (select public.is_team_admin()));

drop policy if exists "Admins update member approval" on public.profiles;
create policy "Admins update member approval" on public.profiles
for update to authenticated using((select public.is_team_admin()))
with check((select public.is_team_admin()));

drop policy if exists "Approved team can read inventory" on public.inventory_items;
create policy "Approved team can read inventory" on public.inventory_items
for select to authenticated using((select public.is_approved_member()));

drop policy if exists "Approved team can add inventory" on public.inventory_items;
create policy "Approved team can add inventory" on public.inventory_items
for insert to authenticated with check((select public.is_approved_member()) and created_by=(select auth.uid()));

drop policy if exists "Approved team can edit inventory" on public.inventory_items;
create policy "Approved team can edit inventory" on public.inventory_items
for update to authenticated using((select public.is_approved_member()))
with check((select public.is_approved_member()));

drop policy if exists "Approved team can delete inventory" on public.inventory_items;
create policy "Approved team can delete inventory" on public.inventory_items
for delete to authenticated using((select public.is_approved_member()));

-- Bootstrap only the first admin after registering in the app.
-- Find the account UUID in Supabase -> Authentication -> Users and replace the ID below:
-- update public.profiles set is_approved=true,is_admin=true where id='YOUR-AUTH-USER-UUID';

-- Enable inventory change events for the website's Supabase Realtime subscription.
-- Supabase normally creates the supabase_realtime publication for a project.
-- This block is safe to re-run and adds only inventory_items if it is not listed yet.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'inventory_items'
  ) then
    execute 'alter publication supabase_realtime add table public.inventory_items';
  end if;
end
$$;
