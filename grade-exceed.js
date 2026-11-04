/* GRADE-EXCEED: his grade rule (decided Fri Oct 23, 2026; docs/CHANGE_DECISIONS.md › GRADE-EXCEED, his words win; build spec
   docs/GRADE_EXCEED_BRIEF.md). Meeting every goal is S; SS needs the goals exceeded by 15%, SSS by 30%. Below S the tighter ladder
   (A 90, B 80, C 70, D 55). Faith, Vigor and Nourish are the #1 grades; Well-being adds up to 5% and never blocks; Family, Career,
   Home and Social gate Overall SS and SSS without being averaged. A missed gate keeps a percent under 100 and the one-item rule stops
   one at 129.9, so a letter is always read from its percent alone. Loaded after health-domain.js (its readers are the record's);
   the page passes what only it reads (steps, water, net energy, sleep). Changes nothing stored. */
'use strict';
const GradeExceed = (() => {
  const CUT = [[130, 'SSS'], [115, 'SS'], [100, 'S'], [90, 'A'], [80, 'B'], [70, 'C'], [55, 'D'], [0, 'F']];
  const letter = pct => Number.isFinite(pct) ? CUT.find(([c]) => pct >= c)[1] : null;
  // §1 the item score: to the goal 0 to 100; past it 100 to 200 at the top, never above
  function itemScore(done, goal, top){
    if (!(goal > 0) || !Number.isFinite(done)) return null;
    if (done <= goal) return 100 * Math.max(0, done) / goal;
    return top > goal ? Math.min(200, 100 + 100 * (done - goal) / (top - goal)) : 100;
  }
  const capped = x => Math.min(100, x);
  const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const r1 = x => x === null || x === undefined ? null : Math.round(x * 10) / 10;

  /* §3 Faith = (church + prayer) / 2 + the journaling bonus, with the gates church, the prayer goal and every fast. Below S: the mean of
     church, prayer and fasting each capped at 100, plus half of what extra prayer and journaling would add above S (at most +10), never
     above 99.9 (his yes). x: {days, church, churchTop, sessions, shapeOk, shape5 (0 to 5, a 7-day week), fastsDue, fastsKept, journal, monthly} */
  function faith(x){
    const D = x.days, O = x.open === undefined ? D : x.open, w = O * 7 / D, goal = Math.min(8, 2 * Math.min(3, w) + Math.min(2, Math.max(0, w - 3))) * D / 7, top = 2 * O, items = [];   // ⊘ (C3): the top drops by 2 a day; the goal only when the open days can't reach it
    const cGoal = x.churchGoal || 1, church = x.church === null || x.church === undefined ? null : itemScore(x.church, cGoal, Math.max(cGoal + 1, x.churchTop || 4));
    const prayer = x.sessions === null || x.sessions === undefined ? null : itemScore(x.sessions, goal, top);
    const bonus = x.journal > 0 ? Math.min(20, 20 * x.journal / (2 * D)) : 0;
    const prayerMet = prayer !== null && x.sessions >= goal - 1e-9 && (x.shapeOk !== false);
    const fastsOk = !(x.fastsDue > 0) || x.fastsKept >= x.fastsDue;
    const gates = (church === null || x.church >= cGoal) && (prayer === null || prayerMet) && fastsOk;
    if (church !== null) items.push({id:'church', name:'Church', score:church, kind:'over', goal:cGoal, top:x.churchTop, done:x.church});
    if (prayer !== null) items.push({id:'prayer', name:'Prayer', score:prayer, kind:'over', goal, top, done:x.sessions, met:prayerMet});
    if (x.fastsDue > 0) items.push({id:'fasting', name:'Fasting', score:100 * Math.min(1, x.fastsKept / x.fastsDue), kind:'must', goal:x.fastsDue, done:x.fastsKept});
    items.push({id:'journal', name:'Journaling', score:bonus, kind:'bonus', done:x.journal || 0, top:2 * D});
    const over = [church, prayer].filter(v => v !== null);
    if (!over.length && !(x.fastsDue > 0)) return {pct:null, letter:null, items, gates};
    if (gates && over.length){ const pct = mean(over) + bonus; return {pct, letter:letter(pct), items, gates, above:true, bonus}; }
    const prayerCap = prayer === null ? null : Math.min(capped(prayer), x.shape5 !== undefined && x.shapeOk === false ? 100 * x.shape5 / 5 : 100);
    const below = [church === null ? null : capped(church), prayerCap, x.fastsDue > 0 ? 100 * Math.min(1, x.fastsKept / x.fastsDue) : null].filter(v => v !== null);
    const boost = Math.min(10, .5 * ((prayer !== null ? Math.max(0, prayer - 100) / 2 : 0) + bonus));
    const pct = Math.min(99.9, mean(below) + boost);
    return {pct, letter:letter(pct), items, gates, above:false, bonus, boost};
  }
  /* §2 and §4 a grade of "over" items and gates: S and above only with every item at its goal and every gate met (the mean of the scores);
     otherwise the mean of the items capped at 100 (gates included as their met share), under 100. The one-item rule (Vigor and Nourish):
     SSS needs two items over their goal, else it stops at 129.9 (SS). */
  function overGrade(items, gateItems, oneItem){
    const over = items.filter(i => i.score !== null);
    if (!over.length) return {pct:null, letter:null, items:over.concat(gateItems), gates:true};
    const gates = gateItems.every(g => g.score >= 100 - 1e-9), all = over.every(i => i.score >= 100 - 1e-9);
    let pct;
    if (all && gates){ pct = mean(over.map(i => i.score)); if (oneItem && over.filter(i => i.score > 100 + 1e-9).length < 2) pct = Math.min(pct, 129.9); }
    else pct = Math.min(99.9, mean(over.concat(gateItems).map(i => capped(i.score))));
    return {pct, letter:letter(pct), items:over.concat(gateItems), gates, above:all && gates};
  }
  // §4 Vigor = (steps + sweat + miles) / 3. x: {days, stepsAvg, sweatDays, miles}
  function vigor(x){
    const D = x.days, wk = D > 1, items = [];   // a week's items scale with the days of the window; a single day leaves them out (BK2)
    if (x.stepsAvg !== null && x.stepsAvg !== undefined) items.push({id:'steps', name:'Steps', score:itemScore(x.stepsAvg, 12000, 24000), kind:'over', goal:12000, top:24000, done:x.stepsAvg, per:'a day'});
    if (wk && x.sweatDays !== null && x.sweatDays !== undefined) items.push({id:'sweat', name:'Sweat', score:itemScore(x.sweatDays, 5 * D / 7, 7 * D / 7), kind:'over', goal:5 * D / 7, top:D, done:x.sweatDays});
    if (wk && x.miles !== null && x.miles !== undefined) items.push({id:'miles', name:'Miles', score:itemScore(x.miles, 25 * D / 7, 50 * D / 7), kind:'over', goal:25 * D / 7, top:50 * D / 7, done:x.miles});
    return overGrade(items, [], true);
  }
  // §4 Nourish = (water + fuel) / 2; Grocery once a week must be met. Fuel is the period's average deficit (a day shows its own). x: {days, waterAvg, deficitAvg, grocery:{done, due}}
  function nourish(x){
    const items = [], gates = [];
    if (x.waterAvg !== null && x.waterAvg !== undefined) items.push({id:'water', name:'Water', score:itemScore(x.waterAvg, 100, 150), kind:'over', goal:100, top:150, done:x.waterAvg, per:'oz a day'});
    if (x.deficitAvg !== null && x.deficitAvg !== undefined) items.push({id:'fuel', name:'Fuel', score:itemScore(x.deficitAvg, 825, 1000), kind:'over', goal:825, top:1000, done:x.deficitAvg, per:'kcal deficit a day'});
    if (x.grocery && x.grocery.due > 0) gates.push({id:'grocery', name:'Grocery', score:100 * Math.min(1, x.grocery.done / x.grocery.due), kind:'must', goal:x.grocery.due, done:x.grocery.done});
    return overGrade(items, gates, true);
  }
  // §5 Well-being: the share of its goals met, S at most; it adds 5% x that share to Overall and never blocks it. goals: [{id, name, met, optional}]
  function wellbeing(goals){
    const counted = goals.filter(g => !g.optional || g.met);
    if (!counted.length) return {pct:null, letter:null, share:null, bonus:0, items:goals};
    const share = counted.filter(g => g.met).length / counted.length, pct = 100 * share;
    return {pct, letter:letter(pct), share, bonus:5 * share, items:goals.map(g => ({...g, score:g.met ? 100 : 0, kind:g.optional ? 'optional' : 'must'}))};
  }
  // §6 a Domain outside the three: each item's done share (capped), count goals that can go over use the item score; S and above only with all met
  function domain(items){ return overGrade(items, [], false); }
  /* §6 Overall = (Faith + Vigor + Nourish) / 3 + the Well-being bonus. S and above need the three at S or above (their gates); SS and SSS
     also need Family, Career, Home and Social met, else S at most (114.9). Below S: the three capped at 100, plus the bonus, under 100. */
  function overall(f, v, n, wb, others){
    const three = [f, v, n].filter(g => g && g.pct !== null);
    if (!three.length) return {pct:null, letter:null, gates:false};
    const bonus = wb && wb.bonus ? wb.bonus : 0, met3 = three.every(g => g.pct >= 100 - 1e-9), metOthers = (others || []).every(g => g.pct === null || g.pct >= 100 - 1e-9);
    let pct;
    if (met3){ pct = mean(three.map(g => g.pct)) + bonus; if (!metOthers) pct = Math.min(pct, 114.9); }
    else pct = Math.min(99.9, mean(three.map(g => capped(g.pct))) + bonus);
    return {pct, letter:letter(pct), gates:met3, othersMet:metOthers, bonus};
  }

  /* ---------- reading the record for a window (from, to): his items by their kind, id or name (the invented record shares the dw- ids) ---------- */
  const NAME = (s, d) => ((versionFor(s, d) || s.versions && s.versions[s.versions.length - 1] || {}).name || '').trim();
  const live = (s, from, to) => !s.demo && (s.versions || []).some(v => v.effectiveFrom <= to) && !(s.archivedAt && String(s.archivedAt).slice(0, 10) <= from);
  const doneDates = (state, id, from, to, partial) => { const out = new Map(); for (const o of Object.values(state.occurrences || {})) if (o.seriesId === id && o.date >= from && o.date <= to && (o.status === 'done' || (partial && o.status === 'partial'))) out.set(o.date, Math.max(out.get(o.date) || 0, o.status === 'done' ? 1 : .5)); return out; };
  const kindOf = (s, d) => { try { return wsKind(s, d) || ''; } catch (_) { return ''; } };
  function find(state, from, to, test){ return (state.series || []).filter(s => live(s, from, to) && test(s)); }
  function days(from, to){ const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; }
  const sundays = (from, to) => days(from, to).filter(d => new Date(d + 'T12:00:00').getDay() === 0).length;
  const isSunday = d => new Date(d + 'T12:00:00').getDay() === 0;
  // A goal of his and its Gena twin read as one line across the cutover: his ended goal still lends its days to a month or a year that crosses it
  const lineOf = (state, list) => [...new Set(list.flatMap(s => genaLine(state, s.id)))].map(id => state.series.find(x => x.id === id)).filter(Boolean);
  const excusedOn = (state, list, d) => list.some(s => { const o = state.occurrences[occKey(s.id, d)]; return !!o && (o.disposition === 'excused' || o.disposition === 'rest'); });
  /* A month's item reads the calendar month of the window's last day, in every view (C5, C6): met once a date lands in it, and while it runs an empty month is "not yet", never a miss */
  const monthOf = to => { const from = to.slice(0, 8) + '01', end = monthEndOf(to); return {from, to:end, running:end >= todayYmd()}; };

  function readFaith(state, from, to, view){
    const D = calendarDistance(from, to) + 1, ds = days(from, to);
    const am = find(state, from, to, s => kindOf(s, to) === 'prayer-am' || s.id === 'dw-prayer-am'), pm = find(state, from, to, s => kindOf(s, to) === 'prayer-pm' || s.id === 'dw-prayer-pm');
    let sessions = null, paired = 0, once = 0;
    if (am.length || pm.length){ const A = new Map(), P = new Map(); for (const s of am) for (const [d, v] of doneDates(state, s.id, from, to, true)) A.set(d, Math.max(A.get(d) || 0, v)); for (const s of pm) for (const [d, v] of doneDates(state, s.id, from, to, true)) P.set(d, Math.max(P.get(d) || 0, v));
      sessions = 0; for (const d of ds){ const a = A.get(d) || 0, p = P.get(d) || 0; sessions += a + p; paired += Math.min(a, p); once += Math.max(a, p); } }
    const amLine = lineOf(state, am), pmLine = lineOf(state, pm), open = D - ds.filter(d => excusedOn(state, amLine, d) && excusedOn(state, pmLine, d)).length;
    const first = Math.min(paired, 3), shape5 = first + Math.min(Math.max(0, once - first), 2), week = D === 7 && view !== 'month', shapeNeed = Math.min(5, open);
    // church: the distinct Sundays of the calendar month of the last day, in every view
    const ch = lineOf(state, find(state, from, to, s => kindOf(s, to) === 'church' || s.id === 'dw-church')), cm = monthOf(to), cDays = days(cm.from, cm.to).filter(isSunday);
    let church = null, cSkip = 0; if (ch.length && D > 1){ const set = new Set(); for (const s of ch) for (const d of doneDates(state, s.id, cm.from, cm.to).keys()) if (isSunday(d)) set.add(d); cSkip = cDays.filter(d => !set.has(d) && excusedOn(state, ch, d)).length; church = set.size || (!cm.running && cSkip < cDays.length) ? set.size : null; }   // an empty month that is over is a miss; every Sunday ⊘ leaves it
    const churchTop = cDays.length - cSkip, cg = ch.length && (versionFor(ch[0], to) || {}).goal, churchGoal = cg && cg.period && cg.period.kind === 'month' && cg.target && cg.target.value >= 1 ? cg.target.value : 1;   // the item's own monthly goal (one Sunday)
    // fasting: the days its plan asked for (Wednesday and Friday, and the season days the plan holds), kept = done; exempt days do not count
    const fs = find(state, from, to, s => kindOf(s, to) === 'fasting' || s.id === 'dw-fasting'); let fastsDue = 0, fastsKept = 0;
    if (fs.length) for (const d of ds) for (const r of flatPlanFor(state, d)) if (fs.some(s => s.id === r.seriesId)){ const o = state.occurrences[occKey(r.seriesId, d)]; if (o && (o.disposition === 'excused' || o.disposition === 'rest')) continue; fastsDue++; if (r.status === 'done') fastsKept++; }
    // journaling: morning and night entries (the Journal page's intention and reflection), or the Journal item done; at most 2 a day
    const js = find(state, from, to, s => kindOf(s, to) === 'journal' || s.id === 'dw-journal'), J = state.journal || {}; let journal = 0;
    const fed = (state.prefs && state.prefs.genaDetail && state.prefs.genaDetail.journal) || {};   // from the cutover: the day's count in Gena, 0 to 2 (C11)
    for (const d of ds){ const e = J[d] || {}, page = (String(e.intention || '').trim() ? 1 : 0) + (String(e.reflection || '').trim() ? 1 : 0), item = js.some(s => { const o = state.occurrences[occKey(s.id, d)]; return o && o.status === 'done'; }) ? 1 : 0; journal += Math.min(2, Math.max(page, item, fed[d] || 0)); }
    return faith({days:D, open, church, churchTop, churchGoal, sessions, shapeOk:week ? shape5 >= shapeNeed - 1e-9 : undefined, shape5:week ? shape5 * 5 / (shapeNeed || 5) : undefined, fastsDue, fastsKept, journal, monthly:view === 'month'});
  }
  function readVigor(state, from, to, io){
    const D = calendarDistance(from, to) + 1, ds = days(from, to);
    const steps = ds.map(d => { const v = io.steps(d); return Number.isFinite(v) ? v : 0; }), stepsAvg = mean(steps);
    // Sweat: a day with 45 minutes of any workout (Cardio, Strength and Workouts are Sweat now); Miles: walking + running distance
    let sweatDays = null, miles = null;
    try { const per = new Map(); for (const r of GoalEngine.autoRecords(state, {kind:'auto', metric:'workouts', types:[], field:'minutes', unit:'min'}, from, to).records) per.set(r.date, (per.get(r.date) || 0) + (Number(r.value) || 0)); sweatDays = [...per.values()].filter(m => m >= 45).length; } catch (_) { sweatDays = null; }
    try { miles = GoalEngine.autoRecords(state, {kind:'auto', metric:'walking_running_distance', unit:'mi'}, from, to).records.reduce((n, r) => n + (Number(r.value) || 0), 0); } catch (_) { miles = null; }
    return vigor({days:D, stepsAvg, sweatDays, miles});
  }
  function readNourish(state, from, to, io){
    const D = calendarDistance(from, to) + 1, ds = days(from, to);
    const waterAvg = mean(ds.map(d => { const v = io.water(d); return Number.isFinite(v) ? v : 0; }));
    const deficitAvg = mean(ds.map(d => { const v = io.net(d); return Number.isFinite(v) ? -v : 0; }));   // a day without its food logged has no deficit to count
    const gr = find(state, from, to, s => s.id === 'groceries' || /^grocer(y|ies)$/i.test(NAME(s, to)));
    // Grocery, once a week: due once per whole week in the window; a part week asks it only once it is done (it is not late yet)
    let grocery = null; if (gr.length && D > 1){ const done = new Set(); for (const s of gr) for (const d of doneDates(state, s.id, from, to).keys()) done.add(d); const due = Math.floor(D / 7) || (done.size ? 1 : 0); grocery = {done:Math.min(done.size, due), due}; }
    return nourish({days:D, waterAvg, deficitAvg, grocery});
  }
  const WB_DAILY = [['dw-brush', 'Morning Brush'], ['dw-floss', 'Floss'], ['dw-tongue', 'Tongue'], ['dw-rinse', 'Rinse'], ['dw-wash-face', 'Face'], ['dw-shower', 'Shower'], ['dw-bathroom-1', 'B1'], ['dw-bathroom-2', 'B2'], ['dw-night-brush', 'Night Brush']];
  function readWellbeing(state, from, to, io, view){
    const D = calendarDistance(from, to) + 1, need = Math.max(1, Math.round(5 * D / 7)), goals = [], cm = monthOf(to);
    const sl = find(state, from, to, s => kindOf(s, to) === 'sleep' || s.id === 'dw-sleep');
    if (sl.length){ const n = days(from, to).filter(d => { const m = io.sleepMin(d); return Number.isFinite(m) && m >= 360; }).length; goals.push({id:'sleep', name:'Sleep 6 h', met:n >= need, done:n, goal:need}); }
    const byName = re => find(state, from, to, s => re.test(NAME(s, to)) && gradeGroupUmbrella(state, (versionFor(s, to) || {}).category || s.category) === 'health');
    for (const [name, re, optional] of [['SUD Individual', /^SUD Individual$/i], ['SUD Group', /^SUD Group$/i], ['RX', /^RX$/i], ['Therapy', /^Therapy$/i, true]]){
      const list = byName(re); if (!list.length) continue; const all = lineOf(state, list), met = all.some(s => doneDates(state, s.id, cm.from, cm.to).size > 0);
      if (!met && (cm.running || days(cm.from, cm.to).some(d => excusedOn(state, all, d)))) continue;   // not yet, or ⊘: it leaves the month
      goals.push({id:list[0].id, name, met, optional:!!optional});
    }
    for (const [id, name] of WB_DAILY){   // his goal and its Gena twin (genaFed.goal): the day counts once, whichever holds it
      const list = (state.series || []).filter(x => (x.id === id || (x.genaFed && x.genaFed.goal === id)) && live(x, from, to)); if (!list.length) continue;
      const on = new Set(); for (const s of list) for (const d of doneDates(state, s.id, from, to).keys()) on.add(d); const n = on.size, open = D - days(from, to).filter(d => !on.has(d) && excusedOn(state, list, d)).length, want = Math.round(5 * open / 7);   // ⊘: 5 of 7 scales with the open days
      if (open) goals.push({id, name, met:n >= want, done:n, goal:want}); }
    return wellbeing(goals);
  }
  // §6 the other Domains from the rows the grade already reads (one-time tasks in their due week, targets pro-rated, summaries left out)
  function readDomains(state, from, to){
    const cfg = gradeConfig(state), rows = gradeRows(state, from, to), by = new Map();
    for (const r of rows){
      const u0 = gradeGroupUmbrella(state, r.gid), u = u0 === 'social' ? 'family' : u0; if (!['family', 'career', 'growth', 'home'].includes(u) && !/^d-/.test(u || '')) continue;   // Family & Friends is one grade (his structure, Oct 31)
      const s = (state.series || []).find(x => x.id === r.seriesId), v = s && (versionFor(s, to) || latestVersion(s)), c = cfg.items[r.seriesId] || {};
      if (c.included === false || c.importance === 0 || /^Dr\.? Dan$/i.test(r.name || '')) continue;   // Dr. Dan stays out (his rule 5)
      const opt = !!(v && v.optional);
      if (opt && !(r.done > 0)) continue;   // optional: skipped is no penalty, done is met (rule 6)
      if (!by.has(u)) by.set(u, {jobs:null, items:[]});
      const b = by.get(u), name = r.name || (v && v.name) || '';
      if (/^Job \d$/i.test(name)){ if (!b.jobs) b.jobs = {id:'jobs', name:'Jobs', planned:0, done:0}; b.jobs.planned += r.planned; b.jobs.done += r.done; continue; }
      const counter = state.prefs && state.prefs.genaDetail && state.prefs.genaDetail.counters[r.seriesId];
      if (counter){ const D = calendarDistance(from, to) + 1, goal = counter.goalN * D / 7, n = days(from, to).reduce((a, d) => a + (counter.log[d] || 0), 0); b.items.push({id:r.seriesId, name, done:n, goal, score:itemScore(n, goal, 2 * goal), kind:'over'}); continue; }   // the week's goal as he sets it in Gena; the top is twice it
      const once = ((state.prefs.genaDetail || {}).once || {})[r.seriesId] || (r.seriesId === 'v2-make-bed' && v && v.recurrence ? {days:v.recurrence.days} : null);
      if (once){ const list = lineOf(state, [s]), ds = days(from, to), on = new Set(); for (const x of list) for (const d of doneDates(state, x.id, from, to).keys()) on.add(d); const off = d => !on.has(d) && excusedOn(state, list, d), open = ds.filter(d => !off(d)).length, goal = open ? Math.min(r.planned, Math.max(1, ds.filter(d => once.days.includes(new Date(d + 'T12:00:00').getDay()) && !(once.start && d < once.start) && !off(d)).length)) : 0;   // one a day, so the top is the open days; the goal stands unless its own days less ⊘ can't reach it, as Gena's habitTop
        b.items.push({id:r.seriesId, name, done:on.size, goal, score:opt ? 100 : itemScore(on.size, goal, open), kind:'over'}); continue; }
      b.items.push({id:r.seriesId, name, done:r.done, goal:r.planned, score:opt ? 100 : r.planned ? 100 * Math.min(1, r.done / r.planned) : null, kind:opt ? 'optional' : 'must'});
    }
    const out = {};
    for (const [u, b] of by){ const items = b.items.slice(); if (b.jobs && b.jobs.planned > 0) items.push({...b.jobs, goal:b.jobs.planned, score:itemScore(b.jobs.done, b.jobs.planned, 2 * b.jobs.planned), kind:'over'}); out[u] = domain(items.filter(i => i.score !== null)); }
    return out;
  }
  /* V6.1.5 Faith in each area (his yes, Nov 4): an area with its switch on shows (1 − share) × its own + share × Faith, on the engine's
     scale (both can pass 100), and the Overall reads the blend: Vigor and Nourish take Health's, the gates read the blended Domains. Faith
     null leaves an area as it is. In this path an area is on only when its stored faith is true (what he has seen since V6); the share is
     its stored faithShare, else GRADE_FAITH_SHARE (20%). Changes nothing stored. */
  const faithBlend = (state, id) => { if (id === 'faith') return {on:false, share:0}; const c = ((state && state.gradeConfig && state.gradeConfig.umbrellas) || {})[id] || {}, dflt = typeof GRADE_FAITH_SHARE === 'number' ? GRADE_FAITH_SHARE : .2; return {on:c.faith === true, share:Number.isFinite(c.faithShare) ? c.faithShare : dflt}; };
  const blendWith = (pct, b, f) => pct === null || pct === undefined || !b.on || f === null || f === undefined ? pct : (1 - b.share) * pct + b.share * f;
  const blended = (g, b, f) => { if (!g) return g; const pct = blendWith(g.pct, b, f); return pct === g.pct ? g : {...g, pct, letter:letter(pct), own:g.pct}; };
  /* The whole report for a window. view: 'day', 'week' (any span of 7 days or more that is not a calendar month) or 'month'. io: the page's
     readers {steps(d), water(d), net(d), sleepMin(d)} (each a number or null). */
  function report(state, from, to, io, view){
    const D = calendarDistance(from, to) + 1, v = view || (D === 1 ? 'day' : from.slice(8) === '01' && D >= 28 ? 'month' : 'week');
    const f = readFaith(state, from, to, v), vg = readVigor(state, from, to, io), n = readNourish(state, from, to, io), wb = readWellbeing(state, from, to, io, v), dom = readDomains(state, from, to);
    const blend = {}; for (const id of ['health', 'family', 'career', 'growth', 'home'].concat(Object.keys(dom))) blend[id] = faithBlend(state, id);
    const hb = blend.health, gate = k => blended(dom[k], blend[k], f.pct);
    const o = overall(f, blended(vg, hb, f.pct), blended(n, hb, f.pct), wb, ['family', 'career', 'home'].map(gate).filter(Boolean));   // these three gate SS and SSS (GLOW_GENA_NAMES §1), blended where Faith counts in them. Growth and custom Domains show their own grade and gate nothing
    return {from, to, view:v, days:D, faith:f, vigor:vg, nourish:n, wellbeing:wb, domains:dom, overall:o, blend};
  }
  /* The report in the shape the page's grade cards read (umbrellaGradeReport): Faith; Health holding Vigor, Nourish and Well-being as its groups
     (its own is the mean of Vigor and Nourish, for the card; Overall is computed by the rule above, not from it); Family, Career, Home and
     Social; Hobbies ungraded. An item's score may pass 100 (to 200). */
  function umbrellaReport(state, from, to, program, period, io){
    const view = period === 'month' ? 'month' : from === to ? 'day' : 'week', r = report(state, from, to, io, view);
    const it = (x, gid) => ({seriesId:'exceed:' + x.id, name:x.name, gid, planned:Number.isFinite(x.goal) ? x.goal : 1, done:Number.isFinite(x.done) ? x.done : x.met ? 1 : 0, score:x.score === undefined ? null : x.score, importance:5, included:true, tier:'required', kind:x.kind, met:x.met});
    const grp = (gid, name, g) => ({gid, name, items:(g.items || []).map(x => it(x, gid)), score:g.pct, letter:g.letter, importance:5, included:true, tiers:null});
    const U = id => GRADE_UMBRELLAS.find(u => u.id === id) || {id, name:id, emoji:''};
    const um = (id, own, groups, included) => { const b = r.blend[id] || faithBlend(state, id), shown = blendWith(own, b, r.faith.pct);   // V6.1.5: the card shows the blend the Overall reads
      return {id, name:U(id).name, emoji:U(id).emoji, groups, own, displayed:shown, letter:letter(shown), ownLetter:letter(own), tiers:null, importance:id === 'faith' || id === 'health' ? 10 : 0, included:included !== false && own !== null, faithOn:b.on, faithShare:b.share}; };
    const health = [r.vigor.pct, r.nourish.pct].filter(v => v !== null), healthOwn = health.length ? mean(health) : null;
    const umbrellas = [um('faith', r.faith.pct, r.faith.pct === null ? [] : [grp('faith', 'Faith', r.faith)]),
      um('health', healthOwn, [r.vigor.pct !== null ? grp('fitness', 'Vigor', r.vigor) : null, r.nourish.pct !== null ? grp('food', 'Nourish', r.nourish) : null, r.wellbeing.pct !== null ? grp('wellbeing', 'Well-being', r.wellbeing) : null].filter(Boolean))]
      .concat(['family', 'career', 'growth', 'home'].map(id => { const d = r.domains[id]; return um(id, d ? d.pct : null, d ? [grp('exceed:' + id, U(id).name, d)] : []); }))
      .concat(GRADE_UMBRELLAS.filter(u => u.custom).map(u => { const d = r.domains[u.id]; return um(u.id, d ? d.pct : null, d ? [grp('exceed:' + u.id, u.name, d)] : []); }))
      .concat([um('hobbies', null, [], false)]);
    const sh = r.faith.pct !== null ? 1 : 0, sv = r.vigor.pct !== null ? 1 : 0, sn = r.nourish.pct !== null ? 1 : 0, tot = sh + sv + sn;
    for (const u of umbrellas) u.share = !tot ? 0 : u.id === 'faith' ? 100 * sh / tot : u.id === 'health' ? 100 * (sv + sn) / tot : 0;
    const due = umbrellas.reduce((n, u) => n + u.groups.reduce((m, g) => m + g.items.length, 0), 0);
    return {from, to, program, period:period || 'day', overall:r.overall.pct, letter:r.overall.letter, umbrellas, unassigned:[], counted:due, listed:0, due, tiered:false, exceed:r};
  }
  return {CUT, letter, itemScore, faith, vigor, nourish, wellbeing, domain, overall, report, umbrellaReport, r1, blendWith};
})();
if (typeof window !== 'undefined') window.GradeExceed = GradeExceed;
if (typeof module !== 'undefined') module.exports = GradeExceed;
