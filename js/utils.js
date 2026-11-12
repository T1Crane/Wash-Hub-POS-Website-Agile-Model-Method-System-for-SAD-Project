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

  // ---------- Loyalty card (same rules as WashHubApi::loyaltyPlan on the server) ----------
  // A card has N boxes (default 14). Every Mth box (default 7 and 14) is FREE.
  // Each load the customer brings = 1 tick. When a tick lands on a FREE box, that order gets the reward.
  // Ticks keep counting across cards: tick 15 is box 1 of card #2.

  /** Loyalty settings from the shop settings (Settings → Loyalty card). */
  WH.loyaltyConfig = (s = WH.state.settings || {}) => {
    const size = Math.min(50, Math.max(2, parseInt(s.loyalty_card_size, 10) || 14));
    return {
      enabled: String(s.loyalty_enabled ?? '1') === '1',
      size,
      every: Math.min(size, Math.max(1, parseInt(s.loyalty_free_every, 10) || 7)),
      reward: ['free_load', 'amount', 'percent'].includes(s.loyalty_reward) ? s.loyalty_reward : 'free_load',
      value: Math.max(0, Number(s.loyalty_reward_value) || 0),
      mode: s.loyalty_mode === 'auto' ? 'auto' : 'save',
    };
  };
  /** Is tick number t (counted over all cards: 1, 2, 3…) a FREE box? */
  WH.isFreeTick = (t, cfg) => (((t - 1) % cfg.size) + 1) % cfg.every === 0;
  /** The loads in an order that earn ticks, cheapest first, as peso values (1 piece/load = its price, a kg line = the whole line). */
  WH.loyaltyLoads = (lines) => {
    const loads = [];
    lines.forEach((l) => {
      if (!l.loyalty) return;
      if (l.unit === 'pc') for (let i = 0; i < Math.floor(Number(l.qty) || 0); i++) loads.push(l.price);
      else loads.push(l.unit === 'kg' ? (Number(l.qty) || 0) * l.price : l.price);
    });
    return loads.sort((a, b) => a - b);
  };
  /** Automatic ticks for an order = 1 per load of a "Loyalty" service (add-ons don't count). */
  WH.loyaltyAutoTicks = (lines) => WH.loyaltyLoads(lines).length;
  /** How many FREE boxes a total of `ticks` has reached. e.g. 17 ticks on a 14/7 card = 2. */
  WH.freeEarned = (ticks, cfg) => Math.floor(ticks / cfg.size) * Math.floor(cfg.size / cfg.every) + Math.floor((ticks % cfg.size) / cfg.every);
  /**
   * What this order earns and uses.
   * before / usedBefore = customer's ticks and FREE already used before this order.
   * useFree = FREE the cashier wants to use now ("save" mode). In "auto" mode the FREE boxes reached are used at once.
   * Returns { ticks, reached, used, discount, before, after, available (left after this order), maxUse, error }.
   */
  WH.loyaltyPlan = ({ cfg, before, usedBefore = 0, ticks, useFree = 0, lines, subtotal, manualDiscount }) => {
    if (!cfg.enabled) return { ticks: 0, reached: 0, used: 0, discount: 0, before, after: before, available: 0, maxUse: 0 };
    const loads = WH.loyaltyLoads(lines);
    const after = before + ticks;
    let reached = 0;
    for (let t = before + 1; t <= after; t++) if (WH.isFreeTick(t, cfg)) reached++;
    const available = Math.max(0, WH.freeEarned(after, cfg) - usedBefore);
    const perOrder = cfg.reward === 'percent' ? 1 : cfg.reward === 'free_load' ? loads.length : 99;
    const maxUse = Math.min(available, perOrder);
    const used = cfg.mode === 'auto' ? Math.min(reached, maxUse) : Math.max(0, Math.min(Number(useFree) || 0, maxUse));
    let discount = 0;
    if (used) {
      if (cfg.reward === 'amount') discount = used * cfg.value;                               // ₱X off per FREE
      else if (cfg.reward === 'percent') discount = subtotal * Math.min(100, cfg.value) / 100;  // X% off the order
      else discount = loads.slice(0, used).reduce((s, v) => s + v, 0);                        // the cheapest load(s) free
    }
    discount = WH.round2(Math.min(discount, Math.max(0, subtotal - manualDiscount)));
    return { ticks, reached, used, discount, before, after, available: available - used, maxUse };
  };
  /** How many more ticks until the next FREE box. */
  WH.loyaltyToNext = (after, cfg) => { for (let t = after + 1; t <= after + cfg.size; t++) if (WH.isFreeTick(t, cfg)) return t - after; return cfg.every; };
  /** Card number and box (1-based) for a total tick count. 0 ticks = card 1, box 0. */
  WH.loyaltyCard = (total, cfg) => ({ card: Math.floor(Math.max(0, total - 1) / cfg.size) + 1, box: total === 0 ? 0 : ((total - 1) % cfg.size) + 1 });
  /** Short text for the reward setting, e.g. "1 free load". */
  WH.loyaltyRewardText = (cfg) => (cfg.reward === 'amount' ? `${WH.money(cfg.value)} off` : cfg.reward === 'percent' ? `${cfg.value}% off the order` : '1 free load');

  // ---------- User roles & permissions ----------
  // The two sides of the system (same keys as WashHubApi::ROLES)
  WH.ROLES = {
    admin: { label: 'Admin', about: 'Everything: orders, customers, dashboard, inventory, reports, prices, shop settings and user accounts' },
    staff: { label: 'Staff', about: 'New orders, payments, the Orders board and customers (no Reports or Users)' },
  };
  WH.roleLabel = (role) => (WH.ROLES[role] || { label: role }).label;
  WH.rolePill = (role) => `<span class="pill role-${WH.h(role)}">${WH.h(WH.roleLabel(role))}</span>`;
  /**
   * What to call this person: "Owner" for the ★ Shop Owner, otherwise "Admin" or "Staff".
   * The Owner has the Admin role (same access) plus the Shop Owner extras; only the name shown is separate.
   */
  // Login lockout (same numbers as WashHubApi::LOGIN_MAX_TRIES / LOGIN_LOCK_MINUTES)
  WH.LOGIN_MAX_TRIES = 5;
  WH.LOGIN_LOCK_MINUTES = 5;
  WH.userRoleLabel = (u) => (u && u.is_owner ? 'Owner' : WH.roleLabel(u && u.role));
  WH.userRolePill = (u) => (u && u.is_owner ? '<span class="pill owner">★ Owner</span>' : WH.rolePill(u && u.role));

  /**
   * Can the logged-in user use this server action? The list comes from the server ("bootstrap"),
   * so the screen and WashHubApi::PERMISSIONS always agree. Demo mode has no list = everything allowed.
   * NOTE: this only hides buttons; the server still checks every request.
   */
  WH.can = (action) => !WH.state || !Array.isArray(WH.state.permissions) || WH.state.permissions.includes(action);

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

  /**
   * The stages THIS order goes through. It depends on its services (need_wash / need_dry from the server):
   *   "Dry" only  -> Received → Drying → Folding / Ready → Picked Up   (no Washing)
   *   "Wash" only -> Received → Washing → Folding / Ready → Picked Up  (no Drying)
   * The stage the order is in now is always kept, even if it is normally skipped.
   */
  WH.orderSteps = (order) => WH.STATUSES.filter((s) =>
    s.key === order.status
    || (s.key === 'washing' ? order.need_wash !== false
      : s.key === 'drying' ? order.need_dry !== false
      : true));
  /** Next stage of this order (skips the stages it doesn't need), or null at the end */
  WH.nextStatus = (order) => {
    const steps = WH.orderSteps(order);
    const i = steps.findIndex((s) => s.key === order.status);
    return i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
  };
  /** Previous stage of this order (for the "Back to …" button), or null at the start */
  WH.prevStatus = (order) => {
    const steps = WH.orderSteps(order);
    const i = steps.findIndex((s) => s.key === order.status);
    return i > 0 ? steps[i - 1] : null;
  };
  /** Label for the single-tap "advance" button (Picked Up vs Delivered depends on the order) */
  WH.advanceLabel = (order) => {
    const next = WH.nextStatus(order);
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
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
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
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M17 6l3 3M14 9l2 2"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  };
  WH.icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  /** Address of a file in the assets folder. Laravel sets window.WASHHUB_ASSETS (files live in public/vendor/washhub/). */
  WH.asset = (path) => (window.WASHHUB_ASSETS || '') + path;

  /** Gap Wash Hub logo (assets/logo.png). Used in the sidebar, login screen, tracking page and claim ticket. */
  WH.logo = (cls = '') => `<img class="${cls}" src="${WH.asset('assets/logo.png')}" alt="Gap Wash Hub logo">`;

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

  /**
   * SOFT DELETE note for delete confirmations. With MySQL, deleted records go to the Trash
   * (deleted_at is set, nothing is removed) and an Owner / Admin can restore them.
   * Demo mode (no server) has no Trash, so there it really deletes.
   */
  WH.trashNote = () => (WH.store && WH.store.mode === 'mysql'
    ? `${WH.icon('trash')} It moves to the <b>Trash</b>. An Owner / Admin can restore it from there.`
    : '<b>Demo mode:</b> this deletes it for real (the Trash needs the MySQL server).');

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
