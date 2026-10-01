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
   `missing`, so the confirm screen asks for it; nothing is guessed. Pounds only: a kilogram report is converted. */
const REPORT_SEGMENTS = [['left-arm', /^left\s*arm/i], ['right-arm', /^right\s*arm/i], ['trunk', /^trunk/i], ['left-leg', /^left\s*leg/i], ['right-leg', /^right\s*leg/i]];
const REPORT_WHOLE = [['weight', /^(body\s*)?weight\b/i, 'lb'], ['bmi', /^bmi\b/i, null], ['bodyFatPercentage', /^body\s*fat(?!\s*mass)(\s*(rate|percentage|%))?\b/i, '%'], ['fatMass', /^(body\s*)?fat\s*mass/i, 'lb'], ['fatFreeWeight', /^fat[\s-]*free/i, 'lb'], ['muscleMass', /^muscle\s*mass/i, 'lb']];
function parseFitdaysReport(lines) {
  const rows = [];
  for (const l of (lines || []).filter(l => l && typeof l.text === 'string').sort((a, b) => (a.y || 0) - (b.y || 0))) {
    const row = rows.find(r => Math.abs(r.y - (l.y || 0)) < 0.012); if (row) row.items.push(l); else rows.push({y: l.y || 0, items: [l]});
  }
  const texts = rows.map(r => r.items.sort((a, b) => (a.x || 0) - (b.x || 0)).map(i => i.text).join('  ').trim());
  const nums = t => [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(lb|lbs|kg|%)?/gi)].map(m => ({v: parseFloat(m[1].replace(',', '.')), unit: (m[2] || '').toLowerCase()}));
  const toLb = n => n.unit === 'kg' ? Math.round(n.v / .45359237 * 10) / 10 : n.v;
  const out = {measurementDate: null, measurementTime: null, wholeBody: {}, segments: [], missing: []};
  for (const t of texts) {
    const iso = t.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/);
    if (iso && !out.measurementDate) { out.measurementDate = iso[1] + '-' + iso[2].padStart(2, '0') + '-' + iso[3].padStart(2, '0'); if (iso[4]) out.measurementTime = iso[4].padStart(2, '0') + ':' + iso[5]; continue; }
    const seg = REPORT_SEGMENTS.find(([, re]) => re.test(t));
    if (seg) { const values = nums(t.replace(seg[1], '')).filter(n => n.unit !== '%'); if (values.length >= 2 && !out.segments.some(s => s.id === seg[0])) out.segments.push({id: seg[0], fatMassLb: toLb(values[0]), muscleBalanceMassLb: toLb(values[1])}); continue; }
    const whole = REPORT_WHOLE.find(([, re]) => re.test(t));
    if (whole && !out.wholeBody[whole[0]]) { const values = nums(t.replace(whole[1], '')); if (values.length) out.wholeBody[whole[0]] = {value: whole[2] === 'lb' ? toLb(values[0]) : values[0].v, unit: whole[2]}; }
  }
  for (const [k] of REPORT_WHOLE) if (!out.wholeBody[k]) out.missing.push(k);
  for (const [k] of REPORT_SEGMENTS) if (!out.segments.some(s => s.id === k)) out.missing.push(k);
  if (!out.measurementDate) out.missing.push('measurementDate');
  return out;
}
window.HealthBodyRegionMath = {partsOf: regionPartsOf, figures: regionFigures, autoName: regionAutoName, share: segmentShare, parseReport: parseFitdaysReport};
const BODY_ZOOM = {min:20, max:250, start:115, step:20};
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
    this.mode = 'select'; this.linked = new Set(); this.compare = {a: null, b: null, next: 'a'};
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
    const f = regionFigures(parts, this.fitdays), esc = v => this.escape(v), name = k => this.regions[k] || FITDAYS_GROUPS[k]?.label || k;
    if (f.fat === null) return '<span class="body-na">Not available at this segmentation' + (f.missing.length ? ' (' + esc(f.missing.map(name).join(', ')) + ')' : '') + '</span>';
    const u=window.HealthDisplayUnits||{mass:'lb',lb:v=>v},old=regionFigures(parts,this.fitdays&&this.fitdays.previous),pct=n=>f.total>0?(100*n/f.total).toFixed(1)+'%':'—';
    const change=(key,better)=>old[key]===null?'':window.GlowViews?GlowViews.delta({now:u.lb(f[key]),prev:u.lb(old[key]),unit:u.mass,better,period:'since '+this.date(this.fitdays.previous.measurementDate)}):'';
    let out = '<b>'+parts.length+' segments (all est.)</b><span><strong>Total</strong> '+u.lb(f.total).toFixed(1)+' '+u.mass+' · 100% '+change('total','')+'</span><span class="body-fat-value"><strong>Fat</strong> '+u.lb(f.fat).toFixed(1)+' '+u.mass+' · '+pct(f.fat)+' '+change('fat','down')+'</span><span class="body-lean-value"><strong>Lean muscle</strong> '+u.lb(f.muscle).toFixed(1)+' '+u.mass+' · '+pct(f.muscle)+' '+change('muscle','up')+'</span>';
    const notes = [];
    if (f.est) notes.push('parts split by typical segment mass');
    if (f.standIn.length) notes.push(f.standIn.map(g => FITDAYS_GROUPS[g].label.toLowerCase() + ' total stands in').join(', ') + ' (no separate measurement)');
    if (f.missing.length) notes.push('no reading for ' + f.missing.map(name).join(', '));
    return out + (notes.length ? '<small>' + esc(notes.join(' · ')) + '</small>' : '');
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
      const a = this.compare.a, b = this.compare.b, pa = regionPartsOf(a, this.saved), pb = regionPartsOf(b, this.saved), label = k => k ? (FITDAYS_GROUPS[k]?.label || (k.startsWith('custom:') ? (this.saved.find(r => 'custom:' + r.id === k) || {}).name : this.regions[k]) || k) : '—';
      const pick = (slot, val) => '<span class="body-cmp-pick' + (this.compare.next === slot ? ' next' : '') + '"><span class="body-swatch ' + slot + '"></span>' + slot.toUpperCase() + ' <b>' + esc(label(val)) + '</b></span>';
      let table = '';
      if (a && b) {
        const fa = regionFigures(pa, this.fitdays), fb = regionFigures(pb, this.fitdays), cell = (f, k) => f[k] === null ? '<span class="body-na">not available at this segmentation</span>' : '<b>' + ((f.est || f.standIn.length) ? 'est. ' : '') + bodyMass(f[k]) + '</b>';
        const size = pa.length !== pb.length ? '<p class="hint">Unequal regions: ' + esc(label(a)) + ' has ' + pa.length + ' segment' + (pa.length === 1 ? '' : 's') + ', ' + esc(label(b)) + ' has ' + pb.length + '. Shapes are comparable; the numbers cover different amounts of body.</p>' : '';
        table = '<table class="body-cmp"><thead><tr><th></th><th><span class="body-swatch a"></span>' + esc(label(a)) + '</th><th><span class="body-swatch b"></span>' + esc(label(b)) + '</th></tr></thead><tbody>' +
          '<tr><td>Fat</td><td>' + cell(fa, 'fat') + '</td><td>' + cell(fb, 'fat') + '</td></tr><tr><td>Muscle</td><td>' + cell(fa, 'muscle') + '</td><td>' + cell(fb, 'muscle') + '</td></tr><tr><td>Segments</td><td>' + pa.length + '</td><td>' + pb.length + '</td></tr></tbody></table>' + size +
          ((fa.est || fb.est) ? '<p class="hint">est.: parts are split from the Fitdays total of their limb or of the trunk by typical segment mass (de Leva).</p>' : '') + ((fa.standIn.length || fb.standIn.length) ? '<p class="hint">A trunk part shows the trunk total standing in; Fitdays does not split the trunk.</p>' : '');
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
  /* V3.4 (B3): the selection panel, five lines. The name; Total in bold; Fat and Muscle, each in pounds and as a share of
     the selection (of the weight for Whole Body, so it matches the Body Fat tile), with an arrow against the previous
     report that hides when the change is tiny; and the source with its date and age in the freshness colour. Whole Body
     reads the latest weigh-in (B2); segments read the last Fitdays report and are never summed with it. */
  freshTone(date) { const d = Math.max(0, Math.round((Date.now() - new Date(date + 'T12:00:00').getTime()) / 864e5)); const h = d <= 3 ? 140 : d <= 6 ? 140 + (52 - 140) * (d - 3) / 3 : d <= 10 ? 52 + (4 - 52) * (d - 6) / 4 : 4; return {days: d, colour: 'hsl(' + Math.round(h) + ' 68% 62%)', words: d === 0 ? 'Today' : d === 1 ? '1 day ago' : d + ' days ago'}; }
  sourceLine(source, date, est) { if (!date) return ''; const f = this.freshTone(date); return '<span class="body-sel-src"><i style="background:' + f.colour + '" aria-hidden="true"></i>' + this.escape(source + (est ? ' (est)' : '')) + ' · ' + this.escape(this.date(date, true)) + ' · ' + f.words + '</span>'; }
  arrowHTML(now, prev, better, unit) { if (!Number.isFinite(now) || !Number.isFinite(prev)) return ''; const d = now - prev; if (Math.abs(d) < 0.3) return ''; const good = better === null ? null : (d < 0) === (better === 'down'); return ' <span class="body-arrow" style="color:' + (good === null ? 'var(--muted)' : good ? 'var(--c-green,#79d6a9)' : 'var(--c-orange,#f0a058)') + '">' + (d < 0 ? '↓' : '↑') + Math.abs(d).toFixed(1) + (unit ? ' ' + unit : '') + '</span>'; }
  selectionHTML() {
    const u = window.HealthDisplayUnits || {mass: 'lb', lb: v => v}, esc = v => this.escape(v), tier = window.HealthFatTier || (() => null);
    const line = (name, total, fat, muscle, base, source, date, est, prev) => {
      const pct = n => base > 0 ? (100 * n / base).toFixed(1) + '%' : '—', t = tier(base > 0 ? 100 * fat / base : null);
      return '<div class="body-sel" data-parity="BODY-26"><b class="body-sel-name">' + esc(name) + '</b><span class="body-sel-total"><strong>Total:</strong> ' + u.lb(total).toFixed(1) + ' ' + u.mass + '</span>' +
        '<span class="body-sel-fat"><strong style="color:' + (t ? t.colour : 'inherit') + '">Fat:</strong> <span style="color:' + (t ? t.colour : 'inherit') + '">' + u.lb(fat).toFixed(1) + ' ' + u.mass + ' | ' + pct(fat) + '</span>' + (prev ? this.arrowHTML(u.lb(fat), u.lb(prev.fat), 'down', u.mass) : '') + '</span>' +
        '<span class="body-sel-muscle" data-parity="BODY-27"><strong>Muscle:</strong> ' + u.lb(muscle).toFixed(1) + ' ' + u.mass + ' | ' + pct(muscle) + (prev ? this.arrowHTML(u.lb(muscle), u.lb(prev.muscle), 'up', u.mass) : '') + '</span>' + this.sourceLine(source, date, est) + '</div>';
    };
    const key = this.mode === 'link' && this.linked.size ? null : this.region;
    if (key === 'all' || !key && !this.linked.size) {
      const w = window.HealthWholeBody || {}, wt = w.weight, bf = w.bodyFat;
      if (wt && bf && Number.isFinite(wt.value) && Number.isFinite(bf.value)) {
        const lb = wt.unit === 'kg' ? wt.value / .45359237 : wt.value, fat = lb * bf.value / 100;
        return line('Whole Body', lb, fat, lb - fat, lb, wt.source || 'Apple Health', wt.date, false, null);
      }
      const p = window.GlowLearn && GlowLearn.partition(this.fitdays);
      return p && Number.isFinite(p.wholeFat) && Number.isFinite(p.wholeMuscle) ? line('Whole Body', p.weight, p.wholeFat, p.weight - p.wholeFat, p.weight, 'Fitdays', p.date, false, null) : '<div class="body-sel"><b class="body-sel-name">Whole Body</b><span class="hint">No weigh-in yet.</span></div>';
    }
    const parts = key ? this.partsInView(key) : [...this.linked], f = regionFigures(parts, this.fitdays), old = this.fitdays && this.fitdays.previous ? regionFigures(parts, this.fitdays.previous) : null;
    const custom = key && key.startsWith('custom:') ? this.saved.find(r => 'custom:' + r.id === key) : null, name = custom ? custom.name : parts.length > 1 ? (FITDAYS_GROUPS[key] ? FITDAYS_GROUPS[key].label : parts.length + ' Segments') : (this.regions[parts[0]] || FITDAYS_GROUPS[parts[0]]?.label || parts[0]);
    if (f.fat === null) return '<div class="body-sel"><b class="body-sel-name">' + esc(name) + '</b><span class="body-na">Not available at this segmentation</span></div>';
    return line(name, f.total, f.fat, f.muscle, f.total, 'Fitdays', this.fitdays.measurementDate, f.est || f.standIn.length > 0, old && old.fat !== null ? old : null);
  }
  regionChipsHTML() {
    const esc = v => this.escape(v), on = k => this.mode === 'select' ? this.region === k : this.mode === 'link' ? this.partsInView(k).every(p => this.linked.has(p)) && this.partsInView(k).length > 0 : this.compare.a === k ? 'a' : this.compare.b === k ? 'b' : false;
    const chip = (k, label) => { const s = on(k); return '<button type="button" class="body-rchip' + (s === 'a' ? ' slot-a' : s === 'b' ? ' slot-b' : '') + '" data-body="chip" data-region="' + esc(k) + '" aria-pressed="' + !!s + '">' + esc(label) + '</button>'; };
    const groups = this.fitdays ? Object.entries(FITDAYS_GROUPS).map(([k, g]) => chip(k, g.label)).join('') : '';
    const mine = this.saved.map(r => chip('custom:' + r.id, r.name)).join('');
    const segs = Object.entries(this.regions).sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => chip(k, n)).join('');
    return '<div class="body-rchips" data-parity="BODY-37">' + (groups ? '<div class="body-rgroup">' + groups + '</div>' : '') + (mine ? '<div class="body-rgroup">' + mine + '</div>' : '') + (segs ? '<div class="body-rgroup segs">' + segs + '</div>' : '') + '</div>';
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
        const custom = key && key.startsWith('custom:') ? new Set(this.partsInView(key)) : null;
        color = key === 'all' ? '#72a2a3' : (custom ? custom.has(n) : n === key) ? '#ddb864' : '#667d7d';
        if (this.fitdays && !custom) {
          const group = fitdaysGroup(n);
          const selected = key === 'all' || n === key || (FITDAYS_GROUPS[key] && group === key);
          color = selected && group ? FITDAYS_GROUPS[group].color : '#667d7d';
        }
      }
      material.pbrMetallicRoughness.setBaseColorFactor(color);
    }
  }
  /* The selection panel, the chips and the mode switch follow every pick (B3, B5). */
  refreshSide() {
    const sel = this.querySelector('.body-sel'); if (sel) { const t = document.createElement('template'); t.innerHTML = this.selectionHTML(); sel.replaceWith(t.content); }
    const chips = this.querySelector('.body-rchips'); if (chips) { const t = document.createElement('template'); t.innerHTML = this.regionChipsHTML(); chips.replaceWith(t.content); }
    const wb = this.querySelector('.body-rchip.wb'); if (wb) wb.setAttribute('aria-pressed', String(this.mode === 'select' && this.region === 'all'));
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
    if (this.mode === 'compare') { if (key === 'all') return; const slot = this.compare.next; this.compare[slot] = key; this.compare.next = slot === 'a' ? 'b' : 'a'; this.refreshTools(); return; }
    this.highlight(key);
  }
  /* Cmd-, Ctrl- or Shift-click on the model (V3.2): the segment joins what is selected, without choosing Link
     first. What was highlighted comes along, so two clicks make a region of two. */
  addToSelection(key) {
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
    viewer.setAttribute('camera-orbit', theta + 'deg 85deg ' + BODY_ZOOM.start + '%');
    viewer.setAttribute('camera-target', 'auto auto auto');
    viewer.setAttribute('field-of-view', '30deg');
    this.zoomPct = BODY_ZOOM.start;
    this.syncZoomControls();
  }

  syncZoomControls() {
    this.querySelectorAll('[data-body="zoom"]').forEach(button => {
      button.disabled = Number(button.dataset.direction) < 0 ? this.zoomPct <= BODY_ZOOM.min : this.zoomPct >= BODY_ZOOM.max;
    });
  }

  zoomModel(direction) {
    const viewer = this.querySelector('model-viewer');
    if (!viewer || typeof viewer.getCameraOrbit !== 'function') return;
    this.zoomPct = Math.max(BODY_ZOOM.min, Math.min(BODY_ZOOM.max, (this.zoomPct ?? BODY_ZOOM.start) + direction * BODY_ZOOM.step));
    const orbit = viewer.getCameraOrbit();
    const theta = Number.isFinite(orbit.theta) ? orbit.theta : 0, phi = Number.isFinite(orbit.phi) ? orbit.phi : 85 * Math.PI / 180;
    viewer.setAttribute('camera-orbit', theta + 'rad ' + phi + 'rad ' + this.zoomPct + '%');
    this.syncZoomControls();
  }

  render() {
    this.zoomPct = BODY_ZOOM.start;
    const record = this.stage || this.selected;
    const esc = value => this.escape(value);
    const icon = (body, label, extra, glyph) => '<button type="button" class="body-ibtn" data-body="' + body + '"' + (extra || '') + ' aria-label="' + label + '" title="' + label + '">' + glyph + '</button>';
    // V3.4 (B4): the options sit beside the model; the reference photo and the model stay side by side at one height, in
    // Full Screen too (the whole card goes full screen, panel and Add Report included); the capture date sits under the model.
    const weighIn = (window.HealthWholeBody || {}).weight, fd = this.fitdays, stale = !this.stage && fd && weighIn && weighIn.date && fd.measurementDate && fd.measurementDate < weighIn.date;
    const stageHTML = record ? '<div class="body-stage3">' +
        (!this.stage ? '<div class="body-side">' + this.selectionHTML() + this.regionHTML() + '</div>' : '') +
        '<div class="body-pane"><div class="body-angles k-seg" role="group" aria-label="Model angle" data-parity="BODY-31">' + ['Front','Back','Left','Right'].map(name => '<button data-body="angle" data-angle="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div>' +
        '<div class="body-model-row"><div class="body-model-stage"><model-viewer class="body-model" src="' + this.asset(!this.stage && Object.keys(this.regions).length ? 'regions.glb' : 'model.glb') + '" alt="Approximate body model. Drag to rotate; the wheel zooms within limits, then scrolls the page." camera-controls disable-zoom touch-action="pan-y" camera-orbit="0deg 85deg '+BODY_ZOOM.start+'%" field-of-view="30deg" min-camera-orbit="auto auto '+BODY_ZOOM.min+'%" max-camera-orbit="auto auto '+BODY_ZOOM.max+'%" interaction-prompt="none" shadow-intensity="0.4" exposure="1"></model-viewer><span class="body-load" role="status">Loading 3D view…</span>'+(!this.stage ? '<div class="body-region-overlay" aria-live="polite"></div>' : '')+'</div>' +
        '<div class="body-angle-controls" aria-label="Model viewing controls">' + icon('zoom', 'Zoom in', ' data-direction="-1"', '＋') + icon('zoom', 'Zoom out', ' data-direction="1"', '－') + icon('angle', 'Reset view', ' data-angle="Reset view"', '⟲') + icon('fullscreen', 'Full screen', ' aria-pressed="false"', '⛶') +
        '<details class="body-help icon"><summary aria-label="About model controls" title="About model controls">ⓘ</summary><p class="hint">Drag to rotate. The wheel zooms inside its limits; at a limit, after a short pause, it scrolls the page. Front, Back, Left and Right turn the model and the photo together; Reset returns both to Front. Solid-colour model; skin is in the reference photos. ' + (record.variant === 'reconstructed-reference' ? 'Reconstructed reference: shape and hidden skin details may be estimated. ' : '') + 'This view does not measure body fat, muscle or circumferences.</p></details></div>' + '<div class="body-photos" data-parity="BODY-34"><span class="body-photo-badge">Reference Photo</span><a class="body-photo-link" href="' + this.asset(this.photo + '.png') + '" target="_blank" rel="noopener" title="Open full-size image"><img class="body-reference" src="' + this.asset(this.photo + '.png') + '" alt="' + this.photo + ' reference image"></a><div class="body-photo-tabs" role="group" aria-label="Reference image" hidden>' + ['Front','Back','Left','Right'].map(name => '<button data-body="photo" data-photo="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div>' + '</div>' +
        (stale ? '<p class="body-stale" data-parity="BODY-39">A newer weigh-in has no segment report yet</p>' : '') +
        (!this.stage ? '<button type="button" class="k-btn body-add-report" data-body="addReport" data-parity="BODY-38">＋ Add Report</button>' : '') +
        '<p class="body-captured">Model captured ' + esc(this.date(record.captureDate, true)) + '</p></div>' +
        '</div></div>' : '';
    this.innerHTML = '<section class="panelcard body-record-card" aria-label="Your body records">' +
      '<p class="body-status hint" role="status" aria-live="polite"></p>' +
      (record ? (this.stage ? '<div class="body-record-heading"><h3>' + esc(this.date(record.captureDate)) + '</h3><span class="chip quiet">Import preview · not saved</span></div><div class="body-review"><label>Reference type<select data-body="variant" aria-label="Reference type"><option value="reconstructed-reference">Reconstructed reference</option><option value="original-photo-reference">Original-photo reference</option></select></label><p class="hint">One model and four reference images checked. Review the date, views and reference type before saving.</p><div class="acts"><button class="primary" data-body="save">Save body record</button><button data-body="cancel">Cancel import</button></div></div>' : '') +
        stageHTML + (!this.stage ? '<div class="body-report-sheet" hidden></div>' : '') +
        (!this.stage ? '<details class="body-more"><summary>More · records, Fitdays detail, measurements, export</summary>' +
          '<div class="body-more-row"><span class="cap" data-parity="BODY-43">Private on this Mac</span><label class="filebtn body-import">Import body record<input type="file" accept=".zip,application/zip" aria-label="Import body record ZIP" data-body="file"></label>' +
          (this.records.length ? '<label class="body-record-label">Choose a dated view<select data-body="record" aria-label="Saved body record">' + this.records.map(r => '<option value="' + r.id + '"' + (r.id === this.selected?.id ? ' selected' : '') + '>' + esc(this.date(r.captureDate) + ' · ' + r.variantLabel) + '</option>').join('') + '</select></label>' : '') + '</div>' +
          '<div data-parity="BODY-40">' + this.compositionHTML() + '</div><div data-parity="BODY-42">' + this.measurementHTML() + '</div>' +
          '<div class="acts" data-parity="BODY-44"><a class="body-export" href="' + this.asset('export.zip') + '" download>Export model + four images</a></div><p class="hint body-limitation" data-parity="BODY-45">' + (record.variant === 'reconstructed-reference' ? 'Reconstructed reference: shape and hidden skin details may be estimated. ' : 'Original-photo references with an approximate generated model. ') + 'This view does not measure body fat, muscle or circumferences.</p></details>' : '')
      : '<div class="body-empty"><details class="body-help inline"><summary aria-label="About your body view">ⓘ</summary><p class="hint">Your 3D model, its four reference photos and your Fitdays reports stay on this Mac. Import the ZIP the body tool makes; you review it before it is saved.</p></details><h3>Keep a dated view of your body</h3><p>Import a ZIP containing your 3D model, its details and four reference images.</p><label class="filebtn body-import">Import body record<input type="file" accept=".zip,application/zip" aria-label="Import body record ZIP" data-body="file"></label></div>') + '</section>';
    const viewer = this.querySelector('model-viewer');
    if (viewer) {
      viewer.addEventListener('load', () => { const label = this.querySelector('.body-load'); if (label) label.hidden = true; if (this.mode === 'select') this.highlight(this.region); else this.refreshTools(); });
      viewer.addEventListener('camera-change', () => {
        const quarter = Math.round(viewer.getCameraOrbit().theta / (Math.PI / 2));
        const angle = ['Front', 'Right', 'Back', 'Left'][((quarter % 4) + 4) % 4];
        if (this.photo !== angle) this.showPhoto(angle);
      });
      this.showPhoto(this.photo);
      viewer.addEventListener('error', () => { const label = this.querySelector('.body-load'); if (label) label.textContent = 'The 3D view could not load. Your saved files are available through Export.'; });
      viewer.addEventListener('pointerdown', event => { this.pointerStart = [event.clientX, event.clientY]; });
      viewer.addEventListener('click', event => {
        if (!this.pointerStart || Math.hypot(event.clientX-this.pointerStart[0],event.clientY-this.pointerStart[1]) > 5) return;
        const material = viewer.materialFromPoint(event.clientX, event.clientY);
        if (!material || !this.regions[material.name]) return;
        if ((event.metaKey || event.ctrlKey || event.shiftKey) && this.mode !== 'compare') this.addToSelection(material.name); else this.pick(material.name);
      });
      this.wheelZoom(this.querySelector('.body-model-stage'));
    }
  }
  /* V3.4 (B4): the wheel zooms inside the limits. At a limit it hands the wheel to the page, but only after the wheel has
     been quiet for 250 ms, so trackpad momentum from the zoom cannot throw the page (the kit's zoomWithHandoff). */
  wheelZoom(el) {
    if (!el) return; let last = 0, latched = false;
    el.addEventListener('wheel', event => {
      const now = performance.now(); if (now - last > 250) latched = false; last = now;
      const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY, z = this.zoomPct ?? BODY_ZOOM.start, atLimit = (z <= BODY_ZOOM.min && dy < 0) || (z >= BODY_ZOOM.max && dy > 0);
      if (!atLimit) { event.preventDefault(); latched = true; this.setZoom(z * Math.exp(dy * 0.0022)); }
      else if (latched) event.preventDefault();
    }, {passive: false});
  }
  setZoom(pct) {
    const viewer = this.querySelector('model-viewer'); if (!viewer || typeof viewer.getCameraOrbit !== 'function') return;
    this.zoomPct = Math.max(BODY_ZOOM.min, Math.min(BODY_ZOOM.max, pct));
    const orbit = viewer.getCameraOrbit(), theta = Number.isFinite(orbit.theta) ? orbit.theta : 0, phi = Number.isFinite(orbit.phi) ? orbit.phi : 85 * Math.PI / 180;
    viewer.setAttribute('camera-orbit', theta + 'rad ' + phi + 'rad ' + this.zoomPct + '%');
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
    const picture = pdf ? '<div class="rep-pdf">PDF · ' + this.escape(file.name) + '</div>' : '<img alt="The report you chose" src="data:' + (file.type || 'image/png') + ';base64,' + base64 + '">';
    box.innerHTML = '<p class="hint">Reading the report on this Mac…</p>';
    let values = null;
    if (window.HealthNativeRequest && BODY_TRANSPORT) {
      try { const reply = await window.HealthNativeRequest('readReport', {base64}); if (reply && reply.ok && Array.isArray(reply.lines)) values = parseFitdaysReport(reply.lines); } catch (_) { values = null; }
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
      const card = this.querySelector('.body-record-card'), doc = document, active = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (active) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
      if (card.classList.contains('body-full')) { card.classList.remove('body-full'); this.fullListener?.(); return; }
      const viewer = this.querySelector('model-viewer'), orbit = viewer?.getCameraOrbit?.(); this.savedZoomPct = this.zoomPct;
      this.savedOrbit = orbit ? orbit.theta + 'rad ' + orbit.phi + 'rad ' + this.savedZoomPct + '%' : null;
      const go = card.requestFullscreen || card.webkitRequestFullscreen;
      if (go) { try { await go.call(card); } catch (_) { card.classList.add('body-full'); } } else card.classList.add('body-full');
      if (!this.fullListener) { this.fullListener = () => { const on = !!(document.fullscreenElement || document.webkitFullscreenElement) || card.classList.contains('body-full'); const b = this.querySelector('[data-body="fullscreen"]'); if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Exit full screen' : 'Full screen'; } if (!on) { const v = this.querySelector('model-viewer'); if (v && this.savedOrbit) { v.cameraOrbit = this.savedOrbit; this.zoomPct = this.savedZoomPct; this.syncZoomControls(); } this.highlight(this.region); } }; document.addEventListener('fullscreenchange', this.fullListener); document.addEventListener('webkitfullscreenchange', this.fullListener); this.keyListener = e => { if (e.key === 'Escape' && card.classList.contains('body-full')) { card.classList.remove('body-full'); this.fullListener(); } }; document.addEventListener('keydown', this.keyListener); }
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
      const key = button.dataset.region; if (key === 'all') { if (this.mode !== 'select') { this.mode = 'select'; this.linked.clear(); } this.region = 'all'; this.refreshTools(); return; }
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
