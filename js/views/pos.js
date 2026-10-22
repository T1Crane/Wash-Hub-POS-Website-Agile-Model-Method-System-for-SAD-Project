/* ==========================================================================
   views/pos.js — "New Order" POS counter
   --------------------------------------------------------------------------
   Flow:  1) tap services  2) enter kg / pieces  3) pick or add customer
          4) choose payment  ->  Create order  ->  claim ticket opens
   The draft (WH.posDraft) is kept in memory, so switching pages doesn't
   lose a half-finished order. Totals shown here are a preview; the backend
   recalculates the real prices when the order is saved.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  const newDraft = () => ({
    lines: [],            // [{ service_id, qty }]
    customer: null,       // selected existing customer {id, name, phone, address, notes}
    newCustomer: null,    // quick-add form values {name, phone, address, notes}
    fulfillment: 'pickup',
    notes: '',
    discount: '',
    method: 'cash',
    tendered: '',
  });
  WH.posDraft = WH.posDraft || newDraft();

  /** Lets other pages start an order for a known customer */
  WH.startOrderFor = (customer) => {
    WH.posDraft = newDraft();
    WH.posDraft.customer = customer;
    WH.navigate('pos');
  };

  WH.views = WH.views || {};
  WH.views.pos = (view) => {
    const d = WH.posDraft;
    const services = () => WH.state.services.filter((s) => s.active);
    const svc = (id) => WH.state.services.find((s) => s.id === id);

    view.innerHTML = `
      <div class="pos">
        <section class="stack" style="gap:18px">
          <div class="card">
            <div class="card-head"><h2><span class="step-no">1</span>Tap a service</h2></div>
            <div class="svc-grid" id="pos-tiles"></div>
          </div>
          <div class="card">
            <div class="card-head"><h2><span class="step-no">2</span>Weight & quantity</h2>
              <button class="btn btn-ghost btn-sm" id="pos-clear">${WH.icon('trash')} Clear</button></div>
            <div class="lines" id="pos-lines"></div>
          </div>
          <div class="card">
            <div class="grid-2">
              <div class="field" style="font-weight:600;font-size:.9rem;color:var(--ink-2)">Pickup or delivery
                <div class="segmented" id="pos-fulfil" style="margin-top:6px">
                  <button type="button" data-f="pickup">${WH.icon('store')} Pickup</button>
                  <button type="button" data-f="delivery">${WH.icon('truck')} Delivery</button>
                </div>
              </div>
              <label class="field">Order notes (stains, special care…)
                <input type="text" id="pos-notes" maxlength="255" placeholder="e.g. separate whites, no fabcon" value="${h(d.notes)}">
              </label>
            </div>
          </div>
        </section>

        <aside class="pos-right">
          <div class="card">
            <div class="card-head"><h2><span class="step-no">3</span>Customer</h2></div>
            <div id="pos-customer"></div>
          </div>
          <div class="card">
            <div class="card-head"><h2><span class="step-no">4</span>Payment</h2></div>
            <div id="pos-totals"></div>
            <div class="segmented" id="pos-method" style="margin-top:12px">
              <button type="button" data-m="cash">${WH.icon('cash')} Cash</button>
              <button type="button" data-m="gcash">${WH.icon('wallet')} GCash</button>
              <button type="button" data-m="card">${WH.icon('card')} Card</button>
            </div>
            <label class="field" style="margin-top:12px">Amount received now
              <input type="number" id="pos-tendered" min="0" step="0.01" inputmode="decimal" placeholder="0.00 = pay on pickup" value="${h(d.tendered)}">
            </label>
            <div class="quick-cash" id="pos-quick"></div>
            <div id="pos-payresult"></div>
          </div>
          <button class="btn btn-primary btn-xl" id="pos-submit">${WH.icon('printer')} Create order & print ticket</button>
        </aside>
      </div>`;

    const $ = (sel) => view.querySelector(sel);

    // ---------- Totals preview (same rules as the backend) ----------
    const calc = () => {
      let subtotal = 0, weight = 0, hours = 0, express = null;
      d.lines.forEach((l) => {
        const s = svc(l.service_id);
        if (!s) return;
        const qty = s.unit === 'flat' ? 1 : Number(l.qty) || 0;
        subtotal += qty * s.price;
        if (s.unit === 'kg') weight += qty;
        if (s.is_express) express = s; else hours = Math.max(hours, s.turnaround_hours);
      });
      if (express) hours = express.turnaround_hours;
      subtotal = WH.round2(subtotal);
      const discount = Math.min(Math.max(WH.round2(d.discount), 0), subtotal);
      const total = WH.round2(subtotal - discount);
      const tendered = Math.max(0, WH.round2(d.tendered));
      const applied = Math.min(tendered, total);
      return {
        subtotal, discount, total, weight, express,
        readyAt: new Date(Date.now() + (hours || 24) * 3600000),
        tendered, applied,
        change: WH.round2(Math.max(tendered - total, 0)),
        balance: WH.round2(total - applied),
        status: applied <= 0 && total > 0 ? 'unpaid' : applied >= total ? 'paid' : 'partial',
      };
    };

    // ---------- 1) Service tiles ----------
    const renderTiles = () => {
      $('#pos-tiles').innerHTML = services().map((s) => {
        const inCart = d.lines.some((l) => l.service_id === s.id);
        return `<button type="button" class="tile c-${h(s.color)} ${inCart ? 'in-cart' : ''}" data-svc="${s.id}">
          ${inCart ? `<span class="t-check">${WH.icon('check')}</span>` : ''}
          <span class="t-name">${s.is_express ? WH.icon('zap') + ' ' : ''}${h(s.name)}</span>
          <span class="t-unit">${WH.unitLabel(s.unit)} · ${s.turnaround_hours}h</span>
          <span class="t-price">${WH.money(s.price)}${s.unit === 'kg' ? '<small style="font-size:.8rem">/kg</small>' : s.unit === 'pc' ? '<small style="font-size:.8rem">/pc</small>' : ''}</span>
        </button>`;
      }).join('') || '<div class="empty">No active services. Add some in Settings.</div>';
      view.querySelectorAll('[data-svc]').forEach((b) => b.addEventListener('click', () => tapService(Number(b.dataset.svc))));
    };

    const tapService = (id) => {
      const s = svc(id);
      const existing = d.lines.find((l) => l.service_id === id);
      if (s.unit === 'flat') {
        // add-ons toggle on/off
        if (existing) d.lines = d.lines.filter((l) => l !== existing);
        else d.lines.push({ service_id: id, qty: 1 });
      } else if (existing) {
        if (s.unit === 'pc') existing.qty = (Number(existing.qty) || 0) + 1;
      } else {
        d.lines.push({ service_id: id, qty: s.unit === 'pc' ? 1 : '' });
      }
      renderTiles();
      renderLines();
      renderTotals();
      // kg services: jump straight to the weight box
      const input = view.querySelector(`[data-qty="${id}"]`);
      if (input && s.unit === 'kg') { input.focus(); input.select(); }
    };

    // ---------- 2) Order lines ----------
    const renderLines = () => {
      if (!d.lines.length) {
        $('#pos-lines').innerHTML = `<div class="empty">${WH.icon('plus')}<div>Tap a service above to start the order.</div></div>`;
        return;
      }
      $('#pos-lines').innerHTML = d.lines.map((l) => {
        const s = svc(l.service_id);
        if (!s) return '';
        const qtyBox = s.unit === 'flat'
          ? '<span class="pill">Add-on</span>'
          : `<div class="stepper">
               <button type="button" data-step="${s.id}" data-dir="-1" aria-label="Less">−</button>
               <input type="number" min="0" step="${s.unit === 'kg' ? '0.1' : '1'}" inputmode="decimal" data-qty="${s.id}" value="${h(l.qty)}" placeholder="0" aria-label="${s.unit === 'kg' ? 'Weight in kg' : 'Pieces'}">
               <span class="u">${s.unit === 'kg' ? 'kg' : 'pcs'}</span>
               <button type="button" data-step="${s.id}" data-dir="1" aria-label="More">+</button>
             </div>`;
        return `<div class="line" data-line="${s.id}">
            <div><div class="l-name">${h(s.name)}</div><div class="l-rate">${WH.money(s.price)} ${WH.unitLabel(s.unit)}</div></div>
            ${qtyBox}
            <div class="l-total" data-total="${s.id}"></div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" data-remove="${s.id}" aria-label="Remove">${WH.icon('x')}</button>
          </div>`;
      }).join('');
      updateLineTotals();

      view.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('input', () => {
        d.lines.find((l) => l.service_id === Number(inp.dataset.qty)).qty = inp.value;
        updateLineTotals();
        renderTotals();
      }));
      view.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        const id = Number(b.dataset.step);
        const s = svc(id);
        const line = d.lines.find((l) => l.service_id === id);
        const step = s.unit === 'kg' ? 0.5 : 1;
        line.qty = Math.max(0, WH.round2((Number(line.qty) || 0) + step * Number(b.dataset.dir)));
        view.querySelector(`[data-qty="${id}"]`).value = line.qty;
        updateLineTotals();
        renderTotals();
      }));
      view.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
        d.lines = d.lines.filter((l) => l.service_id !== Number(b.dataset.remove));
        renderTiles(); renderLines(); renderTotals();
      }));
    };

    const updateLineTotals = () => {
      d.lines.forEach((l) => {
        const s = svc(l.service_id);
        const el = view.querySelector(`[data-total="${l.service_id}"]`);
        if (!s || !el) return;
        const qty = s.unit === 'flat' ? 1 : Number(l.qty) || 0;
        el.textContent = WH.money(qty * s.price);
        el.parentElement.classList.remove('invalid');
      });
    };

    // ---------- 3) Customer lookup / quick add ----------
    const renderCustomer = () => {
      const box = $('#pos-customer');
      if (d.customer) {
        const c = d.customer;
        box.innerHTML = `
          <div class="cust-card">
            <div class="avatar">${h(WH.initials(c.name))}</div>
            <div style="flex:1;min-width:0">
              <div class="strong">${h(c.name)}</div>
              <div class="small">${h(c.phone || 'No phone')}</div>
              ${c.address ? `<div class="small muted">${h(c.address)}</div>` : ''}
              ${c.notes ? `<div class="small muted">Note: ${h(c.notes)}</div>` : ''}
            </div>
            <button class="btn btn-sm" id="cust-change">Change</button>
          </div>`;
        $('#cust-change').onclick = () => { d.customer = null; renderCustomer(); $('#cust-q').focus(); };
        return;
      }
      if (d.newCustomer) {
        const n = d.newCustomer;
        box.innerHTML = `
          <div class="stack">
            <label class="field">Full name *<input type="text" data-nc="name" maxlength="100" value="${h(n.name)}" autocomplete="off"></label>
            <label class="field">Phone number<input type="tel" data-nc="phone" maxlength="30" inputmode="tel" placeholder="09XX XXX XXXX" value="${h(n.phone)}"></label>
            <label class="field">Address / notes<input type="text" data-nc="address" maxlength="255" placeholder="For delivery, landmarks…" value="${h(n.address)}"></label>
            <button class="btn btn-ghost btn-sm" id="cust-search-again">${WH.icon('search')} Search existing instead</button>
          </div>`;
        box.querySelectorAll('[data-nc]').forEach((inp) => inp.addEventListener('input', () => { n[inp.dataset.nc] = inp.value; }));
        $('#cust-search-again').onclick = () => { d.newCustomer = null; renderCustomer(); };
        setTimeout(() => box.querySelector(n.name ? '[data-nc="phone"]' : '[data-nc="name"]').focus(), 0);
        return;
      }
      box.innerHTML = `
        <div class="row">
          <input type="search" id="cust-q" placeholder="Search name or phone…" autocomplete="off" aria-label="Search customer">
          <button class="btn" id="cust-new" title="New customer">${WH.icon('plus')} New</button>
        </div>
        <div id="cust-results"></div>`;
      const q = $('#cust-q');
      const results = $('#cust-results');
      const search = WH.debounce(async () => {
        const term = q.value.trim();
        if (!term) { results.innerHTML = ''; return; }
        try {
          const list = await WH.api('customers', { q: term, limit: 8 });
          if (q.value.trim() !== term) return; // user kept typing
          results.innerHTML = `<div class="cust-results">
            ${list.map((c, i) => `<button type="button" data-pick="${i}"><span class="avatar" style="width:34px;height:34px;font-size:.8rem">${h(WH.initials(c.name))}</span>
              <span style="flex:1"><b>${h(c.name)}</b><br><span class="small muted">${h(c.phone || 'No phone')} · ${c.order_count} order${c.order_count === 1 ? '' : 's'}</span></span></button>`).join('')}
            <button type="button" data-add>${WH.icon('plus')}<span>Add “${h(term)}” as new customer</span></button>
          </div>`;
          results.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { d.customer = list[Number(b.dataset.pick)]; renderCustomer(); }));
          results.querySelector('[data-add]').addEventListener('click', () => startNew(term));
        } catch (e) { WH.error(e); }
      }, 200);
      q.addEventListener('input', search);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = results.querySelector('[data-pick]'); if (first) first.click(); } });
      $('#cust-new').onclick = () => startNew(q.value.trim());
    };
    const startNew = (term) => {
      const isPhone = /^[\d+\s-]{4,}$/.test(term);
      d.newCustomer = { name: isPhone ? '' : term, phone: isPhone ? term : '', address: '', notes: '' };
      renderCustomer();
    };

    // ---------- 4) Totals + payment ----------
    const renderTotals = () => {
      const c = calc();
      $('#pos-totals').innerHTML = `
        ${c.weight > 0 ? `<div class="sum-row"><span>Total weight</span><span class="strong">${WH.num(c.weight)} kg</span></div>` : ''}
        <div class="sum-row"><span>Subtotal</span><span>${WH.money(c.subtotal)}</span></div>
        <div class="sum-row"><span>Discount (₱)</span><input type="number" class="discount-input" id="pos-discount" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${h(d.discount)}"></div>
        <div class="sum-row total"><span>Total</span><span>${WH.money(c.total)}</span></div>
        ${d.lines.length ? `<div class="eta">${WH.icon('clock')} Ready by ${WH.fmtWhen(c.readyAt.toISOString())}${c.express ? ' · Express' : ''}</div>` : ''}`;
      const disc = $('#pos-discount');
      disc.addEventListener('change', () => { d.discount = disc.value; renderTotals(); });
      disc.addEventListener('input', () => { d.discount = disc.value; renderPayResult(); });

      $('#pos-quick').innerHTML = [
        ['Pay later', 0], ['Exact', c.total],
        ...[100, 200, 500, 1000].filter((v) => v > c.total).slice(0, 4).map((v) => [WH.money(v).replace('.00', ''), v]),
      ].slice(0, 6).map(([label, v]) => `<button type="button" class="btn btn-sm" data-cash="${v}">${h(label)}</button>`).join('');
      view.querySelectorAll('[data-cash]').forEach((b) => b.addEventListener('click', () => {
        d.tendered = Number(b.dataset.cash) ? String(b.dataset.cash) : '';
        $('#pos-tendered').value = d.tendered;
        renderPayResult();
      }));
      renderPayResult();
    };

    const renderPayResult = () => {
      const c = calc();
      let html;
      if (!d.lines.length) html = '';
      else if (c.status === 'paid') html = `<div class="pay-result paid"><span>${WH.icon('check')} Paid in full${c.change ? ' · Change' : ''}</span><span class="big">${c.change ? WH.money(c.change) : WH.money(c.total)}</span></div>`;
      else if (c.status === 'partial') html = `<div class="pay-result partial"><span>Partial · balance on pickup</span><span class="big">${WH.money(c.balance)}</span></div>`;
      else html = `<div class="pay-result unpaid"><span>Unpaid · collect on pickup</span><span class="big">${WH.money(c.total)}</span></div>`;
      $('#pos-payresult').innerHTML = html;
    };

    // ---------- Static controls ----------
    const setSegment = (root, attr, value) => root.querySelectorAll(`[${attr}]`).forEach((b) => b.classList.toggle('on', b.getAttribute(attr) === value));
    setSegment($('#pos-fulfil'), 'data-f', d.fulfillment);
    setSegment($('#pos-method'), 'data-m', d.method);
    $('#pos-fulfil').addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      d.fulfillment = b.dataset.f; setSegment($('#pos-fulfil'), 'data-f', d.fulfillment);
    });
    $('#pos-method').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      d.method = b.dataset.m; setSegment($('#pos-method'), 'data-m', d.method);
      // GCash / card are usually the exact amount
      if (d.method !== 'cash' && !d.tendered) { d.tendered = String(calc().total || ''); $('#pos-tendered').value = d.tendered; renderPayResult(); }
    });
    $('#pos-tendered').addEventListener('input', (e) => { d.tendered = e.target.value; renderPayResult(); });
    $('#pos-notes').addEventListener('input', (e) => { d.notes = e.target.value; });
    $('#pos-clear').onclick = async () => {
      if (d.lines.length && !(await WH.confirm('Clear order?', 'Remove all services from this order?', 'Clear'))) return;
      d.lines = []; d.discount = ''; d.tendered = '';
      $('#pos-tendered').value = '';
      renderTiles(); renderLines(); renderTotals();
    };

    // ---------- Submit ----------
    $('#pos-submit').onclick = async () => {
      // client-side checks (the backend checks again)
      if (!d.lines.length) return WH.toast('Tap at least one service first.', 'error');
      const bad = d.lines.find((l) => { const s = svc(l.service_id); return s && s.unit !== 'flat' && !(Number(l.qty) > 0); });
      if (bad) {
        const el = view.querySelector(`[data-line="${bad.service_id}"]`);
        el.classList.add('invalid');
        el.querySelector('input').focus();
        return WH.toast(`Enter the ${svc(bad.service_id).unit === 'kg' ? 'weight (kg)' : 'number of pieces'} for ${svc(bad.service_id).name}.`, 'error');
      }
      let customer = d.customer;
      if (!customer && d.newCustomer && d.newCustomer.name.trim()) customer = d.newCustomer;
      if (!customer) {
        WH.toast('Select or add a customer.', 'error');
        const el = view.querySelector('#cust-q, [data-nc="name"]');
        if (el) el.focus();
        return;
      }
      const c = calc();
      if (d.fulfillment === 'delivery' && !customer.address) {
        const go = await WH.confirm('No delivery address', 'This customer has no address saved. Create the delivery order anyway?', 'Continue');
        if (!go) return;
      }
      const btn = $('#pos-submit');
      btn.disabled = true;
      try {
        const order = await WH.api('order_create', {
          customer: customer.id ? { id: customer.id } : customer,
          items: d.lines.map((l) => ({ service_id: l.service_id, qty: Number(l.qty) || 0 })),
          discount: Number(d.discount) || 0,
          payment: { amount: c.applied, method: d.method },
          fulfillment: d.fulfillment,
          notes: d.notes,
        });
        WH.posDraft = newDraft();
        WH.toast(`Order ${order.code} created`, 'success');
        WH.showTicket(order, { change: c.change, fromPos: true });
        WH.views.pos(view); // fresh, empty counter behind the ticket
        WH.updateBadges();
      } catch (e) {
        WH.error(e);
      } finally {
        btn.disabled = false;
      }
    };

    renderTiles();
    renderLines();
    renderCustomer();
    renderTotals();
  };
})(window.WH);
