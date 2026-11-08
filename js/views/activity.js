/* ==========================================================================
   views/activity.js — Activity Log (★ Shop Owner only)
   --------------------------------------------------------------------------
   Shows who did what and when, newest first:
   - logins and failed login attempts
   - account changes: added, changed (role, disabled, password reset…), deleted,
     Shop Owner handed over, someone editing their own account
   - deletions: orders, customers, history cleanup, services, supplies,
     clearing the stock log
   The records come from wh_activity_logs (see WashHubApi::record). The app has
   no button or action that edits or deletes them, so they can be used as proof.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  // action key -> [label shown, pill color class, filter group]
  const ACTIONS = {
    login:                ['Logged in',             'ok',      'logins'],
    login_failed:         ['Failed login',          'low',     'logins'],
    user_add:             ['Added account',         'paid',    'accounts'],
    user_edit:            ['Changed account',       'partial', 'accounts'],
    user_delete:          ['Deleted account',       'low',     'accounts'],
    owner_transfer:       ['Shop Owner handed over', 'owner',  'accounts'],
    account_edit:         ['Edited own account',    '',        'accounts'],
    order_delete:         ['Deleted order',         'low',     'deletions'],
    customer_delete:      ['Deleted customer',      'low',     'deletions'],
    history_delete:       ['Deleted old history',   'low',     'deletions'],
    service_delete:       ['Deleted service',       'low',     'deletions'],
    inventory_delete:     ['Deleted supply item',   'low',     'deletions'],
    inventory_logs_clear: ['Cleared stock log',     'low',     'deletions'],
    loyalty_override:     ['Loyalty ticks changed', 'partial', 'accounts'],
    loyalty_adjust:       ['Loyalty card adjusted', 'partial', 'accounts'],
    trash_restore:        ['Restored from Trash',   'ok',      'deletions'],
    trash_purge:          ['Deleted forever',       'overdue', 'deletions'],
  };
  const GROUPS = { all: 'Everything', accounts: 'Accounts', deletions: 'Deletions', logins: 'Logins' };

  WH.views = WH.views || {};
  WH.views.activity = (view) => {
    view.innerHTML = `
      <div class="toolbar">
        <div class="segmented" id="act-group">${Object.entries(GROUPS).map(([k, v], i) =>
          `<button type="button" data-g="${k}" class="${i === 0 ? 'on' : ''}">${v}</button>`).join('')}</div>
        <input type="search" id="act-q" placeholder="Search name, order code, details…" style="max-width:280px">
        <span class="spacer"></span>
        <span class="muted small" id="act-count"></span>
      </div>
      <p class="small muted" style="margin:0 0 12px">Only the ★ Shop Owner can see this page. Entries can't be edited or deleted from the app.
        Showing the latest 500.</p>
      <div id="act-body"><div class="loading">Loading…</div></div>`;

    let rows = [];
    let group = 'all';

    const render = () => {
      const q = view.querySelector('#act-q').value.trim().toLowerCase();
      const list = rows.filter((r) => (group === 'all' || (ACTIONS[r.action] || [])[2] === group)
        && (!q || `${r.user_name} ${r.details} ${(ACTIONS[r.action] || [r.action])[0]}`.toLowerCase().includes(q)));
      view.querySelector('#act-count').textContent = `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`;
      view.querySelector('#act-body').innerHTML = list.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
          <tbody>${list.map((r) => {
            const [label, cls] = ACTIONS[r.action] || [r.action, ''];
            return `<tr>
              <td class="small" style="white-space:nowrap">${WH.fmtDateTime(r.created_at)}</td>
              <td>${r.user_name ? h(r.user_name) : '<span class="muted">Not logged in</span>'}</td>
              <td><span class="pill ${cls}">${h(label)}</span></td>
              <td class="small">${h(r.details)}</td></tr>`;
          }).join('')}</tbody></table></div>`
        : `<div class="card empty">${WH.icon('clock')}<div>No activity ${rows.length ? 'matches this filter' : 'recorded yet'}.</div></div>`;
    };

    const load = async () => {
      try { rows = await WH.api('activity_log', { limit: 500 }); render(); } catch (e) { WH.error(e); }
    };

    view.querySelectorAll('#act-group [data-g]').forEach((b) => b.addEventListener('click', () => {
      group = b.dataset.g;
      view.querySelectorAll('#act-group [data-g]').forEach((x) => x.classList.toggle('on', x === b));
      render();
    }));
    view.querySelector('#act-q').addEventListener('input', render);
    load();
    return { refresh: load };
  };
})(window.WH);
