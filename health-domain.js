
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
// The build ship.sh stamped (delivery.js loads after this file, so it is read when asked for, never at load).
const stampedBuildId = () => (typeof window !== 'undefined' && window.HealthDelivery && window.HealthDelivery.build) || BUILD;
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
const THEMES = ['dark','light','system','verde','black'];   // Glow V2.1: verde = Verde Marble (default; dark means the same), black = Black Marble
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
/* Printed instants only. Calendar, feed and sleep-day selection must not call this formatter. */
const pacificFormats = new Map();
function pacificTime(value, style='stamp'){
  if(value===null||value===undefined||value===''||(typeof value==='string'&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)))return 'Unknown';
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return 'Unknown';
  if(!pacificFormats.has(style)){
    const options=style==='clock'?{hour:'2-digit',minute:'2-digit',hourCycle:'h23'}:{...(['time','compact'].includes(style)?{}:{month:'short',day:'numeric',year:'numeric'}),hour:'numeric',minute:'2-digit',...(style==='compact'?{}:{timeZoneName:'short'})};
    pacificFormats.set(style,new Intl.DateTimeFormat('en-US',{...options,timeZone:'America/Los_Angeles'}));
  }
  return pacificFormats.get(style).format(date);
}
/* V3.5 K8: the Pacific calendar day of a stamped instant. A suggestion written at 6 PM on Oct 1 is Oct 2 in UTC, and
   cutting the ISO string (`at.slice(0,10)`) printed and grouped it one day late. For printed and grouped stamps only;
   scoring and feed days keep their own rules. */
function pacificDay(value){
  if(value===null||value===undefined||value===''||(typeof value==='string'&&!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)))return null;
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return null;
  if(!pacificFormats.has('ymd'))pacificFormats.set('ymd',new Intl.DateTimeFormat('en-US',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'America/Los_Angeles'}));
  const p={};for(const x of pacificFormats.get('ymd').formatToParts(date))p[x.type]=x.value;
  return p.year+'-'+p.month+'-'+p.day;
}
function freshnessAge(value, now=Date.now()){
  const at=value?Date.parse(value):NaN,age=now-at;
  if(!Number.isFinite(age)||age<0)return {tone:'none',word:'unknown freshness',ago:'unknown',at:null};
  const [tone,word]=age<=6e5?['live','current']:age<=432e5?['recent','a few hours old']:age<=864e5?['today','most of a day old']:['stale','over a day old'];
  return {tone,word,at:value,ago:age<36e5?Math.max(1,Math.round(age/6e4))+' min ago':age<864e5?Math.floor(age/36e5)+' h ago':Math.floor(age/864e5)+' d ago'};
}
function targetParts(value,target){
  if(!Number.isFinite(value)||!Number.isFinite(target)||target<=0)return {known:false,done:null,left:null,extra:null};
  return {known:true,done:Math.min(target,Math.max(0,value)),left:Math.max(0,target-value),extra:Math.max(0,value-target)};
}
function newId(prefix){ return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
/* V3.6 Block 5 (M1 to M5, Mintay Oct 3): the goal builder's engine. A goal is an ADDITIVE object on a series version,
   {v:1, measure, source, target, period, when, credit}, and its hand entries live in state.goalEntries (seriesId -> list).
   The version's `recurrence` stays an old kind with a valid `days` list (V3.5's validator requires it on every non-once
   kind and refuses the record otherwise: V36-I25), so an older build opens the record and shows a plain item. A revision
   is a new dated version, so an earlier day's evaluation never moves (ASSUMED A10). Pure: nothing here writes the store
   except the entry functions, which change state.goalEntries only. */
const GOAL_KM_PER_MI=1.609344;
const GOAL_UNITS={mi:1,km:1/GOAL_KM_PER_MI,m:1/1609.344,meter:1/1609.344,meters:1/1609.344,mile:1,miles:1,kilometer:1/GOAL_KM_PER_MI,kilometers:1/GOAL_KM_PER_MI,yd:1/1760,ft:1/5280};   // to miles; anything else is unreadable (ASSUMED A12)
const GOAL_MEASURES=['check','count','sum','average','latest'],GOAL_OPS=['atLeast','atMost','between','exactly'],GOAL_PERIODS=['day','week','month','everyN','range','rolling'],GOAL_WHENS=['any','days','by','monthday','nthweekday','after','season','deadline'],GOAL_CREDITS=['all','proportional','half'];
/* V3.7: the day the release's dated rules start (A59 Required and Stretch, A44 goal points). Days before keep the rule
   they were graded and paid under. Set to the ship day at release. */
const V37_RULE_DAY='2026-10-05';
let goalReadings=null;   // V3.6 M4: the page supplies daily readings the domain does not hold (sleep hours, water)
function setGoalReadings(fn){goalReadings=typeof fn==='function'?fn:null;}
const GoalEngine={
  // A goal as stored: every field checked; an unknown future version is kept as it is and never refused.
  normalize(g){
    if(!g||typeof g!=='object')return null;if(Number.isFinite(g.v)&&g.v>1)return JSON.parse(JSON.stringify(g));
    const num=(x,lo,hi)=>Number.isFinite(+x)?Math.max(lo,Math.min(hi,+x)):null,day=x=>Number.isInteger(+x)&&+x>=0&&+x<=6?+x:null,days=a=>[...new Set((Array.isArray(a)?a:[]).map(Number).filter(d=>Number.isInteger(d)&&d>=0&&d<=6))].sort();
    const m=g.measure||{},s=g.source||{},t=g.target||{},p=g.period||{},w=g.when||{};
    const out={v:1,
      measure:{kind:GOAL_MEASURES.includes(m.kind)?m.kind:'check',unit:String(m.unit||'').trim().slice(0,14),...(m.reading?{reading:String(m.reading).slice(0,24)}:{})},
      source:{kind:s.kind==='auto'?'auto':'manual',...(s.kind==='auto'?{metric:String(s.metric||''),types:Array.isArray(s.types)?s.types.map(String).slice(0,40):[],field:['distance','minutes','energy','count'].includes(s.field)?s.field:'distance',unit:String(s.unit||'').slice(0,14),
        // V3.7 O8 (A38): four optional filters, additive under goal.v:1 (V3.6 drops them on a re-save and keeps the goal: §1 row 21)
        ...(Array.isArray(s.writers)&&s.writers.length?{writers:s.writers.map(String).slice(0,8)}:{}),...(s.outdoor===true?{outdoor:true}:{}),...(Number.isFinite(+s.minMinutes)&&+s.minMinutes>0?{minMinutes:Math.min(600,+s.minMinutes)}:{}),...(Number.isFinite(+s.hrCoverage)&&+s.hrCoverage>0?{hrCoverage:Math.min(1,+s.hrCoverage)}:{})}:{})},
      target:{op:GOAL_OPS.includes(t.op)?t.op:'atLeast',value:num(t.value,0,1e7),...(t.op==='between'?{value2:num(t.value2,0,1e7)}:{})},
      period:{kind:GOAL_PERIODS.includes(p.kind)?p.kind:'day',...(p.kind==='week'&&(p.weekStart===0||p.weekStart===1)?{weekStart:p.weekStart}:{}),...(p.kind==='everyN'||p.kind==='rolling'?{n:num(p.n,1,366)||7}:{}),...(p.kind==='range'?(()=>{const a=validCalendarDate(p.from)?p.from:null,b=validCalendarDate(p.to)?p.to:null;return a&&b&&a>b?{from:b,to:a}:{from:a,to:b};})():{})},   // a range typed backwards is put in order (review F5)
      when:{kind:GOAL_WHENS.includes(w.kind)?w.kind:'any'},
      credit:GOAL_CREDITS.includes(g.credit)?g.credit:'all'};
    const W=out.when;
    if(W.kind==='days')W.days=days(w.days).length?days(w.days):[0,1,2,3,4,5,6];
    if(W.kind==='by')W.by=day(w.by)??5;
    if(W.kind==='monthday')W.monthday=num(w.monthday,1,31)||1;
    if(W.kind==='nthweekday'){W.nth=w.nth==='last'||+w.nth===-1?-1:num(w.nth,1,5)||1;W.weekday=day(w.weekday)??0;}   // -1 = the last such weekday
    if(W.kind==='after')W.after=num(w.after,1,366)||7;
    if(W.kind==='season')W.seasons=(Array.isArray(w.seasons)?w.seasons:[]).filter(r=>r&&validCalendarDate(r.from)&&validCalendarDate(r.to)&&r.from<=r.to).slice(0,6).map(r=>({from:r.from,to:r.to,days:days(r.days)}));
    if(W.kind==='deadline')W.date=validCalendarDate(w.date)?w.date:null;
    if(out.measure.kind==='check'&&out.credit==='proportional')out.credit='all';
    return out;
  },
  /* The `recurrence` stored beside a goal, which an older build reads: a weekly kind with a valid days list (it shows a
     plain item), or, for "N times a week" (with or without a due day), the existing weekly target, so the grade, Perfect's
     quota and the Template keep their one rule for N-a-week items (V36-I25: never a new recurrence kind). */
  legacyRecurrence(g,from){const w=(g&&g.when)||{},t=(g&&g.target)||{},all=[0,1,2,3,4,5,6],days=w.kind==='days'?w.days.slice():w.kind==='season'&&w.seasons&&w.seasons[0]?w.seasons[0].days.slice():all;
    if(g&&g.measure&&g.measure.kind==='check'&&g.period&&g.period.kind==='week'&&t.op==='atLeast'&&Number.isFinite(t.value)&&t.value>=1&&['any','by'].includes(w.kind)&&validCalendarDate(from))return {kind:'target',count:Math.min(100,Math.round(t.value)),weeks:1,mode:'fixed',startDate:weekStartOf(from,1),days};   // Monday weeks, as the weekly target's reward identity counts them (review N3); the card follows this target (window)
    return {kind:'weekly',days};},
  validate(g){
    if(g===undefined||g===null)return null;if(typeof g!=='object'||Array.isArray(g))return 'A goal is malformed.';
    if(Number.isFinite(g.v)&&g.v>1)return null;   // a goal from a later build is kept and never refused
    if(g.v!==1||!g.measure||!GOAL_MEASURES.includes(g.measure.kind)||!g.target||!GOAL_OPS.includes(g.target.op)||!g.period||!GOAL_PERIODS.includes(g.period.kind)||!g.when||!GOAL_WHENS.includes(g.when.kind)||!GOAL_CREDITS.includes(g.credit))return 'A goal is malformed.';
    return null;
  },
  validateEntries(map){
    if(map===undefined)return null;if(!map||typeof map!=='object'||Array.isArray(map))return 'The goal entries are malformed.';
    for(const list of Object.values(map)){if(!Array.isArray(list))return 'The goal entries are malformed.';for(const e of list)if(!e||typeof e.id!=='string'||!validCalendarDate(e.date)||!['added','edited','merged'].includes(e.origin)||(e.origin!=='merged'&&!(Number.isFinite(e.value)&&e.value>=0)))return 'A goal entry is malformed.';}
    return null;
  },
  /* M2: the day rules no recurrence kind can say. Stateless kinds here (scheduledOn reads this); "N days after the last
     one done" also needs the record, so planFor asks afterDue. A day outside the version's own days is never due. */
  dueOn(g,date,ver){
    const w=g.when||{},d=dow(date),start=ver&&ver.effectiveFrom||date;
    if(g.period&&g.period.kind==='range'&&((g.period.from&&date<g.period.from)||(g.period.to&&date>g.period.to)))return false;
    switch(w.kind){
      case 'days':return w.days.includes(d);
      case 'monthday':{const last=new Date(+date.slice(0,4),+date.slice(5,7),0).getDate();return +date.slice(8)===Math.min(w.monthday,last);}   // the 31st falls on a short month's last day
      case 'nthweekday':{if(d!==w.weekday)return false;const dom=+date.slice(8),last=new Date(+date.slice(0,4),+date.slice(5,7),0).getDate();return w.nth===-1?dom+7>last:Math.ceil(dom/7)===w.nth;}   // a 5th weekday a month lacks is not due that month; -1 = the last
      case 'season':{const r=(w.seasons||[]).find(x=>x.from<=date&&date<=x.to);return !!r&&r.days.includes(d);}
      case 'deadline':return !w.date||date<=w.date;
      default:return date>=start;
    }
  },
  /* "N days after the last one done": due from the last done day + N; before the first done, due from the version's start.
     It moves when a done is recorded or edited and never re-opens a past day (a past day keeps what it had). */
  afterDue(state,series,ver,date,memo,asOf){
    const g=ver.goal,n=(g.when&&g.when.after)||7,last=GoalEngine.lastDone(state,series.id,date,memo,asOf);
    return last?calendarDistance(last,date)>=n:date>=ver.effectiveFrom;
  },
  /* A series' done dates, sorted, kept for one grading call (review N1: no full scan per day); the last one before a date,
     counting only dones recorded by asOf, so a later done never moves how an earlier range was planned (review N2). */
  doneDates(state,sid,memo){const c=memo?(memo.__done=memo.__done||new Map()):null;if(c&&c.has(sid))return c.get(sid);const a=[];for(const o of Object.values(state.occurrences))if(o.seriesId===sid&&o.status==='done')a.push(o.date);a.sort();if(c)c.set(sid,a);return a;},
  lastDone(state,sid,date,memo,asOf){
    const a=GoalEngine.doneDates(state,sid,memo),below=x=>{let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<x)lo=m+1;else hi=m;}return lo;};
    let i=below(date)-1;if(asOf){const j=below(addDays(asOf,1))-1;if(j<i)i=j;}return i>=0?a[i]:null;
  },
  /* One due rule for every list (review F2, F3): the version's own days, a date range's bounds for every goal, "N days
     after the last done", and a one-off deadline check that stops being due once it is done. */
  dueFor(state,series,ver,date,memo,asOf){
    if(!ver||!scheduledOn(ver,date))return false;const g=ver.goal;if(!g||g.v!==1)return true;
    if(g.when&&g.when.kind==='after'&&!GoalEngine.afterDue(state,series,ver,date,memo,asOf))return false;
    if(g.when&&g.when.kind==='deadline'&&g.measure.kind==='check'){const l=GoalEngine.lastDone(state,series.id,date,memo,asOf);if(l&&l>=ver.effectiveFrom)return false;}
    return true;
  },
  // Is this version graded once per window (an amount, count or reading; a check over a week, month or range; a one-off deadline)?
  windowed(ver){const g=ver&&ver.goal;return !!g&&g.v===1&&(g.measure.kind!=='check'||(g.period.kind!=='day'||g.when.kind==='deadline')&&ver.recurrence.kind!=='target'&&g.when.kind!=='after');},
  /* M3 (review F1, F4, F5): a windowed goal counts once per window in the grade and the rank: each due day of the window
     carries 1/(the window's due days), paid the credit the window holds at its last day inside the graded range. The due
     days are counted as the plan stood on the range's last day (review N2): a later done never re-weighs a closed range. */
  gradeShare(state,series,ver,d,to,memo){
    const g=ver.goal,w=GoalEngine.window(g,d,ver,state),k=series.id+'|'+w.from+'|'+w.to+'|'+to;
    if(!memo[k]){let due=0;for(let x=w.from;x<=w.to;x=addDays(x,1))if(GoalEngine.dueFor(state,series,versionFor(series,x),x,memo,to))due++;const at=w.to<to?w.to:to;memo[k]={due:Math.max(1,due),credit:(GoalEngine.progress(state,series,at,goalReadings)||{}).credit??0};}
    return {planned:1/memo[k].due,done:memo[k].credit/memo[k].due};
  },
  // M3: the window a period means on a date (weeks start Monday unless he chose Sunday).
  window(g,date,ver,state){
    const p=g.period||{},ws=state&&state.prefs&&state.prefs.weekStart===0?0:1;
    if(ver&&ver.recurrence&&ver.recurrence.kind==='target'&&g.measure.kind==='check'){const rw=recurrenceWindow(ver,date,state);if(rw)return {from:rw.from,to:rw.to};}   // "N times a week": the stored target's own week (review F9)
    if(g.when&&g.when.kind==='deadline'&&g.when.date&&p.kind==='day')return {from:ver&&ver.effectiveFrom<g.when.date?ver.effectiveFrom:g.when.date,to:g.when.date};   // a one-off deadline is one window (review F2)
    if(p.kind==='week'){const pin=p.weekStart===0||p.weekStart===1?p.weekStart:(state&&ver&&typeof wsGoalWeekPin==='function'?wsGoalWeekPin(state,ver):null),a=weekStartOf(date,pin===0||pin===1?pin:ws);return {from:a,to:addDays(a,6)};}   // V3.7 X8: an older week goal keeps its first paid week's alignment, on the page and in the pay
    if(p.kind==='month')return {from:date.slice(0,8)+'01',to:addDays(date.slice(0,8)+'01',new Date(+date.slice(0,4),+date.slice(5,7),0).getDate()-1)};
    if(p.kind==='everyN'){const ps=state?programStartOf(state,date):null,start=ps&&ps<=date?ps:ver&&ver.effectiveFrom||date,k=Math.floor(Math.max(0,calendarDistance(start,date))/p.n),a=addDays(start,k*p.n);return {from:a,to:addDays(a,p.n-1)};}
    if(p.kind==='range')return {from:p.from||date,to:p.to||date};
    if(p.kind==='rolling')return {from:addDays(date,-(p.n-1)),to:date};
    return {from:date,to:date};
  },
  /* M4: automatic values per day for a source, in the goal's unit. Workouts by type and field; the unit is read from each
     record and converted at read time (stored values are never rewritten); a record with no readable unit or no distance
     contributes nothing and is listed. Daily walking + running distance: the day's rollup where it exists, else the sum
     of its buckets. A goal reads ONE source for a quantity, never workouts and daily totals together. */
  autoRecords(state,src,from,to){
    const out=[],skipped=[],types=src.types&&src.types.length?new Set(src.types):null;
    if(src.metric==='workouts'){
      /* V3.7 X2 (audit D-1): one entry per session, never per row. The rows are grouped the way the Fitness Workouts card
         groups them (WorkoutSessions.select with his joins and splits); the watch's record wins and a type filter matches
         any record of the session. A day either side is read so a session that crosses midnight is grouped first. */
      const rows=(state.sourceRecords||[]).concat(ifitWorkoutRows(state)).filter(r=>{if(r.kind!=='workout')return false;const d=sourceLocalDay(r.start);return d>=addDays(from,-1)&&d<=addDays(to,1);});   // V3.7 O3: iFIT file sessions join the grouping
      const WS=globalThis.WorkoutSessions,byId=new Map(rows.map(r=>[r.id,r]));
      const recs=WS?rows.map(r=>[r,WS.record(r,sourceLocalDay(r.start))]):[],lone=WS?recs.filter(x=>!x[1]).map(x=>[x[0]]):[];   // a record with no usable time span stands alone (never dropped)
      const groups=WS?lone.concat(WS.select(recs.map(x=>x[1]).filter(Boolean),(l=>({join:l.join.concat(Object.values(state.ifitSessions||{}).filter(x=>x.linked).map(x=>[x.id,x.linked])),split:l.split}))(workoutLinks(state))).map(w=>[w.id,...w.aliases.map(a=>a.id)].map(id=>byId.get(id)).filter(Boolean))):rows.map(r=>[r]);
      const okRec=x=>{if(src.writers&&src.writers.length&&!src.writers.some(w=>new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i').test(String(x.sourceApp||''))))return false;if(src.outdoor&&!(/outdoor|hik/i.test(String(x.type||''))&&!/indoor|treadmill/i.test(String(x.type||''))))return false;
        const mins=Number.isFinite(x.durationSec)?x.durationSec/60:(Date.parse(x.end)-Date.parse(x.start))/60000;if(src.minMinutes&&!(mins>=src.minMinutes))return false;if(src.hrCoverage&&!(workoutHrCoverage(state,x)>=src.hrCoverage))return false;return true;};
      for(const group of groups){const r0=group[0],d=sourceLocalDay(r0.start);if(d<from||d>to)continue;if(types&&!group.some(x=>types.has(x.type)))continue;if((src.writers||src.outdoor||src.minMinutes||src.hrCoverage)&&!group.some(okRec))continue;   // V3.7 O8
        const r=src.field==='distance'?group.find(x=>{const q=x.unmapped&&x.unmapped.healthAutoExport&&x.unmapped.healthAutoExport.distance;return q&&Number.isFinite(+q.qty)&&GOAL_UNITS[String(q.units||'').toLowerCase()];})||r0:src.field==='energy'?group.find(x=>{const q=x.unmapped&&x.unmapped.healthAutoExport&&x.unmapped.healthAutoExport.activeEnergy;return q&&Number.isFinite(+q.qty);})||r0:r0;
        const m=r.unmapped&&r.unmapped.healthAutoExport||{};
        let v=null;if(src.field==='minutes')v=Number.isFinite(r.durationSec)?r.durationSec/60:null;else if(src.field==='count')v=1;else if(src.field==='energy'){const q=m.activeEnergy;v=q&&Number.isFinite(+q.qty)?+q.qty*(/kj/i.test(q.units||'')?.239006:1):null;}
        else{const q=m.distance;if(!q||!Number.isFinite(+q.qty)){skipped.push({id:r.id,date:d,type:r.type,why:'no distance'});continue;}const f=GOAL_UNITS[String(q.units||'').toLowerCase()];if(!f){skipped.push({id:r.id,date:d,type:r.type,why:'unit unknown'});continue;}v=+q.qty*f*(src.unit==='km'?GOAL_KM_PER_MI:1);}
        if(v===null){skipped.push({id:r.id,date:d,type:r.type,why:'no '+src.field});continue;}
        out.push({sourceId:r0.id,date:d,ts:Date.parse(r0.start),type:r.type,value:v,...(group.length>1?{also:group.slice(1).map(x=>x.id)}:{})});}
    }else if(src.metric==='walking_running_distance'){
      const days=new Map();for(const r of haeRowsFor(state,['walking_running_distance'])){const d=sourceLocalDay(r.start);if(d<from||d>to||!Number.isFinite(r.value))continue;const f=GOAL_UNITS[String(r.unit||'').toLowerCase()];if(!f){skipped.push({id:r.id,date:d,why:'unit unknown'});continue;}const rep=(r.unmapped&&r.unmapped.healthAutoExport||{}).representation||'',x=days.get(d)||{roll:null,sum:0};const v=r.value*f*(src.unit==='km'?GOAL_KM_PER_MI:1);if(/daily|rollup|summary/i.test(rep))x.roll=Math.max(x.roll||0,v);else x.sum+=v;days.set(d,x);}
      for(const [d,x] of days)out.push({sourceId:'wrd:'+d,date:d,ts:Date.parse(d+'T12:00:00'),type:'Daily distance',value:x.roll!==null?x.roll:x.sum});
    }
    return {records:out.sort((a,b)=>a.ts-b.ts),skipped};
  },
  // The sources that exist for what is measured, with counts (the builder lists only these).
  sources(state,measure,unit){
    const out=[],wk=(state.sourceRecords||[]).concat(ifitWorkoutRows(state)).filter(r=>r.kind==='workout'),typeCount=new Map();   // review F7: an iFIT file session is a type he can tick
    for(const r of wk){const t=typeCount.get(r.type)||{type:r.type,records:0,distance:0};t.records++;const q=r.unmapped&&r.unmapped.healthAutoExport&&r.unmapped.healthAutoExport.distance;if(q&&Number.isFinite(+q.qty)&&GOAL_UNITS[String(q.units||'').toLowerCase()])t.distance++;typeCount.set(r.type,t);}
    const types=[...typeCount.values()].sort((a,b)=>b.records-a.records);
    if(measure==='sum'&&['mi','km'].includes(unit)){if(wk.length)out.push({metric:'workouts',field:'distance',count:types.reduce((n,t)=>n+t.distance,0),types});const days=new Set(haeRowsFor(state,['walking_running_distance']).map(r=>sourceLocalDay(r.start)));if(days.size)out.push({metric:'walking_running_distance',count:days.size});}
    else if(measure==='sum'&&unit==='min'&&wk.length)out.push({metric:'workouts',field:'minutes',count:wk.length,types});
    else if(measure==='sum'&&unit==='kcal'&&wk.length)out.push({metric:'workouts',field:'energy',count:wk.length,types});
    else if(measure==='count'&&wk.length)out.push({metric:'workouts',field:'count',count:wk.length,types});
    return out;
  },
  // The entries a goal counts in a window: automatic ones (an edit overrides one, Restore removes the edit), then his own.
  entries(state,series,ver,from,to){
    const g=ver.goal,own=(state.goalEntries&&state.goalEntries[series.id])||[],edits=new Map(own.filter(e=>e.origin==='edited'&&e.sourceId).map(e=>[e.sourceId,e])),merged=new Set(own.filter(e=>e.origin==='merged').map(e=>e.sourceId));
    const auto=g.source&&g.source.kind==='auto'?GoalEngine.autoRecords(state,g.source,from,to):{records:[],skipped:[]};
    const list=auto.records.map(r=>{const e=edits.get(r.sourceId);return {id:'auto:'+r.sourceId,sourceId:r.sourceId,date:r.date,ts:r.ts,type:r.type,origin:e?'edited':'auto',value:e?e.value:r.value,original:r.value,merged:merged.has(r.sourceId)};});
    for(const e of own)if(e.origin==='added'&&e.date>=from&&e.date<=to)list.push({id:e.id,date:e.date,ts:e.ts||Date.parse(e.date+'T12:00:00'),type:e.type||'',origin:'added',value:e.value,note:e.note||''});
    return {list:list.sort((a,b)=>a.ts-b.ts),skipped:auto.skipped};
  },
  /* M3: progress on a date: value, target, share, state (open, met, over, short) and credit, for every measure x target x
     period. `readings(metric, from, to)` supplies daily readings the page owns (sleep hours, water); weight is read here. */
  progress(state,series,date,readings){
    readings=readings||goalReadings;
    const ver=versionFor(series,date);if(!ver||!ver.goal||ver.goal.v!==1)return null;const g=ver.goal,w=GoalEngine.window(g,date,ver,state),upto=w.to<date?w.to:date,closed=date>=w.to;
    let value=0,known=true,count=0;const kind=g.measure.kind;
    if(kind==='check'){for(let d=w.from;d<=upto;d=addDays(d,1)){const o=state.occurrences[occKey(series.id,d)];if(o&&o.status==='done')value+=1;else if(o&&o.status==='partial')value+=.5;}}
    else if(kind==='count'||kind==='sum'){const e=GoalEngine.entries(state,series,ver,w.from,upto);for(const x of e.list)value+=kind==='count'&&x.origin==='added'?(Number.isFinite(x.value)?x.value:1):x.value;count=e.list.length;}
    else{const rows=GoalEngine.readings(state,g.measure.reading,w.from,upto,readings);if(!rows.length){known=false;value=null;}else if(kind==='average'){value=rows.reduce((n,r)=>n+r.value,0)/rows.length;}else value=rows[rows.length-1].value;count=rows.length;}
    const t=g.target||{},tv=kind==='check'?(g.period.kind==='day'?1:Math.max(1,t.value||1)):t.value;
    let share=0,met=false,over=false;
    if(value!==null){
      if(kind==='average'||kind==='latest'){met=t.op==='atMost'?value<=tv:t.op==='between'?value>=tv&&value<=t.value2:t.op==='exactly'?Math.abs(value-tv)<1e-9:value>=tv;share=met?1:t.op==='atMost'||(t.op==='between'&&value>t.value2)?(value>0?Math.min(1,(t.op==='between'?t.value2:tv)/value):0):(tv?Math.min(1,value/tv):0);}   // a reading against its target: never a limit, never "over"
      else if(t.op==='atMost'){met=value<=tv;over=value>tv;share=tv>0?Math.min(1,value/tv):value>0?1:0;}
      else if(t.op==='between'){met=value>=tv&&value<=t.value2;over=value>t.value2;share=value<tv?(tv?value/tv:0):over?0:1;}
      else if(t.op==='exactly'){met=Math.abs(value-tv)<1e-9;share=tv?Math.min(1,value/tv):0;over=value>tv;}
      else{met=value>=tv;share=tv?Math.min(1,value/tv):met?1:0;}
    }
    // Credit at the period's end: a limit pays only if it held; proportional pays the share; half pays ½ for a start.
    const reading=kind==='average'||kind==='latest',cr=reading?(g.credit==='proportional'?share:met?1:0):t.op==='atMost'||t.op==='between'||t.op==='exactly'?(met?1:0):g.credit==='proportional'?share:g.credit==='half'?(met?1:value>0?.5:0):(met?1:0);
    // "3 times a week by Friday": after the due day an unmet target is overdue (it still counts if he finishes it).
    const byDay=g.when.kind==='by'?addDays(w.from,(g.when.by-dow(w.from)+7)%7):null,overdue=!!byDay&&!met&&date>byDay;   // after the due day inside its own window (review F9)
    const state1=value===null?'open':over&&t.op==='atMost'&&!reading?'over':met?'met':overdue?'overdue':closed?'short':'open';
    return {value,target:tv,target2:t.value2,op:t.op,unit:g.measure.unit,share,met,over,state:state1,credit:t.op==='atMost'&&!reading?(closed?cr:over?0:1):cr,known,count,window:w,closed,measure:kind};
  },
  readings(state,reading,from,to,provider){
    if(reading==='weight')return weightRowsLb(state,to).filter(r=>r.date>=from).map(r=>({date:r.date,value:r.lb}));
    const m=provider?provider(reading,from,to):null;return m?[...m].filter(([d,v])=>d>=from&&d<=to&&Number.isFinite(v)).sort(([a],[b])=>a.localeCompare(b)).map(([date,value])=>({date,value})):[];
  },
  /* M5: a hand entry adds to the total. Within 20 minutes of a watch workout the same day it asks "Same run? Merge"
     (ASSUMED A13): the caller passes decide:'merge' (the watch's run counts once) or 'keep' (both count). */
  addEntry(state,series,entry,decide){
    const ver=versionFor(series,entry.date);if(!ver||!ver.goal)return {ok:false,error:'This item has no goal.'};
    if(!validCalendarDate(entry.date)||!(Number.isFinite(+entry.value)&&+entry.value>0))return {ok:false,error:'Enter an amount above zero and a real date.'};
    const ts=Number.isFinite(entry.ts)?entry.ts:Date.parse(entry.date+'T12:00:00');
    if(!decide&&ver.goal.source&&ver.goal.source.kind==='auto'&&ver.goal.source.metric==='workouts'){const same=GoalEngine.entries(state,series,ver,entry.date,entry.date).list.find(x=>x.origin!=='added'&&!x.merged&&Math.abs(x.ts-ts)<=20*60000);if(same)return {ok:false,ask:'merge',match:same};}
    state.goalEntries=state.goalEntries||{};const list=state.goalEntries[series.id]=state.goalEntries[series.id]||[];
    if(decide==='merge'){const m=GoalEngine.entries(state,series,ver,entry.date,entry.date).list.find(x=>x.origin!=='added'&&!x.merged&&Math.abs(x.ts-ts)<=20*60000);if(m){list.push({id:newId('ge'),origin:'merged',sourceId:m.sourceId,date:entry.date,ts});return {ok:true,merged:m.sourceId};}}
    const e={id:newId('ge'),origin:'added',date:entry.date,ts,value:Math.round(+entry.value*1000)/1000,unit:ver.goal.measure.unit||'',...(entry.type?{type:String(entry.type).slice(0,40)}:{}),...(entry.note?{note:String(entry.note).slice(0,200)}:{})};
    list.push(e);return {ok:true,entry:e};
  },
  // Any automatic entry can be edited (the original is kept; Restore puts it back); a hand entry can be edited or removed.
  editEntry(state,series,id,value){
    if(!(Number.isFinite(+value)&&+value>=0))return {ok:false,error:'Enter an amount of zero or more.'};
    state.goalEntries=state.goalEntries||{};const list=state.goalEntries[series.id]=state.goalEntries[series.id]||[];
    if(id.startsWith('auto:')){const sid=id.slice(5),e=list.find(x=>x.origin==='edited'&&x.sourceId===sid);if(e){e.value=+value;return {ok:true};}const r=(state.sourceRecords||[]).find(x=>x.id===sid),date=r?sourceLocalDay(r.start):/^wrd:/.test(sid)?sid.slice(4):null;if(!validCalendarDate(date))return {ok:false,error:'That record is gone.'};list.push({id:newId('ge'),origin:'edited',sourceId:sid,date,value:+value});return {ok:true};}
    const e=list.find(x=>x.id===id&&x.origin==='added');if(!e)return {ok:false,error:'That entry is gone.'};e.value=+value;return {ok:true};
  },
  restoreEntry(state,series,id){const list=(state.goalEntries||{})[series.id]||[],sid=id.replace(/^auto:/,''),i=list.findIndex(x=>x.origin==='edited'&&x.sourceId===sid);if(i<0)return {ok:false,error:'Nothing to restore.'};list.splice(i,1);return {ok:true};},
  removeEntry(state,series,id){const list=(state.goalEntries||{})[series.id]||[],i=list.findIndex(x=>x.id===id&&x.origin==='added');if(i<0)return {ok:false,error:'Only your own entries can be removed.'};list.splice(i,1);return {ok:true};},
  // The plain-language summary the builder ends in (the Draft's words).
  summary(g,auto){
    const RD={sleep:'sleep hours',weight:'weight',rhr:'resting heart rate',hrv:'hrv',nutrition:'Nutrition Grade (last 7 closed days)'},WD=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],ord=n=>n+(['th','st','nd','rd'][(n%100-20)%10]||['th','st','nd','rd'][n%100]||'th'),md=s=>{const d=parseYmd(s);return d.toLocaleDateString('en-US',{month:'short',day:'numeric'});};
    const u=g.measure.unit?' '+g.measure.unit:'',t=g.target||{},nf=v=>(Math.round(v*100)/100).toLocaleString('en-US');
    const tt=t.op==='atMost'?'at most '+nf(t.value)+u:t.op==='between'?'between '+nf(t.value)+' and '+nf(t.value2)+u:t.op==='exactly'?'exactly '+nf(t.value)+u:'at least '+nf(t.value)+u;
    const p=g.period,pt={day:'each day',week:'each week',month:'each month',everyN:'every '+p.n+' days',range:p.from&&p.to?'between '+md(p.from)+' and '+md(p.to):'in a date range',rolling:'in any rolling '+p.n+' days'}[p.kind];
    const w=g.when,wt=w.kind==='days'?'on '+(w.days.length===1?WD[w.days[0]]+'s':w.days.map(d=>WD[d].slice(0,3)).join(', ')):w.kind==='by'?'done by '+WD[w.by]+'; it turns overdue after '+WD[w.by]:w.kind==='monthday'?'on the '+ord(w.monthday)+' of the month':w.kind==='nthweekday'?'on the '+(w.nth===-1?'last':ord(w.nth))+' '+WD[w.weekday]+' of the month':w.kind==='after'?w.after+' days after you last did it':w.kind==='season'?(w.seasons||[]).map(r=>r.days.map(d=>WD[d].slice(0,3)).join(', ')+' from '+md(r.from)+' to '+md(r.to)).join('; then '):w.kind==='deadline'&&w.date?'due '+md(w.date):'';
    const cap=s=>s.charAt(0).toUpperCase()+s.slice(1),m=g.measure.kind;let s;
    if(m==='check')s=w.kind==='after'?'Check it off '+w.after+' days after you last did it; the clock restarts each time you finish it':w.kind==='deadline'?'Check it off once, '+wt:'Check it off '+(p.kind==='day'?'every day':p.kind==='week'?(t.value>1?nf(t.value)+' times each week':'once each week'):p.kind==='month'?(t.value>1?nf(t.value)+' times each month':'once each month'):pt)+(wt&&w.kind!=='any'?', '+wt:'');
    else if(m==='count'||m==='sum')s=cap(tt)+' '+pt+(m==='sum'?', adding up what '+(g.source.kind==='auto'?'comes in':'you enter'):'')+(t.op==='atMost'?' (a limit)':'')+(w.kind==='any'?', any day':wt?', '+wt:'');
    else if(m==='average')s='Average '+(RD[g.measure.reading]||g.measure.reading||'reading')+' '+tt+' '+pt+(wt?', '+wt:'');
    else s='Latest '+(RD[g.measure.reading]||g.measure.reading||'reading')+' '+tt+' '+(w.kind==='deadline'&&w.date?'by '+md(w.date):pt);
    if(g.source&&g.source.kind==='auto'&&auto)s+='; automatic from '+auto;
    return s+'. '+({all:'All or nothing.',proportional:'Credit in proportion to the share reached.',half:'Half credit when partly done.'})[g.credit];
  }
};

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
  if (ver.goal && ver.goal.v === 1 && ver.goal.period && ver.goal.period.kind === 'range' && ((ver.goal.period.from && date < ver.goal.period.from) || (ver.goal.period.to && date > ver.goal.period.to))) return false;   // V3.6 M2 (review F3)
  if (ver.goal && ver.goal.v === 1 && typeof GoalEngine !== 'undefined' && ver.goal.when && ver.goal.when.kind !== 'any' && ver.goal.when.kind !== 'days') return date >= ver.effectiveFrom && GoalEngine.dueOn(ver.goal, date, ver);   // V3.6 M2
  const r = ver.recurrence || {};
  if (r.kind === 'once') return !ver.needsDate && r.date === date;   // AG2: an "I set each date" item with no date yet is on no day
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
    const scheduled = GoalEngine.dueFor(state, s, ver, date);   // V3.6 M2
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
function flatPlanFor(state, date){
  const held=drawMemo&&drawMemo.state===state,rows=leafRows(held?planForDraw(state,date):planFor(state,date)).filter(r=>!confirmedProgression(state)||!r.aliasOf);
  return held?structuredClone(rows):rows;
}
function findPlanRow(state, seriesId, date){
  const held=drawMemo&&drawMemo.state===state,rows=held?planForDraw(state,date):planFor(state,date),row=allRows(rows).find(r=>r.seriesId===seriesId)||null;
  return held&&row?structuredClone(row):row;
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
/* "Not today" and "Exempt" (Mintay, Sept 24 evening) are neutral: the day is not required and never
   counts as missed. A daily item is Skipped instead; an item on set days moves to tomorrow when it can. */
function dailyItem(state, seriesId, date){
  const s = state.series.find(x => x.id === seriesId), v = s && versionFor(s, date), r = (v && v.recurrence) || {};
  return r.kind === 'weekly' && (r.days || []).length === 7 && !(r.intervalWeeks > 1);
}
function excuseOcc(state, seriesId, date, why){
  const row = findPlanRow(state, seriesId, date);
  if (!row || row.children) return null;
  const o = ensureOcc(state, seriesId, date);
  if (o.status === 'done' || o.removed) return null;
  o.status = null; o.confirmation = null; o.completedVersion = null;
  o.disposition = 'excused'; o.excuse = why === 'exempt' ? 'exempt' : 'not-today';
  touch(o);
  return o;
}
function unexcuseOcc(state, seriesId, date){
  const k = occKey(seriesId, date), o = state.occurrences[k];
  if (!o || o.disposition !== 'excused') return null;
  delete o.disposition; delete o.excuse; touch(o); pruneOcc(state, k);
  return o;
}
function notToday(state, seriesId, date){
  if (dailyItem(state, seriesId, date)) return { ok:false, error:'A daily item is marked Skipped instead.' };
  const s = state.series.find(x => x.id === seriesId), v = s && versionFor(s, date);
  if (v && v.recurrence && v.recurrence.kind !== 'target' && moveOcc(state, seriesId, date, addDays(date, 1))) return { ok:true, moved:true };
  return { ok:!!excuseOcc(state, seriesId, date, 'not-today'), moved:false };
}
function pruneOcc(state, k){
  const o = state.occurrences[k];
  if (o && o.status === null && !o.disposition && o.selected === 'normal' && !o.removed && !o.added &&
      !o.override && !o.note && o.actualMinutes === null && !o.corrections.length && (!o.rewardEventId || o.rewardEventId === k) &&
      // A claimed occurrence stays, so its pinned rule survives an un-mark and a later re-mark pays under it (V3.1).
      !(state.rewards && state.rewards.claims && state.rewards.claims[typeof rewardIdentity === 'function' ? rewardIdentity(state, o) : k])) delete state.occurrences[k];
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
  for(const key of ['parentId','category','workspaceKind','budgetQ','deadlineDay','setEach','needsDate','secondChance'])if(Object.prototype.hasOwnProperty.call(f,key))out[key]=f[key];   // AG2: setEach (I set each date), needsDate (no date yet), secondChance (Night after 7 PM)
  if (f.goal && typeof GoalEngine !== 'undefined'){ const g = GoalEngine.normalize(f.goal); if (g){ out.goal = g; if (g.v === 1 && !(f.recurrence && f.recurrence.kind === 'once')) out.recurrence = normalizeRecurrence(GoalEngine.legacyRecurrence(g, effectiveFrom), effectiveFrom); } }   // V3.6 M1
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
/* Fix H3 (Mintay, Oct 6): one window rule. An item with a period counts in fixed blocks: a week is the calendar week (the Week setting's
   first day), a longer period is 4-week-style blocks counted from the Program start, and the blocks move with it. A stored "rolling" mode is
   honoured, except for Church, which is always fixed blocks. Without `state` (a caller that has none) the older anchor is the start date. */
function recurrenceWindow(ver, date, state){
  const r = ver.recurrence || {};
  if (r.kind !== 'target') return null;
  const span = r.weeks * 7, anchor = r.startDate || ver.effectiveFrom;
  if (date < anchor) return null;
  if (state && !(r.mode === 'rolling' && ver.workspaceKind !== 'church')){
    if (r.weeks === 1){ const ws = weekStartOf(date, state.prefs && state.prefs.weekStart === 0 ? 0 : 1); return { from:ws, to:addDays(ws, 6), mode:'fixed', target:r.count }; }
    const b = programBlockOf(state, date, r.weeks); if (b) return { from:b.from, to:b.to, mode:'fixed', target:r.count };
  }
  const from = r.mode === 'rolling' && ver.workspaceKind !== 'church' ? (addDays(date, 1-span) < anchor ? anchor : addDays(date, 1-span)) : addDays(anchor, Math.floor(calendarDistance(anchor, date) / span) * span);
  return { from, to:r.mode === 'rolling' && ver.workspaceKind !== 'church' ? date : addDays(from, span-1), mode:r.mode === 'rolling' && ver.workspaceKind !== 'church' ? 'rolling' : 'fixed', target:r.count };
}
/* A read-only index that lives for one synchronous screen draw. The UI opens it around render(),
   when the record cannot change, so repeated per-row scans of every occurrence happen once. */
let drawMemo=null;
function withDrawMemo(state,fn){const outer=drawMemo;drawMemo={state,occBySeries:null};try{return fn();}finally{drawMemo=outer;}}
function occurrencesOf(state,seriesId){
  if(!drawMemo||drawMemo.state!==state)return Object.values(state.occurrences).filter(o=>o.seriesId===seriesId);
  if(!drawMemo.occBySeries){drawMemo.occBySeries=new Map();for(const o of Object.values(state.occurrences)){const list=drawMemo.occBySeries.get(o.seriesId);if(list)list.push(o);else drawMemo.occBySeries.set(o.seriesId,[o]);}}
  return drawMemo.occBySeries.get(seriesId)||[];
}
function targetProgress(state, seriesId, date){
  const s = state.series.find(x => x.id === seriesId), v = s && versionFor(s, date);
  const window = v && recurrenceWindow(v, date, state);
  if (!window) return null;
  const events = new Set(occurrencesOf(state,seriesId).filter(o => o.date >= window.from && o.date <= window.to && o.date <= date && o.status === 'done' && (!confirmedProgression(state)||actionConfirmation(state,o).confirmed)).map(o => o.rewardEventId || occKey(o.seriesId, o.date)));
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
/* V3.4 (S7): a stack, not one snapshot. Each reversible action pushes the record as it was before it; Cmd/Ctrl+Z or
   the toast's Undo pops one step. A change that is not itself undoable (an intake file, typing, a restore) clears the
   stack, because an older snapshot would also rewind that change. */
const UNDO_DEPTH = 25;
let undoStack = [];
function undoSnapshot(state, label){
  // Frozen source rows cannot change in place, so the undo copy keeps them by reference (V3.0).
  const shared = Array.isArray(state.sourceRecords) && sealedRows(state.sourceRecords) ? state.sourceRecords : null;
  return { label, snap: JSON.stringify(shared ? Object.assign({}, state, {sourceRecords: []}) : state), sources: shared };
}
let undoSeq = 0;
function pushUndo(entry){ entry.seq = ++undoSeq; undoStack.push(entry); if (undoStack.length > UNDO_DEPTH) undoStack.shift(); }
function undoTopSeq(){ return undoStack.length ? undoStack[undoStack.length - 1].seq : 0; }   // identifies the newest entry; depth alone repeats (review finding, Oct 1)
function stage(state, label){ pushUndo(undoSnapshot(state, label)); }
function canUndo(){ return undoStack.length > 0; }
function undoDepth(){ return undoStack.length; }
function undoLabel(){ return undoStack.length ? undoStack[undoStack.length - 1].label : ''; }
function undo(state){
  const undoEntry = undoStack[undoStack.length - 1];
  if (!undoEntry) return false;
  const prev = JSON.parse(undoEntry.snap);
  if (undoEntry.sources) prev.sourceRecords = undoEntry.sources;
  if (state.rewards && prev.rewards){
    const ledger = JSON.parse(JSON.stringify(state.rewards));
    for (const [id,e] of Object.entries(ledger.evidence)){
      if (!prev.rewards.evidence[id]) { e.retractedAt = nowIso(); e.updatedAt = e.retractedAt; }
      else if (JSON.stringify(e) !== JSON.stringify(prev.rewards.evidence[id])) ledger.evidence[id] = Object.assign({},prev.rewards.evidence[id],{updatedAt:nowIso()});
    }
    mergeRewardLedger(prev,{rewards:ledger});
  }
  prev.revision=state.revision||0;
  if (state.vo2Ledger) prev.vo2Ledger = JSON.parse(JSON.stringify(state.vo2Ledger));   // V3.7 review F6: the VO2 ledger is a log of frozen claims; an undo never removes a row
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, prev);
  undoStack.pop();
  return true;
}
/* V3.5 F2 (V34-I16): the days an undo would change that have closed since (a snapshot taken before a day auto-closed
   would otherwise reopen it silently); the caller refuses the undo and says which day. */
function undoTouches(state, isClosed){
  const e = undoStack[undoStack.length - 1]; if (!e) return [];
  const prev = JSON.parse(e.snap).occurrences || {}, cur = state.occurrences || {}, out = new Set();
  for (const k of new Set(Object.keys(prev).concat(Object.keys(cur)))){
    if (JSON.stringify(prev[k]) === JSON.stringify(cur[k])) continue;
    const d = (prev[k] || cur[k]).date || String(k).split('|')[1]; if (d && isClosed(d)) out.add(d);
  }
  return [...out].sort();
}
function dropUndo(){ undoStack = []; }   // a change that cannot be undone: older snapshots would revert it too
function popUndo(){ undoStack.pop(); }   // a staged action that was refused drops only its own snapshot (review finding, Oct 1)

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
// A group the V2 structure retired stays for earlier days but leaves today's lists once it is empty.
function visibleGroups(state, date){ const d = date || todayYmd(); return groupsOf(state).filter(g => !g.hidden && !(g.retiredFrom && d >= g.retiredFrom)); }
function groupById(state, id){ return state.groups.find(g => g.id === id) || null; }
// V3.5 (review S2): a hide is dated, so earlier days keep the group in their lists and Perfect verdicts; a Show keeps the
// stretch it was hidden as a range (hiddenRanges, additive) so those days stay as they were.
function setGroupHidden(state, id, hidden, from){ const g = groupById(state, id); if (!g) return null; g.hidden = !!hidden; if (g.hidden){ if (!g.hiddenFrom) g.hiddenFrom = /^\d{4}-\d{2}-\d{2}$/.test(from || '') ? from : todayYmd(); } else if (g.hiddenFrom){ const to = addDays(todayYmd(), -1); if (g.hiddenFrom <= to) g.hiddenRanges = (Array.isArray(g.hiddenRanges) ? g.hiddenRanges : []).concat({from:g.hiddenFrom, to}); delete g.hiddenFrom; } g.updatedAt = nowIso(); return g; }
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
/* Overall Rank, connected (Mintay, 2026-09-24): each category's share of its required activities done
   over the last 28 complete days (or since scoring started, if later), weighted by the existing 10/9
   importance. A category with nothing scheduled shows no letter and stays out of the overall rather
   than blocking it. Arcade-style ladder: A is excellent; S, SS and SSS are the elite 15 %. */
const RANK_SLOTS={fitness:['fitness','health-physical'],food:['food'],care:['care','personal-care','hygiene','home','health-mental'],faith:['faith'],work:['work']};
const RANK_CUTOFFS=[[95,'SSS'],[90,'SS'],[85,'S'],[80,'A'],[70,'B'],[55,'C'],[40,'D'],[0,'F']];
/* V2.0 rank sections (Mintay, Sept 25), used once the V2 structure is adopted: grades by umbrella;
   Hobbies is not graded. Weights default to Faith 10, others 9; a weight he sets is kept. */
const RANK_SECTIONS_V2=['faith','health','hygiene','relationship','career'];
const RANK_SLOTS_V2={faith:['faith'],health:['personal-health','fitness','food','health-mental','wellbeing','health-physical','personal-care','hygiene','care'],hygiene:['trash-day','laundry','cleaning','home'],relationship:['relationship'],career:['work']};
const RANK_WEIGHTS_V2={faith:10,health:9,hygiene:9,relationship:9,career:9};
function rankLetter(pct){return Number.isFinite(pct)?RANK_CUTOFFS.find(([c])=>pct>=c)[1]:null;}

function overallRankReport(state,today,windowKind,range,sections){
  // Window (Mintay, Sept 24 evening): the last 28 complete days by default, or this week so far.
  // V2.0 adds Day (today so far) and weeks that start Monday unless he chose Sunday.
  const start=state.rewards&&state.rewards.progression&&state.rewards.progression.effectiveFrom;let to=windowKind==='day'?today:addDays(today,-1),from=windowKind==='day'?today:windowKind==='week'?weekStartOf(today,state.prefs&&state.prefs.weekStart===0?0:1):addDays(to,-27);
  if(windowKind==='range'&&range&&validCalendarDate(range.from)&&validCalendarDate(range.to)){from=range.from;to=range.to;}
  if(start&&start>from)from=start;if(to<from){from=today;to=today;}
  // A weekly goal (prayer 3 days a week, church once in four weeks) counts against its goal, pro-rated
  // to the days counted and capped there, so meeting the goal is 100 % rather than 3 of 7.
  const v2=(state.workspace?.migrations||[]).some(m=>m.status==='active'&&m.structureV2),SLOTS=sections?sections.slots:v2?RANK_SLOTS_V2:RANK_SLOTS;
  // A card he made himself (V3.2) is graded with its umbrella; Hobbies stays outside the rank, as its own card does.
  const UMBRELLA_SLOT=v2?{faith:'faith',health:'health','home-care':'hygiene',relationship:'relationship',career:'career'}:{faith:'faith',health:'care','home-care':'care',relationship:'care',career:'work'};
  const tally={},goals={},goalMemo={},unassigned=[],slotOf=c=>Object.keys(SLOTS).find(k=>SLOTS[k].includes(c))||(sections?null:UMBRELLA_SLOT[((state.groups||[]).find(g=>g.id===c)||{}).umbrella]),span=calendarDistance(from,to)+1;
  // Scoring V2: a measured item counts by its share of the target, not all or nothing.
  const share=(r,d)=>{if(r.status==='partial')return .5;   /* V3.6 I2 (V36-I19): half credit, as Rank history counted it */
    if(r.status!=='done'||typeof v5Rule!=='function')return r.status==='done'?1:0;const t=v5Rule(state,d),series=t&&state.series.find(x=>x.id===r.seriesId);if(!series||!v5Kind(versionFor(series,d)))return 1;const m=v5Inputs(state,series,state.occurrences[occKey(r.seriesId,d)]||{seriesId:r.seriesId,date:d},t);return m?m.credit.n/m.credit.d:1;};
  for(let d=from;d<=to;d=addDays(d,1))for(const r of allRows(planFor(state,d))){
    if(r.children&&r.children.length)continue;
    const slot=slotOf(r.category);if(!slot){unassigned.push({seriesId:r.seriesId,name:r.name,date:d,category:r.category||null});continue;}   // V3.5 G6 (V35-I8): never silently dropped; reported
    const series=state.series.find(x=>x.id===r.seriesId),rec=series&&versionFor(series,d)?.recurrence;
    { const gv=series&&versionFor(series,d); if(GoalEngine.windowed(gv)&&!r.optional){ const sh=GoalEngine.gradeShare(state,series,gv,d,to,goalMemo),t=tally[slot]=tally[slot]||{planned:0,done:0}; t.planned+=sh.planned; t.done+=sh.done; continue; } }   // V3.6 M3: the rank counts a goal as the grade does (review F1)
    if(rec&&rec.kind==='target'&&rec.count>0){const g=goals[r.seriesId]=goals[r.seriesId]||{seriesId:r.seriesId,slot,count:rec.count,weeks:rec.weeks||1,done:0};if(r.status==='done')g.done++;else if(r.status==='partial')g.done+=.5;continue;}
    if(r.optional)continue;
    const t=tally[slot]=tally[slot]||{planned:0,done:0};t.planned++;t.done+=share(r,d);
  }
  for(const g of Object.values(goals)){const blk=targetBlockShare(state,g.seriesId,{count:g.count,weeks:g.weeks},from,to),expected=blk?blk.planned:g.count*span/(7*g.weeks),t=tally[g.slot]=tally[g.slot]||{planned:0,done:0};t.planned+=expected;t.done+=blk?blk.done:Math.min(g.done,expected);}
  const settings=state.grades||defaultGradeSettings();let weights=0,sum=0;
  const slots=(sections?sections.order:v2?RANK_SECTIONS_V2:GRADE_CATEGORIES).map(gid=>{const t=tally[gid],pct=t&&t.planned?100*t.done/t.planned:null,w=sections?sections.weights[gid]:v2?(settings.included[gid]===false?0:settings.weights[gid]??RANK_WEIGHTS_V2[gid]):settings.included[gid]?settings.weights[gid]:0;if(pct!==null&&w){weights+=w;sum+=pct*w;}return {gid,planned:t?t.planned:0,done:t?t.done:0,pct,letter:rankLetter(pct),weight:w,included:sections?true:v2?settings.included[gid]!==false:!!settings.included[gid]};});
  const overall=weights?sum/weights:null;
  return {from,to,slots,overall,letter:rankLetter(overall),sections:sections?'body':v2?'v2':'v1',unassigned};
}

/* ---- V3.5 G1, the grade engine (brief §1.3, "Faith counts once"). One module every grade card calls; scores are
   computed on each draw and never stored. Item = its done share over its due days (weekly targets pro-rated, measured
   items by their credit, as overallRankReport does); group = importance-weighted mean of its items; umbrella own =
   importance-weighted mean of its groups; Overall = importance-weighted mean of the umbrellas' own scores. Anything
   with nothing due in the period is skipped, never counted as zero. The 🙏 blend on an umbrella card is display only:
   displayed = (1 − s) × own + s × Faith; it never changes the Overall. Additive store: `state.gradeConfig` holds
   importance (0–10) and include flags per umbrella, group and item, the 🙏 toggle and share per umbrella, and whether
   Hobbies is graded; stored umbrella ids never change (home-care shows as Home, relationship as Social). ---- */
const GRADE_UMBRELLAS=[
  {id:'faith',name:'Faith',emoji:'🙏',importance:10,stored:['faith']},
  {id:'health',name:'Health',emoji:'💪',importance:8,stored:['health']},
  {id:'family',name:'Family',emoji:'👪',importance:7,stored:['family']},
  {id:'career',name:'Career',emoji:'💼',importance:6,stored:['career']},
  {id:'home',name:'Home',emoji:'🏠',importance:6,stored:['home-care','home']},
  {id:'social',name:'Social',emoji:'🤝',importance:6,stored:['relationship','social']},
  {id:'hobbies',name:'Hobbies',emoji:'🎨',importance:4,stored:['hobbies']}
];
const GRADE_ITEM_IMPORTANCE=5,GRADE_GROUP_IMPORTANCE=5,GRADE_FAITH_SHARE=.2,GRADE_PROGRAM_START='2026-09-21';
// Groups from before the V2 structure carry no umbrella field; the V2 card order already says where they belong.
const GRADE_GROUP_FALLBACK={fitness:'health',food:'health','health-physical':'health','personal-care':'health',hygiene:'health','health-mental':'health',wellbeing:'health','personal-health':'health',home:'home','trash-day':'home',laundry:'home',cleaning:'home',faith:'faith',work:'career',relationship:'social',interests:'hobbies'};
const gradeUmbrellaOfStored=u=>(GRADE_UMBRELLAS.find(x=>x.stored.includes(u))||{}).id||null;
// The stored id a canonical umbrella is written as when a group moves (an id already in the store wins).
const gradeStoredUmbrella=id=>({home:'home-care',social:'relationship'})[id]||id;
function gradeConfig(state){
  const c=state&&state.gradeConfig&&typeof state.gradeConfig==='object'?state.gradeConfig:{};
  return {umbrellas:c.umbrellas||{},groups:c.groups||{},items:c.items||{},hobbies:c.hobbies===true};
}
function gradeGroupUmbrella(state,gid){
  const g=(state.groups||[]).find(x=>x.id===gid);
  if(g&&g.umbrella)return gradeUmbrellaOfStored(g.umbrella);
  if(gid==='care')return (state.workspace?.migrations||[]).some(m=>m.status==='active'&&m.structureV2)?'health':'home';
  return GRADE_GROUP_FALLBACK[gid]||null;
}
const gradeUmbrellaSettings=(cfg,id)=>{const u=GRADE_UMBRELLAS.find(x=>x.id===id),c=cfg.umbrellas[id]||{};
  return {importance:Number.isFinite(c.importance)?c.importance:u.importance,included:id==='hobbies'?cfg.hobbies&&c.included!==false:c.included!==false,faith:id!=='faith'&&c.faith!==false,faithShare:Number.isFinite(c.faithShare)?c.faithShare:GRADE_FAITH_SHARE};};
/* V3.7 Y1 (notes 20, 21; A6, A7, A63): the period is anchored on the selected date, not on today. Week is the calendar week to
   the anchor (or, with the Week setting's "Last 7 days", the 7 days ending on it); Month the calendar month to it; All the
   Program start to it. The closed-days rule (a window that reaches today stops at yesterday) applies only when the anchor is
   the real today. Nothing ends after today. */
function gradePeriod(state,anchor,period,range,opts){
  const real=todayYmd(),today=anchor&&anchor<real?anchor:real,prog=programStartOf(state,today);   // V3.6 S5: the one Program start (V36-I17)
  let from=today,to=today,live=false;
  if(period==='week')from=opts&&opts.week==='last7'?addDays(today,-6):weekStartOf(today,state.prefs&&state.prefs.weekStart===0?0:1);
  else if(period==='month')from=today.slice(0,8)+'01';
  else if(period==='all')from=prog;
  else if(period==='custom'&&range&&validCalendarDate(range.from)&&validCalendarDate(range.to)){from=range.from<range.to?range.from:range.to;to=range.from<range.to?range.to:range.from;}
  if(anchor&&anchor<real&&(period==='week'||period==='month')){const full=period==='week'?addDays(from,6):from.slice(0,8)+String(new Date(+from.slice(0,4),+from.slice(5,7),0).getDate()).padStart(2,'0');to=full;}   // R1: a past day's Week or Month is the whole calendar span, days after today left out below
  if(to>real)to=real;
  if(['week','month','all'].includes(period)&&to===real&&from<real){to=addDays(real,-1);live=true;}   // review: closed days only, as the old rank did; Day is today so far
  if(from>to)from=to;
  return {from,to,program:prog,live};
}
// The rows a grade reads: every leaf due in the window, with its done share. Weekly targets are one row each, pro-rated.
function gradeRows(state,from,to){
  const share=(r,d)=>{if(r.status==='partial')return .5;   /* V3.6 I2 (V36-I19): half credit, as Rank history counted it */
    if(r.status!=='done'||typeof v5Rule!=='function')return r.status==='done'?1:0;const t=v5Rule(state,d),series=t&&state.series.find(x=>x.id===r.seriesId);if(!series||!v5Kind(versionFor(series,d)))return 1;const m=v5Inputs(state,series,state.occurrences[occKey(r.seriesId,d)]||{seriesId:r.seriesId,date:d},t);return m?m.credit.n/m.credit.d:1;};
  const items=new Map(),goals=new Map(),span=calendarDistance(from,to)+1,goalMemo={};
  for(let d=from;d<=to;d=addDays(d,1))for(const r of allRows(planFor(state,d))){
    if(r.children&&r.children.length)continue;
    const gid=r.category||r.group||null,series=state.series.find(x=>x.id===r.seriesId),rec=series&&versionFor(series,d)?.recurrence;
    // V3.6 M3: an amount, count or reading goal counts once per its window (1/L a day over a window of L days), paid the
    // credit it holds at the latest day of the window inside the graded range; a check goal stays occurrence-based.
    const gv=series&&versionFor(series,d);if(GoalEngine.windowed(gv)&&!r.optional){const sh=GoalEngine.gradeShare(state,series,gv,d,to,goalMemo);const it=items.get(r.seriesId)||{seriesId:r.seriesId,name:r.name,gid,planned:0,done:0,goal:true};it.planned+=sh.planned;it.done+=sh.done;items.set(r.seriesId,it);continue;}
    if(rec&&rec.kind==='target'&&rec.count>0){const g=goals.get(r.seriesId)||{seriesId:r.seriesId,name:r.name,gid,count:rec.count,weeks:rec.weeks||1,done:0};if(r.status==='done')g.done++;else if(r.status==='partial')g.done+=.5;goals.set(r.seriesId,g);continue;}
    if(r.optional)continue;
    const it=items.get(r.seriesId)||{seriesId:r.seriesId,name:r.name,gid,planned:0,done:0};it.planned++;it.done+=share(r,d);items.set(r.seriesId,it);
  }
  // Review S3: pro-rated over the days the target existed in this window (from its first version to its archive), not since the window began.
  const liveSpan=g=>{const s=state.series.find(x=>x.id===g.seriesId),starts=(s&&s.versions||[]).filter(v=>v.recurrence&&v.recurrence.kind==='target').map(v=>v.effectiveFrom).filter(validCalendarDate).sort(),a=starts[0]&&starts[0]>from?starts[0]:from,end=s&&validCalendarDate(String(s.archivedAt||'').slice(0,10))&&s.archivedAt.slice(0,10)<=to?addDays(s.archivedAt.slice(0,10),-1):to;return end<a?1:calendarDistance(a,end)+1;};
  // An item that was daily before it became a weekly target keeps its daily days; the target adds its share (review re-check).
  for(const g of goals.values()){const blk=targetBlockShare(state,g.seriesId,{count:g.count,weeks:g.weeks},from,to),expected=blk?blk.planned:g.count*liveSpan(g)/(7*g.weeks),got=blk?blk.done:Math.min(g.done,expected),prev=items.get(g.seriesId);items.set(g.seriesId,{seriesId:g.seriesId,name:g.name,gid:g.gid,planned:(prev?prev.planned:0)+expected,done:(prev?prev.done:0)+got,target:true});}   // H3: a block-met target counts per block
  // V3.7 Y6 (note 19, A11): the weekly prayer goal (three paired days, two more with at least one) is a graded row, Required;
  // 5 expected per 7 days it existed, pro-rated like the weekly targets. Only from the dated rule day (A59): earlier windows keep
  // the rule they were graded under.
  if(to>=V37_RULE_DAY&&state.workspace){
    const prayer=(state.series||[]).filter(x=>!x.demo&&['prayer-am','prayer-pm'].includes(wsKind(x,to))),cache=new Map();let paired=0,once=0,live=0;
    if(prayer.length)for(let d=from;d<=to;d=addDays(d,1)){const on=prayer.filter(x=>versionFor(x,d)&&!(x.archivedAt&&x.archivedAt<=d));if(!on.length)continue;live++;const val=x=>{const r=wsGoalDay(state,x,d,cache),o=state.occurrences[occKey(x.id,d)];return r.full?1:o&&o.status==='partial'?.5:0;},am=Math.max(0,...on.filter(x=>wsKind(x,d)==='prayer-am').map(val)),pm=Math.max(0,...on.filter(x=>wsKind(x,d)==='prayer-pm').map(val));paired+=Math.min(am,pm);once+=Math.max(am,pm);}   // V3.7 re-review: a partial prayer counts half, as on Faith's card (A78)
    if(live){const P=3*live/7,A=2*live/7,first=Math.min(paired,P),done=first+Math.min(Math.max(0,once-first),A),gid=wsGroup(prayer[0],to);items.set('goal:prayer',{seriesId:'goal:prayer',name:'Prayer week goal',gid,planned:5*live/7,done:Math.min(done,5*live/7),target:true,derived:true});}
  }
  return [...items.values()];
}
const gradeMean=list=>{let w=0,s=0;for(const x of list)if(x.score!==null&&x.included&&x.importance>0){w+=x.importance;s+=x.score*x.importance;}return w?s/w:null;};
/* V3.7 Y3 (note 19, his rule; A8, A9, A10, A59): each item is Required (the goal he set) or Stretch (extra). With R the share of
   Required done and T the share of Stretch done (importance-weighted inside each), percent = 85 x R + 15 x T x R. With no Stretch
   item the level is Required alone, 100 x R, with no cap (A9); where Stretch exists, 95 or more with T under 95 percent is 94.4.
   A dated rule: a window ending before V37_RULE_DAY keeps the old mean. A tier is dated from the day he sets it (tierFrom);
   the defaults (A10): Morning and Night prayer Stretch, everything else Required. */
const GRADE_TIER_DEFAULTS={};   // Fix T1: his prayers are Required (his words, Oct 6: "clearly required"); nothing is Stretch until he says so
// Review F5: the tier history is an append-only list [{from, tier}], so a past day keeps the tier it had whatever is flipped later
function gradeTierOf(cfg,seriesId,to){const c=cfg.items[seriesId]||{},def=GRADE_TIER_DEFAULTS[seriesId]||'required',ok=t=>t==='required'||t==='stretch';
  if(Array.isArray(c.tiers)&&c.tiers.length){let t=def;for(const x of c.tiers)if(x&&validCalendarDate(x.from)&&x.from<=to&&ok(x.tier))t=x.tier;return t;}
  return def;}
function gradeTiered(list,tierOf){
  const req=list.filter(x=>tierOf(x)!=='stretch'),str=list.filter(x=>tierOf(x)==='stretch'),R0=gradeMean(req),T0=gradeMean(str),cnt=l=>l.filter(x=>x.score!==null&&x.included&&x.importance>0);
  if(R0===null&&T0===null)return {score:null,R:null,T:null,hasStretch:false};
  /* Fix T1 (Mintay, Oct 6: "only grade Required"): the grade is the Required percent and nothing else, on every date. Stretch never lowers it; it lifts in one way only: the top
     rung (SSS, 95) needs at least 95 percent of the Stretch items done, so Required alone tops out at SS (94.4) where the group has Stretch, and a group with none can reach SSS.
     A group with no Required item due is not graded (Stretch alone is not a grade). This supersedes the 85/15 blend (V3.7 A9/A59) and the rule-day split. */
  const R=R0===null?null:R0/100,hasStretch=T0!==null,T=hasStretch?T0/100:null;
  let pct=R===null?null:100*R;if(hasStretch&&pct!==null&&pct>=95&&T<0.95)pct=94.4;
  return {score:pct,R,T,hasStretch,reqDone:cnt(req).reduce((n,x)=>n+(x.done||0),0),reqDue:cnt(req).reduce((n,x)=>n+(x.planned||0),0),strDone:cnt(str).reduce((n,x)=>n+(x.done||0),0),strDue:cnt(str).reduce((n,x)=>n+(x.planned||0),0)};
}
/* umbrellaGradeReport(state, today, period, range): {from, to, overall, letter, umbrellas:[{id, name, own, displayed, faithOn,
   faithShare, importance, included, share (of the Overall, %), groups:[{gid, name, score, importance, included,
   items:[…]}]}], unassigned:[items], counted, listed, due}. Percentages are 0–100. */
/* V3.6 R5 (ASSUMED A34): a measured contributor, such as the Nutrition Grade, joins its umbrella as a group whose score the
   page supplies ({health:[{id, name, score}]}); its include and importance live under gradeConfig.groups['measured:<id>'],
   which an earlier build reads as an unknown group and ignores. It is off until he turns it on, so the Overall does not
   move on release day. */
function umbrellaGradeReport(state,today,period,range,measured,opts){
  const {from,to,program,live}=gradePeriod(state,today,period||'day',range,opts),tierDay=live?todayYmd():null;   // Fix G1: a Week, Month or All window ends yesterday only because today is still open, so it reads the tier in force today
  // V3.7.1 F5 (audit D-5; his "take ur rec", Oct 5; ASSUMED V371-A1): a window that spans the rule day is graded in two parts, the
  // days before it by the old rule and the days from it by Required and Stretch, joined by their due counts (gradeSplit). A window
  // wholly on one side is graded exactly as before, so a past week viewed as a week never moves (A59).
  // Review R1: a weekly target or a goal window is met over the whole window, not per part: each part keeps its own due count and
  // takes the whole window's share done (a target met on Oct 1 to 3 is met in a Last 7 days window that ends Oct 7)
  return gradeReportOver(state,from,to,program,period,measured,true,undefined,tierDay);   // Fix T1: one rule for every date, no split at the Oct 5 rule day
}
function gradeReportOver(state,from,to,program,period,measured,tiered,share,tierDay){
  const cfg=gradeConfig(state),rows=share?gradeRows(state,from,to).map(share):gradeRows(state,from,to),tierAt=tierDay||to,tierOf=x=>x.tier||gradeTierOf(cfg,x.seriesId,tierAt);
  const groupName=gid=>((state.groups||[]).find(g=>g.id===gid)||{}).name||gid||'No card';
  const item=r=>{const c=cfg.items[r.seriesId]||{};return {...r,score:r.planned?100*Math.min(1,r.done/r.planned):null,importance:Number.isFinite(c.importance)?c.importance:GRADE_ITEM_IMPORTANCE,included:c.included!==false,tier:r.derived?'required':gradeTierOf(cfg,r.seriesId,tierAt)};};
  const umbrellas=GRADE_UMBRELLAS.map(u=>{
    const set=gradeUmbrellaSettings(cfg,u.id),byGroup=new Map();
    for(const r of rows){if(gradeGroupUmbrella(state,r.gid)!==u.id)continue;if(!byGroup.has(r.gid))byGroup.set(r.gid,[]);byGroup.get(r.gid).push(item(r));}
    const groups=[...byGroup].map(([gid,list])=>{const c=cfg.groups[gid]||{},t=tiered?gradeTiered(list,tierOf):null;return {gid,name:groupName(gid),items:list,score:t?t.score:gradeMean(list),tiers:t,importance:Number.isFinite(c.importance)?c.importance:GRADE_GROUP_IMPORTANCE,included:c.included!==false};});
    for(const m of (measured&&measured[u.id])||[]){const gid='measured:'+m.id,c=cfg.groups[gid]||{};groups.push({gid,name:m.name,items:[],score:Number.isFinite(m.score)?m.score:null,importance:Number.isFinite(c.importance)?c.importance:GRADE_GROUP_IMPORTANCE,included:c.included===true,measured:true,note:m.note||''});}
    // Y3 at umbrella level: R and T are the importance-weighted means of the groups' R and T (the measured groups count in R)
    let own=gradeMean(groups),tiers=null;
    if(tiered){const lv=groups.filter(g=>g.score!==null&&g.included&&g.importance>0),rg=lv.map(g=>({score:g.tiers?(g.tiers.R===null?null:100*g.tiers.R):g.score,importance:g.importance,included:true})),tg=lv.filter(g=>g.tiers&&g.tiers.hasStretch).map(g=>({score:100*g.tiers.T,importance:g.importance,included:true}));
      const R0=gradeMean(rg),T0=gradeMean(tg);if(R0!==null||T0!==null){const R=R0===null?null:R0/100,hasStretch=T0!==null,T=hasStretch?T0/100:null;let pct=R===null?null:100*R;if(hasStretch&&pct!==null&&pct>=95&&T<0.95)pct=94.4;own=pct;
        const sum=(k)=>lv.reduce((n,g)=>n+(g.tiers?g.tiers[k]||0:0),0);tiers={R,T,hasStretch,reqDone:sum('reqDone'),reqDue:sum('reqDue'),strDone:sum('strDone'),strDue:sum('strDue')};}}
    return {id:u.id,name:u.name,emoji:u.emoji,groups,own,tiers,importance:set.importance,included:set.included,faithOn:set.faith,faithShare:set.faithShare};
  });
  const faith=umbrellas.find(u=>u.id==='faith').own;
  for(const u of umbrellas){u.displayed=u.own!==null&&u.faithOn&&faith!==null?(1-u.faithShare)*u.own+u.faithShare*faith:u.own;u.letter=rankLetter(u.displayed);u.ownLetter=rankLetter(u.own);}
  const live=umbrellas.filter(u=>u.included&&u.own!==null&&u.importance>0),wsum=live.reduce((n,u)=>n+u.importance,0);
  let overall=wsum?live.reduce((n,u)=>n+u.own*u.importance,0)/wsum:null;
  if(tiered&&overall!==null&&overall>=95&&live.some(u=>u.tiers&&u.tiers.hasStretch&&u.tiers.T<0.95))overall=94.4;   // Y3: the SSS guard
  for(const u of umbrellas)u.share=wsum&&live.includes(u)?100*u.importance/wsum:0;
  const unassigned=rows.filter(r=>!gradeGroupUmbrella(state,r.gid)).map(item),counted=rows.length-unassigned.length;
  return {from,to,program,period:period||'day',overall,letter:rankLetter(overall),umbrellas,unassigned,counted,listed:unassigned.length,due:rows.length,tiered};
}
/* V3.7.1 F5: join the part before the rule day (a, the old rule) and the part from it (b, Required and Stretch). A group's score and
   an umbrella's level are the two parts' weighted by their due counts (the planned occurrences, as the engine weighs days); the
   Overall then follows from the umbrellas as always (importance-weighted, the SSS guard where the part from the rule day has
   Stretch short of 95 percent). Items read n of m over the whole window; the tiers are those of the part from the rule day, with
   its share of the due count (part) so the drawer's "points to the next letter" stays right. */
function gradeSplit(a,b){
  const due=list=>list.filter(x=>x.included!==false&&x.importance>0&&x.score!==null).reduce((n,x)=>n+(x.planned||0),0),live=g=>g&&g.score!==null&&g.included&&g.importance>0;
  const mix=(va,na,vb,nb)=>va===null||va===undefined?(vb===undefined?null:vb):vb===null||vb===undefined?va:na+nb>0?(va*na+vb*nb)/(na+nb):vb;
  const join=(la,lb)=>{const m=new Map();for(const x of la.concat(lb)){const y=m.get(x.seriesId);if(!y){m.set(x.seriesId,{...x});continue;}const planned=y.planned+x.planned,done=y.done+x.done;m.set(x.seriesId,{...x,planned,done,score:planned?100*Math.min(1,done/planned):null});}return [...m.values()];};
  const parts={before:[],after:[]},umbrellas=b.umbrellas.map(ub=>{const ua=a.umbrellas.find(u=>u.id===ub.id),gids=[...new Set(ua.groups.map(g=>g.gid).concat(ub.groups.map(g=>g.gid)))];
    const groups=gids.map(gid=>{const ga=ua.groups.find(g=>g.gid===gid),gb=ub.groups.find(g=>g.gid===gid);return {...(gb||ga),items:join(ga?ga.items:[],gb?gb.items:[]),score:mix(ga?ga.score:null,ga?due(ga.items):0,gb?gb.score:null,gb?due(gb.items):0),tiers:gb?gb.tiers:null};});
    const nA=ua.groups.filter(live).reduce((n,g)=>n+due(g.items),0),nB=ub.groups.filter(live).reduce((n,g)=>n+due(g.items),0);parts.before.push({id:ua.id,own:ua.own,due:nA});parts.after.push({id:ub.id,own:ub.own,due:nB});
    let own=mix(ua.own,nA,ub.own,nB);if(own!==null&&own>=95&&ub.tiers&&ub.tiers.hasStretch&&ub.tiers.R!==null&&ub.tiers.T<0.95)own=94.4;
    return {...ub,groups,own,tiers:ub.tiers?{...ub.tiers,part:ua.own===null||nA+nB===0?1:nB/(nA+nB)}:null};});
  const faith=umbrellas.find(u=>u.id==='faith').own;
  for(const u of umbrellas){u.displayed=u.own!==null&&u.faithOn&&faith!==null?(1-u.faithShare)*u.own+u.faithShare*faith:u.own;u.letter=rankLetter(u.displayed);u.ownLetter=rankLetter(u.own);}
  const lv=umbrellas.filter(u=>u.included&&u.own!==null&&u.importance>0),wsum=lv.reduce((n,u)=>n+u.importance,0);
  let overall=wsum?lv.reduce((n,u)=>n+u.own*u.importance,0)/wsum:null;
  if(overall!==null&&overall>=95&&lv.some(u=>u.tiers&&u.tiers.hasStretch&&u.tiers.T<0.95))overall=94.4;   // Y3: the SSS guard
  for(const u of umbrellas)u.share=wsum&&lv.includes(u)?100*u.importance/wsum:0;
  const unassigned=join(a.unassigned,b.unassigned),counted=umbrellas.reduce((n,u)=>n+u.groups.reduce((k,g)=>k+g.items.length,0),0);
  return {from:a.from,to:b.to,program:b.program,period:b.period,overall,letter:rankLetter(overall),umbrellas,unassigned,counted,listed:unassigned.length,due:counted+unassigned.length,tiered:true,split:{at:b.from,before:{from:a.from,to:a.to,overall:a.overall,tiered:a.tiered,umbrellas:parts.before},after:{from:b.from,to:b.to,overall:b.overall,tiered:b.tiered,umbrellas:parts.after}}};
}
// The one way settings change: kind is umbrellas, groups or items; field is importance, included, faith or faithShare.
function setGradeConfig(state,kind,id,field,value){
  if(!['umbrellas','groups','items'].includes(kind)||typeof id!=='string'||!id)return null;
  if(kind==='umbrellas'&&!GRADE_UMBRELLAS.some(u=>u.id===id)&&!(id==='fitness'&&['faith','faithShare'].includes(field)))return null;   // the Fitness Grade card keeps its own 🙏 blend
  const ok={tier:v=>(v==='required'||v==='stretch')&&kind==='items',importance:v=>Number.isFinite(+v)&&+v>=0&&+v<=10,included:v=>typeof v==='boolean',faith:v=>typeof v==='boolean'&&kind==='umbrellas'&&id!=='faith',faithShare:v=>Number.isFinite(+v)&&+v>=0&&+v<=.5&&kind==='umbrellas'};
  if(!ok[field]||!ok[field](value))return null;
  if(!state.gradeConfig||typeof state.gradeConfig!=='object')state.gradeConfig={version:1};
  const bag=state.gradeConfig[kind]=state.gradeConfig[kind]||{},entry=bag[id]=Object.assign({},bag[id]);
  if(field==='tier'){const day=todayYmd();if(gradeTierOf(gradeConfig(state),id,day)===value&&(entry.tiers||[]).length)return entry;entry.tiers=(Array.isArray(entry.tiers)?entry.tiers:[]).filter(x=>x&&x.from<day).concat({from:day,tier:value});}   // V3.7 A59: a tier is dated from the day he sets it (a no-op when unchanged)
  entry[field]=field==='importance'?Math.round(+value):field==='faithShare'?Math.round(+value*100)/100:value;
  return entry;
}
function setHobbiesGraded(state,on){if(!state.gradeConfig||typeof state.gradeConfig!=='object')state.gradeConfig={version:1};state.gradeConfig.hobbies=!!on;return state.gradeConfig.hobbies;}
// Reset to default: one entry, or a whole kind (an umbrella's reset also clears its groups and items).
function resetGradeConfig(state,kind,id){
  const c=state.gradeConfig;if(!c||typeof c!=='object')return false;
  const keepTiers=e=>e&&Array.isArray(e.tiers)&&e.tiers.length?{tier:e.tier,tiers:e.tiers}:null;   // review F5: a reset puts weights back, never rewrites tier history
  if(kind&&id){if(c[kind]){const k=kind==='items'?keepTiers(c[kind][id]):null;if(k)c[kind][id]=k;else delete c[kind][id];}return true;}
  delete c.umbrellas;delete c.groups;if(c.items){const kept={};for(const [k,e] of Object.entries(c.items)){const t=keepTiers(e);if(t)kept[k]=t;}if(Object.keys(kept).length)c.items=kept;else delete c.items;}return true;
}
function gradeConfigProblem(c){
  if(c===undefined)return null;if(!c||typeof c!=='object'||Array.isArray(c))return 'The grade settings are malformed.';
  for(const kind of ['umbrellas','groups','items']){const bag=c[kind];if(bag===undefined)continue;if(!bag||typeof bag!=='object'||Array.isArray(bag))return 'The grade settings are malformed.';
    for(const e of Object.values(bag)){if(!e||typeof e!=='object')return 'A grade setting is malformed.';if(e.importance!==undefined&&!(Number.isFinite(e.importance)&&e.importance>=0&&e.importance<=10))return 'A grade importance is out of range.';if(e.included!==undefined&&typeof e.included!=='boolean')return 'A grade setting is malformed.';if(e.faith!==undefined&&typeof e.faith!=='boolean')return 'A grade setting is malformed.';if(e.faithShare!==undefined&&!(Number.isFinite(e.faithShare)&&e.faithShare>=0&&e.faithShare<=.5))return 'A Faith share is out of range.';if(e.tier!==undefined&&e.tier!=='required'&&e.tier!=='stretch')return 'A grade tier is malformed.';if(e.tiers!==undefined&&(!Array.isArray(e.tiers)||e.tiers.some(x=>!x||!validCalendarDate(x.from)||(x.tier!=='required'&&x.tier!=='stretch'))))return 'A grade tier history is malformed.';}}
  if(c.hobbies!==undefined&&typeof c.hobbies!=='boolean')return 'The grade settings are malformed.';
  return null;
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

function addPlanIdea(state,text,extra){const value=String(text||'').trim().slice(0,NOTE_MAX);if(!value)return null;const e=extra||{},category=String(e.category||'').trim().slice(0,40),idea={id:newId('idea'),text:value,at:nowIso(),status:'idea',...(category?{category}:{}),...(e.kind==='note'?{kind:'note'}:{})};state.planIdeas.push(idea);if(category)addIdeaCategory(state,category);return idea;}
function ideaCategories(state){const own=Array.isArray(state.prefs&&state.prefs.ideaCategories)?state.prefs.ideaCategories.filter(x=>typeof x==='string'&&x.trim()):[];const used=(state.planIdeas||[]).map(i=>i.category).filter(x=>typeof x==='string'&&x.trim());return [...new Set(['General',...own,...used])];}
function addIdeaCategory(state,name){const n=String(name||'').trim().slice(0,40);if(!n)return null;const list=Array.isArray(state.prefs.ideaCategories)?state.prefs.ideaCategories:[];if(!list.some(x=>x.toLowerCase()===n.toLowerCase())&&n.toLowerCase()!=='general')state.prefs.ideaCategories=list.concat(n);return n;}
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
  return {start,days:days.length,covered:covered.size,planned:rows.length,confirmed:done.length,ids:done.map(r=>r.key),text:covered.size<4?'Too few reviewed days for a pattern yet.':done.length+' of '+rows.length+' planned actions confirmed across '+covered.size+' reviewed days. Different plans and missing entries limit comparisons.'};
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
  // Done is self-confirmed in one tap (Mintay, Sept 24 evening): with no minutes entered it means
  // "done as planned", so a timed target no longer forces the review. Entered minutes still count.
  const target=row.targets[f.selected||row.selected], minutes=f.minutes==null?(row.actualMinutes??(target&&target.minutes||null)):Number(f.minutes);
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
      const w=recurrenceWindow(v,d,state);
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
/* Points follow corrected facts (Mintay, Sept 25, approved; V3.1). After any change to an occurrence
   whose points were claimed — Skipped, Done again, Tentative, new minutes — the claim is brought to what
   the facts now earn by the same signed, logged adjustment the review uses (adjustConfirmedClaim; the
   rule-4 batch keeps each claim's own rule). Nothing is paid twice: the claim id is the occurrence. */
function followCorrection(state,seriesId,date,reason){
  if(!confirmedProgression(state))return null;
  const o=state.occurrences[occKey(seriesId,date)],id=o?rewardIdentity(state,o):occKey(seriesId,date);
  if(!state.rewards.claims[id]){const s=state.series.find(x=>x.id===seriesId),v=s&&(versionFor(s,date)||latestVersion(s)),lines=typeof wsLineCorrections==='function'?wsLineCorrections(state,v&&v.name?'Recalculated with '+v.name+' ('+String(reason||'corrected')+')':reason):[];return lines.length?{id:null,before:0,after:0,lines}:null;}
  const before=claimBalance(state.rewards.claims[id]),result=adjustConfirmedClaim(state,id,reason);
  return result?{id,before,after:claimBalance(state.rewards.claims[id]),lines:result.lineChanges||[]}:null;
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
  if(wsMergePerfectRules(cur.rewards?.perfectTiers,inc.rewards?.perfectTiers).error)return ['Perfect policy history'];
  if((!confirmedProgression(cur)||!confirmedProgression(inc))&&!Object.values(cur.rewards?.claims||{}).concat(Object.values(inc.rewards?.claims||{})).some(c=>c.ruleVersion===4))return [];
  return Object.keys(inc.rewards.claims).filter(id=>{
    const a=cur.rewards.claims[id],b=inc.rewards.claims[id];if(!a)return false;
    if(a.amount!==b.amount||a.claimedAt!==b.claimedAt)return true;
    if((wsProtectedClaim(a)||wsProtectedClaim(b))&&JSON.stringify([a.seriesId,a.date,a.epochId,a.calculation])!==JSON.stringify([b.seriesId,b.date,b.epochId,b.calculation]))return true;
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
    const loaded=opts.persist===false?{ok:true,state}:await store.readCommitted();
    if(!loaded.ok)return loaded;
    const current=loaded.state||state;
    // A queued one-tap action (V2.3) applies to whatever is committed when its turn comes, so a tap
    // made while an earlier one was saving is not refused; the engine's compare-and-swap still
    // refuses a change made in another window.
    if(!opts.rebase&&(current.revision||0)!==revision)return {ok:false,error:'This action changed in another window. Reload and review again.'};
    // V3.4 (S7): opts.undo names an undoable tap (Done, Skip, an add); the record before it joins the undo stack.
    const before=opts.undo?undoSnapshot(current,opts.undo):null;
    const draft=cloneRecord(current), result=change(draft);
    if(result && result.ok===false)return result;
    const problem=validateState(draft);if(problem)return {ok:false,error:problem};
    const same=(state.revision||0)===(current.revision||0);
    if(opts.persist!==false){const saved=await store.write(draft);if(!saved.ok)return saved;}
    // Saved as he types (V3.2): the live record may hold a tap that is still waiting its turn to be written.
    // Replacing the record would erase that tap, so inPlace(live, written) copies what was written into the
    // live record (the same values, the same times) along with the two stamps the store sets. A record written
    // by another window is still replaced whole.
    if(typeof opts.inPlace==='function'&&same&&opts.persist!==false){opts.inPlace(state,draft);state.revision=draft.revision;state.rewardGeneration=draft.rewardGeneration;}
    else replaceState(state,draft);
    if(before)pushUndo(before);else dropUndo();return {ok:true,result};
  };
  if(opts.persist===false)return run();
  if(typeof navigator==='undefined'||!navigator.locks)return {ok:false,error:'Safe saving needs Web Locks. Your prior record is unchanged.'};
  return navigator.locks.request(STORE_KEY+'.workspace',run);
}
async function claimRewards(state, ids, options){
  const opts = options || {}, today = opts.today || todayYmd();
  const execute = async () => {
    const loaded = opts.persist === false ? {ok:true,state} : await store.readCommitted();
    if (!loaded.ok) return {ok:false,error:loaded.error,claimed:[],amount:0};
    if (confirmedProgression(state) && loaded.state && (loaded.state.revision||0)!==(state.revision||0)){ replaceState(state,loaded.state); }
    if (opts.persist !== false && !loaded.state) return {ok:false,error:'Save the completed task before claiming its reward.',claimed:[],amount:0};
    const draft = cloneRecord(loaded.state || state);
    migrateTo(draft);
    const wanted = ids == null ? null : new Set(Array.isArray(ids) ? ids : [ids]);
    const pending = rewardReport(draft,today).pending.filter(e => !wanted || wanted.has(e.id));
    const at = nowIso(), claimed = pending.map(e => Object.assign({},e,{claimedAt:at},draft.syntheticWorkspace===true?{syntheticPreview:true}:{}));
    for (const c of claimed){
      if (c.topUp){ const prior = draft.rewards.claims[c.id]; if (!prior) continue; const adjustments = prior.adjustments || (prior.adjustments = []);
        adjustments.push({ id:'top-up-' + (adjustments.length + 1), at, delta:c.delta, unit:'quarter-point', epochId:prior.epochId, ruleVersion:4, revision:adjustments.length + 1, kind:'top-up', calculation:wsClone(c.calculation) }); continue; }
      draft.rewards.claims[c.id] = c;
    }
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
function evidenceFingerprint(record){ if(wsPass){let f=wsPass.fp.get(record);if(f===undefined){f=evidenceFingerprintOf(record);wsPass.fp.set(record,f);}return f;} return evidenceFingerprintOf(record); }
function evidenceFingerprintOf(record){ if(record.unmapped?.healthAutoExport?.format==='JSON'&&typeof HealthAutoExport!=='undefined')return HealthAutoExport.signature(record);return JSON.stringify([record.kind,record.type || null,record.start,record.end || null,record.value == null ? null : record.value,record.unit || null,record.durationSec == null ? null : record.durationSec]); }
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
  ownSources(state);
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
  ownSources(cur);
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
  if (review.ok) ownSources(state);
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
  if(prior&&prior.rows===state.sourceRecords&&(sealedRows(state.sourceRecords)||prior.revision===state.revision)&&prior.length===state.sourceRecords.length&&prior.key===key)return prior.value;
  const value=HealthAutoExport.project(state.sourceRecords,state.autoFeed.contract);
  sourceProjectionCache.set(state,{rows:state.sourceRecords,revision:state.revision,length:state.sourceRecords.length,key,value,active:new Set(value.activeIds.concat(value.fallbackIds||[]))});return value;
}
function sourceIsActive(state,id,record){
  if(!state.autoFeed){const r=record||(state.sourceRecords||[]).find(r=>r.id===id);return !!r&&r.unmapped?.healthAutoExport?.format!=='JSON'&&!String(r.id).startsWith('hae:');}
  if(typeof globalThis.HealthAutoExport==='undefined')return false;
  sourceProjection(state);return sourceProjectionCache.get(state).active.has(id);
}
function sourceEvidenceEligible(state,record){return (state.syntheticWorkspace===true||!syntheticPreviewData(record))&&sourceIsActive(state,record.id,record)&&record.unmapped?.healthAutoExport?.representation!=='minute aggregate';}
/* V2.0 goals and checkpoints (Mintay, Sept 25). His numbers (start weight, goal weight, height, dates) live
   only in his own saved settings — this file is published, so it carries the generic, sourced rules and
   never a personal value. A suggested change applies only when he accepts it. Weight rules work in lb. */
const GOAL_DEFAULTS_V2={startDate:null,startWeightLb:null,goalDate:'2027-01-07',weightLb:{jan7:null,longTerm:null},deficit:{daily:825,onTrack:750},heightIn:null,ageBand:'30-39',sex:'male'};
/* Research-based targets (sources: goal-research.json in the repo, retrieved 2026-09-24). A baseline is his
   first reading on or after the start date, frozen once found, so a target does not move each time he measures. */
const GOAL_RULES_V2=[
  {id:'bodyFat',label:'Body fat',unit:'%',metrics:['body_fat_percentage'],down:true,jan7:'fatAtGoal',longTerm:{value:17},source:'ACE body-fat categories (fitness 14–17% for men)'},
  {id:'leanMass',label:'Lean mass',unit:'lb',metrics:['lean_body_mass'],down:false,jan7:{baselinePlus:0},longTerm:{baselinePlus:0},source:'Sardeli 2018: resistance training preserves most lean mass in a deficit'},
  {id:'waist',label:'Waist',unit:'in',metrics:['waist_circumference'],down:true,jan7:{baselineMinus:4},longTerm:{heightRatio:0.5},source:'NICE NG246: waist under half your height'},
  {id:'vo2max',label:'VO₂ max',unit:'ml/kg·min',metrics:['vo2_max'],down:false,jan7:{baselinePlus:4},longTerm:{byAgeBand:{'30-39':45,'40-49':42,'20-29':48}},source:'FRIEND registry: “good” for men 30–39 ≈ 45'},
  {id:'bmi',label:'BMI',unit:'',derived:'bmi',down:true,flag:'Weak for muscular builds',source:'CDC BMI categories'}
];
/* ---------- V3.7 O2, O6 (A31, A35): two additive stores, optional, ignored by V3.6.
   state.ifitSessions: id -> an iFIT TCX session summary (IfitReader.parse), keyed by its start and the file's digest so the same
   file twice is one session; per-second points are never kept, only the 3-minute window table.
   state.vo2Ledger: id -> one frozen row per Apple VO2 max reading (what each variant claimed the day before it arrived); a log
   of claims, never a score: it feeds no grade, no points and no other score. ---------- */
const IFIT_ID=/^ifit:\d+:[0-9a-f]{12}$/;
function validateIfitSessions(m){
  if(m===undefined)return null;if(!m||typeof m!=='object'||Array.isArray(m))return 'The iFIT sessions are malformed.';
  for(const [id,x] of Object.entries(m)){if(!x||x.id!==id||!IFIT_ID.test(id)||typeof x.start!=='string'||!Number.isFinite(Date.parse(x.start))||!Number.isFinite(x.durationSec)||x.durationSec<=0||!Array.isArray(x.windows)||typeof x.hasHR!=='boolean')return 'An iFIT session is malformed.';
    if(x.linked!==undefined&&x.linked!==null&&typeof x.linked!=='string')return 'An iFIT session link is malformed.';}
  return null;
}
function validateVo2Ledger(m){
  if(m===undefined)return null;if(!m||typeof m!=='object'||Array.isArray(m))return 'The VO₂ ledger is malformed.';
  for(const [id,r] of Object.entries(m))if(!r||r.id!==id||!validCalendarDate(r.date)||!Number.isFinite(r.reading)||!['live','backfill'].includes(r.source)||!r.variants||typeof r.variants!=='object')return 'A VO₂ ledger row is malformed.';
  return null;
}
// O2, O3: add parsed sessions; the same file again is "same", never a second copy. Returns the counts the review shows.
function addIfitSessions(state,sessions,links){
  state.ifitSessions=state.ifitSessions||{};const out={added:[],same:[]};
  for(const x of sessions||[]){if(!x||!IFIT_ID.test(x.id||''))continue;if(state.ifitSessions[x.id]){out.same.push(x.id);continue;}
    const keep={id:x.id,fileName:String(x.fileName||'').slice(0,120),digest:x.digest,start:x.start,end:x.end,durationSec:x.durationSec,distanceM:Number.isFinite(x.distanceM)?x.distanceM:null,hasHR:!!x.hasHR,hrCoverage:Number.isFinite(x.hrCoverage)?x.hrCoverage:0,hasAltitude:!!x.hasAltitude,elevGainM:Number.isFinite(x.elevGainM)?x.elevGainM:null,laps:(x.laps||[]).slice(0,20),windows:(x.windows||[]).slice(0,200),origin:'iFIT file',importedAt:nowIso(),linked:links&&links[x.id]||null};
    if(validateIfitSessions({[x.id]:keep})){out.refused=(out.refused||[]).concat(x.id);continue;}   // review F1: a row the validator would refuse never enters the record
    state.ifitSessions[x.id]=keep;out.added.push(x.id);}
  return out;
}
function removeIfitSessions(state,ids){for(const id of ids||[])if(state.ifitSessions)delete state.ifitSessions[id];return true;}
// O3: an iFIT session as a workout row the goal source and the session selector read ("iFIT session"; the watch's record wins, A56)
function ifitWorkoutRows(state){return Object.values(state.ifitSessions||{}).map(x=>({id:x.id,kind:'workout',type:'iFIT session',sourceApp:'iFIT file',start:x.start,end:x.end||new Date(Date.parse(x.start)+x.durationSec*1000).toISOString(),durationSec:x.durationSec,unmapped:{healthAutoExport:{distance:Number.isFinite(x.distanceM)?{qty:x.distanceM/1609.344,units:'mi'}:null}},ifit:true}));}
/* V3.7 O8: the share of a workout's minutes that hold a heart-rate sample: its own per-minute trace when the record has one,
   else the heart_rate rows inside its window. It credits the workout, never Apple's reading. */
function workoutHrCoverage(state,r){
  const a=Date.parse(r.start),b=Date.parse(r.end);if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)return 0;const n=Math.max(1,Math.round((b-a)/60000)),hr=r.detail&&r.detail.hr&&Array.isArray(r.detail.hr.avg)?r.detail.hr.avg:null;
  if(hr)return Math.min(1,hr.filter(v=>Number.isFinite(v)&&v>0).length/n);
  const mins=new Set();for(const x of haeRowsFor(state,['heart_rate'])){const t=Date.parse(x.start);if(t>=a&&t<b)mins.add(Math.floor((t-a)/60000));}
  return Math.min(1,mins.size/n);
}
/* V3.7 X1: sex is optional (male, female or not set). One helper writes it (Settings and Body's Goals); every reader asks
   sexOf. While it is blank the ladders read the male tables and say so; the Nutrition Grade and the VO₂ percentile never default. */
function sexOf(state){const s=state&&state.prefs&&state.prefs.goalsV2&&state.prefs.goalsV2.sex;return s==='male'||s==='female'?s:null;}
function setSex(state,v){const next={...(state.prefs.goalsV2||{})};if(v==='male'||v==='female')next.sex=v;else delete next.sex;state.prefs.goalsV2=next;return sexOf(state);}
function goalsV2(state){const g=state.prefs?.goalsV2||{};return {...GOAL_DEFAULTS_V2,...g,sexSet:sexOf(state)!==null,weightLb:{...GOAL_DEFAULTS_V2.weightLb,...(g.weightLb||{})},deficit:{...GOAL_DEFAULTS_V2.deficit,...(g.deficit||{})},other:Array.isArray(g.other)?g.other:GOAL_DEFAULTS_V2.other};}
/* Health Auto Export rows by metric, kept per committed row set (V3.0): readers that want one or two
   metrics no longer walk every minute bucket on every draw. Rows keep their store order. */
function haeRowsByMetric(state){return rowMemo(state,'byMetric',()=>{const m=new Map();(state.sourceRecords||[]).forEach((r,i)=>{const k=r.unmapped?.healthAutoExport?.metric;if(typeof k!=='string')return;if(!m.has(k))m.set(k,[]);m.get(k).push([i,r]);});return m;});}
function haeRowsFor(state,metrics){const m=haeRowsByMetric(state),out=[];for(const k of new Set(metrics))for(const x of m.get(k)||[])out.push(x);return out.sort((a,b)=>a[0]-b[0]).map(x=>x[1]);}
/* A reading for goals, in display units: mass in lb, everything else canonical. */
function goalReading(state,metrics,pick){
  const H=globalThis.HealthAutoExport,g=goalsV2(state),rows=[];
  for(const r of haeRowsFor(state,metrics)){const m=r.unmapped?.healthAutoExport;if(!m||!metrics.includes(m.metric)||!Number.isFinite(r.value)||(r.clashes||[]).length)continue;const def=H&&H.metric?H.metric(m.metric):null,f=def&&def.units[r.unit];if(!Number.isFinite(f))continue;let v=r.value*f;if(def.unit==='kg')v=v/0.45359237;if(m.metric==='waist_circumference'&&def.unit==='cm')v=v/2.54;rows.push({date:sourceLocalDay(r.start),start:r.start,value:v});}
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));if(!rows.length)return null;
  if(pick==='baseline'&&g.startDate){const after=rows.find(x=>x.date>=g.startDate);return after||rows[rows.length-1];}
  return rows[rows.length-1];
}
function goalTargets(state){
  const g=goalsV2(state),goalW=g.weightLb.jan7,longW=g.weightLb.longTerm,out=[];
  const r1=v=>Number.isFinite(v)?Math.round(v*10)/10:null;
  for(const rule of GOAL_RULES_V2){
    if(rule.derived==='bmi'){const w=latestWeightLb(state),base=goalReading(state,['weight_body_mass'],'baseline');const bmi=lb=>g.heightIn&&Number.isFinite(lb)?lb*0.45359237/Math.pow(g.heightIn*.0254,2):null;out.push({...rule,baseline:base?{value:r1(bmi(base.value)),date:base.date}:null,latest:w?{value:r1(bmi(w.lb)),date:w.date}:null,jan7:r1(bmi(goalW)),longTerm:r1(bmi(longW))});continue;}
    const latest=goalReading(state,rule.metrics),base=goalReading(state,rule.metrics,'baseline');
    const val=spec=>{if(!spec)return null;if(spec==='fatAtGoal'){const bw=base?latestWeightLb(state,base.date):null;return base&&bw&&goalW?r1((base.value/100*bw.lb-0.85*(bw.lb-goalW))/goalW*100):null;}
      if(Number.isFinite(spec.value))return spec.value;if(spec.baselineMinus!==undefined)return base?r1(base.value-spec.baselineMinus):null;if(spec.baselinePlus!==undefined)return base?r1(base.value+spec.baselinePlus):null;
      if(spec.heightRatio)return g.heightIn?r1(g.heightIn*spec.heightRatio):null;if(spec.byAgeBand)return spec.byAgeBand[g.ageBand]??null;return null;};
    out.push({...rule,latest:latest?{value:r1(latest.value),date:latest.date}:null,baseline:base?{value:r1(base.value),date:base.date}:null,jan7:val(rule.jan7),longTerm:val(rule.longTerm)});
  }
  return out;
}
function checkpointsOf(state){const g=goalsV2(state),main={id:'main',name:'Goal date',date:state.prefs?.checkpoint||g.goalDate,main:true};return [main,...(Array.isArray(state.prefs?.checkpoints)?state.prefs.checkpoints:[])].filter(c=>c&&validCalendarDate(c.date)).sort((a,b)=>a.date.localeCompare(b.date));}
function nextCheckpoint(state,today){const t=today||todayYmd();return checkpointsOf(state).find(c=>c.date>=t)||null;}
/* Where the plan says his weight should be on a date: a straight line from the start to the goal. */
/* V3.7 X6 (audit P6, A58, A65): On the Plan's headline and four figures, from data the app already holds. weighIns are
   [{date, lb}]. On plan is within 0.5 lb of the plan line; Ahead is past the line toward the goal. The projected date reads
   the least-squares slope of the weigh-ins in the 28 days to the date (3 or more); the checkpoint is the next one he named,
   else the goal date. Each figure is null with a reason when it cannot be computed. */
function planFigures(state,t,weighIns){
  const g=goalsV2(state),goalDate=validCalendarDate(state.prefs?.checkpoint)?state.prefs.checkpoint:g.goalDate,goal=Number.isFinite(g.weightLb.jan7)&&g.weightLb.jan7>0?g.weightLb.jan7:null,start=Number.isFinite(g.startWeightLb)?g.startWeightLb:null;
  const w=(weighIns||[]).filter(x=>x&&x.date<=t&&Number.isFinite(x.lb)).sort((a,b)=>a.date.localeCompare(b.date)),latest=w.length?w[w.length-1]:null,down=goal!==null&&start!==null?goal<start:true;
  const out={latest,goal,goalDate,state:null,diff:null,paceNeeded:null,projected:null,projectedVsGoal:null,daysAhead:null,checkpoint:null,why:latest?null:'not enough weigh-ins'};
  const plan=d=>weightPaceLb(state,d);
  if(latest&&plan(latest.date)!==null){out.diff=latest.lb-plan(latest.date);out.state=Math.abs(out.diff)<=0.5?'On plan':(out.diff<0)===down?'Ahead':'Behind';}
  if(latest&&goal!==null&&validCalendarDate(goalDate)&&goalDate>t)out.paceNeeded=(goal-latest.lb)/(calendarDistance(t,goalDate)/7);
  const recent=w.filter(x=>x.date>addDays(t,-28));
  if(recent.length>=3&&goal!==null){const xs=recent.map(x=>calendarDistance(recent[0].date,x.date)),ys=recent.map(x=>x.lb),n=xs.length,mx=xs.reduce((a,b)=>a+b,0)/n,my=ys.reduce((a,b)=>a+b,0)/n,sxx=xs.reduce((a,x)=>a+(x-mx)*(x-mx),0),slope=sxx>0?xs.reduce((a,x,i)=>a+(x-mx)*(ys[i]-my),0)/sxx:0;
    out.slopePerWeek=slope*7;const left=goal-latest.lb;if(Math.abs(left)<1e-9){out.projected=latest.date;}else if(Math.abs(slope)>=0.01&&Math.sign(slope)===Math.sign(left)&&left/slope<=3*365){out.projected=addDays(latest.date,Math.ceil(left/slope));}   // review F9: a flat slope (under 0.01 lb a day) or a date past three years is no projection
    if(out.projected&&validCalendarDate(goalDate))out.projectedVsGoal=calendarDistance(goalDate,out.projected);}
  if(latest&&start!==null&&goal!==null&&g.startDate&&validCalendarDate(goalDate)){const span=calendarDistance(g.startDate,goalDate),frac=(latest.lb-start)/(goal-start);if(span>0&&Number.isFinite(frac))out.daysAhead=Math.round(Math.max(0,Math.min(1,frac))*span)-calendarDistance(g.startDate,t);}
  const cks=(Array.isArray(state.prefs?.checkpoints)?state.prefs.checkpoints:[]).filter(c=>c&&validCalendarDate(c.date)&&c.date>=t).sort((a,b)=>a.date.localeCompare(b.date));
  const ck=cks[0]||(validCalendarDate(goalDate)&&goalDate>=t?{name:'Goal',date:goalDate}:null);if(ck)out.checkpoint={name:ck.name||'Checkpoint',date:ck.date,lb:plan(ck.date)};
  return out;
}
function weightPaceLb(state,date){const g=goalsV2(state),goalDate=validCalendarDate(state.prefs?.checkpoint)?state.prefs.checkpoint:g.goalDate;if(!g.startDate||!Number.isFinite(g.startWeightLb)||!Number.isFinite(g.weightLb.jan7)||!validCalendarDate(goalDate))return null;const span=calendarDistance(g.startDate,goalDate),at=Math.max(0,Math.min(span,calendarDistance(g.startDate,date)));return span>0?g.startWeightLb+(g.weightLb.jan7-g.startWeightLb)*at/span:g.weightLb.jan7;}
function latestWeightLb(state,before){const rows=weightRowsLb(state,before);return rows.length?rows[rows.length-1]:null;}
// Every weigh-in in pounds (imported rows and his own entries), oldest first; `before` keeps those on or before a day.
function weightRowsLb(state,before){
  const rows=[];for(const r of haeRowsFor(state,['weight_body_mass','weight_&_body_mass'])){const m=r.unmapped?.healthAutoExport;if(!m||!['weight_body_mass','weight_&_body_mass'].includes(m.metric)||!Number.isFinite(r.value)||(r.clashes||[]).length)continue;const lb=r.unit==='kg'?r.value/0.45359237:r.unit==='lb'||r.unit==='lbs'?r.value:null;if(lb===null)continue;const d=sourceLocalDay(r.start);if(!before||d<=before)rows.push({date:d,lb});}
  for(const [d,o] of Object.entries(state.observations||{}))if(o&&Number.isFinite(o.weight)&&(!before||d<=before))rows.push({date:d,lb:(o.weightUnit||state.prefs?.units)==='kg'?o.weight/0.45359237:o.weight});
  rows.sort((a,b)=>a.date.localeCompare(b.date));return rows;
}
function weightTrend(state,today){
  const t=today||todayYmd(),g=goalsV2(state),now=latestWeightLb(state,t);if(!now)return null;
  const week=latestWeightLb(state,addDays(now.date,-7));
  const pace=weightPaceLb(state,now.date);
  return {latest:now.lb,date:now.date,sinceStart:Number.isFinite(g.startWeightLb)?now.lb-g.startWeightLb:null,week:week&&week.date<now.date?now.lb-week.lb:null,pace,vsPace:pace===null?null:now.lb-pace};
}
/* Weekly suggestion: behind the line by over a pound → a 100 kcal larger daily deficit; ahead by over two
   → 100 smaller. Bounded 500–1,100 kcal, offered once a week, applied only on acceptance. */
function deficitSuggestion(state,today){
  const t=today||todayYmd(),tr=weightTrend(state,t),g=goalsV2(state),week=weekStartOf(t,1);
  if(!tr||tr.vsPace===null||calendarDistance(tr.date,t)>7||(state.prefs?.goalSuggestion||{})[week])return null;
  const daily=g.deficit.daily,next=tr.vsPace>1?Math.min(1100,daily+100):tr.vsPace<-2?Math.max(500,daily-100):daily;
  return next===daily?null:{week,from:daily,to:next,vsPace:tr.vsPace,reason:tr.vsPace>1?'behind':'ahead'};
}
/* V3.6 S5 (V36-I17): one Program start for every reader (the grade's All, Fitness Trends, Fuel, Sleep Credit). */
// review F5: Settings writes prefs.programStart (its own value; goalsV2.startDate is also the weight plan's start), read first
/* Fix H1 (Mintay, Oct 6: "from whenever the program started through the 4th week ... until 4 weeks is over, at which point it resets"):
   an N-week item is met in fixed blocks counted from the Program start, not in a window that slides with the day looked at. */
function programBlockOf(state,date,weeks){const span=(weeks||4)*7,start=programStartOf(state,date);if(!validCalendarDate(start)||date<start)return null;const from=addDays(start,Math.floor(calendarDistance(start,date)/span)*span);return {from,to:addDays(from,span-1),next:addDays(from,span)};}
/* H3: a target met in fixed blocks counts per block in a grade window: each block's share of the window is planned in proportion to its days in the
   window, and paid in full once the block has its attendance (from the block's first day to the window's end), whenever in the block it came. */
function targetBlockShare(state,seriesId,rec,from,to){
  const s=state.series.find(x=>x.id===seriesId),weeks=rec&&rec.weeks||1;if(!s||weeks<2||!(rec.count>0))return null;
  const v=versionFor(s,to);if(!v||(v.recurrence&&v.recurrence.mode==='rolling'&&v.workspaceKind!=='church'))return null;
  const starts=(s.versions||[]).filter(x=>x.recurrence&&x.recurrence.kind==='target').map(x=>x.effectiveFrom).filter(validCalendarDate).sort(),a=starts[0]&&starts[0]>from?starts[0]:from;
  let planned=0,done=0;
  for(let d=a;d<=to;){const b=programBlockOf(state,d,weeks);if(!b){d=addDays(d,1);continue;}
    const end=b.to<to?b.to:to,p=rec.count*(calendarDistance(d,end)+1)/(7*weeks);let att=0;
    for(let x=b.from;x<=end;x=addDays(x,1)){const o=state.occurrences[occKey(seriesId,x)];if(o&&o.status==='done')att++;else if(o&&o.status==='partial')att+=.5;}
    planned+=p;done+=p*Math.min(1,att/rec.count);d=addDays(b.to,1);}
  return planned>0?{planned,done}:null;
}
function programStartOf(state,today){const t=today||todayYmd(),p=state.prefs?.programStart,s=state.prefs?.goalsV2?.startDate;return validCalendarDate(p)&&p<=t?p:validCalendarDate(s)&&s<=t?s:GRADE_PROGRAM_START;}
/* V3.6 N1 to N3 (Mintay, Oct 2 and 3): ONE Net Energy convention. net = food minus burn; a deficit is negative.
   The goal is stored once and positive (goalsV2.deficit.daily, so V3.5 and older read it unchanged) and is read
   negative through goal(); "on track" is its own named threshold. A day counts in a net figure only with a full
   record (food, resting and active energy); otherwise it names the missing input. */
const NET_KCAL_PER_LB=3500;
const NetEnergy={
  goal(state){const d=goalsV2(state).deficit;return -Math.abs(Number(d.daily)||GOAL_DEFAULTS_V2.deficit.daily);},
  onTrack(state){const d=goalsV2(state).deficit;return -Math.abs(Number(d.onTrack)||GOAL_DEFAULTS_V2.deficit.onTrack);},
  // One day as every surface reads it. `missing` names the inputs a full record lacks, in his words.
  day(state,date,eb){
    const e=eb||Workspace.energyBalance(state,date)||{},typedBurn=!!(e.typed&&e.typed.burn);
    const food=Number.isFinite(e.food)?e.food:null,burn=Number.isFinite(e.burn)?e.burn:null;
    const missing=[food===null||food<=0?'food':null,typedBurn?null:!(e.resting>0)?'resting':null,typedBurn?null:!(e.active>0)?'active':null,typedBurn&&!(burn>0)?'burn':null].filter(Boolean);
    const full=!missing.length&&e.complete!==false&&burn!==null;
    return {date,food,burn,resting:Number.isFinite(e.resting)?e.resting:null,active:Number.isFinite(e.active)?e.active:null,net:full?food-burn:null,full,missing,typed:!!e.typed};
  },
  missingText(missing){const w={food:'no food logged',resting:'no resting energy',active:'no active energy',burn:'no burn'};return (missing||[]).length===3?'no data':(missing||[]).map(k=>w[k]).join(', ');},
  // Days from..to (inclusive) with their records, the total and average of the full days, and pounds at 3,500 kcal.
  summary(state,from,to){
    const bal=Workspace.energyBalances(state,from,to),days=[];for(let d=from;d<=to;d=addDays(d,1))days.push(NetEnergy.day(state,d,bal.get(d)));
    // The average is the mean of the displayed (rounded) daily nets, rounded once more at display (the Learn rule).
    const ok=days.filter(x=>x.full),total=ok.reduce((n,x)=>n+x.net,0);
    return {from,to,days,logged:ok.length,of:days.length,total,avg:ok.length?ok.reduce((n,x)=>n+Math.round(x.net),0)/ok.length:null,pounds:total/NET_KCAL_PER_LB,burn:ok.length?ok.reduce((n,x)=>n+x.burn,0)/ok.length:null,food:ok.length?ok.reduce((n,x)=>n+x.food,0)/ok.length:null,missing:days.filter(x=>!x.full)};
  },
  // Windows ending on `day` (A30, H4): Day = that day, Week = Monday to `day` (or Sunday, by the Week setting), Month = the 1st to `day`, All = Program start.
  window(state,period,day,range){const t=day||todayYmd();if(period==='custom'&&range&&validCalendarDate(range.from)&&validCalendarDate(range.to)){const a=range.from<range.to?range.from:range.to,b=range.from<range.to?range.to:range.from;return {from:a,to:b>t?t:b};}
    const from=period==='week'?weekStartOf(t,state.prefs&&state.prefs.weekStart===0?0:1):period==='month'?t.slice(0,8)+'01':period==='all'?programStartOf(state,t):t;return {from:from>t?t:from,to:t};},   // H4: Week is the calendar week and Month the calendar month
  // The net used by the weight estimate (his rule, Oct 3): an unlogged day counts as food 0; a day without resting or
  // active energy is not food 0, so it is skipped and named (ASSUMED A3); today counts once it has a full record.
  estimateDays(state,from,to,today){
    const t=today||todayYmd(),bal=Workspace.energyBalances(state,from,to),used=[],skipped=[];let net=0,zeroFood=0,logged=0;
    for(let d=from;d<=to;d=addDays(d,1)){const x=NetEnergy.day(state,d,bal.get(d));
      if(d>=t&&!x.full)continue;
      if(x.burn===null||x.missing.some(k=>k!=='food')){skipped.push({date:d,missing:x.missing});continue;}
      const food=x.missing.includes('food')?0:x.food;if(food===0)zeroFood++;if(x.full)logged++;net+=food-x.burn;used.push(d);}
    return {net,used,skipped,zeroFood,logged,of:used.length+skipped.length};
  },
  /* N3: last weigh-in + the sum of (food - resting - active) over every day since, divided by 3,500. No range. */
  weightEstimate(state,asOf){
    const t=asOf||todayYmd(),w=latestWeightLb(state,t);if(!w)return null;
    const x=NetEnergy.estimateDays(state,w.date,t,todayYmd());
    return {point:w.lb+x.net/NET_KCAL_PER_LB,from:w.lb,since:w.date,net:x.net,logged:x.logged,of:x.of,zeroFood:x.zeroFood,skipped:x.skipped,used:x.used.length};
  },
  /* N8 (ASSUMED A6): the daily deficit the scale implies between two days at least 10 days apart, from the mean of the
     weigh-ins in the 7 days ending at each end (a light smoothing); null without a reading at both ends. */
  scaleDeficit(state,from,to){
    if(calendarDistance(from,to)<10)return null;const rows=weightRowsLb(state,to),at=d=>{const v=rows.filter(r=>r.date<=d&&r.date>addDays(d,-7)).map(r=>r.lb);return v.length?v.reduce((n,x)=>n+x,0)/v.length:null;};
    const a=at(from),b=at(to);if(a===null||b===null)return null;return {deficit:-(b-a)*NET_KCAL_PER_LB/calendarDistance(from,to),from,to,startLb:a,endLb:b};
  },
  /* N3: the logging gap = scale minus estimate, from the weigh-in before the last to the last one. A scale above the
     estimate means food was not logged; below, more was burned than recorded or food was logged twice. */
  loggingGap(state,asOf){
    const t=asOf||todayYmd(),w=latestWeightLb(state,t);if(!w)return null;const p=latestWeightLb(state,addDays(w.date,-1));if(!p)return null;
    const x=NetEnergy.estimateDays(state,p.date,addDays(w.date,-1),todayYmd()),est=p.lb+x.net/NET_KCAL_PER_LB,diff=w.lb-est,a=Math.abs(diff);
    const level=a<.5?'Aligned':a<1.2?'Watch':'Big gap';   // ASSUMED A7: the Draft's words and 0 to 2 lb meter, a display choice
    const sentence=a<.05?'The scale matches the estimate':'Scale is '+a.toFixed(1)+' lb '+(diff>0?'above the estimate':'below the estimate');
    return {est,measured:w.lb,diff,abs:a,level,sentence,from:p.date,to:w.date,fromWeight:p.lb,logged:x.logged,of:x.of,skipped:x.skipped,max:2};
  }
};
/* The newest reading per metric from every imported row, in the metric's canonical unit, with its
   own date. Rows dated before the feed's start are shadowed for scoring, not for "what is my latest
   weight": Whole Body, Measured Fitness and Vitals read this (V1.12). Rows with an open clash are
   skipped. One pass per draw when the draw memo is open. */
function latestMeasurements(state){
  if(drawMemo&&drawMemo.state===state&&drawMemo.latest)return drawMemo.latest;
  if(sealedRows(state.sourceRecords||[]))return rowMemo(state,'latest',()=>latestMeasurementsOf(state));
  return latestMeasurementsOf(state);
}
function latestMeasurementsOf(state){
  const H=globalThis.HealthAutoExport,defs=new Map(),out=new Map();
  for(const [,list] of haeRowsByMetric(state))for(const [,r] of list){
    const m=r.unmapped&&r.unmapped.healthAutoExport;if(!m||typeof m.metric!=='string'||!Number.isFinite(r.value)||(r.clashes||[]).length)continue;
    if(!defs.has(m.metric))defs.set(m.metric,H&&H.metric?H.metric(m.metric):null);
    const def=defs.get(m.metric);if(!def||def.reduce!=='latest')continue;
    const factor=def.units[r.unit];if(!Number.isFinite(factor))continue;
    const date=sourceLocalDay(r.start),best=out.get(m.metric);
    if(!best||date>best.date||(date===best.date&&r.start>best.start))out.set(m.metric,{value:r.value*factor,unit:def.unit,date,start:r.start,source:r.sourceApp||'Apple Health',metric:m.metric});
  }
  if(drawMemo&&drawMemo.state===state)drawMemo.latest=out;
  return out;
}
function latestMeasurement(state,metrics,asOf){if(asOf)return latestMeasurementOn(state,metrics,asOf);let best=null;const all=latestMeasurements(state);for(const name of metrics){const x=all.get(name);if(x&&(!best||x.date>best.date||(x.date===best.date&&x.start>best.start)))best=x;}return best;}
// V3.7.1 F1 (audit D-1): the newest reading on or before a day (a past selected day), read as latestMeasurementsOf reads them
function latestMeasurementOn(state,metrics,asOf){
  const H=globalThis.HealthAutoExport,byMetric=haeRowsByMetric(state);let best=null;
  for(const name of new Set(metrics)){const def=H&&H.metric?H.metric(name):null;if(!def||def.reduce!=='latest')continue;
    for(const [,r] of byMetric.get(name)||[]){const m=r.unmapped&&r.unmapped.healthAutoExport;if(!m||m.metric!==name||!Number.isFinite(r.value)||(r.clashes||[]).length)continue;const factor=def.units[r.unit];if(!Number.isFinite(factor))continue;
      const date=sourceLocalDay(r.start);if(date>asOf)continue;if(!best||date>best.date||(date===best.date&&r.start>best.start))best={value:r.value*factor,unit:def.unit,date,start:r.start,source:r.sourceApp||'Apple Health',metric:name};}}
  return best;
}
/* One day's imported nutrition totals, by metric, in canonical units (kcal, g, mL). */
function importedNutrition(state,date){
  const out={};for(const r of relayedRecords(state,'other')){const metric=r.unmapped?.healthAutoExport?.metric;if(!metric||sourceLocalDay(r.start)!==date||!Number.isFinite(r.value)||(r.clashes||[]).length)continue;if(['dietary_energy','protein','carbohydrates','total_fat','dietary_water','dietary_sugar','alcohol_consumption','caffeine'].includes(metric))out[metric]={value:(out[metric]?.value||0)+r.value,unit:r.unit,source:r.sourceApp};}
  return out;
}
/* V3.6 R3 (draft for Block 6; goes into health-domain.js next to importedNutrition): the day's nutrient totals in the
   adapter's canonical units (g, mg, mcg). The relay projection already pools a day's writers for the metrics
   POOLED_SUMS names; R3 adds MUFA, PUFA, potassium, calcium, iron, magnesium, zinc and the vitamins to that set so a
   two-writer day sums each nutrient the way it sums dietary energy (one food log per app, the kcal denominator and the
   nutrient numerator from the same rows), and the same row delivered twice still counts once (row ids). A metric
   absent, zero or held (an unresolved revision) is "not reported", never 0 intake. */
const NUTRIENT_KEYS={kcal:'dietary_energy',protein:'protein',carbs:'carbohydrates',fat:'total_fat',sat:'saturated_fat',mufa:'monounsaturated_fat',pufa:'polyunsaturated_fat',
  fibre:'fiber',sugar:'dietary_sugar',sodium:'sodium',potassium:'potassium',calcium:'calcium',fe:'iron',mg:'magnesium',zn:'zinc',vitA:'vitamin_a',vitC:'vitamin_c',
  vitD:'vitamin_d',vitE:'vitamin_e',vitK:'vitamin_k',b6:'vitamin_b6',b12:'vitamin_b12',cholesterol:'cholesterol',caffeine:'caffeine',water:'dietary_water'};
function nutrientDays(state){return rowMemo(state,'nutrient-days',()=>{
  const H=globalThis.HealthAutoExport,out=new Map(),seen=new Set();
  const key=Object.fromEntries(Object.entries(NUTRIENT_KEYS).map(([k,m])=>[m,k]));
  for(const r of relayedRecords(state,'other')){const m=r.unmapped&&r.unmapped.healthAutoExport;if(!m||!key[m.metric]||!Number.isFinite(r.value)||(r.clashes||[]).length||seen.has(r.id))continue;seen.add(r.id);
    const def=H&&H.metric?H.metric(m.metric):null,f=def&&def.units?def.units[r.unit]:1;if(!Number.isFinite(f))continue;   // a unit the adapter does not declare is not read (R3: mcg vs IU)
    const d=sourceLocalDay(r.start),x=out.get(d)||{date:d};x[key[m.metric]]=(x[key[m.metric]]||0)+r.value*f;out.set(d,x);}
  return out;});}
function nutrientTotals(state,date){const x=nutrientDays(state).get(date);return x?{...x}:{date};}
/* V3.6 P9: What Helps Me. For each habit (a series) with 60 or more resolved days in the window (due and either done or
   not), the next morning's readings after kept days are compared with those after missed days. A row is drawn only when
   the difference is clear (|t| of 2 or more with 15 or more mornings each side); three dots at |t| 3 and an effect of half
   a standard deviation, two otherwise. A habit kept mostly on one weekday carries a "Weekday caution": the morning after
   may reflect the weekday, not the habit. Pure: readings(metric) -> Map(date -> value) is supplied by the page. It is an
   association on his own record, never a cause (ASSUMED A37: his OK is owed before a counts-only look at his habits). */
const WHAT_HELPS={minDays:60,minEach:15,metrics:[['readiness','Readiness',1],['hrv','HRV',1],['rhr','Resting heart rate',-1],['sleep','Sleep',1]]};
function whatHelps(state,from,to,readings){
  const rows=[],short=[],mean=a=>a.reduce((n,v)=>n+v,0)/a.length,vari=(a,m)=>a.reduce((n,v)=>n+(v-m)*(v-m),0)/Math.max(1,a.length-1);
  const R=Object.fromEntries(WHAT_HELPS.metrics.map(([k])=>[k,(readings&&readings(k))||new Map()])),memo={};
  for(const series of state.series||[]){
    if(series.demo||series.archivedAt&&series.archivedAt<=from)continue;
    const kept=[],missed=[];
    for(let d=from;d<=to;d=addDays(d,1)){const v=versionFor(series,d);if(!v||v.childIds||!GoalEngine.dueFor(state,series,v,d,memo))continue;const o=state.occurrences[occKey(series.id,d)];if(o&&o.status==='done')kept.push(d);else if(!o||!o.status||o.status==='skipped')missed.push(d);}
    const n=kept.length+missed.length,name=(latestVersion(series)||{}).name||'Habit';
    if(n<WHAT_HELPS.minDays){if(n>0)short.push({seriesId:series.id,name,days:n});continue;}
    const wd=Array(7).fill(0);kept.forEach(d=>wd[dow(d)]++);const top=Math.max(...wd),caution=kept.length>=7&&top/kept.length>=.6?dow(kept.find(d=>wd[dow(d)]===top)):null;
    for(const [k,label,better] of WHAT_HELPS.metrics){
      const a=kept.map(d=>R[k].get(addDays(d,1))).filter(Number.isFinite),b=missed.map(d=>R[k].get(addDays(d,1))).filter(Number.isFinite);
      if(a.length<WHAT_HELPS.minEach||b.length<WHAT_HELPS.minEach)continue;
      const ma=mean(a),mb=mean(b),va=vari(a,ma),vb=vari(b,mb),se=Math.sqrt(va/a.length+vb/b.length),sd=Math.sqrt((va+vb)/2),diff=ma-mb;
      if(!(se>0)||!(sd>0))continue;const t=diff/se,eff=diff/sd;if(Math.abs(t)<2)continue;
      rows.push({seriesId:series.id,name,metric:k,label,diff,effect:eff,t,dots:Math.abs(t)>=3&&Math.abs(eff)>=.5?3:2,helps:diff*better>0,kept:a.length,missed:b.length,days:n,caution});
    }
  }
  rows.sort((x,y)=>Math.abs(y.effect)-Math.abs(x.effect));
  return {rows,short:short.sort((x,y)=>y.days-x.days),minDays:WHAT_HELPS.minDays};
}
/* Fix Y2 (planner's default, his to change; the V3.7 note: "generalise the Fast Resilience method"). For each habit, the next morning after
   the days he kept it is set against the next morning after his other due days, as Fast Resilience sets fast days against other days:
   effect = (kept mean − other mean) / the spread of his other mornings (never below a floor), at least 8 days on each side, over 180 days.
   A habit shows only with a real effect (0.3 of his spread or more) on Readiness, HRV, resting heart rate or Sleep; its strongest one is
   the row; at most three habits. It is an association on his own record, never a cause. */
const WHAT_HELPS2={minEach:8,minEffect:0.3,max:3,metrics:[['readiness','Readiness',1,3,v=>v],['hrv','HRV',1,0.05,v=>v>0?Math.log(v):null],['rhr','Resting HR',-1,1.5,v=>v],['sleep','Sleep',1,0.25,v=>v]]};
function whatHelpsV2(state,from,to,readings){
  const rows=[],near=[],mean=a=>a.reduce((n,v)=>n+v,0)/a.length,sd=(a,m)=>Math.sqrt(a.reduce((n,v)=>n+(v-m)*(v-m),0)/Math.max(1,a.length-1));
  const R=Object.fromEntries(WHAT_HELPS2.metrics.map(([k])=>[k,(readings&&readings(k))||new Map()])),memo={};
  for(const series of state.series||[]){
    if(series.demo||series.archivedAt&&series.archivedAt<=from)continue;
    const kept=[],other=[];
    for(let d=from;d<=to;d=addDays(d,1)){const v=versionFor(series,d);if(!v||v.childIds||!GoalEngine.dueFor(state,series,v,d,memo))continue;const o=state.occurrences[occKey(series.id,d)];if(o&&o.status==='done')kept.push(d);else if(!o||!o.status||o.status==='skipped')other.push(d);}
    const name=(latestVersion(series)||{}).name||'Habit';
    if(kept.length<WHAT_HELPS2.minEach||other.length<WHAT_HELPS2.minEach){if(kept.length+other.length>0)near.push({seriesId:series.id,name,kept:kept.length,other:other.length});continue;}
    let best=null;
    for(const [k,label,better,floor,tf] of WHAT_HELPS2.metrics){
      const pick=ds=>ds.map(d=>{const v=R[k].get(addDays(d,1));return Number.isFinite(v)?tf(v):null;}).filter(Number.isFinite);
      const a=pick(kept),b=pick(other);if(a.length<WHAT_HELPS2.minEach||b.length<WHAT_HELPS2.minEach)continue;
      const ma=mean(a),mb=mean(b),s=Math.max(sd(b,mb),floor),eff=(ma-mb)/s*better;
      const plain=k==='hrv'?(Math.exp(ma-mb)-1)*100:ma-mb;
      if(Math.abs(eff)>=WHAT_HELPS2.minEffect&&(!best||Math.abs(eff)>Math.abs(best.effect)))best={seriesId:series.id,name,metric:k,label,effect:eff,helps:eff>0,plain,unit:k==='hrv'?'%':k==='rhr'?' bpm':k==='sleep'?' h':'',kept:a.length,other:b.length};
    }
    if(best)rows.push(best);
  }
  rows.sort((x,y)=>Math.abs(y.effect)-Math.abs(x.effect));
  return {rows:rows.slice(0,WHAT_HELPS2.max),near:near.sort((x,y)=>Math.min(y.kept,y.other)-Math.min(x.kept,x.other)),minEach:WHAT_HELPS2.minEach};
}
/* V3.6 R7: one rule for a graded food day, read by the Fitness Grade's protein and the Nutrition Grade alike: the day's
   food energy (NetEnergy.day, the figure Net Fuel uses) is at least 800 kcal. A no-food day is never a zero: the weight
   estimate counts it at food 0 (N3), Net Fuel, protein and the Nutrition Grade skip it. */
const FOOD_GRADED_KCAL=800;
function foodGraded(state,date,eb){const x=NetEnergy.day(state,date,eb);return Number.isFinite(x.food)&&x.food>=FOOD_GRADED_KCAL;}
// The Nutrition Grade's day: the food energy of that rule and the nutrients of the reader (closed days only).
function nutritionDay(state,date,eb){const n=nutrientTotals(state,date),x=NetEnergy.day(state,date,eb);return {...n,date,kcal:Number.isFinite(x.food)?x.food:null};}
function relayedRecords(state,kind){const projected=sourceProjection(state);return (projected?projected.records:(state.sourceRecords||[]).filter(r=>sourceIsActive(state,r.id,r))).filter(r=>!kind||r.kind===kind).sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));}
function relaySourceMatches(id, record){
  const app = String(record.sourceApp || '');
  return id === 'bevel-pro' ? /bevel/i.test(app) : id === 'ifit' ? /ifit/i.test(app) : id === 'apple-fitness' ? /apple (watch|fitness|health)|^com\.apple\./i.test(app) : false;
}
/* Committed source rows are frozen (V3.0), so answers that depend only on them are kept per row set
   instead of rescanning every row on every draw. Unfrozen (in-progress) rows are never cached. */
const frozenRowCache=new WeakMap();
function rowMemo(state,name,make){
  const rows=state.sourceRecords;
  if(!Array.isArray(rows)||!sealedRows(rows))return make();
  const key=name+'|'+JSON.stringify(state.autoFeed?.contract||null);
  let memo=frozenRowCache.get(rows);if(!memo){memo=new Map();frozenRowCache.set(rows,memo);}
  if(!memo.has(key))memo.set(key,make());
  return memo.get(key);
}
function sourceEvidenceSummary(state, id){
  const v=rowMemo(state,'summary:'+id,()=>sourceEvidenceSummaryOf(state,id));
  return Object.assign({},v,{kinds:v.kinds.slice(),writers:v.writers.slice(),transports:v.transports.slice()});
}
function sourceEvidenceSummaryOf(state, id){
  const kinds=new Set(), writers=new Set(), transports=new Set();
  const projected=state.autoFeed&&sourceProjection(state),active=projected&&sourceProjectionCache.get(state).active;
  let count=0, latest=null, retrieved=null, lastWorkout=null;
  for(const r of state.sourceRecords || []){
    if((state.autoFeed?!active?.has(r.id):!sourceIsActive(state,r.id,r))||!relaySourceMatches(id,r)) continue;
    count++; kinds.add(r.kind); writers.add(r.sourceApp); transports.add(r.transport || 'legacy relay; transport not recorded');
    const sample=r.end || r.start, retrieval=r.lastRetrievedAt || r.relayedAt;
    if(sample && (!latest || Date.parse(sample)>Date.parse(latest))) latest=sample;
    if(r.kind==='workout'&&sample&&(!lastWorkout||Date.parse(sample)>Date.parse(lastWorkout)))lastWorkout=sample;
    if(retrieval && (!retrieved || Date.parse(retrieval)>Date.parse(retrieved))) retrieved=retrieval;
  }
  const local=transports.has('local file'), mixed=local && transports.size>1;
  return {id,state:count?(mixed?'mixed imports':local?'local import':'relayed'):'unverified',count,kinds:[...kinds],writers:[...writers],lastSample:latest,lastWorkout,retrievedAt:retrieved,transports:[...transports],route:count?(mixed?'Local file and relay records; no verified direct connection':local?'Locally selected file; no verified direct connection':'Sender-reported records via relay; no verified direct connection'):'No matching local records; actual field availability unverified',note:'Based on writing-app labels in local records, not independent device/account verification.'};
}
const BODY_MASS_METRICS = ['weight_body_mass', 'weight_&_body_mass'];
function weightHistory(state, from, to, unit){
  const dest = ['kg','lb'].includes(unit) ? unit : state.prefs.units==='kg'?'kg':'lb';
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
/* Watch-owned duplicates share at least half the shorter span, whatever the names. Explicit joins
   and splits override overlap; self-reported logs stay separate. The shared selector owns this rule. */
function workoutLinks(state){
  const pairs=list=>(Array.isArray(list)?list:[]).filter(p=>Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='string'));
  const l=state&&state.prefs&&state.prefs.workoutLinks||{};return {join:pairs(l.join),split:pairs(l.split)};
}
/* He says two entries are one workout, or two (V3.2). The latest word on a pair is the one kept. */
function setWorkoutLink(state,a,b,kind){
  if(typeof a!=='string'||typeof b!=='string'||!a||!b||a===b||!['join','split','clear'].includes(kind))return {ok:false,error:'Choose two different workouts.'};
  const l=workoutLinks(state),other=(p)=>!((p[0]===a&&p[1]===b)||(p[0]===b&&p[1]===a));
  state.prefs.workoutLinks={join:l.join.filter(other),split:l.split.filter(other)};
  if(kind!=='clear')state.prefs.workoutLinks[kind].push([a,b]);
  return {ok:true};
}
function workoutSessions(state, rows){
  const normalized=[],unselected=[];
  for(const row of rows){const value=row.origin==='relayed'&&row.reference?WorkoutSessions.record(row.reference,row.date):null;if(value)normalized.push({...value,row});else unselected.push({...row});}
  const selected=WorkoutSessions.select(normalized,workoutLinks(state)).map(w=>{
    const row={...w.row},detail=row.reference.detail||{},hr=detail.hr||{};
    row.reference={...row.reference,detail:{...detail,hr:{...hr,avg:w.hr,min:w.hrMin,max:w.hrMax},distanceM:w.distanceM,steps:w.steps,recovery:w.recovery}};
    if(w.aliases.length){row.also=w.aliases.map(a=>a.writer&&a.writer!==w.writer?a.writer:a.type);row.alsoIds=w.aliases.map(a=>a.id);}row.curveSources=w.curveSources;
    return row;
  });
  return [...selected,...unselected].sort((a,b)=>b.date.localeCompare(a.date)||(b.start||'').localeCompare(a.start||''));
}
function workoutSessionsInRange(state,from,to){
  // Choose ownership before date filtering: a duplicate crossing midnight cannot reappear in a day view.
  let selected=drawMemo&&drawMemo.state===state&&drawMemo.workoutSessions;
  if(!selected){
    const rows=workoutHistory(state,'1000-01-01','9999-12-31').filter(w=>w.origin==='relayed'&&!(w.reference.clashes||[]).length).map(w=>({...w,date:w.reference.unmapped?.healthAutoExport?.day||w.date}));
    selected=workoutSessions(state,rows);if(drawMemo&&drawMemo.state===state)drawMemo.workoutSessions=selected;
  }
  return selected.filter(w=>w.date>=from&&w.date<=to);
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

/* ---- V3.5 K7: a night he types (Settings → Sleep → Add a night), marked self-entered. The Watch's night for the same
        day still fills the ring and wins; a typed night only fills a day the Watch left empty. Additive:
        `state.sleepManual`, one entry per wake day; an earlier build ignores it. ---- */
function pacificInstant(day, hhmm){
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm || '')); if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return null;
  let t = Date.UTC(+day.slice(0,4), +day.slice(5,7) - 1, +day.slice(8,10), +m[1], +m[2]) + 8 * 3600000;
  for (let i = 0; i < 2; i++){ const p = {}; for (const x of new Intl.DateTimeFormat('en-US', {timeZone:'America/Los_Angeles', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(new Date(t))) p[x.type] = x.value;
    const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute), want = Date.UTC(+day.slice(0,4), +day.slice(5,7) - 1, +day.slice(8,10), +m[1], +m[2]); t += want - shown; }
  return new Date(t).toISOString();
}
function addManualNight(state, f){
  const day = String(f && f.day || ''), wake = pacificInstant(day, f && f.wake), bedDay = f && f.bed && f.wake && f.bed > f.wake ? addDays(day, -1) : day, bed = pacificInstant(bedDay, f && f.bed);
  if (!wake || !bed || Date.parse(bed) >= Date.parse(wake)) return {ok:false, error:'Enter a bedtime and a wake time.'};
  const span = (Date.parse(wake) - Date.parse(bed)) / 60000; if (span > 18 * 60) return {ok:false, error:'A night is at most 18 hours.'};
  const typed = f.asleep === '' || f.asleep === undefined || f.asleep === null ? null : Number(f.asleep), asleepMin = typed === null ? Math.round(span) : Math.round(typed * 60);
  if (!Number.isFinite(asleepMin) || asleepMin < 30 || asleepMin > span) return {ok:false, error:'Time asleep must fit between bedtime and wake time.'};
  if (!Array.isArray(state.sleepManual)) state.sleepManual = [];
  const prior = state.sleepManual.find(n => n.day === day), entry = {id:prior ? prior.id : newId('night'), day, bed, wake, asleepMin, at:nowIso(), source:'self-entered'};
  if (prior) Object.assign(prior, entry); else state.sleepManual.push(entry);
  return {ok:true, night:prior || entry};
}
function removeManualNight(state, id){ const list = state.sleepManual || [], i = list.findIndex(n => n.id === id); if (i < 0) return false; list.splice(i, 1); return true; }

/* ---- V3.5 T1: burn and food he types on Today's Fuel card, in kilocalories, for one day; additive
        (`state.energyTyped[date] = {food, burn, at}`); an empty value returns that side to the data. ---- */
function setEnergyTyped(state, date, field, value){
  if (!['food', 'burn'].includes(field) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  const v = value === '' || value === null || value === undefined ? null : Math.round(Number(value));
  if (v !== null && !(v >= 0 && v <= 20000)) return null;
  if (!state.energyTyped || typeof state.energyTyped !== 'object') state.energyTyped = {};
  const d = Object.assign({}, state.energyTyped[date] || {}); if (v === null) delete d[field]; else d[field] = v;
  if (!Number.isFinite(d.food) && !Number.isFinite(d.burn)) { delete state.energyTyped[date]; return {date, cleared:true}; }
  d.at = nowIso(); state.energyTyped[date] = d; return d;
}

/* ---- improvement notes: user-written suggestions stay separate from
        health records and journals in the manually shared brief. ---- */
/* V3.5 K4: no silent cut on his words. The 300-character slice (and maxlength on the fields) cut three notes
   mid-sentence; 20,000 is a guard against a runaway paste, not a limit he meets (ASSUMED 8). */
const NOTE_MAX = 20000, NOTE_HEAD = 300;
/* The stored record keeps the first 300 characters in `text` and the rest in `more`, because V3.4's validator refuses a
   note longer than 300 and would then refuse the whole record (V35-I11; an earlier build must still open it). Read a
   note's words with noteText(). */
function noteText(n){ return n ? String(n.text || '') + (typeof n.more === 'string' ? n.more : '') : ''; }
// His exact words are kept; only a head of spaces alone (which would fail approval) loses its leading spaces; never split inside an emoji: V3.4 reads `text` alone (review notes).
function setNoteText(x, t){ t = String(t || ''); if (!t.slice(0, NOTE_HEAD).trim()) t = t.trimStart(); let cut = NOTE_HEAD; if (t.length > cut){ const c = t.charCodeAt(cut - 1); if (c >= 0xD800 && c <= 0xDBFF) cut--; } x.text = t.slice(0, cut); if (t.length > cut) x.more = t.slice(cut); else delete x.more; return x; }
function addNote(state, text, area){
  const t = String(text || '').trim().slice(0, NOTE_MAX); if (!t) return null;
  if (!state.notes) state.notes = [];
  const n = setNoteText({ id: newId('n'), text: '', area: String(area || ''), at: nowIso(), done: false }, t);
  if (typeof stampedBuildId === 'function') n.build = stampedBuildId();   // V3.3 (3.6): the build the suggestion was written on
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
  const f = fields || {}, text = String(f.text || '').slice(0,NOTE_MAX);
  if (!Array.isArray(state.feedbackDrafts)) state.feedbackDrafts = [];
  // V3.7 K4: three levels; a visual's note and its card's note share the card id, so a draft is matched by level and visual too
  const lvl = x => x.level || 'card', vis = x => x.visual && x.visual.id || '';
  let d = f.id ? state.feedbackDrafts.find(x => x.id === f.id) : state.feedbackDrafts.find(x => x.cardId === f.cardId && x.status === 'draft' && lvl(x) === lvl(f) && vis(x) === vis(f));
  if (f.id && !d) return null;
  if (d && d.status === 'approved') return d;
  if (d){
    if (noteText(d) !== text){ setNoteText(d, text); d.updatedAt = new Date(Math.max(Date.now(), noteChangedAt(d) + 1)).toISOString(); }
    return d;
  }
  if (!text.trim() || typeof f.cardId !== 'string' || !f.cardId || typeof f.cardLabel !== 'string' || !f.cardLabel) return null;
  const at = nowIso();
  d = {id:newId('feedback'),cardId:f.cardId,cardLabel:f.cardLabel,area:String(f.area || ''),text:'',at,updatedAt:at,status:'draft',
    ...(f.page ? {page:String(f.page)} : {}), ...(f.item ? {item:String(f.item)} : {}), ...(f.day ? {day:String(f.day)} : {}),
    ...(f.level === 'page' || f.level === 'visual' ? {level:f.level} : {}), ...(f.level === 'visual' && f.visual && f.visual.id ? {visual:{id:String(f.visual.id).slice(0, 80), label:String(f.visual.label || f.visual.id).slice(0, 80)}} : {}), build:typeof stampedBuildId === 'function' ? stampedBuildId() : undefined};   // V3.3 (3.6): where it was written
  setNoteText(d, text);   // review: the first save trims and splits like every later one
  state.feedbackDrafts.push(d); return d;
}
function promoteFeedbackDraft(state, id){
  const d = (state.feedbackDrafts || []).find(x => x.id === id);
  if (!d || !noteText(d).trim()) return null;
  if (!Array.isArray(state.planIdeas)) state.planIdeas=[];
  if (!Array.isArray(state.learning)) state.learning=[];
  if (!Array.isArray(state.notes)) state.notes = [];
  const noteId = 'n-' + d.id, existing = state.notes.find(n => n.id === noteId);
  if (existing && (existing.sourceDraftId !== d.id || !existing.sourceCard || existing.sourceCard.id !== d.cardId)) return null;
  if (d.status === 'approved') return existing || null;
  const at = new Date(Math.max(Date.now(), noteChangedAt(d) + 1)).toISOString();
  const n = existing || {id:noteId,...setNoteText({}, noteText(d).trim()),area:d.area,at,done:false,sourceCard:{id:d.cardId,label:d.cardLabel,area:d.area,...(d.page ? {page:d.page} : {}),...(d.item ? {item:d.item} : {}),...(d.day ? {day:d.day} : {}),...(d.level ? {level:d.level} : {}),...(d.visual ? {visual:{...d.visual}} : {})},sourceDraftId:d.id,...(d.build ? {build:d.build} : {})};
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
    'Glow improvement brief — ' + today + ' (build ' + stampedBuildId() + ')',
    'Read docs/health-tracker/ROADMAP.md first. Mac is the primary app; phone support comes next.',
    'This brief includes the open suggestions and areas written below. It does not automatically include health records, journal entries, routine details, or measurements. Suggestions may contain personal details you wrote; review before sharing.',
    '',
    open.length ? 'Open suggestions (' + open.length + '):' : 'No open suggestions.',
  ];
  // V3.5 K1/K8: grouped under the day each was written (Pacific), newest first; each line keeps its id first and
  // carries its time, build and item.
  for (const [day, list] of notesByDay(open)){
    lines.push('', noteDayLabel(day) + ' (' + list.length + ')');
    for (const n of list) lines.push('[' + n.id + '] ' + noteText(n) + (n.area ? ' [' + n.area + ']' : '') + (n.sourceCard ? ' (Card: ' + n.sourceCard.label + '; ' + n.sourceCard.id + (n.sourceCard.item ? '; item ' + n.sourceCard.item : '') + ')' : '') + ' · ' + pacificTime(n.at) + (n.build ? ' · build ' + n.build : ''));
  }
  lines.push('', 'Use the stable suggestion IDs when discussing changes. After reviewing an update, mark its suggestion resolved manually in Lessons. Reopen it there if more work is needed.');
  return lines.join('\n');
}

/* ---- V3.5 K1 to K3: the suggestion list's model. ---- */
// Newest day first, newest note first inside a day; the day is the Pacific day it was written.
function notesByDay(list){
  const days = new Map();
  for (const n of list.slice().sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0))){ const k = pacificDay(n.at) || 'undated'; if (!days.has(k)) days.set(k, []); days.get(k).push(n); }
  return [...days.entries()];
}
function noteDayLabel(day){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'Undated';
  return new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric', year:'numeric', timeZone:'UTC'});
}
/* A suggestion moves Open → Planned (a release brief schedules it) → Shipped (a release built it; it waits for his
   look) → Resolved (he confirmed). The planned and shipped maps come from delivery.js (note id → release); the older
   `resolved` map now counts as shipped, because nothing resolves by itself (K3). "Not fixed" records the release he
   rejected, so the note is open again until a later release ships it. */
function noteRelease(n, delivery){
  const d = delivery || {}, shipped = Object.assign({}, d.resolved || {}, d.shipped || {}), planned = d.planned || {};
  if (shipped[n.id] && n.notFixed !== String(shipped[n.id])) return {status:'shipped', release:String(shipped[n.id])};
  if (planned[n.id] && !shipped[n.id]) return {status:'planned', release:String(planned[n.id])};
  return null;
}
function noteStatus(n, delivery){ if (!n) return 'open'; if (n.done) return 'resolved'; const r = noteRelease(n, delivery); return r ? r.status : 'open'; }
function markNotFixed(state, id, text, release){
  const n = (state.notes || []).find(x => x.id === id); if (!n || n.done) return null;
  n.notFixed = String(release || ''); n.notFixedText = setNoteText({}, text).text;
  n.updatedAt = new Date(Math.max(Date.now(), noteChangedAt(n) + 1)).toISOString();
  return n;
}
function notePage(n){ const c = n.sourceCard || null; return c && c.page ? c.page : null; }
/* The export (Copy all open, Copy all including resolved, Copy on a day or a page): each suggestion on its own entry
   with the date and time it was written in Pacific time, its build, page, card and item, its id and his full text,
   grouped under day headers. */
function notesExport(list, title, delivery){
  const out = ['Glow suggestions · ' + title + ' · copied ' + pacificTime(nowIso()) + (typeof stampedBuildId === 'function' ? ' (build ' + stampedBuildId() + ')' : ''), 'Times are Pacific. Use the ids when discussing changes; only Mintay resolves a suggestion.'];
  let i = 0;
  for (const [day, ns] of notesByDay(list)){
    out.push('', '## ' + noteDayLabel(day) + ' (' + ns.length + ')');
    for (const n of ns){
      const c = n.sourceCard || null, r = noteRelease(n, delivery), where = [n.area || 'General'].concat(c ? [c.label + ' (' + c.id + ')'] : [], c && c.item ? ['item ' + c.item] : []).join(' › ');
      out.push((++i) + '. [' + n.id + '] ' + pacificTime(n.at) + ' · ' + where + (n.build ? ' · build ' + n.build : '') + ' · ' + (n.done ? 'Resolved' + (n.doneAt ? ' ' + pacificTime(n.doneAt) : '') : r ? (r.status === 'shipped' ? 'Shipped ' : 'Planned ') + r.release : 'Open'));
      out.push(noteText(n));
      if (n.notFixed && !n.done) out.push('Not fixed in ' + n.notFixed + (n.notFixedText ? ': ' + n.notFixedText : ''));
    }
  }
  if (!i) out.push('', 'No suggestions.');
  return out.join('\n') + '\n';
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
  // Quests and Progress all call S().learning.find or S().planIdeas.filter directly, so
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
  // The nine starter activities first seeded as "examples" are Mintay's own templates (Sept 24
  // evening): they count in Progress and carry no example tag or banner. Invented previews keep theirs.
  if (!state.demo && !state.syntheticWorkspace) for (const s of state.series || []) if (s.demo) s.demo = false;
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
  for (const s of x.series) for (const v of s.versions){ const e = typeof GoalEngine !== 'undefined' ? GoalEngine.validate(v.goal) : null; if (e) return e; }   // V3.6 M1
  { const e = typeof GoalEngine !== 'undefined' ? GoalEngine.validateEntries(x.goalEntries) : null; if (e) return e; }
  { const e = validateIfitSessions(x.ifitSessions) || validateVo2Ledger(x.vo2Ledger); if (e) return e; }   // V3.7 O2, O6: additive, optional
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
      if (!n || typeof n.id !== 'string' || !n.id || ids.has(n.id) || typeof n.text !== 'string' || !n.text.trim() || n.text.length > 300 || (n.more !== undefined && typeof n.more !== 'string') || (n.area !== undefined && typeof n.area !== 'string') || typeof n.done !== 'boolean' || !timestamp(n.at) || (n.doneAt !== undefined && !timestamp(n.doneAt)) || (n.updatedAt !== undefined && !timestamp(n.updatedAt))) return 'An improvement note is malformed.';
      if ((n.sourceCard !== undefined && (!n.sourceCard || ['id','label','area'].some(k => typeof n.sourceCard[k] !== 'string') || !n.sourceCard.id || !n.sourceCard.label)) || (n.sourceDraftId !== undefined && (typeof n.sourceDraftId !== 'string' || !n.sourceDraftId))) return 'An improvement note source is malformed.';
      ids.add(n.id);
    }
  }
  if (x.feedbackDrafts !== undefined){
    if (!Array.isArray(x.feedbackDrafts)) return 'The feedback draft list is malformed.';
    const ids = new Set(), timestamp = t => typeof t === 'string' && Number.isFinite(Date.parse(t));
    for (const d of x.feedbackDrafts){
      if (d && ((d.level !== undefined && d.level !== 'page' && d.level !== 'visual') || (d.visual !== undefined && (!d.visual || typeof d.visual.id !== 'string' || typeof d.visual.label !== 'string')))) return 'A feedback draft level is malformed.';   // V3.7 K4
      if (!d || ['id','cardId','cardLabel','area','text'].some(k => typeof d[k] !== 'string') || !d.id || !d.cardId || !d.cardLabel || ids.has(d.id) || d.text.length > 300 || (d.more !== undefined && typeof d.more !== 'string') || !timestamp(d.at) || !timestamp(d.updatedAt) || !['draft','approved'].includes(d.status)) return 'A feedback draft is malformed.';
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
  { const gp = gradeConfigProblem(x.gradeConfig); if (gp) return gp; }   // V3.5 G1, additive
  if (x.grades !== undefined){
    const g = x.grades;
    if (!g || typeof g !== 'object' || !g.weights || !g.included || GRADE_CATEGORIES.some(id => !Number.isFinite(g.weights[id]) || g.weights[id] < 0 || g.weights[id] > 10 || typeof g.included[id] !== 'boolean')) return 'The category grade settings are malformed.';
  }
  if (x.rewards !== undefined){
    const r = x.rewards, map = v => v && typeof v === 'object' && !Array.isArray(v);
    if (!map(r) || r.version !== 2 || !map(r.claims) || !map(r.evidence) || !map(r.unlocks) || !map(r.progression)) return 'The reward ledger is malformed.';
    if(r.perfectTiers!==undefined){const error=validatePerfectPolicy(r.perfectTiers);if(error)return error;}
    if (!['legacy-10','gentle-v1','confirmed-s11','quarter-v1'].includes(r.progression.rule)) return 'The progression rule is unsupported.';
    if (r.progression.rule === 'gentle-v1' && (!Number.isInteger(r.progression.anchorLevel) || r.progression.anchorLevel < 1 || r.progression.firstThreshold !== r.progression.anchorLevel * 10)) return 'The progression milestone is malformed.';
    for (const [id,c] of Object.entries(r.claims)){
      if(c&&c.ruleVersion===4){const error=validateQuarterClaim(c,id,r);if(error)return error;continue;}
      if (!c || c.id !== id || c.eventId !== id || (c.ruleVersion===3 ? (!Number.isInteger(c.amount)||c.amount<1||c.amount>54) : c.amount!==1) || typeof c.claimedAt !== 'string' || typeof c.date !== 'string' || typeof c.seriesId !== 'string' || ![1,2,3].includes(c.ruleVersion)) return 'A reward claim is malformed.';
      if(c.adjustments && (!Array.isArray(c.adjustments)||c.adjustments.some(a=>!a||!Number.isInteger(a.delta)||typeof a.id!=='string'||typeof a.at!=='string')||claimBalance(c)<0||claimBalance(c)>54))return 'A reward correction is malformed.';
    }
    if(r.ruleStep5!==undefined&&(!map(r.ruleStep5)||r.ruleStep5.step!==5||!validCalendarDate(r.ruleStep5.effectiveFrom)||!map(r.ruleStep5.table)||typeof r.ruleStep5.table.id!=='string'||(r.ruleStep5.tables!==undefined&&(!Array.isArray(r.ruleStep5.tables)||r.ruleStep5.tables.some(t=>!map(t)||typeof t.id!=='string'||!validCalendarDate(t.effectiveFrom))))))return 'The Scoring V2 rule is malformed.';
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
const durableStore = {engine:null,active:false,cache:null,error:null,stagedState:null,adopted:null};
const V3_DB = 'glow-v3';
// V3.1 (one-year storage) writes rollups the V3.0 code cannot read, so it lives in its own database and
// leaves glow-v3 untouched: shipping V3.0.1 back reopens it with nothing to restore (Mintay, Sept 26).
const V31_DB = 'glow-v31';
const legacyRead = store.read.bind(store), legacyWrite = store.write.bind(store), legacyWriteClaims = store.writeClaims.bind(store);
store.connect = async function(){
  let marked=false;
  try { marked=!!localStorage.getItem(STORE_KEY+'.idb-authority'); }
  catch(e){ durableStore.error='The saved workspace cannot be accessed. Your existing files have not been changed.';return; }
  if(typeof globalThis.HealthStore==='undefined'){
    if(marked)durableStore.error='The transactional storage component is unavailable. Reopen the current app; the preserved legacy copy has not been substituted.';
    return;
  }
  const sourceSignature=r=>r.unmapped?.healthAutoExport?.format==='JSON'&&typeof HealthAutoExport!=='undefined'?HealthAutoExport.signature(r):relaySignature(r);
  // V3.0: the record lives in its own schema-2 database. The V2.x database is read once, copied here
  // and never written again, so the previous version can still open it if V3.0 is rolled back.
  const engine=globalThis.HealthStore.create({key:STORE_KEY,dbName:V31_DB,markerKey:STORE_KEY+'.v31-authority',schema:2,validateState,sourceSignature});
  durableStore.engine=engine;
  let opened=await engine.open();
  // First open of this version: copy the newest earlier database (V3.0's, else V2.x's), read by an
  // engine of its own and never written again, so each earlier version can still open its own.
  let markedV3=false;try{markedV3=!!localStorage.getItem(STORE_KEY+'.v3-authority');}catch(e){}
  if(opened.ok&&opened.authority!=='indexeddb'&&(markedV3||marked)){
    const from=markedV3?{database:V3_DB,options:{key:STORE_KEY,dbName:V3_DB,markerKey:STORE_KEY+'.v3-authority',schema:2,validateState,sourceSignature}}:{database:'health-tracker',options:{key:STORE_KEY,validateState,sourceSignature}};
    const legacy=globalThis.HealthStore.create(from.options),prior=await legacy.read(true);
    legacy.close();
    if(!prior.ok||prior.authority!=='indexeddb'){durableStore.error=prior.error||'The previous database could not be read, so it was not copied. Nothing was changed.';return;}
    opened=await engine.adopt(prior.state,{database:from.database,authorityId:prior.control.authorityId,stateSHA256:prior.control.stateSHA256||prior.control.recordSHA256||null,revisions:prior.revisions,deliveries:prior.deliveries});
    if(opened.ok)durableStore.adopted={at:nowIso(),from:from.database,revision:prior.state.revision||0,sources:prior.state.sourceRecords.length};
  }
  if(!opened.ok){durableStore.error=opened.error;if(opened.code==='STAGED'){const legacy=legacyRead();if(legacy.ok&&legacy.state)durableStore.stagedState=legacy.state;}return;}
  // open() is a full verified read already; a second one doubled every launch.
  const loaded=opened.authority==='indexeddb'?opened:await engine.read();
  if(!loaded.ok || loaded.blockedMigration){durableStore.error=loaded.error||'A storage migration is waiting for recovery verification. Nothing else will be saved.';return;}
  if(loaded.authority==='indexeddb'){
    if(loaded.state.autoFeed&&typeof globalThis.HealthAutoExport==='undefined'){durableStore.error='The feed adapter is unavailable. Reopen the complete review app before saving.';return;}
    durableStore.active=true;durableStore.cache=loaded.state;
  }
};
store.read = function(){
  if(durableStore.error)return {ok:false,error:durableStore.error,transactionalError:true};
  if(durableStore.active)return {ok:true,state:cloneRecord(durableStore.cache)};
  return legacyRead();
};
// The committed record this tab last read or saved, without re-reading the whole store. A tap
// starts from it; the engine's write still checks the stored revision and hash, so a change made
// in another window is refused exactly as before (V1.12 speed). Callers must not mutate it.
store.readCommitted = function(){
  if(durableStore.active&&!durableStore.error&&durableStore.cache)return {ok:true,state:durableStore.cache};
  return this.readFresh();
};
store.readFresh = async function(){
  if(!durableStore.active)return this.read();
  const result=await durableStore.engine.read();
  if(!result.ok || result.authority!=='indexeddb')return {ok:false,error:result.error||'The current storage generation could not be read.',transactionalError:true};
  durableStore.cache=result.state;
  return {ok:true,state:cloneRecord(result.state)};
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
  if(result.ok){if(result.duplicateDelivery&&result.state)replaceState(state,result.state);durableStore.cache=cloneRecord(state);result.snapshotSafe=true;}
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
  return { format: EXPORT_FORMAT, schema: SCHEMA, build: stampedBuildId(), exportedAt: nowIso(), data,...(syntheticPreviewData(data)?{syntheticPreview:true}:{}) };
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
  if(inc.rewards?.perfectTiers){const a=cur.rewards?.perfectTiers,b=inc.rewards.perfectTiers;out.add.perfectPolicies=a?b.tables.filter(t=>!a.tables.some(x=>x.effectiveFrom===t.effectiveFrom)).length:b.tables.length;out.add.sleepPreferences=a?b.sleep.filter(t=>!a.sleep.some(x=>x.effectiveFrom===t.effectiveFrom)).length:b.sleep.length;}
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
  for (const k of ['ifitSessions', 'vo2Ledger']){ let n = 0; for (const [id, v] of Object.entries(inc[k] || {})){ cur[k] = cur[k] || {}; if (!cur[k][id]){ cur[k][id] = JSON.parse(JSON.stringify(v)); n++; } } if (n) c[k] = n; }   // V3.7 O2, O6: merged by id; history never moves
  { let n = 0; for (const [sid, list] of Object.entries(inc.goalEntries || {})){ if (!Array.isArray(list)) continue; cur.goalEntries = cur.goalEntries || {}; const mine = cur.goalEntries[sid] = cur.goalEntries[sid] || []; for (const e of list) if (e && e.id && !mine.some(x => x.id === e.id)){ mine.push(JSON.parse(JSON.stringify(e))); n++; } } if (n) c.goalEntries = n; }   // V3.6 M1: hand entries merge by id
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
/* V3.0: committed source rows are frozen and shared (health-store.js schema 2), so copies of the record
   deep-copy everything except them. Code that must change source rows takes its own copy first. */
// O(1): WebKit's Object.isFrozen walks a whole array (V3.0.1).
function sealedRows(rows){return !!(rows&&globalThis.HealthStore&&typeof globalThis.HealthStore.isSealed==='function'&&globalThis.HealthStore.isSealed(rows));}
function cloneRecord(state){
  const out={};
  for(const k of Object.keys(state)){if(state[k]===undefined)continue;out[k]=k==='sourceRecords'&&Array.isArray(state[k])&&sealedRows(state[k])?state[k]:JSON.parse(JSON.stringify(state[k]));}
  return out;
}
function ownSources(state){
  if(Array.isArray(state.sourceRecords)&&sealedRows(state.sourceRecords)){sourceProjectionCache.delete(state);state.sourceRecords=JSON.parse(JSON.stringify(state.sourceRecords));}
  return state.sourceRecords;
}
/* V3.1 one-year storage (Mintay, Sept 26). Heart rate, steps and energy minute rows roll up to one
   row per metric and day once the day is `days` old (35 by default), keeping the day's projected
   totals exactly and its hourly figures (hae-adapter.js rollup). Rows that any evidence, confirmation
   or claim names are kept as they are. */
function rollupKeep(state){
  const keep=new Set(Object.keys(state.rewards?.evidence||{}));
  for(const c of Object.values(state.rewards?.claims||{}))for(const id of c?.evidenceIds||[])keep.add(id);
  for(const o of Object.values(state.occurrences||{}))for(const id of o?.confirmation?.sourceIds||[])keep.add(id);
  return keep;
}
function compactAgedDays(state,today,options){
  const days=Number.isInteger(options?.days)?options.days:35,H=globalThis.HealthAutoExport;
  if(!state.autoFeed||!H||typeof H.rollup!=='function')return {ok:true,rolled:[],removedIds:[]};
  const before=addDays(today||todayYmd(),-days),r=H.rollup(state.sourceRecords||[],state.autoFeed.contract,{before,keep:rollupKeep(state),at:nowIso()});
  if(!r.ok)return {ok:false,error:r.error,rolled:[],removedIds:[]};
  if(!r.rolled.length)return {ok:true,rolled:[],removedIds:[]};
  sourceProjectionCache.delete(state);state.sourceRecords=r.records;
  const prior=state.autoFeed.rollups||{metricDays:0,rows:0};
  state.autoFeed.rollups={through:before,at:nowIso(),metricDays:prior.metricDays+r.rolled.length,rows:prior.rows+r.removedIds.length};
  return {ok:true,rolled:r.rolled,removedIds:r.removedIds,before};
}
function replaceState(cur, inc){
  const next = cloneRecord(inc);
  if (next.sourceRecords !== cur.sourceRecords) sourceProjectionCache.delete(cur);
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
    prefs: { weekStart:1, units:'lb', timezone: tzName(), checkpoint:'2027-01-07', fastingDays: [], theme:'verde', textSize:'normal', quietHours:null },
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
function planForDraw(state,date){
  // Private read-only tree for this draw; public readers copy only the shape they return.
  if(drawMemo&&drawMemo.state===state){
    const plans=drawMemo.plans||(drawMemo.plans=new Map());
    if(!plans.has(date))plans.set(date,planForUncached(state,date));
    return plans.get(date);
  }
  return planForUncached(state,date);
}
function planFor(state,date){
  return drawMemo&&drawMemo.state===state?structuredClone(planForDraw(state,date)):planForUncached(state,date);
}
function planForUncached(state,date){
  if(!wsEnabled(state))return legacyPlanFor(state,date);
  const rows=[];
  for(const series of state.series){
    if(series.archivedAt&&series.archivedAt<=date)continue;
    const v=versionFor(series,date);if(!v)continue;
    const o=state.occurrences[occKey(series.id,date)]||null;if(o?.removed)continue;
    const due=GoalEngine.dueFor(state,series,v,date);   // V3.6 M2: one due rule (scheduledOn, after, a done deadline)
    if(!due&&!(o&&(o.added||o.status!==null||o.committed))&&!v.childIds)continue;
    const ov=o?.override||{},variant=recurrenceVariant(v,date),normal=ov.normal||variant?.normal||v.normal,minimum=ov.minimum||variant?.minimum||v.minimum,selected=o?o.selected:'normal';
    rows.push({key:occKey(series.id,date),seriesId:series.id,date,name:ov.name||wsDayName(v,date),category:v.category||series.category,anchor:ov.anchor||v.anchor,window:ov.window!==undefined?ov.window:v.window||'',order:ov.order??v.order,version:v.version,demo:!!series.demo,targets:{normal,minimum},selected,target:selected==='minimum'?minimum:normal,status:o&&o.status==='done'&&confirmedProgression(state)&&!actionConfirmation(state,o).confirmed?'tentative':o?o.status:null,confirmation:o?.aliasOf?'Same action · linked in Log':o?actionConfirmation(state,o).label:'No entry',completedVersion:o?.completedVersion||null,actualMinutes:o?.actualMinutes??null,note:o?.note||'',corrections:o?.corrections?.length||0,added:!!o?.added,addedFrom:o?.addedFrom||null,overridden:!!o?.override,aliasOf:o?.aliasOf||null,optional:!!v.optional,once:v.recurrence?.kind==='once',group:wsGroup(series,date),parentId:wsHas(ov,'parentId')?ov.parentId:parentFor(series,date),childIds:v.childIds||null,session:v.recurrence?.session||'',variant:variant?.label||'',recurrence:v.recurrence,matching:v.matching||null,targetProgress:null,workspaceKind:wsKind(series,date),budgetQ:v.budgetQ??null,occurrence:o});
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
  // The pinned rule per budget root, found once per call instead of a scan of every occurrence per
  // row (the first match wins, as .find did).
  let pinnedByRoot=null;const pinnedRule=rootId=>{if(!pinnedByRoot){pinnedByRoot=new Map();for(const o of Object.values(state.occurrences))if(o.date===date&&o.quarterRule?.rootId&&!pinnedByRoot.has(o.quarterRule.rootId))pinnedByRoot.set(o.quarterRule.rootId,o.quarterRule);}return pinnedByRoot.get(rootId);};
  if(typeof QuarterPoints!=='undefined')for(const row of leafRows(projected)){
    let ancestor=row,budget=null;while(ancestor){if(Number.isSafeInteger(ancestor.budgetQ))budget=ancestor;ancestor=rows.find(r=>r.seriesId===ancestor.parentId);}
    if(budget){const pinned=pinnedRule(budget.seriesId),leafIds=pinned?.leafIds||leafRows(budget.children||[]).filter(r=>!r.optional).map(r=>r.seriesId),amount=leafIds.length?QuarterPoints.allocateQ(pinned?.budgetQ??budget.budgetQ,leafIds.map(id=>({id}))).find(a=>a.id===row.seriesId)?.amountQ||0:0;row.shareQ=amount;row.shareDisplay=amount/4;row.allocation={amountQ:amount,displayAmount:amount/4,pinned:!!pinned,rootId:budget.seriesId,budgetQ:pinned?.budgetQ??budget.budgetQ};}
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
function wsCommitOn(draft,id,date,committed){const s=draft.series.find(s=>s.id===id),v=s&&versionFor(s,date);if(!v||v.childIds||!validCalendarDate(date)||!scheduledOn(v,date))return {ok:false,error:'Choose an available leaf on this date.'};const o=ensureOcc(draft,id,date);o.committed=!!committed;if(committed&&v.recurrence?.kind==='target'&&v.recurrence.count===1&&v.recurrence.mode!=='rolling'&&!o.status&&!draft.rewards.claims[o.rewardEventId])o.rewardEventId=id+'|week:'+weekStartOf(date,1);touch(o);return {ok:true,record:o};}
function wsTransaction(state,change){
  const draft=state.syntheticWorkspace===true?wsClone(state):cloneRecord(state);wsEnsure(draft);
  try{const result=change(draft);if(result?.ok===false)return result;const error=validateState(draft);if(error)return {ok:false,error};replaceState(state,draft);return result&&result.ok!==undefined?result:{ok:true,record:result||null};}
  catch(error){return {ok:false,error:error.message};}
}
/* Fasting (Mintay, 2026-09-24): outside a season the Wednesday and Friday fasts read "Wed Fasting" and
   "Fri Fasting". A season he adds (its name, first and last day) is a dated version of the same
   Fasting activity — daily and named after the season — and the day after it ends the Wednesday and
   Friday version returns. One fasting task a day; scheduling, rings and points follow the versions. */
const WS_EVERY_DAY=[0,1,2,3,4,5,6];
function wsDayName(v,date){if(v.workspaceKind==='fasting'&&v.name==='Fasting'){const d=dow(date);return d===3?'Wed Fasting':d===5?'Fri Fasting':v.name;}return v.name;}
function wsFastingSeries(state){return state.series.find(s=>s.id==='dw-fasting')||state.series.find(s=>s.versions.some(v=>v.workspaceKind==='fasting'))||null;}
function wsFastingSeasons(state){
  const series=wsFastingSeries(state);if(!series)return [];
  const vs=series.versions.slice().sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)||a.version-b.version),out=[];
  vs.forEach((v,i)=>{if(v.recurrence?.kind==='weekly'&&(v.recurrence.days||[]).length===7&&!vs.slice(i+1).some(n=>n.effectiveFrom===v.effectiveFrom)){const next=vs.slice(i+1).find(n=>n.effectiveFrom>v.effectiveFrom);out.push({name:v.name,from:v.effectiveFrom,to:next?addDays(next.effectiveFrom,-1):null});}});
  return out;
}
function wsAddFastingSeason(state,season){
  const name=String(season?.name||'').trim(),from=season?.from,to=season?.to;
  if(!name)throw new Error('Name the fasting season.');
  if(!validCalendarDate(from)||!validCalendarDate(to)||to<from)throw new Error('Choose a first and last day, in order.');
  const series=wsFastingSeries(state);if(!series)throw new Error('Set up the agreed activities first; the season belongs to your Fasting activity.');
  if(wsFastingSeasons(state).some(x=>x.from<=to&&(x.to===null||x.to>=from)))throw new Error('This overlaps a fasting season you already added.');
  if(series.versions.some(v=>v.effectiveFrom>from))throw new Error('Your Fasting activity has a later change; add the season before editing it further.');
  const before=versionFor(series,addDays(from,-1))||versionFor(series,from);if(!before)throw new Error('Fasting is not scheduled on this date.');
  wsRevise(state,series.id,{name,recurrence:{kind:'weekly',days:WS_EVERY_DAY}},from);
  wsRevise(state,series.id,{name:before.name,recurrence:JSON.parse(JSON.stringify(before.recurrence))},addDays(to,1));
  return {ok:true,season:{name,from,to}};
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
  const out=wsRevise(state,id,changes,date);
  // Fix AA7: a routine's steps travel with it: a new group for the routine is the group of its steps from the same date
  if(wsHas(changes,'category')){const v=versionFor(series,date);for(const cid of (v&&v.childIds)||[]){const c=state.series.find(s=>s.id===cid),cv=c&&versionFor(c,date);if(cv&&(cv.category||c.category)!==changes.category)wsRevise(state,cid,{category:changes.category},date);}}
  return out;
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
/* V3.5 Q5, the brush rule (brief §1, ASSUMED reading of his note C-18): from BRUSH_RULE_FROM the day's first brush is the
   Morning Brush when it starts before 7 pm; any later brush that day is the Night Brush; a first brush at or after 7 pm
   is the Night Brush and leaves the morning open. A brush is a run of brushing minutes with no gap over 20 minutes.
   Days before keep the 3 pm rule, so a check-off already made keeps its evidence (history never moves). */
const BRUSH_RULE_FROM='2026-10-03',BRUSH_EVENING_HOUR=19,BRUSH_GAP_MS=20*60000;
function brushFirstRun(state,date){
  return rowMemo(state,'brushRuns',()=>{
    const by=new Map();
    for(const r of haeRowsFor(state,['toothbrushing'])){const m=r.unmapped?.healthAutoExport;if(!m||m.metric!=='toothbrushing'||m.representation!=='minute aggregate'||!(r.value>0)||(r.clashes||[]).length)continue;const d=sourceLocalDay(r.start);if(!by.has(d))by.set(d,[]);by.get(d).push(r);}
    const out=new Map();
    for(const [d,list] of by){list.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start));const run=new Set([list[0].id]);let end=Date.parse(list[0].start);for(const r of list.slice(1)){const t=Date.parse(r.start);if(t-end>BRUSH_GAP_MS)break;run.add(r.id);end=t;}out.set(d,{hour:sourceLocalHour(list[0].start),run});}
    return out;
  }).get(date)||null;
}
function brushSlot(state,record,date){
  if(date<BRUSH_RULE_FROM)return sourceLocalHour(record.start)>=WS_NIGHT_HOUR?'night':'morning';
  const f=brushFirstRun(state,date);return f&&f.run.has(record.id)&&f.hour<BRUSH_EVENING_HOUR?'morning':'night';
}
function sourceLocalHour(instant){const zone=/([+-])(\d{2}):(\d{2})$/.exec(instant),offset=zone?(zone[1]==='-'?-1:1)*(Number(zone[2])*60+Number(zone[3])):0;return new Date(Date.parse(instant)+offset*60000).getUTCHours();}
function wsProjectedRecord(state,id){const projected=sourceProjection(state);return projected?projected.records.find(r=>r.id===id)||null:null;}
function wsSourceRecord(state,id){
  const build=()=>rowMemo(state,'byId',()=>{const byId=new Map(),projected=sourceProjection(state);for(const r of projected?projected.records:[])if(!byId.has(r.id))byId.set(r.id,r);for(const r of state.sourceRecords||[])byId.set(r.id,r);return byId;});
  if(wsPass&&wsPass.state===state){if(!wsPass.byId)wsPass.byId=build();return wsPass.byId.get(id)||null;}
  if(sealedRows(state.sourceRecords||[]))return build().get(id)||null;
  return (state.sourceRecords||[]).find(r=>r.id===id)||wsProjectedRecord(state,id);
}
/* One automatic evidence pass asks the same questions of the same records for every activity on
   every day of its window: each candidate was re-signed (a deep clone) and every lookup scanned the
   whole store, so a pass grew with the square of the records — 14 s after three days of files, and
   intake held the app's click guard the whole time (V1.8). The pass now indexes its records once by
   day and by id and signs each record once. The cache lives only for that pass, on that draft, and
   the answers are the same (test-auto-evidence.js compares a pass with and without it). */
let wsPass=null;
function wsPassCandidates(state,v,date){
  if(!wsPass.byDay)wsPass.byDay=rowMemo(state,'byDay',()=>{const byDay=new Map();for(const r of state.sourceRecords||[]){const derived=r.unmapped?.healthAutoExport?.representation==='derived daily view'?r.unmapped.healthAutoExport.day:null,day=derived||sourceLocalDay(r.kind==='sleep'?(r.end||r.start):r.start);if(!byDay.has(day))byDay.set(day,[]);byDay.get(day).push(r);}for(const list of byDay.values())Object.freeze(list);return byDay;});
  const stored=wsPass.byDay.get(date)||[],kind=v?.matching?.kind;if(kind!=='steps'&&kind!=='sleep')return stored;
  const projected=sourceProjection(state);if(!projected)return stored;
  return stored.concat(projected.records.filter(r=>r.kind===kind&&r.unmapped?.healthAutoExport?.representation==='derived daily view'&&r.unmapped.healthAutoExport.day===date));
}
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
    // Scoring V2 pays the share of the target walked, so any steps count from its date.
    if(v5Rule(state,date)){if(!Number.isFinite(record.value)||record.value<=0)return 'The evidence does not establish the step target.';}
    else if(!(policy.minimum>0)||!Number.isFinite(record.value)||record.value<policy.minimum)return 'The evidence does not establish the step target.';
    return null;
  }
  if(policy?.kind==='sleep'&&record.kind==='sleep'&&hae?.representation==='derived daily view'){
    if(!wsProjectedRecord(state,record.id))return 'This night is no longer current; review the source.';
    if(syntheticPreviewData(record)&&state.syntheticWorkspace!==true)return 'This source is held, shadowed or unsupported.';
    if(hae.day!==date)return 'This night belongs to another wake day.';
    const need=Math.max(Number(policy.minimum)||0,v.normal?.minutes||0),got=Number.isFinite(record.durationSec)?record.durationSec/60:null;
    // Scoring V2 pays hours ÷ 7 h, so any recorded night counts from its date.
    if(got===null||(v5Rule(state,date)?got<=0:got<need))return 'Recorded sleep is below the chosen target.';
    return null;
  }
  if(policy?.kind==='toothbrushing'&&hae?.metric==='toothbrushing'&&hae.representation==='minute aggregate'){
    if(!sourceIsActive(state,record.id,record)||syntheticPreviewData(record)&&state.syntheticWorkspace!==true)return 'This source is held, shadowed or unsupported.';
    if((record.clashes||[]).length)return 'Review the source correction first.';
    if(sourceLocalDay(record.start)!==date)return 'The source-local date differs from this action.';
    if(!(record.value>0))return 'No brushing time was recorded in this minute.';
    const night=['evening','night'].includes(v.anchor);
    if(date>=BRUSH_RULE_FROM){const occ=state.occurrences[occKey(series.id,date)],eid=occ&&rewardIdentity(state,occ);if(eid&&Object.values(state.rewards?.evidence||{}).some(e=>e.eventId===eid&&e.sourceId===record.id&&!e.retractedAt))return null;   // review S6: a confirmed brush keeps its slot when an earlier minute syncs late
      const slot=brushSlot(state,record,date);
      if(night!==(slot==='night'))return night?'This was the day’s first brush, before 7 pm, so it is the Morning Brush.':brushFirstRun(state,date)?.run.has(record.id)?'The day’s first brush came at or after 7 pm, so it is the Night Brush.':'The day’s first brush came earlier, so this one is the Night Brush.';
      return null;}
    const late=sourceLocalHour(record.start)>=WS_NIGHT_HOUR;
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
  for(const record of wsPass&&wsPass.state===state?wsPassCandidates(state,v,date):wsEvidenceCandidates(state,v,date)){
    const derivedDay=record.unmapped?.healthAutoExport?.representation==='derived daily view'?record.unmapped.healthAutoExport.day:null;
    if((derivedDay||sourceLocalDay(record.kind==='sleep'?(record.end||record.start):record.start))!==date)continue;
    let problem=wsEvidenceProblem(state,record,series,date);
    // Within a pass only eligibility matters, so a record that already has a problem skips the scan.
    const used=problem&&wsPass&&wsPass.state===state?null:Object.values(state.rewards.evidence).find(e=>!e.retractedAt&&e.eventId!==eventId&&(e.sourceId===record.id||e.fingerprint===evidenceFingerprint(record)||evidenceOverlaps(record,wsSourceRecord(state,e.sourceId))));
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
    for(const chosen of selected){if(draft.syntheticWorkspace===true){chosen.record.syntheticPreview=true;o.syntheticPreview=true;if(wsPass)wsPass.fp.delete(chosen.record);}const old=draft.rewards.evidence[chosen.id],history=old?[...(old.history||[]),{fingerprint:old.fingerprint,eventId:old.eventId,acceptedAt:old.acceptedAt,retractedAt:old.retractedAt,updatedAt:old.updatedAt}]:[];draft.rewards.evidence[chosen.id]={sourceId:chosen.id,eventId:rewardIdentity(draft,o),fingerprint:wsEvidenceFingerprint(chosen.record),seriesId:id,date,acceptedAt:at,updatedAt:at,retractedAt:null,ruleVersion:4,history,...(draft.syntheticWorkspace===true?{syntheticPreview:true}:{})};}
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
  if(!wsPass&&!options.uncached){wsPass={state,fp:new WeakMap(),byId:null,byDay:null};try{return wsAutoEvidence(state,options);}finally{wsPass=null;}}
  const today=options.today||todayYmd(),days=options.days||WS_AUTO_DAYS,changes=[];
  for(let i=days-1;i>=0;i--){
    const date=addDays(today,-i);
    for(const series of state.series.slice()){
      const dv=versionFor(series,date);
      if(dv&&dv.matching?.kind==='deficit'){const r=wsAutoDeficit(state,series,date,dv,today);if(r)changes.push(r);continue;}
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
/* V3.3 Phase 2 (7.2): the Deficit item checks itself the same day, once the day's food, resting and active energy are all
   there and the deficit is on track (the item's own onTrack figure); a day he already marked, excused or removed is left
   alone. The check is his own confirmation made by the data (`auto`), so his later edit still wins. */
function wsAutoDeficit(state,series,date,v,today){
  // 7.2: the day itself only. The sweep walks the last week, and a past day's record never moves (P2-13).
  // V3.6 N7 (ASSUMED A5): also yesterday, once, when its food synced after midnight; two or more days back never changes.
  const t0=today||todayYmd();if(date!==t0&&date!==addDays(t0,-1))return null;
  if(series.demo||(series.archivedAt&&series.archivedAt<=date)||!scheduledOn(v,date))return null;
  const o=state.occurrences[occKey(series.id,date)];if(o&&(o.status||o.removed||o.disposition||o.autoDeclined))return null;
  const eb=Workspace.energyBalance(state,date);if(!eb||!eb.complete)return null;
  const need=-NetEnergy.onTrack(state);if(-eb.balance<need)return null;   // V3.6 N1: the one stored threshold, not the series' copy
  const r=confirmAction(state,series.id,date,{});if(!r.ok||!r.occurrence)return null;
  r.occurrence.confirmation={...r.occurrence.confirmation,made:'data',deficit:Math.round(-eb.balance)};   // a data-made confirmation: not a source record (`auto` means source-linked to V3.2.2), not self-reported
  return {seriesId:series.id,date,name:v.name,sourceIds:[],minutes:null};
}
function wsUnsortedWorkouts(state,options={}){
  const today=options.today||todayYmd(),from=addDays(today,-((options.days||WS_AUTO_DAYS)-1)),seen=new Map();
  const workouts=rowMemo(state,'raw-workouts',()=>(state.sourceRecords||[]).filter(r=>r.kind==='workout'));
  for(const r of workouts){
    if(!sourceEvidenceEligible(state,r)||wsWorkoutClass(state,r)!==null)continue;
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
/* V3.4 (Q10, Mintay Sept 30): one Workout target replaces the Cardio and Strength pair: 45 total minutes of recorded
   workouts in the day, any type (steps and incidental movement do not count), from the date he adopts it
   (prefs.workoutTarget = {from, minutes}, additive). Every earlier day keeps the two-ring rule, so history never moves. */
function wsWorkoutTarget(state,date){const t=state.prefs&&state.prefs.workoutTarget;return t&&validCalendarDate(t.from)&&date>=t.from?{from:t.from,minutes:Number(t.minutes)>0?Number(t.minutes):45}:null;}
function wsWorkoutRing(state,date,today){
  const t=wsWorkoutTarget(state,date);if(!t)return null;
  const minutes=Math.round(workoutSessionsInRange(state,date,date).reduce((n,w)=>n+(Number(w.minutes)||0),0)*10)/10;
  return {id:'workout',label:'Workout',unit:'minutes',target:t.minutes,value:minutes,minimum:0,applicable:true,closed:minutes>=t.minutes,status:date>(today||todayYmd())?'future':minutes>=t.minutes?'closed':minutes>0?'partial':'open'};
}
function wsRings(state,date,options={}){
  const all=flatPlanFor(state,date).filter(r=>!r.demo&&(!options.groupId||r.group===options.groupId)&&(!options.includeRow||options.includeRow(r)));
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
  const workout=wsWorkoutRing(state,date,options.today);
  return {date,routine,cardio,strength,workout,closed,applicable,displayedIds,displayedCount,percent:closed/displayedCount*100,noTargets:rings.every(r=>!(r.target>0))};
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
/* Scoring V2 (rule step 5; Mintay Sept 25). From its date, a measurable item pays the share of its target
   that his data shows — sleep ÷ 7 h, steps ÷ 12,000, water ÷ 100 fl oz, the nutrition percentage — and a
   day he marks done himself with no data pays in full (his entry wins). Binary items are unchanged. */
// A table he edits applies from its own date; the one in force on a date scores that date.
function v5Rule(state,date){const r=state.rewards?.ruleStep5;if(!r||typeof ScoringV5==='undefined'||date<r.effectiveFrom)return null;const later=(Array.isArray(r.tables)?r.tables:[]).filter(t=>t&&t.effectiveFrom<=date).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom)).slice(-1)[0];return ScoringV5.table(later||r.table);}
function v5Kind(v){const k=v?.matching?.kind;return k==='sleep'?'sleep':k==='steps'?'steps':k==='water'?'water':k==='deficit'?'nutrition':null;}
function v5Inputs(state,series,o,table){
  const v=versionFor(series,o.date),kind=v5Kind(v);if(!kind)return null;
  let value=null,target=null,inputs=null;
  if(kind==='sleep'){const night=relayedRecords(state,'sleep').find(r=>r.unmapped?.healthAutoExport?.day===o.date&&Number.isFinite(r.durationSec));if(night){value=Math.round(night.durationSec/60);inputs={minutes:value};}target=table.sleepTargetMin;}
  else if(kind==='steps'){const day=relayedRecords(state,'steps').filter(r=>sourceLocalDay(r.start)===o.date&&r.unmapped?.healthAutoExport?.representation==='derived daily view').map(r=>r.value).filter(Number.isFinite);target=Number(v.matching.minimum)||table.stepsTarget;if(day.length){value=Math.max(...day);inputs={steps:value,target};}}
  else if(kind==='water'){const imported=importedNutrition(state,o.date).dietary_water,manual=typeof MealWater!=='undefined'?MealWater.waterSummary(state,o.date).manual.usFlOz:0,oz=(imported?imported.value/29.5735295625:0)+(manual||0);target=Math.max(table.waterFloorOz,Number(v.matching.targetOz)||table.waterTargetOz);if(imported||manual){value=Math.round(oz*10)/10;inputs={oz,targetOz:target};}}
  else if(kind==='nutrition'){const eb=Workspace.energyBalance(state,o.date),m=o.measure||{};target=table.deficitFullKcal;if(eb.available){value=Math.round(-eb.balance);inputs={deficit:value,ateOut:m.ateOut||0,soda:m.soda||0,alcohol:m.alcohol||0};}}
  if(inputs){const c=ScoringV5.credit(kind,inputs,table);if(c)return {kind,credit:c,value,target,source:'data',tableId:table.id,inputs:wsClone(inputs)};}
  // No data for the day: his own check-off counts in full (data first, his final say).
  return o.confirmation?.kind==='source'?null:{kind,credit:{n:1,d:1},value:null,target,source:'self',tableId:table.id,inputs:null};
}
/* Turns Scoring V2 on from `from` (Mon Sep 21 by Mintay's choice). If the scoring period starts later, the
   existing one-time "start from Monday" move runs first in the same transaction. Claims never change. */
function wsAdoptScoringV5(draft,from){
  if(typeof ScoringV5==='undefined')return {ok:false,error:'The Scoring V2 module is unavailable.'};
  if(!quarterProgression(draft))return {ok:false,error:'Adopt the agreed activities before Scoring V2.'};
  if(!validCalendarDate(from))return {ok:false,error:'Choose a valid start date.'};
  if(draft.rewards.ruleStep5)return {ok:false,error:'Scoring V2 is already on from '+draft.rewards.ruleStep5.effectiveFrom+'.'};
  let moved=null;
  if(draft.rewards.progression.effectiveFrom>from){const check=wsBackdateCheck(draft,from);if(!check.ok)return check;moved=wsBackdate(draft,from);if(!moved||moved.ok===false)return moved||{ok:false,error:'The scoring start could not move.'};}
  draft.rewards.ruleStep5={step:5,effectiveFrom:from,table:{...ScoringV5.DEFAULT_TABLE,effectiveFrom:from},adoptedAt:nowIso()};
  return {ok:true,record:{effectiveFrom:from,movedStart:!!moved}};
}
function wsQuarterEntitlement(state,o,epochOverride){
  if(typeof QuarterPoints==='undefined')return null;
  const series=state.series.find(s=>s.id===o.seriesId),v=series&&versionFor(series,o.date),epoch=wsEpoch(state,epochOverride||o.quarterRule?.epochId);
  if(!v||!epoch||o.date<epoch.effectiveFrom||series.demo||v.childIds||o.aliasOf||o.removed||o.status!=='done'||!actionConfirmation(state,o).confirmed)return null;
  const id=rewardIdentity(state,o),old=state.rewards.claims[id];if(old&&old.ruleVersion!==4)return null;
  const p=o.quarterRule;if(!p||p.epochId!==epoch.id)return null;
  const rule=scoringRule(p.scoring);if(!rule.eligible)return null;
  const chain=wsPriorChain(state,p.rootId||o.seriesId,o.goalPeriodStart||o.date,epoch);
  let baseQ,bonusQ,allocation=null,v5=null;
  if(p.budgetQ!==null&&p.budgetQ!==undefined){
    const leaves=(p.leafIds||[]).map(id=>({id}));if(!leaves.some(x=>x.id===o.seriesId)||!leaves.length)return null;
    allocation=QuarterPoints.allocateQ(p.budgetQ,leaves);baseQ=allocation.find(x=>x.id===o.seriesId).amountQ;
    const bonus=QuarterPoints.bonusQ(p.budgetQ,{...chain,recurring:p.recurring});bonusQ=QuarterPoints.allocateQ(bonus,leaves).find(x=>x.id===o.seriesId).amountQ;
    if(wsChainEvent(state,p.rootId,o.date)!=='full')bonusQ=0;
  }else{
    const kind=p.kind;
    if(kind==='cardio'){const quantity=wsEvidenceQuantity(state,o.seriesId,o.date);if(quantity.pending||!quantity.sourceIds.length)return null;baseQ=QuarterPoints.baseQ({kind:'cardio',minutes:quantity.minutes});}
    else if(kind==='strength'){const quantity=wsEvidenceQuantity(state,o.seriesId,o.date);if(quantity.pending||quantity.minutes<(p.normal?.minutes||15)||!quantity.sourceIds.length)return null;baseQ=QuarterPoints.baseQ({importance:rule.importance,difficulty:rule.difficulty});}
    else {if(o.completedVersion==='minimum'&&p.normal?.minutes&&Number(o.actualMinutes)<p.normal.minutes)return null;
      // An item already claimed under the earlier rule keeps that rule for good (claimed points never move).
      const table=!old||old.calculation?.ruleStep===5?v5Rule(state,o.date):null,measured=table?v5Inputs(state,series,o,table):null;
      if(table&&v5Kind(v)&&!measured)return null;   // measurable, no data yet and not self-reported: stays pending
      if(measured){if(!measured.credit.n)return null;v5=measured;}
      baseQ=QuarterPoints.baseQ({importance:rule.importance,difficulty:rule.difficulty,sizeNumerator:v5?v5.credit.n:1,sizeDenominator:(kind==='bathroom'?4:1)*(v5?v5.credit.d:1)});}
    bonusQ=wsChainEvent(state,p.rootId||o.seriesId,o.date)==='full'&&(!v5||v5.credit.n===v5.credit.d)?QuarterPoints.bonusQ(baseQ,{...chain,recurring:p.recurring}):0;
  }
  const amount=baseQ+bonusQ;if(!Number.isSafeInteger(amount)||amount<=0)return null;
  return {id,eventId:id,seriesId:o.seriesId,date:o.date,name:v.name,amount,amountQ:amount,displayAmount:amount/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:o.confirmation?.kind==='source'?'import':'manual',evidenceIds:Object.values(state.rewards.evidence).filter(e=>e.eventId===id&&!e.retractedAt).map(e=>e.sourceId),calculation:{baseQ,bonusQ,priorFull:chain.priorFull,pending:chain.pending,recurring:p.recurring,kind:p.kind,rule:wsClone(rule),budgetQ:p.budgetQ,allocation,minutes:p.kind==='cardio'?wsEvidenceQuantity(state,o.seriesId,o.date).minutes:null,...(v5?{ruleStep:5,credit:wsClone(v5.credit),creditKind:v5.kind,measure:{value:v5.value,target:v5.target,source:v5.source,inputs:v5.inputs},tableId:v5.tableId}:{})},disputed:false};
}
const WS_PERFECT_DEFAULTS=Object.freeze({dayQ:4,weekQ:20,monthQ:80});
function wsValidPerfectTable(t){return t&&typeof t.id==='string'&&!!t.id&&validCalendarDate(t.effectiveFrom)&&['dayQ','weekQ','monthQ'].every(k=>Number.isSafeInteger(t[k])&&t[k]>=0&&t[k]<=4000);}
function validatePerfectPolicy(rule){
  if(!rule||rule.version!==1||!validCalendarDate(rule.effectiveFrom)||typeof rule.adoptedAt!=='string')return 'The dated Perfect rule is malformed.';
  for(const key of ['tables','sleep']){
    const list=rule[key];if(!Array.isArray(list)||!list.length||!list[0]||list[0].effectiveFrom!==rule.effectiveFrom)return 'Perfect history must begin at adoption.';
    if(list.some((t,i)=>!t||!validCalendarDate(t.effectiveFrom)||i&&t.effectiveFrom<=list[i-1].effectiveFrom||(key==='tables'?!wsValidPerfectTable(t):typeof t.enabled!=='boolean')))return 'Perfect history is malformed or repeats a date.';
  }
  if(new Set(rule.tables.map(t=>t.id)).size!==rule.tables.length)return 'Perfect table identities repeat.';
  return null;
}
function wsMergePerfectRules(a,b){
  if(!a||!b)return {rule:wsClone(a||b||null)};
  if(a.effectiveFrom!==b.effectiveFrom||a.adoptedAt!==b.adoptedAt)return {error:'Perfect adoption histories conflict; preserve both exports for review.'};
  const rule=wsClone(a);
  for(const key of ['tables','sleep'])for(const entry of b[key]){const old=rule[key].find(t=>t.effectiveFrom===entry.effectiveFrom);if(old&&JSON.stringify(old)!==JSON.stringify(entry))return {error:'Perfect '+key+' histories conflict on '+entry.effectiveFrom+'. Preserve both exports for review.'};if(!old)rule[key].push(wsClone(entry));}
  for(const key of ['tables','sleep'])rule[key].sort((x,y)=>x.effectiveFrom.localeCompare(y.effectiveFrom));
  return {rule};
}
function wsSetPerfectPolicy(state,values,from){
  if(typeof PerfectVerdicts==='undefined')return {ok:false,error:'Perfect calculations are unavailable; no rule changed.'};
  if(!quarterProgression(state)||!state.rewards.ruleStep5)return {ok:false,error:'Turn on Scoring V2 before Perfect rewards.'};
  const old=state.rewards.perfectTiers,first=old?addDays(todayYmd(),1):todayYmd(),epoch=wsEpoch(state);
  if(!validCalendarDate(from)||from<first||from<epoch.effectiveFrom||from<state.rewards.ruleStep5.effectiveFrom)return {ok:false,error:'Choose '+first+' or later. Earlier days keep their rule.'};
  if(old&&old.tables.some(t=>t.effectiveFrom===from))return {ok:false,error:'A Perfect table already starts on that date; choose a later date.'};
  const table={...WS_PERFECT_DEFAULTS,...values,id:newId('perfect-table'),effectiveFrom:from};
  if(!wsValidPerfectTable(table))return {ok:false,error:'Use 0–1,000 points per tier, in quarter-point steps.'};
  if(old)old.tables.push(table);
  else state.rewards.perfectTiers={version:1,effectiveFrom:from,adoptedAt:nowIso(),tables:[table],sleep:[{effectiveFrom:from,enabled:!!state.prefs.sleepCheckOff}]};
  state.rewards.perfectTiers.tables.sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
  return {ok:true,record:table};
}
function wsSetSleepCheckOff(state,enabled){
  if(typeof enabled!=='boolean')return {ok:false,error:'Choose whether Sleep is on the list.'};
  const rule=state.rewards.perfectTiers;
  if(rule){const date=todayYmd()<rule.effectiveFrom?rule.effectiveFrom:todayYmd();rule.sleep=rule.sleep.filter(t=>t.effectiveFrom!==date).concat({effectiveFrom:date,enabled}).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));}
  state.prefs.sleepCheckOff=enabled;return {ok:true};
}
function wsPerfectPolicy(state,date){
  const rule=state.rewards?.perfectTiers;
  return rule&&date>=rule.effectiveFrom?(rule.tables||[]).filter(t=>t.effectiveFrom<=date).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom))[0]||null:null;
}
function wsPerfectSleepOn(state,date){
  const rule=state.rewards?.perfectTiers;
  if(!rule||date<rule.effectiveFrom)return true; // Earlier verdicts retain the pre-adoption requirement.
  return (rule.sleep||[]).filter(t=>t.effectiveFrom<=date).sort((a,b)=>b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.enabled!==false;
}
function groupHiddenOn(g,date){return !!g&&((g.hidden&&(!g.hiddenFrom||date>=g.hiddenFrom))||(Array.isArray(g.hiddenRanges)&&g.hiddenRanges.some(r=>r&&date>=r.from&&date<=r.to)));}   // V3.5: a dated hide, and the stretches it was hidden before a Show
function wsPerfectVisible(state,group,date){return !(state.groups||[]).some(g=>g.id===group&&groupHiddenOn(g,date));}
function wsPerfectIncluded(state,row,date){return wsPerfectVisible(state,row.group,date)&&(wsPerfectSleepOn(state,date)||row.matching?.kind!=='sleep');}
function wsPerfectFitness(row){return row.group==='fitness'||['cardio','strength','steps'].includes(row.workspaceKind);}
function wsQuotaChances(state,seriesId,from,to){
  const series=state.series.find(s=>s.id===seriesId);if(!series)return 0;
  let count=0;
  for(let d=from;d<=to;d=addDays(d,1)){
    if(series.archivedAt&&series.archivedAt<=d)break;
    const v=versionFor(series,d),o=state.occurrences[occKey(seriesId,d)];
    if(!v||!scheduledOn(v,d)||o&&(o.removed||o.disposition==='excused'||o.disposition==='rest'))continue;
    count++;
  }
  return count;
}
function wsPerfectVerdict(state,date){
  if(typeof PerfectVerdicts==='undefined')return {date,perfect:null,fitness:null,due:0,done:0,open:[],fitnessDue:0,fitnessDone:0,fitnessOpen:[],unavailable:true};
  const workout=wsWorkoutTarget(state,date),rows=flatPlanFor(state,date).filter(r=>!r.demo&&wsPerfectIncluded(state,r,date)&&!(workout&&['cardio','strength'].includes(r.workspaceKind)));   // from its start the Workout ring stands for Cardio and Strength (Q10)
  const rings=wsRings(state,date,wsPerfectPolicy(state,date)?{includeRow:r=>wsPerfectIncluded(state,r,date)}:{});
  const items=rows.map(r=>{const o=state.occurrences[r.key]||{},q=r.targetProgress,parent=r.parentId&&state.series.find(s=>s.id===r.parentId),name=parent&&versionFor(parent,date)?.name;
    const gv=(state.series.find(x=>x.id===r.seriesId)||null),gver=gv&&versionFor(gv,date),gp=GoalEngine.windowed(gver)?GoalEngine.progress(state,gv,date,goalReadings):null,dl=gp&&gver.goal.measure.kind==='check'&&gver.goal.when.kind==='deadline'&&!gp.met&&date<gver.goal.when.date;   // V3.6 M3: a goal counts when met (a limit while it holds, review F6, F7); a deadline check is neutral until its day (F2)
    const onPace=gp&&!gp.met&&gp.window&&gp.window.from&&gp.window.to&&gp.window.from!==gp.window.to&&['sum','count'].includes(gp.measure)&&gp.op==='atLeast'&&Number.isFinite(gp.target)&&gp.target>0&&(gp.value||0)>=gp.target*Math.min(1,(calendarDistance(gp.window.from,date)+1)/(calendarDistance(gp.window.from,gp.window.to)+1))-0.005*gp.target;   // AN1: a weekly or monthly amount on pace counts the day
    return {id:r.seriesId,name:(name?name+' · ':'')+r.name,fitness:wsPerfectFitness(r),done:gp?(gp.met||!!onPace):r.status==='done',neutral:dl||o.disposition==='excused'||o.disposition==='rest',optional:!!r.optional,quota:q?{from:q.from,to:q.to,target:q.target,count:q.count,left:wsQuotaChances(state,r.seriesId,date,q.to)}:null};});
  const ring=r=>r?{applicable:!!r.applicable&&!rings.noTargets,closed:!!r.closed,label:(r.label||'Ring')+' ring'}:null;
  return PerfectVerdicts.day({date,items,rings:rings.workout?{cardio:{applicable:true,closed:rings.workout.closed,label:'Workout ring'},strength:null}:{cardio:ring(rings.cardio),strength:ring(rings.strength)}});
}
function wsPerfectQuotas(state,from,to,monthly,today=todayYmd()){
  const out=[];
  for(const s of state.series){
    if(s.demo||s.archivedAt&&s.archivedAt<=from||!s.versions.some(v=>v.recurrence?.kind==='target'))continue;
    for(let d=from;d<=to&&d<=today;){
      const v=versionFor(s,d),r=v?.recurrence,w=r?.kind==='target'?recurrenceWindow(v,d,state):null;
      if(!w){d=addDays(d,1);continue;}
      const end=w.mode==='rolling'?(to<today?to:today):w.to;
      if(end>to)break;
      const at=end<today?end:today,group=wsGroup(s,at),current=versionFor(s,at);
      const p=(r.weeks>1)===!!monthly&&wsPerfectVisible(state,group,at)&&(wsPerfectSleepOn(state,at)||current?.matching?.kind!=='sleep')?targetProgress(state,s.id,at):null;
      if(p)out.push({name:current?.name||v.name,fitness:wsPerfectFitness({group,workspaceKind:current?.workspaceKind}),target:p.target,count:p.count,to:end,neutral:p.count<p.target&&wsQuotaChances(state,s.id,p.from,end)===0});
      if(w.mode==='rolling')break;
      d=addDays(w.to,1);
    }
  }
  return out;
}
function wsPerfectSpan(state,from,to,monthly,track,today=todayYmd()){
  if(typeof PerfectVerdicts==='undefined')return {perfect:null,unavailable:true};
  const days=[];for(let d=from;d<=to;d=addDays(d,1))days.push(wsPerfectVerdict(state,d));
  return PerfectVerdicts.span(days,wsPerfectQuotas(state,from,to,monthly,today),today,track);
}
function wsProtectedClaim(c){return !!c&&(c.seriesId?.startsWith('@perfect:')||['@dated-day-v1','@dated-week-v1'].includes(c.seriesId));}
function wsFixedCalculation(seriesId,amount,metadata){return {baseQ:amount,bonusQ:0,priorFull:0,pending:false,recurring:false,budgetQ:amount,allocation:[{id:seriesId,amountQ:amount}],...metadata};}
function wsProtectLine(line,kind,policy,table,qualified){
  const seriesId='@dated-'+kind+'-v1',math=wsClone(line.calculation);
  return {...line,seriesId,calculation:wsFixedCalculation(seriesId,line.amount,{[kind==='day'?'datedDayLine':'datedWeekLine']:{version:1,policyId:policy.id,effectiveFrom:policy.effectiveFrom,table:wsClone(table),math,...(kind==='day'?{deficitQualified:!!qualified}:{})}})};
}
function wsPerfectAwards(state,today,epoch){
  const rule=state.rewards?.perfectTiers;if(!rule||typeof PerfectVerdicts==='undefined')return [];
  if(!drawMemo||drawMemo.state!==state)return withDrawMemo(state,()=>wsPerfectAwards(state,today,epoch));
  const from=rule.effectiveFrom>epoch.effectiveFrom?rule.effectiveFrom:epoch.effectiveFrom,out=[],days=new Map();
  const verdict=d=>{if(!days.has(d))days.set(d,wsPerfectVerdict(state,d));return days.get(d);};
  const award=(track,tier,start,end,earned)=>{
    if(!earned||start<from||end>today)return;
    const id='perfect-v1|'+track+'|'+tier+'|'+start,old=state.rewards.claims[id],policy=old?.calculation?.perfectTier?.policy||wsPerfectPolicy(state,start),amount=policy?.[tier+'Q'];
    if(!(amount>0)||old&&old.epochId!==epoch.id)return;
    const seriesId='@perfect:'+track+':'+tier;
    out.push({id,eventId:id,seriesId,date:end,name:'Perfect'+(track==='fitness'?' Fitness':'')+' '+tier[0].toUpperCase()+tier.slice(1),amount,amountQ:amount,displayAmount:amount/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:'manual',evidenceIds:[],disputed:false,calculation:wsFixedCalculation(seriesId,amount,{perfectTier:{version:1,track,tier,from:start,to:end,policy:wsClone(policy)}})});
  };
  for(let date=from;date<=today;date=addDays(date,1)){const v=verdict(date);for(const track of ['perfect','fitness'])award(track,'day',date,date,v[track]===true);}
  const span=(start,end,tier)=>{if(start<from||end>=today)return;const list=[];for(let d=start;d<=end;d=addDays(d,1))list.push(verdict(d));const quotas=wsPerfectQuotas(state,start,end,tier==='month',today);for(const track of ['perfect','fitness'])award(track,tier,start,end,PerfectVerdicts.span(list,quotas,today,track).perfect===true);};
  for(let start=weekStartOf(from,1);start<today;start=addDays(start,7))span(start,addDays(start,6),'week');
  for(let start=from.slice(0,7)+'-01';start<today;){const next=addDays(start.slice(0,7)+'-28',7).slice(0,7)+'-01';span(start,addDays(next,-1),'month');start=next;}
  return out;
}

/* Scoring V2 day and week lines (V2.0; Mintay Sept 24–25). One claim per day ('v5day|date', series '@day'):
   a perfect day (three rings closed and every required item done) adds 5% of that day's item points; steps
   add 1 point per 3,000 over 12,000 (at most 4); a complete day's deficit adds the curve points (500 → 8,
   800 → 10, 1,000 → 12); the day never passes 150% of its item points. One claim per finished week
   ('v5week|monday', series '@week'): a perfect week (every day with required items perfect) adds 10% of
   the week's item points, and Sleep Credit pays an ordinary item's points times its credit. */
function wsPerfectDay(state,date,dated=false){
  const includeRow=r=>!dated||wsPerfectIncluded(state,r,date);
  let rings=null;try{rings=Workspace.rings(state,date,dated?{includeRow}:{});}catch(_){rings=null;}
  if(!rings||typeof rings!=='object'||rings.noTargets)return null;
  const req=flatPlanFor(state,date).filter(r=>!r.optional&&!r.demo&&r.status!=='skipped'&&includeRow(r));
  if(!req.length)return null;
  const closed=rings.closed===3||dated&&!rings.routine.applicable&&rings.cardio.closed&&rings.strength.closed;
  return closed&&req.every(r=>r.status==='done');
}
function v5StepsDay(state,date){const v=relayedRecords(state,'steps').filter(r=>sourceLocalDay(r.start)===date&&r.unmapped?.healthAutoExport?.representation==='derived daily view').map(r=>r.value).filter(Number.isFinite);return v.length?Math.max(...v):null;}
function wsDayLine(state,date,itemsQ,epoch,allowZero){
  const old=state.rewards.claims['v5day|'+date],pinned=old?.calculation?.datedDayLine,table=pinned?.table||v5Rule(state,date);if(!table||(!(itemsQ>0)&&!allowZero))return null;itemsQ=itemsQ>0?itemsQ:0;
  const policy=pinned?{id:pinned.policyId,effectiveFrom:pinned.effectiveFrom}:!old?wsPerfectPolicy(state,date):null;
  if(policy&&typeof PerfectVerdicts==='undefined')return null;
  const perfect=wsPerfectDay(state,date,!!policy)===true,perfectQ=perfect?Math.floor(itemsQ*table.perfectDayPct/100):0;
  const steps=v5StepsDay(state,date),stepsQ=steps&&steps>table.stepsTarget?Math.min(4,Math.floor((steps-table.stepsTarget)/3000))*4:0;
  const eb=Workspace.energyBalance(state,date),qualified=!!(eb&&eb.available&&(policy?eb.complete:eb.reviewed)),deficitQ=qualified?ScoringV5.deficitPoints(policy?Math.round(-eb.balance):-eb.balance,table)*4:0;
  const capQ=ScoringV5.dailyCapQ(itemsQ,table),room=Math.max(0,capQ-itemsQ),raw=perfectQ+stepsQ+deficitQ,amount=Math.max(0,Math.min(raw,room));
  if(amount<=0&&!allowZero)return null;
  const id='v5day|'+date;
  const line={id,eventId:id,seriesId:'@day',date,name:'Day bonus'+(perfect?' · perfect day':''),amount,amountQ:amount,displayAmount:amount/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:'import',evidenceIds:[],
    calculation:{dayLine:5,tableId:table.id,itemsQ,perfect,perfectQ,stepsQ,deficitQ,capQ,trimQ:raw-amount,steps,stepsTarget:table.stepsTarget,deficitCurve:table.deficitCurve,deficit:eb&&eb.available?Math.round(-eb.balance):null,baseQ:amount,bonusQ:0,priorFull:0,pending:false,recurring:false},disputed:false};
  return policy?wsProtectLine(line,'day',policy,table,qualified):line;
}
function wsWeekLine(state,monday,itemsByDate,epoch,today,allowZero){
  const old=state.rewards.claims['v5week|'+monday],pinned=old?.calculation?.datedWeekLine,table=pinned?.table||v5Rule(state,monday),sunday=addDays(monday,6);if(!table||sunday>=today)return null;
  const days=Array.from({length:7},(_,i)=>addDays(monday,i)).filter(d=>d>=epoch.effectiveFrom&&d>=state.rewards.ruleStep5.effectiveFrom);if(days.length<7)return null;
  const policy=pinned?{id:pinned.policyId,effectiveFrom:pinned.effectiveFrom}:!old?wsPerfectPolicy(state,monday):null;
  if(policy&&typeof PerfectVerdicts==='undefined')return null;
  const weekQ=days.reduce((n,d)=>n+(itemsByDate.get(d)||0),0),states=days.map(d=>wsPerfectDay(state,d,!!policy)),perfect=states.every(x=>x!==false)&&states.some(x=>x===true);
  const perfectQ=perfect?Math.floor(weekQ*table.perfectWeekPct/100):0;
  const nights=days.map(d=>{const night=relayedRecords(state,'sleep').find(r=>r.unmapped?.healthAutoExport?.day===d&&Number.isFinite(r.durationSec));return {date:d,minutes:night?Math.round(night.durationSec/60):null};});
  const sc=ScoringV5.sleepCredit(nights,table),creditQ=sc.credit&&sc.credit.n?QuarterPoints.baseQ({importance:3,difficulty:2,sizeNumerator:sc.credit.n,sizeDenominator:sc.credit.d}):0;
  const amount=perfectQ+creditQ;if(amount<=0&&!allowZero)return null;
  const id='v5week|'+monday;
  const line={id,eventId:id,seriesId:'@week',date:sunday,name:'Week bonus'+(perfect?' · perfect week':'')+(creditQ?' · Sleep Credit':''),amount,amountQ:amount,displayAmount:amount/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:'import',evidenceIds:[],
    calculation:{weekLine:5,tableId:table.id,weekQ,perfect,perfectQ,sleepBalanceMin:sc.balanceMin,credit:sc.credit,creditQ,baseQ:amount,bonusQ:0,priorFull:0,pending:false,recurring:false},disputed:false};
  return policy?wsProtectLine(line,'week',policy,table):line;
}
function wsBonusLines(state,eligible,today,epoch,allowZero){
  if(!state.rewards?.ruleStep5||typeof ScoringV5==='undefined')return [];
  // Several reports run per screen draw; the lines are computed once per draw for the same inputs.
  const memoKey=drawMemo&&drawMemo.state===state&&!allowZero?JSON.stringify([today,epoch.id,eligible.length,eligible.reduce((n,e)=>n+e.amount,0)]):null;
  if(memoKey&&drawMemo.bonusKey===memoKey)return drawMemo.bonus;
  const from=state.rewards.ruleStep5.effectiveFrom>epoch.effectiveFrom?state.rewards.ruleStep5.effectiveFrom:epoch.effectiveFrom,byDate=new Map();
  for(const e of eligible)if(e.seriesId&&e.seriesId[0]!=='@')byDate.set(e.date,(byDate.get(e.date)||0)+e.amount);
  for(const c of Object.values(state.rewards.claims))if(c.ruleVersion===4&&c.epochId===epoch.id&&c.seriesId&&c.seriesId[0]!=='@'&&!eligible.some(e=>e.id===c.id))byDate.set(c.date,(byDate.get(c.date)||0)+claimBalance(c));
  const out=[];
  for(let d=from;d<=today;d=addDays(d,1)){const line=wsDayLine(state,d,byDate.get(d)||0,epoch,allowZero);if(line)out.push(line);}
  for(let m=weekStartOf(from,1);addDays(m,6)<today;m=addDays(m,7)){const line=wsWeekLine(state,m,byDate,epoch,today,allowZero);if(line)out.push(line);}
  if(memoKey){drawMemo.bonusKey=memoKey;drawMemo.bonus=out;}
  return out;
}
// V3.7 X8: a goal line pays importance x difficulty x the window's credit share, once at the window's close. The amount is
// recomputed from the stored rule and share, and every correction is checked the same way (or is a zero with no calculation).
function validateGoalLineClaim(c,id){
  const sid=typeof c.seriesId==='string'&&c.seriesId.startsWith('@goal:')?c.seriesId.slice(6):null;if(!sid||id!=='goal:'+sid+'|'+c.date)return 'A goal line is malformed.';
  const one=(amount,calc)=>{const g=calc&&calc.goal,r=calc&&calc.rule;if(!calc||calc.ruleStep!=='goal-v1'||calc.bonusQ!==0||calc.baseQ!==amount||!g||!validCalendarDate(g.from)||g.to!==c.date||g.from>g.to||!Number.isSafeInteger(g.share)||g.share<1||g.share>100||!r)return false;
    try{return QuarterPoints.baseQ({importance:r.importance,difficulty:r.difficulty,sizeNumerator:g.share,sizeDenominator:100})===amount;}catch(_){return false;}};
  if(!one(c.amount,c.calculation))return 'A goal line differs from its calculation.';
  const adj=c.adjustments||[];let running=c.amount;
  if(!Array.isArray(adj))return 'A goal line correction is malformed.';
  for(let i=0;i<adj.length;i++){const a=adj[i];if(!a||!Number.isSafeInteger(a.delta)||a.delta===0||a.unit!=='quarter-point'||a.epochId!==c.epochId||a.ruleVersion!==4||typeof a.id!=='string'||typeof a.at!=='string'||a.revision!==i+1)return 'A goal line correction is malformed.';
    running+=a.delta;if(running<0||(a.calculation===null?running!==0:!one(running,a.calculation)))return 'A goal line correction differs from its calculation.';}
  return null;
}
function validateLineClaim(c,id){
  const calc=c.calculation,int=v=>Number.isSafeInteger(v)&&v>=0;
  if(calc.baseQ!==c.amount||calc.bonusQ!==0||typeof calc.tableId!=='string')return 'A bonus line is malformed.';
  if(calc.dayLine===5){if(c.seriesId!=='@day'||id!=='v5day|'+c.date||![calc.itemsQ,calc.perfectQ,calc.stepsQ,calc.deficitQ,calc.capQ,calc.trimQ].every(int)||calc.stepsQ>16||calc.stepsQ%4||![0,32,40,48].includes(calc.deficitQ)||(!calc.perfect&&calc.perfectQ)||calc.perfectQ*20>calc.itemsQ||calc.perfectQ+calc.stepsQ+calc.deficitQ-calc.trimQ!==c.amount||c.amount+calc.itemsQ>calc.capQ)return 'A day bonus differs from its calculation.';
    // The extras are recomputed from the recorded steps and deficit, so an altered amount cannot pass.
    const target=Number.isSafeInteger(calc.stepsTarget)?calc.stepsTarget:12000,stepsQ=Number.isFinite(calc.steps)&&calc.steps>target?Math.min(4,Math.floor((calc.steps-target)/3000))*4:0;
    const deficitQ=calc.deficit===null||calc.deficit===undefined?0:ScoringV5.deficitPoints(calc.deficit,{deficitCurve:Array.isArray(calc.deficitCurve)?calc.deficitCurve:ScoringV5.DEFAULT_TABLE.deficitCurve})*4;
    if(calc.stepsQ!==stepsQ||(calc.deficitQ&&calc.deficitQ!==deficitQ))return 'A day bonus differs from its calculation.';return null;}
  if(calc.weekLine===5){if(c.seriesId!=='@week'||!id.startsWith('v5week|')||![calc.weekQ,calc.perfectQ,calc.creditQ].every(int)||(!calc.perfect&&calc.perfectQ)||calc.perfectQ*10>calc.weekQ||calc.perfectQ+calc.creditQ!==c.amount)return 'A week bonus differs from its calculation.';
    if(calc.creditQ){const cr=calc.credit;if(!cr||!Number.isSafeInteger(cr.n)||!Number.isSafeInteger(cr.d)||cr.n<1||cr.n>cr.d||QuarterPoints.baseQ({importance:3,difficulty:2,sizeNumerator:cr.n,sizeDenominator:cr.d})!==calc.creditQ)return 'A Sleep Credit award differs from its calculation.';}return null;}
  return 'A bonus line is unsupported.';
}
function validatePerfectClaim(c,id,rewards){
  const calc=c.calculation,keys=['perfectTier','datedDayLine','datedWeekLine'].filter(k=>calc[k]!==undefined);
  if(!wsProtectedClaim(c)&&!keys.length)return null;
  const bad='A dated Perfect award differs from its pinned calculation.';
  if(!wsProtectedClaim(c)||keys.length!==1||calc.dayLine!==undefined||calc.weekLine!==undefined||calc.ruleStep!==undefined||calc.bonusQ!==0||calc.priorFull!==0||calc.pending!==false||calc.recurring!==false||calc.budgetQ!==c.amount||JSON.stringify(calc.allocation)!==JSON.stringify([{id:c.seriesId,amountQ:c.amount}]))return bad;
  const key=keys[0],p=calc[key],rule=rewards.perfectTiers;if(!p||p.version!==1||!rule)return bad;
  if(key==='perfectTier'){
    if(!['perfect','fitness'].includes(p.track)||!['day','week','month'].includes(p.tier)||!validCalendarDate(p.from)||!validCalendarDate(p.to)||!wsValidPerfectTable(p.policy)||p.policy.effectiveFrom>p.from||c.date!==p.to||c.seriesId!=='@perfect:'+p.track+':'+p.tier||id!=='perfect-v1|'+p.track+'|'+p.tier+'|'+p.from||c.amount!==p.policy[p.tier+'Q'])return bad;
    const end=p.tier==='day'?p.from:p.tier==='week'?addDays(p.from,6):addDays(addDays(p.from.slice(0,7)+'-28',7).slice(0,7)+'-01',-1);
    if(p.to!==end||p.tier==='week'&&weekStartOf(p.from,1)!==p.from||p.tier==='month'&&!p.from.endsWith('-01'))return bad;
    const stored=rule.tables.find(t=>t.id===p.policy.id);if(!stored||JSON.stringify(stored)!==JSON.stringify(p.policy)||p.from<rule.effectiveFrom)return bad;
    return null;
  }
  const day=key==='datedDayLine',m=p.math,t=p.table,legacy={...c,seriesId:day?'@day':'@week',calculation:m};
  const start=day?c.date:id.slice(7),stored=rule.tables.find(t=>t.id===p.policyId);
  if(typeof p.policyId!=='string'||!p.policyId||!stored||stored.effectiveFrom!==p.effectiveFrom||!validCalendarDate(p.effectiveFrom)||!t||!m||m.tableId!==t.id||!validCalendarDate(t.effectiveFrom)||t.effectiveFrom>start||c.seriesId!==(day?'@dated-day-v1':'@dated-week-v1')||typeof m.perfect!=='boolean'||p.effectiveFrom>start||start<rule.effectiveFrom||validateLineClaim(legacy,id))return bad;
  if(![t.stepsTarget,t.perfectDayPct,t.perfectWeekPct,t.dailyCapPct].every(v=>Number.isFinite(v)&&v>=0)||t.dailyCapPct<100||!Array.isArray(t.deficitCurve)||!t.deficitCurve.length||t.deficitCurve.some(row=>!Array.isArray(row)||row.length!==2||!row.every(v=>Number.isFinite(v)&&v>=0)))return bad;
  const known=[rewards.ruleStep5?.table,...(rewards.ruleStep5?.tables||[])].find(x=>x?.id===t.id);
  if(known&&wsSignature(ScoringV5.table(known))!==wsSignature(t))return bad;
  if(day){
    if(m.dayLine!==5||m.weekLine!==undefined||typeof p.deficitQualified!=='boolean'||m.stepsTarget!==t.stepsTarget||JSON.stringify(m.deficitCurve)!==JSON.stringify(t.deficitCurve)||m.perfectQ!==(m.perfect?Math.floor(m.itemsQ*t.perfectDayPct/100):0)||m.capQ!==ScoringV5.dailyCapQ(m.itemsQ,t)||m.deficitQ!==(p.deficitQualified?ScoringV5.deficitPoints(m.deficit,t)*4:0))return bad;
    const raw=m.perfectQ+m.stepsQ+m.deficitQ;if(c.amount!==Math.max(0,Math.min(raw,m.capQ-m.itemsQ))||m.trimQ!==raw-c.amount)return bad;
  }else{
    const monday=id.slice(7);if(m.weekLine!==5||m.dayLine!==undefined||!validCalendarDate(monday)||weekStartOf(monday,1)!==monday||c.date!==addDays(monday,6)||m.perfectQ!==(m.perfect?Math.floor(m.weekQ*t.perfectWeekPct/100):0))return bad;
    const s=t.sleepCredit;if(!s||![s.weekTargetMin,s.fullDebtMin,s.zeroDebtMin,s.bankCapMin].every(v=>Number.isSafeInteger(v)&&v>=0)||s.zeroDebtMin<=s.fullDebtMin||!(s.weekTargetMin>0)||m.sleepBalanceMin!==null&&!Number.isSafeInteger(m.sleepBalanceMin))return bad;
    const debt=m.sleepBalanceMin===null?null:Math.max(0,-m.sleepBalanceMin),credit=debt===null?null:debt<=s.fullDebtMin?{n:1,d:1}:debt>=s.zeroDebtMin?{n:0,d:1}:ScoringV5.fraction(s.zeroDebtMin-debt,s.zeroDebtMin-s.fullDebtMin);
    if(JSON.stringify(credit)!==JSON.stringify(m.credit))return bad;
    if(m.creditQ!==(credit&&credit.n?QuarterPoints.baseQ({importance:3,difficulty:2,sizeNumerator:credit.n,sizeDenominator:credit.d}):0))return bad;
  }
  return null;
}
function validateQuarterClaim(c,id,rewards){
  if(c.id!==id||c.eventId!==id||c.unit!=='quarter-point'||typeof c.epochId!=='string'||!(rewards.epochs||[]).some(e=>e.id===c.epochId)||!Number.isSafeInteger(c.amount)||c.amount<1||!validCalendarDate(c.date)||typeof c.seriesId!=='string'||typeof c.claimedAt!=='string')return 'A quarter-point claim is malformed.';
  const calc=c.calculation;if(!calc||!Number.isSafeInteger(calc.baseQ)||calc.baseQ<0||!Number.isSafeInteger(calc.bonusQ)||calc.bonusQ<0||calc.baseQ+calc.bonusQ!==c.amount)return 'A quarter-point calculation is malformed.';
  if(calc.ruleStep==='goal-v1')return validateGoalLineClaim(c,id);   // V3.7 X8 (re-attack): a goal line has its own shape
  try{const protectedError=validatePerfectClaim(c,id,rewards);if(protectedError)return protectedError;}catch(_){return 'A dated Perfect calculation is malformed.';}
  if(calc.dayLine!==undefined||calc.weekLine!==undefined){const bad=validateLineClaim(c,id);if(bad)return bad;const adj=c.adjustments||[];if(!Number.isSafeInteger(claimBalance(c))||claimBalance(c)<0||adj.some((a,i)=>!a||!Number.isSafeInteger(a.delta)||a.delta===0||a.unit!=='quarter-point'||a.epochId!==c.epochId||a.ruleVersion!==4||a.revision!==i+1||!a.calculation||validateLineClaim({...c,amount:c.amount+adj.slice(0,i+1).reduce((n,x)=>n+x.delta,0),calculation:a.calculation},id)))return 'A bonus top-up is malformed.';return null;}
  if(!Number.isSafeInteger(calc.priorFull)||calc.priorFull<0||typeof calc.pending!=='boolean'||typeof calc.recurring!=='boolean')return 'A quarter-point chain is malformed.';
  try{
    const maxBonus=QuarterPoints.bonusQ(calc.baseQ,{priorFull:calc.priorFull,pending:calc.pending,recurring:calc.recurring});
    if(calc.ruleStep!==undefined&&(calc.ruleStep!==5||calc.budgetQ!=null||calc.kind==='cardio'||!calc.credit||!Number.isSafeInteger(calc.credit.n)||!Number.isSafeInteger(calc.credit.d)||calc.credit.n<1||calc.credit.d<1||calc.credit.n>calc.credit.d||typeof calc.tableId!=='string'||(calc.credit.n<calc.credit.d&&calc.bonusQ!==0)))return 'A Scoring V2 credit is malformed.';
    const cn=calc.ruleStep===5?calc.credit.n:1,cd=calc.ruleStep===5?calc.credit.d:1;
    if(calc.budgetQ==null){const expected=calc.kind==='cardio'?QuarterPoints.baseQ({kind:'cardio',minutes:calc.minutes}):QuarterPoints.baseQ({importance:calc.rule.importance,difficulty:calc.rule.difficulty,sizeNumerator:cn,sizeDenominator:(calc.kind==='bathroom'?4:1)*cd});if(expected!==calc.baseQ||calc.bonusQ>maxBonus)return 'A quarter-point award differs from its calculation.';}
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
  const rewards=state.rewards,epoch=wsEpoch(state),items=confirmedEligibility(state,today).filter(e=>e.epochId===epoch.id),eligible=items.concat(wsBonusLines(state,items,today,epoch),wsPerfectAwards(state,today,epoch)),byId=new Map(eligible.map(e=>[e.id,e]));
  // A Scoring V2 claim whose day has since grown (steps climbing to 12,000) is topped up by the
  // difference, once; only a drop needs the reviewed correction (V2.0).
  const grown=c=>(c.calculation?.ruleStep===5||c.calculation?.ruleStep==='goal-v1'||c.calculation?.dayLine===5||c.calculation?.weekLine===5||wsProtectedClaim(c))&&(byId.get(c.id)?.amount||0)>claimBalance(c);
  const unknown=c=>wsProtectedClaim(c)&&typeof PerfectVerdicts==='undefined';
  const claims=Object.values(rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===epoch.id).map(c=>({...c,balance:claimBalance(c),displayAmount:c.amount/4,displayBalance:claimBalance(c)/4,eligibilityUnknown:unknown(c),needsReview:!unknown(c)&&(byId.get(c.id)?.amount||0)!==claimBalance(c)&&!grown(c)}));
  const topUps=Object.values(rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===epoch.id&&grown(c)).map(c=>{const e=byId.get(c.id),delta=e.amount-claimBalance(c);return {...e,topUp:true,delta,amount:delta,amountQ:delta,displayAmount:delta/4,previousAmount:claimBalance(c)};});
  const pending=eligible.filter(e=>!rewards.claims[e.id]).concat(topUps),totalQ=claims.reduce((n,c)=>n+claimBalance(c),0),orbs=totalQ/4;
  return {orbs,totalQ,pending,claims,historyClaims:Object.values(rewards.claims).filter(c=>!claims.some(a=>a.id===c.id)),activeEpoch:epoch,daysRecorded:new Set(claims.map(c=>c.date)).size,progression:rewards.progression,quest:{text:REWARD_RULES.questText,done:eligible.some(e=>e.date===today),reward:0},achievements:rewardAchievements(state,orbs,new Set(claims.map(c=>c.date)).size),...rewardLevel(state,orbs)};
};
function wsCorrectionBatch(state,id){
  const selected=state.rewards.claims[id];if(!selected)return null;
  if(selected.ruleVersion!==4)return wsLegacyCorrection(state,id);
  const claims=Object.values(state.rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===selected.epochId&&!(c.seriesId&&c.seriesId[0]==='@')),changes=[];
  for(const claim of claims){const entitlement=Object.values(state.occurrences).filter(o=>rewardIdentity(state,o)===claim.id).map(o=>wsQuarterEntitlement(state,o,claim.epochId)).find(Boolean),before=claimBalance(claim),after=entitlement?.amount||0;if(before!==after)changes.push({id:claim.id,date:claim.date,ruleVersion:4,epochId:claim.epochId,before,after,delta:after-before,calculation:entitlement?.calculation||null});}
  // Preview the exact dependency order: item corrections first, then their capped day/week and tier lines.
  const draft=wsClone(state);
  for(const change of changes){const claim=draft.rewards.claims[change.id];claim.adjustments=claim.adjustments||[];claim.adjustments.push({delta:change.delta,calculation:change.calculation});}
  const lineChanges=wsLineCorrections(draft,'Preview only',selected.epochId).map(change=>({...change,delta:change.after-change.before,calculation:wsClone(draft.rewards.claims[change.id].adjustments.slice(-1)[0].calculation)}));
  const afterQ=Object.values(draft.rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===selected.epochId).reduce((n,c)=>n+claimBalance(c),0),own=changes.concat(lineChanges).find(c=>c.id===id),protectedChanges=lineChanges.filter(c=>wsProtectedClaim(state.rewards.claims[c.id]));
  return {id,before:claimBalance(selected),after:own?.after??claimBalance(selected),delta:own?.delta||0,changes,lineChanges,protectedChanges,total:afterQ/4,totalQ:afterQ,level:QuarterPoints.levelFor(afterQ).level,signature:wsSignature({claims:Object.values(state.rewards.claims).filter(c=>c.ruleVersion===4&&c.epochId===selected.epochId),changes,lineChanges}),unit:'quarter-point',epochId:selected.epochId};
}
function wsProtectedCorrections(state,epochId){
  if(typeof PerfectVerdicts==='undefined')return [];
  const epoch=wsEpoch(state,epochId);if(!epoch)return [];
  const today=todayYmd(),items=confirmedEligibility(state,today).filter(e=>e.epochId===epochId),lines=wsBonusLines(state,items,today,epoch,true).concat(wsPerfectAwards(state,today,epoch)),byId=new Map(lines.map(e=>[e.id,e]));
  return Object.values(state.rewards.claims).filter(c=>wsProtectedClaim(c)&&c.epochId===epochId).flatMap(c=>{const e=byId.get(c.id),before=claimBalance(c),after=e?.amount||0;return after<before?[{id:c.id,before,after,delta:after-before,calculation:after?e.calculation:null}]:[];});
}
/* Day and week bonuses follow corrected items too (Mintay, Sept 26). After item claims are corrected,
   every claimed bonus line is recomputed from the corrected facts; one now lower gets a signed
   adjustment down to it that carries the recomputed calculation, which the validator re-derives.
   A bonus that would grow is left to the ordinary top-up. */
function wsLineCorrections(state,note,reviewedEpoch){
  const today=todayYmd(),at=nowIso(),out=[],byEpoch=new Map();
  for(const c of Object.values(state.rewards.claims||{})){
    if(c.ruleVersion!==4||(c.seriesId!=='@day'&&c.seriesId!=='@week')||reviewedEpoch&&c.epochId!==reviewedEpoch)continue;
    if(!byEpoch.has(c.epochId)){const epoch=(state.rewards.epochs||[]).find(e=>e.id===c.epochId);byEpoch.set(c.epochId,epoch?wsBonusLines(state,confirmedEligibility(state,today).filter(e=>e.epochId===epoch.id),today,epoch,true):[]);}
    const now=byEpoch.get(c.epochId).find(l=>l.id===c.id),before=claimBalance(c);
    if(!now||now.amount>=before)continue;
    c.adjustments=c.adjustments||[];
    c.adjustments.push({id:newId('adjust'),at,delta:now.amount-before,reason:String(note||'Bonus follows corrected items').slice(0,300),revision:c.adjustments.length+1,ruleVersion:4,unit:'quarter-point',epochId:c.epochId,calculation:now.calculation});
    out.push({id:c.id,before,after:now.amount});
  }
  // V3.7 X8 (re-attack): a claimed goal line follows corrected ticks like every other claim (a drop is a reviewed correction)
  const goalNow=new Map();
  for(const c of Object.values(state.rewards.claims||{})){
    if(c.ruleVersion!==4||!c.calculation||c.calculation.ruleStep!=='goal-v1'||reviewedEpoch&&c.epochId!==reviewedEpoch)continue;
    if(!goalNow.has(c.epochId)){const epoch=(state.rewards.epochs||[]).find(e=>e.id===c.epochId);goalNow.set(c.epochId,epoch&&quarterProgression(state)&&wsEpoch(state)?.id===epoch.id?wsGoalLines(state,today):null);}
    const lines=goalNow.get(c.epochId);if(!lines)continue;const now=lines.find(l=>l.id===c.id),before=claimBalance(c),after=now?now.amount:0;
    if(after>=before)continue;
    c.adjustments=c.adjustments||[];
    c.adjustments.push({id:newId('adjust'),at,delta:after-before,reason:String(note||'Goal follows corrected ticks').slice(0,300),revision:c.adjustments.length+1,ruleVersion:4,unit:'quarter-point',epochId:c.epochId,calculation:now?wsClone(now.calculation):null});
    out.push({id:c.id,before,after});
  }
  for(const epochId of new Set(Object.values(state.rewards.claims).filter(c=>wsProtectedClaim(c)&&(!reviewedEpoch||c.epochId===reviewedEpoch)).map(c=>c.epochId)))for(const change of wsProtectedCorrections(state,epochId)){
    const c=state.rewards.claims[change.id];c.adjustments=c.adjustments||[];
    c.adjustments.push({id:newId('adjust'),at,delta:change.delta,reason:String(note||'Dated reward follows corrected facts').slice(0,300),revision:c.adjustments.length+1,ruleVersion:4,unit:'quarter-point',epochId,calculation:change.calculation});out.push({id:c.id,before:change.before,after:change.after});
  }
  return out;
}
function wsApplyCorrectionBatch(state,preview,note){
  const current=preview&&wsCorrectionBatch(state,preview.id);if(!current||current.signature!==preview.signature)return {ok:false,error:'The correction changed. Review the current batch.'};
  // The item that started the batch keeps the reason as given; every other claim the batch moves says which item
  // it was recalculated with (the Mac check, Sept 27: four claims all read "Skipped after claiming").
  const base=String(note||'Reviewed correction batch'),origin=state.rewards.claims[preview.id],carried=origin&&origin.name?'Recalculated with '+origin.name+' ('+base+')':base;
  const at=nowIso();for(const change of current.changes){const claim=state.rewards.claims[change.id];claim.adjustments=claim.adjustments||[];claim.adjustments.push({id:newId('adjust'),at,delta:change.delta,reason:(change.id===preview.id?base:carried).slice(0,300),revision:claim.adjustments.length+1,ruleVersion:4,unit:'quarter-point',epochId:claim.epochId,calculation:change.calculation});claim.reconciledAt=at;claim.reconciliationSignature=rewardReviewSignature(state,claim);}
  current.lineChanges=wsLineCorrections(state,carried,current.epochId);
  return {ok:true,record:current};
}
correctionPreview=function(state,id){return state.rewards.claims[id]?.ruleVersion===4?wsCorrectionBatch(state,id):wsLegacyCorrection(state,id);};
adjustConfirmedClaim=function(state,id,note){if(state.rewards.claims[id]?.ruleVersion!==4)return wsLegacyAdjust(state,id,note);const preview=wsCorrectionBatch(state,id);const result=wsApplyCorrectionBatch(state,preview,note);return result.ok?{...preview,lineChanges:result.record.lineChanges||[]}:null;};

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
    const rolling=v.recurrence?.mode==='rolling'&&kind!=='church',configured=recurrenceWindow(v,date,state),block=kind==='church'&&configured?configured:null,from=rolling?addDays(date,1-(v.recurrence?.weeks||4)*7):configured?.from||start,to=rolling?date:configured?.to||end;   // H1, H3: Church and every N-week item is met once per fixed block from the Program start
    const days=[];for(let day=from;day<=to;day=addDays(day,1)){const entry=wsGoalDay(state,s,day,rowCache);if(kind==='church'&&dow(day)!==0){entry.full=false;entry.qualifying=false;}days.push(entry);}
    const eligibleDays=days.filter(d=>d.date<=date),events=new Set(),fullEvents=new Set();for(const d of eligibleDays){if(d.qualifying)events.add(d.eventId||d.date);if(d.full)fullEvents.add(d.eventId||d.date);}
    const target=v.recurrence?.count||({cardio:4,strength:4,journal:3,church:1,home:1}[kind]||1),qualifying=events.size,full=fullEvents.size;
    const deadline=v.deadlineDay===undefined?null:{date:addDays(start,(v.deadlineDay+6)%7),time:'23:59',label:'By Thursday night'};
    if(v.recurrence?.kind==='target'||['cardio','strength','journal','church','home'].includes(kind))cards.push({id:s.id+'|'+from,kind:kind||'target',title:v.name,groupId:wsGroup(s,date),seriesIds:[s.id],window:{from,to,label:from+' – '+to,kind:block?'block28':rolling?'rolling28':v.recurrence?.weeks>1?'multiweek':'weekly'},qualifying,full,target,minutes:eligibleDays.reduce((n,d)=>n+d.minutes,0),pending:eligibleDays.filter(d=>d.pending).length,complete:qualifying>=target,days,deadline});
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
    for(const g of options.groupChanges||[]){const cur=draft.groups.find(x=>x.id===g.id);if(!cur)continue;for(const k of ['name','umbrella','order','retiredFrom'])if(g[k]!==undefined)cur[k]=g[k];cur.updatedAt=nowIso();}
    for(const id of options.archive||[]){const s=draft.series.find(x=>x.id===id);if(s&&!(s.archivedAt&&s.archivedAt<=date))s.archivedAt=date;}
    let epochId=null;
    if(options.quarterPoints!==false){
      epochId='quarter-'+preview.id;draft.rewards.epochs=draft.rewards.epochs||[];
      if(draft.rewards.epochs.some(e=>e.id===epochId))return {ok:false,error:'This scoring epoch already exists.'};
      draft.rewards.epochs.push({id:epochId,ruleVersion:4,unit:'quarter-point',effectiveFrom:date,adoptedAt:nowIso(),policy:'partial resets full chain; pending holds bonus',proposal:true});
      draft.rewards.progression={rule:'quarter-v1',version:1,ruleVersion:4,unit:'quarter-point',epochId,effectiveFrom:date,adoptedAt:nowIso()};
    }
    const migration={id:preview.id,at:nowIso(),effectiveFrom:date,before,epochId,addedIds:(options.additions||[]).map(a=>a.id).filter(Boolean),status:'active',structureV2:options.structureV2===true};draft.workspace.migrations.push(migration);
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
/* V2.0 activity structure (Mintay, Sept 25; PLAN → V2.0 Phase 3). Umbrella → card → routine → item:
   an umbrella is a group attribute, a card is a group, so the store's three levels still hold.
   Existing series keep their IDs and history; they are renamed, re-parented or re-scheduled by a
   dated version from `date`, new items are created, and replaced ones are archived from `date`.
   Anything this map does not name is left exactly as it is. Adopted through the reviewed migration
   (preview → adopt → rollback) and never starts a new scoring period. */
const V2_GROUPS=[
  {id:'faith',name:'Faith',umbrella:'faith'},
  {id:'personal-health',name:'Personal Health',umbrella:'health'},
  {id:'fitness',name:'Fitness',umbrella:'health'},
  {id:'food',name:'Nutrition',umbrella:'health'},
  {id:'health-mental',name:'Sleep & Recovery',umbrella:'health'},
  {id:'wellbeing',name:'Wellbeing',umbrella:'health'},
  {id:'trash-day',name:'Trash Day',umbrella:'home-care'},
  {id:'laundry',name:'Laundry',umbrella:'home-care'},
  {id:'cleaning',name:'Cleaning',umbrella:'home-care'},
  {id:'relationship',name:'Relationship',umbrella:'relationship'},
  {id:'work',name:'Work & Learning',umbrella:'career'},
  {id:'interests',name:'Hobbies',umbrella:'hobbies'}
];
const V2_RETIRED_GROUPS=['health-physical','personal-care','hygiene','care','home'];
function wsStructureV2(state,date){
  if(!validCalendarDate(date))return {ok:false,error:'Choose a valid date for the new structure.'};
  const has=id=>{const s=state.series.find(x=>x.id===id);return !!(s&&!(s.archivedAt&&s.archivedAt<=date)&&versionFor(s,date));};
  const daily={kind:'weekly',days:[0,1,2,3,4,5,6]},on=days=>({kind:'weekly',days}),perWeek=(count,days=[0,1,2,3,4,5,6])=>({kind:'target',days,count,weeks:1,mode:'fixed',startDate:date}),perMonth=()=>({kind:'target',days:[0,1,2,3,4,5,6],count:1,weeks:4,mode:'fixed',startDate:date});
  const item=(label)=>({label,minutes:null});
  const groups=[],groupChanges=[],taxonomy=[],scheduleChanges=[],additions=[],moves=[],archive=[],kept=[];
  for(const g of V2_GROUPS){const cur=state.groups.find(x=>x.id===g.id);if(!cur)groups.push({id:g.id,name:g.name,umbrella:g.umbrella,order:V2_GROUPS.indexOf(g)+1});else groupChanges.push({id:g.id,name:g.name,umbrella:g.umbrella,order:V2_GROUPS.indexOf(g)+1});}
  for(const id of V2_RETIRED_GROUPS)if(state.groups.some(g=>g.id===id))groupChanges.push({id,retiredFrom:date});
  const change=(id,changes,category)=>{if(!has(id))return false;if(category)taxonomy.push({seriesId:id,category});if(changes&&Object.keys(changes).length)scheduleChanges.push({seriesId:id,changes});return true;};
  const move=(id,parentId)=>{if(has(id))moves.push({seriesId:id,parentId});};
  const add=(id,name,fields)=>{if(state.series.some(s=>s.id===id))return;additions.push({id,name,anchor:'midday',recurrence:daily,normal:item(name),minimum:item('No lower full-credit target'),optional:false,scoring:{importance:3,difficulty:2,eligible:true},workspaceKind:'care',...fields});};
  const container=(id,name,fields)=>add(id,name,{kind:'container',normal:item('Summary of the independent items'),minimum:item('Summary only'),scoring:{importance:3,difficulty:2,eligible:false},...fields});
  const retire=id=>{if(has(id))archive.push(id);};
  // A parent with a check-off recorded on or after the date cannot take new children from that date
  // (wsCreate/wsMove refuse it); such a child is skipped and named instead of forcing it.
  const skipped=[],busy=id=>Object.values(state.occurrences).some(o=>o.seriesId===id&&o.date>=date&&o.status);
  const addUnder=(id,name,parentId,fields)=>{if(parentId&&!additions.some(a=>a.id===parentId)&&busy(parentId)){skipped.push({name,reason:'its card already has a check-off on or after this date'});return;}add(id,name,{...fields,parentId});};
  // Faith: prayers, fasting and church stay; Journal moves in.
  change('dw-journal',{name:'Journal'},'faith');
  // Personal Health: Morning Oral Hygiene, Body, Night Oral Hygiene.
  if(change('dw-oral-care',{name:'Morning Oral Hygiene',budgetQ:32},'personal-health'))move('dw-oral-care',null);
  for(const id of ['dw-brush','dw-floss','dw-tongue','dw-rinse'])change(id,null,'personal-health');
  change('dw-brush',{name:'Brush'});change('dw-tongue',{name:'Tongue'});change('dw-rinse',{name:'Rinse'});
  // Body is a new card; Morning care retires once its items have moved out.
  container('v2-body','Body',{category:'personal-health',anchor:'morning',budgetQ:32});
  for(const id of ['dw-wash-face','dw-shower','dw-bathroom-1','dw-bathroom-2'])if(change(id,id==='dw-shower'?{name:'Shower/Bath'}:id==='dw-wash-face'?{name:'Wash Face'}:null,'personal-health'))move(id,'v2-body');
  retire('dw-morning-care');
  change('dw-night-care',{name:'Night Oral Hygiene',budgetQ:32},'personal-health');
  for(const id of ['dw-night-brush','dw-night-floss','dw-night-rinse'])change(id,null,'personal-health');
  change('dw-night-brush',{name:'Brush'});change('dw-night-rinse',{name:'Rinse'});
  if(has('dw-night-care'))addUnder('v2-night-tongue','Tongue','dw-night-care',{category:'personal-health',anchor:'evening',workspaceKind:'care'});
  retire('hygiene');
  // Fitness: workouts, steps, daily movement.
  for(const id of ['dw-workouts','dw-cardio','dw-strength','dw-steps','daylight','movement'])change(id,null,'fitness');
  // Nutrition: deficit, hydration, weekly grocery shopping. The meal rows it replaces are archived.
  add('v2-deficit','Deficit',{category:'food',workspaceKind:'nutrition',anchor:'evening',normal:item('825 kcal deficit (750 on track)'),matching:{kind:'deficit',target:825,onTrack:750}});
  add('v2-hydration','Hydration',{category:'food',workspaceKind:'nutrition',normal:item('100 fl oz of water'),matching:{kind:'water',targetOz:100,floorOz:60}});
  change('groceries',{name:'Grocery Shopping',recurrence:perWeek(1)},'food');
  for(const id of ['meal','dinner','dw-healthy-meal','mealprep'])retire(id);
  // Sleep & Recovery: nightly sleep on a 7 h target, and the wind-down.
  change('dw-sleep',{name:'Sleep',normal:item('7 hours'),matching:{kind:'sleep',minimum:420}},'health-mental');
  change('winddown',null,'health-mental');
  // Wellbeing: the weekly SUD appointment and monthly therapy.
  change('dw-weekly-appointment',{name:'SUD Appointment'},'wellbeing');
  add('v2-therapy','Therapy',{category:'wellbeing',recurrence:perMonth(),normal:item('Monthly session')});
  // Home Care → Trash Day (Thursday), Laundry (loads per week), Cleaning (rooms).
  change('dw-trash',{name:'Trash',recurrence:on([4])},'trash-day');change('dw-recycling',{name:'Recycling',recurrence:on([4])},'trash-day');
  add('v2-yard-waste','Yard Waste',{category:'trash-day',recurrence:on([4])});
  for(const [id,count,name] of [['dw-laundry-whites',1,'Whites'],['dw-laundry-colors',2,'Colors'],['dw-laundry-towels',2,'Towels'],['dw-laundry-bedding',2,'Bedding']])if(change(id,{name,recurrence:perWeek(count)},'laundry'))move(id,null);
  retire('dw-laundry');retire('laundry');
  const rooms=[['dw-clean-bedroom','Bedroom',[['make-bed','Make Bed',5],['vacuum','Vacuum',1],['organize-bedroom','Organize',1],['clean-bedroom','Clean',1]]],
    ['dw-clean-office','Office',[['organize-office','Organize',1],['clean-office','Clean',1]]],
    ['dw-clean-bathroom','Bathroom',[['sink','Sink',1],['toilet','Toilet',1],['tub','Tub',1],['shower-clean','Shower',1],['shower-curtains','Shower Curtains Wash',0],['bath-floor','Floor',1],['bath-clean','Clean',1]]],
    ['dw-clean-gym','Gym',[['organize-gym','Organize',1],['clean-gym','Clean',1],['gym-floor','Floor',1]]]];
  // Each room is a new card; the old one-line room chore retires from the date with its history.
  for(const [id,name,items] of rooms){
    const room='v2-room-'+name.toLowerCase();container(room,name,{category:'cleaning'});retire(id);
    for(const [key,label,count] of items)add('v2-'+key,label,{category:'cleaning',parentId:room,recurrence:count?perWeek(count):perMonth()});
  }
  // Relationship: monthly couples therapy; family tasks come from the template shelf.
  add('v2-couples-therapy','Couples Therapy',{category:'relationship',recurrence:perMonth(),normal:item('Monthly session')});
  const named=new Set([...taxonomy.map(t=>t.seriesId),...scheduleChanges.map(c=>c.seriesId),...archive,'dw-prayer-am','dw-prayer-pm','dw-fasting','dw-church']);
  for(const s of state.series)if(!s.demo&&!named.has(s.id)&&has(s.id))kept.push({seriesId:s.id,name:versionFor(s,date).name});
  return {ok:true,effectiveFrom:date,quarterPoints:false,structureV2:true,groups,groupChanges,taxonomy,scheduleChanges,additions,moves,archive,kept,skipped};
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
  rings:wsRings,goals:wsGoals,perfectVerdict:wsPerfectVerdict,perfectQuotas:wsPerfectQuotas,perfectSpan:wsPerfectSpan,perfectPolicy:wsPerfectPolicy,perfectDefaults:WS_PERFECT_DEFAULTS,
  setPerfectPolicy(state,values,from){return wsTransaction(state,draft=>wsSetPerfectPolicy(draft,values,from));},
  setSleepCheckOff(state,enabled){return wsTransaction(state,draft=>wsSetSleepCheckOff(draft,enabled));},
  create(state,fields,date){return wsTransaction(state,draft=>wsCreate(draft,fields,date,fields.parentId||null));},
  /* V3.3 Phase 2 (3.1, P2-20): a container and its sub-items in one transaction (one clone, one validation). */
  createWithChildren(state,fields,date,children,options={}){return wsTransaction(state,draft=>{const once=options.scope==='occurrence'?{recurrence:{kind:'once',date}}:{};const parentId=fields.parentId||null;const made=wsCreate(draft,parentId?{...fields,...once}:fields,date,parentId);for(const c of children||[])wsCreate(draft,{...c,...once},date,fields.id);return {ok:true,record:made};});},
  addTemplateBatch(state,nodes,date,templateIds=[]){
    if(!Array.isArray(nodes)||!nodes.length)return {ok:false,error:'Choose at least one Template item.'};
    return wsTransaction(state,draft=>{
      const ids=nodes.map(({parentId,...fields})=>wsCreate(draft,{...fields,recurrence:{kind:'once',date}},date,parentId||null).id);
      draft.prefs.templateUse=draft.prefs.templateUse||{};
      for(const id of new Set(templateIds))draft.prefs.templateUse[id]=[...(draft.prefs.templateUse[id]||[]).filter(d=>d!==date),date].sort().slice(-7);
      return {ok:true,record:{ids}};
    });
  },
  /* V3.3 Phase 2 (3.4, P2-20): place several leaves on a day, and move them to a card, in one transaction; a leaf with an entry, a placement, a removal or a met count is left as it is. */
  placeMany(state,ids,date,options={}){const place=options.place!==false,category=options.category||null;return wsTransaction(state,draft=>{const placed=[];if(place)for(const id of ids){const x=draft.series.find(z=>z.id===id),v=x&&versionFor(x,date);if(!v||(Array.isArray(v.childIds)&&v.childIds.length))continue;const o=draft.occurrences[occKey(id,date)];if(o&&(o.status||o.committed||o.removed||o.disposition))continue;const q=targetProgress(draft,id,date);if(q&&q.count>=q.target)continue;const r=wsCommitOn(draft,id,date,true);if(!r.ok)return r;placed.push(id);}if(category)for(const id of ids){const r=wsEdit(draft,id,{category},date,{});if(r&&r.ok===false)return r;}return {ok:true,placed};});},
  addChild(state,parentId,fields,date,options={}){return wsTransaction(state,draft=>wsCreate(draft,{...fields,...(options.scope==='occurrence'?{recurrence:{kind:'once',date}}:{})},date,parentId));},
  edit(state,id,changes,date,options={}){return wsTransaction(state,draft=>wsEdit(draft,id,changes,date,options));},
  fastingSeasons:wsFastingSeasons,
  addFastingSeason(state,season){return wsTransaction(state,draft=>wsAddFastingSeason(draft,season));},
  move(state,id,parentId,date){return wsTransaction(state,draft=>wsMove(draft,id,parentId,date));},
  reorder(state,id,order,date){if(!Number.isFinite(order))return {ok:false,error:'Choose a valid order.'};return wsTransaction(state,draft=>wsEdit(draft,id,{order},date));},
  commit(state,id,date,committed=true){return wsTransaction(state,draft=>wsCommitOn(draft,id,date,committed));},
  evidencePreview:wsEvidencePreview,confirmEvidence:wsConfirmEvidence,
  autoEvidence(state,options={}){if(!wsEnabled(state))return {ok:true,changes:[]};return wsTransaction(state,draft=>wsAutoEvidence(draft,options));},
  declineAuto(state,id,date){return wsTransaction(state,draft=>wsDeclineAuto(draft,id,date));},
  unsortedWorkouts:wsUnsortedWorkouts,workoutClass:wsWorkoutClass,
  classifyWorkout(state,key,cls){return wsTransaction(state,draft=>{const r=wsClassifyWorkout(draft,key,cls);if(!r.ok)return r;if(wsEnabled(draft))wsAutoEvidence(draft);return r;});},
  // Eating out, soda and alcohol for one day, kept on that day's Deficit item (Scoring V2 nutrition inputs).
  setNutritionInputs(state,date,inputs){return wsTransaction(state,draft=>{const series=draft.series.find(x=>x.id==='v2-deficit');if(!series||!versionFor(series,date))return {ok:false,error:'Adopt the new structure to record nutrition inputs.'};const o=ensureOcc(draft,'v2-deficit',date),clean=k=>Math.max(0,Math.min(9,Math.floor(+inputs[k]||0)));o.measure={...(o.measure||{}),ateOut:clean('ateOut'),soda:clean('soda'),alcohol:clean('alcohol')};o.updatedAt=nowIso();return {ok:true,record:o.measure};});},
  // A new points table from a date (V2.0): later days score with it; claimed points never change.
  setPointsTable(state,table,from){return wsTransaction(state,draft=>{const r=draft.rewards.ruleStep5;if(!r)return {ok:false,error:'Turn on Scoring V2 first.'};if(!validCalendarDate(from)||from<r.effectiveFrom)return {ok:false,error:'Choose a date on or after Scoring V2 started.'};const base=v5Rule(draft,from)||ScoringV5.DEFAULT_TABLE,next={...base,...table,id:'points-'+from+'-'+Date.now().toString(36),effectiveFrom:from};if(next.waterTargetOz<next.waterFloorOz)return {ok:false,error:'Water target cannot be below '+next.waterFloorOz+' fl oz.'};r.tables=(r.tables||[]).filter(t=>t.effectiveFrom!==from).concat(next);return {ok:true,record:next};});},
  proposal:wsProposal,structureV2:wsStructureV2,adoptScoringV5(state,from){return wsTransaction(state,draft=>wsAdoptScoringV5(draft,from));},migrationPreview:wsMigrationPreview,adopt:wsAdopt,rollbackPreview:wsRollbackPreview,rollback:wsRollback,
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
  const perfect=wsMergePerfectRules(draft.rewards?.perfectTiers,copy.rewards?.perfectTiers);if(perfect.error)return {error:perfect.error};
  if(perfect.rule)draft.rewards.perfectTiers=perfect.rule;
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
/* Energy-deficit points on Mintay's curve (500 → 8, 800 → 10, 1,000 → 12 kcal → points). A preview only:
   claims still use the adopted rule; paying these needs a new rule version so earlier claims keep their amounts. */
const DEFICIT_STEPS=[[1000,12],[800,10],[500,8]];
function energyDeficitPoints(deficit){if(!Number.isFinite(deficit))return 0;for(const [kcal,points] of DEFICIT_STEPS)if(deficit>=kcal)return points;return 0;}
/* One day's energy records in projection order; the range reader (V2.0 Fitness) buckets them in one pass. */
const WS_ENERGY_KINDS=['dietaryEnergy','restingEnergy','activeEnergy'],WS_ENERGY_METRICS=['dietary_energy','basal_energy_burned'];
function wsEnergyRecord(r){return WS_ENERGY_KINDS.includes(r.kind)||WS_ENERGY_METRICS.includes(r.unmapped?.healthAutoExport?.metric);}
// V3.6: the energy rows by day, kept per committed row set (rowMemo), so a draw that reads Net Energy several times (Fuel,
// the estimate, the gap, the item bar) filters and sorts the source rows once, not once per read.
function wsEnergyByDay(state){return rowMemo(state,'energy-by-day',()=>{const m=new Map();for(const r of relayedRecords(state)){if(!wsEnergyRecord(r))continue;const d=sourceLocalDay(r.start);if(!m.has(d))m.set(d,[]);m.get(d).push(r);}return m;});}
Workspace.energyBalances=function(state,from,to){
  const byDay=wsEnergyByDay(state),out=new Map();
  for(let d=from;d<=to;d=addDays(d,1))out.set(d,Workspace.energyBalance(state,d,byDay.get(d)||[]));
  return out;
};
// V3.6 F1 timing: within one screen draw (withDrawMemo) a day's balance is worked out once; V3.6 reads the same days from
// several places (Fuel, the Net Energy summary, the estimate, the gap, Nutrition), and each read hashed the day's rows again.
Workspace.energyBalance=function(state,date,dayRecords){
  if(drawMemo&&drawMemo.state===state){const m=drawMemo.eb||(drawMemo.eb=new Map());if(!m.has(date))m.set(date,wsEnergyBalanceOf(state,date,dayRecords));return m.get(date);}
  return wsEnergyBalanceOf(state,date,dayRecords);
};
function wsEnergyBalanceOf(state,date,dayRecords){
  const day=dayRecords||wsEnergyByDay(state).get(date)||[];
  // Imported food and resting energy arrive as kind 'other' named by metric (V1.12), so each side
  // reads its own kind and its metric; the day's projected total is one record.
  const source=(kind,metric)=>{const records=day.filter(r=>r.kind===kind||(metric&&r.kind==='other'&&r.unmapped?.healthAutoExport?.metric===metric)).filter(r=>!r.clashes?.length&&r.unit==='kcal'&&Number.isFinite(r.value)&&r.value>=0);const signatures=new Map();for(const record of records){const key=JSON.stringify([record.sourceRecordId||null,record.sourceApp,record.start,record.end,record.value]);if(!signatures.has(key))signatures.set(key,record);}const distinct=[...signatures.values()];if(new Set(distinct.map(r=>r.sourceApp)).size>1)return null;if(distinct.some((r,i)=>distinct.slice(0,i).some(other=>evidenceOverlaps(r,other))))return null;return distinct.length?distinct.reduce((n,r)=>n+r.value,0):null;};
  const foods=(state.foods||[]).filter(f=>f.date===date),manualFood=foods.length&&foods.every(f=>Number.isFinite(f.nutrition?.calories))?foods.reduce((n,f)=>n+f.nutrition.calories,0):null;
  // Food logged here adds on top of the imported total by default (Mintay, Sept 24 late); a day he
  // marks "Replace Apple Health" counts only what he logged. An entry without calories blanks the day.
  const importedFood=source('dietaryEnergy','dietary_energy'),replaceDay=!!state.prefs?.foodReplacesImported?.[date],overridden=replaceDay&&foods.length>0&&manualFood!==null,mixedFood=foods.length>0&&manualFood===null,food=mixedFood?null:foods.length?(replaceDay||importedFood===null?manualFood:manualFood+importedFood):importedFood,resting=source('restingEnergy','basal_energy_burned'),active=source('activeEnergy');
  // V3.5 T1: a burn or a food total he types on Today's Fuel card wins for that day (self-reported); burn is resting plus active.
  const typed=state.energyTyped&&state.energyTyped[date]||null,foodT=typed&&Number.isFinite(typed.food)?typed.food:food,burnData=Number.isFinite(resting)&&Number.isFinite(active)?resting+active:null,burn=typed&&Number.isFinite(typed.burn)?typed.burn:burnData;
  if(typed&&(Number.isFinite(typed.food)||Number.isFinite(typed.burn))){const ok=Number.isFinite(foodT)&&Number.isFinite(burn);return {date,food:foodT,resting,active,burn,signature:wsSignature([date,foods,day,typed]),balance:ok?foodT-burn:null,available:ok,provisional:true,complete:ok&&foodT>0&&burn>0,reviewed:false,scoring:false,unit:'kcal',typed:{food:Number.isFinite(typed.food),burn:Number.isFinite(typed.burn)},foodSource:Number.isFinite(typed.food)?'typed':food===null?null:!foods.length?'imported':'logged',note:'Typed on Today: your number is used for this day and marked self-reported.',missing:[foodT===null?'Food':null,burn===null?'Burn':null].filter(Boolean)};}
  const available=[food,resting,active].every(Number.isFinite),coverage=state.energyCoverage?.[date]||{},signature=wsSignature([date,foods,day]),reviewed=date<todayYmd()&&available&&coverage.signature===signature&&coverage.food===true&&coverage.resting===true&&coverage.active===true;
  // V3.3 Phase 2 (7.2): complete once food, resting and active energy are all there (live on the day itself); a reviewed
  // coverage that a source correction has since invalidated keeps the day provisional.
  const complete=available&&[food,resting,active].every(v=>v>0)&&(!coverage.signature||coverage.signature===signature);
  return {date,food,resting,active,burn:burnData,signature,balance:available?food-resting-active:null,available,provisional:date>=todayYmd(),complete,reviewed,scoring:false,unit:'kcal',foodSource:food===null?null:!foods.length?'imported':replaceDay||importedFood===null?'logged':'logged+imported',note:mixedFood?'A logged food has no calories, so the day\'s food is unknown.':overridden?'Your logged food replaces the imported total for this day.':reviewed?'Explicitly reviewed coverage; workouts are already included in active energy.':'Coverage is incomplete or unverified. Missing values stay unavailable; no deficit award.'};
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
confirmedEligibility=function(state,today){if(!quarterProgression(state))return wsUncachedEligibility(state,today);const prior=wsProjectionCache;wsProjectionCache=new Map();try{return wsUncachedEligibility(state,today).concat(wsGoalLines(state,today));}finally{wsProjectionCache=prior;}};
/* V3.7 X8 (V36-A9, A44, V36-I29): a goal item pays its existing points times the credit share its window holds when the
   window closes; no new points table. A dated rule from V37_RULE_DAY: a window that closed before it is never paid, an
   occurrence of a windowed goal before it keeps its per-tick pay, and no earlier claim moves. A limit that held credits in
   full, one that is over credits 0 (no line). The line's series id starts with "@" so it never joins a day's bonus total. */
// One test for both payers (re-attack, Oct 4): the window around day d is paid as one line only when one windowed, non-rolling
// version governs every day of it and it starts on or after both the rule day and the points epoch. Otherwise each tick in it
// keeps its own pay, so a tick is never paid twice (line + tick) and never lost (neither).
// A week goal saved without its own week start (every V3.6 goal) is pinned to the alignment of its first claimed line, so a
// later week-start change never re-cuts a paid week, skips the next one or strands a claim (re-attack, Oct 4). Nothing is written.
const wsPinCache=new WeakMap(),wsVerSeries=new WeakMap();
function wsGoalWeekPin(state,ver){
  const claims=state.rewards&&state.rewards.claims;if(!claims)return null;
  let sid=wsVerSeries.get(ver);if(sid===undefined){for(const x of state.series||[])for(const v of x.versions||[])wsVerSeries.set(v,x.id);sid=wsVerSeries.get(ver);if(sid===undefined)return null;}
  const n=Object.keys(claims).length;let c=wsPinCache.get(claims);
  if(!c||c.n!==n){c={n,pin:new Map()};const first=new Map();
    const byId=new Map((state.series||[]).map(x=>[x.id,x]));
    for(const x of Object.values(claims)){const g=x&&x.calculation&&x.calculation.ruleStep==='goal-v1'&&x.calculation.goal;if(!g||!validCalendarDate(g.from)||g.to!==addDays(g.from,6))continue;const k=x.seriesId.slice(6),sr=byId.get(k),vv=sr&&versionFor(sr,g.to);if(!vv||!vv.goal||!vv.goal.period||vv.goal.period.kind!=='week')continue;const prev=first.get(k);if(!prev||g.from<prev)first.set(k,g.from);}   // only a line paid under a weekly version sets a week pin (not "every 7 days", not a month)
    for(const [k,f] of first){const wd=new Date(f+'T12:00:00').getDay();if(wd===0||wd===1)c.pin.set(k,wd);}wsPinCache.set(claims,c);}
  const v=c.pin.get(sid);return v===0||v===1?v:null;
}
function wsLineWindow(state,s,d,epoch){
  const ver=versionFor(s,d);if(!ver||!GoalEngine.windowed(ver)||(ver.goal.period&&ver.goal.period.kind==='rolling'))return null;   // review F2: a rolling window overlaps itself
  const w=GoalEngine.window(ver.goal,d,ver,state),from0=V37_RULE_DAY>epoch.effectiveFrom?V37_RULE_DAY:epoch.effectiveFrom;if(!w||w.from<from0)return null;   // review F3
  for(let x=w.from;x<=w.to;x=addDays(x,1))if(versionFor(s,x)!==ver)return null;   // a goal changed mid-window (Convert either way) is paid per tick
  return {ver,w,st:state};
}
function wsGoalLines(state,today){
  if(typeof QuarterPoints==='undefined'||typeof GoalEngine==='undefined')return [];
  const epoch=wsEpoch(state);if(!epoch)return [];const out=[],memo={},from0=V37_RULE_DAY>epoch.effectiveFrom?V37_RULE_DAY:epoch.effectiveFrom;
  for(const s of state.series||[]){if(s.demo)continue;const done=new Set();
    for(const ver of s.versions||[]){if(!GoalEngine.windowed(ver)||(ver.goal.period&&ver.goal.period.kind==='rolling'))continue;
      const start=ver.effectiveFrom>from0?ver.effectiveFrom:from0;
      for(let d=start;d<today;d=addDays(d,1)){const lw=wsLineWindow(state,s,d,epoch);if(!lw||lw.ver!==ver)continue;const w=lw.w;if(w.to>=today||done.has(w.to))continue;done.add(w.to);
        const rule=scoringRule(ver.scoring);if(!rule.eligible)continue;
        const credit=(GoalEngine.progress(lw.st,s,w.to,goalReadings)||{}).credit,share=Number.isFinite(credit)?Math.max(0,Math.min(100,Math.round(credit*100))):0;if(!share)continue;
        const baseQ=QuarterPoints.baseQ({importance:rule.importance,difficulty:rule.difficulty,sizeNumerator:share,sizeDenominator:100});if(!Number.isSafeInteger(baseQ)||baseQ<=0)continue;
        const id='goal:'+s.id+'|'+w.to;
        out.push({id,eventId:id,seriesId:'@goal:'+s.id,goalSeriesId:s.id,date:w.to,name:ver.name,amount:baseQ,amountQ:baseQ,displayAmount:baseQ/4,ruleVersion:4,unit:'quarter-point',epochId:epoch.id,origin:'goal',evidenceIds:[],calculation:{baseQ,bonusQ:0,ruleStep:'goal-v1',goal:{from:w.from,to:w.to,credit,share},rule:wsClone(rule)},disputed:false});}}}
  return out;
}
const wsUnwindowedEntitlement=actionEntitlement;
actionEntitlement=function(state,o){if(quarterProgression(state)&&o&&o.date>=V37_RULE_DAY&&typeof GoalEngine!=='undefined'){const s=state.series.find(x=>x.id===o.seriesId),epoch=s&&wsEpoch(state);if(epoch&&wsLineWindow(state,s,o.date,epoch))return null;}return wsUnwindowedEntitlement(state,o);};   /* only a window that pays a line loses its per-tick pay (the same test, wsLineWindow) */   // X8: paid once at the window's close, never per tick as well

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
  const series=state.series.find(s=>s.id===id),v=series&&versionFor(series,date),window=v&&recurrenceWindow(v,date,state);if(!window)return null;
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
