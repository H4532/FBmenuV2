// FB Menus — guest menu.
// Boot order: apply outlet branding → render cached copy instantly (if any)
// → fetch fresh data → re-render only if it changed.
import {
  chooseLanguage, setLanguage, lang, t, tr, esc, setExtraBadges,
  badgeLabel,
} from '../core/i18n.js';
import { LANG_NAMES, DIETARY } from '../core/strings.js';
import { configureFormat, price, kcalRange, time, dayList } from '../core/format.js';
import { pickCurrentMenu, isServing, nowIn, nextStartToday, describeHours } from '../core/schedule.js';
import { readCached, fetchMenu } from '../core/menu-data.js';
import { photoUrl } from '../platform.js';
import { itemSummary, openItemSheet } from './item-sheet.js';
import { locationFromUrl } from './cart.js';
import { setupOrdering, orderContext, quickAdd, renderCartBar, whereLabel, showMyOrders } from './order-ui.js';
import { savedOrders, activeOrders, watchOrders, STATUS_DOT, estimateText } from './my-orders.js';
import * as filt from './filters.js';
import * as svc from './service.js';
import { guestToast } from './order-ui.js';

const state = {
  config: null,
  data: null,
  menuId: null,
  offline: false,
  params: new URLSearchParams(location.search),
  location: null,        // {type:'table'|'room', value} from the QR code
  orderingOn: false,
  menuServing: false,
};

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------
function applyBrand(config) {
  const c = config.brand?.colors || {};
  const root = document.documentElement.style;
  const map = {
    primary: '--c-primary', primaryDeep: '--c-primary-deep', accent: '--c-accent',
    accentSoft: '--c-accent-soft', ink: '--c-ink', muted: '--c-muted', paper: '--c-paper',
  };
  for (const [key, cssVar] of Object.entries(map)) if (c[key]) root.setProperty(cssVar, c[key]);
  if (config.brand?.fontFamily) root.setProperty('--font', config.brand.fontFamily);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && c.primary) meta.content = c.primary;
  setExtraBadges(config.badges);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function startWatch() {
  if (!locationFromUrl(state.params)) return;       // plain menu link: no order tracking
  watchOrders(state.config.slug, locationFromUrl(state.params), (active, changed) => {
    for (const o of changed) {
      guestToast(`${STATUS_DOT[o.status] || ''} ${t('order_status_changed', { n: o.order_no, status: t(`status_${o.status}`) })}`);
      if (o.status === 'ready' && navigator.vibrate) navigator.vibrate([120, 60, 120]);
    }
    if (changed.length || active.length) renderNotice();
  });
}
window.addEventListener('fbm:orders', () => { if (state.data) { renderNotice(); startWatch(); } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.data) startWatch(); });

export default async function boot(config) {
  state.config = config;
  applyBrand(config);

  const cached = readCached(config.slug);
  if (cached) {
    state.data = cached;
    start();
  } else {
    renderLoading();
  }

  try {
    const fresh = await fetchMenu(config.slug);
    const changed = !cached || fresh.outlet.data_version !== cached.outlet.data_version;
    state.offline = false;
    state.data = fresh;
    if (changed) start({ keepPosition: Boolean(cached) });
    else renderNotice();
  } catch (err) {
    console.warn('Menu fetch failed:', err);
    state.offline = true;
    if (cached) renderNotice();
    else renderError();
  }

  registerServiceWorker();
  if (state.data) startWatch();
  // Refresh the "serving now" status every minute.
  setInterval(() => state.data && renderMenuTabs(), 60000);
}

async function refetch() {
  try {
    state.data = await fetchMenu(state.config.slug);
    renderAll({ keepPosition: true });
  } catch { /* keep what we have */ }
}

function start({ keepPosition = false } = {}) {
  const { outlet } = state.data;
  if (!document.documentElement.dataset.langSet) {
    setLanguage(chooseLanguage(outlet.languages, outlet.default_language), {
      remember: false, fallbackLang: outlet.default_language,
    });
    document.documentElement.dataset.langSet = '1';
  }
  configureFormat(outlet, state.config.format);
  state.location = locationFromUrl(state.params);
  state.orderingOn = setupOrdering(state, { refetch });
  const svcHost = $('#svc');
  if (state.location && outlet.ordering?.requests !== false) {
    const opts = { slug: state.config.slug, location: state.location, onToast: guestToast };
    svc.render(svcHost, opts);
    svc.watch(svcHost, opts);
  } else if (svcHost) {
    svcHost.hidden = true;
  }
  if (!state.scanLogged) { state.scanLogged = true; svc.logScan(state.config.slug, state.location, lang()); }

  const menus = state.data.menus;
  const wanted = state.params.get('m');
  const byParam = wanted && menus.find((m) => m.slug === wanted);
  const stillThere = state.menuId && menus.find((m) => m.id === state.menuId);
  state.menuId = (stillThere || byParam || pickCurrentMenu(menus, outlet.timezone) || {}).id;

  renderAll({ keepPosition });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderAll({ keepPosition = false } = {}) {
  const anchor = keepPosition ? currentSectionId() : null;
  const { outlet } = state.data;
  document.title = `${tr(state.config.brand?.name) || tr(outlet.name)} · ${t('menus')}`;

  renderHeader();
  renderNotice();
  renderMenuTabs();
  renderMenu();
  renderFooter();
  if (state.orderingOn) renderCartBar();

  if (anchor) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
}

function renderLoading() {
  $('#app-main').innerHTML = '<div class="state state-loading" aria-busy="true"><span class="spinner"></span></div>';
}

function renderError() {
  $('#app-main').innerHTML = `
    <div class="state state-error" role="alert">
      <p>${esc(t('load_error'))}</p>
      <button type="button" class="btn" id="retry">${esc(t('retry'))}</button>
    </div>`;
  $('#retry').addEventListener('click', () => location.reload());
}

function renderHeader() {
  const { outlet } = state.data;
  const brand = state.config.brand || {};
  const name = tr(brand.name) || tr(outlet.name);
  const logo = brand.logo
    ? `<img class="brand-logo" src="${esc(brand.logo)}" alt="${esc(name)}">`
    : `<span class="brand-name">${esc(name)}</span>`;

  const langs = outlet.languages.length > 1
    ? `<div class="lang-switch" role="group" aria-label="${esc(t('language'))}">
        ${outlet.languages.map((l) => `
          <button type="button" lang="${l}" data-lang="${l}" aria-pressed="${l === lang()}">
            ${esc(LANG_NAMES[l] || l.toUpperCase())}
          </button>`).join('')}
      </div>`
    : '';

  $('#app-header').innerHTML = `
    <div class="topbar-inner">
      <div class="brand">${logo}<span class="brand-sub">${esc(tr(outlet.tagline))}</span></div>
      ${langs}
    </div>`;

  $('#app-header').querySelectorAll('[data-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === lang()) return;
      setLanguage(btn.dataset.lang, { fallbackLang: outlet.default_language });
      renderAll({ keepPosition: true });
    });
  });
}

function renderNotice() {
  const el = $('#app-notice');
  const { outlet } = state.data || {};
  const notes = [];
  if (state.offline) notes.push(`<p class="notice notice-offline">${esc(t('offline'))}</p>`);
  if (state.orderingOn) notes.push(`<p class="notice notice-order">🛎 ${esc(t('ordering_for', { where: whereLabel(state.location) }))}</p>`);
  const ext = outlet?.contact?.room_service_ext;
  const fromRoom = state.params.get('src') === 'room' || state.params.has('r');
  if (fromRoom && ext) {
    notes.push(`<p class="notice notice-room">
      <strong>${esc(t('room_service'))}</strong> ${esc(t('room_service_call', { ext }))}
    </p>`);
  }
  // "My orders" and live status only when opened from a table/room QR code,
  // and only for that table/room. The plain menu link stays a plain menu.
  const here = locationFromUrl(state.params);
  const live = state.config && here ? activeOrders(state.config.slug, here) : [];
  for (const o of live.slice(0, 3)) {
    notes.push(`<button type="button" class="notice notice-live st-${esc(o.status || 'new')}" data-my-orders>
      <span class="live-dot-lg" aria-hidden="true">${STATUS_DOT[o.status || 'new']}</span>
      <span><strong>#${esc(o.order_no)}</strong> · ${esc(t(`status_${o.status || 'new'}`))}${estimateText(o) ? ` · ⏱ ${esc(estimateText(o))}` : ''}</span>
    </button>`);
  }
  const mine = state.config && here ? savedOrders(state.config.slug, here).length : 0;
  if (mine) notes.push(`<button type="button" class="notice notice-myorders" data-my-orders>🧾 ${esc(t('my_orders'))} <span>${mine}</span></button>`);
  el.innerHTML = notes.join('');
  el.hidden = notes.length === 0;
  el.querySelectorAll('[data-my-orders]').forEach((b) => b.addEventListener('click', showMyOrders));
}

function renderMenuTabs() {
  const { menus, outlet } = state.data;
  const nav = $('#menu-tabs');
  const now = nowIn(outlet.timezone);
  const current = menus.find((m) => m.id === state.menuId);

  // Hero for the selected menu
  if (current) {
    const serving = isServing(current, now);
    const next = !serving && nextStartToday(current, outlet.timezone);
    const status = serving
      ? `<span class="status status-on">${esc(t('now_serving'))}</span>`
      : `<span class="status status-off">${esc(next ? t('starts_at', { time: time(next) }) : t('not_serving'))}</span>`;
    $('#hero').innerHTML = `
      <p class="hero-line">${esc(tr(current.description) || tr(current.name))}</p>
      <div class="hero-meta">
        <h1 class="hero-menu">${esc(tr(current.name))}</h1>
        ${status}
        <span class="hero-hours">${esc(describeHours(current))}</span>
      </div>`;
  }

  if (menus.length < 2) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }
  nav.hidden = false;
  nav.innerHTML = `
    <div class="menu-tabs-inner" role="tablist" aria-label="${esc(t('menus'))}">
      ${menus.map((m) => {
        const on = isServing(m, now);
        return `
          <button type="button" role="tab" data-menu="${m.id}"
                  aria-selected="${m.id === state.menuId}" class="${on ? 'is-live' : ''}">
            <span>${esc(tr(m.name))}</span>
            ${on && m.schedules?.length ? `<span class="live-dot" title="${esc(t('now_serving'))}"></span>` : ''}
          </button>`;
      }).join('')}
    </div>`;
  nav.querySelectorAll('[data-menu]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.menuId = btn.dataset.menu;
      renderMenuTabs();
      renderMenu();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function renderMenu() {
  const { menus, items, outlet } = state.data;
  const menu = menus.find((m) => m.id === state.menuId);
  const main = $('#app-main');
  const bar = $('#cat-bar');
  if (!menu) {
    main.innerHTML = `<div class="state"><p>${esc(t('empty_menu'))}</p></div>`;
    bar.hidden = true;
    return;
  }

  const hideSoldOut = outlet.unavailable_display === 'hide';
  state.menuServing = isServing(menu, nowIn(outlet.timezone));
  const visible = (it) => it && (it.available || !hideSoldOut);
  const allInMenu = [...new Set(menu.categories.flatMap((c) => c.items))].map((id) => items[id]).filter(visible);
  const cats = menu.categories
    .map((c) => ({
      ...c,
      list: c.items.map((id) => items[id]).filter((it) => visible(it) && filt.passes(it)),
    }))
    .filter((c) => c.list.length);
  const shown = new Set(cats.flatMap((c) => c.list.map((i) => i.id))).size;

  filt.renderBar($('#filter-bar'), {
    shown, total: allInMenu.length,
    onOpen: () => filt.openSheet($('#filters'), {
      countFor: (f) => allInMenu.filter((i) => filt.passes(i, f)).length,
      onApply: () => { renderMenu(); window.scrollTo({ top: 0 }); },
    }),
  });

  // Category chips
  if (cats.length > 1) {
    bar.hidden = false;
    bar.innerHTML = `<div class="cat-bar-inner">${cats.map((c) => `
      <a href="#cat-${c.id}" data-cat="cat-${c.id}">${esc(tr(c.name))}</a>`).join('')}</div>`;
  } else {
    bar.hidden = true;
    bar.innerHTML = '';
  }

  const buffet = menu.type === 'buffet' && menu.buffet_prices.length ? renderBuffet(menu) : '';

  main.innerHTML = buffet + (cats.length
    ? cats.map(renderCategory).join('')
    : `<div class="state"><p>${esc(t(filt.active() ? 'filter_none' : 'empty_menu'))}</p></div>`);

  main.querySelectorAll('[data-item]').forEach((btn) => {
    btn.addEventListener('click', () => openItemSheet(state.data, btn.dataset.item, state.config, orderContext(state.menuServing)));
  });
  main.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', () => quickAdd(btn.dataset.quick));
  });
  bar.querySelectorAll('a[data-cat]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.cat)?.scrollIntoView({ behavior: smoothOk() ? 'smooth' : 'auto' });
    });
  });
  watchSections();
}

function renderBuffet(menu) {
  return `
    <section class="buffet" aria-labelledby="buffet-title">
      <h2 class="cat-title" id="buffet-title"><span>${esc(t('buffet_prices'))}</span></h2>
      <table class="buffet-table">
        <tbody>
          ${menu.buffet_prices.map((b) => `
            <tr>
              <th scope="row">
                ${esc(tr(b.label))}
                <span class="buffet-when">${esc(dayList(b.days))}${b.start ? ` · ${esc(time(b.start))}–${esc(time(b.end))}` : ''}</span>
                ${tr(b.note) ? `<span class="buffet-note">${esc(tr(b.note))}</span>` : ''}
              </th>
              <td>${price(b.price)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
}

function renderCategory(cat) {
  const desc = tr(cat.description);
  return `
    <section class="cat" id="cat-${cat.id}" aria-labelledby="cat-${cat.id}-title">
      <h2 class="cat-title" id="cat-${cat.id}-title"><span>${esc(tr(cat.name))}</span></h2>
      ${desc ? `<p class="cat-desc">${esc(desc)}</p>` : ''}
      <ul class="items" role="list">${cat.list.map(renderItem).join('')}</ul>
    </section>`;
}

function renderItem(item) {
  const s = itemSummary(state.data, item);
  const showPhotos = state.config.showPhotos !== false;
  const thumb = showPhotos && item.photo
    ? `<img class="item-thumb" src="${photoUrl(item.photo, 'thumb')}" alt="" loading="lazy" decoding="async" width="88" height="88">`
    : '';
  const tags = [
    ...item.badges.map((b) => `<span class="badge">${esc(badgeLabel(b))}</span>`),
    ...item.dietary.map((d) => `<span class="diet" title="${esc(tr(DIETARY[d]))}">${esc(tr(DIETARY[d]))}</span>`),
    item.spice > 0 ? `<span class="spice" aria-label="${esc(t('spice_levels')[item.spice])}">${'<i></i>'.repeat(item.spice)}</span>` : '',
  ].join('');
  const desc = tr(item.description);

  return `
    <li class="item${item.available ? '' : ' is-soldout'}">
      <button type="button" class="item-btn" data-item="${item.id}">
        <span class="item-main">
          <span class="item-name">${esc(tr(item.name))}</span>
          ${desc ? `<span class="item-desc">${esc(desc)}</span>` : ''}
          ${tags ? `<span class="item-tags">${tags}</span>` : ''}
          ${item.available ? '' : `<span class="soldout-label">${esc(t('sold_out'))}</span>`}
        </span>
        <span class="item-side">
          <span class="item-price">${s.fromPrice ? `<span class="from">${esc(t('from'))}</span> ` : ''}${price(s.minPrice)}</span>
          ${state.config.showCalories !== false && s.minKcal != null
            ? `<span class="item-kcal">${esc(kcalRange(s.minKcal, s.maxKcal))}</span>` : ''}
        </span>
        ${thumb}
      </button>
      ${state.orderingOn && state.menuServing && item.available ? `
        <button type="button" class="quick-add" ${item.option_groups.length ? `data-item="${item.id}"` : `data-quick="${item.id}"`}
                aria-label="${esc(t('add_to_order'))}: ${esc(tr(item.name))}">+</button>` : ''}
    </li>`;
}

function renderFooter() {
  const { outlet } = state.data;
  const hours = (outlet.opening_hours || []).map((h) =>
    `<li><span>${esc(dayList(h.days))}</span> <bdi>${esc(time(h.open))}–${esc(time(h.close))}</bdi></li>`).join('');
  const contact = outlet.contact || {};
  $('#app-footer').innerHTML = `
    <div class="footer-inner">
      <p class="note note-allergy">${esc(t('allergy_notice'))}</p>
      ${tr(outlet.price_note) ? `<p class="note">${esc(tr(outlet.price_note))}</p>` : ''}
      ${Number(outlet.service_charge_pct) > 0 ? `<p class="note">${esc(t('service_charge', { pct: outlet.service_charge_pct }))}</p>` : ''}
      ${tr(outlet.calorie_note) ? `<p class="note">${esc(tr(outlet.calorie_note))}</p>` : ''}
      ${hours ? `<div class="hours"><h2>${esc(t('opening_hours'))}</h2><ul role="list">${hours}</ul></div>` : ''}
      ${contact.phone ? `<p class="note"><a href="tel:${esc(contact.phone)}"><bdi>${esc(contact.phone)}</bdi></a></p>` : ''}
      <p class="property">${esc(tr(outlet.tagline))}</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Scroll spy for the category bar
// ---------------------------------------------------------------------------
let observer;
function watchSections() {
  observer?.disconnect();
  const links = [...document.querySelectorAll('#cat-bar a[data-cat]')];
  if (!links.length) return;
  const visible = new Map();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) visible.set(e.target.id, e.isIntersecting);
    const firstVisible = links.find((a) => visible.get(a.dataset.cat));
    if (!firstVisible) return;
    if (firstVisible.classList.contains('is-active')) return;
    links.forEach((a) => a.classList.toggle('is-active', a === firstVisible));
    centreChip(firstVisible);
  }, { rootMargin: '-120px 0px -55% 0px' });
  document.querySelectorAll('section.cat').forEach((s) => observer.observe(s));
}

// Centre the active chip by scrolling ONLY the horizontal chip strip.
// (scrollIntoView would also scroll the page and fight the guest's own scrolling.)
function centreChip(chip) {
  const strip = chip.parentElement;
  const c = chip.getBoundingClientRect();
  const s = strip.getBoundingClientRect();
  const delta = (c.left + c.width / 2) - (s.left + s.width / 2);
  if (Math.abs(delta) > 2) strip.scrollBy({ left: delta, behavior: smoothOk() ? 'smooth' : 'auto' });
}

function currentSectionId() {
  const sections = [...document.querySelectorAll('section.cat')];
  const top = sections.find((s) => s.getBoundingClientRect().bottom > 130);
  return top?.id || null;
}

const smoothOk = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const swUrl = new URL('../../../sw.js', import.meta.url);
  const scope = new URL('../../../', import.meta.url);
  navigator.serviceWorker.register(swUrl, { scope: scope.pathname }).catch(() => {});
}
