/* ==========================================================================
   views/trash.js — Trash (Owner / Admin): soft-deleted records
   --------------------------------------------------------------------------
   SOFT DELETE in one sentence: "deleting" only fills in the deleted_at column,
   so the record is hidden from every screen but is still in the database.
   This page lists those hidden records:
   - Restore        -> sets deleted_at back to NULL (the record is back)
   - Delete forever -> the only real DELETE in the system (★ Shop Owner only)
   Restoring a customer also brings back the orders deleted together with them.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  // API type -> [tab label, icon, what "restore" brings back]
  const TYPES = {
    orders:     ['Orders',          'board',    'The order shows again on the Orders board, and its payments count in Reports again.'],
    customers:  ['Customers',       'users',    'The customer comes back with the orders that were deleted together with them.'],
    services:   ['Services',        'settings','The service is back in the price list and on the New Order screen.'],
    inventory:  ['Supplies',        'box',      'The supply item is back in Inventory, with its stock movement records.'],
    stock_logs: ['Stock records',   'clock',    'The record shows again in "Recent stock movements".'],
    users:      ['User accounts',   'shield',   'The account is back in Users and can log in again (if it is active).'],
  };

  WH.views = WH.views || {};
  WH.views.trash = (view) => {
    const isOwner = !!WH.state.user.is_owner;
    let data = null;
    let tab = 'orders';

    view.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="small">
          <b>${WH.icon('trash')} How the Trash works (soft delete).</b>
          When something is deleted, it is <b>not removed from the database</b>. It only gets a <i>deleted date</i>
          (the <code>deleted_at</code> column) and is hidden from every screen and report.
          <b>Restore</b> clears that date and brings it back exactly as it was.
          ${isOwner ? '<b>Delete forever</b> really removes it and cannot be undone.' : 'Only the ★ Shop Owner can delete things forever.'}
        </div>
      </div>
      <div class="toolbar"><div class="segmented" id="tr-tabs"></div></div>
      <div id="tr-body"><div class="loading">Loading…</div></div>`;

    const render = () => {
      view.querySelector('#tr-tabs').innerHTML = Object.entries(TYPES).map(([k, [label]]) =>
        `<button type="button" data-t="${k}" class="${k === tab ? 'on' : ''}">${label} (${data[k].length})</button>`).join('');
      view.querySelectorAll('#tr-tabs [data-t]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.t; render(); }));

      const rows = data[tab];
      const [label, icon, restoreNote] = TYPES[tab];
      view.querySelector('#tr-body').innerHTML = rows.length ? `
        <div class="row" style="margin:0 0 10px">
          <p class="small muted" style="margin:0;flex:1">Restore: ${h(restoreNote)}</p>
          ${isOwner ? `<button class="btn btn-sm btn-danger" id="tr-empty">${WH.icon('trash')} Empty this tab</button>` : ''}
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Deleted</th><th>${h(label)}</th><th>Details</th><th class="right">Actions</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td class="small" style="white-space:nowrap">${WH.fmtDateTime(r.deleted_at)}</td>
            <td><b>${h(r.title)}</b></td>
            <td class="small">${h(r.details)}</td>
            <td class="right"><div class="row" style="justify-content:flex-end">
              <button class="btn btn-sm btn-primary" data-restore="${r.id}">${WH.icon('check')} Restore</button>
              ${isOwner ? `<button class="btn btn-sm btn-ghost" data-purge="${r.id}" style="color:var(--danger)">${WH.icon('trash')} Delete forever</button>` : ''}
            </div></td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty">${WH.icon(icon)}<div>No ${h(label.toLowerCase())} in the Trash.</div></div>`;

      const find = (id) => rows.find((r) => r.id === Number(id));
      view.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restore(find(b.dataset.restore))));
      view.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', () => purge(find(b.dataset.purge))));
      const empty = view.querySelector('#tr-empty');
      if (empty) empty.onclick = () => purge(null);
    };

    const restore = async (row) => {
      try {
        data = await WH.api('trash_restore', { type: tab, id: row.id });
        WH.toast(`${row.title} was restored`, 'success');
        render();
        WH.updateBadges();
        if (tab === 'services') WH.state.services = await WH.api('bootstrap').then((b) => b.services);
      } catch (e) { WH.error(e); }
    };

    // Shop Owner only: real DELETE (one row, or the whole tab when row = null)
    const purge = async (row) => {
      const what = row ? `<b>${h(row.title)}</b>` : `<b>all ${data[tab].length} ${h(TYPES[tab][0].toLowerCase())}</b> in this tab`;
      const ok = await WH.confirm(row ? `Delete ${row.title} forever?` : 'Empty this Trash tab?',
        `${what} will be removed from the database for good${tab === 'customers' ? ', together with all their orders and payments' : ''}${tab === 'orders' ? ', with their items and payments' : ''}.
         <br><br><b style="color:var(--danger)">This cannot be undone.</b>`,
        'Delete forever');
      if (!ok) return;
      try {
        data = await WH.api('trash_purge', row ? { type: tab, id: row.id } : { type: tab, all: true });
        WH.toast(row ? `${row.title} was deleted forever` : 'Trash tab emptied', 'success');
        render();
      } catch (e) { WH.error(e); }
    };

    const load = async () => {
      try { data = await WH.api('trash'); render(); } catch (e) { WH.error(e); }
    };
    load();
    return { refresh: load };
  };
})(window.WH);
