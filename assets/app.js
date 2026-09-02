/* Fideo Global — company dashboard.
   Reads data/dashboard.js (window.FIDEO_DATA), renders every view, and hosts
   the spreadsheet importer. No build step, no framework. */
(function () {
  'use strict';

  var PREVIEW_KEY = 'fideo.preview.v1';
  var TODAY = new Date();
  var NOW_KEY = TODAY.getFullYear() * 100 + (TODAY.getMonth() + 1);
  var RAMP = ['#EDE3F8', '#D8C0F0', '#B78CE4', '#8E4FD1', '#560BAD', '#3B0879'];
  var GLYPH = { done: '✓', active: '▶', pending: '○', none: '·' };

  var state = {
    data: null,
    isPreview: false,
    route: 'overview',
    pending: null,          // dataset staged by the importer
    pendingDiff: [],
    pendingTargets: [],
    showSignIn: false,
    signInMessage: null,
    saveError: null,
    saving: false,
    filters: {},
    sort: { pipeline: { key: 'stageNum', dir: -1 } }
  };

  /* ---------- small helpers ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    return '€' + Math.round(n).toLocaleString('en-IE');
  }
  function moneyShort(n) {
    if (n == null || n === 0) return n === 0 ? '€0' : '—';
    if (n >= 1000000) return '€' + (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'm';
    if (n >= 1000) return '€' + Math.round(n / 1000) + 'k';
    return '€' + n;
  }
  function monthIdx(key) { return key ? Math.floor(key / 100) * 12 + (key % 100) : null; }
  function monthsFromNow(key) {
    var a = monthIdx(key), b = monthIdx(NOW_KEY);
    return a == null ? null : a - b;
  }
  function isOverdue(key) { var d = monthsFromNow(key); return d != null && d < 0; }
  function pct(n) { return Math.max(0, Math.min(100, n)) + '%'; }
  function uniq(list) { return list.filter(function (v, i, a) { return v && a.indexOf(v) === i; }); }
  function dateLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function chip(kind, label, glyph) {
    if (!label) return '';
    return '<span class="chip ' + kind + '">' + (glyph ? '<span class="glyph" aria-hidden="true">' + glyph + '</span>' : '') + esc(label) + '</span>';
  }
  /* Sort order (0 = first) and urgency weight. Written as explicit lookups because
     `weights[p] || fallback` silently swallows a legitimate 0. */
  function priorityRank(p) {
    var m = { HIGH: 0, MEDIUM: 1, LOW: 2, MONITOR: 2, UNSET: 3, DEAD: 4 };
    var k = String(p || '').toUpperCase();
    return k in m ? m[k] : 3;
  }
  function priorityUrgency(p) {
    var m = { HIGH: 3, MEDIUM: 2, LOW: 1, MONITOR: 1, UNSET: 1, DEAD: 0 };
    var k = String(p || '').toUpperCase();
    return k in m ? m[k] : 1;
  }
  function priorityChip(p) {
    var t = String(p || '').toUpperCase();
    if (!t || t === 'UNSET') return '';
    var kind = 'ghost';
    if (t === 'HIGH') kind = 'brand';
    else if (t === 'MEDIUM') kind = 'amber';
    else if (t === 'DEAD') kind = 'risk';
    else if (t === 'MONITOR') kind = 'wait';
    return chip(kind, t.charAt(0) + t.slice(1).toLowerCase());
  }
  function targetChip(label, key, provisional) {
    if (!label) return chip('wait', 'No target date');
    var kind = 'ghost', glyph = '';
    if (isOverdue(key)) { kind = 'risk'; glyph = '!'; }
    else if (monthsFromNow(key) !== null && monthsFromNow(key) <= 2) { kind = 'amber'; }
    return chip(kind, label + (provisional ? ' (provisional)' : ''), glyph);
  }
  function flagChips(flags) {
    return (flags || []).map(function (f) { return chip('wait', f); }).join('');
  }
  function progressBar(percent, text) {
    return '<div class="progress"><span class="progress-track"><span class="progress-fill" style="width:' + pct(percent) + '"></span></span>' +
      '<span class="progress-text">' + esc(text) + '</span></div>';
  }
  function stepStrip(steps, wide) {
    return '<div class="steps' + (wide ? ' wide' : '') + '">' + steps.map(function (s, i) {
      var tip = (i + 1) + '. ' + s.name + ' — ' + (s.label || 'not started');
      return '<span class="step ' + s.key + '" data-tip="' + esc(tip) + '">' +
        (wide ? esc(s.name) : (i + 1)) + '</span>';
    }).join('') + '</div>';
  }
  function stepLegend(full) {
    var rows = [
      ['done', 'Complete', 'the stage is finished'],
      ['active', 'In progress', 'someone is working on it now'],
      ['pending', 'To be confirmed', 'planned, not started, no date agreed'],
      ['none', 'Not started', 'blank on the tracker, or not applicable'],
      ['overdue', 'Past its date', 'the date has gone by and the stage is not complete']
    ];
    return '<div class="legend colour-key">' +
      rows.map(function (r) {
        return '<span><i class="key-swatch ' + r[0] + '"></i><b>' + r[1] + '</b>' +
          (full ? ' \u2014 ' + r[2] : '') + '</span>';
      }).join('') +
      (full ? '<span><i class="key-swatch suggested"></i><b>Dashed</b> \u2014 a suggested date or owner, ' +
        'not yet agreed by anyone</span>' : '') +
      '</div>';
  }

  /* ---------- data ---------- */
  function loadData() {
    var base = window.FIDEO_DATA || (window.FideoParse ? window.FideoParse.emptyDataset() : null);
    var preview = null;
    try {
      var raw = localStorage.getItem(PREVIEW_KEY);
      if (raw) preview = JSON.parse(raw);
    } catch (err) { preview = null; }
    if (preview && preview.meta) {
      state.data = preview;
      state.isPreview = true;
    } else {
      state.data = base;
      state.isPreview = false;
    }
    if (!state.data) state.data = { meta: {}, pipeline: { deals: [] }, courses: { items: [], stageNames: [] }, projects: { items: [] }, dealPlans: { items: [] }, updates: [] };
    state.data.updates = state.data.updates || [];
  }
  function savePreview(data) {
    data.meta = data.meta || {};
    data.meta.locallyEditedAt = new Date().toISOString();
    try {
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(data));
    } catch (err) {
      alert('Could not save the preview locally (browser storage full). You can still download the data file.');
    }
    state.data = data;
    state.isPreview = true;
    pushToCloud(data);
  }
  function clearPreview() {
    localStorage.removeItem(PREVIEW_KEY);
    loadData();
  }

  /* ---------- shared storage ----------
     state.data comes from the database when it can be reached, so everyone sees
     the same dashboard. Edits by a signed-in editor go straight back to it.
     Without a sign-in, edits stay on the device exactly as before, and the
     banner keeps saying so. */
  function cloud() { return window.FideoCloud || null; }
  function cloudOnline() { var c = cloud(); return !!(c && c.state.online); }
  function canEditShared() { var c = cloud(); return !!(c && c.state.canEdit); }

  function pushToCloud(data) {
    var c = cloud();
    if (!c || !canEditShared()) return;
    state.saving = true;
    c.save(data).then(function (res) {
      state.saving = false;
      if (res.ok) {
        if (res.updatedAt) state.savedAt = res.updatedAt;
        state.saveError = null;
        state.isPreview = false;
        try { localStorage.removeItem(PREVIEW_KEY); } catch (err) { /* ignore */ }
      } else if (res.reason === 'stale') {
        state.saveError = (res.updatedBy ? res.updatedBy : 'Somebody else') +
          ' saved a change while this page was open, so this edit was not sent — ' +
          'reloading will show their version, and you can redo yours on top.';
      } else if (res.reason === 'not-an-editor') {
        state.saveError = 'You are signed in but not on the editors list, so this stayed on your device.';
      } else {
        state.saveError = res.message || 'Could not save to the shared database — kept on this device.';
      }
      renderChrome();
      if (state.saveError) render();
    });
  }

  function saveChip() {
    if (!cloudOnline() || !canEditShared()) return '';
    if (state.saving) return '<span class="chip amber"><span class="glyph">&#9679;</span>Saving…</span>';
    if (state.saveError) return '<span class="chip risk"><span class="glyph">!</span>Not saved</span>';
    if (state.savedAt) return '<span class="chip done"><span class="glyph">&#10003;</span>Saved ' +
      esc(new Date(state.savedAt).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' })) + '</span>';
    return '';
  }

  function signInPanel() {
    var c = cloud();
    if (!c) return '';
    var s = c.state;
    if (!s.ready) return '<span class="chip ghost">Connecting…</span>';
    if (!s.online) {
      return '<span class="chip risk" data-tip="' + esc(s.error || '') +
        '">Offline — showing the last published copy</span>';
    }
    if (!s.user) {
      return '<button class="btn" id="openSignIn">Sign in to edit</button>';
    }
    return '<span class="chip ' + (s.canEdit ? 'done' : 'risk') + '" data-tip="' +
      esc(s.canEdit ? 'On the editors list' : 'Signed in, but not on the editors list — see the Access page') + '">' +
      esc(s.user.email) + (s.canEdit ? ' · can edit' : ' · read only') + '</span>' +
      '<button class="btn btn-sm" id="signOut">Sign out</button>';
  }

  function signInDialog() {
    if (!state.showSignIn) return '';
    return '<div class="banner info" id="signInBox"><span aria-hidden="true">🔑</span><div style="flex:1">' +
      '<b>Sign in to edit the shared dashboard</b>' +
      '<div class="filters" style="margin:10px 0 0">' +
      '<input type="email" id="siEmail" placeholder="you@fideo-global.com" style="min-width:230px">' +
      '<input type="password" id="siPass" placeholder="password" style="min-width:170px">' +
      '<button class="btn primary" id="doSignIn">Sign in</button>' +
      '<button class="btn" id="doSignUp">Create account</button>' +
      '<button class="btn" id="forgotPass">Forgot password</button>' +
      '<button class="btn" id="cancelSignIn">Cancel</button>' +
      '</div>' +
      (state.signInMessage ? '<p class="hint" style="margin-top:9px">' + esc(state.signInMessage) + '</p>' : '') +
      '<p class="hint" style="margin-top:9px">Anyone can read this dashboard without signing in. ' +
      'Only people on the editors list can change it — ask Oliver to add your address.</p>' +
      '</div></div>';
  }

  function recoveryPanel() {
    var c = cloud();
    if (!c || !c.state.recovery) return '';
    return '<div class="banner info"><span aria-hidden="true">&#128273;</span><div style="flex:1">' +
      '<b>Set a new password</b>' +
      '<div class="filters" style="margin:10px 0 0">' +
      '<input type="password" id="newPass" placeholder="new password, at least 6 characters" style="min-width:280px">' +
      '<button class="btn primary" id="saveNewPass">Save password</button>' +
      '</div>' +
      (state.recoveryMessage ? '<p class="hint" style="margin-top:9px">' + esc(state.recoveryMessage) + '</p>' : '') +
      '<p class="hint" style="margin-top:9px">This is the same account you use for the Model Room, so the new ' +
      'password applies there too.</p></div></div>';
  }

  function cloudBanner() {
    var c = cloud();
    if (!c || !c.state.ready) return '';
    if (state.sharedSeeded && !state.saveError && cloudOnline()) {
      return '<div class="banner info"><span aria-hidden="true">✓</span><div>' +
        '<b>This view is now the shared copy.</b> The database was empty, so what you were looking at ' +
        'has been saved as the version everyone sees.</div></div>';
    }
    if (state.saveError) {
      return '<div class="banner"><span aria-hidden="true">⚠</span><div>' + esc(state.saveError) +
        ' <button class="btn btn-sm" id="reloadShared">Reload the shared copy</button></div></div>';
    }
    if (!c.state.online) {
      return '<div class="banner"><span aria-hidden="true">⚠</span><div>' +
        '<b>Not connected to the shared database.</b> You are looking at the copy published with the site' +
        (c.state.error ? ' (' + esc(c.state.error) + ')' : '') + '. Anything you change stays on this device.</div></div>';
    }
    return '';
  }

  /* ---------- edits ----------
     The spreadsheets are the base layer; anything edited here is stored
     separately, keyed by client or course name, so the next upload refreshes the
     sheet data without wiping what people have changed on the platform. An edited
     field wins over the sheet, and says so on screen. */
  function ovr(kind) {
    return (state.data.overrides && state.data.overrides[kind]) || {};
  }
  function setOvr(kind, key, patch) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.overrides = data.overrides || {};
    data.overrides[kind] = data.overrides[kind] || {};
    var existing = data.overrides[kind][key] || {};
    Object.keys(patch).forEach(function (k) { existing[k] = patch[k]; });
    existing.editedAt = new Date().toISOString().slice(0, 10);
    data.overrides[kind][key] = existing;
    savePreview(data);
  }
  function clearOvrField(kind, key, field) {
    var data = JSON.parse(JSON.stringify(state.data));
    if (data.overrides && data.overrides[kind] && data.overrides[kind][key]) {
      delete data.overrides[kind][key][field];
      savePreview(data);
    }
  }
  function reFlag(notes, fallback) {
    return window.FideoParse && window.FideoParse.flagsFor ? window.FideoParse.flagsFor(notes) : (fallback || []);
  }
  function applyTarget(out, label) {
    out.target = label;
    var t = window.FideoParse ? window.FideoParse.parseTarget(label) : { sortKey: null, provisional: false };
    out.targetSort = t.sortKey;
    out.provisional = t.provisional;
  }
  function copyOf(obj) {
    var out = {};
    Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
    return out;
  }

  function allDeals() {
    var raw = (state.data.pipeline && state.data.pipeline.deals) || [];
    var edits = ovr('deals');
    return raw.map(function (d) {
      var e = edits[d.client];
      if (!e) return d;
      var out = copyOf(d);
      out.edited = [];
      if (e.priority) { out.priority = e.priority; out.edited.push('priority'); }
      if (e.step) { out.step = e.step; out.edited.push('step'); }
      if (e.notes != null) { out.notes = e.notes; out.flags = reFlag(e.notes, d.flags); out.edited.push('notes'); }
      if (e.target != null) { applyTarget(out, e.target); out.edited.push('target'); }
      if (e.archived) out.archived = true;
      out.editedAt = e.editedAt;
      return out;
    });
  }
  function deals() { return allDeals().filter(function (d) { return !d.archived; }); }
  function archivedDeals() { return allDeals().filter(function (d) { return d.archived; }); }

  /* The four states a build stage can be in, and how each one reads. */
  var STAGE_STATUSES = [
    { value: 'done', label: 'Complete', glyph: '✓' },
    { value: 'active', label: 'In progress', glyph: '▶' },
    { value: 'pending', label: 'To be confirmed', glyph: '○' },
    { value: 'none', label: 'Not started', glyph: '·' }
  ];
  function statusLabel(key) {
    var s = STAGE_STATUSES.filter(function (x) { return x.value === key; })[0];
    return s ? s.label : '';
  }

  /* Recalculate everything that hangs off the ten stage statuses, using the same
     rules the spreadsheet parser uses, so a stage ticked complete here counts
     exactly as one ticked complete in the tracker. */
  function recomputeStages(out) {
    var done = 0, active = 0;
    out.steps.forEach(function (s) {
      if (s.key === 'done') done++;
      if (s.key === 'active') active++;
    });
    out.stagesDone = done;
    out.stagesActive = active;
    out.stageCount = out.steps.length;
    out.progress = out.steps.length ? Math.round((done / out.steps.length) * 100) : 0;

    var current = null, i;
    for (i = 0; i < out.steps.length; i++) {
      if (out.steps[i].key === 'active') { current = 'In progress: ' + out.steps[i].name; break; }
    }
    if (!current && done > 0 && done === out.steps.length) current = 'All stages complete';
    if (!current && out.steps.every(function (s) { return s.key === 'none'; })) current = 'Not started';
    if (!current) {
      for (i = 0; i < out.steps.length; i++) {
        if (out.steps[i].key !== 'done') { current = 'Next up: ' + out.steps[i].name; break; }
      }
    }
    out.currentStage = current || 'Not started';
    return out;
  }

  function allCourses() {
    var raw = (state.data.courses && state.data.courses.items) || [];
    var edits = ovr('courses');
    var stagePlans = state.data.stagePlans || {};
    return raw.map(function (c) {
      var e = edits[c.name];
      var sp = stagePlans[c.name];
      var statusEdits = [];
      if (sp) {
        Object.keys(sp).forEach(function (k) { if (sp[k] && sp[k].status) statusEdits.push(k); });
      }
      if (!e && !statusEdits.length) return c;

      var out = copyOf(c);
      out.edited = [];
      if (e) {
        if (e.priority) { out.priority = e.priority; out.edited.push('priority'); }
        if (e.notes != null) { out.notes = e.notes; out.flags = reFlag(e.notes, c.flags); out.edited.push('notes'); }
        if (e.owner != null) { out.owner = e.owner; out.edited.push('owner'); }
        if (e.target != null) { applyTarget(out, e.target); out.edited.push('target'); }
        if (e.archived) out.archived = true;
        out.editedAt = e.editedAt;
      }
      if (statusEdits.length) {
        out.steps = c.steps.map(function (st, i) {
          var o = sp[i];
          if (!o || !o.status) return st;
          return { name: st.name, key: o.status, label: statusLabel(o.status), fromPlatform: true };
        });
        recomputeStages(out);
        out.edited.push(statusEdits.length + (statusEdits.length === 1 ? ' stage status' : ' stage statuses'));
      }
      return out;
    });
  }
  function courses() { return allCourses().filter(function (c) { return !c.archived; }); }
  function archivedCourses() { return allCourses().filter(function (c) { return c.archived; }); }

  /* Manual ordering of the sales priority list. Empty until somebody drags
     something out of the computed order, at which point every client gets an
     explicit position so later moves are stable. */
  function dealOrder() { return (state.data.overrides && state.data.overrides.dealOrder) || {}; }
  function isHigh(x) { return String(x && x.priority).toUpperCase() === 'HIGH'; }
  function rankedClientNames() {
    return salesRanking(deals().filter(isHigh)).map(function (r) { return r.deal.client; });
  }
  function persistOrder(names) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.overrides = data.overrides || {};
    data.overrides.dealOrder = {};
    names.forEach(function (n, idx) { data.overrides.dealOrder[n] = idx; });
    savePreview(data);
  }
  function moveDeal(client, direction) {
    var names = rankedClientNames();
    var i = names.indexOf(client);
    var j = i + direction;
    if (i < 0 || j < 0 || j >= names.length) return;
    names.splice(j, 0, names.splice(i, 1)[0]);
    persistOrder(names);
  }
  function courseOrder() { return (state.data.overrides && state.data.overrides.courseOrder) || {}; }
  function rankedCourseNames() {
    return buildRanking(courses().filter(function (c) { return c.name && c.progress < 100 && isHigh(c); }), liveDeals())
      .map(function (r) { return r.course.name; });
  }
  function persistCourseOrder(names) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.overrides = data.overrides || {};
    data.overrides.courseOrder = {};
    names.forEach(function (n, idx) { data.overrides.courseOrder[n] = idx; });
    savePreview(data);
  }
  function moveCourse(name, direction) {
    var names = rankedCourseNames();
    var i = names.indexOf(name);
    var j = i + direction;
    if (i < 0 || j < 0 || j >= names.length) return;
    names.splice(j, 0, names.splice(i, 1)[0]);
    persistCourseOrder(names);
  }
  function dropCourseBefore(dragged, target, after) {
    if (!dragged || dragged === target) return;
    var names = rankedCourseNames();
    var from = names.indexOf(dragged);
    if (from < 0) return;
    names.splice(from, 1);
    var at = names.indexOf(target);
    if (at < 0) return;
    names.splice(at + (after ? 1 : 0), 0, dragged);
    persistCourseOrder(names);
  }

  /* Dropping one client onto another. Worked out against the full ranked list,
     not just the rows on screen, so reordering the visible top eight cannot
     scramble the order of everyone below them. */
  function dropDealBefore(dragged, target, after) {
    if (!dragged || dragged === target) return;
    var names = rankedClientNames();
    var from = names.indexOf(dragged);
    if (from < 0) return;
    names.splice(from, 1);
    var at = names.indexOf(target);
    if (at < 0) return;
    names.splice(at + (after ? 1 : 0), 0, dragged);
    persistOrder(names);
  }

  var EDIT_PRIORITIES = ['High', 'Medium', 'Low', 'Monitor', 'Dead'];

  /* The editor that hangs under a client row on the sales pipeline. */
  function dealEditor(d) {
    var open = state.filters.editingDeal === d.client;
    if (!open) return '';
    var stepOptions = PROCESS.filter(function (p) { return !p.gate; }).map(function (p) {
      return '<option value="' + p.id + '"' + (currentStepOf(d) === p.id ? ' selected' : '') + '>' +
        esc(p.id + '. ' + p.name) + '</option>';
    }).join('');
    return '<tr class="editor-row"><td colspan="6"><div class="editor">' +
      '<div class="editor-grid">' +
      '<label>Step on the process<select class="ed-step" data-client="' + esc(d.client) + '">' + stepOptions + '</select></label>' +
      '<label>Priority<select class="ed-priority" data-client="' + esc(d.client) + '">' +
      EDIT_PRIORITIES.map(function (p) {
        return '<option' + (String(d.priority).toLowerCase() === p.toLowerCase() ? ' selected' : '') + '>' + p + '</option>';
      }).join('') + '</select></label>' +
      '<label>Target go-live<input type="text" class="ed-target" data-client="' + esc(d.client) + '" value="' +
      esc(d.target || '') + '" placeholder="e.g. Q4 2026"></label>' +
      '</div>' +
      '<label class="editor-notes">Next action / notes<textarea class="ed-notes" data-client="' + esc(d.client) + '">' +
      esc(d.notes || '') + '</textarea></label>' +
      '<div class="editor-actions">' +
      '<button class="btn" data-close-editor="1">Done</button>' +
      '<button class="btn" data-archive-deal="' + esc(d.client) + '">Archive this client</button>' +
      (d.edited && d.edited.length ? '<span class="hint">Edited here: ' + esc(d.edited.join(', ')) +
        (d.editedAt ? ' · ' + esc(dateLabel(d.editedAt)) : '') + '</span>' : '') +
      '</div></div></td></tr>';
  }

  function currentStepOf(d) {
    return d.step || STAGE_TO_STEP[d.stageNum] || '1';
  }
  function projects() { return (state.data.projects && state.data.projects.items) || []; }
  function plans() { return (state.data.dealPlans && state.data.dealPlans.items) || []; }

  function quantified(list) {
    return list.reduce(function (a, d) { return a + (d.revenue || 0); }, 0);
  }
  function liveDeals() {
    return deals().filter(function (d) { return String(d.priority).toLowerCase() !== 'dead'; });
  }
  function coursesInBuild() {
    return courses().filter(function (c) { return c.stagesActive > 0 || (c.stagesDone > 0 && c.stagesDone < c.stageCount); });
  }
  function funnelByStage(list) {
    var map = {};
    list.forEach(function (d) {
      var k = d.stageNum || 0;
      if (!map[k]) map[k] = { stageNum: k, name: d.stage || 'Unstaged', count: 0, revenue: 0, clients: [] };
      map[k].count++;
      map[k].revenue += d.revenue || 0;
      map[k].clients.push(d.client);
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.stageNum - b.stageNum; });
  }
  function byVertical(list) {
    var map = {};
    list.forEach(function (d) {
      var k = d.vertical || 'Unassigned';
      if (!map[k]) map[k] = { name: k, count: 0, revenue: 0 };
      map[k].count++;
      map[k].revenue += d.revenue || 0;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue || b.count - a.count; });
  }

  /* Everything that looks like it needs a human this week. */
  function attentionItems() {
    var out = [];

    courses().forEach(function (c) {
      if (!c.name) return;
      var why = c.flags.slice();
      if (isOverdue(c.targetSort) && c.progress < 100) why.unshift('Go-live target passed (' + c.target + ')');
      if (!why.length) return;
      out.push({
        source: 'Course build', route: '#/courses', title: c.name, why: why,
        side: c.stagesDone + '/' + c.stageCount + ' stages',
        weight: (isOverdue(c.targetSort) ? 10 : 0) + priorityUrgency(c.priority) * 2, key: c.targetSort
      });
    });

    liveDeals().forEach(function (d) {
      var why = d.flags.slice();
      if (isOverdue(d.targetSort)) why.unshift('Target go-live passed (' + d.target + ')');
      if (d.stageNum >= 3 && d.revenue == null) why.push('No revenue figure recorded');
      if (!why.length) return;
      out.push({
        source: 'Pipeline', route: '#/pipeline', title: d.client, why: why,
        side: d.stageLabel || d.stage,
        weight: (isOverdue(d.targetSort) ? 8 : 0) + priorityUrgency(d.priority) * 2 + (d.stageNum || 0), key: d.targetSort
      });
    });

    projects().forEach(function (p) {
      if (!p.name) return;
      var why = [];
      if (!p.lead) why.push('No lead assigned');
      if (!p.nextStep) why.push('No next step agreed');
      why = why.concat(p.flags || []);
      if (!why.length) return;
      out.push({
        source: 'Project', route: '#/projects', title: p.name, why: why,
        side: p.status, weight: (p.status === 'In Progress' ? 5 : 2), key: p.targetSort
      });
    });

    return out.sort(function (a, b) { return b.weight - a.weight || (a.key || 999999) - (b.key || 999999); });
  }

  function upcoming() {
    var out = [];
    courses().forEach(function (c) {
      if (!c.targetSort || !c.name || c.progress === 100) return;
      out.push({ title: c.name, sub: 'Course go-live · ' + c.currentStage, key: c.targetSort, label: c.target, provisional: c.provisional, route: '#/courses' });
    });
    liveDeals().forEach(function (d) {
      if (!d.targetSort) return;
      out.push({ title: d.client, sub: 'Deal · ' + (d.stageLabel || d.stage), key: d.targetSort, label: d.target, route: '#/pipeline' });
    });
    projects().forEach(function (p) {
      if (!p.targetSort) return;
      out.push({ title: p.name, sub: 'Project · ' + p.status, key: p.targetSort, label: p.target, route: '#/projects' });
    });
    return out.sort(function (a, b) { return a.key - b.key; });
  }

  /* ---------- the Fideo sales & programme development process ----------
     The twelve boxes from the process diagram: ten numbered steps plus the two
     gates. The trackers only record a six-stage pipeline, so each deal is placed
     on the step its tracker stage implies — see STAGE_TO_STEP. That mapping is
     an interpretation, not something the spreadsheet states; it is shown on the
     page so anyone can challenge it. */
  /* Roles exactly as the process diagram's ownership key defines them. */
  var ROLES = [
    ['ALL', 'Team', 'Opportunity spotting, introductions and referrals.'],
    ['AQ', 'Course Director', 'Discovery, training needs analysis, learning objectives, solution design and programme oversight.'],
    ['OG', 'Business Development', 'Qualification, commercial discussions, relationship management, proposal approval and contracting.'],
    ['TG', 'Operational Support', 'Process governance, proposal coordination, commercial documentation and mobilisation support.'],
    ['OM', 'Digital Learning Specialist', 'Course build, LMS configuration, learner experience design and programme implementation.'],
    ['JM', 'Project Coordinator', 'Makes sure information is shared, actions are tracked and people have what they need to progress work.'],
    ['BI', 'Learning Support', 'Learning administration and implementation support to the Course Director and Digital Learning Specialist.']
  ];
  function roleName(initials) {
    var found = ROLES.filter(function (r) { return r[0] === String(initials).toUpperCase().trim(); })[0];
    return found ? found[1] : '';
  }
  /* "AQ/OM" -> "AQ — Course Director · OM — Digital Learning Specialist" */
  function expandInitials(s) {
    var parts = String(s || '').split(/[\/,]| and /).map(function (p) { return p.trim(); }).filter(Boolean);
    var out = parts.map(function (p) {
      var name = roleName(p);
      return name ? p + ' — ' + name : p;
    });
    return out.join(' · ');
  }

  var PROCESS = [
    { id: '1', name: 'Initial Engagement', detail: 'Opportunity spotting, introductions and referrals.', lead: 'ALL' },
    { id: '2', name: 'Qualification', detail: 'Validate the opportunity and confirm potential fit and priorities.', lead: 'OG' },
    { id: '3', name: 'Discovery & Training Needs Analysis', detail: 'Understand the client environment, needs and capability gaps.', lead: 'AQ' },
    { id: '4', name: 'Discovery Summary', detail: 'Summarise findings, learning objectives and indicative approaches, as a high-level proposal.', lead: 'AQ' },
    { id: 'G1', name: 'Gate 1: Commercial Alignment', detail: 'Checkpoint — agreement to progress to commercial discussions.', lead: 'OG', gate: true },
    { id: '5', name: 'Commercial Scoping & Budget', detail: 'Agree scope, budget parameters, timelines and delivery preferences.', lead: 'OG' },
    { id: '6', name: 'Solution Design', detail: 'Design the detailed solution, aligned to the agreed commercial parameters.', lead: 'AQ' },
    { id: 'G2', name: 'Gate 2: Delivery Readiness', detail: 'Checkpoint — internal approval to proceed to proposal and delivery planning.', lead: 'OG', gate: true },
    { id: '7', name: 'Final Proposal & Contracting', detail: 'Final proposal, commercial agreement and signed contract.', lead: 'OG' },
    { id: '8', name: 'Programme Build & Setup', detail: 'Build and configure the programme and prepare for launch.', lead: 'AQ' },
    { id: '9', name: 'Programme Delivery', detail: 'Deliver the programme and provide ongoing learner support.', lead: 'AQ' },
    { id: '10', name: 'Review & Future Opportunities', detail: 'Review performance, share insights and identify future opportunities.', lead: 'AQ, OG' }
  ];
  /* tracker pipeline stage -> process step */
  var STAGE_TO_STEP = { 1: '1', 2: '3', 3: '5', 4: '7', 5: '8', 6: '9' };

  function processGroups(list) {
    var byStep = {};
    PROCESS.forEach(function (p) { byStep[p.id] = []; });
    list.forEach(function (d) {
      var id = currentStepOf(d);
      if (id && byStep[id]) byStep[id].push(d);
    });
    return PROCESS.map(function (p) { return { step: p, deals: byStep[p.id] }; });
  }

  function processCard(list) {
    var groups = processGroups(list);
    var open = state.filters.overviewStep;
    var tracked = {};
    Object.keys(STAGE_TO_STEP).forEach(function (k) { tracked[STAGE_TO_STEP[k]] = true; });

    var boxes = groups.map(function (g) {
      var n = g.deals.length;
      var isTracked = !!tracked[g.step.id] || n > 0;
      var tip = g.step.detail + ' Led by ' + expandInitials(g.step.lead) + '.' +
        (isTracked ? '' : ' The tracker does not record this step, so no client can be counted here.');
      return '<button class="pstep' + (g.step.gate ? ' gate' : '') + (open === g.step.id ? ' open' : '') +
        (isTracked ? (n ? '' : ' vacant') : ' untracked') + '" data-step="' + g.step.id + '" data-tip="' + esc(tip) + '"' +
        ' aria-expanded="' + (open === g.step.id) + '">' +
        '<span class="pstep-n">' + esc(g.step.id) + '</span>' +
        '<span class="pstep-name">' + esc(g.step.name.replace(/^Gate \d: /, '')) + '</span>' +
        '<span class="pstep-count">' + (isTracked ? n : '–') + '</span>' +
        '</button>';
    }).join('<span class="pstep-arrow" aria-hidden="true">›</span>');

    var panel = '';
    if (open) {
      var g = groups.filter(function (x) { return x.step.id === open; })[0];
      if (g) {
        panel = '<div class="pstep-panel"><div class="card-head"><h3>' +
          (g.step.gate ? 'Gate — ' : g.step.id + '. ') + esc(g.step.name) + '</h3>' +
          '<span class="hint">' + esc(g.step.detail) + ' · Lead: ' + esc(g.step.lead) + '</span></div>' +
          (g.deals.length
            ? '<div class="list">' + g.deals.map(function (d) {
              return '<div class="list-row"><div class="lr-main">' +
                '<a class="lr-title" href="#/pipeline">' + esc(d.client) + '</a>' +
                '<div class="lr-sub">' + esc(d.vertical) + (d.notes ? ' — ' + esc(d.notes) : '') + '</div></div>' +
                '<div class="lr-side">' + priorityChip(d.priority) + ' ' + targetChip(d.target, d.targetSort) + '</div></div>';
            }).join('') + '</div>'
            : '<p class="empty">No clients sitting at this step.</p>') +
          '</div>';
      }
    }

    return '<section class="card"><div class="card-head"><h2>Sales &amp; programme development process</h2>' +
      '<span class="hint">click a step to see which clients are there</span></div>' +
      '<div class="process">' + boxes + '</div>' + panel +
      '<div class="legend" style="margin-top:14px">' +
      '<span><i style="background:var(--p1)"></i>Numbered step</span>' +
      '<span><i style="background:var(--amber)"></i>Gate — a checkpoint that must be passed</span>' +
      '<span><i style="background:repeating-linear-gradient(45deg,#fff,#fff 3px,#EFECF1 3px,#EFECF1 6px)"></i>Shows “–” because the tracker does not record this step</span>' +
      '</div>' +
      '<p class="hint" style="margin-top:10px">The pipeline tracker records six stages, this process has twelve boxes. ' +
      'Clients are placed by their tracker stage: Lead&nbsp;→&nbsp;1, Scoping&nbsp;→&nbsp;3, Proposal&nbsp;→&nbsp;5, ' +
      'Contracting&nbsp;→&nbsp;7, Contracted&nbsp;→&nbsp;8, Live&nbsp;→&nbsp;9. The remaining boxes show “–” rather than zero, ' +
      'because nothing in the spreadsheet says who is sitting at them. Add a step column to the tracker and they fill in.</p>' +
      '</section>';
  }

  /* ---------- prioritisation ----------
     Two rules, set by the directors. Both are computed here and shown with their
     reasoning so anyone can see why something ranks where it does.

     SALES: highest revenue potential and closest to deal completion ranks first.
     BUILD: 1 active clients with a signed mandate, 2 high-priority new clients
            per the sales pipeline, 3 what ECI want, 4 what we think the market
            wants. Never deviate without director agreement. */
  var PRIORITY_RULE_SALES = 'Highest revenue potential and closest to deal completion ranks first.';
  var PRIORITY_RULE_BUILD = 'Signed mandates first, then high-priority new clients, then ECI, then market-led. Never deviate without director agreement.';

  function salesRanking(list) {
    var revenues = list.map(function (d) { return d.revenue || 0; });
    var maxRev = Math.max.apply(null, revenues.concat([1]));
    var logMax = Math.log10(1 + maxRev);
    return list.map(function (d) {
      /* completion: stage 6 of 6 is as close as it gets. revenue: log-scaled so
         one very large deal cannot flatten everything below it. */
      var completion = (d.stageNum || 0) / 6;
      var revScore = d.revenue ? Math.log10(1 + d.revenue) / logMax : 0;
      return {
        deal: d,
        score: (completion * 0.5) + (revScore * 0.5),
        completion: completion,
        revScore: revScore,
        unvalued: d.revenue == null
      };
    }).sort(function (a, b) {
      var order = dealOrder();
      var manual = Object.keys(order).length > 0;
      if (manual) {
        var ai = order[a.deal.client], bi = order[b.deal.client];
        if (ai == null) ai = 9999;
        if (bi == null) bi = 9999;
        if (ai !== bi) return ai - bi;
      }
      return b.score - a.score || (a.deal.client || '').localeCompare(b.deal.client || '');
    });
  }

  /* Find the pipeline deal a course belongs to. Whole-word matching only —
     substring matching linked "Gambling Compliance" to LIA, on the "lia" inside
     "compliance". Generic industry words are ignored so "Financial & Digital
     Literacy" cannot attach itself to a client called Financia. The match is
     shown on screen so a wrong one is visible and can be corrected. */
  var MATCH_STOP_WORDS = ['training', 'programme', 'programmes', 'course', 'courses', 'short',
    'institute', 'association', 'assoc', 'school', 'global', 'ireland', 'irish', 'professional',
    'business', 'compliance', 'digital', 'the', 'and', 'for'];
  /* Known abbreviations the trackers use on one side but not the other. */
  var COURSE_CLIENT_ALIASES = [
    [/\bpfai\b/i, 'Ireland Professional Players Assoc.'],
    [/\bcu\b|credit union/i, 'Credit Unions'],
    [/\beirgrid\b/i, 'Analytics Institute'],
    [/fincrime|\bamli\b/i, 'AML Intelligence']
  ];

  function wordBag(s) {
    return ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  }

  function dealForCourse(course, dealList) {
    var name = wordBag(course.name);
    var byClient = {};
    dealList.forEach(function (d) { byClient[d.client] = d; });

    for (var i = 0; i < COURSE_CLIENT_ALIASES.length; i++) {
      if (COURSE_CLIENT_ALIASES[i][0].test(course.name) && byClient[COURSE_CLIENT_ALIASES[i][1]]) {
        return byClient[COURSE_CLIENT_ALIASES[i][1]];
      }
    }

    var best = null, bestScore = 0;
    dealList.forEach(function (d) {
      var client = wordBag(d.client).trim();
      if (!client) return;
      if (client.length > 3 && name.indexOf(' ' + client + ' ') !== -1 && client.length > bestScore) {
        best = d; bestScore = client.length; return;
      }
      client.split(' ').forEach(function (w) {
        if (w.length < 3 || MATCH_STOP_WORDS.indexOf(w) !== -1) return;
        if (name.indexOf(' ' + w + ' ') !== -1 && w.length > bestScore) { best = d; bestScore = w.length; }
      });
    });
    return best;
  }

  var BUILD_TIERS = {
    1: { label: 'Active clients with a signed mandate', kind: 'done', glyph: '1' },
    2: { label: 'High priority new clients', kind: 'brand', glyph: '2' },
    3: { label: 'What ECI want', kind: 'amber', glyph: '3' },
    4: { label: 'What we think the market wants', kind: 'wait', glyph: '4' }
  };

  function buildTier(course, dealList) {
    var deal = dealForCourse(course, dealList);
    /* the "active client / signed" signal usually lives in the deal's notes,
       not the build tracker's */
    var text = (course.name + ' ' + course.notes + ' ' + (deal ? deal.notes : '')).toLowerCase();

    /* "signed" has to mean signed — not "awaiting signature". But a note about
       waiting on content from a live client is a delivery detail, not an unsigned
       mandate, so the exclusions name the contract explicitly. */
    var signed = /(active client|contract signed|signed contract|mandate signed|signed mandate|contracted)/;
    var unsigned = /(awaiting sign|awaiting contract|await contract|waiting on sign|waiting contract|waiting on contract|pending contract|pending .{0,20}agreement|to be agreed|not yet signed|subject to contract|when .{0,15}sign|once .{0,15}sign|if .{0,15}sign)/;

    if (deal && deal.stageNum >= 5) {
      return { tier: 1, deal: deal, why: deal.client + ' is at ' + (deal.stageLabel || deal.stage) + ' — mandate signed' };
    }
    if (signed.test(text) && !unsigned.test(text)) {
      return {
        tier: 1, deal: deal,
        why: (deal ? deal.client + ' — ' : '') + 'tracker notes record an active client or signed mandate'
      };
    }
    if (deal && String(deal.priority).toUpperCase() === 'HIGH') {
      return { tier: 2, deal: deal, why: deal.client + ' is a High priority deal at ' + (deal.stageLabel || deal.stage) };
    }
    if (/\beci\b|erasmus/.test(text)) {
      return { tier: 3, deal: deal, why: 'ECI-commissioned work' };
    }
    if (deal) {
      return { tier: 4, deal: deal, why: 'Linked to ' + deal.client + ', priority ' + deal.priority };
    }
    return { tier: 4, deal: null, why: 'No client in the pipeline — built on our read of the market' };
  }

  function buildRanking(list, dealList) {
    return list.map(function (c) {
      var t = buildTier(c, dealList);
      return { course: c, tier: t.tier, deal: t.deal, why: t.why };
    }).sort(function (a, b) {
      var order = courseOrder();
      if (Object.keys(order).length) {
        var ai = order[a.course.name], bi = order[b.course.name];
        if (ai == null) ai = 9999;
        if (bi == null) bi = 9999;
        if (ai !== bi) return ai - bi;
      }
      return a.tier - b.tier ||
        (a.course.targetSort || 999999) - (b.course.targetSort || 999999) ||
        priorityRank(a.course.priority) - priorityRank(b.course.priority) ||
        b.course.progress - a.course.progress;
    });
  }

  /* ---------- build capacity ----------
     Who is carrying how much, and where work is queueing. Every number here is
     counted from the build tracker itself — no estimates, no assumptions about
     how long anything takes. What it cannot yet show is speed: that needs more
     than one snapshot of the tracker, which is noted on the page rather than
     guessed at. */
  function ownerLoad() {
    var load = {};
    courses().forEach(function (c) {
      if (!c.name || !c.stagesActive) return;
      var names = (c.owner || 'Unassigned').split(/[\/,]| and /).map(function (s) { return s.trim(); }).filter(Boolean);
      names.forEach(function (n) {
        if (!load[n]) load[n] = { owner: n, active: 0, courses: [] };
        load[n].active++;
        load[n].courses.push(c.name);
      });
    });
    return Object.keys(load).map(function (k) { return load[k]; })
      .sort(function (a, b) { return b.active - a.active; });
  }

  function stageQueue() {
    var stages = state.data.courses.stageNames || [];
    var counts = stages.map(function (s, i) { return { name: s, index: i, active: 0, waiting: 0 }; });
    courses().forEach(function (c) {
      if (!c.name) return;
      c.steps.forEach(function (s, i) {
        if (!counts[i]) return;
        if (s.key === 'active') counts[i].active++;
        else if (s.key === 'pending') counts[i].waiting++;
      });
    });
    return counts;
  }

  function capacityCard() {
    var load = ownerLoad();
    var inFlight = courses().filter(function (c) { return c.name && c.stagesActive > 0; });
    var stalled = courses().filter(function (c) {
      return c.name && !c.stagesActive && c.stagesDone > 0 && c.progress < 100;
    });
    var maxLoad = Math.max.apply(null, load.map(function (l) { return l.active; }).concat([1]));

    var rows = load.map(function (l) {
      return {
        label: l.owner + (roleName(l.owner) ? '' : ''),
        value: l.active,
        valueLabel: l.active + (l.active === 1 ? ' build' : ' builds'),
        color: l.active > 4 ? '#C62828' : (l.active > 2 ? RAMP[4] : RAMP[3]),
        tip: (roleName(l.owner) ? l.owner + ' — ' + roleName(l.owner) + '. ' : '') + 'Currently on: ' + l.courses.join(', ')
      };
    });

    var queue = stageQueue().filter(function (s) { return s.active || s.waiting; }).map(function (s) {
      return {
        label: (s.index + 1) + '. ' + s.name,
        value: s.active,
        valueLabel: s.active + ' in progress',
        subLabel: s.waiting ? s.waiting + ' queued' : '',
        color: RAMP[3],
        tip: s.active + ' course(s) being worked on at this stage, ' + s.waiting + ' waiting to reach it.'
      };
    });

    return '<section class="card"><div class="card-head"><h2>Build capacity</h2>' +
      '<span class="hint">counted from the build tracker</span></div>' +
      '<div class="grid two">' +
      '<div><h3 class="sub-h">Builds each person is on right now</h3>' +
      (rows.length ? barChart(rows) : '<p class="empty">Nobody is recorded as building anything.</p>') +
      '<p class="hint" style="margin-top:10px">A person appears once for every course where a stage is marked in progress. ' +
      'Owners come from the “Owner:” note at the end of each row in the build tracker.</p></div>' +
      '<div><h3 class="sub-h">Where the work is stacked up</h3>' +
      (queue.length ? barChart(queue) : '<p class="empty">No stages in progress.</p>') +
      '</div></div>' +
      '<div class="banner info" style="margin-top:16px"><span aria-hidden="true">ℹ</span><div>' +
      '<b>' + inFlight.length + ' courses have work in progress right now</b>, against the build tracker’s own note that ' +
      '“4 concurrent builds is not workable”. ' + (stalled.length ? stalled.length + ' more are part-built with no stage currently active. ' : '') +
      'This page can show how much is being carried, but not how fast it moves — that needs the tracker saved week on week, ' +
      'which nothing does yet.</div></div>' +
      '</section>';
  }

  function ruleNote(text) {
    return '<div class="rule-note"><span class="rule-note-mark" aria-hidden="true">§</span><div>' + text + '</div></div>';
  }

  /* ---------- the standard build ----------
     How long a course should take, stage by stage, and who owns each stage.
     These durations are NOT recorded anywhere — they are a starting point sized
     to the tracker's own note that EirGrid is a "4-6 week build when contract
     signed". They must be confirmed by the Course Director before anyone makes a
     hiring decision on them, and the page says so. Change them in one place and
     every deadline and staffing number recalculates. */
  var DEFAULT_BUILD_MODEL = {
    days: [3, 2, 5, 5, 3, 2, 1, 2, 2, 1],
    roles: ['AQ', 'AQ', 'AQ', 'OM', 'OM', 'OM', 'OM', 'OM', 'AQ', 'AQ/OM'],
    confirmed: false
  };
  function buildModel() {
    var m = state.data.buildModel || DEFAULT_BUILD_MODEL;
    return {
      days: m.days || DEFAULT_BUILD_MODEL.days,
      roles: m.roles || DEFAULT_BUILD_MODEL.roles,
      confirmed: !!m.confirmed
    };
  }
  function modelTotalDays() {
    return buildModel().days.reduce(function (a, b) { return a + b; }, 0);
  }

  function endOfMonthFromKey(key) {
    if (!key) return null;
    return new Date(Math.floor(key / 100), key % 100, 0);
  }
  function workingDaysBetween(from, to) {
    if (!from || !to) return null;
    var a = new Date(from), b = new Date(to), sign = 1;
    a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
    if (b < a) { var t = a; a = b; b = t; sign = -1; }
    var n = 0;
    while (a < b) {
      var wd = a.getDay();
      if (wd !== 0 && wd !== 6) n++;
      a.setDate(a.getDate() + 1);
    }
    return n * sign;
  }
  function minusWorkingDays(date, days) {
    var d = new Date(date);
    while (days > 0) {
      d.setDate(d.getDate() - 1);
      var wd = d.getDay();
      if (wd !== 0 && wd !== 6) days--;
    }
    return d;
  }
  function fmtDate(d) {
    return d ? d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  }

  /* Stage deadlines are back-scheduled from the go-live target using the standard
     build, so every course gets a date per stage without anyone typing twenty of them. */
  function coursePlan(c) {
    var m = buildModel();
    var target = endOfMonthFromKey(c.targetSort);
    var remaining = [];
    c.steps.forEach(function (s, i) { if (s.key !== 'done') remaining.push(i); });
    var remainingDays = remaining.reduce(function (a, i) { return a + (m.days[i] || 0); }, 0);
    var available = target ? workingDaysBetween(new Date(), target) : null;
    var deadlines = {}, cursor = target ? new Date(target) : null;
    for (var k = remaining.length - 1; k >= 0; k--) {
      var idx = remaining[k];
      deadlines[idx] = cursor ? new Date(cursor) : null;
      if (cursor) cursor = minusWorkingDays(cursor, m.days[idx] || 0);
    }
    return {
      remaining: remaining, remainingDays: remainingDays, target: target,
      available: available, deadlines: deadlines, startBy: cursor,
      shortfall: available == null ? null : remainingDays - available
    };
  }

  function staffingCase() {
    var live = courses().filter(function (c) { return c.name && c.progress < 100 && c.targetSort; });
    var inHorizon = live.filter(function (c) {
      var m = monthsFromNow(c.targetSort);
      return m !== null && m <= 6;
    });
    var plans = inHorizon.map(function (c) { return { course: c, plan: coursePlan(c) }; });
    var behind = plans.filter(function (p) { return p.plan.shortfall > 0; });
    var totalDays = plans.reduce(function (a, p) { return a + p.plan.remainingDays; }, 0);
    var latest = plans.reduce(function (a, p) {
      return (!a || (p.plan.target && p.plan.target > a)) ? p.plan.target : a;
    }, null);
    var horizonDays = latest ? Math.max(workingDaysBetween(new Date(), latest), 0) : 0;
    var builders = ownerLoad().filter(function (l) { return l.owner !== 'Unassigned'; }).length;
    var needed = horizonDays > 0 ? Math.ceil(totalDays / horizonDays) : null;
    return {
      plans: plans.sort(function (a, b) { return (b.plan.shortfall == null ? -999 : b.plan.shortfall) - (a.plan.shortfall == null ? -999 : a.plan.shortfall); }),
      behind: behind, totalDays: totalDays, horizonDays: horizonDays, latest: latest,
      builders: builders, capacity: builders * horizonDays, needed: needed,
      gap: needed == null ? null : needed - builders
    };
  }


  function monthLabel(key) {
    var d = endOfMonthFromKey(key);
    return d ? d.toLocaleDateString('en-IE', { month: 'short', year: 'numeric' }) : '—';
  }

  /* Total capacity over six months tells you very little: the binding constraint is
     the near term, because deadlines are not evenly spread. This walks month by
     month and finds the first point where the work due has outrun the days available. */
  function phasedCase() {
    var s = staffingCase();
    var byMonth = {};
    s.plans.forEach(function (p) {
      var k = p.course.targetSort;
      if (!k) return;
      if (!byMonth[k]) byMonth[k] = { key: k, days: 0, courses: [] };
      byMonth[k].days += p.plan.remainingDays;
      byMonth[k].courses.push(p.course.name);
    });
    var cum = 0;
    var rows = Object.keys(byMonth).sort().map(function (k) {
      var g = byMonth[k];
      cum += g.days;
      var wd = Math.max(workingDaysBetween(new Date(), endOfMonthFromKey(+k)), 0);
      var cap = wd * s.builders;
      return {
        key: +k, label: monthLabel(+k), courses: g.courses, days: g.days,
        cumDemand: cum, capacity: cap, gap: cum - cap,
        peopleNeeded: wd > 0 ? Math.ceil(cum / wd) : null
      };
    });
    var crunch = rows.filter(function (r) { return r.gap > 0; })[0] || null;
    return { rows: rows, crunch: crunch, builders: s.builders, behind: s.behind, plans: s.plans };
  }

  function staffingCard() {
    var s = staffingCase();
    var m = buildModel();
    if (!s.plans.length) return '';

    var rows = s.plans.slice(0, 14).map(function (p) {
      var late = p.plan.shortfall > 0;
      return '<tr><td class="client-cell">' + esc(p.course.name) + '</td>' +
        '<td class="num">' + p.plan.remaining.length + '</td>' +
        '<td class="num">' + p.plan.remainingDays + '</td>' +
        '<td class="num">' + (p.plan.available == null ? '—' : p.plan.available) + '</td>' +
        '<td>' + (late ? chip('risk', 'Short by ' + p.plan.shortfall + ' days', '!') : chip('done', 'Fits', '✓')) + '</td>' +
        '<td class="note">Latest start ' + esc(fmtDate(p.plan.startBy)) + '</td></tr>';
    }).join('');

    var ph = phasedCase();
    var verdict;
    if (ph.crunch) {
      verdict = '<b>The dates do not work, and the problem is the near term, not the total.</b> ' +
        'By the end of ' + ph.crunch.label + ', ' + ph.crunch.cumDemand + ' build days are due and ' +
        ph.builders + (ph.builders === 1 ? ' person has ' : ' people have ') + ph.crunch.capacity +
        ' days between them. That is ' + ph.crunch.peopleNeeded + ' people building full time to hold the date — ' +
        '<b>' + (ph.crunch.peopleNeeded - ph.builders) + ' more than we have</b>. Across the whole six months the ' +
        'work fits, which is why a headline capacity figure will always say yes.';
    } else {
      verdict = '<b>The dates work at this pace.</b> ' + s.totalDays + ' build days are needed before ' +
        fmtDate(s.latest) + ', against ' + s.capacity + ' days from ' + s.builders + ' people, and no month is oversubscribed.';
    }

    var phaseRows = ph.rows.map(function (r) {
      return '<tr><td>' + esc(r.label) + '</td>' +
        '<td class="num">' + r.courses.length + '</td>' +
        '<td class="num">' + r.days + '</td>' +
        '<td class="num">' + r.cumDemand + '</td>' +
        '<td class="num">' + r.capacity + '</td>' +
        '<td>' + (r.gap > 0 ? chip('risk', r.gap + ' days short', '!') : chip('done', 'Covered', '✓')) + '</td>' +
        '<td class="num">' + (r.peopleNeeded == null ? '—' : r.peopleNeeded) + '</td></tr>';
    }).join('');

    var phaseTable = '<h3 class="sub-h" style="margin-top:18px">Month by month</h3>' +
      '<div class="table-wrap"><table><thead><tr><th>By end of</th><th>Courses due</th><th>Build days due</th>' +
      '<th>Running total</th><th>Days available</th><th>Verdict</th><th>People needed</th></tr></thead>' +
      '<tbody>' + phaseRows + '</tbody></table></div>' +
      '<p class="hint" style="margin-top:8px">Running total is every build day owed by that date, including work ' +
      'carried over from earlier months. Days available is ' + ph.builders + ' people times the working days left ' +
      'until then.</p>';

    return '<section class="card"><div class="card-head"><h2>Can we hit the dates?</h2>' +
      '<span class="hint">courses with a go-live target in the next six months</span></div>' +
      (m.confirmed ? '' : '<div class="banner"><span aria-hidden="true">⚠</span><div>' +
        '<b>The stage durations behind this have not been signed off.</b> They total ' + modelTotalDays() +
        ' working days, about ' + (modelTotalDays() / 5).toFixed(1) + ' weeks, sized to the tracker’s own note that ' +
        'EirGrid is a “4-6 week build when contract signed”. Everything here is arithmetic on top of them, so have the ' +
        'Course Director confirm or correct them before this goes near a hiring decision.</div></div>') +
      '<div class="banner info"><span aria-hidden="true">ℹ</span><div>' + verdict + '</div></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Course</th><th>Stages left</th><th>Build days needed</th><th>Working days left</th>' +
      '<th>Verdict</th><th>Latest possible start</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      phaseTable +
      '<p class="hint" style="margin-top:10px">' + s.behind.length + ' of ' + s.plans.length +
      ' cannot be finished by their target date at the standard pace, even with someone free to start today. ' +
      'Working days exclude weekends only — holidays, meetings, review time and everything else are not deducted, ' +
      'so these are best cases.</p></section>';
  }


  /* Per-course stage deadlines, back-scheduled from the go-live target. */
  function planDetails(c) {
    var m = buildModel();
    var plan = coursePlan(c);
    var saved = stagePlanFor(c.name);
    var today = new Date();
    var agreed = Object.keys(saved).filter(function (k) { return saved[k] && (saved[k].due || saved[k].who); }).length;

    var rows = c.steps.map(function (st, i) {
      var own = saved[i] || {};
      var suggested = plan.deadlines[i];
      var dueValue = own.due || (suggested ? isoDate(suggested) : '');
      var whoValue = own.who || m.roles[i] || '';
      var dueDate = own.due ? new Date(own.due) : suggested;
      var late = dueDate && dueDate < today && st.key !== 'done';

      return '<tr' + (late ? ' class="row-late"' : '') + '>' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td>' + esc(st.name) + '</td>' +
        '<td>' + (st.key === 'done' ? chip('done', 'Complete', '✓')
          : st.key === 'active' ? chip('active', 'In progress', '▶')
            : chip('wait', st.label || 'Not started', '○')) + '</td>' +
        '<td><input type="date" class="stage-due" data-course="' + esc(c.name) + '" data-stage="' + i + '"' +
        ' value="' + esc(dueValue) + '"' + (own.due ? '' : ' data-suggested="1"') + '></td>' +
        '<td><input type="text" class="stage-who" data-course="' + esc(c.name) + '" data-stage="' + i + '"' +
        ' value="' + esc(whoValue) + '" placeholder="who" data-tip="' + esc(expandInitials(whoValue)) + '"' +
        (own.who ? '' : ' data-suggested="1"') + '></td>' +
        '<td>' + (late ? chip('risk', 'Overdue', '!') : (own.due || own.who ? chip('done', 'Agreed', '✓') : chip('ghost', 'Suggested'))) + '</td>' +
        '</tr>';
    }).join('');

    return '<details class="plan"><summary>Stage dates and owners — ' + agreed + ' of ' + c.steps.length + ' agreed' +
      (plan.target ? ', ' + plan.remainingDays + ' build days left' : ', no go-live target set') + '</summary>' +
      '<div class="table-wrap" style="margin-top:10px"><table><thead><tr>' +
      '<th>#</th><th>Stage</th><th>Status</th><th>Date</th><th>Responsible</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<p class="hint" style="margin:8px 0 0">Grey values are suggestions from the standard build, worked back from the ' +
      'go-live target. Type over one and it becomes an agreed date or owner for this course. ' +
      'Changes save to this browser until published from Update data.</p></details>';
  }

  function buildModelCard() {
    var m = buildModel();
    var stages = state.data.courses.stageNames || [];
    var cum = 0;
    var rows = stages.map(function (name, i) {
      cum += m.days[i] || 0;
      return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(name) + '</td>' +
        '<td><span data-tip="' + esc(expandInitials(m.roles[i] || '')) + '">' + esc(m.roles[i] || '—') + '</span></td>' +
        '<td class="num"><input type="number" min="0" max="99" class="model-days" data-stage="' + i + '" value="' + (m.days[i] || 0) + '"></td>' +
        '<td class="num">' + cum + '</td></tr>';
    }).join('');

    return '<section class="card"><div class="card-head"><h2>The standard build</h2>' +
      '<span class="hint">' + modelTotalDays() + ' working days end to end — about ' + (modelTotalDays() / 5).toFixed(1) + ' weeks</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>#</th><th>Stage</th><th>Responsible</th>' +
      '<th>Working days</th><th>Cumulative</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="filters" style="margin:14px 0 0">' +
      '<button class="btn primary" id="saveModel">Save these durations</button>' +
      '<button class="btn' + (m.confirmed ? ' amber' : '') + '" id="confirmModel">' +
      (m.confirmed ? 'Signed off — click to unlock' : 'Mark as agreed with the Course Director') + '</button></div>' +
      '<p class="hint" style="margin-top:10px">Change a number and every stage deadline, verdict and staffing figure ' +
      'recalculates. Responsible roles follow the process diagram: discovery, script and QA with the Course Director, ' +
      'the build itself with the Digital Learning Specialist.</p></section>';
  }

  /* ---------- charts ---------- */
  function barChart(rows, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; }).concat([1]));
    return '<div class="bars">' + rows.map(function (r) {
      return '<div class="bar-row"' + (r.tip ? ' data-tip="' + esc(r.tip) + '"' : '') + '>' +
        '<span class="bar-label">' + esc(r.label) + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + pct((r.value / max) * 100) + ';background:' + (r.color || RAMP[4]) + '"></span></span>' +
        '<span class="bar-value">' + esc(r.valueLabel) + (r.subLabel ? ' <small>' + esc(r.subLabel) + '</small>' : '') + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function funnelCard(list, title) {
    var rows = funnelByStage(list).map(function (s) {
      return {
        label: (s.stageNum ? s.stageNum + '. ' : '') + s.name,
        value: s.count,
        valueLabel: s.count + (s.count === 1 ? ' deal' : ' deals'),
        color: RAMP[Math.max(0, Math.min(5, (s.stageNum || 1) - 1))],
        tip: s.clients.slice(0, 6).join(', ') + (s.clients.length > 6 ? ' +' + (s.clients.length - 6) + ' more' : '')
      };
    });
    if (!rows.length) return '';
    return '<section class="card"><div class="card-head"><h2>' + esc(title) + '</h2>' +
      '<span class="hint">hover a bar for the client names</span></div>' +
      barChart(rows) + '</section>';
  }

  function verticalCard(list) {
    var rows = byVertical(list).sort(function (a, b) { return b.count - a.count; }).slice(0, 8).map(function (v) {
      return {
        label: v.name, value: v.count,
        valueLabel: v.count + (v.count === 1 ? ' deal' : ' deals'),
        tip: v.name + ': ' + v.count + ' deal(s)'
      };
    });
    if (!rows.length) return '';
    return '<section class="card"><div class="card-head"><h2>Deals by vertical</h2>' +
      '<span class="hint">where the conversations are</span></div>' +
      barChart(rows) + '</section>';
  }

  /* ---------- views ---------- */
  /* Archived clients and courses. Nothing is deleted — archiving takes something
     out of every list, count and ranking, and it can come back. */
  function archiveCard(kind) {
    var items = kind === 'deals' ? archivedDeals() : archivedCourses();
    var label = kind === 'deals' ? 'client' : 'course';
    if (!items.length) {
      return '<details class="card archive-card"><summary>Archive — nothing archived yet</summary>' +
        '<p class="hint" style="margin-top:10px">Archiving a ' + (kind === 'deals' ? 'client' : 'course') +
        ' removes it from every list and count here, without touching the spreadsheet. It can be restored at any time.</p></details>';
    }
    return '<details class="card archive-card"><summary>Archive — ' + items.length + ' ' + label + (items.length === 1 ? '' : 's') + '</summary>' +
      '<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Name</th><th>Last known status</th>' +
      '<th>Archived</th><th></th></tr></thead><tbody>' +
      items.map(function (x) {
        var name = kind === 'deals' ? x.client : x.name;
        var status = kind === 'deals' ? (x.stageLabel || x.stage || '—') : x.currentStage;
        return '<tr><td class="client-cell">' + esc(name) + '</td>' +
          '<td>' + esc(status) + '</td>' +
          '<td>' + esc(x.editedAt ? dateLabel(x.editedAt) : '—') + '</td>' +
          '<td><button class="btn btn-sm" data-restore-' + (kind === 'deals' ? 'deal' : 'course') + '="' + esc(name) + '">Restore</button></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="hint" style="margin-top:10px">Archived items stay out of every count and ranking until restored. ' +
      'They are still in the spreadsheet — this only affects what the platform shows.</p></details>';
  }

  /* The editor that hangs under a course row in the grid. */
  function courseEditor(c, colspan) {
    if (state.filters.editingCourse !== c.name) return '';
    return '<tr class="editor-row"><td colspan="' + colspan + '"><div class="editor">' +
      '<div class="editor-grid">' +
      '<label>Priority<select class="ec-priority" data-course-name="' + esc(c.name) + '">' +
      ['HIGH', 'MEDIUM', 'LOW', 'UNSET'].map(function (p) {
        return '<option' + (String(c.priority).toUpperCase() === p ? ' selected' : '') + '>' + p + '</option>';
      }).join('') + '</select></label>' +
      '<label>Go-live target<input type="text" class="ec-target" data-course-name="' + esc(c.name) + '" value="' +
      esc(c.target || '') + '" placeholder="e.g. End Oct 2026"></label>' +
      '<label>Owner<input type="text" class="ec-owner" data-course-name="' + esc(c.name) + '" value="' +
      esc(c.owner || '') + '" placeholder="e.g. AQ/OM"></label>' +
      '</div>' +
      '<label class="editor-notes">Notes / blockers<textarea class="ec-notes" data-course-name="' + esc(c.name) + '">' +
      esc(c.notes || '') + '</textarea></label>' +
      '<div class="editor-actions">' +
      '<button class="btn" data-edit-course="' + esc(c.name) + '">Done</button>' +
      '<button class="btn" data-archive-course="' + esc(c.name) + '">Archive this course</button>' +
      (c.edited && c.edited.length ? '<span class="hint">Edited here: ' + esc(c.edited.join(', ')) +
        (c.editedAt ? ' · ' + esc(dateLabel(c.editedAt)) : '') + '</span>' : '') +
      '</div></div></td></tr>';
  }

  var views = {};

  function salesPriorityCard(list, limit) {
    var high = list.filter(isHigh);
    var ranked = salesRanking(high);
    var shown = limit ? ranked.slice(0, limit) : ranked;
    if (!shown.length) {
      return '<section class="card"><div class="card-head"><h2>Sales priority order</h2>' +
        '<span class="hint">High-rated clients only</span></div>' +
        '<p class="empty">No client is rated High. Rate one High from its Edit panel and it appears here.</p></section>';
    }
    return '<section class="card"><div class="card-head"><h2>Sales priority order</h2>' +
      '<span class="hint">High-rated clients only · ' +
      (limit && ranked.length > limit ? 'top ' + limit + ' of ' + ranked.length : ranked.length + ' of them') + '</span></div>' +
      ruleNote(esc(PRIORITY_RULE_SALES) + (Object.keys(dealOrder()).length ? ' <b>This list has been reordered by hand</b> — the rule no longer decides it. <button class="btn btn-sm" id="resetOrder">Back to the rule</button>' : '')) +
      '<div class="list ranked">' + shown.map(function (r, i) {
        var d = r.deal;
        var mismatch = i < 5 && ['LOW', 'MONITOR'].indexOf(String(d.priority).toUpperCase()) !== -1;
        return '<div class="list-row draggable" draggable="true" data-client="' + esc(d.client) + '">' +
          '<span class="grip" aria-hidden="true" title="Drag to reorder">⠿</span>' +
          '<span class="rank">' + (i + 1) + '</span>' +
          '<span class="movers">' +
          '<button class="mover" data-move-deal="' + esc(d.client) + '" data-direction="-1" title="Move up"' +
          (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button class="mover" data-move-deal="' + esc(d.client) + '" data-direction="1" title="Move down"' +
          (i === shown.length - 1 ? ' disabled' : '') + '>▼</button></span>' +
          '<div class="lr-main"><a class="lr-title" href="' + clientHref(d.client) + '">' + esc(d.client) + '</a>' +
          '<div class="lr-sub">' + esc(d.stageLabel || d.stage) + ' — ' +
          (d.revenue != null ? esc(money(d.revenue)) + ' a year' : 'no value recorded') + '</div>' +
          (mismatch || r.unvalued ? '<div class="chips" style="margin-top:5px">' +
            (mismatch ? chip('amber', 'Ranks top 5 but marked ' + d.priority) : '') +
            (r.unvalued ? chip('wait', 'Add a value to rank it properly') : '') + '</div>' : '') +
          '</div>' +
          '<div class="lr-side">' + targetChip(d.target, d.targetSort) + '</div></div>';
      }).join('') + '</div></section>';
  }

  function buildPriorityCard(limit) {
    var ranked = buildRanking(courses().filter(function (c) { return c.name && c.progress < 100 && isHigh(c); }), liveDeals());
    var shown = limit ? ranked.slice(0, limit) : ranked;
    if (!shown.length) return '';
    return '<section class="card"><div class="card-head"><h2>Build priority order</h2>' +
      '<span class="hint">High-rated courses only · ' + (limit && ranked.length > limit ? 'top ' + limit + ' of ' + ranked.length : ranked.length + ' of them') + '</span></div>' +
      ruleNote(esc(PRIORITY_RULE_BUILD)) +
      '<div class="list ranked">' + shown.map(function (r, i) {
        var t = BUILD_TIERS[r.tier];
        return '<div class="list-row"><span class="rank">' + (i + 1) + '</span>' +
          '<div class="lr-main"><div class="lr-title">' + esc(r.course.name) + '</div>' +
          '<div class="lr-sub">' + esc(r.why) + '</div></div>' +
          '<div class="lr-side">' + chip(t.kind, t.label) + '</div></div>';
      }).join('') + '</div></section>';
  }

  views.overview = function () {
    var live = liveDeals();
    var build = coursesInBuild();
    var ready = courses().filter(function (c) { return c.progress === 100; });
    var soon = upcoming().filter(function (u) { var m = monthsFromNow(u.key); return m !== null && m >= 0 && m <= 3; });
    var late = upcoming().filter(function (u) { return isOverdue(u.key); });
    var attention = attentionItems();
    var inProgressProjects = projects().filter(function (p) { return /progress/i.test(p.status); });

    var kpis = '<div class="grid kpis">' +
      kpi('Live clients in the pipeline', String(live.length), deals().length - live.length + ' dead or parked', true) +
      kpi('Courses being built', String(build.length), courses().filter(function (c) { return c.name; }).length + ' on the tracker') +
      kpi('Past their target date', String(late.length), 'across sales and build') +
      kpi('Needs attention', String(attention.length), 'blockers, chases and missing owners') +
      '</div>';

    var charts = '<div class="grid two">' + funnelCard(live, 'Deals by pipeline stage') + verticalCard(live) + '</div>';

    var attentionList = '<section class="card"><div class="card-head"><h2>Needs attention</h2>' +
      '<span class="hint">' + attention.length + ' items</span></div>' +
      (attention.length ? '<div class="list">' + attention.slice(0, 9).map(function (a) {
        return '<div class="list-row"><div class="lr-main">' +
          '<a class="lr-title" href="' + a.route + '">' + esc(a.title) + '</a>' +
          '<div class="lr-sub">' + esc(a.source) + ' — ' + esc(a.why.join(' · ')) + '</div>' +
          '</div><div class="lr-side">' + esc(a.side || '') + '</div></div>';
      }).join('') + '</div>' : '<p class="empty">Nothing flagged. Enjoy it while it lasts.</p>') +
      '</section>';

    var upcomingList = '<section class="card"><div class="card-head"><h2>Coming up</h2>' +
      '<span class="hint">next go-live targets</span></div>' +
      (upcoming().length ? '<div class="list">' + upcoming().slice(0, 9).map(function (u) {
        return '<div class="list-row"><div class="lr-main">' +
          '<a class="lr-title" href="' + u.route + '">' + esc(u.title) + '</a>' +
          '<div class="lr-sub">' + esc(u.sub) + '</div></div>' +
          '<div class="lr-side">' + targetChip(u.label, u.key, u.provisional) + '</div></div>';
      }).join('') + '</div>' : '<p class="empty">No target dates recorded yet.</p>') +
      '</section>';

    var updates = state.data.updates.slice(0, 3);
    var updatesCard = '<section class="card"><div class="card-head"><h2>Latest updates</h2>' +
      '<a class="hint" href="#/updates">See all</a></div>' +
      (updates.length ? '<div class="timeline">' + updates.map(updateRow).join('') + '</div>'
        : '<p class="empty">No updates posted yet. Post one from the <a href="#/updates">Updates</a> page.</p>') +
      '</section>';

    /* Deliberately high level. Two separate journeys — selling a programme and
       building one — then what is most urgent in each. Detail lives on the
       pages behind these. */
    return stampLine() +
      kpis + '<div style="height:16px"></div>' +
      salesStepsCard(live) + '<div style="height:16px"></div>' +
      buildStagesCard() + '<div style="height:16px"></div>' +
      '<div class="grid two">' + highPrioritySalesCard(live) + highPriorityCoursesCard() + '</div>';
  };

  function unpublishedSummary() {
    var d = state.data, parts = [], count = 0;
    var o = d.overrides || {};
    var dealEdits = Object.keys(o.deals || {}).length;
    var courseEdits = Object.keys(o.courses || {}).length;
    var stageEdits = 0;
    Object.keys(d.stagePlans || {}).forEach(function (c) {
      Object.keys(d.stagePlans[c] || {}).forEach(function (i) {
        var cell = d.stagePlans[c][i] || {};
        if (cell.due || cell.who || cell.status) stageEdits++;
      });
    });
    if (dealEdits) { parts.push(dealEdits + (dealEdits === 1 ? ' client' : ' clients')); count += dealEdits; }
    if (courseEdits) { parts.push(courseEdits + (courseEdits === 1 ? ' course' : ' courses')); count += courseEdits; }
    if (stageEdits) { parts.push(stageEdits + (stageEdits === 1 ? ' stage' : ' stages')); count += stageEdits; }
    if (Object.keys(o.dealOrder || {}).length) { parts.push('the sales order'); count++; }
    if (Object.keys(o.courseOrder || {}).length) { parts.push('the build order'); count++; }
    if (d.buildModel) { parts.push('the standard build'); count++; }
    return { count: count, parts: parts, at: d.meta && d.meta.locallyEditedAt };
  }

  /* Sits above every page while there is unpublished work, because the whole
     failure mode is somebody editing for an afternoon and nobody else seeing it. */
  function unpublishedBanner() {
    /* Work done on this device before the shared database existed. The shared
       copy now takes precedence on screen, so this offers it back rather than
       letting it quietly disappear. */
    if (!state.isPreview && state.pendingLocal) {
      var when = state.pendingLocal.meta && state.pendingLocal.meta.locallyEditedAt;
      return '<div class="banner unpublished"><span aria-hidden="true">⚠</span><div>' +
        '<b>This device has older changes that were never shared</b>' +
        (when ? ', last edited ' + esc(dateLabel(when)) : '') + '. ' +
        'They are not part of what everyone else sees. ' +
        '<button class="btn btn-sm" id="downloadLocal">Download them</button> ' +
        '<button class="btn btn-sm" id="discardLocal">Discard</button></div></div>';
    }
    if (!state.isPreview) return '';
    if (cloudOnline() && canEditShared()) return '';
    var u = unpublishedSummary();
    if (!u.count) return '';

    var c = cloud();
    var why, fix;
    if (!c || !c.state.online) {
      why = 'The shared dashboard cannot be reached, so this is saved on this device only.';
      fix = '<button class="btn btn-sm" id="reloadShared">Try again</button>';
    } else if (!c.state.user) {
      why = 'You are not signed in, so this is saved on this device only and nobody else can see it.';
      fix = '<button class="btn btn-sm" id="openSignIn">Sign in to share it</button>';
    } else {
      why = 'You are signed in but not on the editors list, so this is saved on this device only.';
      fix = '<a class="btn btn-sm" href="#/access">Who can edit</a>';
    }
    return '<div class="banner unpublished"><span aria-hidden="true">⚠</span><div>' +
      '<b>Not saved to the shared dashboard.</b> ' + esc(why) + ' ' +
      esc(u.parts.join(', ')) + ' changed here' + (u.at ? ', last edit ' + esc(dateLabel(u.at)) : '') + '. ' +
      fix + '</div></div>';
  }

  /* A go-live date that moves still has to be explained. The spreadsheet import
     used to ask at upload time; now the question follows the edit itself. */
  function noteTargetChange(kind, key, from, to, owner) {
    if (String(from || '') === String(to || '')) return;
    state.pendingSlip = { kind: kind, key: key, from: from || 'none', to: to || 'none', owner: owner || '' };
  }

  function recordSlip(reason, agreedBy) {
    var sp = state.pendingSlip;
    if (!sp) return;
    var data = JSON.parse(JSON.stringify(state.data));
    data.history = data.history || { slips: [] };
    data.history.slips.push({
      date: new Date().toISOString().slice(0, 10),
      course: sp.key, from: sp.from, to: sp.to, owner: sp.owner,
      reason: reason || '', agreedBy: agreedBy || '',
      source: sp.kind === 'deal' ? 'client date, edited here' : 'edited here'
    });
    state.pendingSlip = null;
    savePreview(data);
    render();
  }

  function slipPrompt() {
    var sp = state.pendingSlip;
    if (!sp) return '';
    var gone = !String(sp.to).trim() || /^(tbc|none|under review)$/i.test(String(sp.to).trim());
    return '<div class="banner"><span aria-hidden="true">&#9888;</span><div style="flex:1">' +
      '<b>' + esc(sp.key) + '</b> moved from <b>' + esc(sp.from) + '</b> to <b>' + esc(sp.to) + '</b>' +
      (gone && sp.from !== 'none' ? ' &mdash; that removes the date rather than moving it' : '') + '.' +
      '<div class="filters" style="margin:10px 0 0">' +
      '<input type="text" id="slipReason" placeholder="Why has it moved?" style="min-width:300px">' +
      '<input type="text" id="slipAgreed" placeholder="Agreed with" style="min-width:170px">' +
      '<button class="btn primary" id="saveSlip">Record it</button>' +
      '<button class="btn" id="skipSlip">Skip</button></div>' +
      '<p class="hint" style="margin-top:8px">Skipping still records the change, as <b>no reason given</b>.</p>' +
      '</div></div>';
  }

  /* ---------- adding new work ----------
     With the spreadsheet import gone, a new course or client has to be able to
     start life here. Both are written into the same shape the tracker produced,
     so everything downstream treats them identically. */
  function newCourseFrom(fields) {
    var stages = (state.data.courses && state.data.courses.stageNames) || [];
    if (!stages.length) {
      stages = ['Data Gathering', 'Overview & Timeframes', 'Create Script', 'On-Demand Content',
        'Activities', 'Academy Setup', 'Timetables', 'Tutor Recording', 'QA', 'Go-Live'];
    }
    var target = window.FideoParse
      ? window.FideoParse.parseTarget(fields.target || '')
      : { label: fields.target || '', sortKey: null, provisional: false };
    return {
      name: fields.name,
      priority: (fields.priority || 'MEDIUM').toUpperCase(),
      steps: stages.map(function (name) { return { name: name, key: 'none', label: '' }; }),
      stagesDone: 0,
      stagesActive: 0,
      stageCount: stages.length,
      progress: 0,
      currentStage: 'Not started',
      target: target.label,
      targetSort: target.sortKey,
      provisional: target.provisional,
      owner: fields.owner || '',
      notes: fields.notes || '',
      flags: window.FideoParse ? window.FideoParse.flagsFor(fields.notes || '') : [],
      addedHere: new Date().toISOString().slice(0, 10)
    };
  }

  function newDealFrom(fields) {
    var target = window.FideoParse
      ? window.FideoParse.parseTarget(fields.target || '')
      : { label: fields.target || '', sortKey: null, provisional: false };
    var step = PROCESS.filter(function (x) { return x.id === fields.step; })[0];
    return {
      ref: '',
      client: fields.client,
      vertical: fields.vertical || 'Unassigned',
      stageNum: null,
      stage: step ? step.name : '',
      stageLabel: step ? step.id + '. ' + step.name : '',
      step: fields.step || '1',
      priority: fields.priority || 'Medium',
      target: target.label,
      targetSort: target.sortKey,
      revenue: null,
      notes: fields.notes || '',
      flags: window.FideoParse ? window.FideoParse.flagsFor(fields.notes || '') : [],
      addedHere: new Date().toISOString().slice(0, 10)
    };
  }

  function addCourse(fields) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.courses = data.courses || { items: [], stageNames: [] };
    data.courses.items = data.courses.items || [];
    var clash = data.courses.items.some(function (c) {
      return String(c.name).toLowerCase() === String(fields.name).toLowerCase();
    });
    if (clash) return 'There is already a course called that.';
    data.courses.items.push(newCourseFrom(fields));
    savePreview(data);
    return null;
  }

  function addDeal(fields) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.pipeline = data.pipeline || { deals: [] };
    data.pipeline.deals = data.pipeline.deals || [];
    var clash = data.pipeline.deals.some(function (d) {
      return String(d.client).toLowerCase() === String(fields.client).toLowerCase();
    });
    if (clash) return 'There is already a client called that.';
    data.pipeline.deals.push(newDealFrom(fields));
    savePreview(data);
    return null;
  }

  function addForm(kind) {
    var open = state.adding === kind;
    var noun = kind === 'course' ? 'course' : 'client';
    if (!canEditShared() && cloudOnline()) {
      return '';
    }
    if (!open) {
      return '<div style="margin-bottom:16px">' +
        '<button class="btn primary" data-add="' + kind + '">Add a ' + noun + '</button>' +
        (state.addMessage ? ' <span class="hint">' + esc(state.addMessage) + '</span>' : '') + '</div>';
    }

    var fields = kind === 'course'
      ? '<label>Course name<input type="text" id="afName" placeholder="e.g. Malta AML Part II" style="min-width:260px"></label>' +
        '<label>Priority<select id="afPriority">' +
        ['HIGH', 'MEDIUM', 'LOW'].map(function (x) { return '<option>' + x + '</option>'; }).join('') +
        '</select></label>' +
        '<label>Go-live target<input type="text" id="afTarget" placeholder="e.g. Q1 2027"></label>' +
        '<label>Owner<input type="text" id="afOwner" placeholder="e.g. AQ/OM"></label>'
      : '<label>Client name<input type="text" id="afName" placeholder="e.g. Bank of Valletta" style="min-width:240px"></label>' +
        '<label>Vertical<input type="text" id="afVertical" placeholder="e.g. RegTech / AML"></label>' +
        '<label>Step<select id="afStep">' +
        PROCESS.filter(function (x) { return !x.gate; }).map(function (x) {
          return '<option value="' + x.id + '">' + esc(x.id + '. ' + x.name) + '</option>';
        }).join('') + '</select></label>' +
        '<label>Priority<select id="afPriority">' +
        ['High', 'Medium', 'Low', 'Monitor'].map(function (x) { return '<option>' + x + '</option>'; }).join('') +
        '</select></label>' +
        '<label>Target go-live<input type="text" id="afTarget" placeholder="e.g. Q4 2026"></label>';

    return '<section class="card" style="margin-bottom:16px">' +
      '<div class="card-head"><h2>Add a ' + noun + '</h2>' +
      '<span class="hint">it starts with every stage not started, and you fill it in from there</span></div>' +
      '<div class="editor"><div class="editor-grid">' + fields + '</div>' +
      '<label class="editor-notes">Notes<textarea id="afNotes" placeholder="Anything worth knowing"></textarea></label>' +
      '<div class="editor-actions">' +
      '<button class="btn primary" data-save-add="' + kind + '">Add it</button>' +
      '<button class="btn" data-add="">Cancel</button>' +
      (state.addMessage ? '<span class="hint">' + esc(state.addMessage) + '</span>' : '') +
      '</div></div></section>';
  }

  function stampLine() {
    var gen = state.data.meta && state.data.meta.generatedAt;
    var local = state.data.meta && state.data.meta.locallyEditedAt;
    return '<div class="stamp">' +
      '<span><b>Last published</b> ' + esc(gen ? dateLabel(gen) : 'unknown') + '</span>' +
      (state.isPreview && local ? '<span class="chip amber"><span class="glyph">●</span>Edited on this device ' +
        esc(dateLabel(local)) + ', not published</span>' : '') +
      '<span>Build tracker as at ' + esc((state.data.courses && state.data.courses.asAt) || 'unknown') + '</span>' +
      '<span>Sales tracker as at ' + esc((state.data.pipeline && state.data.pipeline.asAt) || 'unknown') + '</span>' +

      '</div>';
  }

  /* --- Overview strip 1: selling a programme (the ten-step sales process) --- */
  function salesStepsCard(list) {
    var groups = processGroups(list);
    var open = state.filters.overviewStep;
    var tracked = {};
    Object.keys(STAGE_TO_STEP).forEach(function (k) { tracked[STAGE_TO_STEP[k]] = true; });

    var boxes = groups.filter(function (g) { return !g.step.gate; }).map(function (g) {
      var n = g.deals.length;
      var isTracked = !!tracked[g.step.id] || n > 0;
      var gateBefore = g.step.id === '5' ? 'Gate 1' : (g.step.id === '7' ? 'Gate 2' : '');
      return (gateBefore ? '<span class="gate-marker" data-tip="' +
        (gateBefore === 'Gate 1' ? 'Commercial Alignment Checkpoint — agreement to progress to commercial discussions.'
          : 'Delivery Readiness Checkpoint — internal approval to proceed to proposal and delivery planning.') +
        '">' + gateBefore + '</span>' : '') +
        '<button class="pstep' + (open === g.step.id ? ' open' : '') + (isTracked ? (n ? '' : ' vacant') : ' untracked') +
        '" data-step="' + g.step.id + '" data-tip="' + esc(g.step.detail + ' Led by ' + expandInitials(g.step.lead) + '.' +
          (isTracked ? '' : ' The sales tracker does not record this step separately.')) + '">' +
        '<span class="pstep-n">' + esc(g.step.id) + '</span>' +
        '<span class="pstep-name">' + esc(g.step.name) + '</span>' +
        '<span class="pstep-count">' + (isTracked ? n : '–') + '</span>' +
        '</button>';
    }).join('');

    var panel = '';
    if (open) {
      var g2 = groups.filter(function (x) { return x.step.id === open; })[0];
      if (g2) {
        panel = '<div class="pstep-panel"><div class="card-head"><h3>' + esc(g2.step.id + '. ' + g2.step.name) + '</h3>' +
          '<span class="hint">' + esc(g2.step.detail) + '</span></div>' +
          (g2.deals.length ? '<div class="list">' + g2.deals.map(function (d) {
            return '<div class="list-row"><div class="lr-main"><a class="lr-title" href="' + clientHref(d.client) + '">' + esc(d.client) + '</a>' +
              '<div class="lr-sub">' + esc(d.vertical) + '</div></div>' +
              '<div class="lr-side">' + priorityChip(d.priority) + '</div></div>';
          }).join('') + '</div>' : '<p class="empty">No clients at this step.</p>') + '</div>';
      }
    }

    return '<section class="card"><div class="card-head"><h2>Selling a programme</h2>' +
      '<span class="hint">the ten-step sales process · ' + list.length + ' live clients · click a step for names</span></div>' +
      '<div class="process">' + boxes + '</div>' + panel +
      '<p class="hint" style="margin-top:10px">Steps showing “–” are ones the sales tracker does not record separately. ' +
      'This is the client journey, and is nothing to do with the ten build stages below.</p></section>';
  }

  /* --- Overview strip 2: building a programme (the ten build stages) --- */
  function buildStagesCard() {
    var stages = (state.data.courses.stageNames || []);
    var list = courses().filter(function (c) { return c.name; });
    var open = state.filters.overviewStage;

    var at = stages.map(function () { return { active: [], waiting: [] }; });
    var notStarted = [], complete = [];
    list.forEach(function (c) {
      var b = stageBucket(c.steps, c.stagesDone, c.stageCount);
      if (b.complete) { complete.push(c); return; }
      if (b.idle) { notStarted.push(c); return; }
      if (at[b.index]) (b.live ? at[b.index].active : at[b.index].waiting).push(c);
    });

    var boxes = stages.map(function (name, i) {
      var a = at[i].active.length, w = at[i].waiting.length, n = a + w;
      return '<button class="pstep' + (open === String(i) ? ' open' : '') + (n ? '' : ' vacant') +
        '" data-stage="' + i + '" data-tip="' + esc(name + ' — ' + a + ' in progress, ' + w + ' waiting to start') + '">' +
        '<span class="pstep-n">' + (i + 1) + '</span>' +
        '<span class="pstep-name">' + esc(name) + '</span>' +
        '<span class="pstep-count">' + n + '</span>' +
        (a ? '<span class="pstep-sub">' + a + ' active</span>' : '') +
        '</button>';
    }).join('');

    var panel = '';
    if (open !== null && open !== undefined && at[+open]) {
      var g = at[+open];
      var items = g.active.map(function (c) { return { c: c, live: true }; })
        .concat(g.waiting.map(function (c) { return { c: c, live: false }; }));
      panel = '<div class="pstep-panel"><div class="card-head"><h3>' + esc((+open + 1) + '. ' + stages[+open]) + '</h3>' +
        '<span class="hint">' + g.active.length + ' in progress · ' + g.waiting.length + ' waiting to start</span></div>' +
        (items.length ? '<div class="list">' + items.map(function (x) {
          return '<div class="list-row"><div class="lr-main"><a class="lr-title" href="' + courseHref(x.c.name) + '">' + esc(x.c.name) + '</a>' +
            '<div class="lr-sub">' + esc(x.c.owner ? 'Owner: ' + x.c.owner : 'No owner named') + '</div></div>' +
            '<div class="lr-side">' + (x.live ? chip('active', 'In progress', '▶') : chip('wait', 'Waiting', '○')) +
            ' ' + targetChip(x.c.target, x.c.targetSort, x.c.provisional) + '</div></div>';
        }).join('') + '</div>' : '<p class="empty">No courses at this stage.</p>') + '</div>';
    }

    return '<section class="card"><div class="card-head"><h2>Building a programme</h2>' +
      '<span class="hint">the ten build stages · ' + list.length + ' courses · click a stage for names</span></div>' +
      '<div class="process">' + boxes + '</div>' + panel +
      stepLegend(false) +
      '<div class="legend" style="margin-top:12px">' +
      '<span><b>' + notStarted.length + '</b> not started</span>' +
      '<span><b>' + complete.length + '</b> all ten stages complete</span>' +
      '<span>A course counts once, at the stage it is currently on.</span>' +
      '</div></section>';
  }

  function highPrioritySalesCard(live) {
    var high = live.filter(function (d) { return String(d.priority).toUpperCase() === 'HIGH'; });
    var ranked = salesRanking(high).slice(0, 8);
    return '<section class="card"><div class="card-head"><h2>High priority sales</h2>' +
      '<a class="hint" href="#/pipeline">All ' + high.length + ' →</a></div>' +
      (ranked.length ? '<div class="list ranked">' + ranked.map(function (r, i) {
        return '<div class="list-row"><span class="rank">' + (i + 1) + '</span><div class="lr-main">' +
          '<a class="lr-title" href="' + clientHref(r.deal.client) + '">' + esc(r.deal.client) + '</a>' +
          '<div class="lr-sub">' + esc(r.deal.stageLabel || r.deal.stage) + '</div></div>' +
          '<div class="lr-side">' + targetChip(r.deal.target, r.deal.targetSort) + '</div></div>';
      }).join('') + '</div>' : '<p class="empty">Nothing marked High.</p>') + '</section>';
  }

  function highPriorityCoursesCard() {
    var high = courses().filter(function (c) { return c.name && c.priority === 'HIGH' && c.progress < 100; });
    var ranked = buildRanking(high, liveDeals()).slice(0, 8);
    return '<section class="card"><div class="card-head"><h2>High priority course builds</h2>' +
      '<a class="hint" href="#/courses">All ' + high.length + ' →</a></div>' +
      (ranked.length ? '<div class="list ranked">' + ranked.map(function (r, i) {
        return '<div class="list-row"><span class="rank">' + (i + 1) + '</span><div class="lr-main">' +
          '<a class="lr-title" href="' + courseHref(r.course.name) + '">' + esc(r.course.name) + '</a>' +
          '<div class="lr-sub">' + esc(r.course.currentStage) + '</div></div>' +
          '<div class="lr-side">' + targetChip(r.course.target, r.course.targetSort, r.course.provisional) + '</div></div>';
      }).join('') + '</div>' : '<p class="empty">Nothing marked High.</p>') + '</section>';
  }

  function kpi(label, value, foot, accent) {
    return '<div class="kpi' + (accent ? ' accent' : '') + '">' +
      '<div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + esc(value) + '</div>' +
      '<div class="kpi-foot">' + esc(foot) + '</div></div>';
  }

  views.pipeline = function () {
    var f = state.filters.pipeline = state.filters.pipeline || { q: '', stage: '', priority: '', vertical: '' };
    var all = deals();
    var list = all.filter(function (d) {
      if (f.stage && String(d.stageNum) !== f.stage) return false;
      if (f.priority && String(d.priority).toLowerCase() !== f.priority.toLowerCase()) return false;
      if (f.vertical && d.vertical !== f.vertical) return false;
      if (f.q) {
        var hay = (d.client + ' ' + d.vertical + ' ' + d.notes + ' ' + d.stage + ' ' + d.target).toLowerCase();
        if (hay.indexOf(f.q.toLowerCase()) === -1) return false;
      }
      return true;
    });

    var sort = state.sort.pipeline;
    list = list.slice().sort(function (a, b) {
      var va = a[sort.key], vb = b[sort.key];
      if (va == null) va = sort.key === 'revenue' ? -1 : '';
      if (vb == null) vb = sort.key === 'revenue' ? -1 : '';
      if (typeof va === 'string') return va.localeCompare(vb) * sort.dir;
      return (va - vb) * sort.dir;
    });

    var banner = '';
    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search client, vertical or notes…" value="' + esc(f.q) + '" aria-label="Search deals">' +
      select('fstage', 'All stages', uniqStages(all), f.stage) +
      select('fpriority', 'All priorities', uniq(all.map(function (d) { return d.priority; })).map(function (p) { return { value: p, label: p }; }), f.priority) +
      select('fvertical', 'All verticals', uniq(all.map(function (d) { return d.vertical; })).sort().map(function (v) { return { value: v, label: v }; }), f.vertical) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' deals</span>' +
      '</div>';

    /* The page is organised by the ten sales steps, one section each. */
    var placed = {};
    PROCESS.forEach(function (p) { if (!p.gate) placed[p.id] = []; });
    var unplaced = [];
    list.forEach(function (d) {
      var id = currentStepOf(d);
      if (id && placed[id]) placed[id].push(d);
      else unplaced.push(d);
    });

    function dealRows(items) {
      return items.sort(function (a, b) {
        return priorityRank(a.priority) - priorityRank(b.priority) ||
          (a.targetSort || 999999) - (b.targetSort || 999999);
      }).map(function (d) {
        return '<tr>' +
          '<td class="client-cell"><a href="' + clientHref(d.client) + '">' + esc(d.client) + '</a>' +
          (d.ref ? '<small>ref ' + esc(d.ref) + '</small>' : '') + '</td>' +
          '<td>' + esc(d.vertical) + '</td>' +
          '<td>' + priorityChip(d.priority) + '</td>' +
          '<td>' + targetChip(d.target, d.targetSort) + '</td>' +
          '<td class="note">' + esc(d.notes) +
          (d.flags.length ? '<div class="chips" style="margin-top:6px">' + flagChips(d.flags) + '</div>' : '') + '</td>' +
          '<td><button class="btn btn-sm" data-edit-deal="' + esc(d.client) + '">' +
          (state.filters.editingDeal === d.client ? 'Close' : 'Edit') + '</button></td>' +
          '</tr>' + dealEditor(d);
      }).join('');
    }

    var tracked = {};
    Object.keys(STAGE_TO_STEP).forEach(function (k) { tracked[STAGE_TO_STEP[k]] = true; });

    var sections = PROCESS.filter(function (p) { return !p.gate; }).map(function (p) {
      var items = placed[p.id] || [];
      var gateBefore = p.id === '5' ? ['Gate 1', 'Commercial Alignment Checkpoint — agreement to progress to commercial discussions.']
        : (p.id === '7' ? ['Gate 2', 'Delivery Readiness Checkpoint — internal approval to proceed to proposal and delivery planning.'] : null);
      var head = (gateBefore ? '<div class="gate-band"><b>' + gateBefore[0] + '</b> ' + esc(gateBefore[1]) + '</div>' : '') +
        '<div class="stage-group-head"><h2>' + esc(p.id + '. ' + p.name) + '</h2>' +
        '<span class="chip ghost">' + items.length + '</span>' +
        '<span class="hint" data-tip="' + esc(expandInitials(p.lead)) + '">Led by ' + esc(p.lead) + '</span></div>';

      var body = items.length
        ? '<div class="table-wrap"><table><thead><tr><th>Client / partner</th><th>Vertical</th>' +
        '<th>Priority</th><th>Target go-live</th><th>Next action / notes</th><th></th></tr></thead>' +
        '<tbody>' + dealRows(items) + '</tbody></table></div>'
        : '<p class="empty">' + (tracked[p.id] || items.length
          ? 'No clients at this step.'
          : 'The sales tracker does not record this step, so nobody can be placed here yet. Add a step column to the tracker and this fills in.') + '</p>';

      return '<section class="stage-group">' + head + body + '</section>';
    }).join('');

    var leftovers = unplaced.length
      ? '<section class="stage-group"><div class="stage-group-head"><h2>Not on the process yet</h2>' +
      '<span class="chip ghost">' + unplaced.length + '</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Client / partner</th><th>Vertical</th>' +
      '<th>Priority</th><th>Target go-live</th><th>Next action / notes</th><th></th></tr></thead>' +
      '<tbody>' + dealRows(unplaced) + '</tbody></table></div></section>'
      : '';

    return banner + addForm('client') +
      salesStepsCard(all.filter(function (d) { return String(d.priority).toLowerCase() !== 'dead'; })) +
      '<div style="height:16px"></div>' +
      salesPriorityCard(list, 8) +
      '<div style="height:18px"></div>' + filters +
      (list.length ? sections + leftovers : '<p class="empty">No deals match those filters.</p>') +
      '<div style="height:16px"></div>' + archiveCard('deals');
  };

  function uniqStages(all) {
    var seen = {};
    all.forEach(function (d) { if (d.stageNum) seen[d.stageNum] = d.stage; });
    return Object.keys(seen).sort().map(function (k) { return { value: k, label: k + ' – ' + seen[k] }; });
  }
  function select(id, placeholder, options, value) {
    return '<select id="' + id + '"><option value="">' + esc(placeholder) + '</option>' +
      options.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (String(value) === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
  }

  /* ---------- customer status ----------
     One entry per client, pulling together their pipeline deal, their five-milestone
     plan and any course builds matched to them, grouped by how close to live they are. */
  var CUSTOMER_BANDS = [
    { key: 'live', label: 'Live — delivering now', kind: 'done', glyph: '✓', blurb: 'Programme is running with learners.' },
    { key: 'contracted', label: 'Contracted — starting', kind: 'done', glyph: '✓', blurb: 'Signed. Build and mobilisation underway.' },
    { key: 'nearly', label: 'Nearly live — in contracting', kind: 'active', glyph: '▶', blurb: 'Terms being agreed. Nothing signed yet.' },
    { key: 'proposal', label: 'Proposal with the client', kind: 'brand', glyph: '', blurb: 'We have put numbers in front of them.' },
    { key: 'scoping', label: 'Scoping', kind: 'wait', glyph: '', blurb: 'Working out what they need.' },
    { key: 'lead', label: 'Early conversations', kind: 'wait', glyph: '', blurb: 'Interest, nothing shaped yet.' },
    { key: 'noDeal', label: 'On the plan, not on the pipeline', kind: 'wait', glyph: '', blurb: 'A milestone plan exists but no deal row.' },
    { key: 'parked', label: 'Parked or dead', kind: 'wait', glyph: '○', blurb: 'Frozen by the client, or written off.' }
  ];

  function customerBand(key) {
    return CUSTOMER_BANDS.filter(function (b) { return b.key === key; })[0] || CUSTOMER_BANDS[CUSTOMER_BANDS.length - 1];
  }

  function customerList() {
    var map = {}, dealList = deals();
    dealList.forEach(function (d) {
      if (!d.client) return;
      map[d.client] = { name: d.client, deal: d, plan: null, courses: [] };
    });
    plans().forEach(function (p) {
      if (!p.client) return;
      if (!map[p.client]) map[p.client] = { name: p.client, deal: null, plan: p, courses: [] };
      else map[p.client].plan = p;
    });
    courses().forEach(function (c) {
      if (!c.name) return;
      var d = dealForCourse(c, dealList);
      if (d && map[d.client]) map[d.client].courses.push(c);
    });

    return Object.keys(map).map(function (k) {
      var cu = map[k];
      var stage = cu.deal ? cu.deal.stageNum : null;
      var dead = cu.deal && ['dead'].indexOf(String(cu.deal.priority).toLowerCase()) !== -1;
      var frozen = /frozen|on hold|inactive/i.test((cu.deal && cu.deal.notes) || '');
      if (dead || frozen) cu.band = 'parked';
      else if (stage === 6) cu.band = 'live';
      else if (stage === 5) cu.band = 'contracted';
      else if (stage === 4) cu.band = 'nearly';
      else if (stage === 3) cu.band = 'proposal';
      else if (stage === 2) cu.band = 'scoping';
      else if (stage === 1) cu.band = 'lead';
      else cu.band = 'noDeal';
      return cu;
    });
  }

  views.customers = function () {
    var f = state.filters.customers = state.filters.customers || { q: '', band: '' };
    var all = customerList();

    var counts = {};
    all.forEach(function (cu) { counts[cu.band] = (counts[cu.band] || 0) + 1; });

    var list = all.filter(function (cu) {
      if (f.band && cu.band !== f.band) return false;
      if (f.q) {
        var hay = (cu.name + ' ' + (cu.deal ? cu.deal.vertical + ' ' + cu.deal.notes : '') + ' ' +
          cu.courses.map(function (c) { return c.name; }).join(' ')).toLowerCase();
        if (hay.indexOf(f.q.toLowerCase()) === -1) return false;
      }
      return true;
    });

    /* the headline: who is live, and who is nearly there */
    var liveish = ['live', 'contracted', 'nearly'];
    var summary = '<div class="grid kpis">' +
      CUSTOMER_BANDS.filter(function (b) { return liveish.indexOf(b.key) !== -1; }).map(function (b) {
        var names = all.filter(function (cu) { return cu.band === b.key; }).map(function (cu) { return cu.name; });
        return kpi(b.label, String(names.length), names.length ? names.join(', ') : 'nobody yet', b.key === 'live');
      }).join('') +
      kpi('Everyone else', String(all.length - all.filter(function (cu) { return liveish.indexOf(cu.band) !== -1; }).length),
        'in discussion, parked or not yet on the pipeline') +
      '</div>';

    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search client, vertical, notes or course…" value="' + esc(f.q) + '" aria-label="Search customers">' +
      select('fband', 'All customers', CUSTOMER_BANDS.filter(function (b) { return counts[b.key]; })
        .map(function (b) { return { value: b.key, label: b.label + ' (' + counts[b.key] + ')' }; }), f.band) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' clients</span></div>';

    function customerCard(cu) {
      var d = cu.deal;
      var band = customerBand(cu.band);

      var dealBlock = d
        ? '<div class="cust-block"><h4>The deal</h4>' +
        '<div class="item-meta">' +
        '<span>Stage: <b>' + esc(d.stageLabel || d.stage || '—') + '</b></span>' +
        '<span>Priority: <b>' + esc(d.priority) + '</b></span>' +
        '<span>Vertical: <b>' + esc(d.vertical) + '</b></span>' +
        '<span>Target go-live: <b>' + esc(d.target || 'not set') + '</b></span>' +
        '</div>' +
        (d.notes ? '<p class="note"><b>Next action:</b> ' + esc(d.notes) + '</p>' : '') +
        (d.flags.length ? '<div class="chips">' + flagChips(d.flags) + '</div>' : '') +
        '</div>'
        : '<div class="cust-block"><h4>The deal</h4><p class="note">No row on the sales pipeline for this client.</p></div>';

      var planBlock = cu.plan
        ? '<div class="cust-block"><h4>Milestones</h4>' + stepStrip(cu.plan.steps, true) +
        progressBar(cu.plan.progress, cu.plan.stepsDone + '/' + cu.plan.stepCount + ' complete') +
        (cu.plan.notes ? '<p class="note">' + esc(cu.plan.notes) + '</p>' : '') + '</div>'
        : '';

      var courseBlock = cu.courses.length
        ? '<div class="cust-block"><h4>' + cu.courses.length + (cu.courses.length === 1 ? ' course being built' : ' courses being built') + '</h4>' +
        '<div class="list">' + cu.courses.map(function (c) {
          return '<div class="list-row"><div class="lr-main"><a class="lr-title" href="' + courseHref(c.name) + '">' + esc(c.name) + '</a>' +
            '<div class="lr-sub">' + esc(c.currentStage) + ' · ' + c.stagesDone + '/' + c.stageCount + ' stages</div></div>' +
            '<div class="lr-side">' + targetChip(c.target, c.targetSort, c.provisional) + '</div></div>';
        }).join('') + '</div></div>'
        : '';

      return '<article class="item customer">' +
        '<div class="item-head"><h3><a href="' + clientHref(cu.name) + '">' + esc(cu.name) + '</a></h3>' +
        '<div class="chips">' + chip(band.kind, band.label, band.glyph) + (d ? priorityChip(d.priority) : '') + '</div></div>' +
        dealBlock + planBlock + courseBlock +
        '</article>';
    }

    var sections = CUSTOMER_BANDS.map(function (b) {
      var items = list.filter(function (cu) { return cu.band === b.key; })
        .sort(function (a, z) {
          return priorityRank(a.deal && a.deal.priority) - priorityRank(z.deal && z.deal.priority) ||
            a.name.localeCompare(z.name);
        });
      if (!items.length) return '';
      return '<section class="stage-group"><div class="stage-group-head">' +
        '<h2>' + esc(b.label) + '</h2><span class="chip ghost">' + items.length + '</span>' +
        '<span class="hint">' + esc(b.blurb) + '</span></div>' +
        '<div class="grid cards">' + items.map(customerCard).join('') + '</div></section>';
    }).join('');

    return summary + '<div style="height:16px"></div>' + filters +
      (list.length ? sections : '<p class="empty">No clients match those filters.</p>');
  };

  /* Which stage is this item sitting at? Used to break the long card walls into
     sections, so you can read a page by stage rather than scrolling everything. */
  function stageBucket(steps, done, total) {
    for (var i = 0; i < steps.length; i++) if (steps[i].key === 'active') return { order: i, index: i, live: true };
    if (total && done === total) return { order: 900, index: null, complete: true };
    if (steps.every(function (s) { return s.key === 'none'; })) return { order: -1, index: null, idle: true };
    for (var j = 0; j < steps.length; j++) if (steps[j].key !== 'done') return { order: j, index: j, live: false };
    return { order: 901, index: null };
  }

  /* Render items grouped into stage sections, most advanced work last. */
  function groupedSections(items, steps, cardFn, noun) {
    var buckets = {};
    items.forEach(function (item) {
      var b = stageBucket(item.steps, item.stagesDone != null ? item.stagesDone : item.stepsDone,
        item.stageCount != null ? item.stageCount : item.stepCount);
      var key = b.complete ? 'complete' : (b.idle ? 'idle' : String(b.index));
      if (!buckets[key]) {
        buckets[key] = {
          order: b.order,
          title: b.complete ? 'All ' + noun + ' complete'
            : b.idle ? 'Not started'
              : (noun === 'stages' ? 'Stage ' : 'Milestone ') + (b.index + 1) + ' — ' + steps[b.index],
          items: []
        };
      }
      buckets[key].items.push(item);
    });
    var keys = Object.keys(buckets).sort(function (a, b) { return buckets[a].order - buckets[b].order; });
    if (!keys.length) return '';
    return keys.map(function (k) {
      var g = buckets[k];
      return '<section class="stage-group">' +
        '<div class="stage-group-head"><h2>' + esc(g.title) + '</h2>' +
        '<span class="chip ghost">' + g.items.length + '</span></div>' +
        '<div class="grid cards">' + g.items.map(cardFn).join('') + '</div>' +
        '</section>';
    }).join('');
  }

  function updateRow(u) {
    return '<div class="tl-item"><div class="tl-date">' + esc(dateLabel(u.date)) + '<br>' + (u.tag ? chip('ghost', u.tag) : '') + '</div>' +
      '<div class="tl-body"><h3>' + esc(u.title) + '</h3><p>' + esc(u.body || '') + '</p></div></div>';
  }

  /* Resolve a stage's date and owner: an agreed value if someone has typed one,
     otherwise the standard build's suggestion worked back from the go-live target. */
  function stageCell(c, i, plan, saved, m) {
    var own = saved[i] || {};
    var due = own.due ? new Date(own.due) : (plan.deadlines[i] || null);
    var who = own.who || m.roles[i] || '';
    return {
      due: due, who: who, agreed: !!(own.due || own.who),
      status: c.steps[i].key,
      overdue: due && due < new Date() && c.steps[i].key !== 'done'
    };
  }

  function everyStageCell() {
    var m = buildModel(), out = [];
    courses().forEach(function (c) {
      if (!c.name) return;
      var plan = coursePlan(c), saved = stagePlanFor(c.name);
      c.steps.forEach(function (st, i) {
        out.push({ course: c, index: i, stage: st, cell: stageCell(c, i, plan, saved, m) });
      });
    });
    return out;
  }

  function tasksByPerson() {
    var byPerson = {};
    everyStageCell().forEach(function (x) {
      if (x.stage.key === 'done') return;
      var names = String(x.cell.who || 'Unassigned').split(/[\/,]| and /)
        .map(function (n) { return n.trim(); }).filter(Boolean);
      if (!names.length) names = ['Unassigned'];
      names.forEach(function (n) {
        if (!byPerson[n]) byPerson[n] = { person: n, open: 0, active: 0, overdue: 0, items: [] };
        byPerson[n].open++;
        if (x.stage.key === 'active') byPerson[n].active++;
        if (x.cell.overdue) byPerson[n].overdue++;
        byPerson[n].items.push(x);
      });
    });
    return Object.keys(byPerson).map(function (k) { return byPerson[k]; })
      .sort(function (a, b) { return b.overdue - a.overdue || b.active - a.active || b.open - a.open; });
  }

  function slipLogCard() {
    var all = slips().slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    if (!all.length) {
      return '<section class="card"><div class="card-head"><h2>Dates that have moved</h2>' +
        '<span class="hint">recorded from the next upload onwards</span></div>' +
        '<p class="empty">No go-live date has moved yet. When one does, the upload asks why before applying it.</p></section>';
    }
    var unexplained = all.filter(function (x) { return !x.reason; }).length;
    return '<section class="card"><div class="card-head"><h2>Dates that have moved</h2>' +
      '<span class="hint">' + all.length + ' changes · ' + unexplained + ' with no reason given</span></div>' +
      (unexplained ? ruleNote('A date cannot move quietly: uploads ask why before applying a change. Rows below marked <b>no reason given</b> came in without one — through the command line, or because nobody filled the box in.') : '') +
      '<div class="table-wrap"><table><thead><tr><th>Recorded</th><th>Course</th><th>From</th><th>To</th>' +
      '<th>Reason given</th><th>Agreed with</th></tr></thead><tbody>' +
      all.slice(0, 15).map(function (x) {
        var erased = /^(tbc|none|under review|\s*)$/i.test(String(x.to).trim());
        return '<tr><td>' + esc(dateLabel(x.date)) + '</td><td class="client-cell">' +
          '<a href="' + courseHref(x.course) + '">' + esc(x.course) + '</a>' +
          (x.source ? '<small>' + esc(x.source) + '</small>' : '') + '</td>' +
          '<td>' + esc(x.from) + '</td>' +
          '<td>' + esc(x.to) + (erased && x.from && x.from !== 'none'
            ? ' ' + chip('risk', 'date removed', '!') : '') + '</td>' +
          '<td class="note">' + (x.reason ? esc(x.reason) : chip('risk', 'No reason given', '!')) + '</td>' +
          '<td>' + esc(x.agreedBy || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>';
  }

  views.courses = function () {
    var f = state.filters.courses = state.filters.courses || { q: '', priority: '', person: '' };
    var m = buildModel();
    var stages = (state.data.courses.stageNames || []);
    var all = courses().filter(function (c) { return c.name; });

    var list = all.filter(function (c) {
      if (f.priority && c.priority !== f.priority) return false;
      if (f.q && (c.name + ' ' + c.notes + ' ' + c.owner).toLowerCase().indexOf(f.q.toLowerCase()) === -1) return false;
      if (f.person) {
        var saved = stagePlanFor(c.name), plan = coursePlan(c);
        var hit = c.steps.some(function (st, i) {
          return String(stageCell(c, i, plan, saved, m).who).toUpperCase().indexOf(f.person.toUpperCase()) !== -1;
        });
        if (!hit) return false;
      }
      return true;
    }).sort(function (a, b) {
      return priorityRank(a.priority) - priorityRank(b.priority) ||
        (a.targetSort || 999999) - (b.targetSort || 999999);
    });

    var people = tasksByPerson();

    /* 1. the ten stages across the top, same strip as the Overview */
    var strip = buildStagesCard();

    /* 2. high priority builds */
    var highs = buildRanking(all.filter(function (c) { return c.priority === 'HIGH' && c.progress < 100; }), liveDeals());
    var highCard = '<section class="card"><div class="card-head"><h2>High priority builds</h2>' +
      '<span class="hint">High-rated courses only · ' + highs.length + ' of them, in build-priority order</span></div>' +
      (Object.keys(courseOrder()).length
        ? ruleNote('<b>This order has been set by hand</b> — the build rule no longer decides it. ' +
          '<button class="btn btn-sm" id="resetCourseOrder">Back to the rule</button>')
        : '') +
      (highs.length ? '<div class="list ranked">' + highs.slice(0, 12).map(function (r, i) {
        var t = BUILD_TIERS[r.tier];
        return '<div class="list-row draggable" draggable="true" data-course="' + esc(r.course.name) + '">' +
          '<span class="grip" aria-hidden="true" title="Drag to reorder">⠿</span>' +
          '<span class="rank">' + (i + 1) + '</span>' +
          '<span class="movers">' +
          '<button class="mover" data-move-course="' + esc(r.course.name) + '" data-direction="-1" title="Move up"' +
          (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button class="mover" data-move-course="' + esc(r.course.name) + '" data-direction="1" title="Move down"' +
          (i === Math.min(highs.length, 12) - 1 ? ' disabled' : '') + '>▼</button></span>' +
          '<div class="lr-main">' +
          '<a class="lr-title" href="' + courseHref(r.course.name) + '">' + esc(r.course.name) + '</a>' +
          '<div class="lr-sub">' + esc(r.course.currentStage) + '</div></div>' +
          '<div class="lr-side">' + chip(t.kind, t.label) + ' ' +
          targetChip(r.course.target, r.course.targetSort, r.course.provisional) + '</div></div>';
      }).join('') + '</div>' : '<p class="empty">Nothing marked High.</p>') + '</section>';

    /* 3. anything overdue */
    var overdue = everyStageCell().filter(function (x) { return x.cell.overdue; })
      .sort(function (a, b) { return a.cell.due - b.cell.due; });
    var overdueCard = '<section class="card"><div class="card-head"><h2>Overdue stages</h2>' +
      '<span class="hint">' + overdue.length + ' past their date across ' +
      uniq(overdue.map(function (x) { return x.course.name; })).length + ' courses</span></div>' +
      (overdue.length
        ? '<div class="table-wrap"><table><thead><tr><th>Course</th><th>Stage</th><th>Was due</th>' +
        '<th>Days late</th><th>Responsible</th></tr></thead><tbody>' +
        overdue.slice(0, 20).map(function (x) {
          return '<tr class="row-late"><td class="client-cell"><a href="' + courseHref(x.course.name) + '">' + esc(x.course.name) + '</a></td>' +
            '<td>' + (x.index + 1) + '. ' + esc(x.stage.name) + '</td>' +
            '<td>' + esc(fmtDate(x.cell.due)) + '</td>' +
            '<td class="num">' + chip('risk', String(workingDaysBetween(x.cell.due, new Date())), '!') + '</td>' +
            '<td><span data-tip="' + esc(expandInitials(x.cell.who)) + '">' + esc(x.cell.who || '—') + '</span></td></tr>';
        }).join('') + '</tbody></table></div>'
        : '<p class="empty">Nothing is past its stage date.</p>') + '</section>';

    /* 4. who is carrying what */
    var peopleCard = '<section class="card"><div class="card-head"><h2>Who is on what</h2>' +
      '<span class="hint">every stage still to do, by the person responsible</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Stages still to do</th>' +
      '<th>In progress now</th><th>Overdue</th></tr></thead><tbody>' +
      people.map(function (p) {
        return '<tr><td class="client-cell">' + esc(p.person) + '</td>' +
          '<td class="note">' + esc(roleName(p.person) || '—') + '</td>' +
          '<td class="num">' + p.open + '</td>' +
          '<td class="num">' + (p.active ? chip('active', String(p.active), '▶') : '0') + '</td>' +
          '<td class="num">' + (p.overdue ? chip('risk', String(p.overdue), '!') : '0') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<p class="hint" style="margin-top:10px">Counts every stage not yet complete, using the agreed owner where one ' +
      'has been set and the standard build’s role where it has not — which is why only roles appear until someone types a name. '  + 'Type a person into any cell of the grid below (Ben, for instance) and they appear here. A stage owned by two people counts for both.</p>' +
      '</section>';

    /* 5. the grid: courses down the side, stages across the top */
    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search course, owner or notes…" value="' + esc(f.q) + '" aria-label="Search courses">' +
      select('fpriority', 'All priorities', uniq(all.map(function (c) { return c.priority; })).map(function (p) { return { value: p, label: p }; }), f.priority) +
      select('fperson', 'Anyone responsible', people.map(function (p) {
        return { value: p.person, label: p.person + (roleName(p.person) ? ' — ' + roleName(p.person) : '') };
      }), f.person) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' courses</span></div>';

    var headCells = stages.map(function (name, i) {
      return '<th class="stage-col"><span class="stage-col-n">' + (i + 1) + '</span>' + esc(name) +
        '<small>' + esc(m.roles[i] || '') + ' · ' + (m.days[i] || 0) + 'd</small></th>';
    }).join('');

    var gridRows = list.map(function (c) {
      var plan = coursePlan(c), saved = stagePlanFor(c.name);
      var cells = c.steps.map(function (st, i) {
        var cell = stageCell(c, i, plan, saved, m);
        return '<td class="grid-cell ' + st.key + (cell.overdue ? ' overdue' : '') + '"' +
          ' data-tip="' + esc(c.name + ' — ' + (i + 1) + '. ' + st.name + ' — ' + (st.label || 'not started')) + '">' +
          '<input type="date" class="stage-due" data-course="' + esc(c.name) + '" data-stage="' + i + '" value="' +
          esc(cell.due ? isoDate(cell.due) : '') + '"' + (saved[i] && saved[i].due ? '' : ' data-suggested="1"') + '>' +
          '<input type="text" class="stage-who" data-course="' + esc(c.name) + '" data-stage="' + i + '" value="' +
          esc(cell.who) + '" placeholder="who"' + (saved[i] && saved[i].who ? '' : ' data-suggested="1"') + '>' +
          statusPicker(c.name, i, st, true) +
          '</td>';
      }).join('');
      return '<tr><th class="course-col"><a href="' + courseHref(c.name) + '">' + esc(c.name) + '</a>' +
        '<small>' + esc(c.priority) + ' · ' + esc(c.target || 'no target') + (c.owner ? ' · ' + esc(c.owner) : '') + '</small>' +
        '<button class="btn btn-sm" data-edit-course="' + esc(c.name) + '">' +
        (state.filters.editingCourse === c.name ? 'Close' : 'Edit') + '</button></th>' + cells + '</tr>' +
        courseEditor(c, stages.length + 1);
    }).join('');

    var gridCard = '<section class="card"><div class="card-head"><h2>Every course, every stage</h2>' +
      '<span class="hint">date and person for each — grey is suggested, type to agree it</span></div>' +
      (list.length
        ? '<div class="table-wrap grid-scroll"><table class="stage-grid"><thead><tr><th class="course-col">Course</th>' +
        headCells + '</tr></thead><tbody>' + gridRows + '</tbody></table></div>'
        : '<p class="empty">No courses match those filters.</p>') +
      stepLegend(false) + '</section>';

    var footnotes = (state.data.courses.footnotes || []).map(function (n) {
      return '<div class="banner info"><span aria-hidden="true">ℹ</span><div>' + esc(n) + '</div></div>';
    }).join('');

    var colourKey = '<section class="card" style="margin-bottom:16px">' +
      '<div class="card-head"><h2>What the colours mean</h2>' +
      '<span class="hint">the same colours are used on every page</span></div>' +
      stepLegend(true) + '</section>';

    return strip + colourKey + addForm('course') + '<div style="height:16px"></div>' +
      ruleNote('<b>Build order:</b> ' + esc(PRIORITY_RULE_BUILD)) +
      '<div class="grid two">' + highCard + overdueCard + '</div>' +
      '<div style="height:16px"></div>' + peopleCard +
      '<div style="height:16px"></div>' + slipLogCard() +
      '<div style="height:16px"></div>' + filters + gridCard +
      '<div style="height:16px"></div>' + staffingCard() +
      '<div style="height:16px"></div>' + buildModelCard() +
      '<div style="height:16px"></div>' + archiveCard('courses') +
      (footnotes ? '<div style="margin-top:16px">' + footnotes + '</div>' : '');
  };

  /* ---------- detail pages ----------
     Click any client or course name and land here: everything held on it, all of
     it editable, at a URL you can send to someone. Archived items still open, so
     nothing becomes unreachable. */
  function backLink(href, label) {
    return '<a class="back-link" href="' + href + '">&larr; ' + esc(label) + '</a>';
  }
  function clientHref(name) { return '#/client/' + encodeURIComponent(name); }
  function courseHref(name) { return '#/course/' + encodeURIComponent(name); }

  views.client = function () {
    var name = state.routeParam;
    var d = allDeals().filter(function (x) { return x.client === name; })[0];
    var plan = plans().filter(function (p) { return p.client === name; })[0];
    var linked = courses().filter(function (c) { return (dealForCourse(c, deals()) || {}).client === name; });

    if (!d && !plan) {
      return backLink('#/pipeline', 'Back to the sales pipeline') +
        '<p class="empty">No client called “' + esc(name || '') + '” on the pipeline or the stage plans.</p>';
    }

    var stepOptions = PROCESS.filter(function (p) { return !p.gate; }).map(function (p) {
      return '<option value="' + p.id + '"' + (d && currentStepOf(d) === p.id ? ' selected' : '') + '>' +
        esc(p.id + '. ' + p.name) + '</option>';
    }).join('');

    var editor = d
      ? '<section class="card"><div class="card-head"><h2>Edit this client</h2>' +
      '<span class="hint">saved as you change each field</span></div>' +
      '<div class="editor">' +
      '<div class="editor-grid">' +
      '<label>Step on the process<select class="ed-step" data-client="' + esc(d.client) + '">' + stepOptions + '</select></label>' +
      '<label>Priority<select class="ed-priority" data-client="' + esc(d.client) + '">' +
      EDIT_PRIORITIES.map(function (p) {
        return '<option' + (String(d.priority).toLowerCase() === p.toLowerCase() ? ' selected' : '') + '>' + p + '</option>';
      }).join('') + '</select></label>' +
      '<label>Target go-live<input type="text" class="ed-target" data-client="' + esc(d.client) + '" value="' +
      esc(d.target || '') + '" placeholder="e.g. Q4 2026"></label>' +
      '</div>' +
      '<label class="editor-notes">Next action / notes<textarea class="ed-notes" data-client="' + esc(d.client) + '">' +
      esc(d.notes || '') + '</textarea></label>' +
      '<div class="editor-actions">' +
      (d.archived
        ? '<button class="btn primary" data-restore-deal="' + esc(d.client) + '">Restore from archive</button>'
        : '<button class="btn" data-archive-deal="' + esc(d.client) + '">Archive this client</button>') +
      (d.edited && d.edited.length ? '<span class="hint">Edited here: ' + esc(d.edited.join(', ')) +
        (d.editedAt ? ' · ' + esc(dateLabel(d.editedAt)) : '') + '</span>' : '<span class="hint">Nothing changed here yet — all of it still comes from the spreadsheet.</span>') +
      '</div></div></section>'
      : '';

    var facts = d
      ? '<section class="card"><div class="card-head"><h2>Where this client is</h2></div>' +
      '<div class="item-meta">' +
      '<span>Process step: <b>' + esc((PROCESS.filter(function (p) { return p.id === currentStepOf(d); })[0] || {}).name || '—') + '</b></span>' +
      '<span>Tracker stage: <b>' + esc(d.stageLabel || d.stage || '—') + '</b></span>' +
      '<span>Vertical: <b>' + esc(d.vertical) + '</b></span>' +
      '<span>Priority: <b>' + esc(d.priority) + '</b></span>' +
      '<span>Target: <b>' + esc(d.target || 'not set') + '</b></span>' +
      (d.ref ? '<span>Tracker ref: <b>' + esc(d.ref) + '</b></span>' : '') +
      '</div>' +
      (d.notes ? '<p class="note" style="margin-top:10px">' + esc(d.notes) + '</p>' : '') +
      (d.flags && d.flags.length ? '<div class="chips" style="margin-top:10px">' + flagChips(d.flags) + '</div>' : '') +
      '</section>'
      : '';

    var planCard = plan
      ? '<section class="card"><div class="card-head"><h2>Milestones</h2>' +
      '<span class="hint">from the Deal Stage Plans sheet</span></div>' +
      stepStrip(plan.steps, true) + progressBar(plan.progress, plan.stepsDone + '/' + plan.stepCount + ' complete') +
      (plan.notes ? '<p class="note">' + esc(plan.notes) + '</p>' : '') + '</section>'
      : '';

    var courseCard = linked.length
      ? '<section class="card"><div class="card-head"><h2>Courses for this client</h2>' +
      '<span class="hint">' + linked.length + ' matched to them</span></div>' +
      '<div class="list">' + linked.map(function (c) {
        return '<div class="list-row"><div class="lr-main">' +
          '<a class="lr-title" href="' + courseHref(c.name) + '">' + esc(c.name) + '</a>' +
          '<div class="lr-sub">' + esc(c.currentStage) + ' · ' + c.stagesDone + '/' + c.stageCount + ' stages</div></div>' +
          '<div class="lr-side">' + targetChip(c.target, c.targetSort, c.provisional) + '</div></div>';
      }).join('') + '</div></section>'
      : '';

    return backLink('#/pipeline', 'Back to the sales pipeline') +
      (d && d.archived ? '<div class="banner"><span aria-hidden="true">⚠</span><div>This client is archived — hidden from every list and count until restored.</div></div>' : '') +
      editor + '<div style="height:16px"></div>' +
      '<div class="grid two">' + facts + planCard + '</div>' +
      (courseCard ? '<div style="height:16px"></div>' + courseCard : '');
  };

  views.course = function () {
    var name = state.routeParam;
    var c = allCourses().filter(function (x) { return x.name === name; })[0];
    if (!c) {
      return backLink('#/courses', 'Back to course builds') +
        '<p class="empty">No course called “' + esc(name || '') + '” on the build tracker.</p>';
    }

    var m = buildModel();
    var plan = coursePlan(c);
    var saved = stagePlanFor(c.name);
    var tier = buildTier(c, liveDeals());
    var tierMeta = BUILD_TIERS[tier.tier];
    var linkedDeal = tier.deal;

    var editor = '<section class="card"><div class="card-head"><h2>Edit this course</h2>' +
      '<span class="hint">saved as you change each field</span></div>' +
      '<div class="editor">' +
      '<div class="editor-grid">' +
      '<label>Priority<select class="ec-priority" data-course-name="' + esc(c.name) + '">' +
      ['HIGH', 'MEDIUM', 'LOW', 'UNSET'].map(function (p) {
        return '<option' + (String(c.priority).toUpperCase() === p ? ' selected' : '') + '>' + p + '</option>';
      }).join('') + '</select></label>' +
      '<label>Go-live target<input type="text" class="ec-target" data-course-name="' + esc(c.name) + '" value="' +
      esc(c.target || '') + '" placeholder="e.g. End Oct 2026"></label>' +
      '<label>Owner<input type="text" class="ec-owner" data-course-name="' + esc(c.name) + '" value="' +
      esc(c.owner || '') + '" placeholder="e.g. AQ/OM"></label>' +
      '</div>' +
      '<label class="editor-notes">Notes / blockers<textarea class="ec-notes" data-course-name="' + esc(c.name) + '">' +
      esc(c.notes || '') + '</textarea></label>' +
      '<div class="editor-actions">' +
      (c.archived
        ? '<button class="btn primary" data-restore-course="' + esc(c.name) + '">Restore from archive</button>'
        : '<button class="btn" data-archive-course="' + esc(c.name) + '">Archive this course</button>') +
      (c.edited && c.edited.length ? '<span class="hint">Edited here: ' + esc(c.edited.join(', ')) +
        (c.editedAt ? ' · ' + esc(dateLabel(c.editedAt)) : '') + '</span>' : '<span class="hint">Nothing changed here yet — all of it still comes from the spreadsheet.</span>') +
      '</div></div></section>';

    var stageRows = c.steps.map(function (st, i) {
      var cell = stageCell(c, i, plan, saved, m);
      return '<tr' + (cell.overdue ? ' class="row-late"' : '') + '>' +
        '<td class="num">' + (i + 1) + '</td><td>' + esc(st.name) + '</td>' +
        '<td>' + statusPicker(c.name, i, st) + '</td>' +
        '<td><input type="date" class="stage-due" data-course="' + esc(c.name) + '" data-stage="' + i + '" value="' +
        esc(cell.due ? isoDate(cell.due) : '') + '"' + (saved[i] && saved[i].due ? '' : ' data-suggested="1"') + '></td>' +
        '<td><input type="text" class="stage-who" data-course="' + esc(c.name) + '" data-stage="' + i + '" value="' +
        esc(cell.who) + '" placeholder="who"' + (saved[i] && saved[i].who ? '' : ' data-suggested="1"') + '></td>' +
        '<td class="num">' + (m.days[i] || 0) + 'd</td>' +
        '<td>' + (cell.overdue ? chip('risk', 'Overdue', '!') : (cell.agreed ? chip('done', 'Agreed', '✓') : chip('ghost', 'Suggested'))) + '</td>' +
        '</tr>';
    }).join('');

    var stagesCard = '<section class="card"><div class="card-head"><h2>The ten stages</h2>' +
      '<span class="hint">grey values are suggestions from the standard build — type to agree them</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>#</th><th>Stage</th><th>Status</th>' +
      '<th>Date</th><th>Responsible</th><th>Days</th><th></th></tr></thead><tbody>' + stageRows + '</tbody></table></div>' +
      '</section>';

    var verdict = plan.target
      ? (plan.shortfall > 0
        ? chip('risk', plan.remainingDays + ' days of build left, ' + plan.available + ' working days to the target — short by ' + plan.shortfall, '!')
        : chip('done', plan.remainingDays + ' days of build left, ' + plan.available + ' working days available', '✓'))
      : chip('wait', 'No go-live target set');

    var facts = '<section class="card"><div class="card-head"><h2>Where this build is</h2></div>' +
      '<div class="chips" style="margin-bottom:10px">' + chip(tierMeta.kind, tierMeta.glyph + '. ' + tierMeta.label) +
      priorityChip(c.priority) + targetChip(c.target, c.targetSort, c.provisional) + '</div>' +
      '<p class="note">' + esc(tier.why) + '</p>' +
      (linkedDeal ? '<p class="note">Client: <a href="' + clientHref(linkedDeal.client) + '">' + esc(linkedDeal.client) + '</a></p>' : '') +
      progressBar(c.progress, c.stagesDone + '/' + c.stageCount + ' stages complete') +
      '<div class="chips" style="margin-top:10px">' + verdict + '</div>' +
      (plan.startBy ? '<p class="hint" style="margin-top:8px">To hold the target, the remaining work has to start by ' +
        esc(fmtDate(plan.startBy)) + '.</p>' : '') +
      (c.notes ? '<p class="note" style="margin-top:10px">' + esc(c.notes) + '</p>' : '') +
      (c.flags && c.flags.length ? '<div class="chips" style="margin-top:8px">' + flagChips(c.flags) + '</div>' : '') +
      '</section>';

    return backLink('#/courses', 'Back to course builds') +
      (c.archived ? '<div class="banner"><span aria-hidden="true">⚠</span><div>This course is archived — hidden from every list and count until restored.</div></div>' : '') +
      '<div class="grid two">' + facts + editor + '</div>' +
      '<div style="height:16px"></div>' + stagesCard;
  };

  /* ---------- who can do what ----------
     Reading is open to anyone with the link. Editing is limited to the people on
     the editors list, which editors manage here rather than in SQL. */
  views.access = function () {
    var c = cloud();
    var s = c ? c.state : null;

    var explain = '<section class="card"><div class="card-head"><h2>How access works</h2></div>' +
      '<div class="table-wrap"><table><tbody>' +
      '<tr><td><b>Anyone with the link</b></td><td class="note">Sees every page. No account, no sign-in. ' +
      'Cannot change anything — the database refuses writes from anyone not signed in.</td></tr>' +
      '<tr><td><b>Signed in</b></td><td class="note">Anyone can create an account, which on its own changes nothing. ' +
      'They stay read-only until their address is on the editors list.</td></tr>' +
      '<tr><td><b>On the editors list</b></td><td class="note">Can change anything on the platform, and their edits ' +
      'become what everyone else sees. Can also add and remove other editors here.</td></tr>' +
      '</tbody></table></div>' +
      '<p class="hint" style="margin-top:10px">The rules are enforced by the database, not by this page, so they ' +
      'hold however someone reaches the data.</p></section>';

    if (!s || !s.ready) {
      return explain + '<div style="height:16px"></div><p class="empty">Connecting to the database…</p>';
    }
    if (!s.online) {
      return explain + '<div style="height:16px"></div>' +
        '<div class="banner"><span aria-hidden="true">⚠</span><div>Not connected to the database, so the editors ' +
        'list cannot be shown or changed right now.</div></div>';
    }
    if (!s.user) {
      return explain + '<div style="height:16px"></div>' +
        '<section class="card"><div class="card-head"><h2>Editors</h2></div>' +
        '<p class="empty">Sign in to see who can edit. <button class="btn primary" id="openSignIn">Sign in</button></p>' +
        '</section>';
    }

    var rows = (state.editors || []).map(function (e) {
      var isYou = String(e.email).toLowerCase() === String(s.user.email).toLowerCase();
      return '<tr><td class="client-cell">' + esc(e.email) +
        (isYou ? ' ' + chip('brand', 'you') : '') + '</td>' +
        '<td class="note">' + esc(e.note || '—') + '</td>' +
        '<td>' + esc(e.added_at ? dateLabel(e.added_at) : '—') + '</td>' +
        '<td>' + (e.protected
          ? chip('ghost', 'Protected')
          : (s.canEdit
            ? '<button class="btn btn-sm" data-remove-editor="' + esc(e.email) + '">Remove</button>'
            : '')) + '</td></tr>';
    }).join('');

    var list = '<section class="card"><div class="card-head"><h2>Editors</h2>' +
      '<span class="hint">' + (state.editors ? state.editors.length : 0) + ' with permission to change the platform</span></div>' +
      (state.editors && state.editors.length
        ? '<div class="table-wrap"><table><thead><tr><th>Email</th><th>Who they are</th><th>Added</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>'
        : '<p class="empty">Nobody on the list yet.</p>') +
      (state.accessMessage ? '<p class="hint" style="margin-top:10px">' + esc(state.accessMessage) + '</p>' : '') +
      '<p class="hint" style="margin-top:10px">A protected entry cannot be removed here, so the list can never be ' +
      'emptied by accident and lock everyone out.</p>' +
      '</section>';

    var addBox = s.canEdit
      ? '<section class="card"><div class="card-head"><h2>Give someone editing rights</h2>' +
      '<span class="hint">they also need to create an account with this address</span></div>' +
      '<div class="filters" style="margin-bottom:0">' +
      '<input type="email" id="newEditorEmail" placeholder="name@fideo-global.com" style="min-width:250px">' +
      '<input type="text" id="newEditorNote" placeholder="who they are, e.g. Andrew — course builds" style="min-width:250px">' +
      '<button class="btn primary" id="addEditor">Add editor</button>' +
      '</div>' +
      '<p class="hint" style="margin-top:10px">Adding an address here does not create the account. They sign up ' +
      'themselves from the top of any page; once their address is on this list, their next sign-in can edit.</p>' +
      '</section>'
      : '<section class="card"><div class="card-head"><h2>You are read-only</h2></div>' +
      '<p class="note">You are signed in as ' + esc(s.user.email) + ' but not on the editors list, so you can see ' +
      'everything and change nothing. Ask one of the editors above to add you.</p></section>';

    var backup = s.canEdit
      ? '<div style="height:16px"></div>' +
        '<section class="card"><div class="card-head"><h2>Backup</h2>' +
        '<span class="hint">a copy of everything, as a file</span></div>' +
        '<p class="note">Everything is saved in the shared database as you work. This downloads a snapshot, ' +
        'if you want one kept off-site or taken before a big change.</p>' +
        '<button class="btn" id="downloadData">Download a backup</button></section>'
      : '';
    return explain + '<div style="height:16px"></div>' + list + '<div style="height:16px"></div>' + addBox + backup;
  };

  views.projects = function () {
    var all = projects().filter(function (p) { return p.name; });
    var f = state.filters.projects = state.filters.projects || { q: '', status: '' };
    var list = all.filter(function (p) {
      if (f.status && p.status !== f.status) return false;
      if (f.q && (p.name + ' ' + p.description + ' ' + p.notes + ' ' + p.nextStep).toLowerCase().indexOf(f.q.toLowerCase()) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var w = function (p) { return /progress/i.test(p.status) ? 0 : 1; };
      return w(a) - w(b) || (a.targetSort || 999999) - (b.targetSort || 999999);
    });

    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search projects…" value="' + esc(f.q) + '" aria-label="Search projects">' +
      select('fstatus', 'All statuses', uniq(all.map(function (p) { return p.status; })).map(function (s) { return { value: s, label: s }; }), f.status) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' projects</span></div>';

    var cards = list.map(function (p) {
      var gaps = [];
      if (!p.lead) gaps.push('No lead');
      if (!p.nextStep) gaps.push('No next step');
      if (!p.target) gaps.push('No target date');
      var statusKind = /progress/i.test(p.status) ? 'active' : (/complete|live/i.test(p.status) ? 'done' : 'wait');
      var statusGlyph = statusKind === 'active' ? '▶' : (statusKind === 'done' ? '✓' : '○');
      return '<article class="item' + (gaps.length ? ' attention' : '') + '">' +
        '<div class="item-head"><h3>' + esc(p.name) + '</h3>' + chip(statusKind, p.status, statusGlyph) + '</div>' +
        (p.description ? '<p class="note">' + esc(p.description) + '</p>' : '') +
        '<div class="item-meta">' +
        '<span>Lead: <b>' + esc(p.lead || 'unassigned') + '</b></span>' +
        (p.target ? '<span>Target: <b>' + esc(p.target) + '</b></span>' : '') +
        '</div>' +
        (p.nextStep ? '<p class="note"><b>Next step:</b> ' + esc(p.nextStep) + '</p>' : '') +
        (p.notes ? '<p class="note">' + esc(p.notes) + '</p>' : '') +
        (gaps.length || p.flags.length ? '<div class="chips">' + gaps.map(function (g) { return chip('wait', g); }).join('') + flagChips(p.flags) + '</div>' : '') +
        '</article>';
    }).join('');

    return filters + (list.length ? '<div class="grid cards">' + cards + '</div>' : '<p class="empty">No projects match those filters.</p>');
  };

  /* Which stage is this item sitting at? Used to break the long card walls into
     sections, so you can read a page by stage rather than scrolling everything. */
  function stageBucket(steps, done, total) {
    for (var i = 0; i < steps.length; i++) if (steps[i].key === 'active') return { order: i, index: i, live: true };
    if (total && done === total) return { order: 900, index: null, complete: true };
    if (steps.every(function (s) { return s.key === 'none'; })) return { order: -1, index: null, idle: true };
    for (var j = 0; j < steps.length; j++) if (steps[j].key !== 'done') return { order: j, index: j, live: false };
    return { order: 901, index: null };
  }

  function updateRow(u) {
    return '<div class="tl-item"><div class="tl-date">' + esc(dateLabel(u.date)) + '<br>' + (u.tag ? chip('ghost', u.tag) : '') + '</div>' +
      '<div class="tl-body"><h3>' + esc(u.title) + '</h3><p>' + esc(u.body || '') + '</p></div></div>';
  }

  views.updates = function () {
    var list = (state.data.updates || []).slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });

    var writer = canEditShared()
      ? '<section class="card"><div class="card-head"><h2>Post an update</h2>' +
      '<span class="hint">saves for everyone straight away</span></div>' +
      '<div class="form-row"><label for="upTitle">Headline</label>' +
      '<input id="upTitle" placeholder="e.g. Crab Nebula pilot signed off"></div>' +
      '<div class="form-row"><label for="upBody">Detail</label>' +
      '<textarea id="upBody" placeholder="What happened, what it means, what happens next."></textarea></div>' +
      '<div class="form-row"><label for="upTag">Tag</label>' +
      '<input id="upTag" placeholder="Sales, Build, Ops…" value="General"></div>' +
      '<button class="btn primary" id="addUpdate">Post it</button></section>'
      : '<section class="card"><div class="card-head"><h2>Post an update</h2></div>' +
      '<p class="note">Sign in as an editor to post one.</p></section>';

    var feed = '<section class="card"><div class="card-head"><h2>Company updates</h2>' +
      '<span class="hint">' + list.length + ' posted</span></div>' +
      (list.length ? '<div class="timeline">' + list.map(updateRow).join('') + '</div>'
        : '<p class="empty">Nothing posted yet.</p>') +
      '</section>';

    return '<div class="grid two">' + feed + writer + '</div>';
  };

  views.key = function () {
    var stages = (state.data.courses.stageNames || []);
    var milestones = (state.data.dealPlans && state.data.dealPlans.stageNames) || [];

    var roleRows = ROLES.map(function (r) {
      return '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td class="note">' + esc(r[2]) + '</td></tr>';
    }).join('');

    var flagRows = [
      ['Waiting on others', 'the note says awaiting, waiting on or waiting for something'],
      ['Pending', 'the note contains “pending”'],
      ['Contract / sign-off', 'the note mentions a contract, agreement, sign-off, MOA or a tender dependency'],
      ['Stalled', 'the note says frozen, inactive, idle, dead, “no further updates” or “not much traction”'],
      ['Needs chasing', 'the note says chase, nudge, follow up or reach out'],
      ['Under review', 'the note says under review, review needed, QA needed or feasibility'],
      ['Revenue unquantified', 'the note says unquantified, revenue TBC, “need to price” or “commercialise”']
    ].map(function (f) {
      return '<tr><td>' + chip('wait', f[0]) + '</td><td class="note">Shown when ' + esc(f[1]) + '.</td></tr>';
    }).join('');

    return '<div class="banner info"><span aria-hidden="true">ℹ</span><div>' +
      'Everything on this platform is counted from two spreadsheets — the Course Build Tracker and the Sales Pipeline Tracker. ' +
      'Nothing is estimated. Where something is worked out rather than recorded, it says so on the page and is explained here.' +
      '</div></div>' +

      '<section class="card"><div class="card-head"><h2>Who the initials are</h2>' +
      '<span class="hint">from the ownership key in the process diagram</span></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Initials</th><th>Role</th><th>Responsible for</th></tr></thead>' +
      '<tbody>' + roleRows + '</tbody></table></div></section>' +

      '<div style="height:16px"></div>' +
      '<div class="grid two">' +
      '<section class="card"><div class="card-head"><h2>The ten build stages</h2>' +
      '<span class="hint">every course runs through these in order</span></div>' +
      '<ol class="plain-list">' + stages.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="hint">A course is shown at the first stage marked in progress. If none is in progress, ' +
      'it is shown at the next stage still to be done.</p></section>' +

      '<section class="card"><div class="card-head"><h2>The five deal milestones</h2>' +
      '<span class="hint">from the Deal Stage Plans sheet</span></div>' +
      '<ol class="plain-list">' + milestones.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      '<p class="hint">Separate from the six-stage pipeline column, which is what the process strip on the ' +
      'Overview uses.</p></section></div>' +

      '<div style="height:16px"></div>' +
      '<section class="card"><div class="card-head"><h2>What the marks mean</h2></div>' +
      '<div class="table-wrap"><table><tbody>' +
      '<tr><td><span class="step done">✓</span></td><td><b>Complete</b></td><td class="note">The tracker cell says Complete.</td></tr>' +
      '<tr><td><span class="step active">▶</span></td><td><b>In progress</b></td><td class="note">The cell says In Progress, WIP, Started, Scoping or Proposal Submitted.</td></tr>' +
      '<tr><td><span class="step pending">○</span></td><td><b>To be confirmed</b></td><td class="note">The cell says TBC or Pending.</td></tr>' +
      '<tr><td><span class="step none">·</span></td><td><b>Blank</b></td><td class="note">The cell is empty — not started, or not applicable to this course.</td></tr>' +
      '<tr><td>' + chip('risk', 'Mar 2026', '!') + '</td><td><b>Date passed</b></td><td class="note">The target date has gone by and the work is not finished.</td></tr>' +
      '<tr><td>' + chip('amber', 'Aug 2026') + '</td><td><b>Due soon</b></td><td class="note">Target date falls within the next two months.</td></tr>' +
      '<tr><td>' + chip('ghost', 'Q4 2026 (provisional)') + '</td><td><b>Provisional</b></td><td class="note">Marked with an asterisk in the tracker — subject to contract signing.</td></tr>' +
      '</tbody></table></div></section>' +

      '<div style="height:16px"></div>' +
      '<section class="card"><div class="card-head"><h2>Flags read from the notes column</h2>' +
      '<span class="hint">worked out from wording, not recorded as data</span></div>' +
      '<div class="table-wrap"><table><tbody>' + flagRows + '</tbody></table></div>' +
      '<p class="hint" style="margin-top:10px">These are a reading aid, not a status. If a flag looks wrong, ' +
      'the wording in the tracker is what to change.</p></section>' +

      '<div style="height:16px"></div>' +
      '<div class="grid two">' +
      '<section class="card"><div class="card-head"><h2>How sales priority is worked out</h2></div>' +
      ruleNote(esc(PRIORITY_RULE_SALES)) +
      '<p class="note">Each deal scores half on how close it is to completion (its stage out of six) and half on ' +
      'revenue potential. Revenue is log-scaled, so one very large deal does not push everything else to the bottom. ' +
      'Deals with no revenue figure score zero on that half and are labelled, rather than being quietly ranked last. ' +
      'Deals marked Dead are left out.</p></section>' +

      '<section class="card"><div class="card-head"><h2>How build priority is worked out</h2></div>' +
      ruleNote(esc(PRIORITY_RULE_BUILD)) +
      '<p class="note">Courses are matched to a pipeline client by name to decide which band they fall in. ' +
      'The match is printed on every course card so a wrong one is obvious. Known shorthand is linked deliberately: ' +
      '<b>PFAI</b> to Ireland Professional Players Assoc., <b>CU</b> to Credit Unions, and ' +
      '<b>EirGrid</b> to Analytics Institute — the last of these because the build tracker itself notes ' +
      '“Analytics Institute now named EirGrid”.</p></section></div>' +

      '<div style="height:16px"></div>' +
      '<section class="card"><div class="card-head"><h2>Where the data comes from</h2></div>' +
      '<div class="list">' +
      '<div class="list-row"><div class="lr-main"><div class="lr-title">Course Build Tracker</div>' +
      '<div class="lr-sub">Course builds and the project register</div></div>' +
      '<div class="lr-side">as at ' + esc(state.data.courses.asAt || 'unknown') + '</div></div>' +
      '<div class="list-row"><div class="lr-main"><div class="lr-title">Sales Pipeline Tracker</div>' +
      '<div class="lr-sub">Deals, deal stage plans and the funnel summary</div></div>' +
      '<div class="lr-side">as at ' + esc(state.data.pipeline.asAt || 'unknown') + '</div></div>' +
      '</div>' +
      '<p class="hint" style="margin-top:12px">Both are read straight from the spreadsheets. Anything this platform ' +
      'works out for itself — process placement, priority order, flags, capacity — is explained on this page.</p>' +
      '</section>';
  };



  /* ---------- per-course stage plans ----------
     Each course needs a date and a named person for all ten stages. The standard
     build gives every stage a suggested date (worked back from the go-live
     target) and a suggested role, so nobody starts from a blank grid. Anything
     typed here overrides the suggestion and is marked as agreed. */
  function statusPicker(courseName, index, step, compact) {
    var overridden = !!(stagePlanFor(courseName)[index] || {}).status;
    return '<select class="stage-status' + (compact ? ' compact' : '') + '"' +
      ' data-course="' + esc(courseName) + '" data-stage="' + index + '"' +
      (overridden ? '' : ' data-suggested="1"') +
      ' title="' + esc(overridden ? 'Set here' : 'From the spreadsheet') + '">' +
      STAGE_STATUSES.map(function (o) {
        return '<option value="' + o.value + '"' + (step.key === o.value ? ' selected' : '') + '>' +
          esc(compact ? o.glyph + ' ' + o.label : o.label) + '</option>';
      }).join('') +
      (overridden ? '<option value="">— back to spreadsheet —</option>' : '') +
      '</select>';
  }

  function stagePlanFor(courseName) {
    var all = state.data.stagePlans || {};
    return all[courseName] || {};
  }
  function clearStagePlan(courseName, index, field) {
    var data = JSON.parse(JSON.stringify(state.data));
    if (data.stagePlans && data.stagePlans[courseName] && data.stagePlans[courseName][index]) {
      delete data.stagePlans[courseName][index][field];
      savePreview(data);
    }
  }
  function setStagePlan(courseName, index, field, value) {
    var data = JSON.parse(JSON.stringify(state.data));
    data.stagePlans = data.stagePlans || {};
    data.stagePlans[courseName] = data.stagePlans[courseName] || {};
    data.stagePlans[courseName][index] = data.stagePlans[courseName][index] || {};
    data.stagePlans[courseName][index][field] = value;
    data.stagePlans[courseName][index].setAt = new Date().toISOString().slice(0, 10);
    savePreview(data);
  }
  function isoDate(d) {
    if (!d) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  /* ---------- accountability ----------
     Every time a go-live target moves between one import and the next it is
     recorded here, with the reason and who agreed it. Blank reasons are kept and
     shown as unexplained rather than quietly dropped — that is the point of it. */
  function slips() { return (state.data.history && state.data.history.slips) || []; }

  function targetChangesBetween(oldD, newD) {
    var before = {}, out = [];
    ((oldD.courses && oldD.courses.items) || []).forEach(function (c) { if (c.name) before[c.name] = c; });
    ((newD.courses && newD.courses.items) || []).forEach(function (c) {
      if (!c.name || !before[c.name]) return;
      var was = before[c.name].target || '', now = c.target || '';
      if (was !== now) {
        out.push({
          course: c.name, from: was || 'none', to: now || 'none',
          owner: c.owner || before[c.name].owner || '', priority: c.priority
        });
      }
    });
    return out;
  }

  /* ---------- importer ---------- */
  function serialise(data) {
    return '/* Fideo Global dashboard data — generated ' + new Date().toISOString() + '\n' +
      '   Regenerate by uploading a tracker on the "Update data" tab, or run: node tools/seed.js */\n' +
      'window.FIDEO_DATA = ' + JSON.stringify(data, null, 2) + ';\n';
  }
  function download(filename, text) {
    var blob = new Blob([text], { type: 'text/javascript;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ---------- chrome ---------- */
  var TITLES = {
    overview: ['Overview', 'The whole company on one screen'],
    pipeline: ['Sales pipeline', 'Every live deal, its stage and its value'],
    customers: ['Customer status', 'Who is live, who is nearly live, and the detail behind each'],
    courses: ['Course builds', 'Where every programme is in the ten-stage build'],
    projects: ['Projects', 'Pre-pipeline opportunities and who owns them'],
    updates: ['Updates', 'What has changed lately'],
    client: ['Client', 'Everything we hold on this client'],
    course: ['Course build', 'Everything we hold on this course'],
    access: ['Access', 'Who can see this, and who can change it'],
    key: ['Key', 'What every symbol, initial and worked-out label on this platform means'],
    'import': ['Update data', 'Upload a tracker and publish the new numbers']
  };

  function renderChrome() {
    var t = TITLES[state.route] || TITLES.overview;
    if (state.route === 'client' || state.route === 'course') {
      $('#pageTitle').textContent = state.routeParam || t[0];
      $('#pageSub').textContent = state.route === 'client' ? 'Client — everything we hold, all of it editable'
        : 'Course build — everything we hold, all of it editable';
    } else {
      $('#pageTitle').textContent = t[0];
      $('#pageSub').textContent = t[1];
    }
    $$('.nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === state.route);
    });

    var courseAsAt = state.data.courses && state.data.courses.asAt;
    var pipeAsAt = state.data.pipeline && state.data.pipeline.asAt;
    $('#sidebarAsAt').innerHTML = '<b>Builds: ' + esc(courseAsAt || 'unknown') + '</b><b>Pipeline: ' + esc(pipeAsAt || 'unknown') + '</b>';
    $('#footStamp').textContent = state.data.meta && state.data.meta.generatedAt
      ? 'Data file generated ' + dateLabel(state.data.meta.generatedAt) : '';

    $('#topbarRight').innerHTML =
      (state.isPreview ? '<span class="chip amber"><span class="glyph">●</span>Local preview — not published</span>' : '') +
      saveChip() + signInPanel();
  }

  function render() {
    loadRoute();
    renderChrome();
    if (state.route === 'access' && cloud() && cloud().state.user && !state.editorsLoading && !state.editors) {
      state.editorsLoading = true;
      cloud().listEditors().then(function (list) {
        state.editors = list;
        state.editorsLoading = false;
        render();
      });
    }
    var view = views[state.route] || views.overview;
    var main = $('#main');
    main.innerHTML = recoveryPanel() + slipPrompt() + cloudBanner() + signInDialog() + unpublishedBanner() + view();
    bind();
  }

  function loadRoute() {
    var raw = (location.hash || '#/overview').replace(/^#\//, '');
    var parts = raw.split('/');
    var head = parts[0];
    if (head === 'deals') head = 'customers';
    state.routeParam = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : null;
    state.route = views[head] ? head : 'overview';
  }

  function bind() {
    var main = $('#main');

    var fq = $('#fq', main);
    if (fq) {
      fq.addEventListener('input', debounce(function () {
        state.filters[state.route].q = fq.value;
        var pos = fq.selectionStart;
        render();
        var again = $('#fq');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      }, 180));
    }
    [['fband', 'band'], ['fstage', 'stage'], ['fpriority', 'priority'], ['fvertical', 'vertical'], ['fstatus', 'status'], ['fgroup', 'groupBy'], ['fperson', 'person']].forEach(function (pair) {
      var el = $('#' + pair[0], main);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters[state.route][pair[1]] = el.value;
        render();
      });
    });

    $$('.pstep', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-step');
        var stage = btn.getAttribute('data-stage');
        if (id !== null && id !== undefined) {
          state.filters.overviewStep = state.filters.overviewStep === id ? null : id;
        } else if (stage !== null && stage !== undefined) {
          state.filters.overviewStage = state.filters.overviewStage === stage ? null : stage;
        }
        render();
        var sel = id != null ? '.pstep[data-step="' + id + '"]' : '.pstep[data-stage="' + stage + '"]';
        var again = $(sel);
        if (again) again.focus();
      });
    });

    $$('th.sortable', main).forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        var s = state.sort.pipeline;
        if (s.key === key) s.dir = -s.dir;
        else { s.key = key; s.dir = key === 'client' || key === 'vertical' ? 1 : -1; }
        render();
      });
    });

    /* --- dragging clients up and down the priority list ---
       The arrows stay for keyboards and touch screens, where HTML5 dragging
       either does not fire or is painful. */
    (function () {
      var rows = $$('.list-row.draggable', main);
      if (!rows.length) return;
      var dragged = null;

      function clearMarks() {
        rows.forEach(function (r) { r.classList.remove('drop-above', 'drop-below', 'dragging'); });
      }
      function isAfter(row, clientY) {
        var rect = row.getBoundingClientRect();
        return (clientY - rect.top) > rect.height / 2;
      }

      rows.forEach(function (row) {
        row.addEventListener('dragstart', function (e) {
          dragged = row.getAttribute('data-client') || row.getAttribute('data-course');
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', dragged); } catch (err) { /* older browsers */ }
        });
        row.addEventListener('dragend', clearMarks);
        row.addEventListener('dragover', function (e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if ((row.getAttribute('data-client') || row.getAttribute('data-course')) === dragged) return;
          var after = isAfter(row, e.clientY);
          row.classList.toggle('drop-below', after);
          row.classList.toggle('drop-above', !after);
        });
        row.addEventListener('dragleave', function () {
          row.classList.remove('drop-above', 'drop-below');
        });
        row.addEventListener('drop', function (e) {
          e.preventDefault();
          var from = dragged;
          try { from = e.dataTransfer.getData('text/plain') || dragged; } catch (err) { /* ignore */ }
          var isCourse = !!row.getAttribute('data-course');
          var target = row.getAttribute('data-client') || row.getAttribute('data-course');
          var after = isAfter(row, e.clientY);
          clearMarks();
          dragged = null;
          if (isCourse) dropCourseBefore(from, target, after);
          else dropDealBefore(from, target, after);
          render();
        });
      });
    })();

    on('#downloadLocal', 'click', function () {
      if (state.pendingLocal) download('dashboard-unpublished-local.js', serialise(state.pendingLocal));
    });
    on('#discardLocal', 'click', function () {
      if (!confirm('Discard the unshared changes on this device? Download them first if they matter.')) return;
      try { localStorage.removeItem(PREVIEW_KEY); } catch (err) { /* ignore */ }
      state.pendingLocal = null;
      render();
    });
    on('#addEditor', 'click', function () {
      var email = $('#newEditorEmail').value.trim();
      var note = $('#newEditorNote').value.trim();
      if (!email || email.indexOf('@') === -1) { state.accessMessage = 'Enter a valid email address.'; render(); return; }
      state.accessMessage = 'Adding…'; render();
      cloud().addEditor(email, note).then(function (res) {
        state.accessMessage = res.ok ? email + ' can now edit, once they sign in.' : res.message;
        state.editors = null;
        render();
      });
    });
    $$('[data-remove-editor]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var email = btn.getAttribute('data-remove-editor');
        var you = cloud().state.user && cloud().state.user.email;
        var warn = String(email).toLowerCase() === String(you).toLowerCase()
          ? 'Remove your own editing rights? You will be read-only until another editor adds you back.'
          : 'Remove editing rights from ' + email + '? They keep read access like everyone else.';
        if (!confirm(warn)) return;
        cloud().removeEditor(email).then(function (res) {
          state.accessMessage = res.ok ? email + ' is now read-only.' : res.message;
          state.editors = null;
          if (res.ok) cloud().refreshPermission();
          render();
        });
      });
    });
    on('#forgotPass', 'click', function () {
      var email = $('#siEmail').value.trim();
      if (!email) { state.signInMessage = 'Type your email address first, then click Forgot password.'; render(); return; }
      state.signInMessage = 'Sending...'; render();
      cloud().resetPassword(email).then(function (res) {
        state.signInMessage = res.ok
          ? 'If ' + email + ' has an account, a reset link is on its way. Open it on this device and you will be asked to set a new password.'
          : res.message;
        render();
      });
    });
    on('#saveNewPass', 'click', function () {
      var pw = $('#newPass').value;
      if (!pw || pw.length < 6) { state.recoveryMessage = 'Use at least six characters.'; render(); return; }
      state.recoveryMessage = 'Saving...'; render();
      cloud().updatePassword(pw).then(function (res) {
        state.recoveryMessage = res.ok ? null : res.message;
        if (res.ok) {
          state.showSignIn = false;
          if (location.hash.indexOf('type=recovery') !== -1) location.hash = '#/overview';
        }
        render();
        renderChrome();
      });
    });
    on('#openSignIn', 'click', function () { state.showSignIn = true; state.signInMessage = null; render(); });
    on('#cancelSignIn', 'click', function () { state.showSignIn = false; render(); });
    on('#signOut', 'click', function () {
      cloud().signOut().then(function () { state.signInMessage = null; render(); renderChrome(); });
    });
    on('#reloadShared', 'click', function () { location.reload(); });
    on('#doSignIn', 'click', function () {
      var email = $('#siEmail').value.trim(), pass = $('#siPass').value;
      if (!email || !pass) { state.signInMessage = 'Enter an email and password.'; render(); return; }
      state.signInMessage = 'Signing in…'; render();
      cloud().signIn(email, pass).then(function (res) {
        if (!res.ok) { state.signInMessage = res.message; render(); return; }
        state.signInMessage = null;
        state.showSignIn = false;
        state.saveError = null;
        cloud().load().then(function (shared) {
          if (shared && shared.meta) {
            state.data = shared;
            state.isPreview = false;
          } else if (cloud().state.online && cloud().state.canEdit) {
            /* Nobody has written the shared copy yet, so this editor's view
               becomes it. */
            state.sharedSeeded = true;
            pushToCloud(state.data);
          }
          render();
        });
      });
    });
    on('#doSignUp', 'click', function () {
      var email = $('#siEmail').value.trim(), pass = $('#siPass').value;
      if (!email || !pass) { state.signInMessage = 'Enter an email and a password of at least six characters.'; render(); return; }
      state.signInMessage = 'Creating the account…'; render();
      cloud().signUp(email, pass).then(function (res) {
        state.signInMessage = res.ok
          ? (res.needsConfirmation
            ? 'You are not signed in yet. If this address is new, check ' + email +
              ' for the confirmation link. If it already has an account, use Sign in instead — ' +
              'creating an account again does not sign you in.'
            : 'Signed in.')
          : res.message;
        render();
      });
    });

    /* --- editing clients on the sales pipeline --- */
    $$('[data-edit-deal]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var client = btn.getAttribute('data-edit-deal');
        state.filters.editingDeal = state.filters.editingDeal === client ? null : client;
        render();
      });
    });
    $$('[data-close-editor]', main).forEach(function (btn) {
      btn.addEventListener('click', function () { state.filters.editingDeal = null; render(); });
    });
    $$('[data-archive-deal]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var client = btn.getAttribute('data-archive-deal');
        if (!confirm('Archive ' + client + '? They disappear from the pipeline and every count, and can be restored from the archive at the bottom of this page.')) return;
        setOvr('deals', client, { archived: true });
        state.filters.editingDeal = null;
        render();
      });
    });
    $$('[data-restore-deal]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearOvrField('deals', btn.getAttribute('data-restore-deal'), 'archived');
        render();
      });
    });
    $$('[data-move-deal]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        moveDeal(btn.getAttribute('data-move-deal'), +btn.getAttribute('data-direction'));
        render();
      });
    });
    $$('[data-move-course]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        moveCourse(btn.getAttribute('data-move-course'), +btn.getAttribute('data-direction'));
        render();
      });
    });
    on('#resetCourseOrder', 'click', function () {
      var data = JSON.parse(JSON.stringify(state.data));
      if (data.overrides) delete data.overrides.courseOrder;
      savePreview(data);
      render();
    });
    on('#resetOrder', 'click', function () {
      var data = JSON.parse(JSON.stringify(state.data));
      if (data.overrides) delete data.overrides.dealOrder;
      savePreview(data);
      render();
    });

    [['.ed-step', 'step'], ['.ed-priority', 'priority'], ['.ed-target', 'target'], ['.ed-notes', 'notes']].forEach(function (pair) {
      $$(pair[0], main).forEach(function (el) {
        var was = el.value;
        el.addEventListener('change', function () {
          var patch = {};
          patch[pair[1]] = el.value;
          var client = el.getAttribute('data-client');
          if (pair[1] === 'target') noteTargetChange('deal', client, was, el.value, '');
          setOvr('deals', client, patch);
          render();
        });
      });
    });

    /* --- editing courses --- */
    $$('[data-edit-course]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-edit-course');
        state.filters.editingCourse = state.filters.editingCourse === name ? null : name;
        render();
      });
    });
    $$('[data-archive-course]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-archive-course');
        if (!confirm('Archive ' + name + '? It leaves the grid and every count, and can be restored from the archive at the bottom of this page.')) return;
        setOvr('courses', name, { archived: true });
        state.filters.editingCourse = null;
        render();
      });
    });
    $$('[data-restore-course]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        clearOvrField('courses', btn.getAttribute('data-restore-course'), 'archived');
        render();
      });
    });
    [['.ec-priority', 'priority'], ['.ec-target', 'target'], ['.ec-owner', 'owner'], ['.ec-notes', 'notes']].forEach(function (pair) {
      $$(pair[0], main).forEach(function (el) {
        var was = el.value;
        el.addEventListener('change', function () {
          var patch = {};
          patch[pair[1]] = el.value;
          var cname = el.getAttribute('data-course-name');
          if (pair[1] === 'target') {
            var cc = allCourses().filter(function (x) { return x.name === cname; })[0];
            noteTargetChange('course', cname, was, el.value, cc ? cc.owner : '');
          }
          setOvr('courses', cname, patch);
          render();
        });
      });
    });

    $$('.stage-status', main).forEach(function (sel) {
      sel.addEventListener('change', function () {
        var course = sel.getAttribute('data-course'), i = +sel.getAttribute('data-stage');
        if (sel.value === '') clearStagePlan(course, i, 'status');
        else setStagePlan(course, i, 'status', sel.value);
        render();
      });
    });
    $$('.stage-due', main).forEach(function (input) {
      input.addEventListener('change', function () {
        setStagePlan(input.getAttribute('data-course'), +input.getAttribute('data-stage'), 'due', input.value);
        render();
      });
    });
    $$('.stage-who', main).forEach(function (input) {
      input.addEventListener('change', function () {
        setStagePlan(input.getAttribute('data-course'), +input.getAttribute('data-stage'), 'who', input.value.trim());
        render();
      });
    });

    on('#saveModel', 'click', function () {
      var data = JSON.parse(JSON.stringify(state.data));
      var current = buildModel();
      var days = current.days.slice();
      $$('.model-days').forEach(function (input) {
        var i = +input.getAttribute('data-stage');
        var v = parseInt(input.value, 10);
        if (!isNaN(v) && v >= 0) days[i] = v;
      });
      data.buildModel = { days: days, roles: current.roles, confirmed: current.confirmed };
      savePreview(data);
      render();
    });
    on('#confirmModel', 'click', function () {
      var data = JSON.parse(JSON.stringify(state.data));
      var current = buildModel();
      data.buildModel = { days: current.days, roles: current.roles, confirmed: !current.confirmed };
      savePreview(data);
      render();
    });

    on('#clearPreview', 'click', function () {
      if (confirm('Discard the local preview and go back to the published data?')) { clearPreview(); render(); }
    });
    $$('[data-add]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.adding = btn.getAttribute('data-add') || null;
        state.addMessage = null;
        render();
      });
    });
    $$('[data-save-add]', main).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-save-add');
        var name = ($('#afName') || {}).value;
        name = (name || '').trim();
        if (!name) { state.addMessage = 'Give it a name first.'; render(); return; }
        var err;
        if (kind === 'course') {
          err = addCourse({
            name: name,
            priority: ($('#afPriority') || {}).value,
            target: (($('#afTarget') || {}).value || '').trim(),
            owner: (($('#afOwner') || {}).value || '').trim(),
            notes: (($('#afNotes') || {}).value || '').trim()
          });
        } else {
          err = addDeal({
            client: name,
            vertical: (($('#afVertical') || {}).value || '').trim(),
            step: ($('#afStep') || {}).value,
            priority: ($('#afPriority') || {}).value,
            target: (($('#afTarget') || {}).value || '').trim(),
            notes: (($('#afNotes') || {}).value || '').trim()
          });
        }
        state.addMessage = err || (name + ' added.');
        if (!err) state.adding = null;
        render();
      });
    });
    on('#saveSlip', 'click', function () { recordSlip($('#slipReason').value.trim(), $('#slipAgreed').value.trim()); });
    on('#skipSlip', 'click', function () { recordSlip('', ''); });
    on('#downloadData', 'click', function () { download('dashboard.js', serialise(state.data)); });
    on('#copyData', 'click', function () {
      navigator.clipboard.writeText(serialise(state.data)).then(function () {
        alert('Data file copied. Paste it over data/dashboard.js.');
      }, function () { alert('Could not copy — use the download button instead.'); });
    });
    on('#addUpdate', 'click', function () {
      var title = $('#upTitle').value.trim();
      if (!title) { $('#upTitle').focus(); return; }
      var data = JSON.parse(JSON.stringify(state.data));
      data.updates = data.updates || [];
      data.updates.unshift({
        date: new Date().toISOString().slice(0, 10),
        title: title,
        tag: $('#upTag').value.trim() || 'General',
        body: $('#upBody').value.trim()
      });
      savePreview(data);
      location.hash = '#/updates';
      render();
    });

    bindTooltips(main);
  }

  function on(sel, evt, fn) {
    var el = $(sel);
    if (el) el.addEventListener(evt, fn);
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  var tipEl;
  function bindTooltips(root) {
    tipEl = tipEl || $('#tooltip');
    $$('[data-tip]', root).forEach(function (el) {
      el.addEventListener('mouseenter', function () {
        tipEl.textContent = el.getAttribute('data-tip');
        tipEl.classList.add('show');
      });
      el.addEventListener('mousemove', function (e) {
        var x = Math.min(e.clientX + 14, window.innerWidth - tipEl.offsetWidth - 12);
        var y = e.clientY + 18;
        if (y + tipEl.offsetHeight > window.innerHeight) y = e.clientY - tipEl.offsetHeight - 12;
        tipEl.style.left = x + 'px';
        tipEl.style.top = y + 'px';
      });
      el.addEventListener('mouseleave', function () { tipEl.classList.remove('show'); });
    });
  }

  /* ---------- boot ---------- */
  window.addEventListener('hashchange', function () {
    render();
    $('#main').focus();
    window.scrollTo(0, 0);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      var fq = $('#fq');
      if (fq) { e.preventDefault(); fq.focus(); }
    }
  });

  /* Boot: try the shared database first, fall back to the published copy. */
  function bootstrap() {
    loadData();
    render();
    var c = cloud();
    if (!c) return;
    c.watchRecovery(function () { render(); });
    c.load().then(function (shared) {
      if (!shared && c.state.online && c.state.canEdit) {
        /* An editor arrived and the shared copy is empty: seed it from what is
           on screen, so the database stops being empty without anyone having to
           think about it. */
        state.sharedSeeded = true;
        pushToCloud(state.data);
      }
      if (shared && shared.meta) {
        var localPreview = null;
        try { localPreview = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null'); } catch (err) { localPreview = null; }
        state.data = shared;
        state.data.updates = state.data.updates || [];
        state.isPreview = false;
        /* Local work from before the database existed is kept, not thrown away:
           it stays on the device and the banner keeps asking for it to be published. */
        if (localPreview && localPreview.meta && localPreview.meta.locallyEditedAt) {
          state.pendingLocal = localPreview;
        }
      }
      render();
    });
  }

  bootstrap();
})();
