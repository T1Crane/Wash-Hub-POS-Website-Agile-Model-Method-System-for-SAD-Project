/* ==========================================================================
   views/order.js — Order detail modal + shared order actions
   --------------------------------------------------------------------------
   - WH.advanceOrder(order): the ONE-TAP status button used by the board,
                             the dashboard and the detail modal. Asks for
                             payment first if a balance is still unpaid at pickup.
   - WH.collectPayment(order): small "record payment" dialog
   - WH.openOrder(id):       full detail modal (items, payments, history, actions)
   After any change, WH.refresh() re-renders the current page.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** Move an order to the next stage. Returns the updated order (or null if cancelled). */
  WH.advanceOrder = async (order) => {
    const next = WH.nextStatus(order);   // skips Washing / Drying if this order doesn't need it
    if (!next) return null;
    try {
      // A role that can't take payments must leave unpaid orders to someone who can
      if (next.key === 'completed' && order.balance > 0 && !WH.can('order_payment')) {
        WH.toast(`${order.code} still has ${WH.money(order.balance)} unpaid. Ask someone at the counter to collect it and release the order.`, 'error', null, 6000);
        return null;
      }
      // Picking up with an unpaid balance -> ask first
      if (next.key === 'completed' && order.balance > 0) {
        const pick = await WH.choice(
          'Balance not yet paid',
          `<b>${h(order.code)}</b> still has <b>${WH.money(order.balance)}</b> unpaid. Collect payment before releasing the laundry?`,
          [
            { label: 'Cancel', value: null },
            { label: 'Release anyway', value: 'skip', cls: 'btn-danger' },
            { label: 'Collect payment', value: 'pay', cls: 'btn-primary' },
          ]
        );
        if (!pick) return null;
        if (pick === 'pay') {
          const paid = await WH.collectPayment(order);
          if (!paid) return null;
          order = paid;
        }
      }
      const prev = order.status;
      const updated = await WH.api('order_status', { id: order.id, status: next.key });
      WH.toast(`${order.code} → ${WH.statusLabel(updated)}`, 'success', {
        label: 'Undo',
        fn: async () => { await WH.api('order_status', { id: order.id, status: prev }); WH.refresh(); },
      });
      WH.refresh();
      return updated;
    } catch (e) {
      WH.error(e);
      return null;
    }
  };

  /** Payment dialog. Resolves with the updated order, or null if cancelled. */
  WH.collectPayment = (order) => new Promise((resolve) => {
    let done = false;
    let method = 'cash';
    const m = WH.modal({
      title: `Collect payment · ${order.code}`,
      body: `
        <div class="pay-result ${order.payment_status}" style="margin:0 0 14px"><span>Balance due</span><span class="big">${WH.money(order.balance)}</span></div>
        <div class="stack">
          <div class="segmented" data-role="method">
            <button type="button" class="on" data-m="cash">${WH.icon('cash')} Cash</button>
            <button type="button" data-m="gcash">${WH.icon('wallet')} GCash</button>
            <button type="button" data-m="card">${WH.icon('card')} Card</button>
          </div>
          <label class="field">Amount received
            <input type="number" name="amount" min="0" step="0.01" inputmode="decimal" value="${order.balance}">
          </label>
          <div class="small muted" data-role="change"></div>
        </div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Record payment</button>`,
      onClose: () => { if (!done) resolve(null); },
    });
    const amount = m.el.querySelector('[name="amount"]');
    const changeEl = m.el.querySelector('[data-role="change"]');
    const showChange = () => {
      const v = Number(amount.value) || 0;
      changeEl.textContent = v > order.balance ? `Change to give: ${WH.money(v - order.balance)}` : v < order.balance && v > 0 ? `Remaining after this: ${WH.money(order.balance - v)}` : '';
    };
    amount.addEventListener('input', showChange);
    m.el.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => {
      method = b.dataset.m;
      m.el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    m.el.querySelector('[data-act="save"]').onclick = async () => {
      try {
        const updated = await WH.api('order_payment', { id: order.id, amount: Math.min(Number(amount.value) || 0, order.balance), method });
        done = true;
        m.close();
        WH.toast(`Payment recorded · ${WH.payLabel(updated.payment_status)}`, 'success');
        resolve(updated);
      } catch (e) { WH.error(e); }
    };
  });

  /** Full order detail modal */
  WH.openOrder = async (id) => {
    let order;
    try { order = await WH.api('order', { id }); } catch (e) { WH.error(e); return; }

    // Timeline shows only the stages this order goes through (e.g. no "Washing" for a Dry-only order)
    const steps = WH.orderSteps(order);
    const idx = steps.findIndex((s) => s.key === order.status);
    const timeline = steps.map((s, i) => `
      <div class="stage ${i < idx ? 'done' : ''} ${i === idx ? 'done current' : ''}">
        <div class="bar-s"></div>${h(s.key === 'completed' ? WH.statusLabel({ status: 'completed', fulfillment: order.fulfillment }) : s.label)}</div>`).join('');
    const overdue = WH.isOverdue(order);
    const next = WH.advanceLabel(order);
    const prev = WH.prevStatus(order);

    const m = WH.modal({
      title: `Order ${order.code}`,
      wide: true,
      body: `
        <div class="row wrap" style="margin-bottom:10px">
          ${WH.statusPill(order)} ${WH.payPill(order)}
          ${order.is_express ? `<span class="pill express">${WH.icon('zap')} Express</span>` : ''}
          ${overdue ? `<span class="pill overdue">${WH.icon('alert')} Overdue ${WH.duration(Date.now() - new Date(order.ready_at))}</span>` : ''}
          <span class="pill">${WH.icon(order.fulfillment === 'delivery' ? 'truck' : 'store')} ${order.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</span>
        </div>
        <div class="timeline">${timeline}</div>
        <div class="grid-2" style="gap:18px">
          <div class="stack">
            <h3>Customer</h3>
            <dl class="kv">
              <dt>Name</dt><dd>${h(order.customer.name)}</dd>
              <dt>Phone</dt><dd>${h(order.customer.phone || '—')}</dd>
              <dt>Address</dt><dd>${h(order.customer.address || '—')}</dd>
              ${order.customer.notes ? `<dt>Notes</dt><dd>${h(order.customer.notes)}</dd>` : ''}
            </dl>
            <h3>Schedule</h3>
            <dl class="kv">
              <dt>Received</dt><dd>${WH.fmtDateTime(order.created_at)}</dd>
              <dt>Ready by</dt><dd>${WH.fmtDateTime(order.ready_at)}</dd>
              ${order.completed_at ? `<dt>${order.fulfillment === 'delivery' ? 'Delivered' : 'Picked up'}</dt><dd>${WH.fmtDateTime(order.completed_at)}</dd>` : ''}
              ${order.notified_at ? `<dt>Notified</dt><dd>${WH.fmtDateTime(order.notified_at)}</dd>` : ''}
            </dl>
            ${order.notes ? `<h3>Order notes</h3><p style="margin:0">${h(order.notes)}</p>` : ''}
          </div>
          <div class="stack">
            <h3>Items</h3>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Service</th><th class="right">Qty</th><th class="right">Amount</th></tr></thead>
              <tbody>${order.items.map((i) => `<tr><td>${h(i.name)}<div class="tiny muted">${WH.money(i.unit_price)} ${WH.unitLabel(i.unit)}</div></td>
                <td class="right num">${WH.qtyLabel(i.qty, i.unit) || '—'}</td><td class="right num">${WH.money(i.line_total)}</td></tr>`).join('')}</tbody>
            </table></div>
            <div>
              ${order.discount > 0 ? `<div class="sum-row"><span>Discount</span><span>−${WH.money(order.discount)}</span></div>` : ''}
              ${order.loyalty_discount > 0 ? `<div class="sum-row" style="color:var(--success)"><span>★ Loyalty FREE used</span><span>−${WH.money(order.loyalty_discount)}</span></div>` : ''}
              ${order.loyalty_ticks > 0 ? `<div class="sum-row small muted"><span>Loyalty ticks earned</span><span>+${order.loyalty_ticks}</span></div>` : ''}
              <div class="sum-row strong"><span>Total</span><span>${WH.money(order.total)}</span></div>
              ${order.payments.map((p) => `<div class="sum-row small"><span>${WH.methodLabel(p.method)} · ${WH.fmtDateTime(p.paid_at)}</span><span>${WH.money(p.amount)}</span></div>`).join('')}
              <div class="sum-row strong"><span>Balance</span><span>${WH.money(order.balance)}</span></div>
            </div>
            ${order.history && order.history.length ? `<h3>Status history</h3><div class="small">${order.history.map((x) =>
              `<div class="method-row"><span>${h(x.status === 'completed' ? WH.statusLabel(order) : WH.statusInfo(x.status).label)}</span><span class="muted">${WH.fmtDateTime(x.at)}</span></div>`).join('')}</div>` : ''}
          </div>
        </div>`,
      foot: `
        ${WH.can('order_delete') ? `<button class="btn btn-danger" data-act="delete">${WH.icon('trash')} Delete order</button>` : ''}
        ${prev && order.status !== 'received' ? `<button class="btn btn-ghost" data-act="back">${WH.icon('arrowLeft')} Back to ${h(prev.label)}</button>` : ''}
        <span class="spacer"></span>
        ${order.status === 'ready' && WH.can('order_notify') ? `<button class="btn" data-act="notify">${WH.icon('bell')} Notify</button>` : ''}
        ${order.balance > 0 && WH.can('order_payment') ? `<button class="btn" data-act="pay">${WH.icon('cash')} Collect payment</button>` : ''}
        ${WH.can('order_payment') ? `<button class="btn" data-act="ticket">${WH.icon('printer')} Ticket</button>` : ''}
        ${next ? `<button class="btn btn-primary" data-act="next">${h(next)} ${WH.icon('arrowRight')}</button>` : ''}`,
    });

    const on = (act, fn) => { const b = m.el.querySelector(`[data-act="${act}"]`); if (b) b.onclick = fn; };
    const reopen = () => { m.close(); WH.openOrder(order.id); };
    on('next', async () => { const u = await WH.advanceOrder(order); if (u) reopen(); });
    on('back', async () => {
      try { await WH.api('order_status', { id: order.id, status: prev.key }); WH.refresh(); reopen(); } catch (e) { WH.error(e); }
    });
    on('pay', async () => { const u = await WH.collectPayment(order); if (u) { WH.refresh(); reopen(); } });
    on('ticket', () => WH.showTicket(order));
    on('notify', () => WH.notifyCustomer(order, () => { WH.refresh(); reopen(); }));
    on('delete', async () => {
      // Asks first: payments on this order leave the sales reports while it is in the Trash
      const ok = await WH.confirm(
        `Delete order ${order.code}?`,
        `This removes <b>${h(order.code)}</b> for <b>${h(order.customer.name)}</b> (${h(WH.itemsSummary(order.items))}, total ${WH.money(order.total)}).
         ${order.amount_paid > 0 ? `<br><br><b style="color:var(--danger)">${WH.money(order.amount_paid)} already paid on this order will also be left out of the sales reports.</b> Refund the customer if needed.` : ''}
         <br><br>The customer's profile is kept. To fix a mistake, delete this order and create a new one.
         <br><br>${WH.trashNote()}`,
        'Delete order'
      );
      if (!ok) return;
      try {
        await WH.api('order_delete', { id: order.id });
        m.close();
        WH.toast(`Order ${order.code} was deleted`, 'success');
        WH.refresh();
      } catch (e) { WH.error(e); }
    });
  };

  /** Order card used on the board and in dashboard lists */
  WH.orderCard = (o) => {
    const overdue = WH.isOverdue(o);
    const next = WH.advanceLabel(o);
    const remaining = new Date(o.ready_at) - Date.now();
    let when;
    if (o.status === 'completed') when = `${WH.icon('check')} ${WH.statusLabel(o)} ${WH.fmtWhen(o.completed_at)}`;
    else if (o.status === 'ready') when = `${WH.icon('bell')} ${o.notified_at ? 'Notified ' + WH.fmtWhen(o.notified_at) : 'Not yet notified'}`;
    else if (overdue) when = `${WH.icon('alert')} Overdue by ${WH.duration(remaining)}`;
    else when = `${WH.icon('clock')} Ready ${WH.fmtWhen(o.ready_at)} · in ${WH.duration(remaining)}`;
    return `
      <article class="ocard ${overdue ? 'is-overdue' : ''}" style="--stc: var(--st-${o.status})" data-open="${o.id}" tabindex="0">
        <div class="row wrap" style="gap:6px"><span class="code">${h(o.code)}</span><span class="spacer"></span>
          ${o.is_express ? `<span class="pill express">${WH.icon('zap')} Express</span>` : ''}
          ${o.fulfillment === 'delivery' ? `<span class="pill" title="Delivery">${WH.icon('truck')}</span>` : ''}</div>
        <div class="cust">${h(o.customer.name)}</div>
        <div class="items">${h(WH.itemsSummary(o.items))}</div>
        <div class="meta">${WH.payPill(o)}<span class="pill">${WH.money(o.total)}</span></div>
        <div class="when ${overdue ? 'late' : ''}">${when}</div>
        ${next ? `<button class="btn ${o.status === 'ready' ? 'btn-success' : 'btn-primary'} advance" style="margin-top:10px" data-advance="${o.id}">${h(next)} ${WH.icon('arrowRight')}</button>` : ''}
      </article>`;
  };

  /** Wires click handlers for cards rendered with WH.orderCard inside a container */
  WH.bindOrderCards = (root, orders) => {
    const byId = (id) => orders.find((o) => o.id === Number(id));
    root.querySelectorAll('[data-advance]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      b.disabled = true;
      WH.advanceOrder(byId(b.dataset.advance)).finally(() => { b.disabled = false; });
    }));
    root.querySelectorAll('[data-open]').forEach((c) => {
      c.addEventListener('click', () => WH.openOrder(Number(c.dataset.open)));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === c) WH.openOrder(Number(c.dataset.open)); });
    });
  };
})(window.WH);
