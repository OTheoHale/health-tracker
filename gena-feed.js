/* The Gena feed (his real switch, Oct 31; docs/GLOW_LITE_PLAN.md §1 to §4, §10; docs/GLOW_GENA_NAMES.md). Gena is the one source of check-offs. Glow reads
   Gena's sync gist, read only, and keeps a cache: each Gena item is a hidden series and days keyed by Gena's id (genaFed on the series), rebuilt from every
   read that differs, never edited in Glow. His own Glow rows are never touched: a mapped goal of his ends at the cutover with its history, and a hidden twin
   (a copy of its version, its Gena id in its own) carries it on, so the grade and points engine read what they always read.
   A Domain is a grade and a Focus is a card: each Gena Focus is a Glow group keyed by Gena's id and renamed on every read, under its Domain's umbrella.
   reduce() keeps only what the feed needs and drops notes, journal text, emails and people's details. apply() changes only genaFed series, their days and
   their groups. Loaded after health-domain.js. */
'use strict';
const GenaFeed = (() => {
  const FILE = 'daybook.json', GIST = id => 'https://api.github.com/gists/' + encodeURIComponent(id);
  // Gena's Domain -> Glow's grade (null: not graded). Read through the Focus, never from a Project or a person (plan §10)
  const DOMAINS = {'area-faith':'faith', 'area-health':'health', 'jritwcmhpy':'home', 'seed-prof-home':'home', 'area-family':'family', 'area-career':'career', 'area-growth':'growth', 'area-finance':null};
  const UMBRELLA_STORED = {faith:'faith', health:'health', home:'home-care', family:'family', career:'career', growth:'growth'};
  // Items with a special rule keep a named row (plan §10; the item model, gena/docs/GLOW_GENA_ITEM_MODEL.md; ids from V7.0's migrateV7). gena: its id; find: a habit found by its name once, then kept by id, for Monthly care alone, whose four ids (v7-mc-1 to 4) his private file sets; part: the position of its mark; week: a daily chip Glow counts as so many a week; kit: a loadKind; ends: his goals that end for it, with no twin, because the rule itself is the goal
  const HYGIENE = 5, JOURNAL = 'v7-h-journal', ROWS = [
    {gena:'fwdc295j1a', kind:'habit', glow:['dw-prayer-am'], part:0}, {gena:'fwdc295j1a', kind:'habit', glow:['dw-prayer-pm'], part:1},
    {gena:'hchr8reb5c', kind:'habit', glow:['dw-brush'], part:0, week:HYGIENE}, {gena:'hchr8reb5c', kind:'habit', glow:['dw-night-brush'], part:1, week:HYGIENE},
    {gena:'v7-h-makebed', kind:'habit', glow:['v2-make-bed']},
    {gena:'1i8gzyniw3', kind:'steps', ends:['v2-clean-bedroom', 'v2-vacuum', 'v2-organize-bedroom']}, {gena:'89ptmstusi', kind:'steps', ends:['v2-clean-office', 'v2-organize-office']},
    {gena:'v7-r-bathroom', kind:'steps', ends:['v2-bath-clean', 'v2-bath-floor', 'v2-shower-clean', 'v2-sink', 'v2-toilet', 'v2-tub']}, {gena:'v7-r-gym', kind:'steps', ends:['v2-clean-gym', 'v2-gym-floor', 'v2-organize-gym']},
    {gena:'wo2zf66uky', kind:'steps', ends:['s-mv0lfk42-qzih7', 's-mv0lfk42-mmh35', 's-mv0lfk43-brnhq', 's-mv0lfk43-aq76a', 's-mv0lfk43-9vrjp', 's-mv0lfk43-tkmoo', 's-mv0lfk44-twac4', 's-mv0lfk44-d6xe6', 's-mv0lfk44-xipm7', 's-mv0lfk45-cj5n2', 's-mv0lfk45-ik34g', 's-mv0lfk45-64fkv', 's-mv0lfk46-32lxm']},
    {gena:['4oi9tgl8rn', '0wkv2ilz96'], kind:'counter', ends:['ws-draft-mux19x06-ixayig-1', 'ws-draft-mux19x06-ixayig-2', 'ws-draft-mux19x06-ixayig-3', 'ws-draft-muxet89a-k9uf1q-1', 'ws-draft-muxet89a-k9uf1q-2', 'ws-draft-muxet89a-k9uf1q-3']}, {gena:'u999kqfsfy', kind:'repeat', glow:['s-mv0lfk3z-g5fak']},
    ...['whites', 'bedding', 'towels', 'colors'].map(k => ({kit:k, kind:'kit', glow:['dw-laundry-' + k, 'dw-laundry-' + k + '-wash', 'dw-laundry-' + k + '-dry', 'dw-laundry-' + k + '-fold']})), {kit:'shower-curtains', kind:'kit', glow:['v2-shower-curtains', 'v2-shower-curtains-wash', 'v2-shower-curtains-dry', 'v2-shower-curtains-fold']},
    {gena:'v7-h-church', kind:'habit', glow:['dw-church']}, {gena:JOURNAL, kind:'habit', glow:['dw-journal']}, {gena:'v7-h-fasting', kind:'habit', glow:['dw-fasting']}, {gena:'v7-h-grocery', kind:'habit', glow:['groceries']},
    ...[['floss', 'dw-floss'], ['tongue', 'dw-tongue'], ['rinse', 'dw-rinse'], ['face', 'dw-wash-face'], ['shower', 'dw-shower'], ['b1', 'dw-bathroom-1'], ['b2', 'dw-bathroom-2']].map(([n, id]) => ({gena:'v7-h-' + n, kind:'habit', glow:[id], week:HYGIENE})),
    {find:'SUD Group', kind:'habit', glow:['dw-weekly-appointment']}, {find:'SUD Individual', kind:'habit', named:/^SUD Individual$/i}, {find:'RX', kind:'habit', named:/^RX$/i}, {find:'Therapy', kind:'habit', glow:['v2-therapy']},
    {kind:'mentors', ends:['s-mv0lfk3x-1ujc1', 's-mv0lfk3x-l2bug', 's-mv0lfk3y-p1hq4', 's-mv0lfk3z-4lfd3']}];   // his own Mentorship goals: Mentors reads the Focus now, so these end with no twin
  // Glow measures these, or they are out on purpose (plan §2): never fed
  const NOT = new Set(['seed-habit-water', 'seed-habit-move', 'r67rpsfj1a', '4vel1svm2d', 'wdfansqu0z', 'rptsbdajj7', 'gfmmlrcdvy']);
  const MENTOR_FOCUS = ['8frk84epmh', 'qxlkfd2zl8'], MENTOR_RULES = ['29vdpxzj0g', '9ahcllm644'], MENTOR_PEOPLE = ['xchrs3cm3a'];
  const allDays = () => [0, 1, 2, 3, 4, 5, 6];
  // a whole copy: an empty or partial one is a bad read, never a store with nothing in it, because reading it would end every fed series
  const isCopy = g => !!g && typeof g === 'object' && !!g.habitLog && [g.tasks, g.projects, g.habits, g.profiles, g.templates].every(x => Array.isArray(x) && x.length > 0);
  // V7.0 by what its migrateV7 wrote: the mark on the JIK Domain, or its Hygiene Focus, because a V6.8 edit of that Domain can drop the mark
  const isV7 = g => g.profiles.some(p => p && p.id === 'area-faith' && p.v7) || g.projects.some(p => p && p.id === 'v7-fc-hygiene');
  const OLD = 'Gena is still on V6.8. Open V7 on every device.';
  const doneOf = t => t.status === 'done' || !!t.completedOn;
  // One mark language (the item model §2): ✓ wins, ⊘ leaves the goal, a swept copy is a miss and never ⏭, only his own tap is a ⏭
  const markOf = t => doneOf(t) ? 'done' : t.excused ? 'excused' : t.swept ? 'open' : t.status === 'skipped' || t.skippedOn ? 'skipped' : 'open';
  const RANK = {done:4, partial:3, excused:2, skipped:1, open:0};
  const dayAt = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
  const weekOf = d => dayAt(d, -((new Date(d + 'T12:00:00').getDay() + 6) % 7));
  /* The switch lands on a Monday: a mid-week switch would split a week (the item model §10) */
  const nextMonday = d => { const w = weekOf(d); return w === d ? d : dayAt(w, 7); };
  const monthEnd = d => dayAt(dayAt(d.slice(0, 8) + '28', 4).slice(0, 8) + '01', -1);
  /* Gena's isStepGroup: a kit, a period copy or a fixed-day rule's copy with steps is a group. A one-off's or a daily repeat's subtasks stay subtasks: such a row is one mark */
  const isGroup = (t, r) => Array.isArray(t.subs) && t.subs.length > 0 && (!!t.loadKind || !!t.periodStart || !!(r && r.freq === 'weekly' && !r.goal && r.listed));
  /* A copy's steps, by what is on them, never by a name: ✓ 1, ⏭ 0. Steps a carry left behind (subsDone) are done */
  function stepsOf(t){
    const live = (t.subs || []).filter(Boolean), done = t.subsDone || [], on = live.filter(x => x.done), when = on.concat(done).map(x => x.doneOn).filter(Boolean).sort();
    return {done:on.length + done.length, of:live.length + done.length, open:live.filter(x => !x.done && !x.skipDay).length, last:when[when.length - 1] || null};
  }
  // Gena's marksFix: the count rules. A string that disagrees is healed at read, filling the first empty, then a skip, or dropping from the end, so an older day reads as it always did. Read that way, never written back
  function marksFix(raw, want, n){
    if (raw === 'x'){ if (!(want > 0)) return 'x'; raw = ''; }
    const a = [], r = typeof raw === 'string' ? raw : ''; let c = 0;
    for (let i = 0; i < n; i++){ const m = r.charAt(i); a[i] = m === 'd' || m === 'p' || m === 's' ? m : '-'; if (m === 'd' || m === 'p') c++; }
    for (let i = 0; i < n && c < want; i++) if (a[i] === '-'){ a[i] = 'd'; c++; }
    for (let i = 0; i < n && c < want; i++) if (a[i] === 's'){ a[i] = 'd'; c++; }
    for (let i = n - 1; i >= 0 && c > want; i--) if (a[i] === 'd' || a[i] === 'p'){ a[i] = '-'; c--; }
    return a.join('');
  }
  // a habit's parts, from the store: Gena's habitSlots, so a part he adds in the habit sheet needs nothing here
  const slotsOf = h => { const s = h.slots, box = +h.box > 0 ? +h.box : 1, goal = +h.goal > 0 ? +h.goal : 1; return Array.isArray(s) && s.length === Math.ceil(goal / box) && h.per !== 'week' && h.per !== 'month' ? s.length : 0; };
  const pausedOn = (x, d) => !!x.paused && (!x.pausedSince || d >= x.pausedSince) && !(x.pausedUntil && d > x.pausedUntil);
  const STATUS = {d:'done', p:'partial', s:'skipped'};
  // a day's marks, cut to the day's own length: a part added later leaves older days as they were
  function dayMarks(h, d, width){
    const n = h.log[d] || 0, raw = h.marks && h.marks[d], list = marksFix(raw, Math.floor(n / (h.box || 1) + 1e-9), width);
    return list === 'x' ? '' : list.slice(0, typeof raw === 'string' && raw && raw !== 'x' && raw.length < width ? raw.length : width);
  }
  /* One unit of a habit on a day. part null: the whole habit, as a plain item reads it. A mark outside a part's reach is undecided, never a miss */
  function habitMark(h, d, part){
    const n = h.log[d] || 0, m = h.marks && h.marks[d], whole = part === null || part === undefined, width = h.parts || (whole ? 0 : h.goal), skip = !!(h.skips && h.skips[d]) && !n;
    if (m === 'x' && !n) return 'excused';
    const list = width ? dayMarks(h, d, width) : '';
    if (whole){ if (width ? /[dp]/.test(list) : n) return !width || /^d+$/.test(list) ? 'done' : 'partial'; if (skip || /^s+$/.test(list)) return 'skipped'; }
    else { const c = list[part]; if (STATUS[c]) return STATUS[c]; if (skip) return 'skipped'; }
    return pausedOn(h, d) ? 'excused' : null;
  }
  /* A habit outside ROWS, on Gena's own schedule: habitDayCounts (dayMin), habitMet (a day's goal), then below, habitPer and habitOnDay as a Glow recurrence */
  const plainMark = (h, d) => { const m = habitMark(h, d, null), n = h.log[d] || 0; if (m !== 'done' || h.parts) return m; if (h.per !== 'day') return h.dayMin && n < h.dayMin ? null : m; return n < h.goal ? 'partial' : m; };
  function habitRec(h, from){
    const base = {count:1, weeks:1, mode:'fixed', startDate:from, session:''}, chosen = h.weekdays.length ? h.weekdays : allDays();
    if (h.per !== 'day') return {...base, kind:'target', days:chosen, count:Math.ceil(h.goal / h.box), weeks:h.per === 'month' ? 4 : 1};
    if (h.every > 1 && h.start){
      if (h.everyUnit === 'week') return {...base, kind:'weekly', days:h.weekdays.length ? h.weekdays : [new Date(h.start + 'T12:00:00').getDay()], intervalWeeks:h.every, startDate:weekOf(h.start)};
      return {...base, kind:'weekly', days:allDays(), everyDays:h.every, startDate:h.start};
    }
    return {...base, kind:'weekly', days:chosen, intervalWeeks:1};
  }
  // a whole day's share of a habit with parts: ✓ 1, ◐ ½, ⏭ 0, so 1 of 3 parts is no half
  const partShare = (h, d) => { const list = dayMarks(h, d, h.parts); return list ? [...list].reduce((n, c) => n + (c === 'd' ? 1 : c === 'p' ? .5 : 0), 0) / list.length : 0; };
  const genaIds = r => Array.isArray(r.gena) ? r.gena : r.gena ? [r.gena] : [];

  /* The read: the gist, then its file (a large file comes truncated, with a raw link). Any failure throws, and the caller keeps the last copy */
  async function read(id, fetcher){
    const f = fetcher || fetch, r = await f(GIST(id), {headers:{Accept:'application/vnd.github+json'}, cache:'no-store'}); if (!r.ok) throw new Error('Gist answered ' + r.status);
    const g = await r.json(), file = g.files && g.files[FILE]; if (!file) throw new Error('Not a Gena gist');
    let text = file.content; if (file.truncated || !text){ const raw = await f(file.raw_url, {cache:'no-store'}); if (!raw.ok) throw new Error('Gist file answered ' + raw.status); text = await raw.text(); }
    const copy = JSON.parse(text); if (!isCopy(copy)) throw new Error('Not a Gena file'); if (!isV7(copy)) throw Object.assign(new Error(OLD), {plain:true}); return copy;
  }
  /* The switch ends the goals it maps, so it waits for the items that carry them. Only the find rows can be absent from a V7 copy: Monthly care comes from his private file, not from migrateV7 */
  const notReady = g => { const have = new Set((g.habits || []).map(h => String(h.name || '').trim().toLowerCase())), lack = ROWS.filter(r => r.find && !have.has(r.find.toLowerCase())).map(r => r.find); return lack.length ? 'Monthly care is not in Gena yet (' + lack.join(', ') + '). Import it first.' : ''; };
  /* What the feed keeps of a copy, from the cutover on. Rule copies are read through their live rule, so a moved rule keeps its old copies on the same card */
  function reduce(g, cutover){
    const projects = new Map((g.projects || []).map(p => [p.id, p])), rules = new Map((g.templates || []).map(t => [t.id, t])), all = (g.tasks || []).concat(g.archive || []);
    const focusOf = id => { const p = projects.get(id); return p ? id : null; };
    const out = {at:g.savedAt || null, habits:{}, rules:{}, once:{}, focuses:{}, domains:{}, loads:{}, kits:[], noFocus:0}, since = o => { const k = {}; for (const [d, v] of Object.entries(o || {})) if (d >= cutover) k[d] = v; return k; };
    for (const d of g.profiles || []) out.domains[d.id] = {name:String(d.name || '').slice(0, 40)};
    for (const p of g.projects || []) out.focuses[p.id] = {name:String(p.name || '').slice(0, 40), emoji:p.emoji || '', domain:p.profileId || null, ended:p.state === 'ended' || p.state === 'done' || p.state === 'archived', projects:[]};
    // A Gena Project (a role under Job Search) is no card of its own: its live ones show on their Focus's card, and its work counts through that Focus
    for (const e of g.efforts || []) if (out.focuses[e.projectId] && !['ended', 'off'].includes(e.state)) out.focuses[e.projectId].projects.push(String(e.name || '').slice(0, 40));
    for (const h of g.habits || []){
      const log = {}, marks = {}; for (const [d, v] of Object.entries(g.habitLog || {})) if (d >= cutover && v && v[h.id]) log[d] = v[h.id];
      for (const [d, v] of Object.entries(g.habitMarks || {})) if (d >= cutover && v && v[h.id]) marks[d] = String(v[h.id]);
      const o = out.habits[h.id] = {name:String(h.name || '').slice(0, 80), goal:h.goal || 1, box:+h.box > 0 ? +h.box : 1, parts:slotsOf(h), per:h.per === 'week' || h.per === 'month' ? h.per : 'day', weekdays:Array.isArray(h.weekdays) ? h.weekdays.slice() : [], every:Math.floor(+h.every) || 0, everyUnit:h.everyUnit || '', start:h.start || null, dayMin:+h.dayMin > 0 ? +h.dayMin : 0, once:!!h.once, optional:!!h.optional, focus:focusOf(h.projectId), log, marks, skips:since(h.skips)};
      if (h.paused){ o.paused = true; if (h.pausedSince) o.pausedSince = h.pausedSince; if (h.pausedUntil) o.pausedUntil = h.pausedUntil; }
    }
    for (const r of g.templates || []){
      const o = out.rules[r.id] = {name:String(r.title || '').slice(0, 80), focus:focusOf(r.projectId), freq:r.freq || '', per:r.per || '', weekdays:Array.isArray(r.weekdays) ? r.weekdays.slice() : [], interval:r.interval || 0, start:r.start || null, until:r.until || null, goal:!!r.goal, listed:(r.subs || []).length > 0, log:{}, steps:{}};
      for (const d of r.skip || []) if (d >= cutover) o.log[d] = 'skipped';   // a broomed day, or a copy deleted with Just this one
      if (r.paused){ o.paused = true; if (r.pausedSince) o.pausedSince = r.pausedSince; }
      o.pauses = (Array.isArray(r.pauses) ? r.pauses : []).filter(p => p && p.from && p.to).map(p => ({from:p.from, to:p.to}));
      const items = r.subs || [];   // the week's counter: goalN, or the older list of "n of 20"
      if (r.goal && r.freq === 'weekly' && items.length && items.every(x => /^\s*\d+\s+of\s+\d+\s*$/i.test(x.text || ''))) o.counter = {goalN:+r.goalN > 0 ? +r.goalN : items.length, log:{}};
    }
    for (const t of all){
      if (t.loadKind){   // a kit: met for the week of Fold, by that step's date. Started and left, it earns and costs nothing
        const steps = t.subs || [], left = t.subsDone || [], fold = steps[steps.length - 1] || left[left.length - 1], on = !!fold && (fold.done || left.includes(fold)), day = on ? fold.doneOn || t.completedOn || t.day || null : null, s = stepsOf(t);
        if (day && day >= cutover){ const k = out.loads[t.loadKind] = out.loads[t.loadKind] || {log:{}}; k.log[day] = (k.log[day] || 0) + 1; }
        if (!day || day >= cutover) out.kits.push({kind:t.loadKind, done:s.done, of:s.of, day, open:!day || s.open > 0});
        continue;
      }
      if (t.tplId && out.rules[t.tplId]){
        const r = out.rules[t.tplId], start = t.periodStart || null, ends = start && ((t.per || r.per) === 'month' ? monthEnd(start) : dayAt(start, 6)), due = t.firstDay || t.day || start; if (!due || (ends || due) < cutover) continue;   // a month that began before the cutover still counts its month
        if (r.counter){ const log = t.goalLog || null; if (log) for (const [d, n] of Object.entries(log)) r.counter.log[d] = Math.max(r.counter.log[d] || 0, n); else { for (const x of t.subsDone || []){ const on = x.doneOn || t.day; if (on) r.counter.log[on] = (r.counter.log[on] || 0) + 1; } const n = (t.subs || []).filter(x => x && x.done).length; if (n && t.day) r.counter.log[t.day] = (r.counter.log[t.day] || 0) + n; } continue; }
        const s = isGroup(t, r) ? stepsOf(t) : {done:0, of:0, open:0, last:null}, mark = markOf(t), steps = s.of > 0;
        let status = mark; if (mark !== 'excused'){ if (steps && s.done < s.of && mark === 'done') status = 'partial'; if (steps && s.done && !['done', 'partial'].includes(status)) status = 'partial'; if (steps && s.of && s.done >= s.of) status = 'done'; }   // ⊘ sits on the whole copy: that period leaves the goal, ticked steps or not
        // a period's copy dates to the day its work was done, inside its period
        let day = start ? t.completedOn || s.last || t.day || start : due; if (start){ if (day < start) day = start; if (day > ends) day = ends; }
        if (RANK[status] >= RANK[r.log[day] || 'open']) r.log[day] = status;
        if (steps && mark !== 'excused') r.steps[day] = {done:s.done, of:s.of, week:start || weekOf(day)};
        continue;
      }
      if (t.tplId) continue;   // a copy of a deleted rule
      const due = t.firstDay || t.day || t.completedOn; if (!due || (t.completedOn || due) < cutover) continue;
      const focus = focusOf(t.projectId); if (!focus){ out.noFocus++; continue; }
      const mark = markOf(t); out.once[t.id] = {name:String(t.title || '').slice(0, 80), focus, day:due, doneOn:t.completedOn || null, mark:mark === 'open' ? null : mark};
    }
    // Mentors: the Focus ids, Usual Focus or a Relationship that says mentor; a dated task in the Focus or naming one counts a day, from all his history (plan §10). Their names and whether Gena has them paused, nothing else
    const people = (g.people || []).filter(p => MENTOR_FOCUS.includes(p.focusId) || /mentor/i.test(String(p.relationship || '')) || MENTOR_PEOPLE.includes(p.id)), who = new Set(people.map(p => p.id)), days = {}, met = {};
    for (const t of all) if (t.day && doneOf(t) && (MENTOR_FOCUS.includes(t.projectId) || MENTOR_RULES.includes(t.tplId) || (t.personIds || []).some(i => who.has(i)))) days[t.day] = (days[t.day] || 0) + 1;
    // a touch is one meeting on its date. A day's dated tasks saw the same meetings, so the larger, never both; V7.0 migrates `last` in as the first touch, and older history stays with the tasks
    for (const p of people) for (const x of Array.isArray(p.touches) ? p.touches : []) if (x && x.day) met[x.day] = (met[x.day] || 0) + 1;
    for (const [d, n] of Object.entries(met)) days[d] = Math.max(days[d] || 0, n);
    out.mentors = {people:people.map(p => ({name:String(p.name || ''), active:!p.paused})).concat(MENTOR_FOCUS.filter(id => projects.has(id) && id !== MENTOR_FOCUS[0] && !people.some(p => p.name === projects.get(id).name)).map(id => ({name:projects.get(id).name, active:!out.focuses[id].ended}))), days};
    return out;
  }
  // "Different", never "newer": any change at all re-applies every day since the cutover (plan §4). The copy's own time is not part of it; the day is, so a paused item's new day is excused with nothing changed in Gena
  const sigOf = (copy, day) => { const {at, ...rest} = copy, s = JSON.stringify(rest) + (day || ''); let x = 2166136261; for (let i = 0; i < s.length; i++){ x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36) + ':' + s.length; };

  const live = (st, s, T) => !!(s && versionFor(s, T) && !(s.archivedAt && String(s.archivedAt).slice(0, 10) <= T));
  const named = (st, re, T) => (st.series || []).filter(s => !s.genaFed && versionFor(s, T) && re.test(versionFor(s, T).name || ''));
  const kitId = k => 'kit' + k.replace(/[^a-z0-9]/g, '');   // never a hyphen: a twin's id splits at its first --
  function goalIds(st, row, T){   // his own goals a row feeds or ends: by id, or by name where the id is his own
    if (row.ends) return row.ends;
    if (row.glow) return row.glow;
    return named(st, row.named, T).map(s => s.id);
  }
  function foundId(copy, row, map){
    if (row.kit) return copy.loads[row.kit] ? [kitId(row.kit)] : [];
    const swap = (map && map.swap) || {}, ids = genaIds(row).map(id => swap[id] || id).filter(id => copy.habits[id] || copy.rules[id]); if (ids.length) return ids;
    if (!row.find) return [];
    const kept = map && map.found && map.found[row.find]; if (kept && copy.habits[kept]) return [kept];
    const same = Object.entries(copy.habits).filter(([, h]) => h.name.trim().toLowerCase() === row.find.toLowerCase()), hit = same.find(([id]) => /^v7-mc-/.test(id)) || same[0]; return hit ? [hit[0]] : [];
  }
  // a rule's pause: the open span from pausedSince, the closed ones in pauses. A rule paused with no date records nothing, so it stays neutral throughout
  const ruleOf = (r, d) => { const m = r.log[d]; return m && m !== 'open' ? m : (r.paused && (!r.pausedSince || d >= r.pausedSince)) || r.pauses.some(p => d >= p.from && d <= p.to) ? 'excused' : null; };
  const statusOf = (copy, ids, row, d) => { if (row.kind === 'kit') return (copy.loads[row.kit] || {log:{}}).log[d] ? 'done' : null; const own = ids.map(id => copy.habits[id] || copy.rules[id]).filter(Boolean); if (!own.length) return null; if (row.kind === 'habit') return habitMark(own[0], d, row.part === undefined ? null : row.part); const m = own.map(i => ruleOf(i, d)); return ['done', 'partial', 'excused', 'skipped'].find(x => m.includes(x)) || null; };
  function recurrenceOf(r, T){
    const base = {mode:'fixed', startDate:T, session:''};
    if (r.counter || r.freq === 'period') return {...base, kind:'target', days:allDays(), count:1, weeks:r.per === 'month' ? 4 : 1};
    if (r.freq === 'weekly' || r.weekdays.length) return {...base, kind:'weekly', days:r.weekdays.length ? r.weekdays : allDays(), intervalWeeks:1, count:1, weeks:1};
    if (r.freq === 'everyN' && r.interval > 1 && r.interval < 7 && r.start) return {...base, kind:'weekly', days:allDays(), everyDays:r.interval, startDate:r.start, count:1, weeks:1};   // Gena's ruleHits: every N days from its start
    if (r.freq === 'everyN' && r.interval >= 7) return {...base, kind:'target', days:allDays(), count:1, weeks:Math.min(52, Math.round(r.interval / 7))};
    return {...base, kind:'weekly', days:allDays(), intervalWeeks:1, count:1, weeks:1};
  }
  function sync(d, s, want, T, changed){   // one series' days from the cutover to T
    for (const [date, status] of want){
      const o = d.occurrences[occKey(s.id, date)], have = o && o.disposition === 'excused' ? 'excused' : (o && o.status) || null; if (have === status) continue;
      if (have === 'excused') unexcuseOcc(d, s.id, date);
      if (status === 'excused'){ clearOcc(d, s.id, date); const x = ensureOcc(d, s.id, date); x.disposition = 'excused'; x.excuse = 'exempt'; }
      else if (status) logOcc(d, s.id, date, status, {}); else clearOcc(d, s.id, date);
      changed.push([s.id, date]);
    }
  }
  const schedule = r => JSON.stringify([r.kind, r.days, r.count, r.weeks, r.intervalWeeks, r.everyDays]);
  const stamp = (s, fed) => { s.genaFed = fed; return s; };
  /* The first read and every read that differs: everything since the cutover from the fresh copy. Only genaFed series, their days and their groups change */
  function apply(d, copy, T, first){
    const cut = d.prefs.genaCutover, from = first ? cut : T, twinned = new Set(), map = d.prefs.genaMap = d.prefs.genaMap || {found:{}, swap:{}}, changed = [], days = []; for (let x = cut; x <= T; x = addDays(x, 1)) days.push(x);
    const counters = {}, shares = {}, weeks = {}, asked = d.prefs.genaAsked = d.prefs.genaAsked || {}, asks = d.prefs.genaAsks = d.prefs.genaAsks || [], news = d.prefs.genaNews = d.prefs.genaNews || [];
    const ask = (key, text, extra) => { if (asked[key]) return; asked[key] = T; asks.push({key, text, ...extra}); }, seen = new Set();
    const known = id => Object.prototype.hasOwnProperty.call(DOMAINS, id) || (d.prefs.genaDomains || {})[id] !== undefined;
    const gradeOf = id => { const own = (d.prefs.genaDomains || {})[id]; return own !== undefined ? own : DOMAINS[id]; };
    // a new Domain, a Domain that lost its last Focus, a Focus across a graded line: asked once (plan §10). A name is never a question: it is read by id
    for (const [id, dom] of Object.entries(copy.domains)) if (!known(id)) ask('domain:' + id, 'New in Gena: the Domain ' + dom.name + '. Should it have a grade?', {domain:id, name:dom.name});
    const hasFocus = new Set(Object.values(copy.focuses).map(f => f.domain));
    for (const id of Object.keys(DOMAINS)) if (gradeOf(id) && copy.domains[id] && (d.groups || []).some(g => g.genaDomain === id) && !hasFocus.has(id)) ask('empty:' + id + ':' + T.slice(0, 7), copy.domains[id].name + ' in Gena has no Focus left. Its grade waits until one comes back.');
    // Focus = card: a group keyed by Gena's id, under its Domain's umbrella; renamed from each read. A group's Domain has no date, so a move starts a new card from today and the old one stays hidden, holding the weeks it earned: each item's dated version carries it across (item, below)
    const cards = map.cards = map.cards || {}, cardOf = id => cards[id] || 'gena-' + id;
    for (const [id, f] of Object.entries(copy.focuses)){
      const um = gradeOf(f.domain), stored = um ? UMBRELLA_STORED[um] || um : null; let g = (d.groups || []).find(x => x.id === cardOf(id));
      if (!um && !g) continue;
      if (g && g.genaDomain && g.genaDomain !== f.domain && !!gradeOf(g.genaDomain) !== !!um) ask('moved:' + id + ':' + f.domain, f.name + ' moved ' + (um ? 'into' : 'out of') + ' a graded Domain in Gena. What is recorded stays where it was earned; it counts on the new side from today.');
      if (g && um && g.umbrella !== stored && !g.id.endsWith('~' + T)){ Object.assign(g, {hidden:true, hiddenFrom:T, retiredFrom:T}); delete g.genaDomain; cards[id] = 'gena-' + id + '~' + T; g = null; }
      if (!g){ g = {id:cardOf(id), name:f.name, icon:'star', order:(d.groups || []).length + 1, hidden:false, custom:false, createdAt:nowIso(), updatedAt:nowIso()}; d.groups.push(g); }
      if (g.name !== f.name) g.name = f.name;
      const off = !!f.ended || !um; if (um) g.umbrella = stored;   // out of every grade, the card keeps the Domain its weeks were earned in
      if (off && !g.hidden) g.hiddenFrom = T; else if (!off) delete g.hiddenFrom;
      g.genaDomain = f.domain; g.hidden = off; g.genaEmoji = f.emoji; g.genaProjects = f.projects || [];
    }
    // mapped goals: a twin per goal, from the cutover
    for (const row of ROWS){
      const ids = foundId(copy, row, map), fid = ids[0];
      if (row.find && fid && !map.found[row.find]) map.found[row.find] = fid;
      if (row.kit){ if (!ids.length) for (const goal of goalIds(d, row, T)) seen.add('gena-' + kitId(row.kit) + '--' + goal); } else { map.names = map.names || {}; for (const id of ids) map.names[id] = (copy.habits[id] || copy.rules[id]).name; }
      // a mapped id that disappears: offer the item with the same title, because silence would zero a grade (plan §10)
      for (const id of genaIds(row).concat(row.find && map.found[row.find] ? [map.found[row.find]] : [])) if (!copy.habits[id] && !copy.rules[id] && !(map.swap && map.swap[id])){
        const was = map.names[id] || row.find || id, same = [...Object.entries(copy.habits), ...Object.entries(copy.rules)].find(([, x]) => x.name.trim().toLowerCase() === String(was).trim().toLowerCase());
        ask('gone:' + id, was + ' is gone from Gena' + (same ? '. Use the new ' + same[1].name + ' in its place?' : ', so it stops counting.'), {gone:id, to:same ? same[0] : null, find:row.find || null});
      }
      if (!fid || row.ends) continue;   // a rule that is its own goal is read below, as any item
      for (const goal of goalIds(d, row, T)){
        const own = d.series.find(s => s.id === goal), base = own && (versionFor(own, cut) || latestVersion(own)); if (!base || base.childIds) continue;
        const tid = 'gena-' + fid + '--' + goal; seen.add(tid); let tw = d.series.find(s => s.id === tid);
        // a Hygiene chip is daily in Gena and so many a week in Glow's goal, so a Perfect day doesn't ask for all nine
        if (!tw){ tw = createSeries(d, {...base, matching:null, parentId:null, childIds:undefined, container:false, ...(row.week ? {recurrence:{kind:'target', days:allDays(), count:row.week, weeks:1, mode:'fixed', startDate:cut, session:''}} : {})}, cut); tw.id = tid; tw.category = own.category; delete tw.versions[0].parentId; delete tw.versions[0].childIds; stamp(tw, {id:fid, goal, kind:row.kind}); }
        twinned.add(fid); tw.archivedAt = null; tw.genaFed.focus = row.kit ? null : (copy.habits[fid] || copy.rules[fid]).focus;   // it counts on its Focus's card, wherever his goal lived
        sync(d, tw, days.map(x => [x, statusOf(copy, ids, row, x)]), T, changed);
      }
    }
    const mapped = new Set([...twinned].concat(genaIds(ROWS.find(r => r.kind === 'counter')).filter(id => copy.rules[id] && !copy.rules[id].counter)));   // a mapped item with no goal of his to carry it counts as any other, so nothing is lost
    // everything else in a graded Domain, one series a Gena id, in its Focus's group; it counts from the day it is added, never backdated
    const item = (id, name, focus, make, want) => {
      if (mapped.has(id) || NOT.has(id) || MENTOR_RULES.includes(id)) return;
      const f = copy.focuses[focus], um = f && gradeOf(f.domain); if (!um || um === 'faith' || um === 'health' || MENTOR_FOCUS.includes(focus)) return;
      const sid = 'gena-' + id, gid = cardOf(focus); seen.add(sid); let s = d.series.find(x => x.id === sid);
      if (!s){ s = createSeries(d, {name, category:gid, anchor:'midday', recurrence:make(), optional:!!make.optional}, make.from || from); s.id = sid; s.category = gid; stamp(s, {id}); news.push({id:sid, text:'New: ' + name + ' counts toward ' + (copy.domains[f.domain] || {}).name + ' from today.'}); }
      else { const v = s.versions[s.versions.length - 1]; if (v.name !== name) v.name = name; if (s.category !== gid){ const was = wsGroup(s, T); if (was !== gid){ s.versions.push(versionFrom({...v, category:gid}, v.version + 1, T)); s.category = gid; } }
        // a schedule he changes in Gena applies from today, and what is recorded stands
        const now = s.versions[s.versions.length - 1], fresh = make(); if (fresh.kind !== 'once' && (schedule(now.recurrence) !== schedule(normalizeRecurrence(fresh, T)) || !!now.optional !== !!make.optional)) s.versions.push(versionFrom({...now, recurrence:fresh, optional:!!make.optional}, now.version + 1, T)); }
      s.archivedAt = null; sync(d, s, want(s), T, changed);
    };
    for (const [id, h] of Object.entries(copy.habits)){
      const make = () => habitRec(h, h.start && h.start > from ? h.start : from); make.optional = h.optional; if (h.start && h.start > from) make.from = h.start;
      item(id, h.name, h.focus, make, () => { for (const x of days) if (plainMark(h, x) === 'partial') (shares['gena-' + id] = shares['gena-' + id] || {})[x] = h.parts ? partShare(h, x) : (h.log[x] || 0) / h.goal; return days.map(x => [x, plainMark(h, x)]); });
    }
    for (const [id, r] of Object.entries(copy.rules)){
      const sid = 'gena-' + id;
      if (r.until && r.until < cut) continue;   // a rule that ended before the cutover expects nothing
      if (r.counter){ counters[sid] = {name:r.name, goalN:r.counter.goalN, log:r.counter.log}; item(id, r.name, r.focus, () => recurrenceOf(r, from), () => { const by = {}, hit = {}; for (const x of Object.keys(r.counter.log).sort()){ const w = weekOf(x); by[w] = (by[w] || 0) + r.counter.log[x]; if (by[w] >= r.counter.goalN && !hit[w]) hit[w] = x; } const on = new Set(Object.values(hit)); return days.map(x => [x, on.has(x) ? 'done' : null]); }); continue; }   // the goal is met on the day the week's count reaches it
      for (const [x, n] of Object.entries(r.steps)){ (shares[sid] = shares[sid] || {})[x] = n.done / n.of; (weeks[sid] = weeks[sid] || {name:r.name, weeks:{}}).weeks[n.week] = {done:n.done, of:n.of}; }
      item(id, r.name, r.focus, () => recurrenceOf(r, from), () => days.map(x => [x, ruleOf(r, x)]));
      if (r.until && r.until < T){ const s = d.series.find(x => x.id === sid); if (s) s.archivedAt = dayAt(r.until, 1); }   // Gena's end date: no more days are expected, and its days stay
    }
    // a one-off counts in its due week, by firstDay then day: done by then is on time. Done after, it earns nothing there (a day left open never counts, BK-ROLL) and shows on the day it was done
    for (const [id, t] of Object.entries(copy.once)){ const make = () => ({kind:'once', date:t.day}); make.from = t.day < cut ? cut : t.day; const on = t.day < cut ? cut : t.day, late = t.mark === 'done' && t.doneOn && t.doneOn > on ? t.doneOn : null;
      item(id, t.name, t.focus, make, s => { const v = s.versions[s.versions.length - 1]; if (v.recurrence && v.recurrence.date !== on){ const old = v.recurrence.date; sync(d, s, [[old, null]], T, changed); v.recurrence = normalizeRecurrence({kind:'once', date:on}, v.effectiveFrom); if (on < v.effectiveFrom) v.effectiveFrom = on; } return days.map(x => [x, x === on ? (late ? null : t.mark) : x === late ? 'done' : null]); }); }
    // a Gena id no longer there stops from today; its days stay. A deleted one-off's day was never earned: it is cleared. One still in the copy only left the grades, and what it earned stands
    for (const s of d.series) if (s.genaFed && !seen.has(s.id) && !s.archivedAt){ const once = (latestVersion(s).recurrence || {}).kind === 'once' && !copy.once[s.genaFed.id]; if (once) sync(d, s, [[latestVersion(s).recurrence.date, null]], T, changed); s.archivedAt = T; }
    const journal = {}, jid = (map.swap || {})[JOURNAL] || JOURNAL; if (copy.habits[jid]) Object.assign(journal, copy.habits[jid].log);
    // what a day's status can't hold: a room's share of steps, Journal's count, the week's counter, the loads. A cache, rebuilt from every read that differs
    d.prefs.genaMentors = copy.mentors; d.prefs.genaNoFocus = copy.noFocus; const once = {}; for (const s of d.series){ const h = s.genaFed && copy.habits[s.genaFed.id]; if (h && h.once && h.per !== 'day') once[s.id] = {days:h.weekdays.length ? h.weekdays : allDays(), start:h.start}; }   // a once-a-day week or month habit: the grade reads its schedule, as Gena's habitTop
    d.prefs.genaDetail = {shares, weeks, counters, journal, kits:copy.kits, once};
    return {changed};
  }
  /* The cutover: his mapped goals end, with their history; their days from here on are Gena's. Ended, never deleted */
  function cutover(d, copy, T, today){
    d.prefs.genaCutover = T; d.prefs.genaMap = {found:{}, swap:{}}; const ended = [];
    d.prefs.genaNamesWas = JSON.parse(JSON.stringify(d.prefs.domainNames || {}));
    d.prefs.domainNames = {...(d.prefs.domainNames || {}), home:{name:'DRM'}, family:{name:'Family & Friends'}, career:{name:'Career'}};
    for (const row of ROWS) for (const goal of goalIds(d, row, T)){ const s = d.series.find(x => x.id === goal); if (!live(d, s, T) || s.genaFed) continue; s.archivedAt = T; ended.push(goal); }
    // a routine whose steps have all ended ends with them
    for (const s of d.series){ const v = !s.genaFed && live(d, s, T) ? versionFor(s, T) : null, kids = v && v.childIds; if (kids && kids.length && kids.every(id => { const c = d.series.find(x => x.id === id); return !c || !live(d, c, T); })){ s.archivedAt = T; ended.push(s.id); } }
    d.prefs.genaEnded = ended;
    const r = apply(d, copy, today || T, true); d.prefs.genaNews = [];   // what is there on the first day is not news
    // a tick of his from the Monday on, before the switch landed: its twin's day takes that tick's reward, so the day pays once
    const twins = new Map(d.series.filter(s => s.genaFed && s.genaFed.goal).map(s => [s.id, s.genaFed.goal]));
    for (const o of Object.values(d.occurrences)){ const goal = o.status === 'done' && twins.get(o.seriesId), own = goal && d.occurrences[occKey(goal, o.date)]; if (own && own.status === 'done') o.rewardEventId = rewardIdentity(d, own); }
    return {...r, ended};
  }
  /* The switch's one Undo, at any time since it needs no snapshot: the cache goes (it can always be read again), his goals run on, the names come back. What those
     days earned goes back as a correction, because the ledger keeps every claim. A read's save clears the toolbar's Undo, so the switch keeps its own */
  function undo(d){
    const fed = new Set(d.series.filter(s => s.genaFed).map(s => s.id)), earned = Object.values((d.rewards && d.rewards.claims) || {}).filter(c => fed.has(c.seriesId)).map(c => [c.seriesId, c.date]);
    for (const k of Object.keys(d.occurrences)) if (fed.has(d.occurrences[k].seriesId)) delete d.occurrences[k];
    correctClaimsOnce(d, earned, 'Gena switch undone');
    d.series = d.series.filter(s => !s.genaFed); d.groups = (d.groups || []).filter(g => !/^gena-/.test(g.id));
    for (const id of d.prefs.genaEnded || []){ const s = d.series.find(x => x.id === id); if (s) s.archivedAt = null; }
    if (d.prefs.genaNamesWas) d.prefs.domainNames = d.prefs.genaNamesWas;
    for (const k of ['genaCutover', 'genaMap', 'genaSig', 'genaAt', 'genaEnded', 'genaNamesWas', 'genaAsks', 'genaAsked', 'genaNews', 'genaMentors', 'genaNoFocus', 'genaDomains', 'genaDetail', 'genaPending']) delete d.prefs[k];
    return {ok:true};
  }
  const cardFocus = gid => gid.slice(5).split('~')[0];   // a card's Focus: gena-<id>, or gena-<id>~<day> after a move
  return {ROWS, DOMAINS, NOT, MENTOR_FOCUS, isCopy, isV7, notReady, read, reduce, sigOf, apply, cutover, undo, nextMonday, habitMark, cardFocus};
})();
if (typeof window !== 'undefined') window.GenaFeed = GenaFeed;
if (typeof module !== 'undefined') module.exports = GenaFeed;
