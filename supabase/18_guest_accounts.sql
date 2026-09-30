-- =====================================================================
-- FB Menus — 18_guest_accounts.sql  (v2)
-- Guest accounts: profile & diet/allergy preferences, favourites, order history,
-- loyalty points (earned when a linked order is Served), Simphony item numbers,
-- and the rate limit used by the guest-register Edge Function.
-- =====================================================================
create table public.guest_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 60),
  phone text check (char_length(phone) <= 20),
  preferred_lang text check (preferred_lang in ('ar', 'en', 'fr')),
  diet text[] not null default '{}' check (diet <@ array['vegetarian','vegan','gluten_free','dairy_free']::text[]),
  allergens text[] not null default '{}' check (allergens <@ array[
    'gluten','crustaceans','egg','fish','peanuts','soy','dairy','nuts','celery','mustard','sesame','sulphites','lupin','molluscs']::text[]),
  marketing_ok boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create trigger guest_profiles_set_updated_at before update on public.guest_profiles for each row execute function public.set_updated_at();

create table public.guest_favorites (
  user_id uuid not null references auth.users (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  item_id uuid not null references public.items (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
create index guest_favorites_outlet_idx on public.guest_favorites (outlet_id);
create index guest_favorites_item_idx on public.guest_favorites (item_id);

create table public.guest_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  points integer not null,
  reason text not null check (reason in ('order', 'adjustment', 'redeemed')),
  created_at timestamptz not null default now(),
  constraint guest_points_once_per_order unique (order_id, reason)
);
create index guest_points_user_idx on public.guest_points (user_id);
create index guest_points_outlet_idx on public.guest_points (outlet_id);

alter table public.orders add column if not exists guest_user_id uuid references auth.users (id) on delete set null;
create index if not exists orders_guest_idx on public.orders (guest_user_id);
alter table public.outlet_order_settings add column if not exists points_per_sar numeric(6,2) not null default 1 check (points_per_sar between 0 and 100);
alter table public.items add column if not exists pos_item_no text check (char_length(pos_item_no) <= 20);

revoke all on public.guest_profiles, public.guest_favorites, public.guest_points from anon, authenticated;
grant select, insert, update, delete on public.guest_profiles, public.guest_favorites to authenticated;
grant select on public.guest_points to authenticated;
alter table public.guest_profiles enable row level security;
alter table public.guest_favorites enable row level security;
alter table public.guest_points enable row level security;
create policy guest_profile_own on public.guest_profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy guest_fav_own on public.guest_favorites for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy guest_points_own on public.guest_points for select to authenticated
  using (user_id = (select auth.uid()) or private.has_perm(outlet_id, 'orders'));

create or replace function public.link_order_to_guest(p_order uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then return false; end if;
  update public.orders set guest_user_id = v_uid
   where id = p_order and guest_user_id is null and created_at > now() - interval '24 hours';
  return found;
end; $$;
revoke execute on function public.link_order_to_guest(uuid) from public, anon;
grant execute on function public.link_order_to_guest(uuid) to authenticated;

create or replace function public.my_guest_orders(p_limit integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', o.id, 'order_no', o.order_no, 'status', o.status, 'created_at', o.created_at,
      'location_type', o.location_type, 'location', o.location, 'subtotal', o.subtotal,
      'outlet', jsonb_build_object('slug', ot.slug, 'name', ot.name, 'currency', ot.currency),
      'items', (select jsonb_agg(jsonb_build_object('item_id', i.item_id, 'qty', i.qty, 'name', i.name, 'line_total', i.line_total,
                  'option_ids', '[]'::jsonb, 'options', i.options, 'note', i.note) order by i.created_at) from public.order_items i where i.order_id = o.id),
      'points', (select coalesce(sum(points), 0) from public.guest_points gp where gp.order_id = o.id)
    ) x
    from public.orders o join public.outlets ot on ot.id = o.outlet_id
    where o.guest_user_id = (select auth.uid())
    order by o.created_at desc limit least(greatest(p_limit, 1), 100)
  ) s;
$$;
revoke execute on function public.my_guest_orders(integer) from public, anon;
grant execute on function public.my_guest_orders(integer) to authenticated;

create or replace function public.orders_award_points()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_rate numeric;
begin
  if new.status = 'served' and old.status is distinct from 'served' and new.guest_user_id is not null then
    select coalesce(points_per_sar, 1) into v_rate from public.outlet_order_settings where outlet_id = new.outlet_id;
    insert into public.guest_points (user_id, outlet_id, order_id, points, reason)
    values (new.guest_user_id, new.outlet_id, new.id, floor(new.subtotal * coalesce(v_rate, 1))::int, 'order')
    on conflict (order_id, reason) do nothing;
  end if;
  return null;
exception when others then return null;
end; $$;
revoke execute on function public.orders_award_points() from public, anon, authenticated;
create trigger orders_award_points after update of status on public.orders
  for each row execute function public.orders_award_points();

create table private.guest_signups (ip text not null, created_at timestamptz not null default now());
create index guest_signups_ip_idx on private.guest_signups (ip, created_at);

create or replace function public.guest_signup_allowed(p_ip text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from private.guest_signups where created_at < now() - interval '1 day';
  if (select count(*) from private.guest_signups where ip = p_ip and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from private.guest_signups where created_at > now() - interval '1 hour') >= 200 then
    return false;
  end if;
  insert into private.guest_signups (ip) values (left(coalesce(p_ip, 'unknown'), 60));
  return true;
end; $$;
revoke execute on function public.guest_signup_allowed(text) from public, anon, authenticated;
grant execute on function public.guest_signup_allowed(text) to service_role;
