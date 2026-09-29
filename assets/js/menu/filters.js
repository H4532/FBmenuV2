// FB Menus — guest menu filters: diet (show only) and allergens (hide).
// Saved on the phone, so a vegetarian or nut-allergic guest sets it once.
import { t, tr, esc } from '../core/i18n.js';
import { ALLERGENS, DIETARY } from '../core/strings.js';

const KEY = 'fbm:filters';
let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { diet: Array.isArray(s.diet) ? s.diet : [], hide: Array.isArray(s.hide) ? s.hide : [] };
  } catch { return { diet: [], hide: [] }; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } }

export const filters = () => state;
export const active = () => state.diet.length + state.hide.length > 0;

/** Does a dish pass the current filters? Vegan dishes count as vegetarian too. */
export function passes(item, f = state) {
  const diet = new Set(item.dietary || []);
  if (diet.has('vegan')) diet.add('vegetarian');
  if (f.diet.some((d) => !diet.has(d))) return false;
  if (f.hide.some((a) => (item.allergens || []).includes(a))) return false;
  return true;
}

/** Filter bar under the category chips. */
export function renderBar(host, { shown, total, onOpen }) {
  const chips = [
    ...state.diet.map((d) => `<span class="fchip">${esc(tr(DIETARY[d]))}</span>`),
    ...state.hide.map((a) => `<span class="fchip fchip-no">✕ ${esc(tr(ALLERGENS[a]))}</span>`),
  ].join('');
  host.hidden = false;
  host.innerHTML = `
    <div class="filter-bar-inner">
      <button type="button" class="filter-btn${active() ? ' is-on' : ''}" data-open-filters>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        ${esc(t('filters'))}${active() ? ` <span class="filter-n">${state.diet.length + state.hide.length}</span>` : ''}
      </button>
      ${active() ? `<span class="fchips">${chips}</span><span class="filter-count">${esc(t('filter_count', { n: shown, total }))}</span>` : ''}
    </div>`;
  host.querySelector('[data-open-filters]').addEventListener('click', onOpen);
}

/** Filter sheet. countFor(f) returns how many dishes would show with filters f. */
export function openSheet(dialog, { countFor, onApply }) {
  let draft = { diet: [...state.diet], hide: [...state.hide] };
  const draw = () => {
    const n = countFor(draft);
    dialog.innerHTML = `
      <div class="sheet" role="document">
        <button type="button" class="sheet-close" data-close aria-label="${esc(t('close'))}">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <div class="sheet-body filters-sheet">
          <h2 class="sheet-title">${esc(t('filters'))}</h2>
          <section>
            <h3>${esc(t('filter_show'))}</h3>
            <div class="fpick">${Object.keys(DIETARY).map((k) => `
              <label class="fopt"><input type="checkbox" data-diet="${k}" ${draft.diet.includes(k) ? 'checked' : ''}><span>${esc(tr(DIETARY[k]))}</span></label>`).join('')}</div>
          </section>
          <section>
            <h3>${esc(t('filter_hide'))}</h3>
            <div class="fpick">${Object.keys(ALLERGENS).map((k) => `
              <label class="fopt fopt-no"><input type="checkbox" data-hide="${k}" ${draft.hide.includes(k) ? 'checked' : ''}><span>${esc(tr(ALLERGENS[k]))}</span></label>`).join('')}</div>
          </section>
          <p class="muted filter-note">${esc(t('filter_note'))}</p>
          ${n === 0 ? `<p class="cart-error">${esc(t('filter_none'))}</p>` : ''}
          <div class="filter-actions">
            <button type="button" class="btn-ghost" data-clear>${esc(t('filter_clear'))}</button>
            <button type="button" class="btn-send" data-apply ${n === 0 ? 'disabled' : ''}>${esc(t('filter_apply', { n }))}</button>
          </div>
        </div>
      </div>`;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelectorAll('[data-diet]').forEach((c) => { c.onchange = () => {
      draft.diet = c.checked ? [...draft.diet, c.dataset.diet] : draft.diet.filter((x) => x !== c.dataset.diet); draw(); }; });
    dialog.querySelectorAll('[data-hide]').forEach((c) => { c.onchange = () => {
      draft.hide = c.checked ? [...draft.hide, c.dataset.hide] : draft.hide.filter((x) => x !== c.dataset.hide); draw(); }; });
    dialog.querySelector('[data-clear]').onclick = () => { draft = { diet: [], hide: [] }; draw(); };
    dialog.querySelector('[data-apply]').onclick = () => { state = draft; save(); dialog.close(); onApply(); };
  };
  draw();
  if (!dialog.open) dialog.showModal();
  dialog.onclick = (e) => { if (e.target === dialog) dialog.close(); };
}
