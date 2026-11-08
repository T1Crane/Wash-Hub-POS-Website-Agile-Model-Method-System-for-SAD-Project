/* ==========================================================================
   index.js — App start-up, page router, sidebar & top bar
   --------------------------------------------------------------------------
   Pages are addressed by the URL hash, e.g.  index.php#/pos
   Each page is a function in js/views/*.js:  WH.views.<name>(container, params)
   It may return { refresh(), destroy() }:
     refresh() — reload data after something changed (WH.refresh())
     destroy() — stop timers when leaving the page
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  // Sidebar menu. Order here = order on screen.
  //   need   = the server action this page requires (see WashHubApi::PERMISSIONS) -> decides who sees it
  //   server = needs the MySQL server (hidden in demo mode)
  //   hidden = not in the menu (opened another way)
  const ROUTES = [
    { key: 'dashboard', label: 'Dashboard',  icon: 'dashboard', need: 'dashboard' },
    { key: 'pos',       label: 'New Order',  icon: 'plus',      need: 'order_create' },
    { key: 'board',     label: 'Orders',     icon: 'board',     need: 'orders' },
    { key: 'customers', label: 'Customers',  icon: 'users',     need: 'customers' },
    { key: 'inventory', label: 'Inventory',  icon: 'box',       need: 'inventory' },
    { key: 'reports',   label: 'Reports',    icon: 'chart',     need: 'report' },
    { key: 'users',     label: 'Users',      icon: 'shield',    need: 'users',        server: true },
    { key: 'activity',  label: 'Activity Log', icon: 'clock',   need: 'activity_log', server: true }, // ★ Shop Owner only
    { key: 'settings',  label: 'Settings',   icon: 'settings',  need: 'service_save' },
    { key: 'account',   label: 'My Account', icon: 'user',      need: 'account_save', server: true, hidden: true },
  ];

  /** The pages the logged-in user may open. The first one is their start page
      (Owner / Admin: Dashboard, Staff: New Order). */
  WH.myRoutes = () => ROUTES.filter((r) => WH.can(r.need) && !(r.server && WH.store.mode !== 'mysql'));

  WH.state = { settings: {}, services: [] };
  let current = null; // { key, handle }

  /** WH.navigate('board', {q:'WH-261022-0001'}) */
  WH.navigate = (key, params = {}) => {
    const qs = new URLSearchParams(params).toString();
    const hash = `#/${key}${qs ? '?' + qs : ''}`;
    if (location.hash === hash) render(); else location.hash = hash;
  };

  /** Reload the data on the current page (called after saving something) */
  WH.refresh = () => {
    if (current && current.handle && current.handle.refresh) current.handle.refresh();
    WH.updateBadges();
  };

  /** Reads "#/board?q=abc" -> { key:'board', params:{q:'abc'} }.
      A page this user may not open (or an unknown one) goes to their start page instead. */
  const parseHash = () => {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const mine = WH.myRoutes();
    const key = mine.some((r) => r.key === path) ? path : mine[0].key;
    return { key, params: Object.fromEntries(new URLSearchParams(query || '')) };
  };

  const render = () => {
    const { key, params } = parseHash();
    if (current && current.handle && current.handle.destroy) current.handle.destroy();
    document.getElementById('modal-root').innerHTML = ''; // close dialogs left open on the old page
    const route = ROUTES.find((r) => r.key === key);
    document.title = `${route.label} · ${WH.state.settings.shop_name || 'Gap Wash Hub'} POS`;
    document.getElementById('page-title').textContent = route.label;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
    const chip = document.querySelector('.user-chip');
    if (chip) chip.classList.toggle('active', key === 'account');
    const view = document.getElementById('view');
    view.innerHTML = '';
    view.scrollTop = 0;
    window.scrollTo(0, 0);
    current = { key, handle: WH.views[key](view, params) || null };
  };

  /** Sidebar + top bar + demo-mode banner */
  WH.renderChrome = () => {
    const s = WH.state.settings;
    const local = WH.store.mode === 'local';
    const { key } = parseHash();
    document.getElementById('sidebar').innerHTML = `
      <div class="brand">${WH.logo('brand-logo')}
        <div class="brand-text"><div class="brand-name">${h(s.shop_name || 'Gap Wash Hub')}</div><div class="brand-sub">POS & Inventory</div></div></div>
      <nav class="nav" aria-label="Main">
        ${WH.myRoutes().filter((r) => !r.hidden).map((r) => `<a href="#/${r.key}" data-key="${r.key}" title="${r.label}">${WH.icon(r.icon)}<span class="lbl">${r.label}</span><span class="badge hidden" data-badge="${r.key}"></span></a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <a class="user-chip ${key === 'account' ? 'active' : ''}" ${local ? '' : 'href="#/account"'} title="My account">
          <span class="avatar" style="width:32px;height:32px;font-size:.75rem">${h(WH.initials(WH.state.user.full_name))}</span>
          <span class="foot-text"><b>${h(WH.state.user.full_name)}</b><br><span class="role">${h(WH.roleLabel(WH.state.user.role))}</span></span></a>
        ${local ? '' : `<button class="btn btn-sm btn-ghost" style="color:#fff;width:100%;margin-bottom:8px" onclick="WH.logout()">${WH.icon('logout')}<span class="foot-text">Log out</span></button>`}
        <div title="${h(local ? WH.store.reason : 'Connected to MySQL')}"><span class="mode-dot ${local ? 'local' : ''}"></span><span class="foot-text">${local ? 'Demo mode (browser)' : 'MySQL connected'}</span></div>
      </div>`;

    document.getElementById('banner').innerHTML = local
      ? `<div class="demo-banner"><b>Demo mode:</b> data is saved in this browser only. ${h(WH.store.reason)} — see README to connect XAMPP MySQL.</div>`
      : '';
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
    WH.updateBadges();
  };

  /** Red counters on the menu: overdue orders, low-stock items */
  WH.updateBadges = WH.debounce(async () => {
    if (!WH.can('dashboard')) return; // the counts come from the dashboard (Owner/Admin only)
    try {
      const d = await WH.api('dashboard');
      const set = (key, n) => {
        const el = document.querySelector(`[data-badge="${key}"]`);
        if (!el) return;
        el.textContent = n;
        el.classList.toggle('hidden', !n);
        el.title = key === 'board' ? `${n} overdue` : `${n} low on stock`;
      };
      set('board', d.overdue.length);
      set('inventory', d.low_stock.length);
    } catch (e) { /* badges are optional */ }
  }, 300);

  /** Top-bar "scan or type ticket" box: works with USB barcode scanners (they type the code + Enter) */
  const setupScanBox = () => {
    const input = document.getElementById('scan');
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = input.value.trim();
      if (!q) return;
      try {
        const found = await WH.api('orders', { q, limit: 20 });
        const exact = found.find((o) => o.code.toLowerCase() === q.toLowerCase());
        input.value = '';
        if (exact || found.length === 1) WH.openOrder((exact || found[0]).id);
        else WH.navigate('board', { q, filter: 'all' });
        input.blur();
      } catch (err) { WH.error(err); }
    });
  };

  const startClock = () => {
    const el = document.getElementById('clock');
    const tick = () => { el.textContent = new Date().toLocaleString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    tick();
    setInterval(tick, 15000);
  };

  /** Shows the login form. Resolves once someone has logged in successfully. */
  const showLogin = () => new Promise((resolve) => {
    const app = document.querySelector('.app');
    const root = document.getElementById('login-root');
    app.classList.add('hidden');
    root.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="login-form">
          ${WH.logo('brand-logo')}
          <h1>${h(WH.state.settings.shop_name || 'Gap Wash Hub')}</h1>
          <p class="sub">Sign in to the POS</p>
          <div id="login-error"></div>
          <div class="stack">
            <label class="field">Username<input type="text" name="username" autocomplete="username" required></label>
            <label class="field">Password<input type="password" name="password" autocomplete="current-password" required></label>
            <button class="btn btn-primary btn-xl" type="submit">Sign in</button>
          </div>
        </form>
      </div>`;
    const form = document.getElementById('login-form');
    form.username.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); // stop the browser from reloading the page
      try {
        const user = await WH.api('login', { username: form.username.value.trim(), password: form.password.value });
        root.innerHTML = '';
        app.classList.remove('hidden');
        resolve(user);
      } catch (err) {
        document.getElementById('login-error').innerHTML = `<div class="login-error">${h(err.message)}</div>`;
        form.password.value = '';
        form.password.focus();
      }
    });
  });

  /**
   * Public "track your order" card. Opened by scanning the QR code on a claim ticket
   * (index.php?track=<secret code>). No login needed; shows no phone number or address.
   */
  const showTracking = async (token) => {
    document.querySelector('.app').classList.add('hidden');
    const root = document.getElementById('login-root');
    const card = (inner) => { root.innerHTML = `<div class="login-wrap"><div class="login-card track-card">${WH.logo('brand-logo')}${inner}</div></div>`; };
    card('<p class="sub">Loading your order…</p>');

    let shop, o;
    try {
      ({ shop, order: o } = await WH.api('track', { t: token }));
    } catch (e) {
      card(`<h1>Order not found</h1><p class="sub">${h(e.message)}</p>`);
      return;
    }
    document.title = `${o.code} · ${shop.name}`;
    const idx = WH.STATUSES.findIndex((s) => s.key === o.status);
    const done = o.status === 'completed';
    const late = WH.isOverdue(o);
    const message = done ? `Your laundry was ${o.fulfillment === 'delivery' ? 'delivered' : 'picked up'}. Thank you!`
      : o.status === 'ready' ? (o.fulfillment === 'delivery' ? 'Your laundry is ready and will be delivered soon.' : 'Your laundry is ready for pickup!')
      : late ? 'We are finishing your laundry. Sorry for the delay!'
      : 'We are working on your laundry.';

    card(`
      <h1>${h(shop.name)}</h1>
      <p class="sub">Hi ${h(o.first_name)}! ${h(message)}</p>
      <div class="track-code">${h(o.code)}</div>
      <div class="track-status st-${h(o.status)}">${h(WH.statusLabel(o))}</div>
      <div class="timeline">${WH.STATUSES.map((s, i) => `
        <div class="stage ${i <= idx ? 'done' : ''} ${i === idx ? 'current' : ''}"><div class="bar-s"></div>${h(i === 4 ? WH.statusLabel({ status: 'completed', fulfillment: o.fulfillment }) : s.label)}</div>`).join('')}
      </div>
      <dl class="kv" style="margin-top:6px">
        <dt>${done ? (o.fulfillment === 'delivery' ? 'Delivered' : 'Picked up') : 'Ready by'}</dt><dd>${WH.fmtWhen(done ? o.completed_at : o.ready_at)}</dd>
        <dt>Items</dt><dd>${h(WH.itemsSummary(o.items))}</dd>
        <dt>Total</dt><dd>${WH.money(o.total)}</dd>
        <dt>Payment</dt><dd>${o.balance > 0 ? `${WH.payLabel(o.payment_status)} · <b style="color:var(--danger)">${WH.money(o.balance)} to pay</b>` : 'Paid in full'}</dd>
      </dl>
      <p class="small muted" style="text-align:center;margin:18px 0 0">${h(shop.address)}<br>${h(shop.phone)}</p>`);
  };

  /** Logout button: tells the server, then reloads the page (back to the login form). */
  WH.logout = async () => {
    try { await WH.api('logout'); } catch (e) { /* reload anyway */ }
    location.hash = '';
    location.reload();
  };

  // ---------- Start ----------
  const start = async () => {
    await WH.initStore();

    // Opened from the QR code on a ticket? Show the customer's order card instead of the app.
    const trackToken = new URLSearchParams(location.search).get('track');
    if (trackToken) {
      await showTracking(trackToken);
      return;
    }

    // MySQL mode needs a login. (Demo mode has no server, so everyone is Owner / Admin.)
    if (WH.store.mode === 'mysql') {
      WH.state.user = await WH.api('me');
      if (!WH.state.user) WH.state.user = await showLogin();
    } else {
      WH.state.user = { id: 0, username: 'demo', full_name: 'Demo User', role: 'admin' };
    }

    try {
      Object.assign(WH.state, await WH.api('bootstrap'));
    } catch (e) {
      document.getElementById('view').innerHTML = `<div class="card empty"><h2>Can't load the app</h2><p>${h(e.message)}</p></div>`;
      return;
    }
    WH.renderChrome();
    setupScanBox();
    startClock();
    window.addEventListener('hashchange', render);
    render();
  };

  document.addEventListener('DOMContentLoaded', start);
})(window.WH);
