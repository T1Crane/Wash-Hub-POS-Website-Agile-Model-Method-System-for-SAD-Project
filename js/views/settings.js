/* ==========================================================================
   views/settings.js — Shop info, price list (services), data mode
   --------------------------------------------------------------------------
   - Shop details printed on the claim ticket + pickup terms + SMS template
   - Services: name, unit (kg / piece / add-on), price, turnaround hours,
     express flag, tile color, active on/off
   - Data: shows whether MySQL or the local demo storage is in use
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;
  const COLORS = ['blue', 'violet', 'amber', 'teal', 'red', 'green', 'pink', 'slate'];

  WH.views = WH.views || {};
  WH.views.settings = (view) => {
    const s = WH.state.settings;
    const local = WH.store.mode === 'local';
    const canEditShop = WH.can('settings_save'); // Owner / Admin only

    view.innerHTML = `
      <div class="page-grid">
        <div class="card">
          <div class="card-head"><h2>Shop details</h2><span class="small muted">${canEditShop ? 'Shown on the claim ticket' : 'Only Owner / Admin can change these'}</span></div>
          <fieldset ${canEditShop ? '' : 'disabled'} style="border:0;padding:0;margin:0;min-width:0">
          <div class="grid-2" id="set-shop">
            <label class="field">Shop name<input type="text" name="shop_name" value="${h(s.shop_name)}"></label>
            <label class="field">Tagline<input type="text" name="shop_tagline" value="${h(s.shop_tagline)}"></label>
            <label class="field">Address<input type="text" name="shop_address" value="${h(s.shop_address)}"></label>
            <label class="field">Phone<input type="text" name="shop_phone" value="${h(s.shop_phone)}"></label>
            <label class="field span-2">Pickup terms (printed on ticket)<textarea name="pickup_terms" rows="3">${h(s.pickup_terms)}</textarea></label>
            <label class="field span-2">"Ready for pickup" SMS template — use {name} {code} {shop} {balance} {total}
              <textarea name="sms_template" rows="2">${h(s.sms_template)}</textarea></label>
            <label class="field span-2">QR code link on tickets (the address customers' phones will open)
              <input type="text" name="public_url" value="${h(s.public_url)}" placeholder="${h(location.origin + location.pathname)}">
              <span class="small muted" style="font-weight:400">Leave blank to use the address this app is open on now.
                Phones on the shop Wi-Fi need this PC's network address, e.g. <code>http://192.168.1.189/washhub/</code> (run <code>ipconfig</code> to see it).
                Customers away from the shop can only open it once the system is hosted online.</span>
              ${!s.public_url && /^(localhost|127\.|\[::1\])/.test(location.hostname)
                ? '<span class="small" style="font-weight:600;color:var(--warning)">⚠ The app is open on "localhost", so QR codes will point to localhost and phones can\'t open them. Fill in this PC\'s network address above.</span>'
                : ''}
            </label>
          </div>
          </fieldset>
          ${canEditShop ? `<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn btn-primary" id="set-save">${WH.icon('check')} Save shop details</button></div>` : ''}
        </div>

        <div class="card">
          <div class="card-head"><h2>Services & prices</h2><button class="btn btn-sm" id="svc-add">${WH.icon('plus')} Add service</button></div>
          <p class="small muted" style="margin-top:-6px">Express add-ons replace the turnaround time of the whole order (e.g. 6 hours = same day). Untick <b>Active</b> to hide a service for a while, or <b>Delete</b> to remove it (it goes to the Trash). Old orders and tickets keep their prices either way.</p>
          <div class="table-wrap"><table class="table" id="svc-table">
            <thead><tr><th>Name</th><th>Unit</th><th>Price (₱)</th><th>Turnaround (h)</th><th>Express</th><th title="Each load of this service earns a loyalty tick">★ Loyalty</th><th>Color</th><th>Active</th><th></th></tr></thead>
            <tbody></tbody>
          </table></div>
          <p class="small muted" style="margin:8px 0 0"><b>★ Loyalty</b> = each load of this service earns a tick on the customer's loyalty card. Untick it for add-ons (detergent, plastic…).</p>
        </div>

        ${canEditShop ? `
        <div class="card" id="loy-card">
          <div class="card-head"><h2>★ Loyalty card</h2><span class="small muted">Owner / Admin only</span></div>
          <p class="small muted" style="margin-top:-6px">Like a paper stamp card: each load = 1 tick. When a tick lands on a <b>FREE</b> box, that order gets the reward automatically.
            Example: a 14-box card with FREE every 7 → the 7th and 14th loads get the reward, then Card #2 starts.</p>
          <div class="grid-2">
            <label class="row span-2" style="font-weight:600"><input type="checkbox" name="loyalty_enabled" ${s.loyalty_enabled !== '0' ? 'checked' : ''} style="width:22px;height:22px"> Loyalty card is on</label>
            <label class="field">Boxes on one card<input type="number" name="loyalty_card_size" min="2" max="50" step="1" value="${h(s.loyalty_card_size || 14)}"></label>
            <label class="field">FREE on every … box<input type="number" name="loyalty_free_every" min="1" max="50" step="1" value="${h(s.loyalty_free_every || 7)}"></label>
            <label class="field">Reward when a FREE box is reached
              <select name="loyalty_reward">
                ${[['free_load', '1 load free (the cheapest load in that order)'], ['amount', 'Fixed peso discount (₱)'], ['percent', 'Percent off the order (%)']]
                  .map(([v, l]) => `<option value="${v}" ${(s.loyalty_reward || 'free_load') === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
            <label class="field span-2">When a FREE box is reached
              <select name="loyalty_mode">
                <option value="save" ${(s.loyalty_mode || 'save') === 'save' ? 'selected' : ''}>Save it as "FREE available" — the cashier taps Use FREE on any later order</option>
                <option value="auto" ${s.loyalty_mode === 'auto' ? 'selected' : ''}>Use it right away on the order that reaches the FREE box</option>
              </select></label>
            <label class="field">Discount value (for ₱ or %)<input type="number" name="loyalty_reward_value" min="0" step="0.01" value="${h(s.loyalty_reward_value || 0)}"></label>
          </div>
          <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn btn-primary" id="loy-save">${WH.icon('check')} Save loyalty card</button></div>
        </div>` : ''}

        ${WH.can('history_delete') ? `
        <div class="card" id="hist-card">
          <div class="card-head"><h2>${WH.icon('trash')} History cleanup</h2><span class="small muted">Owner / Admin only</span></div>
          <p class="small muted" style="margin-top:-6px">Delete <b>finished</b> orders (Picked Up / Delivered) received between two dates, with their payments.
            Orders still in progress are never deleted here. Those sales also disappear from Reports, so export a CSV in Reports first if you need a record.</p>
          <div class="row wrap" style="align-items:flex-end">
            <label class="field" style="width:180px">From<input type="date" name="from"></label>
            <label class="field" style="width:180px">To<input type="date" name="to" value="${WH.ymd(new Date())}"></label>
            <button class="btn" id="hist-check">${WH.icon('search')} Check</button>
            <button class="btn btn-danger" id="hist-delete" disabled>${WH.icon('trash')} Delete finished orders</button>
          </div>
          <div id="hist-result" class="small" style="margin-top:10px"></div>
          <p class="small muted" style="margin:14px 0 0">To delete one customer and all their orders, open them in <b>Customers</b>. To clear the stock movement log, use <b>Inventory</b>.</p>
        </div>` : ''}

        <div class="card">
          <div class="card-head"><h2>Data storage</h2></div>
          ${local ? `
            <p style="margin-top:0"><span class="mode-dot local"></span><b>Demo mode</b> — data is saved only in this browser (localStorage).</p>
            <p class="small muted">Reason: ${h(WH.store.reason)}</p>
            <p class="small">To use MySQL: start <b>Apache</b> and <b>MySQL</b> in the XAMPP Control Panel and open the app at <code>http://localhost/&lt;folder&gt;/</code>. See README.md.</p>
            <div class="row wrap"><button class="btn" id="data-export">${WH.icon('download')} Export demo data (JSON)</button>
              <button class="btn btn-danger" id="data-reset">${WH.icon('refresh')} Reset demo data</button></div>`
          : `<p style="margin:0"><span class="mode-dot"></span><b>Connected to MySQL</b> — all counters using this server share the same data.</p>`}
        </div>
      </div>`;

    // ----- shop details -----
    if (canEditShop) view.querySelector('#set-save').onclick = async () => {
      try {
        WH.state.settings = await WH.api('settings_save', WH.formData(view.querySelector('#set-shop')));
        WH.toast('Shop details saved', 'success');
        WH.renderChrome();
      } catch (e) { WH.error(e); }
    };

    // ----- loyalty card settings -----
    const loy = view.querySelector('#loy-card');
    if (loy) loy.querySelector('#loy-save').onclick = async () => {
      const f = WH.formData(loy);
      try {
        WH.state.settings = await WH.api('settings_save', { ...f, loyalty_enabled: f.loyalty_enabled ? '1' : '0' });
        WH.toast('Loyalty card saved', 'success');
      } catch (e) { WH.error(e); }
    };

    // ----- services table -----
    const row = (svc) => `
      <tr data-id="${svc.id || ''}">
        <td><input type="text" name="name" value="${h(svc.name)}" style="min-width:180px"></td>
        <td><select name="unit">${[['kg', 'per kg'], ['pc', 'per piece'], ['flat', 'add-on']].map(([v, l]) => `<option value="${v}" ${svc.unit === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td><input type="number" name="price" min="0" step="0.01" value="${h(svc.price)}" style="width:110px"></td>
        <td><input type="number" name="turnaround_hours" min="1" step="1" value="${h(svc.turnaround_hours)}" style="width:100px"></td>
        <td><input type="checkbox" name="is_express" ${svc.is_express ? 'checked' : ''} style="width:22px;height:22px"></td>
        <td><input type="checkbox" name="loyalty" ${svc.loyalty !== false ? 'checked' : ''} style="width:22px;height:22px" title="Earns a loyalty tick"></td>
        <td><select name="color">${COLORS.map((c) => `<option ${svc.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td><input type="checkbox" name="active" ${svc.active ? 'checked' : ''} style="width:22px;height:22px"></td>
        <td><div class="row" style="flex-wrap:nowrap">
          <button class="btn btn-sm btn-primary" data-save>Save</button>
          <button class="btn btn-sm btn-danger btn-icon" data-delete title="Delete service" aria-label="Delete service">${WH.icon('trash')}</button>
        </div></td>
      </tr>`;
    const tbody = view.querySelector('#svc-table tbody');
    const renderServices = () => {
      tbody.innerHTML = WH.state.services.map(row).join('');
      bindRows();
    };
    const bindRows = () => {
      tbody.querySelectorAll('[data-save]').forEach((b) => {
        b.onclick = async () => {
          const tr = b.closest('tr');
          const data = WH.formData(tr);
          const index = Array.from(tbody.children).indexOf(tr);
          try {
            WH.state.services = await WH.api('service_save', { ...data, id: Number(tr.dataset.id) || 0, sort_order: index + 1 });
            WH.toast('Service saved', 'success');
            renderServices();
          } catch (e) { WH.error(e); }
        };
      });
      // Delete: a row that was never saved is just removed; a saved one is deleted on the server after asking
      tbody.querySelectorAll('[data-delete]').forEach((b) => {
        b.onclick = async () => {
          const tr = b.closest('tr');
          const id = Number(tr.dataset.id) || 0;
          if (!id) { tr.remove(); return; }
          const name = tr.querySelector('[name="name"]').value;
          const ok = await WH.confirm('Delete this service?',
            `<b>${h(name)}</b> will be removed from the price list and the New Order screen. Past orders and tickets keep their prices.<br><br>Tip: to hide it only for a while, untick <b>Active</b> instead.<br><br>${WH.trashNote()}`,
            'Delete service');
          if (!ok) return;
          try {
            WH.state.services = await WH.api('service_delete', { id });
            WH.toast(`${name} was deleted`, 'success');
            renderServices();
          } catch (e) { WH.error(e); }
        };
      });
    };
    view.querySelector('#svc-add').onclick = () => {
      tbody.insertAdjacentHTML('beforeend', row({ name: '', unit: 'pc', price: 0, turnaround_hours: 24, is_express: false, loyalty: true, color: 'green', active: true }));
      bindRows();
      tbody.lastElementChild.querySelector('input').focus();
    };
    renderServices();

    // ----- history cleanup: first "Check" (count only), then "Delete" (asks once more) -----
    const hist = view.querySelector('#hist-card');
    if (hist) {
      const result = hist.querySelector('#hist-result');
      const delBtn = hist.querySelector('#hist-delete');
      let checked = null; // the range that was last checked
      const range = () => ({ from: hist.querySelector('[name="from"]').value, to: hist.querySelector('[name="to"]').value });
      hist.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => { checked = null; delBtn.disabled = true; result.innerHTML = ''; }));

      hist.querySelector('#hist-check').onclick = async () => {
        try {
          checked = await WH.api('history_delete', range()); // without confirm = count only
          result.innerHTML = checked.count
            ? `<b>${checked.count}</b> finished order${checked.count === 1 ? '' : 's'} from ${WH.fmtDate(checked.from + 'T12:00:00')} to ${WH.fmtDate(checked.to + 'T12:00:00')} · billed ${WH.money(checked.billed)} · paid ${WH.money(checked.paid)}`
            : 'No finished orders in these dates.';
          delBtn.disabled = !checked.count;
        } catch (e) { WH.error(e); }
      };

      delBtn.onclick = async () => {
        if (!checked || !checked.count) return;
        const ok = await WH.confirm(`Delete ${checked.count} finished order${checked.count === 1 ? '' : 's'}?`,
          `All finished orders from <b>${WH.fmtDate(checked.from + 'T12:00:00')}</b> to <b>${WH.fmtDate(checked.to + 'T12:00:00')}</b> will be deleted,
           with their payments (<b>${WH.money(checked.paid)}</b>). Reports for these dates will change.<br><br>${WH.trashNote()}`,
          'Delete orders');
        if (!ok) return;
        try {
          const r = await WH.api('history_delete', { from: checked.from, to: checked.to, confirm: true });
          WH.toast(`${r.count} finished order${r.count === 1 ? '' : 's'} deleted`, 'success');
          checked = null;
          delBtn.disabled = true;
          result.innerHTML = '';
          WH.updateBadges();
        } catch (e) { WH.error(e); }
      };
    }

    // ----- demo data tools -----
    if (local) {
      view.querySelector('#data-export').onclick = async () => {
        WH.downloadText('washhub-demo-data.json', JSON.stringify(await WH.api('local_export'), null, 2), 'application/json');
      };
      view.querySelector('#data-reset').onclick = async () => {
        if (!(await WH.confirm('Reset demo data?', 'All demo orders, customers and settings in this browser will be replaced with fresh sample data.', 'Reset'))) return;
        await WH.api('local_reset');
        Object.assign(WH.state, await WH.api('bootstrap'));
        WH.toast('Demo data reset', 'success');
        WH.renderChrome();
        WH.views.settings(view);
      };
    }
  };
})(window.WH);
