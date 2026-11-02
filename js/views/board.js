/* ==========================================================================
   views/board.js — Order status & workflow board
   --------------------------------------------------------------------------
   Board view: Kanban columns  Received → Washing → Drying → Folding/Ready →
               Picked Up/Delivered (last 24 hours only, to keep it short).
               Each card has a single-tap button that moves it forward.
   List view:  searchable table of all orders with status filters.
   Refreshes every 30 seconds so several counters/tablets stay in sync.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  // Remember the chosen layout/filter while the app is open
  const ui = { layout: 'board', filter: 'active', q: '' };
  try { ui.layout = localStorage.getItem('washhub_board_layout') || 'board'; } catch (e) { /* ignore */ }

  WH.views = WH.views || {};
  WH.views.board = (view, params) => {
    if (params.q !== undefined) ui.q = params.q;
    if (params.filter) { ui.filter = params.filter; ui.layout = 'list'; }

    view.innerHTML = `
      <div class="toolbar">
        <input type="search" class="search" id="b-q" placeholder="Search order ID, name or phone…" value="${h(ui.q)}">
        <div class="segmented" id="b-layout" style="width:220px">
          <button type="button" data-l="board">${WH.icon('board')} Board</button>
          <button type="button" data-l="list">${WH.icon('list')} List</button>
        </div>
        <span class="spacer"></span>
        <button class="btn" id="b-refresh" title="Refresh">${WH.icon('refresh')}</button>
        ${WH.can('order_create') ? `<a class="btn btn-primary" href="#/pos">${WH.icon('plus')} New order</a>` : ''}
      </div>
      <div id="b-filters" class="row wrap" style="margin-bottom:14px"></div>
      <div id="b-body"><div class="loading">Loading orders…</div></div>`;

    const $ = (s) => view.querySelector(s);
    const setLayout = () => view.querySelectorAll('[data-l]').forEach((b) => b.classList.toggle('on', b.dataset.l === ui.layout));

    const load = async () => {
      try {
        const payload = ui.layout === 'board'
          ? { status: 'all', completed_since_hours: 24, q: ui.q }
          : { status: ui.filter, q: ui.q, limit: 500 };
        const orders = await WH.api('orders', payload);
        if (!view.isConnected) return;
        ui.layout === 'board' ? renderBoard(orders) : renderList(orders);
      } catch (e) { WH.error(e); }
    };

    const renderBoard = (orders) => {
      $('#b-filters').innerHTML = '';
      $('#b-body').innerHTML = `<div class="board">${WH.STATUSES.map((s) => {
        // oldest first inside a column = first in, first out
        const list = orders.filter((o) => o.status === s.key).sort((a, b) => a.ready_at.localeCompare(b.ready_at));
        return `<section class="col" aria-label="${h(s.label)}">
          <div class="col-head"><span class="dot" style="background:var(--st-${s.key})"></span>${h(s.label)}<span class="count">${list.length}</span></div>
          ${s.key === 'completed' ? '<div class="tiny muted" style="padding:0 6px 8px">Last 24 hours</div>' : ''}
          <div class="col-cards">${list.map(WH.orderCard).join('') || '<div class="empty small">No orders</div>'}</div>
        </section>`;
      }).join('')}</div>`;
      WH.bindOrderCards($('#b-body'), orders);
    };

    const FILTERS = [['active', 'Active'], ['overdue', 'Overdue'], ...WH.STATUSES.map((s) => [s.key, s.label]), ['all', 'All']];
    const renderList = (orders) => {
      $('#b-filters').innerHTML = FILTERS.map(([k, l]) => `<button class="btn btn-sm ${ui.filter === k ? 'btn-primary' : ''}" data-filter="${k}">${h(l)}</button>`).join('');
      view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { ui.filter = b.dataset.filter; load(); }));
      $('#b-body').innerHTML = orders.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th class="right">Total</th><th>Payment</th><th>Status</th><th>Ready by</th><th></th></tr></thead>
          <tbody>${orders.map((o) => {
            const next = WH.advanceLabel(o);
            const late = WH.isOverdue(o);
            return `<tr class="clickable" data-open="${o.id}">
              <td class="strong" style="font-family:ui-monospace,Consolas,monospace">${h(o.code)} ${o.is_express ? `<span class="pill express">${WH.icon('zap')}</span>` : ''}</td>
              <td>${h(o.customer.name)}<div class="tiny muted">${h(o.customer.phone)}</div></td>
              <td class="small">${h(WH.itemsSummary(o.items))}</td>
              <td class="right num strong">${WH.money(o.total)}</td>
              <td>${WH.payPill(o)}</td>
              <td>${WH.statusPill(o)}</td>
              <td class="small ${late ? 'strong' : ''}" style="${late ? 'color:var(--danger)' : ''}">${WH.fmtWhen(o.ready_at)}${late ? '<br>Overdue' : ''}</td>
              <td>${next ? `<button class="btn btn-sm ${o.status === 'ready' ? 'btn-success' : 'btn-primary'}" data-advance="${o.id}">${h(next)}</button>` : ''}</td>
            </tr>`;
          }).join('')}</tbody></table></div>`
        : `<div class="card empty">${WH.icon('search')}<div>No orders found.</div></div>`;
      WH.bindOrderCards($('#b-body'), orders);
    };

    setLayout();
    $('#b-layout').addEventListener('click', (e) => {
      const b = e.target.closest('[data-l]'); if (!b) return;
      ui.layout = b.dataset.l;
      try { localStorage.setItem('washhub_board_layout', ui.layout); } catch (err) { /* ignore */ }
      setLayout(); load();
    });
    $('#b-q').addEventListener('input', WH.debounce((e) => { ui.q = e.target.value.trim(); load(); }, 250));
    $('#b-refresh').onclick = load;

    load();
    const timer = setInterval(() => { if (!document.querySelector('.modal-backdrop')) load(); }, 30000);
    return { refresh: load, destroy: () => clearInterval(timer) };
  };
})(window.WH);
