/* ==========================================================================
   views/reports.js — Sales reports for any date range
   --------------------------------------------------------------------------
   "Collected" = payments received in the range (cash flow).
   "Billed"    = total value of orders received in the range.
   Includes per-day table + chart, revenue per service, payment methods,
   Print and CSV export.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;
  const range = { from: '', to: '' };

  WH.views = WH.views || {};
  WH.views.reports = (view) => {
    const today = new Date();
    const presets = {
      today: () => [WH.ymd(today), WH.ymd(today)],
      week: () => [WH.ymd(new Date(Date.now() - 6 * 86400000)), WH.ymd(today)],
      month: () => [WH.ymd(new Date(today.getFullYear(), today.getMonth(), 1)), WH.ymd(today)],
      lastMonth: () => [WH.ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)), WH.ymd(new Date(today.getFullYear(), today.getMonth(), 0))],
    };
    if (!range.from) [range.from, range.to] = presets.week();

    view.innerHTML = `
      <div class="toolbar">
        <label class="field" style="width:170px">From<input type="date" id="r-from" value="${range.from}"></label>
        <label class="field" style="width:170px">To<input type="date" id="r-to" value="${range.to}"></label>
        <div class="row wrap" style="align-self:flex-end">
          <button class="btn btn-sm" data-p="today">Today</button>
          <button class="btn btn-sm" data-p="week">Last 7 days</button>
          <button class="btn btn-sm" data-p="month">This month</button>
          <button class="btn btn-sm" data-p="lastMonth">Last month</button>
        </div>
        <span class="spacer"></span>
        <div class="row" style="align-self:flex-end">
          <button class="btn" id="r-csv">${WH.icon('download')} CSV</button>
          <button class="btn btn-primary" id="r-print">${WH.icon('printer')} Print</button>
        </div>
      </div>
      <div id="r-body"><div class="loading">Loading report…</div></div>`;

    let report = null;
    const $ = (s) => view.querySelector(s);

    const body = (r) => {
      const t = r.totals;
      const many = r.days.length > 14;
      return `
        <div class="kpis">
          <div class="kpi"><div class="label">Collected</div><div class="value">${WH.money(t.collected)}</div><div class="sub">Payments received</div></div>
          <div class="kpi"><div class="label">Billed</div><div class="value">${WH.money(t.billed)}</div><div class="sub">Value of new orders</div></div>
          <div class="kpi"><div class="label">Orders</div><div class="value">${t.orders}</div><div class="sub">Avg ${WH.money(t.average)}</div></div>
          <div class="kpi"><div class="label">Laundry processed</div><div class="value">${WH.num(t.kg)} kg</div><div class="sub">Per-kg services</div></div>
        </div>
        <div class="card" style="margin-bottom:18px">
          <div class="card-head"><h2>Collected per day</h2><span class="small muted">${WH.fmtDate(r.from + 'T12:00:00')} – ${WH.fmtDate(r.to + 'T12:00:00')}</span></div>
          ${WH.barChart(r.days.map((d) => {
            const dt = new Date(d.date + 'T12:00:00');
            return {
              label: many ? String(dt.getDate()) : dt.toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric' }),
              value: d.collected, short: WH.shortMoney(d.collected),
              tip: `${WH.fmtDate(d.date + 'T12:00:00')}: ${WH.money(d.collected)} · ${d.orders} orders`,
              showValue: !many, highlight: d.date === WH.ymd(new Date()),
            };
          }))}
        </div>
        <div class="dash-grid">
          <div class="card">
            <div class="card-head"><h2>Daily breakdown</h2></div>
            <div class="table-wrap"><table class="table">
              <thead><tr><th>Date</th><th class="right">Orders</th><th class="right">Kg</th><th class="right">Billed</th><th class="right">Collected</th></tr></thead>
              <tbody>${r.days.slice().reverse().map((d) => `<tr><td>${WH.fmtDate(d.date + 'T12:00:00')}</td><td class="right num">${d.orders}</td>
                <td class="right num">${WH.num(d.kg)}</td><td class="right num">${WH.money(d.billed)}</td><td class="right num strong">${WH.money(d.collected)}</td></tr>`).join('')}
                <tr><td class="strong">Total</td><td class="right num strong">${t.orders}</td><td class="right num strong">${WH.num(t.kg)}</td>
                <td class="right num strong">${WH.money(t.billed)}</td><td class="right num strong">${WH.money(t.collected)}</td></tr></tbody>
            </table></div>
          </div>
          <div class="stack" style="gap:18px">
            <div class="card">
              <div class="card-head"><h2>Revenue by service</h2></div>
              ${r.services.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Service</th><th class="right">Qty</th><th class="right">Revenue</th></tr></thead>
                <tbody>${r.services.map((s) => `<tr><td>${h(s.name)}<div class="tiny muted">${s.orders} orders</div></td>
                  <td class="right num">${WH.qtyLabel(s.qty, s.unit) || s.orders + '×'}</td><td class="right num strong">${WH.money(s.revenue)}</td></tr>`).join('')}</tbody></table></div>`
                : '<div class="empty small">No orders in this range.</div>'}
            </div>
            <div class="card">
              <div class="card-head"><h2>Payment methods</h2></div>
              ${r.methods.length ? r.methods.map((m) => `<div class="method-row"><span>${WH.methodLabel(m.method)} <span class="muted small">(${m.count})</span></span><span class="strong num">${WH.money(m.total)}</span></div>`).join('')
                : '<div class="empty small">No payments in this range.</div>'}
            </div>
          </div>
        </div>`;
    };

    const load = async () => {
      range.from = $('#r-from').value;
      range.to = $('#r-to').value;
      try { report = await WH.api('report', { from: range.from, to: range.to }); } catch (e) { WH.error(e); return; }
      $('#r-body').innerHTML = body(report);
    };

    $('#r-from').addEventListener('change', load);
    $('#r-to').addEventListener('change', load);
    view.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
      const [f, t] = presets[b.dataset.p]();
      $('#r-from').value = f; $('#r-to').value = t; load();
    }));
    $('#r-print').onclick = () => {
      if (!report) return;
      const s = WH.state.settings;
      WH.printHTML(`<div class="report-print"><h1>${h(s.shop_name)} — Sales Report</h1>
        <p>${WH.fmtDate(report.from + 'T12:00:00')} – ${WH.fmtDate(report.to + 'T12:00:00')} · printed ${WH.fmtDateTime(new Date().toISOString())}</p>${body(report)}</div>`);
    };
    $('#r-csv').onclick = () => {
      if (!report) return;
      const rows = [['Date', 'Orders', 'Kg', 'Billed', 'Collected'], ...report.days.map((d) => [d.date, d.orders, d.kg, d.billed, d.collected])];
      WH.downloadText(`washhub-report-${report.from}-to-${report.to}.csv`, rows.map((r) => r.join(',')).join('\r\n'));
    };

    load();
    return { refresh: load };
  };
})(window.WH);
