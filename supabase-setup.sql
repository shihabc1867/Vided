-- Vided accounts: run this ONCE in Supabase > SQL Editor > New query > Run.

-- 1) Each user's plan
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  plan text not null default 'free',
  plan_until timestamptz,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);
-- No insert/update policies on purpose: users can read their plan but never change it.

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) Pro codes (hand a code to a customer after they pay, e.g. by bKash)
create table if not exists public.codes (
  code text primary key,
  days int not null default 30,
  used_by uuid references auth.users,
  used_at timestamptz
);
alter table public.codes enable row level security;   -- no policies: only you (dashboard/service role) can see codes

create or replace function public.redeem_code(p_code text) returns json
language plpgsql security definer set search_path = public as $$
declare c public.codes%rowtype; p public.profiles%rowtype; new_until timestamptz;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  select * into c from public.codes where code = upper(trim(p_code)) for update;
  if not found then raise exception 'That code is not valid'; end if;
  if c.used_by is not null then raise exception 'That code was already used'; end if;
  insert into public.profiles (id, email) select id, email from auth.users where id = auth.uid() on conflict do nothing;
  select * into p from public.profiles where id = auth.uid();
  new_until := greatest(coalesce(p.plan_until, now()), now()) + make_interval(days => c.days);
  update public.codes set used_by = auth.uid(), used_at = now() where code = c.code;
  update public.profiles set plan = 'pro', plan_until = new_until where id = auth.uid();
  return json_build_object('plan', 'pro', 'plan_until', new_until);
end $$;
revoke all on function public.redeem_code(text) from public, anon;
grant execute on function public.redeem_code(text) to authenticated;

-- 3) Private cloud backups: each user can only touch the folder named after their own user id
insert into storage.buckets (id, name, public) values ('backups', 'backups', false) on conflict do nothing;
drop policy if exists "backups read" on storage.objects;
drop policy if exists "backups insert" on storage.objects;
drop policy if exists "backups update" on storage.objects;
drop policy if exists "backups delete" on storage.objects;
create policy "backups read"   on storage.objects for select to authenticated using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "backups insert" on storage.objects for insert to authenticated with check (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "backups update" on storage.objects for update to authenticated using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "backups delete" on storage.objects for delete to authenticated using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------
-- Handy snippets (run separately when needed):
--   Make 10 Pro codes valid for 30 days each:
--     insert into public.codes (code, days) select upper(substr(md5(random()::text), 1, 10)), 30 from generate_series(1, 10);
--     select code, days from public.codes where used_by is null;
--   Give someone Pro for a year by hand:
--     update public.profiles set plan = 'pro', plan_until = now() + interval '365 days' where email = 'user@example.com';

-- ===============================================================
-- 4) bKash / Nagad payments (re-run this whole file after updating; it is safe to run again)
alter table public.profiles add column if not exists is_admin boolean not null default false;

create table if not exists public.payment_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  email text,
  method text not null check (method in ('bkash', 'nagad')),
  trx_id text not null,
  sender text,
  days int not null default 30,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (method, trx_id)
);
alter table public.payment_requests enable row level security;
drop policy if exists "read own payments" on public.payment_requests;
drop policy if exists "admin reads payments" on public.payment_requests;
create policy "read own payments" on public.payment_requests for select to authenticated using (auth.uid() = user_id);
create policy "admin reads payments" on public.payment_requests for select to authenticated
  using (exists (select 1 from public.profiles where id = auth.uid() and is_admin));
-- No insert/update policies: everything goes through the functions below.

create or replace function public.submit_payment(p_method text, p_trx text, p_sender text) returns json
language plpgsql security definer set search_path = public as $$
declare t text := upper(trim(p_trx)); s text := regexp_replace(coalesce(p_sender, ''), '\s', '', 'g'); em text; n int;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if p_method not in ('bkash', 'nagad') then raise exception 'Choose bKash or Nagad'; end if;
  if t !~ '^[A-Z0-9]{6,20}$' then raise exception 'That Transaction ID does not look right'; end if;
  if s !~ '^01[0-9]{9}$' then raise exception 'Enter the 11-digit number you paid from'; end if;
  select count(*) into n from public.payment_requests where user_id = auth.uid() and status = 'pending';
  if n >= 3 then raise exception 'You already have pending payments. Please wait for approval.'; end if;
  if exists (select 1 from public.payment_requests where method = p_method and trx_id = t) then
    raise exception 'This Transaction ID was already submitted';
  end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.payment_requests (user_id, email, method, trx_id, sender) values (auth.uid(), em, p_method, t, s);
  return json_build_object('status', 'pending');
end $$;

create or replace function public.approve_payment(p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests%rowtype; p public.profiles%rowtype; new_until timestamptz;
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then raise exception 'Not allowed'; end if;
  select * into r from public.payment_requests where id = p_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if r.status <> 'pending' then raise exception 'Already decided'; end if;
  insert into public.profiles (id, email) select id, email from auth.users where id = r.user_id on conflict do nothing;
  select * into p from public.profiles where id = r.user_id;
  new_until := greatest(coalesce(p.plan_until, now()), now()) + make_interval(days => r.days);
  update public.profiles set plan = 'pro', plan_until = new_until where id = r.user_id;
  update public.payment_requests set status = 'approved', decided_at = now() where id = p_id;
  return json_build_object('plan_until', new_until);
end $$;

create or replace function public.reject_payment(p_id bigint) returns json
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then raise exception 'Not allowed'; end if;
  update public.payment_requests set status = 'rejected', decided_at = now() where id = p_id and status = 'pending';
  return json_build_object('ok', true);
end $$;

revoke all on function public.submit_payment(text, text, text), public.approve_payment(bigint), public.reject_payment(bigint) from public, anon;
grant execute on function public.submit_payment(text, text, text), public.approve_payment(bigint), public.reject_payment(bigint) to authenticated;

-- Make YOURSELF the admin (sign in to the app once first, then run with your email):
--   update public.profiles set is_admin = true where email = 'you@example.com';
