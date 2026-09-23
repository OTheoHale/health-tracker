
/* ===================================================================
   Health Tracker — domain + storage. No DOM access in this script:
   health-tracker/test.js evaluates it directly in Node.
   =================================================================== */
const SCHEMA = 5;
/* Versioned migrations. Each step is additive and idempotent; a record or
   export from an older schema is brought forward on read, never rewritten
   on disk until the next ordinary save. A newer schema is refused. */
const MIGRATIONS = [
  { from:4, to:5, note:'dated hierarchy, explicit quarter-point epochs and manual meal/water events; no automatic rule adoption', up(state){ if(typeof MealWater!=='undefined')MealWater.ensure(state); } },
  { from: 3, to: 4, note: 'explicit confirmation and versioned action-point accounts; old progression retained until adoption', up(state){ state.revision = 0; } },
  { from: 1, to: 2, note: 'groups, goals, sources, foods, reminders, hydration, notes, profile, observations', up(state){ migrate(state); } },
  { from: 2, to: 3, note: 'preserved reward ledger, grade settings, task families, journal and import receipts', up(state){ migrate(state); } },
];
function migrateTo(state){
  if (!state || typeof state !== 'object') return state;
  let v = typeof state.schema === 'number' ? state.schema : 1;
  while (v < SCHEMA){
    const m = MIGRATIONS.find(x => x.from === v);
    if (!m) break;
    m.up(state); v = m.to; state.schema = v;
  }
  migrate(state);
  return state;
}
const BUILD = '2026-09-21-daily-workspace-candidate';
// Raised from 20,000 on 2026-09-22. Minute-bucketed Health Auto Export lands about 2,300 rows a
// day, so the old cap was eight days of history. Source rows live in IndexedDB, not the 5 MB
// localStorage record, and measured cost at this size is 20.7 MB / 50 ms serialize / 67 ms
// parse — comfortable. Roughly three months of continuous minute-level intake.
const AUTO_SOURCE_LIMIT = 200000;
const STORE_KEY = 'health-tracker-v1';
const EXPORT_FORMAT = 'health-tracker-export';

const ANCHORS = [
  { id:'morning', label:'After getting up' },
  { id:'midday',  label:'During the day' },
  { id:'evening', label:'Evening' },
  { id:'night',   label:'Wind-down' },
];
/* Legacy per-series categories. Kept as written so no stored record or old
   export changes meaning; each one resolves to a group below. */
const CATEGORIES = [
  { id:'movement',  label:'Movement' },
  { id:'sleep',     label:'Sleep' },
  { id:'eating',    label:'Eating' },
  { id:'routine',   label:'Routine' },
  { id:'household', label:'Household' },
];
const LEGACY_GROUP = { movement:'fitness', sleep:'fitness', eating:'food', routine:'care', household:'care' };
/* Activity groups: the user's configurable categories. Built-ins can be
   hidden (records kept), renamed, and reordered; custom ones added. */
const DEFAULT_GROUPS = [
  { id:'fitness',   name:'Fitness & recovery', icon:'run',   order:1 },
  { id:'food',      name:'Food & hydration',   icon:'meal',  order:2 },
  { id:'care',      name:'Care & home',        icon:'home',  order:3 },
  { id:'faith',     name:'Faith',              icon:'cross', order:4 },
  { id:'work',      name:'Work & learning',    icon:'work',  order:5 },
  { id:'interests', name:'Hobbies', icon:'star',  order:6 },
];
/* Suggested activities per group: a catalog the user may add from.
   Nothing here is scheduled until the user picks days and confirms. */
const CATALOG = [
  { group:'fitness', name:'Workout', anchor:'midday', normal:'A planned session', minimum:'Ten easy minutes' },
  { group:'fitness', name:'Mobility', anchor:'evening', normal:'Ten to fifteen minutes of stretching', minimum:'Two stretches', optional:true },
  { group:'fitness', name:'Sleep schedule', anchor:'night', normal:'In bed by the time you chose', minimum:'Lights lower, screens away' },
  { group:'fitness', name:'Evening wind-down', anchor:'night', normal:'Half an hour of quiet', minimum:'Ten quiet minutes' },
  { group:'food', name:'Eat well', anchor:'midday', normal:'A real meal, sat down', minimum:'Something familiar, roughly on time' },
  { group:'food', name:'Hydration', anchor:'midday', normal:'Water through the day', minimum:'One glass with each meal' },
  { group:'food', name:'Meal planning', anchor:'evening', normal:'Decide tomorrow\'s meals', minimum:'Decide the first meal' },
  { group:'food', name:'Groceries & meal prep', anchor:'midday', normal:'Shop and prepare two easy meals', minimum:'Check what is in' },
  { group:'food', name:'Cooking', anchor:'evening', normal:'Cook one thing', minimum:'Assemble something simple', optional:true },
  { group:'care', name:'Brush & floss', anchor:'night', normal:'Brush and floss', minimum:'Brush' },
  { group:'care', name:'Shower & personal hygiene', anchor:'morning', normal:'Shower and basic care', minimum:'Face and teeth' },
  { group:'care', name:'Laundry', anchor:'evening', normal:'Wash, dry, and put away', minimum:'One load started', days:[0] },
  { group:'care', name:'Home routine', anchor:'evening', normal:'Ten minutes of tidying', minimum:'Clear one surface' },
  { group:'faith', name:'Prayer', anchor:'morning', normal:'Prayer at the time you choose', minimum:'A short prayer', days:[0,1,2,3,4,5,6] },
  { group:'faith', name:'Church', anchor:'morning', normal:'Attend', minimum:'Attend part of it', days:[0] },
  { group:'work', name:'Work / focus block', anchor:'midday', normal:'One focused block', minimum:'Twenty-five minutes', days:[1,2,3,4,5] },
  { group:'work', name:'Learning', anchor:'evening', normal:'Thirty minutes on what you are learning', minimum:'Ten minutes', optional:true },
  { group:'interests', name:'Art practice', anchor:'evening', normal:'A sitting at the easel or sketchbook', minimum:'One quick sketch', optional:true },
  { group:'interests', name:'Learning about art', anchor:'evening', normal:'Read or watch one piece', minimum:'One page', optional:true },
  { group:'interests', name:'Cooking skills', anchor:'evening', normal:'Practice one technique', minimum:'Watch how it is done', optional:true },
];
/* Planned connections: named by the user, none verified. A source state is a
   claim about evidence, never a button that pretends to connect. */
const SOURCES = [
  { id:'apple-fitness', name:'Apple Fitness', route:'Through Apple Health, on a device; a desktop page cannot read it directly' },
  { id:'bevel-pro',     name:'Bevel Pro',     route:'Supported metrics reach Apple Health; proprietary scores are not exported' },
  { id:'ifit',          name:'iFIT',          route:'Apple Health connection documented; program catalog access unverified' },
];
const SOURCE_STATES = ['unverified','connected','partial','error','unavailable'];
/* Fitness attributes stay unassessed until a metric, evidence window and
   versioned rule exist. Rank labels follow the gaming convention; cutoffs
   are not approved and are not computed here. */
const ATTRIBUTES = [ { id:'strength', name:'Strength' }, { id:'endurance', name:'Endurance' }, { id:'cardio', name:'Cardio' } ];
const RANK_LADDER = ['D','C','B','A','S','SS'];
/* Four kinds of information, kept visibly apart everywhere they appear. */
const PROVENANCE = ['reported','proposed','logged','unknown'];
const NIGHT_EATING = [
  { id:'woke',    label:'Woke from sleep and ate' },
  { id:'awake',   label:'Was still awake and ate' },
  { id:'neither', label:'Neither' },
  { id:'unknown', label:'Not sure' },
];
const ENERGY = [ { id:'low', label:'Low' }, { id:'okay', label:'Okay' }, { id:'good', label:'Good' } ];
const MEAL_TAGS = [ { id:'first', label:'First meal' }, { id:'main', label:'Main meal' }, { id:'dinner', label:'Dinner' }, { id:'snack', label:'Snack' }, { id:'drink', label:'Drink' }, { id:'other', label:'Other' } ];
const THEMES = ['dark','light','system'];
const anchorOrder = id => { const i = ANCHORS.findIndex(a => a.id === id); return i < 0 ? 99 : i; };

/* ---- local calendar days. Never round-trip through UTC: a date here
        means "the day Mintay is living in", not an instant. ---- */
const pad = n => String(n).padStart(2, '0');
function ymd(d){ return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function parseYmd(s){ return new Date(+s.slice(0,4), +s.slice(5,7)-1, +s.slice(8,10)); }
function addDays(s, n){ const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function dow(s){ return parseYmd(s).getDay(); }
function todayYmd(){ return ymd(new Date()); }
function nowIso(){ return new Date().toISOString(); }
function weekStartOf(date, weekStart){ return addDays(date, -((dow(date) - weekStart + 7) % 7)); }
function weekDays(start){ return [0,1,2,3,4,5,6].map(i => addDays(start, i)); }
function tzName(){
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'; }
  catch(e){ return 'unknown'; }
}
function newId(prefix){ return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

/* ---- template versions are append-only. A date resolves to the version
        that was in force on that date, so editing the future can never
        reach back and rewrite a past target. ---- */
function versionFor(series, date){
  let out = null;
  for (const v of series.versions){
    if (v.effectiveFrom <= date && (!out || v.effectiveFrom >= out.effectiveFrom)) out = v;
  }
  return out;
}
function latestVersion(series){
  return series.versions.reduce((a, v) => (!a || v.version > a.version) ? v : a, null);
}
function scheduledOn(ver, date){
  const r = ver.recurrence || {};
  if (r.kind === 'once') return r.date === date;
  if (r.startDate && date < r.startDate) return false;
  if (r.endDate && date > r.endDate) return false;
  const variant = recurrenceVariant(ver, date);
  if (!(variant ? variant.days : r.days || []).includes(dow(date))) return false;
  if (r.kind === 'weekly' && r.intervalWeeks > 1 && r.startDate){
    const elapsed = calendarDistance(weekStartOf(r.startDate, 1), weekStartOf(date, 1));
    return Math.floor(elapsed / 7) % r.intervalWeeks === 0;
  }
  return true;
}
function calendarDistance(from, to){
  const a = from.split('-').map(Number), b = to.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1]-1, b[2]) - Date.UTC(a[0], a[1]-1, a[2])) / 86400000);
}
function recurrenceVariant(ver, date){
  return ((ver.recurrence || {}).variants || []).filter(v => v.from <= date && date <= v.to).slice(-1)[0] || null;
}

const occKey = (seriesId, date) => seriesId + '|' + date;

/* A row is a version's fields with any one-day override laid on top. */
function legacyPlanFor(state, date){
  const rows = [];
  for (const s of state.series){
    if (s.archivedAt && s.archivedAt <= date) continue;
    const ver = versionFor(s, date);
    if (!ver) continue;
    const occ = state.occurrences[occKey(s.id, date)] || null;
    if (occ && occ.removed) continue;
    const scheduled = scheduledOn(ver, date);
    if (!scheduled && !(occ && (occ.added || occ.status !== null)) && !ver.childIds) continue;
    const ov = (occ && occ.override) || {};
    const variant = recurrenceVariant(ver, date);
    const normal = ov.normal || (variant && variant.normal) || ver.normal, minimum = ov.minimum || (variant && variant.minimum) || ver.minimum;
    const selected = occ ? occ.selected : 'normal';
    rows.push({
      key: occKey(s.id, date), seriesId: s.id, date,
      name: ov.name || ver.name, category: s.category,
      anchor: ov.anchor || ver.anchor,
      window: ov.window !== undefined ? ov.window : (ver.window || ''),
      order: ver.order, version: ver.version, demo: !!s.demo,
      targets: { normal, minimum },
      selected, target: selected === 'minimum' ? minimum : normal,
      status: occ && occ.status === 'done' && confirmedProgression(state) && !actionConfirmation(state,occ).confirmed ? 'tentative' : occ ? occ.status : null,
      confirmation: occ&&occ.aliasOf ? 'Same action · linked in Log' : occ ? actionConfirmation(state,occ).label : 'No entry',
      completedVersion: occ ? occ.completedVersion : null,
      actualMinutes: occ ? occ.actualMinutes : null,
      note: occ ? occ.note : '',
      corrections: occ ? occ.corrections.length : 0,
      added: !!(occ && occ.added), addedFrom: occ ? (occ.addedFrom || null) : null,
      overridden: !!(occ && occ.override),
      aliasOf:occ&&occ.aliasOf||null, optional: !!ver.optional, once: !!(ver.recurrence && ver.recurrence.kind === 'once'),
      group: groupOf(s),
      parentId:s.parentId || null, childIds:ver.childIds || null,
      session:(ver.recurrence || {}).session || '', variant:variant ? variant.label : '',
      recurrence:ver.recurrence, matching:ver.matching || null,
      targetProgress:targetProgress(state, s.id, date),
    });
  }
  const time = r => /^([01]\d|2[0-3]):[0-5]\d$/.test(r.window || '') ? r.window : '99:99';
  rows.sort((a, b) =>
    time(a).localeCompare(time(b)) || anchorOrder(a.anchor) - anchorOrder(b.anchor) ||
    a.order - b.order ||
    a.name.localeCompare(b.name));
  return rows.filter(r => !r.parentId).map(r => {
    if (!r.childIds) return r;
    r.children = rows.filter(c => r.childIds.includes(c.seriesId));
    r.family = familySummary(r.children);
    r.status = r.family.status;
    r.completedVersion = r.status === 'done' ? (r.family.minimum ? 'minimum' : 'normal') : null;
    return r;
  }).filter(r => !r.childIds || r.children.length);
}
function flatPlanFor(state, date){ return leafRows(planFor(state,date)).filter(r=>!confirmedProgression(state)||!r.aliasOf); }
function findPlanRow(state, seriesId, date){
  const rows = planFor(state, date);
  return allRows(rows).find(r => r.seriesId === seriesId) || null;
}
function familySummary(children){
  const required = children.filter(c => !c.optional), basis = required.length ? required : children;
  const done = children.filter(c => c.status === 'done').length;
  const minimum = basis.filter(c => c.status === 'done' && c.completedVersion === 'minimum').length;
  const partial = children.filter(c => c.status === 'partial').length;
  const status = basis.length && basis.every(c => c.status === 'done') ? 'done'
    : done || partial ? 'partial'
    : basis.length && basis.every(c => c.status === 'skipped') ? 'skipped' : null;
  return { total:children.length, required:required.length, done, minimum, partial, status };
}

/* Occurrences taken off a day, so they can be put back. */
function removedFor(state, date){
  const out = [];
  for (const o of Object.values(state.occurrences)){
    if (o.date !== date || !o.removed) continue;
    const s = state.series.find(x => x.id === o.seriesId);
    const ver = s && versionFor(s, date);
    if (!ver) continue;
    out.push({ seriesId: o.seriesId, date, name: ver.name, movedTo: o.movedTo || null });
  }
  return out;
}

/* No entry is not a failure — it is simply the next thing available. */
function nextAction(rows){ const leaves=leafRows(rows);return leaves.find(r => r.status === 'tentative') || leaves.find(r => r.status === null) || null; }

function outcomeOf(r){
  if (r.status === null || r.status === 'tentative') return 'none';
  if (r.status === 'skipped') return 'skipped';
  if (r.status === 'partial') return 'partial';
  return r.completedVersion === 'minimum' ? 'minimum' : 'normal';
}
function tallyDay(rows){
  const t = { normal:0, minimum:0, partial:0, skipped:0, none:0 };
  for (const r of leafRows(rows)) t[outcomeOf(r)]++;
  return t;
}
/* Over a range of days. A day that has not arrived yet is "ahead", never
   "no entry": the five outcome states are only claimed for lived days. */
function tallyRange(state, dates, today, opts){
  const includeDemo = !!(opts && opts.includeDemo);
  const totals = { normal:0, minimum:0, partial:0, skipped:0, none:0, ahead:0, planned:0, examplesLeftOut:0 };
  const by = {};
  for (const d of dates){
    for (const r of flatPlanFor(state, d)){
      if (r.demo && !includeDemo){ totals.examplesLeftOut++; continue; }
      if (state.groups && state.groups.some(g => g.id === r.group && g.hidden)) continue;
      totals.planned++;
      const b = by[r.seriesId] || (by[r.seriesId] = { seriesId:r.seriesId, name:r.name, normal:0, minimum:0, partial:0, skipped:0, none:0, ahead:0 });
      let k = outcomeOf(r);
      if (k === 'none' && d > today) k = 'ahead';
      totals[k]++; b[k]++;
    }
  }
  return { totals, bySeries: Object.values(by) };
}

/* ---- occurrence records exist only when there is something to remember ---- */
function ensureOcc(state, seriesId, date){
  const k = occKey(seriesId, date);
  if (!state.occurrences[k]){
    const s = state.series.find(x => x.id === seriesId);
    const ver = s ? versionFor(s, date) : null;
    state.occurrences[k] = {
      seriesId, date, version: ver ? ver.version : null,
      rewardEventId:k,
      selected:'normal', status:null, completedVersion:null,
      actualMinutes:null, note:'', loggedAt:null, corrections:[],
      removed:false, added:false, override:null, updatedAt:null,
    };
  }
  return state.occurrences[k];
}
const touch = o => { o.updatedAt = nowIso(); };

const snapshot = o => ({
  status:o.status, selected:o.selected, completedVersion:o.completedVersion,
  actualMinutes:o.actualMinutes, note:o.note, confirmation:o.confirmation || null,
});
function recordCorrection(o, before, at){
  if (before.status !== null) o.corrections.push({ at, from: before, to: snapshot(o) });
}

/* Changes the planned target for this occurrence only. Deliberately does
   not touch status or actual activity — §4: switching versions after
   logging must not erase what actually happened. */
function selectVersion(state, seriesId, date, which){
  const series = state.series.find(s => s.id === seriesId), ver = series && versionFor(series, date);
  if (ver && ver.childIds){
    for (const child of flatPlanFor(state, date).filter(r => r.parentId === seriesId && r.status === null)) selectVersion(state, child.seriesId, date, which);
    return null;
  }
  const o = ensureOcc(state, seriesId, date);
  const before = snapshot(o);
  o.selected = which;
  recordCorrection(o, before, nowIso());
  touch(o);
  pruneOcc(state, occKey(seriesId, date));   // back to normal with nothing else = nothing to remember
  return state.occurrences[occKey(seriesId, date)] || null;
}

function logOcc(state, seriesId, date, status, extra){
  const series = state.series.find(s => s.id === seriesId), ver = series && versionFor(series, date);
  if (ver && ver.childIds) return null;
  const o = ensureOcc(state, seriesId, date);
  o.evidenceOnly = false;
  const before = snapshot(o);
  const at = nowIso();
  o.status = status;
  o.completedVersion = (status === 'done' || status === 'partial') ? o.selected : null;
  if (extra && extra.minutes !== undefined) o.actualMinutes = extra.minutes;
  if (extra && extra.note !== undefined) o.note = extra.note;
  o.loggedAt = at;
  if (status === 'done'){ o.confirmation = {kind:'self',at,target:o.selected,minutes:o.actualMinutes,ruleVersion:1};if(!o.rewardRule&&ver)o.rewardRule={scoring:scoringRule(ver.scoring),matching:ver.matching?JSON.parse(JSON.stringify(ver.matching)):null}; }
  else o.confirmation = null;
  recordCorrection(o, before, at);
  touch(o);
  return o;
}

function annotate(state, seriesId, date, extra){
  const o = ensureOcc(state, seriesId, date);
  const before = snapshot(o);
  if (extra.minutes !== undefined){ o.actualMinutes = extra.minutes; if (o.confirmation && o.confirmation.minutes !== extra.minutes) o.confirmation = null; }
  if (extra.note !== undefined) o.note = extra.note;
  recordCorrection(o, before, nowIso());
  touch(o);
  return o;
}

/* Back to genuinely no entry — distinct from an explicit skip. Plan-level
   facts about the day (version, override, moves) are kept. */
function clearOcc(state, seriesId, date){
  const k = occKey(seriesId, date);
  const o = state.occurrences[k];
  if (!o) return;
  o.confirmation = null; o.status = null; o.completedVersion = null; o.actualMinutes = null; o.note = ''; o.loggedAt = null;
  touch(o);
  pruneOcc(state, k);
}
function pruneOcc(state, k){
  const o = state.occurrences[k];
  if (o && o.status === null && o.selected === 'normal' && !o.removed && !o.added &&
      !o.override && !o.note && o.actualMinutes === null && !o.corrections.length && (!o.rewardEventId || o.rewardEventId === k)) delete state.occurrences[k];
}

/* ---- one-day changes: "this occurrence", never the series ---- */
function overrideOcc(state, seriesId, date, fields){
  const o = ensureOcc(state, seriesId, date);
  o.override = Object.assign({}, o.override || {}, fields);
  touch(o);
  return o;
}
function removeOcc(state, seriesId, date){
  const o = ensureOcc(state, seriesId, date);
  if (o.status !== null) return null;      // what happened, happened
  o.removed = true;
  touch(o);
  return o;
}
function restoreOcc(state, seriesId, date){
  const k = occKey(seriesId, date);
  const o = state.occurrences[k];
  if (!o) return null;
  if (o.movedTo){
    const chain = [], seen = new Set([date]);
    let previous = o;
    while (previous.movedTo){
      if (seen.has(previous.movedTo)) return null;
      seen.add(previous.movedTo);
      const next = state.occurrences[occKey(seriesId,previous.movedTo)];
      if (!next || !next.added || next.addedFrom !== previous.date || next.status !== null) return null;
      chain.push(next); previous = next;
    }
    const last = chain[chain.length-1];
    o.rewardEventId = rewardIdentity(state,last);
    o.selected = last.selected; o.override = last.override;
    o.actualMinutes = last.actualMinutes; o.note = last.note;
    o.corrections = (o.corrections || []).concat(last.corrections || []);
    for (const moved of chain) delete state.occurrences[occKey(seriesId,moved.date)];
  }
  o.removed = false; o.movedTo = null;
  touch(o);
  pruneOcc(state, k);
  return o;
}
function moveOcc(state, seriesId, from, to){
  if (from === to || !validCalendarDate(from) || !validCalendarDate(to)) return null;
  const series = state.series.find(s => s.id === seriesId), version = series && versionFor(series, from);
  const destinationVersion = series && versionFor(series,to), parent = series && series.parentId && state.series.find(s => s.id === series.parentId);
  if (!version || version.childIds || !destinationVersion || destinationVersion.childIds || (series.archivedAt && series.archivedAt <= to) || (parent && parent.archivedAt && parent.archivedAt <= to)) return null;
  const src = ensureOcc(state, seriesId, from);
  if (src.status !== null || src.removed) return null;
  const existing = state.occurrences[occKey(seriesId, to)];
  if (existing && (existing.status !== null || existing.added || existing.removed || existing.override || existing.note || existing.selected !== 'normal' || existing.actualMinutes !== null || existing.corrections.length)) return null;
  const dst = ensureOcc(state, seriesId, to);
  dst.added = true; dst.addedFrom = from;
  dst.rewardEventId = src.rewardEventId || occKey(seriesId, from);
  dst.selected = src.selected; dst.override = src.override;
  src.removed = true; src.movedTo = to;
  touch(src); touch(dst);
  return dst;
}
/* A lighter day is a first-class plan, not a mood: every unlogged
   activity on that day takes the chosen version. */
function setDayVersion(state, date, which){
  let n = 0;
  for (const r of flatPlanFor(state, date)){
    if (r.status !== null || r.selected === which) continue;
    selectVersion(state, r.seriesId, date, which); n++;
  }
  return n;
}

/* ---- series: create, revise from a date, stop from a date ---- */
function target(t){
  const m = t && t.minutes;
  return { label: String((t && t.label) || '').trim(), minutes: Number.isFinite(+m) && m !== null && m !== '' ? Math.max(0, Math.round(+m)) : null };
}
function validCalendarDate(date){ return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && ymd(parseYmd(date)) === date; }
function normalizeRecurrence(rec, effectiveFrom){
  rec = rec || {};
  if (rec.kind === 'once') return { kind:'once', date:rec.date };
  const cleanDays = days => [...new Set((days || []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const out = { kind:rec.kind === 'target' ? 'target' : 'weekly', days:cleanDays(rec.days) };
  if (rec.kind === 'target'){
    out.count = Math.max(1, Math.min(100, Math.floor(+rec.count) || 1));
    out.weeks = Math.max(1, Math.min(52, Math.floor(+rec.weeks) || 1));
    out.mode = rec.mode === 'rolling' ? 'rolling' : 'fixed';
    out.startDate = validCalendarDate(rec.startDate) ? rec.startDate : effectiveFrom;
  } else if (+rec.intervalWeeks > 1){
    out.intervalWeeks = Math.min(52, Math.floor(+rec.intervalWeeks));
    out.startDate = validCalendarDate(rec.startDate) ? rec.startDate : effectiveFrom;
  }
  if (validCalendarDate(rec.endDate)) out.endDate = rec.endDate;
  if (rec.session) out.session = String(rec.session).trim().slice(0, 60);
  if (Array.isArray(rec.variants) && rec.variants.length){
    out.variants = rec.variants.filter(v => v && validCalendarDate(v.from) && validCalendarDate(v.to) && v.from <= v.to).map(v => {
      const variant = { id:String(v.id || newId('variant')), label:String(v.label || 'Variant').trim().slice(0, 80), from:v.from, to:v.to, days:cleanDays(v.days) };
      if (v.normal) variant.normal = target(v.normal);
      if (v.minimum) variant.minimum = target(v.minimum);
      return variant;
    });
  }
  return out;
}
function versionFrom(f, version, effectiveFrom){
  const out = {
    version, effectiveFrom,
    name: String(f.name || '').trim() || 'Untitled',
    anchor: ANCHORS.some(a => a.id === f.anchor) ? f.anchor : 'midday',
    order: Number.isFinite(+f.order) ? +f.order : 1,
    window: String(f.window || '').trim(),
    recurrence: normalizeRecurrence(f.recurrence, effectiveFrom),
    normal: target(f.normal), minimum: target(f.minimum),
    optional: !!f.optional,
    scoring: scoringRule(f.scoring),
    matching: f.matching ? JSON.parse(JSON.stringify(f.matching)) : null,
  };
  for(const key of ['parentId','category','workspaceKind','budgetQ','deadlineDay'])if(Object.prototype.hasOwnProperty.call(f,key))out[key]=f[key];
  if (Array.isArray(f.childIds)) out.childIds = [...new Set(f.childIds)];
  return out;
}
function createSeries(state, fields, effectiveFrom){
  const s = {
    id: newId('s'), category: (CATEGORIES.some(c => c.id === fields.category) || (state.groups || []).some(g => g.id === fields.category)) ? fields.category : 'care',
    demo:false, archivedAt:null, createdAt: nowIso(),
    versions: [ versionFrom(fields, 1, effectiveFrom) ],
  };
  state.series.push(s);
  state.demo = false;
  return s;
}
/* Appends a version. Refuses a start date in the past: the past is lived,
   not edited. Two versions may share a date; the later one wins. */
function reviseSeries(state, seriesId, changes, effectiveFrom, today){
  today = today || todayYmd();
  if (effectiveFrom < today) return null;
  const s = state.series.find(x => x.id === seriesId);
  if (!s) return null;
  const base = versionFor(s,effectiveFrom);
  if (!base) return null;
  const merged = Object.assign({}, base, changes);
  const v = versionFrom(merged, latestVersion(s).version + 1, effectiveFrom);
  s.versions.push(v);
  const parent = s.parentId && state.series.find(p => p.id === s.parentId);
  const category = parent ? parent.category : changes.category;
  if (category && (CATEGORIES.some(c => c.id === category) || (state.groups || []).some(g => g.id === category))){
    s.category = category;
    for (const child of state.series.filter(c => c.parentId === s.id)) child.category = category;
  }
  s.demo = false;
  state.demo = false;
  return v;
}
function archiveSeries(state, seriesId, fromDate, today){
  today = today || todayYmd();
  if (fromDate < today) return null;
  const s = state.series.find(x => x.id === seriesId);
  if (!s) return null;
  s.archivedAt = fromDate;
  return s;
}
function resumeSeries(state, seriesId){
  const s = state.series.find(x => x.id === seriesId);
  if (s) s.archivedAt = null;
  return s || null;
}
function stoppedSeries(state, asOf){
  return state.series.filter(s => s.archivedAt && s.archivedAt <= asOf)
    .map(s => ({ seriesId: s.id, name: latestVersion(s).name, since: s.archivedAt }));
}

/* A family is a dated parent version plus ordinary, independently logged
   tasks. Conversion never expands an old parent completion into children. */
function convertToFamily(state, seriesId, childSpecs, effectiveFrom, today){
  today = today || todayYmd();
  const parent = state.series.find(s => s.id === seriesId);
  const old = parent && versionFor(parent,effectiveFrom);
  if (!parent || parent.parentId || !old || parent.versions.some(v => v.childIds) || effectiveFrom < today || !validCalendarDate(effectiveFrom) || !Array.isArray(childSpecs) || !childSpecs.length) return null;
  if (Object.values(state.occurrences).some(o => o.seriesId === seriesId && o.date >= effectiveFrom && o.status !== null)) return null;
  if (childSpecs.some(c => !c || !String(c.name || '').trim())) return null;
  const children = childSpecs.map((c, i) => {
    const fields = Object.assign({}, old, c, { category:parent.category, order:i + 1 });
    delete fields.childIds;
    const child = createSeries(state, fields, effectiveFrom);
    child.parentId = parent.id;
    return child;
  });
  addFamilyMembership(state,parent,children.map(c => c.id),effectiveFrom,today);
  return parent;
}
function createFamily(state, fields, childSpecs, effectiveFrom){
  if (!validCalendarDate(effectiveFrom) || !Array.isArray(childSpecs) || !childSpecs.length || childSpecs.some(c => !c || !String(c.name || '').trim())) return null;
  const parent = createSeries(state, fields, effectiveFrom);
  return convertToFamily(state, parent.id, childSpecs, effectiveFrom, effectiveFrom);
}
function reviseFamilyTask(state, seriesId, changes, effectiveFrom, today){
  const child = state.series.find(s => s.id === seriesId);
  if (!child || !child.parentId) return null;
  const fields = Object.assign({}, changes); delete fields.childIds;
  return reviseSeries(state, seriesId, fields, effectiveFrom, today);
}
function addFamilyTask(state, seriesId, fields, effectiveFrom, today){
  today = today || todayYmd();
  const parent = state.series.find(s => s.id === seriesId), base = parent && versionFor(parent,effectiveFrom);
  if (!base || !base.childIds || effectiveFrom < today || !validCalendarDate(effectiveFrom) || !String(fields.name || '').trim()) return null;
  const childFields = Object.assign({}, base, fields, {category:parent.category, order:base.childIds.length + 1}); delete childFields.childIds;
  const child = createSeries(state,childFields,effectiveFrom); child.parentId = parent.id;
  addFamilyMembership(state,parent,[child.id],effectiveFrom,today);
  return child;
}
function addFamilyMembership(state, parent, childIds, effectiveFrom, today){
  const dates = [...new Set([effectiveFrom].concat(parent.versions.filter(v => v.effectiveFrom > effectiveFrom).map(v => v.effectiveFrom)))].sort();
  for (const date of dates){
    const base = versionFor(parent,date), ids = [...new Set((base.childIds || []).concat(childIds))];
    reviseSeries(state,parent.id,{childIds:ids},date,today);
  }
}
function recurrenceWindow(ver, date){
  const r = ver.recurrence || {};
  if (r.kind !== 'target') return null;
  const span = r.weeks * 7, anchor = r.startDate || ver.effectiveFrom;
  if (date < anchor) return null;
  const from = r.mode === 'rolling' ? (addDays(date, 1-span) < anchor ? anchor : addDays(date, 1-span)) : addDays(anchor, Math.floor(calendarDistance(anchor, date) / span) * span);
  return { from, to:r.mode === 'rolling' ? date : addDays(from, span-1), mode:r.mode, target:r.count };
}
function targetProgress(state, seriesId, date){
  const s = state.series.find(x => x.id === seriesId), v = s && versionFor(s, date);
  const window = v && recurrenceWindow(v, date);
  if (!window) return null;
  const events = new Set(Object.values(state.occurrences).filter(o => o.seriesId === seriesId && o.date >= window.from && o.date <= window.to && o.date <= date && o.status === 'done' && (!confirmedProgression(state)||actionConfirmation(state,o).confirmed)).map(o => o.rewardEventId || occKey(o.seriesId, o.date)));
  return Object.assign({}, window, { count:events.size, remaining:Math.max(0, window.target-events.size), complete:events.size >= window.target });
}

/* Journaling stays in private app state; it never creates plan changes or
   improvement-log entries. Empty edits remain dated records for merge. */
function journalFor(state, date){ return (state.journal || {})[date] || { date, intention:'', reflection:'', feedback:'', updatedAt:null }; }
function saveJournal(state, date, fields){
  if (!validCalendarDate(date)) return null;
  if (!state.journal) state.journal = {};
  const out = Object.assign({}, journalFor(state, date));
  for (const key of ['intention','reflection','feedback']) if (fields[key] !== undefined) out[key] = String(fields[key] || '').trim().slice(0, 10000);
  out.updatedAt = nowIso(); state.journal[date] = out;
  return out;
}
function journalMergePreview(cur, inc){
  const out = { add:0, clash:[] };
  for (const [date, entry] of Object.entries(inc.journal || {})){
    const mine = (cur.journal || {})[date];
    if (!mine) out.add++;
    else if (JSON.stringify(mine) !== JSON.stringify(entry)) out.clash.push({ kind:'journal', key:date, keeps:later(entry.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  return out;
}
function mergeJournals(cur, inc){
  if (!cur.journal) cur.journal = {};
  let count = 0;
  for (const [date, entry] of Object.entries(inc.journal || {})){
    const mine = cur.journal[date];
    if (!mine || later(entry.updatedAt, mine.updatedAt)){ cur.journal[date] = JSON.parse(JSON.stringify(entry)); count++; }
  }
  return count;
}
function validateFamilyState(state){
  if(state.workspace&&state.workspace.version===1)return validateWorkspaceFamily(state);
  for (const s of state.series){
    if (s.parentId !== undefined && (typeof s.parentId !== 'string' || !state.series.some(p => p.id === s.parentId && !p.parentId))) return 'A task has an invalid family.';
    for (const v of s.versions){
      if (v.childIds !== undefined && (!Array.isArray(v.childIds) || !v.childIds.length || s.parentId || new Set(v.childIds).size !== v.childIds.length || v.childIds.some(id => typeof id !== 'string' || !state.series.some(c => c.id === id && c.parentId === s.id)))) return 'A family has invalid child tasks.';
      const r = v.recurrence || {};
      if ((r.kind === 'target' || r.intervalWeeks !== undefined || r.variants !== undefined) && (!Array.isArray(r.days) || r.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))) return 'A flexible schedule has invalid days.';
      if (r.intervalWeeks !== undefined && (!Number.isInteger(r.intervalWeeks) || r.intervalWeeks < 1 || r.intervalWeeks > 52 || !validCalendarDate(r.startDate))) return 'A repeat interval is malformed.';
      if (r.kind === 'target' && (!Number.isInteger(r.count) || r.count < 1 || r.count > 100 || !Number.isInteger(r.weeks) || r.weeks < 1 || r.weeks > 52 || !['fixed','rolling'].includes(r.mode) || !validCalendarDate(r.startDate))) return 'A multiweek target is malformed.';
      if (r.session !== undefined && typeof r.session !== 'string') return 'A session label is malformed.';
      if (r.variants !== undefined && (!Array.isArray(r.variants) || r.variants.some(a => !a || typeof a.id !== 'string' || typeof a.label !== 'string' || !validCalendarDate(a.from) || !validCalendarDate(a.to) || a.from > a.to || !Array.isArray(a.days) || a.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)))) return 'A dated schedule variant is malformed.';
    }
  }
  if (state.journal !== undefined){
    if (!state.journal || typeof state.journal !== 'object' || Array.isArray(state.journal)) return 'The journal is malformed.';
    for (const [date, entry] of Object.entries(state.journal)) if (!validCalendarDate(date) || !entry || entry.date !== date || ['intention','reflection','feedback'].some(k => typeof entry[k] !== 'string') || typeof entry.updatedAt !== 'string') return 'A journal entry is malformed.';
  }
  return null;
}

/* ---- manual workouts: always self-reported, never a measurement ---- */
function addWorkout(state, f){
  const w = {
    id: newId('w'), origin:'self-reported',
    date: f.date, type: String(f.type || '').trim() || 'Workout',
    minutes: Number.isFinite(+f.minutes) && f.minutes !== '' && f.minutes !== null ? Math.max(0, Math.round(+f.minutes)) : null,
    startTime: String(f.startTime || ''),
    effort: [1,2,3,4,5].includes(+f.effort) ? +f.effort : null,
    notes: String(f.notes || '').trim(),
    occurrenceKey: f.occurrenceKey || null, actionId:f.actionId||f.occurrenceKey||null, strengthDetail:String(f.strengthDetail||'').trim().slice(0,600),
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  if(state.syntheticWorkspace===true)w.syntheticPreview=true;
  state.workouts.push(w);
  return w;
}
function updateWorkout(state, id, f){
  const w = state.workouts.find(x => x.id === id);
  if (!w) return null;
  const n = addWorkout({ workouts: [] }, Object.assign({}, w, f));
  Object.assign(w, n, { id: w.id, origin:'self-reported', createdAt: w.createdAt, updatedAt: nowIso() });
  return w;
}
function deleteWorkout(state, id){
  const before = state.workouts.length;
  state.workouts = state.workouts.filter(w => w.id !== id);
  return state.workouts.length < before;
}
function workoutsOn(state, date){
  return state.workouts.filter(w => w.date === date)
    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || '') || a.createdAt.localeCompare(b.createdAt));
}
function workoutsBetween(state, from, to){
  return state.workouts.filter(w => w.date >= from && w.date <= to);
}

/* ---- weekly review: three questions, one adjustment ---- */
function saveReview(state, f){
  let r = state.reviews.find(x => x.periodStart === f.periodStart);
  if (!r){ r = { id: newId('r'), periodStart: f.periodStart, periodEnd: f.periodEnd, createdAt: nowIso() }; state.reviews.push(r); }
  r.worked = String(f.worked || '').trim();
  r.harder = String(f.harder || '').trim();
  r.adjustment = String(f.adjustment || '').trim();
  r.updatedAt = nowIso();
  return r;
}
function reviewFor(state, periodStart){ return state.reviews.find(x => x.periodStart === periodStart) || null; }

/* ---- Undo restores the record; claimed credit and evidence reservations
   survive so undo/recomplete can never become another reward. ---- */
let undoEntry = null;
function stage(state, label){ undoEntry = { label, snap: JSON.stringify(state) }; }
function canUndo(){ return !!undoEntry; }
function undoLabel(){ return undoEntry ? undoEntry.label : ''; }
function undo(state){
  if (!undoEntry) return false;
  const prev = JSON.parse(undoEntry.snap);
  if (state.rewards && prev.rewards){
    const ledger = JSON.parse(JSON.stringify(state.rewards));
    for (const [id,e] of Object.entries(ledger.evidence)){
      if (!prev.rewards.evidence[id]) { e.retractedAt = nowIso(); e.updatedAt = e.retractedAt; }
      else if (JSON.stringify(e) !== JSON.stringify(prev.rewards.evidence[id])) ledger.evidence[id] = Object.assign({},prev.rewards.evidence[id],{updatedAt:nowIso()});
    }
    mergeRewardLedger(prev,{rewards:ledger});
  }
  prev.revision=state.revision||0;
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, prev);
  undoEntry = null;
  return true;
}
function dropUndo(){ undoEntry = null; }

/* ---- starting point and phase: what the user reported, what is proposed,
        what is unknown. Never a measurement. ---- */
function setProfile(state, profile){
  const p = JSON.parse(JSON.stringify(profile || {}));
  p.items = (p.items || []).map(it => ({
    id: String(it.id || newId('pi')), area: String(it.area || 'general'),
    status: PROVENANCE.includes(it.status) ? it.status : 'unknown', text: String(it.text || '').trim(),
  })).filter(it => it.text);
  p.phase = p.phase ? { id: String(p.phase.id || '1'), title: String(p.phase.title || ''), note: String(p.phase.note || ''), checkpoint: String(p.phase.checkpoint || '') } : null;
  p.questions = (p.questions || []).map(q => ({
    id: String(q.id || newId('q')), text: String(q.text || '').trim(),
    answer: q.answer == null ? null : String(q.answer), answeredAt: q.answeredAt || null, skippedAt: q.skippedAt || null,
  })).filter(q => q.text);
  p.updatedAt = p.updatedAt || nowIso();
  state.profile = p;
  return p;
}
function nextQuestion(state){
  const p = state.profile; if (!p) return null;
  return p.questions.find(q => !q.answeredAt && !q.skippedAt) || null;
}
function answerQuestion(state, id, answer){
  const p = state.profile; if (!p) return null;
  const q = p.questions.find(x => x.id === id); if (!q) return null;
  if (answer === null){ q.skippedAt = nowIso(); }
  else { q.answer = String(answer).trim(); q.answeredAt = nowIso(); q.skippedAt = null; }
  p.updatedAt = nowIso();
  return q;
}
/* An answered question becomes a reported item, so it is not asked again. */
function answeredItems(state){
  const p = state.profile; if (!p) return [];
  return p.questions.filter(q => q.answeredAt && q.answer).map(q => ({ id:'ans-' + q.id, area:'clarified', status:'reported', text: q.text + ' — ' + q.answer }));
}

/* ---- daily check-in: self-report about the night into this date and the
        day itself. Blank is unknown, never zero. ---- */
const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '';
function saveObservation(state, date, f){
  const prev = state.observations[date];
  const o = {
    date,
    sleepAttempt: hhmm(f.sleepAttempt), sleepOnset: hhmm(f.sleepOnset), wake: hhmm(f.wake),
    firstMeal: String(f.firstMeal || '').trim().slice(0, 140),
    nightEating: NIGHT_EATING.some(n => n.id === f.nightEating) ? f.nightEating : '',
    energy: ENERGY.some(e => e.id === f.energy) ? f.energy : '',
    note: String(f.note || '').trim().slice(0, 300),
    weight: (f.weight === '' || f.weight === null || f.weight === undefined || !Number.isFinite(+f.weight) || +f.weight <= 0) ? null : Math.round(+f.weight * 10) / 10,
    weightUnit: ['kg','lb'].includes(f.weightUnit) ? f.weightUnit : prev && prev.weight === +f.weight ? (prev.weightUnit || null) : state.prefs.units,
    origin: 'self-reported',
  };
  const blank = !o.sleepAttempt && !o.sleepOnset && !o.wake && !o.firstMeal && !o.nightEating && !o.energy && !o.note && o.weight === null;
  if (blank){ delete state.observations[date]; return null; }
  o.createdAt = prev ? prev.createdAt : nowIso();
  o.updatedAt = nowIso();
  state.observations[date] = o;
  return o;
}
function observationFor(state, date){ return state.observations[date] || null; }
function observationsBetween(state, from, to){
  return Object.values(state.observations).filter(o => o.date >= from && o.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}

/* ---- groups: configurable categories over the legacy enum ---- */
function groupOf(series){ const c = series.category; return LEGACY_GROUP[c] || c || 'care'; }
function groupsOf(state){ return state.groups.slice().sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)); }
function visibleGroups(state){ return groupsOf(state).filter(g => !g.hidden); }
function groupById(state, id){ return state.groups.find(g => g.id === id) || null; }
function setGroupHidden(state, id, hidden){ const g = groupById(state, id); if (!g) return null; g.hidden = !!hidden; g.updatedAt = nowIso(); return g; }
function addGroup(state, name){
  const n = String(name || '').trim().slice(0, 40); if (!n) return null;
  const g = { id: newId('g'), name: n, icon:'star', order: state.groups.length + 1, hidden:false, custom:true, createdAt: nowIso(), updatedAt: nowIso() };
  state.groups.push(g); return g;
}
function renameGroup(state, id, name){ const g = groupById(state, id); const n = String(name || '').trim().slice(0, 40); if (!g || !n) return null; g.name = n; g.updatedAt = nowIso(); return g; }
/* One day's rows arranged by visible group. A hidden group's rows are left
   out of the day (their records stay), so the group cards and the agenda
   read from one and the same record. */
function planByGroup(state, date){
  const rows = agendaFor(state, date);
  return visibleGroups(state).map(g => ({ group: g, rows: rows.filter(r => r.group === g.id) }));
}
function agendaFor(state, date){
  const hidden = new Set(state.groups.filter(g => g.hidden).map(g => g.id));
  return planFor(state, date).filter(r => !hidden.has(r.group));
}
/* ---- goals: the user's own words, beside the review checkpoint ---- */
function setGoals(state, list){
  state.goals = (list || []).map(t => String(t || '').trim().slice(0, 120)).filter(Boolean).slice(0, 8);
  return state.goals;
}
/* ---- intent: a typed wish becomes a proposal the user confirms or edits ---- */
function proposeFromIntent(text, date){
  const t = String(text || '').trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const byFull = CATALOG.find(c => lower.includes(c.name.toLowerCase()));
  const byWord = CATALOG.find(c => { const w = c.name.toLowerCase().split(/[\s\/&]+/)[0]; return w.length > 4 && !['evening','morning','sleep'].includes(w) && lower.includes(w); });
  const hit = byFull || byWord;
  const group = hit ? hit.group
    : /(walk|run|bike|gym|stretch|workout|swim|lift|treadmill)/.test(lower) ? 'fitness'
    : /(eat|meal|cook|water|drink|grocer|snack)/.test(lower) ? 'food'
    : /(pray|church|bible|faith)/.test(lower) ? 'faith'
    : /(work|focus|study|learn|read|write)/.test(lower) ? 'work'
    : /(clean|laundry|shower|teeth|tidy|floss)/.test(lower) ? 'care' : 'interests';
  const m = lower.match(/(\d{1,3})\s*(min|minutes|m)\b/);
  return {
    name: hit ? hit.name : (t.length > 60 ? t.slice(0, 57) + '…' : t.charAt(0).toUpperCase() + t.slice(1)),
    group, anchor: hit ? hit.anchor : 'midday', date,
    normal: { label: hit ? hit.normal : t, minutes: m ? +m[1] : null },
    minimum: { label: hit ? hit.minimum : 'A smaller version', minutes: null },
    optional: !!(hit && hit.optional),
    reason: hit ? 'Matched the catalog entry “' + hit.name + '”.' : 'Grouped from the words you used; change anything before adding.',
  };
}

/* ---- rank rule: consistency tiers, computed only after the user adopts a
        rule. Proposed values are a starting point he can edit, never an
        approval. Ranks grade practice on recorded days; they never read
        health data and are not fitness attributes. ---- */
const RANK_PROPOSED = { windowDays:14, coverageMin:5, coverageOf:7, tiers:[['SS',95],['S',85],['A',70],['B',55],['C',0]], countMinimum:true, version:1 };
function adoptRankRule(state, rule){
  const r = Object.assign({}, RANK_PROPOSED, rule || {});
  r.windowDays = Math.min(56, Math.max(7, Math.round(+r.windowDays) || 14));
  r.coverageOf = Math.min(14, Math.max(3, Math.round(+r.coverageOf) || 7));
  r.coverageMin = Math.min(r.coverageOf, Math.max(1, Math.round(+r.coverageMin) || 1));
  r.countMinimum = r.countMinimum !== false;
  r.tiers = (Array.isArray(r.tiers) ? r.tiers : RANK_PROPOSED.tiers).map(t => [String(t[0]), Math.max(0, Math.min(100, +t[1] || 0))]).filter(t => RANK_LADDER.includes(t[0])).sort((a, b) => b[1] - a[1]);
  if (!r.tiers.length || r.tiers[r.tiers.length - 1][1] !== 0) r.tiers.push(['C', 0]);
  r.version = RANK_PROPOSED.version;
  if (!state.rank) state.rank = { rule:null, weights:{} };
  state.rank.rule = r; state.rank.adoptedAt = nowIso();
  return r;
}
function clearRankRule(state){ if (state.rank){ state.rank.rule = null; state.rank.clearedAt = nowIso(); } }
function setGroupWeight(state, gid, w){ if (!state.rank) state.rank = { rule:null, weights:{} }; state.rank.weights[gid] = Math.max(0, Math.min(5, Math.round(+w) || 0)); return state.rank.weights[gid]; }
function groupWeight(state, gid){ const w = state.rank && state.rank.weights ? state.rank.weights[gid] : undefined; return w === undefined ? 1 : w; }
function tierFor(rule, score){ if (score === null) return null; for (const t of rule.tiers){ if (score >= t[1]) return t[0]; } return rule.tiers[rule.tiers.length - 1][0]; }
/* Score = practice over entries: done (and minimum if it counts) as 1,
   partial as ½, skipped as 0; no entry is not in the denominator. Coverage =
   days with at least one entry in the group over the last coverageOf days. */
function groupScore(state, gid, endDate, rule){
  const days = []; for (let i = rule.windowDays - 1; i >= 0; i--) days.push(addDays(endDate, -i));
  let normal = 0, minimum = 0, partial = 0, skipped = 0; const recordedAll = new Set(), recordedRecent = new Set();
  const recentFrom = addDays(endDate, -(rule.coverageOf - 1));
  for (const d of days){
    for (const r of flatPlanFor(state, d).filter(r => confirmedProgression(state)||!state.groups.some(g => g.id === r.group && g.hidden))){
      if (r.demo || r.group !== gid || r.status === null || r.status === 'tentative') continue;
      if (r.status === 'done') (r.completedVersion === 'minimum' ? minimum++ : normal++); else if (r.status === 'partial') partial++; else skipped++;
      recordedAll.add(d); if (d >= recentFrom) recordedRecent.add(d);
    }
  }
  const entries = normal + minimum + partial + skipped;
  const num = normal + (rule.countMinimum ? minimum : 0) + partial * 0.5;
  const score = entries ? Math.round(100 * num / entries) : null;
  const coverage = recordedRecent.size;
  const ranked = entries > 0 && coverage >= rule.coverageMin;
  return { gid, score, coverage, coverageOf: rule.coverageOf, ranked, tier: ranked ? tierFor(rule, score) : null, entries: { normal, minimum, partial, skipped }, recordedDays: recordedAll.size };
}
function rankReport(state, endDate){
  const rule = state.rank && state.rank.rule;
  if (!rule) return { rule:null, groups:[], overall:null, previous:null };
  const groups = visibleGroups(state).map(g => Object.assign({ name: g.name, weight: groupWeight(state, g.id) }, groupScore(state, g.id, endDate, rule)));
  const prev = visibleGroups(state).map(g => groupScore(state, g.id, addDays(endDate, -rule.windowDays), rule));
  groups.forEach((g, i) => { g.change = (g.ranked && prev[i].ranked) ? g.score - prev[i].score : null; });
  const ranked = groups.filter(g => g.ranked && g.weight > 0);
  const wsum = ranked.reduce((a, g) => a + g.weight, 0);
  const overallScore = wsum ? Math.round(ranked.reduce((a, g) => a + g.score * g.weight, 0) / wsum) : null;
  return { rule, groups, overall: overallScore === null ? null : { score: overallScore, tier: tierFor(rule, overallScore), rankedGroups: ranked.length } };
}

/* ---- Category grades have separate settings from routine consistency.
   Scores and cutoffs remain unassessed until their evidence rules are chosen. */
const GRADE_CATEGORIES = ['fitness','food','care','faith','work'];
const GRADE_LADDER = ['F','E','D','C','B','A','S','SS','SSS'];
function defaultGradeSettings(){ return { version:1, weights:{ fitness:9, food:9, care:9, faith:10, work:9 }, included:Object.fromEntries(GRADE_CATEGORIES.map(id => [id,true])), updatedAt:null }; }
function setGradeWeight(state, gid, weight){
  if (!GRADE_CATEGORIES.includes(gid) || !Number.isFinite(+weight)) return null;
  state.grades.weights[gid] = Math.round(Math.max(0, Math.min(10, +weight)) * 100) / 100;
  state.grades.updatedAt = nowIso(); return state.grades.weights[gid];
}
function setGradeIncluded(state, gid, included){
  if (!GRADE_CATEGORIES.includes(gid)) return null;
  state.grades.included[gid] = !!included; state.grades.updatedAt = nowIso(); return !!included;
}
function gradeReport(state, exampleScores){
  const settings = state.grades || defaultGradeSettings();
  const totalWeight = GRADE_CATEGORIES.reduce((n, id) => n + (settings.included[id] ? settings.weights[id] : 0), 0);
  const groups = GRADE_CATEGORIES.map(gid => {
    const included = settings.included[gid], weight = settings.weights[gid];
    const score = exampleScores && typeof exampleScores[gid] === 'number' && Number.isFinite(exampleScores[gid]) && exampleScores[gid] >= 0 && exampleScores[gid] <= 100 ? exampleScores[gid] : null;
    return { gid, name:(groupById(state,gid) || {}).name || gid, included, weight, share:included && totalWeight ? weight / totalWeight : 0,
      score, status:!included || !weight ? 'Excluded' : score === null ? 'Unassessed' : 'Example',
      contribution:included && weight && score !== null && totalWeight ? score * weight / totalWeight : null };
  });
  const active = groups.filter(g => g.included && g.weight > 0), missing = active.filter(g => g.score === null);
  return { groups, totalWeight, missing:missing.map(g => g.gid), overall:active.length && !missing.length ? groups.reduce((n,g) => n + (g.contribution || 0),0) : null,
    example:!!exampleScores, tier:null, rule:null, explanation:'Overall = sum(score × importance) ÷ total included importance. All included categories need assessed scores; category evidence rules and F–SSS cutoffs are still pending.' };
}

/* ---- Claimed credit is durable. Eligibility is derived from the concrete
   occurrence, so corrections withdraw pending rewards without minting another. */

/* S1 action scoring and S1.1 levels share the existing occurrence identity.
   Old epochs are immutable history, never silently converted to confirmed XP. */

function addPlanIdea(state,text){const value=String(text||'').trim().slice(0,300);if(!value)return null;const idea={id:newId('idea'),text:value,at:nowIso(),status:'idea'};state.planIdeas.push(idea);return idea;}
function mergeActionAlias(state,duplicateKey,keptKey){
  const [a,day]=duplicateKey.split('|'),[b,date]=keptKey.split('|');
  const left=findPlanRow(state,a,day),right=findPlanRow(state,b,date);
  if(!left||!right||left.children||right.children||day!==date||a===b||left.group!==right.group)return {ok:false,error:'Choose two concrete actions in the same category and day.'};
  const target=state.occurrences[keptKey];
  if(!target||target.aliasOf||!actionConfirmation(state,target).confirmed)return {ok:false,error:'Keep the action you have already deliberately confirmed.'};
  const o=ensureOcc(state,a,day),oldId=rewardIdentity(state,o),newId=rewardIdentity(state,target);
  if(o.aliasOf===keptKey)return {ok:true,same:true};
  if(Object.values(state.occurrences).some(x=>x.aliasOf===duplicateKey))return {ok:false,error:'This action already has aliases. Keep it as the canonical action.'};
  o.aliasOf=keptKey;o.rewardEventId=newId;o.updatedAt=nowIso();
  for(const list of [state.foods,state.workouts])for(const item of list)if(item.actionId===oldId)item.actionId=newId;
  for(const evidence of Object.values(state.rewards.evidence))if(evidence.eventId===oldId){evidence.eventId=newId;evidence.seriesId=b;evidence.updatedAt=nowIso();}
  if(confirmedProgression(state)&&oldId!==newId&&state.rewards.claims[oldId])adjustConfirmedClaim(state,oldId,'Duplicate action linked to '+keptKey);
  return {ok:true,id:newId};
}
function linkLogAction(state,kind,id,key){
  const list=kind==='food'?state.foods:state.workouts,record=list.find(x=>x.id===id);
  if(!record)return {ok:false,error:'Choose an existing log entry.'};
  if(!key){record.actionId=null;return {ok:true};}
  const [seriesId,date]=key.split('|'),row=findPlanRow(state,seriesId,date);
  if(!row||row.children||record.date!==date)return {ok:false,error:'Choose a concrete action on the log entry’s day.'};
  const o=ensureOcc(state,seriesId,date),actionId=rewardIdentity(state,o);
  if(list.some(x=>x.id!==id&&x.actionId===actionId))return {ok:false,error:'This action already has a linked entry. Edit that entry instead of duplicating it.'};
  record.actionId=actionId;record.updatedAt=nowIso();return {ok:true};
}
function weeklyLearning(state,start){
  const days=weekDays(start).filter(d=>d<=todayYmd()),rows=days.flatMap(d=>flatPlanFor(state,d)).filter(r=>!r.demo),done=rows.filter(r=>r.status==='done'),covered=new Set(rows.filter(r=>r.status!==null&&r.status!=='tentative').map(r=>r.date));
  return {start,days:days.length,covered:covered.size,planned:rows.length,confirmed:done.length,ids:done.map(r=>r.key),text:covered.size<4?'Too few reviewed days for a weekly pattern. You can still reflect on what you recorded.':done.length+' of '+rows.length+' planned actions confirmed across '+covered.size+' reviewed days. Different plans and missing entries limit comparisons.'};
}
function decideLearning(state,start,decision,text,followUp){
  if(!['accepted','modified','declined','undone','followed-up'].includes(decision))return null;
  const insight=weeklyLearning(state,start),prior=state.learning.find(x=>x.start===start),item={id:prior?prior.id:newId('learning'),start,at:nowIso(),rule:'descriptive-coverage-v1',inputIds:insight.ids,decision,text:String(text||'').slice(0,500),followUp:validCalendarDate(followUp)?followUp:null,history:prior?[...(prior.history||[]),{at:prior.at,decision:prior.decision,text:prior.text,followUp:prior.followUp}]:[]};
  if(prior)Object.assign(prior,item);else state.learning.push(item);return item;
}
function sourceCoverage(state,kind,from,to){
  const records=relayedRecords(state,kind).filter(r=>r.kind===kind&&sourceLocalDay(r.start)>=from&&sourceLocalDay(r.start)<=to),days=new Set(records.map(r=>sourceLocalDay(r.start)));
  // These counts are display rows, not raw buckets: a day of minute buckets projects to one derived
  // row, so 2,500 accepted buckets read as 1/1. Held rows never reach relayedRecords at all, so
  // "no accessible records" could mean nothing arrived or everything arrived and was held — two
  // very different situations that looked identical. Counted separately now.
  const projection=sourceProjection(state),heldIds=projection?new Set(projection.heldIds):null;
  const held=heldIds?(state.sourceRecords||[]).filter(r=>r.kind===kind&&heldIds.has(r.id)&&sourceLocalDay(r.start)>=from&&sourceLocalDay(r.start)<=to).length:0;
  return {kind,count:records.length,days:days.size,held,latest:records.map(r=>r.unmapped&&r.unmapped.healthAutoExport&&r.unmapped.healthAutoExport.representation==='daily aggregate'?r.start:r.end||r.start).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1)||null,conflicts:records.filter(r=>(r.clashes||[]).length).length,receipts:state.importReceipts.filter(r=>r.window&&r.window.from<=to&&r.window.to>=from)};
}

function confirmedProgression(state){ return !!(state.rewards && state.rewards.progression.rule === 'confirmed-s11'); }
function scoringRule(input){
  const r = input || {}, bounded = x => Math.max(1,Math.min(3,Math.round(Number(x)) || 1));
  return {version:1,chain:String(r.chain||'').trim().slice(0,40),importance:bounded(r.importance),difficulty:bounded(r.difficulty),duration:!!r.duration,reference:Math.max(1,Math.min(240,Number(r.reference) || 30)),eligible:r.eligible !== false};
}
function actionConfirmation(state,o){
  if (!o) return {confirmed:false,label:'No entry'};
  if (o.date > todayYmd()) return {confirmed:false,label:'Future'};
  if (o.status === 'skipped') return {confirmed:false,label:'Explicitly not done'};
  if (o.status === 'partial') return {confirmed:false,label:'Partial'};
  if (!o.status) return {confirmed:false,label:'No entry'};
  if (o.status !== 'done') return {confirmed:false,label:'Tentative · review to confirm'};
  if (!confirmedProgression(state)){
    if(o.evidenceOnly){const id=rewardIdentity(state,o),valid=Object.values(state.rewards.evidence||{}).some(e=>{const r=state.sourceRecords.find(r=>r.id===e.sourceId);return e.eventId===id&&!e.retractedAt&&r&&sourceEvidenceEligible(state,r)&&!(r.clashes||[]).length&&e.fingerprint===evidenceFingerprint(r);});if(!valid)return {confirmed:false,label:'Evidence changed · review required'};}
    return {confirmed:true,label:o.evidenceOnly?'Source-confirmed':'Recorded under legacy rules'};
  }
  const id=rewardIdentity(state,o), evidence=Object.values(state.rewards.evidence).filter(e=>e.eventId===id&&!e.retractedAt);
  const valid=evidence.some(e=>{const r=state.sourceRecords.find(r=>r.id===e.sourceId);return r&&sourceEvidenceEligible(state,r)&&!(r.clashes||[]).length&&e.fingerprint===evidenceFingerprint(r);});
  if (valid) return {confirmed:true,kind:'source',label:'Source-confirmed'};
  if (o.confirmation && o.confirmation.kind === 'self') return {confirmed:true,kind:'self',label:'Self-confirmed'};
  return {confirmed:false,label:evidence.length?'Evidence changed · review required':'Tentative · review to confirm'};
}
function markTentative(state,id,date){
  if (date>todayYmd()) return null;
  const o=logOcc(state,id,date,'tentative');
  if(o) o.completedVersion=o.selected;
  return o;
}
function confirmAction(state,id,date,fields){
  const row=findPlanRow(state,id,date), f=fields||{};
  if (!row || row.children || date>todayYmd()) return {ok:false,error:'Choose an activity on a lived day.'};
  const minutes=f.minutes==null?row.actualMinutes:Number(f.minutes), target=row.targets[f.selected||row.selected];
  if (!target || (minutes != null && (!Number.isFinite(minutes)||minutes<0))) return {ok:false,error:'Review the target and duration.'};
  if (target.minutes && (minutes==null || minutes<target.minutes)) return {ok:false,error:'This target needs '+target.minutes+' confirmed minutes. Record partial or choose a suitable minimum.'};
  if (f.selected) selectVersion(state,id,date,f.selected);
  const o=logOcc(state,id,date,'done',{minutes,note:f.note===undefined?row.note:String(f.note).slice(0,300)});
  return {ok:!!o,occurrence:o};
}
function levelThreshold(level){const n=Math.max(0,Math.floor(level)-1);return n<=35?n*(n+229):9240+300*(n-35);}
function s11Level(points){let level=1;while(points>=levelThreshold(level+1))level++;return {level,toNext:levelThreshold(level+1)-points,nextThreshold:levelThreshold(level+1)};}
function activateConfirmedProgression(state,date){
  if (confirmedProgression(state)) return state.rewards.progression;
  const old=JSON.parse(JSON.stringify(state.rewards||emptyRewards())), total=Object.values(old.claims).reduce((n,c)=>n+c.amount,0);
  state.rewards=emptyRewards();
  state.rewards.legacy={at:nowIso(),points:total,level:rewardLevel({rewards:old},total).level,rewards:old};
  state.rewards.evidence=old.evidence;
  state.rewards.progression={rule:'confirmed-s11',version:1,adoptedAt:nowIso(),effectiveFrom:date||todayYmd()};
  return state.rewards.progression;
}
function routineConsistency(state,seriesId,date){
  const s=state.series.find(s=>s.id===seriesId); if(!s)return 0;
  const current=versionFor(s,date),chain=current&&scoringRule(current.scoring).chain;
  if(chain){
    const slot=v=>(/^([01]\d|2[0-3]):[0-5]\d$/.test(v.window||'')?v.window:'99:99')+'|'+String(anchorOrder(v.anchor)).padStart(2,'0')+'|'+String(v.order||0).padStart(3,'0');
    let count=0;
    for(let d=date,i=0;i<730;i++,d=addDays(d,-1)){
      const members=state.series.map(other=>({s:other,v:versionFor(other,d)})).filter(x=>x.v&&groupOf(x.s)===groupOf(s)&&scoringRule(x.v.scoring).chain===chain&&scheduledOn(x.v,d)&&(!x.s.archivedAt||d<x.s.archivedAt)).sort((a,b)=>slot(b.v).localeCompare(slot(a.v))||b.s.id.localeCompare(a.s.id));
      for(const x of members){
        if(d===date&&(x.s.id===seriesId||slot(x.v)>=slot(current)))continue;
        const o=state.occurrences[occKey(x.s.id,d)];
        if(o&&(o.removed||o.aliasOf||o.disposition==='rest'||o.disposition==='excused'))continue;
        if(!o||!actionConfirmation(state,o).confirmed)return count;
        if(++count===14)return count;
      }
      if(!members.length&&d<state.series.filter(x=>groupOf(x)===groupOf(s)).flatMap(x=>x.versions.map(v=>v.effectiveFrom)).sort()[0])break;
    }
    return count;
  }
  let count=0;
  for(let d=addDays(date,-1),i=0;i<730;i++,d=addDays(d,-1)){
    const v=versionFor(s,d); if(!v)break;
    const o=state.occurrences[occKey(seriesId,d)];
    if (o && (o.disposition==='rest'||o.disposition==='excused'||o.removed)) continue;
    if(v.recurrence&&v.recurrence.kind==='target'&&!(o&&(o.added||o.committed||o.status))){
      const w=recurrenceWindow(v,d);
      if(w&&w.mode==='fixed'&&d===w.to&&!targetProgress(state,seriesId,d).complete)break;
      continue;
    }
    if(!scheduledOn(v,d) && !(o&&o.added))continue;
    if(!o||o.status!=='done'||!actionConfirmation(state,o).confirmed)break;
    count++; if(count>=14)break;
  }
  return count;
}
function actionEntitlement(state,o){
  const s=state.series.find(s=>s.id===o.seriesId),v=s&&versionFor(s,o.date), c=actionConfirmation(state,o);
  if(!v||s.demo||v.childIds||o.aliasOf||o.removed||o.status!=='done'||!c.confirmed)return null;
  const id=rewardIdentity(state,o), legacy=state.rewards.legacy;
  if(legacy && legacy.rewards.claims[id])return null;
  if(o.date<state.rewards.progression.effectiveFrom)return null;
  const pinned=o.rewardRule||v,rule=scoringRule(pinned.scoring);if(!rule.eligible)return null;
  const base=5*(rule.importance+rule.difficulty), minimum=o.completedVersion==='minimum', k=routineConsistency(state,o.seriesId,o.date);
  const safeDose=rule.duration && ((groupOf(s)==='fitness'&&pinned.matching&&pinned.matching.kind==='workout')||groupOf(s)==='work'||groupOf(s)==='interests') && !(pinned.matching && pinned.matching.kind==='sleep');
  const dose=!minimum&&safeDose&&Number.isFinite(o.actualMinutes)?1+0.5*Math.min(1,Math.max(0,o.actualMinutes/rule.reference-1)):1;
  const boost=k>=14?.2:k>=7?.1:k>=3?.05:0, amount=Math.floor(base*(minimum?.5:1)*dose*(1+boost)+.5);
  return {id,eventId:id,seriesId:o.seriesId,date:o.date,name:v.name,amount,ruleVersion:3,origin:c.kind==='source'?'import':'manual',evidenceIds:Object.values(state.rewards.evidence).filter(e=>e.eventId===id&&!e.retractedAt).map(e=>e.sourceId),calculation:{base,minimum,dose,boost,priorConfirmed:k,rule},disputed:false};
}
function confirmedEligibility(state,today){
  const found=new Map();for(const o of Object.values(state.occurrences)){if(o.date>today)continue;const e=actionEntitlement(state,o);if(e&&!found.has(e.id))found.set(e.id,e);}
  return [...found.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
}
function claimBalance(c){return c.amount+(c.adjustments||[]).reduce((n,a)=>n+a.delta,0);}
function correctionPreview(state,id){
  const claim=state.rewards.claims[id]; if(!claim)return null;
  const entitlement=confirmedEligibility(state,todayYmd()).find(e=>e.id===id), before=claimBalance(claim), after=entitlement?entitlement.amount:0;
  const total=Object.values(state.rewards.claims).reduce((n,c)=>n+claimBalance(c),0);
  return {id,before,after,delta:after-before,total:total+after-before,...s11Level(total+after-before)};
}
function adjustConfirmedClaim(state,id,note){
  const c=state.rewards.claims[id], p=correctionPreview(state,id);if(!c||!p)return null;
  c.adjustments=c.adjustments||[];
  if(p.delta)c.adjustments.push({id:newId('adjust'),at:nowIso(),delta:p.delta,reason:String(note||'Reviewed action correction').slice(0,300),revision:c.adjustments.length+1});
  c.reconciliationSignature=rewardReviewSignature(state,c);c.reconciledAt=nowIso();return p;
}
function completionRows(state,date){
  return flatPlanFor(state,date).filter(r=>{
    if(r.demo)return false;
    const o=state.occurrences[r.key];if(o&&o.aliasOf)return false;const committed=!!(o&&(o.added||o.committed||o.status));
    return (!r.optional&&!(r.recurrence&&r.recurrence.kind==='target'))||committed;
  });
}
function recognitionReport(state,date){
  const rows=completionRows(state,date),done=rows.filter(r=>r.status==='done').length;
  const unknown=rows.filter(r=>r.status===null||r.status==='tentative').length, share=rows.length?done/rows.length:null;
  const categories=[...new Set(rows.map(r=>r.group))], floor=categories.every(g=>rows.some(r=>r.group===g&&r.status==='done'));
  return {planned:rows.length,done,unknown,share,tier:date>todayYmd()?'Future':!rows.length?'Rest / no scheduled work':unknown?'Review incomplete':share>=.9&&floor?'Gold':share>=.75&&floor?'Silver':share>=.5?'Bronze':'Reviewed',documentation:!!(observationFor(state,date)||state.journal[date])};
}
function weekRecognition(state,start){
  const days=weekDays(start).filter(d=>d<=todayYmd()),reports=days.map(d=>recognitionReport(state,d)),rows=days.flatMap(d=>completionRows(state,d));
  const done=rows.filter(r=>r.status==='done').length,unknown=rows.filter(r=>!r.status||r.status==='tentative').length,reviewed=reports.filter(r=>r.planned&&r.unknown===0).length;
  const floor=[...new Set(rows.map(r=>r.group))].every(g=>rows.some(r=>r.group===g&&r.status==='done')),share=rows.length?done/rows.length:null;
  return {done,planned:rows.length,unknown,reviewed,tier:days.length<4||reviewed<4?'Building coverage':!rows.length?'Rest / no scheduled work':unknown?'Review incomplete':share>=.9&&floor?'Gold':share>=.75&&floor?'Silver':share>=.5?'Bronze':'Reviewed'};
}
function matchingProblem(state,record,series,date){
  const v=versionFor(series,date), policy=v&&v.matching, row=findPlanRow(state,series.id,date);
  if(!policy||!['workout','steps','sleep'].includes(policy.kind))return 'This routine has no supported source rule. Set one in its routine editor or self-confirm.';
  if(record.unmapped?.healthAutoExport?.representation==='minute aggregate')return 'A single minute bucket cannot establish a full task target. Use deliberate self-confirmation or eligible summary evidence.';
  if(record.kind==='steps'&&!(Number(policy.minimum)>0))return 'Set an explicit positive step target before using step evidence.';
  if(record.kind!==policy.kind)return 'This source kind does not match the chosen rule.';
  if(policy.type && String(record.type||'').toLowerCase()!==policy.type.toLowerCase())return 'The workout type does not match the chosen rule.';
  const sourceDay=sourceLocalDay(record.kind==='sleep'?(record.end||record.start):record.start);
  if(sourceDay!==date)return 'The source-local action day does not match this planned day.';
  const amount=record.kind==='steps'?record.value:record.durationSec==null?null:record.durationSec/60;
  const minimum=Number(policy.minimum)||0, target=row&&row.target.minutes||0;
  if(!Number.isFinite(amount)||amount<Math.max(minimum,record.kind==='steps'?0:target))return 'The source does not establish the full chosen target; record partial or review another target.';
  return null;
}

const REWARD_RULES = { version:2, orbPerDone:1, orbsPerLevel:10, questText:'Complete one planned activity' };
function emptyRewards(){ return { version:2, claims:{}, evidence:{}, unlocks:{}, progression:{ rule:'legacy-10', version:1 }, migratedAt:null }; }
function rewardIdentity(state, o){
  if (o.rewardEventId) return o.rewardEventId;
  let current = o; const seen = new Set();
  while (current.addedFrom && !seen.has(current.date)){
    seen.add(current.date);
    const prior = state.occurrences[occKey(current.seriesId,current.addedFrom)];
    if (!prior) return occKey(current.seriesId,current.addedFrom);
    if (prior.rewardEventId) return prior.rewardEventId;
    current = prior;
  }
  return occKey(current.seriesId,current.date);
}
function rewardEligibility(state, today){
  if (confirmedProgression(state)) return confirmedEligibility(state,today);
  const found = new Map();
  for (const o of Object.values(state.occurrences)){
    if (o.date > today || o.removed || o.status !== 'done') continue;
    const s = state.series.find(x => x.id === o.seriesId), v = s && versionFor(s,o.date);
    if (!s || s.demo || !v || (v.childIds && v.childIds.length)) continue;
    const id = rewardIdentity(state,o);
    const evidence = Object.values((state.rewards || {}).evidence || {}).filter(e => e.eventId === id && !e.retractedAt);
    const disputed = evidence.some(e => { const r = (state.sourceRecords || []).find(r => r.id === e.sourceId); return !r || !sourceEvidenceEligible(state,r) || (r.clashes || []).length || e.fingerprint !== evidenceFingerprint(r); });
    if (o.evidenceOnly && (!evidence.length || disputed)) continue;
    if (!found.has(id)) found.set(id,{ id,eventId:id,date:o.date,seriesId:o.seriesId,name:v.name,amount:REWARD_RULES.orbPerDone,ruleVersion:REWARD_RULES.version,
      origin:evidence.length ? 'import' : 'manual',evidenceIds:evidence.map(e => e.sourceId),disputed });
  }
  return [...found.values()].sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}
function rewardAchievements(state, orbs, days){
  return [
    { id:'first-orb',name:'First orb',rule:'one orb claimed',earned:orbs >= 1 },
    { id:'ten-orbs',name:'Ten orbs',rule:'ten orbs claimed',earned:orbs >= 10 },
    { id:'fifty-orbs',name:'Fifty orbs',rule:'fifty orbs claimed',earned:orbs >= 50 },
    { id:'seven-days',name:'Seven recorded days',rule:'entries on seven different days',earned:days >= 7 },
    { id:'first-checkin',name:'First check-in',rule:'one daily check-in saved',earned:Object.keys(state.observations || {}).length >= 1 },
    { id:'first-review',name:'First weekly review',rule:'one weekly review saved',earned:(state.reviews || []).length >= 1 },
  ].map(a => Object.assign(a,{ earned:a.earned || !!(!confirmedProgression(state) && state.rewards && state.rewards.unlocks[a.id]), historical:!!(state.rewards&&state.rewards.unlocks[a.id]) }));
}
function preserveRewardUnlocks(state, today){
  const days = new Set(Object.values(state.occurrences).filter(o => o.date <= today && o.status !== null && !o.removed && state.series.some(s => s.id === o.seriesId && !s.demo)).map(o => o.date));
  const orbs = Object.values(state.rewards.claims).reduce((n,c) => n + claimBalance(c),0);
  for (const a of rewardAchievements(state,orbs,days.size)) if (a.earned && !state.rewards.unlocks[a.id]) state.rewards.unlocks[a.id] = nowIso();
}
function migrateRewards(state){
  if (state.rewards) return;
  state.rewards = emptyRewards(); state.rewards.migratedAt = nowIso();
  for (const event of rewardEligibility(state,todayYmd())) state.rewards.claims[event.id] = Object.assign({},event,{origin:'legacy',claimedAt:state.rewards.migratedAt,ruleVersion:1});
  preserveRewardUnlocks(state,todayYmd());
}
function rewardLevel(state, orbs){
  if (confirmedProgression(state)) return s11Level(orbs);
  const p = state.rewards.progression;
  if (p.rule !== 'gentle-v1' || orbs < p.firstThreshold) return {level:1 + Math.floor(orbs / 10),toNext:10 - orbs % 10,nextThreshold:(1 + Math.floor(orbs / 10)) * 10};
  let level = p.anchorLevel + 1, threshold = p.firstThreshold, step = 0;
  let cost = Math.min(30,5 + Math.floor(step / 2));
  while (orbs >= threshold + cost){ threshold += cost; level++; step++; cost = Math.min(30,5 + Math.floor(step / 2)); }
  return {level,toNext:threshold + cost - orbs,nextThreshold:threshold + cost};
}
function adoptGentleProgression(state){
  if (state.rewards.progression.rule === 'gentle-v1') return state.rewards.progression;
  const orbs = Object.values(state.rewards.claims).reduce((n,c) => n + c.amount,0), current = rewardLevel(state,orbs);
  state.rewards.progression = {rule:'gentle-v1',version:1,adoptedAt:nowIso(),anchorLevel:current.level,firstThreshold:current.nextThreshold};
  return state.rewards.progression;
}
function rewardReport(state, today){
  const rewards = state.rewards || emptyRewards(), eligible = rewardEligibility(state,today), byId = new Map(eligible.map(e => [e.id,e]));
  const claims = Object.values(rewards.claims).map(c => Object.assign({},c,{balance:claimBalance(c),needsReview:(!byId.has(c.id) || byId.get(c.id).disputed || (confirmedProgression(state) && byId.get(c.id).amount !== claimBalance(c))) && c.reconciliationSignature !== rewardReviewSignature(state,c)}));
  const pending = eligible.filter(e => !rewards.claims[e.id]);
  const orbs = claims.reduce((n,c) => n + claimBalance(c),0);
  const days = new Set(Object.values(state.occurrences).filter(o => o.date <= today && !o.removed && o.status !== null && state.series.some(s => s.id === o.seriesId && !s.demo)).map(o => o.date));
  const level = rewardLevel(Object.assign({},state,{rewards}),orbs);
  return Object.assign({orbs,pending,claims,daysRecorded:days.size,progression:rewards.progression,quest:{text:REWARD_RULES.questText,done:eligible.some(e => e.date === today),reward:1},achievements:rewardAchievements(state,orbs,days.size)},level);
}
function rewardMergeConflicts(cur,inc){
  if((!confirmedProgression(cur)||!confirmedProgression(inc))&&!Object.values(cur.rewards?.claims||{}).concat(Object.values(inc.rewards?.claims||{})).some(c=>c.ruleVersion===4))return [];
  return Object.keys(inc.rewards.claims).filter(id=>{
    const a=cur.rewards.claims[id],b=inc.rewards.claims[id];if(!a)return false;
    if(a.amount!==b.amount||a.claimedAt!==b.claimedAt)return true;
    const x=a.adjustments||[],y=b.adjustments||[];
    return x.slice(0,Math.min(x.length,y.length)).some((v,i)=>JSON.stringify(v)!==JSON.stringify(y[i]));
  });
}
function mergeRewardLedger(cur, inc){
  if (!inc.rewards) return;
  if(!quarterProgression(cur)&&confirmedProgression(cur)&&!confirmedProgression(inc)){if(cur.rewards.legacy){for(const [id,c] of Object.entries(inc.rewards.claims))if(!cur.rewards.legacy.rewards.claims[id])cur.rewards.legacy.rewards.claims[id]=JSON.parse(JSON.stringify(c));}return;}
  if (!cur.rewards) cur.rewards = emptyRewards();
  for (const [id,c] of Object.entries(inc.rewards.claims)){
    const mine = cur.rewards.claims[id];
    if (!mine) cur.rewards.claims[id] = JSON.parse(JSON.stringify(c));
    else if ((c.adjustments||[]).length > (mine.adjustments||[]).length){ cur.rewards.claims[id] = JSON.parse(JSON.stringify(c)); }
    else if (later(c.reconciledAt,mine.reconciledAt)) { mine.reconciledAt = c.reconciledAt; mine.reconciliation = c.reconciliation; mine.reconciliationSignature = c.reconciliationSignature; }
  }
  if(inc.rewards.questChoices){cur.rewards.questChoices=cur.rewards.questChoices||{};for(const [day,item] of Object.entries(inc.rewards.questChoices)){const old=cur.rewards.questChoices[day];if(!old||later(item.at,old.at))cur.rewards.questChoices[day]={...item};}}
  for (const [id,e] of Object.entries(inc.rewards.evidence)){
    const mine = cur.rewards.evidence[id];
    if (!mine || later(e.updatedAt,mine.updatedAt)) cur.rewards.evidence[id] = JSON.parse(JSON.stringify(e));
  }
  for (const [id,at] of Object.entries(inc.rewards.unlocks)) if (!cur.rewards.unlocks[id]) cur.rewards.unlocks[id] = at;
}
async function actionTransaction(state, change, options){
  const opts=options||{}, revision=state.revision||0;
  const run=async()=>{
    const loaded=opts.persist===false?{ok:true,state}:await store.readFresh();
    if(!loaded.ok)return loaded;
    const current=loaded.state||state;
    if((current.revision||0)!==revision)return {ok:false,error:'This action changed in another window. Reload and review again.'};
    const draft=JSON.parse(JSON.stringify(current)), result=change(draft);
    if(result && result.ok===false)return result;
    const problem=validateState(draft);if(problem)return {ok:false,error:problem};
    if(opts.persist!==false){const saved=await store.write(draft);if(!saved.ok)return saved;}
    replaceState(state,draft);dropUndo();return {ok:true,result};
  };
  if(opts.persist===false)return run();
  if(typeof navigator==='undefined'||!navigator.locks)return {ok:false,error:'Safe saving needs Web Locks. Your prior record is unchanged.'};
  return navigator.locks.request(STORE_KEY+'.workspace',run);
}
async function claimRewards(state, ids, options){
  const opts = options || {}, today = opts.today || todayYmd();
  const execute = async () => {
    const loaded = opts.persist === false ? {ok:true,state} : await store.readFresh();
    if (!loaded.ok) return {ok:false,error:loaded.error,claimed:[],amount:0};
    if (confirmedProgression(state) && loaded.state && (loaded.state.revision||0)!==(state.revision||0)){ replaceState(state,loaded.state); }
    if (opts.persist !== false && !loaded.state) return {ok:false,error:'Save the completed task before claiming its reward.',claimed:[],amount:0};
    const draft = JSON.parse(JSON.stringify(loaded.state || state));
    migrateTo(draft);
    const wanted = ids == null ? null : new Set(Array.isArray(ids) ? ids : [ids]);
    const pending = rewardReport(draft,today).pending.filter(e => !wanted || wanted.has(e.id));
    const at = nowIso(), claimed = pending.map(e => Object.assign({},e,{claimedAt:at},draft.syntheticWorkspace===true?{syntheticPreview:true}:{}));
    for (const c of claimed) draft.rewards.claims[c.id] = c;
    preserveRewardUnlocks(draft,today);
    if (opts.persist !== false && claimed.length){ const saved = await store.writeClaims(draft); if (!saved.ok) return Object.assign(saved,{claimed:[],amount:0}); }
    replaceState(state,draft);
    const amount=claimed.reduce((n,c)=>n+c.amount,0);return {ok:true,claimed,amount,displayAmount:quarterProgression(draft)?amount/4:amount,unit:quarterProgression(draft)?'quarter-point':'legacy-point'};
  };
  if (opts.persist === false) return execute();
  if (typeof navigator === 'undefined' || !navigator.locks || !navigator.locks.request) return {ok:false,error:'Safe claims need Web Locks. Open this local preview in a current browser; your completed work remains recorded.',claimed:[],amount:0};
  return navigator.locks.request(STORE_KEY + '.workspace',execute);
}
function rewardReviewSignature(state, claim){
  const occurrences = Object.values(state.occurrences).filter(o => rewardIdentity(state,o) === claim.eventId).map(o => [o.date,o.status,o.removed,o.updatedAt]).sort((a,b) => a[0].localeCompare(b[0]));
  const evidence = (claim.evidenceIds || []).map(id => { const r = state.sourceRecords.find(x => x.id === id), e = state.rewards.evidence[id]; return [id,e ? e.retractedAt : 'missing',r ? evidenceFingerprint(r) : 'missing',r ? (r.clashes || []) : 'missing',sourceIsActive(state,id)]; });
  const current=confirmedProgression(state)?confirmedEligibility(state,todayYmd()).find(e=>e.id===claim.id):null;
  return JSON.stringify([occurrences,evidence,current?current.amount:null]);
}
function reconcileRewardClaim(state, id, note){
  if (confirmedProgression(state)) return adjustConfirmedClaim(state,id,note);
  const claim = state.rewards.claims[id]; if (!claim) return null;
  claim.reconciledAt = nowIso(); claim.reconciliation = String(note || 'Reviewed correction; previously claimed credit retained.').slice(0,300); claim.reconciliationSignature = rewardReviewSignature(state,claim); return claim;
}
function evidenceFingerprint(record){ if(record.unmapped?.healthAutoExport?.format==='JSON'&&typeof HealthAutoExport!=='undefined')return HealthAutoExport.signature(record);return JSON.stringify([record.kind,record.type || null,record.start,record.end || null,record.value == null ? null : record.value,record.unit || null,record.durationSec == null ? null : record.durationSec]); }
function evidenceOverlaps(a, b){
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'steps') return ymd(new Date(a.start)) === ymd(new Date(b.start));
  const start = r => Date.parse(r.start), end = r => r.end ? Date.parse(r.end) : start(r) + (+r.durationSec || 0) * 1000;
  return Math.max(start(a),start(b)) < Math.min(end(a),end(b)) || start(a) === start(b);
}
function associateRewardEvidence(state, sourceId, seriesId, date){
  const record = state.sourceRecords.find(r => r.id === sourceId), series = state.series.find(s => s.id === seriesId), version = series && versionFor(series,date);
  if (!record || !series || series.demo || !version || (version.childIds && version.childIds.length)) return {ok:false,error:'Choose an imported record and a concrete task.'};
  if (!sourceEvidenceEligible(state,record))return {ok:false,error:'This source is held or shadowed by the active feed contract. It cannot confirm an activity.'};
  if ((record.clashes || []).length) return {ok:false,error:'This source record has a correction to review before it can qualify.'};
  if (!['workout','steps','sleep'].includes(record.kind)) return {ok:false,error:'Only workouts, steps and sleep can support a task in this rule. Other measurements stay in Data.'};
  if (groupOf(series) !== 'fitness') return {ok:false,error:'This imported fitness evidence can only support a Fitness task.'};
  const row = typeof findPlanRow === 'function' ? findPlanRow(state,seriesId,date) : planFor(state,date).find(r => r.seriesId === seriesId);
  if (!row || row.isFamily) return {ok:false,error:'Choose a concrete task scheduled on the record’s day.'};
  if (confirmedProgression(state)){const problem=matchingProblem(state,record,series,date);if(problem)return {ok:false,error:problem};}
  const taskWords = (row.name + ' ' + row.target.label).toLowerCase();
  const sleepTask = /sleep|bed|wind.down|rest|wake/.test(taskWords);
  if (!confirmedProgression(state) && ((record.kind === 'sleep' && !sleepTask) || (record.kind !== 'sleep' && sleepTask))) return {ok:false,error:'Match sleep to a sleep task, and activity evidence to an activity task.'};
  if (!confirmedProgression(state) && ymd(new Date(record.start)) !== date) return {ok:false,error:'The record and task must be on the same local day; review their dates before associating them.'};
  const key = occKey(seriesId,date), existing = state.occurrences[key], eventId = existing ? rewardIdentity(state,existing) : key, fingerprint = evidenceFingerprint(record);
  const conflict = Object.values(state.rewards.evidence).find(e => (e.sourceId === sourceId || e.fingerprint === fingerprint || evidenceOverlaps(record,state.sourceRecords.find(r => r.id === e.sourceId))) && e.eventId !== eventId);
  if (conflict) return {ok:false,error:'That evidence already belongs to another activity. Review the existing association; it cannot award a second task.',conflict};
  const manual = record.kind === 'workout' && state.workouts.find(w => w.date === date && w.occurrenceKey && w.occurrenceKey !== key && (!w.startTime || !record.end || (Date.parse(date + 'T' + w.startTime) < Date.parse(record.end) && Date.parse(date + 'T' + w.startTime) + (w.minutes || 0) * 60000 > Date.parse(record.start))));
  if (manual) return {ok:false,error:'A manual workout may describe this activity. Associate it with that workout’s task before claiming another reward.',conflict:{eventId:manual.occurrenceKey}};
  const prior = state.rewards.evidence[sourceId];
  if (prior && prior.eventId === eventId && !prior.retractedAt && prior.fingerprint === fingerprint) return {ok:true,same:true,eventId};
  const alreadyDone = existing && existing.status === 'done';
  const wasEvidenceOnly = existing && existing.evidenceOnly, priorConfirmation=existing&&existing.confirmation;
  const occurrence = logOcc(state,seriesId,date,'done');
  if (!occurrence) return {ok:false,error:'That task cannot accept a completion.'};
  occurrence.rewardEventId = eventId;
  if (confirmedProgression(state)){ occurrence.confirmation = alreadyDone && priorConfirmation && priorConfirmation.kind==='self' ? priorConfirmation : {kind:'source',at:nowIso(),sourceId}; occurrence.actualMinutes = record.durationSec==null ? occurrence.actualMinutes : record.durationSec/60; }
  if (!alreadyDone || wasEvidenceOnly) occurrence.evidenceOnly = true;
  state.rewards.evidence[sourceId] = {sourceId,eventId,fingerprint,seriesId,date,acceptedAt:nowIso(),updatedAt:nowIso(),retractedAt:null,ruleVersion:2};
  return {ok:true,same:false,eventId,alreadyDone:!!alreadyDone};
}
function retractRewardEvidence(state, sourceId){
  const e = state.rewards.evidence[sourceId]; if (!e) return false;
  e.retractedAt = nowIso(); e.updatedAt = e.retractedAt;
  const active = Object.values(state.rewards.evidence).some(x => x.eventId === e.eventId && !x.retractedAt);
  if (!active) for (const o of Object.values(state.occurrences)) if (rewardIdentity(state,o) === e.eventId && o.evidenceOnly && o.status === 'done') clearOcc(state,o.seriesId,o.date);
  return true;
}

/* ---- avatar photo: stored locally, left out of exports unless asked ---- */
function setAvatarPhoto(state, dataUrl){
  if (!dataUrl){ state.avatar = null; return null; }
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl) || dataUrl.length > 400000) return null;
  state.avatar = { photo: dataUrl, at: nowIso() }; return state.avatar;
}

/* ---- Relay replies arrive through manual paste or the native inbox.
        Both routes require explicit review and preserve source provenance;
        shape checks do not establish source authenticity or accuracy. ---- */
const RELAY_FORMAT = 'health-tracker-relay';
const RELAY_KINDS = ['workout','weight','sleep','steps','activeEnergy','restingHeartRate','dietaryEnergy','restingEnergy','toothbrushing','other'];
function fnv(str){ let h = 0x811c9dc5; for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return ('0000000' + h.toString(16)).slice(-8); }
function relayPacket(state, from, to){
  return [
    'Health Tracker data request (relay via ChatGPT). Please answer ONLY with a JSON object in exactly this shape, no prose:',
    '{ "format": "' + RELAY_FORMAT + '", "version": 1, "source": "apple-health", "relayedBy": "chatgpt", "retrievedAt": "<ISO-8601 now>",',
    '  "window": { "from": "' + from + '", "to": "' + to + '" },',
    '  "records": [',
    '    { "kind": "workout", "sourceApp": "<app that wrote it, e.g. iFIT, Bevel, Apple Watch>", "sourceRecordId": "<HealthKit UUID if available, else null>", "type": "<e.g. Walking>", "start": "<ISO-8601 with offset>", "end": "<ISO-8601 with offset>", "durationSec": <source-reported duration in seconds, or null>, "unit": null, "value": null, "device": "<device name or null>" },',
    '    { "kind": "weight", "sourceApp": "<app>", "sourceRecordId": null, "start": "<ISO-8601>", "end": null, "value": <number>, "unit": "kg|lb" },',
    '    { "kind": "sleep", "sourceApp": "<app>", "sourceRecordId": null, "type": "inBed|asleep|awake|core|deep|rem", "start": "<ISO-8601>", "end": "<ISO-8601>" },',
    '    { "kind": "steps", "sourceApp": "<app>", "start": "<day start ISO>", "end": "<day end ISO>", "value": <number>, "unit": "count" }',
    '  ] }',
    'Rules: include every record you can actually read for the window and only those; never estimate or fill gaps; keep original units; keep the app that wrote each record (it is not necessarily the device that measured it); if a field is unknown use null; if nothing is readable for a kind, leave it out rather than inventing it; report the window you actually covered.',
    'Window: ' + from + ' to ' + to + ' inclusive. Kinds wanted: workout, weight, sleep, steps.',
  ].join('\n');
}
function parseRelay(text, context){
  let obj; try { obj = JSON.parse(String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '')); } catch(e){ return { ok:false, error:'That is not valid JSON. Ask for the JSON only, no prose.' }; }
  if (!obj || obj.format !== RELAY_FORMAT) return { ok:false, error:'That is not a Health Tracker relay reply (missing format tag).' };
  if (obj.version !== undefined && obj.version !== 1) return { ok:false, error:'This app reads relay version 1. This reply uses a different version; nothing was imported.' };
  if (!Array.isArray(obj.records)) return { ok:false, error:'The reply has no records list.' };
  const instant = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(v) && ymd(parseYmd(v.slice(0,10))) === v.slice(0,10) && !isNaN(Date.parse(v));
  const relayedAt = instant(obj.retrievedAt) ? new Date(obj.retrievedAt).toISOString() : null;
  const out = [], problems = [], issues = [], unsupportedFields = [],previewInput=syntheticPreviewData(obj);
  const fields = ['kind','sourceApp','sourceRecordId','type','start','end','durationSec','unit','value','device'];
  const issue = (index, status, reason) => { issues.push({ index, status, reason }); problems.push('Record ' + index + ': ' + reason); };
  obj.records.forEach((r, i) => {
    const index = i + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)){ issue(index, 'invalid', 'not an object'); return; }
    if (!instant(r.start)){ issue(index, 'invalid', 'start must be an ISO timestamp with an offset'); return; }
    if (!RELAY_KINDS.includes(r.kind)){ issue(index, 'unsupported', 'unsupported kind ' + String(r.kind || '(missing)').slice(0, 60)); return; }
    const kind = r.kind, start = r.start;
    if (r.end !== null && r.end !== undefined && !instant(r.end)){ issue(index, 'invalid', 'end is not a timestamp with an offset'); return; }
    const end = r.end || null;
    if (end && Date.parse(end) < Date.parse(start)){ issue(index, 'invalid', 'end precedes start'); return; }
    const value = (typeof r.value === 'number' && isFinite(r.value)) ? r.value : null;
    const unit = typeof r.unit === 'string' ? r.unit : null;
    if (['weight','steps','activeEnergy','restingHeartRate','dietaryEnergy','restingEnergy'].includes(kind) && (value === null || value < 0 || (kind === 'weight' && value === 0))){ issue(index, 'invalid', kind + ' needs a valid nonnegative value' + (kind === 'weight' ? ' above zero' : '')); return; }
    if (['dietaryEnergy','restingEnergy'].includes(kind) && unit!=='kcal'){issue(index,'unsupported','energy unit must be explicit kcal');return;}
    if (kind === 'weight' && !['kg','lb'].includes(unit)){ issue(index, 'unsupported', 'weight unit must be kg or lb; original value was not converted'); return; }
    if (kind === 'sleep' && (!end || Date.parse(end) <= Date.parse(start))){ issue(index, 'invalid', 'sleep needs a positive start/end interval'); return; }
    if (kind === 'sleep' && !['inBed','asleep','awake','core','deep','rem'].includes(r.type)){ issue(index, 'unsupported', 'sleep category is not supported'); return; }
    if (r.durationSec !== null && r.durationSec !== undefined && (typeof r.durationSec !== 'number' || !isFinite(r.durationSec) || r.durationSec < 0)){ issue(index, 'invalid', 'duration must be nonnegative seconds or null'); return; }
    if(kind==='toothbrushing'&&(!(typeof r.durationSec==='number'&&r.durationSec>0)||end&&r.durationSec>(Date.parse(end)-Date.parse(start))/1000)){issue(index,'invalid','toothbrushing needs a positive reported duration consistent with its interval');return;}
    const sourceApp = String(r.sourceApp || 'unknown').trim().slice(0, 60) || 'unknown';
    const sourceRecordId = typeof r.sourceRecordId === 'string' && r.sourceRecordId ? r.sourceRecordId : null;
    const durationSec = typeof r.durationSec === 'number' ? Math.round(r.durationSec) : null;
    const elapsedSec = end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
    const identity = sourceRecordId ? 'src:' + sourceRecordId : 'derived:' + fnv([kind, sourceApp, r.type || '', start, end || '', value === null ? '' : value, unit || ''].join('|'));
    const unmapped = Object.fromEntries(Object.entries(r).filter(([key]) => !fields.includes(key)));
    const unknown = Object.keys(unmapped); unknown.forEach(key => { if (!unsupportedFields.includes(key)) unsupportedFields.push(key); });
    if(kind==='workout'&&typeof r.durationSec==='number')unmapped.workoutDurationExactSec=r.durationSec;
    if(kind==='toothbrushing')unmapped.reportedDurationExactSec=r.durationSec;
    const localFile = context && context.transport === 'local file';
    out.push({ id: identity, kind, type: r.type ? String(r.type).slice(0, 60) : null, sourceApp, sourceRecordId, device: r.device ? String(r.device).slice(0, 60) : null, start, end, value, unit, durationSec, elapsedSec, idRule: sourceRecordId ? 'provider id' : 'derived v1 (kind, app, type, start, end, value, unit)', origin: localFile ? 'source-recorded (local file)' : 'source-recorded (relayed)', relayedBy: localFile ? 'local file' : 'chatgpt', source: typeof obj.source === 'string' ? obj.source.slice(0, 80) : 'unknown', relayedAt, window: relayWindow(obj.window), sourceIndex:index, unmapped,...(previewInput||syntheticPreviewData(r)?{syntheticPreview:true}:{}) });
  });
  return { ok:true, records:out, problems, issues, unsupportedFields, relayedAt, window:relayWindow(obj.window), inputCount:obj.records.length,...(previewInput?{syntheticPreview:true}:{}) };
}
function syntheticPreviewData(value){
  if(!value||typeof value!=='object')return false;
  const marked=record=>record&&[record,record.unmapped,record.starter,record.unmapped?.starter].some(meta=>meta&&(meta.syntheticWorkspace===true||meta.syntheticPreview===true));
  if(marked(value))return true;
  return ['records','sourceRecords','workouts','foods'].flatMap(key=>Array.isArray(value[key])?value[key]:[]).concat(Object.values(value.occurrences||{}),Object.values(value.rewards?.evidence||{}),Object.values(value.rewards?.claims||{})).some(marked);
}
function relayWindow(w){
  const valid = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
  return w && valid(w.from) && valid(w.to) && w.from <= w.to ? { from:w.from, to:w.to } : null;
}
function sourceLocalDay(instant, exclusiveEnd){
  const zone=/([+-])(\d{2}):(\d{2})$/.exec(instant);
  const offset=zone ? (zone[1]==='-'?-1:1)*(Number(zone[2])*60+Number(zone[3])) : 0;
  return new Date(Date.parse(instant)-(exclusiveEnd?1:0)+offset*60000).toISOString().slice(0,10);
}
function relaySignature(r){
  if(r.unmapped?.healthAutoExport?.format==='JSON'&&r.unmapped.healthAutoExport.adapterVersion===1&&typeof HealthAutoExport!=='undefined')return HealthAutoExport.signature(relayRecordSnapshot(r));
  const ordered = v => Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
  return JSON.stringify([r.kind, r.type, r.sourceApp, r.sourceRecordId, r.device, r.start, r.end, r.value, r.unit, r.durationSec, r.source || null, ordered(r.unmapped || {})]);
}
function relayUnresolvedClashes(record){ return record && Array.isArray(record.clashes) ? record.clashes : []; }
function relayReviewedSignature(record, signature){
  const hae=record.unmapped?.healthAutoExport?.format==='JSON'&&record.unmapped.healthAutoExport.adapterVersion===1&&typeof HealthAutoExport!=='undefined';
  const matches=(stored,snapshot)=>stored===signature||!!(hae&&snapshot&&relaySignature(snapshot)===signature);
  return (record.resolutions || []).some(r => matches(r.incomingSignature,r.incoming) || (r.choice === 'use-incoming' && matches(r.beforeSignature,r.before)));
}
function relayRecordSnapshot(record){
  const copy = JSON.parse(JSON.stringify(record)); delete copy.clashes; delete copy.resolutions; return copy;
}
function resolveRelayConflict(state, sourceId, index, choice){
  sourceProjectionCache.delete(state);
  const record = (state.sourceRecords || []).find(r => r.id === sourceId);
  const clashes = relayUnresolvedClashes(record);
  if (!record || !Number.isInteger(index) || !clashes[index] || !['keep-current','use-incoming'].includes(choice)) return { ok:false, error:'That conflict is no longer available. Review the current record again.' };
  const incoming = clashes[index].record;
  if (!incoming || incoming.id !== record.id) return { ok:false, error:'The incoming identity does not match this record; nothing was changed.' };
  const before = relayRecordSnapshot(record), audit = { id:newId('resolution'), at:nowIso(), choice, beforeSignature:relaySignature(record), incomingSignature:relaySignature(incoming), before, incoming:relayRecordSnapshot(incoming) };
  const remaining = clashes.filter((_,i) => i !== index), resolutions = (record.resolutions || []).concat([audit]);
  const changed = choice === 'use-incoming' && relaySignature(record) !== relaySignature(incoming);
  if (choice === 'use-incoming'){
    const selected = relayRecordSnapshot(incoming);
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, selected, { importedAt:before.importedAt, lastSeenAt:before.lastSeenAt, sourceCorrectedAt:audit.at });
  }
  record.clashes = remaining; record.resolutions = resolutions;
  return { ok:true, changed, sourceId, resolutionId:audit.id, requiresEvidenceReview:changed };
}
function mergeRelayRecords(cur, inc){
  if (!cur.sourceRecords) cur.sourceRecords = [];
  const counts = { added:0, same:0, clash:0 };
  for (const incoming of (inc.sourceRecords || [])){
    const mine = cur.sourceRecords.find(r => r.id === incoming.id);
    if (!mine){ cur.sourceRecords.push(JSON.parse(JSON.stringify(incoming))); counts.added++; continue; }
    const wasReviewed = relayReviewedSignature(mine,relaySignature(incoming));
    const same = relaySignature(mine) === relaySignature(incoming);
    for (const audit of (incoming.resolutions || [])) if (!(mine.resolutions || []).some(r => r.id === audit.id)) (mine.resolutions ||= []).push(JSON.parse(JSON.stringify(audit)));
    const addClash = candidate => {
      if (relaySignature(mine) === relaySignature(candidate) || (mine.clashes || []).some(c => relaySignature(c.record) === relaySignature(candidate))) return;
      (mine.clashes ||= []).push({ at:nowIso(), record:relayRecordSnapshot(candidate), origin:'restore merge' }); counts.clash++;
    };
    if (!same && !wasReviewed) addClash(incoming); else counts.same++;
    for (const candidate of relayUnresolvedClashes(incoming)) if (!relayReviewedSignature(mine,relaySignature(candidate.record))) addClash(candidate.record);
    const latest = incoming.lastRetrievedAt || incoming.relayedAt, current = mine.lastRetrievedAt || mine.relayedAt;
    if (same && latest && (!current || Date.parse(latest) > Date.parse(current))) mine.lastRetrievedAt = latest;
    if(same&&mine.unmapped?.healthAutoExport?.format==='JSON'&&mine.unmapped.healthAutoExport.adapterVersion===1&&typeof HealthAutoExport!=='undefined'){
      const prior=mine.unmapped.healthAutoExport.delivery,next=incoming.unmapped?.healthAutoExport?.delivery;
      const time=d=>d&&Object.prototype.hasOwnProperty.call(d,'modifiedAtMs')?(typeof d.modifiedAtMs==='number'?d.modifiedAtMs:NaN):Date.parse(d?.modifiedAt);
      if(next&&Number.isFinite(time(next))&&(!Number.isFinite(time(prior))||time(next)>time(prior)))mine.unmapped.healthAutoExport.delivery=JSON.parse(JSON.stringify(next));
    }
  }
  return counts;
}
function previewRelay(state, parsed, context){
  if (!parsed || !parsed.ok) return parsed || { ok:false, error:'Check a reply first.' };
  if(state.syntheticWorkspace!==true&&syntheticPreviewData(parsed))return {ok:false,error:'Synthetic walkthrough evidence cannot be imported into a personal record.'};
  const ctx = Object.assign({ transport:'manual paste', requestedWindow:null, deliveryId:null }, context || {});
  if (ctx.requestedWindow && !relayWindow(ctx.requestedWindow)) return { ok:false, error:'Choose a valid date range before checking the reply.' };
  ctx.requestedWindow = relayWindow(ctx.requestedWindow);
  ctx.transport = ctx.transport === 'local file' ? 'local file' : ['received delivery','received-delivery'].includes(ctx.transport) ? 'received delivery' : 'manual paste';
  if (ctx.transport === 'local file' && (parsed.issues || []).some(issue => issue.status === 'invalid')) return { ok:false, error:'A supported record is invalid. Nothing can be imported from this file until it is corrected.' };
  const counts = { added:0, same:0, clash:0, invalid:0, unsupported:0, inFileDuplicate:0, ambiguous:0 }, items = [], warnings = [];
  const fileIds = new Set(), intervalKey = r => !r.sourceRecordId ? [r.kind,r.sourceApp,r.type || '',r.start,r.end || '',r.unit || ''].join('|') : null;
  const intervals = new Map();
  for (const r of (state.sourceRecords || [])){ const key = intervalKey(r); if (key && !intervals.has(key)) intervals.set(key,r); }
  const seen = new Map((state.sourceRecords || []).map(r => [r.id, r]));
  for (const issue of (parsed.issues || [])){ counts[issue.status]++; items.push(Object.assign({}, issue)); }
  for (const r of parsed.records){
    const date = ctx.transport === 'local file' ? sourceLocalDay(r.start,false) : ymd(new Date(r.start));
    const endDate = ctx.transport === 'local file' ? (r.end ? sourceLocalDay(r.end,true) : date) : ymd(new Date(r.end || r.start));
    if (ctx.requestedWindow && (date > ctx.requestedWindow.to || endDate < ctx.requestedWindow.from)){
      counts.invalid++; items.push({ index:r.sourceIndex, status:'invalid', reason:ctx.transport === 'local file' ? 'outside selected source-local dates' : 'outside selected dates (device timezone)', record:r }); continue;
    }
    if (fileIds.has(r.id)) counts.inFileDuplicate++; else fileIds.add(r.id);
    const key = intervalKey(r), prior = key && intervals.get(key);
    if (prior && relaySignature(prior) !== relaySignature(r) && prior.value !== r.value){
      counts.ambiguous++; items.push({ index:r.sourceIndex, status:'ambiguous', record:r, current:relayRecordSnapshot(prior), reason:'possible revised copy at the same source interval; no combined total is safe' }); continue;
    }
    if (key && !prior) intervals.set(key,r);
    const mine = seen.get(r.id), reviewed = !!mine && relayReviewedSignature(mine,relaySignature(r));
    const status = !mine ? 'added' : relaySignature(mine) === relaySignature(r) || reviewed ? 'same' : 'clash';
    counts[status]++; items.push({ index:r.sourceIndex, status, record:r, reviewed, reason:reviewed ? 'previously reviewed version; your saved choice is preserved' : null }); if (!mine) seen.set(r.id, r);
  }
  if (counts.ambiguous) warnings.push(counts.ambiguous + ' possible revised source copies share an interval but differ in value. Those copies are held in this receipt, excluded from totals, and need source review. Other valid records can still be imported.');
  if (!parsed.relayedAt) warnings.push('Retrieval time is unknown; import time will be kept separately.');
  if (!parsed.window) warnings.push('The reply does not state a valid covered date range.');
  if (ctx.requestedWindow && parsed.window && JSON.stringify(ctx.requestedWindow) !== JSON.stringify(parsed.window)) warnings.push('Reported coverage differs from the selected dates; coverage is not assumed complete.');
  if ((parsed.unsupportedFields || []).length) warnings.push('Unmapped fields are retained on supported records but not used in calculations: ' + parsed.unsupportedFields.join(', ') + '.');
  if (parsed.records.some(r => r.sourceApp === 'unknown')) warnings.push('Some records have no original source app; provenance remains unknown.');
  return { ok:true, parsed, context:ctx, counts, items, warnings, problems:parsed.problems || [], summary:counts.added + ' new · ' + counts.same + ' same · ' + counts.clash + ' conflicting · ' + counts.ambiguous + ' ambiguous held · ' + counts.invalid + ' invalid/out of scope · ' + counts.unsupported + ' unsupported' };
}
function importRelay(state, parsed, context){
  sourceProjectionCache.delete(state);
  const review = previewRelay(state, parsed, context);
  if (!review.ok) return { added:0, same:0, clash:0, invalid:0, unsupported:0, error:review.error };
  if (!state.sourceRecords) state.sourceRecords = [];
  if (!state.importReceipts) state.importReceipts = [];
  const c = Object.assign({}, review.counts), now = nowIso();
  for (const item of review.items){
    if (!['added','same','clash'].includes(item.status)) continue;
    const r = Object.assign({}, item.record, { transport:review.context.transport },state.syntheticWorkspace===true?{syntheticPreview:true}:{});
    const mine = state.sourceRecords.find(x => x.id === r.id);
    if (!mine){ state.sourceRecords.push(Object.assign({ importedAt:now, lastSeenAt:now, lastRetrievedAt:r.relayedAt }, r)); continue; }
    if (item.status === 'same'){
      if (item.reviewed && relaySignature(mine) !== relaySignature(r)) continue;
      mine.lastSeenAt = now;
      const prior = mine.lastRetrievedAt || mine.relayedAt;
      if (r.relayedAt && (!prior || Date.parse(r.relayedAt) > Date.parse(prior))) mine.lastRetrievedAt = r.relayedAt;
      continue;
    }
    if (relaySignature(mine) !== relaySignature(r)){
      mine.clashes = mine.clashes || [];
      if (!mine.clashes.some(x => relaySignature(x.record) === relaySignature(r))) mine.clashes.push({ at:now, record:r });
    }
  }
  const apps = {};
  for (const item of review.items){
    if (!['added','same'].includes(item.status) || item.reviewed) continue;
    const r = item.record;
    const k = /bevel/i.test(r.sourceApp) ? 'bevel-pro' : /ifit/i.test(r.sourceApp) ? 'ifit' : /apple (watch|fitness|health)|^com\.apple\./i.test(r.sourceApp) ? 'apple-fitness' : null;
    if (!k) continue;
    const t = r.end || r.start; apps[k] = apps[k] || { last:null }; if (!apps[k].last || Date.parse(t) > Date.parse(apps[k].last)) apps[k].last = t;
  }
  if (!state.sources) state.sources = {};
  for (const k of Object.keys(apps)){
    const old = state.sources[k] || {};
    const evidence=sourceEvidenceSummary(state,k);
    state.sources[k] = Object.assign({},old,{state:evidence.state,lastSample:evidence.lastSample,retrievedAt:evidence.retrievedAt,note:evidence.route});
  }
  const receipt = { id:newId('receipt'), at:now, transport:review.context.transport, deliveryId:review.context.deliveryId || null, counts:Object.assign({}, c), requestedWindow:review.context.requestedWindow, reportedWindow:parsed.window || null, requestedKinds:review.context.transport === 'local file' ? [] : ['workout','weight','sleep','steps'], receivedKinds:[...new Set(parsed.records.map(r => r.kind))], sourceApps:[...new Set(parsed.records.map(r => r.sourceApp))], relayedAt:parsed.relayedAt, unsupportedFields:parsed.unsupportedFields || [], warnings:review.warnings, heldAmbiguous:review.items.filter(item=>item.status==='ambiguous').map(item=>({reason:item.reason,current:item.current,record:relayRecordSnapshot(item.record)})) };
  state.importReceipts.push(receipt); c.receipt = receipt;
  return c;
}
const sourceProjectionCache=new WeakMap();
function sourceProjection(state){
  if(!state.autoFeed||typeof globalThis.HealthAutoExport==='undefined')return null;
  const prior=sourceProjectionCache.get(state),key=JSON.stringify(state.autoFeed.contract);
  if(prior&&prior.rows===state.sourceRecords&&prior.revision===state.revision&&prior.length===state.sourceRecords.length&&prior.key===key)return prior.value;
  const value=HealthAutoExport.project(state.sourceRecords,state.autoFeed.contract);
  sourceProjectionCache.set(state,{rows:state.sourceRecords,revision:state.revision,length:state.sourceRecords.length,key,value,active:new Set(value.activeIds.concat(value.fallbackIds||[]))});return value;
}
function sourceIsActive(state,id,record){
  if(!state.autoFeed){const r=record||(state.sourceRecords||[]).find(r=>r.id===id);return !!r&&r.unmapped?.healthAutoExport?.format!=='JSON'&&!String(r.id).startsWith('hae:');}
  if(typeof globalThis.HealthAutoExport==='undefined')return false;
  sourceProjection(state);return sourceProjectionCache.get(state).active.has(id);
}
function sourceEvidenceEligible(state,record){return (state.syntheticWorkspace===true||!syntheticPreviewData(record))&&sourceIsActive(state,record.id,record)&&record.unmapped?.healthAutoExport?.representation!=='minute aggregate';}
function relayedRecords(state,kind){const projected=sourceProjection(state);return (projected?projected.records:(state.sourceRecords||[]).filter(r=>sourceIsActive(state,r.id,r))).filter(r=>!kind||r.kind===kind).sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));}
function relaySourceMatches(id, record){
  const app = String(record.sourceApp || '');
  return id === 'bevel-pro' ? /bevel/i.test(app) : id === 'ifit' ? /ifit/i.test(app) : id === 'apple-fitness' ? /apple (watch|fitness|health)|^com\.apple\./i.test(app) : false;
}
function sourceEvidenceSummary(state, id){
  const kinds=new Set(), writers=new Set(), transports=new Set();
  let count=0, latest=null, retrieved=null;
  for(const r of state.sourceRecords || []){
    if(!sourceIsActive(state,r.id,r)||!relaySourceMatches(id,r)) continue;
    count++; kinds.add(r.kind); writers.add(r.sourceApp); transports.add(r.transport || 'legacy relay; transport not recorded');
    const sample=r.end || r.start, retrieval=r.lastRetrievedAt || r.relayedAt;
    if(sample && (!latest || Date.parse(sample)>Date.parse(latest))) latest=sample;
    if(retrieval && (!retrieved || Date.parse(retrieval)>Date.parse(retrieved))) retrieved=retrieval;
  }
  const local=transports.has('local file'), mixed=local && transports.size>1;
  return {id,state:count?(mixed?'mixed imports':local?'local import':'relayed'):'unverified',count,kinds:[...kinds],writers:[...writers],lastSample:latest,retrievedAt:retrieved,transports:[...transports],route:count?(mixed?'Local file and relay records; no verified direct connection':local?'Locally selected file; no verified direct connection':'Sender-reported records via relay; no verified direct connection'):'No matching local records; actual field availability unverified',note:'Based on writing-app labels in local records, not independent device/account verification.'};
}
const BODY_MASS_METRICS = ['weight_body_mass', 'weight_&_body_mass'];
function weightHistory(state, from, to, unit){
  const dest = ['kg','lb'].includes(unit) ? unit : state.prefs.units;
  const rows = observationsBetween(state, from, to).filter(o => Number.isFinite(o.weight)).map(o => ({ id:'manual:' + o.date, date:o.date, instant:o.date, originalValue:o.weight, originalUnit:o.weightUnit || null, source:'Manual check-in', origin:'self-reported', reference:o }));
  // Body fat percentage, BMI and lean body mass are all kind 'weight' too. A percentage or an
  // index is not a body weight, and including them put "32.6 %" under a heading that says Weight
  // and let a body-fat row become the "latest recorded weight". Rows that do not name a metric —
  // relayed and manual ones — are body weights and stay.
  for (const r of relayedRecords(state, 'weight')){
    const metric = r.unmapped && r.unmapped.healthAutoExport && r.unmapped.healthAutoExport.metric;
    if (metric && !BODY_MASS_METRICS.includes(metric)) continue;
    const date = ymd(new Date(r.start)); if (date < from || date > to) continue;
    rows.push({ id:r.id, date, instant:r.start, originalValue:r.value, originalUnit:r.unit, source:r.sourceApp, origin:'relayed', reference:r });
  }
  return rows.map(r => Object.assign(r, { unit:dest, weight:!Number.isFinite(r.originalValue) || r.originalValue <= 0 || !['kg','lb'].includes(r.originalUnit) ? null : r.originalUnit === dest ? r.originalValue : r.originalUnit === 'kg' ? r.originalValue * 2.2046226218487757 : r.originalValue / 2.2046226218487757 })).sort((a, b) => a.date.localeCompare(b.date) || a.instant.localeCompare(b.instant));
}
function workoutHistory(state, from, to){
  const rows = workoutsBetween(state, from, to).map(w => ({ id:'manual:' + w.id, date:w.date, start:w.startTime || null, type:w.type, minutes:w.minutes, elapsedMinutes:null, source:'Manual log', origin:'self-reported', effort:w.effort, reference:w }));
  for (const r of relayedRecords(state, 'workout')){
    const date = ymd(new Date(r.start)); if (date < from || date > to) continue;
    rows.push({ id:r.id, date, start:r.start, type:r.type || 'Workout', minutes:r.durationSec === null || r.durationSec === undefined ? null : r.durationSec / 60, elapsedMinutes:r.elapsedSec === null || r.elapsedSec === undefined ? null : r.elapsedSec / 60, source:r.sourceApp, origin:'relayed', effort:null, reference:r });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date) || (b.start || '').localeCompare(a.start || ''));
}
function workoutComparison(rows, end, span){
  span=Math.max(1,Math.min(7,span||7));
  const since = addDays(end, 1-span), before = addDays(since, -7), previousEnd=addDays(end,-7), groups = new Map();
  for (const r of rows){
    if (r.date < before || r.date > end || (r.date<since&&r.date>previousEnd)) continue;
    const key = r.origin + '|' + r.source + '|' + r.type;
    if (!groups.has(key)) groups.set(key, { source:r.source, type:r.type, origin:r.origin, recent:[], previous:[] });
    groups.get(key)[r.date >= since ? 'recent' : 'previous'].push(r);
  }
  const sum = items => ({ records:items.length, reportedMinutes:items.filter(r => Number.isFinite(r.minutes)).reduce((n, r) => n + r.minutes, 0), knownDurations:items.filter(r => Number.isFinite(r.minutes)).length });
  return [...groups.values()].map(g => Object.assign({}, g, { recent:sum(g.recent), previous:sum(g.previous) }));
}

/* ---- reminders: the page owns the schedule; a native shell delivers it.
        Nothing here is a notification service by itself. ---- */
function setReminder(state, seriesId, time, enabled){
  if (!state.reminders) state.reminders = {};
  const t = hhmm(time);
  if (!t){ delete state.reminders[seriesId]; return null; }
  state.reminders[seriesId] = { time: t, enabled: !!enabled, updatedAt: nowIso() };
  return state.reminders[seriesId];
}
function inQuietHours(prefs, time){
  const q = prefs && prefs.quietHours;
  if (!q || !hhmm(q.from) || !hhmm(q.to) || q.from === q.to) return false;
  const m = t => +t.slice(0, 2) * 60 + +t.slice(3);
  const x = m(time), a = m(q.from), b = m(q.to);
  return a < b ? (x >= a && x < b) : (x >= a || x < b);
}
/* What to hand a native shell: one entry per enabled reminder on a live
   series, weekdays in Apple's 1 = Sunday convention, one-offs by date. */
function reminderSchedule(state, today){
  const out = [];
  for (const [sid, r] of Object.entries(state.reminders || {})){
    if (!r.enabled || !r.time) continue;
    const s = state.series.find(x => x.id === sid);
    if (!s || (s.archivedAt && s.archivedAt <= today)) continue;
    if (inQuietHours(state.prefs, r.time)) continue;
    const v = latestVersion(s);
    if (v.recurrence.kind === 'target' || v.recurrence.intervalWeeks > 1 || (v.recurrence.variants || []).length) continue;
    const base = { id: 'ht-' + sid, seriesId: sid, title: v.name, body: v.normal.label + (v.minimum.label ? ' — or the minimum: ' + v.minimum.label : ''), hour: +r.time.slice(0, 2), minute: +r.time.slice(3) };
    if (v.recurrence.kind === 'once'){ if (v.recurrence.date >= today) out.push(Object.assign(base, { date: v.recurrence.date })); }
    else if (v.recurrence.days.length) out.push(Object.assign(base, { weekdays: v.recurrence.days.map(d => d + 1) }));
  }
  return out;
}

/* ---- water: a count per day, typed by you ---- */
function addWater(state, date, delta){
  if (!state.hydration) state.hydration = {};
  const n = Math.max(0, Math.min(40, (state.hydration[date] || 0) + (+delta || 0)));
  if (n === 0) delete state.hydration[date]; else state.hydration[date] = n;
  return n;
}
function waterOn(state, date){ return (state.hydration && state.hydration[date]) || 0; }

/* ---- improvement notes: user-written suggestions stay separate from
        health records and journals in the manually shared brief. ---- */
function addNote(state, text, area){
  const t = String(text || '').trim().slice(0, 300); if (!t) return null;
  if (!state.notes) state.notes = [];
  const n = { id: newId('n'), text: t, area: String(area || ''), at: nowIso(), done: false };
  state.notes.push(n); return n;
}
function noteChangedAt(n){ return Math.max(...[n.at, n.doneAt, n.updatedAt].map(t => Date.parse(t) || 0)); }
function setNoteDone(state, id, done){
  const n = (state.notes || []).find(x => x.id === id); if (!n || n.done === done) return n || null;
  const at = new Date(Math.max(Date.now(), noteChangedAt(n) + 1)).toISOString();
  n.done = done; n.updatedAt = at;
  if (done) n.doneAt = at;
  return n;
}
function resolveNote(state, id){ return setNoteDone(state, id, true); }
function reopenNote(state, id){ return setNoteDone(state, id, false); }
function saveFeedbackDraft(state, fields){
  const f = fields || {}, text = String(f.text || '').slice(0,300);
  if (!Array.isArray(state.feedbackDrafts)) state.feedbackDrafts = [];
  let d = f.id ? state.feedbackDrafts.find(x => x.id === f.id) : state.feedbackDrafts.find(x => x.cardId === f.cardId && x.status === 'draft');
  if (f.id && !d) return null;
  if (d && d.status === 'approved') return d;
  if (d){
    if (d.text !== text){ d.text = text; d.updatedAt = new Date(Math.max(Date.now(), noteChangedAt(d) + 1)).toISOString(); }
    return d;
  }
  if (!text.trim() || typeof f.cardId !== 'string' || !f.cardId || typeof f.cardLabel !== 'string' || !f.cardLabel) return null;
  const at = nowIso();
  d = {id:newId('feedback'),cardId:f.cardId,cardLabel:f.cardLabel,area:String(f.area || ''),text,at,updatedAt:at,status:'draft'};
  state.feedbackDrafts.push(d); return d;
}
function promoteFeedbackDraft(state, id){
  const d = (state.feedbackDrafts || []).find(x => x.id === id);
  if (!d || !d.text.trim()) return null;
  if (!Array.isArray(state.planIdeas)) state.planIdeas=[];
  if (!Array.isArray(state.learning)) state.learning=[];
  if (!Array.isArray(state.notes)) state.notes = [];
  const noteId = 'n-' + d.id, existing = state.notes.find(n => n.id === noteId);
  if (existing && (existing.sourceDraftId !== d.id || !existing.sourceCard || existing.sourceCard.id !== d.cardId)) return null;
  if (d.status === 'approved') return existing || null;
  const at = new Date(Math.max(Date.now(), noteChangedAt(d) + 1)).toISOString();
  const n = existing || {id:noteId,text:d.text.trim(),area:d.area,at,done:false,sourceCard:{id:d.cardId,label:d.cardLabel,area:d.area},sourceDraftId:d.id};
  if (!existing) state.notes.push(n);
  d.status = 'approved'; d.approvedNoteId = n.id; d.approvedAt = at; d.updatedAt = at;
  return n;
}
function newerFeedbackDraft(incoming, current){
  if (incoming.status !== current.status) return incoming.status === 'approved';
  return noteChangedAt(incoming) > noteChangedAt(current);
}
function buildBrief(state, today){
  const open = (state.notes || []).filter(n => !n.done);
  const lines = [
    'Health Tracker improvement brief — ' + today + ' (build ' + BUILD + ')',
    'Read docs/health-tracker/ROADMAP.md first. Mac is the primary app; phone support comes next.',
    'This brief includes the open suggestions and areas written below. It does not automatically include health records, journal entries, routine details, or measurements. Suggestions may contain personal details you wrote; review before sharing.',
    '',
    open.length ? 'Open suggestions (' + open.length + '):' : 'No open suggestions.',
  ].concat(open.map(n => '[' + n.id + '] ' + n.text + (n.area ? ' [' + n.area + ']' : '') + (n.sourceCard ? ' (Card: ' + n.sourceCard.label + '; ' + n.sourceCard.id + ')' : '')));
  lines.push('', 'Use the stable suggestion IDs when discussing changes. After reviewing an update, mark its suggestion resolved manually in Lessons & Updates. Reopen it there if more work is needed.');
  return lines.join('\n');
}

/* ---- food log: what you say you ate, when. No calories, no database. ---- */
function addFood(state, f){
  const x = {
    id: newId('f'), origin:'self-reported', date: f.date,
    time: hhmm(f.time), label: String(f.label || '').trim().slice(0, 80),
    location:['home','away'].includes(f.location)?f.location:'unknown',timePrecision:f.timePrecision==='approximate'?'approximate':'exact',actionId:f.actionId||null,
    tag: MEAL_TAGS.some(t => t.id === f.tag) ? f.tag : 'other',
    notes: String(f.notes || '').trim().slice(0, 140),
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  if (!x.label) return null;
  if(state.syntheticWorkspace===true)x.syntheticPreview=true;
  state.foods.push(x);
  return x;
}
function updateFood(state, id, f){
  const x = state.foods.find(y => y.id === id); if (!x) return null;
  const n = addFood({ foods: [] }, Object.assign({}, x, f)); if (!n) return null;
  Object.assign(x, n, { id: x.id, origin:'self-reported', createdAt: x.createdAt, updatedAt: nowIso() });
  return x;
}
function deleteFood(state, id){
  const before = state.foods.length;
  state.foods = state.foods.filter(x => x.id !== id);
  return state.foods.length < before;
}
function foodsOn(state, date){
  return state.foods.filter(x => x.date === date).sort((a, b) => (a.time || '99').localeCompare(b.time || '99') || a.createdAt.localeCompare(b.createdAt));
}
/* Your own recent labels, most used first — the chips come from you, not a database. */
function recentFoodLabels(state, n){
  const count = {};
  for (const x of state.foods){ const k = x.label; count[k] = (count[k] || 0) + 1; }
  return Object.entries(count).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n || 8).map(e => e[0]);
}
function isFastingDay(state, date){
  const d = state.prefs && state.prefs.fastingDays;
  return Array.isArray(d) && d.includes(dow(date));
}

/* ---- rings: three things the app actually knows about a day ---- */
function dayRings(state, date){
  const rows = confirmedProgression(state) ? completionRows(state,date) : flatPlanFor(state,date);
  const t = tallyDay(rows);
  const mv = rows.filter(r => r.category === 'movement' || (r.group === 'fitness' && r.matching && r.matching.kind === 'workout'));
  const wk = workoutsOn(state, date);
  const movement = mv.some(r => r.status === 'done') || (!confirmedProgression(state) && wk.length) ? 'done'
    : mv.some(r => r.status === 'partial') ? 'partial'
    : mv.length ? (mv.every(r => r.optional) ? 'optional' : 'planned') : 'none';
  return {
    routine: { done: t.normal + t.minimum, partial: t.partial, skipped: t.skipped, none: t.none, planned: rows.length },
    movement, workouts: wk.length,
    checkin: !!observationFor(state, date),
  };
}
function nextThree(rows){ return leafRows(rows).filter(r => r.status === null).slice(0, 3); }

/* ---- narrative: rule-based, cites its basis, says when it does not know ---- */
function narrateDay(state, date, today){
  const rows = flatPlanFor(state, date);
  if (!rows.length) return { text: 'Nothing planned for this day.', basis: 'No plan for this date.' };
  const t = tallyDay(rows);
  const n = nextAction(rows);
  const obs = observationFor(state, date);
  const wk = workoutsOn(state, date);
  const parts = [];
  const done = rows.filter(r => r.status === 'done').map(r => r.name);
  if (done.length){
    parts.push((done.length <= 2 ? done.join(' and ') : done.slice(0, 2).join(', ') + ' and ' + (done.length - 2) + ' more') + (done.length === 1 ? ' is done.' : ' are done.'));
    if (t.minimum) parts.push(t.minimum === 1 ? 'One of those was the minimum version, which counts.' : t.minimum + ' of those were minimum versions, which count.');
  }
  if (t.partial) parts.push(t.partial === 1 ? 'One is recorded as partial.' : t.partial + ' are recorded as partial.');
  if (t.skipped) parts.push(t.skipped === 1 ? 'One was skipped on purpose.' : t.skipped + ' were skipped on purpose.');
  if (n){
    parts.push(n.name + ' is next' + (n.optional ? ' — it is optional, and rest counts.' : '.'));
    if (date < today && t.none) parts.push((t.none === 1 ? 'One activity has' : t.none + ' activities have') + ' no entry; that is unknown, not a miss.');
  } else if (date <= today) parts.push('Every activity has an entry.');
  if (date > today && !done.length) parts.unshift('This day has not come yet.');
  const entries = t.normal + t.minimum + t.partial + t.skipped;
  const basis = 'Based on ' + entries + (entries === 1 ? ' entry' : ' entries') + (obs ? ', your check-in' : ', no check-in yet') +
    (wk.length ? ', ' + wk.length + (wk.length === 1 ? ' workout' : ' workouts') + ' you reported' : '') + '. Nothing is imported.';
  return { text: parts.join(' '), basis };
}
function narrateWeek(state, start, today){
  const days = weekDays(start);
  const lived = days.filter(d => d <= today);
  const ahead = days.length - lived.length;
  const byAnchor = {};
  for (const d of lived){
    for (const r of flatPlanFor(state, d)){
      if (r.demo) continue;
      const a = byAnchor[r.anchor] || (byAnchor[r.anchor] = { planned:0, done:0, none:0 });
      a.planned++;
      if (r.status === 'done') a.done++; else if (r.status === null) a.none++;
    }
  }
  const label = { morning:'Mornings', midday:'Middays', evening:'Evenings', night:'Wind-downs' };
  const parts = [];
  const anchors = Object.entries(byAnchor).filter(([, a]) => a.planned >= 2);
  if (!anchors.length) return { text: lived.length ? 'Not enough lived days with a plan to say anything yet.' : 'This week has not started.', basis: 'Based on ' + lived.length + ' lived days; example routines left out.' };
  const best = anchors.slice().sort((x, y) => (y[1].done / y[1].planned) - (x[1].done / x[1].planned))[0];
  const gaps = anchors.filter(([, a]) => a.none >= 2).sort((x, y) => y[1].none - x[1].none)[0];
  if (best && best[1].done) parts.push(label[best[0]] + ' held up: ' + best[1].done + ' of ' + best[1].planned + ' done.');
  if (gaps) parts.push(label[gaps[0]] + ' had ' + gaps[1].none + ' with no entry — unknown, not missed.');
  if (!parts.length) parts.push('Entries are spread evenly so far.');
  const rv = reviewFor(state, start);
  if (rv && rv.adjustment) parts.push('The one adjustment you chose: ' + rv.adjustment + '.');
  if (ahead) parts.push(ahead + (ahead === 1 ? ' day is' : ' days are') + ' still ahead.');
  return { text: parts.join(' '), basis: 'Based on ' + lived.length + ' lived days of planned activities; example routines left out; nothing imported.' };
}

/* ---- examples: per-item, judged by what was actually done to each one ---- */
function exampleStatus(state){
  return state.series.filter(s => s.demo).map(s => {
    const occs = Object.values(state.occurrences).filter(o => o.seriesId === s.id);
    const entries = occs.filter(o => o.status !== null || o.note || o.actualMinutes !== null).length;
    return {
      seriesId: s.id, name: latestVersion(s).name, entries,
      touched: occs.length > 0 || s.versions.length > 1,
      edited: s.versions.length > 1,
      stopped: !!s.archivedAt, since: s.archivedAt || null,
    };
  });
}
function stopUntouchedExamples(state, from){
  let n = 0;
  for (const x of exampleStatus(state)){
    if (x.touched || x.entries || x.stopped) continue;
    if (archiveSeries(state, x.seriesId, from, from)) n++;
  }
  return n;
}
/* New stores no longer receive the invented examples (Mintay, 2026-09-23); existing ones get a
   reviewed removal. Stopping keeps every entry and can be resumed; an example with an entry today or
   later stops the day after that entry, so nothing recorded is hidden. */
function exampleRemovalPreview(state, today){
  today = today || todayYmd();
  return state.series.filter(s => s.demo && !s.archivedAt).map(s => {
    const dates = Object.values(state.occurrences).filter(o => o.seriesId === s.id && (o.status !== null || o.note || o.actualMinutes !== null)).map(o => o.date).sort();
    const last = dates[dates.length - 1] || null;
    return { seriesId:s.id, name:latestVersion(s).name, entries:dates.length, from:last && last >= today ? addDays(last, 1) : today };
  });
}
function stopExamples(state, today){
  today = today || todayYmd();
  const plan = exampleRemovalPreview(state, today);
  for (const x of plan) archiveSeries(state, x.seriesId, x.from, today);
  return plan;
}
function liveExamples(state, asOf){
  return state.series.filter(s => s.demo && !(s.archivedAt && s.archivedAt <= asOf)).length;
}

/* ---- fields added after the first records were written. An older record
        is completed in memory and stays readable; nothing is rewritten. ---- */
function migrate(state){
  if (!state) return state;
  if (state.profile === undefined) state.profile = null;
  if (!state.observations || typeof state.observations !== 'object' || Array.isArray(state.observations)) state.observations = {};
  if (!Array.isArray(state.foods)) state.foods = [];
  if (!Array.isArray(state.groups) || !state.groups.length) state.groups = DEFAULT_GROUPS.map(g => Object.assign({ hidden:false, custom:false }, g));
  else for (const g of DEFAULT_GROUPS){ if (!state.groups.some(x => x.id === g.id)) state.groups.push(Object.assign({ hidden:false, custom:false }, g)); }
  const hobbies=state.groups.find(g=>g.id==='interests');if(hobbies&&hobbies.name==='Optional interests')hobbies.name='Hobbies';
  if (!Array.isArray(state.goals)) state.goals = [];
  // freshState() gained these two, migrate() did not. A record saved before they existed passed
  // validateState (both are optional there) and then threw on first render: Today, Profile,
  // Plan & Quests and Progress all call S().learning.find or S().planIdeas.filter directly, so
  // every one of those areas came up blank while Fitness, which touches neither, looked fine.
  if (!Array.isArray(state.learning)) state.learning = [];
  if (!Array.isArray(state.planIdeas)) state.planIdeas = [];
  // applyTheme() reads state.prefs on every render, so a record without it cannot paint at all.
  // Fill in only the missing keys: a record that already chose a theme or text size keeps it.
  if (!state.prefs || typeof state.prefs !== 'object' || Array.isArray(state.prefs)) state.prefs = {};
  for (const [key, value] of Object.entries(freshState().prefs)) {
    if (state.prefs[key] === undefined) state.prefs[key] = value;
  }
  if (!state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)) state.sources = {};
  for (const src of SOURCES){ if (!state.sources[src.id]) state.sources[src.id] = { state:'unverified', lastSample:null, retrievedAt:null, note:'' }; }
  if (state.prefs && !Array.isArray(state.prefs.fastingDays)) state.prefs.fastingDays = [];
  if (state.prefs && !THEMES.includes(state.prefs.theme)) state.prefs.theme = 'dark';
  if (state.prefs && !['normal','large'].includes(state.prefs.textSize)) state.prefs.textSize = 'normal';
  if (state.prefs && state.prefs.quietHours === undefined) state.prefs.quietHours = null;
  if (!state.reminders || typeof state.reminders !== 'object' || Array.isArray(state.reminders)) state.reminders = {};
  if (!state.hydration || typeof state.hydration !== 'object' || Array.isArray(state.hydration)) state.hydration = {};
  if (!Array.isArray(state.notes)) state.notes = [];
  if (!Array.isArray(state.feedbackDrafts)) state.feedbackDrafts = [];
  if (!state.rank || typeof state.rank !== 'object') state.rank = { rule:null, weights:{} };
  if (!state.rank.weights || typeof state.rank.weights !== 'object') state.rank.weights = {};
  if (state.avatar === undefined) state.avatar = null;
  if (!Array.isArray(state.sourceRecords)) state.sourceRecords = [];
  if (!state.grades) state.grades = defaultGradeSettings();
  if (!state.journal) state.journal = {};
  if (!Array.isArray(state.importReceipts)) state.importReceipts = [];
  if (!state.rewardGeneration) state.rewardGeneration = 'legacy-' + fnv(String(state.createdAt || 'original-store'));
  migrateRewards(state);
  if(typeof MealWater!=='undefined')MealWater.ensure(state);
  for (const o of Object.values(state.occurrences || {})) if (!o.rewardEventId) o.rewardEventId = rewardIdentity(state,o);
  return state;
}

/* ---- shape checks shared by the store and by import ---- */
function validateState(x){
  if (!x || typeof x !== 'object') return 'The record is not an object.';
  if (typeof x.schema !== 'number' || x.schema > SCHEMA) return 'The record is version ' + x.schema + '; this build reads up to version ' + SCHEMA + '.';
  if (!Array.isArray(x.series)) return 'The record has no routine list.';
  for (const s of x.series){
    if (!s || typeof s.id !== 'string' || !Array.isArray(s.versions) || !s.versions.length) return 'A routine is malformed.';
    for (const v of s.versions){
      if (!v || typeof v.version !== 'number' || typeof v.effectiveFrom !== 'string' || typeof v.name !== 'string') return 'A routine version is malformed.';
    }
  }
  if (!x.occurrences || typeof x.occurrences !== 'object' || Array.isArray(x.occurrences)) return 'The record has no occurrence map.';
  for (const [k, o] of Object.entries(x.occurrences)){
    if (!o || typeof o.seriesId !== 'string' || typeof o.date !== 'string' || occKey(o.seriesId, o.date) !== k) return 'An occurrence is malformed.';
    if (o.rewardEventId !== undefined && (typeof o.rewardEventId !== 'string' || !o.rewardEventId)) return 'An occurrence reward identity is malformed.';
  }
  if (!Array.isArray(x.workouts)) return 'The record has no workout list.';
  for (const w of x.workouts){ if (!w || typeof w.id !== 'string' || typeof w.date !== 'string') return 'A workout is malformed.'; }
  if (!Array.isArray(x.reviews)) return 'The record has no review list.';
  if (x.groups !== undefined){
    if (!Array.isArray(x.groups)) return 'The group list is malformed.';
    for (const g of x.groups){ if (!g || typeof g.id !== 'string' || typeof g.name !== 'string') return 'A group is malformed.'; }
  }
  if (x.bodySnapshot !== undefined && x.bodySnapshot !== null && (typeof x.bodySnapshot !== 'object' || Array.isArray(x.bodySnapshot))) return 'The body snapshot is malformed.';
  if (x.goals !== undefined && !Array.isArray(x.goals)) return 'The goal list is malformed.';
  if (x.reminders !== undefined && (!x.reminders || typeof x.reminders !== 'object' || Array.isArray(x.reminders))) return 'The reminder map is malformed.';
  if (x.hydration !== undefined){
    if (!x.hydration || typeof x.hydration !== 'object' || Array.isArray(x.hydration)) return 'The water log is malformed.';
    for (const v of Object.values(x.hydration)){ if (typeof v !== 'number' || v < 0) return 'A water count is malformed.'; }
  }
  if (x.notes !== undefined){
    if (!Array.isArray(x.notes)) return 'The note list is malformed.';
    const ids = new Set(), timestamp = t => typeof t === 'string' && Number.isFinite(Date.parse(t));
    for (const n of x.notes){
      if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id) || typeof n.text !== 'string' || !n.text.trim() || n.text.length > 300 || (n.area !== undefined && typeof n.area !== 'string') || typeof n.done !== 'boolean' || !timestamp(n.at) || (n.doneAt !== undefined && !timestamp(n.doneAt)) || (n.updatedAt !== undefined && !timestamp(n.updatedAt))) return 'An improvement note is malformed.';
      if ((n.sourceCard !== undefined && (!n.sourceCard || ['id','label','area'].some(k => typeof n.sourceCard[k] !== 'string') || !n.sourceCard.id || !n.sourceCard.label)) || (n.sourceDraftId !== undefined && (typeof n.sourceDraftId !== 'string' || !n.sourceDraftId))) return 'An improvement note source is malformed.';
      ids.add(n.id);
    }
  }
  if (x.feedbackDrafts !== undefined){
    if (!Array.isArray(x.feedbackDrafts)) return 'The feedback draft list is malformed.';
    const ids = new Set(), timestamp = t => typeof t === 'string' && Number.isFinite(Date.parse(t));
    for (const d of x.feedbackDrafts){
      if (!d || ['id','cardId','cardLabel','area','text'].some(k => typeof d[k] !== 'string') || !d.id || !d.cardId || !d.cardLabel || ids.has(d.id) || d.text.length > 300 || !timestamp(d.at) || !timestamp(d.updatedAt) || !['draft','approved'].includes(d.status)) return 'A feedback draft is malformed.';
      if (d.status === 'approved' ? (!d.text.trim() || d.approvedNoteId !== 'n-' + d.id || !timestamp(d.approvedAt)) : (d.approvedNoteId !== undefined || d.approvedAt !== undefined)) return 'A feedback draft approval is malformed.';
      ids.add(d.id);
    }
  }
  for (const d of x.feedbackDrafts || []){
    const note = (x.notes || []).find(n => n.id === 'n-' + d.id);
    if (d.status === 'approved' && (!note || note.sourceDraftId !== d.id || !note.sourceCard || note.sourceCard.id !== d.cardId)) return 'An approved feedback draft is missing its linked improvement note.';
    if (d.status === 'draft' && note) return 'A feedback draft has an improvement note without an approval.';
  }
  for (const n of x.notes || []){
    if (n.sourceCard !== undefined || n.sourceDraftId !== undefined){
      const draft = (x.feedbackDrafts || []).find(d => d.id === n.sourceDraftId);
      if (!n.sourceCard || !draft || draft.status !== 'approved' || draft.approvedNoteId !== n.id || draft.cardId !== n.sourceCard.id) return 'A card improvement note is missing its draft approval.';
    }
  }
  if (x.rank !== undefined && (!x.rank || typeof x.rank !== 'object' || (x.rank.rule && !Array.isArray(x.rank.rule.tiers)))) return 'The rank rule is malformed.';
  if (x.avatar !== undefined && x.avatar !== null && (typeof x.avatar !== 'object' || typeof x.avatar.photo !== 'string')) return 'The avatar is malformed.';
  if (x.sourceRecords !== undefined){
    if (!Array.isArray(x.sourceRecords)) return 'The source record list is malformed.';
    for (const r of x.sourceRecords){ if (!r || typeof r.id !== 'string' || typeof r.start !== 'string' || typeof r.sourceApp !== 'string') return 'A source record is malformed.'; }
  }
  if (x.grades !== undefined){
    const g = x.grades;
    if (!g || typeof g !== 'object' || !g.weights || !g.included || GRADE_CATEGORIES.some(id => !Number.isFinite(g.weights[id]) || g.weights[id] < 0 || g.weights[id] > 10 || typeof g.included[id] !== 'boolean')) return 'The category grade settings are malformed.';
  }
  if (x.rewards !== undefined){
    const r = x.rewards, map = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!map(r) || r.version !== 2 || !map(r.claims) || !map(r.evidence) || !map(r.unlocks) || !map(r.progression)) return 'The reward ledger is malformed.';
    if (!['legacy-10','gentle-v1','confirmed-s11','quarter-v1'].includes(r.progression.rule)) return 'The progression rule is unsupported.';
    if (r.progression.rule === 'gentle-v1' && (!Number.isInteger(r.progression.anchorLevel) || r.progression.anchorLevel < 1 || r.progression.firstThreshold !== r.progression.anchorLevel * 10)) return 'The progression milestone is malformed.';
    for (const [id,c] of Object.entries(r.claims)){
      if(c&&c.ruleVersion===4){const error=validateQuarterClaim(c,id,r);if(error)return error;continue;}
      if (!c || c.id !== id || c.eventId !== id || (c.ruleVersion===3 ? (!Number.isInteger(c.amount)||c.amount<1||c.amount>54) : c.amount!==1) || typeof c.claimedAt !== 'string' || typeof c.date !== 'string' || typeof c.seriesId !== 'string' || ![1,2,3].includes(c.ruleVersion)) return 'A reward claim is malformed.';
      if(c.adjustments && (!Array.isArray(c.adjustments)||c.adjustments.some(a=>!a||!Number.isInteger(a.delta)||typeof a.id!=='string'||typeof a.at!=='string')||claimBalance(c)<0||claimBalance(c)>54))return 'A reward correction is malformed.';
    }
    if(r.progression.rule==='quarter-v1'&&(!Array.isArray(r.epochs)||!r.epochs.some(e=>e.id===r.progression.epochId&&e.ruleVersion===4&&validCalendarDate(e.effectiveFrom))))return 'The quarter-point epoch is malformed.';
    for (const [id,e] of Object.entries(r.evidence)) if (!e || e.sourceId !== id || typeof e.eventId !== 'string' || typeof e.fingerprint !== 'string' || typeof e.updatedAt !== 'string') return 'A reward evidence association is malformed.';
  }
  for(const key of ['planIdeas','learning'])if(x[key]!==undefined&&(!Array.isArray(x[key])||x[key].some(i=>!i||typeof i.id!=='string'||typeof i.at!=='string'||typeof i.text!=='string')))return 'A planning or learning record is malformed.';
  if (x.revision!==undefined&&(!Number.isInteger(x.revision)||x.revision<0))return 'The workspace revision is malformed.';
  if (x.rewardGeneration !== undefined && (typeof x.rewardGeneration !== 'string' || !x.rewardGeneration || x.rewardGeneration.length > 200)) return 'The reward store identity is malformed.';
  if (x.importReceipts !== undefined){
    if (!Array.isArray(x.importReceipts) || x.importReceipts.some(r => !r || typeof r.id !== 'string' || typeof r.at !== 'string' || typeof r.transport !== 'string' || !r.counts || ['added','same','clash','invalid','unsupported'].some(k => !Number.isFinite(r.counts[k]) || r.counts[k] < 0))) return 'An import receipt is malformed.';
  }
  if (typeof validateFamilyState === 'function'){ const familyProblem = validateFamilyState(x); if (familyProblem) return familyProblem; }
  if (x.foods !== undefined){
    if (!Array.isArray(x.foods)) return 'The food log is malformed.';
    for (const f of x.foods){ if (!f || typeof f.id !== 'string' || typeof f.date !== 'string') return 'A food entry is malformed.'; }
  }
  for (const r of x.reviews){ if (!r || typeof r.periodStart !== 'string') return 'A review is malformed.'; }
  if (x.profile !== undefined && x.profile !== null){
    const p = x.profile;
    if (typeof p !== 'object' || !Array.isArray(p.items) || !Array.isArray(p.questions)) return 'The starting point is malformed.';
    for (const it of p.items){ if (!it || typeof it.text !== 'string' || !PROVENANCE.includes(it.status)) return 'A starting-point item is malformed.'; }
  }
  if (x.observations !== undefined){
    if (!x.observations || typeof x.observations !== 'object' || Array.isArray(x.observations)) return 'The check-in map is malformed.';
    for (const [k, o] of Object.entries(x.observations)){ if (!o || o.date !== k) return 'A check-in is malformed.'; }
  }
  if(x.autoFeed!==undefined){
    const feed=x.autoFeed;
    if(!feed||feed.version!==1||typeof feed.paused!=='boolean'||!Array.isArray(feed.files)||!feed.contract)return 'The automatic feed configuration is malformed.';
    if(typeof globalThis.HealthAutoExport!=='undefined'&&HealthAutoExport.validateContract(feed.contract))return 'The automatic feed contract is unsupported.';
    if(feed.files.some(f=>!f||f.feedId!==feed.contract.feedId||typeof f.fileId!=='string'||!Array.isArray(f.digests)))return 'The automatic delivery history is malformed.';
  }
  if(typeof MealWater!=='undefined'){const problem=MealWater.validate(x);if(problem)return problem;}
  return null;
}

/* ---- storage: the only place that talks to localStorage. Everything
        above is storable anywhere, which is what a later native or
        synced version will reuse. ---- */
const SNAP_MAX = 5;
const SNAP_KEY = STORE_KEY + '.snap.';
const QUAR_KEY = STORE_KEY + '.quarantine';
const REWARD_KEY = STORE_KEY + '.claims';
const QUAR_REWARD_KEY = REWARD_KEY + '.quarantine';
const store = {
  read(){
    let raw;
    try { raw = localStorage.getItem(STORE_KEY); }
    catch(e){ return { ok:false, error:'This browser refused to read local storage.' }; }
    if (raw === null || raw === undefined) return { ok:true, state:null };
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch(e){ return { ok:false, error:'The saved record could not be read (invalid file).' }; }
    const problem = validateState(parsed);
    if (problem) return { ok:false, error:'The saved record was refused: ' + problem };
    return this.readClaims(migrateTo(parsed));
  },
  /* Claims have their own atomic key. A stale ordinary whole-state write
     cannot erase them; only locked claim transactions write this key. */
  readClaims(state){
    if (confirmedProgression(state)) return {ok:true,state};
    let raw;
    try { raw = localStorage.getItem(REWARD_KEY); }
    catch(e){ return {ok:false,state,rewardError:true,error:'This browser refused to read the reward ledger.'}; }
    if (!raw) return {ok:true,state};
    let ledger;
    try { ledger = JSON.parse(raw); }
    catch(e){ return {ok:false,state,rewardError:true,error:'The reward ledger is unreadable. Your activity record is intact; restore a known-good backup before claiming.'}; }
    if (ledger && ledger.generation !== state.rewardGeneration) return {ok:true,state};
    const problem = !ledger || ledger.version !== 1 || !ledger.rewards || validateState(Object.assign({},state,{rewards:ledger.rewards}));
    if (problem) return {ok:false,state,rewardError:true,error:'The reward ledger was refused. Your activity record is intact; restore a known-good backup before claiming.'};
    mergeRewardLedger(state,ledger);
    return {ok:true,state};
  },
  writeClaims(state){
    if (confirmedProgression(state)) return this.write(state);
    let text;
    try { text = JSON.stringify({version:1,generation:state.rewardGeneration,rewards:state.rewards}); }
    catch(e){ return {ok:false,error:'Could not prepare the reward claim.'}; }
    try { this.takeSnapshot(todayYmd()); } catch(e){}
    try { localStorage.setItem(REWARD_KEY,text); }
    catch(e){ return {ok:false,error:'The reward claim was not saved. Local storage may be full or unavailable; completed work remains recorded.'}; }
    const current = this.read();
    if (!current.ok) return {ok:false,error:'The claim write finished but could not be verified. Reload before trying again.'};
    if (!current.state || current.state.rewardGeneration !== state.rewardGeneration) return {ok:false,error:'The workspace changed while claiming. Reload it before trying again.'};
    this.mirror(JSON.stringify(current.state));
    return {ok:true};
  },
  /* Rolling snapshots: the last valid record is copied aside before the
     first save of each day, keeping up to SNAP_MAX dated copies. A bad save
     can therefore be undone from inside the app, not only from an export. */
  snapshots(){
    const out = [];
    for (let i = 0; i < SNAP_MAX; i++){
      try { const raw = localStorage.getItem(SNAP_KEY + i); if (!raw) continue; const at = raw.slice(0, 24); out.push({ slot: i, at, size: raw.length - 25, raw: raw.slice(25) }); } catch(e){}
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  },
  takeSnapshot(today, priorRaw, force){
    let cur;
    try { cur = typeof priorRaw === 'string' ? priorRaw : localStorage.getItem(STORE_KEY); } catch(e){ return false; }
    if (!cur) return false;
    let ok = false; try { ok = validateState(JSON.parse(cur)) === null; } catch(e){}
    if (!ok) return false;
    if (typeof priorRaw !== 'string'){
      const complete = this.read();
      if (!complete.ok) return false;
      if (complete.state) cur = JSON.stringify(complete.state);
    }
    const snaps = this.snapshots();
    if (!force && snaps.length && ymd(new Date(snaps[0].at)) === today) return false;      // one per local day, except an explicit pre-import recovery copy
    const used = new Set(snaps.map(x => x.slot));
    let slot = -1;
    for (let i = 0; i < SNAP_MAX; i++){ if (!used.has(i)){ slot = i; break; } }
    if (slot < 0) slot = snaps[snaps.length - 1].slot;                           // overwrite the oldest
    const stamp = new Date().toISOString().padEnd(24, ' ').slice(0, 24);
    try { localStorage.setItem(SNAP_KEY + slot, stamp + '|' + cur); return true; } catch(e){ return false; }
  },
  /* An unreadable record is set aside, never deleted, so nothing is lost to a bad byte. */
  quarantine(){
    try {
      const raw = localStorage.getItem(STORE_KEY); if (!raw) return null;
      const at = new Date().toISOString();
      localStorage.setItem(QUAR_KEY, at + '|' + raw);
      localStorage.removeItem(STORE_KEY);
      return { at, size: raw.length };
    } catch(e){ return null; }
  },
  quarantined(){ try { const q = localStorage.getItem(QUAR_KEY); return q ? { at: q.slice(0, 24), size: q.length - 25, raw: q.slice(25) } : null; } catch(e){ return null; } },
  quarantinedClaims(){ try { const q = localStorage.getItem(QUAR_REWARD_KEY); return q ? {at:q.slice(0,24),size:q.length-25,raw:q.slice(25)} : null; } catch(e){ return null; } },
  /* setItem is all-or-nothing per key, so a refused or interrupted write
     leaves the previous valid record in place rather than truncating it. */
  write(state, options){
    let text;
    const problem=validateState(state);if(problem)return {ok:false,error:problem};
    const existing = this.read();
    const replacing = !!(options && options.replaceRewards);
    if (replacing && existing.rewardError){
      try { const raw = localStorage.getItem(REWARD_KEY); if (raw) localStorage.setItem(QUAR_REWARD_KEY,nowIso() + '|' + raw); }
      catch(e){ return {ok:false,error:'The unreadable reward ledger could not be set aside safely. Nothing was replaced.'}; }
    }
    if(replacing&&existing.ok&&existing.state&&confirmedProgression(existing.state)&&state.series.length&&!confirmedProgression(state))return {ok:false,error:'This backup predates confirmed progression. Merge it for review instead of replacing the current reward history.'};
    if(replacing&&existing.ok&&existing.state&&confirmedProgression(state))mergeRewardLedger(state,existing.state);
    if (!replacing && existing.rewardError) return {ok:false,error:existing.error};
    if (!replacing && existing.ok && existing.state && existing.state.rewardGeneration !== state.rewardGeneration) return {ok:false,error:'This workspace was replaced in another view. Reload before saving.'};
    if (!replacing && existing.ok && existing.state && (state.revision||0)!==(existing.state.revision||0)) return {ok:false,error:'This workspace changed in another window. Reload before saving.'};
    if (!replacing && existing.ok && existing.state && !confirmedProgression(state)){ mergeRewardLedger(state,existing.state); }
    if (!replacing){ const claims = this.readClaims(state); if (!claims.ok) return {ok:false,error:claims.error}; }
    if (state.rewards) preserveRewardUnlocks(state,todayYmd());
    const generation = replacing ? newId('store') : state.rewardGeneration;
    try { text = JSON.stringify(Object.assign({},state,{rewardGeneration:generation,revision:(state.revision||0)+1})); }
    catch(e){ return { ok:false, error:'Could not prepare the record for saving.' }; }
    const deferSnapshot = !!(options && options.deferSnapshot);
    const priorSnapshotRaw = deferSnapshot && existing.ok && existing.state ? JSON.stringify(existing.state) : null;
    if (!deferSnapshot) try { this.takeSnapshot(todayYmd()); } catch(e){}
    try { localStorage.setItem(STORE_KEY, text); }
    catch(e){
      const full = e && (e.name === 'QuotaExceededError' || e.code === 22);
      return { ok:false, error: full ? 'Local storage is full — nothing was saved.' : 'This browser refused to save.' };
    }
    state.rewardGeneration = generation; state.revision=(state.revision||0)+1;
    if (replacing) try { localStorage.removeItem(REWARD_KEY); } catch(e){}
    let snapshotSafe = true;
    if (deferSnapshot && priorSnapshotRaw){
      try { snapshotSafe = this.takeSnapshot(todayYmd(),priorSnapshotRaw,true); }
      catch(e){ snapshotSafe = false; }
    }
    this.mirror(text);
    return { ok:true, snapshotSafe };
  },
  /* IndexedDB mirror: a second copy with far more room than localStorage,
     written after every successful save and readable for recovery. It is
     the seam a later Health import store grows from; today it is a mirror. */
  mirror(text){
    try {
      if (typeof indexedDB === 'undefined') return;
      const req = indexedDB.open('health-tracker');
      req.onupgradeneeded = () => { req.result.createObjectStore('records'); };
      req.onsuccess = () => { try { const tx = req.result.transaction('records', 'readwrite'); tx.objectStore('records').put({ at: new Date().toISOString(), text }, 'current'); tx.oncomplete = () => req.result.close(); } catch(e){} };
    } catch(e){}
  },
  readMirror(cb){
    try {
      if (typeof indexedDB === 'undefined') return cb(null);
      const req = indexedDB.open('health-tracker');
      req.onupgradeneeded = () => { req.result.createObjectStore('records'); };
      req.onerror = () => cb(null);
      req.onsuccess = () => { try { const tx = req.result.transaction('records', 'readonly'); const g = tx.objectStore('records').get('current'); g.onsuccess = () => { cb(g.result || null); req.result.close(); }; g.onerror = () => cb(null); } catch(e){ cb(null); } };
    } catch(e){ cb(null); }
  },
};
/* The legacy synchronous store remains readable until a verified migration.
   Once activated, one IndexedDB transaction owns app state and source records. */
const durableStore = {engine:null,active:false,cache:null,error:null,stagedState:null};
const legacyRead = store.read.bind(store), legacyWrite = store.write.bind(store), legacyWriteClaims = store.writeClaims.bind(store);
store.connect = async function(){
  let marked=false;
  try { marked=!!localStorage.getItem(STORE_KEY+'.idb-authority'); }
  catch(e){ durableStore.error='The saved workspace cannot be accessed. Your existing files have not been changed.';return; }
  if(typeof globalThis.HealthStore==='undefined'){
    if(marked)durableStore.error='The transactional storage component is unavailable. Reopen the current app; the preserved legacy copy has not been substituted.';
    return;
  }
  const engine=globalThis.HealthStore.create({key:STORE_KEY,validateState,sourceSignature:r=>r.unmapped?.healthAutoExport?.format==='JSON'&&typeof HealthAutoExport!=='undefined'?HealthAutoExport.signature(r):relaySignature(r)});
  durableStore.engine=engine;
  const opened=await engine.open();
  if(!opened.ok){durableStore.error=opened.error;if(opened.code==='STAGED'){const legacy=legacyRead();if(legacy.ok&&legacy.state)durableStore.stagedState=legacy.state;}return;}
  const loaded=await engine.read();
  if(!loaded.ok || loaded.blockedMigration){durableStore.error=loaded.error||'A storage migration is waiting for recovery verification. Nothing else will be saved.';return;}
  if(loaded.authority==='indexeddb'){
    if(loaded.state.autoFeed&&typeof globalThis.HealthAutoExport==='undefined'){durableStore.error='The feed adapter is unavailable. Reopen the complete review app before saving.';return;}
    durableStore.active=true;durableStore.cache=loaded.state;
  }
};
store.read = function(){
  if(durableStore.error)return {ok:false,error:durableStore.error,transactionalError:true};
  if(durableStore.active)return {ok:true,state:JSON.parse(JSON.stringify(durableStore.cache))};
  return legacyRead();
};
store.readFresh = async function(){
  if(!durableStore.active)return this.read();
  const result=await durableStore.engine.read();
  if(!result.ok || result.authority!=='indexeddb')return {ok:false,error:result.error||'The current storage generation could not be read.',transactionalError:true};
  durableStore.cache=result.state;
  return {ok:true,state:JSON.parse(JSON.stringify(result.state))};
};
store.activate = async function(state,backup){
  if(!durableStore.engine)return {ok:false,error:'Transactional storage is unavailable in this app.'};
  const result=await durableStore.engine.migrate(state,{backup});
  if(!result.ok){durableStore.error=result.error;return result;}
  const loaded=await durableStore.engine.read();
  if(!loaded.ok || loaded.authority!=='indexeddb'){durableStore.error=loaded.error||'The migrated record could not be reconciled.';return {ok:false,error:durableStore.error};}
  durableStore.active=true;durableStore.cache=loaded.state;durableStore.error=null;durableStore.stagedState=null;
  replaceState(state,loaded.state);
  return {ok:true};
};
store.write = function(state,options){
  if(!durableStore.active)return durableStore.error?{ok:false,error:durableStore.error}:legacyWrite(state,options);
  return this.writeTransactional(state,options||{});
};
store.writeTransactional = async function(state,options){
  // The engine re-reads and checks CAS inside its write; this cache was validated at the last read/commit.
  const existing=durableStore.error?{ok:false,error:durableStore.error}:{ok:true,state:durableStore.cache};if(!existing.ok)return existing;
  const prior=existing.state,replacing=!!options.replaceRewards;
  if(replacing&&confirmedProgression(prior)&&state.series.length&&!confirmedProgression(state))return {ok:false,error:'This backup predates confirmed progression. Merge it for review instead.'};
  if(replacing&&confirmedProgression(state))mergeRewardLedger(state,prior);
  if(!replacing&&prior.rewardGeneration!==state.rewardGeneration)return {ok:false,error:'This workspace was replaced in another view. Reload before saving.'};
  if(!replacing&&(prior.revision||0)!==(state.revision||0))return {ok:false,error:'This workspace changed in another view. Your unsaved input is still here; export it before reloading.'};
  if(!confirmedProgression(state))mergeRewardLedger(state,prior);
  if(state.rewards)preserveRewardUnlocks(state,todayYmd());
  const result=await durableStore.engine.write(state,{...options,expectedRevision:prior.revision||0,expectedGeneration:prior.rewardGeneration,allowSourceRemoval:replacing||!!options.allowSourceRemoval});
  if(result.ok){if(result.duplicateDelivery&&result.state)replaceState(state,result.state);durableStore.cache=JSON.parse(JSON.stringify(state));result.snapshotSafe=true;}
  return result;
};
store.writeClaims = function(state){return durableStore.active?this.write(state):legacyWriteClaims(state);};

function localImportNeedsRecovery(counts,snapshots,date){
  return !!(counts.added||counts.clash||counts.ambiguous) || !(snapshots||[]).some(sn=>ymd(new Date(sn.at))===date);
}
function localImportEstimateUnits(next,current,snapshots,needsRecovery=true){
  return 2*(JSON.stringify(next).length+(needsRecovery?JSON.stringify(current).length:0)+(snapshots||[]).reduce((sum,sn)=>sum+String(sn.raw||'').length+25,0));
}
/* Parse any candidate record (snapshot, quarantine, mirror) without touching the store. */
function parseRecord(raw){
  let parsed; try { parsed = JSON.parse(raw); } catch(e){ return { ok:false, error:'not valid JSON' }; }
  const problem = validateState(parsed); if (problem) return { ok:false, error: problem };
  return { ok:true, state: migrateTo(parsed) };
}

/* ---- export and restore ---- */
function exportBundle(state, opts){
  const data = JSON.parse(JSON.stringify(state));
  if (!(opts && opts.includePhoto)) data.avatar = null;                 // a photo leaves only when asked
  return { format: EXPORT_FORMAT, schema: SCHEMA, build: BUILD, exportedAt: nowIso(), data,...(syntheticPreviewData(data)?{syntheticPreview:true}:{}) };
}
function parseBundle(text,options={}){
  let obj;
  try { obj = JSON.parse(text); }
  catch(e){ return { ok:false, error:'That file is not valid JSON.' }; }
  if (!obj || obj.format !== EXPORT_FORMAT) return { ok:false, error:'That file is not a Health Tracker export.' };
  if((syntheticPreviewData(obj)||syntheticPreviewData(obj.data))&&options.targetState?.syntheticWorkspace!==true)return {ok:false,error:'Synthetic walkthrough exports cannot be imported into a personal record.'};
  if (typeof obj.schema !== 'number' || obj.schema > SCHEMA) return { ok:false, error:'That export is version ' + obj.schema + '; this build reads up to version ' + SCHEMA + '.' };
  const problem = validateState(obj.data);
  if (problem) return { ok:false, error:'That export was refused: ' + problem };
  if(options.targetState?.syntheticWorkspace===true)obj.data.syntheticWorkspace=true;
  migrateTo(obj.data);
  return { ok:true, bundle: obj };
}
function summarizeState(s){
  return { series: s.series.length, occurrences: Object.keys(s.occurrences).length, workouts: s.workouts.length, reviews: s.reviews.length,
    sourceRecords:(s.sourceRecords||[]).length,importReceipts:(s.importReceipts||[]).length,observations: Object.keys(s.observations || {}).length, profile: !!s.profile, foods: (s.foods || []).length, groups: (s.groups || []).length, goals: (s.goals || []).length };
}
const later = (a, b) => String(a || '') > String(b || '');
/* Union by identity. On a clash the record touched most recently wins.
   Importing the same file twice therefore changes nothing the second time. */
/* What a merge would do, before it does it: additions and clashes, so the
   user reviews them. A clash is a record that exists on both sides with
   different content; the newer one wins on merge, the other is not lost
   from the file the user still holds. */
function familyMergeConflicts(cur, inc){
  const conflicts = [];
  for (const s of inc.series){
    const mine = cur.series.find(x => x.id === s.id); if (!mine) continue;
    if ((s.parentId || null) !== (mine.parentId || null)) conflicts.push(s.id);
    for (const v of s.versions){
      const existing = mine.versions.find(x => x.version === v.version && x.effectiveFrom === v.effectiveFrom);
      if (existing && (v.childIds || existing.childIds) && JSON.stringify(v.childIds || null) !== JSON.stringify(existing.childIds || null)) conflicts.push(s.id + ' version ' + v.version);
    }
  }
  return conflicts;
}
function previewMerge(cur, inc){
  inc = migrateTo(JSON.parse(JSON.stringify(inc)));
  const out = { add: { series:0, versions:0, occurrences:0, workouts:0, reviews:0, observations:0, profile:0, foods:0, groups:0 }, clash: [] };
  if(cur.syntheticWorkspace!==true&&syntheticPreviewData(inc)){out.blocked='Synthetic walkthrough records cannot be merged into a personal record.';return out;}
  const rewardConflicts=rewardMergeConflicts(cur,inc);
  if(rewardConflicts.length)out.blocked='Conflicting point corrections need review. Both copies remain unchanged: '+rewardConflicts.join(', ');
  const familyConflicts = familyMergeConflicts(cur,inc);
  if (familyConflicts.length) out.blocked = 'These family definitions differ at the same version: ' + familyConflicts.join(', ') + '. Merge is paused so no child tasks disappear. Keep the export and reconcile the family definitions, or deliberately replace the complete workspace.';
  out.add.claims = Object.keys(inc.rewards.claims).filter(id => !(cur.rewards && cur.rewards.claims[id])).length;
  out.add.importReceipts = inc.importReceipts.filter(r => !(cur.importReceipts || []).some(x => x.id === r.id)).length;
  out.add.notes = 0;
  for (const n of inc.notes){
    const mine = (cur.notes || []).find(x => x.id === n.id);
    if (!mine) out.add.notes++;
    else if (JSON.stringify(mine) !== JSON.stringify(n)) out.clash.push({kind:'improvement note',key:n.id,keeps:noteChangedAt(n) > noteChangedAt(mine) ? 'file' : 'here'});
  }
  out.add.feedbackDrafts = 0;
  for (const d of inc.feedbackDrafts){
    const mine = (cur.feedbackDrafts || []).find(x => x.id === d.id);
    if (!mine) out.add.feedbackDrafts++;
    else if (JSON.stringify(mine) !== JSON.stringify(d)) out.clash.push({kind:'card feedback draft',key:d.id,keeps:newerFeedbackDraft(d,mine) ? 'file' : 'here'});
  }
  out.add.sourceRecords = 0;
  for (const incoming of inc.sourceRecords){
    const mine = (cur.sourceRecords || []).find(r => r.id === incoming.id);
    if (!mine) { out.add.sourceRecords++; continue; }
    if (relaySignature(mine) !== relaySignature(incoming) && !relayReviewedSignature(mine,relaySignature(incoming))) out.clash.push({kind:'source record (incoming copy retained for review)',key:incoming.id,keeps:'here'});
  }
  const currentGrades = cur.grades || defaultGradeSettings();
  if (JSON.stringify(currentGrades) !== JSON.stringify(inc.grades)) out.clash.push({kind:'category importance and inclusion',key:'settings',keeps:later(inc.grades.updatedAt,currentGrades.updatedAt)?'file':'here'});
  if (cur.rewards && JSON.stringify(cur.rewards.progression) !== JSON.stringify(inc.rewards.progression)) out.clash.push({kind:'progression rule (active milestone preserved)',key:'settings',keeps:'here'});
  if (typeof journalMergePreview === 'function'){ const j = journalMergePreview(cur,inc); out.add.journal = j.add; out.clash.push(...j.clash); }
  for (const g of inc.groups){
    const mine = (cur.groups || []).find(x => x.id === g.id);
    if (!mine) out.add.groups++;
    else if (JSON.stringify(mine) !== JSON.stringify(g)) out.clash.push({ kind:'group', key:g.id, keeps: later(g.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  for (const f of inc.foods){
    const mine = (cur.foods || []).find(x => x.id === f.id);
    if (!mine) out.add.foods++;
    else if (JSON.stringify(mine) !== JSON.stringify(f)) out.clash.push({ kind:'food entry', key:f.id, keeps: later(f.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  for (const s of inc.series){
    const mine = cur.series.find(x => x.id === s.id);
    if (!mine){ out.add.series++; continue; }
    for (const v of s.versions){ if (!mine.versions.some(x => x.version === v.version && x.effectiveFrom === v.effectiveFrom)) out.add.versions++; }
  }
  for (const [k, o] of Object.entries(inc.occurrences)){
    const mine = cur.occurrences[k];
    if (!mine) out.add.occurrences++;
    else if (JSON.stringify(mine) !== JSON.stringify(o)) out.clash.push({ kind:'day record', key:k, keeps: later(o.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  for (const w of inc.workouts){
    const mine = cur.workouts.find(x => x.id === w.id);
    if (!mine) out.add.workouts++;
    else if (JSON.stringify(mine) !== JSON.stringify(w)) out.clash.push({ kind:'workout', key:w.id, keeps: later(w.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  for (const r of inc.reviews){
    const mine = cur.reviews.find(x => x.periodStart === r.periodStart);
    if (!mine) out.add.reviews++;
    else if (JSON.stringify(mine) !== JSON.stringify(r)) out.clash.push({ kind:'review', key:r.periodStart, keeps: later(r.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  for (const [k, o] of Object.entries(inc.observations)){
    const mine = (cur.observations || {})[k];
    if (!mine) out.add.observations++;
    else if (JSON.stringify(mine) !== JSON.stringify(o)) out.clash.push({ kind:'check-in', key:k, keeps: later(o.updatedAt, mine.updatedAt) ? 'file' : 'here' });
  }
  if (inc.profile){
    if (!cur.profile) out.add.profile = 1;
    else if (JSON.stringify(cur.profile) !== JSON.stringify(inc.profile)) out.clash.push({ kind:'starting point', key:'profile', keeps: later(inc.profile.updatedAt, cur.profile.updatedAt) ? 'file' : 'here' });
  }
  return out;
}
function mergeState(cur, inc){
  if(typeof MealWater!=='undefined'){const probe=JSON.parse(JSON.stringify(cur)),result=MealWater.merge(probe,inc);if(!result.ok)return {error:result.error};}
  sourceProjectionCache.delete(cur);
  const rewardConflicts=rewardMergeConflicts(cur,inc);if(rewardConflicts.length)return {error:'Merge paused: conflicting point corrections. Preserve both exports for review.'};
  const familyConflicts = familyMergeConflicts(cur,inc);
  if (familyConflicts.length) return {error:'Merge paused: conflicting family definitions (' + familyConflicts.join(', ') + '). Current records and the export are unchanged.'};
  for(const key of ['planIdeas','learning']){const incoming=inc[key]||[];cur[key]=cur[key]||[];for(const item of incoming){const mine=cur[key].find(x=>x.id===item.id);if(!mine)cur[key].push(JSON.parse(JSON.stringify(item)));else if(Date.parse(item.at)>Date.parse(mine.at))Object.assign(mine,JSON.parse(JSON.stringify(item)));}}
  migrateTo(cur); inc = migrateTo(JSON.parse(JSON.stringify(inc)));
  const c = { series:0, versions:0, occurrences:0, workouts:0, reviews:0, observations:0, profile:0, foods:0, groups:0 };
  c.claims = Object.keys(inc.rewards.claims).filter(id => !cur.rewards.claims[id]).length;
  mergeRewardLedger(cur,inc);
  c.gradeSettings = 0;
  if (later(inc.grades.updatedAt,cur.grades.updatedAt)){ cur.grades = JSON.parse(JSON.stringify(inc.grades)); c.gradeSettings = 1; }
  c.importReceipts = 0;
  for (const r of inc.importReceipts) if (!cur.importReceipts.some(x => x.id === r.id)){ cur.importReceipts.push(JSON.parse(JSON.stringify(r))); c.importReceipts++; }
  if (typeof mergeJournals === 'function') c.journal = mergeJournals(cur,inc);
  for (const g of inc.groups){
    const i = cur.groups.findIndex(x => x.id === g.id);
    if (i < 0){ cur.groups.push(JSON.parse(JSON.stringify(g))); c.groups++; }
    else if (later(g.updatedAt, cur.groups[i].updatedAt)){ cur.groups[i] = JSON.parse(JSON.stringify(g)); c.groups++; }
  }
  if (Array.isArray(inc.goals) && inc.goals.length && !cur.goals.length) cur.goals = inc.goals.slice();
  for (const [k, r] of Object.entries(inc.reminders || {})){ const mine = cur.reminders[k]; if (!mine || later(r.updatedAt, mine.updatedAt)) cur.reminders[k] = JSON.parse(JSON.stringify(r)); }
  mergeLegacyWater(cur,inc);
  c.notes = 0;
  for (const n of inc.notes){
    const i = cur.notes.findIndex(x => x.id === n.id);
    if (i < 0){ cur.notes.push(JSON.parse(JSON.stringify(n))); c.notes++; }
    else if (noteChangedAt(n) > noteChangedAt(cur.notes[i])){ cur.notes[i] = JSON.parse(JSON.stringify(n)); c.notes++; }
  }
  c.feedbackDrafts = 0;
  for (const d of inc.feedbackDrafts){
    const i = cur.feedbackDrafts.findIndex(x => x.id === d.id);
    if (i < 0){ cur.feedbackDrafts.push(JSON.parse(JSON.stringify(d))); c.feedbackDrafts++; }
    else if (newerFeedbackDraft(d,cur.feedbackDrafts[i])){ cur.feedbackDrafts[i] = JSON.parse(JSON.stringify(d)); c.feedbackDrafts++; }
  }
  const sourceMerge = mergeRelayRecords(cur,inc); c.sourceRecords = sourceMerge.added; c.sourceConflicts = sourceMerge.clash;
  if (inc.rank && inc.rank.rule && !cur.rank.rule) cur.rank = JSON.parse(JSON.stringify(inc.rank));
  if (inc.avatar && !cur.avatar) cur.avatar = JSON.parse(JSON.stringify(inc.avatar));
  if(typeof MealWater!=='undefined'){const result=MealWater.merge(cur,inc);if(!result.ok)return {error:result.error};c.foods=result.counts.foods;}
  else for(const f of inc.foods){const i=cur.foods.findIndex(x=>x.id===f.id);if(i<0){cur.foods.push(JSON.parse(JSON.stringify(f)));c.foods++;}else if(later(f.updatedAt,cur.foods[i].updatedAt)){cur.foods[i]=JSON.parse(JSON.stringify(f));c.foods++;}}
  for (const s of inc.series){
    const mine = cur.series.find(x => x.id === s.id);
    if (!mine){ cur.series.push(JSON.parse(JSON.stringify(s))); c.series++; continue; }
    for (const v of s.versions){
      if (!mine.versions.some(x => x.version === v.version && x.effectiveFrom === v.effectiveFrom)){ mine.versions.push(JSON.parse(JSON.stringify(v))); c.versions++; }
    }
    if (s.archivedAt && !mine.archivedAt) mine.archivedAt = s.archivedAt;
  }
  for (const [k, o] of Object.entries(inc.occurrences)){
    const mine = cur.occurrences[k];
    if (!mine || later(o.updatedAt, mine.updatedAt)){ cur.occurrences[k] = JSON.parse(JSON.stringify(o)); c.occurrences++; }
  }
  for (const w of inc.workouts){
    const i = cur.workouts.findIndex(x => x.id === w.id);
    if (i < 0){ cur.workouts.push(JSON.parse(JSON.stringify(w))); c.workouts++; }
    else if (later(w.updatedAt, cur.workouts[i].updatedAt)){ cur.workouts[i] = JSON.parse(JSON.stringify(w)); c.workouts++; }
  }
  for (const r of inc.reviews){
    const i = cur.reviews.findIndex(x => x.periodStart === r.periodStart);
    if (i < 0){ cur.reviews.push(JSON.parse(JSON.stringify(r))); c.reviews++; }
    else if (later(r.updatedAt, cur.reviews[i].updatedAt)){ cur.reviews[i] = JSON.parse(JSON.stringify(r)); c.reviews++; }
  }
  for (const [k, o] of Object.entries(inc.observations)){
    const mine = cur.observations[k];
    if (!mine || later(o.updatedAt, mine.updatedAt)){ cur.observations[k] = JSON.parse(JSON.stringify(o)); c.observations++; }
  }
  if (inc.profile && (!cur.profile || later(inc.profile.updatedAt, cur.profile.updatedAt))){
    cur.profile = JSON.parse(JSON.stringify(inc.profile)); c.profile++;
  }
  cur.seeded = cur.seeded || inc.seeded;
  return c;
}
function replaceState(cur, inc){
  sourceProjectionCache.delete(cur);
  const next = JSON.parse(JSON.stringify(inc));
  for (const k of Object.keys(cur)) delete cur[k];
  Object.assign(cur, next);
  return cur;
}

function freshState(){
  return {
    schema: SCHEMA, revision:0,
    createdAt: nowIso(),
    seeded: false,
    demo: false,
    prefs: { weekStart:1, units:'lb', timezone: tzName(), checkpoint:'2027-01-07', fastingDays: [], theme:'dark', textSize:'normal', quietHours:null },
    series: [],
    occurrences: {},
    workouts: [],
    reviews: [],
    profile: null,
    observations: {},
    foods: [],
    groups: DEFAULT_GROUPS.map(g => Object.assign({ hidden:false, custom:false }, g)),
    goals: [],
    sources: Object.fromEntries(SOURCES.map(x => [x.id, { state:'unverified', lastSample:null, retrievedAt:null, note:'' }])),
    reminders: {},
    hydration: {},
    notes: [], planIdeas:[], learning:[],
    feedbackDrafts: [],
    rank: { rule:null, weights:{} },
    grades: defaultGradeSettings(),
    rewards: emptyRewards(),
    rewardGeneration: newId('store'),
    journal: {},
    importReceipts: [],
    avatar: null,
    sourceRecords: [],
  };
}

/* Wholly invented starter routine. Proposed examples, not prescriptions. */
function seedDemo(){
  const mk = (id, category, anchor, order, name, win, normal, minimum, days) => ({
    id, category, demo:true, archivedAt:null,
    versions: [{
      version:1, effectiveFrom:'2000-01-01', name, anchor, order, window:win,
      recurrence:{ kind:'weekly', days }, normal, minimum,
    }],
  });
  const all = [0,1,2,3,4,5,6];
  return [
    mk('hygiene','routine','morning',1,'Basic hygiene','',
       {label:'Teeth, face, and a shower', minutes:null},
       {label:'Teeth', minutes:null}, all),
    mk('daylight','movement','morning',2,'Daylight','',
       {label:'Ten minutes outside', minutes:10},
       {label:'Two minutes at a window', minutes:2}, all),
    mk('movement','movement','morning',3,'Easy movement','',
       {label:'Ten to fifteen minutes', minutes:12},
       {label:'A five-minute walk', minutes:5}, [1,2,3,4,5,6]),
    mk('meal','eating','midday',1,'A regular meal','',
       {label:'Sit down and eat properly', minutes:null},
       {label:'Something, roughly on time', minutes:null}, all),
    mk('groceries','household','midday',2,'Groceries','',
       {label:'The full list', minutes:null},
       {label:'Just the next few days', minutes:null}, [6]),
    mk('mealprep','eating','midday',3,'Meal prep','',
       {label:'Two or three meals ahead', minutes:60},
       {label:'One thing, cooked', minutes:20}, [0]),
    mk('dinner','eating','evening',1,'Dinner','around 6pm',
       {label:'Cooked, around six', minutes:null},
       {label:'Whatever is easiest', minutes:null}, all),
    mk('laundry','household','evening',2,'Laundry','',
       {label:'Wash, dry, and put away', minutes:null},
       {label:'One load started', minutes:null}, [0]),
    mk('winddown','sleep','night',1,'Quiet wind-down','from 10:30pm',
       {label:'Half an hour of quiet', minutes:30},
       {label:'Ten quiet minutes', minutes:10}, all),
  ];
}

/* Invented preview only. The caller supplies its clock so history and date
   boundaries can be checked without touching any saved workspace. */
function syntheticPreviewState(prefs, endDay, spanDays){
  const d = freshState(), days = spanDays || 90, firstDay = addDays(endDay, 1-days);
  d.syntheticWorkspace=true;
  activateConfirmedProgression(d,firstDay);
  d.seeded = true; d.demo = true; d.series = seedDemo();
  d.prefs = Object.assign({}, d.prefs, prefs || {});
  d.goals = ['Build consistent habits', 'Notice what helps'];
  for (const parentId of ['hygiene','daylight','movement']){
    const specs = parentId === 'hygiene' ? ['Brush teeth','Wash face','Shower'] : parentId === 'daylight' ? ['Step outside','Notice the daylight'] : ['Choose an easy movement','Move at a comfortable pace'];
    convertToFamily(d,parentId,specs.map((name,i)=>({name,normal:{label:'Choose your own target',minutes:null},minimum:{label:'A small first step',minutes:null},optional:i===2})),firstDay,firstDay);
  }
  for (const [category,name,anchor] of [['faith','A quiet pause','morning'],['work','Focused work','midday'],['interests','Time for a hobby','evening']]){
    createSeries(d,{category,name,anchor,order:1,normal:{label:'A comfortable session',minutes:15},minimum:{label:'One small step',minutes:3},recurrence:{kind:'weekly',days:[0,1,2,3,4,5,6],startDate:firstDay}},firstDay);
  }
  const bases={'A quiet pause':20,'Brush teeth':10,'Wash face':10,'Shower':15,'Step outside':15,'Notice the daylight':0,'Choose an easy movement':0,'Move at a comfortable pace':20,'A regular meal':15,'Focused work':25,'Dinner':15,'Time for a hobby':15,'Wind down':15,'Groceries':15,'Meal prep':20,'Laundry':15};
  for(const series of d.series)for(const v of series.versions){const base=bases[v.name]===undefined?15:bases[v.name];v.scoring={importance:base>=25?3:base>=15?2:1,difficulty:base>=20?2:1,duration:false,reference:30,eligible:base!==0};}
  for (let i=days-1;i>=0;i--){
    const date=addDays(endDay,-i);
    if (i>=46 && i<=49) continue; // a visible gap is unknown, never failure
    flatPlanFor(d,date).forEach((r,j)=>{
      if (r.group === 'interests' && i%9 !== 0) return; // a sparse area remains an honest unknown
      const groups=DEFAULT_GROUPS.findIndex(g=>g.id===r.group), k=(i*3+j+groups*2)%10;
      if (k<5) logOcc(d,r.seriesId,date,'done');
      else if (k===5){ selectVersion(d,r.seriesId,date,'minimum'); logOcc(d,r.seriesId,date,'done'); }
      else if (k===6) logOcc(d,r.seriesId,date,'partial');
      else if (k===7) logOcc(d,r.seriesId,date,'skipped');
    });
    if (i%6===0) addWorkout(d,{date,type:'Invented walk',minutes:20+(i%4)*5,effort:2});
    if (i%4===0) saveObservation(d,date,{sleepAttempt:'22:30',sleepOnset:'23:10',wake:'07:00',energy:['okay','good','low'][i%3],weight:82.4+i*0.01});
    if (i%3===1) addFood(d,{date,time:'12:30',label:'Invented lunch',tag:'main'});
  }
  const inventedRecords=[];
  for (let i=days-1;i>=0;i--){
    const date=addDays(endDay,-i), start=date+'T12:00:00Z';
    inventedRecords.push({kind:'steps',sourceApp:'Synthetic Watch',sourceRecordId:'preview-steps-'+date,type:'daily steps',start,end:null,value:3100+(i*71)%5400,unit:'count'});
    if (i%2===0) inventedRecords.push({kind:'activeEnergy',sourceApp:i===12?'unknown':'Synthetic Watch',sourceRecordId:null,type:'active energy',start,end:null,value:180+(i*13)%230,unit:'kcal'});
    if (i%3===0) inventedRecords.push({kind:'restingHeartRate',sourceApp:'Invented Bevel Preview',sourceRecordId:'preview-rhr-'+date,type:'daily sample',start,end:null,value:58+i%11,unit:'bpm'});
    if (i%7===0) inventedRecords.push({kind:'workout',sourceApp:'Invented iFIT Preview',sourceRecordId:'preview-workout-'+date,type:'walking',start,end:date+'T12:25:00Z',durationSec:1200,value:null,unit:null});
  }
  const inventedPacket={format:RELAY_FORMAT,version:1,source:'invented-preview-only',relayedBy:'local file',retrievedAt:null,window:{from:firstDay,to:endDay},records:inventedRecords};
  importRelay(d,parseRelay(JSON.stringify(inventedPacket),{transport:'local file'}),{transport:'local file',requestedWindow:inventedPacket.window});
  d.profile=setProfile(d,{phase:{id:'1',title:'Invented preview phase',note:'Illustrative only.',checkpoint:addDays(endDay,30)},items:[{area:'demo',status:'proposed',text:'Everything in this workspace is invented.'}],questions:[]});
  d.series.forEach(series=>{ series.demo=false; });
  for (const claim of rewardEligibility(d,endDay)) d.rewards.claims[claim.id]=Object.assign({},claim,{claimedAt:claim.date+'T20:00:00'+(new Date(claim.date+'T20:00:00').getTimezoneOffset()===420?'-07:00':'-08:00'),adjustments:[],syntheticPreview:true});
  saveJournal(d,endDay,{intention:'An invented example: make room for one small step.'});
  d.demo=true;
  for(const record of [...d.workouts,...d.foods])record.syntheticPreview=true;
  return migrateTo(d);
}

/* Seeds exactly once. A returning user with real history is never reseeded,
   even if they have deleted every routine. */
/* An unreadable record is quarantined and the newest valid snapshot takes
   over, with the recovery reported. Only when nothing valid exists does the
   session start blank, read-only, with the bad record still set aside. */
function bootstrap(){
  const r = store.read();
  if (r.transactionalError) return {state:durableStore.stagedState?JSON.parse(JSON.stringify(durableStore.stagedState)):freshState(),error:r.error,readOnly:true};
  if (r.rewardError) return {state:r.state,error:r.error,readOnly:true};
  let recovered = null;
  let state = null;
  if (!r.ok){
    const q = store.quarantine();
    const snap = store.snapshots().map(sn => Object.assign({ parsed: parseRecord(sn.raw) }, sn)).find(sn => sn.parsed.ok);
    if (snap){ state = snap.parsed.state; recovered = { error: r.error, from: snap.at, quarantined: q }; }
    else return { state: freshState(), error: r.error, readOnly: true, quarantined: q };
  } else state = r.state;
  let firstRun = false;
  if (!state){ state = freshState(); firstRun = true; }
  migrateTo(state);
  if (!state.seeded){
    state.seeded = true;
    state.demo = false;
  }
  return { state, error:null, readOnly:false, firstRun, recovered };
}

/* Daily Workspace v1. Dated series and occurrences remain the only action store.
   New behavior is explicit; loading a legacy export never adopts point rules. */
const wsClone = value => JSON.parse(JSON.stringify(value));
const wsHas = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
function leafRows(rows){ return rows.flatMap(row=>row.children?leafRows(row.children):[row]); }
function allRows(rows){ return rows.flatMap(row=>[row,...(row.children?allRows(row.children):[])]); }
function wsEnabled(state){return !!(state.workspace&&state.workspace.version===1);}
function wsEnsure(state){if(!state.workspace)state.workspace={version:1,migrations:[]};if(!Array.isArray(state.workspace.migrations))state.workspace.migrations=[];state.schema=SCHEMA;return state.workspace;}
function parentFor(series,date){const v=versionFor(series,date);return v&&wsHas(v,'parentId')?v.parentId:series.parentId||null;}
function wsGroup(series,date){const v=versionFor(series,date);return v&&v.category?LEGACY_GROUP[v.category]||v.category:groupOf(series);}
function wsKind(series,date){const v=versionFor(series,date);if(!v)return null;if(v.workspaceKind)return v.workspaceKind;const match=v.matching;if(match&&match.kind==='workout'){const t=String(match.type||'').toLowerCase();if(/strength|resistance|weight.training/.test(t))return 'strength';if(/cardio|walk|run|cycl|elliptical|row|swim|hiking/.test(t))return 'cardio';}return null;}
function wsRequired(state,row){const o=state.occurrences[row.key];if(o&&(o.disposition==='rest'||o.disposition==='excused'||o.removed))return false;return (!row.optional&&row.recurrence?.kind!=='target')||!!(o&&(o.committed||o.added||o.status));}
function wsState(state,row,date,options={}){
  const o=state.occurrences[row.key];
  if(o&&(o.disposition==='rest'||o.disposition==='excused'))return 'rest';
  if(!wsRequired(state,row))return 'uncommitted';
  if(date>(options.today||todayYmd()))return 'future';
  if(o&&o.status==='skipped')return 'not-done';
  if(o&&o.status==='partial')return 'partial';
  if(o&&o.status==='done'&&actionConfirmation(state,o).confirmed)return o.completedVersion==='minimum'?'partial':'closed';
  if(o&&(o.status==='tentative'||o.evidenceOnly||o.confirmation?.kind==='source'))return 'pending-evidence';
  if(date===(options.today||todayYmd())&&options.time&&/^\d\d:\d\d$/.test(row.window||'')&&row.window>options.time)return 'future';
  return 'open';
}
function planFor(state,date){
  if(!wsEnabled(state))return legacyPlanFor(state,date);
  const rows=[];
  for(const series of state.series){
    if(series.archivedAt&&series.archivedAt<=date)continue;
    const v=versionFor(series,date);if(!v)continue;
    const o=state.occurrences[occKey(series.id,date)]||null;if(o?.removed)continue;
    if(!scheduledOn(v,date)&&!(o&&(o.added||o.status!==null||o.committed))&&!v.childIds)continue;
    const ov=o?.override||{},variant=recurrenceVariant(v,date),normal=ov.normal||variant?.normal||v.normal,minimum=ov.minimum||variant?.minimum||v.minimum,selected=o?o.selected:'normal';
    rows.push({key:occKey(series.id,date),seriesId:series.id,date,name:ov.name||v.name,category:v.category||series.category,anchor:ov.anchor||v.anchor,window:ov.window!==undefined?ov.window:v.window||'',order:ov.order??v.order,version:v.version,demo:!!series.demo,targets:{normal,minimum},selected,target:selected==='minimum'?minimum:normal,status:o&&o.status==='done'&&confirmedProgression(state)&&!actionConfirmation(state,o).confirmed?'tentative':o?o.status:null,confirmation:o?.aliasOf?'Same action · linked in Log':o?actionConfirmation(state,o).label:'No entry',completedVersion:o?.completedVersion||null,actualMinutes:o?.actualMinutes??null,note:o?.note||'',corrections:o?.corrections?.length||0,added:!!o?.added,addedFrom:o?.addedFrom||null,overridden:!!o?.override,aliasOf:o?.aliasOf||null,optional:!!v.optional,once:v.recurrence?.kind==='once',group:wsGroup(series,date),parentId:wsHas(ov,'parentId')?ov.parentId:parentFor(series,date),childIds:v.childIds||null,session:v.recurrence?.session||'',variant:variant?.label||'',recurrence:v.recurrence,matching:v.matching||null,targetProgress:null,workspaceKind:wsKind(series,date),budgetQ:v.budgetQ??null,occurrence:o});
  }
  const time=r=>/^([01]\d|2[0-3]):[0-5]\d$/.test(r.window||'')?r.window:'99:99';
  const order=(a,b)=>time(a).localeCompare(time(b))||anchorOrder(a.anchor)-anchorOrder(b.anchor)||a.order-b.order||a.seriesId.localeCompare(b.seriesId);
  rows.sort(order);
  const visit=(row,depth)=>{
    const children=rows.filter(r=>r.parentId===row.seriesId);
    if(row.childIds||children.length){row.children=children.map(c=>visit(c,depth+1));row.childIds=children.map(c=>c.seriesId);row.family=familySummary(leafRows(row.children));row.status=row.family.status;row.completedVersion=row.status==='done'?(row.family.minimum?'minimum':'normal'):null;row.isFamily=true;}
    row.depth=depth;return row;
  };
  const projected=rows.filter(r=>!r.parentId||!rows.some(p=>p.seriesId===r.parentId)).map(r=>visit(r,0));
  for(const row of allRows(projected)){row.container=Array.isArray(row.children);row.targetProgress=targetProgress(state,row.seriesId,date);}
  if(typeof QuarterPoints!=='undefined')for(const row of leafRows(projected)){
    let ancestor=row,budget=null;while(ancestor){if(Number.isSafeInteger(ancestor.budgetQ))budget=ancestor;ancestor=rows.find(r=>r.seriesId===ancestor.parentId);}
    if(budget){const pinned=Object.values(state.occurrences).find(o=>o.date===date&&o.quarterRule?.rootId===budget.seriesId)?.quarterRule,leafIds=pinned?.leafIds||leafRows(budget.children||[]).filter(r=>!r.optional).map(r=>r.seriesId),amount=leafIds.length?QuarterPoints.allocateQ(pinned?.budgetQ??budget.budgetQ,leafIds.map(id=>({id}))).find(a=>a.id===row.seriesId)?.amountQ||0:0;row.shareQ=amount;row.shareDisplay=amount/4;row.allocation={amountQ:amount,displayAmount:amount/4,pinned:!!pinned,rootId:budget.seriesId,budgetQ:pinned?.budgetQ??budget.budgetQ};}
  }
  return projected;
}
function validateWorkspaceFamily(state){
  const ids=new Set();
  for(const s of state.series){if(ids.has(s.id))return 'Duplicate action identity.';ids.add(s.id);}
  const dates=[...new Set(state.series.flatMap(s=>s.versions.map(v=>v.effectiveFrom)))].sort();
  for(const date of dates){
    for(const s of state.series){
      const v=versionFor(s,date);if(!v)continue;
      if(!validCalendarDate(v.effectiveFrom)||!Number.isInteger(v.version)||v.version<1)return 'A dated version is malformed.';
      const direct=state.series.filter(child=>versionFor(child,date)&&parentFor(child,date)===s.id);
      if(direct.length&&(!Array.isArray(v.childIds)||direct.some(child=>!v.childIds.includes(child.id))))return 'A dated container is missing child membership.';
      let cursor=s,depth=1;const seen=new Set([s.id]);
      while(parentFor(cursor,date)){
        const parent=state.series.find(p=>p.id===parentFor(cursor,date));
        if(!parent||!versionFor(parent,date))return 'A task has an invalid dated parent.';
        if(seen.has(parent.id))return 'A task hierarchy contains a cycle.';
        if(++depth>3)return 'Only routine, section and leaf depth is supported.';
        seen.add(parent.id);cursor=parent;
      }
      if(v.childIds!==undefined&&(!Array.isArray(v.childIds)||new Set(v.childIds).size!==v.childIds.length||v.childIds.some(id=>!state.series.some(c=>c.id===id&&parentFor(c,date)===s.id))))return 'A family has invalid dated children.';
      if(v.budgetQ!==undefined&&(!Number.isSafeInteger(v.budgetQ)||v.budgetQ<0))return 'A routine budget is malformed.';
      if(v.workspaceKind!==undefined&&typeof v.workspaceKind!=='string')return 'An action kind is malformed.';
      if(v.deadlineDay!==undefined&&(!Number.isInteger(v.deadlineDay)||v.deadlineDay<0||v.deadlineDay>6))return 'A deadline is malformed.';
      const r=v.recurrence||{};
      if(r.kind==='once'&&!validCalendarDate(r.date))return 'A one-off date is malformed.';
      if(r.endDate!==undefined&&(!validCalendarDate(r.endDate)||r.startDate&&r.endDate<r.startDate))return 'An end date is malformed.';
      if(r.kind==='target'&&(!Number.isInteger(r.count)||r.count<1||r.count>100||!Number.isInteger(r.weeks)||r.weeks<1||r.weeks>52||!['fixed','rolling'].includes(r.mode)||!validCalendarDate(r.startDate)))return 'A multiweek target is malformed.';
      if(r.kind!=='once'&&(!Array.isArray(r.days)||r.days.some(d=>!Number.isInteger(d)||d<0||d>6)))return 'A flexible schedule has invalid days.';
    }
  }
  if(state.journal&&Object.entries(state.journal).some(([d,e])=>!validCalendarDate(d)||!e||e.date!==d||['intention','reflection','feedback'].some(k=>typeof e[k]!=='string')))return 'A journal entry is malformed.';
  return null;
}
function wsTransaction(state,change){
  const draft=wsClone(state);wsEnsure(draft);
  try{const result=change(draft);if(result?.ok===false)return result;const error=validateState(draft);if(error)return {ok:false,error};replaceState(state,draft);return result&&result.ok!==undefined?result:{ok:true,record:result||null};}
  catch(error){return {ok:false,error:error.message};}
}
function wsRevise(state,id,changes,date){
  const series=state.series.find(s=>s.id===id),base=series&&versionFor(series,date);if(!base)throw new Error('Choose an existing activity on this date.');
  const version=versionFrom({...base,...changes},latestVersion(series).version+1,date);series.versions.push(version);return version;
}
function wsCreate(state,fields,date,parentId=null){
  if(!validCalendarDate(date)||!String(fields.name||'').trim())throw new Error('Enter a name and a valid date.');
  const id=fields.id||fields.requestId;
  const requestSignature=wsSignature([fields,parentId,date]);
  if(id){const existing=state.series.find(s=>s.id===id);if(existing){if(existing.workspaceRequestSignature!==requestSignature)throw new Error('This activity ID already represents a different request.');return existing;}if(typeof id!=='string'||!id||id.includes('|'))throw new Error('Invalid activity identity.');}
  const parent=parentId&&state.series.find(s=>s.id===parentId),pv=parent&&versionFor(parent,date);
  if(parentId&&!pv)throw new Error('Choose a parent present on this date.');
  if(parent&&Object.values(state.occurrences).some(o=>o.seriesId===parent.id&&o.date>=date&&o.status))throw new Error('This parent has recorded actions. Review an explicit history mapping before converting it.');
  const defaults={category:parent?wsGroup(parent,date):'care',normal:{label:'Complete',minutes:null},minimum:{label:'Small version',minutes:null},recurrence:{kind:'once',date},anchor:pv?.anchor||'midday'};
  const clean={...defaults,...fields,parentId,category:fields.category||defaults.category};
  if(fields.kind==='container'||fields.container)clean.childIds=[];
  const series=createSeries(state,clean,date);if(id)series.id=id;series.workspaceRequestSignature=requestSignature;
  if(parent){const ids=[...new Set([...(versionFor(parent,date).childIds||[]),series.id])];wsRevise(state,parent.id,{childIds:ids},date);wsSyncMembership(state,[parent.id],date);}
  return series;
}
function wsEdit(state,id,changes,date,options={}){
  if(!validCalendarDate(date))throw new Error('Choose a valid effective date.');
  const series=state.series.find(s=>s.id===id);if(!series)throw new Error('Activity no longer exists.');
  if(changes.name!==undefined&&!String(changes.name).trim())throw new Error('Enter an activity name.');
  if(options.scope==='occurrence'||options.scope==='this-day'){if(['parentId','childIds','category','recurrence','budgetQ'].some(key=>wsHas(changes,key)))throw new Error('This structural change needs a dated series version.');const allowed={};for(const key of ['name','anchor','window','order','normal','minimum'])if(wsHas(changes,key))allowed[key]=['normal','minimum'].includes(key)?target(changes[key]):changes[key];return overrideOcc(state,id,date,allowed);}
  if(wsHas(changes,'parentId')){wsMove(state,id,changes.parentId,date);changes={...changes};delete changes.parentId;}
  return wsRevise(state,id,changes,date);
}
function wsMove(state,id,parentId,date){
  const series=state.series.find(s=>s.id===id);if(!series||!validCalendarDate(date))throw new Error('Choose an activity and valid date.');
  const old=parentFor(series,date);if(old===parentId)return series;
  if(parentId===id)throw new Error('An activity cannot contain itself.');
  const parent=parentId&&state.series.find(s=>s.id===parentId);if(parentId&&!versionFor(parent||{versions:[]},date))throw new Error('Choose a parent present on this date.');
  if(parent&&Object.values(state.occurrences).some(o=>o.seriesId===parent.id&&o.date>=date&&o.status))throw new Error('Review the parent history before converting it.');
  wsRevise(state,id,{parentId:parentId||null},date);
  if(old){const prior=state.series.find(s=>s.id===old);wsRevise(state,old,{childIds:(versionFor(prior,date).childIds||[]).filter(x=>x!==id)},date);}
  if(parent)wsRevise(state,parent.id,{childIds:[...new Set([...(versionFor(parent,date).childIds||[]),id])]},date);
  wsSyncMembership(state,[old,parentId].filter(Boolean),date);
  return series;
}
function wsSyncMembership(state,parentIds,from){
  const dates=[...new Set([from,...state.series.flatMap(s=>s.versions.filter(v=>v.effectiveFrom>from).map(v=>v.effectiveFrom))])].sort();
  for(const date of dates)for(const id of parentIds){const parent=state.series.find(s=>s.id===id),v=parent&&versionFor(parent,date);if(!v)continue;const ids=state.series.filter(s=>versionFor(s,date)&&parentFor(s,date)===id).map(s=>s.id);if(JSON.stringify((v.childIds||[]).slice().sort())!==JSON.stringify(ids.slice().sort()))wsRevise(state,id,{childIds:ids},date);}
}

/* A daily step total and a brushing minute are Health Auto Export's own figures, not rows the
   workspace stores: the total is re-derived from the day's buckets on every projection. Evidence
   lookups therefore see the current projection as well as stored rows. (Mintay, 2026-09-23) */
const WS_NIGHT_HOUR=15;
function sourceLocalHour(instant){const zone=/([+-])(\d{2}):(\d{2})$/.exec(instant),offset=zone?(zone[1]==='-'?-1:1)*(Number(zone[2])*60+Number(zone[3])):0;return new Date(Date.parse(instant)+offset*60000).getUTCHours();}
function wsProjectedRecord(state,id){const projected=sourceProjection(state);return projected?projected.records.find(r=>r.id===id)||null:null;}
function wsSourceRecord(state,id){return (state.sourceRecords||[]).find(r=>r.id===id)||wsProjectedRecord(state,id);}
function wsEvidenceCandidates(state,v,date){
  const stored=state.sourceRecords||[],kind=v?.matching?.kind;if(kind!=='steps'&&kind!=='sleep')return stored;
  const projected=sourceProjection(state);if(!projected)return stored;
  return stored.concat(projected.records.filter(r=>r.kind===kind&&r.unmapped?.healthAutoExport?.representation==='derived daily view'&&r.unmapped.healthAutoExport.day===date));
}
/* Any app that records a workout counts (Mintay, 2026-09-23): the Watch, iFIT, a strength app.
   The type decides cardio or strength; a type the rules do not know — softball, say — waits for
   Mintay to choose once, and that choice applies to every later workout of the same type. */
function wsWorkoutTypeKey(record){return String(record?.type||'').trim().toLowerCase().replace(/\s+/g,' ');}
function wsWorkoutClass(state,record){
  const chosen=state.prefs?.workoutTypes?.[wsWorkoutTypeKey(record)];if(['cardio','strength','other'].includes(chosen))return chosen;
  const type=wsWorkoutTypeKey(record);
  if(/strength|resistance|weight|functional|core training|crossfit|pilates|barre/.test(type))return 'strength';
  if(/cardio|walk|run|cycl|bik|elliptical|row|swim|hik|stair|step training|aerobic|dance|hiit|high.intensity|kickbox|boxing|jump rope|treadmill|spin/.test(type))return 'cardio';
  return null;
}
function wsEvidenceFingerprint(record){if(record?.origin==='derived'&&record.unmapped?.healthAutoExport?.representation==='derived daily view')return JSON.stringify(['derived',record.id]);return JSON.stringify([evidenceFingerprint(record),record.sourceApp||null,record.device||null,record.sourceRecordId||null,record.unmapped?.starter?.duration_sec??record.unmapped?.reportedDurationExactSec??record.unmapped?.workoutDurationExactSec??null,record.unmapped?.starter?.source_name??null,record.unmapped?.healthAutoExport?.originalWriter??null]);}
function wsExactMinutes(record){const original=record.unmapped?.starter?.duration_sec??record.unmapped?.reportedDurationExactSec??record.unmapped?.workoutDurationExactSec;const sec=typeof original==='number'?original:record.durationSec;return Number.isFinite(sec)&&sec>=0?sec/60:null;}
function wsWatch(record){return /apple\s*watch|watch\d|watchos/i.test([record.device,record.sourceApp,record.unmapped?.healthAutoExport?.originalWriter,record.unmapped?.starter?.source_name].filter(Boolean).join(' '));}
function wsEvidenceProblem(state,record,series,date){
  const v=versionFor(series,date),kind=wsKind(series,date),policy=v?.matching;
  if(!v||v.childIds)return 'Choose an independently recorded leaf.';
  const hae=record.unmapped?.healthAutoExport;
  if(policy?.kind==='steps'&&record.kind==='steps'&&hae?.representation==='derived daily view'){
    if(!wsProjectedRecord(state,record.id))return 'This daily total is no longer current; review the source.';
    if(syntheticPreviewData(record)&&state.syntheticWorkspace!==true)return 'This source is held, shadowed or unsupported.';
    if(sourceLocalDay(record.start)!==date)return 'The source-local date differs from this action.';
    if(!(policy.minimum>0)||!Number.isFinite(record.value)||record.value<policy.minimum)return 'The evidence does not establish the step target.';
    return null;
  }
  if(policy?.kind==='sleep'&&record.kind==='sleep'&&hae?.representation==='derived daily view'){
    if(!wsProjectedRecord(state,record.id))return 'This night is no longer current; review the source.';
    if(syntheticPreviewData(record)&&state.syntheticWorkspace!==true)return 'This source is held, shadowed or unsupported.';
    if(hae.day!==date)return 'This night belongs to another wake day.';
    const need=Math.max(Number(policy.minimum)||0,v.normal?.minutes||0),got=Number.isFinite(record.durationSec)?record.durationSec/60:null;
    if(got===null||got<need)return 'Recorded sleep is below the chosen target.';
    return null;
  }
  if(policy?.kind==='toothbrushing'&&hae?.metric==='toothbrushing'&&hae.representation==='minute aggregate'){
    if(!sourceIsActive(state,record.id,record)||syntheticPreviewData(record)&&state.syntheticWorkspace!==true)return 'This source is held, shadowed or unsupported.';
    if((record.clashes||[]).length)return 'Review the source correction first.';
    if(sourceLocalDay(record.start)!==date)return 'The source-local date differs from this action.';
    if(!(record.value>0))return 'No brushing time was recorded in this minute.';
    const night=['evening','night'].includes(v.anchor),late=sourceLocalHour(record.start)>=WS_NIGHT_HOUR;
    if(night!==late)return night?'This brushing was recorded before 3 pm, so it belongs to the morning routine.':'This brushing was recorded after 3 pm, so it belongs to the night routine.';
    return null;
  }
  if(!sourceEvidenceEligible(state,record))return 'This source is held, shadowed or unsupported.';
  if((record.clashes||[]).length)return 'Review the source correction first.';
  if(sourceLocalDay(record.kind==='sleep'?(record.end||record.start):record.start)!==date)return 'The source-local date differs from this action.';
  if(record.unmapped?.healthAutoExport?.representation==='minute aggregate')return 'Minute buckets do not establish this action.';
  if(kind==='cardio'||kind==='strength'){
    if(record.kind!=='workout')return 'Only typed workout evidence supplies workout minutes.';
    const cls=wsWorkoutClass(state,record);
    if(cls===null)return 'Choose whether this workout is cardio or strength.';
    if(cls==='other')return 'You marked this workout type as neither cardio nor strength.';
    if(cls!==kind)return 'The workout type does not match this activity.';
    if(!record.sourceApp?.trim()||String(record.sourceApp).toLowerCase()==='unknown')return 'The original workout writer is unavailable.';
    if(wsExactMinutes(record)===null||wsExactMinutes(record)<=0)return 'A positive exact reported duration is unavailable.';
    if(record.end&&record.unmapped?.healthAutoExport?.timestampPrecision!=='minute'&&wsExactMinutes(record)>(Date.parse(record.end)-Date.parse(record.start))/60000+1e-8)return 'Workout duration exceeds the recorded interval; review the source.';
  }else{
    if(!policy||!['steps','sleep','toothbrushing'].includes(policy.kind))return 'This activity has no supported source evidence rule.';
    if(record.kind!==policy.kind)return 'The source kind differs from the activity rule.';
    if(policy.kind==='steps'&&(!(policy.minimum>0)||!Number.isFinite(record.value)||record.value<policy.minimum))return 'The evidence does not establish the step target.';
    if(policy.kind!=='steps'&&(wsExactMinutes(record)===null||wsExactMinutes(record)<Math.max(Number(policy.minimum)||0,v.normal?.minutes||0)))return 'The evidence does not establish the chosen target.';
  }
  return null;
}
function wsEvidencePreview(state,id,date){
  const series=state.series.find(s=>s.id===id),v=series&&versionFor(series,date);if(!v||(!scheduledOn(v,date)&&!state.occurrences[occKey(id,date)]?.added))return {ok:false,error:'Choose an activity available on this date; saved end dates are retained.'};
  const o=state.occurrences[occKey(id,date)],eventId=o?rewardIdentity(state,o):occKey(id,date),records=[];
  for(const record of wsEvidenceCandidates(state,v,date)){
    const derivedDay=record.unmapped?.healthAutoExport?.representation==='derived daily view'?record.unmapped.healthAutoExport.day:null;
    if((derivedDay||sourceLocalDay(record.kind==='sleep'?(record.end||record.start):record.start))!==date)continue;
    let problem=wsEvidenceProblem(state,record,series,date);
    const used=Object.values(state.rewards.evidence).find(e=>!e.retractedAt&&e.eventId!==eventId&&(e.sourceId===record.id||e.fingerprint===evidenceFingerprint(record)||evidenceOverlaps(record,wsSourceRecord(state,e.sourceId))));
    if(used)problem='This evidence already belongs to another action.';
    records.push({id:record.id,sourceId:record.id,type:record.type||record.kind,writer:record.sourceApp||'unknown',minutes:wsExactMinutes(record),eligible:!problem,problem,confirmed:!!(state.rewards.evidence[record.id]&&!state.rewards.evidence[record.id].retractedAt&&state.rewards.evidence[record.id].eventId===eventId),record});
  }
  return {ok:true,seriesId:id,date,eventId,records,eligible:records.filter(r=>r.eligible),pending:records.filter(r=>!r.eligible),target:v.normal?.minutes||null,minimum:v.minimum?.minutes||null};
}
function wsEvidenceQuantity(state,id,date){
  const o=state.occurrences[occKey(id,date)],series=state.series.find(s=>s.id===id);if(!o||!series)return {minutes:0,sourceIds:[],pending:false};
  const records=[],sourceIds=[];let pending=false;
  for(const evidence of Object.values(state.rewards.evidence)){
    if(evidence.eventId!==rewardIdentity(state,o)||evidence.retractedAt)continue;
    const record=wsSourceRecord(state,evidence.sourceId);
    if(!record||evidence.fingerprint!==(evidence.ruleVersion===4?wsEvidenceFingerprint(record):evidenceFingerprint(record))||wsEvidenceProblem(state,record,series,date)){pending=true;continue;}
    if(records.some(r=>r.id===record.id||evidenceFingerprint(r)===evidenceFingerprint(record)||evidenceOverlaps(r,record))){pending=true;continue;}
    records.push(record);sourceIds.push(record.id);
  }
  return {minutes:records.reduce((sum,r)=>sum+(wsExactMinutes(r)||0),0),sourceIds,pending};
}
function wsConfirmEvidence(state,id,date,sourceIds){return wsTransaction(state,draft=>wsConfirmEvidenceIn(draft,id,date,sourceIds));}
function wsConfirmEvidenceIn(draft,id,date,sourceIds,options={}){
  if(date>todayYmd()||!validCalendarDate(date))return {ok:false,error:'Evidence can confirm only a lived date.'};
  if(!Array.isArray(sourceIds)||!sourceIds.length||new Set(sourceIds).size!==sourceIds.length)return {ok:false,error:'Select each source record once.'};
  {
    const preview=wsEvidencePreview(draft,id,date);if(!preview.ok)return preview;
    const selected=sourceIds.map(sourceId=>preview.records.find(r=>r.id===sourceId));
    if(selected.some(r=>!r||!r.eligible))return {ok:false,error:selected.find(r=>r&&!r.eligible)?.problem||'A selected source record is unavailable.'};
    for(let i=0;i<selected.length;i++)for(let j=0;j<i;j++)if(evidenceOverlaps(selected[i].record,selected[j].record)||evidenceFingerprint(selected[i].record)===evidenceFingerprint(selected[j].record))return {ok:false,error:'Overlapping or duplicate workouts need reconciliation before aggregation.'};
    const series=draft.series.find(s=>s.id===id),v=versionFor(series,date),kind=wsKind(series,date),o=ensureOcc(draft,id,date),at=nowIso();
    const active=Object.values(draft.rewards.evidence).filter(e=>e.eventId===rewardIdentity(draft,o)&&!e.retractedAt);
    if(o.status==='done'&&o.confirmation?.kind==='source'&&active.length===selected.length&&selected.every(r=>active.some(e=>e.sourceId===r.id&&e.ruleVersion===4&&e.fingerprint===wsEvidenceFingerprint(r.record))))return {ok:true,same:true,record:o,occurrence:o};
    const before=snapshot(o);
    o.committed=true;o.evidenceOnly=true;o.status='done';o.confirmation={kind:'source',at,sourceIds:sourceIds.slice(),...(options.auto?{auto:true}:{})};o.completedVersion='normal';o.loggedAt=at;if(!options.auto)delete o.autoDeclined;
    for(const old of Object.values(draft.rewards.evidence))if(old.eventId===preview.eventId&&!sourceIds.includes(old.sourceId)&&!old.retractedAt){old.retractedAt=at;old.updatedAt=at;}
    for(const chosen of selected){if(draft.syntheticWorkspace===true){chosen.record.syntheticPreview=true;o.syntheticPreview=true;}const old=draft.rewards.evidence[chosen.id],history=old?[...(old.history||[]),{fingerprint:old.fingerprint,eventId:old.eventId,acceptedAt:old.acceptedAt,retractedAt:old.retractedAt,updatedAt:old.updatedAt}]:[];draft.rewards.evidence[chosen.id]={sourceId:chosen.id,eventId:rewardIdentity(draft,o),fingerprint:wsEvidenceFingerprint(chosen.record),seriesId:id,date,acceptedAt:at,updatedAt:at,retractedAt:null,ruleVersion:4,history,...(draft.syntheticWorkspace===true?{syntheticPreview:true}:{})};}
    if(kind==='cardio'||kind==='strength'){o.actualMinutes=selected.reduce((sum,r)=>sum+r.minutes,0);o.completedVersion=o.actualMinutes<(v.normal?.minutes||0)?'minimum':'normal';}
    wsPinRule(draft,o);recordCorrection(o,before,at);touch(o);return {ok:true,record:o,occurrence:o};
  }
}
/* Imported evidence now checks off the activity it establishes (Mintay, 2026-09-23): a Watch
   workout confirms Cardio, a strength workout confirms Strength, the day's step total confirms the
   step goal, and a brushing record confirms the brush leaf for its half of the day. Only an
   untouched or tentative entry, or one this pass linked earlier, is ever changed. Anything Mintay
   decided himself — self-confirmed, skipped, partial, rest, or an automatic link he undid — is
   left exactly as he set it. Points still wait for his claim. */
const WS_AUTO_DAYS=7;
function wsAutoEligible(state,series,date){
  const v=versionFor(series,date);if(!v||v.childIds||series.demo||series.archivedAt&&series.archivedAt<=date||!scheduledOn(v,date))return false;
  const kind=wsKind(series,date);if(!(kind==='cardio'||kind==='strength'||['steps','toothbrushing','sleep'].includes(v.matching?.kind)))return false;
  const o=state.occurrences[occKey(series.id,date)];
  if(!o)return true;
  if(o.autoDeclined||o.removed||o.aliasOf||o.disposition||['skipped','partial'].includes(o.status))return false;
  if(o.status==='done')return o.confirmation?.kind==='source'&&o.confirmation.auto===true;
  return true;
}
function wsAutoEvidence(state,options={}){
  const today=options.today||todayYmd(),days=options.days||WS_AUTO_DAYS,changes=[];
  for(let i=days-1;i>=0;i--){
    const date=addDays(today,-i);
    for(const series of state.series.slice()){
      if(!wsAutoEligible(state,series,date))continue;
      const preview=wsEvidencePreview(state,series.id,date);if(!preview.ok)continue;
      // Only the automatic feed links itself; a file imported by hand keeps its reviewed flow.
      const eligible=preview.eligible.filter(r=>r.record.unmapped?.healthAutoExport?.format==='JSON');if(!eligible.length)continue;
      const chosen=[];
      for(const r of eligible.slice().sort((a,b)=>(b.minutes||0)-(a.minutes||0)||Date.parse(a.record.start)-Date.parse(b.record.start)||a.id.localeCompare(b.id)))
        if(!chosen.some(c=>evidenceOverlaps(c.record,r.record)||evidenceFingerprint(c.record)===evidenceFingerprint(r.record)))chosen.push(r);
      chosen.sort((a,b)=>Date.parse(a.record.start)-Date.parse(b.record.start)||a.id.localeCompare(b.id));
      const ids=(['steps','sleep'].includes(versionFor(series,date).matching?.kind)?chosen.slice(-1):chosen).map(r=>r.id);
      const result=wsConfirmEvidenceIn(state,series.id,date,ids,{auto:true});
      if(result.ok&&!result.same)changes.push({seriesId:series.id,date,name:versionFor(series,date).name,sourceIds:ids,minutes:result.occurrence.actualMinutes??null});
    }
  }
  return {ok:true,changes};
}
function wsUnsortedWorkouts(state,options={}){
  const today=options.today||todayYmd(),from=addDays(today,-((options.days||WS_AUTO_DAYS)-1)),seen=new Map();
  for(const r of state.sourceRecords||[]){
    if(r.kind!=='workout'||!sourceEvidenceEligible(state,r)||wsWorkoutClass(state,r)!==null)continue;
    const day=sourceLocalDay(r.start);if(day<from||day>today)continue;
    const key=wsWorkoutTypeKey(r);if(!key)continue;
    const item=seen.get(key)||{key,type:r.type,count:0,latest:null,minutes:0};item.count++;item.minutes+=wsExactMinutes(r)||0;item.latest=!item.latest||r.start>item.latest?r.start:item.latest;seen.set(key,item);
  }
  return [...seen.values()].sort((a,b)=>String(b.latest).localeCompare(String(a.latest)));
}
function wsClassifyWorkout(draft,key,cls){
  if(!['cardio','strength','other'].includes(cls)||typeof key!=='string'||!key.trim())return {ok:false,error:'Choose cardio, strength or neither.'};
  draft.prefs=draft.prefs||{};draft.prefs.workoutTypes={...(draft.prefs.workoutTypes||{}),[key.trim().toLowerCase()]:cls};
  return {ok:true,record:{key,cls}};
}
function wsDeclineAuto(draft,id,date){
  const o=draft.occurrences[occKey(id,date)];
  if(!o||o.status!=='done'||o.confirmation?.kind!=='source'||o.confirmation.auto!==true)return {ok:false,error:'Only an entry checked off automatically can be unlinked here.'};
  const eventId=rewardIdentity(draft,o);
  if(Object.values(draft.rewards.claims).some(c=>c.id===eventId||c.eventId===eventId))return {ok:false,error:'Its points are already claimed. Use Correct in Collection so the ledger stays accurate.'};
  const before=snapshot(o),at=nowIso();
  for(const e of Object.values(draft.rewards.evidence))if(e.eventId===eventId&&!e.retractedAt){e.retractedAt=at;e.updatedAt=at;}
  o.status=null;o.confirmation=null;o.evidenceOnly=false;o.actualMinutes=null;o.committed=false;o.autoDeclined={at};
  recordCorrection(o,before,at);touch(o);return {ok:true,record:o};
}
function wsSlots(state,rows,date,options){
  const count=rows.length,width=count?Math.min(8,270/count):0;
  const decorated=rows.map(row=>{const plannedTime=/^([01]\d|2[0-3]):[0-5]\d$/.test(row.window||'')?row.window:null;return {row,plannedTime,anchor:plannedTime?(Number(plannedTime.slice(0,2))*60+Number(plannedTime.slice(3)))/4:null};});
  const timed=decorated.filter(x=>x.anchor!==null).sort((a,b)=>a.anchor-b.anchor||a.row.seriesId.localeCompare(b.row.seriesId));
  const untimed=decorated.filter(x=>x.anchor===null).sort((a,b)=>anchorOrder(a.row.anchor)-anchorOrder(b.row.anchor)||a.row.order-b.row.order||a.row.seriesId.localeCompare(b.row.seriesId));
  const gap=Math.min(1,count?90/count:1),separation=width+gap,capacity=Math.max(count,Math.floor(360/separation)),step=360/capacity,phase=timed.length?timed[0].anchor%step:0;
  const available=Array.from({length:capacity},(_,i)=>(phase+i*step)%360);
  const distance=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
  [...timed,...untimed].forEach(item=>{
    const desired=item.anchor===null?(untimed.indexOf(item)+.5)*360/Math.max(1,untimed.length):item.anchor;
    let best=0;for(let i=1;i<available.length;i++)if(distance(available[i],desired)<distance(available[best],desired)-1e-8)best=i;
    item.angle=available.splice(best,1)[0];
  });
  return decorated.map(({row,plannedTime,angle})=>{const status=wsState(state,row,date,options),o=state.occurrences[row.key];return {id:row.key,seriesId:row.seriesId,occurrenceKey:row.key,title:row.name,groupId:row.group,state:status,confirmed:status==='closed',plannedTime,period:plannedTime?null:row.anchor||'untimed',angle:angle%360,width,actualTime:o?.loggedAt||null,positionBasis:plannedTime?'approximate planned hour':'untimed list position; not a clock time'};});
}
function wsRings(state,date,options={}){
  const all=flatPlanFor(state,date).filter(r=>!r.demo&&(!options.groupId||r.group===options.groupId));
  const required=all.filter(r=>wsRequired(state,r)),routineRows=required.filter(r=>!['cardio','strength'].includes(r.workspaceKind));
  const slots=wsSlots(state,routineRows,date,options),done=slots.filter(s=>s.confirmed).length;
  const routine={id:'routine',label:'Routine',status:!slots.length?'no-target':done===slots.length?'closed':slots.some(s=>s.state==='pending-evidence')?'pending-evidence':done?'partial':slots.every(s=>s.state==='future')?'future':slots.every(s=>s.state==='not-done')?'not-done':'open',applicable:slots.length>0,closed:slots.length>0&&done===slots.length,value:done,target:slots.length,unit:'leaves',minimum:null,sourceIds:[],actionIds:routineRows.map(r=>r.seriesId),slots};
  const exercise=kind=>{
    const rows=all.filter(r=>r.workspaceKind===kind),committed=rows.filter(r=>wsRequired(state,r)),target=rows.reduce((n,r)=>n+(r.targets.normal?.minutes||0),0),minimum=rows.reduce((n,r)=>n+(r.targets.minimum?.minutes||0),0),quantities=committed.map(r=>wsEvidenceQuantity(state,r.seriesId,date));
    const value=quantities.reduce((n,q)=>n+q.minutes,0),pending=quantities.some(q=>q.pending),full=rows.length>0&&committed.length===rows.length&&target>0&&committed.every((r,i)=>quantities[i].sourceIds.length>0&&!quantities[i].pending&&quantities[i].minutes>=(r.targets.normal?.minutes||Infinity)&&state.occurrences[r.key]?.status==='done');
    const applicable=committed.length>0&&target>0;const rest=rows.some(r=>['rest','excused'].includes(state.occurrences[r.key]?.disposition));
    return {id:kind,label:kind==='cardio'?'Cardio':'Strength',status:!applicable?(rest?'rest':target>0?(date>(options.today||todayYmd())?'future':'open'):rows.length?'uncommitted':'no-target'):date>(options.today||todayYmd())?'future':full?'closed':pending?'pending-evidence':committed.every(r=>state.occurrences[r.key]?.status==='skipped')?'not-done':value>0?'partial':committed.some(r=>state.occurrences[r.key]?.status)?'pending-evidence':'open',applicable,closed:full&&date<=(options.today||todayYmd()),value,target:target||null,unit:'minutes',minimum:minimum||null,sourceIds:quantities.flatMap(q=>q.sourceIds),actionIds:rows.map(r=>r.seriesId),slots:[]};
  };
  const cardio=exercise('cardio'),strength=exercise('strength'),rings=[routine,cardio,strength],applicable=rings.filter(r=>r.applicable).length,closed=rings.filter(r=>r.closed).length;
  const displayedIds=rings.map(r=>r.id),displayedCount=displayedIds.length;
  return {date,routine,cardio,strength,closed,applicable,displayedIds,displayedCount,percent:closed/displayedCount*100,noTargets:rings.every(r=>!(r.target>0))};
}

function quarterProgression(state){return state.rewards?.progression?.rule==='quarter-v1';}
function wsEpoch(state,id){return (state.rewards.epochs||[]).find(e=>e.id===(id||state.rewards.progression.epochId));}
function wsPinRule(state,o){
  if(!quarterProgression(state)||o.quarterRule)return;
  const s=state.series.find(s=>s.id===o.seriesId),v=s&&versionFor(s,o.date);if(!v)return;
  const ancestors=[];let cursor=s;while(parentFor(cursor,o.date)){cursor=state.series.find(p=>p.id===parentFor(cursor,o.date));if(!cursor)break;ancestors.push(cursor);}
  const budget=ancestors.reverse().find(p=>Number.isSafeInteger(versionFor(p,o.date)?.budgetQ));
  const owner=budget||s,rootVersion=versionFor(owner,o.date),siblings=budget?leafRows(planFor(state,o.date)).filter(r=>{let leaf=state.series.find(s=>s.id===r.seriesId);while(leaf){if(leaf.id===budget.id)return true;leaf=state.series.find(s=>s.id===parentFor(leaf,o.date));}return false;}):[];
  const priorBudget=budget&&Object.values(state.occurrences).find(other=>other.date===o.date&&other.quarterRule?.epochId===state.rewards.progression.epochId&&other.quarterRule?.rootId===budget.id)?.quarterRule;
  o.quarterRule={version:4,epochId:state.rewards.progression.epochId,scoring:wsClone(v.scoring||scoringRule({})),kind:wsKind(s,o.date)||'ordinary',recurring:v.recurrence?.kind!=='once',rootId:owner.id,budgetQ:budget?(priorBudget?priorBudget.budgetQ:rootVersion.budgetQ):null,leafIds:budget?(priorBudget?priorBudget.leafIds.slice():siblings.filter(r=>!r.optional).map(r=>r.seriesId).sort()):null,normal:wsClone(v.normal),minimum:wsClone(v.minimum)};
}
function wsChainEvent(state,rootId,date){
  const root=state.series.find(s=>s.id===rootId),v=root&&versionFor(root,date),pinned=Object.values(state.occurrences).find(o=>o.date===date&&o.quarterRule?.rootId===rootId&&o.quarterRule?.leafIds)?.quarterRule;if(!v||!pinned&&root.archivedAt&&root.archivedAt<=date)return 'unscheduled';
  const descendants=series=>{const version=versionFor(series,date);if(!version)return [];const children=state.series.filter(s=>parentFor(s,date)===series.id&&versionFor(s,date));return version.childIds?children.flatMap(descendants):[series];};
  const membership=pinned?pinned.leafIds.map(id=>state.series.find(s=>s.id===id)).filter(Boolean):descendants(root);
  const leaves=membership.filter(s=>{const ver=versionFor(s,date),o=state.occurrences[occKey(s.id,date)];return (!ver.optional||!!(o&&(o.committed||o.added||o.status)))&&(pinned||!(s.archivedAt&&s.archivedAt<=date))&&(scheduledOn(ver,date)||o?.added||o?.committed)&&!(o&&(o.disposition==='rest'||o.disposition==='excused'||o.removed))&&(ver.recurrence?.kind!=='target'||!!(o&&(o.committed||o.added||o.status)));});
  if(!leaves.length)return 'rest';
  const statuses=leaves.map(s=>{const o=state.occurrences[occKey(s.id,date)];if(!o||!o.status)return 'pending';if(o.status==='skipped')return 'miss';if(o.status==='partial'||o.completedVersion==='minimum')return 'partial';if(o.status==='done'&&actionConfirmation(state,o).confirmed)return 'full';return 'pending';});
  if(statuses.every(s=>s==='full'))return 'full';
  if(statuses.some(s=>s==='pending'))return 'pending';
  if(statuses.every(s=>s==='miss'))return 'miss';
  return 'partial';
}
function wsPriorChain(state,rootId,date,epoch){
  const series=state.series.find(s=>s.id===rootId),first=series?.versions.map(v=>v.effectiveFrom).sort()[0];
  let chain={priorFull:0,pending:false};if(!first)return chain;
  const start=first<epoch.effectiveFrom?epoch.effectiveFrom:first;
  const current=versionFor(series,date);
  if(current?.recurrence?.kind==='target'&&current.recurrence.count===1&&current.recurrence.mode!=='rolling'){
    for(let week=weekStartOf(start,1);week<weekStartOf(date,1);week=addDays(week,7)){
      const entries=Object.values(state.occurrences).filter(o=>o.seriesId===rootId&&(o.goalPeriodStart||weekStartOf(o.date,1))===week&&!o.removed&&!o.aliasOf);
      let event='pending';if(entries.some(o=>o.status==='done'&&actionConfirmation(state,o).confirmed))event='full';else if(entries.some(o=>o.status==='partial'))event='partial';else if(entries.some(o=>o.status==='skipped'))event='miss';
      chain=QuarterPoints.chainAdvance(chain,event);
    }
    return chain;
  }
  for(let day=start;day<date;day=addDays(day,1))chain=QuarterPoints.chainAdvance(chain,wsChainEvent(state,rootId,day));
  return chain;
}
function wsQuarterEntitlement(state,o,epochOverride){
  if(typeof QuarterPoints==='undefined')return null;
  const series=state.series.find(s=>s.id===o.seriesId),v=series&&versionFor(series,o.date),epoch=wsEpoch(state,epochOverride||o.quarterRule?.epochId);
  if(!v||!epoch||o.date<epoch.effectiveFrom||series.demo||v.childIds||o.aliasOf||o.removed||o.status!=='done'||!actionConfirmation(state,o).confirmed)return null;
  const id=rewardIdentity(state,o),old=state.rewards.claims[id];if(old&&old.ruleVersion!==4)return null;
  const p=o.quarterRule;if(!p||p.epochId!==epoch.id)return null;
  const rule=scoringRule(p.scoring);if(!rule.eligible)return null;
  const chain=wsPriorChain(state,p.rootId||o.seriesId,o.goalPeriodStart||o.date,epoch);
  let baseQ,bonusQ,allocation=null;
  if(p.budgetQ!==null&&p.budgetQ!==undefined){
    const leaves=(p.leafIds||[]).map(id=>({id}));if(!leaves.some(x=>x.id===o.seriesId)||!leaves.length)return null;
    allocation=QuarterPoints.allocateQ(p.budgetQ,leaves);baseQ=allocation.find(x=>x.id===o.seriesId).amountQ;
    const bonus=QuarterPoints.bonusQ(p.budgetQ,{...chain,recurring:p.recurring});bonusQ=QuarterPoints.allocateQ(bonus,leaves).find(x=>x.id===o.seriesId).amountQ;
    if(wsChainEvent(state,p.rootId,o.date)!=='full')bonusQ=0;
  }else{
    const kind=p.kind;
    if(kind==='cardio'){const quantity=wsEvidenceQuantity(state,o.seriesId,o.date);if(quantity.pending||!quantity.sourceIds.length)return null;baseQ=QuarterPoints.baseQ({kind:'cardio',minutes:quantity.minutes});}
    else if(kind==='strength'){const quantity=wsEvidenceQuantity(state,o.seriesId,o.date);if(quantity.pending||quantity.minutes<(p.normal?.minutes||15)||!quantity.sourceIds.length)return null;baseQ=QuarterPoints.baseQ({importance:rule.importance,difficulty:rule.difficulty});}
    else {if(o.completedVersion==='minimum'&&p.normal?.minutes&&Number(o.actualMinutes)<p.normal.minutes)return null;baseQ=QuarterPoints.baseQ({importance:rule.importance,difficulty:rule.difficulty,sizeNumerator:1,sizeDenominator:kind==='bathroom'?4:1});}
    bonusQ=wsChainEvent(state,p.rootId||o.seriesId,o.date)==='full'?QuarterPoints.bonusQ(baseQ,{...chain,recurring:p.recurring}):0;
  }
  const amount=baseQ+bonusQ;if(!Number.isSafeInteger(amount)||amount<=0)return null;
  return {id,eventId:id,seriesId:o.seriesId,date:o.date,name:v.name,amount,amountQ:amount,displayAmount:amount/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:o.confirmation?.kind==='source'?'import':'manual',evidenceIds:Object.values(state.rewards.evidence).filter(e=>e.eventId===id&&!e.retractedAt).map(e=>e.sourceId),calculation:{baseQ,bonusQ,priorFull:chain.priorFull,pending:chain.pending,recurring:p.recurring,kind:p.kind,rule:wsClone(rule),budgetQ:p.budgetQ,allocation,minutes:p.kind==='cardio'?wsEvidenceQuantity(state,o.seriesId,o.date).minutes:null},disputed:false};
}
function validateQuarterClaim(c,id,rewards){
  if(c.id!==id||c.eventId!==id||c.unit!=='quarter-point'||typeof c.epochId!=='string'||!(rewards.epochs||[]).some(e=>e.id===c.epochId)||!Number.isSafeInteger(c.amount)||c.amount<1||!validCalendarDate(c.date)||typeof c.seriesId!=='string'||typeof c.claimedAt!=='string')return 'A quarter-point claim is malformed.';
  const calc=c.calculation;if(!calc||!Number.isSafeInteger(calc.baseQ)||calc.baseQ<0||!Number.isSafeInteger(calc.bonusQ)||calc.bonusQ<0||calc.baseQ+calc.bonusQ!==c.amount)return 'A quarter-point calculation is malformed.';
  if(!Number.isSafeInteger(calc.priorFull)||calc.priorFull<0||typeof calc.pending!=='boolean'||typeof calc.recurring!=='boolean')return 'A quarter-point chain is malformed.';
  try{
    const maxBonus=QuarterPoints.bonusQ(calc.baseQ,{priorFull:calc.priorFull,pending:calc.pending,recurring:calc.recurring});
    if(calc.budgetQ==null){const expected=calc.kind==='cardio'?QuarterPoints.baseQ({kind:'cardio',minutes:calc.minutes}):QuarterPoints.baseQ({importance:calc.rule.importance,difficulty:calc.rule.difficulty,sizeNumerator:1,sizeDenominator:calc.kind==='bathroom'?4:1});if(expected!==calc.baseQ||calc.bonusQ>maxBonus)return 'A quarter-point award differs from its calculation.';}
    else {if(!Array.isArray(calc.allocation)||calc.allocation.reduce((n,x)=>n+x.amountQ,0)!==calc.budgetQ||calc.allocation.find(x=>x.id===c.seriesId)?.amountQ!==calc.baseQ)return 'A care budget allocation is malformed.';const expected=QuarterPoints.allocateQ(calc.budgetQ,calc.allocation.map(x=>({id:x.id})));if(JSON.stringify(expected)!==JSON.stringify(calc.allocation))return 'A care allocation differs from stable-ID shares.';const budgetBonus=QuarterPoints.bonusQ(calc.budgetQ,{priorFull:calc.priorFull,pending:calc.pending,recurring:calc.recurring});if(calc.bonusQ>QuarterPoints.allocateQ(budgetBonus,calc.allocation.map(x=>({id:x.id}))).find(x=>x.id===c.seriesId).amountQ)return 'A care bonus exceeds its conserved budget.';}
  }catch(error){return 'A quarter-point calculation is unsupported.';}
  const adjustments=c.adjustments||[];if(!Array.isArray(adjustments)||adjustments.some((a,i)=>!a||!Number.isSafeInteger(a.delta)||a.unit!=='quarter-point'||a.epochId!==c.epochId||a.ruleVersion!==4||typeof a.id!=='string'||typeof a.at!=='string'||a.revision!==i+1)||!Number.isSafeInteger(claimBalance(c))||claimBalance(c)<0)return 'A quarter-point correction is malformed.';
  let running=c.amount;
  for(const adjustment of adjustments){
    running+=adjustment.delta;
    if(adjustment.calculation===null){if(running!==0)return 'A zero-entitlement correction is malformed.';}
    else if(!adjustment.calculation||validateQuarterClaim({...c,amount:running,calculation:adjustment.calculation,adjustments:[]},id,rewards))return 'A quarter-point correction differs from its calculation.';
  }
  return null;
}
const wsLegacyConfirmed=confirmedProgression,wsLegacyConfirmation=actionConfirmation,wsLegacyEntitlement=actionEntitlement,wsLegacyRewardLevel=rewardLevel,wsLegacyReport=rewardReport,wsLegacyCorrection=correctionPreview,wsLegacyAdjust=adjustConfirmedClaim,wsLegacyLog=logOcc;
confirmedProgression=function(state){return quarterProgression(state)||wsLegacyConfirmed(state);};
actionConfirmation=function(state,o){
  if(wsEnabled(state)&&o?.confirmation?.kind==='source'&&o.status==='done'){
    const associations=Object.values(state.rewards.evidence).filter(e=>e.eventId===rewardIdentity(state,o)&&!e.retractedAt);
    if(associations.some(e=>e.ruleVersion===4)){
      const series=state.series.find(s=>s.id===o.seriesId),valid=associations.length>0&&associations.every(e=>{const record=wsSourceRecord(state,e.sourceId);return record&&series&&e.fingerprint===(e.ruleVersion===4?wsEvidenceFingerprint(record):evidenceFingerprint(record))&&!wsEvidenceProblem(state,record,series,o.date);});
      return {confirmed:valid&&o.date<=todayYmd(),kind:'source',label:valid?'Source-confirmed':'Evidence changed · review required'};
    }
    const series=state.series.find(s=>s.id===o.seriesId),kind=series&&wsKind(series,o.date);
    if(kind==='cardio'||kind==='strength'){const q=wsEvidenceQuantity(state,o.seriesId,o.date);return {confirmed:o.date<=todayYmd()&&!q.pending&&q.sourceIds.length>0,kind:'source',label:q.pending?'Evidence changed · review required':q.sourceIds.length?'Source-confirmed':'Source evidence unavailable'};}
  }
  return wsLegacyConfirmation(state,o);
};
logOcc=function(state,id,date,status,extra){
  const result=wsLegacyLog(state,id,date,status,extra);
  if(result&&state.syntheticWorkspace===true)result.syntheticPreview=true;
  if(result&&wsEnabled(state)){const series=state.series.find(s=>s.id===id),v=series&&versionFor(series,date);if(v?.recurrence?.kind==='target'&&v.recurrence.count===1&&v.recurrence.mode!=='rolling'){
    if(!state.rewards.claims[result.rewardEventId]&&!result.addedFrom){result.goalPeriodStart=result.goalPeriodStart||weekStartOf(date,1);result.rewardEventId=id+'|week:'+result.goalPeriodStart;}
    result.committed=true;
  }}
  if(result&&quarterProgression(state)&&status==='done')wsPinRule(state,result);return result;
};
actionEntitlement=function(state,o){return quarterProgression(state)?wsQuarterEntitlement(state,o):wsLegacyEntitlement(state,o);};
rewardLevel=function(state,points){if(!quarterProgression(state))return wsLegacyRewardLevel(state,points);const level=QuarterPoints.levelFor(Math.round(points*4));return {...level,within:level.withinQ/4,cost:level.costQ/4,toNext:level.remainingQ/4,nextThreshold:(level.thresholdQ+level.costQ)/4};};
rewardReport=function(state,today){
  if(!quarterProgression(state)){
    const historyClaims=Object.values(state.rewards?.claims||{}).filter(c=>c.ruleVersion===4);
    if(!historyClaims.length)return wsLegacyReport(state,today);
    const filtered={...state,rewards:{...state.rewards,claims:Object.fromEntries(Object.entries(state.rewards.claims).filter(([,c])=>c.ruleVersion!==4))}};
    const report=wsLegacyReport(filtered,today);report.pending=report.pending.filter(e=>!state.rewards.claims[e.id]);return {...report,historyClaims};
  }
  const rewards=state.rewards,epoch=wsEpoch(state),eligible=confirmedEligibility(state,today).filter(e=>e.epochId===epoch.id),byId=new Map(eligible.map(e=>[e.id,e]));
  const claims=Object.values(rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===epoch.id).map(c=>({...c,balance:claimBalance(c),displayAmount:c.amount/4,displayBalance:claimBalance(c)/4,needsReview:(byId.get(c.id)?.amount||0)!==claimBalance(c)}));
  const pending=eligible.filter(e=>!rewards.claims[e.id]),totalQ=claims.reduce((n,c)=>n+claimBalance(c),0),orbs=totalQ/4;
  return {orbs,totalQ,pending,claims,historyClaims:Object.values(rewards.claims).filter(c=>!claims.some(a=>a.id===c.id)),activeEpoch:epoch,daysRecorded:new Set(claims.map(c=>c.date)).size,progression:rewards.progression,quest:{text:REWARD_RULES.questText,done:eligible.some(e=>e.date===today),reward:0},achievements:rewardAchievements(state,orbs,new Set(claims.map(c=>c.date)).size),...rewardLevel(state,orbs)};
};
function wsCorrectionBatch(state,id){
  const selected=state.rewards.claims[id];if(!selected)return null;
  if(selected.ruleVersion!==4)return wsLegacyCorrection(state,id);
  const claims=Object.values(state.rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===selected.epochId),changes=[];
  for(const claim of claims){const entitlement=Object.values(state.occurrences).filter(o=>rewardIdentity(state,o)===claim.id).map(o=>wsQuarterEntitlement(state,o,claim.epochId)).find(Boolean),before=claimBalance(claim),after=entitlement?.amount||0;if(before!==after)changes.push({id:claim.id,date:claim.date,ruleVersion:4,epochId:claim.epochId,before,after,delta:after-before,calculation:entitlement?.calculation||null});}
  const totalQ=claims.reduce((n,c)=>n+claimBalance(c),0),afterQ=totalQ+changes.reduce((n,c)=>n+c.delta,0),own=changes.find(c=>c.id===id);
  return {id,before:claimBalance(selected),after:own?.after??claimBalance(selected),delta:own?.delta||0,changes,total:afterQ/4,totalQ:afterQ,level:QuarterPoints.levelFor(afterQ).level,signature:wsSignature({claims,changes}),unit:'quarter-point',epochId:selected.epochId};
}
function wsApplyCorrectionBatch(state,preview,note){
  const current=preview&&wsCorrectionBatch(state,preview.id);if(!current||current.signature!==preview.signature)return {ok:false,error:'The correction changed. Review the current batch.'};
  const at=nowIso();for(const change of current.changes){const claim=state.rewards.claims[change.id];claim.adjustments=claim.adjustments||[];claim.adjustments.push({id:newId('adjust'),at,delta:change.delta,reason:String(note||'Reviewed correction batch').slice(0,300),revision:claim.adjustments.length+1,ruleVersion:4,unit:'quarter-point',epochId:claim.epochId,calculation:change.calculation});claim.reconciledAt=at;claim.reconciliationSignature=rewardReviewSignature(state,claim);}
  return {ok:true,record:current};
}
correctionPreview=function(state,id){return state.rewards.claims[id]?.ruleVersion===4?wsCorrectionBatch(state,id):wsLegacyCorrection(state,id);};
adjustConfirmedClaim=function(state,id,note){if(state.rewards.claims[id]?.ruleVersion!==4)return wsLegacyAdjust(state,id,note);const preview=wsCorrectionBatch(state,id);const result=wsApplyCorrectionBatch(state,preview,note);return result.ok?preview:null;};

function wsGoalDay(state,series,date,cache){
  if(cache&&!cache.has(date))cache.set(date,new Map(allRows(planFor(state,date)).map(row=>[row.seriesId,row])));
  const v=versionFor(series,date),row=v&&(cache?cache.get(date).get(series.id):findPlanRow(state,series.id,date)),o=state.occurrences[occKey(series.id,date)];
  if(!v||!row||series.archivedAt&&series.archivedAt<=date)return {date,qualifying:false,full:false,minutes:0,pending:false};
  const kind=wsKind(series,date),committed=wsRequired(state,row);
  if(kind==='cardio'||kind==='strength'){
    const q=wsEvidenceQuantity(state,series.id,date),confirmed=!!o&&o.status==='done'&&actionConfirmation(state,o).confirmed;
    return {date,qualifying:confirmed&&!q.pending&&q.minutes>=(v.minimum?.minutes||(kind==='cardio'?20:15)),full:confirmed&&!q.pending&&q.minutes>=(v.normal?.minutes||(kind==='cardio'?45:15)),minutes:confirmed?q.minutes:0,pending:committed&&(q.pending||!confirmed)&&o?.status!=='skipped',eventId:o?rewardIdentity(state,o):null};
  }
  const leaves=row.children?leafRows(row.children).filter(r=>!r.optional):[row];
  const full=leaves.length>0&&leaves.every(r=>wsState(state,r,date)==='closed');
  return {date,qualifying:full,full,minutes:leaves.reduce((n,r)=>n+(state.occurrences[r.key]?.actualMinutes||0),0),pending:committed&&leaves.some(r=>['pending-evidence','open','future'].includes(wsState(state,r,date))),eventId:o?rewardIdentity(state,o):null};
}
function wsGoals(state,date,options={}){
  const start=weekStartOf(date,1),end=addDays(start,6),cards=[],rowCache=new Map();
  const series=state.series.filter(s=>{const v=versionFor(s,date);return !s.demo&&v&&(!s.archivedAt||date<s.archivedAt)&&(!v.recurrence?.endDate||v.recurrence.endDate>=start)&&(!options.groupId||wsGroup(s,date)===options.groupId);});
  const prayer=series.filter(s=>['prayer-am','prayer-pm'].includes(wsKind(s,date)));
  if(prayer.length){
    const days=weekDays(start).map(day=>{const rows=prayer.map(s=>wsGoalDay(state,s,day,rowCache)),am=prayer.some((s,i)=>wsKind(s,day)==='prayer-am'&&rows[i].full),pm=prayer.some((s,i)=>wsKind(s,day)==='prayer-pm'&&rows[i].full);return {date:day,qualifying:am||pm,full:am&&pm,minutes:rows.reduce((n,r)=>n+r.minutes,0),pending:rows.some(r=>r.pending),paired:am&&pm};});
    const paired=days.filter(d=>d.full).length,distinct=days.filter(d=>d.qualifying).length,additional=Math.max(0,distinct-Math.min(3,paired));
    cards.push({id:'prayer|'+start,kind:'prayer',title:'Prayer · three paired and two additional days',groupId:'faith',seriesIds:prayer.map(s=>s.id),window:{from:start,to:end,label:start+' – '+end,kind:'weekly'},qualifying:distinct,full:paired,target:5,pairedTarget:3,additionalTarget:2,additional,minutes:days.reduce((n,d)=>n+d.minutes,0),pending:days.filter(d=>d.pending).length,complete:paired>=3&&distinct>=5,days,deadline:null});
  }
  for(const s of series){
    const v=versionFor(s,date),kind=wsKind(s,date);if(['prayer-am','prayer-pm'].includes(kind)||!kind&&v.recurrence?.kind!=='target')continue;
    if(v.childIds&&kind!=='care')continue;
    const rolling=kind==='church'||v.recurrence?.mode==='rolling',configured=recurrenceWindow(v,date),from=rolling?addDays(date,1-(v.recurrence?.weeks||4)*7):configured?.from||start,to=rolling?date:configured?.to||end;
    const days=[];for(let day=from;day<=to;day=addDays(day,1)){const entry=wsGoalDay(state,s,day,rowCache);if(kind==='church'&&dow(day)!==0){entry.full=false;entry.qualifying=false;}days.push(entry);}
    const eligibleDays=days.filter(d=>d.date<=date),events=new Set(),fullEvents=new Set();for(const d of eligibleDays){if(d.qualifying)events.add(d.eventId||d.date);if(d.full)fullEvents.add(d.eventId||d.date);}
    const target=v.recurrence?.count||({cardio:4,strength:4,journal:3,church:1,home:1}[kind]||1),qualifying=events.size,full=fullEvents.size;
    const deadline=v.deadlineDay===undefined?null:{date:addDays(start,(v.deadlineDay+6)%7),time:'23:59',label:'By Thursday night'};
    if(v.recurrence?.kind==='target'||['cardio','strength','journal','church','home'].includes(kind))cards.push({id:s.id+'|'+from,kind:kind||'target',title:v.name,groupId:wsGroup(s,date),seriesIds:[s.id],window:{from,to,label:from+' – '+to,kind:rolling?'rolling28':v.recurrence?.weeks>1?'multiweek':'weekly'},qualifying,full,target,minutes:eligibleDays.reduce((n,d)=>n+d.minutes,0),pending:eligibleDays.filter(d=>d.pending).length,complete:qualifying>=target,days,deadline});
  }
  return cards;
}
function wsSignature(value){return fnv(JSON.stringify(value));}
function wsMigrationPreview(state,options={}){
  const effectiveFrom=options.effectiveFrom||options.date||todayYmd();if(!validCalendarDate(effectiveFrom))return {ok:false,error:'Choose a valid effective date.'};
  const safe=wsClone(options);delete safe.snapshot;delete safe.signature;
  if(safe.quarterPoints!==false&&typeof QuarterPoints==='undefined')return {ok:false,error:'Quarter-point module unavailable.'};
  return {ok:true,id:options.id||'migration-'+wsSignature([effectiveFrom,state.rewardGeneration,safe,(state.workspace?.migrations||[]).map(m=>[m.id,m.status])]),effectiveFrom,signature:wsSignature(state),proposalSignature:wsSignature([effectiveFrom,safe]),snapshot:wsClone(state),options:safe,legacyClaims:Object.values(state.rewards.claims).map(c=>({id:c.id,amount:c.amount,ruleVersion:c.ruleVersion,unit:c.unit||'legacy-point'})),newEpochTotalQ:0,policies:['Candidate rules require explicit adoption. Legacy claims stay unchanged.','Quarter units are not a rescale of past awards.','Partial care earns confirmed leaf shares and breaks full-instance continuity.','Pending holds consistency bonuses until the earlier instance is reviewed.','Reviewed corrections can reduce the current level.','No new calorie-deficit, water, template or documentation award.'],mapping:safe.taxonomy||[],additions:safe.additions||[],pending:safe.pending||[]};
}
function wsAdopt(state,preview){
  if(!preview?.ok||preview.signature!==wsSignature(state)||preview.proposalSignature!==wsSignature([preview.effectiveFrom,preview.options]))return {ok:false,error:'The workspace or proposal changed. Review a fresh migration preview.'};
  return wsTransaction(state,draft=>{
    const date=preview.effectiveFrom,options=preview.options||{};if(draft.workspace.migrations.some(m=>m.id===preview.id))return {ok:false,error:'This proposal has already been applied.'};
    const before={series:wsClone(draft.series),groups:wsClone(draft.groups),progression:wsClone(draft.rewards.progression)};
    for(const group of options.groups||[])if(!draft.groups.some(g=>g.id===group.id))draft.groups.push({...group,hidden:false,custom:true,updatedAt:nowIso()});
    for(const mapping of options.taxonomy||[]){if(!draft.groups.some(g=>g.id===mapping.category))return {ok:false,error:'The proposed category is unavailable.'};wsRevise(draft,mapping.seriesId,{category:mapping.category},date);}
    for(const change of options.scheduleChanges||[]){wsRevise(draft,change.seriesId,change.changes,date);if(change.restore===true)draft.series.find(s=>s.id===change.seriesId).archivedAt=null;}
    for(const addition of options.additions||[])wsCreate(draft,addition,date,addition.parentId||null);
    for(const move of options.moves||[])wsMove(draft,move.seriesId,move.parentId,date);
    let epochId=null;
    if(options.quarterPoints!==false){
      epochId='quarter-'+preview.id;draft.rewards.epochs=draft.rewards.epochs||[];
      if(draft.rewards.epochs.some(e=>e.id===epochId))return {ok:false,error:'This scoring epoch already exists.'};
      draft.rewards.epochs.push({id:epochId,ruleVersion:4,unit:'quarter-point',effectiveFrom:date,adoptedAt:nowIso(),policy:'partial resets full chain; pending holds bonus',proposal:true});
      draft.rewards.progression={rule:'quarter-v1',version:1,ruleVersion:4,unit:'quarter-point',epochId,effectiveFrom:date,adoptedAt:nowIso()};
    }
    const migration={id:preview.id,at:nowIso(),effectiveFrom:date,before,epochId,addedIds:(options.additions||[]).map(a=>a.id).filter(Boolean),status:'active'};draft.workspace.migrations.push(migration);
    return {ok:true,record:{id:migration.id,epochId,effectiveFrom:date,retainedClaims:Object.keys(draft.rewards.claims).length}};
  });
}
function wsRollbackPreview(state,id){
  const migration=state.workspace?.migrations.find(m=>m.id===id);if(!migration||migration.status!=='active')return {ok:false,error:'Choose an active migration.'};
  const added=(migration.addedIds||[]).filter(sid=>Object.values(state.occurrences).some(o=>o.seriesId===sid&&o.status));
  return {ok:true,id,signature:wsSignature(state),preserveClaims:Object.keys(state.rewards.claims).length,recordedAdditions:added,description:'Restore the prior structure and scoring selection; preserve all ledger entries and dated records. Recorded added activities remain archived for history.'};
}
function wsRollback(state,preview){
  if(!preview?.ok||preview.signature!==wsSignature(state))return {ok:false,error:'The workspace changed. Review rollback again.'};
  return wsTransaction(state,draft=>{
    const migration=draft.workspace.migrations.find(m=>m.id===preview.id);if(!migration||migration.status!=='active')return {ok:false,error:'This migration is not active.'};
    const previousIds=new Set(migration.before.series.map(s=>s.id)),retained=draft.series.filter(s=>!previousIds.has(s.id)&&Object.values(draft.occurrences).some(o=>o.seriesId===s.id));
    for(let i=0;i<retained.length;i++)for(const version of retained[i].versions){const id=version.parentId||retained[i].parentId;if(id&&!previousIds.has(id)&&!retained.some(s=>s.id===id)){const parent=draft.series.find(s=>s.id===id);if(parent)retained.push(parent);}}
    for(const s of retained){s.archivedAt=todayYmd();for(const v of s.versions){if(v.parentId&&!retained.some(p=>p.id===v.parentId))v.parentId=null;if(v.childIds)v.childIds=v.childIds.filter(id=>retained.some(c=>c.id===id));}}
    draft.series=wsClone(migration.before.series).concat(retained);draft.groups=wsClone(migration.before.groups);draft.rewards.progression=wsClone(migration.before.progression);migration.status='rolled-back';migration.rolledBackAt=nowIso();
    return {ok:true,record:{id:migration.id,status:migration.status,preservedClaims:Object.keys(draft.rewards.claims).length}};
  });
}
function wsProposal(state,date){
  if(typeof WorkspaceProposal==='undefined')return {ok:false,error:'The daily workspace proposal definitions are unavailable.'};
  const proposal=WorkspaceProposal.build(date),additions=[],scheduleChanges=[],taxonomy=[],pending=[],idMap=new Map(),moves=[];
  const definitions=proposal.additions||[],used=new Set(),rollbackIds=new Set((state.workspace?.migrations||[]).filter(m=>m.status==='rolled-back').flatMap(m=>m.addedIds||[])),notes=(proposal.notes||[]).slice();
  for(const definition of definitions){
    const matches=state.series.filter(s=>!s.demo&&!used.has(s.id)&&(!s.archivedAt||s.archivedAt>date||rollbackIds.has(s.id))).filter(s=>{const v=versionFor(s,date);return v&&(!definition.parentId||definition.workspaceKind!=='care'||(['evening','night'].includes(v.anchor)?'night':v.anchor)===(['evening','night'].includes(definition.anchor)?'night':definition.anchor))&&(v.workspaceKind===definition.workspaceKind&&definition.workspaceKind&&!['home','care','ordinary','bathroom'].includes(definition.workspaceKind)||v.name.trim().toLowerCase()===definition.name.trim().toLowerCase());});
    if(matches.length===1){const existing=matches[0],v=versionFor(existing,date);used.add(existing.id);idMap.set(definition.id,existing.id);if(definition.remap===true&&(v.category||existing.category)!==definition.category)taxonomy.push({seriesId:existing.id,category:definition.category});const changes={workspaceKind:definition.workspaceKind,scoring:definition.scoring};if(definition.matching)changes.matching=wsClone(definition.matching);if(definition.budgetQ!==undefined)changes.budgetQ=definition.budgetQ;if(definition.deadlineDay!==undefined)changes.deadlineDay=definition.deadlineDay;if(!v.childIds&&!definition.container&&!definition.kind){changes.normal=definition.normal;changes.minimum=definition.minimum;changes.recurrence={...definition.recurrence,...(v.recurrence?.endDate&&definition.workspaceKind!=='cardio'?{endDate:v.recurrence.endDate}:{})};}const restore=!!existing.archivedAt&&rollbackIds.has(existing.id);scheduleChanges.push({seriesId:existing.id,changes,...(restore?{restore:true}:{})});if(restore)notes.push(v.name+' will be restored from archived rollback history on deliberate adoption.');if(definition.category!==wsGroup(existing,date))taxonomy.push({seriesId:existing.id,category:definition.category});}
    else if(matches.length>1){pending.push({id:definition.id,reason:'Multiple existing actions could match; no automatic remap.',seriesIds:matches.map(s=>s.id)});idMap.set(definition.id,null);}
    else {idMap.set(definition.id,definition.id);additions.push(wsClone(definition));}
  }
  for(const s of state.series){const v=versionFor(s,date);if(v&&/^laundry$|^one load|^laundry load/i.test(v.name)&&!used.has(s.id))pending.push({seriesId:s.id,reason:'Generic prior laundry is preserved; review its relationship to the four weekly loads.'});}
  for(const definition of definitions){const id=idMap.get(definition.id),parentId=definition.parentId?idMap.get(definition.parentId):null;if(id&&id!==definition.id&&parentId&&parentFor(state.series.find(s=>s.id===id),date)!==parentId)moves.push({seriesId:id,parentId});}
  const filtered=additions.filter(a=>!a.parentId||idMap.get(a.parentId));for(const a of filtered)if(a.parentId)a.parentId=idMap.get(a.parentId)||a.parentId;
  return {ok:true,effectiveFrom:date,quarterPoints:!quarterProgression(state),groups:proposal.groups||[],additions:filtered,scheduleChanges,taxonomy,moves,pending,notes,policies:proposal.policies||[]};
}
/* Mintay began the agreed activities on Monday 2026-09-21 but adopted them on the Wednesday. This
   moves the start of scoring back, once, as a single transaction: the quarter epoch, every version
   the adoption-day migrations wrote (so a parent keeps its children on the earlier days), and the
   JSON display boundary. Later versions are untouched. It refuses while any claim already falls on
   or after the new date outside the current epoch, so nothing is scored twice. */
function wsBackdateCheck(state,date){
  if(!validCalendarDate(date))return {ok:false,error:'Choose a valid start date.'};
  if(!wsEnabled(state)||!quarterProgression(state))return {ok:false,error:'Adopt the agreed activities first.'};
  const epoch=wsEpoch(state),from=epoch?.effectiveFrom;if(!epoch)return {ok:false,error:'The scoring period is unavailable.'};
  if(date>=from)return {ok:false,error:'Scoring already starts on '+from+'.'};
  if(date>todayYmd())return {ok:false,error:'Choose a date that has already begun.'};
  const migrations=state.workspace.migrations.filter(m=>m.status==='active'&&m.effectiveFrom===from);
  if(!migrations.some(m=>m.epochId===epoch.id))return {ok:false,error:'The adoption that started this scoring period is not active.'};
  const earlier=Object.values(state.rewards.claims).filter(c=>c.date>=date&&c.epochId!==epoch.id);
  if(earlier.length)return {ok:false,error:'Points were already claimed on '+[...new Set(earlier.map(c=>c.date))].sort().join(', ')+'. Moving the start would score those days twice.'};
  const before=new Map(migrations.flatMap(m=>m.before.series).map(s=>[s.id,Math.max(0,...s.versions.map(v=>v.version))]));
  const added=new Set(migrations.flatMap(m=>m.addedIds||[])),moves=[];
  for(const series of state.series){
    const known=before.get(series.id),wrote=series.versions.filter(v=>v.effectiveFrom===from&&(added.has(series.id)||known!==undefined&&v.version>known));
    if(!wrote.length)continue;
    if(series.versions.some(v=>v.effectiveFrom>=date&&v.effectiveFrom<from))return {ok:false,error:versionFor(series,from).name+' changed between '+date+' and '+from+'; review it before moving the start.'};
    moves.push({seriesId:series.id,name:versionFor(series,from).name,versions:wrote.map(v=>v.version)});
  }
  const feed=state.autoFeed?.contract&&state.autoFeed.contract.activeFrom>date;
  return {ok:true,date,from,epochId:epoch.id,migrationIds:migrations.map(m=>m.id),moves,feed,signature:wsSignature(state)};
}
function wsBackdate(draft,date,options={}){
  const check=wsBackdateCheck(draft,date);if(!check.ok)return check;
  const at=nowIso();
  for(const move of check.moves){const series=draft.series.find(s=>s.id===move.seriesId);for(const v of series.versions)if(move.versions.includes(v.version))v.effectiveFrom=date;}
  wsEpoch(draft).effectiveFrom=date;draft.rewards.progression.effectiveFrom=date;
  for(const m of draft.workspace.migrations)if(check.migrationIds.includes(m.id)){m.backdated={from:check.from,to:date,at};m.effectiveFrom=date;}
  if(check.feed){
    draft.autoFeed.contract.activeFrom=date;
    const problem=typeof HealthAutoExport!=='undefined'&&HealthAutoExport.validateContract(draft.autoFeed.contract);if(problem)return {ok:false,error:problem};
  }
  // Anything already done in the reopened days takes the rule it would have been given at the time.
  for(const o of Object.values(draft.occurrences))if(o.status==='done'&&o.date>=date&&o.date<check.from)wsPinRule(draft,o);
  const today=options.today||todayYmd(),span=Math.round((parseYmd(today)-parseYmd(date))/864e5)+1;
  const auto=wsAutoEvidence(draft,{today,days:Math.max(WS_AUTO_DAYS,span)});
  return {ok:true,record:{from:check.from,to:date,moved:check.moves.length,feed:check.feed},changes:auto.changes};
}

const Workspace={
  tree(state,date,options={}){const rows=planFor(state,date);if(!options.groupId)return rows;const filter=rows=>rows.flatMap(r=>{if(r.children){const children=filter(r.children);return children.length?[{...r,children,family:familySummary(leafRows(children))}]:[];}return r.group===options.groupId?[r]:[];});return filter(rows);},
  rings:wsRings,goals:wsGoals,
  create(state,fields,date){return wsTransaction(state,draft=>wsCreate(draft,fields,date,fields.parentId||null));},
  addChild(state,parentId,fields,date,options={}){return wsTransaction(state,draft=>wsCreate(draft,{...fields,...(options.scope==='occurrence'?{recurrence:{kind:'once',date}}:{})},date,parentId));},
  edit(state,id,changes,date,options={}){return wsTransaction(state,draft=>wsEdit(draft,id,changes,date,options));},
  move(state,id,parentId,date){return wsTransaction(state,draft=>wsMove(draft,id,parentId,date));},
  reorder(state,id,order,date){if(!Number.isFinite(order))return {ok:false,error:'Choose a valid order.'};return wsTransaction(state,draft=>wsEdit(draft,id,{order},date));},
  commit(state,id,date,committed=true){return wsTransaction(state,draft=>{const s=draft.series.find(s=>s.id===id),v=s&&versionFor(s,date);if(!v||v.childIds||!validCalendarDate(date)||!scheduledOn(v,date))return {ok:false,error:'Choose an available leaf on this date.'};const o=ensureOcc(draft,id,date);o.committed=!!committed;if(committed&&v.recurrence?.kind==='target'&&v.recurrence.count===1&&v.recurrence.mode!=='rolling'&&!o.status&&!draft.rewards.claims[o.rewardEventId])o.rewardEventId=id+'|week:'+weekStartOf(date,1);touch(o);return {ok:true,record:o};});},
  evidencePreview:wsEvidencePreview,confirmEvidence:wsConfirmEvidence,
  autoEvidence(state,options={}){if(!wsEnabled(state))return {ok:true,changes:[]};return wsTransaction(state,draft=>wsAutoEvidence(draft,options));},
  declineAuto(state,id,date){return wsTransaction(state,draft=>wsDeclineAuto(draft,id,date));},
  unsortedWorkouts:wsUnsortedWorkouts,workoutClass:wsWorkoutClass,
  classifyWorkout(state,key,cls){return wsTransaction(state,draft=>{const r=wsClassifyWorkout(draft,key,cls);if(!r.ok)return r;if(wsEnabled(draft))wsAutoEvidence(draft);return r;});},
  proposal:wsProposal,migrationPreview:wsMigrationPreview,adopt:wsAdopt,rollbackPreview:wsRollbackPreview,rollback:wsRollback,
  backdateCheck:wsBackdateCheck,backdate(state,date,options={}){return wsTransaction(state,draft=>wsBackdate(draft,date,options));},
  correctionBatch:wsCorrectionBatch,applyCorrectionBatch(state,preview,note){return wsTransaction(state,draft=>wsApplyCorrectionBatch(draft,preview,note));},
};
globalThis.Workspace=Workspace;

/* Keep legacy count-only water honest and make downward corrections mergeable. */
const wsLegacyWater=addWater,wsLegacyFoodUpdate=updateFood,wsLegacyFoodDelete=deleteFood;
addWater=function(state,date,delta){const value=wsLegacyWater(state,date,delta);state.hydrationRevisions=state.hydrationRevisions||{};const old=state.hydrationRevisions[date];state.hydrationRevisions[date]={revision:(old?.revision||0)+1,value:state.hydration[date],at:nowIso()};return value;};
function mergeLegacyWater(cur,inc){
  if(Object.keys(inc.hydration||{}).length)cur.hydrationRevisions=cur.hydrationRevisions||{};
  for(const [date,value]of Object.entries(inc.hydration||{})){
    const mine=cur.hydrationRevisions[date],incoming=inc.hydrationRevisions?.[date];
    if(incoming&&(!mine||incoming.revision>mine.revision)){cur.hydration[date]=value;cur.hydrationRevisions[date]=wsClone(incoming);}
    else if(!(date in cur.hydration))cur.hydration[date]=value;
    else if(!mine&&!incoming&&cur.hydration[date]!==value){cur.hydrationConflicts=cur.hydrationConflicts||{};cur.hydrationConflicts[date]={kept:cur.hydration[date],incoming:value,note:'Legacy counts differ; volume is unknown. Review before replacing.'};}
  }
}
updateFood=function(state,id,fields){if(typeof MealWater==='undefined')return wsLegacyFoodUpdate(state,id,fields);const changes={};for(const key of ['date','time','label','tag','notes','location','timePrecision','actionId','servings'])if(wsHas(fields,key))changes[key]=fields[key];const result=MealWater.editConsumption(state,id,changes);return result.ok?result.record:null;};
deleteFood=function(state,id){if(typeof MealWater==='undefined')return wsLegacyFoodDelete(state,id);return MealWater.deleteConsumption(state,id).ok;};

/* A merge is staged, including epoch metadata, so a refusal cannot half-import. */
const wsLegacyMerge=mergeState;
mergeState=function(current,incoming){
  if(current.syntheticWorkspace!==true&&syntheticPreviewData(incoming))return {error:'Synthetic walkthrough records cannot be merged into a personal record.'};
  for(const [date,value]of Object.entries(incoming.hydration||{})){if(date in (current.hydration||{})&&current.hydration[date]!==value&&(current.hydrationRevisions?.[date]?.revision||0)===(incoming.hydrationRevisions?.[date]?.revision||0))return {error:'Legacy glass counts conflict on '+date+'. Preserve both exports and review the count; volume is unknown.'};}
  const draft=wsClone(current),copy=wsClone(incoming);
  if(copy.rewards?.epochs?.length||draft.rewards.epochs)draft.rewards.epochs=draft.rewards.epochs||[];
  for(const epoch of copy.rewards?.epochs||[]){const old=draft.rewards.epochs.find(e=>e.id===epoch.id);if(old&&JSON.stringify(old)!==JSON.stringify(epoch))return {error:'Scoring epoch definitions conflict; preserve both exports for review.'};if(!old)draft.rewards.epochs.push(wsClone(epoch));}
  if(wsEnabled(copy)){
    wsEnsure(draft);
    for(const migration of copy.workspace.migrations||[])if(!draft.workspace.migrations.some(m=>m.id===migration.id))draft.workspace.migrations.push(wsClone(migration));
  }
  const result=wsLegacyMerge(draft,copy);if(result.error)return result;
  const error=validateState(draft);if(error)return {error:'Merged export refused: '+error};replaceState(current,draft);return result;
};

const wsLegacyConfirmAction=confirmAction;
confirmAction=function(state,id,date,fields={}){
  const series=state.series.find(s=>s.id===id);
  if(series&&wsKind(series,date)==='healthy-meal'){
    if(fields.attested!==true||!Array.isArray(fields.mealTags)||!fields.mealTags.length||fields.mealTags.some(t=>!['breakfast','lunch','dinner'].includes(t)))return {ok:false,error:'Select at least one meal and explicitly confirm your own healthy-meal assessment.'};
    const result=wsLegacyConfirmAction(state,id,date,fields);if(result.ok){result.occurrence.mealTags=[...new Set(fields.mealTags)].sort();result.occurrence.healthfulness={kind:'self-attested',at:nowIso()};if(state.syntheticWorkspace===true)result.occurrence.syntheticPreview=true;}return result;
  }
  const result=wsLegacyConfirmAction(state,id,date,fields);if(result.ok&&state.syntheticWorkspace===true)result.occurrence.syntheticPreview=true;return result;
};
Workspace.confirmHealthyMeal=function(state,id,date,tags,options={}){return wsTransaction(state,draft=>{const result=confirmAction(draft,id,date,{mealTags:tags,attested:options.attested===true});return result.ok?{ok:true,record:result.occurrence}:result;});};
Workspace.energyBalance=function(state,date){
  const source=(kind)=>{const records=relayedRecords(state,kind).filter(r=>sourceLocalDay(r.start)===date&&!r.clashes?.length&&r.unit==='kcal'&&Number.isFinite(r.value)&&r.value>=0);const signatures=new Map();for(const record of records){const key=JSON.stringify([record.sourceRecordId||null,record.sourceApp,record.start,record.end,record.value]);if(!signatures.has(key))signatures.set(key,record);}const distinct=[...signatures.values()];if(new Set(distinct.map(r=>r.sourceApp)).size>1)return null;if(distinct.some((r,i)=>distinct.slice(0,i).some(other=>evidenceOverlaps(r,other))))return null;return distinct.length?distinct.reduce((n,r)=>n+r.value,0):null;};
  const foods=(state.foods||[]).filter(f=>f.date===date),manualFood=foods.length&&foods.every(f=>Number.isFinite(f.nutrition?.calories))?foods.reduce((n,f)=>n+f.nutrition.calories,0):null;
  const importedFood=source('dietaryEnergy'),mixedFood=foods.length>0&&importedFood!==null,food=mixedFood?null:manualFood??importedFood,resting=source('restingEnergy'),active=source('activeEnergy');
  const available=[food,resting,active].every(Number.isFinite),coverage=state.energyCoverage?.[date]||{},signature=wsSignature([date,foods,relayedRecords(state).filter(r=>sourceLocalDay(r.start)===date&&['dietaryEnergy','restingEnergy','activeEnergy'].includes(r.kind))]),complete=date<todayYmd()&&available&&coverage.signature===signature&&coverage.food===true&&coverage.resting===true&&coverage.active===true;
  return {date,food,resting,active,signature,balance:available?food-resting-active:null,available,provisional:!complete,complete,scoring:false,unit:'kcal',note:mixedFood?'Possible imported/manual food duplication needs review.':complete?'Explicitly reviewed coverage; workouts are already included in active energy.':'Coverage is incomplete or unverified. Missing values stay unavailable; no deficit award.'};
};
Workspace.syntheticPreview=function(date,prefs){
  const state=freshState();state.seeded=true;state.demo=false;state.syntheticWorkspace=true;if(prefs)state.prefs={...state.prefs,...wsClone(prefs)};
  const proposal=Workspace.proposal(state,date);if(!proposal.ok)return {ok:false,error:proposal.error};
  const result=Workspace.adopt(state,Workspace.migrationPreview(state,proposal));if(!result.ok)return result;
  const brush=state.series.find(s=>s.id==='dw-brush');if(brush)confirmAction(state,brush.id,date,{});
  return {ok:true,record:migrateTo(state)};
};

/* Cache only within one read projection: no mutation or persisted cache can
   make late evidence or corrections reuse an obsolete chain. */
let wsProjectionCache=null;
const wsUncachedChainEvent=wsChainEvent,wsUncachedPriorChain=wsPriorChain,wsUncachedEligibility=confirmedEligibility;
wsChainEvent=function(state,id,date){if(!wsProjectionCache)return wsUncachedChainEvent(state,id,date);const key='event|'+id+'|'+date;if(!wsProjectionCache.has(key))wsProjectionCache.set(key,wsUncachedChainEvent(state,id,date));return wsProjectionCache.get(key);};
wsPriorChain=function(state,id,date,epoch){if(!wsProjectionCache)return wsUncachedPriorChain(state,id,date,epoch);const key='prior|'+id+'|'+date+'|'+epoch.id;if(!wsProjectionCache.has(key))wsProjectionCache.set(key,wsUncachedPriorChain(state,id,date,epoch));return wsProjectionCache.get(key);};
confirmedEligibility=function(state,today){if(!quarterProgression(state))return wsUncachedEligibility(state,today);const prior=wsProjectionCache;wsProjectionCache=new Map();try{return wsUncachedEligibility(state,today);}finally{wsProjectionCache=prior;}};

/* Corrections use the original claim's rule even while another epoch is active. */
function wsLegacyClaimPreview(state,id){
  const claim=state.rewards.claims[id];if(!claim)return null;
  const progression=claim.ruleVersion===3?{rule:'confirmed-s11',version:1,effectiveFrom:'0001-01-01'}:{rule:'legacy-10',version:1};
  const historical={...state,rewards:{...state.rewards,progression}},occurrences=Object.values(state.occurrences).filter(o=>rewardIdentity(state,o)===id);
  const entitlement=claim.ruleVersion===3?occurrences.map(o=>wsLegacyEntitlement(historical,o)).find(Boolean):rewardEligibility(historical,todayYmd()).find(e=>e.id===id);
  const before=claimBalance(claim),after=entitlement?.amount||0,total=Object.values(state.rewards.claims).filter(c=>c.ruleVersion!==4).reduce((n,c)=>n+claimBalance(c),0)+after-before;
  return {id,before,after,delta:after-before,total,unit:'legacy-point',ruleVersion:claim.ruleVersion,...(claim.ruleVersion===3?s11Level(total):wsLegacyRewardLevel(historical,total))};
}
correctionPreview=function(state,id){const claim=state.rewards.claims[id];if(!claim)return null;return claim.ruleVersion===4?wsCorrectionBatch(state,id):quarterProgression(state)||Object.values(state.rewards.claims).some(c=>c.ruleVersion===4)?wsLegacyClaimPreview(state,id):wsLegacyCorrection(state,id);};
const wsCurrentConfirmation=actionConfirmation;
actionConfirmation=function(state,o){
  if(o?.quarterRule&&o.status==='done'&&!o.confirmation)return {confirmed:false,label:'Tentative · review to confirm'};
  if(wsEnabled(state)&&o?.status==='done'){const series=state.series.find(s=>s.id===o.seriesId);if(series&&wsKind(series,o.date)==='healthy-meal'&&(o.healthfulness?.kind!=='self-attested'||!Array.isArray(o.mealTags)||!o.mealTags.length))return {confirmed:false,label:'Healthy meal assessment needs your confirmation'};}
  return wsCurrentConfirmation(state,o);
};

const wsLegacyTargetProgress=targetProgress;
targetProgress=function(state,id,date){
  if(!wsEnabled(state))return wsLegacyTargetProgress(state,id,date);
  const series=state.series.find(s=>s.id===id),v=series&&versionFor(series,date),window=v&&recurrenceWindow(v,date);if(!window)return null;
  const kind=wsKind(series,date),qualified=new Set(),full=new Set();let minutes=0,pending=0;
  for(let day=window.from;day<=window.to&&day<=date;day=addDays(day,1)){
    const current=versionFor(series,day);if(!current||!scheduledOn(current,day))continue;
    const o=state.occurrences[occKey(id,day)],eventId=o?rewardIdentity(state,o):day;
    if(current.childIds){const status=wsChainEvent(state,id,day);if(status==='full'){qualified.add(day);full.add(day);}else if(status==='pending')pending++;continue;}
    if(!o||!o.status)continue;
    if(kind==='cardio'||kind==='strength'){const q=wsEvidenceQuantity(state,id,day);if(actionConfirmation(state,o).confirmed&&!q.pending){minutes+=q.minutes;if(q.minutes>=(current.minimum?.minutes||(kind==='cardio'?20:15)))qualified.add(eventId);if(q.minutes>=(current.normal?.minutes||(kind==='cardio'?45:15)))full.add(eventId);}else pending++;}
    else if(o.status==='done'&&actionConfirmation(state,o).confirmed&&o.completedVersion!=='minimum'&&(kind!=='church'||dow(day)===0)){qualified.add(eventId);full.add(eventId);}
    else if(!['partial','skipped'].includes(o.status))pending++;
  }
  return {...window,count:qualified.size,full:full.size,minutes,pending,remaining:Math.max(0,window.target-qualified.size),complete:qualified.size>=window.target};
};

const wsLegacyPreserveUnlocks=preserveRewardUnlocks;
preserveRewardUnlocks=function(state,today){
  if(!quarterProgression(state))return wsLegacyPreserveUnlocks(state,today);
  const epoch=wsEpoch(state),claims=Object.values(state.rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===epoch.id),points=claims.reduce((n,c)=>n+claimBalance(c),0)/4,days=new Set(claims.map(c=>c.date));
  for(const achievement of rewardAchievements(state,points,days.size))if(achievement.earned&&!state.rewards.unlocks[achievement.id])state.rewards.unlocks[achievement.id]=nowIso();
};
