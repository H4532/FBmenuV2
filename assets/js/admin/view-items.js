// FB Menus admin — Dishes: the everyday screen.
// Inline price edit, "sold out today" switch, drag to reorder, full editor.
import { esc } from '../core/i18n.js';
import { ALLERGENS, DIETARY, BADGES } from '../core/strings.js';
import { photoUrl } from '../platform.js';
import * as api from './api.js';
import { preparePhoto } from './image.js';
import {
  $, $$, toast, errorToast, openDialog, langFields, readLang, field, toggle, chips,
  checkedValues, parseMoney, parseIntOrNull, money, nameBlock,
} from './ui.js';

let filterText = '';

export function renderItems(ctx) {
  const { data, langs } = ctx;
  const root = $('#view');
  const menus = data.menus;
  const menuId = ctx.ui.itemsMenu && menus.some((m) => m.id === ctx.ui.itemsMenu) ? ctx.ui.itemsMenu : menus[0]?.id;
  ctx.ui.itemsMenu = menuId;

  const placed = new Set(data.category_items.map((ci) => ci.item_id));
  const orphans = data.items.filter((i) => !placed.has(i.id));

  root.innerHTML = `
    <div class="view-head">
      <h1>Dishes</h1>
      <button type="button" class="btn btn-primary" data-new-item>+ Add dish</button>
    </div>
    <div class="toolbar">
      ${menus.length > 1 ? `
        <div class="seg" role="tablist" aria-label="Menu">
          ${menus.map((m) => `<button type="button" role="tab" data-menu="${m.id}" aria-selected="${m.id === menuId}">${nameBlock(m.name, langs)}</button>`).join('')}
        </div>` : ''}
      <input type="search" class="search" placeholder="Search dishes" value="${esc(filterText)}" aria-label="Search dishes">
    </div>
    <p class="hint">Tap a price to change it. Use the switch for “sold out today”. Drag ⋮⋮ to reorder.</p>
    <div id="item-lists"></div>
    ${orphans.length ? `
      <section class="block">
        <h2 class="block-title">Not on any menu <span class="count">${orphans.length}</span></h2>
        <p class="hint">These dishes are saved but guests can’t see them. Open one and tick a section to publish it.</p>
        <ul class="rows" role="list">${orphans.map((i) => itemRow(ctx, i, false)).join('')}</ul>
      </section>` : ''}
  `;

  renderLists(ctx);

  $$('[data-menu]', root).forEach((b) => b.addEventListener('click', () => {
    ctx.ui.itemsMenu = b.dataset.menu;
    renderItems(ctx);
  }));
  $('.search', root).addEventListener('input', (e) => {
    filterText = e.target.value;
    applyFilter();
  });
  $('[data-new-item]', root).addEventListener('click', () => editItem(ctx, null, null));
  bindRows(ctx, root);
  applyFilter();
}

function renderLists(ctx) {
  const { data, langs } = ctx;
  const host = $('#item-lists');
  const cats = data.categories.filter((c) => c.menu_id === ctx.ui.itemsMenu);
  if (!cats.length) {
    host.innerHTML = `<div class="empty"><p>This menu has no sections yet.</p><p class="hint">Add sections under <strong>Menus</strong>, then add dishes here.</p></div>`;
    return;
  }
  const itemsById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  host.innerHTML = cats.map((c) => {
    const links = data.category_items.filter((ci) => ci.category_id === c.id).sort((a, b) => a.sort_order - b.sort_order);
    return `
      <section class="block" data-cat-block="${c.id}">
        <h2 class="block-title">${nameBlock(c.name, langs)} <span class="count">${links.length}</span>
          ${c.is_active ? '' : '<span class="tag tag-muted">Hidden</span>'}
          <button type="button" class="btn btn-small btn-quiet" data-new-item-in="${c.id}">+ Add</button>
        </h2>
        <ul class="rows sortable" role="list" data-cat="${c.id}">
          ${links.map((l) => itemsById[l.item_id]).filter(Boolean).map((i) => itemRow(ctx, i, true)).join('')
            || '<li class="row-empty">No dishes in this section.</li>'}
        </ul>
      </section>`;
  }).join('');

  $$('[data-new-item-in]', host).forEach((b) => b.addEventListener('click', () => editItem(ctx, null, b.dataset.newItemIn)));

  $$('ul.sortable', host).forEach((ul) => {
    if (!ul.querySelector('[data-id]')) return;
    window.Sortable.create(ul, {
      handle: '.drag',
      animation: 150,
      onEnd: async () => {
        const ids = $$('[data-id]', ul).map((li) => li.dataset.id);
        try {
          await api.reorderCategoryItems(ul.dataset.cat, ids);
          ids.forEach((id, i) => {
            const link = ctx.data.category_items.find((ci) => ci.category_id === ul.dataset.cat && ci.item_id === id);
            if (link) link.sort_order = (i + 1) * 10;
          });
          toast('Order saved');
        } catch (err) {
          errorToast(err);
          ctx.reload();
        }
      },
    });
  });
}

function itemRow(ctx, i, draggable) {
  const thumb = i.photo_path
    ? `<img class="thumb" src="${photoUrl(i.photo_path, 'thumb')}" alt="" loading="lazy" width="48" height="48">`
    : '<span class="thumb thumb-empty" aria-hidden="true"></span>';
  const search = Object.values(i.name || {}).join(' ').toLowerCase();
  return `
    <li class="row${i.is_available ? '' : ' is-off'}${i.is_active ? '' : ' is-hidden'}" data-id="${i.id}" data-search="${esc(search)}">
      ${draggable ? '<span class="drag" title="Drag to reorder" aria-hidden="true">⋮⋮</span>' : ''}
      ${thumb}
      <button type="button" class="row-name" data-edit="${i.id}">
        ${nameBlock(i.name, ctx.langs)}
        <span class="row-flags">
          ${i.is_active ? '' : '<span class="tag tag-muted">Hidden</span>'}
          ${i.calories == null ? '' : `<span class="tag">${i.calories} kcal</span>`}
          ${i.prep_minutes == null ? '<span class="tag tag-warn">No prep time</span>' : `<span class="tag">⏱ ${i.prep_minutes} min</span>`}
          ${i.allergens.length ? '' : '<span class="tag tag-warn">No allergens set</span>'}
        </span>
      </button>
      <label class="price-edit">
        <span class="sr-only">Price</span>
        <input type="text" inputmode="decimal" value="${money(i.price)}" data-price="${i.id}" aria-label="Price">
      </label>
      <label class="avail" title="${i.is_available ? 'Available' : 'Sold out today'}">
        <input type="checkbox" class="switch" data-avail="${i.id}" ${i.is_available ? 'checked' : ''}>
        <span class="avail-label">${i.is_available ? 'On' : 'Sold out'}</span>
      </label>
    </li>`;
}

function bindRows(ctx, root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (btn) editItem(ctx, btn.dataset.edit, null);
  });

  root.addEventListener('change', async (e) => {
    const priceInput = e.target.closest('[data-price]');
    if (priceInput) {
      const item = ctx.data.items.find((i) => i.id === priceInput.dataset.price);
      const value = parseMoney(priceInput.value);
      if (!Number.isFinite(value) || value < 0) {
        toast('Enter a price like 45 or 45.50', 'error');
        priceInput.value = money(item.price);
        return;
      }
      if (value === Number(item.price)) { priceInput.value = money(value); return; }
      try {
        await api.update('items', item.id, { price: value });
        item.price = value;
        priceInput.value = money(value);
        $$(`[data-price="${item.id}"]`).forEach((el) => { el.value = money(value); });
        toast(`Price saved: ${money(value)}`);
      } catch (err) {
        errorToast(err);
        priceInput.value = money(item.price);
      }
      return;
    }

    const avail = e.target.closest('[data-avail]');
    if (avail) {
      const item = ctx.data.items.find((i) => i.id === avail.dataset.avail);
      const on = avail.checked;
      try {
        await api.update('items', item.id, { is_available: on });
        item.is_available = on;
        $$(`[data-avail="${item.id}"]`).forEach((el) => {
          el.checked = on;
          const row = el.closest('.row');
          row.classList.toggle('is-off', !on);
          row.querySelector('.avail-label').textContent = on ? 'On' : 'Sold out';
        });
        toast(on ? 'Back on the menu' : 'Marked sold out');
      } catch (err) {
        errorToast(err);
        avail.checked = !on;
      }
    }
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-price]')) e.target.blur();
  });
}

function applyFilter() {
  const q = filterText.trim().toLowerCase();
  $$('#view .row[data-search]').forEach((row) => {
    row.hidden = q && !row.dataset.search.includes(q);
  });
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
async function editItem(ctx, itemId, presetCategoryId) {
  const { data, langs, outlet, badges } = ctx;
  const item = itemId ? data.items.find((i) => i.id === itemId) : null;
  const isNew = !item;
  const v = item || {
    name: {}, description: {}, price: 0, calories: null, caffeine_mg: null, spice_level: 0,
    allergens: [], dietary: [], badges: [], item_type: 'single', photo_path: null,
    is_available: true, is_active: true,
  };
  const currentCats = item
    ? data.category_items.filter((ci) => ci.item_id === item.id).map((ci) => ci.category_id)
    : (presetCategoryId ? [presetCategoryId] : []);
  const currentGroups = item
    ? data.item_option_groups.filter((g) => g.item_id === item.id).sort((a, b) => a.sort_order - b.sort_order).map((g) => g.group_id)
    : [];

  let photoPath = v.photo_path;
  let uploadedThisSession = null;

  const catsByMenu = data.menus.map((m) => ({
    menu: m,
    cats: data.categories.filter((c) => c.menu_id === m.id),
  })).filter((g) => g.cats.length);

  const allBadges = { ...BADGES, ...badges };
  const tr = (o) => o?.en || Object.values(o || {})[0] || '';

  const body = `
    <div class="form-grid">
      ${langFields('name', 'Dish name', v.name, langs, { required: [outlet.default_language] })}
      ${langFields('description', 'Description (optional)', v.description, langs, { textarea: true })}

      <fieldset class="field-group">
        <legend>Price and nutrition</legend>
        <div class="row-fields">
          ${field(`Price (${outlet.currency})`, `<input name="price" inputmode="decimal" value="${money(v.price)}" required>`, 'VAT included')}
          ${field('Calories (kcal)', `<input name="calories" inputmode="numeric" value="${v.calories ?? ''}">`, 'Required on Saudi menus')}
          ${field('Caffeine (mg)', `<input name="caffeine_mg" inputmode="numeric" value="${v.caffeine_mg ?? ''}">`, 'Drinks only')}
          ${field('Preparation time (min)', `<input name="prep_minutes" inputmode="numeric" value="${v.prep_minutes ?? ''}">`, 'Used for the guest’s estimated time')}
          ${field('Simphony item no.', `<input name="pos_item_no" maxlength="20" value="${esc(v.pos_item_no ?? '')}" placeholder="e.g. 10245">`, 'Menu item number in Oracle Simphony (for the POS link)')}
        </div>
      </fieldset>

      <fieldset class="field-group">
        <legend>Photo</legend>
        <div class="photo-edit">
          <div class="photo-preview" data-photo-preview>${photoPath ? `<img src="${photoUrl(photoPath, 'thumb')}" alt="">` : '<span>No photo</span>'}</div>
          <div class="photo-actions">
            <label class="btn btn-quiet file-btn">
              <input type="file" accept="image/*" data-photo-input hidden>
              <span data-photo-label>${photoPath ? 'Replace photo' : 'Add photo'}</span>
            </label>
            <button type="button" class="btn btn-quiet" data-photo-remove ${photoPath ? '' : 'hidden'}>Remove photo</button>
            <p class="hint">Landscape photos look best. They are resized automatically.</p>
          </div>
        </div>
      </fieldset>

      <fieldset class="field-group">
        <legend>Where it appears</legend>
        ${catsByMenu.length ? catsByMenu.map((g) => `
          <p class="sub-legend">${esc(tr(g.menu.name))}</p>
          ${chips('categories', g.cats.map((c) => [c.id, tr(c.name)]), currentCats)}
        `).join('') : '<p class="hint">Create a menu and sections first (Menus tab).</p>'}
      </fieldset>

      <fieldset class="field-group">
        <legend>Allergens</legend>
        <p class="hint">Tick everything the dish contains. Guests with allergies rely on this.</p>
        ${chips('allergens', Object.entries(ALLERGENS).map(([k, l]) => [k, `${l.en} · ${l.ar}`]), v.allergens)}
      </fieldset>

      <fieldset class="field-group">
        <legend>Dietary</legend>
        ${chips('dietary', Object.entries(DIETARY).map(([k, l]) => [k, `${l.en} · ${l.ar}`]), v.dietary)}
      </fieldset>

      <fieldset class="field-group">
        <legend>Badges</legend>
        ${chips('badges', Object.entries(allBadges).map(([k, l]) => [k, `${l.en} · ${l.ar}`]), v.badges)}
        <div class="row-fields">
          ${field('Spice level', `
            <select name="spice_level">
              ${['Not spicy', 'Mild', 'Medium', 'Hot'].map((s, i) => `<option value="${i}" ${v.spice_level === i ? 'selected' : ''}>${s}</option>`).join('')}
            </select>`)}
          ${field('Type', `
            <select name="item_type">
              <option value="single" ${v.item_type === 'single' ? 'selected' : ''}>Single dish</option>
              <option value="combo" ${v.item_type === 'combo' ? 'selected' : ''}>Set menu / combo</option>
            </select>`)}
        </div>
      </fieldset>

      <fieldset class="field-group">
        <legend>Choices (sizes, sides, add-ons)</legend>
        ${data.option_groups.length
          ? chips('groups', data.option_groups.map((g) => [g.id, g.internal_name]), currentGroups)
          : '<p class="hint">No choice groups yet. Create them in the Choices tab.</p>'}
      </fieldset>

      <fieldset class="field-group">
        <legend>Status</legend>
        ${toggle('is_available', 'Available today', v.is_available, 'Turn off when sold out; guests see it greyed out.')}
        ${toggle('is_active', 'Show on the menu', v.is_active, 'Turn off to hide the dish completely.')}
      </fieldset>
    </div>`;

  const onOpen = (dlg) => {
    const input = $('[data-photo-input]', dlg);
    const preview = $('[data-photo-preview]', dlg);
    const removeBtn = $('[data-photo-remove]', dlg);
    const label = $('[data-photo-label]', dlg);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      preview.innerHTML = '<span class="spinner"></span>';
      try {
        const blobs = await preparePhoto(file);
        const path = await api.uploadPhoto(outlet.id, blobs);
        if (uploadedThisSession) await api.deletePhoto(uploadedThisSession);
        uploadedThisSession = path;
        photoPath = path;
        preview.innerHTML = `<img src="${URL.createObjectURL(blobs[400])}" alt="">`;
        removeBtn.hidden = false;
        label.textContent = 'Replace photo';
      } catch (err) {
        errorToast(err);
        preview.innerHTML = photoPath ? `<img src="${photoUrl(photoPath, 'thumb')}" alt="">` : '<span>No photo</span>';
      } finally {
        input.value = '';
      }
    });
    removeBtn.addEventListener('click', () => {
      photoPath = null;
      preview.innerHTML = '<span>No photo</span>';
      removeBtn.hidden = true;
      label.textContent = 'Add photo';
    });
  };

  const onSubmit = async (form) => {
    const price = parseMoney(form.elements.price.value);
    if (!Number.isFinite(price) || price < 0) throw new Error('Enter a valid price, e.g. 45 or 45.50.');
    const row = {
      name: readLang(form, 'name', langs),
      description: readLang(form, 'description', langs),
      price,
      calories: parseIntOrNull(form.elements.calories.value),
      caffeine_mg: parseIntOrNull(form.elements.caffeine_mg.value),
      pos_item_no: form.elements.pos_item_no.value.trim() || null,
      prep_minutes: (() => { const m = parseIntOrNull(form.elements.prep_minutes.value); if (m != null && m > 240) throw new Error('Preparation time must be 240 minutes or less.'); return m; })(),
      spice_level: Number(form.elements.spice_level.value),
      item_type: form.elements.item_type.value,
      allergens: checkedValues(form, 'allergens'),
      dietary: checkedValues(form, 'dietary'),
      badges: checkedValues(form, 'badges'),
      photo_path: photoPath,
      is_available: form.elements.is_available.checked,
      is_active: form.elements.is_active.checked,
    };
    const categories = checkedValues(form, 'categories');
    const groups = checkedValues(form, 'groups');

    let saved;
    if (isNew) {
      saved = await api.insert('items', { ...row, outlet_id: outlet.id });
    } else {
      saved = await api.update('items', item.id, row);
    }
    await api.setItemCategories(outlet.id, saved.id, categories, data.category_items);
    const groupsChanged = JSON.stringify(groups) !== JSON.stringify(currentGroups);
    if (groupsChanged) await api.setItemGroups(outlet.id, saved.id, groups);

    // Clean up a replaced/removed photo only after the save succeeded.
    if (item?.photo_path && item.photo_path !== photoPath) await api.deletePhoto(item.photo_path);
    uploadedThisSession = null;
  };

  const result = await openDialog({
    title: isNew ? 'Add dish' : 'Edit dish',
    body,
    wide: true,
    submitLabel: isNew ? 'Add dish' : 'Save dish',
    onOpen,
    onSubmit,
    danger: isNew ? null : {
      label: 'Delete dish',
      confirm: 'Delete this dish from every menu? This can’t be undone. To remove it for today only, use “Available today” instead.',
      action: async () => {
        await api.remove('items', item.id);
        await api.deletePhoto(item.photo_path);
        toast('Dish deleted');
        ctx.reload();
      },
    },
  });

  if (result) {
    toast(isNew ? 'Dish added' : 'Dish saved');
    ctx.reload();
  } else if (uploadedThisSession) {
    // Cancelled after uploading: remove the unused files.
    api.deletePhoto(uploadedThisSession);
  }
}
