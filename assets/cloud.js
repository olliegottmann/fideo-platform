/* Fideo Global — shared storage.

   The dashboard's data lives in one row of a Supabase table, so everyone sees
   the same thing from wherever they are. Reading is open to anyone with the
   link; writing needs a signed-in account that is on the editors list.

   If the database cannot be reached, the app falls back to the copy bundled in
   data/dashboard.js and says so, rather than showing nothing. */
(function (root) {
  'use strict';

  var CONFIG = {
    url: 'https://eewbwobwtjrowuldepyp.supabase.co',
    key: 'sb_publishable_cG3a-49TYzWaE7SDjV8K2A_RgwwS0vV',
    table: 'fideo_state',
    editors: 'fideo_editors',
    row: 1
  };

  var client = null;
  var state = {
    ready: false,
    online: false,
    canEdit: false,
    user: null,
    updatedAt: null,
    updatedBy: null,
    error: null
  };

  function sb() {
    if (client) return client;
    if (!root.supabase || !root.supabase.createClient) return null;
    client = root.supabase.createClient(CONFIG.url, CONFIG.key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return client;
  }

  /* Is this signed-in person allowed to write? The editors table answers it,
     and the database enforces it regardless of what the page believes. */
  function refreshPermission() {
    var c = sb();
    if (!c || !state.user) { state.canEdit = false; return Promise.resolve(false); }
    return c.from(CONFIG.editors).select('email').then(function (res) {
      var rows = (res && res.data) || [];
      var email = String(state.user.email || '').toLowerCase();
      state.canEdit = rows.some(function (r) { return String(r.email).toLowerCase() === email; });
      return state.canEdit;
    }, function () { state.canEdit = false; return false; });
  }

  function load() {
    var c = sb();
    if (!c) {
      state.error = 'The database library did not load.';
      return Promise.resolve(null);
    }
    return c.auth.getSession().then(function (s) {
      state.user = (s && s.data && s.data.session && s.data.session.user) || null;
      return refreshPermission();
    }).then(function () {
      return c.from(CONFIG.table).select('data, updated_at, updated_by').eq('id', CONFIG.row).maybeSingle();
    }).then(function (res) {
      state.ready = true;
      if (res && res.error) {
        state.online = false;
        state.error = res.error.message;
        return null;
      }
      state.online = true;
      state.error = null;
      if (!res || !res.data) return null;
      state.updatedAt = res.data.updated_at;
      state.updatedBy = res.data.updated_by;
      return res.data.data;
    }, function (err) {
      state.ready = true;
      state.online = false;
      state.error = (err && err.message) || 'Could not reach the database.';
      return null;
    });
  }

  /* Last write wins, but never silently: if the row moved since this page loaded,
     the caller is told so it can warn rather than overwrite someone's afternoon. */
  function save(data) {
    var c = sb();
    if (!c) return Promise.resolve({ ok: false, reason: 'offline' });
    if (!state.canEdit) return Promise.resolve({ ok: false, reason: 'not-an-editor' });

    return c.from(CONFIG.table).select('updated_at, updated_by').eq('id', CONFIG.row).maybeSingle()
      .then(function (res) {
        var remote = res && res.data ? res.data.updated_at : null;
        if (remote && state.updatedAt && remote !== state.updatedAt) {
          return { ok: false, reason: 'stale', updatedAt: remote, updatedBy: res.data.updated_by };
        }
        return c.from(CONFIG.table)
          .upsert({ id: CONFIG.row, data: data }, { onConflict: 'id' })
          .select('updated_at, updated_by').maybeSingle()
          .then(function (out) {
            if (out && out.error) return { ok: false, reason: 'error', message: out.error.message };
            if (out && out.data) {
              state.updatedAt = out.data.updated_at;
              state.updatedBy = out.data.updated_by;
            }
            return { ok: true, updatedAt: state.updatedAt, updatedBy: state.updatedBy };
          });
      }, function (err) {
        return { ok: false, reason: 'error', message: (err && err.message) || 'save failed' };
      });
  }

  function signIn(email, password) {
    var c = sb();
    if (!c) return Promise.resolve({ ok: false, message: 'The database library did not load.' });
    return c.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error) return { ok: false, message: res.error.message };
      state.user = res.data.user;
      return refreshPermission().then(function () {
        return { ok: true, canEdit: state.canEdit, email: state.user && state.user.email };
      });
    });
  }

  function signUp(email, password) {
    var c = sb();
    if (!c) return Promise.resolve({ ok: false, message: 'The database library did not load.' });
    return c.auth.signUp({ email: email, password: password }).then(function (res) {
      if (res.error) return { ok: false, message: res.error.message };
      state.user = res.data.user;
      return { ok: true, needsConfirmation: !res.data.session, email: email };
    });
  }

  function signOut() {
    var c = sb();
    if (!c) return Promise.resolve();
    return c.auth.signOut().then(function () {
      state.user = null;
      state.canEdit = false;
    });
  }

  root.FideoCloud = {
    config: CONFIG,
    state: state,
    load: load,
    save: save,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    refreshPermission: refreshPermission
  };
})(typeof self !== 'undefined' ? self : this);
