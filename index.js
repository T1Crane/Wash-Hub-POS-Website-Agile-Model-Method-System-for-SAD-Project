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
  const ROUTES = [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { key: 'pos',       label: 'New Order', icon: 'plus' },
    { key: 'board',     label: 'Orders',    icon: 'board' },
    { key: 'customers', label: 'Customers', icon: 'users' },
    { key: 'inventory', label: 'Inventory', icon: 'box' },
    { key: 'reports',   label: 'Reports',   icon: 'chart' },
    { key: 'settings',  label: 'Settings',  icon: 'settings' },
  ];

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

  /** Reads "#/board?q=abc" -> { key:'board', params:{q:'abc'} } */
  const parseHash = () => {
    const [path, query] = location.hash.replace(/^#\/?/, '').split('?');
    const key = ROUTES.some((r) => r.key === path) ? path : 'dashboard';
    return { key, params: Object.fromEntries(new URLSearchParams(query || '')) };
  };

  const render = () => {
    const { key, params } = parseHash();
    if (current && current.handle && current.handle.destroy) current.handle.destroy();
    document.getElementById('modal-root').innerHTML = ''; // close dialogs left open on the old page
    const route = ROUTES.find((r) => r.key === key);
    document.title = `${route.label} · ${WH.state.settings.shop_name || 'Wash Hub'} POS`;
    document.getElementById('page-title').textContent = route.label;
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
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
    document.getElementById('sidebar').innerHTML = `
      <div class="brand">${WH.logo('brand-logo')}
        <div class="brand-text"><div class="brand-name">${h(s.shop_name || 'Wash Hub')}</div><div class="brand-sub">POS & Inventory</div></div></div>
      <nav class="nav" aria-label="Main">
        ${ROUTES.map((r) => `<a href="#/${r.key}" data-key="${r.key}" title="${r.label}">${WH.icon(r.icon)}<span class="lbl">${r.label}</span><span class="badge hidden" data-badge="${r.key}"></span></a>`).join('')}
      </nav>
      <div class="sidebar-foot">
        <div title="${h(local ? WH.store.reason : 'Connected to MySQL')}"><span class="mode-dot ${local ? 'local' : ''}"></span><span class="foot-text">${local ? 'Demo mode (browser)' : 'MySQL connected'}</span></div>
      </div>`;

    document.getElementById('banner').innerHTML = local
      ? `<div class="demo-banner"><b>Demo mode:</b> data is saved in this browser only. ${h(WH.store.reason)} — see README to connect XAMPP MySQL.</div>`
      : '';
    const { key } = parseHash();
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.key === key));
    WH.updateBadges();
  };

  /** Red counters on the menu: overdue orders, low-stock items */
  WH.updateBadges = WH.debounce(async () => {
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

  // ---------- Start ----------
  const start = async () => {
    await WH.initStore();
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
