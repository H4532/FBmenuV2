// FB Menus admin — shell: sign-in, outlet selection, navigation.
import { esc } from '../core/i18n.js';
import * as api from './api.js';
import { sb } from './api.js';
import { $, $$, toast, errorToast, openDialog, field } from './ui.js';
import { renderItems } from './view-items.js';
import { renderMenus } from './view-menus.js';
import { renderOptions } from './view-options.js';
import { renderSettings } from './view-settings.js';
import { renderOrders } from './view-orders.js';
import { renderUsers } from './view-users.js';
import { renderReports } from './view-reports.js';

const VIEWS = {
  orders:   { perm: 'orders',   label: 'Orders',   render: renderOrders,   icon: 'M6 17h12l-1.5-2V11a4.5 4.5 0 00-9 0v4zM10 20h4M12 4v2' },
  items:    { perm: 'dishes',   label: 'Dishes',   render: renderItems,    icon: 'M4 6h16M4 12h16M4 18h10' },
  menus:    { perm: 'menus',    label: 'Menus',    render: renderMenus,    icon: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h4' },
  options:  { perm: 'menus',    label: 'Choices',  render: renderOptions,  icon: 'M5 7h3m4 0h7M5 17h9m4 0h1M8 5v4M14 15v4' },
  reports:  { perm: 'settings', label: 'Reports',  render: renderReports,  icon: 'M4 20V10M10 20V4M16 20v-7M22 20H2' },
  users:    { perm: 'users',    label: 'Users',    render: renderUsers,    icon: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21c.8-3.5 3.6-5.5 7-5.5s6.2 2 7 5.5M17 11a3 3 0 100-6M22 21c-.5-2.6-2.2-4.2-4.5-4.8' },
  settings: { perm: 'settings', label: 'Settings', render: renderSettings, icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM4 12h2m12 0h2M12 4v2m0 12v2' },
};

const OUTLET_KEY = 'fbm:admin:outlet';

const ctx = {
  session: null,
  outlets: [],
  outlet: null,
  role: null,
  data: null,
  langs: [],
  badges: {},
  ui: {},
  reload,
};

const app = () => $('#app');

// ---------------------------------------------------------------------------
// Boot & auth
// ---------------------------------------------------------------------------
async function boot() {
  let recovering = /type=recovery/.test(location.hash);

  api.onAuth((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      recovering = true;
      showSetPassword();
    } else if (event === 'SIGNED_OUT') {
      ctx.session = null;
      showSignIn();
    } else if (session) {
      ctx.session = session;       // token refresh etc. — screens are driven by the form/boot
    }
  });

  ctx.session = await api.getSession();
  if (recovering) return;          // handled by the PASSWORD_RECOVERY event
  if (ctx.session) enter(); else showSignIn();
}

function showSignIn(message = '') {
  document.title = 'Sign in · Menu admin';
  app().innerHTML = `
    <main class="auth">
      <form class="auth-card" novalidate>
        <h1>Menu admin</h1>
        <p class="hint">Sign in to update dishes, prices and availability.</p>
        ${message ? `<p class="notice">${esc(message)}</p>` : ''}
        ${field('Email', '<input type="email" name="email" autocomplete="username" required>')}
        ${field('Password', '<input type="password" name="password" autocomplete="current-password" required>')}
        <button type="submit" class="btn btn-primary btn-block">Sign in</button>
        <button type="button" class="link-btn" data-forgot>Forgot password?</button>
      </form>
    </main>`;
  const form = $('.auth-card');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const { session } = await api.signIn(form.email.value.trim(), form.password.value);
      ctx.session = session;
      enter();
    } catch (err) {
      errorToast(err);
    } finally {
      btn.disabled = false;
    }
  });
  $('[data-forgot]', form).addEventListener('click', async () => {
    const email = form.email.value.trim();
    if (!email) { form.email.focus(); toast('Enter your email first.', 'error'); return; }
    try {
      await api.sendReset(email, location.href.split('#')[0]);
      toast('If this email has an account, a reset link is on its way.');
    } catch (err) { errorToast(err); }
  });
  form.email.focus();
}

function showSetPassword() {
  app().innerHTML = `
    <main class="auth">
      <form class="auth-card" novalidate>
        <h1>Choose a new password</h1>
        ${field('New password', '<input type="password" name="pw" autocomplete="new-password" minlength="10" required>', 'At least 10 characters.')}
        <button type="submit" class="btn btn-primary btn-block">Save password</button>
      </form>
    </main>`;
  const form = $('.auth-card');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.pw.value.length < 10) { toast('Use at least 10 characters.', 'error'); return; }
    try {
      await api.updatePassword(form.pw.value);
      history.replaceState(null, '', location.pathname);
      toast('Password saved');
      ctx.session = await api.getSession();
      enter();
    } catch (err) { errorToast(err); }
  });
}

// ---------------------------------------------------------------------------
// Outlet selection
// ---------------------------------------------------------------------------
async function enter() {
  app().innerHTML = '<main class="auth"><span class="spinner"></span></main>';
  try {
    ctx.outlets = await api.myOutlets(ctx.session.user.id);
  } catch (err) {
    errorToast(err);
    showSignIn('Could not load your outlets. Check the connection and sign in again.');
    return;
  }
  if (!ctx.outlets.length) {
    app().innerHTML = `
      <main class="auth">
        <div class="auth-card">
          <h1>No outlet linked</h1>
          <p>You’re signed in as <strong>${esc(ctx.session.user.email)}</strong>, but this account isn’t linked to a restaurant yet. Ask the platform administrator to add you.</p>
          <button type="button" class="btn btn-quiet btn-block" data-signout>Sign out</button>
        </div>
      </main>`;
    $('[data-signout]').addEventListener('click', () => api.signOut());
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem(OUTLET_KEY); } catch { /* ignore */ }
  const pick = ctx.outlets.find((o) => o.outlet.id === saved) || ctx.outlets[0];
  await selectOutlet(pick.outlet.id);
}

async function selectOutlet(id) {
  const entry = ctx.outlets.find((o) => o.outlet.id === id);
  ctx.outlet = entry.outlet;
  ctx.role = entry.role;
  ctx.perms = entry.permissions;
  ctx.ui = {};
  try { localStorage.setItem(OUTLET_KEY, id); } catch { /* ignore */ }

  // Custom badges come from the outlet's config.js (same file the guest page uses).
  ctx.badges = {};
  try {
    const mod = await import(new URL(`../../../${ctx.outlet.slug}/config.js`, import.meta.url));
    ctx.badges = mod.default?.badges || {};
  } catch { /* outlet folder not deployed yet */ }

  renderShell();
  await reload();
  sb.from('activity_log').insert({ outlet_id: entry.outlet.id, user_id: ctx.session.user.id, action: 'sign_in',
    actor_email: ctx.session.user.email, device: navigator.userAgent.slice(0, 200) }).then(() => {}).catch(() => {});
}

// ---------------------------------------------------------------------------
// Shell & routing
// ---------------------------------------------------------------------------
const can = (perm) => (ctx.perms || []).includes(perm);
const allowedViews = () => Object.keys(VIEWS).filter((k) => can(VIEWS[k].perm));

function currentView() {
  const v = location.hash.replace('#', '');
  const allowed = allowedViews();
  if (allowed.includes(v)) return v;
  if (ctx.outlet?.ordering?.enabled && allowed.includes('orders')) return 'orders';
  return allowed.includes('items') ? 'items' : allowed[0];
}

function renderShell() {
  const o = ctx.outlet;
  const name = o.name.en || Object.values(o.name)[0];
  const guestUrl = new URL(`../${o.slug}/`, location.href).href;
  document.title = `${name} · Menu admin`;

  app().innerHTML = `
    <header class="a-top">
      <div class="a-top-inner">
        <div class="a-outlet">
          ${ctx.outlets.length > 1
            ? `<select data-outlet aria-label="Outlet">${ctx.outlets.map((x) => `<option value="${x.outlet.id}" ${x.outlet.id === o.id ? 'selected' : ''}>${esc(x.outlet.name.en || Object.values(x.outlet.name)[0])}</option>`).join('')}</select>`
            : `<strong>${esc(name)}</strong>`}
          <span class="a-role">${{ owner: 'Owner', manager: 'Manager', editor: 'Menu editor', staff: 'Order staff', custom: 'Staff' }[ctx.role] || 'Staff'}</span>
        </div>
        <div class="a-top-actions">
          <a class="btn btn-small btn-on-dark" href="${guestUrl}" target="_blank" rel="noopener">View menu</a>
          <details class="a-account">
            <summary aria-label="Account">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20c1.5-4 5-5 8-5s6.5 1 8 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </summary>
            <div class="a-account-menu">
              <p class="hint">${esc(ctx.session.user.email)}</p>
              <button type="button" data-change-pw>Change password</button>
              <button type="button" data-signout>Sign out</button>
            </div>
          </details>
        </div>
      </div>
    </header>
    <nav class="a-nav" aria-label="Sections" style="--tabs:${allowedViews().length}">
      ${Object.entries(VIEWS).filter(([, v]) => can(v.perm)).map(([k, v]) => `
        <a href="#${k}" data-view="${k}" ${k === currentView() ? 'aria-current="page"' : ''}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${v.icon}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>${v.label}</span>
        </a>`).join('')}
    </nav>
    <main class="a-main"><div id="view"><div class="loading"><span class="spinner"></span></div></div></main>`;

  $('[data-outlet]')?.addEventListener('change', (e) => selectOutlet(e.target.value));
  $('[data-signout]').addEventListener('click', () => api.signOut());
  $('[data-change-pw]').addEventListener('click', changePassword);
}

async function reload({ quiet = false } = {}) {
  try {
    const all = await api.loadOutlet(ctx.outlet.id);
    ctx.outlet = all.outlet;
    const entry = ctx.outlets.find((o) => o.outlet.id === all.outlet.id);
    if (entry) entry.outlet = all.outlet;
    ctx.data = all;
    refreshBadge();
    ctx.langs = sortLangs(all.outlet.languages, all.outlet.default_language);
    if (!quiet) renderView();
  } catch (err) {
    errorToast(err);
  }
}

function sortLangs(langs, def) {
  return [def, ...langs.filter((l) => l !== def)].filter((l) => langs.includes(l));
}

function renderView() {
  if (!ctx.data) return;
  const key = currentView();
  $$('.a-nav a').forEach((a) => {
    if (a.dataset.view === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Fresh #view element each time so listeners from the previous view are dropped.
  const old = $('#view');
  const fresh = old.cloneNode(false);
  old.replaceWith(fresh);
  if (!key) { $('#view').innerHTML = '<div class="empty"><p>Your account has no rights on this restaurant yet. Ask the owner.</p></div>'; return; }
  VIEWS[key].render(ctx);
}

window.addEventListener('hashchange', () => {
  if (ctx.data) {
    renderView();
    window.scrollTo(0, 0);
  }
});

async function changePassword() {
  $('.a-account')?.removeAttribute('open');
  await openDialog({
    title: 'Change password',
    body: field('New password', '<input type="password" name="pw" autocomplete="new-password" minlength="10" required>', 'At least 10 characters.'),
    submitLabel: 'Save password',
    onSubmit: async (form) => {
      if (form.elements.pw.value.length < 10) throw new Error('Use at least 10 characters.');
      await api.updatePassword(form.elements.pw.value);
      toast('Password changed');
    },
  });
}

// App-icon badge = open orders, refreshed on start and whenever the app comes back.
async function refreshBadge() {
  if (!ctx.outlet || !(ctx.perms || []).includes('orders')) return;
  try {
    const n = await api.openOrderCount(ctx.outlet.id);
    (await import('./alerts.js')).setBadge(n);
  } catch { /* offline */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshBadge(); });

// Background worker for notifications; tapping a notification opens Orders.
import('./push.js').then((p) => p.registration()).catch(() => {});
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-orders') location.hash = '#orders';
});

boot();
