// FB Menus — item detail sheet and price/calorie range calculation.
import { t, tr, esc, allergenLabel, dietaryLabel, badgeLabel } from '../core/i18n.js';
import { price, priceDelta, kcal, kcalRange } from '../core/format.js';
import { photoUrl } from '../platform.js';
import * as account from './account.js';

const sum = (arr) => arr.reduce((a, b) => a + b, 0);

/**
 * Headline price and calorie range for an item, taking option groups into account:
 *  - 'replace' groups (sizes, protein choice) set the price/calories;
 *  - required 'add' groups add their cheapest/lightest picks to the minimum;
 *  - all 'add' groups add their most expensive/heaviest picks to the maximum.
 */
export function itemSummary(data, item) {
  const groups = item.option_groups.map((id) => data.option_groups[id]).filter(Boolean);
  const replace = groups.find((g) => g.pricing === 'replace' && g.options.some((o) => o.available));

  let minPrice = Number(item.price);
  let maxPrice = minPrice;
  let minKcal = item.calories;
  let maxKcal = item.calories;

  if (replace) {
    const opts = replace.options.filter((o) => o.available);
    const prices = opts.map((o) => Number(o.price));
    minPrice = Math.min(...prices);
    maxPrice = Math.max(...prices);
    const cals = opts.map((o) => o.calories).filter((c) => c != null);
    if (cals.length) { minKcal = Math.min(...cals); maxKcal = Math.max(...cals); }
  }

  for (const g of groups.filter((x) => x.pricing === 'add')) {
    const opts = g.options.filter((o) => o.available);
    if (!opts.length) continue;
    const picksMax = g.max == null ? opts.length : Math.min(g.max, opts.length);
    const byPrice = opts.map((o) => Number(o.price)).sort((a, b) => a - b);
    const byCal = opts.map((o) => o.calories ?? 0).sort((a, b) => a - b);
    if (g.min > 0) {
      minPrice += sum(byPrice.slice(0, g.min));
      if (minKcal != null) minKcal += sum(byCal.slice(0, g.min));
    }
    maxPrice += sum(byPrice.slice(-picksMax));
    if (maxKcal != null) maxKcal += sum(byCal.slice(-picksMax));
  }

  return {
    minPrice, maxPrice, minKcal, maxKcal,
    fromPrice: maxPrice > minPrice && Boolean(replace),
  };
}

function groupRule(g) {
  if (g.selection === 'single') return g.min > 0 ? `${t('choose_one')} · ${t('required')}` : `${t('choose_one')} · ${t('optional')}`;
  const rule = g.max == null ? t('choose_any') : t('choose_up_to', { n: g.max });
  return g.min > 0 ? `${rule} · ${t('required')}` : `${rule} · ${t('optional')}`;
}

function renderGroup(g, interactive) {
  return `
    <section class="sheet-group" data-group="${g.id}">
      <h3>${esc(tr(g.name))} <span class="rule">${esc(groupRule(g))}</span></h3>
      <ul role="list">
        ${g.options.map((o) => {
          const meta = `
            <span class="opt-meta">
              ${o.calories != null ? `<span class="opt-kcal">${esc(kcal(o.calories))}</span>` : ''}
              <span class="opt-price">${g.pricing === 'replace' ? price(o.price) : (Number(o.price) > 0 ? priceDelta(o.price) : esc(t('included')))}</span>
            </span>`;
          const name = `<span class="opt-name">${esc(tr(o.name))}${o.available ? '' : ` <small>(${esc(t('sold_out'))})</small>`}</span>`;
          if (!interactive) return `<li class="${o.available ? '' : 'is-soldout'}">${name}${meta}</li>`;
          return `
            <li class="${o.available ? '' : 'is-soldout'}">
              <label class="opt-pick">
                <input type="checkbox" class="${g.selection === 'single' ? 'as-radio' : ''}" value="${o.id}" data-opt-group="${g.id}" ${o.available ? '' : 'disabled'}>
                ${name}${meta}
              </label>
            </li>`;
        }).join('')}
      </ul>
    </section>`;
}

export function openItemSheet(data, itemId, config, order = null) {
  const item = data.items[itemId];
  if (!item) return;
  const dialog = document.getElementById('sheet');
  const s = itemSummary(data, item);
  const groups = item.option_groups.map((id) => data.option_groups[id]).filter(Boolean);
  const photo = config.showPhotos !== false && item.photo
    ? `<img class="sheet-photo" src="${photoUrl(item.photo, 'large')}" alt="" decoding="async">`
    : '';
  const desc = tr(item.description);

  dialog.innerHTML = `
    <div class="sheet" role="document">
      <button type="button" class="sheet-close" data-close aria-label="${esc(t('close'))}">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      ${photo}
      <div class="sheet-body">
        ${item.badges.length ? `<p class="sheet-badges">${item.badges.map((b) => `<span class="badge">${esc(badgeLabel(b))}</span>`).join('')}</p>` : ''}
        <div class="sheet-title-row">
          <h2 class="sheet-title" id="sheet-title">${esc(tr(item.name))}</h2>
          <button type="button" class="icon-heart${account.isFavorite(item.id) ? ' is-on' : ''}" data-fav aria-pressed="${account.isFavorite(item.id)}" aria-label="♡">${account.isFavorite(item.id) ? '♥' : '♡'}</button>
        </div>
        <p class="sheet-price">
          ${s.fromPrice ? `<span class="from">${esc(t('from'))}</span> ` : ''}${price(s.minPrice)}
          ${s.minKcal != null && config.showCalories !== false ? `<span class="sheet-kcal">${esc(kcalRange(s.minKcal, s.maxKcal))}</span>` : ''}
        </p>
        ${item.available ? '' : `<p class="soldout-label">${esc(t('sold_out'))}</p>`}
        ${desc ? `<p class="sheet-desc">${esc(desc)}</p>` : ''}
        ${groups.map((g) => renderGroup(g, Boolean(order?.canOrder && item.available))).join('')}
        <section class="sheet-facts">
          <h3>${esc(t('allergens'))}</h3>
          ${item.allergens.length
            ? `<p>${esc(t('contains'))}: <strong>${item.allergens.map((a) => esc(allergenLabel(a))).join(lang_sep())}</strong></p>`
            : `<p class="muted">${esc(t('no_allergen_info'))}</p>`}
          ${item.dietary.length ? `<p>${esc(t('dietary'))}: ${item.dietary.map((d) => esc(dietaryLabel(d))).join(lang_sep())}</p>` : ''}
          ${item.spice > 0 ? `<p>${esc(t('spice'))}: ${esc(t('spice_levels')[item.spice])}</p>` : ''}
          ${item.prep ? `<p>⏱ ${esc(t('prep_time'))}: ${esc(t('est_about', { n: item.prep }))}</p>` : ''}
          ${item.caffeine_mg != null ? `<p>${esc(t('caffeine'))}: <bdi>${item.caffeine_mg} mg</bdi></p>` : ''}
        </section>
        <p class="sheet-allergy muted">${esc(t('allergy_notice'))}</p>
        ${order?.canOrder && item.available ? `
          <label class="field-note">
            <span>${esc(t('note_item'))}</span>
            <textarea rows="2" maxlength="200" data-note placeholder="${esc(t('note_item_ph'))}"></textarea>
          </label>` : ''}
        ${order && !order.canOrder && order.reason ? `<p class="order-hint">${esc(order.reason)}</p>` : ''}
      </div>
      ${order?.canOrder && item.available ? `
        <div class="sheet-order">
          <div class="qty" role="group" aria-label="${esc(t('quantity'))}">
            <button type="button" data-qty="-1" aria-label="${esc(t('decrease'))}">−</button>
            <output data-qty-out>1</output>
            <button type="button" data-qty="1" aria-label="${esc(t('increase'))}">+</button>
          </div>
          <button type="button" class="btn-add" data-add>${esc(t('add_to_order'))} · <span data-add-price></span></button>
        </div>` : ''}
    </div>`;
  dialog.setAttribute('aria-labelledby', 'sheet-title');

  const close = () => dialog.close();
  dialog.querySelector('[data-close]').addEventListener('click', close);
  dialog.onclick = (e) => { if (e.target === dialog) close(); };   // tap on backdrop
  dialog.showModal();
  dialog.querySelector('.sheet').scrollTop = 0;
  dialog.querySelector('[data-fav]').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    if (!account.signedIn()) { dialog.close(); account.open(); return; }
    await account.toggleFavorite(item.id);
    const on = account.isFavorite(item.id);
    b.classList.toggle('is-on', on); b.textContent = on ? '♥' : '♡'; b.setAttribute('aria-pressed', on);
  });
  if (order?.canOrder && item.available) wireOrdering(dialog, data, item, groups, order);
}

// ---------------------------------------------------------------------------
// Ordering controls inside the sheet
// ---------------------------------------------------------------------------
function wireOrdering(dialog, data, item, groups, order) {
  let qty = 1;
  const boxes = [...dialog.querySelectorAll('[data-opt-group]')];
  const chosen = () => boxes.filter((b) => b.checked).map((b) => b.value);

  // Pre-select defaults; required single choices fall back to the first available option.
  for (const g of groups) {
    const inGroup = boxes.filter((b) => b.dataset.optGroup === g.id && !b.disabled);
    const defaults = g.options.filter((o) => o.is_default && o.available).map((o) => o.id);
    inGroup.forEach((b) => { b.checked = defaults.includes(b.value); });
    if (g.selection === 'single' && g.min > 0 && !inGroup.some((b) => b.checked) && inGroup[0]) inGroup[0].checked = true;
  }

  const enforce = (changed) => {
    const g = data.option_groups[changed.dataset.optGroup];
    const inGroup = boxes.filter((b) => b.dataset.optGroup === g.id);
    if (g.selection === 'single') {
      if (changed.checked) inGroup.forEach((b) => { if (b !== changed) b.checked = false; });
      else if (g.min > 0) changed.checked = true;      // a required single choice can't be emptied
    } else if (g.max != null) {
      const n = inGroup.filter((b) => b.checked).length;
      inGroup.forEach((b) => { if (!b.checked) b.disabled = n >= g.max || !g.options.find((o) => o.id === b.value)?.available; });
    }
  };

  const refresh = () => {
    const unit = order.unitPrice(item.id, chosen());
    dialog.querySelector('[data-add-price]').innerHTML = price(unit * qty);
    dialog.querySelector('[data-qty-out]').textContent = qty;
  };

  boxes.forEach((b) => b.addEventListener('change', () => { enforce(b); refresh(); }));
  dialog.querySelectorAll('[data-qty]').forEach((btn) => btn.addEventListener('click', () => {
    qty = Math.max(1, Math.min(20, qty + Number(btn.dataset.qty)));
    refresh();
  }));

  dialog.querySelector('[data-add]').addEventListener('click', () => {
    const ids = chosen();
    for (const g of groups) {
      const n = g.options.filter((o) => ids.includes(o.id)).length;
      if (n < g.min) {
        const sec = dialog.querySelector(`[data-group="${g.id}"]`);
        sec.classList.add('is-missing');
        sec.scrollIntoView({ block: 'center', behavior: 'smooth' });
        order.toast(t('choose_required', { group: tr(g.name) }));
        return;
      }
    }
    order.onAdd(item.id, ids, qty, dialog.querySelector('[data-note]')?.value || '');
    dialog.close();
  });
  refresh();
}

function lang_sep() {
  return document.documentElement.lang === 'ar' ? '، ' : ', ';
}
