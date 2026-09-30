// FB Menus — guest-register Edge Function.
// Creates a guest account that is confirmed immediately (no e-mail round-trip),
// then the phone signs in with the same e-mail/password. Rate-limited per IP.
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
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'METHOD' }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'BAD_REQUEST' }, 400); }

  const email = String(b.email || '').trim().toLowerCase();
  const password = String(b.password || '');
  const name = String(b.name || '').trim().slice(0, 60);
  const lang = ['ar', 'en', 'fr'].includes(b.lang) ? b.lang : null;
  if (!EMAIL.test(email) || email.length > 120) return json({ error: 'BAD_EMAIL' }, 422);
  if (password.length < 8 || password.length > 72) return json({ error: 'WEAK_PASSWORD' }, 422);

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const { data: allowed } = await admin.rpc('guest_signup_allowed', { p_ip: ip });
  if (!allowed) return json({ error: 'RATE_LIMIT' }, 429);

  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { display_name: name || null, guest: true },
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message)) return json({ error: 'EXISTS' }, 409);
    console.error(error);
    return json({ error: 'FAILED' }, 400);
  }
  await admin.from('guest_profiles').insert({ user_id: data.user.id, display_name: name || null, preferred_lang: lang });
  return json({ ok: true });
});
