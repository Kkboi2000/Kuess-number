-- =====================================================================
--  Kuess: Supabase schema
--  Paste into Supabase > SQL Editor and press Run. Safe to run again.
--
--  Design in one paragraph:
--  Every device signs in anonymously, so the database knows who is asking.
--  Tables live in a private "kuess" schema that the browser cannot query.
--  The browser can only call the public kuess_* functions below, and the
--  one that returns the table (kuess_state) leaves out the caller's own
--  number. So nobody can peek, not even with DevTools. Each change bumps
--  rooms.version; devices listen for that over Realtime and re-read state.
-- =====================================================================

create schema if not exists kuess;

-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------

create table if not exists kuess.rooms (
  id           uuid primary key default gen_random_uuid(),
  code         text not null check (code ~ '^[0-9]{5}$'),
  host_id      uuid not null,                                  -- auth user of the host
  status       text not null default 'lobby'
               check (status in ('lobby', 'playing', 'finished', 'closed')),
  number_mode  text not null default 'random' check (number_mode in ('random', 'custom')),
  number_max   int  not null default 100 check (number_max in (10, 100, 1000)),
  max_kuess    int  check (max_kuess between 1 and 99),          -- null = unlimited
  memo         boolean not null default true,
  turn_player  uuid,                                           -- kuess.players.id
  last_event   jsonb,                                          -- for "Ana got it!" toasts
  version      bigint not null default 0,                      -- bumped on every change
  updated_at   timestamptz not null default now()
);

-- A code is unique among rooms that are still open.
create unique index if not exists rooms_code_open on kuess.rooms (code) where status <> 'closed';

create table if not exists kuess.players (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references kuess.rooms (id) on delete cascade,
  user_id     uuid not null,
  name        text not null,
  seat        int  not null,                                   -- turn order
  state       text not null default 'waiting'
              check (state in ('waiting', 'solved', 'out')),   -- ⏳ ✅ ❌
  kuess_used  int  not null default 0,
  done_at     timestamptz,                                     -- when they hit ✅ or ❌
  active      boolean not null default true                    -- false once they leave
);

create index if not exists players_room on kuess.players (room_id);
-- One seat per device at a time.
create unique index if not exists players_user_active on kuess.players (user_id) where active;

-- The numbers. No policy grants access, so only the functions below can read it.
create table if not exists kuess.secrets (
  player_id  uuid primary key references kuess.players (id) on delete cascade,
  value      int not null
);

-- ---------------------------------------------------------------------
--  Internal helpers (not callable from the browser)
-- ---------------------------------------------------------------------

create or replace function kuess.require_user() returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'not_signed_in'; end if;
  return v;
end $$;

create or replace function kuess.clean_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := btrim(left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 20));
begin
  if v = '' then raise exception 'need_name'; end if;
  return v;
end $$;

-- The caller's seat in a room (null if they are not in it).
create or replace function kuess.me(p_room uuid) returns kuess.players
language sql stable set search_path = '' as $$
  select * from kuess.players where room_id = p_room and user_id = auth.uid() and active
$$;

-- Locks the room for this change and checks the caller may make it.
create or replace function kuess.lock_room(p_room uuid, p_status text default null, p_host_only boolean default false)
returns kuess.rooms
language plpgsql set search_path = '' as $$
declare r kuess.rooms;
begin
  select * into r from kuess.rooms where id = p_room for update;
  if not found or r.status = 'closed' then raise exception 'room_closed'; end if;
  if (kuess.me(p_room)).id is null then raise exception 'not_in_room'; end if;
  if p_host_only and r.host_id is distinct from auth.uid() then raise exception 'host_only'; end if;
  if p_status is not null and r.status <> p_status then raise exception 'wrong_phase'; end if;
  return r;
end $$;

-- Marks the room as changed so every device re-reads it.
create or replace function kuess.touch(p_room uuid, p_event jsonb default null) returns void
language sql set search_path = '' as $$
  update kuess.rooms
     set version    = version + 1,
         updated_at = now(),
         last_event = case when p_event is null then last_event
                           else p_event || jsonb_build_object('id', version + 1) end
   where id = p_room;
$$;

-- Passes the turn to the next player still guessing (after the current seat,
-- wrapping around). Ends the game when nobody is left guessing.
create or replace function kuess.advance(p_room uuid) returns void
language plpgsql set search_path = '' as $$
declare v_seat int; v_next uuid;
begin
  select p.seat into v_seat
    from kuess.rooms r join kuess.players p on p.id = r.turn_player
   where r.id = p_room;

  select id into v_next
    from kuess.players
   where room_id = p_room and active and state = 'waiting'
   order by (seat <= coalesce(v_seat, -1)), seat
   limit 1;

  if v_next is null then
    update kuess.rooms set status = 'finished', turn_player = null where id = p_room;
  else
    update kuess.rooms set turn_player = v_next where id = p_room;
  end if;
end $$;

-- A random number from 1..max, avoiding the taken ones while possible.
create or replace function kuess.draw(p_max int, p_taken int[]) returns int
language sql volatile set search_path = '' as $$
  select coalesce(
    (select n from generate_series(1, p_max) n
      where n <> all (coalesce(p_taken, '{}'))
      order by random() limit 1),
    1 + floor(random() * p_max)::int)
$$;

-- Removes one player. If it is the host, the room closes for everyone.
create or replace function kuess.leave_player(p_player uuid) returns void
language plpgsql set search_path = '' as $$
declare p kuess.players; r kuess.rooms;
begin
  select * into p from kuess.players where id = p_player;
  select * into r from kuess.rooms where id = p.room_id for update;
  update kuess.players set active = false where id = p.id;

  if r.host_id = p.user_id then
    update kuess.players set active = false where room_id = r.id;
    update kuess.rooms set status = 'closed', turn_player = null where id = r.id;
    perform kuess.touch(r.id, jsonb_build_object('type', 'closed'));
    return;
  end if;

  if r.status = 'lobby' then
    delete from kuess.secrets where player_id = p.id;
  elsif r.status = 'playing' then
    if r.turn_player = p.id then
      perform kuess.advance(r.id);
    elsif not exists (select 1 from kuess.players
                       where room_id = r.id and active and state = 'waiting') then
      update kuess.rooms set status = 'finished', turn_player = null where id = r.id;
    end if;
  end if;

  perform kuess.touch(r.id, jsonb_build_object('type', 'left', 'name', p.name, 'player', p.id));
end $$;

-- Realtime asks this when deciding who may hear about a room.
create or replace function kuess.in_room(p_room uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from kuess.players where room_id = p_room and user_id = auth.uid())
$$;

-- ---------------------------------------------------------------------
--  Public functions (what the game calls)
-- ---------------------------------------------------------------------

-- 1st page: New game. Returns the room id.
create or replace function public.kuess_create_room(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := kuess.require_user();
  v_name text := kuess.clean_name(p_name);
  v_code text;
  v_room uuid;
  v_old  uuid;
begin
  for v_old in select id from kuess.players where user_id = v_uid and active loop
    perform kuess.leave_player(v_old);
  end loop;

  -- Tidy away tables nobody has touched for a day.
  delete from kuess.rooms where updated_at < now() - interval '1 day';

  loop
    v_code := (10000 + floor(random() * 90000))::int::text;
    exit when not exists (select 1 from kuess.rooms where code = v_code and status <> 'closed');
  end loop;

  insert into kuess.rooms (code, host_id) values (v_code, v_uid) returning id into v_room;
  insert into kuess.players (room_id, user_id, name, seat) values (v_room, v_uid, v_name, 0);
  return v_room;
end $$;

-- 1st page: Join game. Returns the room id.
create or replace function public.kuess_join_room(p_code text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := kuess.require_user();
  v_name text := kuess.clean_name(p_name);
  r      kuess.rooms;
  v_old  uuid;
begin
  select * into r from kuess.rooms
   where code = btrim(p_code) and status <> 'closed'
   for update;
  if not found then raise exception 'room_not_found'; end if;

  -- Already sitting here (page refresh, second tap): just come back.
  if exists (select 1 from kuess.players where room_id = r.id and user_id = v_uid and active) then
    return r.id;
  end if;

  if r.status <> 'lobby' then raise exception 'game_started'; end if;
  if (select count(*) from kuess.players where room_id = r.id and active) >= 20 then
    raise exception 'room_full';
  end if;
  if exists (select 1 from kuess.players
              where room_id = r.id and active and lower(name) = lower(v_name)) then
    raise exception 'name_taken';
  end if;

  for v_old in select id from kuess.players where user_id = v_uid and active loop
    perform kuess.leave_player(v_old);
  end loop;

  insert into kuess.players (room_id, user_id, name, seat)
  values (r.id, v_uid, v_name,
          coalesce((select max(seat) + 1 from kuess.players where room_id = r.id), 0));
  perform kuess.touch(r.id, jsonb_build_object('type', 'joined', 'name', v_name));
  return r.id;
end $$;

-- On page load: which room is this device sitting in, if any?
create or replace function public.kuess_my_room() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.room_id
    from kuess.players p join kuess.rooms r on r.id = p.room_id
   where p.user_id = auth.uid() and p.active and r.status <> 'closed'
   limit 1
$$;

-- Everything a device needs to draw the screen, minus its own number.
create or replace function public.kuess_state(p_room uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r kuess.rooms; me kuess.players; v_host boolean;
begin
  select * into r from kuess.rooms where id = p_room;
  me := kuess.me(p_room);

  if me.id is null then
    if exists (select 1 from kuess.players where room_id = p_room and user_id = auth.uid()) then
      return jsonb_build_object('room', jsonb_build_object(
        'id', p_room,
        'status', case when r.status is null or r.status = 'closed' then 'closed' else 'left' end));
    end if;
    raise exception 'not_in_room';
  end if;

  v_host := r.host_id = me.user_id;

  return jsonb_build_object(
    'me', me.id,
    'room', jsonb_build_object(
      'id', r.id, 'code', r.code, 'status', r.status,
      'number_mode', r.number_mode, 'number_max', r.number_max,
      'max_kuess', r.max_kuess, 'memo', r.memo,
      'turn_player', r.turn_player, 'last_event', r.last_event, 'version', r.version),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'seat', p.seat, 'state', p.state,
               'kuess_used', p.kuess_used, 'done_at', p.done_at,
               'is_host', p.user_id = r.host_id,
               'number', case
                 when r.status = 'finished'               then s.value   -- reveal all
                 when p.id = me.id                        then case when p.state = 'solved' then s.value end
                 when r.status = 'playing'                then s.value   -- you see the others
                 when r.status = 'lobby' and v_host       then s.value   -- host edits custom numbers
               end)
             order by p.seat, p.id)
        from kuess.players p left join kuess.secrets s on s.player_id = p.id
       where p.room_id = r.id and p.active), '[]'::jsonb));
end $$;

-- 2nd page (host): numbers / range / kuess chances / memo.
create or replace function public.kuess_update_settings(p_room uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kuess.lock_room(p_room, 'lobby', true);
  update kuess.rooms set
    number_mode = coalesce(p_settings ->> 'number_mode', number_mode),
    number_max  = coalesce((p_settings ->> 'number_max')::int, number_max),
    max_kuess   = case when p_settings ? 'max_kuess' then (p_settings ->> 'max_kuess')::int
                       else max_kuess end,
    memo        = coalesce((p_settings ->> 'memo')::boolean, memo)
  where id = p_room;
  perform kuess.touch(p_room);
end $$;

-- 2nd page (host): turn order, as the full list of player ids.
create or replace function public.kuess_set_order(p_room uuid, p_order uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kuess.lock_room(p_room, 'lobby', true);
  with ord as (
    select p.id, row_number() over (order by coalesce(o.ord, 1000000), p.seat, p.id) - 1 as s
      from kuess.players p
      left join unnest(p_order) with ordinality as o(id, ord) on o.id = p.id
     where p.room_id = p_room and p.active)
  update kuess.players p set seat = ord.s from ord where p.id = ord.id;
  perform kuess.touch(p_room);
end $$;

-- 2nd page (host, custom mode): one player's number. Null clears it.
create or replace function public.kuess_set_number(p_room uuid, p_player uuid, p_value int) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kuess.lock_room(p_room, 'lobby', true);
  if not exists (select 1 from kuess.players where id = p_player and room_id = p_room and active) then
    raise exception 'not_in_room';
  end if;
  if p_player = (kuess.me(p_room)).id then raise exception 'own_number'; end if;

  if p_value is null then
    delete from kuess.secrets where player_id = p_player;
  else
    if p_value not between 0 and 999999 then raise exception 'bad_number'; end if;
    insert into kuess.secrets (player_id, value) values (p_player, p_value)
    on conflict (player_id) do update set value = excluded.value;
  end if;
  perform kuess.touch(p_room);
end $$;

-- 2nd page (host): Start game.
create or replace function public.kuess_start(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r kuess.rooms; v_host uuid; v_first uuid;
begin
  r := kuess.lock_room(p_room, 'lobby', true);
  if (select count(*) from kuess.players where room_id = p_room and active) < 2 then
    raise exception 'need_players';
  end if;
  v_host := (kuess.me(p_room)).id;

  -- Fresh seats 0..n-1 and a clean slate.
  with ord as (
    select id, row_number() over (order by seat, id) - 1 as s
      from kuess.players where room_id = p_room and active)
  update kuess.players p
     set seat = ord.s, state = 'waiting', kuess_used = 0, done_at = null
    from ord where p.id = ord.id;

  if r.number_mode = 'custom' then
    if exists (select 1 from kuess.players p
                where p.room_id = p_room and p.active and p.id <> v_host
                  and not exists (select 1 from kuess.secrets s where s.player_id = p.id)) then
      raise exception 'missing_numbers';
    end if;
    -- The host cannot know their own number, so theirs is drawn at random.
    delete from kuess.secrets where player_id = v_host;
    insert into kuess.secrets (player_id, value)
    values (v_host, kuess.draw(r.number_max, array(
      select s.value from kuess.secrets s join kuess.players p on p.id = s.player_id
       where p.room_id = p_room and p.active)));
  else
    delete from kuess.secrets s using kuess.players p
     where s.player_id = p.id and p.room_id = p_room;
    -- Different numbers for everyone while the range allows it.
    insert into kuess.secrets (player_id, value)
    select ps.id, coalesce(ns.n, 1 + floor(random() * r.number_max)::int)
      from (select id, row_number() over (order by random()) as k
              from kuess.players where room_id = p_room and active) ps
      left join (select n, row_number() over (order by random()) as k
                   from generate_series(1, r.number_max) n) ns on ns.k = ps.k;
  end if;

  select id into v_first from kuess.players
   where room_id = p_room and active order by seat limit 1;
  update kuess.rooms set status = 'playing', turn_player = v_first where id = p_room;
  perform kuess.touch(p_room, jsonb_build_object('type', 'start'));
end $$;

-- 3rd page: Kuess. One kuess per turn. Returns 'correct', 'wrong' or 'out'.
create or replace function public.kuess_guess(p_room uuid, p_value int) returns text
language plpgsql security definer set search_path = '' as $$
declare r kuess.rooms; me kuess.players; v_secret int; v_result text;
begin
  r  := kuess.lock_room(p_room, 'playing');
  me := kuess.me(p_room);
  if r.turn_player is distinct from me.id or me.state <> 'waiting' then
    raise exception 'not_your_turn';
  end if;
  if p_value is null then raise exception 'bad_number'; end if;

  select value into v_secret from kuess.secrets where player_id = me.id;

  if p_value = v_secret then
    v_result := 'correct';
    update kuess.players set state = 'solved', kuess_used = kuess_used + 1, done_at = now()
     where id = me.id;
  elsif r.max_kuess is not null and me.kuess_used + 1 >= r.max_kuess then
    v_result := 'out';
    update kuess.players set state = 'out', kuess_used = kuess_used + 1, done_at = now()
     where id = me.id;
  else
    v_result := 'wrong';
    update kuess.players set kuess_used = kuess_used + 1 where id = me.id;
  end if;

  perform kuess.advance(p_room);
  perform kuess.touch(p_room, jsonb_build_object(
    'type', v_result, 'name', me.name, 'player', me.id, 'value', p_value));
  return v_result;
end $$;

-- 3rd page: Still not sure (ends the turn).
create or replace function public.kuess_pass(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r kuess.rooms; me kuess.players;
begin
  r  := kuess.lock_room(p_room, 'playing');
  me := kuess.me(p_room);
  if r.turn_player is distinct from me.id then raise exception 'not_your_turn'; end if;
  perform kuess.advance(p_room);
  perform kuess.touch(p_room, jsonb_build_object('type', 'pass', 'name', me.name, 'player', me.id));
end $$;

-- 3rd page (host): End game early.
create or replace function public.kuess_end(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kuess.lock_room(p_room, 'playing', true);
  update kuess.rooms set status = 'finished', turn_player = null where id = p_room;
  perform kuess.touch(p_room, jsonb_build_object('type', 'ended'));
end $$;

-- Summary (host): Play again with the same people.
create or replace function public.kuess_rematch(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform kuess.lock_room(p_room, 'finished', true);
  delete from kuess.secrets s using kuess.players p
   where s.player_id = p.id and p.room_id = p_room;
  update kuess.players set state = 'waiting', kuess_used = 0, done_at = null where room_id = p_room;
  update kuess.rooms set status = 'lobby', turn_player = null where id = p_room;
  perform kuess.touch(p_room, jsonb_build_object('type', 'rematch'));
end $$;

-- Any page: Leave. The host leaving closes the room for everyone.
create or replace function public.kuess_leave(p_room uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := (kuess.me(p_room)).id;
begin
  if v_me is not null then perform kuess.leave_player(v_me); end if;
end $$;

-- ---------------------------------------------------------------------
--  Who may do what
-- ---------------------------------------------------------------------

alter table kuess.rooms   enable row level security;
alter table kuess.players enable row level security;
alter table kuess.secrets enable row level security;

grant usage on schema kuess to authenticated;
revoke all on all tables in schema kuess from anon, authenticated;
grant select on kuess.rooms to authenticated;          -- Realtime needs this, RLS narrows it

drop policy if exists "players hear their own room" on kuess.rooms;
create policy "players hear their own room" on kuess.rooms
  for select to authenticated using (kuess.in_room(id));

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'kuess\_%' loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'kuess' loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function kuess.in_room(uuid) to authenticated;

-- Realtime: announce room changes.
do $$
begin
  alter publication supabase_realtime add table kuess.rooms;
exception when duplicate_object then null;
end $$;

-- Let the API see the new functions right away.
notify pgrst, 'reload schema';
