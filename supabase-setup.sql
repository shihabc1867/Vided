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
