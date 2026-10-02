/* Body assets live in the local server store, outside the app's activity data. */

/* Where body assets are fetched from.
   Today the page is served BY the local body server, so a relative 'api/body/' resolves to it.
   Once the app is served from a hosted origin that relative path resolves to static hosting and
   404s, and an HTTPS page may not call http://127.0.0.1 (mixed content / private network).
   The wrapper therefore registers a custom scheme and sets window.HealthBodyTransport before this
   module loads. Both the JSON API and the binary .glb/.png assets resolve through this one base,
   so there is exactly one place that knows where body data lives. */
const BODY_TRANSPORT = window.HealthBodyTransport || null;
/* Three cases, decided once at load:
   - the Mac wrapper injected a transport, so the scheme handler reaches the body service;
   - the page is served BY the body service on loopback, so the old relative path still works;
   - anything else is the hosted website or the phone, which have no body service at all. */
const BODY_LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
const BODY_BASE = BODY_TRANSPORT ? BODY_TRANSPORT.base : 'api/body/';
const BODY_AVAILABLE = !!BODY_TRANSPORT || BODY_LOOPBACK;
const bodyMass=value=>{const u=window.HealthDisplayUnits||{mass:'lb',lb:v=>v};return u.lb(value).toFixed(1)+' '+u.mass;};
const bodyMeasurement=row=>{
  const u=window.HealthDisplayUnits,value=row.value,unit=row.unit;
  if(u&&Number.isFinite(value)){
    if(unit==='kg'||unit==='lb')return (unit==='kg'?u.kg(value):u.lb(value)).toFixed(1)+' '+u.mass;
    if(unit==='cm'||unit==='in')return (unit==='cm'?u.cm(value):u.inch(value)).toFixed(1)+' '+u.length;
    if(unit==='m'||unit==='km'||unit==='mi')return u.meters(value*(unit==='km'?1000:unit==='mi'?1609.344:1)).toFixed(2)+' '+u.distance;
  }
  return String(value??'')+(unit?' '+unit:'');
};
/* From the hosted HTTPS page WebKit never hands a custom-scheme request to the wrapper: it failed as
   "TypeError: Load failed" with no load started (Mintay's V1.1 log, 2026-09-23). The hosted wrapper
   therefore sets bridge:true, and every body request travels through the same native message bridge
   automatic intake uses. Binary files come back as bytes and are shown through blob: URLs. */
const BODY_BRIDGE = !!(BODY_TRANSPORT && BODY_TRANSPORT.bridge);
const bodyBlobs = new Map();
function toBase64(buffer) { const bytes = new Uint8Array(buffer); let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(text); }
function fromBase64(value) { const text = atob(value || ''); const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i); return bytes; }
async function bodyFetch(path, init) {
  if (!BODY_BRIDGE || !window.HealthNativeRequest) return fetch(BODY_BASE + path, init);
  const body = init && init.body, base64 = body == null ? null : toBase64(body instanceof Blob ? await body.arrayBuffer() : new TextEncoder().encode(String(body)));
  const reply = await window.HealthNativeRequest('bodyFetch', {path, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, base64});
  if (!reply.ok) throw new TypeError(reply.error || 'The body service did not answer.');
  const empty = [204, 205, 304].includes(reply.status);
  return new Response(empty ? null : fromBase64(reply.base64), {status: reply.status, headers: {'Content-Type': reply.contentType || 'application/octet-stream'}});
}
async function bodyBlobURL(url) {
  if (!bodyBlobs.has(url)) bodyBlobs.set(url, bodyFetch(url.slice(BODY_BASE.length)).then(async response => { if (!response.ok) throw new Error('HTTP ' + response.status); return URL.createObjectURL(await response.blob()); }));
  return bodyBlobs.get(url);
}
const FITDAYS_GROUPS = {
  'left-arm': {label: 'Left arm', color: '#70c5c1', parts: ['left-upper-arm', 'left-forearm']},
  'right-arm': {label: 'Right arm', color: '#8ba7e4', parts: ['right-upper-arm', 'right-forearm']},
  trunk: {label: 'Trunk', color: '#d7b96e', parts: ['chest', 'abdomen', 'back', 'pelvis']},
  'left-leg': {label: 'Left leg', color: '#c4a6e4', parts: ['left-thigh', 'left-calf', 'left-foot']},
  'right-leg': {label: 'Right leg', color: '#efa38f', parts: ['right-thigh', 'right-calf', 'right-foot']}
};
/* Segment estimates (V2.0; Mintay accepts labelled estimates, overriding the old whole-region-only rule):
   a limb's Fitdays fat and muscle split by segment mass fractions, de Leva 1996, male — upper arm 2.71%,
   forearm + hand 2.23% of body mass; thigh 14.16%, shank 4.33%, foot 1.37%. Always labelled "est.".
   The trunk is split the same way (V3.2, Mintay Sept 27): de Leva's upper trunk 15.96%, middle trunk 16.33%
   and lower trunk 11.17% of body mass (43.46% together). The model cuts the upper and middle trunk into a
   front (chest, abdomen) and a back, so each front takes half of its level and the back takes the two other
   halves; hips and pelvis are the lower trunk. The four shares add up to the trunk Fitdays measured. */
const SEGMENT_SHARE = {'upper-arm': 0.549, forearm: 0.451, thigh: 0.713, calf: 0.218, foot: 0.069,
  chest: 15.96 / 2 / 43.46, abdomen: 16.33 / 2 / 43.46, back: (15.96 + 16.33) / 2 / 43.46, pelvis: 11.17 / 43.46};
const segmentShare = region => { const key = Object.keys(SEGMENT_SHARE).find(k => region.endsWith(k)); return key ? SEGMENT_SHARE[key] : null; };
const fitdaysGroup = region => Object.keys(FITDAYS_GROUPS).find(key => key === region || FITDAYS_GROUPS[key].parts.includes(region));
/* Regions from parts (V2.2, PLAN 2.1/2.3). A key is a segment, a Fitdays whole region, or a saved region
   ('custom:<id>'). Figures: a whole limb or the whole trunk is exact; a part of one is its de Leva share and
   reads "est."; head, neck and anything without a Fitdays row are "not available at this segmentation".
   `total` is fat plus muscle, the two figures Fitdays reports for a region. */
function regionPartsOf(key, saved) {
  if (!key || key === 'all') return [];
  if (FITDAYS_GROUPS[key]) return FITDAYS_GROUPS[key].parts.slice();
  if (key.startsWith('custom:')) { const c = (saved || []).find(r => 'custom:' + r.id === key); return c ? c.parts.slice() : []; }
  return [key];
}
function regionFigures(parts, fitdays) {
  const rows = new Map(((fitdays && fitdays.segments) || []).map(r => [r.id, r]));
  const byGroup = new Map(); const missing = [];
  for (const p of parts) { const g = fitdaysGroup(p); if (!g || !rows.has(g)) { missing.push(p); continue; } if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(p); }
  let fat = 0, muscle = 0, est = false; const standIn = [], covered = [];
  for (const [g, ps] of byGroup) {
    const row = rows.get(g), all = FITDAYS_GROUPS[g].parts;
    const whole = ps.includes(g) || all.every(a => ps.includes(a));
    if (whole) { fat += row.fatMassLb; muscle += row.muscleBalanceMassLb; covered.push(...ps); continue; }
    let share = 0, unsplit = false;
    for (const p of ps) { const f = segmentShare(p); if (f === null) unsplit = true; else share += f; }
    if (unsplit) { fat += row.fatMassLb; muscle += row.muscleBalanceMassLb; standIn.push(g); }
    else { fat += row.fatMassLb * share; muscle += row.muscleBalanceMassLb * share; est = true; }
    covered.push(...ps);
  }
  if (!covered.length) return {fat: null, muscle: null, total: null, est: false, standIn, covered, missing};
  return {fat, muscle, total: fat + muscle, est, standIn, covered, missing};
}
function regionAutoName(parts, regions) {
  for (const [key, group] of Object.entries(FITDAYS_GROUPS)) if (group.parts.length === parts.length && group.parts.every(p => parts.includes(p))) return group.label;
  if (parts.length === 1) return (regions && regions[parts[0]]) || parts[0];
  return parts.length + ' segments';
}
/* V3.4 (B6): turns the lines read from a Fitdays report into its numbers. Lines are grouped into rows by height; a row's
   label decides the field, its numbers fill it (a glued "3.0lb" still reads). What it cannot find is listed in
   `missing`, so the confirm screen asks for it; nothing is guessed. Pounds only: a kilogram report is converted.
   V3.5 (B6), the real layouts: the date may be written with a month name ("Sep.25,2026 09:11", "Sep 25, 2026",
   "September 25, 2026 9:11 AM"); a whole-body label takes the value beside it on its row, or the one under it (a tile);
   and Fitdays prints no segment names, so the five pairs are read BY POSITION inside the "Segmental fat analysis" block
   (fat) and the "Muscle balance" block (muscle): top row the two arms, middle the trunk, bottom row the two legs, in lb
   (a percent-of-standard figure beside or under each is ignored here). Blocks may be stacked (phone) or side by side
   (A4). The side of each value is the side of the nearest L or R marker; with no marker the figure is taken to face the
   viewer, so the value on the viewer's left is the person's RIGHT. A glued unit read as "1b", "Ib" or "16" ("9.116")
   is the lb unit after Fitdays' one decimal. */
const REPORT_SEGMENTS = [['left-arm', /^left\s*arm/i], ['right-arm', /^right\s*arm/i], ['trunk', /^trunk/i], ['left-leg', /^left\s*leg/i], ['right-leg', /^right\s*leg/i]];
const REPORT_WHOLE = [['weight', /^(body\s*)?weight\b/i, 'lb'], ['bmi', /^bmi\b/i, null], ['bodyFatPercentage', /^body\s*fat(?!\s*mass)(\s*(rate|percentage|%))?\b/i, '%'], ['fatMass', /^(body\s*)?fat\s*mass/i, 'lb'], ['fatFreeWeight', /^fat[\s-]*free/i, 'lb'], ['muscleMass', /^muscle\s*mass/i, 'lb']];
const REPORT_BLOCKS = [['fat', /^segment(al)?\s*fat(\s*(analysis|mass))?\s*$/i], ['muscle', /^((segment(al)?\s*)?muscle\s*balance(\s*analysis)?|segment(al)?\s*muscle(\s*(analysis|mass))?)\s*$/i]];
const REPORT_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const REPORT_MASS = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(lbs?|[1Il|]bs?|kg)(?![a-z])|(\d{1,4}[.,]\d)16(?![\d%])/gi;
function reportMasses(text) {
  return [...String(text).matchAll(REPORT_MASS)].map(m => { const raw = m[1] || m[3], kg = /kg/i.test(m[2] || ''), v = parseFloat(raw.replace(',', '.')); return {v: kg ? Math.round(v / .45359237 * 10) / 10 : v, index: m.index, length: m[0].length}; });
}
function reportClock(h, m, ap) {
  let hour = Number(h); const min = Number(m); if (!(hour >= 0 && hour < 24 && min >= 0 && min < 60)) return null;
  if (ap) { const pm = /p/i.test(ap); if (hour < 1 || hour > 12) return null; hour = hour % 12 + (pm ? 12 : 0); }
  return String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function reportDate(t) {
  const iso = t.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (iso) return {date: iso[1] + '-' + iso[2].padStart(2, '0') + '-' + iso[3].padStart(2, '0'), time: iso[4] ? reportClock(iso[4], iso[5]) : null};
  const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  let m = t.match(new RegExp('\\b' + mon + '\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*[,.]?\\s*(\\d{4})', 'i')), day, month, year;
  if (m) { month = m[1]; day = m[2]; year = m[3]; }
  else { m = t.match(new RegExp('\\b(\\d{1,2})[\\s.\\-]*' + mon + '\\s*[,.\\-]?\\s*(\\d{4})', 'i')); if (m) { day = m[1]; month = m[2]; year = m[3]; } }
  if (!m) return null;
  const mi = REPORT_MONTHS.indexOf(month.toLowerCase().slice(0, 3)), d = Number(day);
  if (mi < 0 || d < 1 || d > 31) return null;
  const clock = t.slice(m.index + m[0].length).match(/^[^\d]{0,4}(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\b\.?)?/i);
  return {date: year + '-' + String(mi + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'), time: clock ? reportClock(clock[1], clock[2], clock[3]) : null};
}
function parseFitdaysReport(lines) {
  const items = (lines || []).filter(l => l && typeof l.text === 'string').map(l => ({text: l.text.trim(), x: +l.x || 0, y: +l.y || 0, w: +l.w || 0, h: +l.h || 0})).filter(l => l.text).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const l of items) { const row = rows.find(r => Math.abs(r.y - l.y) < 0.012); if (row) row.items.push(l); else rows.push({y: l.y, items: [l]}); }
  const texts = rows.map(r => r.items.slice().sort((a, b) => a.x - b.x).map(i => i.text).join('  ').trim());
  const nums = t => [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(lb|lbs|kg|%)?/gi)].map(m => ({v: parseFloat(m[1].replace(',', '.')), unit: (m[2] || '').toLowerCase()}));
  const toLb = n => n.unit === 'kg' ? Math.round(n.v / .45359237 * 10) / 10 : n.v;
  const out = {measurementDate: null, measurementTime: null, wholeBody: {}, segments: [], missing: []};
  const segment = id => { let s = out.segments.find(r => r.id === id); if (!s) { s = {id, fatMassLb: null, muscleBalanceMassLb: null}; out.segments.push(s); } return s; };
  /* the date, and labelled segment rows ("Left arm 3.0 lb 8.7 lb", the V3.4 shape) */
  for (const t of texts) {
    const when = !out.measurementDate && reportDate(t);
    if (when) { out.measurementDate = when.date; out.measurementTime = when.time; continue; }
    const seg = REPORT_SEGMENTS.find(([, re]) => re.test(t));
    if (seg) { const values = nums(t.replace(seg[1], '')).filter(n => n.unit !== '%'); const s = out.segments.find(r => r.id === seg[0]); if (values.length >= 2 && !s) out.segments.push({id: seg[0], fatMassLb: toLb(values[0]), muscleBalanceMassLb: toLb(values[1])}); }
  }
  /* whole-body figures: the value in the label's own line, else beside it on its row, else under it */
  const sameRow = (a, b) => Math.abs(a.y - b.y) < (a.h && b.h ? 0.6 * Math.max(a.h, b.h) : 0.012);
  const isValue = l => /^[\d]/.test(l.text) && !REPORT_WHOLE.some(([, re]) => re.test(l.text));
  const valueOf = (text, unit) => { if (unit === 'lb') { const m = reportMasses(text); if (m.length) return m[0].v; } const n = nums(text); return n.length ? (unit === 'lb' ? toLb(n[0]) : n[0].v) : null; };
  for (const l of items) {
    const whole = REPORT_WHOLE.find(([, re]) => re.test(l.text)); if (!whole || out.wholeBody[whole[0]]) continue;
    let v = valueOf(l.text.replace(whole[1], ''), whole[2]);
    if (v === null) { const right = items.filter(o => o !== l && o.x > l.x && sameRow(o, l) && isValue(o)).sort((a, b) => a.x - b.x)[0]; if (right) v = valueOf(right.text, whole[2]); }
    if (v === null) { const lh = l.h || 0.015, under = items.filter(o => o.y > l.y + lh * 0.5 && o.y < l.y + lh * 3.5 && Math.abs(o.x - l.x) < Math.max(0.03, (l.w || 0) * 0.5) && isValue(o)).sort((a, b) => a.y - b.y)[0]; if (under) v = valueOf(under.text, whole[2]); }
    if (v !== null) out.wholeBody[whole[0]] = {value: v, unit: whole[2]};
  }
  /* the segment blocks, by position */
  const heads = items.map(l => ({l, kind: (REPORT_BLOCKS.find(([, re]) => re.test(l.text)) || [])[0]})).filter(h => h.kind);
  const at = (l, i, n) => l.x + (l.w || 0) * ((i + n / 2) / Math.max(1, l.text.length));
  const status = /^(standard|normal|high|low|over|under|excellent|insufficient|healthy|fat|muscle)$/i;
  for (const head of heads) {
    const H = head.l, sib = heads.filter(o => sameRow(o.l, H) || Math.abs(o.l.y - H.y) < 0.02).map(o => o.l).sort((a, b) => a.x - b.x), k = sib.indexOf(H);
    const x0 = k > 0 ? sib[k].x - 0.02 : 0, x1 = k < sib.length - 1 ? sib[k + 1].x - 0.02 : 1;
    const inCol = l => l.x < x1 && l.x + (l.w || 0) > x0;
    const below = items.filter(l => l.y > H.y + (H.h || 0.01) * 0.5 && inCol(l));
    const stop = below.find(l => heads.some(o => o.l === l) || (/[a-z]{4,}/i.test(l.text) && !l.text.split(/\s+/).every(w => status.test(w) || !/[a-z]{4,}/i.test(w))));
    const yEnd = stop ? stop.y : Infinity, inside = below.filter(l => l.y < yEnd);
    const tokens = [], markers = [];
    for (const l of inside) {
      for (const m of reportMasses(l.text)) { const x = at(l, m.index, m.length); if (x >= x0 && x < x1) tokens.push({v: m.v, x, y: l.y, h: l.h}); }
      let pos = 0; for (const word of l.text.split(/\s+/)) { const i = l.text.indexOf(word, pos); pos = i + word.length; const side = /^(L|left)$/i.test(word) ? 'left' : /^(R|right)$/i.test(word) ? 'right' : null; if (side && (word.length > 1 || word === word.toUpperCase())) markers.push({side, x: at(l, i, word.length)}); }
    }
    if (tokens.length < 2) continue;
    const xs = tokens.map(t => t.x), cx = (Math.min(...xs) + Math.max(...xs)) / 2, spread = Math.max(...xs) - Math.min(...xs) || 1;
    const lines2 = []; for (const t of tokens.sort((a, b) => a.y - b.y)) { const r = lines2.find(r => Math.abs(r.y - t.y) < (t.h ? 0.6 * t.h : 0.008)); if (r) r.t.push(t); else lines2.push({y: t.y, t: [t]}); }
    const sideOf = t => { const L = markers.filter(m => m.side === 'left'), R = markers.filter(m => m.side === 'right'); const d = ms => ms.length ? Math.min(...ms.map(m => Math.abs(m.x - t.x))) : Infinity;
      if (L.length || R.length) return d(L) <= d(R) ? 'left' : 'right'; return t.x < cx ? 'right' : 'left'; };
    const put = (part, t) => { const s = segment(part); const f = head.kind === 'fat' ? 'fatMassLb' : 'muscleBalanceMassLb'; if (s[f] === null) s[f] = t.v; };
    const limbs = (row, limb, rest) => { const r = row.t.slice().sort((a, b) => a.x - b.x);
      if (r.length >= 2) { const a = r[0], b = r[r.length - 1], sa = sideOf(a), sb = sideOf(b); rest.push(...r.slice(1, -1)); if (sa !== sb) { put(sa + '-' + limb, a); put(sb + '-' + limb, b); } return; }
      if (Math.abs(r[0].x - cx) < 0.2 * spread) rest.push(r[0]); else put(sideOf(r[0]) + '-' + limb, r[0]); };
    const middle = [];
    if (lines2.length >= 2) { limbs(lines2[0], 'arm', middle); limbs(lines2[lines2.length - 1], 'leg', middle); }
    for (const r of lines2.slice(1, -1)) middle.push(...r.t);
    const trunk = middle.sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx))[0]; if (trunk) put('trunk', trunk);
  }
  for (const [k] of REPORT_WHOLE) if (!out.wholeBody[k]) out.missing.push(k);
  for (const [k] of REPORT_SEGMENTS) { const s = out.segments.find(r => r.id === k); if (!s || s.fatMassLb === null || s.muscleBalanceMassLb === null) out.missing.push(k); }
  out.segments = REPORT_SEGMENTS.map(([k]) => out.segments.find(r => r.id === k)).filter(Boolean);
  if (!out.measurementDate) out.missing.push('measurementDate');
  return out;
}
window.HealthBodyRegionMath = {partsOf: regionPartsOf, figures: regionFigures, autoName: regionAutoName, share: segmentShare, parseReport: parseFitdaysReport};
const BODY_ZOOM = {min:20, max:250, start:115, step:20};
/* V3.5 (B1, B10 to B12). The model and the photo share one framing: the body fills the box less this margin at the top
   and the bottom, so head and feet line up between them. Short labels for the Parts popover; Other is head and neck,
   bone and what the report's five regions leave over, worked out from the latest weigh-in, so every segment plus Other
   adds up to the weigh-in (ASSUMED V35-A3). */
const BODY_MARGIN = 0.04, BODY_FRAME = {min: 35, max: 220, step: 15};
const SEG_SHORT = {head: 'Head', chest: 'Chest', abdomen: 'Abs', back: 'Back', pelvis: 'Hips', 'left-upper-arm': 'L bicep', 'right-upper-arm': 'R bicep', 'left-forearm': 'L forearm', 'right-forearm': 'R forearm',
  'left-thigh': 'L thigh', 'right-thigh': 'R thigh', 'left-calf': 'L calf', 'right-calf': 'R calf', 'left-foot': 'L foot', 'right-foot': 'R foot', other: 'Other'};
const REGION_SHORT = {trunk: 'Trunk', 'right-arm': 'R arm', 'left-arm': 'L arm', 'right-leg': 'R leg', 'left-leg': 'L leg'};
const BC_TONE = {better: 'var(--c-violet,#b394ff)', average: 'var(--c-green,#79d6a9)', poor: 'var(--c-orange,#f0a058)', none: '#ffffff'};
const bodyIcon = (d, size) => '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const BODY_ICONS = {zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6M11 8v6"/>', zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6"/>', reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', report: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>', down: '<path d="M6 9l6 6 6-6"/>'};
class HealthBodyView extends HTMLElement {
  connectedCallback() {
    this.records = [];
    this.stage = null;
    this.selected = null;
    this.busy = false;
    this.photo = 'Front';
    this.region = 'all';
    this.regions = {};
    this.measurements = {readings: []};
    this.fitdays = null;
    this.mode = 'select'; this.linked = new Set(); this.compare = {a: null, b: null, next: 'a'}; this.sel = null; this.startPct = BODY_ZOOM.start;   // sel null = Whole Body (V3.5 B11)
    this.saved = []; try { this.saved = JSON.parse(localStorage.getItem('glow-body-regions') || '[]'); } catch (_) { this.saved = []; }
    if (!Array.isArray(this.saved)) this.saved = [];
    if (!BODY_AVAILABLE) { this.unavailable(); return; }
    this.innerHTML = '<p class="hint">Opening your body records…</p>';
    if (BODY_BRIDGE) this.bridgeAssets();
    this.addEventListener('click', event => this.clickAction(event));
    this.addEventListener('change', event => this.changeAction(event));
    this.load();
  }

  /* Shown on a surface that has no body backend: the hosted website and the iPhone PWA.
     The model, photos and Fitdays reports are private device-local files that only the Mac
     wrapper can reach, so this is a permanent state on those surfaces, not a loading error.
     TODO(Mintay): decide what this should say and show. See the three options discussed. */
  unavailable() {
    const esc=value=>this.escape(value);
    const snap = window.HealthBodySnapshot || null;
    const note = '<p class="hint">The 3D model and reference photos stay on the Mac, where the files live. These numbers came across with your last backup' + (snap && snap.capturedAt ? ', captured ' + esc(snap.capturedAt) : '') + '.</p>';
    // Imported whole-body figures live in the record itself, not in the body snapshot, so this
    // surface can be useful even before a backup carrying body files has been imported.
    this.fitdays = (snap && snap.fitdays) || null;
    const heading = this.compositionHeadingHTML();
    if (!heading && (!snap || (!snap.fitdays && !(snap.measurements && snap.measurements.readings.length)))) {
      this.innerHTML = '<section class="body-composition"><h3>Body</h3><p class="hint">No body numbers have come across yet. Open Health Tracker on your Mac and export a backup with body numbers included, then import it here.</p></section>';
      return;
    }
    let html = '<section class="body-composition" aria-label="Body numbers">' + heading;
    if (snap && snap.fitdays && snap.fitdays.segments.length) {
      html += '<h3>Fat &amp; muscle by region</h3><div class="body-composition-cards">' +
        snap.fitdays.segments.filter(row => FITDAYS_GROUPS[row.id]).map(row =>
          '<div class="body-composition-card" style="--region-color:' + FITDAYS_GROUPS[row.id].color + '">' +
          '<strong>' + esc(row.label) + '</strong>' +
          '<span><b>' + bodyMass(row.fatMassLb) + '</b> fat</span>' +
          '<span><b>' + bodyMass(row.muscleBalanceMassLb) + '</b> muscle</span></div>').join('') +
        '</div>';
    }
    const readings = (snap && snap.measurements && snap.measurements.readings) || [];
    if (readings.length) {
      html += '<details class="body-composition-details"><summary>Measurements</summary><table><tbody>' +
        readings.map(r => '<tr><td>' + esc(r.label || r.id || '') + '</td><td>' + esc(bodyMeasurement(r)) + '</td></tr>').join('') +
        '</tbody></table></details>';
    }
    this.innerHTML = html + this.reconciliationHTML() + note + '</section>';
  }

  /* Swap every body-file address in this element for a blob: URL fetched over the bridge. Images and
     the model load at once; a download link is fetched only when it is clicked. */
  bridgeAssets() {
    const swap = () => {
      for (const el of this.querySelectorAll('[src^="' + BODY_BASE + '"]')) {
        const url = el.getAttribute('src');
        el.setAttribute('src', '');
        bodyBlobURL(url).then(blob => el.setAttribute('src', blob)).catch(error => window.HealthBodyLog && window.HealthBodyLog(url.slice(BODY_BASE.length, 120) + ' failed: ' + error.message));
      }
    };
    new MutationObserver(swap).observe(this, {subtree: true, childList: true, attributes: true, attributeFilter: ['src']});
    this.addEventListener('click', event => {
      const link = event.target.closest && event.target.closest('a[download][href^="' + BODY_BASE + '"]');
      if (!link) return;
      event.preventDefault();
      bodyBlobURL(link.getAttribute('href')).then(blob => { link.setAttribute('href', blob); link.click(); }).catch(error => this.status(error.message, true));
    }, true);
  }

  disconnectedCallback() {
    if (this.stage) this.request('cancel', {stageId: this.stage.stageId}).catch(() => {});
    if (this.fullListener) { document.removeEventListener('fullscreenchange', this.fullListener); document.removeEventListener('webkitfullscreenchange', this.fullListener); document.removeEventListener('keydown', this.keyListener); this.fullListener = null; }
  }

  async request(action, data) {
    try { return await this.fetchJSON(action, data); }
    catch (error) { if (window.HealthBodyLog) window.HealthBodyLog(String(action).slice(0, 80) + ' via ' + BODY_BASE.split('/')[0] + ' failed: ' + error.name + ': ' + error.message); throw error; }
  }

  async fetchJSON(action, data) {
    const response = await bodyFetch(action, data ? {
      method: 'POST', headers: {'X-Body-Request': '1', 'X-Source-Name': data instanceof File ? data.name : '', 'Content-Type': data instanceof File ? 'application/octet-stream' : 'application/json'},
      body: data instanceof File ? data : JSON.stringify(data)
    } : {});
    // A missing or empty reply used to surface as the raw parser message "Unexpected end of JSON
    // input". No records list yet is simply no records; anything else names what failed in words.
    const text = await response.text();
    let result = null;
    try { result = text ? JSON.parse(text) : null; } catch (_) { result = null; }
    if (response.status === 404 && action === 'records') return [];
    if (!response.ok || result === null) throw new Error((result && result.error) || 'The body record could not be opened.');
    return result;
  }

  async load(id) {
    try {
      this.records = await this.request('records');
      if (!this.isConnected) return;
      this.selected = this.records.find(record => record.id === id) || this.records[0] || null;
      await this.loadRegionData();
      this.render();
    } catch (error) { this.render(); this.status(error.message, true); }
  }

  async loadRegionData() {
    this.regions = {}; this.region = 'all'; this.measurements = {readings: []}; this.fitdays = null;
    if (!this.selected) return;
    const base = 'records/' + this.selected.id + '/';
    try { this.regions = (await this.request(base + 'region-map.json')).regions; } catch (_) { /* Original model remains available when automatic region assignment is unsupported. */ }
    this.measurements = await this.request(base + 'measurements.json');
    this.fitdays = await this.request(base + 'fitdays.json');
    this.publishSnapshot();
  }

  /* The model and photos are large private files that only the Mac can serve. The NUMBERS are
     small, so they travel: the shell stores this snapshot in the record, App & backup carries it,
     and the website and phone render it through unavailable() below. Nothing here is a file. */
  publishSnapshot() {
    if (!this.selected) return;
    const snapshot = {
      recordId: this.selected.id,
      capturedAt: this.selected.capturedAt || this.selected.date || null,
      measurements: {readings: (this.measurements && this.measurements.readings) || []},
      fitdays: this.fitdays ? {
        measurementDate: this.fitdays.measurementDate || null,
        // Whole-body figures travel too, so the website and the phone can date each one the same
        // way the Mac does instead of showing regions with no reading beside them.
        wholeBody: this.fitdays.wholeBody || null,
        previous: this.fitdays.previous ? {measurementDate:this.fitdays.previous.measurementDate, wholeBody:this.fitdays.previous.wholeBody, segments:this.fitdays.previous.segments} : null,
        segments: (this.fitdays.segments || []).map(row => ({
          id: row.id, label: row.label, fatMassLb: row.fatMassLb,
          muscleBalanceMassLb: row.muscleBalanceMassLb,
          fatComparisonPercent: row.fatComparisonPercent,
          muscleComparisonPercent: row.muscleComparisonPercent
        }))
      } : null
    };
    this.dispatchEvent(new CustomEvent('bodysnapshot', {bubbles: true, detail: snapshot}));
  }

  regionOptions(selected) {
    const esc = v => this.escape(v);
    const groups = this.fitdays ? '<optgroup label="Fitdays whole regions">' + Object.entries(FITDAYS_GROUPS).map(([key,group]) => '<option value="'+key+'"' + (selected === key ? ' selected' : '') + '>'+group.label+'</option>').join('') + '</optgroup>' : '';
    const mine = this.saved.length ? '<optgroup label="Your regions">' + this.saved.map(r => '<option value="custom:' + esc(r.id) + '"' + (selected === 'custom:' + r.id ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') + '</optgroup>' : '';
    return groups + mine + '<optgroup label="Segments">' + Object.entries(this.regions).map(([key,name]) => '<option value="'+key+'"' + (selected === key ? ' selected' : '') + '>'+esc(name)+'</option>').join('') + '</optgroup>';
  }
  regionHTML() {
    const modes = [['select','Inspect'],['link','Link'],['compare','Compare']];
    return '<div class="body-segments"><div class="body-wb"><button type="button" class="body-rchip wb" data-body="chip" data-region="all" aria-pressed="' + (this.mode === 'select' && this.region === 'all') + '" data-parity="BODY-30">Whole Body</button>' +
      '<details class="body-help inline"><summary aria-label="About Whole Body and regions">ⓘ</summary><p class="hint">Whole Body is your latest weigh-in: total, fat and muscle from one reading, so they add up. Regions come from your last Fitdays report, dated, and are never added to the weigh-in. Click the body or a chip; hold Cmd (or Ctrl or Shift) and click to select several. Left and right are your body’s. Drag the model to rotate it.</p>' + this.reconciliationHTML() + '</details></div>' +
      '<div class="body-modes k-seg" role="group" aria-label="Region tool">' + modes.map(([m,l]) => '<button data-body="mode" data-mode="' + m + '" aria-pressed="' + (this.mode === m) + '">' + l + '</button>').join('') + '</div>' +
      this.regionChipsHTML() + '<div class="body-tools">' + this.toolsHTML() + '</div></div>';
  }
  figuresLine(parts) {
    const f = this.figuresOf(parts.flatMap(k => this.keyParts(k))), esc = v => this.escape(v), name = k => this.regions[k] || FITDAYS_GROUPS[k]?.label || (k === 'other' ? 'Other' : k);
    if (f.total === null) return '<span class="body-na">Not available at this segmentation' + (f.missing.length ? ' (' + esc(f.missing.map(name).join(', ')) + ')' : '') + '</span>';
    const u = window.HealthDisplayUnits || {mass:'lb', lb:v => v}, pct = n => f.total > 0 ? (100 * n / f.total).toFixed(1) + '%' : '—';
    return '<b>' + parts.length + ' part' + (parts.length === 1 ? '' : 's') + (f.est ? ' (est.)' : '') + '</b><span><strong>Total</strong> ' + u.lb(f.total).toFixed(1) + ' ' + u.mass + '</span><span class="body-fat-value"><strong>Fat</strong> ' + u.lb(f.fat).toFixed(1) + ' ' + u.mass + ' · ' + pct(f.fat) + '</span><span class="body-lean-value"><strong>Muscle</strong> ' + u.lb(f.lean).toFixed(1) + ' ' + u.mass + ' · ' + pct(f.lean) + '</span>' + (f.missing.length ? '<small>' + esc('no reading for ' + f.missing.map(name).join(', ')) + '</small>' : '');
  }
  toolsHTML() {
    const esc = v => this.escape(v), name = k => this.regions[k] || FITDAYS_GROUPS[k]?.label || k;
    if (this.mode === 'link') {
      const parts = [...this.linked], auto = parts.length ? regionAutoName(parts, this.regions) : '';
      const chips = parts.length ? parts.map(p => '<span class="body-chip">' + esc(name(p)) + '<button data-body="unlink" data-part="' + esc(p) + '" aria-label="Unlink ' + esc(name(p)) + '">✕</button></span>').join('') : '<span class="hint">Click segments on the model, or choose them above, to link them into one region.</span>';
      const mine = this.saved.length ? '<p class="cap">Your regions</p><div class="body-chips">' + this.saved.map(r => '<span class="body-chip saved"><button data-body="loadRegion" data-id="' + esc(r.id) + '">' + esc(r.name) + '</button><button data-body="removeRegion" data-id="' + esc(r.id) + '" aria-label="Remove ' + esc(r.name) + '">✕</button></span>').join('') + '</div>' : '';
      return '<div class="body-chips">' + chips + '</div>' + (parts.length ? '<div class="body-selection-figures">' + this.figuresLine(parts) + '</div><div class="body-link-acts"><input type="text" data-body="regionName" maxlength="40" placeholder="' + esc(auto) + '" aria-label="Name for this region" value=""><button data-body="saveRegion">Save as region</button><button class="ghost" data-body="clearLink">Clear</button></div>' : '') + mine;
    }
    if (this.mode === 'compare') {
      const a = this.compare.a, b = this.compare.b, pa = a ? this.keyParts(a) : [], pb = b ? this.keyParts(b) : [], label = k => k ? (k === 'all' ? 'Whole Body' : k === 'other' ? 'Other' : FITDAYS_GROUPS[k]?.label || (k.startsWith('custom:') ? (this.saved.find(r => 'custom:' + r.id === k) || {}).name : this.regions[k]) || k) : '—';   // V3.5 B11: Whole Body and Other compare too
      const pick = (slot, val) => '<span class="body-cmp-pick' + (this.compare.next === slot ? ' next' : '') + '"><span class="body-swatch ' + slot + '"></span>' + slot.toUpperCase() + ' <b>' + esc(label(val)) + '</b></span>';
      let table = '';
      if (a && b) {
        const fa = this.figuresOf(pa), fb = this.figuresOf(pb), cell = (f, k) => f[k] === null ? '<span class="body-na">not available at this segmentation</span>' : '<b>' + (f.est ? 'est. ' : '') + bodyMass(f[k]) + '</b>';
        const size = pa.filter(k => k !== 'head').length !== pb.filter(k => k !== 'head').length ? '<p class="hint">Unequal regions: ' + esc(label(a)) + ' has ' + pa.length + ' segment' + (pa.length === 1 ? '' : 's') + ', ' + esc(label(b)) + ' has ' + pb.length + '. Shapes are comparable; the numbers cover different amounts of body.</p>' : '';
        table = '<table class="body-cmp"><thead><tr><th></th><th><span class="body-swatch a"></span>' + esc(label(a)) + '</th><th><span class="body-swatch b"></span>' + esc(label(b)) + '</th></tr></thead><tbody>' +
          '<tr><td>Fat</td><td>' + cell(fa, 'fat') + '</td><td>' + cell(fb, 'fat') + '</td></tr><tr><td>Muscle</td><td>' + cell(fa, 'lean') + '</td><td>' + cell(fb, 'lean') + '</td></tr><tr><td>Total</td><td>' + cell(fa, 'total') + '</td><td>' + cell(fb, 'total') + '</td></tr><tr><td>Segments</td><td>' + pa.filter(k => k !== 'head').length + '</td><td>' + pb.filter(k => k !== 'head').length + '</td></tr></tbody></table>' + size +
          ((fa.est || fb.est) ? '<p class="hint">est.: parts are split from the Fitdays total of their limb or of the trunk by typical segment mass (de Leva).</p>' : '');
      } else table = '<p class="hint">Click two regions on the model, or choose A and B. Compare stays separate from linking.</p>';
      return '<div class="body-cmp-picks">' + pick('a', a) + pick('b', b) + '<button class="ghost" data-body="cmpSwap"' + (a && b ? '' : ' disabled') + '>Swap</button></div>' + table;
    }
    return '';   // Inspect: the selection panel carries the numbers (B3)
  }
  reconciliationHTML(){
    if(!window.GlowLearn)return '';
    const p=GlowLearn.partition(this.fitdays),old=GlowLearn.partition(this.fitdays&&this.fitdays.previous),u=window.HealthDisplayUnits||GlowLearn.units();
    if(!p)return '<p class="hint">A complete Fitdays report is needed for regional figures.</p>';
    const delta=(key,better)=>old&&window.GlowViews?GlowViews.delta({now:u.lb(p[key]),prev:u.lb(old[key]),better,unit:u.mass,period:'since '+this.date(old.date)}):'';
    const line=(name,key,cls,better)=>'<div class="'+(cls||'')+'"><strong>'+name+'</strong><b>'+u.lb(p[key]).toFixed(1)+' '+u.mass+'</b><span>'+(100*p[key]/p.weight).toFixed(1)+'%</span>'+delta(key,better)+'</div>';
    // A report without whole-body muscle mass still shows what it has; the unsegmented part cannot be split then.
    if(p.remainder===null)return '<section class="body-reconciliation" aria-label="Regional figures" data-parity="BODY-29"><p class="cap">Parts of '+this.escape(this.date(p.date))+'’s report</p>'+line('Five regions, fat','fat','body-fat-value','down')+line('Five regions, muscle','muscle','body-lean-value','up')+line('Report weight','weight','body-report-total',null)+'<p class="hint">This report has no whole-body '+(p.wholeFat===null?'fat and muscle':'muscle')+' mass, so the head, neck, bone and other parts cannot be worked out. '+(old?'Arrows compare the preceding dated report.':'No earlier report for change arrows.')+'</p></section>';
    return '<section class="body-reconciliation" aria-label="Regional figures" data-parity="BODY-29"><p class="cap">Parts of '+this.escape(this.date(p.date))+'’s report</p>'+line('Five regions, fat','fat','body-fat-value','down')+line('Five regions, muscle','muscle','body-lean-value','up')+line('Head, neck and unsegmented','remainder','',null)+(p.bone!==null?line('Bone','bone','',null):'')+line('Other (rounding)','other','',null)+line('Report weight','weight','body-report-total',null)+'<p class="hint">From the report itself: the unsegmented part is its whole-body fat and muscle less the five regions’; bone is its fat-free weight less its muscle; “other” is Fitdays’ own rounding, about a third of a pound. '+(p.reconciles?'':'These parts do not add up to the report weight; check the report. ')+(old?'Arrows compare the preceding dated report.':'No earlier report for change arrows.')+'</p></section>';
  }
  /* V3.4 (B3) kept: the freshness tone, the source line and the change arrows. */
  freshTone(date) { const d = Math.max(0, Math.round((Date.now() - new Date(date + 'T12:00:00').getTime()) / 864e5)); const h = d <= 3 ? 140 : d <= 6 ? 140 + (52 - 140) * (d - 3) / 3 : d <= 10 ? 52 + (4 - 52) * (d - 6) / 4 : 4; return {days: d, colour: 'hsl(' + Math.round(h) + ' 68% 62%)', words: d === 0 ? 'Today' : d === 1 ? '1 day ago' : d + ' days ago'}; }
  sourceLine(source, date, est) { if (!date) return ''; const f = this.freshTone(date); return '<span class="body-sel-src"><i style="background:' + f.colour + '" aria-hidden="true"></i>' + this.escape(source + (est ? ' (est)' : '')) + ' · ' + this.escape(this.date(date, true)) + ' · ' + f.words + '</span>'; }
  arrowHTML(now, prev, better, unit) { if (!Number.isFinite(now) || !Number.isFinite(prev)) return ''; const d = now - prev; if (Math.abs(d) < 0.3) return ''; const good = better === null ? null : (d < 0) === (better === 'down'); return ' <span class="body-arrow" style="color:' + (good === null ? 'var(--muted)' : good ? 'var(--c-green,#79d6a9)' : 'var(--c-orange,#f0a058)') + '">' + (d < 0 ? '↓' : '↑') + Math.abs(d).toFixed(1) + (unit ? ' ' + unit : '') + '</span>'; }
  /* V3.5 (B11): what can be selected. Every model segment and Other; head and neck have no report row, so they travel
     with Other (selecting one selects both). Whole Body is all of them. */
  allKeys() { const ks = new Set(Object.keys(this.regions || {}).concat(...Object.values(FITDAYS_GROUPS).map(g => g.parts))); ks.delete('head'); ks.delete('other'); return [...ks].concat(['head', 'other']); }   // the report's 14 parts, head and Other, whatever the model's own map holds
  selParts() { return this.sel ? [...this.sel] : this.allKeys(); }
  isWhole(parts) { const all = this.allKeys(), set = new Set(parts); return all.every(k => set.has(k)); }
  keyParts(key) { if (key === 'all') return this.allKeys(); if (key === 'other' || key === 'head') return ['head', 'other']; return regionPartsOf(key, this.saved).flatMap(k => k === 'other' || k === 'head' ? ['head', 'other'] : [k]); }
  /* The weigh-in the whole body reads (V3.4 B2): Apple Health's latest weight and body fat; else the report's own. */
  weighIn() {
    const w = window.HealthWholeBody || {}, wt = w.weight, bf = w.bodyFat;
    if (wt && bf && Number.isFinite(wt.value) && Number.isFinite(bf.value)) { const lb = wt.unit === 'kg' ? wt.value / .45359237 : wt.value, fat = lb * bf.value / 100; return {weight: lb, fat, lean: lb - fat, date: wt.date, source: wt.source || 'Apple Health'}; }
    const p = window.GlowLearn && GlowLearn.partition(this.fitdays);
    return p && Number.isFinite(p.wholeFat) ? {weight: p.weight, fat: p.wholeFat, lean: p.weight - p.wholeFat, date: p.date, source: 'Fitdays'} : null;
  }
  otherFigures(report, W) {
    const rows = (report && report.segments) || []; if (!W || Object.keys(FITDAYS_GROUPS).some(g => !rows.some(r => r.id === g))) return null;
    const fat = rows.filter(r => FITDAYS_GROUPS[r.id]).reduce((n, r) => n + r.fatMassLb, 0), muscle = rows.filter(r => FITDAYS_GROUPS[r.id]).reduce((n, r) => n + r.muscleBalanceMassLb, 0);
    return {fat: W.fat - fat, lean: W.lean - muscle};
  }
  /* Figures for any set of parts: segments from the report (a part of a limb or the trunk by its typical share, "est."),
     Other from the weigh-in. Comparison percentages (Fitdays' percent of standard) are averaged by mass for the colours. */
  figuresOf(parts, report, W) {
    report = report === undefined ? this.fitdays : report; W = W === undefined ? this.weighIn() : W;
    const rows = new Map(((report && report.segments) || []).map(r => [r.id, r]));
    let fat = 0, lean = 0, est = false, cf = 0, cfw = 0, cm = 0, cmw = 0, other = null; const missing = [], seen = new Set();
    for (const k of parts) {
      if (k === 'head' || k === 'other') { if (seen.has('other')) continue; seen.add('other'); other = this.otherFigures(report, W); if (other) { fat += other.fat; lean += other.lean; } else missing.push('other'); continue; }
      const g = fitdaysGroup(k), row = g && rows.get(g); if (!row) { missing.push(k); continue; }
      const share = k === g ? 1 : segmentShare(k); if (share === null) { missing.push(k); continue; }
      if (k !== g && !FITDAYS_GROUPS[g].parts.every(q => parts.includes(q))) est = true;   // a whole region is exact; a part of one is its typical share
      const f = row.fatMassLb * share, m = row.muscleBalanceMassLb * share; fat += f; lean += m;
      if (Number.isFinite(row.fatComparisonPercent)) { cf += row.fatComparisonPercent * f; cfw += f; }
      if (Number.isFinite(row.muscleComparisonPercent)) { cm += row.muscleComparisonPercent * m; cmw += m; }
    }
    const total = fat + lean, any = parts.length > missing.length;
    return {fat: any ? fat : null, lean: any ? lean : null, total: any ? total : null, other, est, missing, fatStd: cfw ? cf / cfw : null, muscleStd: cmw ? cm / cmw : null, weight: W ? W.weight : null, eq: !!W && any && Math.abs(total - W.weight) < 0.05};
  }
  /* B10 colours (ASSUMED 24): purple better than average for age, sex and height, green average, orange not good, never red.
     Whole-body fat by the body-fat tier table; a region by Fitdays' percent of standard (fat: lower is better, muscle:
     higher; 90 to 110 is the average band, ASSUMED V35-A4); white where no reference exists. */
  fatTone(f, wholeFat) {
    if (wholeFat) { const t = window.HealthFatTier && window.HealthFatTier(100 * f.fat / f.total); if (!t) return 'none'; return ['violet', 'purple', 'blue', 'tierBlue'].includes(t.tone) ? 'better' : t.tone === 'green' ? 'average' : 'poor'; }
    return f.fatStd === null ? 'none' : f.fatStd < 90 ? 'better' : f.fatStd <= 110 ? 'average' : 'poor';
  }
  muscleTone(f) { return f.muscleStd === null || f.other ? 'none' : f.muscleStd > 110 ? 'better' : f.muscleStd >= 90 ? 'average' : 'poor'; }
  selectionName(parts, key) {
    if (this.isWhole(parts)) return 'Whole Body';
    const custom = key && key.startsWith && key.startsWith('custom:') ? this.saved.find(r => 'custom:' + r.id === key) : null; if (custom) return custom.name;
    const set = new Set(parts), group = Object.entries(FITDAYS_GROUPS).find(([, g]) => g.parts.length === set.size && g.parts.every(p => set.has(p)));
    if (group) return group[1].label;
    if (set.has('other') && set.size <= 2) return 'Other';
    const n = parts.filter(k => k !== 'head').length;   // head travels with Other
    return n === 1 ? (this.regions[parts[0]] || SEG_SHORT[parts[0]] || parts[0]) : n + ' Segments';
  }
  /* B10: the Body Composition card. Rows Other, Fat, Muscle, then Total under a thin rule as their sum; a fixed grid of
     name, pounds and percent; the legend behind ⓘ. Docked over the model's top-left corner, larger in full screen. */
  selectionHTML() {
    const u = window.HealthDisplayUnits || {mass: 'lb', lb: v => v}, esc = v => this.escape(v), W = this.weighIn();
    const linkPick = this.mode === 'link' && this.linked.size, parts = linkPick ? [...this.linked].flatMap(k => this.keyParts(k)) : this.selParts();
    const f = this.figuresOf(parts), whole = this.isWhole(parts), name = this.selectionName(parts, this.mode === 'select' ? this.region : null), report = this.fitdays;
    const head = '<div class="bc-head"><span class="bc-title">Body Composition</span><details class="bc-info"><summary aria-label="About Body Composition" title="About Body Composition">ⓘ</summary><div class="bc-pop">' +
      '<p class="bc-legt">Compared with men your age and height</p><p><i style="background:' + BC_TONE.better + '"></i>Better than average</p><p><i style="background:' + BC_TONE.average + '"></i>Average</p><p><i style="background:' + BC_TONE.poor + '"></i>Not good</p>' +
      (f.total !== null && W ? '<p class="bc-sub">Selected ' + parts.filter(k => k !== 'head').length + ' of ' + this.allKeys().filter(k => k !== 'head').length + ' · ' + u.lb(f.total).toFixed(1) + ' of ' + u.lb(W.weight).toFixed(1) + ' ' + u.mass + (f.eq ? ' ✓' : '') + '</p>' : '') +
      (W ? '<p class="bc-sub">Whole Body: ' + esc(W.source) + ', ' + esc(this.date(W.date, true)) + '. Segments: Fitdays, ' + (report && report.measurementDate ? esc(this.date(report.measurementDate, true)) : 'no report yet') + (report && W.date && report.measurementDate && report.measurementDate !== W.date ? ' (different dates)' : '') + '.</p>' : '') +
      '<p class="bc-sub">Muscle is everything that is not fat (lean mass: water, organs and bone included). Other is head and neck, bone and what the report’s five regions leave over, from your latest weigh-in, so every part plus Other adds up to your weight. A part of a limb or of the trunk is its typical share of that region (est.).</p>' + this.reconciliationHTML() + '</div></details></div>';
    if (f.total === null) return '<section class="bc-card" data-parity="V35-B10-01" aria-label="Body Composition">' + head + '<b class="bc-name">' + esc(name) + '</b><span class="body-na">' + (W || report ? 'Not available at this segmentation' : 'No weigh-in yet.') + '</span></section>';
    const prevReport = report && report.previous, old = !whole && !f.other && prevReport ? this.figuresOf(parts, prevReport, null) : null;
    const pct = n => f.total > 0 ? (100 * n / f.total).toFixed(1) + '%' : '—', row = (cls, label, value, p, tone, extra, parity) => '<span class="bc-n ' + cls + '"' + (parity ? ' data-parity="' + parity + '"' : '') + '>' + label + '</span><span class="bc-v ' + cls + '" style="color:' + BC_TONE[tone] + '">' + u.lb(value).toFixed(1) + ' ' + u.mass + '</span><span class="bc-p ' + cls + '" style="color:' + BC_TONE[tone] + '">' + p + (extra || '') + '</span>';
    const left = W && !f.eq && f.other ? '<span class="bc-left" data-parity="V35-B11-03">' + u.lb(Math.max(0, W.weight - f.total)).toFixed(1) + ' ' + u.mass + ' left out</span>' : '';
    const src = whole || f.other ? this.sourceLine(W ? W.source : 'Fitdays', W ? W.date : report && report.measurementDate, false) : this.sourceLine(report && report.extraction === 'self-entered' ? 'Self-entered' : 'Fitdays', report && report.measurementDate, f.est);
    return '<section class="bc-card" data-parity="V35-B10-01" aria-label="Body Composition">' + head + '<b class="bc-name">' + esc(name) + '</b><div class="bc-grid" data-parity="BODY-26">' +
      (f.other ? row('other', 'Other', f.other.fat + f.other.lean, pct(f.other.fat + f.other.lean), 'none') : '') +
      row('fat', 'Fat', f.fat, pct(f.fat), this.fatTone(f, whole || !!f.other), old && old.fat !== null ? this.arrowHTML(u.lb(f.fat), u.lb(old.fat), 'down', '') : '') +
      row('muscle', 'Muscle', f.lean, pct(f.lean), this.muscleTone(f), old && old.lean !== null ? this.arrowHTML(u.lb(f.lean), u.lb(old.lean), 'up', '') : '', 'BODY-27') +
      '<i class="bc-rule" aria-hidden="true"></i>' + row('total', 'Total', f.total, W ? (f.eq ? '100%' : (100 * f.total / W.weight).toFixed(1) + '%') : '100%', 'none', f.eq ? '<em class="bc-eq" data-parity="V35-B11-02" title="Equals your weight" aria-label="Equals your weight">✓</em>' : '') +
      '</div>' + left + src + '</section>';
  }
  /* B12: short labels in a Parts popover. Regions read Trunk, R arm, L arm, R leg, L leg; segments read Head, Chest, Abs,
     R bicep and so on, and Other; Select all is Whole Body. In Inspect a part toggles in or out of the selection. */
  regionChipsHTML() {
    const esc = v => this.escape(v), sel = new Set(this.selParts());
    const on = k => this.mode === 'select' ? (k === 'all' ? this.isWhole([...sel]) : this.keyParts(k).every(p => sel.has(p))) : this.mode === 'link' ? this.keyParts(k).length > 0 && this.keyParts(k).every(p => this.linked.has(p)) : this.compare.a === k ? 'a' : this.compare.b === k ? 'b' : false;
    const chip = (k, label, title) => { const s = on(k); return '<button type="button" class="body-rchip' + (s === 'a' ? ' slot-a' : s === 'b' ? ' slot-b' : '') + '" data-body="chip" data-region="' + esc(k) + '" aria-pressed="' + !!s + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(label) + '</button>'; };
    const groups = this.fitdays ? ['trunk', 'right-arm', 'left-arm', 'right-leg', 'left-leg'].map(k => chip(k, REGION_SHORT[k], FITDAYS_GROUPS[k].label)).join('') : '';
    const mine = this.saved.map(r => chip('custom:' + r.id, r.name)).join('');
    const order = ['head', 'chest', 'abdomen', 'back', 'pelvis', 'right-upper-arm', 'left-upper-arm', 'right-forearm', 'left-forearm', 'right-thigh', 'left-thigh', 'right-calf', 'left-calf', 'right-foot', 'left-foot'];
    const keys = this.allKeys().filter(k => k !== 'other').sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    const segs = keys.map(k => chip(k, SEG_SHORT[k] || this.regions[k] || k, this.regions[k] || SEG_SHORT[k])).join('') + chip('other', 'Other', 'Head and neck, bone and the rest: what the report’s five regions leave over');
    return '<div class="body-rchips" data-parity="V35-B12-01">' + (this.mode !== 'link' ? '<div class="body-rgroup"><button type="button" class="body-rchip all" data-body="chip" data-region="all" aria-pressed="' + !!on('all') + '">Select all</button></div>' : '') + (groups ? '<div class="body-rgroup">' + groups + '</div>' : '') + (mine ? '<div class="body-rgroup">' + mine + '</div>' : '') + '<div class="body-rgroup segs">' + segs + '</div></div>';
  }
  regionHTML() {
    const modes = [['select','Inspect'],['link','Link'],['compare','Compare']], whole = this.mode === 'select' && this.isWhole(this.selParts());
    return '<div class="bs-bar"><button type="button" class="body-rchip wb" data-body="chip" data-region="all" aria-pressed="' + whole + '" data-parity="BODY-30"><span data-parity="V35-B11-01">Whole Body</span></button>' +
      '<details class="bs-parts" data-parity="BODY-37"><summary class="bs-btn" aria-label="Parts">Parts' + bodyIcon(BODY_ICONS.down, 13) + '</summary><div class="bs-pop">' + this.regionChipsHTML() + '</div></details>' +
      '<div class="body-modes k-seg" role="group" aria-label="Region tool">' + modes.map(([m,l]) => '<button data-body="mode" data-mode="' + m + '" aria-pressed="' + (this.mode === m) + '">' + l + '</button>').join('') + '</div>' +
'</div>';
  }
  partsInView(key) { return regionPartsOf(key, this.saved); }
  paintModel(key) {
    const viewer = this.querySelector('model-viewer');
    if (!(viewer && viewer.model) || this.stage) return;
    const A = this.mode === 'compare' ? new Set(this.partsInView(this.compare.a)) : null, B = this.mode === 'compare' ? new Set(this.partsInView(this.compare.b)) : null;
    for (const material of viewer.model.materials) {
      const n = material.name; let color;
      if (this.mode === 'link') color = this.linked.has(n) ? '#ddb864' : '#5e7472';
      else if (this.mode === 'compare') color = A.has(n) ? (B.has(n) ? '#a3b79a' : '#ddb864') : B.has(n) ? '#6fa8dc' : '#5e7472';
      else {
        const parts = new Set(this.selParts()), whole = this.isWhole([...parts]), on = parts.has(n) || (n === 'head' && parts.has('other')), group = fitdaysGroup(n);   // V3.5 B11: Inspect paints its selection
        color = whole ? (this.fitdays && group ? FITDAYS_GROUPS[group].color : '#72a2a3') : on ? (this.fitdays && group ? FITDAYS_GROUPS[group].color : '#ddb864') : '#4f6160';
      }
      material.pbrMetallicRoughness.setBaseColorFactor(color);
    }
  }
  /* The selection panel, the chips and the mode switch follow every pick (B3, B5). */
  refreshSide() {
    const sel = this.querySelector('.bc-card'); if (sel) { const open = !!sel.querySelector('.bc-info[open]'), t = document.createElement('template'); t.innerHTML = this.selectionHTML(); if (open) t.content.querySelector('.bc-info').open = true; sel.replaceWith(t.content); }
    const chips = this.querySelector('.body-rchips'); if (chips) { const t = document.createElement('template'); t.innerHTML = this.regionChipsHTML(); chips.replaceWith(t.content); }
    const wb = this.querySelector('.body-rchip.wb'); if (wb) wb.setAttribute('aria-pressed', String(this.mode === 'select' && this.isWhole(this.selParts())));
  }
  refreshTools() {
    const tools = this.querySelector('.body-tools'); if (tools) tools.innerHTML = this.toolsHTML();
    this.refreshSide();
    const label = this.querySelector('.body-segments > label'); if (label && label.firstChild && label.firstChild.nodeType === 3) label.firstChild.textContent = this.mode === 'link' ? 'Add to the region' : this.mode === 'compare' ? 'Pick a region' : 'Highlight a region';
    this.querySelectorAll('[data-body="mode"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === this.mode)));
    if (this.mode === 'select') { this.highlight(this.region); return; }
    this.paintModel(this.region);
    const overlay = this.querySelector('.body-region-overlay');
    if (overlay) {
      const esc = v => this.escape(v);
      if (this.mode === 'link') { const parts = [...this.linked]; overlay.innerHTML = parts.length ? '<strong>' + esc(regionAutoName(parts, this.regions)) + '</strong><span>' + this.figuresLine(parts) + '</span>' : '<strong>Link segments</strong><span>Click segments to build a region.</span>'; }
      else { const a = this.compare.a, b = this.compare.b; overlay.innerHTML = '<strong>Compare</strong><span>' + (a && b ? 'A in gold, B in blue' : a ? 'A chosen · pick B' : 'Pick A, then B') + '</span>'; }
    }
  }
  /* One entry for every way a region gets chosen: the model, the dropdown, a composition card. */
  pick(key) {
    if (this.mode === 'link') { if (key === 'all') return; for (const p of this.partsInView(key)) { if (this.linked.has(p) && this.partsInView(key).length === 1) this.linked.delete(p); else this.linked.add(p); } this.refreshTools(); return; }
    if (this.mode === 'compare') { const slot = this.compare.next; this.compare[slot] = key; this.compare.next = slot === 'a' ? 'b' : 'a'; this.refreshTools(); return; }
    this.highlight(key);
  }
  /* Cmd-, Ctrl- or Shift-click on the model (V3.2): the segment joins what is selected, without choosing Link
     first. What was highlighted comes along, so two clicks make a region of two. */
  addToSelection(key) {
    if (this.mode === 'select') { const s = new Set(this.selParts()), ks = this.keyParts(key), all = ks.every(k => s.has(k)); for (const k of ks) { if (all) s.delete(k); else s.add(k); } this.sel = this.isWhole([...s]) ? null : s; this.highlight('sel'); return; }   // V3.5 B11: Cmd-click toggles a part in Inspect
    if (this.mode !== 'link') { this.linked = new Set(this.region && this.region !== 'all' ? this.partsInView(this.region) : []); this.mode = 'link'; }
    if (this.linked.has(key)) this.linked.delete(key); else this.linked.add(key);
    this.refreshTools();
  }
  saveRegions() { try { localStorage.setItem('glow-body-regions', JSON.stringify(this.saved)); } catch (_) {} }
  /* A whole-body figure follows whichever source measured it most recently and shows that
     source's own date. The Fitdays report was the only source here, so a May scale reading stayed
     on screen while Apple Health already held a September one. Figures are never averaged across
     sources and never share one date; where only Fitdays has a measurement, it keeps the Fitdays
     date rather than borrowing a newer one. */
  wholeBodyFigures() {
    const app = (typeof window !== 'undefined' && window.HealthWholeBody) || {};
    const whole = (this.fitdays && this.fitdays.wholeBody) || {};
    const date = this.fitdays && this.fitdays.measurementDate;
    const fromFitdays = (field, unit) => {
      const value = whole[field] && whole[field].value;
      return Number.isFinite(value) && date ? {value, unit: (whole[field] && whole[field].unit) || unit, date, source: 'Fitdays'} : null;
    };
    const newer = (a, b) => !b ? a : !a ? b : a.date >= b.date ? a : b;
    return [
      {label: 'weight', figure: newer(app.weight, fromFitdays('weight', 'lb'))},
      {label: 'body fat', figure: newer(app.bodyFat, fromFitdays('bodyFatPercentage', '%'))},
      {label: 'lean mass', figure: app.leanMass || null},
      // Fitdays' muscle has no Apple Health twin; it shows only when your export has no lean mass.
      {label: 'muscle', figure: app.leanMass ? null : fromFitdays('muscleMass', 'lb')},
      {label: 'BMI', figure: newer(app.bmi, fromFitdays('bmi', null))}
    ].filter(row => row.figure);
  }

  compositionHeadingHTML() {
    if(typeof window.HealthBodyFiguresHTML==='function')return window.HealthBodyFiguresHTML(this.fitdays);
    const esc = value => this.escape(value);
    const rows = this.wholeBodyFigures();
    if (!rows.length) return '';
    const stats = rows.map(row => '<span><b>' + esc(row.figure.value.toFixed(1)) + (row.figure.unit === '%' ? '%' : row.figure.unit ? ' ' + esc(row.figure.unit) : '') + '</b> ' + esc(row.label) + '<small>' + esc(row.figure.source) + ' · ' + esc(this.date(row.figure.date)) + '</small></span>').join('');
    const dates = new Set(rows.map(row => row.figure.date));
    return '<div class="body-composition-heading"><p class="cap">Whole body</p><div class="body-whole-stats">' + stats + '</div><p class="hint">' + (dates.size > 1 ? 'Each figure is its own most recent measurement and keeps that source’s date. They are from different days and are not combined.' : 'Each figure shows the source that measured it and the date it was measured.') + '</p></div>';
  }

  compositionHTML() {
    if (!this.fitdays) return '<div class="body-fitdays-empty"><label class="filebtn body-import">Add reviewed Fitdays report<input data-body="fitdays" type="file" accept=".zip" aria-label="Add reviewed Fitdays report ZIP"></label></div>';
    const report = this.fitdays;
    return '<section class="body-composition" aria-label="Fitdays regional composition"><h3>Fat &amp; muscle by region</h3><p class="hint">Fitdays · '+this.escape(this.date(report.measurementDate))+' '+this.escape(report.measurementTime || '')+' · report timezone not specified. No other source measures individual regions, so these stay on the Fitdays date'+(report.measurementDate !== this.selected.captureDate ? ', shown on your '+this.escape(this.date(this.selected.captureDate))+' model' : '')+'. Fitdays-reported estimates; segment fat is inferred, and colors identify regions rather than showing fat inside your body.</p><div class="body-composition-cards">'+this.fitdays.segments.map(row => '<button data-body="composition-region" data-region="'+row.id+'" aria-pressed="false" style="--region-color:'+FITDAYS_GROUPS[row.id].color+'"><strong><i aria-hidden="true"></i>'+row.label+'</strong><span><b>'+bodyMass(row.fatMassLb)+'</b> fat</span><span><b>'+bodyMass(row.muscleBalanceMassLb)+'</b> muscle</span></button>').join('')+'</div><p class="hint">Whole-arm, whole-leg and trunk totals. Smaller regions are estimated from these by typical segment mass and read “est.”.</p><details class="body-composition-details"><summary>Report details & comparison percentages</summary><p class="hint">These percentages compare with the Fitdays standard range. They are not regional body-fat percentages or shares of your total. '+(report.sourceSha256?'Transcribed from the saved report image.':'')+(report.extraction?' Entry: '+this.escape(report.extraction)+'.':'')+'</p><table><thead><tr><th>Region</th><th>Fat comparison</th><th>Muscle comparison</th></tr></thead><tbody>'+this.fitdays.segments.map(row=>'<tr><td>'+row.label+'</td><td>'+(Number.isFinite(row.fatComparisonPercent)?row.fatComparisonPercent.toFixed(1)+'%':'—')+'</td><td>'+(Number.isFinite(row.muscleComparisonPercent)?row.muscleComparisonPercent.toFixed(1)+'%':'—')+'</td></tr>').join('')+'</tbody></table>'+(report.sourceSha256?'<p><a class="body-export" href="'+this.asset('fitdays-source.jpg')+'" target="_blank" rel="noopener">View original Fitdays report ↗</a></p>':'<p class="hint">No picture was saved with this report.</p>')+'<p><a class="body-export" href="'+this.asset('fitdays-export.zip')+'" download>Export Fitdays report + values</a></p><label class="filebtn body-import">Add another reviewed Fitdays report<input data-body="fitdays" type="file" accept=".zip" aria-label="Add reviewed Fitdays report ZIP"></label><p class="hint">Fitdays reports are saved separately from your model, photos and HealthAutoExport source.</p></details></section>';
  }

  refreshFigures(){
    if(this.querySelector('.body-composition[aria-label="Body numbers"]')){this.unavailable();return;}
    const current=this.querySelector('.body-figures');
    if(current){const next=document.createElement('template');next.innerHTML=this.compositionHeadingHTML();current.replaceWith(next.content);}
    const tools=this.querySelector('.body-tools');
    if(tools){
      const field=tools.querySelector('[data-body="regionName"]'),draft=field?{value:field.value,focused:document.activeElement===field,start:field.selectionStart,end:field.selectionEnd}:null;
      tools.innerHTML=this.toolsHTML();
      const next=tools.querySelector('[data-body="regionName"]');if(draft&&next){next.value=draft.value;if(draft.focused){next.focus({preventScroll:true});next.setSelectionRange(draft.start,draft.end);}}
    }
    const measurements=this.querySelector('.body-measurements');if(measurements){const open=measurements.open,holder=document.createElement('template');holder.innerHTML=this.measurementHTML();holder.content.firstElementChild.open=open;measurements.replaceWith(holder.content);}
    const composition=this.querySelector('.body-composition[aria-label="Fitdays regional composition"]');if(composition){const holder=document.createElement('template');holder.innerHTML=this.compositionHTML();composition.replaceWith(holder.content);}
    if(this.selected)this.highlight(this.region);
  }

  measurementHTML() {
    const esc = value => this.escape(value);
    const readings = this.measurements.readings || [];
    return '<details class="body-measurements"><summary>Body measurements from your export</summary><label class="filebtn body-import">Add HealthAutoExport file<input data-body="measurements" type="file" accept=".zip,.csv" aria-label="Add HealthAutoExport body measurements"></label>' +
      '<p class="hint">' + (this.measurements.source ? esc(this.measurements.sourceFile) + ' · ' + readings.length + ' body readings' : 'No body-measurement export linked yet.') + '</p>' +
      (this.measurements.coverageStart ? '<p class="hint">Export coverage: '+esc(this.measurements.coverageStart)+' – '+esc(this.measurements.coverageEnd)+'. These dates may differ from the model capture date.</p>' : '') +
      '<div class="body-readings">' + (readings.length ? readings.slice(-30).map(r=>'<p><b>'+esc(r.label)+': '+esc(bodyMeasurement(r))+'</b><br><span class="hint">'+esc(r.region === 'whole-body' ? 'Whole body' : r.region)+' · '+esc(r.recordedAt)+' · HealthAutoExport</span></p>').join('') : '<p>Weight, body fat and lean body mass: <b>Not available in this HealthAutoExport file</b></p>') + '</div><p class="hint">Regional fat and muscle: Not available in this HealthAutoExport file. Whole-body values are not assigned to individual limbs.</p>' +
      (this.measurements.source ? '<a class="body-export" href="'+this.asset('measurements.json')+'" download="body-measurement-source.json">Export measurement source details</a>' : '') + '</details>';
  }

  highlight(key) {
    if (this.mode === 'select' && key !== 'sel') this.sel = key === 'all' ? null : new Set(this.keyParts(key));   // V3.5 B11
    this.region = key;
    const tools=this.querySelector('.body-tools');if(tools&&this.mode==='select')tools.innerHTML=this.toolsHTML();
    this.refreshSide();
    const select = this.querySelector('[data-body="region"]'); if (select) select.value = key;
    const viewer = this.querySelector('model-viewer');
    const groupKey = fitdaysGroup(key);
    this.querySelectorAll('[data-body="composition-region"]').forEach(el => el.setAttribute('aria-pressed', el.dataset.region === groupKey));
    this.paintModel(key);
    const overlay = this.querySelector('.body-region-overlay');
    if (overlay) {
      overlay.replaceChildren();
      const custom = key.startsWith('custom:') ? this.saved.find(r => 'custom:' + r.id === key) : null;
      const title = document.createElement('strong'); title.textContent = custom ? custom.name : this.regions[key] || FITDAYS_GROUPS[key]?.label || 'Whole body'; overlay.append(title);
      if (custom) { const d = document.createElement('span'); d.innerHTML = this.figuresLine(custom.parts); overlay.append(d); return; }
      const detail = document.createElement('span');
      if (this.fitdays) {
        const row = this.fitdays.segments.find(item => item.id === groupKey);
        if (key === 'all') detail.textContent = 'Five colored regions · select a region to inspect its fat and muscle totals.';
        else if (row && key !== groupKey && segmentShare(key) !== null) { const f = segmentShare(key); detail.textContent = 'est. ' + bodyMass((row.fatMassLb + row.muscleBalanceMassLb) * f) + ' total · ' + bodyMass(row.fatMassLb * f) + ' fat · ' + bodyMass(row.muscleBalanceMassLb * f) + ' muscle · ' + Math.round(f * 100) + '% of the ' + row.label.toLowerCase() + ' (' + bodyMass(row.fatMassLb + row.muscleBalanceMassLb) + '), by typical segment mass'; }
        else if (row) detail.textContent = (key === groupKey ? 'Whole region' : row.label + ' total — not a separate ' + this.regions[key].toLowerCase() + ' measurement') + ': ' + bodyMass(row.fatMassLb + row.muscleBalanceMassLb) + ' total · ' + bodyMass(row.fatMassLb) + ' fat · ' + bodyMass(row.muscleBalanceMassLb) + ' muscle';
        else detail.textContent = 'No separate head / neck composition data in this report.';
        overlay.append(detail);
        const source = document.createElement('span'); source.className = 'body-overlay-source'; source.textContent = 'Fitdays estimates · ' + this.date(this.fitdays.measurementDate) + ' · segment fat inferred'; overlay.append(source);
        return;
      }
      const matches = (this.measurements.readings || []).filter(r => key === 'all' ? r.region === 'whole-body' : r.region === key || (key === 'abdomen' && r.region === 'waist'));
      if (matches.length) {
        const latest = new Map();
        for (const row of matches) if (!latest.has(row.metric) || row.recordedAt > latest.get(row.metric).recordedAt) latest.set(row.metric, row);
        detail.textContent = [...latest.values()].map(row => row.label + ': ' + bodyMeasurement(row) + ' · ' + row.recordedAt).join(' | ') + ' · Export reported';
      } else detail.textContent = key === 'all' ? 'Body measurements: not available' : 'Regional fat / muscle: not available';
      overlay.append(detail);
    }
  }

  escape(value) {
    const span = document.createElement('span'); span.textContent = String(value ?? ''); return span.innerHTML;
  }

  date(value, short) {
    return new Date(value + 'T12:00:00').toLocaleDateString('en-US', short ? {month:'short', day:'numeric'} : {month:'long', day:'numeric', year:'numeric'});
  }

  asset(name) {
    const value = this.stage || this.selected;
    return BODY_BASE + (this.stage ? 'stages/' + value.stageId : 'records/' + value.id) + '/' + name;
  }

  status(message, error = false) {
    const element = this.querySelector('.body-status');
    if (element) { element.textContent = message; element.classList.toggle('body-error', error); }
  }

  showPhoto(angle) {
    this.photo = angle;
    this.querySelectorAll('[data-body="photo"]').forEach(el => el.setAttribute('aria-pressed', el.dataset.photo === angle));
    this.querySelectorAll('[data-body="angle"]').forEach(el => { if (el.dataset.angle !== 'Reset view') el.setAttribute('aria-pressed', el.dataset.angle === angle); });
    const image = this.querySelector('.body-reference');
    if (image && image.alt !== angle + ' reference image') {
      image.src = this.asset(angle + '.png'); image.alt = angle + ' reference image';
      this.querySelector('.body-photo-link').href = image.src;
    }
  }

  showAngle(angle) {
    const name = angle === 'Reset view' ? 'Front' : angle;
    // Match the facing direction of the supplied Left.png and Right.png files.
    const theta = {Front: 0, Back: 180, Left: -90, Right: 90}[name];
    const viewer = this.querySelector('model-viewer');
    this.showPhoto(name);
    viewer.setAttribute('camera-orbit', theta + 'deg 90deg ' + this.rad(this.startPct));
    viewer.setAttribute('camera-target', 'auto auto auto');
    viewer.setAttribute('field-of-view', '30deg');
    this.zoomPct = this.startPct;
    this.syncZoomControls();
  }

  syncZoomControls() {
    this.querySelectorAll('[data-body="zoom"]').forEach(button => {
      const Z = this.frameR ? BODY_FRAME : BODY_ZOOM; button.disabled = Number(button.dataset.direction) < 0 ? this.zoomPct <= Z.min : this.zoomPct >= Z.max;
    });
  }

  zoomModel(direction) {
    const viewer = this.querySelector('model-viewer');
    if (!viewer || typeof viewer.getCameraOrbit !== 'function') return;
    const Z = this.frameR ? BODY_FRAME : BODY_ZOOM; this.zoomPct = Math.max(Z.min, Math.min(Z.max, (this.zoomPct ?? this.startPct) + direction * Z.step));
    const orbit = viewer.getCameraOrbit();
    const theta = Number.isFinite(orbit.theta) ? orbit.theta : 0, phi = Number.isFinite(orbit.phi) ? orbit.phi : 85 * Math.PI / 180;
    viewer.setAttribute('camera-orbit', theta + 'rad ' + phi + 'rad ' + this.rad(this.zoomPct));
    this.syncZoomControls();
  }

  render() {
    if (!this.escBound) { this.escBound = true; document.addEventListener('keydown', e => { const st = this.querySelector('.body-stage35'); if (e.key === 'Escape' && st && st.classList.contains('body-full')) { st.classList.remove('body-full'); if (this.fullListener) this.fullListener(); else { st.classList.remove('is-full'); const c = this.querySelector('.bc-card'); if (c) c.classList.remove('full'); } } }); }
    this.zoomPct = this.startPct;
    const record = this.stage || this.selected;
    const esc = value => this.escape(value);
    const icon = (body, label, extra, glyph, parity) => '<button type="button" class="body-ibtn" data-body="' + body + '"' + (extra || '') + (parity ? ' data-parity="' + parity + '"' : '') + ' aria-label="' + label + '" title="' + label + '">' + glyph + '</button>';
    // V3.5 (B1 to B3, B12 to B14): the model and the photo each take half of the stage at one height; the Body Composition
    // card is docked over the model's top-left corner; a slim icon strip on the model's edge; Front, Back, Left, Right at
    // the top; Whole Body, Parts, the region tool and Add Report along the bottom. Full screen is the stage alone.
    const weighIn = (window.HealthWholeBody || {}).weight, fd = this.fitdays, stale = !this.stage && fd && weighIn && weighIn.date && fd.measurementDate && fd.measurementDate < weighIn.date;
    const stageHTML = record ? '<div class="body-stage35" data-parity="V35-B1-01">' +
        '<div class="bs-model body-model-stage">' +
          '<model-viewer class="body-model" src="' + this.asset(!this.stage && Object.keys(this.regions).length ? 'regions.glb' : 'model.glb') + '" alt="Approximate body model. Drag to rotate; the wheel zooms within limits, then scrolls the page." camera-controls disable-zoom touch-action="pan-y" camera-orbit="0deg 90deg ' + this.startPct + '%" field-of-view="30deg" min-camera-orbit="auto auto ' + BODY_ZOOM.min + '%" max-camera-orbit="auto auto ' + BODY_ZOOM.max + '%" interaction-prompt="none" shadow-intensity="0.4" exposure="1"></model-viewer><span class="body-load" role="status">Loading 3D view…</span>' +
          (!this.stage ? this.selectionHTML() + '<div class="body-region-overlay" aria-live="polite" hidden></div>' : '') +
          '<div class="body-angles k-seg" role="group" aria-label="Model angle" data-parity="BODY-31">' + ['Front','Back','Left','Right'].map(name => '<button data-body="angle" data-angle="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div>' +
          '<div class="body-angle-controls bs-strip" aria-label="Model viewing controls" data-parity="V35-B1-02">' + icon('zoom', 'Zoom in', ' data-direction="-1"', bodyIcon(BODY_ICONS.zoomIn)) + icon('zoom', 'Zoom out', ' data-direction="1"', bodyIcon(BODY_ICONS.zoomOut)) + icon('angle', 'Reset view', ' data-angle="Reset view"', bodyIcon(BODY_ICONS.reset)) + icon('fullscreen', 'Full screen', ' aria-pressed="false"', bodyIcon(BODY_ICONS.expand), 'V35-B13-01') +
            (!this.stage ? '<button type="button" class="body-ibtn bs-add" data-body="addReport" data-parity="BODY-38" aria-label="Add a Fitdays report" title="Add a Fitdays report">' + bodyIcon(BODY_ICONS.report, 16) + '</button>' : '') +
            '<details class="body-help icon"><summary aria-label="About model controls" title="About model controls">ⓘ</summary><p class="hint">Drag to rotate. The wheel zooms inside its limits; at a limit, after a short pause, it scrolls the page. Front, Back, Left and Right turn the model and the photo together; Reset returns both to Front. Whole Body selects every part and Other; Parts picks any set (Cmd or Shift-click on the model adds one). Solid-colour model; skin is in the reference photos. ' + (record.variant === 'reconstructed-reference' ? 'Reconstructed reference: shape and hidden skin details may be estimated. ' : '') + 'This view does not measure body fat, muscle or circumferences.</p></details></div>' +
          (!this.stage ? this.regionHTML() : '') +
        '</div>' +
        '<div class="bs-photo body-photos" data-parity="BODY-34"><span class="body-photo-badge">Photo</span><a class="body-photo-link" href="' + this.asset(this.photo + '.png') + '" target="_blank" rel="noopener" title="Open full-size image" data-parity="V35-B14-01"><img class="body-reference" src="' + this.asset(this.photo + '.png') + '" alt="' + this.photo + ' reference image"></a><div class="body-photo-tabs" role="group" aria-label="Reference image" hidden>' + ['Front','Back','Left','Right'].map(name => '<button data-body="photo" data-photo="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div></div>' +
        '<button type="button" class="bs-exit" data-body="fullscreen" data-parity="V35-B13-02" aria-label="Exit full screen" title="Exit full screen (Esc)">' + bodyIcon(BODY_ICONS.shrink, 18) + '</button>' +
        (!this.stage ? '<div class="body-report-sheet" hidden></div>' : '') +
      '</div>' +
      '<div class="bs-foot">' + (stale ? '<p class="body-stale" data-parity="BODY-39">A newer weigh-in has no segment report yet</p>' : '') + '<p class="body-captured">Model captured ' + esc(this.date(record.captureDate, true)) + '</p></div>' +
      (!this.stage ? '<div class="body-tools">' + this.toolsHTML() + '</div>' : '') : '';
    this.innerHTML = '<section class="panelcard body-record-card" aria-label="Your body records">' +
      '<p class="body-status hint" role="status" aria-live="polite"></p>' +
      (record ? (this.stage ? '<div class="body-record-heading"><h3>' + esc(this.date(record.captureDate)) + '</h3><span class="chip quiet">Import preview · not saved</span></div><div class="body-review"><label>Reference type<select data-body="variant" aria-label="Reference type"><option value="reconstructed-reference">Reconstructed reference</option><option value="original-photo-reference">Original-photo reference</option></select></label><p class="hint">One model and four reference images checked. Review the date, views and reference type before saving.</p><div class="acts"><button class="primary" data-body="save">Save body record</button><button data-body="cancel">Cancel import</button></div></div>' : '') +
        stageHTML +
        (!this.stage ? '<details class="body-more"><summary>More · records, Fitdays detail, measurements, export</summary>' +
          '<div class="body-more-row"><span class="cap" data-parity="BODY-43">Private on this Mac</span><label class="filebtn body-import">Import body record<input type="file" accept=".zip,application/zip" aria-label="Import body record ZIP" data-body="file"></label>' +
          (this.records.length ? '<label class="body-record-label">Choose a dated view<select data-body="record" aria-label="Saved body record">' + this.records.map(r => '<option value="' + r.id + '"' + (r.id === this.selected?.id ? ' selected' : '') + '>' + esc(this.date(r.captureDate) + ' · ' + r.variantLabel) + '</option>').join('') + '</select></label>' : '') + '</div>' +
          '<div data-parity="BODY-40">' + this.compositionHTML() + '</div><div data-parity="BODY-42">' + this.measurementHTML() + '</div>' +
          '<div class="acts" data-parity="BODY-44"><a class="body-export" href="' + this.asset('export.zip') + '" download>Export model + four images</a></div><p class="hint body-limitation" data-parity="BODY-45">' + (record.variant === 'reconstructed-reference' ? 'Reconstructed reference: shape and hidden skin details may be estimated. ' : 'Original-photo references with an approximate generated model. ') + 'This view does not measure body fat, muscle or circumferences.</p></details>' : '')
      : '<div class="body-empty"><details class="body-help inline"><summary aria-label="About your body view">ⓘ</summary><p class="hint">Your 3D model, its four reference photos and your Fitdays reports stay on this Mac. Import the ZIP the body tool makes; you review it before it is saved.</p></details><h3>Keep a dated view of your body</h3><p>Import a ZIP containing your 3D model, its details and four reference images.</p><label class="filebtn body-import">Import body record<input type="file" accept=".zip,application/zip" aria-label="Import body record ZIP" data-body="file"></label></div>') + '</section>';
    // V3.5 K5: the page adds its one note control to each card; this card is drawn here, after the page's pass.
    this.dispatchEvent(new CustomEvent('bodyrender', {bubbles: true}));
    const viewer = this.querySelector('model-viewer');
    if (viewer) {
      viewer.addEventListener('load', () => { const label = this.querySelector('.body-load'); if (label) label.hidden = true; this.frameModel(); if (this.mode === 'select') this.highlight(this.sel ? 'sel' : 'all'); else this.refreshTools(); });
      viewer.addEventListener('camera-change', () => {
        const quarter = Math.round(viewer.getCameraOrbit().theta / (Math.PI / 2));
        const angle = ['Front', 'Right', 'Back', 'Left'][((quarter % 4) + 4) % 4];
        if (this.photo !== angle) this.showPhoto(angle);
      });
      this.showPhoto(this.photo);
      const img = this.querySelector('.body-reference'); if (img) { img.addEventListener('load', () => this.fitPhoto()); if (img.complete) this.fitPhoto(); }
      viewer.addEventListener('error', () => { const label = this.querySelector('.body-load'); if (label) label.textContent = 'The 3D view could not load. Your saved files are available through Export.'; });
      viewer.addEventListener('pointerdown', event => { this.pointerStart = [event.clientX, event.clientY]; });
      viewer.addEventListener('click', event => {
        if (!this.pointerStart || Math.hypot(event.clientX-this.pointerStart[0],event.clientY-this.pointerStart[1]) > 5) return;
        const material = viewer.materialFromPoint(event.clientX, event.clientY);
        if (!material || !this.regions[material.name]) return;
        if ((event.metaKey || event.ctrlKey || event.shiftKey) && this.mode !== 'compare') this.addToSelection(material.name); else this.pick(material.name);
      });
      this.wheelZoom(this.querySelector('.body-model-stage'));
      if (!this.resizeWatch && typeof ResizeObserver === 'function') { this.resizeWatch = new ResizeObserver(() => this.fitPhoto()); }
      const stage = this.querySelector('.body-stage35'); if (this.resizeWatch && stage) { this.resizeWatch.disconnect(); this.resizeWatch.observe(stage); }
    }
  }
  /* B1: frame the model so its height fills the box less BODY_MARGIN at the top and the bottom, level (90°), and make
     that the start and Reset zoom. model-viewer's 100% radius frames the whole bounding sphere; this scales it. */
  frameModel() {
    const v = this.querySelector('model-viewer'); if (!v || typeof v.getDimensions !== 'function') return;
    try {
      const d = v.getDimensions(), vfov = 30 * Math.PI / 180;   // field-of-view is vertical, in a portrait box too (measured)
      const need = (d.y / 2) / Math.tan(vfov / 2) / (1 - 2 * BODY_MARGIN) + d.z / 2; if (!(need > 0)) return;
      // The radius is set in metres: model-viewer's own 100% moves as it settles, so a percentage drifted. Zoom is a
      // percentage of this framed radius from here on (100 = head and feet at the margin).
      this.frameR = need; this.startPct = 100; this.zoomPct = 100;
      v.setAttribute('min-camera-orbit', 'auto auto ' + this.rad(BODY_FRAME.min)); v.setAttribute('max-camera-orbit', 'auto auto ' + this.rad(BODY_FRAME.max));
      const o = {Front: 0, Back: 180, Left: -90, Right: 90}[this.photo] || 0;
      v.cameraOrbit = o + 'deg 90deg ' + this.rad(100); v.cameraTarget = 'auto auto auto'; if (v.jumpCameraToGoal) v.jumpCameraToGoal();
      this.syncZoomControls();
    } catch (_) { /* the default framing stays */ }
  }
  zoomLimits() { const Z = this.frameR ? BODY_FRAME : BODY_ZOOM; return {min: Z.min, max: Z.max, step: Z.step, start: this.frameR ? 100 : BODY_ZOOM.start}; }
  rad(pct) { return this.frameR ? (this.frameR * pct / 100).toFixed(3) + 'm' : pct + '%'; }
  /* B1 and B14: the photo is cropped to the body plus the same margin, kept to its aspect ratio (never stretched), and
     centred in its half; the box takes the photo's own corner colour, so the picture meets the card's edge with no frame.
     The body's rows are the rows that differ from the corner colour. */
  fitPhoto() {
    const img = this.querySelector('.body-reference'), box = this.querySelector('.bs-photo'); if (!img || !box || !img.naturalWidth) return;
    let top = 0, bottom = img.naturalHeight, corner = null;
    try {
      const w = Math.min(240, img.naturalWidth), h = Math.round(img.naturalHeight * w / img.naturalWidth), c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(img, 0, 0, w, h); const px = g.getImageData(0, 0, w, h).data, at = (x, y) => (y * w + x) * 4;
      corner = [px[0], px[1], px[2]]; const far = (x, y) => { const i = at(x, y); return Math.abs(px[i] - corner[0]) + Math.abs(px[i + 1] - corner[1]) + Math.abs(px[i + 2] - corner[2]) > 60; };
      const rowHas = y => { let n = 0; for (let x = 0; x < w; x += 2) if (far(x, y)) n++; return n >= 2; };
      let t = 0; while (t < h && !rowHas(t)) t++; let b = h - 1; while (b > t && !rowHas(b)) b--;
      if (b - t > h * 0.2) { top = t * img.naturalHeight / h; bottom = (b + 1) * img.naturalHeight / h; }
    } catch (_) { /* a picture the canvas cannot read keeps its full frame */ }
    if (corner) { box.style.background = 'rgb(' + corner.join(',') + ')'; box.dataset.corner = corner.join(','); }
    const H = box.clientHeight, W = box.clientWidth; if (!H || !W) return;
    const scale = H * (1 - 2 * BODY_MARGIN) / Math.max(1, bottom - top), dh = img.naturalHeight * scale, dw = img.naturalWidth * scale;
    Object.assign(img.style, {position: 'absolute', height: dh + 'px', width: dw + 'px', maxWidth: 'none', left: ((W - dw) / 2) + 'px', top: (H * BODY_MARGIN - top * scale) + 'px', objectFit: 'fill'});
    box.dataset.bodyTop = String(Math.round(H * BODY_MARGIN)); box.dataset.bodyBottom = String(Math.round(H * (1 - BODY_MARGIN)));
  }
  /* V3.4 (B4): the wheel zooms inside the limits. At a limit it hands the wheel to the page, but only after the wheel has
     been quiet for 250 ms, so trackpad momentum from the zoom cannot throw the page (the kit's zoomWithHandoff). */
  wheelZoom(el) {
    if (!el) return; let last = 0, latched = false;
    el.addEventListener('wheel', event => {
      const now = performance.now(); if (now - last > 250) latched = false; last = now;
      const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, z = this.zoomPct ?? this.startPct, Z = this.frameR ? BODY_FRAME : BODY_ZOOM, atLimit = (z <= Z.min && dy < 0) || (z >= Z.max && dy > 0);
      if (!atLimit) { event.preventDefault(); latched = true; this.setZoom(z * Math.exp(dy * 0.0022)); }
      else if (latched) event.preventDefault();
    }, {passive: false});
  }
  setZoom(pct) {
    const viewer = this.querySelector('model-viewer'); if (!viewer || typeof viewer.getCameraOrbit !== 'function') return;
    const Z = this.frameR ? BODY_FRAME : BODY_ZOOM; this.zoomPct = Math.max(Z.min, Math.min(Z.max, pct));
    const orbit = viewer.getCameraOrbit(), theta = Number.isFinite(orbit.theta) ? orbit.theta : 0, phi = Number.isFinite(orbit.phi) ? orbit.phi : 85 * Math.PI / 180;
    viewer.setAttribute('camera-orbit', theta + 'rad ' + phi + 'rad ' + this.rad(this.zoomPct));
    this.syncZoomControls();
  }

  /* V3.4 (B6): Add Report. From File reads the report on this Mac (the wrapper's Vision reader) and shows every number on a
     confirm screen beside the picture, each editable; Type It is the short form, saved as self-entered. Both save through
     the body service with the measurement date. Without the wrapper's reader, a chosen file opens the same form beside
     its picture, empty. */
  reportFields() {
    return [['weight','Weight','lb'],['bmi','BMI',''],['bodyFatPercentage','Body fat','%'],['fatMass','Fat mass','lb'],['fatFreeWeight','Fat-free weight','lb'],['muscleMass','Muscle mass','lb']];
  }
  reportFormHTML(values, entry, picture) {
    const v = values || {wholeBody: {}, segments: []}, esc = x => this.escape(x), miss = new Set(v.missing || []), num = x => Number.isFinite(x) ? String(x) : '';
    const field = (name, label, value, unit, missing) => '<label class="rep-field' + (missing ? ' miss' : '') + '"><span>' + esc(label) + '</span><input type="number" step="0.1" min="0" inputmode="decimal" data-rep="' + name + '" value="' + esc(num(value)) + '"' + (missing ? ' aria-invalid="true"' : '') + '>' + (unit ? '<small>' + unit + '</small>' : '') + '</label>';
    const seg = id => (v.segments || []).find(s => s.id === id) || {};
    const whole = this.reportFields().map(([k, l, u]) => field('whole.' + k, l, (v.wholeBody[k] || {}).value, u, miss.has(k))).join('');
    const segs = Object.entries(FITDAYS_GROUPS).map(([id, g]) => '<div class="rep-seg"><b>' + esc(g.label) + '</b>' + field('seg.' + id + '.fat', 'Fat', seg(id).fatMassLb, 'lb', miss.has(id)) + field('seg.' + id + '.muscle', 'Muscle', seg(id).muscleBalanceMassLb, 'lb', miss.has(id)) + '</div>').join('');
    return '<div class="rep-form" data-entry="' + entry + '">' + (picture ? '<div class="rep-picture">' + picture + '</div>' : '') + '<div class="rep-fields">' +
      (entry === 'read' ? '<p class="hint">Read on this Mac. Check each number against the picture; ' + (miss.size ? 'the outlined ones were not found.' : 'every field was found.') + '</p>' : '<p class="hint">Typed reports are marked self-entered.</p>') +
      '<div class="rep-row"><label class="rep-field' + (miss.has('measurementDate') ? ' miss' : '') + '"><span>Measured on</span><input type="date" data-rep="date" value="' + esc(v.measurementDate || '') + '"></label><label class="rep-field"><span>Time</span><input type="time" data-rep="time" value="' + esc(v.measurementTime || '') + '"></label></div>' +
      '<div class="rep-grid">' + whole + '</div><p class="cap">Regions</p><div class="rep-segs">' + segs + '</div>' +
      '<p class="body-status hint rep-status" role="status"></p><div class="acts"><button class="primary save" data-body="reportSave">' + (entry === 'read' ? 'Confirm and save' : 'Save') + '</button><button data-body="reportClose">Cancel</button></div></div></div>';
  }
  openReport(tab) {
    const sheet = this.querySelector('.body-report-sheet'); if (!sheet) return;
    this.reportTab = tab || this.reportTab || 'file'; this.reportImage = null;
    sheet.hidden = false;
    sheet.innerHTML = '<div class="rep-head"><b>Add Report</b><div class="k-seg" role="group" aria-label="How to add the report">' + [['file','From File'],['type','Type It']].map(([k, l]) => '<button data-body="reportTab" data-tab="' + k + '" aria-pressed="' + (this.reportTab === k) + '">' + l + '</button>').join('') + '</div><button class="body-ibtn" data-body="reportClose" aria-label="Close">✕</button></div>' +
      (this.reportTab === 'file' ? '<label class="rep-drop" data-parity="BODY-REPORT-FILE"><input type="file" data-body="reportFile" accept="image/*,application/pdf" aria-label="Choose the Fitdays report (a picture or a PDF)"><span>Drop the Fitdays report here, or choose it</span><small>A picture or a PDF. It is read on this Mac; nothing leaves it.</small></label><div class="rep-confirm"></div>' : this.reportFormHTML(null, 'self-entered', ''));
    sheet.scrollIntoView({block: 'nearest'});
  }
  async readReportFile(file) {
    const sheet = this.querySelector('.body-report-sheet'), box = sheet && sheet.querySelector('.rep-confirm'); if (!box) return;
    if (file.size > 25 * 1024 * 1024) { box.innerHTML = '<p class="body-error hint">Choose a report under 25 MB.</p>'; return; }
    const bytes = new Uint8Array(await file.arrayBuffer()), base64 = toBase64(bytes.buffer), pdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
    this.reportImage = pdf ? null : base64;
    let picture = pdf ? '<div class="rep-pdf">PDF · ' + this.escape(file.name) + '</div>' : '<img alt="The report you chose" src="data:' + (file.type || 'image/png') + ';base64,' + base64 + '">';
    box.innerHTML = '<p class="hint">Reading the report on this Mac…</p>';
    let values = null;
    if (window.HealthNativeRequest && BODY_TRANSPORT) {
      try { const reply = await window.HealthNativeRequest('readReport', {base64}); if (reply && reply.ok && Array.isArray(reply.lines)) { values = parseFitdaysReport(reply.lines);
        /* V3.5 (B6): for a HEIC or an image-only PDF the wrapper sends back a JPEG of what it read; it is shown and saved */
        if (typeof reply.imageBase64 === 'string' && reply.imageBase64) { this.reportImage = reply.imageBase64; picture = '<img alt="The report you chose" src="data:image/jpeg;base64,' + reply.imageBase64 + '">'; } } } catch (_) { values = null; }
    }
    box.innerHTML = values ? this.reportFormHTML(values, 'read', picture) : '<p class="hint">This surface cannot read reports; type the numbers beside the picture.</p>' + this.reportFormHTML(null, 'self-entered', picture);
  }
  async saveReport() {
    const form = this.querySelector('.rep-form'); if (!form || !this.selected) return;
    const val = name => { const el = form.querySelector('[data-rep="' + name + '"]'); return el && el.value !== '' ? Number(el.value) : null; };
    const status = form.querySelector('.rep-status'), say = (t, bad) => { if (status) { status.textContent = t; status.classList.toggle('body-error', !!bad); } };
    const entry = form.dataset.entry, units = Object.fromEntries(this.reportFields().map(([k, , u]) => [k, u || null]));
    const payload = {entry, measurementDate: (form.querySelector('[data-rep="date"]') || {}).value || null, measurementTime: (form.querySelector('[data-rep="time"]') || {}).value || null,
      wholeBody: Object.fromEntries(this.reportFields().map(([k]) => [k, {value: val('whole.' + k), unit: units[k]}])),
      segments: Object.keys(FITDAYS_GROUPS).map(id => ({id, fatMassLb: val('seg.' + id + '.fat'), muscleBalanceMassLb: val('seg.' + id + '.muscle')}))};
    if (entry === 'read' && this.reportImage) payload.imageBase64 = this.reportImage;
    const empty = Object.entries(payload.wholeBody).filter(([, x]) => x.value === null).length + payload.segments.filter(s => s.fatMassLb === null || s.muscleBalanceMassLb === null).length;
    if (!payload.measurementDate || empty) { say('Fill in the date and every number first.', true); return; }
    this.busy = true; say('Saving…');
    try {
      await this.request('fitdays-entry/' + this.selected.id, payload);
      this.fitdays = await this.request('records/' + this.selected.id + '/fitdays.json'); this.region = 'all'; this.publishSnapshot(); this.render();
      this.status('Report from ' + this.date(payload.measurementDate) + ' saved' + (entry === 'self-entered' ? ' as self-entered.' : '.'));
    } catch (error) { say(error.message, true); }
    finally { this.busy = false; }
  }
  async changeAction(event) {
    const control = event.target;
    if (this.busy) return;
    if (control.dataset.body === 'record') {
      this.selected = this.records.find(record => record.id === control.value); this.photo = 'Front'; await this.loadRegionData(); this.render();
    }
    if (control.dataset.body === 'region') { this.pick(control.value); if (this.mode !== 'select') control.value = 'all'; }
    if (control.dataset.body === 'reportFile' && control.files.length) { await this.readReportFile(control.files[0]); return; }
    if (control.dataset.body === 'cmp') { this.compare[control.dataset.slot] = control.value || null; this.compare.next = control.dataset.slot === 'a' ? 'b' : 'a'; this.refreshTools(); }
    if (control.dataset.body === 'fitdays' && control.files.length) {
      this.busy = true; this.disable(true); this.status('Checking the Fitdays report and original image…');
      try {
        const result = await this.request('fitdays/' + this.selected.id, control.files[0]);
        this.fitdays = await this.request('records/'+this.selected.id+'/fitdays.json'); this.region = 'all'; this.photo = 'Front'; this.publishSnapshot(); this.render();
        this.status((result.duplicate ? 'Existing Fitdays report opened. ' : 'Fitdays report saved locally. ') + 'Measurement date: ' + this.date(this.fitdays.measurementDate) + '.');
      } catch (error) { this.status(error.message, true); }
      finally { this.busy = false; this.disable(false); }
      return;
    }
    if (control.dataset.body === 'measurements' && control.files.length) {
      this.busy = true; this.disable(true); this.status('Reading body-measurement fields…');
      try { this.measurements = await this.request('measurements/' + this.selected.id, control.files[0]); this.render(); this.status(this.measurements.readings.length ? 'Export-reported body measurements linked.' : 'Export checked: body fields are empty; no measurement values were added.'); }
      catch (error) { this.status(error.message, true); }
      finally { this.busy = false; this.disable(false); }
      return;
    }
    if (control.dataset.body !== 'file' || !control.files.length) return;
    const file = control.files[0];
    if (file.size > 64 * 1024 * 1024) { this.status('Choose a ZIP smaller than 64 MB.', true); control.value = ''; return; }
    this.busy = true; this.disable(true); this.status('Checking the model and four images…');
    try {
      if (this.stage) await this.request('cancel', {stageId: this.stage.stageId});
      this.stage = null;
      const stage = await this.request('stage', file);
      if (!this.isConnected) { await this.request('cancel', {stageId: stage.stageId}); return; }
      this.stage = stage; this.photo = 'Front'; this.render();
      this.querySelector('[data-body="save"]').focus();
    } catch (error) { this.status(error.message, true); }
    finally { this.busy = false; this.disable(false); control.value = ''; }
  }

  disable(value) { this.querySelectorAll('button,select,input').forEach(el => { el.disabled = value; }); }

  async clickAction(event) {
    const button = event.target.closest('[data-body]');
    if (!button || this.busy) return;
    const action = button.dataset.body;
    if (action === 'photo' || action === 'angle') {
      this.showAngle(action === 'photo' ? button.dataset.photo : button.dataset.angle);
    } else if (action === 'zoom') {
      this.zoomModel(Number(button.dataset.direction));
    } else if (action === 'fullscreen') {
      // V3.5 (B2, B13): full screen is the stage alone (the model and the photo, half each, the docked card and Add Report);
      // the controls are icon-only; Esc or the round exit button leaves it.
      const stage = this.querySelector('.body-stage35'), doc = document, active = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (!stage) return;
      if (active) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
      if (stage.classList.contains('body-full')) { stage.classList.remove('body-full'); this.fullListener?.(); return; }
      const viewer = this.querySelector('model-viewer'), orbit = viewer?.getCameraOrbit?.(); this.savedZoomPct = this.zoomPct;
      this.savedOrbit = orbit ? orbit.theta + 'rad ' + orbit.phi + 'rad ' + this.rad(this.savedZoomPct) : null;
      const go = stage.requestFullscreen || stage.webkitRequestFullscreen;
      if (go) { try { await go.call(stage); } catch (_) { stage.classList.add('body-full'); } } else stage.classList.add('body-full');
      if (!this.fullListener) {
        this.fullListener = () => {
          const st = this.querySelector('.body-stage35'), on = !!(document.fullscreenElement || document.webkitFullscreenElement) || !!(st && st.classList.contains('body-full'));
          if (st) st.classList.toggle('is-full', on);
          const b = this.querySelector('.bs-strip [data-body="fullscreen"]'); if (b) { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); b.title = on ? 'Exit full screen (Esc)' : 'Full screen'; b.innerHTML = bodyIcon(on ? BODY_ICONS.shrink : BODY_ICONS.expand); }
          const card = this.querySelector('.bc-card'); if (card) card.classList.toggle('full', on);
          this.fitPhoto(); this.frameModel();
          if (!on) { const v = this.querySelector('model-viewer'); if (v && this.savedOrbit) { v.cameraOrbit = this.savedOrbit; this.zoomPct = this.savedZoomPct; this.syncZoomControls(); } this.highlight(this.sel ? 'sel' : 'all'); }
        };
        document.addEventListener('fullscreenchange', this.fullListener); document.addEventListener('webkitfullscreenchange', this.fullListener);
        this.keyListener = e => { const st = this.querySelector('.body-stage35'); if (e.key === 'Escape' && st && st.classList.contains('body-full')) { st.classList.remove('body-full'); this.fullListener(); } };
        document.addEventListener('keydown', this.keyListener);
      }
      this.fullListener();
    } else if (action === 'mode') {
      this.mode = button.dataset.mode; if (this.mode === 'select' && this.region.startsWith('custom:') && !this.saved.some(r => 'custom:' + r.id === this.region)) this.region = 'all'; this.refreshTools();
    } else if (action === 'unlink') { this.linked.delete(button.dataset.part); this.refreshTools();
    } else if (action === 'clearLink') { this.linked.clear(); this.refreshTools();
    } else if (action === 'saveRegion') {
      const parts = [...this.linked]; if (!parts.length) return;
      const typed = (this.querySelector('[data-body="regionName"]')?.value || '').trim(), name = typed || regionAutoName(parts, this.regions);
      this.saved = this.saved.filter(r => r.name !== name).concat({id: Date.now().toString(36), name, parts}); this.saveRegions();
      this.linked.clear(); this.mode = 'select'; this.region = 'custom:' + this.saved[this.saved.length - 1].id; this.render(); this.status('Saved “' + name + '” as a region on this Mac.');
    } else if (action === 'loadRegion') { const r = this.saved.find(x => x.id === button.dataset.id); if (r) { this.linked = new Set(r.parts); this.refreshTools(); }
    } else if (action === 'removeRegion') { this.saved = this.saved.filter(x => x.id !== button.dataset.id); this.saveRegions(); if (this.region === 'custom:' + button.dataset.id) this.region = 'all'; this.refreshTools();
    } else if (action === 'cmpSwap') { const t = this.compare.a; this.compare.a = this.compare.b; this.compare.b = t; this.refreshTools();
    } else if (action === 'composition-region' || action === 'chip') {
      const key = button.dataset.region; if (key === 'all' && this.mode === 'compare' && button.classList.contains('all')) { this.pick('all'); this.refreshSide(); return; }   // V3.5 B11: Compare A or B may be Whole Body
      if (key === 'all') { if (this.mode !== 'select') { this.mode = 'select'; this.linked.clear(); } this.region = 'all'; this.refreshTools(); return; }
      if ((event.metaKey || event.ctrlKey || event.shiftKey) && this.mode !== 'compare' && this.regions[key]) this.addToSelection(key); else this.pick(key);
      this.refreshSide();
    } else if (action === 'addReport') {
      this.openReport();
    } else if (action === 'reportTab') {
      this.openReport(button.dataset.tab);
    } else if (action === 'reportClose') {
      const sheet = this.querySelector('.body-report-sheet'); if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
    } else if (action === 'reportSave') {
      await this.saveReport();
    } else if (action === 'cancel' || action === 'save') {
      const variant = this.querySelector('[data-body="variant"]')?.value;
      this.busy = true; this.disable(true);
      try {
        if (action === 'cancel') {
          await this.request('cancel', {stageId: this.stage.stageId}); this.stage = null; this.render(); this.status('Import cancelled. Existing records are unchanged.');
        } else {
          const result = await this.request('commit', {stageId: this.stage.stageId, variant});
          this.stage = null; await this.load(result.record.id);
          this.status(result.duplicate ? 'This body record was already saved. Opened the existing record.' : 'Body record saved on this Mac.');
        }
      } catch (error) { this.status(error.message, true); }
      finally { this.busy = false; this.disable(false); }
    }
  }
}
customElements.define('ht-body-view', HealthBodyView);
