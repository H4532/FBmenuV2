// FB Menus admin — data layer. Every write goes through Supabase with the
// signed-in user's session; row-level security decides what is allowed.
import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET } from '../platform.js';

// supabase-js is loaded as a classic script (assets/vendor) → window.supabase
export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

const must = ({ data, error }) => {
  if (error) throw error;
  return data;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const getSession = async () => (await sb.auth.getSession()).data.session;
export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password }).then(must);
export const signOut = () => sb.auth.signOut();
export const sendReset = (email, redirectTo) => sb.auth.resetPasswordForEmail(email, { redirectTo }).then(must);
export const updatePassword = (password) => sb.auth.updateUser({ password }).then(must);
export const onAuth = (cb) => sb.auth.onAuthStateChange(cb);

// ---------------------------------------------------------------------------
// Outlets the signed-in user manages
// ---------------------------------------------------------------------------
export async function myOutlets(userId) {
  const rows = must(await sb
    .from('outlet_admins')
    .select('role, permissions, outlet:outlets(*)')
    .eq('user_id', userId));
  return rows
    .filter((r) => r.outlet)
    .map((r) => ({ role: r.role, permissions: r.role === 'owner' ? ['orders', 'dishes', 'menus', 'settings', 'users'] : (r.permissions || []), outlet: r.outlet }))
    .sort((a, b) => a.outlet.slug.localeCompare(b.outlet.slug));
}

// ---------------------------------------------------------------------------
// Everything for one outlet, in parallel
// ---------------------------------------------------------------------------
const TABLES = [
  'menus', 'menu_schedules', 'categories', 'items', 'category_items',
  'option_groups', 'options', 'item_option_groups', 'buffet_prices',
];

export async function loadOutlet(outletId) {
  const results = await Promise.all(TABLES.map((t) => {
    let q = sb.from(t).select('*').eq('outlet_id', outletId);
    if (['menus', 'categories', 'category_items', 'option_groups', 'options', 'item_option_groups', 'buffet_prices'].includes(t)) {
      q = q.order('sort_order', { ascending: true });
    }
    return q;
  }));
  const data = {};
  TABLES.forEach((t, i) => { data[t] = must(results[i]); });
  const outlet = must(await sb.from('outlets').select('*').eq('id', outletId).single());
  return { outlet, ...data };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
export const insert = (table, row) => sb.from(table).insert(row).select().single().then(must);
export const insertMany = (table, rows) => (rows.length ? sb.from(table).insert(rows).then(must) : null);
export const update = (table, id, patch) => sb.from(table).update(patch).eq('id', id).select().single().then(must);
export const remove = (table, id) => sb.from(table).delete().eq('id', id).then(must);

export const reorder = (table, ids) => sb.rpc('reorder', { p_table: table, p_ids: ids }).then(must);
export const reorderCategoryItems = (categoryId, itemIds) =>
  sb.rpc('reorder_category_items', { p_category_id: categoryId, p_item_ids: itemIds }).then(must);
export const reorderItemGroups = (itemId, groupIds) =>
  sb.rpc('reorder_item_option_groups', { p_item_id: itemId, p_group_ids: groupIds }).then(must);

export async function updateOutlet(id, patch) {
  return must(await sb.from('outlets').update(patch).eq('id', id).select().single());
}

// ---------------------------------------------------------------------------
// Link tables
// ---------------------------------------------------------------------------
/** Make the item appear in exactly `categoryIds` (new placements go to the end). */
export async function setItemCategories(outletId, itemId, categoryIds, current) {
  const have = new Set(current.filter((ci) => ci.item_id === itemId).map((ci) => ci.category_id));
  const want = new Set(categoryIds);
  const toRemove = [...have].filter((c) => !want.has(c));
  const toAdd = [...want].filter((c) => !have.has(c));

  if (toRemove.length) {
    must(await sb.from('category_items').delete().eq('item_id', itemId).in('category_id', toRemove));
  }
  if (toAdd.length) {
    const rows = toAdd.map((categoryId) => {
      const last = Math.max(0, ...current.filter((ci) => ci.category_id === categoryId).map((ci) => ci.sort_order));
      return { outlet_id: outletId, category_id: categoryId, item_id: itemId, sort_order: last + 10 };
    });
    must(await sb.from('category_items').insert(rows));
  }
}

/** Attach exactly `groupIds` to the item, in that order. */
export async function setItemGroups(outletId, itemId, groupIds) {
  must(await sb.from('item_option_groups').delete().eq('item_id', itemId));
  if (groupIds.length) {
    must(await sb.from('item_option_groups').insert(groupIds.map((g, i) => ({
      outlet_id: outletId, item_id: itemId, group_id: g, sort_order: (i + 1) * 10,
    }))));
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
export async function uploadPhoto(outletId, blobs) {
  const base = `${outletId}/items/${crypto.randomUUID()}`;
  for (const [size, blob] of Object.entries(blobs)) {
    must(await sb.storage.from(PHOTO_BUCKET).upload(`${base}-${size}.webp`, blob, {
      // Safari can't encode WebP and falls back to JPEG: keep the real type so it displays.
      contentType: blob.type || 'image/webp', cacheControl: '31536000', upsert: false,
    }));
  }
  return base;
}

export async function deletePhoto(basePath) {
  if (!basePath) return;
  await sb.storage.from(PHOTO_BUCKET).remove([`${basePath}-400.webp`, `${basePath}-1200.webp`]);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
export const loadOrders = (outletId, sinceIso) => sb
  .from('orders')
  .select('*, order_items(*)')
  .eq('outlet_id', outletId)
  .gte('created_at', sinceIso)
  .order('created_at', { ascending: false })
  .limit(200)
  .then(must);

// Only the status column is writable by staff (column-level grant).
export const setOrderStatus = (id, status) => sb.from('orders').update({ status }).eq('id', id).then(must);

export const getOrderSettings = (outletId) =>
  sb.from('outlet_order_settings').select('*').eq('outlet_id', outletId).maybeSingle().then(must);

export const saveOrderSettings = (outletId, emails, extra = {}) =>
  sb.from('outlet_order_settings').upsert({ outlet_id: outletId, notify_emails: emails, ...extra }).then(must);

/** E-mail a status change (Edge Function checks the caller is an admin of the outlet). */
export async function notifyStatus(orderId) {
  const session = (await sb.auth.getSession()).data.session;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/order-status`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${session?.access_token || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ order_id: orderId }),
  });
  return res.json().catch(() => ({ sent: false, reason: `HTTP ${res.status}` }));
}

/** Staff adjust the estimated preparation time (minutes). */
export const setOrderEstimate = (id, minutes) =>
  sb.from('orders').update({ estimated_minutes: minutes }).eq('id', id).then(must);

// ---------------------------------------------------------------------------
// Users (server function checks the caller's rights)
// ---------------------------------------------------------------------------
export async function manageUsers(action, outletId, body = {}) {
  const session = (await sb.auth.getSession()).data.session;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/manage-users`, {
    method: 'POST',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session?.access_token || ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, outlet_id: outletId, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Open orders (new / accepted / ready) in the last 24 h — for the app-icon badge. */
export async function openOrderCount(outletId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count, error } = await sb.from('orders').select('id', { count: 'exact', head: true })
    .eq('outlet_id', outletId).in('status', ['new', 'accepted', 'ready']).gte('created_at', since);
  if (error) throw error;
  return count || 0;
}

// ---------------------------------------------------------------------------
// Guest service requests (call waiter / request bill)
// ---------------------------------------------------------------------------
export const loadOpenRequests = (outletId) => sb.from('service_requests').select('*')
  .eq('outlet_id', outletId).eq('status', 'open')
  .gte('created_at', new Date(Date.now() - 12 * 3600 * 1000).toISOString())
  .order('created_at', { ascending: true }).then(must);

export async function markRequestDone(id) {
  const uid = (await sb.auth.getSession()).data.session?.user?.id || null;
  return sb.from('service_requests').update({ status: 'done', done_at: new Date().toISOString(), done_by: uid }).eq('id', id).then(must);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export const reportSales = (outletId, from, to) =>
  sb.rpc('report_sales', { p_outlet: outletId, p_from: from.toISOString(), p_to: to.toISOString() }).then(must);
export const reportOverview = () => sb.rpc('report_overview').then(must);
