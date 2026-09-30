-- =====================================================================
-- FB Menus — 16_reports.sql  (v2)
-- report_sales(outlet, from, to) and report_overview() for the admin Reports tab.
-- SECURITY INVOKER: RLS decides what each user sees (orders need Orders right,
-- scans need Settings right).
-- =====================================================================
create or replace function public.report_sales(p_outlet uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with
  tz as (select timezone from public.outlets where id = p_outlet),
  o as (select * from public.orders where outlet_id = p_outlet and created_at >= p_from and created_at < p_to),
  ok as (select * from o where status <> 'cancelled'),
  li as (select oi.* from public.order_items oi join ok on ok.id = oi.order_id),
  acc as (
    select extract(epoch from ((select min((h->>'at')::timestamptz) from jsonb_array_elements(ok.status_history) h where h->>'status' = 'accepted')
                               - ok.created_at)) / 60 as mins
    from ok
  ),
  sc as (select * from public.qr_scans where outlet_id = p_outlet and created_at >= p_from and created_at < p_to)
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'orders', (select count(*) from ok),
      'cancelled', (select count(*) from o where status = 'cancelled'),
      'revenue', coalesce((select sum(subtotal) from ok), 0),
      'avg_order', coalesce((select round(avg(subtotal), 2) from ok), 0),
      'items', coalesce((select sum(qty) from li), 0),
      'avg_accept_min', (select round(avg(mins)::numeric, 1) from acc where mins is not null),
      'scans', (select count(*) from sc),
      'scans_located', (select count(*) from sc where location_type in ('table', 'room'))
    ),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue', r) order by d) from (
        select to_char(created_at at time zone (select timezone from tz), 'YYYY-MM-DD') d, count(*) n, sum(subtotal) r
        from ok group by 1) x), '[]'::jsonb),
    'by_hour', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n, 'revenue', r) order by h) from (
        select extract(hour from created_at at time zone (select timezone from tz))::int h, count(*) n, sum(subtotal) r
        from ok group by 1) x), '[]'::jsonb),
    'top_items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', q, 'revenue', r) order by q desc, r desc) from (
        select name, sum(qty) q, sum(line_total) r from li group by name order by sum(qty) desc, sum(line_total) desc limit 15) x), '[]'::jsonb),
    'by_location', coalesce((select jsonb_agg(jsonb_build_object('type', t, 'location', l, 'orders', n, 'revenue', r) order by n desc) from (
        select location_type t, location l, count(*) n, sum(subtotal) r from ok group by 1, 2) x), '[]'::jsonb),
    'scans_by_location', coalesce((select jsonb_agg(jsonb_build_object('type', t, 'location', l, 'scans', n) order by n desc) from (
        select coalesce(location_type, 'none') t, coalesce(location, '') l, count(*) n from sc group by 1, 2) x), '[]'::jsonb),
    'status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from o group by status) x), '{}'::jsonb)
  );
$$;
revoke execute on function public.report_sales(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.report_sales(uuid, timestamptz, timestamptz) to authenticated;

create or replace function public.report_overview()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'outlet_id', ot.id, 'slug', ot.slug, 'name', ot.name, 'ordering', ot.ordering,
    'orders_today', (select count(*) from public.orders o where o.outlet_id = ot.id and o.status <> 'cancelled'
                     and (o.created_at at time zone ot.timezone)::date = (now() at time zone ot.timezone)::date),
    'revenue_today', (select coalesce(sum(subtotal), 0) from public.orders o where o.outlet_id = ot.id and o.status <> 'cancelled'
                     and (o.created_at at time zone ot.timezone)::date = (now() at time zone ot.timezone)::date),
    'open_orders', (select count(*) from public.orders o where o.outlet_id = ot.id and o.status in ('new', 'accepted', 'ready')
                    and o.created_at > now() - interval '24 hours'),
    'waiting_new', (select count(*) from public.orders o where o.outlet_id = ot.id and o.status = 'new'
                    and o.created_at > now() - interval '24 hours'),
    'open_requests', (select count(*) from public.service_requests r where r.outlet_id = ot.id and r.status = 'open'
                    and r.created_at > now() - interval '12 hours'),
    'sold_out', (select count(*) from public.items i where i.outlet_id = ot.id and i.is_active and not i.is_available)
  ) order by ot.slug), '[]'::jsonb)
  from public.outlets ot
  where exists (select 1 from public.outlet_admins a where a.outlet_id = ot.id and a.user_id = (select auth.uid()));
$$;
revoke execute on function public.report_overview() from public, anon;
grant execute on function public.report_overview() to authenticated;
