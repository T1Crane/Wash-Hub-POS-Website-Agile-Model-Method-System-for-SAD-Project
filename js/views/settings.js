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

    view.innerHTML = `
      <div class="page-grid">
        <div class="card">
          <div class="card-head"><h2>Shop details</h2><span class="small muted">Shown on the claim ticket</span></div>
          <div class="grid-2" id="set-shop">
            <label class="field">Shop name<input type="text" name="shop_name" value="${h(s.shop_name)}"></label>
            <label class="field">Tagline<input type="text" name="shop_tagline" value="${h(s.shop_tagline)}"></label>
            <label class="field">Address<input type="text" name="shop_address" value="${h(s.shop_address)}"></label>
            <label class="field">Phone<input type="text" name="shop_phone" value="${h(s.shop_phone)}"></label>
            <label class="field span-2">Pickup terms (printed on ticket)<textarea name="pickup_terms" rows="3">${h(s.pickup_terms)}</textarea></label>
            <label class="field span-2">"Ready for pickup" SMS template — use {name} {code} {shop} {balance} {total}
              <textarea name="sms_template" rows="2">${h(s.sms_template)}</textarea></label>
          </div>
          <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn btn-primary" id="set-save">${WH.icon('check')} Save shop details</button></div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Services & prices</h2><button class="btn btn-sm" id="svc-add">${WH.icon('plus')} Add service</button></div>
          <p class="small muted" style="margin-top:-6px">Express add-ons replace the turnaround time of the whole order (e.g. 6 hours = same day). Turn a service off instead of deleting it so old tickets stay correct.</p>
          <div class="table-wrap"><table class="table" id="svc-table">
            <thead><tr><th>Name</th><th>Unit</th><th>Price (₱)</th><th>Turnaround (h)</th><th>Express</th><th>Color</th><th>Active</th><th></th></tr></thead>
            <tbody></tbody>
          </table></div>
        </div>

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
    view.querySelector('#set-save').onclick = async () => {
      try {
        WH.state.settings = await WH.api('settings_save', WH.formData(view.querySelector('#set-shop')));
        WH.toast('Shop details saved', 'success');
        WH.renderChrome();
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
        <td><select name="color">${COLORS.map((c) => `<option ${svc.color === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
        <td><input type="checkbox" name="active" ${svc.active ? 'checked' : ''} style="width:22px;height:22px"></td>
        <td><button class="btn btn-sm btn-primary" data-save>Save</button></td>
      </tr>`;
    const tbody = view.querySelector('#svc-table tbody');
    const renderServices = () => {
      tbody.innerHTML = WH.state.services.map(row).join('');
      bindRows();
    };
    const bindRows = () => tbody.querySelectorAll('[data-save]').forEach((b) => {
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
    view.querySelector('#svc-add').onclick = () => {
      tbody.insertAdjacentHTML('beforeend', row({ name: '', unit: 'pc', price: 0, turnaround_hours: 24, is_express: false, color: 'green', active: true }));
      bindRows();
      tbody.lastElementChild.querySelector('input').focus();
    };
    renderServices();

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
