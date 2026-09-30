// FB Menus admin — Printers: kitchen ticket printers (Epson TM-U220B / ESC/POS over IP),
// which printer each menu section goes to, the on-site print agent, and recent jobs.
import { esc } from '../core/i18n.js';
import * as api from './api.js';
import { $, $$, toast, errorToast, openDialog, confirmDialog, field, toggle, nameBlock } from './ui.js';

const REPO_RAW = 'https://raw.githubusercontent.com/H4532/fb-menus/main/tools/print-agent';
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

export async function renderPrinters(ctx) {
  const root = $('#view');
  root.innerHTML = `
    <div class="view-head">
      <h1>Printers</h1>
      <button type="button" class="btn btn-primary" data-add-printer>+ Add printer</button>
    </div>
    <p class="hint">When an order is <strong>accepted</strong>, each kitchen station gets a ticket with only its dishes. Tickets are sent by the print agent running on a PC in the hotel network.</p>
    <div id="agent-box"></div>
    <div id="printer-list"><div class="loading"><span class="spinner"></span></div></div>
    <section class="block"><h2 class="block-title">Which printer gets each section</h2>
      <p class="hint">Dishes print at their section’s printer. Sections set to “Default printer” go to the printer marked as default.</p>
      <div id="routing"></div></section>
    <section class="block"><h2 class="block-title">Recent tickets</h2><div id="jobs"></div></section>`;
  $('[data-add-printer]', root).addEventListener('click', () => editPrinter(ctx, null));
  await refresh(ctx);
}

async function refresh(ctx) {
  let printers = [], agents = [], jobs = [];
  try {
    [printers, agents, jobs] = await Promise.all([
      api.listPrinters(ctx.outlet.id), api.listAgents(ctx.outlet.id), api.recentPrintJobs(ctx.outlet.id)]);
  } catch (err) { errorToast(err); return; }
  ctx.ui.printers = printers;
  renderAgents(ctx, agents);
  renderList(ctx, printers);
  renderRouting(ctx, printers);
  renderJobs(printers, jobs);
}

// ------------------------------------------------------------------- agents
function renderAgents(ctx, agents) {
  const online = agents.filter((a) => a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < 60000);
  const box = $('#agent-box');
  box.className = `agent-box ${online.length ? 'agent-on' : 'agent-off'}`;
  box.innerHTML = `
    <div class="agent-head">
      <strong>${online.length ? '🟢 Print agent online' : agents.length ? '🔴 Print agent offline' : '⚪ No print agent yet'}</strong>
      <button type="button" class="btn btn-small btn-quiet" data-add-agent>+ Add print agent</button>
    </div>
    ${agents.length ? `<ul class="rows compact" role="list">${agents.map((a) => `
      <li class="row"><span class="row-name" style="cursor:default"><span class="nm">${esc(a.name)}</span>
        <span class="nm-sub">Last contact ${esc(ago(a.last_seen_at))}</span></span>
        <button type="button" class="btn btn-small btn-danger-quiet" data-del-agent="${a.id}">Remove</button></li>`).join('')}</ul>`
      : '<p class="hint">Install the agent once on an always-on PC in the hotel network (it can reach the printers’ IP addresses). Tap “Add print agent” for the steps.</p>'}`;
  $('[data-add-agent]', box).addEventListener('click', () => addAgent(ctx));
  $$('[data-del-agent]', box).forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove this print agent? That PC will stop printing tickets.', 'Remove'))) return;
    try { await api.deleteAgent(b.dataset.delAgent); toast('Agent removed'); refresh(ctx); } catch (err) { errorToast(err); }
  }));
}

async function addAgent(ctx) {
  let token = '';
  const done = await openDialog({
    title: 'Add print agent',
    submitLabel: 'Create agent',
    body: field('Name of the PC', '<input name="name" value="Kitchen PC" maxlength="40" required>', 'e.g. “Kitchen PC” or “F&B office PC”.'),
    onSubmit: async (form) => { token = await api.createAgent(ctx.outlet.id, form.elements.name.value.trim()); },
  });
  if (!done || !token) return;
  const cfg = JSON.stringify({
    supabase_url: 'https://swjffroqtxfbsmtjpimw.supabase.co',
    publishable_key: 'sb_publishable_9iSpnZU7vc1n2K4kMMjYNg_l55LW1XU',
    agent_token: token, poll_seconds: 3,
  }, null, 2);
  await openDialog({
    title: 'Install the print agent',
    submitLabel: 'Done',
    wide: true,
    body: `
      <ol class="steps">
        <li>On the PC, install <strong>Python 3</strong> from python.org (tick “Add Python to PATH”).</li>
        <li>Create a folder, e.g. <code>C:\\FBMenus\\print-agent</code>, and download into it:
          <a href="${REPO_RAW}/print_agent.py" target="_blank" rel="noopener">print_agent.py</a> and
          <a href="${REPO_RAW}/run_agent.bat" target="_blank" rel="noopener">run_agent.bat</a>.</li>
        <li>In the same folder create <code>config.json</code> with exactly this content
          <strong>(the token is shown only now — copy it)</strong>:
          <pre class="cred" data-cfg>${esc(cfg)}</pre>
          <button type="button" class="btn btn-small btn-quiet" data-copy>Copy config.json</button></li>
        <li>Double-click <code>run_agent.bat</code>. This page shows <strong>🟢 Print agent online</strong> within a few seconds.</li>
        <li>To start it automatically: Task Scheduler → Create Basic Task → “When the computer starts” → run <code>run_agent.bat</code>.</li>
      </ol>
      <p class="hint">The PC must stay on and be on the same network as the printers. The PC needs internet access to reach the server (outgoing HTTPS only; nothing is opened to the internet).</p>`,
    onOpen: (dlg) => $('[data-copy]', dlg).addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('[data-cfg]', dlg).textContent); toast('Copied'); } catch { toast('Select the text and copy it.', 'error'); }
    }),
  });
  refresh(ctx);
}

// ----------------------------------------------------------------- printers
function renderList(ctx, printers) {
  const host = $('#printer-list');
  host.innerHTML = printers.length ? `<div class="printer-grid">${printers.map((p) => `
    <article class="printer-card${p.is_active ? '' : ' is-hidden'}">
      <header><span class="printer-ico" aria-hidden="true">🖨️</span>
        <div><strong>${esc(p.name)}</strong><span class="nm-sub">${esc(p.station)} · ${esc(p.host)}:${p.port} · ${esc(p.model)}</span></div>
        ${p.is_default ? '<span class="tag tag-info">Default</span>' : ''}</header>
      <p class="printer-status ${p.last_error ? 'bad' : p.last_ok_at ? 'good' : ''}">
        ${p.last_error ? `⚠️ ${esc(p.last_error)}` : p.last_ok_at ? `✓ Last ticket printed ${esc(ago(p.last_ok_at))}` : 'No ticket printed yet'}</p>
      <footer class="user-actions">
        <button type="button" class="btn btn-small btn-quiet" data-test="${p.id}">Test print</button>
        <button type="button" class="btn btn-small btn-quiet" data-edit="${p.id}">Edit</button>
        <button type="button" class="btn btn-small btn-danger-quiet" data-del="${p.id}">Delete</button>
      </footer>
    </article>`).join('')}</div>`
    : '<div class="empty"><p>No printers yet. Add your Hot, Pastry and Cold kitchen printers.</p></div>';
  host.onclick = async (e) => {
    const t = e.target.closest('[data-test]'), ed = e.target.closest('[data-edit]'), d = e.target.closest('[data-del]');
    if (t) { try { await api.testPrinter(t.dataset.test); toast('Test ticket queued — it prints within a few seconds'); setTimeout(() => refresh(ctx), 4000); } catch (err) { errorToast(err); } }
    if (ed) editPrinter(ctx, printers.find((p) => p.id === ed.dataset.edit));
    if (d) {
      if (!(await confirmDialog('Delete this printer? Its sections will fall back to the default printer.', 'Delete'))) return;
      try { await api.deletePrinter(d.dataset.del); toast('Printer deleted'); refresh(ctx); } catch (err) { errorToast(err); }
    }
  };
}

async function editPrinter(ctx, p) {
  const v = p || { name: '', station: 'Hot kitchen', host: '192.168.1.', port: 9100, model: 'TM-U220B', width_chars: 40, copies: 1, use_red: true, is_default: false, is_active: true };
  const done = await openDialog({
    title: p ? 'Edit printer' : 'Add printer',
    submitLabel: p ? 'Save printer' : 'Add printer',
    body: `
      <div class="form-grid">
        <div class="row-fields">
          ${field('Name', `<input name="name" value="${esc(v.name)}" maxlength="40" required placeholder="Hot kitchen printer">`)}
          ${field('Station (printed at the top)', `<input name="station" value="${esc(v.station)}" maxlength="20" required list="stations">
            <datalist id="stations"><option>Hot kitchen</option><option>Pastry</option><option>Cold kitchen</option><option>Bar</option></datalist>`)}
        </div>
        <div class="row-fields">
          ${field('IP address', `<input name="host" value="${esc(v.host)}" required inputmode="decimal" placeholder="192.168.1.50">`, 'Print the printer’s status sheet to see its IP (hold FEED while switching on).')}
          ${field('Port', `<input name="port" value="${v.port}" inputmode="numeric" required>`, 'Usually 9100')}
        </div>
        <div class="row-fields">
          ${field('Model', `<input name="model" value="${esc(v.model)}" maxlength="30">`)}
          ${field('Characters per line', `<select name="width_chars">${[33, 40, 42, 48].map((n) => `<option ${n === v.width_chars ? 'selected' : ''}>${n}</option>`).join('')}</select>`, 'TM-U220B on 76 mm paper: 40')}
          ${field('Copies', `<select name="copies">${[1, 2, 3].map((n) => `<option ${n === v.copies ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
        </div>
        ${toggle('use_red', 'Print notes and allergies in red', v.use_red, 'Needs a two-colour (black/red) ribbon.')}
        ${toggle('is_default', 'Default printer', v.is_default, 'Gets dishes from sections that have no printer assigned.')}
        ${toggle('is_active', 'Active', v.is_active)}
      </div>`,
    onSubmit: async (form) => {
      const host = form.elements.host.value.trim();
      if (!/^[A-Za-z0-9.-]{3,64}$/.test(host)) throw new Error('Enter a valid IP address, e.g. 192.168.1.50');
      const row = {
        outlet_id: ctx.outlet.id, name: form.elements.name.value.trim(), station: form.elements.station.value.trim(),
        host, port: Number(form.elements.port.value) || 9100, model: form.elements.model.value.trim() || 'TM-U220B',
        width_chars: Number(form.elements.width_chars.value), copies: Number(form.elements.copies.value),
        use_red: form.elements.use_red.checked, is_default: form.elements.is_default.checked, is_active: form.elements.is_active.checked,
      };
      if (p) row.id = p.id;
      if (row.is_default) {
        for (const other of (ctx.ui.printers || []).filter((x) => x.is_default && x.id !== p?.id)) {
          await api.savePrinter({ id: other.id, is_default: false });
        }
      }
      await api.savePrinter(row);
    },
  });
  if (done) { toast(p ? 'Printer saved' : 'Printer added'); refresh(ctx); }
}

// ------------------------------------------------------------------ routing
function renderRouting(ctx, printers) {
  const host = $('#routing');
  const { menus, categories } = ctx.data;
  if (!printers.length) { host.innerHTML = '<p class="hint">Add printers first.</p>'; return; }
  const opts = (sel) => `<option value="">Default printer</option>${printers.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} — ${esc(p.station)}</option>`).join('')}`;
  host.innerHTML = menus.map((m) => `
    <p class="sub-legend">${esc(m.name.en || Object.values(m.name)[0])}</p>
    <ul class="rows compact" role="list">${categories.filter((c) => c.menu_id === m.id).map((c) => `
      <li class="row"><span class="row-name" style="cursor:default">${nameBlock(c.name, ctx.langs)}</span>
        <select class="route-sel" data-cat="${c.id}">${opts(c.printer_id)}</select></li>`).join('')}</ul>`).join('');
  $$('.route-sel', host).forEach((s) => s.addEventListener('change', async () => {
    try {
      await api.setCategoryPrinter(s.dataset.cat, s.value || null);
      const c = ctx.data.categories.find((x) => x.id === s.dataset.cat); if (c) c.printer_id = s.value || null;
      toast('Section printer saved');
    } catch (err) { errorToast(err); }
  }));
}

// --------------------------------------------------------------------- jobs
function renderJobs(printers, jobs) {
  const name = (id) => printers.find((p) => p.id === id)?.name || '—';
  const icon = { done: '✓', pending: '⏳', printing: '🖨️', failed: '⚠️' };
  $('#jobs').innerHTML = jobs.length ? `<ul class="log-list" role="list">${jobs.map((j) => `
    <li class="log-row job-${j.status}"><span class="log-time">${esc(new Date(j.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
      <span class="log-text">${icon[j.status] || ''} <strong>${esc(name(j.printer_id))}</strong> — ${j.kind === 'test' ? 'test page' : `${j.kind === 'reprint' ? 'reprint ' : ''}order #${esc(j.order_no ?? '')}`}
      · ${esc(j.status)}${j.attempts > 1 ? ` (${j.attempts} tries)` : ''}${j.error ? ` — <span class="job-err">${esc(j.error)}</span>` : ''}</span></li>`).join('')}</ul>`
    : '<p class="hint">No tickets yet.</p>';
}
