-- =========================================================
-- Facility Reservation System - Supabase Database Setup
-- Run this entire script in Supabase SQL Editor.
-- =========================================================

create extension if not exists pgcrypto;

-- 1. Profiles / users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null,
  role text not null default 'Requester'
    check (role in ('Administrator','Facility Staff','Requester')),
  status text not null default 'Active'
    check (status in ('Active','Inactive')),
  created_at timestamptz not null default now()
);

-- 2. Facilities
create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  facility_name text not null,
  location text not null,
  status text not null default 'Active'
    check (status in ('Active','Maintenance','Inactive')),
  condition text not null default 'Good',
  created_at timestamptz not null default now()
);

-- 3. Reservations
create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete restrict,
  facility_id uuid not null references public.facilities(id) on delete restrict,
  start_time timestamptz not null,
  end_time timestamptz not null,
  purpose text not null,
  status text not null default 'Pending'
    check (status in ('Pending','Approved','Rejected','Scheduled','In Use','Completed','Cancelled')),
  created_at timestamptz not null default now(),
  constraint reservation_time_valid check (start_time < end_time)
);

-- 4. Service requests
create table if not exists public.service_requests (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  staff_id uuid references public.profiles(id) on delete set null,
  concern text not null,
  status text not null default 'Open'
    check (status in ('Open','In Progress','Completed','Cancelled')),
  created_at timestamptz not null default now()
);

-- 5. Audit logs
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  reservation_id uuid references public.reservations(id) on delete set null,
  action text not null,
  old_status text,
  new_status text,
  created_at timestamptz not null default now()
);

-- Helpful indexes
create index if not exists reservations_facility_time_idx
  on public.reservations(facility_id, start_time, end_time);

create index if not exists reservations_requester_idx
  on public.reservations(requester_id);

create index if not exists audit_logs_created_idx
  on public.audit_logs(created_at desc);

-- =========================================================
-- Helper functions
-- =========================================================

create or replace function public.current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Create a profile automatically after Supabase Auth signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'New User'),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- =========================================================
-- Audit trigger
-- =========================================================

create or replace function public.log_reservation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_logs(user_id,reservation_id,action,old_status,new_status)
    values (auth.uid(), new.id, 'Reservation Submitted', null, new.status);
  elsif tg_op = 'UPDATE' then
    if old.status is distinct from new.status then
      insert into public.audit_logs(user_id,reservation_id,action,old_status,new_status)
      values (auth.uid(), new.id, 'Status Changed', old.status, new.status);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists reservation_audit_trigger on public.reservations;
create trigger reservation_audit_trigger
after insert or update on public.reservations
for each row execute procedure public.log_reservation_change();

-- =========================================================
-- Reservation functions
-- =========================================================

create or replace function public.submit_reservation(
  p_facility_id uuid,
  p_start_time timestamptz,
  p_end_time timestamptz,
  p_purpose text
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.reservations;
  facility_status text;
begin
  if auth.uid() is null then
    raise exception 'You must be logged in.';
  end if;

  if p_start_time >= p_end_time then
    raise exception 'Reservation start must precede end time.';
  end if;

  select status into facility_status
  from public.facilities
  where id = p_facility_id;

  if facility_status is null then
    raise exception 'Facility not found.';
  end if;

  if facility_status <> 'Active' then
    raise exception 'Only active facilities may be reserved.';
  end if;

  if exists (
    select 1
    from public.reservations r
    where r.facility_id = p_facility_id
      and r.status in ('Approved','Scheduled','In Use')
      and p_start_time < r.end_time
      and p_end_time > r.start_time
  ) then
    raise exception 'Conflict detected: the facility is already reserved during that time.';
  end if;

  insert into public.reservations(requester_id,facility_id,start_time,end_time,purpose,status)
  values(auth.uid(),p_facility_id,p_start_time,p_end_time,p_purpose,'Pending')
  returning * into result;

  return result;
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.reservations;
begin
  update public.reservations
  set status='Cancelled'
  where id=p_reservation_id
    and requester_id=auth.uid()
    and status='Pending'
  returning * into result;

  if result.id is null then
    raise exception 'You can only cancel your own Pending reservation.';
  end if;

  insert into public.audit_logs(user_id,reservation_id,action,old_status,new_status)
  values(auth.uid(), result.id, 'Reservation Cancelled', 'Pending', 'Cancelled');

  return result;
end;
$$;

create or replace function public.admin_set_reservation_status(
  p_reservation_id uuid,
  p_new_status text
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.reservations;
  old text;
begin
  if public.current_role() <> 'Administrator' then
    raise exception 'Administrator access required.';
  end if;

  if p_new_status not in ('Approved','Rejected') then
    raise exception 'Administrator can only approve or reject a Pending request.';
  end if;

  select status into old from public.reservations where id=p_reservation_id for update;

  if old <> 'Pending' then
    raise exception 'Only Pending reservations can be approved or rejected.';
  end if;

  if p_new_status='Approved' and exists (
    select 1 from public.reservations r
    where r.id <> p_reservation_id
      and r.facility_id=(select facility_id from public.reservations where id=p_reservation_id)
      and r.status in ('Approved','Scheduled','In Use')
      and (select start_time from public.reservations where id=p_reservation_id) < r.end_time
      and (select end_time from public.reservations where id=p_reservation_id) > r.start_time
  ) then
    raise exception 'Conflict detected: another approved schedule uses this time slot.';
  end if;

  update public.reservations
  set status=p_new_status
  where id=p_reservation_id
  returning * into result;

  insert into public.audit_logs(user_id,reservation_id,action,old_status,new_status)
  values(auth.uid(), result.id,
    case when p_new_status='Approved' then 'Reservation Approved' else 'Reservation Rejected' end,
    old,p_new_status);

  return result;
end;
$$;

create or replace function public.staff_set_reservation_status(
  p_reservation_id uuid,
  p_new_status text
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.reservations;
  old text;
begin
  if public.current_role() <> 'Facility Staff' then
    raise exception 'Facility Staff access required.';
  end if;

  if p_new_status not in ('In Use','Completed') then
    raise exception 'Invalid staff status.';
  end if;

  select status into old from public.reservations where id=p_reservation_id for update;

  if p_new_status='In Use' and old not in ('Approved','Scheduled') then
    raise exception 'Only Approved or Scheduled reservations can become In Use.';
  end if;

  if p_new_status='Completed' and old <> 'In Use' then
    raise exception 'Only In Use reservations can become Completed.';
  end if;

  update public.reservations
  set status=p_new_status
  where id=p_reservation_id
  returning * into result;

  insert into public.audit_logs(user_id,reservation_id,action,old_status,new_status)
  values(auth.uid(), result.id, 'Staff Status Change', old,p_new_status);

  return result;
end;
$$;

-- =========================================================
-- Row Level Security
-- =========================================================

alter table public.profiles enable row level security;
alter table public.facilities enable row level security;
alter table public.reservations enable row level security;
alter table public.service_requests enable row level security;
alter table public.audit_logs enable row level security;

-- Profiles
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
for select to authenticated
using (id = auth.uid() or public.current_role() = 'Administrator');

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
for update to authenticated
using (public.current_role() = 'Administrator')
with check (public.current_role() = 'Administrator');

-- Facilities
drop policy if exists facilities_read_authenticated on public.facilities;
create policy facilities_read_authenticated on public.facilities
for select to authenticated using (true);

drop policy if exists facilities_admin_insert on public.facilities;
create policy facilities_admin_insert on public.facilities
for insert to authenticated
with check (public.current_role() = 'Administrator');

drop policy if exists facilities_admin_update on public.facilities;
create policy facilities_admin_update on public.facilities
for update to authenticated
using (public.current_role() = 'Administrator')
with check (public.current_role() = 'Administrator');

-- Reservations
drop policy if exists reservations_read on public.reservations;
create policy reservations_read on public.reservations
for select to authenticated
using (requester_id = auth.uid() or public.current_role() in ('Administrator','Facility Staff'));

-- Inserts are performed through submit_reservation RPC.
drop policy if exists reservations_insert_none on public.reservations;
create policy reservations_insert_none on public.reservations
for insert to authenticated
with check (false);

-- Updates are performed through controlled RPC functions.
drop policy if exists reservations_update_none on public.reservations;
create policy reservations_update_none on public.reservations
for update to authenticated
using (false);

-- Audit logs: administrators only
drop policy if exists audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs
for select to authenticated
using (public.current_role() = 'Administrator');

-- Service requests
drop policy if exists service_requests_staff_read on public.service_requests;
create policy service_requests_staff_read on public.service_requests
for select to authenticated
using (public.current_role() in ('Administrator','Facility Staff'));

drop policy if exists service_requests_staff_insert on public.service_requests;
create policy service_requests_staff_insert on public.service_requests
for insert to authenticated
with check (public.current_role() = 'Facility Staff');

-- =========================================================
-- Sample facilities
-- =========================================================
insert into public.facilities(facility_name,location,status,condition)
select 'Computer Laboratory','Main Building - Room 101','Active','Good'
where not exists (select 1 from public.facilities where facility_name='Computer Laboratory');

insert into public.facilities(facility_name,location,status,condition)
select 'Conference Room','Administration Building','Active','Good'
where not exists (select 1 from public.facilities where facility_name='Conference Room');

insert into public.facilities(facility_name,location,status,condition)
select 'Audio Visual Room','Main Building - Room 203','Maintenance','Under Maintenance'
where not exists (select 1 from public.facilities where facility_name='Audio Visual Room');

-- =========================================================
-- AFTER YOU CREATE YOUR ADMIN ACCOUNT:
-- Replace the email below with your actual account email,
-- then run:
--
-- update public.profiles
-- set role='Administrator'
-- where email='YOUR_ADMIN_EMAIL@example.com';
--
-- To make a staff account:
-- update public.profiles
-- set role='Facility Staff'
-- where email='YOUR_STAFF_EMAIL@example.com';
-- =========================================================
