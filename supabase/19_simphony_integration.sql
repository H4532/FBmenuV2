-- =====================================================================
-- FB Menus — 19_simphony_integration.sql  (v2)
-- Oracle Simphony STS Gen2: accepted orders are posted as OPEN checks
-- (simphony Edge Function). Settings per outlet; API password & tokens in
-- the private schema. Replace the project URL/key in orders_send_to_pos()
-- when installing elsewhere.
-- =====================================================================
create table public.pos_settings (
  outlet_id uuid primary key references public.outlets (id) on delete cascade,
  enabled boolean not null default false,
  api_host text check (api_host ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  auth_host text check (auth_host ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  client_id text check (char_length(client_id) <= 100),
  org_short_name text check (char_length(org_short_name) <= 40),
  loc_ref text check (char_length(loc_ref) <= 40),
  rvc_ref integer, employee_ref integer, order_type_ref integer, room_order_type_ref integer,
  training_mode boolean not null default true,
  last_test_at timestamptz, last_test_result text,
  updated_at timestamptz not null default now()
);
create trigger pos_settings_set_updated_at before update on public.pos_settings for each row execute function public.set_updated_at();

create table private.pos_credentials (
  outlet_id uuid primary key references public.outlets (id) on delete cascade,
  username text, password text, id_token text, refresh_token text, token_expires timestamptz
);
revoke all on private.pos_credentials from public, anon, authenticated;

alter table public.orders
  add column if not exists pos_status text check (pos_status in ('pending', 'sent', 'failed', 'skipped')),
  add column if not exists pos_check_ref text,
  add column if not exists pos_check_number integer,
  add column if not exists pos_error text,
  add column if not exists pos_sent_at timestamptz;

revoke all on public.pos_settings from anon, authenticated;
grant select, insert, update on public.pos_settings to authenticated;
alter table public.pos_settings enable row level security;
create policy pos_settings_rw on public.pos_settings for all to authenticated
  using (private.has_perm(outlet_id, 'settings')) with check (private.has_perm(outlet_id, 'settings'));

create or replace function public.pos_set_credentials(p_outlet uuid, p_username text, p_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_perm(p_outlet, 'settings') then raise exception 'FORBIDDEN'; end if;
  insert into private.pos_credentials (outlet_id, username, password)
  values (p_outlet, nullif(btrim(p_username), ''), nullif(p_password, ''))
  on conflict (outlet_id) do update set username = excluded.username,
    password = coalesce(excluded.password, private.pos_credentials.password),
    id_token = null, refresh_token = null, token_expires = null;
end; $$;
revoke execute on function public.pos_set_credentials(uuid, text, text) from public, anon;
grant execute on function public.pos_set_credentials(uuid, text, text) to authenticated;

create or replace function public.pos_has_credentials(p_outlet uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_perm(p_outlet, 'settings') and exists (
    select 1 from private.pos_credentials where outlet_id = p_outlet and username is not null and password is not null);
$$;
revoke execute on function public.pos_has_credentials(uuid) from public, anon;
grant execute on function public.pos_has_credentials(uuid) to authenticated;

create or replace function public.pos_get_credentials(p_outlet uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(c) from private.pos_credentials c where c.outlet_id = p_outlet;
$$;
create or replace function public.pos_save_tokens(p_outlet uuid, p_id_token text, p_refresh_token text, p_expires timestamptz)
returns void language sql security definer set search_path = '' as $$
  update private.pos_credentials set id_token = p_id_token, refresh_token = coalesce(p_refresh_token, refresh_token),
         token_expires = p_expires where outlet_id = p_outlet;
$$;
revoke execute on function public.pos_get_credentials(uuid) from public, anon, authenticated;
revoke execute on function public.pos_save_tokens(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.pos_get_credentials(uuid) to service_role;
grant execute on function public.pos_save_tokens(uuid, text, text, timestamptz) to service_role;

create or replace function public.orders_send_to_pos()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' and new.pos_status is null
     and exists (select 1 from public.pos_settings s where s.outlet_id = new.outlet_id and s.enabled) then
    update public.orders set pos_status = 'pending' where id = new.id;
    perform net.http_post(
      url := 'https://swjffroqtxfbsmtjpimw.supabase.co/functions/v1/simphony',
      body := jsonb_build_object('action', 'send', 'order_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', 'sb_publishable_9iSpnZU7vc1n2K4kMMjYNg_l55LW1XU'),
      timeout_milliseconds := 20000);
  end if;
  return null;
exception when others then return null;
end; $$;
revoke execute on function public.orders_send_to_pos() from public, anon, authenticated;
create trigger orders_send_to_pos after update of status on public.orders for each row execute function public.orders_send_to_pos();

insert into public.pos_settings (outlet_id) select id from public.outlets on conflict do nothing;
