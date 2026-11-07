/* ==========================================================================
   views/customers.js — Customer profiles
   --------------------------------------------------------------------------
   Search, add and edit customers (name, phone, address, notes) and see each
   customer's order history. "New order" jumps to the POS with them selected.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** Add/edit dialog. Resolves with the saved customer or null. */
  WH.editCustomer = (c = {}) => new Promise((resolve) => {
    let saved = null;
    const m = WH.modal({
      title: c.id ? `Edit ${c.name}` : 'New customer',
      body: `<div class="stack">
        <label class="field">Full name *<input type="text" name="name" maxlength="100" value="${h(c.name)}"></label>
        <label class="field">Phone number<input type="tel" name="phone" maxlength="30" inputmode="tel" placeholder="09XX XXX XXXX" value="${h(c.phone)}"></label>
        <label class="field">Address<input type="text" name="address" maxlength="255" value="${h(c.address)}"></label>
        <label class="field">Notes (preferences, allergies to detergent…)<input type="text" name="notes" maxlength="255" value="${h(c.notes)}"></label>
      </div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      onClose: () => resolve(saved),
    });
    m.el.querySelector('[data-act="save"]').onclick = async () => {
      try {
        saved = await WH.api('customer_save', { ...WH.formData(m.el), id: c.id });
        WH.toast('Customer saved', 'success');
        m.close();
      } catch (e) { WH.error(e); }
    };
  });

  /** Customer profile with order history */
  const openCustomer = async (c, reload) => {
    let orders = [];
    try { orders = await WH.api('orders', { customer_id: c.id, limit: 100 }); } catch (e) { WH.error(e); }
    const m = WH.modal({
      title: c.name,
      wide: true,
      body: `
        <div class="grid-2" style="margin-bottom:16px">
          <dl class="kv"><dt>Phone</dt><dd>${h(c.phone || '—')}</dd><dt>Address</dt><dd>${h(c.address || '—')}</dd><dt>Notes</dt><dd>${h(c.notes || '—')}</dd></dl>
          <dl class="kv"><dt>Orders</dt><dd>${c.order_count}</dd><dt>Total billed</dt><dd>${WH.money(c.total_spent)}</dd><dt>Last visit</dt><dd>${WH.fmtDate(c.last_order_at)}</dd></dl>
        </div>
        <h3 style="margin-bottom:8px">Order history</h3>
        ${orders.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Order ID</th><th>Date</th><th>Items</th><th class="right">Total</th><th>Payment</th><th>Status</th></tr></thead>
          <tbody>${orders.map((o) => `<tr class="clickable" data-open="${o.id}"><td class="strong">${h(o.code)}</td><td>${WH.fmtDate(o.created_at)}</td>
            <td class="small">${h(WH.itemsSummary(o.items))}</td><td class="right num">${WH.money(o.total)}</td><td>${WH.payPill(o)}</td><td>${WH.statusPill(o)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty">No orders yet.</div>'}`,
      foot: `
        ${WH.can('customer_delete') ? `<button class="btn btn-danger" data-act="delete">${WH.icon('trash')} Delete customer</button><span class="spacer"></span>` : ''}
        <button class="btn" data-act="edit">${WH.icon('edit')} Edit</button><button class="btn btn-primary" data-act="order">${WH.icon('plus')} New order</button>`,
    });
    WH.bindOrderCards(m.el, orders);
    m.el.querySelector('[data-act="edit"]').onclick = async () => { m.close(); if (await WH.editCustomer(c)) reload(); };
    m.el.querySelector('[data-act="order"]').onclick = () => { m.close(); WH.startOrderFor({ id: c.id, name: c.name, phone: c.phone, address: c.address, notes: c.notes }); };

    // Owner / Admin: delete the customer AND all their orders (asks first, warns about unfinished orders)
    const del = m.el.querySelector('[data-act="delete"]');
    if (del) del.onclick = async () => {
      const unfinished = orders.filter((o) => o.status !== 'completed').length;
      const paid = orders.reduce((s, o) => s + o.amount_paid, 0);
      const ok = await WH.confirm(`Delete ${c.name}?`,
        `This permanently deletes <b>${h(c.name)}</b> and <b>all ${orders.length} order${orders.length === 1 ? '' : 's'}</b> in their history${paid > 0 ? `, including ${WH.money(paid)} in payments (Reports will change)` : ''}.
         ${unfinished ? `<br><br><b style="color:var(--danger)">${unfinished} of these orders are not finished yet</b> — make sure the laundry was returned first.` : ''}
         <br><br>This cannot be undone.`,
        'Delete permanently');
      if (!ok) return;
      try {
        const r = await WH.api('customer_delete', { id: c.id });
        m.close();
        WH.toast(`${r.deleted} and ${r.orders} order${r.orders === 1 ? '' : 's'} deleted`, 'success');
        reload();
        WH.updateBadges();
      } catch (e) { WH.error(e); }
    };
  };

  WH.views = WH.views || {};
  WH.views.customers = (view) => {
    view.innerHTML = `
      <div class="toolbar">
        <input type="search" class="search" id="c-q" placeholder="Search name or phone…">
        <span class="spacer"></span>
        <button class="btn btn-primary" id="c-add">${WH.icon('plus')} Add customer</button>
      </div>
      <div id="c-body"><div class="loading">Loading…</div></div>`;
    const q = view.querySelector('#c-q');

    const load = async () => {
      let list;
      try { list = await WH.api('customers', { q: q.value.trim(), limit: 300 }); } catch (e) { WH.error(e); return; }
      const body = view.querySelector('#c-body');
      body.innerHTML = list.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th>Phone</th><th>Address / notes</th><th class="right">Orders</th><th class="right">Total billed</th><th>Last visit</th></tr></thead>
          <tbody>${list.map((c, i) => `<tr class="clickable" data-i="${i}">
            <td><div class="row"><span class="avatar" style="width:34px;height:34px;font-size:.8rem">${h(WH.initials(c.name))}</span><b>${h(c.name)}</b></div></td>
            <td>${h(c.phone || '—')}</td>
            <td class="small">${h(c.address)}${c.notes ? `<div class="muted">${h(c.notes)}</div>` : ''}</td>
            <td class="right num">${c.order_count}</td>
            <td class="right num">${WH.money(c.total_spent)}</td>
            <td>${WH.fmtDate(c.last_order_at)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="card empty">${WH.icon('users')}<div>No customers found.</div></div>`;
      body.querySelectorAll('[data-i]').forEach((tr) => tr.addEventListener('click', () => openCustomer(list[Number(tr.dataset.i)], load)));
    };

    q.addEventListener('input', WH.debounce(load, 250));
    view.querySelector('#c-add').onclick = async () => { if (await WH.editCustomer()) load(); };
    load();
    return { refresh: load };
  };
})(window.WH);
