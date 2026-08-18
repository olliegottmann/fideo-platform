/* Fideo Global — workbook parser.
   Shared by the browser importer (Update data tab) and tools/seed.mjs.
   Turns the FIDEO tracker spreadsheets into the dashboard data model.
   Deliberately tolerant: headers are found by content, not by row number,
   so re-ordered or lightly re-titled sheets keep working. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FideoParse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  function S(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\s+/g, ' ').trim();
  }
  function isBlank(v) {
    var s = S(v);
    return s === '' || s === '—' || s === '-' || s === '–';
  }

  /* "€104,000" / "6500" / "—" -> number | null */
  function money(v) {
    var s = S(v);
    if (isBlank(s)) return null;
    var cleaned = s.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    if (!cleaned) return null;
    var n = parseFloat(cleaned);
    return isFinite(n) ? n : null;
  }

  /* "Q4 2026", "End Aug 2026*", "Oct-26", "H1 2027" -> {label, sortKey, provisional} */
  function parseTarget(v) {
    var label = S(v);
    var out = { label: label.replace(/\*/g, '').trim(), sortKey: null, provisional: /\*/.test(label) };
    if (isBlank(label)) return out;
    var t = label.toLowerCase().replace(/\*/g, ' ');
    var m;
    if ((m = t.match(/q([1-4])\s*(20\d\d)/))) { out.sortKey = (+m[2]) * 100 + (+m[1]) * 3; return out; }
    if ((m = t.match(/(20\d\d)\s*q([1-4])/))) { out.sortKey = (+m[1]) * 100 + (+m[2]) * 3; return out; }
    if ((m = t.match(/h([12])\s*(20\d\d)/))) { out.sortKey = (+m[2]) * 100 + (m[1] === '1' ? 6 : 12); return out; }
    var mi = -1;
    for (var i = 0; i < MONTHS.length; i++) { if (t.indexOf(MONTHS[i]) !== -1) { mi = i; break; } }
    var year = null;
    if ((m = t.match(/(20\d\d)/))) year = +m[1];
    else if ((m = t.match(/[-\/](\d\d)\b/))) year = 2000 + (+m[1]);
    if (mi >= 0) out.sortKey = (year || 2026) * 100 + (mi + 1);
    else if (year) out.sortKey = year * 100 + 12;
    return out;
  }

  /* A build step or deal milestone -> done | active | pending | none */
  function stepStatus(v) {
    var raw = S(v);
    var t = raw.replace(/[✔✓►○●→]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (t === '' || t === '—' || t === '-') return { key: 'none', label: '' };
    if (/^complete/.test(t)) return { key: 'done', label: 'Complete' };
    if (/^tbc$/.test(t) || /^pending$/.test(t) || /^not started$/.test(t)) {
      return { key: 'pending', label: raw.replace(/[○]/g, '').trim() || 'TBC' };
    }
    return { key: 'active', label: raw.replace(/[►]/g, '').trim() };
  }

  var BLOCKER_PATTERNS = [
    [/awaiting|waiting on|waiting for|waiting\b/i, 'Waiting on others'],
    [/pending\b/i, 'Pending'],
    [/sign[- ]?off|contract|agreement|\bmoa\b|tender-dependent/i, 'Contract / sign-off'],
    [/frozen|inactive|\bidle\b|\bdead\b|no further updates|not much traction/i, 'Stalled'],
    [/chase|nudge|follow up|follow-up|reach out/i, 'Needs chasing'],
    [/under review|review needed|qa needed|feasibility/i, 'Under review'],
    [/unquantified|revenue tbc|need to price|commercialise/i, 'Revenue unquantified']
  ];
  function flagsFor(text) {
    var s = S(text), out = [];
    for (var i = 0; i < BLOCKER_PATTERNS.length; i++) {
      if (BLOCKER_PATTERNS[i][0].test(s) && out.indexOf(BLOCKER_PATTERNS[i][1]) === -1) out.push(BLOCKER_PATTERNS[i][1]);
    }
    return out;
  }
  function ownerFrom(text) {
    var m = S(text).match(/owner:\s*([^.]+)/i);
    return m ? m[1].trim() : '';
  }

  /* --- sheet helpers -------------------------------------------------- */
  function rowsOf(XLSX, wb, name) {
    var ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
  }
  function findSheet(wb, needles) {
    var names = wb.SheetNames || [];
    for (var j = 0; j < needles.length; j++) {
      for (var i = 0; i < names.length; i++) {
        if (names[i].toLowerCase().indexOf(needles[j]) !== -1) return names[i];
      }
    }
    return null;
  }
  function findHeader(rows, firstCells) {
    for (var r = 0; r < rows.length; r++) {
      var c0 = S(rows[r][0]).toLowerCase();
      for (var i = 0; i < firstCells.length; i++) if (c0 === firstCells[i]) return r;
    }
    return -1;
  }
  function asAtFrom(rows) {
    for (var r = 0; r < Math.min(rows.length, 4); r++) {
      for (var c = 0; c < Math.min((rows[r] || []).length, 4); c++) {
        var m = S(rows[r][c]).match(/(?:updated|as at)\s+(.+)$/i);
        if (m) return m[1].trim();
      }
    }
    return '';
  }
  function cleanStageName(v) { return S(v).replace(/^\d+\s*/, '').trim(); }
  function isFootnote(v) {
    var s = S(v);
    return s === '' || /^\*/.test(s) || /^total\b/i.test(s) || /^yellow cells/i.test(s) || /^projects at pre-pipeline/i.test(s);
  }
  /* The August 2026 tracker groups rows under coloured banner rows —
     "🔴 HIGH PRIORITY" and friends. They are separators, not courses. */
  function isBandRow(v) {
    var s = S(v).replace(/[^\x20-\x7E]/g, '').trim();
    return /^(high|medium|low)\s*priority$/i.test(s);
  }

  /* --- Course Build Tracker ------------------------------------------- */
  function parseCourses(XLSX, wb) {
    var name = findSheet(wb, ['course build', 'course']);
    if (!name) return null;
    var rows = rowsOf(XLSX, wb, name);
    var h = findHeader(rows, ['course name']);
    if (h < 0) return null;
    var head = rows[h];
    var lastCol = head.length - 1;
    var stageNames = [];
    for (var c = 2; c <= lastCol - 2; c++) stageNames.push(cleanStageName(head[c]));
    var items = [], footnotes = [];
    for (var r = h + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var title = S(row[0]);
      if (isFootnote(title)) { if (title) footnotes.push(title); continue; }
      if (isBandRow(title)) continue;
      var steps = [], done = 0, active = 0;
      for (var i = 0; i < stageNames.length; i++) {
        var st = stepStatus(row[2 + i]);
        if (st.key === 'done') done++;
        if (st.key === 'active') active++;
        steps.push({ name: stageNames[i], key: st.key, label: st.label });
      }
      var note = S(row[lastCol]);
      if (note === '—') note = '';
      var target = parseTarget(row[lastCol - 1]);
      var current = null;
      for (var a = 0; a < steps.length; a++) { if (steps[a].key === 'active') { current = 'In progress: ' + steps[a].name; break; } }
      if (!current && done > 0 && done === steps.length) current = 'All stages complete';
      if (!current && steps.every(function (s) { return s.key === 'none'; })) current = 'Not started';
      if (!current) {
        for (var b = 0; b < steps.length; b++) { if (steps[b].key !== 'done') { current = 'Next up: ' + steps[b].name; break; } }
      }
      if (!current) current = 'Not started';
      items.push({
        name: title,
        priority: S(row[1]).toUpperCase() || 'UNSET',
        steps: steps,
        stagesDone: done,
        stagesActive: active,
        stageCount: stageNames.length,
        progress: stageNames.length ? Math.round((done / stageNames.length) * 100) : 0,
        currentStage: current,
        target: target.label,
        targetSort: target.sortKey,
        provisional: target.provisional,
        owner: ownerFrom(note),
        notes: note,
        flags: flagsFor(note)
      });
    }
    return { asAt: asAtFrom(rows), stageNames: stageNames, items: items, footnotes: footnotes, sheet: name };
  }

  /* --- Project Register ----------------------------------------------- */
  function parseProjects(XLSX, wb) {
    var name = findSheet(wb, ['project']);
    if (!name) return null;
    var rows = rowsOf(XLSX, wb, name);
    var h = findHeader(rows, ['project name']);
    if (h < 0) return null;
    var items = [];
    for (var r = h + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var title = S(row[0]);
      if (isFootnote(title)) continue;
      var target = parseTarget(row[5]);
      items.push({
        name: title,
        description: S(row[1]),
        status: S(row[2]) || 'Not Started',
        lead: S(row[3]),
        nextStep: S(row[4]),
        target: target.label,
        targetSort: target.sortKey,
        notes: S(row[6]),
        flags: flagsFor(S(row[4]) + ' ' + S(row[6]))
      });
    }
    return { items: items, sheet: name };
  }

  /* --- Sales Pipeline -------------------------------------------------- */
  function parsePipeline(XLSX, wb) {
    var name = findSheet(wb, ['pipeline tracker', 'pipeline']);
    if (!name) return null;
    var rows = rowsOf(XLSX, wb, name);
    var h = findHeader(rows, ['#', 'client / partner']);
    if (h < 0) return null;
    var head = rows[h].map(function (x) { return S(x).toLowerCase(); });
    function col(needle, fallback) {
      for (var i = 0; i < head.length; i++) if (head[i].indexOf(needle) !== -1) return i;
      return fallback;
    }
    var cClient = col('client', 1), cVert = col('vertical', 2), cStage = col('stage', 3),
      cPri = col('priority', 4), cTgt = col('target', 5), cRev = col('rev', 6), cNote = col('next action', 7);
    var deals = [], statedTotal = null;
    for (var r = h + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var client = S(row[cClient]);
      if (/^total/i.test(S(row[0])) || /^total/i.test(client)) { statedTotal = money(row[cRev]); continue; }
      if (!client) continue;
      var stageRaw = S(row[cStage]);
      var sm = stageRaw.match(/^(\d)\s*[–—-]\s*(.+)$/);
      var target = parseTarget(row[cTgt]);
      var notes = S(row[cNote]);
      deals.push({
        ref: S(row[0]),
        client: client,
        vertical: S(row[cVert]) || 'Unassigned',
        stageNum: sm ? +sm[1] : null,
        stage: sm ? sm[2].trim() : stageRaw,
        stageLabel: stageRaw,
        priority: S(row[cPri]) || 'Unset',
        target: target.label,
        targetSort: target.sortKey,
        revenue: money(row[cRev]),
        notes: notes,
        flags: flagsFor(notes)
      });
    }
    return { asAt: asAtFrom(rows), deals: deals, statedTotal: statedTotal, sheet: name };
  }

  /* --- Deal Stage Plans ------------------------------------------------ */
  function parseDealPlans(XLSX, wb) {
    var name = findSheet(wb, ['deal stage', 'stage plan']);
    if (!name) return null;
    var rows = rowsOf(XLSX, wb, name);
    var h = findHeader(rows, ['client / partner', 'client']);
    if (h < 0) return null;
    var head = rows[h];
    var lastCol = head.length - 1;
    var stageNames = [];
    for (var c = 2; c <= lastCol - 3; c++) stageNames.push(cleanStageName(head[c]));
    var items = [];
    for (var r = h + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var client = S(row[0]);
      if (isFootnote(client)) continue;
      var steps = [], done = 0;
      for (var i = 0; i < stageNames.length; i++) {
        var st = stepStatus(row[2 + i]);
        if (st.key === 'done') done++;
        steps.push({ name: stageNames[i], key: st.key, label: st.label });
      }
      var target = parseTarget(row[lastCol - 2]);
      items.push({
        client: client,
        vertical: S(row[1]),
        steps: steps,
        stepsDone: done,
        stepCount: stageNames.length,
        progress: stageNames.length ? Math.round((done / stageNames.length) * 100) : 0,
        target: target.label,
        targetSort: target.sortKey,
        priority: S(row[lastCol - 1]) || 'Unset',
        notes: S(row[lastCol]),
        flags: flagsFor(S(row[lastCol]))
      });
    }
    return { stageNames: stageNames, items: items, sheet: name };
  }

  /* --- Funnel Summary (kept only to cross-check the deal list) ---------- */
  function parseFunnel(XLSX, wb) {
    var name = findSheet(wb, ['funnel']);
    if (!name) return null;
    var rows = rowsOf(XLSX, wb, name);
    var stated = null;
    for (var r = 0; r < rows.length; r++) {
      if (/^total/i.test(S((rows[r] || [])[0]))) {
        for (var c = 1; c < rows[r].length; c++) {
          var v = money(rows[r][c]);
          if (v) { stated = v; break; }
        }
      }
    }
    return { statedTotal: stated, sheet: name };
  }

  /* --- top level -------------------------------------------------------- */
  function emptyDataset() {
    return {
      meta: { generatedAt: null, sources: {} },
      pipeline: { asAt: '', deals: [], statedTotal: null },
      dealPlans: { stageNames: [], items: [] },
      courses: { asAt: '', stageNames: [], items: [], footnotes: [] },
      projects: { items: [] },
      updates: []
    };
  }

  /* Merge whatever a workbook contains into `base`. Uploading only one of the
     two trackers refreshes only the sections that file covers. */
  function applyWorkbook(XLSX, wb, fileName, base, stampISO) {
    var data = base || emptyDataset();
    var applied = [];
    var courses = parseCourses(XLSX, wb);
    if (courses) { data.courses = courses; applied.push('Course builds (' + courses.items.length + ')'); }
    var projects = parseProjects(XLSX, wb);
    if (projects) { data.projects = projects; applied.push('Projects (' + projects.items.length + ')'); }
    var pipeline = parsePipeline(XLSX, wb);
    if (pipeline) { data.pipeline = pipeline; applied.push('Pipeline deals (' + pipeline.deals.length + ')'); }
    var plans = parseDealPlans(XLSX, wb);
    if (plans) { data.dealPlans = plans; applied.push('Deal stage plans (' + plans.items.length + ')'); }
    var funnel = parseFunnel(XLSX, wb);
    if (funnel && funnel.statedTotal && data.pipeline && !data.pipeline.statedTotal) {
      data.pipeline.statedTotal = funnel.statedTotal;
    }
    if (!applied.length) return { data: data, applied: [], error: 'No recognised Fideo tracker sheets in this file.' };
    data.meta = data.meta || {};
    data.meta.sources = data.meta.sources || {};
    data.meta.sources[fileName] = { file: fileName, importedAt: stampISO, sections: applied };
    data.meta.generatedAt = stampISO;
    return { data: data, applied: applied, error: null };
  }

  return {
    emptyDataset: emptyDataset,
    applyWorkbook: applyWorkbook,
    parseTarget: parseTarget,
    money: money,
    stepStatus: stepStatus
  };
});
