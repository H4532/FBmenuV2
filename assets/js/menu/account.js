// FB Menus — guest accounts on the menu page.
// • Sign in with Google / Apple / Facebook (buttons appear automatically for the
//   providers switched on in Supabase), or e-mail + password.
// • Favourites, order history (all outlets), loyalty points, diet/allergy preferences
//   (applied to the menu filters automatically).
// supabase-js is loaded only when needed, so the menu stays light on hotel Wi-Fi.
// Guests use their own session key, separate from staff sessions in the admin.
import { SUPABASE_URL, SUPABASE_KEY } from '../platform.js';
import { t, tr, esc, lang } from '../core/i18n.js';
import { ALLERGENS, DIETARY } from '../core/strings.js';
import { price } from '../core/format.js';

const STORAGE_KEY = 'fbm-guest-auth';
const PROVIDERS = {
  google:   { label: 'Google',   icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h6c-.3 1.4-1.1 2.5-2.2 3.3v2.7h3.6c2-1.9 3.2-4.7 3.2-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1-3.7 1-2.8 0-5.2-1.9-6.1-4.5H2.2v2.8C4 20.5 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.9 14.1c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7.1H2.2C1.4 8.6 1 10.3 1 12s.4 3.4 1.2 4.9l3.7-2.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .6 4.1 1.6l3.1-3.1C17.5 2.1 15 1 12 1 7.7 1 4 3.5 2.2 7.1l3.7 2.8C6.8 7.3 9.2 5.4 12 5.4z"/></svg>' },
  apple:    { label: 'Apple',    icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.5 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.8 5c.7-.9 1.2-2.1 1.1-3.3-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.1.1 2.3-.6 3-1.5z"/></svg>' },
  facebook: { label: 'Facebook', icon: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="#1877F2" d="M24 12a12 12 0 10-13.9 11.9v-8.4H7.1V12h3V9.4c0-3 1.8-4.7 4.5-4.7 1.3 0 2.7.2 2.7.2v3h-1.5c-1.5 0-2 .9-2 1.9V12h3.3l-.5 3.5h-2.8v8.4A12 12 0 0024 12z"/></svg>' },
};

let sb = null;            // supabase client (lazy)
let session = null;
let profile = null;
let favorites = new Set();
let enabledProviders = null;
let ctx = null;           // { slug, outletId, data(), onPrefs(prefs), addToCart(itemId), canOrder(), toast(msg), rerender() }

const $ = (sel, root = document) => root.querySelector(sel);
const hasStoredSession = () => { try { return Boolean(localStorage.getItem(STORAGE_KEY)); } catch { return false; } };
const returningFromOAuth = () => /[?&]code=|access_token=/.test(location.search + location.hash);

function loadScript(src) {
  return new Promise((res, rej) => {
    if (window.supabase?.createClient) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('load'));
    document.head.append(s);
  });
}

async function client() {
  if (sb) return sb;
  await loadScript(new URL('../../vendor/supabase-2.117.2.js', import.meta.url).href);
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { storageKey: STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  sb.auth.onAuthStateChange((_e, s) => { session = s; });
  return sb;
}

async function providers() {
  if (enabledProviders) return enabledProviders;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_KEY } });
    const d = await r.json();
    enabledProviders = Object.keys(PROVIDERS).filter((p) => d.external?.[p]);
  } catch { enabledProviders = []; }
  return enabledProviders;
}

// ------------------------------------------------------------------ public API
export const signedIn = () => Boolean(session?.user);
export const isFavorite = (itemId) => favorites.has(itemId);

/** Call once after the menu data is ready. Restores a session without loading supabase-js unless needed. */
export async function init(options) {
  ctx = options;
  renderButton();
  if (!hasStoredSession() && !returningFromOAuth()) return;
  try {
    await client();
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (returningFromOAuth()) history.replaceState(null, '', location.pathname + location.search.replace(/[?&]code=[^&]+/, '').replace(/^&/, '?') + location.hash.replace(/#.*access_token.*/, ''));
    if (session) { await loadProfile(); if (returningFromOAuth()) ctx.toast(t('acc_welcome')); }
  } catch { /* offline: stay signed out for now */ }
  renderButton();
  ctx.rerender();
}

export async function toggleFavorite(itemId) {
  if (!signedIn()) { ctx.toast(t('acc_signin_to_save')); return open(); }
  try {
    if (favorites.has(itemId)) {
      await sb.from('guest_favorites').delete().eq('item_id', itemId).eq('user_id', session.user.id);
      favorites.delete(itemId); ctx.toast(t('acc_fav_removed'));
    } else {
      await sb.from('guest_favorites').insert({ user_id: session.user.id, outlet_id: ctx.outletId, item_id: itemId });
      favorites.add(itemId); ctx.toast(t('acc_fav_added'));
    }
    ctx.rerender();
  } catch { ctx.toast(t('acc_err_generic')); }
}

/** After an order is sent: attach it to the signed-in guest. */
export async function linkOrder(orderId) {
  if (!signedIn()) return;
  try { await sb.rpc('link_order_to_guest', { p_order: orderId }); } catch { /* best effort */ }
}

// ------------------------------------------------------------------ internals
async function loadProfile() {
  const uid = session.user.id;
  const [{ data: p }, { data: favs }] = await Promise.all([
    sb.from('guest_profiles').select('*').eq('user_id', uid).maybeSingle(),
    sb.from('guest_favorites').select('item_id').eq('user_id', uid),
  ]);
  profile = p;
  if (!profile) {           // first sign-in with Google/Apple/Facebook: create the profile
    const meta = session.user.user_metadata || {};
    const name = meta.full_name || meta.name || meta.display_name || null;
    const { data } = await sb.from('guest_profiles').insert({ user_id: uid, display_name: name, preferred_lang: lang() }).select().single();
    profile = data;
  }
  favorites = new Set((favs || []).map((f) => f.item_id));
  if (profile && (profile.diet?.length || profile.allergens?.length)) ctx.onPrefs({ diet: profile.diet || [], hide: profile.allergens || [] });
}

export function refreshButton() { renderButton(); }

function renderButton() {
  const host = $('#acc-btn-host');
  if (!host) return;
  const name = profile?.display_name || session?.user?.email?.split('@')[0] || '';
  host.innerHTML = `
    <button type="button" class="acc-btn${signedIn() ? ' is-in' : ''}" data-open-account aria-label="${esc(t('account'))}">
      ${signedIn() ? `<span class="acc-initial">${esc((name || '?').slice(0, 1).toUpperCase())}</span>`
        : '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20c1.5-4 5-5 8-5s6.5 1 8 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'}
    </button>`;
  host.querySelector('[data-open-account]').addEventListener('click', open);
}

export async function open() {
  const dlg = $('#account');
  dlg.innerHTML = `<div class="sheet"><div class="sheet-body"><div class="state"><span class="spinner"></span></div></div></div>`;
  if (!dlg.open) dlg.showModal();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  try { await client(); } catch { dlg.close(); ctx.toast(t('acc_err_generic')); return; }
  if (signedIn()) return drawProfile(dlg);
  drawSignIn(dlg, 'signin');
}

function shell(inner) {
  return `
    <div class="sheet" role="document">
      <button type="button" class="sheet-close" data-close aria-label="${esc(t('close'))}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="sheet-body acc">${inner}</div>
    </div>`;
}

async function drawSignIn(dlg, mode, error = '') {
  const list = await providers();
  dlg.innerHTML = shell(`
    <h2 class="sheet-title">${esc(t('acc_title'))}</h2>
    <p class="muted">${esc(t('acc_benefits'))}</p>
    ${list.length ? `<div class="social">${list.map((p) => `
      <button type="button" class="social-btn social-${p}" data-oauth="${p}">${PROVIDERS[p].icon}<span>${esc(t('acc_continue_with', { p: PROVIDERS[p].label }))}</span></button>`).join('')}</div>
      <p class="acc-or"><span>${esc(t('acc_or'))}</span></p>` : ''}
    <div class="seg-guest" role="tablist">
      <button type="button" role="tab" data-mode="signin" aria-selected="${mode === 'signin'}">${esc(t('acc_signin'))}</button>
      <button type="button" role="tab" data-mode="create" aria-selected="${mode === 'create'}">${esc(t('acc_create'))}</button>
    </div>
    <form class="acc-form" novalidate>
      ${mode === 'create' ? `<label class="field-note"><span>${esc(t('acc_name'))}</span><input name="name" maxlength="60" autocomplete="name"></label>` : ''}
      <label class="field-note"><span>${esc(t('acc_email'))}</span><input name="email" type="email" autocomplete="email" required dir="ltr"></label>
      <label class="field-note"><span>${esc(t('acc_password'))}</span><input name="password" type="password" minlength="8" dir="ltr"
        autocomplete="${mode === 'create' ? 'new-password' : 'current-password'}" required>
        ${mode === 'create' ? `<small class="muted">${esc(t('acc_password_hint'))}</small>` : ''}</label>
      ${error ? `<p class="cart-error" role="alert">${esc(error)}</p>` : ''}
      <button type="submit" class="btn-send">${esc(mode === 'create' ? t('acc_create') : t('acc_signin'))}</button>
    </form>`);
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => drawSignIn(dlg, b.dataset.mode); });
  dlg.querySelectorAll('[data-oauth]').forEach((b) => {
    b.onclick = () => sb.auth.signInWithOAuth({ provider: b.dataset.oauth, options: { redirectTo: location.href.split('#')[0] } });
  });
  const form = dlg.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim(); const password = form.password.value;
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      if (mode === 'create') {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/guest-register`, {
          method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, name: form.name?.value.trim() || '', lang: lang() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { const m = t(`acc_err_${d.error}`); return drawSignIn(dlg, mode, m.startsWith('acc_err_') ? t('acc_err_generic') : m); }
      }
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) return drawSignIn(dlg, 'signin', t('acc_err_LOGIN'));
      session = data.session;
      await loadProfile();
      renderButton(); ctx.rerender();
      ctx.toast(t('acc_welcome'));
      drawProfile(dlg);
    } catch { drawSignIn(dlg, mode, t('acc_err_generic')); }
  };
}

async function drawProfile(dlg) {
  const [{ data: history }, { data: pts }] = await Promise.all([
    sb.rpc('my_guest_orders', { p_limit: 20 }),
    sb.from('guest_points').select('points').eq('user_id', session.user.id),
  ]);
  const points = (pts || []).reduce((s, r) => s + r.points, 0);
  const data = ctx.data();
  const favs = [...favorites].map((id) => data.items[id]).filter(Boolean);
  const name = profile?.display_name || session.user.email.split('@')[0];
  const diet = new Set(profile?.diet || []); const hide = new Set(profile?.allergens || []);

  dlg.innerHTML = shell(`
    <h2 class="sheet-title">${esc(t('acc_hello', { name }))}</h2>
    <p class="muted" dir="ltr">${esc(session.user.email || '')}</p>
    <div class="points-card"><span>${esc(t('acc_points'))}</span><strong>${points}</strong><small>${esc(t('acc_points_hint'))}</small></div>

    <section><h3>${esc(t('acc_favorites'))}</h3>
      ${favs.length ? `<ul class="acc-list" role="list">${favs.map((i) => `
        <li><span>${esc(tr(i.name))}</span><span class="acc-list-side">${price(i.price)}
          ${ctx.canOrder() && i.available && !i.option_groups.length ? `<button type="button" class="btn-ghost btn-mini" data-fav-add="${i.id}">+ ${esc(t('acc_add'))}</button>` : ''}
          <button type="button" class="icon-heart is-on" data-fav-del="${i.id}" aria-label="♡">♥</button></span></li>`).join('')}</ul>`
        : `<p class="muted">${esc(t('acc_no_favorites'))}</p>`}
    </section>

    <section><h3>${esc(t('acc_prefs'))}</h3><p class="muted">${esc(t('acc_prefs_hint'))}</p>
      <div class="fpick">${Object.keys(DIETARY).map((k) => `<label class="fopt"><input type="checkbox" data-pdiet="${k}" ${diet.has(k) ? 'checked' : ''}><span>${esc(tr(DIETARY[k]))}</span></label>`).join('')}</div>
      <div class="fpick" style="margin-top:.4rem">${Object.keys(ALLERGENS).map((k) => `<label class="fopt fopt-no"><input type="checkbox" data-phide="${k}" ${hide.has(k) ? 'checked' : ''}><span>${esc(tr(ALLERGENS[k]))}</span></label>`).join('')}</div>
    </section>

    <section><h3>${esc(t('acc_history'))}</h3>
      ${(history || []).length ? `<ul class="acc-list" role="list">${history.map((o) => `
        <li><span><strong>#${o.order_no}</strong> · ${esc(tr(o.outlet.name))}<br><small class="muted">${esc(new Date(o.created_at).toLocaleDateString(lang() === 'ar' ? 'ar-SA-u-ca-gregory' : lang(), { day: 'numeric', month: 'short', year: 'numeric' }))}
          · ${esc(o.items.map((x) => `${x.qty}× ${tr(x.name)}`).join(', '))}</small></span>
          <span class="acc-list-side">${price(o.subtotal)}${o.points ? `<small class="muted">+${o.points}</small>` : ''}</span></li>`).join('')}</ul>`
        : `<p class="muted">${esc(t('acc_no_history'))}</p>`}
    </section>
    <button type="button" class="link-quiet" data-signout>${esc(t('acc_signout'))}</button>`);

  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('[data-signout]').onclick = async () => {
    await sb.auth.signOut(); session = null; profile = null; favorites = new Set();
    renderButton(); ctx.rerender(); dlg.close();
  };
  dlg.querySelectorAll('[data-fav-del]').forEach((b) => { b.onclick = async () => { await toggleFavorite(b.dataset.favDel); drawProfile(dlg); }; });
  dlg.querySelectorAll('[data-fav-add]').forEach((b) => { b.onclick = () => ctx.addToCart(b.dataset.favAdd); });
  const savePrefs = async () => {
    const d = [...dlg.querySelectorAll('[data-pdiet]:checked')].map((x) => x.dataset.pdiet);
    const h = [...dlg.querySelectorAll('[data-phide]:checked')].map((x) => x.dataset.phide);
    try {
      const { data: p } = await sb.from('guest_profiles').update({ diet: d, allergens: h }).eq('user_id', session.user.id).select().single();
      profile = p; ctx.onPrefs({ diet: d, hide: h }); ctx.toast(t('acc_prefs_saved'));
    } catch { ctx.toast(t('acc_err_generic')); }
  };
  dlg.querySelectorAll('[data-pdiet],[data-phide]').forEach((c) => { c.onchange = savePrefs; });
}
