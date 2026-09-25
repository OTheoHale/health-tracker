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
   forearm + hand 2.23% of body mass; thigh 14.16%, shank 4.33%, foot 1.37%. Always labelled "est.". */
const SEGMENT_SHARE = {'upper-arm': 0.549, forearm: 0.451, thigh: 0.713, calf: 0.218, foot: 0.069};
const segmentShare = region => { const key = Object.keys(SEGMENT_SHARE).find(k => region.endsWith(k)); return key ? SEGMENT_SHARE[key] : null; };
const fitdaysGroup = region => Object.keys(FITDAYS_GROUPS).find(key => key === region || FITDAYS_GROUPS[key].parts.includes(region));
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
          '<span><b>' + row.fatMassLb.toFixed(1) + ' lb</b> fat</span>' +
          '<span><b>' + row.muscleBalanceMassLb.toFixed(1) + ' lb</b> muscle</span></div>').join('') +
        '</div>';
    }
    const readings = (snap && snap.measurements && snap.measurements.readings) || [];
    if (readings.length) {
      html += '<details class="body-composition-details"><summary>Measurements</summary><table><tbody>' +
        readings.map(r => '<tr><td>' + esc(r.label || r.id || '') + '</td><td>' + esc(String(r.value ?? '')) + (r.unit ? ' ' + esc(r.unit) : '') + '</td></tr>').join('') +
        '</tbody></table></details>';
    }
    this.innerHTML = html + note + '</section>';
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

  regionHTML() {
    const groups = this.fitdays ? '<optgroup label="Fitdays whole regions">' + Object.entries(FITDAYS_GROUPS).map(([key,group]) => '<option value="'+key+'">'+group.label+'</option>').join('') + '</optgroup>' : '';
    return '<div class="body-segments"><label>Highlight a region<select data-body="region" aria-label="Highlight a body region"><option value="all">Whole body</option>' + groups + '<optgroup label="Detailed viewing regions">' + Object.entries(this.regions).map(([key,name]) => '<option value="'+key+'">'+this.escape(name)+'</option>').join('') + '</optgroup></select></label><p class="hint">Click the model or choose a region. Boundaries are approximate viewing guides. Left and right refer to your body.</p></div>';
  }

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
    return '<section class="body-composition" aria-label="Fitdays regional composition"><h3>Fat &amp; muscle by region</h3><p class="hint">Fitdays · '+this.escape(this.date(report.measurementDate))+' '+this.escape(report.measurementTime || '')+' · report timezone not specified. No other source measures individual regions, so these stay on the Fitdays date'+(report.measurementDate !== this.selected.captureDate ? ', shown on your '+this.escape(this.date(this.selected.captureDate))+' model' : '')+'. Fitdays-reported estimates; segment fat is inferred, and colors identify regions rather than showing fat inside your body.</p><div class="body-composition-cards">'+this.fitdays.segments.map(row => '<button data-body="composition-region" data-region="'+row.id+'" aria-pressed="false" style="--region-color:'+FITDAYS_GROUPS[row.id].color+'"><strong><i aria-hidden="true"></i>'+row.label+'</strong><span><b>'+row.fatMassLb.toFixed(1)+' lb</b> fat</span><span><b>'+row.muscleBalanceMassLb.toFixed(1)+' lb</b> muscle</span></button>').join('')+'</div><p class="hint">Whole-arm, whole-leg and trunk totals. Smaller regions do not have separate measurements in this report.</p><details class="body-composition-details"><summary>Report details & comparison percentages</summary><p class="hint">These percentages compare with the Fitdays standard range. They are not regional body-fat percentages or shares of your total. Transcribed from the saved report image.</p><table><thead><tr><th>Region</th><th>Fat comparison</th><th>Muscle comparison</th></tr></thead><tbody>'+this.fitdays.segments.map(row=>'<tr><td>'+row.label+'</td><td>'+row.fatComparisonPercent.toFixed(1)+'%</td><td>'+row.muscleComparisonPercent.toFixed(1)+'%</td></tr>').join('')+'</tbody></table><p><a class="body-export" href="'+this.asset('fitdays-source.jpg')+'" target="_blank" rel="noopener">View original Fitdays report ↗</a></p><p><a class="body-export" href="'+this.asset('fitdays-export.zip')+'" download>Export Fitdays report + values</a></p><label class="filebtn body-import">Add another reviewed Fitdays report<input data-body="fitdays" type="file" accept=".zip" aria-label="Add reviewed Fitdays report ZIP"></label><p class="hint">Fitdays reports are saved separately from your model, photos and HealthAutoExport source.</p></details></section>';
  }

  measurementHTML() {
    const esc = value => this.escape(value);
    const readings = this.measurements.readings || [];
    return '<details class="body-measurements" open><summary>Body measurements from your export</summary><label class="filebtn body-import">Add HealthAutoExport file<input data-body="measurements" type="file" accept=".zip,.csv" aria-label="Add HealthAutoExport body measurements"></label>' +
      '<p class="hint">' + (this.measurements.source ? esc(this.measurements.sourceFile) + ' · ' + readings.length + ' body readings' : 'No body-measurement export linked yet.') + '</p>' +
      (this.measurements.coverageStart ? '<p class="hint">Export coverage: '+esc(this.measurements.coverageStart)+' – '+esc(this.measurements.coverageEnd)+'. These dates may differ from the model capture date.</p>' : '') +
      '<div class="body-readings">' + (readings.length ? readings.slice(-30).map(r=>'<p><b>'+esc(r.label)+': '+esc(r.value)+' '+esc(r.unit)+'</b><br><span class="hint">'+esc(r.region === 'whole-body' ? 'Whole body' : r.region)+' · '+esc(r.recordedAt)+' · HealthAutoExport</span></p>').join('') : '<p>Weight, body fat and lean body mass: <b>Not available in this HealthAutoExport file</b></p>') + '</div><p class="hint">Regional fat and muscle: Not available in this HealthAutoExport file. Whole-body values are not assigned to individual limbs.</p>' +
      (this.measurements.source ? '<a class="body-export" href="'+this.asset('measurements.json')+'" download="body-measurement-source.json">Export measurement source details</a>' : '') + '</details>';
  }

  highlight(key) {
    this.region = key;
    const select = this.querySelector('[data-body="region"]'); if (select) select.value = key;
    const viewer = this.querySelector('model-viewer');
    const groupKey = fitdaysGroup(key);
    this.querySelectorAll('[data-body="composition-region"]').forEach(el => el.setAttribute('aria-pressed', el.dataset.region === groupKey));
    if (viewer?.model && !this.stage) {
      for (const material of viewer.model.materials) {
        let color = key === 'all' ? '#72a2a3' : material.name === key ? '#ddb864' : '#667d7d';
        if (this.fitdays) {
          const group = fitdaysGroup(material.name);
          const selected = key === 'all' || material.name === key || (FITDAYS_GROUPS[key] && group === key);
          color = selected && group ? FITDAYS_GROUPS[group].color : '#667d7d';
        }
        material.pbrMetallicRoughness.setBaseColorFactor(color);
      }
    }
    const overlay = this.querySelector('.body-region-overlay');
    if (overlay) {
      overlay.replaceChildren();
      const title = document.createElement('strong'); title.textContent = this.regions[key] || FITDAYS_GROUPS[key]?.label || 'Whole body'; overlay.append(title);
      const detail = document.createElement('span');
      if (this.fitdays) {
        const row = this.fitdays.segments.find(item => item.id === groupKey);
        if (key === 'all') detail.textContent = 'Five colored regions · select a region to inspect its fat and muscle totals.';
        else if (row && key !== groupKey && segmentShare(key) !== null) { const f = segmentShare(key); detail.textContent = 'est. ' + (row.fatMassLb * f).toFixed(1) + ' lb fat · est. ' + (row.muscleBalanceMassLb * f).toFixed(1) + ' lb muscle · ' + Math.round(f * 100) + '% of the ' + row.label.toLowerCase() + ' (' + row.fatMassLb.toFixed(1) + ' / ' + row.muscleBalanceMassLb.toFixed(1) + ' lb), by typical segment mass'; }
        else if (row) detail.textContent = (key === groupKey ? 'Whole region' : row.label + ' total — not a separate ' + this.regions[key].toLowerCase() + ' measurement') + ': ' + row.fatMassLb.toFixed(1) + ' lb fat · ' + row.muscleBalanceMassLb.toFixed(1) + ' lb muscle';
        else detail.textContent = 'No separate head / neck composition data in this report.';
        overlay.append(detail);
        const source = document.createElement('span'); source.className = 'body-overlay-source'; source.textContent = 'Fitdays estimates · ' + this.date(this.fitdays.measurementDate) + ' · segment fat inferred'; overlay.append(source);
        return;
      }
      const matches = (this.measurements.readings || []).filter(r => key === 'all' ? r.region === 'whole-body' : r.region === key || (key === 'abdomen' && r.region === 'waist'));
      if (matches.length) {
        const latest = new Map();
        for (const row of matches) if (!latest.has(row.metric) || row.recordedAt > latest.get(row.metric).recordedAt) latest.set(row.metric, row);
        detail.textContent = [...latest.values()].map(row => row.label + ': ' + row.value + ' ' + row.unit + ' · ' + row.recordedAt).join(' | ') + ' · Export reported';
      } else detail.textContent = key === 'all' ? 'Body measurements: not available' : 'Regional fat / muscle: not available';
      overlay.append(detail);
    }
  }

  escape(value) {
    const span = document.createElement('span'); span.textContent = String(value ?? ''); return span.innerHTML;
  }

  date(value) {
    return new Date(value + 'T12:00:00').toLocaleDateString(undefined, {month:'long', day:'numeric', year:'numeric'});
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
    viewer.setAttribute('camera-orbit', theta + 'deg 85deg 115%');
    viewer.setAttribute('camera-target', 'auto auto auto');
    viewer.setAttribute('field-of-view', '30deg');
  }

  render() {
    const record = this.stage || this.selected;
    const esc = value => this.escape(value);
    this.innerHTML = '<section class="panelcard body-record-card" aria-label="Your body records">' +
      '<div class="ph"><div><p class="cap">Private on this Mac</p><h2>Your body view</h2></div><label class="filebtn body-import">Import body record<input type="file" accept=".zip,application/zip" aria-label="Import body record ZIP" data-body="file"></label></div>' +
      '<p class="body-status hint" role="status" aria-live="polite"></p>' +
      (this.records.length && !this.stage ? '<label class="body-record-label">Saved record<select data-body="record" aria-label="Saved body record">' + this.records.map(r => '<option value="' + r.id + '"' + (r.id === this.selected?.id ? ' selected' : '') + '>' + esc(this.date(r.captureDate) + ' · ' + r.variantLabel) + '</option>').join('') + '</select></label>' : '') +
      (record ? '<div class="body-record-heading"><h3>' + esc(this.date(record.captureDate)) + '</h3><span class="chip quiet">' + (this.stage ? 'Import preview · not saved' : esc(record.variantLabel)) + '</span></div>' +
        (!this.stage ? this.compositionHeadingHTML() : '') +
        (this.stage ? '<div class="body-review"><label>Reference type<select data-body="variant" aria-label="Reference type"><option value="reconstructed-reference">Reconstructed reference</option><option value="original-photo-reference">Original-photo reference</option></select></label><p class="hint">One model and four reference images checked. Review the date, views and reference type before saving.</p><div class="acts"><button class="primary" data-body="save">Save body record</button><button data-body="cancel">Cancel import</button></div></div>' : '') +
        // Model and reference image side by side (Mintay, 2026-09-24); the image follows the model's angle.
        '<div class="body-pair"><div class="body-pane">' +
        '<div class="body-model-stage"><model-viewer class="body-model" src="' + this.asset(!this.stage && Object.keys(this.regions).length ? 'regions.glb' : 'model.glb') + '" alt="Approximate body model. Drag to rotate; scroll to zoom." camera-controls camera-orbit="0deg 85deg 115%" field-of-view="30deg" min-camera-orbit="auto auto 20%" max-camera-orbit="auto auto 250%" interaction-prompt="none" shadow-intensity="0.4" exposure="1"></model-viewer><span class="body-load" role="status">Loading 3D view…</span>'+(!this.stage ? '<div class="body-region-overlay" aria-live="polite"></div>' : '')+'</div>' +
        '<div class="body-angle-controls" aria-label="Model viewing angle">' + ['Front','Back','Left','Right','Reset view'].map(name => '<button data-body="angle" data-angle="' + name + '">' + name + '</button>').join('') + '<button data-body="fullscreen" aria-pressed="false">Full screen</button></div><p class="hint">Drag to rotate · scroll to zoom. The photo follows the nearest angle; Reset returns both to Front. Solid-color model; skin is shown in the reference images.</p></div>' +
        '<div class="body-pane body-photos"><p class="cap">Reference image</p><div class="body-photo-tabs" role="group" aria-label="Reference image">' + ['Front','Back','Left','Right'].map(name => '<button data-body="photo" data-photo="' + name + '" aria-pressed="' + (name === this.photo) + '">' + name + '</button>').join('') + '</div><a class="body-photo-link" href="' + this.asset(this.photo + '.png') + '" target="_blank" rel="noopener"><img class="body-reference" src="' + this.asset(this.photo + '.png') + '" alt="' + this.photo + ' reference image"><span>Open full-size image ↗</span></a></div></div>' +
        (!this.stage ? this.regionHTML() : '') +
        (!this.stage ? this.compositionHTML() : '') +
        (!this.stage ? this.measurementHTML() : '') +
        '<p class="hint body-limitation">' + (this.stage || record.variant === 'reconstructed-reference' ? 'Reconstructed reference: shape and hidden skin details may be estimated. ' : 'Original-photo references with an approximate generated model. ') + 'This view does not measure body fat, muscle or circumferences.</p>' +
        (!this.stage ? '<div class="acts"><a class="body-export" href="' + this.asset('export.zip') + '" download>Export model + four images</a><span class="hint">Saved locally · available after reopening</span></div>' : '') :
        // Imported whole-body figures do not depend on a 3D model, so they are shown here too
        // rather than waiting behind an import the numbers never needed.
        this.compositionHeadingHTML() + '<div class="body-empty"><h3>Keep a dated view of your body</h3><p>Import a ZIP containing your 3D model, its details and four reference images.</p><p class="hint">You can review everything before saving. Your existing activity records are kept separate.</p></div>') + '</section>';
    const viewer = this.querySelector('model-viewer');
    if (viewer) {
      viewer.addEventListener('load', () => { const label = this.querySelector('.body-load'); if (label) label.hidden = true; this.highlight(this.region); });
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
        if (material && this.regions[material.name]) this.highlight(material.name);
      });
    }
  }

  async changeAction(event) {
    const control = event.target;
    if (this.busy) return;
    if (control.dataset.body === 'record') {
      this.selected = this.records.find(record => record.id === control.value); this.photo = 'Front'; await this.loadRegionData(); this.render();
    }
    if (control.dataset.body === 'region') this.highlight(control.value);
    if (control.dataset.body === 'fitdays' && control.files.length) {
      this.busy = true; this.disable(true); this.status('Checking the Fitdays report and original image…');
      try {
        const result = await this.request('fitdays/' + this.selected.id, control.files[0]);
        this.fitdays = result.report; this.region = 'all'; this.photo = 'Front'; this.render();
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
    } else if (action === 'fullscreen') {
      const card = this.querySelector('.body-record-card'), doc = document, active = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (active) { (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc); return; }
      const viewer = this.querySelector('model-viewer'); this.savedOrbit = viewer && viewer.getCameraOrbit ? viewer.getCameraOrbit().toString() : null;
      const go = card.requestFullscreen || card.webkitRequestFullscreen;
      if (go) { try { await go.call(card); } catch (_) { card.classList.add('body-full'); } } else card.classList.add('body-full');
      if (!this.fullListener) { this.fullListener = () => { const on = !!(document.fullscreenElement || document.webkitFullscreenElement) || card.classList.contains('body-full'); const b = this.querySelector('[data-body="fullscreen"]'); if (b) { b.setAttribute('aria-pressed', String(on)); b.textContent = on ? 'Exit full screen' : 'Full screen'; } if (!on) { const v = this.querySelector('model-viewer'); if (v && this.savedOrbit) v.cameraOrbit = this.savedOrbit; this.highlight(this.region); } }; document.addEventListener('fullscreenchange', this.fullListener); document.addEventListener('webkitfullscreenchange', this.fullListener); this.keyListener = e => { if (e.key === 'Escape' && card.classList.contains('body-full')) { card.classList.remove('body-full'); this.fullListener(); } }; document.addEventListener('keydown', this.keyListener); }
      this.fullListener();
    } else if (action === 'composition-region') {
      this.highlight(button.dataset.region);
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
