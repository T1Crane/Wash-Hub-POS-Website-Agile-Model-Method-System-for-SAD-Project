/* ==========================================================================
   store.js — data layer (talks to MySQL through PHP, or to browser storage)
   --------------------------------------------------------------------------
   Every page calls:   await WH.api('action_name', { ...payload })

   Two modes, chosen automatically at startup by WH.initStore():
     1) "mysql" — sends the request to the PHP backend (api.php on XAMPP, or
                  /washhub/api on Laravel). Data is saved in MySQL.
     2) "local" — DEMO mode used when PHP/MySQL isn't reachable (e.g. opened
                  with VS Code Live Server). Data is saved in localStorage.
                  LocalDB below copies the rules of backend/WashHubApi.php, so
                  both modes return exactly the same data shapes.
   ========================================================================== */
(function (WH) {
  'use strict';

  WH.store = { mode: 'mysql', reason: '' };

  // ---------------------------------------------------------------------
  //  1) MySQL mode — HTTP call to the PHP backend
  // ---------------------------------------------------------------------
  async function remoteCall(action, payload = {}) {
    const base = window.WASHHUB_API || 'api.php';
    const url = base + (base.includes('?') ? '&' : '?') + 'action=' + encodeURIComponent(action);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    // Laravel needs its CSRF token on POST requests (the Blade view adds this meta tag)
    const csrf = document.querySelector('meta[name="csrf-token"]');
    if (csrf) headers['X-CSRF-TOKEN'] = csrf.content;

    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), credentials: 'same-origin' });
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error(`Server did not return JSON (HTTP ${res.status}). Is PHP running?`);
    }
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json.data;
  }

  /** The one function pages use. */
  WH.api = (action, payload = {}) =>
    WH.store.mode === 'mysql' ? remoteCall(action, payload) : Promise.resolve().then(() => LocalDB.call(action, payload));

  /** Decide the mode: try the PHP API, fall back to local demo storage. */
  WH.initStore = async () => {
    if (window.WASHHUB_FORCE_LOCAL) {
      WH.store = { mode: 'local', reason: 'Demo mode was forced (WASHHUB_FORCE_LOCAL).' };
      return;
    }
    if (location.protocol === 'file:') {
      WH.store = { mode: 'local', reason: 'Opened as a file. Open it through http://localhost/ (XAMPP) to use MySQL.' };
      return;
    }
    try {
      await remoteCall('ping');
      WH.store = { mode: 'mysql', reason: '' };
    } catch (e) {
      WH.store = { mode: 'local', reason: e.message };
    }
  };

  // ---------------------------------------------------------------------
  //  2) Local demo mode — same rules as backend/WashHubApi.php
  // ---------------------------------------------------------------------
  const KEY = 'washhub_demo_db_v1';
  const STATUSES = ['received', 'washing', 'drying', 'ready', 'completed'];
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  const dayStart = (ymd, add = 0) => { const d = new Date(ymd + 'T00:00:00'); d.setDate(d.getDate() + add); return d; };
  const fail = (msg) => { throw new Error(msg); };
  const cleanPhone = (p) => String(p || '').replace(/[^\d+]/g, '').slice(0, 30);
  const payStatus = (paid, total) => (paid <= 0 && total > 0 ? 'unpaid' : paid + 0.001 >= total ? 'paid' : 'partial');

  const DEFAULT_SETTINGS = {
    shop_name: 'Wash Hub',
    shop_tagline: 'Laundry Services',
    shop_address: 'Shop address, City',
    shop_phone: '0900 000 0000',
    pickup_terms: 'Present this claim ticket when picking up. Items unclaimed after 30 days will be donated. Wash Hub is not liable for color bleeding, shrinkage, or items left in pockets. Please check your items before leaving the counter.',
    sms_template: 'Hi {name}! Your laundry ({code}) at {shop} is ready for pickup. Balance due: {balance}. Thank you!',
    public_url: '',
  };
  /** Random 32-character secret for the QR tracking link (same format as the PHP version) */
  const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

  const LocalDB = {
    db: null,

    load() {
      if (this.db) return this.db;
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) this.db = JSON.parse(raw);
      } catch (e) { /* storage blocked: keep in memory only */ }
      if (!this.db) this.db = this.seed();
      return this.db;
    },
    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch (e) { /* ignore */ }
    },
    nextId(table) {
      this.db.seq[table] = (this.db.seq[table] || 0) + 1;
      return this.db.seq[table];
    },

    /** Starter data + a few sample orders so the demo dashboard isn't empty */
    seed() {
      this.db = {
        seq: {},
        settings: { ...DEFAULT_SETTINGS },
        services: [],
        customers: [],
        orders: [],
        inventory: [],
        invLogs: [],
      };
      [
        ['Wash-Dry-Fold', 'kg', 35, 24, false, 'blue'],
        ['Dry Cleaning', 'pc', 180, 72, false, 'violet'],
        ['Ironing / Pressing', 'pc', 20, 24, false, 'amber'],
        ['Comforter / Blanket', 'pc', 150, 48, false, 'teal'],
        ['Express Add-on (Same Day)', 'flat', 60, 6, true, 'red'],
      ].forEach(([name, unit, price, turnaround_hours, is_express, color], i) =>
        this.db.services.push({ id: this.nextId('services'), name, unit, price, turnaround_hours, is_express, color, active: true, sort_order: i + 1 }));
      const now = new Date().toISOString();
      [
        ['Liquid Detergent', 'L', 20, 5, 95], ['Fabric Conditioner', 'L', 15, 5, 80], ['Color-safe Bleach', 'L', 4, 3, 70],
        ['Plastic Laundry Bags', 'pcs', 180, 50, 3], ['Hangers', 'pcs', 25, 30, 12], ['Dryer Sheets', 'box', 6, 2, 150],
      ].forEach(([name, unit, stock, reorder_level, cost]) =>
        this.db.inventory.push({ id: this.nextId('inventory'), name, unit, stock, reorder_level, cost, updated_at: now }));

      // Sample orders: [customer, phone, items, hours ago, status, paid?]
      const samples = [
        ['Maria Santos', '09171234567', [[1, 6.5], [3, 4]], 30, 'completed', 'full'],
        ['Juan Dela Cruz', '09181112222', [[1, 4.2]], 26, 'ready', 'none'],
        ['Ana Reyes', '09209876543', [[2, 3]], 20, 'washing', 'full'],
        ['Carlo Mendoza', '09175550000', [[1, 8], [3, 5]], 28, 'drying', 'half'],
        ['Rosa Villanueva', '09061239876', [[4, 2]], 5, 'washing', 'none'],
        ['Liza Garcia', '09998887777', [[1, 3.5], [5, 1]], 2, 'received', 'full'],
        ['Maria Santos', '09171234567', [[1, 5]], 1, 'received', 'none'],
      ];
      samples.forEach(([name, phone, items, hoursAgo, status, pay]) => {
        const at = new Date(Date.now() - hoursAgo * 3600000);
        const o = this.createOrder({ customer: { name, phone }, items: items.map(([service_id, qty]) => ({ service_id, qty })), payment: { amount: 0 } }, at);
        if (pay !== 'none') this.addPayment({ id: o.id, amount: pay === 'full' ? o.total : r2(o.total / 2), method: pay === 'half' ? 'gcash' : 'cash' }, at);
        if (status !== 'received') this.setStatus({ id: o.id, status }, new Date(at.getTime() + 3600000 * 2));
      });
      // A week of past payments so the 7-day sales chart has bars
      let walkIn = { name: 'Walk-in Customer', phone: '' };
      for (let d = 1; d <= 6; d++) {
        const at = new Date(Date.now() - d * 86400000);
        at.setHours(11, 0, 0, 0);
        const o = this.createOrder({ customer: walkIn, items: [{ service_id: 1, qty: 4 + ((d * 7) % 9) }], payment: { amount: 0 } }, at);
        walkIn = { id: o.customer.id };
        this.addPayment({ id: o.id, amount: o.total, method: d % 3 ? 'cash' : 'gcash' }, at);
        this.setStatus({ id: o.id, status: 'completed' }, new Date(at.getTime() + 86400000));
      }
      this.save();
      return this.db;
    },

    /** Router — same action names as WashHubApi::handle() */
    call(action, p) {
      this.load();
      const fn = {
        ping: () => ({ mode: 'local', time: iso(new Date()) }),
        bootstrap: () => ({ settings: { ...DEFAULT_SETTINGS, ...this.db.settings }, services: this.services() }),
        settings_save: () => { Object.keys(DEFAULT_SETTINGS).forEach((k) => { if (k in p) this.db.settings[k] = String(p[k]).trim(); }); return { ...this.db.settings }; },
        service_save: () => this.saveService(p),
        customers: () => this.customers(p),
        customer_save: () => this.saveCustomer(p),
        orders: () => this.orders(p),
        order: () => this.order(Number(p.id)),
        order_create: () => this.createOrder(p),
        order_status: () => this.setStatus(p),
        order_payment: () => this.addPayment(p),
        track: () => {
          const o = this.db.orders.find((x) => x.track_token && x.track_token === p.t) || fail('This tracking link is not valid. Please check your claim ticket or contact the shop.');
          const full = this.out(o);
          const s = { ...DEFAULT_SETTINGS, ...this.db.settings };
          return {
            shop: { name: s.shop_name, phone: s.shop_phone, address: s.shop_address },
            order: {
              code: o.code, first_name: String(full.customer.name || '').trim().split(' ')[0], status: o.status, fulfillment: o.fulfillment,
              is_express: o.is_express, created_at: o.created_at, ready_at: o.ready_at, completed_at: o.completed_at,
              total: o.total, balance: full.balance, payment_status: o.payment_status,
              items: o.items.map((i) => ({ name: i.name, unit: i.unit, qty: i.qty })),
            },
          };
        },
        order_notify: () => { const o = this.find(p.id); o.notified_at = iso(new Date()); return this.order(o.id); },
        order_delete: () => { const o = this.find(p.id); this.db.orders = this.db.orders.filter((x) => x !== o); return { deleted: o.code }; },
        dashboard: () => this.dashboard(),
        report: () => this.report(p),
        inventory: () => this.inventory(),
        inventory_save: () => this.saveInventory(p),
        inventory_adjust: () => this.adjustInventory(p),
        inventory_logs: () => this.inventoryLogs(p),
        local_reset: () => { this.db = null; localStorage.removeItem(KEY); this.load(); return true; },
        local_export: () => clone(this.db),
      }[action];
      if (!fn) fail(`Unknown action "${action}".`);
      const result = fn();
      this.save();
      return clone(result);
    },

    // ----- services / customers -----
    services() {
      return [...this.db.services].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    },
    saveService(p) {
      const name = String(p.name || '').trim() || fail('Service name is required.');
      const row = {
        name,
        unit: ['kg', 'pc', 'flat'].includes(p.unit) ? p.unit : 'kg',
        price: Math.max(0, r2(p.price)),
        turnaround_hours: Math.max(1, parseInt(p.turnaround_hours, 10) || 24),
        is_express: !!p.is_express,
        color: String(p.color || 'blue').replace(/[^a-z]/g, '') || 'blue',
        active: p.active === undefined ? true : !!p.active,
        sort_order: parseInt(p.sort_order, 10) || 0,
      };
      const existing = this.db.services.find((s) => s.id === Number(p.id));
      if (existing) Object.assign(existing, row);
      else this.db.services.push({ id: this.nextId('services'), ...row });
      return this.services();
    },
    customers(p) {
      const q = String(p.q || '').trim().toLowerCase();
      const qPhone = q.replace(/\s+/g, '');
      return this.db.customers
        .filter((c) => !q || c.name.toLowerCase().includes(q) || (qPhone && c.phone.includes(qPhone)))
        .map((c) => {
          const orders = this.db.orders.filter((o) => o.customer_id === c.id);
          const last = orders.reduce((m, o) => (o.created_at > m ? o.created_at : m), '');
          return { ...c, order_count: orders.length, last_order_at: last || null, total_spent: r2(orders.reduce((s, o) => s + o.total, 0)) };
        })
        .sort((a, b) => String(b.last_order_at || '').localeCompare(String(a.last_order_at || '')) || a.name.localeCompare(b.name))
        .slice(0, Number(p.limit) || 100);
    },
    saveCustomer(p, at = new Date()) {
      const row = {
        name: String(p.name || '').trim().slice(0, 100) || fail('Customer name is required.'),
        phone: cleanPhone(p.phone),
        address: String(p.address || '').trim().slice(0, 255),
        notes: String(p.notes || '').trim().slice(0, 255),
      };
      let c = this.db.customers.find((x) => x.id === Number(p.id));
      if (c) Object.assign(c, row);
      else this.db.customers.push((c = { id: this.nextId('customers'), ...row, created_at: iso(at) }));
      return { id: c.id, name: c.name, phone: c.phone, address: c.address, notes: c.notes };
    },
    resolveCustomer(c, at) {
      if (c.id && this.db.customers.some((x) => x.id === Number(c.id))) return Number(c.id);
      const phone = cleanPhone(c.phone);
      const same = phone && this.db.customers.find((x) => x.phone === phone);
      return same ? same.id : this.saveCustomer(c, at).id;
    },

    // ----- orders -----
    find(id) {
      return this.db.orders.find((o) => o.id === Number(id)) || fail('Order not found.');
    },
    out(o) {
      const c = this.db.customers.find((x) => x.id === o.customer_id) || {};
      const { customer_id, history, ...rest } = o;
      return { ...rest, balance: r2(o.total - o.amount_paid), customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, notes: c.notes } };
    },
    order(id) {
      const o = this.find(id);
      return { ...this.out(o), history: o.history };
    },
    orders(p) {
      const now = new Date();
      const status = p.status || 'all';
      const q = String(p.q || '').trim().toLowerCase();
      const since = p.completed_since_hours ? new Date(Date.now() - p.completed_since_hours * 3600000) : null;
      return this.db.orders
        .filter((o) => {
          if (status === 'active' && o.status === 'completed') return false;
          if (status === 'overdue' && !(['received', 'washing', 'drying'].includes(o.status) && new Date(o.ready_at) < now)) return false;
          if (STATUSES.includes(status) && o.status !== status) return false;
          if (since && o.status === 'completed' && new Date(o.completed_at) < since) return false;
          if (p.customer_id && o.customer_id !== Number(p.customer_id)) return false;
          if (p.from && new Date(o.created_at) < dayStart(p.from)) return false;
          if (p.to && new Date(o.created_at) >= dayStart(p.to, 1)) return false;
          if (q) {
            const c = this.db.customers.find((x) => x.id === o.customer_id) || {};
            if (!(o.code.toLowerCase().includes(q) || (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q.replace(/\s+/g, '')))) return false;
          }
          return true;
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Number(p.limit) || 300)
        .map((o) => this.out(o));
    },
    createOrder(p, at = new Date()) {
      const items = Array.isArray(p.items) ? p.items : [];
      if (!items.length) fail('Add at least one service to the order.');
      let subtotal = 0, weight = 0, hours = 0, express = null;
      const lines = items.map((it) => {
        const s = this.db.services.find((x) => x.id === Number(it.service_id));
        if (!s || !s.active) fail('One of the selected services is no longer available.');
        const qty = s.unit === 'flat' ? 1 : r2(it.qty);
        if (qty <= 0) fail(`Enter the ${s.unit === 'kg' ? 'weight' : 'number of pieces'} for ${s.name}.`);
        const line_total = r2(qty * s.price);
        subtotal += line_total;
        if (s.unit === 'kg') weight += qty;
        if (s.is_express) express = s; else hours = Math.max(hours, s.turnaround_hours);
        return { service_id: s.id, name: s.name, unit: s.unit, qty, unit_price: s.price, line_total };
      });
      if (express) hours = express.turnaround_hours;
      subtotal = r2(subtotal);
      const discount = Math.min(Math.max(r2(p.discount), 0), subtotal);
      const total = r2(subtotal - discount);
      const paid = Math.min(Math.max(r2(p.payment && p.payment.amount), 0), total);
      const method = ['cash', 'gcash', 'card'].includes(p.payment && p.payment.method) ? p.payment.method : 'cash';

      const prefix = 'WH-' + WH.ymd(at).slice(2).replace(/-/g, '') + '-';
      const lastNo = this.db.orders.filter((o) => o.code.startsWith(prefix)).reduce((m, o) => Math.max(m, parseInt(o.code.slice(prefix.length), 10)), 0);
      const o = {
        id: this.nextId('orders'),
        code: prefix + String(lastNo + 1).padStart(4, '0'),
        track_token: newToken(),
        customer_id: this.resolveCustomer(p.customer || {}, at),
        status: 'received',
        fulfillment: p.fulfillment === 'delivery' ? 'delivery' : 'pickup',
        is_express: !!express,
        total_weight: r2(weight),
        subtotal, discount, total,
        amount_paid: paid,
        payment_status: payStatus(paid, total),
        notes: String(p.notes || '').trim().slice(0, 255),
        created_at: iso(at),
        ready_at: iso(new Date(at.getTime() + hours * 3600000)),
        status_updated_at: iso(at),
        completed_at: null,
        notified_at: null,
        items: lines,
        payments: paid > 0 ? [{ amount: paid, method, paid_at: iso(at) }] : [],
        history: [{ status: 'received', at: iso(at) }],
      };
      this.db.orders.push(o);
      return this.order(o.id);
    },
    setStatus(p, at = new Date()) {
      if (!STATUSES.includes(p.status)) fail('Invalid status.');
      const o = this.find(p.id);
      o.status = p.status;
      o.status_updated_at = iso(at);
      o.completed_at = p.status === 'completed' ? iso(at) : null;
      o.history.push({ status: p.status, at: iso(at) });
      return this.order(o.id);
    },
    addPayment(p, at = new Date()) {
      const o = this.find(p.id);
      const balance = r2(o.total - o.amount_paid);
      if (balance <= 0) fail('This order is already fully paid.');
      const amount = Math.min(r2(p.amount), balance);
      if (amount <= 0) fail('Enter the amount received.');
      o.payments.push({ amount, method: ['cash', 'gcash', 'card'].includes(p.method) ? p.method : 'cash', paid_at: iso(at) });
      o.amount_paid = r2(o.amount_paid + amount);
      o.payment_status = payStatus(o.amount_paid, o.total);
      return this.order(o.id);
    },

    // ----- dashboard & reports -----
    payments(from, to) {
      const out = [];
      this.db.orders.forEach((o) => o.payments.forEach((pay) => {
        const d = new Date(pay.paid_at);
        if (d >= from && d < to) out.push(pay);
      }));
      return out;
    },
    dashboard() {
      const today = dayStart(WH.ymd(new Date()));
      const week = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const next = new Date(d); next.setDate(next.getDate() + 1);
        week.push({ date: WH.ymd(d), label: d.toLocaleDateString('en-US', { weekday: 'short' }), total: r2(this.payments(d, next).reduce((s, x) => s + x.amount, 0)) });
      }
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const methods = { cash: 0, gcash: 0, card: 0 };
      this.payments(today, tomorrow).forEach((x) => { methods[x.method] = r2(methods[x.method] + x.amount); });
      const todays = this.db.orders.filter((o) => new Date(o.created_at) >= today);
      const status_counts = { received: 0, washing: 0, drying: 0, ready: 0 };
      this.db.orders.forEach((o) => { if (o.status !== 'completed') status_counts[o.status]++; });
      return {
        today_sales: week[6].total,
        week_sales: r2(week.reduce((s, d) => s + d.total, 0)),
        week,
        today_methods: methods,
        today_orders: todays.length,
        today_kg: r2(todays.reduce((s, o) => s + o.total_weight, 0)),
        status_counts,
        active_count: Object.values(status_counts).reduce((a, b) => a + b, 0),
        receivable: r2(this.db.orders.filter((o) => o.payment_status !== 'paid').reduce((s, o) => s + o.total - o.amount_paid, 0)),
        overdue: this.orders({ status: 'overdue', limit: 50 }),
        ready: this.orders({ status: 'ready', limit: 50 }),
        low_stock: this.inventory().filter((i) => i.low),
      };
    },
    report(p) {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      const now = new Date();
      let from = re.test(p.from || '') ? p.from : WH.ymd(new Date(now.getFullYear(), now.getMonth(), 1));
      let to = re.test(p.to || '') ? p.to : WH.ymd(now);
      if (from > to) [from, to] = [to, from];
      const days = [];
      for (let d = dayStart(from); WH.ymd(d) <= to; d.setDate(d.getDate() + 1)) {
        const start = new Date(d), end = new Date(d); end.setDate(end.getDate() + 1);
        const orders = this.db.orders.filter((o) => new Date(o.created_at) >= start && new Date(o.created_at) < end);
        days.push({
          date: WH.ymd(start),
          collected: r2(this.payments(start, end).reduce((s, x) => s + x.amount, 0)),
          orders: orders.length,
          billed: r2(orders.reduce((s, o) => s + o.total, 0)),
          kg: r2(orders.reduce((s, o) => s + o.total_weight, 0)),
        });
      }
      const start = dayStart(from), end = dayStart(to, 1);
      const inRange = this.db.orders.filter((o) => new Date(o.created_at) >= start && new Date(o.created_at) < end);
      const svc = {};
      inRange.forEach((o) => o.items.forEach((i) => {
        const k = i.name + '|' + i.unit;
        svc[k] = svc[k] || { name: i.name, unit: i.unit, qty: 0, revenue: 0, orders: 0 };
        svc[k].qty = r2(svc[k].qty + i.qty); svc[k].revenue = r2(svc[k].revenue + i.line_total); svc[k].orders++;
      }));
      const methods = {};
      this.payments(start, end).forEach((x) => {
        methods[x.method] = methods[x.method] || { method: x.method, total: 0, count: 0 };
        methods[x.method].total = r2(methods[x.method].total + x.amount); methods[x.method].count++;
      });
      const orders = days.reduce((s, d) => s + d.orders, 0);
      const billed = r2(days.reduce((s, d) => s + d.billed, 0));
      return {
        from, to, days,
        services: Object.values(svc).sort((a, b) => b.revenue - a.revenue),
        methods: Object.values(methods),
        totals: { collected: r2(days.reduce((s, d) => s + d.collected, 0)), billed, orders, kg: r2(days.reduce((s, d) => s + d.kg, 0)), average: orders ? r2(billed / orders) : 0 },
      };
    },

    // ----- inventory -----
    inventory() {
      return [...this.db.inventory].sort((a, b) => a.name.localeCompare(b.name)).map((i) => ({ ...i, low: i.stock <= i.reorder_level }));
    },
    saveInventory(p) {
      const row = {
        name: String(p.name || '').trim().slice(0, 100) || fail('Item name is required.'),
        unit: String(p.unit || 'pcs').trim().slice(0, 20) || 'pcs',
        reorder_level: Math.max(0, r2(p.reorder_level)),
        cost: Math.max(0, r2(p.cost)),
        updated_at: iso(new Date()),
      };
      const item = this.db.inventory.find((i) => i.id === Number(p.id));
      if (item) Object.assign(item, row);
      else {
        const stock = Math.max(0, r2(p.stock));
        const id = this.nextId('inventory');
        this.db.inventory.push({ id, ...row, stock });
        if (stock > 0) this.db.invLogs.push({ item_id: id, change: stock, reason: 'Initial stock', created_at: row.updated_at });
      }
      return this.inventory();
    },
    adjustInventory(p) {
      const item = this.db.inventory.find((i) => i.id === Number(p.id)) || fail('Item not found.');
      const change = r2(p.change);
      if (!change) fail('Enter a quantity to add or remove.');
      if (item.stock + change < 0) fail(`Not enough stock (only ${item.stock} left).`);
      item.stock = r2(item.stock + change);
      item.updated_at = iso(new Date());
      this.db.invLogs.push({ item_id: item.id, change, reason: String(p.reason || '').slice(0, 120), created_at: item.updated_at });
      return this.inventory();
    },
    inventoryLogs(p) {
      return this.db.invLogs
        .filter((l) => !p.id || l.item_id === Number(p.id))
        .slice(-100).reverse()
        .map((l) => { const i = this.db.inventory.find((x) => x.id === l.item_id) || {}; return { ...l, name: i.name, unit: i.unit }; });
    },
  };
})(window.WH);
