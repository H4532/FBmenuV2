// FB Menus admin — Oracle Simphony (STS Gen2) connection settings (inside Settings).
import { esc } from '../core/i18n.js';
import * as api from './api.js';
import { $, toast, errorToast, field, toggle } from './ui.js';

export async function renderSimphony(ctx, host) {
  let cfg = {}, hasCred = false;
  try { [cfg, hasCred] = await Promise.all([api.getPosSettings(ctx.outlet.id), api.posHasCredentials(ctx.outlet.id)]); } catch { /* no rights */ return; }
  cfg = cfg || {};
  const num = (v) => (v === null || v === undefined ? '' : v);
  host.innerHTML = `
    <section class="block">
      <h2 class="block-title">Oracle Simphony (POS)</h2>
      <p class="hint">When on, every <strong>accepted</strong> order is created as an <strong>open check</strong> in Simphony
        (Transaction Services Gen2). The cashier closes it in Simphony — room charge to Opera, cash or card — and Simphony prints the tax invoice.
        Each dish needs its <strong>Simphony item no.</strong> (Dishes → edit dish).</p>
      <form class="simph-form" novalidate>
        ${toggle('enabled', 'Send accepted orders to Simphony', Boolean(cfg.enabled))}
        ${toggle('training_mode', 'Training mode (checks marked as training — use until go-live)', cfg.training_mode !== false)}
        <div class="row-fields">
          ${field('API host', `<input name="api_host" value="${esc(cfg.api_host || '')}" placeholder="https://xxxx-sts.oracleindustry.com">`)}
          ${field('Auth host', `<input name="auth_host" value="${esc(cfg.auth_host || '')}" placeholder="https://xxxx-idm.oracleindustry.com">`)}
          ${field('Client ID', `<input name="client_id" value="${esc(cfg.client_id || '')}">`)}
        </div>
        <div class="row-fields">
          ${field('Org short name', `<input name="org_short_name" value="${esc(cfg.org_short_name || '')}">`)}
          ${field('Location ref', `<input name="loc_ref" value="${esc(cfg.loc_ref || '')}">`)}
          ${field('Revenue center (RVC) ref', `<input name="rvc_ref" inputmode="numeric" value="${num(cfg.rvc_ref)}">`)}
        </div>
        <div class="row-fields">
          ${field('Employee no. for web orders', `<input name="employee_ref" inputmode="numeric" value="${num(cfg.employee_ref)}">`, 'Object number of the “Web order” employee')}
          ${field('Order type (tables)', `<input name="order_type_ref" inputmode="numeric" value="${num(cfg.order_type_ref)}">`)}
          ${field('Order type (rooms, optional)', `<input name="room_order_type_ref" inputmode="numeric" value="${num(cfg.room_order_type_ref)}">`)}
        </div>
        <div class="row-fields">
          ${field('API account username', '<input name="api_user" autocomplete="off">', hasCred ? '✓ An account is saved. Leave empty to keep it.' : 'From Simphony Reporting & Analytics → API accounts')}
          ${field('API account password', '<input name="api_pass" type="password" autocomplete="new-password">', 'Stored encrypted-at-rest in a private table; never shown again')}
        </div>
        <div class="simph-actions">
          <button type="submit" class="btn btn-primary btn-small">Save Simphony settings</button>
          <button type="button" class="btn btn-quiet btn-small" data-test>Test connection</button>
        </div>
        ${cfg.last_test_result ? `<p class="simph-test ${cfg.last_test_result.startsWith('OK') ? 'good' : 'bad'}">${esc(cfg.last_test_result)}
          <small>(${esc(new Date(cfg.last_test_at).toLocaleString())})</small></p>` : ''}
      </form>
    </section>`;
  const form = $('.simph-form', host);
  const toInt = (v) => (String(v).trim() === '' ? null : parseInt(v, 10));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); e.stopPropagation();
    const f = form.elements;
    const row = {
      outlet_id: ctx.outlet.id, enabled: f.enabled.checked, training_mode: f.training_mode.checked,
      api_host: f.api_host.value.trim().replace(/\/+$/, '') || null, auth_host: f.auth_host.value.trim().replace(/\/+$/, '') || null,
      client_id: f.client_id.value.trim() || null, org_short_name: f.org_short_name.value.trim() || null, loc_ref: f.loc_ref.value.trim() || null,
      rvc_ref: toInt(f.rvc_ref.value), employee_ref: toInt(f.employee_ref.value),
      order_type_ref: toInt(f.order_type_ref.value), room_order_type_ref: toInt(f.room_order_type_ref.value),
    };
    try {
      if (row.enabled && (!row.api_host || !row.auth_host || !row.client_id || !row.org_short_name || !row.loc_ref || row.rvc_ref == null || row.employee_ref == null || row.order_type_ref == null)) {
        throw new Error('Fill in all connection fields before switching the Simphony link on.');
      }
      await api.savePosSettings(row);
      if (f.api_user.value.trim()) await api.setPosCredentials(ctx.outlet.id, f.api_user.value.trim(), f.api_pass.value);
      toast('Simphony settings saved');
      renderSimphony(ctx, host);
    } catch (err) { errorToast(err); }
  });
  $('[data-test]', host).addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Testing…';
    try { const r = await api.testPos(ctx.outlet.id); toast(r.result, r.result.startsWith('OK') ? 'ok' : 'error'); } catch (err) { errorToast(err); }
    renderSimphony(ctx, host);
  });
}
