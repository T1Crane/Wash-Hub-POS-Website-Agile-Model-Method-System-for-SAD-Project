/* ==========================================================================
   views/users.js — User accounts (Owner only)
   --------------------------------------------------------------------------
   - List of every account: name, username, role, active/disabled, last login
   - Add a user, or click a row to edit: name, username, role, active,
     and reset the password (leave blank to keep it)
   - The server refuses changing your OWN role or disabling yourself, so the
     shop can never be locked out (see WashHubApi::saveUser)
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** Add (no user) or edit (user given) dialog. Resolves true when saved. */
  const editUser = (u = {}) => new Promise((resolve) => {
    let saved = false;
    const isMe = u.id && u.id === WH.state.user.id;
    const m = WH.modal({
      title: u.id ? `Edit ${u.full_name}` : 'Add user',
      body: `
        <div class="grid-2">
          <label class="field span-2">Full name *<input type="text" name="full_name" maxlength="100" value="${h(u.full_name)}"></label>
          <label class="field">Username *<input type="text" name="username" maxlength="50" autocomplete="off" value="${h(u.username)}" placeholder="e.g. maria or maria@email.com"></label>
          <label class="field">Role *
            <select name="role" ${isMe ? 'disabled' : ''}>
              ${Object.keys(WH.ROLES).map((r) => `<option value="${r}" ${(u.role || 'cashier') === r ? 'selected' : ''}>${WH.roleLabel(r)}</option>`).join('')}
            </select>
          </label>
          <p class="small muted span-2" data-role="about" style="margin:-4px 0 0"></p>
          <label class="field span-2">${u.id ? 'New password (leave blank to keep the current one)' : 'Password * (at least 6 characters)'}
            <input type="password" name="password" autocomplete="new-password"></label>
          <label class="row span-2" style="font-weight:600">
            <input type="checkbox" name="active" ${u.active === false ? '' : 'checked'} ${isMe ? 'disabled' : ''} style="width:22px;height:22px">
            Account active (untick to block this person from logging in)
          </label>
          ${isMe ? '<p class="small muted span-2" style="margin:0">This is your own account: your role and status can\'t be changed here, so the shop is never left without an owner.</p>' : ''}
        </div>`,
      foot: `<button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      onClose: () => resolve(saved),
    });
    const role = m.el.querySelector('[name="role"]');
    const about = m.el.querySelector('[data-role="about"]');
    const showAbout = () => { about.textContent = `Can use: ${WH.ROLES[role.value].about}.`; };
    role.addEventListener('change', showAbout);
    showAbout();

    m.el.querySelector('[data-act="save"]').onclick = async () => {
      const f = WH.formData(m.el);
      try {
        await WH.api('user_save', {
          id: u.id,
          full_name: f.full_name,
          username: f.username,
          role: isMe ? u.role : f.role,
          active: isMe ? true : f.active,
          password: f.password,
        });
        saved = true;
        WH.toast(u.id ? 'User updated' : 'User added', 'success');
        m.close();
      } catch (e) { WH.error(e); }
    };
  });

  WH.views = WH.views || {};
  WH.views.users = (view) => {
    view.innerHTML = `
      <div class="toolbar">
        <div class="muted">Only the Owner can see this page.</div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="u-add">${WH.icon('plus')} Add user</button>
      </div>
      <div id="u-body"><div class="loading">Loading…</div></div>
      <div class="card" style="margin-top:18px">
        <div class="card-head"><h2>What each role can do</h2></div>
        ${Object.keys(WH.ROLES).map((r) => `<div class="method-row"><span>${WH.rolePill(r)}</span><span class="small" style="text-align:right">${h(WH.ROLES[r].about)}</span></div>`).join('')}
      </div>`;

    const load = async () => {
      let users;
      try { users = await WH.api('users'); } catch (e) { WH.error(e); return; }
      const body = view.querySelector('#u-body');
      body.innerHTML = `
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th>Last login</th></tr></thead>
          <tbody>${users.map((u, i) => `<tr class="clickable" data-i="${i}">
            <td><div class="row"><span class="avatar" style="width:34px;height:34px;font-size:.8rem">${h(WH.initials(u.full_name))}</span>
              <b>${h(u.full_name)}</b>${u.id === WH.state.user.id ? ' <span class="pill">You</span>' : ''}</div></td>
            <td>${h(u.username)}</td>
            <td>${WH.rolePill(u.role)}</td>
            <td>${u.active ? `<span class="pill ok">${WH.icon('check')} Active</span>` : '<span class="pill low">Disabled</span>'}</td>
            <td class="small">${u.last_login_at ? WH.fmtDateTime(u.last_login_at) : '<span class="muted">Never</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;
      body.querySelectorAll('[data-i]').forEach((tr) => tr.addEventListener('click', async () => {
        if (await editUser(users[Number(tr.dataset.i)])) load();
      }));
    };

    view.querySelector('#u-add').onclick = async () => { if (await editUser()) load(); };
    load();
    return { refresh: load };
  };
})(window.WH);
