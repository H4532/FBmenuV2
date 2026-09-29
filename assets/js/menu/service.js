// FB Menus — "Call waiter" / "Request bill" from a table or room QR code.
import { SUPABASE_URL, SUPABASE_KEY } from '../platform.js';
import { t, esc } from '../core/i18n.js';

const KEEP_MS = 20 * 60 * 1000;          // show "on the way" for up to 20 min
const key = (slug, loc) => `fbm:req:${slug}:${loc.type}:${loc.value}`;

function saved(slug, loc) {
  try {
    return JSON.parse(localStorage.getItem(key(slug, loc)) || '[]')
      .filter((r) => Date.now() - new Date(r.at).getTime() < KEEP_MS);
  } catch { return []; }
}
function store(slug, loc, list) { try { localStorage.setItem(key(slug, loc), JSON.stringify(list)); } catch { /* ignore */ } }

const rpc = (fn, body) => fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export function render(host, { slug, location, onToast }) {
  const list = saved(slug, location);
  const pending = (kind) => list.find((r) => r.kind === kind && r.status !== 'done');
  const doneRecently = (kind) => list.find((r) => r.kind === kind && r.status === 'done');
  const btn = (kind, label, icon) => {
    const p = pending(kind);
    const d = !p && doneRecently(kind);
    const text = p ? t(kind === 'bill' ? 'bill_requested' : 'waiter_called') : d ? `${label} · ${t('request_done')}` : label;
    return `<button type="button" class="svc-btn${p ? ' is-pending' : ''}" data-svc="${kind}" ${p ? 'disabled' : ''}>
      <span aria-hidden="true">${icon}</span> ${esc(text)}</button>`;
  };
  host.innerHTML = `
    <div class="svc-bar">
      ${btn('waiter', location.type === 'room' ? t('request_assist') : t('call_waiter'), '🙋')}
      ${location.type === 'table' ? btn('bill', t('request_bill'), '🧾') : ''}
    </div>`;
  host.hidden = false;
  host.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const res = await rpc('request_service', { p_slug: slug, p_location_type: location.type, p_location: location.value, p_kind: b.dataset.svc, p_note: null });
      const data = await res.json();
      if (!res.ok) {
        const code = String(data.message || '').split(':')[0];
        const msg = t(`err_${code}`);
        onToast(msg === `err_${code}` ? t('err_generic') : msg);
        b.disabled = false;
        return;
      }
      const next = saved(slug, location).filter((r) => r.id !== data.id);
      next.push({ id: data.id, kind: b.dataset.svc, at: new Date().toISOString(), status: 'open' });
      store(slug, location, next);
      onToast(t('request_sent_toast'));
      render(host, { slug, location, onToast });
      watch(host, { slug, location, onToast });
    } catch {
      onToast(t('err_generic'));
      b.disabled = false;
    }
  }));
}

let timer;
/** While a request is open, check every 20 s whether staff marked it done. */
export function watch(host, opts) {
  clearTimeout(timer);
  const tick = async () => {
    const list = saved(opts.slug, opts.location);
    const open = list.filter((r) => r.status !== 'done');
    if (!open.length) return;
    try {
      const res = await rpc('guest_request_status', { p_ids: open.map((r) => r.id) });
      const rows = res.ok ? await res.json() : [];
      let changed = false;
      for (const r of list) {
        const row = rows.find((x) => x.id === r.id);
        if (row && row.status !== r.status) { r.status = row.status; changed = true; }
      }
      if (changed) { store(opts.slug, opts.location, list); render(host, opts); }
    } catch { /* offline */ }
    if (list.some((r) => r.status !== 'done')) timer = setTimeout(tick, 20000);
  };
  timer = setTimeout(tick, 20000);
}

/** Anonymous scan counter (one per phone per location per 30 min on the server). */
export function logScan(slug, location, lang) {
  let session = '';
  try {
    session = localStorage.getItem('fbm:sid') || '';
    if (!session) { session = crypto.randomUUID(); localStorage.setItem('fbm:sid', session); }
  } catch { session = 'nostore'; }
  rpc('log_scan', {
    p_slug: slug, p_location_type: location ? location.type : 'none', p_location: location ? location.value : '',
    p_lang: lang, p_session: session,
  }).catch(() => {});
}
