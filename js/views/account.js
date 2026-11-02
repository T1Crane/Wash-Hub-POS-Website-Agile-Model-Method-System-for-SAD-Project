/* ==========================================================================
   views/account.js — "My Account" (every role)
   --------------------------------------------------------------------------
   Opened by clicking your name at the bottom of the sidebar.
   - Shows who you are, your role and the pages you can use
   - Edit your full name and username
   - Change your password (needs your current password)
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  WH.views = WH.views || {};
  WH.views.account = (view) => {
    const u = WH.state.user;
    const pages = WH.myRoutes().filter((r) => !r.hidden).map((r) => r.label);

    view.innerHTML = `
      <div class="page-grid" style="max-width:760px">
        <div class="card">
          <div class="row" style="gap:16px;align-items:center">
            <span class="avatar" style="width:64px;height:64px;font-size:1.4rem">${h(WH.initials(u.full_name))}</span>
            <div style="flex:1;min-width:0">
              <h2 style="font-size:1.4rem">${h(u.full_name)}</h2>
              <div class="muted">@${h(u.username)}</div>
              <div style="margin-top:6px">${WH.rolePill(u.role)}</div>
            </div>
          </div>
          <p class="small" style="margin:14px 0 4px"><b>Your role can:</b> ${h(WH.ROLES[u.role].about)}.</p>
          <p class="small muted" style="margin:0">Pages: ${pages.map(h).join(' · ')}</p>
        </div>

        <div class="card" id="acc-form">
          <div class="card-head"><h2>${WH.icon('user')} Profile</h2></div>
          <div class="grid-2">
            <label class="field">Full name<input type="text" name="full_name" maxlength="100" value="${h(u.full_name)}"></label>
            <label class="field">Username<input type="text" name="username" maxlength="50" autocomplete="username" value="${h(u.username)}"></label>
          </div>

          <div class="card-head" style="margin-top:22px"><h2>${WH.icon('key')} Change password</h2></div>
          <div class="grid-3">
            <label class="field">Current password<input type="password" name="current_password" autocomplete="current-password"></label>
            <label class="field">New password<input type="password" name="new_password" autocomplete="new-password" placeholder="At least 6 characters"></label>
            <label class="field">Repeat new password<input type="password" name="confirm_password" autocomplete="new-password"></label>
          </div>
          <p class="small muted">Your current password is needed only when you change your username or password.</p>

          <div class="row" style="justify-content:flex-end;margin-top:8px">
            <button class="btn btn-primary" id="acc-save">${WH.icon('check')} Save changes</button>
          </div>
        </div>
      </div>`;

    view.querySelector('#acc-save').onclick = async () => {
      const f = WH.formData(view.querySelector('#acc-form'));
      // Check on the screen first (the server checks again)
      if (f.new_password !== f.confirm_password) {
        WH.toast('The two new passwords are not the same.', 'error');
        return;
      }
      const sensitive = f.new_password || f.username.trim() !== u.username;
      if (sensitive && !f.current_password) {
        WH.toast('Enter your current password to change your username or password.', 'error');
        view.querySelector('[name="current_password"]').focus();
        return;
      }
      try {
        WH.state.user = await WH.api('account_save', {
          full_name: f.full_name,
          username: f.username,
          current_password: f.current_password,
          new_password: f.new_password,
        });
        WH.toast(f.new_password ? 'Saved. Use your new password next time you log in.' : 'Profile saved', 'success');
        WH.renderChrome();          // sidebar shows the new name
        WH.views.account(view);     // redraw with the saved values (password boxes cleared)
      } catch (e) { WH.error(e); }
    };
  };
})(window.WH);
