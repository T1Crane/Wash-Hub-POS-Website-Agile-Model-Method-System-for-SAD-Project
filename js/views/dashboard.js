/* ==========================================================================
   views/dashboard.js — Daily overview for the shop owner / staff
   --------------------------------------------------------------------------
   - KPI tiles: today's sales, last 7 days, active orders, ready, overdue
   - 7-day sales bar chart (money received per day)
   - Workflow counts per stage
   - Lists: overdue orders, ready for pickup (notify customer), low stock
   Data comes from the "dashboard" API action.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** Simple single-series bar chart (no library). rows: [{label, value, tip, highlight}] */
  WH.barChart = (rows) => {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `
      <div class="bars" role="img" aria-label="Bar chart">
        ${rows.map((r) => `<div class="bar-col ${r.highlight ? 'today' : ''}">
            <span class="bar-tip">${h(r.tip)}</span>
            ${r.showValue ? `<span class="bar-val">${h(r.short)}</span>` : ''}
            <div class="bar" style="height:${Math.max(1, (r.value / max) * 100)}%"></div>
          </div>`).join('')}
      </div>
      <div class="bar-labels">${rows.map((r) => `<span>${h(r.label)}</span>`).join('')}</div>`;
  };
  /** ₱12,345 -> "₱12.3k" for bar labels */
  WH.shortMoney = (n) => (n >= 1000 ? '₱' + WH.num(n / 1000, 1) + 'k' : '₱' + WH.num(n, 0));

  WH.views = WH.views || {};
  WH.views.dashboard = (view) => {
    view.innerHTML = '<div class="loading">Loading dashboard…</div>';

    const load = async () => {
      let d;
      try { d = await WH.api('dashboard'); } catch (e) { WH.error(e); return; }
      if (!view.isConnected) return;
      const sc = d.status_counts;
      const methodsTotal = d.today_methods.cash + d.today_methods.gcash + d.today_methods.card;

      view.innerHTML = `
        <div class="kpis">
          <div class="kpi"><div class="label">${WH.icon('cash')} Today's sales</div><div class="value">${WH.money(d.today_sales)}</div>
            <div class="sub">${d.today_orders} new order${d.today_orders === 1 ? '' : 's'} · ${WH.num(d.today_kg)} kg</div></div>
          <div class="kpi"><div class="label">${WH.icon('chart')} Last 7 days</div><div class="value">${WH.money(d.week_sales)}</div>
            <div class="sub">Avg ${WH.money(d.week_sales / 7)} per day</div></div>
          <div class="kpi"><div class="label">${WH.icon('board')} In progress</div><div class="value">${d.active_count}</div>
            <div class="sub">${sc.received + sc.washing + sc.drying} being processed</div></div>
          <div class="kpi"><div class="label">${WH.icon('bell')} Ready for pickup</div><div class="value">${sc.ready}</div>
            <div class="sub">${d.ready.filter((o) => !o.notified_at).length} not yet notified</div></div>
          <div class="kpi ${d.overdue.length ? 'alert' : ''}"><div class="label">${WH.icon('alert')} Overdue</div><div class="value">${d.overdue.length}</div>
            <div class="sub">Past promised time</div></div>
          <div class="kpi"><div class="label">${WH.icon('wallet')} Uncollected</div><div class="value">${WH.money(d.receivable)}</div>
            <div class="sub">Unpaid balances</div></div>
        </div>

        <div class="dash-grid">
          <div class="card">
            <div class="card-head"><h2>Sales — last 7 days</h2><a class="btn btn-sm btn-ghost" href="#/reports">Full report ${WH.icon('arrowRight')}</a></div>
            ${WH.barChart(d.week.map((w, i) => ({
              label: i === 6 ? 'Today' : w.label,
              value: w.total,
              short: WH.shortMoney(w.total),
              tip: `${WH.fmtDate(w.date + 'T12:00:00')}: ${WH.money(w.total)}`,
              highlight: i === 6,
              showValue: true,
            })))}
          </div>
          <div class="card">
            <div class="card-head"><h2>Workflow now</h2><a class="btn btn-sm btn-ghost" href="#/board">Open board ${WH.icon('arrowRight')}</a></div>
            <div class="pipeline">
              ${['received', 'washing', 'drying', 'ready'].map((k) => `<a class="pipe st-${k}" href="#/board"><div class="n">${sc[k]}</div><div class="t">${h(WH.statusInfo(k).label)}</div></a>`).join('')}
            </div>
            <h3 style="margin:18px 0 6px">Today's payments</h3>
            ${['cash', 'gcash', 'card'].map((m) => `<div class="method-row"><span>${WH.icon(m === 'gcash' ? 'wallet' : m)} ${WH.methodLabel(m)}</span><span class="strong num">${WH.money(d.today_methods[m])}</span></div>`).join('')}
            <div class="method-row strong"><span>Total</span><span class="num">${WH.money(methodsTotal)}</span></div>
          </div>
        </div>

        <div class="dash-grid-3">
          <div class="card">
            <div class="card-head"><h2 style="color:${d.overdue.length ? 'var(--danger)' : 'inherit'}">${WH.icon('alert')} Overdue orders</h2></div>
            <div class="mini-list" id="dash-overdue">${d.overdue.length ? d.overdue.map((o) => `
              <div class="mini-item">
                <div class="grow" data-open="${o.id}" style="cursor:pointer"><div class="title">${h(o.code)} · ${h(o.customer.name)}</div>
                  <div class="meta">${h(WH.statusLabel(o))} · was due ${WH.fmtWhen(o.ready_at)} (${WH.duration(Date.now() - new Date(o.ready_at))} late)</div></div>
                <button class="btn btn-sm btn-primary" data-advance="${o.id}">${h(WH.advanceLabel(o))}</button>
              </div>`).join('') : `<div class="empty small">${WH.icon('check')}<div>Everything is on time.</div></div>`}</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>${WH.icon('bell')} Ready — notify customer</h2></div>
            <div class="mini-list" id="dash-ready">${d.ready.length ? d.ready.map((o) => `
              <div class="mini-item">
                <div class="grow" data-open="${o.id}" style="cursor:pointer"><div class="title">${h(o.code)} · ${h(o.customer.name)}</div>
                  <div class="meta">${o.notified_at ? `${WH.icon('check')} Notified ${WH.fmtWhen(o.notified_at)}` : 'Not yet notified'} · ${o.balance > 0 ? WH.money(o.balance) + ' due' : 'Paid'}</div></div>
                <button class="btn btn-sm ${o.notified_at ? '' : 'btn-primary'}" data-notify="${o.id}">${WH.icon('bell')} ${o.notified_at ? 'Again' : 'Notify'}</button>
              </div>`).join('') : '<div class="empty small">No orders waiting for pickup.</div>'}</div>
          </div>
          <div class="card">
            <div class="card-head"><h2>${WH.icon('box')} Low stock</h2><a class="btn btn-sm btn-ghost" href="#/inventory">Inventory ${WH.icon('arrowRight')}</a></div>
            <div class="mini-list">${d.low_stock.length ? d.low_stock.map((i) => `
              <div class="mini-item"><div class="grow"><div class="title">${h(i.name)}</div>
                <div class="meta">Reorder at ${WH.num(i.reorder_level)} ${h(i.unit)}</div></div>
                <span class="pill low">${WH.num(i.stock)} ${h(i.unit)} left</span></div>`).join('') : `<div class="empty small">${WH.icon('check')}<div>All supplies are stocked.</div></div>`}</div>
          </div>
        </div>`;

      WH.bindOrderCards(view, [...d.overdue, ...d.ready]);
      view.querySelectorAll('[data-notify]').forEach((b) => b.addEventListener('click', () => {
        WH.notifyCustomer(d.ready.find((o) => o.id === Number(b.dataset.notify)), load);
      }));
    };

    load();
    const timer = setInterval(() => { if (!document.querySelector('.modal-backdrop')) load(); }, 60000);
    return { refresh: load, destroy: () => clearInterval(timer) };
  };
})(window.WH);
