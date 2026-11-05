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
  let reply = await window.HealthNativeRequest('bodyFetch', {path, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, base64});
  /* Fix B5: the body service on this Mac may still be starting when the first request lands ("The network connection was lost"); one retry before the page says anything */
  if (!reply.ok && /connection was lost|could not connect|did not finish/i.test(String(reply.error || ''))) { await new Promise(r => setTimeout(r, 1500)); reply = await window.HealthNativeRequest('bodyFetch', {path, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, base64}); }
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
/* Fix B2 (Mintay, Oct 6: "no manual typing of numbers that are on the picture"): the rest of the table a Fitdays report prints. They are read when
   present and never required; the confirm screen shows what was read and a report without them still saves. */
const REPORT_EXTRA = [['boneMass', /^bone\s*mass/i, 'lb'], ['proteinMass', /^protein\s*mass/i, 'lb'], ['waterWeight', /^water\s*weight/i, 'lb'], ['idealBodyWeight', /^ideal\s*body\s*weight/i, 'lb'],
  ['muscleRate', /^muscle\s*rate/i, '%'], ['skeletalMuscle', /^skeletal\s*muscle/i, '%'], ['protein', /^protein(?!\s*mass)\b/i, '%'], ['bodyWater', /^body\s*water/i, '%'], ['subcutaneousFat', /^subcutaneous/i, '%'],
  ['visceralFat', /^visceral/i, null], ['bmr', /^bmr\b/i, 'kcal'], ['bodyAge', /^body\s*age/i, null], ['whr', /^whr\b/i, null]];
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
  const any = !clock && t.match(/\b(\d{1,2}):(\d{2})\b/);   // Fitdays prints "21:06 Oct.05,2026": the time comes first
  return {date: year + '-' + String(mi + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0'), time: clock ? reportClock(clock[1], clock[2], clock[3]) : any ? reportClock(any[1], any[2]) : null};
}
function parseFitdaysReport(lines) {
  const items = (lines || []).filter(l => l && typeof l.text === 'string').map(l => ({text: l.text.trim(), x: +l.x || 0, y: +l.y || 0, w: +l.w || 0, h: +l.h || 0})).filter(l => l.text).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const l of items) { const row = rows.find(r => Math.abs(r.y - l.y) < 0.012); if (row) row.items.push(l); else rows.push({y: l.y, items: [l]}); }
  const texts = rows.map(r => r.items.slice().sort((a, b) => a.x - b.x).map(i => i.text).join('  ').trim());
  const nums = t => [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(lb|lbs|kg|%)?/gi)].map(m => ({v: parseFloat(m[1].replace(',', '.')), unit: (m[2] || '').toLowerCase()}));
  const toLb = n => n.unit === 'kg' ? Math.round(n.v / .45359237 * 10) / 10 : n.v;
  const out = {measurementDate: null, measurementTime: null, wholeBody: {}, extras: {}, segments: [], missing: []};
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
  for (const l of items) {
    const extra = REPORT_EXTRA.find(([k, re]) => re.test(l.text) && !out.extras[k]); if (!extra) continue;
    let v = valueOf(l.text.replace(extra[1], ''), extra[2] === 'lb' ? 'lb' : null);
    if (v === null) { const right = items.filter(o => o !== l && o.x > l.x && sameRow(o, l) && isValue(o)).sort((a, b) => a.x - b.x)[0]; if (right) v = valueOf(right.text, extra[2] === 'lb' ? 'lb' : null); }
    if (v !== null) out.extras[extra[0]] = {value: v, unit: extra[2]};
  }
  /* Fix K1: the report's own status word beside each figure (High, Too High, Excellent...), the two verdict lines and the weight-control block */
  const STATUS_WORD = /^(too\s*high|high|too\s*low|low|excellent|standard|normal|good|insufficient|healthy)$/i, onRow = l => items.filter(o => o !== l && sameRow(o, l));
  out.statuses = {}; out.labels = {}; out.control = {};
  for (const l of items) {
    const key = (REPORT_WHOLE.find(([, re]) => re.test(l.text)) || REPORT_EXTRA.find(([, re]) => re.test(l.text)) || [])[0]; if (!key || out.statuses[key]) continue;
    const word = onRow(l).filter(o => o.x > 0.6 && STATUS_WORD.test(o.text.trim())).sort((a, b) => a.x - b.x)[0]; if (word) out.statuses[key] = word.text.trim().replace(/\s+/g, ' ');
  }
  const rightText = l => { const r = onRow(l).filter(o => o.x > l.x + 0.1).sort((a, b) => b.x - a.x)[0]; return r ? r.text.trim() : null; };
  for (const [key, re] of [['obesityLevel', /^obesity\s*level$/i], ['bodyType', /^body\s*type$/i]]) { const l = items.find(o => re.test(o.text.trim())); const v = l && rightText(l); if (v && v.length <= 40) out.labels[key] = v; }
  const signed = (l, r) => { if (!r) return null; const m = reportMasses(r.text); const v = m.length ? m[0].v : (nums(r.text)[0] || {}).v; return Number.isFinite(v) ? (/^[\s•]*[-–−]/.test(r.text) ? -v : v) : null; };
  for (const [key, re] of [['targetWeight', /^recommended\s*target\s*weight/i], ['weight', /^[•\s]*weight\s*control/i], ['fat', /^[•\s]*fat\s*control/i], ['muscle', /^[•\s]*muscle\s*control/i]]) {
    const l = items.filter(o => re.test(o.text.trim())).find(o => onRow(o).some(x => x.x > o.x + 0.2)); if (!l) continue;
    const val = signed(l, onRow(l).filter(o => o.x > l.x + 0.2).sort((a, b) => b.x - a.x)[0]); if (val !== null) out.control[key] = val;
  }
  /* the segment blocks, by position */
  const heads = items.map(l => ({l, kind: (REPORT_BLOCKS.find(([, re]) => re.test(l.text)) || [])[0]})).filter(h => h.kind);
  const at = (l, i, n) => l.x + (l.w || 0) * ((i + n / 2) / Math.max(1, l.text.length));
  const status = /^(standard|normal|high|low|over|under|excellent|insufficient|healthy|fat|muscle)$/i;
  for (const head of heads) {
    const H = head.l, sib = heads.filter(o => sameRow(o.l, H) || Math.abs(o.l.y - H.y) < 0.02).map(o => o.l).sort((a, b) => a.x - b.x), k = sib.indexOf(H);
    const x0 = k > 0 ? sib[k].x - 0.02 : 0, x1 = k < sib.length - 1 ? sib[k + 1].x - 0.02 : 1;
    const inCol = l => l.x < x1 && l.x + (l.w || 0) > x0;
    const note = l => /\brange\b|\(\s*\d+\s*%\s*[-–]\s*\d+\s*%\s*\)|inferred/i.test(l.text);   // "Standard range: 80%-160%" sits right under the head and is not the end of the block
    const below = items.filter(l => l.y > H.y + (H.h || 0.01) * 0.5 && inCol(l) && !note(l));
    const stop = below.find(l => heads.some(o => o.l === l) || (/[a-z]{5,}/i.test(l.text) && !l.text.split(/\s+/).every(w => status.test(w) || !/[a-z]{5,}/i.test(w))));   // five letters: a title ends the block, a misread "Hiah" under a figure does not
    const yEnd = stop ? stop.y : Infinity, inside = below.filter(l => l.y < yEnd);
    const tokens = [], markers = [];
    for (const l of inside) {
      for (const m of reportMasses(l.text)) { const x = at(l, m.index, m.length); if (x >= x0 && x < x1) tokens.push({v: m.v, x, y: l.y, h: l.h}); }
      let pos = 0; for (const word of l.text.split(/\s+/)) { const i = l.text.indexOf(word, pos); pos = i + word.length; const bare = word.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''), side = /^(L|left)$/i.test(bare) ? 'left' : /^(R|right)$/i.test(bare) ? 'right' : null; if (side && (bare.length > 1 || bare === bare.toUpperCase())) markers.push({side, x: at(l, i, word.length)}); }
    }
    if (tokens.length < 2) continue;
    const xs = tokens.map(t => t.x), cx = (Math.min(...xs) + Math.max(...xs)) / 2, spread = Math.max(...xs) - Math.min(...xs) || 1;
    const lines2 = []; for (const t of tokens.sort((a, b) => a.y - b.y)) { const r = lines2.find(r => Math.abs(r.y - t.y) < (t.h ? 0.6 * t.h : 0.008)); if (r) r.t.push(t); else lines2.push({y: t.y, t: [t]}); }
    const sideOf = t => { const L = markers.filter(m => m.side === 'left'), R = markers.filter(m => m.side === 'right'); const d = ms => ms.length ? Math.min(...ms.map(m => Math.abs(m.x - t.x))) : Infinity;
      if (L.length && R.length) return d(L) <= d(R) ? 'left' : 'right';
      if (L.length || R.length) { const m = (L[0] || R[0]), ms = L.length ? 'left' : 'right'; return (t.x < cx) === (m.x < cx) ? ms : ms === 'left' ? 'right' : 'left'; }   // one marker survived the read: it names the side of the figure it stands on
      return t.x < cx ? 'right' : 'left'; };
    const put = (part, t) => { const s = segment(part); const f = head.kind === 'fat' ? 'fatMassLb' : 'muscleBalanceMassLb'; if (s[f] === null) s[f] = t.v; };
    const limbs = (row, limb, rest) => { const r = row.t.slice().sort((a, b) => a.x - b.x);
      if (r.length >= 2) { const a = r[0], b = r[r.length - 1], sa = sideOf(a), sb = sideOf(b); rest.push(...r.slice(1, -1)); if (sa !== sb) { put(sa + '-' + limb, a); put(sb + '-' + limb, b); } return; }
      if (Math.abs(r[0].x - cx) < 0.2 * spread) rest.push(r[0]); else put(sideOf(r[0]) + '-' + limb, r[0]); };
    const middle = [];
    if (lines2.length >= 2) { limbs(lines2[0], 'arm', middle); limbs(lines2[lines2.length - 1], 'leg', middle); }
    for (const r of lines2.slice(1, -1)) middle.push(...r.t);
    const trunk = middle.sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx))[0]; if (trunk) put('trunk', trunk);
  }
  /* Fix U1: each region's percent of standard (printed under its pounds) and the report's own standard ranges (printed under the block heads) */
  const pctItems = items.filter(l => /^\d+(?:\.\d+)?\s*%$/.test(l.text.trim()));
  out.segmentRanges = {}; out.segmentPct = {};
  for (const l of items){
    const t = l.text.replace(/\s+/g, ' '), rng = re => { const m = re.exec(t); return m ? [+m[m.length - 2], +m[m.length - 1]] : null; };
    const fat = /standard range:?\s*(\d+)\s*%\s*[-–]\s*(\d+)\s*%\s*$/i.exec(t); if (fat && !/limbs/i.test(t) && !out.segmentRanges.fat) out.segmentRanges.fat = [+fat[1], +fat[2]];
    const limb = /upper limbs\s*\((\d+)\s*%\s*[-–]\s*(\d+)\s*%\)/i.exec(t); if (limb) out.segmentRanges.muscleLimb = [+limb[1], +limb[2]];
    const core = /(?:trunk|lower limbs)[^()]*\((\d+)\s*%\s*[-–]\s*(\d+)\s*%\)/i.exec(t); if (core) out.segmentRanges.muscleCore = [+core[1], +core[2]];
  }
  for (const head of heads){
    const H = head.l, sib = heads.filter(o => sameRow(o.l, H) || Math.abs(o.l.y - H.y) < 0.02).map(o => o.l).sort((a, b) => a.x - b.x), k = sib.indexOf(H), x0 = k > 0 ? sib[k].x - 0.02 : 0, x1 = k < sib.length - 1 ? sib[k + 1].x - 0.02 : 1;
    const next = heads.filter(o => o.l.y > H.y + 0.02).sort((a, b) => a.l.y - b.l.y)[0], yEnd = next ? next.l.y : 1, field = head.kind === 'fat' ? 'fatComparisonPercent' : 'muscleComparisonPercent';
    for (const seg of out.segments){
      const v = seg[head.kind === 'fat' ? 'fatMassLb' : 'muscleBalanceMassLb']; if (v === null || v === undefined) continue;
      const tok = items.filter(l => l.y > H.y && l.y < yEnd && l.x < x1 && l.x + (l.w || 0) > x0 && reportMasses(l.text).some(m => Math.abs(m.v - v) < 0.051));
      tok.sort((a, b) => a.x - b.x); if (tok.length > 1) { const pick = /^left/.test(seg.id) ? tok[0] : /^right/.test(seg.id) ? tok[tok.length - 1] : tok[0]; tok.length = 0; tok.push(pick); }   // two regions with the same pounds: the left one is the figure's left side, as the pounds were assigned
      for (const t of tok){ const tx = t.x + (t.w || 0) / 2, cand = pctItems.filter(q => q.y >= t.y - 0.012 && q.y <= t.y + 0.06 && Math.abs(q.x + (q.w || 0) / 2 - tx) < 0.1).sort((a, b) => Math.abs(a.y - t.y) - Math.abs(b.y - t.y))[0]; if (cand && seg[field] === undefined){ seg[field] = parseFloat(cand.text); break; } }
    }
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
const BC_KEY = 'health-tracker.bcCard', BC_EDGE = 8, BC_CLICK = 4, BC_CLEAR = {right: 50, bottom: 46};   // round 2: where the Body Composition card sits; clear of the icon column (32 px at 10) and the bottom strip (28 px at 8)
const BC_TONE = {better: 'var(--c-violet,#b394ff)', average: 'var(--c-green,#79d6a9)', poor: 'var(--c-orange,#f0a058)', none: '#ffffff'};
const bodyIcon = (d, size) => '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
const BODY_ICONS = {zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6M11 8v6"/>', zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4M8 11h6"/>', reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', report: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M12 11v6M9 14h6"/>', down: '<path d="M6 9l6 6 6-6"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>', camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'};
/* V6.1.7 (his Nov 4 words: "an import thing for the 3D visual and Import thing for the side image"): the page builds the one ZIP the body
   service already accepts, model.glb, manifest.json and the four PNGs, stored without compression, so a .glb alone or one photo saves
   through the same stage, review and commit as before. The Mac's own body service is not changed (it ships inside the app bundle). */
const BODY_SIDES = ['Front', 'Back', 'Left', 'Right'];
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zipStored(entries) {
  const enc = new TextEncoder(), local = [], central = [], now = new Date(); let offset = 0;
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), day = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const [name, data] of entries) {
    const n = enc.encode(name), crc = crc32(data), h = new DataView(new ArrayBuffer(30)), d = new DataView(new ArrayBuffer(46));
    [[0, 0x04034b50, 4], [4, 20, 2], [10, time, 2], [12, day, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, n.length, 2]].forEach(([at, v, w]) => w === 4 ? h.setUint32(at, v, true) : h.setUint16(at, v, true));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [12, time, 2], [14, day, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, n.length, 2], [42, offset, 4]].forEach(([at, v, w]) => w === 4 ? d.setUint32(at, v, true) : d.setUint16(at, v, true));
    local.push(new Uint8Array(h.buffer), n, data); central.push(new Uint8Array(d.buffer), n); offset += 30 + n.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, size, true); e.setUint32(16, offset, true);
  return new Blob([...local, ...central, new Uint8Array(e.buffer)], {type: 'application/zip'});
}
/* The old ZIPs: the body tool's (model.glb and manifest.json only) or a full record. Only the six known names are read, by their last path
   part; a deflated member is opened with the browser's own DecompressionStream. */
async function unzipBody(buffer) {
  const v = new DataView(buffer), u8 = new Uint8Array(buffer), dec = new TextDecoder(), out = {}, want = new Set(['model.glb', 'manifest.json', ...BODY_SIDES.map(s => s + '.png')]);
  let end = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('That file is not a ZIP the body view can open.');
  for (let k = 0, p = v.getUint32(end + 16, true), count = v.getUint16(end + 10, true); k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('That ZIP is damaged.');
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true), at = v.getUint32(p + 42, true), name = dec.decode(u8.subarray(p + 46, p + 46 + nlen)), base = name.split('/').pop();
    p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (!want.has(base) || name.startsWith('__MACOSX/')) continue;
    const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true), raw = u8.subarray(start, start + size);
    if (method === 0) out[base] = raw.slice();
    else if (method === 8 && typeof DecompressionStream === 'function') out[base] = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('That ZIP is packed in a way this page cannot open.');
  }
  return out;
}
async function sha256Hex(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join(''); }
const canvasPNG = c => new Promise((ok, bad) => c.toBlob(b => b ? b.arrayBuffer().then(a => ok(new Uint8Array(a)), bad) : bad(new Error('The photo could not be turned into a PNG.')), 'image/png'));
/* The service takes PNGs: a PNG is kept as it is, a JPEG or HEIC is redrawn as one (at most 4,000 px on its long side). */
async function photoPNG(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return new Uint8Array(await file.arrayBuffer());
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('That photo could not be opened. Choose a PNG, JPEG or HEIC picture.')); i.src = url; });
    const k = Math.min(1, 4000 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return await canvasPNG(c);
  } finally { URL.revokeObjectURL(url); }
}
function placeholderPNG() { const c = document.createElement('canvas'); c.width = 480; c.height = 960; const g = c.getContext('2d'); g.fillStyle = '#e9ebea'; g.fillRect(0, 0, c.width, c.height); return canvasPNG(c); }
const localYmd = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const reportStamp = r => (r.measurementDate || '') + ' ' + (r.measurementTime || '');
/* V6.1.7: the progress table's rows. [name, figure of a report, unit, the better way] */
const fdWhole = k => r => (r.wholeBody && r.wholeBody[k] || {}).value, fdExtra = k => r => (r.extras && r.extras[k] || {}).value, fdSeg = (id, k) => r => ((r.segments || []).find(x => x.id === id) || {})[k];
const FD_ROWS = [['Weight', fdWhole('weight'), 'lb', null], ['Body fat', fdWhole('bodyFatPercentage'), '%', 'down'], ['Fat mass', fdWhole('fatMass'), 'lb', 'down'], ['Muscle mass', fdWhole('muscleMass'), 'lb', 'up'],
  ['Fat-free weight', fdWhole('fatFreeWeight'), 'lb', 'up'], ['Skeletal muscle', fdExtra('skeletalMuscle'), '%', 'up'], ['Muscle rate', fdExtra('muscleRate'), '%', 'up'], ['BMR', fdExtra('bmr'), 'kcal', 'up'], ['Body age', fdExtra('bodyAge'), '', 'down'],
  ['BMI', fdWhole('bmi'), '', 'down'], ['Visceral fat', fdExtra('visceralFat'), '', 'down'], ['Subcutaneous fat', fdExtra('subcutaneousFat'), '%', 'down'], ['Bone mass', fdExtra('boneMass'), 'lb', null], ['Protein', fdExtra('protein'), '%', 'up'],
  ['Protein mass', fdExtra('proteinMass'), 'lb', 'up'], ['Body water', fdExtra('bodyWater'), '%', null], ['Water weight', fdExtra('waterWeight'), 'lb', null], ['WHR', fdExtra('whr'), '', 'down']];
const FD_REGION_ROWS = Object.entries(FITDAYS_GROUPS).flatMap(([id, g]) => [[g.label + ' fat', fdSeg(id, 'fatMassLb'), 'lb', 'down'], [g.label + ' muscle', fdSeg(id, 'muscleBalanceMassLb'), 'lb', 'up']]);
const FD_TONE = {good: 'var(--c-green,#79d6a9)', bad: 'var(--c-red,#ee7a6a)', flat: 'var(--muted,#bdb8a9)'};
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
    this.fitdays = null; this.fitdaysHome = null; this.reports = [];
    this.mode = 'select'; this.linked = new Set(); this.compare = {a: null, b: null, next: 'a'}; this.sel = null; this.startPct = BODY_ZOOM.start;   // sel null = Whole Body (V3.5 B11)
    this.saved = []; try { this.saved = JSON.parse(localStorage.getItem('glow-body-regions') || '[]'); } catch (_) { this.saved = []; }
    if (!Array.isArray(this.saved)) this.saved = [];
    if (!BODY_AVAILABLE) { this.unavailable(); return; }
    this.innerHTML = '<p class="hint">Opening your body records…</p>';
    if (BODY_BRIDGE) this.bridgeAssets();
    this.addEventListener('click', event => this.clickAction(event));
    this.addEventListener('change', event => this.changeAction(event));
    this.addEventListener('pointerdown', event => this.bcDrag(event));
    this.addEventListener('keydown', event => { if (event.target.closest && event.target.closest('.bc-title') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); this.bcFold(); } });
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
    if (response.ok && text.trim() === 'null' && /fitdays\.json$/.test(action)) return null;   // V6.1.7: the service's answer for a record with no report yet
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
    this.regions = {}; this.region = 'all'; this.measurements = {readings: []}; this.fitdays = null; this.fitdaysHome = null; this.reports = [];
    if (!this.selected) return;
    const base = 'records/' + this.selected.id + '/';
    try { this.regions = (await this.request(base + 'region-map.json')).regions; } catch (_) { /* Original model remains available when automatic region assignment is unsupported. */ }
    this.measurements = await this.request(base + 'measurements.json');
    await this.loadFitdays();
    this.publishSnapshot();
  }

  /* V6.1.7 (his Nov 4 ask: "show me how my body is progressing"): the Fitdays reports are his body's, not one model's. A report is saved
     with the dated record that was open (fitdays/<id>), so a new model or photo makes a record without one. Read only, nothing is copied:
     every record's reports are gathered for the progress table; a record with no report of its own shows the newest one any record holds,
     and the earlier reports join its trend. A record with its own report (his Sep 21 one) shows it exactly as before. */
  async loadFitdays() {
    const own = this.selected ? await this.request('records/' + this.selected.id + '/fitdays.json') : null, seen = new Map(), full = [];
    const add = (r, home) => { if (!r || !r.measurementDate || !r.wholeBody) return; const w = r.wholeBody.weight, key = reportStamp(r) + ' ' + (w && w.value); if (!seen.has(key)) seen.set(key, Object.assign({}, r, {home})); };
    for (const rec of this.records) {
      let r = rec.id === (this.selected && this.selected.id) ? own : null;
      if (r === null && rec.id !== (this.selected && this.selected.id)) { try { r = await this.request('records/' + rec.id + '/fitdays.json'); } catch (_) { r = null; } }
      if (!r) continue; full.push({home: rec.id, report: r}); add(r, rec.id); for (const h of r.history || []) add(h, rec.id);
    }
    this.reports = [...seen.values()].sort((a, b) => reportStamp(b).localeCompare(reportStamp(a)));
    const newest = full.sort((a, b) => reportStamp(b.report).localeCompare(reportStamp(a.report)))[0];
    this.fitdays = own || (newest ? newest.report : null); this.fitdaysHome = own ? this.selected.id : newest ? newest.home : null;
    if (!this.fitdays || full.length < 2) return;
    const cur = reportStamp(this.fitdays), have = new Set((this.fitdays.history || []).map(reportStamp)), older = this.reports.filter(r => reportStamp(r) < cur);
    this.fitdays.history = (this.fitdays.history || []).concat(older.filter(r => !have.has(reportStamp(r))).map(r => ({measurementDate: r.measurementDate, measurementTime: r.measurementTime, wholeBody: r.wholeBody, extras: r.extras || {}, segments: r.segments || []}))).sort((a, b) => reportStamp(a).localeCompare(reportStamp(b)));
    if (!this.fitdays.previous && older.length) this.fitdays.previous = older[0];
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
        // Fix Z1: the report's other figures (bone, water, protein...) and its words travel too, so Data and every page read the one report
        extras: this.fitdays.extras || null, statuses: this.fitdays.statuses || null, labels: this.fitdays.labels || null, control: this.fitdays.control || null,
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
  /* Fix B1 (Mintay, Oct 6: Other 26.2 + Fat 73.7 + "Muscle" 122.9 = 222.8 under Total 196.6): the whole body is the report's own three
     parts, which add up to its weight: Fat mass, Muscle mass and Bone (or what is left, as Other). Fat-free weight is not Muscle: it also holds
     bone, water and organs. A report without whole-body fat and muscle mass keeps the older figures. */
  wholeReport() {
    const r = this.fitdays, w = r && r.wholeBody; if (!w) return null;
    const val = k => w[k] && Number.isFinite(w[k].value) ? w[k].value : null, weight = val('weight'), fat = val('fatMass'), muscle = val('muscleMass'), bone = r.extras && r.extras.boneMass && Number.isFinite(r.extras.boneMass.value) ? r.extras.boneMass.value : null;
    if (weight === null || fat === null || muscle === null) return null;
    const rest = weight - fat - muscle - (bone || 0);
    return {weight, fat, muscle, bone, other: Math.abs(rest) >= 0.5 ? rest : 0, date: r.measurementDate};
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
    const head = '<div class="bc-head" title="Drag to move · click to fold or open"><span class="bc-title" role="button" tabindex="0" aria-expanded="true">Body Composition</span><details class="bc-info"><summary aria-label="About Body Composition" title="About Body Composition">ⓘ</summary><div class="bc-pop">' +
      '<p class="bc-legt">Compared with men your age and height</p><p><i style="background:' + BC_TONE.better + '"></i>Better than average</p><p><i style="background:' + BC_TONE.average + '"></i>Average</p><p><i style="background:' + BC_TONE.poor + '"></i>Not good</p>' +
      (f.total !== null && W ? '<p class="bc-sub">Selected ' + parts.filter(k => k !== 'head').length + ' of ' + this.allKeys().filter(k => k !== 'head').length + ' · ' + u.lb(f.total).toFixed(1) + ' of ' + u.lb(W.weight).toFixed(1) + ' ' + u.mass + (f.eq ? ' ✓' : '') + '</p>' : '') +
      (W ? '<p class="bc-sub">Whole Body: ' + esc(W.source) + ', ' + esc(this.date(W.date, true)) + '. Segments: Fitdays, ' + (report && report.measurementDate ? esc(this.date(report.measurementDate, true)) : 'no report yet') + (report && W.date && report.measurementDate && report.measurementDate !== W.date ? ' (different dates)' : '') + '.</p>' : '') +
      '<p class="bc-sub">Muscle is everything that is not fat (lean mass: water, organs and bone included). Other is head and neck, bone and what the report’s five regions leave over, from your latest weigh-in, so every part plus Other adds up to your weight. A part of a limb or of the trunk is its typical share of that region (est.).</p>' + this.reconciliationHTML() + '</div></details></div>';
    if (f.total === null) return '<section class="bc-card" data-parity="V35-B10-01" aria-label="Body Composition">' + head + '<b class="bc-name">' + esc(name) + '</b><span class="body-na">' + (W || report ? 'Not available at this segmentation' : 'No weigh-in yet.') + '</span></section>';
    const wr0 = whole ? this.wholeReport() : null;
    /* V6 line 11 (his overnight yes): Whole Body totals the weigh-in (Apple Health), not the report's own weight; Fat and Muscle stay the report's and
       Other is what the weigh-in leaves over, so the rows still add up (his Oct 6 rule, Fix B1). A weigh-in lighter than the report's fat and muscle
       keeps the report's own figures rather than show a negative Other. */
    const onW = wr0 && W && W.source !== 'Fitdays' && W.weight - wr0.fat - wr0.muscle >= 0 ? {weight:W.weight, fat:wr0.fat, muscle:wr0.muscle, bone:null, other:W.weight - wr0.fat - wr0.muscle, date:W.date} : null, wr = onW || wr0;
    if (wr) {
      const pctw = n => (100 * n / wr.weight).toFixed(1) + '%', rowW = (cls, label, value, tone, parity) => '<span class="bc-n ' + cls + '"' + (parity ? ' data-parity="' + parity + '"' : '') + '>' + label + '</span><span class="bc-v ' + cls + '" style="color:' + BC_TONE[tone] + '">' + u.lb(value).toFixed(1) + ' ' + u.mass + '</span><span class="bc-p ' + cls + '" style="color:' + BC_TONE[tone] + '">' + pctw(value) + '</span>';
      return '<section class="bc-card" data-parity="V35-B10-01" data-bc-source="' + (onW ? 'weigh-in' : 'report') + '" aria-label="Body Composition">' + head + '<b class="bc-name">' + esc(name) + '</b><div class="bc-grid" data-parity="BODY-26">' +
        rowW('fat', 'Fat', wr.fat, this.fatTone({fat: wr.fat, total: wr.weight}, true)) + rowW('muscle', 'Muscle', wr.muscle, 'none', 'BODY-27') + (wr.bone !== null ? rowW('other', 'Bone', wr.bone, 'none') : '') + (wr.other ? rowW('other', wr.bone !== null || onW ? 'Other' : 'Bone and other', wr.other, 'none') : '') +
        '<i class="bc-rule" aria-hidden="true"></i>' + '<span class="bc-n total">Total</span><span class="bc-v total">' + u.lb(wr.weight).toFixed(1) + ' ' + u.mass + '</span><span class="bc-p total">100%<em class="bc-eq" data-parity="V35-B11-02" title="' + (onW ? 'Equals your weight' : 'Equals the report weight') + '" aria-label="' + (onW ? 'Equals your weight' : 'Equals the report weight') + '">✓</em></span>' +
        '</div>' + this.sourceLine(onW ? W.source : 'Fitdays', wr.date, false) + '</section>';
    }
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
  /* V6.1.3 round 2 (his words on Preview v31: "make that Body COmposition WHole body card so that it doesnt block the 3d model ... collapsable and draggable
     ... it defaults to collapsed on the right bottom side"): the card's title row drags it; a press that moves under 4 px is a click, which folds it to that
     row or opens it. Folded at the model's bottom right by default, clear of the control strip and the icon column. Where it sits (fractions of the room
     left in the model's half) and the fold are kept on this device and clamped inside, so it holds in the page and in full screen. */
  bcState() { try { const o = JSON.parse(localStorage.getItem(BC_KEY) || 'null'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; } }
  bcSave(o) { try { localStorage.setItem(BC_KEY, JSON.stringify(o)); } catch (_) {} }
  bcRoom(card) { const box = card.parentElement, W = box.clientWidth, H = box.clientHeight; return {W, H, maxX: Math.max(BC_EDGE, W - card.offsetWidth - BC_EDGE), maxY: Math.max(BC_EDGE, H - card.offsetHeight - BC_EDGE)}; }
  placeCard() {
    const card = this.querySelector('.bc-card'); if (!card || !card.parentElement) return;
    const st = this.bcState(), folded = st.folded !== false;
    if (card.classList.contains('bc-folded') !== folded) card.classList.toggle('bc-folded', folded);
    const t = card.querySelector('.bc-title'); if (t) t.setAttribute('aria-expanded', String(!folded));
    const R = this.bcRoom(card); if (!R.W || !R.H) return;
    const free = (f, max) => BC_EDGE + Math.min(1, Math.max(0, f)) * (max - BC_EDGE);
    const x = Number.isFinite(st.x) ? free(st.x, R.maxX) : Math.max(BC_EDGE, R.W - card.offsetWidth - BC_CLEAR.right), y = Number.isFinite(st.y) ? free(st.y, R.maxY) : Math.max(BC_EDGE, R.H - card.offsetHeight - BC_CLEAR.bottom);
    card.style.left = Math.round(x) + 'px'; card.style.top = Math.round(y) + 'px';
    card.classList.toggle('bc-east', x + card.offsetWidth / 2 > R.W / 2); card.classList.toggle('bc-low', y + card.offsetHeight / 2 > R.H / 2);   // the ⓘ legend opens toward the middle
  }
  bcFold() { const st = this.bcState(); st.folded = st.folded === false; this.bcSave(st); this.placeCard(); }
  bcDrag(event) {
    const head = event.target.closest && event.target.closest('.bc-head'); if (!head || event.button !== 0 || event.target.closest('.bc-info')) return;
    const card = head.closest('.bc-card'), x0 = event.clientX, y0 = event.clientY, l0 = card.offsetLeft, t0 = card.offsetTop; let moved = false;
    event.preventDefault(); try { head.setPointerCapture(event.pointerId); } catch (_) {}
    const move = e => {
      const dx = e.clientX - x0, dy = e.clientY - y0; if (!moved && Math.hypot(dx, dy) < BC_CLICK) return; moved = true; card.classList.add('bc-drag');
      const R = this.bcRoom(card); card.style.left = Math.round(Math.min(R.maxX, Math.max(BC_EDGE, l0 + dx))) + 'px'; card.style.top = Math.round(Math.min(R.maxY, Math.max(BC_EDGE, t0 + dy))) + 'px';
    };
    const done = fold => () => {
      head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); head.removeEventListener('pointercancel', cancel); card.classList.remove('bc-drag');
      if (!moved){ if (fold) this.bcFold(); return; }
      const R = this.bcRoom(card), st = this.bcState(); st.x = R.maxX > BC_EDGE ? (card.offsetLeft - BC_EDGE) / (R.maxX - BC_EDGE) : 0; st.y = R.maxY > BC_EDGE ? (card.offsetTop - BC_EDGE) / (R.maxY - BC_EDGE) : 0; this.bcSave(st); this.placeCard();
    }, up = done(true), cancel = done(false);
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up); head.addEventListener('pointercancel', cancel);
  }
  /* Round 2: in full screen a scroll down shows the Fitdays report (open, every section) and the regional composition under the stage; a copy, so his
     open or closed report card on the page stays as he left it. */
  fullMore(on) {
    const more = this.querySelector('.bs-more'); if (!more) return;
    if (!on) { if (!more.hidden) { more.hidden = true; more.innerHTML = ''; } return; }
    more.innerHTML = this.fullCopyHTML();
    more.hidden = false;
  }
  /* V6.1.7: the copy is the Body composition card with every fold open, its parity ids left on the page's own card. */
  fullCopyHTML() { return this.compositionHTML().replace(/ data-parity="[^"]*"/g, '').replace(/<details class="([^"]*)"( open)?>/g, '<details class="$1" open>'); }
  /* The selection panel, the chips and the mode switch follow every pick (B3, B5). */
  refreshSide() {
    const sel = this.querySelector('.bc-card'); if (sel) { const open = !!sel.querySelector('.bc-info[open]'), t = document.createElement('template'); t.innerHTML = this.selectionHTML(); if (open) t.content.querySelector('.bc-info').open = true; sel.replaceWith(t.content); this.placeCard(); }
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
      // Fix K2: muscle is always the saved report's muscle mass; Apple Health's lean mass is its own, differently named figure.
      {label: 'muscle', figure: fromFitdays('muscleMass', 'lb')},
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

  /* V6.1.7 (points 6 and 7, his yes Nov 4): one card for Fitdays. Its one Add Fitdays report button opens the sheet (read the picture or
     type it); his last three reports sit side by side, newest first, with the change between the newest two; regions and the full
     report fold under it. */
  compositionHTML() {
    const n = (this.reports || []).length;
    return '<section class="body-fd" aria-label="Body composition" data-parity="BODY-40"><div class="fd-head"><h3>Body composition</h3>' +
      '<button type="button" class="body-import fd-add" data-body="addReport" data-parity="BODY-38"' + (this.selected ? '' : ' disabled') + '>Add Fitdays report</button></div>' +
      (!this.selected ? '<p class="hint fd-none">Add the 3D model first: a Fitdays report saves with a body record.</p>' : !n ? '<p class="hint fd-none">No Fitdays report yet.</p>' :
        this.progressHTML(FD_ROWS, 'fd-main') + (this.reports.slice(0, 3).some(r => (r.segments || []).length) ? '<details class="fd-fold fd-regions"><summary>Fat and muscle by region</summary>' + this.progressHTML(FD_REGION_ROWS, 'fd-region') + '</details>' : '') + this.reportCardHTML()) +
      '</section>';
  }
  /* The table: one row per figure any of the three reports holds, in the report card's names. Change is the newest minus the one before:
     green when it moved the right way (fat down, muscle up), red the wrong way, plain where neither way is better (weight, water). */
  progressHTML(rows, cls) {
    const reps = (this.reports || []).slice(0, 3), u = window.HealthDisplayUnits || {mass: 'lb', lb: v => v}, esc = v => this.escape(v);
    const shown = v => v.unit === 'lb' ? u.lb(v.v) : v.v, fmt = (x, unit) => unit === 'kcal' ? String(Math.round(x)) : x.toFixed(1);
    const day = r => this.date(r.measurementDate, true) + (reps.filter(o => o.measurementDate === r.measurementDate).length > 1 && r.measurementTime ? ' ' + r.measurementTime : '');
    const body = rows.map(([label, pick, unit, better]) => {
      const vals = reps.map(r => { const x = pick(r); return Number.isFinite(x) ? {v: x, unit} : null; }); if (!vals.some(Boolean)) return '';
      let change = '';
      if (reps.length > 1) {
        const a = vals[0], b = vals[1], d = a && b ? shown(a) - shown(b) : null, step = unit === 'kcal' ? 0.5 : 0.05;
        const tone = d === null || Math.abs(d) < step || !better ? 'flat' : (d < 0) === (better === 'down') ? 'good' : 'bad';
        change = '<td class="fd-d" data-tone="' + tone + '" style="color:' + FD_TONE[tone] + '">' + (d === null ? '—' : Math.abs(d) < step ? '0' : (d < 0 ? '↓ ' : '↑ ') + fmt(Math.abs(d), unit)) + '</td>';
      }
      return '<tr><th scope="row">' + esc(label) + (unit ? '<small>' + esc(unit === 'lb' ? u.mass : unit) + '</small>' : '') + '</th>' + vals.map((x, i) => '<td' + (i ? '' : ' class="fd-now"') + '>' + (x ? fmt(shown(x), unit) : '—') + '</td>').join('') + change + '</tr>';
    }).join('');
    return '<table class="fd-table ' + cls + '" data-parity="' + (cls === 'fd-main' ? 'V617-FD-01' : 'V617-FD-02') + '"><thead><tr><th></th>' + reps.map(r => '<th scope="col">' + esc(day(r)) + '</th>').join('') + (reps.length > 1 ? '<th scope="col" title="The newest report less the one before">Change</th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table>';
  }
  /* Behind the stage's ⓘ: how the newest report was entered, its picture and its export (they were in the More fold). */
  fitdaysLinksHTML() {
    const r = this.fitdays; if (!r || !this.fitdaysHome) return '';
    const at = name => BODY_BASE + 'records/' + this.fitdaysHome + '/' + name;
    return '<p>Fitdays, ' + this.escape(this.date(r.measurementDate, true)) + (r.extraction ? ': ' + this.escape(r.extraction) : '') + '. ' + (r.sourceSha256 ? '<a class="body-export" href="' + at('fitdays-source.jpg') + '" target="_blank" rel="noopener">View original Fitdays report ↗</a>' : 'No picture was saved with it.') + '</p>' +
      '<p><a class="body-export" href="' + at('fitdays-export.zip') + '" download>Export Fitdays report + values</a></p>';
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
    const measurements=this.querySelector('.body-measurements');if(measurements){const open=measurements.open,holder=document.createElement('template');holder.innerHTML=this.measurementHTML();if(holder.content.firstElementChild)holder.content.firstElementChild.open=open;measurements.replaceWith(holder.content);}
    this.querySelectorAll('.body-fd').forEach(card=>{const open=[...card.querySelectorAll('details')].map(d=>d.open),copy=!!card.closest('.bs-more'),holder=document.createElement('template');holder.innerHTML=copy?this.fullCopyHTML():this.compositionHTML();holder.content.querySelectorAll('details').forEach((d,i)=>{if(open[i]!==undefined)d.open=open[i];});card.replaceWith(holder.content);});   // the page's and, in full screen, the copy under the stage
    if(this.selected)this.highlight(this.region);
  }

  measurementHTML() {
    const esc = value => this.escape(value);
    const readings = this.measurements.readings || [];
    if (!readings.length && !this.measurements.source) return '';   // V6.1.7: nothing from Health Auto Export, no fold
    return '<details class="body-measurements"><summary>Measurements from Health Auto Export</summary>' +
      '<p class="hint">' + esc(this.measurements.sourceFile || 'Health Auto Export') + ' · ' + readings.length + ' readings' + (this.measurements.coverageStart ? ' · ' + esc(this.measurements.coverageStart) + ' – ' + esc(this.measurements.coverageEnd) : '') + '</p>' +
      '<div class="body-readings">' + readings.slice(-30).map(r=>'<p><b>'+esc(r.label)+': '+esc(bodyMeasurement(r))+'</b><br><span class="hint">'+esc(r.region === 'whole-body' ? 'Whole body' : r.region)+' · '+esc(r.recordedAt)+'</span></p>').join('') + '</div>' +
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

  /* V6.1.7 (point 5): on the model card's corner, the record's date (a chip; a menu when there are several) and the two small buttons. */
  modelButtonHTML() { return '<label class="body-import bs-file" title="Add a 3D model: a .glb, or the body tool’s ZIP">' + bodyIcon(BODY_ICONS.cube, 13) + '3D model<input type="file" data-body="modelFile" accept=".glb,.zip,model/gltf-binary,application/zip" aria-label="Add a 3D model"></label>'; }
  filesHTML() {
    const esc = v => this.escape(v), rec = this.stage || this.selected, recs = this.records || [];
    if (this.stage) return '<div class="bs-files"><span class="bs-date" data-parity="B4-MODEL">' + esc(this.date(rec.captureDate, true)) + '</span></div>';
    const name = r => this.date(r.captureDate, true) + (recs.some(o => o !== r && o.captureDate === r.captureDate) && r.importedAt ? ' · ' + new Date(r.importedAt).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}) : '');
    const date = recs.length > 1 ? '<label class="bs-date" data-parity="B4-MODEL" title="Choose a dated view"><select data-body="record" aria-label="Dated body record">' + recs.map(r => '<option value="' + r.id + '"' + (r.id === rec.id ? ' selected' : '') + '>' + esc(name(r)) + '</option>').join('') + '</select>' + bodyIcon(BODY_ICONS.down, 11) + '</label>'
      : '<span class="bs-date" data-parity="B4-MODEL" title="The date of this body record">' + esc(name(rec)) + '</span>';
    return '<div class="bs-files" data-parity="V617-FILES">' + date + this.modelButtonHTML() + '<label class="body-import bs-file" title="Add a photo: Front, Back, Left or Right">' + bodyIcon(BODY_ICONS.camera, 13) + 'Photo<input type="file" data-body="photoFile" accept="image/*" aria-label="Add a photo"></label></div>';
  }
  /* One quiet review step: the new model and photos show on the stage before anything is saved. */
  reviewHTML() {
    const filled = this.stageFilled || [];
    return '<div class="body-review" data-parity="V617-REVIEW"><span><b>Preview, not saved yet.</b>' + (filled.length ? ' Plain stand-ins for ' + this.escape(filled.length === 4 ? 'all four photos' : filled.join(', ')) + ' until you add them.' : '') + '</span>' +
      '<div class="acts"><button class="primary" data-body="save">Save</button><button data-body="cancel">Cancel</button></div></div>';
  }
  /* Photo: which side is it? The side shown now is the first guess. */
  askSide(png) {
    this.pendingPhoto = png; if (this.pendingURL) URL.revokeObjectURL(this.pendingURL); this.pendingURL = URL.createObjectURL(new Blob([png], {type: 'image/png'}));
    const box = this.querySelector('.bs-photo'); if (!box) return; const old = box.querySelector('.bs-ask'); if (old) old.remove();
    box.insertAdjacentHTML('beforeend', '<div class="bs-ask" role="dialog" aria-label="Which side is this photo?" data-parity="V617-SIDE"><img src="' + this.pendingURL + '" alt="The photo you chose"><b>Which side is this?</b><div class="bs-sides" role="group" aria-label="Photo side">' +
      BODY_SIDES.map(side => '<button type="button" data-body="photoSide" data-side="' + side + '" aria-pressed="' + (side === this.photo) + '">' + side + '</button>').join('') + '</div><button type="button" class="bs-ask-x" data-body="photoCancel">Cancel</button></div>');
  }
  closeAsk() { const ask = this.querySelector('.bs-ask'); if (ask) ask.remove(); if (this.pendingURL) URL.revokeObjectURL(this.pendingURL); this.pendingURL = null; this.pendingPhoto = null; }
  async bodyBytes(name) { const response = await bodyFetch('records/' + this.selected.id + '/' + name); if (!response.ok) throw new Error('The saved body record could not be read.'); return new Uint8Array(await response.arrayBuffer()); }
  /* The ZIP the service accepts, from what is new and what the open record already has: a new model keeps the record's four photos; a
     new photo keeps the record's model, manifest and other three photos. The very first record gets plain stand-ins for missing photos. */
  async stageBuilt(change) {
    if (this.busy) return; this.busy = true; this.disable(true); this.status('Getting the new view ready…');
    try {
      const files = {}, filled = [], cur = this.selected;
      if (change.model) { files['model.glb'] = change.model.glb; files['manifest.json'] = change.model.manifest || new TextEncoder().encode(JSON.stringify({schema: 1, kind: 'visual-likeness', captureDate: localYmd(), modelSha256: await sha256Hex(change.model.glb)})); }
      else { files['model.glb'] = await this.bodyBytes('model.glb'); files['manifest.json'] = await this.bodyBytes('manifest.json'); }
      for (const side of BODY_SIDES) {
        const fresh = change.photos && change.photos[side];
        if (fresh) files[side + '.png'] = fresh; else if (cur) files[side + '.png'] = await this.bodyBytes(side + '.png'); else { files[side + '.png'] = await placeholderPNG(); filled.push(side); }
      }
      const zip = zipStored(['model.glb', 'manifest.json', ...BODY_SIDES.map(s => s + '.png')].map(n => [n, files[n]]));
      if (zip.size > 64 * 1024 * 1024) throw new Error('The model and photos come to more than 64 MB together.');
      if (this.stage) await this.request('cancel', {stageId: this.stage.stageId});
      this.stage = null;
      const stage = await this.request('stage', new File([zip], 'body-record.zip', {type: 'application/zip'}));
      if (!this.isConnected) { await this.request('cancel', {stageId: stage.stageId}); return; }
      this.stage = stage; this.stageFilled = filled; this.stageVariant = cur ? cur.variant : 'reconstructed-reference';
      this.photo = change.side || 'Front'; this.closeAsk(); this.render();
      const save = this.querySelector('[data-body="save"]'); if (save) save.focus();
    } catch (error) { this.status(error.message, true); }
    finally { this.busy = false; this.disable(false); }
  }
  async readModel(file) {
    if (file.size > 64 * 1024 * 1024) throw new Error('Choose a model smaller than 64 MB.');
    const buffer = await file.arrayBuffer(), u8 = new Uint8Array(buffer);
    if (u8[0] === 0x67 && u8[1] === 0x6C && u8[2] === 0x54 && u8[3] === 0x46) return {model: {glb: u8}};   // "glTF": a .glb alone
    if (u8[0] !== 0x50 || u8[1] !== 0x4B) throw new Error('Choose a .glb model, or the body tool’s ZIP.');
    const z = await unzipBody(buffer); if (!z['model.glb']) throw new Error('That ZIP has no model.glb in it.');
    const photos = {}; for (const side of BODY_SIDES) if (z[side + '.png']) photos[side] = z[side + '.png'];
    return {model: {glb: z['model.glb'], manifest: z['manifest.json'] || null}, photos};
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
          '<model-viewer class="body-model" src="' + this.asset(!this.stage && Object.keys(this.regions).length ? 'regions.glb' : 'model.glb') + '" alt="Approximate body model. Drag to rotate; the wheel zooms within limits, then scrolls the page." camera-controls disable-zoom touch-action="pan-y" camera-orbit="' + ({Front: 0, Back: 180, Left: -90, Right: 90}[this.photo] || 0) + 'deg 90deg ' + this.startPct + '%" field-of-view="30deg" min-camera-orbit="auto auto ' + BODY_ZOOM.min + '%" max-camera-orbit="auto auto ' + BODY_ZOOM.max + '%" interaction-prompt="none" shadow-intensity="0.4" exposure="1"></model-viewer><span class="body-load" role="status">Loading 3D view…</span>' +
          (!this.stage ? this.selectionHTML() + '<div class="body-region-overlay" aria-live="polite" hidden></div>' : '') + this.filesHTML() +
          '<div class="body-angles k-seg" role="group" aria-label="Model angle" data-parity="BODY-31">' + ['Front','Back','Left','Right'].map(name => '<button data-body="angle" data-angle="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div>' +
          '<div class="body-angle-controls bs-strip" aria-label="Model viewing controls" data-parity="V35-B1-02">' + icon('zoom', 'Zoom in', ' data-direction="-1"', bodyIcon(BODY_ICONS.zoomIn)) + icon('zoom', 'Zoom out', ' data-direction="1"', bodyIcon(BODY_ICONS.zoomOut)) + icon('angle', 'Reset view', ' data-angle="Reset view"', bodyIcon(BODY_ICONS.reset)) + icon('fullscreen', 'Full screen', ' aria-pressed="false"', bodyIcon(BODY_ICONS.expand), 'V35-B13-01') +
            '<details class="body-help icon"><summary aria-label="About this view" title="About this view">ⓘ</summary><div class="bh-pop" data-parity="V617-INFO"><p>Drag to turn the model; Front, Back, Left and Right turn it and the photo together.</p><p>Private: the model, photos and Fitdays reports stay on this Mac.</p><p>A visual likeness, not a measurement' + (record.variant === 'reconstructed-reference' ? '; its shape may be estimated' : '') + '.</p>' +
              (!this.stage ? '<p><a class="body-export" href="' + this.asset('export.zip') + '" download>Export model + four images</a></p>' + this.fitdaysLinksHTML() : '') + '</div></details></div>' +
          (!this.stage ? this.regionHTML() : '') +
        '</div>' +
        '<div class="bs-photo body-photos" data-parity="BODY-34"><span class="body-photo-badge">Photo</span><a class="body-photo-link" href="' + this.asset(this.photo + '.png') + '" target="_blank" rel="noopener" title="Open full-size image" data-parity="V35-B14-01"><img class="body-reference" src="' + this.asset(this.photo + '.png') + '" alt="' + this.photo + ' reference image"></a><div class="body-photo-tabs" role="group" aria-label="Reference image" hidden>' + ['Front','Back','Left','Right'].map(name => '<button data-body="photo" data-photo="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div></div>' +
        '<button type="button" class="bs-exit" data-body="fullscreen" data-parity="V35-B13-02" aria-label="Exit full screen" title="Exit full screen (Esc)">' + bodyIcon(BODY_ICONS.shrink, 18) + '</button>' +
        (!this.stage ? '<div class="body-report-sheet" hidden></div><div class="bs-more" hidden></div>' : '') +
      '</div>' +
      (stale ? '<div class="bs-foot"><p class="body-stale" data-parity="BODY-39">A newer weigh-in has no segment report yet</p></div>' : '') +
      (!this.stage ? '<div class="body-tools">' + this.toolsHTML() + '</div>' : '') : '';
    this.innerHTML = '<section class="panelcard body-record-card" aria-label="Your body records">' +
      '<p class="body-status hint" role="status" aria-live="polite"></p>' +
      (record ? (this.stage ? this.reviewHTML() : '') + stageHTML + (!this.stage ? this.compositionHTML() + this.measurementHTML() : '')
      : '<div class="body-empty"><h3>Keep a dated view of your body</h3><div class="bs-files">' + this.modelButtonHTML() + '<details class="body-help inline"><summary aria-label="About your body view">ⓘ</summary><p class="hint">Private: the model, photos and Fitdays reports stay on this Mac.</p></details></div><p class="hint">A .glb, or the body tool’s ZIP; photos go beside it after.</p></div>' + this.compositionHTML()) + '</section>';
    // V3.5 K5: the page adds its one note control to each card; this card is drawn here, after the page's pass.
    { const rc = this.querySelector('.body-report-card'); if (rc) rc.addEventListener('toggle', () => { try { localStorage.setItem('health-tracker.reportCardOpen', rc.open ? '1' : '0'); } catch (_) {} }); }   // U3: the card stays as he left it
    this.dispatchEvent(new CustomEvent('bodyrender', {bubbles: true}));
    this.placeCard();
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
      if (!this.resizeWatch && typeof ResizeObserver === 'function') { this.resizeWatch = new ResizeObserver(() => { this.fitPhoto(); this.placeCard(); }); }
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
      '<div class="rep-grid">' + whole + '</div>' + this.reportExtrasHTML(v.extras) + '<p class="cap">Regions</p><div class="rep-segs">' + segs + '</div>' +
      '<p class="body-status hint rep-status" role="status"></p><div class="acts"><button class="primary save" data-body="reportSave">' + (entry === 'read' ? 'Confirm and save' : 'Save') + '</button><button data-body="reportClose">Cancel</button></div></div></div>';
  }
  /* Fix K1 (Mintay, Oct 6: "all the metrics from the Fitdays app ... visualized as well without making things too complicated"): one folded card with
     everything the saved report holds, in four short blocks, each figure with the report's own status word. */
  reportCardHTML() {
    const r = this.fitdays, w = r && r.wholeBody; if (!w) return '';
    const e = r.extras || {}, st = r.statuses || {}, lab = r.labels || {}, ctl = r.control || {}, ranges = r.segmentRanges || {}, esc = v => this.escape(v), u = window.HealthDisplayUnits || {mass: 'lb', lb: v => v};
    const hist = (Array.isArray(r.history) ? r.history : []).concat(r.previous && !(r.history || []).some(h => h.measurementDate === r.previous.measurementDate) ? [r.previous] : []).filter(h => h && h.measurementDate && h.measurementDate < r.measurementDate).sort((a, b) => a.measurementDate.localeCompare(b.measurementDate));
    const fig = (src, k, unit) => { const x = src && src[k]; return x && Number.isFinite(x.value) ? {v: x.value, unit} : null; };
    /* Fix U1: a status bar in the style of the Goals bars. Its zones are the report's own words, Excellent, Standard, High, Too High (Low only when the report says Low);
       a dot sits in the zone the report names. Nothing is invented: a figure with no word in the report shows only its value. */
    const ZONES = [['Excellent', '#79d6a9'], ['Standard', '#b9d96f'], ['High', '#f0a058'], ['Too High', '#e0645c']];
    const zoneOf = word => { const x = String(word || '').trim().toLowerCase(); return /^too\s*high$/.test(x) ? 'Too High' : /^high$/.test(x) ? 'High' : /^(standard|normal|good|healthy)$/.test(x) ? 'Standard' : /^excellent$/.test(x) ? 'Excellent' : /^(too\s*)?low$|^insufficient$/.test(x) ? 'Low' : null; };
    const statusBar = word => { const z = zoneOf(word); if (!z) return word ? '<span class="rc-s">' + esc(word) + '</span>' : ''; const zones = z === 'Low' ? [['Low', '#7fb3f0']].concat(ZONES) : ZONES, at = zones.findIndex(x => x[0] === z), n = zones.length;
      return '<span class="rc-bar" role="img" aria-label="' + esc(word) + '" title="' + esc(word) + '">' + zones.map(x => '<i style="background:' + x[1] + '"></i>').join('') + '<b style="left:' + ((at + .5) / n * 100).toFixed(1) + '%"></b></span>'; };
    /* U1: a region against the report's own standard range (percent of standard): the range is the green zone, below it blue, above it orange, the dot where the percent is */
    const rangeBar = (pct, range) => { if (!Number.isFinite(pct) || !range) return ''; const hi = Math.max(pct, range[1]) * 1.15, x = v => Math.min(100, Math.max(0, v / hi * 100)).toFixed(1);
      return '<span class="rc-bar rc-range" role="img" aria-label="' + pct + ' percent of standard" title="Standard ' + range[0] + '% to ' + range[1] + '%"><i style="left:0;width:' + x(range[0]) + '%;background:#7fb3f0"></i><i style="left:' + x(range[0]) + '%;width:' + (x(range[1]) - x(range[0])).toFixed(1) + '%;background:#79d6a9"></i><i style="left:' + x(range[1]) + '%;right:0;background:#f0a058"></i><b style="left:' + x(pct) + '%"></b></span>'; };
    /* U2: a trend line once there are two or more reports, with the change since the previous one; one report shows neither */
    const series = pick => { const out = []; for (const h of hist){ const v = pick(h); if (Number.isFinite(v)) out.push(v); } const c = pick(r); if (Number.isFinite(c)) out.push(c); return out; };
    const spark = (vals, unit) => { if (vals.length < 2) return ''; const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1, W = 44, H = 16, pts = vals.map((v, i) => (i / (vals.length - 1) * (W - 4) + 2).toFixed(1) + ',' + (H - 2 - (v - lo) / span * (H - 4)).toFixed(1)).join(' '), d = vals[vals.length - 1] - vals[vals.length - 2];
      const txt = Math.abs(d) < 0.05 ? '0' : (d > 0 ? '+' : '−') + (unit === 'lb' ? Math.abs(u.lb(d)).toFixed(1) : unit === '%' || unit === 'pt' ? Math.abs(d).toFixed(1) : String(Math.round(Math.abs(d) * 10) / 10));
      return '<span class="rc-sp"><svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Trend, ' + vals.length + ' reports"><polyline fill="none" stroke="currentColor" stroke-width="1.4" points="' + pts + '"/><circle cx="' + pts.split(' ').pop().split(',')[0] + '" cy="' + pts.split(' ').pop().split(',')[1] + '" r="2" fill="currentColor"/></svg><small>' + txt + (unit === 'lb' ? ' ' + esc(u.mass) : unit === '%' ? '%' : unit === 'pt' ? ' pts' : '') + '</small></span>'; };
    const valTxt = f => f.unit === 'lb' ? u.lb(f.v).toFixed(1) + ' ' + u.mass : f.unit === '%' ? f.v + '%' : f.unit === 'kcal' ? f.v + ' kcal' : String(f.v);
    const row = (label, f, key, src) => { if (!f) return ''; const status = st[key] || '', vals = src === 'w' ? series(h => (h.wholeBody && h.wholeBody[key] || {}).value) : series(h => (h.extras && h.extras[key] || {}).value);
      return '<span class="rc-n">' + esc(label) + '</span>' + (spark(vals, f.unit) || '<span class="rc-sp"></span>') + '<b class="rc-v">' + esc(valTxt(f)) + '</b>' + (status ? statusBar(status) : '<span class="rc-s"></span>'); };
    const text = (label, v) => v ? '<span class="rc-n">' + esc(label) + '</span><b class="rc-v rc-wide">' + esc(v) + '</b>' : '';
    /* U1: the weight-control block as one short "to go" bar per figure: the length is the distance from the current figure to the report's target */
    const toGo = (label, k, kind) => { if (!Number.isFinite(ctl[k])) return ''; const v = ctl[k], ab = Math.abs(v), txt = (v > 0 ? '+' : v < 0 ? '−' : '') + u.lb(ab).toFixed(1) + ' ' + u.mass, cur = k === 'weight' ? w.weight : k === 'fat' ? w.fatMass : w.muscleMass, base = cur && Number.isFinite(cur.value) ? cur.value : 0, pct = base > 0 ? Math.min(100, ab / base * 100) : 0;
      return '<span class="rc-n">' + esc(label) + '</span><span class="rc-sp"></span><b class="rc-v">' + esc(txt) + '</b><span class="rc-bar rc-togo" role="img" aria-label="' + esc(label + ' ' + txt + ' to go') + '"><i style="left:0;width:' + pct.toFixed(1) + '%"></i></span>'; };
    const segRows = kind => { const rows = (r.segments || []).filter(x => FITDAYS_GROUPS[x.id]); if (!rows.length) return ''; const pctKey = kind === 'fat' ? 'fatComparisonPercent' : 'muscleComparisonPercent';
      return rows.map(x => { const range = kind === 'fat' ? ranges.fat : (/arm/.test(x.id) ? ranges.muscleLimb : ranges.muscleCore), pct = x[pctKey], vals = series(h => { const s = (h.segments || []).find(y => y.id === x.id); return s ? s[pctKey] : null; });
        return '<span class="rc-n">' + esc(FITDAYS_GROUPS[x.id].label) + '</span>' + (spark(vals, 'pt') || '<span class="rc-sp"></span>') + '<b class="rc-v">' + (Number.isFinite(pct) ? pct + '%' : '') + '</b>' + (rangeBar(pct, range) || '<span class="rc-s"></span>'); }).join(''); };
    const blocks = [
      ['Composition', row('Weight', fig(w, 'weight', 'lb'), 'weight', 'w') + row('Fat mass', fig(w, 'fatMass', 'lb'), 'fatMass', 'w') + row('Fat-free weight', fig(w, 'fatFreeWeight', 'lb'), 'fatFreeWeight', 'w') + row('Muscle mass', fig(w, 'muscleMass', 'lb'), 'muscleMass', 'w') + row('Muscle rate', fig(e, 'muscleRate', '%'), 'muscleRate', 'e') + row('Skeletal muscle', fig(e, 'skeletalMuscle', '%'), 'skeletalMuscle', 'e') + row('Bone mass', fig(e, 'boneMass', 'lb'), 'boneMass', 'e')],
      ['Water and protein', row('Water weight', fig(e, 'waterWeight', 'lb'), 'waterWeight', 'e') + row('Body water', fig(e, 'bodyWater', '%'), 'bodyWater', 'e') + row('Protein mass', fig(e, 'proteinMass', 'lb'), 'proteinMass', 'e') + row('Protein', fig(e, 'protein', '%'), 'protein', 'e')],
      ['Fat and risk', row('Body fat', fig(w, 'bodyFatPercentage', '%'), 'bodyFatPercentage', 'w') + row('BMI', fig(w, 'bmi', ''), 'bmi', 'w') + row('Subcutaneous fat', fig(e, 'subcutaneousFat', '%'), 'subcutaneousFat', 'e') + row('Visceral fat', fig(e, 'visceralFat', ''), 'visceralFat', 'e') + row('WHR', fig(e, 'whr', ''), 'whr', 'e') + text('Obesity level', lab.obesityLevel) + text('Body type', lab.bodyType)],
      ['Targets', row('Ideal weight', fig(e, 'idealBodyWeight', 'lb'), 'idealBodyWeight', 'e') + row('BMR', fig(e, 'bmr', 'kcal'), 'bmr', 'e') + row('Body age', fig(e, 'bodyAge', ''), 'bodyAge', 'e') + (Number.isFinite(ctl.targetWeight) ? '<span class="rc-n">Recommended weight</span><span class="rc-sp"></span><b class="rc-v">' + u.lb(ctl.targetWeight).toFixed(1) + ' ' + u.mass + '</b><span class="rc-s"></span>' : '') + toGo('Weight control', 'weight') + toGo('Fat control', 'fat') + toGo('Muscle control', 'muscle')]
    ];
    const fatRows = segRows('fat'), muscleRows = segRows('muscle');
    if (fatRows) blocks.push(['Fat by region', fatRows]); if (muscleRows) blocks.push(['Muscle by region', muscleRows]);
    const shown = blocks.filter(b => b[1]); if (!shown.length) return '';
    const open = (() => { try { return localStorage.getItem('health-tracker.reportCardOpen') === '1'; } catch (_) { return false; } })();
    return '<details class="body-report-card" data-parity="K1-REPORT"' + (open ? ' open' : '') + '><summary>Fitdays report · ' + esc(this.date(r.measurementDate, true)) + (hist.length ? ' · ' + (hist.length + 1) + ' reports' : '') + '</summary>' +
      shown.map(([t, body]) => '<div class="rc-block"><p class="cap">' + esc(t) + '</p><div class="rc-grid">' + body + '</div></div>').join('') + '</details>';
  }
  /* B2: the remaining table rows, read from the picture and saved with the report; nothing to type. */
  reportExtrasHTML(extras) {
    const names = {boneMass: 'Bone', proteinMass: 'Protein mass', waterWeight: 'Water weight', skeletalMuscle: 'Skeletal muscle', muscleRate: 'Muscle rate', subcutaneousFat: 'Subcutaneous fat', visceralFat: 'Visceral fat', bmr: 'BMR', bodyAge: 'Body age', whr: 'WHR', idealBodyWeight: 'Ideal weight', bodyWater: 'Body water', protein: 'Protein share'};
    const list = Object.entries(extras || {}).map(([k, x]) => (names[k] || k) + ' ' + x.value + (x.unit ? (x.unit === '%' ? '%' : ' ' + x.unit) : '')); if (!list.length) return '';
    return '<p class="hint rep-extras" data-parity="B2-EXTRAS">Also read from the picture: ' + this.escape(list.join(' · ')) + '.</p>';
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
    this.reportExtras = values && values.extras || {}; this.reportMore = values ? {statuses: values.statuses || {}, labels: values.labels || {}, control: values.control || {}, segmentRanges: values.segmentRanges || {}} : null; this.reportSegs = values && values.segments || [];
    box.innerHTML = values ? this.reportFormHTML(values, 'read', picture) : '<p class="hint">This surface cannot read reports; type the numbers beside the picture.</p>' + this.reportFormHTML(null, 'self-entered', picture);
  }
  async saveReport() {
    const form = this.querySelector('.rep-form'); if (!form || !this.selected) return;
    const val = name => { const el = form.querySelector('[data-rep="' + name + '"]'); return el && el.value !== '' ? Number(el.value) : null; };
    const status = form.querySelector('.rep-status'), say = (t, bad) => { if (status) { status.textContent = t; status.classList.toggle('body-error', !!bad); } };
    const entry = form.dataset.entry, units = Object.fromEntries(this.reportFields().map(([k, , u]) => [k, u || null]));
    const payload = {entry, measurementDate: (form.querySelector('[data-rep="date"]') || {}).value || null, measurementTime: (form.querySelector('[data-rep="time"]') || {}).value || null,
      wholeBody: Object.fromEntries(this.reportFields().map(([k]) => [k, {value: val('whole.' + k), unit: units[k]}])),
      segments: Object.keys(FITDAYS_GROUPS).map(id => { const r = entry === 'read' && (this.reportSegs || []).find(x => x.id === id) || {}; return {id, fatMassLb: val('seg.' + id + '.fat'), muscleBalanceMassLb: val('seg.' + id + '.muscle'), ...(Number.isFinite(r.fatComparisonPercent) ? {fatComparisonPercent: r.fatComparisonPercent} : {}), ...(Number.isFinite(r.muscleComparisonPercent) ? {muscleComparisonPercent: r.muscleComparisonPercent} : {})}; })};
    if (entry === 'read' && this.reportImage) payload.imageBase64 = this.reportImage;
    if (entry === 'read' && this.reportMore) Object.assign(payload, this.reportMore);   // K1: the status words, the two verdicts and the weight-control block
    if (entry === 'read' && this.reportExtras && Object.keys(this.reportExtras).length) payload.extras = this.reportExtras;   // B2: what else the picture printed
    const empty = Object.entries(payload.wholeBody).filter(([, x]) => x.value === null).length + payload.segments.filter(s => s.fatMassLb === null || s.muscleBalanceMassLb === null).length;
    if (!payload.measurementDate || empty) { say('Fill in the date and every number first.', true); return; }
    this.busy = true; say('Saving…');
    try {
      await this.request('fitdays-entry/' + this.selected.id, payload);
      await this.loadFitdays(); this.region = 'all'; this.publishSnapshot(); this.render();
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
    if (control.dataset.body === 'measurements' && control.files.length) {
      this.busy = true; this.disable(true); this.status('Reading body-measurement fields…');
      try { this.measurements = await this.request('measurements/' + this.selected.id, control.files[0]); this.render(); this.status(this.measurements.readings.length ? 'Export-reported body measurements linked.' : 'Export checked: body fields are empty; no measurement values were added.'); }
      catch (error) { this.status(error.message, true); }
      finally { this.busy = false; this.disable(false); }
      return;
    }
    /* V6.1.7: the corner's two buttons. A model (or the old ZIP) goes straight to the review; a photo first asks its side. */
    if (control.dataset.body === 'modelFile' && control.files.length) {
      const file = control.files[0]; control.value = '';
      try { await this.stageBuilt(await this.readModel(file)); } catch (error) { this.status(error.message, true); }
      return;
    }
    if (control.dataset.body === 'photoFile' && control.files.length) {
      const file = control.files[0]; control.value = '';
      if (!this.selected) { this.status('Add the 3D model first; the photos go beside it.', true); return; }
      if (file.size > 40 * 1024 * 1024) { this.status('Choose a photo smaller than 40 MB.', true); return; }
      try { this.status(''); this.askSide(await photoPNG(file)); } catch (error) { this.status(error.message, true); }
    }
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
          this.fullMore(on);
          const b = this.querySelector('.bs-strip [data-body="fullscreen"]'); if (b) { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen'); b.title = on ? 'Exit full screen (Esc)' : 'Full screen'; b.innerHTML = bodyIcon(on ? BODY_ICONS.shrink : BODY_ICONS.expand); }
          const card = this.querySelector('.bc-card'); if (card) card.classList.toggle('full', on);
          this.fitPhoto(); this.frameModel(); this.placeCard();
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
      if (!this.selected) { this.status('Add the 3D model first: a Fitdays report saves with a body record.'); return; }
      this.openReport();
    } else if (action === 'photoSide') {
      const png = this.pendingPhoto; if (png) await this.stageBuilt({photos: {[button.dataset.side]: png}, side: button.dataset.side});
    } else if (action === 'photoCancel') {
      this.closeAsk();
    } else if (action === 'reportTab') {
      this.openReport(button.dataset.tab);
    } else if (action === 'reportClose') {
      const sheet = this.querySelector('.body-report-sheet'); if (sheet) { sheet.hidden = true; sheet.innerHTML = ''; }
    } else if (action === 'reportSave') {
      await this.saveReport();
    } else if (action === 'cancel' || action === 'save') {
      const variant = this.stageVariant || 'reconstructed-reference';   // V6.1.7: the record's own reference type, else the old default; no select
      this.busy = true; this.disable(true);
      try {
        if (action === 'cancel') {
          await this.request('cancel', {stageId: this.stage.stageId}); this.stage = null; this.stageFilled = null; this.render(); this.status('Nothing was saved.');
        } else {
          const result = await this.request('commit', {stageId: this.stage.stageId, variant});
          this.stage = null; this.stageFilled = null; await this.load(result.record.id);
          this.status(result.duplicate ? 'This body record was already saved. Opened the existing record.' : 'Body record saved on this Mac.');
        }
      } catch (error) { this.status(error.message, true); }
      finally { this.busy = false; this.disable(false); }
    }
  }
}
customElements.define('ht-body-view', HealthBodyView);
