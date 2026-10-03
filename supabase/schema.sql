create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  ring_id text not null unique,
  ring_no text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.rings (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 50),
  default_topic text not null check (char_length(trim(default_topic)) between 1 and 120),
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.ring_members (
  ring_id uuid not null references public.rings (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ring_id, user_id)
);

create table if not exists public.ring_events (
  id uuid primary key default gen_random_uuid(),
  ring_id uuid not null references public.rings (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  topic text not null check (char_length(trim(topic)) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'ended')),
  created_at timestamptz not null default now()
);

create table if not exists public.ring_responses (
  event_id uuid not null references public.ring_events (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  response text not null check (response in ('yes', 'no')),
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

create index if not exists ring_members_user_id_idx on public.ring_members (user_id);
create index if not exists ring_events_ring_created_idx on public.ring_events (ring_id, created_at desc);
create index if not exists ring_responses_user_id_idx on public.ring_responses (user_id);

update public.profiles
set ring_no = 'R-' || upper(replace(id::text, '-', ''))
where ring_no is distinct from ('R-' || upper(replace(id::text, '-', '')));

revoke all on table public.profiles, public.rings, public.ring_members, public.ring_events, public.ring_responses from anon;
grant select on table public.profiles to authenticated;
grant select, insert, update, delete on table public.rings to authenticated;
grant select, insert, update, delete on table public.ring_members to authenticated;
grant select, insert, update, delete on table public.ring_events to authenticated;
grant select, insert, update, delete on table public.ring_responses to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_ring_id text;
begin
  requested_ring_id := lower(trim(coalesce(new.raw_user_meta_data ->> 'ring_id', '')));
  if requested_ring_id = '' then
    requested_ring_id := '@member_' || left(new.id::text, 8);
  elsif left(requested_ring_id, 1) <> '@' then
    requested_ring_id := '@' || requested_ring_id;
  end if;
  insert into public.profiles (id, ring_id, ring_no)
  values (new.id, requested_ring_id, 'R-' || upper(replace(new.id::text, '-', '')));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_ring_member(p_ring_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ring_members
    where ring_id = p_ring_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_ring_creator(p_ring_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.rings
    where id = p_ring_id and created_by = auth.uid()
  );
$$;

create or replace function public.is_active_ring_event(p_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.ring_events
    where id = p_event_id and status = 'active' and public.is_ring_member(ring_id)
  );
$$;

create or replace function public.add_ring_member(p_ring_id uuid, p_identifier text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  target_ring_id text;
  identifier text := lower(trim(p_identifier));
begin
  if auth.uid() is null or not (public.is_ring_member(p_ring_id) or public.is_ring_creator(p_ring_id)) then
    raise exception 'You must be a member of this Ring to invite someone.' using errcode = '42501';
  end if;
  select id, ring_id into target_user_id, target_ring_id
  from public.profiles
  where lower(ring_id) = identifier or lower(ring_no) = identifier
  limit 1;
  if target_user_id is null then
    raise exception 'No account found for that Ring ID or Ring No.' using errcode = 'P0002';
  end if;
  insert into public.ring_members (ring_id, user_id)
  values (p_ring_id, target_user_id)
  on conflict (ring_id, user_id) do nothing;
  return target_ring_id;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.is_ring_member(uuid) from public, anon;
revoke all on function public.is_ring_creator(uuid) from public, anon;
revoke all on function public.is_active_ring_event(uuid) from public, anon;
revoke all on function public.add_ring_member(uuid, text) from public, anon;
grant execute on function public.is_ring_member(uuid) to authenticated;
grant execute on function public.is_ring_creator(uuid) to authenticated;
grant execute on function public.is_active_ring_event(uuid) to authenticated;
grant execute on function public.add_ring_member(uuid, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.rings enable row level security;
alter table public.ring_members enable row level security;
alter table public.ring_events enable row level security;
alter table public.ring_responses enable row level security;

drop policy if exists "Profiles visible to self and Ring members" on public.profiles;
create policy "Profiles visible to self and Ring members" on public.profiles
  for select to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.ring_members mine
      join public.ring_members theirs on theirs.ring_id = mine.ring_id
      where mine.user_id = auth.uid() and theirs.user_id = profiles.id
    )
  );

drop policy if exists "Rings visible to members" on public.rings;
create policy "Rings visible to members" on public.rings
  for select to authenticated using (public.is_ring_member(id) or created_by = auth.uid());

drop policy if exists "Members create Rings" on public.rings;
create policy "Members create Rings" on public.rings
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "Ring creators update Rings" on public.rings;
create policy "Ring creators update Rings" on public.rings
  for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists "Ring creators delete Rings" on public.rings;
create policy "Ring creators delete Rings" on public.rings
  for delete to authenticated using (created_by = auth.uid());

drop policy if exists "Members see Ring membership" on public.ring_members;
create policy "Members see Ring membership" on public.ring_members
  for select to authenticated using (public.is_ring_member(ring_id));

drop policy if exists "Members can join or invite to a Ring" on public.ring_members;
create policy "Members can join or invite to a Ring" on public.ring_members
  for insert to authenticated
  with check (user_id = auth.uid() and (public.is_ring_member(ring_id) or public.is_ring_creator(ring_id)));

drop policy if exists "Members leave or creators remove Ring members" on public.ring_members;
create policy "Members leave or creators remove Ring members" on public.ring_members
  for delete to authenticated
  using (user_id = auth.uid() or public.is_ring_creator(ring_id));

drop policy if exists "Ring members see events" on public.ring_events;
create policy "Ring members see events" on public.ring_events
  for select to authenticated using (public.is_ring_member(ring_id));

drop policy if exists "Members create Ring events" on public.ring_events;
create policy "Members create Ring events" on public.ring_events
  for insert to authenticated with check (sender_id = auth.uid() and public.is_ring_member(ring_id));

drop policy if exists "Senders end Ring events" on public.ring_events;
create policy "Senders end Ring events" on public.ring_events
  for update to authenticated using (sender_id = auth.uid())
  with check (sender_id = auth.uid() and public.is_ring_member(ring_id) and status in ('active', 'ended'));

drop policy if exists "Members see Ring responses" on public.ring_responses;
create policy "Members see Ring responses" on public.ring_responses
  for select to authenticated using (public.is_active_ring_event(event_id) or exists (
    select 1 from public.ring_events e where e.id = event_id and public.is_ring_member(e.ring_id)
  ));

drop policy if exists "Members respond to active events" on public.ring_responses;
create policy "Members respond to active events" on public.ring_responses
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_active_ring_event(event_id));

drop policy if exists "Members update their active response" on public.ring_responses;
create policy "Members update their active response" on public.ring_responses
  for update to authenticated using (user_id = auth.uid() and public.is_active_ring_event(event_id))
  with check (user_id = auth.uid() and public.is_active_ring_event(event_id));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ring_members'
  ) then
    alter publication supabase_realtime add table public.ring_members;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ring_events'
  ) then
    alter publication supabase_realtime add table public.ring_events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ring_responses'
  ) then
    alter publication supabase_realtime add table public.ring_responses;
  end if;
end;
$$;