-- =====================================================================
-- FB Menus — 17_kitchen_printers.sql  (v2)
-- Printers per outlet, section → printer routing, print agents (token-hashed),
-- print job queue filled automatically when an order is accepted, agent API
-- (agent_claim_jobs / agent_report) used by tools/print-agent/print_agent.py.
-- Identical to the live migration "17_kitchen_printers".
-- =====================================================================
create extension if not exists pgcrypto with schema extensions;

create table public.printers (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  station text not null default 'hot' check (char_length(station) between 1 and 20),
  host text not null check (host ~ '^[A-Za-z0-9.-]{3,64}$'),
  port integer not null default 9100 check (port between 1 and 65535),
  model text not null default 'TM-U220B',
  width_chars integer not null default 40 check (width_chars between 24 and 64),
  copies integer not null default 1 check (copies between 1 and 3),
  use_red boolean not null default true,
  is_default boolean not null default false,
  is_active boolean not null default true,
  last_ok_at timestamptz, last_error text,
  created_at timestamptz not null default now(),
  constraint printers_id_outlet_unique unique (id, outlet_id)
);
create index printers_outlet_idx on public.printers (outlet_id);
alter table public.categories add column if not exists printer_id uuid references public.printers (id) on delete set null;
alter table public.items      add column if not exists printer_id uuid references public.printers (id) on delete set null;

create table public.print_agents (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  token_hash text not null unique,
  is_active boolean not null default true,
  last_seen_at timestamptz, last_ip text,
  created_at timestamptz not null default now()
);

create table public.print_jobs (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  printer_id uuid not null references public.printers (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  kind text not null check (kind in ('order', 'reprint', 'test')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'printing', 'done', 'failed')),
  attempts integer not null default 0,
  error text,
  agent_id uuid references public.print_agents (id) on delete set null,
  created_at timestamptz not null default now(), claimed_at timestamptz, printed_at timestamptz
);
create index print_jobs_queue_idx on public.print_jobs (outlet_id, status, created_at);
create index print_jobs_order_idx on public.print_jobs (order_id);
create index print_jobs_printer_idx on public.print_jobs (printer_id);
create index print_jobs_agent_idx on public.print_jobs (agent_id);
create index categories_printer_idx on public.categories (printer_id);
create index items_printer_idx on public.items (printer_id);
create index print_agents_outlet_idx on public.print_agents (outlet_id);

revoke all on public.printers, public.print_agents, public.print_jobs from anon, authenticated;
grant select, insert, update, delete on public.printers to authenticated;
grant select, update, delete on public.print_agents to authenticated;
grant select on public.print_jobs to authenticated;
grant update (printer_id) on public.categories to authenticated;
alter table public.printers enable row level security;
alter table public.print_agents enable row level security;
alter table public.print_jobs enable row level security;
create policy printers_read on public.printers for select to authenticated
  using (private.has_perm(outlet_id, 'settings') or private.has_perm(outlet_id, 'orders') or private.has_perm(outlet_id, 'menus'));
create policy printers_write on public.printers for all to authenticated
  using (private.has_perm(outlet_id, 'settings')) with check (private.has_perm(outlet_id, 'settings'));
create policy print_agents_read on public.print_agents for select to authenticated using (private.has_perm(outlet_id, 'settings'));
create policy print_agents_update on public.print_agents for update to authenticated
  using (private.has_perm(outlet_id, 'settings')) with check (private.has_perm(outlet_id, 'settings'));
create policy print_agents_delete on public.print_agents for delete to authenticated using (private.has_perm(outlet_id, 'settings'));
create policy print_jobs_read on public.print_jobs for select to authenticated
  using (private.has_perm(outlet_id, 'orders') or private.has_perm(outlet_id, 'settings'));

create or replace function public.enqueue_order_print(p_order uuid, p_kind text default 'order')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with o as (select * from public.orders where id = p_order),
  lines as (
    select oi.*, coalesce(
        (select i.printer_id from public.items i where i.id = oi.item_id),
        (select c.printer_id from public.category_items ci join public.categories c on c.id = ci.category_id
          where ci.item_id = oi.item_id and c.printer_id is not null order by c.sort_order limit 1),
        (select p.id from public.printers p where p.outlet_id = oi.outlet_id and p.is_default and p.is_active limit 1)
      ) as printer_id
    from public.order_items oi where oi.order_id = p_order
  ),
  ins as (
    insert into public.print_jobs (outlet_id, printer_id, order_id, kind, payload)
    select o.outlet_id, l.printer_id, o.id, p_kind, jsonb_build_object(
      'order_no', o.order_no, 'location_type', o.location_type, 'location', o.location,
      'guest_name', o.guest_name, 'guest_note', o.guest_note, 'created_at', o.created_at,
      'estimated_minutes', o.estimated_minutes, 'ready_by', o.ready_by,
      'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'options', l.options, 'note', l.note) order by l.created_at, l.id))
    from lines l cross join o
    join public.printers p on p.id = l.printer_id and p.is_active
    group by o.outlet_id, l.printer_id, o.id, o.order_no, o.location_type, o.location, o.guest_name, o.guest_note,
             o.created_at, o.estimated_minutes, o.ready_by
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end; $$;
revoke execute on function public.enqueue_order_print(uuid, text) from public, anon, authenticated;

create or replace function public.orders_print_on_accept()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform public.enqueue_order_print(new.id, 'order');
  end if;
  return null;
exception when others then return null;
end; $$;
revoke execute on function public.orders_print_on_accept() from public, anon, authenticated;
drop trigger if exists orders_print_on_accept on public.orders;
create trigger orders_print_on_accept after update of status on public.orders
  for each row execute function public.orders_print_on_accept();

create or replace function public.reprint_order(p_order uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_outlet uuid;
begin
  select outlet_id into v_outlet from public.orders where id = p_order;
  if v_outlet is null or not private.has_perm(v_outlet, 'orders') then raise exception 'FORBIDDEN'; end if;
  return public.enqueue_order_print(p_order, 'reprint');
end; $$;
revoke execute on function public.reprint_order(uuid) from public, anon;
grant execute on function public.reprint_order(uuid) to authenticated;

create or replace function public.print_test_page(p_printer uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_p public.printers%rowtype;
begin
  select * into v_p from public.printers where id = p_printer;
  if not found or not private.has_perm(v_p.outlet_id, 'settings') then raise exception 'FORBIDDEN'; end if;
  insert into public.print_jobs (outlet_id, printer_id, kind, payload)
  values (v_p.outlet_id, v_p.id, 'test', jsonb_build_object('printer', v_p.name, 'station', v_p.station, 'at', now()));
end; $$;
revoke execute on function public.print_test_page(uuid) from public, anon;
grant execute on function public.print_test_page(uuid) to authenticated;

create or replace function public.create_print_agent(p_outlet uuid, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text;
begin
  if not private.has_perm(p_outlet, 'settings') then raise exception 'FORBIDDEN'; end if;
  v_token := 'fbm_pa_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.print_agents (outlet_id, name, token_hash)
  values (p_outlet, left(coalesce(nullif(btrim(p_name), ''), 'Kitchen PC'), 40), encode(extensions.digest(v_token, 'sha256'), 'hex'));
  return v_token;
end; $$;
revoke execute on function public.create_print_agent(uuid, text) from public, anon;
grant execute on function public.create_print_agent(uuid, text) to authenticated;

create or replace function public.agent_claim_jobs(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_agent public.print_agents%rowtype; v_result jsonb;
begin
  select * into v_agent from public.print_agents
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and is_active;
  if not found then raise exception 'AGENT_UNKNOWN'; end if;
  update public.print_agents set last_seen_at = now() where id = v_agent.id;
  update public.print_jobs set status = 'pending'
   where outlet_id = v_agent.outlet_id and status = 'printing' and claimed_at < now() - interval '2 minutes' and attempts < 5;
  with c as (
    update public.print_jobs j
       set status = 'printing', claimed_at = now(), attempts = j.attempts + 1, agent_id = v_agent.id
     where j.id in (select id from public.print_jobs
                     where outlet_id = v_agent.outlet_id and status = 'pending' and created_at > now() - interval '6 hours'
                     order by created_at limit 10 for update skip locked)
    returning j.*
  )
  select jsonb_build_object(
    'outlet', (select jsonb_build_object('name', name, 'timezone', timezone) from public.outlets where id = v_agent.outlet_id),
    'jobs', coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'kind', c.kind, 'payload', c.payload, 'attempts', c.attempts,
      'printer', jsonb_build_object('name', p.name, 'station', p.station, 'host', p.host, 'port', p.port,
                                    'width', p.width_chars, 'copies', p.copies, 'red', p.use_red, 'model', p.model))
      order by c.created_at), '[]'::jsonb))
  into v_result
  from c join public.printers p on p.id = c.printer_id;
  return v_result;
end; $$;
revoke execute on function public.agent_claim_jobs(text) from public;
grant execute on function public.agent_claim_jobs(text) to anon, authenticated;

create or replace function public.agent_report(p_token text, p_job uuid, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_agent public.print_agents%rowtype; v_job public.print_jobs%rowtype;
begin
  select * into v_agent from public.print_agents
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and is_active;
  if not found then raise exception 'AGENT_UNKNOWN'; end if;
  select * into v_job from public.print_jobs where id = p_job and outlet_id = v_agent.outlet_id;
  if not found then return; end if;
  if p_ok then
    update public.print_jobs set status = 'done', printed_at = now(), error = null where id = p_job;
    update public.printers set last_ok_at = now(), last_error = null where id = v_job.printer_id;
  else
    update public.print_jobs set status = case when v_job.attempts >= 5 then 'failed' else 'pending' end,
           error = left(p_error, 300) where id = p_job;
    update public.printers set last_error = left(p_error, 300) where id = v_job.printer_id;
  end if;
end; $$;
revoke execute on function public.agent_report(text, uuid, boolean, text) from public;
grant execute on function public.agent_report(text, uuid, boolean, text) to anon, authenticated;
