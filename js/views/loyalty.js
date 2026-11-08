/* ==========================================================================
   views/loyalty.js — ★ Loyalty Card page
   --------------------------------------------------------------------------
   - Every customer's stamp card on one screen: ticked boxes, FREE boxes,
     "N FREE available", Card #, total ticks, FREE earned / used, last visit
   - Owner / Admin: the form at the top adds ticks to a customer (finds them by
     phone or exact name, or adds them) — e.g. to copy an old paper card —
     and "Adjust ticks" on each card. Every change goes to the Activity Log.
   - The rules (1 tick per load, FREE every 7th box…) are in WH.loyaltyPlan
     (js/utils.js) and WashHubApi::loyaltyPlan.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** One customer's card, like the paper card: ticked boxes in blue, FREE boxes in yellow. */
  const cardHTML = (c, cfg, canEdit) => {
    const ticks = c.loyalty_ticks;
    const card = Math.floor(ticks / cfg.size) + 1;   // the card the next tick goes on
    const filled = ticks % cfg.size;
    let boxes = '';
    for (let i = 1; i <= cfg.size; i++) {
      const free = i % cfg.every === 0;
      boxes += `<span class="loyal-box ${i <= filled ? 'done' : ''} ${free ? 'free' : ''}">${free ? 'FREE' : i}</span>`;
    }
    return `<div class="card loyal-card" data-cid="${c.id}">
      <div class="loyal-card-top">
        <div style="min-width:0">
          <div class="loyal-name">${h(c.name)}</div>
          <div class="small muted">${h(c.phone || 'No contact number')}</div>
        </div>
        <div class="right">
          ${c.loyalty_free_available ? `<span class="pill paid">${c.loyalty_free_available} FREE available</span>` : ''}
          <div class="small muted" style="margin-top:4px">Card #${card}</div>
        </div>
      </div>
      <div class="loyal-grid" style="grid-template-columns:repeat(${Math.min(cfg.size, 7)},1fr);margin:10px 0">${boxes}</div>
      <dl class="loyal-stats">
        <dt>Total ticks (all cards)</dt><dd>${ticks}</dd>
        <dt>FREE earned / used</dt><dd>${c.loyalty_free_earned} / ${c.loyalty_free_used}</dd>
        <dt>Last visit</dt><dd>${c.last_order_at ? WH.fmtDateTime(c.last_order_at) : '—'}</dd>
      </dl>
      <div class="row" style="margin-top:10px">
        ${canEdit ? `<button class="btn btn-sm" data-adjust="${c.id}">${WH.icon('edit')} Adjust ticks</button>` : ''}
        <button class="btn btn-sm" data-orders="${c.id}">${WH.icon('board')} View orders</button>
      </div>
    </div>`;
  };

  WH.views = WH.views || {};
  WH.views.loyalty = (view) => {
    const canEdit = WH.can('loyalty_card_save');   // Owner / Admin
    const cfg = WH.loyaltyConfig();
    let list = [];

    view.innerHTML = `
      ${!cfg.enabled ? `<div class="card" style="margin-bottom:14px"><b>The loyalty card is switched off.</b> ${WH.can('settings_save') ? 'Turn it on in <b>Settings → Loyalty card</b>.' : ''}</div>` : ''}
      ${canEdit ? `
      <div class="card" style="margin-bottom:14px" id="loy-form">
        <div class="loyal-form">
          <label class="field">Customer name *<input type="text" name="name" maxlength="100" autocomplete="off"></label>
          <label class="field">Contact number (optional)<input type="tel" name="phone" maxlength="30" inputmode="tel" placeholder="09XXXXXXXXX"></label>
          <label class="field">Ticks to add<input type="number" name="add" step="1" placeholder="e.g. 5 or -1"></label>
          <label class="field">FREE already used<input type="number" name="free_used" min="0" step="1" placeholder="0"></label>
          <label class="field">Note (optional)<input type="text" name="note" maxlength="100" placeholder="e.g. From paper card"></label>
          <button class="btn btn-primary" id="loy-save">${WH.icon('check')} Save</button>
        </div>
        <p class="small muted" style="margin:8px 0 0">Finds the customer by contact number (or exact name). If they are new, they are added.
          Leave "FREE already used" blank to keep it as it is.</p>
      </div>` : ''}
      <div class="toolbar">
        <input type="search" id="loy-q" placeholder="Search name or phone…" style="max-width:300px">
        <span class="spacer"></span>
        <span class="small muted">${cfg.size}-box card · FREE every ${cfg.every} · reward: ${h(WH.loyaltyRewardText(cfg))}
          · ${cfg.mode === 'save' ? 'FREE is saved until used' : 'FREE is used right away'}</span>
      </div>
      <div id="loy-body"><div class="loading">Loading…</div></div>`;

    const render = () => {
      const body = view.querySelector('#loy-body');
      // Customers with FREE available first, then the most recent visits
      const sorted = [...list].sort((a, b) => b.loyalty_free_available - a.loyalty_free_available
        || String(b.last_order_at || '').localeCompare(String(a.last_order_at || '')));
      body.innerHTML = sorted.length
        ? `<div class="loyal-cards">${sorted.map((c) => cardHTML(c, cfg, canEdit)).join('')}</div>`
        : `<div class="card empty">${WH.icon('star')}<div>No loyalty cards yet. Ticks are added automatically with every order${canEdit ? ', or with the form above' : ''}.</div></div>`;
      const find = (id) => list.find((c) => c.id === Number(id));
      body.querySelectorAll('[data-adjust]').forEach((b) => b.addEventListener('click', () => adjust(find(b.dataset.adjust))));
      body.querySelectorAll('[data-orders]').forEach((b) => b.addEventListener('click', () => WH.openCustomer(find(b.dataset.orders), load)));
    };

    const load = async () => {
      try {
        list = await WH.api('customers', { loyalty_only: true, q: view.querySelector('#loy-q').value.trim(), limit: 500 });
        render();
      } catch (e) { WH.error(e); }
    };

    // Owner / Admin: change one card (+/- ticks, FREE already used, note)
    const adjust = (c) => {
      const m = WH.modal({
        title: `Adjust loyalty card · ${c.name}`,
        body: `<div class="stack">
          <p class="small muted" style="margin:0">Now: <b>${c.loyalty_ticks}</b> ticks · FREE earned ${c.loyalty_free_earned} / used ${c.loyalty_free_used}</p>
          <label class="field">Ticks to add or remove<input type="number" name="add" step="1" placeholder="e.g. 5 or -1"></label>
          <label class="field">FREE already used<input type="number" name="free_used" min="0" step="1" value="${c.loyalty_free_used}"></label>
          <label class="field">Note (optional)<input type="text" name="note" maxlength="100" placeholder="e.g. From paper card, correction"></label>
        </div>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      });
      m.el.querySelector('[data-act="save"]').onclick = async () => {
        try {
          const r = await WH.api('customer_loyalty', { id: c.id, ...WH.formData(m.el) });
          m.close();
          WH.toast(`${r.name}: ${r.loyalty_ticks} ticks · ${r.loyalty_free_available} FREE available`, 'success');
          load();
        } catch (e) { WH.error(e); }
      };
    };

    const form = view.querySelector('#loy-form');
    if (form) form.querySelector('#loy-save').onclick = async () => {
      try {
        const r = await WH.api('loyalty_card_save', WH.formData(form));
        form.querySelectorAll('input').forEach((i) => { i.value = ''; });
        WH.toast(`${r.name}: ${r.loyalty_ticks} ticks · ${r.loyalty_free_available} FREE available`, 'success');
        load();
      } catch (e) { WH.error(e); }
    };

    view.querySelector('#loy-q').addEventListener('input', WH.debounce(load, 250));
    load();
    return { refresh: load };
  };
})(window.WH);
