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
      var id = STAGE_TO_STEP[d.stageNum];
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
      var isTracked = !!tracked[g.step.id];
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
    if (!plan.target) {
      return '<details class="plan"><summary>Stage deadlines</summary>' +
        '<p class="hint" style="margin:10px 0 0">No go-live target on this course, so there is nothing to work back from. ' +
        'Put a date in the tracker and the ten stage deadlines appear here.</p></details>';
    }
    var rows = c.steps.map(function (st, i) {
      var due = plan.deadlines[i];
      var late = due && due < new Date() && st.key !== 'done';
      return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(st.name) + '</td>' +
        '<td><span data-tip="' + esc(expandInitials(m.roles[i] || '')) + '">' + esc(m.roles[i] || '—') + '</span></td>' +
        '<td class="num">' + (m.days[i] || 0) + 'd</td>' +
        '<td>' + (st.key === 'done'
          ? chip('done', 'Complete', '✓')
          : (due ? (late ? chip('risk', fmtDate(due), '!') : chip('ghost', fmtDate(due))) : '—')) + '</td></tr>';
    }).join('');
    return '<details class="plan"><summary>Stage deadlines — ' + plan.remainingDays + ' build days left, ' +
      (plan.shortfall > 0 ? 'short by ' + plan.shortfall : (plan.available == null ? 'no target' : plan.available + ' working days available')) +
      '</summary><div class="table-wrap" style="margin-top:10px"><table><thead><tr>' +
      '<th>#</th><th>Stage</th><th>Who</th><th>Days</th><th>Due</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<p class="hint" style="margin:8px 0 0">Worked back from the go-live target using the standard build. ' +
      'Nobody has typed these dates — change a stage duration and they all move.</p></details>';
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
  var views = {};

  function salesPriorityCard(list, limit) {
    var ranked = salesRanking(list);
    var shown = limit ? ranked.slice(0, limit) : ranked;
    if (!shown.length) return '';
    return '<section class="card"><div class="card-head"><h2>Sales priority order</h2>' +
      '<span class="hint">' + (limit ? 'top ' + limit + ' of ' + ranked.length : ranked.length + ' live deals') + '</span></div>' +
      ruleNote(esc(PRIORITY_RULE_SALES)) +
      '<div class="list ranked">' + shown.map(function (r, i) {
        var d = r.deal;
        var mismatch = i < 5 && ['LOW', 'MONITOR'].indexOf(String(d.priority).toUpperCase()) !== -1;
        return '<div class="list-row"><span class="rank">' + (i + 1) + '</span>' +
          '<div class="lr-main"><div class="lr-title">' + esc(d.client) + '</div>' +
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
    var ranked = buildRanking(courses().filter(function (c) { return c.name && c.progress < 100; }), liveDeals());
    var shown = limit ? ranked.slice(0, limit) : ranked;
    if (!shown.length) return '';
    return '<section class="card"><div class="card-head"><h2>Build priority order</h2>' +
      '<span class="hint">' + (limit ? 'top ' + limit + ' of ' + ranked.length : ranked.length + ' in flight') + '</span></div>' +
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
        : '<p class="empty">No updates posted yet. Add one from the <a href="#/import">Update data</a> tab.</p>') +
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

  function stampLine() {
    var gen = state.data.meta && state.data.meta.generatedAt;
    return '<div class="stamp">' +
      '<span><b>Last updated</b> ' + esc(gen ? dateLabel(gen) : 'unknown') + '</span>' +
      '<span>Build tracker as at ' + esc((state.data.courses && state.data.courses.asAt) || 'unknown') + '</span>' +
      '<span>Sales tracker as at ' + esc((state.data.pipeline && state.data.pipeline.asAt) || 'unknown') + '</span>' +
      (state.isPreview ? '<span class="chip amber"><span class="glyph">●</span>Unpublished preview</span>' : '') +
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
      var isTracked = !!tracked[g.step.id];
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
            return '<div class="list-row"><div class="lr-main"><a class="lr-title" href="#/pipeline">' + esc(d.client) + '</a>' +
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
          return '<div class="list-row"><div class="lr-main"><a class="lr-title" href="#/courses">' + esc(x.c.name) + '</a>' +
            '<div class="lr-sub">' + esc(x.c.owner ? 'Owner: ' + x.c.owner : 'No owner named') + '</div></div>' +
            '<div class="lr-side">' + (x.live ? chip('active', 'In progress', '▶') : chip('wait', 'Waiting', '○')) +
            ' ' + targetChip(x.c.target, x.c.targetSort, x.c.provisional) + '</div></div>';
        }).join('') + '</div>' : '<p class="empty">No courses at this stage.</p>') + '</div>';
    }

    return '<section class="card"><div class="card-head"><h2>Building a programme</h2>' +
      '<span class="hint">the ten build stages · ' + list.length + ' courses · click a stage for names</span></div>' +
      '<div class="process">' + boxes + '</div>' + panel +
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
          '<div class="lr-title">' + esc(r.deal.client) + '</div>' +
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
          '<div class="lr-title">' + esc(r.course.name) + '</div>' +
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

    var cols = [
      { key: 'client', label: 'Client / partner' },
      { key: 'vertical', label: 'Vertical' },
      { key: 'stageNum', label: 'Stage' },
      { key: 'priority', label: 'Priority' },
      { key: 'targetSort', label: 'Target' },
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
        '<td class="note">' + esc(d.notes) + (d.flags.length ? '<div class="chips" style="margin-top:6px">' + flagChips(d.flags) + '</div>' : '') + '</td>' +
        '</tr>';
    }).join('');

    return banner + salesPriorityCard(list.filter(function (d) { return String(d.priority).toLowerCase() !== 'dead'; })) +
      '<div style="height:18px"></div>' +
      '<div class="grid two">' + funnelCard(list, 'Deals by stage' + (list.length !== all.length ? ' (filtered)' : '')) + verticalCard(list) + '</div>' +
      '<div style="height:18px"></div>' + filters +
      '<div class="table-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' +
      (body || '<tr><td colspan="6" class="empty">No deals match those filters.</td></tr>') +
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

    var card = function (p) {
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
    };

    var stageNames = (state.data.dealPlans && state.data.dealPlans.stageNames) || [];
    return filters + (list.length
      ? groupedSections(list, stageNames, card, 'milestones')
      : '<p class="empty">No deal plans match those filters.</p>') +
      '<div class="card" style="margin-top:16px">' + stepLegend() + '</div>';
  };

  views.courses = function () {
    var f = state.filters.courses = state.filters.courses || { q: '', priority: '', status: '', groupBy: 'priority' };
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
      return priorityRank(a.priority) - priorityRank(b.priority) ||
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
      select('fgroup', 'Group by…', [
        { value: 'priority', label: 'Group by build priority' },
        { value: 'stage', label: 'Group by build stage' }
      ], f.groupBy) +
      '<span class="result-count">' + list.length + ' of ' + all.length + ' courses</span></div>';

    var tiers = {};
    buildRanking(all, liveDeals()).forEach(function (r) { tiers[r.course.name] = r; });

    var card = function (c) {
      var attention = c.flags.length || (isOverdue(c.targetSort) && c.progress < 100);
      var t = tiers[c.name];
      var tierMeta = t ? BUILD_TIERS[t.tier] : null;
      return '<article class="item' + (attention ? ' attention' : '') + '">' +
        '<div class="item-head"><h3>' + esc(c.name) + '</h3><div class="chips">' + priorityChip(c.priority) + '</div></div>' +
        (tierMeta ? '<div class="chips">' + chip(tierMeta.kind, tierMeta.glyph + '. ' + tierMeta.label) + '</div>' +
          '<p class="note tier-why">' + esc(t.why) + '</p>' : '') +
        '<div class="chips">' + targetChip(c.target, c.targetSort, c.provisional) +
        chip('ghost', c.currentStage) + (c.owner ? '<span class="chip ghost" data-tip="' + esc(expandInitials(c.owner)) + '">Owner: ' + esc(c.owner) + '</span>' : '') + '</div>' +
        stepStrip(c.steps) +
        progressBar(c.progress, c.stagesDone + '/' + c.stageCount + ' stages complete') +
        planDetails(c) +
        (c.notes ? '<p class="note">' + esc(c.notes) + '</p>' : '') +
        (c.flags.length ? '<div class="chips">' + flagChips(c.flags) + '</div>' : '') +
        '</article>';
    };

    var footnotes = (state.data.courses.footnotes || []).map(function (n) {
      return '<div class="banner info"><span aria-hidden="true">ℹ</span><div>' + esc(n) + '</div></div>';
    }).join('');

    var body;
    if (!list.length) {
      body = '<p class="empty">No courses match those filters.</p>';
    } else if (f.groupBy === 'stage') {
      body = groupedSections(list, stages, card, 'stages');
    } else {
      /* grouped by the directors' build-priority rule */
      var order = buildRanking(list, liveDeals());
      body = [1, 2, 3, 4].map(function (tier) {
        var items = order.filter(function (r) { return r.tier === tier; }).map(function (r) { return r.course; });
        if (!items.length) return '';
        var meta = BUILD_TIERS[tier];
        return '<section class="stage-group"><div class="stage-group-head">' +
          '<h2>' + meta.glyph + '. ' + esc(meta.label) + '</h2>' +
          '<span class="chip ghost">' + items.length + '</span></div>' +
          '<div class="grid cards">' + items.map(card).join('') + '</div></section>';
      }).join('');
    }

    return strip + capacityCard() + '<div style="height:16px"></div>' +
      staffingCard() + '<div style="height:16px"></div>' +
      buildModelCard() + '<div style="height:16px"></div>' +
      ruleNote('<b>Build order:</b> ' + esc(PRIORITY_RULE_BUILD)) + filters + body +
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

  /* Stage deadlines that have already gone by with the stage unfinished. */
  function missedDeadlines() {
    var m = buildModel(), today = new Date(), out = [];
    courses().forEach(function (c) {
      if (!c.name || !c.targetSort || c.progress === 100) return;
      var plan = coursePlan(c);
      c.steps.forEach(function (st, i) {
        var due = plan.deadlines[i];
        if (!due || st.key === 'done' || due >= today) return;
        out.push({
          course: c.name, stage: (i + 1) + '. ' + st.name, who: m.roles[i] || '',
          owner: c.owner || '', due: due, daysLate: workingDaysBetween(due, today)
        });
      });
    });
    return out.sort(function (a, b) { return b.daysLate - a.daysLate; });
  }

  views.accountability = function () {
    var all = slips().slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var unexplained = all.filter(function (s) { return !s.reason; });
    var missed = missedDeadlines();

    var byCourse = {};
    all.forEach(function (s) { byCourse[s.course] = (byCourse[s.course] || 0) + 1; });
    var repeat = Object.keys(byCourse).filter(function (k) { return byCourse[k] > 1; })
      .sort(function (a, b) { return byCourse[b] - byCourse[a]; });

    var kpis = '<div class="grid kpis">' +
      kpi('Dates moved', String(all.length), 'recorded since tracking began', true) +
      kpi('Moved without a reason', String(unexplained.length), 'nobody gave an explanation') +
      kpi('Courses that moved more than once', String(repeat.length), repeat.length ? repeat.slice(0, 2).join(', ') : 'none yet') +
      kpi('Stage deadlines already passed', String(missed.length), 'across ' + uniq(missed.map(function (x) { return x.course; })).length + ' courses') +
      '</div>';

    var log = all.length
      ? '<div class="table-wrap"><table><thead><tr><th>Recorded</th><th>Course</th><th>Moved from</th>' +
      '<th>Moved to</th><th>Owner</th><th>Reason given</th><th>Agreed with</th></tr></thead><tbody>' +
      all.map(function (s) {
        return '<tr><td>' + esc(dateLabel(s.date)) + '</td>' +
          '<td class="client-cell">' + esc(s.course) + '</td>' +
          '<td>' + esc(s.from) + '</td><td>' + esc(s.to) + '</td>' +
          '<td><span data-tip="' + esc(expandInitials(s.owner)) + '">' + esc(s.owner || '—') + '</span></td>' +
          '<td class="note">' + (s.reason ? esc(s.reason) : chip('risk', 'No reason given', '!')) + '</td>' +
          '<td>' + esc(s.agreedBy || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<p class="empty">No date changes recorded yet. The log starts from the next tracker you upload — ' +
      'each moved go-live date will ask why before it is applied.</p>';

    var missedTable = missed.length
      ? '<div class="table-wrap"><table><thead><tr><th>Course</th><th>Stage</th><th>Responsible</th>' +
      '<th>Course owner</th><th>Should have finished</th><th>Working days late</th></tr></thead><tbody>' +
      missed.slice(0, 25).map(function (x) {
        return '<tr><td class="client-cell">' + esc(x.course) + '</td><td>' + esc(x.stage) + '</td>' +
          '<td><span data-tip="' + esc(expandInitials(x.who)) + '">' + esc(x.who) + '</span></td>' +
          '<td><span data-tip="' + esc(expandInitials(x.owner)) + '">' + esc(x.owner || '—') + '</span></td>' +
          '<td>' + esc(fmtDate(x.due)) + '</td>' +
          '<td class="num">' + chip('risk', String(x.daysLate), '!') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<p class="empty">Nothing is past a stage deadline.</p>';

    return kpis + '<div style="height:16px"></div>' +
      '<section class="card"><div class="card-head"><h2>Every date that has moved</h2>' +
      '<span class="hint">captured at import, with the reason</span></div>' + log +
      '<p class="hint" style="margin-top:10px">A go-live date cannot move quietly: the next upload compares the ' +
      'new tracker against what is published and asks for an explanation for each change before applying it. ' +
      'Rows marked “no reason given” were applied without one.</p></section>' +
      '<div style="height:16px"></div>' +
      '<section class="card"><div class="card-head"><h2>Stages already past their deadline</h2>' +
      '<span class="hint">worked back from each go-live target</span></div>' + missedTable +
      '<p class="hint" style="margin-top:10px">These are not recorded events — they are what the standard build ' +
      'says should already have happened, given each course’s own go-live target.</p></section>';
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

    var moved = (state.pendingTargets || []).map(function (t, i) {
      return '<div class="slip-ask"><div class="slip-ask-head"><b>' + esc(t.course) + '</b>' +
        chip('ghost', esc(t.from) + '  →  ' + esc(t.to)) +
        (t.owner ? '<span class="hint" data-tip="' + esc(expandInitials(t.owner)) + '">Owner: ' + esc(t.owner) + '</span>' : '') +
        '</div>' +
        '<div class="form-row"><label for="slipWhy' + i + '">Why has this date moved?</label>' +
        '<input id="slipWhy' + i + '" data-slip="' + i + '" placeholder="e.g. client delayed sign-off on the script"></div>' +
        '<div class="form-row"><label for="slipWho' + i + '">Agreed with</label>' +
        '<input id="slipWho' + i + '" data-slipwho="' + i + '" placeholder="which director agreed the change"></div>' +
        '</div>';
    }).join('');

    var movedPanel = moved
      ? '<section class="card"><div class="card-head"><h2>' + state.pendingTargets.length +
        (state.pendingTargets.length === 1 ? ' go-live date has moved' : ' go-live dates have moved') + '</h2>' +
        '<span class="hint">recorded permanently on the Accountability page</span></div>' +
        '<div class="banner"><span aria-hidden="true">⚠</span><div>Anything left blank is applied and logged as ' +
        '<b>“no reason given”</b>. It is not blocked, but it is not forgotten either.</div></div>' +
        moved + '</section><div style="height:16px"></div>'
      : '';

    var pending = state.pending
      ? movedPanel + '<section class="card"><div class="card-head"><h2>Ready to apply</h2><span class="hint">nothing has changed yet</span></div>' +
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
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('failed: ' + src)); };
      document.head.appendChild(s);
    });
  }
  /* The .xlsx reader ships with the site so it works offline; the CDN is only a
     fallback for deployments where the vendor folder was not uploaded. */
  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (sheetJsPromise) return sheetJsPromise;
    sheetJsPromise = loadScript('assets/vendor/xlsx.full.min.js')
      .catch(function () { return loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'); })
      .then(function () {
        if (!window.XLSX) throw new Error('Could not load the spreadsheet reader.');
        return window.XLSX;
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
          state.pendingTargets = targetChangesBetween(state.data, working);
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
    accountability: ['Accountability', 'Dates that have moved, why, and what is already late'],
    key: ['Key', 'What every symbol, initial and worked-out label on this platform means'],
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
    [['fstage', 'stage'], ['fpriority', 'priority'], ['fvertical', 'vertical'], ['fstatus', 'status'], ['fgroup', 'groupBy']].forEach(function (pair) {
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

      /* log every moved go-live date, with whatever explanation was given */
      var stamp = new Date().toISOString().slice(0, 10);
      data.history = data.history || { slips: [] };
      (state.pendingTargets || []).forEach(function (t, i) {
        var why = $('#slipWhy' + i), who = $('#slipWho' + i);
        data.history.slips.push({
          date: stamp, course: t.course, from: t.from, to: t.to, owner: t.owner,
          reason: why ? why.value.trim() : '', agreedBy: who ? who.value.trim() : ''
        });
      });
      state.pendingTargets = [];
      savePreview(data);
      state.pending = null; state.pendingDiff = [];
      location.hash = '#/overview';
      render();
    });
    on('#discardPending', 'click', function () { state.pending = null; state.pendingDiff = []; state.pendingTargets = []; render(); });
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
