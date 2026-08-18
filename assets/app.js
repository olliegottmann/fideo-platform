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
  function stepLegend() {
    return '<div class="legend">' +
      '<span><i style="background:var(--done-mark)"></i>✓ Complete</span>' +
      '<span><i style="background:var(--active-mark)"></i>▶ In progress / WIP</span>' +
      '<span><i style="background:var(--wait-mark)"></i>○ TBC</span>' +
      '<span><i style="background:#E7E5EA"></i>· Not applicable / blank</span>' +
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
    try {
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(data));
    } catch (err) {
      alert('Could not save the preview locally (browser storage full). You can still download the data file.');
    }
    state.data = data;
    state.isPreview = true;
  }
  function clearPreview() {
    localStorage.removeItem(PREVIEW_KEY);
    loadData();
  }

  function deals() { return (state.data.pipeline && state.data.pipeline.deals) || []; }
  function courses() { return (state.data.courses && state.data.courses.items) || []; }
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
    var priWeight = { HIGH: 3, MEDIUM: 2, LOW: 1, MONITOR: 1, DEAD: 0, UNSET: 1 };

    courses().forEach(function (c) {
      if (!c.name) return;
      var why = c.flags.slice();
      if (isOverdue(c.targetSort) && c.progress < 100) why.unshift('Go-live target passed (' + c.target + ')');
      if (!why.length) return;
      out.push({
        source: 'Course build', route: '#/courses', title: c.name, why: why,
        side: c.stagesDone + '/' + c.stageCount + ' stages',
        weight: (isOverdue(c.targetSort) ? 10 : 0) + (priWeight[c.priority] || 1) * 2, key: c.targetSort
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
        weight: (isOverdue(d.targetSort) ? 8 : 0) + (priWeight[String(d.priority).toUpperCase()] || 1) * 2 + (d.stageNum || 0), key: d.targetSort
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
        subLabel: s.revenue ? moneyShort(s.revenue) : '',
        color: RAMP[Math.max(0, Math.min(5, (s.stageNum || 1) - 1))],
        tip: s.clients.slice(0, 6).join(', ') + (s.clients.length > 6 ? ' +' + (s.clients.length - 6) + ' more' : '')
      };
    });
    if (!rows.length) return '';
    return '<section class="card"><div class="card-head"><h2>' + esc(title) + '</h2>' +
      '<span class="hint">bar = number of deals · € = quantified revenue</span></div>' +
      barChart(rows) + '</section>';
  }

  function verticalCard(list) {
    var rows = byVertical(list).slice(0, 7).map(function (v) {
      return {
        label: v.name, value: v.revenue,
        valueLabel: v.revenue ? moneyShort(v.revenue) : '—',
        subLabel: v.count + (v.count === 1 ? ' deal' : ' deals'),
        tip: v.name + ': ' + money(v.revenue) + ' across ' + v.count + ' deal(s)'
      };
    });
    if (!rows.length) return '';
    return '<section class="card"><div class="card-head"><h2>Quantified revenue by vertical</h2>' +
      '<span class="hint">top 7 · deals with no € figure are not shown</span></div>' +
      barChart(rows) + '</section>';
  }

  /* ---------- views ---------- */
  var views = {};

  views.overview = function () {
    var live = liveDeals();
    var withRev = live.filter(function (d) { return d.revenue != null; });
    var build = coursesInBuild();
    var ready = courses().filter(function (c) { return c.progress === 100; });
    var soon = upcoming().filter(function (u) { var m = monthsFromNow(u.key); return m !== null && m >= 0 && m <= 3; });
    var late = upcoming().filter(function (u) { return isOverdue(u.key); });
    var attention = attentionItems();
    var inProgressProjects = projects().filter(function (p) { return /progress/i.test(p.status); });

    var kpis = '<div class="grid kpis">' +
      kpi('Quantified pipeline', moneyShort(quantified(live)), withRev.length + ' of ' + live.length + ' live deals carry a € figure', true) +
      kpi('Live deals', String(live.length), deals().length - live.length + ' marked dead or parked') +
      kpi('Courses in build', String(build.length), ready.length + ' at 10/10 stages · ' + courses().filter(function (c) { return c.name; }).length + ' tracked') +
      kpi('Due in next 3 months', String(soon.length), late.length + ' already past their target date') +
      kpi('Projects in progress', String(inProgressProjects.length), projects().length + ' in the register') +
      kpi('Needs attention', String(attention.length), 'blockers, chases and missing owners') +
      '</div>';

    var charts = '<div class="grid two">' + funnelCard(live, 'Pipeline by stage') + verticalCard(live) + '</div>';

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
        : '<p class="empty">No updates posted yet. Add one from the <a href="#/import">Update data</a> tab.</p>') +
      '</section>';

    return kpis + '<div style="height:16px"></div>' + charts + '<div style="height:16px"></div>' +
      '<div class="grid two">' + attentionList + upcomingList + '</div>' +
      '<div style="height:16px"></div>' + updatesCard;
  };

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

    var stated = state.data.pipeline.statedTotal;
    var computed = quantified(list);
    var banner = '';
    if (stated && !f.q && !f.stage && !f.priority && !f.vertical && Math.abs(stated - quantified(all)) > 1) {
      banner = '<div class="banner"><span aria-hidden="true">⚠</span><div><b>Revenue figures do not reconcile.</b> ' +
        'The deal rows below add up to <b>' + money(quantified(all)) + '</b>, but the Funnel Summary sheet states <b>' + money(stated) + '</b>. ' +
        'The gap is deals whose value is written in the summary or the notes but not in the “Annual Rev” column ' +
        '(AML Intelligence, W3GRC and Bespoke Training are the big ones). Fill that column in and the two will agree.</div></div>';
    }

    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search client, vertical or notes…" value="' + esc(f.q) + '" aria-label="Search deals">' +
      select('fstage', 'All stages', uniqStages(all), f.stage) +
      select('fpriority', 'All priorities', uniq(all.map(function (d) { return d.priority; })).map(function (p) { return { value: p, label: p }; }), f.priority) +
      select('fvertical', 'All verticals', uniq(all.map(function (d) { return d.vertical; })).sort().map(function (v) { return { value: v, label: v }; }), f.vertical) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' deals · ' + money(computed) + ' quantified</span>' +
      '</div>';

    var cols = [
      { key: 'client', label: 'Client / partner' },
      { key: 'vertical', label: 'Vertical' },
      { key: 'stageNum', label: 'Stage' },
      { key: 'priority', label: 'Priority' },
      { key: 'targetSort', label: 'Target' },
      { key: 'revenue', label: 'Annual rev', cls: 'num' },
      { key: null, label: 'Next action / notes' }
    ];
    var head = cols.map(function (c) {
      if (!c.key) return '<th>' + esc(c.label) + '</th>';
      var arrow = sort.key === c.key ? '<span class="arrow">' + (sort.dir > 0 ? '▲' : '▼') + '</span>' : '';
      return '<th class="sortable" data-sort="' + c.key + '">' + esc(c.label) + ' ' + arrow + '</th>';
    }).join('');

    var body = list.map(function (d) {
      return '<tr>' +
        '<td class="client-cell">' + esc(d.client) + (d.ref ? '<small>ref ' + esc(d.ref) + '</small>' : '') + '</td>' +
        '<td>' + esc(d.vertical) + '</td>' +
        '<td>' + chip('stage', d.stageLabel || d.stage) + '</td>' +
        '<td>' + priorityChip(d.priority) + '</td>' +
        '<td>' + targetChip(d.target, d.targetSort) + '</td>' +
        '<td class="num">' + (d.revenue == null ? '<span class="hint">not set</span>' : money(d.revenue)) + '</td>' +
        '<td class="note">' + esc(d.notes) + (d.flags.length ? '<div class="chips" style="margin-top:6px">' + flagChips(d.flags) + '</div>' : '') + '</td>' +
        '</tr>';
    }).join('');

    return banner + '<div class="grid two">' + funnelCard(list, 'Pipeline by stage' + (list.length !== all.length ? ' (filtered)' : '')) + verticalCard(list) + '</div>' +
      '<div style="height:18px"></div>' + filters +
      '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="7" class="empty">No deals match those filters.</td></tr>') +
      '</tbody></table></div>';
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

  views.deals = function () {
    var f = state.filters.deals = state.filters.deals || { q: '', priority: '' };
    var all = plans().filter(function (p) { return p.client; });
    var list = all.filter(function (p) {
      if (f.priority && String(p.priority).toLowerCase() !== f.priority.toLowerCase()) return false;
      if (f.q && (p.client + ' ' + p.vertical + ' ' + p.notes).toLowerCase().indexOf(f.q.toLowerCase()) === -1) return false;
      return true;
    }).sort(function (a, b) { return b.progress - a.progress || a.client.localeCompare(b.client); });

    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search client or notes…" value="' + esc(f.q) + '" aria-label="Search deal plans">' +
      select('fpriority', 'All priorities', uniq(all.map(function (p) { return p.priority; })).map(function (p) { return { value: p, label: p }; }), f.priority) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' deal plans</span></div>';

    var cards = list.map(function (p) {
      var stalled = p.steps.every(function (s) { return s.key !== 'active'; }) && p.progress < 100;
      return '<article class="item' + (p.flags.length ? ' attention' : '') + '">' +
        '<div class="item-head"><h3>' + esc(p.client) + '</h3><div class="chips">' + priorityChip(p.priority) + '</div></div>' +
        '<div class="item-meta">' + (p.vertical ? '<span><b>' + esc(p.vertical) + '</b></span>' : '') +
        (p.target ? '<span>Target: ' + esc(p.target) + '</span>' : '') + '</div>' +
        stepStrip(p.steps, true) +
        progressBar(p.progress, p.stepsDone + '/' + p.stepCount + ' milestones') +
        (p.notes ? '<p class="note">' + esc(p.notes) + '</p>' : '') +
        (p.flags.length || stalled ? '<div class="chips">' + flagChips(p.flags) + (stalled && p.stepsDone < p.stepCount ? chip('wait', 'No milestone in progress') : '') + '</div>' : '') +
        '</article>';
    }).join('');

    return filters + (list.length ? '<div class="grid cards">' + cards + '</div>' : '<p class="empty">No deal plans match those filters.</p>') +
      '<div class="card" style="margin-top:16px">' + stepLegend() + '</div>';
  };

  views.courses = function () {
    var f = state.filters.courses = state.filters.courses || { q: '', priority: '', status: '' };
    var all = courses().filter(function (c) { return c.name; });
    var list = all.filter(function (c) {
      if (f.priority && c.priority !== f.priority) return false;
      if (f.status === 'build' && !(c.stagesActive > 0)) return false;
      if (f.status === 'ready' && c.progress !== 100) return false;
      if (f.status === 'notstarted' && c.stagesDone !== 0) return false;
      if (f.status === 'late' && !isOverdue(c.targetSort)) return false;
      if (f.q && (c.name + ' ' + c.notes + ' ' + c.owner).toLowerCase().indexOf(f.q.toLowerCase()) === -1) return false;
      return true;
    }).sort(function (a, b) {
      var pw = { HIGH: 0, MEDIUM: 1, LOW: 2, UNSET: 3 };
      return (pw[a.priority] || 3) - (pw[b.priority] || 3) ||
        (a.targetSort || 999999) - (b.targetSort || 999999) || b.progress - a.progress;
    });

    var stages = (state.data.courses.stageNames || []);
    var strip = '<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>The ' + stages.length + '-stage build</h2>' +
      '<span class="hint">every course runs through these in order</span></div>' +
      '<div class="steps wide">' + stages.map(function (s, i) {
        return '<span class="step pending" data-tip="Stage ' + (i + 1) + '">' + (i + 1) + '. ' + esc(s) + '</span>';
      }).join('') + '</div>' + stepLegend() + '</div>';

    var filters = '<div class="filters">' +
      '<input type="search" id="fq" placeholder="Search course, owner or notes…" value="' + esc(f.q) + '" aria-label="Search courses">' +
      select('fpriority', 'All priorities', uniq(all.map(function (c) { return c.priority; })).map(function (p) { return { value: p, label: p }; }), f.priority) +
      select('fstatus', 'All statuses', [
        { value: 'build', label: 'Actively building' },
        { value: 'ready', label: 'All stages complete' },
        { value: 'notstarted', label: 'Not started' },
        { value: 'late', label: 'Past target date' }
      ], f.status) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' courses</span></div>';

    var cards = list.map(function (c) {
      var attention = c.flags.length || (isOverdue(c.targetSort) && c.progress < 100);
      return '<article class="item' + (attention ? ' attention' : '') + '">' +
        '<div class="item-head"><h3>' + esc(c.name) + '</h3><div class="chips">' + priorityChip(c.priority) + '</div></div>' +
        '<div class="chips">' + targetChip(c.target, c.targetSort, c.provisional) +
        chip('ghost', 'Now: ' + c.currentStage) + (c.owner ? chip('ghost', 'Owner: ' + c.owner) : '') + '</div>' +
        stepStrip(c.steps) +
        progressBar(c.progress, c.stagesDone + '/' + c.stageCount + ' stages complete') +
        (c.notes ? '<p class="note">' + esc(c.notes) + '</p>' : '') +
        (c.flags.length ? '<div class="chips">' + flagChips(c.flags) + '</div>' : '') +
        '</article>';
    }).join('');

    var footnotes = (state.data.courses.footnotes || []).map(function (n) {
      return '<div class="banner info"><span aria-hidden="true">ℹ</span><div>' + esc(n) + '</div></div>';
    }).join('');

    return strip + filters + (list.length ? '<div class="grid cards">' + cards + '</div>' : '<p class="empty">No courses match those filters.</p>') +
      (footnotes ? '<div style="margin-top:16px">' + footnotes + '</div>' : '');
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

  function updateRow(u) {
    return '<div class="tl-item"><div class="tl-date">' + esc(dateLabel(u.date)) + '<br>' + (u.tag ? chip('ghost', u.tag) : '') + '</div>' +
      '<div class="tl-body"><h3>' + esc(u.title) + '</h3><p>' + esc(u.body || '') + '</p></div></div>';
  }

  views.updates = function () {
    var list = (state.data.updates || []).slice().sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || ''));
    });
    return '<section class="card">' +
      '<div class="card-head"><h2>Company updates</h2><a class="btn" href="#/import">Post an update</a></div>' +
      (list.length ? '<div class="timeline">' + list.map(updateRow).join('') + '</div>'
        : '<p class="empty">Nothing posted yet. Updates you write on the <a href="#/import">Update data</a> tab appear here, ' +
        'along with an automatic note each time a new spreadsheet is imported.</p>') +
      '</section>';
  };

  /* ---------- importer ---------- */
  views['import'] = function () {
    var sources = (state.data.meta && state.data.meta.sources) || {};
    var sourceRows = Object.keys(sources).map(function (k) {
      var s = sources[k];
      return '<div class="list-row"><div class="lr-main"><div class="lr-title">' + esc(s.file) + '</div>' +
        '<div class="lr-sub">' + esc((s.sections || []).join(' · ')) + '</div></div>' +
        '<div class="lr-side">' + esc(dateLabel(s.importedAt)) + '</div></div>';
    }).join('');

    var previewBanner = state.isPreview
      ? '<div class="banner"><span aria-hidden="true">⚠</span><div><b>You are viewing a local preview.</b> ' +
        'These numbers are only on this computer until you download the data file and it is published. ' +
        '<button class="btn" id="clearPreview" style="margin-top:8px">Discard preview and show published data</button></div></div>'
      : '';

    var pending = state.pending
      ? '<section class="card"><div class="card-head"><h2>Ready to apply</h2><span class="hint">nothing has changed yet</span></div>' +
        '<ul class="diff">' + (state.pendingDiff.length
          ? state.pendingDiff.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('')
          : '<li>No differences found — the file matches what is already published.</li>') + '</ul>' +
        '<div class="filters" style="margin:14px 0 0">' +
        '<button class="btn primary" id="applyPending">Apply and preview</button>' +
        '<button class="btn" id="discardPending">Discard</button>' +
        '</div></section>'
      : '';

    return previewBanner +
      '<div class="grid two">' +
      '<section class="card"><div class="card-head"><h2>Upload a tracker</h2></div>' +
      '<div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose spreadsheet files">' +
      '<strong>Drop the Excel tracker here</strong>' +
      '<small>or click to choose · .xlsx · you can drop both trackers at once</small>' +
      '<input type="file" id="fileInput" accept=".xlsx,.xlsm" multiple hidden></div>' +
      '<p class="hint" style="margin-top:12px">Recognised sheets: <b>Course Build Tracker</b>, <b>Projects</b>, ' +
      '<b>Pipeline Tracker</b>, <b>Deal Stage Plans</b>, <b>Funnel Summary</b>. Anything else in the file is ignored. ' +
      'Nothing is uploaded anywhere — the file is read inside your browser.</p>' +
      '<div id="importStatus"></div>' +
      '</section>' +

      '<section class="card"><div class="card-head"><h2>How to publish an update</h2></div>' +
      '<ol class="steps-guide">' +
      '<li>Drop the new spreadsheet above and check the list of changes.</li>' +
      '<li>Click <b>Apply and preview</b> — the whole dashboard now shows the new numbers, on your machine only.</li>' +
      '<li>Click <b>Download data file</b> and save it as <code>data/dashboard.js</code> in the project folder.</li>' +
      '<li>Commit and push that one file. Vercel redeploys in about a minute and everyone sees it.</li>' +
      '</ol>' +
      '<div class="filters" style="margin:16px 0 0">' +
      '<button class="btn amber" id="downloadData">Download data file</button>' +
      '<button class="btn" id="copyData">Copy to clipboard</button>' +
      '</div>' +
      '<p class="hint" style="margin-top:10px">Prefer the command line? <code>node tools/seed.js</code> rebuilds the same file from <code>source-files/</code>.</p>' +
      '</section></div>' +

      (pending ? '<div style="height:16px"></div>' + pending : '') +

      '<div style="height:16px"></div><div class="grid two">' +
      '<section class="card"><div class="card-head"><h2>Post an update</h2><span class="hint">appears on Updates + Overview</span></div>' +
      '<div class="form-row"><label for="upTitle">Headline</label><input id="upTitle" placeholder="e.g. Crab Nebula pilot signed off"></div>' +
      '<div class="form-row"><label for="upBody">Detail</label><textarea id="upBody" placeholder="What happened, what it means, what happens next."></textarea></div>' +
      '<div class="form-row"><label for="upTag">Tag</label><input id="upTag" placeholder="Sales, Build, Ops…" value="General"></div>' +
      '<button class="btn primary" id="addUpdate">Add update</button>' +
      '<p class="hint" style="margin-top:10px">Saved into the same data file — download and publish it the same way.</p>' +
      '</section>' +

      '<section class="card"><div class="card-head"><h2>Current data sources</h2></div>' +
      (sourceRows ? '<div class="list">' + sourceRows + '</div>' : '<p class="empty">No imports recorded yet.</p>') +
      '</section></div>';
  };

  /* Compare two datasets and describe what changed, in plain English. */
  function diffData(oldD, newD) {
    var out = [];
    function index(list, key) {
      var m = {};
      (list || []).forEach(function (x) { if (x[key]) m[x[key]] = x; });
      return m;
    }
    var od = index(oldD.pipeline && oldD.pipeline.deals, 'client'), nd = index(newD.pipeline && newD.pipeline.deals, 'client');
    Object.keys(nd).forEach(function (k) {
      if (!od[k]) { out.push('New deal: ' + k + ' (' + (nd[k].stageLabel || 'unstaged') + ')'); return; }
      if (od[k].stageNum !== nd[k].stageNum) out.push('Deal moved: ' + k + ' — ' + (od[k].stageLabel || '?') + ' → ' + (nd[k].stageLabel || '?'));
      if ((od[k].revenue || null) !== (nd[k].revenue || null)) out.push('Revenue changed: ' + k + ' — ' + money(od[k].revenue) + ' → ' + money(nd[k].revenue));
      if (od[k].priority !== nd[k].priority) out.push('Priority changed: ' + k + ' — ' + od[k].priority + ' → ' + nd[k].priority);
    });
    Object.keys(od).forEach(function (k) { if (!nd[k]) out.push('Deal removed: ' + k); });

    var oc = index(oldD.courses && oldD.courses.items, 'name'), nc = index(newD.courses && newD.courses.items, 'name');
    Object.keys(nc).forEach(function (k) {
      if (!oc[k]) { out.push('New course: ' + k); return; }
      if (oc[k].stagesDone !== nc[k].stagesDone) out.push('Build progress: ' + k + ' — ' + oc[k].stagesDone + '/' + oc[k].stageCount + ' → ' + nc[k].stagesDone + '/' + nc[k].stageCount + ' stages');
      if (oc[k].target !== nc[k].target) out.push('Go-live target: ' + k + ' — ' + (oc[k].target || 'none') + ' → ' + (nc[k].target || 'none'));
    });
    Object.keys(oc).forEach(function (k) { if (!nc[k]) out.push('Course removed: ' + k); });

    var op = index(oldD.projects && oldD.projects.items, 'name'), np = index(newD.projects && newD.projects.items, 'name');
    Object.keys(np).forEach(function (k) {
      if (!op[k]) { out.push('New project: ' + k); return; }
      if (op[k].status !== np[k].status) out.push('Project status: ' + k + ' — ' + op[k].status + ' → ' + np[k].status);
    });
    return out;
  }

  var sheetJsPromise = null;
  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (sheetJsPromise) return sheetJsPromise;
    sheetJsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('Could not load the spreadsheet reader.')); };
      document.head.appendChild(s);
    });
    return sheetJsPromise;
  }

  function handleFiles(files) {
    var status = $('#importStatus');
    if (!files || !files.length) return;
    status.innerHTML = '<p class="hint" style="margin-top:12px">Reading…</p>';
    loadSheetJS().then(function (XLSX) {
      var working = JSON.parse(JSON.stringify(state.data));
      var stamp = new Date().toISOString();
      var messages = [], errors = [];
      var queue = Array.prototype.slice.call(files);

      function next() {
        if (!queue.length) return finish();
        var file = queue.shift();
        var reader = new FileReader();
        reader.onload = function (e) {
          try {
            var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            var res = window.FideoParse.applyWorkbook(XLSX, wb, file.name, working, stamp);
            if (res.error) errors.push(file.name + ': ' + res.error);
            else { working = res.data; messages.push(file.name + ' → ' + res.applied.join(', ')); }
          } catch (err) {
            errors.push(file.name + ': ' + err.message);
          }
          next();
        };
        reader.onerror = function () { errors.push(file.name + ': could not be read.'); next(); };
        reader.readAsArrayBuffer(file);
      }

      function finish() {
        if (messages.length) {
          state.pending = working;
          state.pendingDiff = diffData(state.data, working);
        }
        render();
        var s = $('#importStatus');
        if (s) {
          s.innerHTML =
            (messages.length ? '<div class="banner info" style="margin-top:14px"><span aria-hidden="true">✓</span><div>' +
              messages.map(esc).join('<br>') + '</div></div>' : '') +
            (errors.length ? '<div class="banner" style="margin-top:14px"><span aria-hidden="true">⚠</span><div>' +
              errors.map(esc).join('<br>') + '</div></div>' : '');
        }
      }
      next();
    }).catch(function (err) {
      status.innerHTML = '<div class="banner"><span aria-hidden="true">⚠</span><div>' + esc(err.message) + '</div></div>';
    });
  }

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
    deals: ['Deal plans', 'The five milestones each deal has to clear'],
    courses: ['Course builds', 'Where every programme is in the ten-stage build'],
    projects: ['Projects', 'Pre-pipeline opportunities and who owns them'],
    updates: ['Updates', 'What has changed lately'],
    'import': ['Update data', 'Upload a tracker and publish the new numbers']
  };

  function renderChrome() {
    var t = TITLES[state.route] || TITLES.overview;
    $('#pageTitle').textContent = t[0];
    $('#pageSub').textContent = t[1];
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
      '<a class="btn" href="#/import">Update data</a>';
  }

  function render() {
    loadRoute();
    renderChrome();
    var view = views[state.route] || views.overview;
    var main = $('#main');
    main.innerHTML = view();
    bind();
  }

  function loadRoute() {
    var hash = (location.hash || '#/overview').replace('#/', '');
    state.route = views[hash] ? hash : 'overview';
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
    [['fstage', 'stage'], ['fpriority', 'priority'], ['fvertical', 'vertical'], ['fstatus', 'status']].forEach(function (pair) {
      var el = $('#' + pair[0], main);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters[state.route][pair[1]] = el.value;
        render();
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

    var dz = $('#dropzone', main), fi = $('#fileInput', main);
    if (dz && fi) {
      dz.addEventListener('click', function () { fi.click(); });
      dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
      fi.addEventListener('change', function () { handleFiles(fi.files); });
      ['dragenter', 'dragover'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.add('over'); });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        dz.addEventListener(evt, function (e) { e.preventDefault(); dz.classList.remove('over'); });
      });
      dz.addEventListener('drop', function (e) { handleFiles(e.dataTransfer.files); });
    }

    on('#applyPending', 'click', function () {
      var data = state.pending;
      if (!data) return;
      data.updates = data.updates || [];
      var summary = state.pendingDiff.slice(0, 12).join('\n') + (state.pendingDiff.length > 12 ? '\n…and ' + (state.pendingDiff.length - 12) + ' more changes.' : '');
      data.updates.unshift({
        date: new Date().toISOString().slice(0, 10),
        title: 'Trackers refreshed',
        tag: 'Data',
        body: state.pendingDiff.length ? summary : 'Spreadsheets re-imported with no material changes.'
      });
      savePreview(data);
      state.pending = null; state.pendingDiff = [];
      location.hash = '#/overview';
      render();
    });
    on('#discardPending', 'click', function () { state.pending = null; state.pendingDiff = []; render(); });
    on('#clearPreview', 'click', function () {
      if (confirm('Discard the local preview and go back to the published data?')) { clearPreview(); render(); }
    });
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

  loadData();
  render();
})();
