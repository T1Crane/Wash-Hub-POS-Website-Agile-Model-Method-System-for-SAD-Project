/* ==========================================================================
   utils.js — shared helpers used by every page
   --------------------------------------------------------------------------
   Everything lives on the global "WH" object (no build tools needed).
   - Formatting: WH.money, WH.num, WH.fmtDateTime, WH.relTime ...
   - Safety:     WH.h() escapes text before putting it in HTML (prevents XSS)
   - UI:         WH.icon, WH.toast, WH.modal, WH.choice
   - Workflow:   WH.STATUSES (labels for each order stage)
   ========================================================================== */
window.WH = window.WH || {};

(function (WH) {
  'use strict';

  // ---------- Formatting ----------
  const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });

  /** 1234.5 -> "₱1,234.50" */
  WH.money = (n) => peso.format(Number(n) || 0);

  /** Rounds and adds thousands separators: 3.456 -> "3.46" */
  WH.num = (n, digits = 2) => (Number(n) || 0).toLocaleString('en-PH', { maximumFractionDigits: digits });

  /** Round to 2 decimals (money math) */
  WH.round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /** Escape text for safe use inside HTML templates. ALWAYS use for user-typed data. */
  WH.h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  WH.fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
  WH.fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : '—';
  WH.fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

  /** "Today 4:30 PM" / "Tomorrow 9:00 AM" / "Oct 25, 2:00 PM" */
  WH.fmtWhen = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const today = WH.ymd(new Date());
    const tomorrow = WH.ymd(new Date(Date.now() + 86400000));
    if (WH.ymd(d) === today) return 'Today ' + WH.fmtTime(iso);
    if (WH.ymd(d) === tomorrow) return 'Tomorrow ' + WH.fmtTime(iso);
    return WH.fmtDateTime(iso);
  };

  /** Duration text: 5400000 ms -> "1h 30m" */
  WH.duration = (ms) => {
    const mins = Math.max(0, Math.round(Math.abs(ms) / 60000));
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  };

  /** Local date as "YYYY-MM-DD" (used for date inputs and grouping) */
  WH.ymd = (d) => {
    d = d instanceof Date ? d : new Date(d);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  WH.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  /** "3.5 kg", "2 pcs", "" for flat add-ons */
  WH.qtyLabel = (qty, unit) => unit === 'kg' ? `${WH.num(qty)} kg` : unit === 'pc' ? `${WH.num(qty, 0)} pc${qty == 1 ? '' : 's'}` : '';
  WH.unitLabel = (unit) => ({ kg: 'per kg', pc: 'per piece', flat: 'add-on' }[unit] || unit);

  /** Short summary of order items for cards: "3.5 kg Wash-Dry-Fold · 2 pcs Ironing" */
  WH.itemsSummary = (items) => items.map((i) => (i.unit === 'flat' ? i.name : `${WH.qtyLabel(i.qty, i.unit)} ${i.name}`)).join(' · ');

  WH.methodLabel = (m) => ({ cash: 'Cash', gcash: 'GCash / E-wallet', card: 'Card' }[m] || m);
  WH.payLabel = (s) => ({ paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid' }[s] || s);

  // ---------- Order workflow stages ----------
  // key = value stored in the database; action = text on the one-tap button that moves an order INTO this stage
  WH.STATUSES = [
    { key: 'received',  label: 'Received',        action: 'Receive' },
    { key: 'washing',   label: 'Washing',         action: 'Start Washing' },
    { key: 'drying',    label: 'Drying',          action: 'Move to Drying' },
    { key: 'ready',     label: 'Folding / Ready', action: 'Mark Ready' },
    { key: 'completed', label: 'Picked Up / Delivered', action: 'Picked Up' },
  ];
  WH.statusInfo = (key) => WH.STATUSES.find((s) => s.key === key) || WH.STATUSES[0];
  WH.nextStatus = (key) => {
    const i = WH.STATUSES.findIndex((s) => s.key === key);
    return i >= 0 && i < WH.STATUSES.length - 1 ? WH.STATUSES[i + 1] : null;
  };
  WH.prevStatus = (key) => {
    const i = WH.STATUSES.findIndex((s) => s.key === key);
    return i > 0 ? WH.STATUSES[i - 1] : null;
  };
  /** Label for the single-tap "advance" button (Picked Up vs Delivered depends on the order) */
  WH.advanceLabel = (order) => {
    const next = WH.nextStatus(order.status);
    if (!next) return null;
    if (next.key === 'completed') return order.fulfillment === 'delivery' ? 'Mark Delivered' : 'Mark Picked Up';
    return next.action;
  };
  WH.statusLabel = (order) => order.status === 'completed'
    ? (order.fulfillment === 'delivery' ? 'Delivered' : 'Picked Up')
    : WH.statusInfo(order.status).label;

  /** True if the order isn't ready yet and its promised time has passed */
  WH.isOverdue = (order) => ['received', 'washing', 'drying'].includes(order.status) && new Date(order.ready_at) < new Date();

  WH.statusPill = (order) => `<span class="pill st-${order.status}">${WH.h(WH.statusLabel(order))}</span>`;
  WH.payPill = (order) => {
    const extra = order.payment_status === 'paid' ? '' : ` · ${WH.money(order.balance)}`;
    return `<span class="pill ${order.payment_status}">${WH.payLabel(order.payment_status)}${extra}</span>`;
  };

  // ---------- Icons (inline SVG, Lucide-style strokes) ----------
  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17V11M13 17V7M18 17v-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8v8M11 8v8M15 8v8M18 8v8"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    minus: '<path d="M5 12h14"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    truck: '<path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    store: '<path d="M3 9 4.5 4h15L21 9"/><path d="M4 9v11h16V9"/><path d="M3 9h18a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  };
  WH.icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /** Wash Hub logo (washing machine + bubbles). Used in sidebar and on the claim ticket. */
  WH.logo = (cls = '') => `
    <svg class="${cls}" viewBox="0 0 64 64" aria-label="Wash Hub logo" role="img">
      <rect x="6" y="4" width="52" height="56" rx="12" fill="#2f6bff"/>
      <rect x="6" y="4" width="52" height="14" rx="12" fill="#1747c9"/>
      <rect x="6" y="12" width="52" height="6" fill="#1747c9"/>
      <circle cx="16" cy="11" r="2.6" fill="#bcd0ff"/><circle cx="24" cy="11" r="2.6" fill="#bcd0ff"/>
      <rect x="38" y="9" width="13" height="4" rx="2" fill="#bcd0ff"/>
      <circle cx="32" cy="38" r="15" fill="#fff"/>
      <circle cx="32" cy="38" r="11" fill="#7fd4ff"/>
      <path d="M21 39c4 3 7-3 11 0s7 3 11 0v3a11 11 0 0 1-22 0z" fill="#2f9be0"/>
      <circle cx="28" cy="33" r="2.4" fill="#fff" opacity=".9"/><circle cx="35" cy="30" r="1.6" fill="#fff" opacity=".9"/>
    </svg>`;

  // ---------- DOM helpers ----------
  WH.$ = (sel, root = document) => root.querySelector(sel);
  WH.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  WH.debounce = (fn, ms = 250) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  // ---------- Toast notifications ----------
  /** WH.toast('Saved', 'success', {label:'Undo', fn: ()=>...}) */
  WH.toast = (message, type = '', action = null, ms = 4000) => {
    const root = document.getElementById('toast-root');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<span>${WH.h(message)}</span>${action ? `<button type="button">${WH.h(action.label)}</button>` : ''}`;
    if (action) el.querySelector('button').onclick = () => { el.remove(); action.fn(); };
    root.appendChild(el);
    setTimeout(() => el.remove(), action ? ms + 2000 : ms);
  };
  WH.error = (err) => WH.toast(err && err.message ? err.message : String(err), 'error', null, 6000);

  // ---------- Modal dialog ----------
  /**
   * Opens a modal. Returns { el, close }.
   *   title:   heading text
   *   body:    HTML string
   *   foot:    HTML string for the button row (optional)
   *   wide:    true for large modals
   *   onClose: callback when closed
   */
  WH.modal = ({ title, body, foot = '', wide = false, onClose = null }) => {
    const root = document.getElementById('modal-root');
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${WH.h(title)}">
        <div class="modal-head"><h2>${WH.h(title)}</h2>
          <button class="btn btn-ghost btn-icon" data-close aria-label="Close">${WH.icon('x')}</button></div>
        <div class="modal-body">${body}</div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>`;
    const prevFocus = document.activeElement;
    const close = () => {
      if (!wrap.isConnected) return;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && root.lastElementChild === wrap) close(); };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    root.appendChild(wrap);
    const first = wrap.querySelector('.modal-body input, .modal-body select, .modal-body textarea, .modal-foot .btn-primary');
    if (first) setTimeout(() => first.focus(), 30);
    return { el: wrap, close };
  };

  /**
   * Asks the user to pick one option. Resolves with the chosen value (or null if dismissed).
   *   WH.choice('Title', 'Message', [{label:'Yes', value:'yes', cls:'btn-primary'}, ...])
   */
  WH.choice = (title, message, buttons) => new Promise((resolve) => {
    let done = false;
    const m = WH.modal({
      title,
      body: `<p style="margin:0">${message}</p>`,
      foot: buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${WH.h(b.label)}</button>`).join(''),
      onClose: () => { if (!done) resolve(null); },
    });
    m.el.querySelectorAll('[data-i]').forEach((btn) => btn.addEventListener('click', () => {
      done = true;
      m.close();
      resolve(buttons[Number(btn.dataset.i)].value);
    }));
  });

  WH.confirm = (title, message, okLabel = 'Confirm') =>
    WH.choice(title, message, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, cls: 'btn-primary' }]).then(Boolean);

  /** Reads all named inputs inside a container into an object */
  WH.formData = (root) => {
    const out = {};
    root.querySelectorAll('[name]').forEach((el) => {
      out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  };

  /** Downloads text as a file (used for CSV exports) */
  WH.downloadText = (filename, text, type = 'text/csv') => {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  };
})(window.WH);
