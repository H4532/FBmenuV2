// FB Menus admin — Reports: sales dashboard, QR scan analytics, all-outlets overview.
import { esc } from '../core/i18n.js';
import * as api from './api.js';
import { $, $$, errorToast, money } from './ui.js';

const RANGES = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', month: 'This month' };
let range = '7d';

function bounds(key, tz) {
  // Compute the outlet's local midnight, expressed as a real instant.
  const now = new Date();
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  const offset = localNow.getTime() - now.getTime();
  const midnight = new Date(localNow); midnight.setHours(0, 0, 0, 0);
  const startLocal = new Date(midnight);
  if (key === '7d') startLocal.setDate(startLocal.getDate() - 6);
  if (key === '30d') startLocal.setDate(startLocal.getDate() - 29);
  if (key === 'month') startLocal.setDate(1);
  return { from: new Date(startLocal.getTime() - offset), to: new Date(now.getTime() + 60000) };
}

const en = (o) => o?.en || o?.ar || Object.values(o || {})[0] || '';
const bar = (v, max, label, sub = '') => `
  <div class="rbar"><span class="rbar-label">${label}</span>
    <span class="rbar-track"><span class="rbar-fill" style="width:${max ? Math.max(2, (v / max) * 100) : 0}%"></span></span>
    <span class="rbar-val">${sub}</span></div>`;

export async function renderReports(ctx) {
  const root = $('#view');
  root.innerHTML = `
    <div class="view-head">
      <h1>Reports</h1>
      <div class="seg" role="tablist">${Object.entries(RANGES).map(([k, l]) => `<button type="button" role="tab" data-range="${k}" aria-selected="${k === range}">${l}</button>`).join('')}</div>
    </div>
    <div id="overview"></div>
    <div id="report"><div class="loading"><span class="spinner"></span></div></div>`;
  $$('[data-range]', root).forEach((b) => b.addEventListener('click', () => { range = b.dataset.range; renderReports(ctx); }));
  loadOverview(ctx);
  loadReport(ctx);
}

async function loadOverview(ctx) {
  const host = $('#overview');
  let rows = [];
  try { rows = await api.reportOverview(); } catch { return; }
  if (rows.length < 2) { host.innerHTML = ''; return; }     // single outlet: the dashboard below is enough
  host.innerHTML = `
    <section class="block">
      <h2 class="block-title">All outlets — today</h2>
      <div class="ov-grid">${rows.map((r) => `
        <div class="ov-card${r.waiting_new || r.open_requests ? ' ov-alert' : ''}">
          <strong>${esc(en(r.name))}</strong>
          <span class="ov-big">${money(r.revenue_today)}</span>
          <span>${r.orders_today} orders today · ${r.open_orders} open</span>
          ${r.waiting_new ? `<span class="ov-warn">🟡 ${r.waiting_new} waiting to be accepted</span>` : ''}
          ${r.open_requests ? `<span class="ov-warn">🙋 ${r.open_requests} open waiter/bill requests</span>` : ''}
          ${r.sold_out ? `<span class="muted">${r.sold_out} dishes sold out</span>` : ''}
          <span class="muted">${r.ordering?.enabled ? 'Ordering on' : 'Ordering off'}</span>
        </div>`).join('')}</div>
    </section>`;
}

async function loadReport(ctx) {
  const host = $('#report');
  const { from, to } = bounds(range, ctx.outlet.timezone || 'Asia/Riyadh');
  let r;
  try { r = await api.reportSales(ctx.outlet.id, from, to); } catch (err) { errorToast(err); host.innerHTML = ''; return; }
  const t = r.totals;
  const cur = ctx.outlet.currency;
  const maxDay = Math.max(0, ...r.by_day.map((d) => Number(d.revenue)));
  const hours = Array.from({ length: 24 }, (_, h) => r.by_hour.find((x) => x.hour === h) || { hour: h, orders: 0, revenue: 0 });
  const maxHour = Math.max(0, ...hours.map((h) => h.orders));
  const maxItem = Math.max(0, ...r.top_items.map((i) => i.qty));
  const scansMap = Object.fromEntries(r.scans_by_location.map((s) => [`${s.type}:${s.location}`, s.scans]));
  const ordersMap = Object.fromEntries(r.by_location.map((s) => [`${s.type}:${s.location}`, s]));
  const places = [...new Set([...Object.keys(scansMap), ...Object.keys(ordersMap)])].filter((k) => !k.startsWith('none'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const maxHeat = Math.max(1, ...places.map((k) => (ordersMap[k]?.orders || 0)));
  const maxScan = Math.max(1, ...places.map((k) => scansMap[k] || 0));
  const conv = t.scans_located ? Math.round((t.orders / t.scans_located) * 100) : null;

  host.innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>Revenue</span><strong>${cur} ${money(t.revenue)}</strong><small>VAT incl., cancelled excluded</small></div>
      <div class="kpi"><span>Orders</span><strong>${t.orders}</strong><small>${t.cancelled} cancelled</small></div>
      <div class="kpi"><span>Average order</span><strong>${cur} ${money(t.avg_order)}</strong><small>${t.items} dishes sold</small></div>
      <div class="kpi"><span>Time to accept</span><strong>${t.avg_accept_min == null ? '—' : `${t.avg_accept_min} min`}</strong><small>average</small></div>
      <div class="kpi"><span>QR scans</span><strong>${t.scans}</strong><small>${conv == null ? 'no table/room scans yet' : `${conv}% of table/room scans ordered`}</small></div>
    </div>

    <div class="rgrid">
      <section class="block">
        <h2 class="block-title">Best-selling dishes</h2>
        ${r.top_items.length ? r.top_items.map((i) => bar(i.qty, maxItem, esc(en(i.name)), `${i.qty} · ${money(i.revenue)}`)).join('') : '<p class="hint">No orders in this period.</p>'}
      </section>
      <section class="block">
        <h2 class="block-title">Revenue by day</h2>
        ${r.by_day.length ? r.by_day.map((d) => bar(Number(d.revenue), maxDay, esc(new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })), `${money(d.revenue)} · ${d.orders}`)).join('') : '<p class="hint">No orders in this period.</p>'}
      </section>
    </div>

    <section class="block">
      <h2 class="block-title">Orders by hour</h2>
      <div class="hours-chart">${hours.map((h) => `
        <div class="hc-col" title="${h.hour}:00 — ${h.orders} orders, ${money(h.revenue)}">
          <span class="hc-bar" style="height:${maxHour ? Math.max(h.orders ? 6 : 0, (h.orders / maxHour) * 100) : 0}%"></span>
          <span class="hc-lbl">${h.hour % 3 === 0 ? h.hour : ''}</span>
        </div>`).join('')}</div>
    </section>

    <section class="block">
      <h2 class="block-title">Tables &amp; rooms — orders and QR scans</h2>
      <p class="hint">Darker = more orders. The small number is how many times that QR code was scanned (one count per phone per 30 min).</p>
      ${places.length ? `<div class="heat">${places.map((k) => {
        const [type, loc] = k.split(':');
        const o = ordersMap[k];
        const intensity = (o?.orders || 0) / maxHeat;
        return `<div class="heat-cell" style="--i:${intensity.toFixed(2)};color:${intensity > 0.45 ? '#fff' : 'var(--c-primary-deep)'}" title="${type} ${loc}: ${o?.orders || 0} orders, ${money(o?.revenue || 0)}, ${scansMap[k] || 0} scans">
          <span class="heat-name">${type === 'room' ? 'R' : 'T'} ${esc(loc)}</span>
          <span class="heat-orders">${o?.orders || 0}</span>
          <span class="heat-scans">📱 ${scansMap[k] || 0}</span>
        </div>`;
      }).join('')}</div>` : '<p class="hint">No table or room activity in this period.</p>'}
      ${places.length ? `<h3 class="sub-legend" style="margin-top:1rem">Most-scanned QR codes</h3>
        ${places.map((k) => [k, scansMap[k] || 0]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 10)
          .map(([k, n]) => { const [type, loc] = k.split(':'); return bar(n, maxScan, `${type === 'room' ? 'Room' : 'Table'} ${esc(loc)}`, `${n} scans`); }).join('') || '<p class="hint">No scans yet.</p>'}` : ''}
    </section>`;
}
