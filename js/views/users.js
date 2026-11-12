/* ==========================================================================
   views/users.js — User accounts (Owner / Admin only)
   --------------------------------------------------------------------------
   - List of every account: name, username, role, active/disabled, last login
   - Add a user, or click a row to edit: name, username, role, active,
     and reset the password (leave blank to keep it)
   - The server refuses changing your OWN role or disabling yourself, so the
     shop can never be locked out (see WashHubApi::saveUser)
   - Owner protection: only the ★ Shop Owner can add, change or delete another
     Owner / Admin. Other admins see those accounts read-only and can manage
     Staff only. Nobody can delete the Shop Owner. The Shop Owner can hand the
     ★ mark to another admin ("Make Shop Owner", asks for their password).
   - Login lockout: an Admin / Staff account is locked for 5 minutes after
     5 wrong passwords (never the Owner). It shows as "Locked" here, and the
     Owner (or an Admin, for Staff accounts) can press Unlock.
   - Names shown: "★ Owner", "Admin", "Staff". The Owner has the Admin role
     (same access) plus the Shop Owner extras.
   ========================================================================== */
(function (WH) {
  'use strict';
  const h = WH.h;

  /** Add (no user) or edit (user given) dialog. Resolves true when saved. */
  const editUser = (u = {}) => new Promise((resolve) => {
    let saved = false;
    const isMe = u.id && u.id === WH.state.user.id;
    const iAmOwner = !!WH.state.user.is_owner;
    // A non-owner admin may look at another admin's account but not change it (the server checks this too)
    const locked = u.id && !isMe && !iAmOwner && u.role === 'admin';
    const off = isMe || locked ? 'disabled' : '';
    // Non-owners can't pick "Admin" for a Staff account or a new account
    const adminOff = !iAmOwner && !isMe && !locked;
    // Locked by wrong passwords? Owner can unlock anyone; an Admin can unlock Staff accounts only
    const canUnlock = !!u.locked_until && (iAmOwner || u.role !== 'admin');
    const m = WH.modal({
      title: u.id ? `Edit ${u.full_name}` : 'Add user',
      body: `
        <div class="grid-2">
          ${locked ? `<p class="span-2 small owner-note">${u.is_owner ? '★ This is the <b>Owner</b>.' : 'This is an Admin account.'} Only the ★ Owner can change or delete it.</p>` : ''}
          ${u.locked_until ? `<p class="span-2 small owner-note">🔒 Locked after ${h(WH.LOGIN_MAX_TRIES)} wrong passwords until <b>${h(WH.fmtDateTime(u.locked_until))}</b>.${canUnlock ? ' Press <b>Unlock</b> to let them log in now, or set a new password.' : ' Only the ★ Owner can unlock an Admin account.'}</p>` : ''}
          <label class="field span-2">Full name *<input type="text" name="full_name" maxlength="100" value="${h(u.full_name)}" ${locked ? 'disabled' : ''}></label>
          <label class="field">Username *<input type="text" name="username" maxlength="50" autocomplete="off" value="${h(u.username)}" placeholder="e.g. maria or maria@email.com" ${locked ? 'disabled' : ''}></label>
          <label class="field">Role *
            <select name="role" ${off}>
              ${Object.keys(WH.ROLES).map((r) => `<option value="${r}" ${(u.role || 'staff') === r ? 'selected' : ''} ${r === 'admin' && adminOff ? 'disabled' : ''}>${r === 'admin' && u.is_owner ? '★ Owner (Admin access)' : WH.roleLabel(r)}${r === 'admin' && adminOff ? ' (Owner only)' : ''}</option>`).join('')}
            </select>
          </label>
          <p class="small muted span-2" data-role="about" style="margin:-4px 0 0"></p>
          <label class="field span-2">${u.id ? 'New password (leave blank to keep the current one)' : 'Password * (at least 6 characters)'}
            <input type="password" name="password" autocomplete="new-password" ${locked ? 'disabled' : ''}></label>
          <label class="row span-2" style="font-weight:600">
            <input type="checkbox" name="active" ${u.active === false ? '' : 'checked'} ${off} style="width:22px;height:22px">
            Account active (untick to block this person from logging in)
          </label>
          ${isMe ? '<p class="small muted span-2" style="margin:0">This is your own account: your role and status can\'t be changed here, so the shop is never left without an Admin.</p>' : ''}
        </div>`,
      foot: locked ? `${canUnlock ? `<button class="btn" data-act="unlock">🔓 Unlock</button>` : ''}<span class="spacer"></span><button class="btn" data-close>Close</button>` : `
        ${canUnlock ? '<button class="btn" data-act="unlock">🔓 Unlock</button>' : ''}
        ${u.id && !isMe && !u.is_owner ? `<button class="btn btn-danger" data-act="delete">${WH.icon('trash')} Delete account</button>` : ''}
        ${iAmOwner && u.id && !isMe && u.role === 'admin' && u.active ? '<button class="btn" data-act="owner">★ Make Shop Owner</button>' : ''}
        <span class="spacer"></span>
        <button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-act="save">${WH.icon('check')} Save</button>`,
      onClose: () => resolve(saved),
    });
    const role = m.el.querySelector('[name="role"]');
    const about = m.el.querySelector('[data-role="about"]');
    const showAbout = () => { about.textContent = `Can use: ${WH.ROLES[role.value].about}.`; };
    role.addEventListener('change', showAbout);
    showAbout();

    // Delete: asks first. The account goes to the Trash (soft delete) and can't log in; it can be restored.
    const del = m.el.querySelector('[data-act="delete"]');
    if (del) del.onclick = async () => {
      const ok = await WH.confirm(
        'Delete this account?',
        `<b>${h(u.full_name)}</b> (${h(u.username)}) will be removed and can no longer log in. Orders and payments are not affected.<br><br>
         ${WH.trashNote()}`,
        'Delete account'
      );
      if (!ok) return;
      try {
        await WH.api('user_delete', { id: u.id });
        saved = true;
        WH.toast(`${u.full_name}'s account was deleted`, 'success');
        m.close();
      } catch (e) { WH.error(e); }
    };

    // Unlock an account that was locked by wrong passwords (the server checks the owner rule too)
    const unlock = m.el.querySelector('[data-act="unlock"]');
    if (unlock) unlock.onclick = async () => {
      try {
        await WH.api('user_unlock', { id: u.id });
        saved = true;
        WH.toast(`${u.full_name} can log in again`, 'success');
        m.close();
      } catch (e) { WH.error(e); }
    };

    // Shop Owner only: hand the ★ Shop Owner mark to this admin. Asks for the owner's password first.
    const own = m.el.querySelector('[data-act="owner"]');
    if (own) own.onclick = () => {
      const p = WH.modal({
        title: `Make ${u.full_name} the Shop Owner?`,
        body: `<div class="stack">
          <p style="margin:0"><b>${h(u.full_name)}</b> will become the ★ Shop Owner. You will stay an Owner / Admin,
            but you will <b>lose</b> the Shop Owner powers (managing other admins, the Activity Log).
            ${h(u.full_name)} could then also change or remove your account.</p>
          <label class="field">Type <b>your</b> password to confirm<input type="password" name="password" autocomplete="current-password"></label>
        </div>`,
        foot: '<button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-act="go">★ Hand over ownership</button>',
      });
      p.el.querySelector('[data-act="go"]').onclick = async () => {
        try {
          await WH.api('owner_transfer', { id: u.id, password: WH.formData(p.el).password });
          WH.toast(`${u.full_name} is now the Shop Owner`, 'success');
          setTimeout(() => location.reload(), 900);
        } catch (e) { WH.error(e); }
      };
    };

    const saveBtn = m.el.querySelector('[data-act="save"]');
    if (saveBtn) saveBtn.onclick = async () => {
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
        <div class="muted">Only the Owner and Admin accounts can see this page.${WH.state.user.is_owner ? '' : ' Only the ★ Owner can add, change or delete Admin accounts.'}</div>
        <span class="spacer"></span>
        <button class="btn btn-primary" id="u-add">${WH.icon('plus')} Add user</button>
      </div>
      <div id="u-body"><div class="loading">Loading…</div></div>
      <div class="card" style="margin-top:18px">
        <div class="card-head"><h2>What each role can do</h2></div>
        <div class="method-row"><span class="pill owner">★ Owner</span><span class="small" style="text-align:right">The shop owner (one account). Same access as Admin, plus: only the Owner can add, change, delete or unlock Admin accounts, see the Activity Log and delete from the Trash forever. Nobody can delete the Owner, and the Owner is never locked out by wrong passwords.</span></div>
        ${Object.keys(WH.ROLES).map((r) => `<div class="method-row"><span>${WH.rolePill(r)}</span><span class="small" style="text-align:right">${h(WH.ROLES[r].about)}</span></div>`).join('')}
        <p class="small muted" style="margin:10px 0 0">🔒 After ${h(WH.LOGIN_MAX_TRIES)} wrong passwords in a row, an Admin or Staff account is locked for ${h(WH.LOGIN_LOCK_MINUTES)} minutes. Unlock it here, or set a new password.</p>
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
            <td>${WH.userRolePill(u)}</td>
            <td>${!u.active ? '<span class="pill low">Disabled</span>'
              : u.locked_until ? `<span class="pill overdue" title="Locked until ${h(WH.fmtDateTime(u.locked_until))}">🔒 Locked</span>`
              : `<span class="pill ok">${WH.icon('check')} Active</span>`}</td>
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
