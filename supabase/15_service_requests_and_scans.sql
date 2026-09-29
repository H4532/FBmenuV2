-- =====================================================================
-- FB Menus — 15_service_requests_and_scans.sql  (v2)
-- Call waiter / request bill from table & room QR codes, with push to the team,
-- and anonymous QR scan counting for analytics.
-- get_public_menu() now returns ordering flags {enabled, requests}; the full
-- function is re-created in the live project (migration 15b) — see 07_ordering.sql
-- with 'ordering', jsonb_build_object('enabled', …, 'requests', …).
-- Replace the project URL/key in service_requests_push() when installing elsewhere.
-- =====================================================================
create table public.service_requests (
  id            uuid primary key default gen_random_uuid(),
  outlet_id     uuid not null references public.outlets (id) on delete cascade,
  location_type text not null check (location_type in ('table', 'room')),
  location      text not null check (location ~ '^[A-Za-z0-9-]{1,10}$'),
  kind          text not null check (kind in ('waiter', 'bill')),
  note          text check (char_length(note) <= 200),
  status        text not null default 'open' check (status in ('open', 'done')),
  created_at    timestamptz not null default now(),
  done_at       timestamptz,
  done_by       uuid references auth.users (id) on delete set null
);
create index service_requests_outlet_idx on public.service_requests (outlet_id, status, created_at desc);
revoke all on public.service_requests from anon, authenticated;
grant select on public.service_requests to authenticated;
grant update (status, done_at, done_by) on public.service_requests to authenticated;
alter table public.service_requests enable row level security;
create policy service_requests_read on public.service_requests for select to authenticated using (private.has_perm(outlet_id, 'orders'));
create policy service_requests_update on public.service_requests for update to authenticated
  using (private.has_perm(outlet_id, 'orders')) with check (private.has_perm(outlet_id, 'orders'));

create or replace function public.request_service(p_slug text, p_location_type text, p_location text, p_kind text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_outlet public.outlets%rowtype; v_existing public.service_requests%rowtype; v_id uuid;
begin
  select * into v_outlet from public.outlets where slug = p_slug and is_active;
  if not found then raise exception 'OUTLET_NOT_FOUND'; end if;
  if not coalesce((v_outlet.ordering->>'requests')::boolean, true) then raise exception 'REQUESTS_CLOSED'; end if;
  if p_location_type not in ('table', 'room') or p_location !~ '^[A-Za-z0-9-]{1,10}$' then raise exception 'LOCATION_REQUIRED'; end if;
  if p_kind not in ('waiter', 'bill') then raise exception 'BAD_REQUEST'; end if;
  select * into v_existing from public.service_requests
   where outlet_id = v_outlet.id and location_type = p_location_type and location = p_location
     and kind = p_kind and status = 'open' and created_at > now() - interval '2 hours'
   order by created_at desc limit 1;
  if found then return jsonb_build_object('id', v_existing.id, 'already_open', true, 'created_at', v_existing.created_at); end if;
  if (select count(*) from public.service_requests where outlet_id = v_outlet.id and location_type = p_location_type
        and location = p_location and created_at > now() - interval '10 minutes') >= 6
     or (select count(*) from public.service_requests where outlet_id = v_outlet.id and created_at > now() - interval '10 minutes') >= 80 then
    raise exception 'RATE_LIMIT';
  end if;
  insert into public.service_requests (outlet_id, location_type, location, kind, note)
  values (v_outlet.id, p_location_type, p_location, p_kind, left(nullif(btrim(p_note), ''), 200)) returning id into v_id;
  return jsonb_build_object('id', v_id, 'already_open', false, 'created_at', now());
end; $$;
revoke execute on function public.request_service(text, text, text, text, text) from public;
grant execute on function public.request_service(text, text, text, text, text) to anon, authenticated;

create or replace function public.guest_request_status(p_ids uuid[])
returns table (id uuid, kind text, status text, created_at timestamptz, done_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select r.id, r.kind, r.status, r.created_at, r.done_at from public.service_requests r
  where r.id = any (p_ids[1:10]) and r.created_at > now() - interval '12 hours';
$$;
revoke execute on function public.guest_request_status(uuid[]) from public;
grant execute on function public.guest_request_status(uuid[]) to anon, authenticated;

create or replace function public.service_requests_push()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(url := 'https://swjffroqtxfbsmtjpimw.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('request_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_9iSpnZU7vc1n2K4kMMjYNg_l55LW1XU'),
    timeout_milliseconds := 5000);
  return null;
exception when others then return null;
end; $$;
revoke execute on function public.service_requests_push() from public, anon, authenticated;
create trigger service_requests_push after insert on public.service_requests for each row execute function public.service_requests_push();

create table public.qr_scans (
  id bigint generated always as identity primary key,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  location_type text check (location_type in ('table', 'room', 'none')),
  location text check (location ~ '^[A-Za-z0-9-]{0,10}$'),
  lang text, session text check (char_length(session) <= 40),
  created_at timestamptz not null default now()
);
create index qr_scans_outlet_idx on public.qr_scans (outlet_id, created_at desc);
revoke all on public.qr_scans from anon, authenticated;
grant select on public.qr_scans to authenticated;
alter table public.qr_scans enable row level security;
create policy qr_scans_read on public.qr_scans for select to authenticated using (private.has_perm(outlet_id, 'settings'));

create or replace function public.log_scan(p_slug text, p_location_type text, p_location text, p_lang text, p_session text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_outlet uuid;
begin
  select id into v_outlet from public.outlets where slug = p_slug and is_active;
  if v_outlet is null or p_location_type not in ('table', 'room', 'none') or coalesce(p_location, '') !~ '^[A-Za-z0-9-]{0,10}$' then return; end if;
  if exists (select 1 from public.qr_scans where outlet_id = v_outlet and session = left(p_session, 40)
               and coalesce(location, '') = coalesce(p_location, '') and created_at > now() - interval '30 minutes') then return; end if;
  insert into public.qr_scans (outlet_id, location_type, location, lang, session)
  values (v_outlet, p_location_type, nullif(p_location, ''), left(p_lang, 5), left(p_session, 40));
end; $$;
revoke execute on function public.log_scan(text, text, text, text, text) from public;
grant execute on function public.log_scan(text, text, text, text, text) to anon, authenticated;
