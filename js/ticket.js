/* ==========================================================================
   ticket.js — Claim ticket (receipt), barcode/QR code, printing, SMS notice
   --------------------------------------------------------------------------
   - WH.barcodeSVG(text):  Code 39 barcode drawn as SVG (works offline,
                           readable by any USB barcode scanner)
   - WH.renderCodes(root): fills every [data-qr] / [data-barcode] placeholder
                           (QR uses the qrcodejs library from the CDN; if
                           there's no internet only the barcode is shown)
   - WH.ticketHTML(order): the receipt layout (customer copy + bag tag)
   - WH.showTicket(order): preview modal with a Print button
   - WH.printHTML(html):   prints any HTML using the #print-root container
   - WH.notifyCustomer(order): "laundry is ready" SMS message helper
   ========================================================================== */
(function (WH) {
  'use strict';

  /** Loyalty card line for the ticket, e.g. "★ Loyalty card #1: 12/14 ticks (+1 today) · 2 more to the next FREE". */
  const loyaltyLine = (o) => {
    const cfg = WH.loyaltyConfig();
    if (o.loyalty_after === null || o.loyalty_after === undefined || (!o.loyalty_ticks && !cfg.enabled)) return '';
    const { card, box } = WH.loyaltyCard(o.loyalty_after, cfg);
    const next = WH.loyaltyToNext(o.loyalty_after, cfg);
    // FREE still available = earned with the ticks after this order - used so far (customer's card right now)
    const c = o.customer || {};
    const free = Math.max(0, WH.freeEarned(Number(c.loyalty_ticks ?? o.loyalty_after) || 0, cfg) - (Number(c.loyalty_free_used) || 0));
    return `<div class="t-sep"></div>
      <div><b>★ Loyalty card #${card}:</b> ${box}/${cfg.size} ticks${o.loyalty_ticks ? ` (+${o.loyalty_ticks} today)` : ''}
        ${o.loyalty_rewards ? ` · <b>${o.loyalty_rewards} FREE used</b>` : ''} · ${next} more to the next FREE
        ${cfg.mode === 'save' && free > 0 ? `<br><b>${free} FREE available</b> for your next visit` : ''}</div>`;
  };

  // ---------- Code 39 barcode ----------
  // Each character = 5 bars + 4 spaces; 1 = wide, 0 = narrow.
  // Characters are grouped by which space is wide; the bar pattern repeats per group.
  const BAR_PATTERNS = ['00110', '10001', '01001', '11000', '00101', '10100', '01100', '00011', '10010', '01010'];
  const GROUPS = [['1234567890', '0100'], ['ABCDEFGHIJ', '0010'], ['KLMNOPQRST', '0001'], ['UVWXYZ-. *', '1000']];
  const CODE39 = {};
  GROUPS.forEach(([chars, spaces]) => {
    [...chars].forEach((ch, i) => {
      const bars = BAR_PATTERNS[(i + 1) % 10];
      CODE39[ch] = bars[0] + spaces[0] + bars[1] + spaces[1] + bars[2] + spaces[2] + bars[3] + spaces[3] + bars[4];
    });
  });

  WH.barcodeSVG = (text) => {
    const value = '*' + String(text).toUpperCase().replace(/[^0-9A-Z\-. ]/g, '') + '*';
    const narrow = 2, wide = 5, height = 60;
    let x = 10, rects = '';
    [...value].forEach((ch) => {
      [...CODE39[ch]].forEach((w, i) => {
        const width = w === '1' ? wide : narrow;
        if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${width}" height="${height}"/>`;
        x += width;
      });
      x += narrow; // gap between characters
    });
    return `<svg viewBox="0 0 ${x + 8} ${height}" preserveAspectRatio="none" role="img" aria-label="Barcode ${WH.h(text)}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  };

  WH.renderCodes = (root) => {
    root.querySelectorAll('[data-barcode]').forEach((el) => { el.innerHTML = WH.barcodeSVG(el.dataset.barcode); });
    root.querySelectorAll('[data-qr]').forEach((el) => {
      el.innerHTML = '';
      if (typeof window.QRCode === 'function') {
        // eslint-disable-next-line no-new
        new window.QRCode(el, { text: el.dataset.qr, width: 232, height: 232, correctLevel: window.QRCode.CorrectLevel.M });
      } else {
        el.style.display = 'none'; // offline: barcode still works
      }
    });
  };

  /**
   * The link inside the QR code: <app address>?track=<secret code>.
   * The address comes from Settings ("QR code link"); blank = the address the app is open on now.
   * Opening it shows the public "track your order" card (see showTracking in index.js).
   */
  WH.trackUrl = (o) => {
    if (!o.track_token) return o.code; // very old demo orders have no tracking code
    const base = String(WH.state.settings.public_url || '').trim() || (location.origin + location.pathname);
    const url = new URL(base, location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('track', o.track_token);
    return url.href;
  };

  // ---------- Claim ticket layout ----------
  WH.ticketHTML = (o, opts = {}) => {
    const s = WH.state.settings;
    const h = WH.h;
    const lines = o.items.map((i) => `
      <tr><td>${h(i.name)}${i.unit !== 'flat' ? `<br><span style="color:#444">${WH.qtyLabel(i.qty, i.unit)} × ${WH.money(i.unit_price)}</span>` : ''}</td>
          <td class="r">${WH.money(i.line_total)}</td></tr>`).join('');
    const payments = o.payments.map((p) => `<tr><td>Paid · ${h(WH.methodLabel(p.method))} <span style="color:#444">${WH.fmtDateTime(p.paid_at)}</span></td><td class="r">${WH.money(p.amount)}</td></tr>`).join('');

    return `
    <div class="ticket">
      <div class="t-center">
        ${WH.logo('t-logo')}
        <div class="t-shop">${h(s.shop_name)}</div>
        <div>${h(s.shop_tagline)}</div>
        <div>${h(s.shop_address)}</div>
        <div>${h(s.shop_phone)}</div>
      </div>
      <div class="t-title">CLAIM TICKET${o.is_express ? ' · EXPRESS' : ''}</div>
      <div class="t-code">${h(o.code)}</div>
      <div class="t-codes">
        <div class="t-qr" data-qr="${h(WH.trackUrl(o))}"></div>
      </div>
      <div class="t-center" style="font-size:10px">Scan with your phone to check your order status</div>
      <div class="t-barcode" data-barcode="${h(o.code)}"></div>
      <table style="margin-top:6px">
        <tr><td>Customer</td><td class="r"><b>${h(o.customer.name)}</b></td></tr>
        ${o.customer.phone ? `<tr><td>Phone</td><td class="r">${h(o.customer.phone)}</td></tr>` : ''}
        <tr><td>Received</td><td class="r">${WH.fmtDate(o.created_at)} ${WH.fmtTime(o.created_at)}</td></tr>
        <tr><td><b>Ready by</b></td><td class="r"><b>${WH.fmtDate(o.ready_at)} ${WH.fmtTime(o.ready_at)}</b></td></tr>
        <tr><td>${o.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}</td><td class="r">${o.fulfillment === 'delivery' ? h(o.customer.address || 'Address on file') : 'At the counter'}</td></tr>
      </table>
      <div class="t-sep"></div>
      <table>
        ${lines}
        <tr><td colspan="2"><div class="t-sep"></div></td></tr>
        ${o.total_weight > 0 ? `<tr><td>Total weight</td><td class="r">${WH.num(o.total_weight)} kg</td></tr>` : ''}
        <tr><td>Subtotal</td><td class="r">${WH.money(o.subtotal)}</td></tr>
        ${o.discount > 0 ? `<tr><td>Discount</td><td class="r">−${WH.money(o.discount)}</td></tr>` : ''}
        ${o.loyalty_discount > 0 ? `<tr><td>★ Loyalty FREE used</td><td class="r">−${WH.money(o.loyalty_discount)}</td></tr>` : ''}
        <tr class="t-total"><td>TOTAL</td><td class="r">${WH.money(o.total)}</td></tr>
        ${payments}
        ${opts.change > 0 ? `<tr><td>Change</td><td class="r">${WH.money(opts.change)}</td></tr>` : ''}
        <tr><td><b>Balance due</b></td><td class="r"><b>${WH.money(o.balance)}</b></td></tr>
      </table>
      <div class="t-center" style="margin-top:6px"><span class="t-status">${WH.payLabel(o.payment_status).toUpperCase()}</span></div>
      ${o.notes ? `<div class="t-sep"></div><div><b>Notes:</b> ${h(o.notes)}</div>` : ''}
      ${loyaltyLine(o)}
      <div class="t-sep"></div>
      <div class="t-terms"><b>Pickup terms:</b> ${h(s.pickup_terms)}</div>
      <div class="t-center" style="margin-top:8px">Thank you for choosing ${h(s.shop_name)}!</div>

      <div class="t-cut"><span>✂ cut here — attach to laundry bag</span></div>
      <div class="t-center"><b>${h(s.shop_name)} · BAG TAG</b></div>
      <div class="t-tag-code">${h(o.code)}</div>
      <table>
        <tr><td>Customer</td><td class="r"><b>${h(o.customer.name)}</b></td></tr>
        <tr><td>Items</td><td class="r" style="white-space:normal">${h(WH.itemsSummary(o.items))}</td></tr>
        <tr><td>Ready by</td><td class="r"><b>${WH.fmtDate(o.ready_at)} ${WH.fmtTime(o.ready_at)}</b></td></tr>
        <tr><td>Payment</td><td class="r">${WH.payLabel(o.payment_status)}${o.balance > 0 ? ' · ' + WH.money(o.balance) + ' due' : ''}</td></tr>
      </table>
    </div>`;
  };

  // ---------- Printing ----------
  /** Prints HTML only (the rest of the page is hidden by the @media print rules in index.css). */
  WH.printHTML = (html) => {
    const root = document.getElementById('print-root');
    root.innerHTML = html;
    WH.renderCodes(root);
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); root.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    // short delay so the QR image finishes drawing before the print dialog opens
    setTimeout(() => { window.print(); setTimeout(done, 1000); }, 250);
  };

  /** Ticket preview modal. opts.change = change given to the customer (from the POS). */
  WH.showTicket = (order, opts = {}) => {
    const m = WH.modal({
      title: `Claim Ticket · ${order.code}`,
      body: `
        ${opts.change > 0 ? `<div class="pay-result paid" style="margin:0 0 12px"><span>Give change</span><span class="big">${WH.money(opts.change)}</span></div>` : ''}
        <div class="ticket-wrap">${WH.ticketHTML(order, opts)}</div>`,
      foot: `
        <button class="btn" data-close>Close</button>
        ${opts.fromPos ? `<button class="btn" data-act="new">${WH.icon('plus')} New order</button>` : ''}
        <button class="btn btn-primary" data-act="print">${WH.icon('printer')} Print ticket</button>`,
    });
    WH.renderCodes(m.el);
    m.el.querySelector('[data-act="print"]').onclick = () => WH.printHTML(WH.ticketHTML(order, opts));
    const nb = m.el.querySelector('[data-act="new"]');
    if (nb) nb.onclick = () => { m.close(); WH.navigate('pos'); };
    return m;
  };

  // ---------- "Ready for pickup" customer notice ----------
  WH.smsText = (o) => {
    const s = WH.state.settings;
    return String(s.sms_template || '')
      .replace(/\{name\}/g, o.customer.name.split(' ')[0])
      .replace(/\{code\}/g, o.code)
      .replace(/\{shop\}/g, s.shop_name)
      .replace(/\{balance\}/g, WH.money(o.balance))
      .replace(/\{total\}/g, WH.money(o.total));
  };

  /** Shows the message, lets staff copy it / open the phone's SMS app, then mark as notified. */
  WH.notifyCustomer = (order, onDone) => {
    const text = WH.smsText(order);
    const phone = order.customer.phone;
    const m = WH.modal({
      title: `Notify ${order.customer.name}`,
      body: `
        <p class="muted" style="margin-top:0">${phone ? `Send this to <b>${WH.h(phone)}</b>:` : 'No phone number saved for this customer.'}</p>
        <textarea name="msg" rows="4">${WH.h(text)}</textarea>
        ${order.notified_at ? `<p class="small muted">Last notified: ${WH.fmtDateTime(order.notified_at)}</p>` : ''}`,
      foot: `
        <button class="btn" data-act="copy">${WH.icon('copy')} Copy</button>
        ${phone ? `<a class="btn" data-act="sms">${WH.icon('phone')} Open SMS app</a>` : ''}
        <button class="btn btn-primary" data-act="done">${WH.icon('check')} Mark as notified</button>`,
    });
    const msg = () => m.el.querySelector('[name="msg"]').value;
    m.el.querySelector('[data-act="copy"]').onclick = async () => {
      try { await navigator.clipboard.writeText(msg()); WH.toast('Message copied', 'success'); } catch (e) { WH.toast('Select the text and copy it manually'); }
    };
    const sms = m.el.querySelector('[data-act="sms"]');
    if (sms) sms.onclick = () => { sms.href = `sms:${encodeURIComponent(phone)}?body=${encodeURIComponent(msg())}`; };
    m.el.querySelector('[data-act="done"]').onclick = async () => {
      try {
        const updated = await WH.api('order_notify', { id: order.id });
        m.close();
        WH.toast(`${order.code} marked as notified`, 'success');
        if (onDone) onDone(updated);
      } catch (e) { WH.error(e); }
    };
  };
})(window.WH);
