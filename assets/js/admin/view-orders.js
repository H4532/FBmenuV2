// FB Menus admin — Orders: live list of guest orders from table/room QR codes.
import { esc } from '../core/i18n.js';
import * as api from './api.js';
import { $, $$, toast, errorToast, money } from './ui.js';
import * as push from './push.js';
import * as alerts from './alerts.js';

const POLL_MS = 15000;
const NEXT = { new: 'accepted', accepted: 'ready', ready: 'served' };
const LABEL = { new: 'New', accepted: 'Accepted', ready: 'Ready', served: 'Served', cancelled: 'Cancelled' };
const DOT = { new: '🟡', accepted: '🔵', ready: '🟢', served: '⚪', cancelled: '🔴' };
let activationWarned = false;
let TZ = 'Asia/Riyadh';
const clock = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const ACTION = { new: 'Accept', accepted: 'Mark ready', ready: 'Mark served' };

let timer = null;
let seen = new Set();
let filter = 'active';

const en = (o) => o?.en || o?.ar || Object.values(o || {})[0] || '';
const ar = (o) => o?.ar || '';

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return clock(iso);
}

export function renderOrders(ctx) {
  const root = $('#view');
  root.dataset.view = 'orders';
  TZ = ctx.outlet.timezone || TZ;
  const enabled = Boolean(ctx.outlet.ordering?.enabled);
  root.innerHTML = `
    <div class="view-head">
      <h1>Orders</h1>
      <div class="seg" role="tablist" aria-label="Filter">
        <button type="button" role="tab" data-filter="active" aria-selected="${filter === 'active'}">Open</button>
        <button type="button" role="tab" data-filter="all" aria-selected="${filter === 'all'}">All today</button>
      </div>
    </div>
    ${enabled ? '' : `<p class="notice">Guests can’t order yet. Turn on <strong>Take orders</strong> in Settings.</p>`}
    <div class="push-box" id="push-box"></div>
    <details class="sound-box" id="sound-box"></details>
    <p class="hint">Updates every 15 seconds. New orders play your alert sound and show at the top.</p>
    <div id="requests-list"></div>
    <div id="orders-list"><div class="loading"><span class="spinner"></span></div></div>`;

  $$('[data-filter]', root).forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    $$('[data-filter]', root).forEach((x) => x.setAttribute('aria-selected', x === b));
    refresh(ctx, false);
  }));
  root.addEventListener('click', (e) => onAction(ctx, e));

  renderPushBox(ctx);
  renderSoundBox();
  clearInterval(timer);
  seen = new Set();
  refresh(ctx, true);
  timer = setInterval(() => {
    if ($('#view')?.dataset.view !== 'orders') { clearInterval(timer); document.title = document.title.replace(/^\(\d+\) /, ''); return; }
    refresh(ctx, false);
  }, POLL_MS);
}

async function refresh(ctx, first) {
  const since = new Date();
  since.setHours(since.getHours() - 18);          // "today" for a restaurant day incl. late night
  let orders;
  try {
    orders = await api.loadOrders(ctx.outlet.id, since.toISOString());
  } catch (err) {
    if (first) errorToast(err);
    return;
  }
  // Waiter / bill requests (shown above the orders).
  let requests = [];
  try { requests = await api.loadOpenRequests(ctx.outlet.id); } catch { /* keep going */ }
  const freshReq = requests.filter((r) => !seen.has(r.id));
  requests.forEach((r) => seen.add(r.id));
  renderRequests(ctx, requests);
  if (!first && freshReq.length) {
    const r = freshReq[0];
    toast(`${r.kind === 'bill' ? '🧾' : '🙋'} ${r.location_type === 'room' ? 'Room' : 'Table'} ${r.location}: ${r.kind === 'bill' ? 'bill requested' : 'calling a waiter'}`);
    alerts.play();
  }

  const fresh = orders.filter((o) => !seen.has(o.id));
  const hasFreshNew = !first && fresh.some((o) => o.status === 'new');
  const waiting = orders.filter((o) => o.status === 'new').length;
  if (hasFreshNew) toast(`New order #${fresh[0].order_no}`);
  // Sound: every new order, and (if "repeat" is on) every refresh while any order is still New.
  if (hasFreshNew || (!first && waiting && alerts.getSettings().repeat)) alerts.play();
  orders.forEach((o) => seen.add(o.id));

  const open = orders.filter((o) => ['new', 'accepted', 'ready'].includes(o.status));
  alerts.setBadge(open.length);
  const newCount = orders.filter((o) => o.status === 'new').length;
  document.title = `${newCount ? `(${newCount}) ` : ''}${document.title.replace(/^\(\d+\) /, '')}`;
  const list = filter === 'active' ? open : orders;
  const host = $('#orders-list');
  if (!host) return;
  host.innerHTML = list.length
    ? `<div class="order-grid">${list.map(card).join('')}</div>`
    : `<div class="empty"><p>${filter === 'active' ? 'No open orders.' : 'No orders today yet.'}</p></div>`;
}

function card(o) {
  const where = o.location_type === 'room' ? `Room ${o.location}` : `Table ${o.location}`;
  const items = (o.order_items || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const dot = (st) => `<i class="sd sd-${st}" aria-hidden="true"></i>`;
  const timeline = (o.status_history || []).map((h) =>
    `<span class="tl tl-${h.status}">${dot(h.status)}${LABEL[h.status] || h.status} <small>${clock(h.at)}</small></span>`).join('<span class="tl-arrow">→</span>');
  const mail = o.notified_at
    ? '<span class="tag tag-info">E-mailed</span>'
    : (o.notify_error ? `<span class="tag tag-warn" title="${esc(o.notify_error)}">E-mail not sent</span>` : '');
  return `
    <article class="order-card st-${o.status}" data-order="${o.id}">
      <header class="order-band">
        <div class="ob-main">
          <strong class="order-no">#${o.order_no}</strong>
          <span class="order-where">${esc(where)}</span>
        </div>
        <div class="ob-side">
          <span class="ob-status">${dot(o.status)}${LABEL[o.status]}</span>
          <span class="ob-ago">${esc(ago(o.created_at))}</span>
        </div>
      </header>
      <div class="order-body">
        ${timeline ? `<p class="order-timeline">${timeline}</p>` : ''}
        ${o.guest_name ? `<p class="order-guest">Guest: <strong>${esc(o.guest_name)}</strong></p>` : ''}
        <table class="order-table">
          <thead><tr><th>Qty</th><th>Item</th><th class="num">Amount</th></tr></thead>
          <tbody>
            ${items.map((i) => `
              <tr>
                <td class="oi-qty">${i.qty}×</td>
                <td>
                  <span class="oi-name">${esc(en(i.name))}</span>${ar(i.name) ? ` <span class="nm-sub" dir="rtl">${esc(ar(i.name))}</span>` : ''}
                  ${(i.options || []).length ? `<span class="oi-opts">${i.options.map((x) => `${esc(en(x.group))}: <b>${esc(en(x.option))}</b>`).join(' · ')}</span>` : ''}
                  ${i.note ? `<span class="oi-note">📝 ${esc(i.note)}</span>` : ''}
                </td>
                <td class="num">${money(i.line_total)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr><td></td><td>Total <small>(${o.item_count} items)</small></td><td class="num">${money(o.subtotal)}</td></tr></tfoot>
        </table>
        ${o.guest_note ? `<p class="oi-note order-note">📝 ${esc(o.guest_note)}</p>` : ''}
        ${etaBlock(o)}
        <footer class="order-foot">
          <span class="order-mail">${mail}${posChip(o)}</span>
          <span class="order-actions">
            ${['accepted', 'ready', 'served'].includes(o.status) ? `<button type="button" class="btn btn-small btn-quiet" data-reprint="${o.id}" title="Print the kitchen tickets again">🖨️ Reprint</button>` : ''}
            ${['new', 'accepted'].includes(o.status) ? `<button type="button" class="btn btn-small btn-st btn-st-cancelled" data-status="cancelled" data-id="${o.id}">${dot('cancelled')}Cancel</button>` : ''}
            ${NEXT[o.status] ? `<button type="button" class="btn btn-small btn-st btn-st-${NEXT[o.status]}" data-status="${NEXT[o.status]}" data-id="${o.id}">${dot(NEXT[o.status])}${ACTION[o.status]}</button>` : ''}
          </span>
        </footer>
      </div>
    </article>`;
}

function posChip(o) {
  if (!o.pos_status || o.pos_status === 'skipped') return '';
  if (o.pos_status === 'sent') return ` <span class="tag tag-info" title="Simphony check ${esc(o.pos_check_ref || '')}">POS ✓ check ${esc(o.pos_check_number ?? '')}</span>`;
  if (o.pos_status === 'pending') return ' <span class="tag">POS sending…</span>';
  return ` <span class="tag tag-warn" title="${esc(o.pos_error || '')}">POS failed</span> <button type="button" class="btn btn-small btn-quiet" data-pos-resend="${o.id}">Send to Simphony again</button>`;
}

function etaBlock(o) {
  if (o.status === 'new' || o.status === 'accepted') {
    const v = o.estimated_minutes ?? '';
    const label = o.status === 'new' ? 'Estimated time' : 'Adjust: ready in';
    return `
      <div class="eta-edit" data-eta-for="${o.id}">
        <span class="eta-label">⏱ ${label}</span>
        <button type="button" class="eta-step" data-eta-step="-5" aria-label="5 minutes less">−5</button>
        <input type="number" min="0" max="480" step="1" inputmode="numeric" value="${v}" data-eta-input aria-label="Minutes">
        <span class="eta-unit">min</span>
        <button type="button" class="eta-step" data-eta-step="5" aria-label="5 minutes more">+5</button>
        ${o.status === 'accepted' && o.ready_by ? `<span class="eta-ready">Ready by <strong>${clock(o.ready_by)}</strong></span>` : ''}
        ${o.status === 'accepted' ? '<button type="button" class="btn btn-small btn-quiet" data-eta-save>Update</button>' : ''}
      </div>`;
  }
  if (o.ready_by) return `<p class="eta-ready eta-past">⏱ Was due ${clock(o.ready_by)}</p>`;
  return '';
}

function readEta(card) {
  const input = card.querySelector('[data-eta-input]');
  if (!input || input.value === '') return null;
  const n = Math.round(Number(input.value));
  if (!Number.isFinite(n) || n < 0 || n > 480) throw new Error('Estimated time must be between 0 and 480 minutes.');
  return n;
}

async function onAction(ctx, e) {
  const step = e.target.closest('[data-eta-step]');
  if (step) {
    const input = step.closest('.eta-edit').querySelector('[data-eta-input]');
    input.value = Math.max(0, Math.min(480, (Number(input.value) || 0) + Number(step.dataset.etaStep)));
    return;
  }
  const saveEta = e.target.closest('[data-eta-save]');
  if (saveEta) {
    const card = saveEta.closest('.order-card');
    try {
      await api.setOrderEstimate(card.dataset.order, readEta(card));
      toast('Estimated time updated');
      api.notifyStatus(card.dataset.order).catch(() => {});
      refresh(ctx, false);
    } catch (err) { errorToast(err); }
    return;
  }
  const pr = e.target.closest('[data-pos-resend]');
  if (pr) {
    pr.disabled = true;
    try {
      const r = await api.resendToPos(pr.dataset.posResend);
      toast(r.sent ? `Sent to Simphony — check ${r.checkNumber ?? ''}` : `Simphony: ${r.error || r.skipped}`, r.sent ? 'ok' : 'error');
    } catch (err) { errorToast(err); }
    refresh(ctx, false);
    return;
  }
  const rp = e.target.closest('[data-reprint]');
  if (rp) {
    try {
      const n = await api.reprintOrder(rp.dataset.reprint);
      toast(n ? `Reprint sent to ${n} printer${n > 1 ? 's' : ''}` : 'No printer is set up for these dishes (Printers tab).', n ? 'ok' : 'error');
    } catch (err) { errorToast(err); }
    return;
  }
  const btn = e.target.closest('[data-status]');
  if (!btn) return;
  if (btn.dataset.status === 'cancelled' && !confirm('Cancel this order?')) return;
  btn.disabled = true;
  try {
    // Accepting locks in the (possibly edited) estimate first, so "ready by" is right.
    if (btn.dataset.status === 'accepted') {
      const card = btn.closest('.order-card');
      await api.setOrderEstimate(btn.dataset.id, readEta(card));
    }
    await api.setOrderStatus(btn.dataset.id, btn.dataset.status);
    toast(`${DOT[btn.dataset.status]} Order ${LABEL[btn.dataset.status].toLowerCase()}`);
    refresh(ctx, false);
    // E-mail the change in the background; tell staff only if it didn't go out.
    api.notifyStatus(btn.dataset.id).then((r) => {
      if (r?.sent) toast('Status e-mailed');
      else if (r?.reason && (!/activation/i.test(r.reason) || !activationWarned)) {
        if (/activation/i.test(r.reason)) activationWarned = true;
        toast(`Status saved. E-mail not sent: ${r.reason}`, 'error');
      }
    }).catch(() => {});
  } catch (err) {
    errorToast(err);
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Notifications on this device
// ---------------------------------------------------------------------------
async function renderPushBox(ctx) {
  const box = $('#push-box');
  if (!box) return;
  const st = await push.state().catch(() => 'unsupported');
  const msg = {
    'install-first': '🔔 To get order notifications on this iPhone, install the app first: tap <b>Share</b> → <b>Add to Home Screen</b>, then open <b>Menu Admin</b> from the home screen and come back here.',
    unsupported: '🔕 This browser can’t receive notifications. On iPhone use the installed app (iOS 16.4 or later); on computers use Chrome, Edge or Safari.',
    denied: '🔕 Notifications are blocked for this app. Allow them in the phone/browser settings (Notifications → Menu Admin), then reload.',
    off: '🔔 Get a notification on this device for every new order, even when the app is closed.',
    on: '✅ Order notifications are <b>on</b> for this device.',
  }[st];
  box.className = `push-box push-${st}`;
  box.innerHTML = `
    <p>${msg}</p>
    <div class="push-actions">
      ${st === 'off' ? '<button type="button" class="btn btn-primary btn-small" data-push="on">Turn on notifications</button>' : ''}
      ${st === 'on' ? '<button type="button" class="btn btn-quiet btn-small" data-push="test">Send test</button><button type="button" class="btn btn-quiet btn-small" data-push="off">Turn off</button>' : ''}
    </div>`;
  box.onclick = async (e) => {
    const b = e.target.closest('[data-push]');
    if (!b) return;
    b.disabled = true;
    try {
      if (b.dataset.push === 'on') { await push.enable(ctx.outlet.id, ctx.session.user.id); toast('Notifications turned on for this device'); }
      if (b.dataset.push === 'off') { await push.disable(); toast('Notifications turned off for this device'); }
      if (b.dataset.push === 'test') { await push.sendTest(ctx.outlet.id); toast('Test sent — check the notification'); }
    } catch (err) { errorToast(err); }
    b.disabled = false;
    renderPushBox(ctx);
  renderSoundBox();
  };
}

// ---------------------------------------------------------------------------
// Alert sound for this device
// ---------------------------------------------------------------------------
function renderSoundBox() {
  const box = $('#sound-box');
  if (!box) return;
  const st = alerts.getSettings();
  box.innerHTML = `
    <summary>🔊 Alert sound on this device: <strong>${esc(alerts.SOUNDS[st.sound])}</strong>${st.repeat && st.sound !== 'none' ? ' · repeats until accepted' : ''}</summary>
    <div class="sound-grid">
      <label class="field"><span class="field-label">Sound</span>
        <select data-snd="sound">${Object.entries(alerts.SOUNDS).map(([k, l]) => `<option value="${k}" ${k === st.sound ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="field"><span class="field-label">Volume</span>
        <input type="range" min="0.1" max="1" step="0.1" value="${st.volume}" data-snd="volume">
      </label>
      <label class="switch-row"><span><span class="field-label">Repeat until accepted</span><span class="hint">Plays again every 15 s while an order is still New (only while the app is on screen — for a closed app use Settings → Remind the team)</span></span>
        <input type="checkbox" class="switch" data-snd="repeat" ${st.repeat ? 'checked' : ''}>
      </label>
      <button type="button" class="btn btn-quiet btn-small" data-snd-preview>▶ Preview</button>
    </div>
    <p class="hint">Plays while the app is open (keep it open on the tablet at the pass). When the app is closed, notifications use the phone’s own notification sound: on iPhone that can’t be changed for web apps; on Android choose it in Settings → Notifications.</p>`;
  box.onchange = (e) => {
    const el = e.target.closest('[data-snd]');
    if (!el) return;
    const s2 = alerts.getSettings();
    s2[el.dataset.snd] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
    alerts.saveSettings(s2);
    if (el.dataset.snd !== 'repeat') alerts.play();
    box.querySelector('summary strong').textContent = alerts.SOUNDS[s2.sound];
  };
  box.onclick = (e) => { if (e.target.closest('[data-snd-preview]')) alerts.play(); };
}

// ---------------------------------------------------------------------------
// Waiter / bill requests
// ---------------------------------------------------------------------------
function renderRequests(ctx, requests) {
  const host = $('#requests-list');
  if (!host) return;
  if (!requests.length) { host.innerHTML = ''; return; }
  host.innerHTML = `
    <div class="req-grid">
      ${requests.map((r) => {
        const where = r.location_type === 'room' ? `Room ${r.location}` : `Table ${r.location}`;
        return `
          <div class="req-card req-${r.kind}">
            <span class="req-icon" aria-hidden="true">${r.kind === 'bill' ? '🧾' : '🙋'}</span>
            <span class="req-text"><strong>${esc(where)}</strong> ${r.kind === 'bill' ? 'asks for the bill' : 'is calling a waiter'}
              <small>${esc(ago(r.created_at))}</small>${r.note ? `<small>📝 ${esc(r.note)}</small>` : ''}</span>
            <button type="button" class="btn btn-small btn-primary" data-req-done="${r.id}">Done</button>
          </div>`;
      }).join('')}
    </div>`;
  host.onclick = async (e) => {
    const b = e.target.closest('[data-req-done]');
    if (!b) return;
    b.disabled = true;
    try {
      await api.markRequestDone(b.dataset.reqDone);
      b.closest('.req-card').remove();
      toast('Request marked done');
    } catch (err) { errorToast(err); b.disabled = false; }
  };
}
