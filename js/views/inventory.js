/* ==========================================================================
   views/inventory.js — Supplies inventory (detergent, bags, hangers…)
   --------------------------------------------------------------------------
   - Stock list with low-stock warning (stock <= reorder level)
   - Restock (+) / Use (−) adjustments, each saved to a movement log
   - Add / edit items
   - Owner / Admin: delete items no longer used, clear the movement log
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  const REASONS = {
    in: ['Restock / delivery', 'Count correction'],
    out: ['Used for laundry', 'Damaged / expired', 'Count correction'],
  };

  WH.views = WH.views || {};
  WH.views.inventory = (view) => {
    view.innerHTML = `
      <div class="toolbar">
        <div><b id="inv-summary"></b></div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="inv-add">${WH.icon('plus')} Add item</button>
      </div>
      <div id="inv-body"><div class="loading">Loading…</div></div>
      <div class="row" style="margin:24px 0 10px"><h2 style="flex:1">Recent stock movements</h2>
        ${WH.can('inventory_logs_clear') ? `<button class="btn btn-sm btn-danger" id="inv-clear">${WH.icon('trash')} Clear history</button>` : ''}</div>
      <div id="inv-logs"></div>`;

    let items = [];

    const load = async () => {
      try {
        const [list, logs] = await Promise.all([WH.api('inventory'), WH.api('inventory_logs')]);
        items = list;
        render(logs);
      } catch (e) { WH.error(e); }
    };

    const render = (logs) => {
      const low = items.filter((i) => i.low).length;
      const value = items.reduce((s, i) => s + i.stock * i.cost, 0);
      view.querySelector('#inv-summary').innerHTML = `${items.length} items · Stock value ${WH.money(value)} ${low ? `· <span style="color:var(--danger)">${low} low on stock</span>` : ''}`;
      view.querySelector('#inv-body').innerHTML = items.length ? `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Item</th><th class="right">In stock</th><th>Level</th><th class="right">Reorder at</th><th class="right">Unit cost</th><th>Status</th><th class="right">Actions</th></tr></thead>
          <tbody>${items.map((i) => {
            const pct = Math.min(100, (i.stock / Math.max(i.reorder_level * 3, 1)) * 100);
            return `<tr>
              <td><b>${h(i.name)}</b><div class="tiny muted">Updated ${WH.fmtDateTime(i.updated_at)}</div></td>
              <td class="right num strong">${WH.num(i.stock)} ${h(i.unit)}</td>
              <td><div class="meter ${i.low ? 'low' : ''}"><span style="width:${pct}%"></span></div></td>
              <td class="right num">${WH.num(i.reorder_level)} ${h(i.unit)}</td>
              <td class="right num">${WH.money(i.cost)}</td>
              <td>${i.low ? `<span class="pill low">${WH.icon('alert')} Reorder</span>` : `<span class="pill ok">${WH.icon('check')} OK</span>`}</td>
              <td class="right"><div class="row" style="justify-content:flex-end">
                <button class="btn btn-sm" data-adj="in" data-id="${i.id}">${WH.icon('plus')} Restock</button>
                <button class="btn btn-sm" data-adj="out" data-id="${i.id}">${WH.icon('minus')} Use</button>
                <button class="btn btn-sm btn-ghost btn-icon" data-edit="${i.id}" aria-label="Edit">${WH.icon('edit')}</button>
                ${WH.can('inventory_delete') ? `<button class="btn btn-sm btn-ghost btn-icon" data-del="${i.id}" aria-label="Delete" title="Delete item" style="color:var(--danger)">${WH.icon('trash')}</button>` : ''}
              </div></td></tr>`;
          }).join('')}</tbody></table></div>`
        : `<div class="card empty">${WH.icon('box')}<div>No supplies yet.</div></div>`;

      view.querySelector('#inv-logs').innerHTML = logs.length ? `
        <div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Item</th><th class="right">Change</th><th>Reason</th></tr></thead>
          <tbody>${logs.slice(0, 20).map((l) => `<tr><td>${WH.fmtDateTime(l.created_at)}</td><td>${h(l.name)}</td>
            <td class="right num strong" style="color:${l.change > 0 ? 'var(--success)' : 'var(--danger)'}">${l.change > 0 ? '+' : ''}${WH.num(l.change)} ${h(l.unit)}</td>
            <td>${h(l.reason)}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="card empty small">No movements recorded yet.</div>';

      view.querySelectorAll('[data-adj]').forEach((b) => b.addEventListener('click', () => adjust(items.find((i) => i.id === Number(b.dataset.id)), b.dataset.adj)));
      view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(items.find((i) => i.id === Number(b.dataset.edit)))));
      view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => remove(items.find((i) => i.id === Number(b.dataset.del)))));
    };

    // Owner / Admin: delete a supply item that isn't used anymore (asks first)
    const remove = async (item) => {
      const ok = await WH.confirm(`Delete ${item.name}?`,
        `This removes the item from Inventory, along with its stock movement records. ${WH.trashNote()}`
        + (item.stock > 0 ? `<br><br><b>It still has ${WH.num(item.stock)} ${h(item.unit)} in stock.</b>` : ''),
        'Delete item');
      if (!ok) return;
      try {
        await WH.api('inventory_delete', { id: item.id });
        WH.toast(`${item.name} deleted`, 'success');
        load();
        WH.updateBadges();
      } catch (e) { WH.error(e); }
    };

    const adjust = (item, dir) => {
      const m = WH.modal({
        title: `${dir === 'in' ? 'Restock' : 'Use'} · ${item.name}`,
        body: `<div class="stack">
          <p class="muted" style="margin:0">Current stock: <b>${WH.num(item.stock)} ${h(item.unit)}</b></p>
          <label class="field">Quantity (${h(item.unit)})<input type="number" name="qty" min="0" step="0.01" inputmode="decimal"></label>
          <label class="field">Reason<select name="reason">${REASONS[dir].map((r) => `<option>${h(r)}</option>`).join('')}</select></label>
          <label class="field">Note (optional)<input type="text" name="note" maxlength="60" placeholder="e.g. supplier, receipt #"></label>
        </div>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      });
      m.el.querySelector('[data-act="save"]').onclick = async () => {
        const f = WH.formData(m.el);
        const qty = Number(f.qty) || 0;
        try {
          items = await WH.api('inventory_adjust', { id: item.id, change: dir === 'in' ? qty : -qty, reason: f.reason + (f.note ? ` — ${f.note}` : '') });
          m.close();
          WH.toast('Stock updated', 'success');
          load();
          WH.updateBadges();
        } catch (e) { WH.error(e); }
      };
    };

    const edit = (item = {}) => {
      const m = WH.modal({
        title: item.id ? `Edit ${item.name}` : 'New supply item',
        body: `<div class="grid-2">
          <label class="field span-2">Item name *<input type="text" name="name" maxlength="100" value="${h(item.name)}"></label>
          <label class="field">Unit (L, pcs, box…)<input type="text" name="unit" maxlength="20" value="${h(item.unit || 'pcs')}"></label>
          ${item.id ? '' : '<label class="field">Starting stock<input type="number" name="stock" min="0" step="0.01" value="0"></label>'}
          <label class="field">Reorder level<input type="number" name="reorder_level" min="0" step="0.01" value="${h(item.reorder_level ?? 0)}"></label>
          <label class="field">Unit cost (₱)<input type="number" name="cost" min="0" step="0.01" value="${h(item.cost ?? 0)}"></label>
        </div>`,
        foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      });
      m.el.querySelector('[data-act="save"]').onclick = async () => {
        try {
          await WH.api('inventory_save', { ...WH.formData(m.el), id: item.id });
          m.close();
          WH.toast('Item saved', 'success');
          load();
          WH.updateBadges();
        } catch (e) { WH.error(e); }
      };
    };

    view.querySelector('#inv-add').onclick = () => edit();

    // Owner / Admin: clear the movement log (stock numbers stay the same)
    const clearBtn = view.querySelector('#inv-clear');
    if (clearBtn) clearBtn.onclick = async () => {
      const ok = await WH.confirm('Clear stock movement history?',
        `Every restock / use record in this list will be cleared. <b>Current stock levels do not change.</b><br><br>${WH.trashNote()}`,
        'Clear history');
      if (!ok) return;
      try {
        const r = await WH.api('inventory_logs_clear');
        WH.toast(`${r.deleted} stock movement${r.deleted === 1 ? '' : 's'} cleared`, 'success');
        load();
      } catch (e) { WH.error(e); }
    };
    load();
    return { refresh: load };
  };
})(window.WH);
