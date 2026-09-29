// FB Menus — send-push Edge Function (Web Push to team devices).
//  • {order_id}          called by the database when a new order is complete;
//                        sends once per order (orders.pushed_at guards duplicates).
//  • {action:'test', outlet_id}  signed-in user: test notification to their own devices.
//  • {request_id}      called by the database when a guest calls a waiter / asks for the bill.
//  • {action:'remind'}  called every 30 s by pg_cron: repeats the push for orders still "new"
//                       (interval and maximum per outlet in outlet_order_settings).
// Recipients: devices of users with the Orders right on the order's outlet.
// Every payload carries `badge` = open orders (new/accepted/ready) for the app icon.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type L = Record<string, string>;
const en = (o: L | null | undefined) => (o?.en || o?.ar || Object.values(o || {})[0] || '') as string;

let configured = false;
async function setup() {
  if (configured) return;
  const { data: cfg, error } = await admin.rpc('push_config');
  if (error || !cfg?.vapid_private_key) throw new Error('Push keys missing');
  webpush.setVapidDetails(cfg.vapid_subject, cfg.vapid_public_key, cfg.vapid_private_key);
  configured = true;
}

async function openCount(outletId: string) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin.from('orders').select('id', { count: 'exact', head: true })
    .eq('outlet_id', outletId).in('status', ['new', 'accepted', 'ready']).gte('created_at', since);
  return count || 0;
}

async function sendTo(subs: any[], payload: Record<string, unknown>) {
  let sent = 0, removed = 0;
  const errors: string[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 3600, urgency: 'high' },
      );
      sent++;
      await admin.from('push_subscriptions').update({ last_ok_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq('id', s.id);
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) {       // device unsubscribed / app removed
        await admin.from('push_subscriptions').delete().eq('id', s.id);
        removed++;
      } else {
        errors.push(`${e?.statusCode || ''} ${String(e?.body || e?.message || e).slice(0, 120)}`);
      }
    }
  }));
  return { sent, removed, errors };
}

async function teamDevices(outletId: string) {
  const { data: members } = await admin.from('outlet_admins').select('user_id, role, permissions').eq('outlet_id', outletId);
  const ids = (members || []).filter((m: any) => m.role === 'owner' || (m.permissions || []).includes('orders')).map((m: any) => m.user_id);
  if (!ids.length) return [];
  const { data } = await admin.from('push_subscriptions').select('*').eq('outlet_id', outletId).in('user_id', ids);
  return data || [];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'METHOD' }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'BAD_REQUEST' }, 400); }

  try {
    await setup();

    // ---------------------------------------------------------------- test
    if (b.action === 'test') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      const { data: who } = await admin.auth.getUser(token);
      if (!who?.user) return json({ error: 'Please sign in again.' }, 401);
      const outletId = String(b.outlet_id || '');
      const { data: subs } = await admin.from('push_subscriptions').select('*')
        .eq('user_id', who.user.id).eq('outlet_id', outletId);
      if (!subs?.length) return json({ error: 'This device is not registered for notifications yet.' }, 400);
      const r = await sendTo(subs, {
        title: '🔔 Test notification',
        body: 'Order notifications are working on this device.',
        url: './#orders', tag: 'fbm-test',
        badge: await openCount(outletId),
      });
      return json(r);
    }

    // -------------------------------------------------------------- reminders
    if (b.action === 'remind') {
      const { data: due, error } = await admin.rpc('claim_order_reminders');
      if (error) throw error;
      let sent = 0;
      for (const d of due || []) {
        const { data: n } = await admin.rpc('order_notification', { p_order_id: d.order_id });
        if (!n) continue;
        const o = n.order;
        const where = o.location_type === 'room' ? `Room ${o.location}` : `Table ${o.location}`;
        const mins = Math.max(1, Math.round(d.waiting_seconds / 60));
        const items = n.items.map((i: any) => `${i.qty}× ${en(i.name)}`).join(', ');
        const subs = await teamDevices(d.outlet_id);
        if (!subs.length) continue;
        const r = await sendTo(subs, {
          title: `⏰ Not accepted yet: #${o.order_no} · ${where}`,
          body: `Waiting ${mins} min — ${items}`,
          url: './#orders',
          tag: `order-${o.id}-r${d.remind_count}`,       // new tag each time so the phone alerts again
          badge: await openCount(d.outlet_id),
        });
        sent += r.sent;
      }
      return json({ reminders: (due || []).length, sent });
    }

    // -------------------------------------------------------- service requests
    if (b.request_id) {
      const { data: r } = await admin.from('service_requests').select('*').eq('id', String(b.request_id)).maybeSingle();
      if (!r || r.status !== 'open' || Date.now() - new Date(r.created_at).getTime() > 5 * 60 * 1000) return json({ skipped: true });
      const where = r.location_type === 'room' ? `Room ${r.location}` : `Table ${r.location}`;
      const subs = await teamDevices(r.outlet_id);
      if (!subs.length) return json({ sent: 0, note: 'No devices registered' });
      const res = await sendTo(subs, {
        title: r.kind === 'bill' ? `🧾 ${where} asks for the bill` : `🙋 ${where} is calling a waiter`,
        body: r.note ? `📝 ${r.note}` : 'Tap to open the Orders tab.',
        url: './#orders',
        tag: `req-${r.id}`,
        badge: await openCount(r.outlet_id),
      });
      return json(res);
    }

    // ------------------------------------------------------------- new order
    const orderId = String(b.order_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(orderId)) return json({ error: 'BAD_REQUEST' }, 400);
    // Claim the order atomically so it's only pushed once, and only if recent.
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: claimed } = await admin.from('orders').update({ pushed_at: new Date().toISOString() })
      .eq('id', orderId).is('pushed_at', null).gte('created_at', since).select('id, outlet_id').maybeSingle();
    if (!claimed) return json({ skipped: true });

    const { data: n } = await admin.rpc('order_notification', { p_order_id: orderId });
    if (!n) return json({ skipped: true });
    const o = n.order;
    const where = o.location_type === 'room' ? `Room ${o.location}` : `Table ${o.location}`;
    const items = n.items.map((i: any) => `${i.qty}× ${en(i.name)}`).join(', ');
    const subs = await teamDevices(claimed.outlet_id);
    if (!subs.length) return json({ sent: 0, note: 'No devices registered' });
    const r = await sendTo(subs, {
      title: `🛎 New order #${o.order_no} · ${where}`,
      body: `${items}${o.guest_note ? ` — 📝 ${o.guest_note}` : ''} · ${n.outlet.currency} ${Number(o.subtotal).toFixed(2)}`,
      url: './#orders',
      tag: `order-${o.id}`,
      badge: await openCount(claimed.outlet_id),
    });
    return json(r);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
