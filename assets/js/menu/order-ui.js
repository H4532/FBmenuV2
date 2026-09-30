// FB Menus — guest ordering UI: cart bar, cart sheet, checkout, confirmation.
import { t, tr, esc, lang } from '../core/i18n.js';
import { price } from '../core/format.js';
import {
  initCart, onCartChange, addLine, setQty, removeLine, clearCart, resolvedLines, totals,
  unitPrice, submitOrder,
} from './cart.js';
import { saveOrder, snapshotFrom, saveReceipt, openMyOrders, estimateFor } from './my-orders.js';
import { number } from '../core/format.js';

let S = null;               // shared guest state from app.js
let onMenuStale = () => {};

const $ = (sel, root = document) => root.querySelector(sel);

export function whereLabel(loc) {
  return t(loc.type === 'room' ? 'where_room' : 'where_table', { n: loc.value });
}

/** Call once the menu data is known. Returns false when ordering isn't possible here. */
export function setupOrdering(state, { refetch }) {
  S = state;
  onMenuStale = refetch;
  if (!state.location || !state.data?.outlet?.ordering?.enabled) {
    document.body.classList.remove('can-order');
    $('#cart-bar').hidden = true;
    return false;
  }
  initCart(state.config.slug, state.location);
  document.body.classList.add('can-order');
  onCartChange(renderCartBar);
  renderCartBar();
  return true;
}

/** Context passed to the item sheet for the menu being viewed. */
export function orderContext(menuServingNow) {
  if (!S?.orderingOn) return null;
  return {
    canOrder: menuServingNow,
    reason: menuServingNow ? '' : t('not_orderable_now'),
    unitPrice: (id, opts) => unitPrice(S.data, id, opts),
    onAdd: (id, opts, qty, note) => { addLine(id, opts, qty, note); guestToast(t('added')); },
    toast: guestToast,
  };
}

/** Quick "+" from the list for dishes without choices. */
export function quickAdd(itemId) {
  addLine(itemId, [], 1, '');
  guestToast(t('added'));
}

export function renderCartBar() {
  const bar = $('#cart-bar');
  if (!S?.orderingOn) { bar.hidden = true; return; }
  const { count, amount } = totals(S.data);
  bar.hidden = count === 0;
  document.body.classList.toggle('has-cart', count > 0);
  bar.innerHTML = `
    <button type="button" class="cart-btn" data-open-cart>
      <span class="cart-count">${count}</span>
      <span class="cart-label">${esc(t('view_order'))}</span>
      <span class="cart-total">${price(amount)}</span>
    </button>`;
  $('[data-open-cart]', bar).addEventListener('click', openCart);
}

// ---------------------------------------------------------------------------
// Cart sheet
// ---------------------------------------------------------------------------
export function openCart() {
  const dlg = $('#cart');
  renderCart(dlg);
  if (!dlg.open) dlg.showModal();
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
}

function renderCart(dlg, error = '') {
  const lines = resolvedLines(S.data);
  const { count, amount } = totals(S.data);
  const hasProblem = lines.some((l) => l.problem);
  const prev = { name: $('[name=guest-name]', dlg)?.value || '', note: $('[name=order-note]', dlg)?.value || '' };

  dlg.innerHTML = `
    <div class="sheet cart" role="document">
      <button type="button" class="sheet-close" data-close aria-label="${esc(t('close'))}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="sheet-body">
        <h2 class="sheet-title">${esc(t('your_order'))}</h2>
        <p class="cart-where">${esc(whereLabel(S.location))}</p>
        ${lines.length ? `
          <ul class="cart-lines" role="list">
            ${lines.map((l) => `
              <li class="cart-line${l.problem ? ' has-problem' : ''}">
                <div class="cl-main">
                  <span class="cl-name">${esc(l.item ? tr(l.item.name) : '—')}</span>
                  ${l.options.length ? `<span class="cl-opts">${l.options.map((o) => esc(tr(o.option.name))).join(' · ')}</span>` : ''}
                  ${l.note ? `<span class="cl-note">“${esc(l.note)}”</span>` : ''}
                  ${l.problem ? `<span class="cl-problem">${esc(l.problem === 'ITEM_UNAVAILABLE' ? t('sold_out') : t('err_OPTION_INVALID'))}</span>` : ''}
                </div>
                <div class="cl-side">
                  <span class="cl-total">${l.problem ? '' : price(l.total)}</span>
                  <div class="qty qty-small" role="group" aria-label="${esc(t('quantity'))}">
                    <button type="button" data-line="${esc(l.key)}" data-d="-1" aria-label="${esc(l.qty === 1 ? t('remove') : t('decrease'))}">${l.qty === 1 ? '🗑' : '−'}</button>
                    <output>${l.qty}</output>
                    <button type="button" data-line="${esc(l.key)}" data-d="1" aria-label="${esc(t('increase'))}" ${l.problem ? 'disabled' : ''}>+</button>
                  </div>
                </div>
              </li>`).join('')}
          </ul>
          <label class="field-note"><span>${esc(t('your_name'))}</span><input name="guest-name" maxlength="60" autocomplete="given-name" value="${esc(prev.name)}"></label>
          <label class="field-note"><span>${esc(t('order_note'))}</span><textarea name="order-note" rows="2" maxlength="300">${esc(prev.note)}</textarea></label>
          <div class="cart-sum"><span>${esc(t('total'))} <small>${esc(t('vat_incl'))}</small></span><strong>${price(amount)}</strong></div>
          ${estimateFor(S.data, lines) ? `<p class="cart-eta">⏱ ${esc(t('est_time'))}: <strong>${esc(t('est_pending', { n: number(estimateFor(S.data, lines)) }))}</strong></p>` : ''}
          ${error ? `<p class="cart-error" role="alert">${esc(error)}</p>` : ''}
          <button type="button" class="btn-send" data-send ${count === 0 || hasProblem ? 'disabled' : ''}>${esc(t('send_order'))} · ${esc(whereLabel(S.location))}</button>
          <p class="cart-pay muted">${esc(t('pay_note'))}</p>
        ` : `<p class="muted cart-empty">${esc(t('empty_cart'))}</p>`}
      </div>
    </div>`;

  $('[data-close]', dlg).addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('[data-line]').forEach((b) => b.addEventListener('click', () => {
    const l = lines.find((x) => x.key === b.dataset.line);
    const next = l.qty + Number(b.dataset.d);
    if (next <= 0 || l.problem) removeLine(l.key); else setQty(l.key, next);
    renderCart(dlg);
  }));
  $('[data-send]', dlg)?.addEventListener('click', () => send(dlg));
}

async function send(dlg) {
  const btn = $('[data-send]', dlg);
  btn.disabled = true;
  btn.textContent = t('sending');
  try {
    const res = await submitOrder({
      slug: S.config.slug,
      location: S.location,
      name: $('[name=guest-name]', dlg).value.trim(),
      note: $('[name=order-note]', dlg).value.trim(),
      lang: lang(),
    });
    const sentLines = resolvedLines(S.data);
    const snap = snapshotFrom(res, sentLines, S.data, S.location);
    saveOrder(S.config.slug, snap);
    clearCart();
    renderSent(dlg, res, sentLines, snap);
    window.dispatchEvent(new Event('fbm:orders'));
    window.dispatchEvent(new CustomEvent('fbm:order-sent', { detail: { id: res.id } }));
  } catch (err) {
    const key = `err_${err.code}`;
    const msg = t(key, { detail: err.detail || '' });
    renderCart(dlg, msg === key ? t('err_generic') : msg);
    if (['ITEM_UNAVAILABLE', 'ITEM_NOT_FOUND', 'OPTION_INVALID', 'OPTION_REQUIRED'].includes(err.code)) {
      await onMenuStale();          // fetch fresh availability, then show which line is affected
      renderCart(dlg, msg);
    }
  }
}

function renderSent(dlg, res, lines, snap) {
  dlg.innerHTML = `
    <div class="sheet cart" role="document">
      <div class="sheet-body sent">
        <div class="sent-check" aria-hidden="true">✓</div>
        <h2 class="sheet-title">${esc(t('order_sent'))}</h2>
        <p class="sent-no"><span>${esc(t('order_number'))}</span><strong>#${esc(res.order_no)}</strong></p>
        <p>${esc(t('order_sent_body', { where: whereLabel(S.location) }))}</p>
        <ul class="sent-lines" role="list">
          ${lines.filter((l) => !l.problem).map((l) => `<li><span>${l.qty}× ${esc(tr(l.item.name))}${l.options.length ? ` <small>(${l.options.map((o) => esc(tr(o.option.name))).join(', ')})</small>` : ''}</span></li>`).join('')}
        </ul>
        <div class="cart-sum"><span>${esc(t('total'))}</span><strong>${price(res.subtotal)}</strong></div>
        ${snap.est ? `<p class="cart-eta">⏱ ${esc(t('est_time'))}: <strong>${esc(t('est_pending', { n: number(snap.est) }))}</strong></p>` : ''}
        <p class="cart-pay muted">${esc(t('pay_note'))}</p>
        <div class="sent-actions">
          <button type="button" class="btn-ghost" data-receipt>🧾 ${esc(t('save_receipt'))}</button>
          <button type="button" class="btn-ghost" data-my-orders>${esc(t('my_orders'))}</button>
        </div>
        <button type="button" class="btn-send" data-close>${esc(t('back_to_menu'))}</button>
      </div>
    </div>`;
  $('[data-close]', dlg).addEventListener('click', () => dlg.close());
  $('[data-receipt]', dlg).addEventListener('click', () => saveReceipt(snap, () => guestToast(t('receipt_saved'))));
  $('[data-my-orders]', dlg).addEventListener('click', showMyOrders);
}

/** "My orders" — available whenever this phone has sent orders, even on the plain menu link. */
export function showMyOrders() {
  openMyOrders({
    slug: S.config.slug,
    location: S.location,
    dialog: $('#cart'),
    orderAgain: S.orderingOn ? orderAgain : null,
  });
}

function orderAgain(order) {
  let added = 0;
  for (const l of order.lines) {
    const item = S.data.items[l.item_id];
    if (!item || !item.available) continue;
    addLine(l.item_id, l.option_ids, l.qty, l.note);
    added += 1;
  }
  if (added) openCart(); else guestToast(t('err_ITEM_UNAVAILABLE', { detail: tr(order.lines[0]?.name) }));
}

// ---------------------------------------------------------------------------
let toastTimer;
export function guestToast(msg) {
  const el = $('#guest-toast');
  el.textContent = msg;
  el.hidden = false;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-on'); setTimeout(() => { el.hidden = true; }, 250); }, 1800);
}
