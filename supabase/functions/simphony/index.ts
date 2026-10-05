// FB Menus — simphony Edge Function (Oracle Simphony Transaction Services Gen2).
//  • {action:'send', order_id}              from the database when an order is accepted
//  • {action:'resend', order_id}  (staff)   retry a failed order ("Orders" right)
//  • {action:'test', outlet_id}   (staff)   sign in and list checks ("Settings" right)
//  • {action:'keepalive'}                   daily (pg_cron): renew tokens before they expire
// Accepted orders become OPEN checks in the configured revenue center; the cashier
// closes them in Simphony (room charge to Opera, cash, card) and Simphony prints the
// fiscal / ZATCA invoice as usual. idempotencyId = order id, so retries never duplicate.
// Auth follows Oracle's API-account flow (PKCE authorize → signin → token, refresh token).
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const REDIRECT = 'apiaccount://callback';
type L = Record<string, string>;
const en = (o: L | null | undefined) => (o?.en || Object.values(o || {})[0] || '') as string;
const ascii = (s: string, n: number) => String(s || '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').trim().slice(0, n);

// ------------------------------------------------------------------ auth
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function login(cfg: any, cred: any) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const auth = cfg.auth_host;
  // 1. authorize (sets session cookies)
  const a = await fetch(`${auth}/oidc-provider/v1/oauth2/authorize?response_type=code&client_id=${encodeURIComponent(cfg.client_id)}`
    + `&scope=openid&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual' });
  const cookies = (a.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  // 2. sign in with the API account
  const s = await fetch(`${auth}/oidc-provider/v1/oauth2/signin`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies },
    body: new URLSearchParams({ username: cred.username, password: cred.password, orgname: cfg.org_short_name }),
  });
  const sj = await s.json().catch(() => ({} as any));
  if (sj.nextOp === 'expired') {
    throw new Error('The Simphony API account password has expired (Oracle requires a change every 60 days). '
      + 'Reset it on the Reporting and Analytics sign-in page ("Can\'t sign in?"), then save the new password in Settings → Oracle Simphony.');
  }
  if (s.status === 401) throw new Error('Simphony rejected the API account username/password (or the account is locked for 30 min after repeated failures).');
  const code = sj.redirectUrl ? new URL(sj.redirectUrl.replace('apiaccount://', 'https://x/')).searchParams.get('code') : null;
  if (!code) throw new Error(`Simphony sign-in failed (${s.status}): ${JSON.stringify(sj).slice(0, 200)}`);
  // 3. exchange the code for tokens
  return await token(cfg, new URLSearchParams({ scope: 'openid', grant_type: 'authorization_code', code, code_verifier: verifier, client_id: cfg.client_id, redirect_uri: REDIRECT }), cookies);
}

async function token(cfg: any, body: URLSearchParams, cookies = '') {
  const r = await fetch(`${cfg.auth_host}/oidc-provider/v1/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookies ? { Cookie: cookies } : {}) }, body });
  const j = await r.json().catch(() => ({} as any));
  if (!r.ok || !j.id_token) throw new Error(`Simphony token request failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  const exp = new Date(Date.now() + (Number(j.expires_in) || 1209600) * 1000).toISOString();   // id_token: 14 days
  await db.rpc('pos_save_tokens', { p_outlet: cfg.outlet_id, p_id_token: j.id_token, p_refresh_token: j.refresh_token || null, p_expires: exp });
  return j.id_token as string;
}

async function idToken(cfg: any) {
  const { data: cred } = await db.rpc('pos_get_credentials', { p_outlet: cfg.outlet_id });
  if (!cred?.username || !cred?.password) throw new Error('No Simphony API account saved (Settings → Oracle Simphony).');
  // Oracle recommends renewing 3–7 days before the 14-day id_token expires; we renew with 5 days left.
  const renewAt = Date.now() + 5 * 24 * 3600 * 1000;
  if (cred.id_token && cred.token_expires && new Date(cred.token_expires).getTime() > renewAt) return cred.id_token;
  if (cred.refresh_token) {
    try {
      return await token(cfg, new URLSearchParams({ scope: 'openid', grant_type: 'refresh_token', refresh_token: cred.refresh_token,
        client_id: cfg.client_id, redirect_uri: REDIRECT }));
    }
    catch { /* fall back to a full sign-in */ }
  }
  return await login(cfg, cred);
}

async function sts(cfg: any, method: string, path: string, body?: unknown) {
  const t = await idToken(cfg);
  const r = await fetch(`${cfg.api_host}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', Accept: 'application/json',
      'Simphony-OrgShortName': cfg.org_short_name, 'Simphony-LocRef': cfg.loc_ref, 'Simphony-RvcRef': String(cfg.rvc_ref),
      'Simphony-Features': 'detect-duplicate-request',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Simphony ${r.status}: ${typeof data === 'string' ? data.slice(0, 250) : JSON.stringify(data).slice(0, 250)}`);
  return data;
}

// ------------------------------------------------------------------ build a check
async function buildCheck(cfg: any, orderId: string) {
  const { data: o } = await db.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  const ids = [...new Set((o.order_items || []).map((i: any) => i.item_id).filter(Boolean))];
  const { data: items } = await db.from('items').select('id, pos_item_no, name').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
  const posNo = Object.fromEntries((items || []).map((i: any) => [i.id, i.pos_item_no]));
  const missing = (o.order_items || []).filter((i: any) => !/^\d+$/.test(String(posNo[i.item_id] || '')));
  if (missing.length) throw new Error(`No Simphony item no. for: ${[...new Set(missing.map((i: any) => en(i.name)))].join(', ')} (set it in Dishes).`);
  const isRoom = o.location_type === 'room';
  const where = `${isRoom ? 'ROOM' : 'TABLE'} ${o.location}`;
  const info = [`WEB ORDER #${o.order_no} - ${where}`];
  if (o.guest_name) info.push(`Guest: ${ascii(o.guest_name, 30)}`);
  if (o.guest_note) info.push(`Note: ${ascii(o.guest_note, 60)}`);
  return {
    order: o,
    check: {
      header: {
        orgShortName: cfg.org_short_name, locRef: cfg.loc_ref, rvcRef: cfg.rvc_ref,
        idempotencyId: String(o.id).replace(/-/g, ''),
        checkEmployeeRef: cfg.employee_ref,
        orderTypeRef: isRoom && cfg.room_order_type_ref ? cfg.room_order_type_ref : cfg.order_type_ref,
        checkName: ascii(`WEB${o.order_no} ${isRoom ? 'R' : 'T'}${o.location}`, 20),
        ...(isRoom ? {} : { tableName: String(o.location) }),
        guestCount: 1,
        isTrainingCheck: Boolean(cfg.training_mode),
        informationLines: info,
      },
      menuItems: (o.order_items || []).map((i: any) => ({
        menuItemId: Number(posNo[i.item_id]),
        quantity: i.qty,
        ...(i.note || (i.options || []).length
          ? { referenceText: ascii([...(i.options || []).map((x: any) => en(x.option)), i.note].filter(Boolean).join(' / '), 20) } : {}),
      })),
    },
  };
}

async function send(orderId: string) {
  const { data: o } = await db.from('orders').select('id, outlet_id, status, pos_status').eq('id', orderId).single();
  if (!o || !['accepted', 'ready', 'served'].includes(o.status)) return { skipped: 'not accepted' };
  if (o.pos_status === 'sent') return { skipped: 'already sent' };
  const { data: cfg } = await db.from('pos_settings').select('*').eq('outlet_id', o.outlet_id).single();
  if (!cfg?.enabled) { await db.from('orders').update({ pos_status: 'skipped' }).eq('id', orderId); return { skipped: 'disabled' }; }
  try {
    const { check } = await buildCheck(cfg, orderId);
    const res = await sts(cfg, 'POST', '/checks', check);
    await db.from('orders').update({
      pos_status: 'sent', pos_check_ref: res?.header?.checkRef || null, pos_check_number: res?.header?.checkNumber || null,
      pos_error: null, pos_sent_at: new Date().toISOString(),
    }).eq('id', orderId);
    return { sent: true, checkNumber: res?.header?.checkNumber };
  } catch (e) {
    await db.from('orders').update({ pos_status: 'failed', pos_error: String((e as Error).message || e).slice(0, 300) }).eq('id', orderId);
    return { sent: false, error: String((e as Error).message || e) };
  }
}

async function staff(req: Request, outletId: string, perm: string) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data } = await db.auth.getUser(t);
  if (!data?.user) return false;
  const { data: m } = await db.from('outlet_admins').select('role, permissions').eq('outlet_id', outletId).eq('user_id', data.user.id).maybeSingle();
  return Boolean(m && (m.role === 'owner' || (m.permissions || []).includes(perm)));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let b: any; try { b = await req.json(); } catch { return json({ error: 'BAD_REQUEST' }, 400); }
  try {
    if (b.action === 'send') return json(await send(String(b.order_id)));
    if (b.action === 'keepalive') {
      const { data: outlets } = await db.from('pos_settings').select('*').eq('enabled', true);
      const out: Record<string, string> = {};
      for (const cfg of outlets || []) {
        try { await idToken(cfg); out[cfg.outlet_id] = 'ok'; }
        catch (e) {
          out[cfg.outlet_id] = String((e as Error).message || e);
          await db.from('pos_settings').update({ last_test_at: new Date().toISOString(), last_test_result: `FAILED (daily renewal) — ${out[cfg.outlet_id].slice(0, 250)}` }).eq('outlet_id', cfg.outlet_id);
        }
      }
      return json(out);
    }
    if (b.action === 'resend') {
      const { data: o } = await db.from('orders').select('outlet_id').eq('id', String(b.order_id)).single();
      if (!o || !(await staff(req, o.outlet_id, 'orders'))) return json({ error: 'FORBIDDEN' }, 403);
      await db.from('orders').update({ pos_status: 'pending' }).eq('id', String(b.order_id)).neq('pos_status', 'sent');
      return json(await send(String(b.order_id)));
    }
    if (b.action === 'test') {
      const outletId = String(b.outlet_id);
      if (!(await staff(req, outletId, 'settings'))) return json({ error: 'FORBIDDEN' }, 403);
      const { data: cfg } = await db.from('pos_settings').select('*').eq('outlet_id', outletId).single();
      let result: string;
      try {
        for (const k of ['api_host', 'auth_host', 'client_id', 'org_short_name', 'loc_ref', 'rvc_ref']) if (!cfg?.[k]) throw new Error(`Fill in ${k.replace(/_/g, ' ')} first.`);
        const disc = await fetch(`${cfg.auth_host}/oidc-provider/v1/.well-known/openid-configuration`).catch(() => null);
        if (!disc || !disc.ok) throw new Error(`Auth host not recognised: ${cfg.auth_host}/oidc-provider/v1/.well-known/openid-configuration did not answer. Check the Auth host with IHG IT/Oracle.`);
        const r = await sts(cfg, 'GET', '/checks');
        result = `OK — connected to ${cfg.org_short_name}/${cfg.loc_ref} RVC ${cfg.rvc_ref}; ${Array.isArray(r?.checks) ? r.checks.length : 0} open check(s) visible.`;
      } catch (e) { result = `FAILED — ${String((e as Error).message || e).slice(0, 280)}`; }
      await db.from('pos_settings').update({ last_test_at: new Date().toISOString(), last_test_result: result }).eq('outlet_id', outletId);
      return json({ result });
    }
    return json({ error: 'UNKNOWN_ACTION' }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
