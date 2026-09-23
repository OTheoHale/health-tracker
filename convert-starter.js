#!/usr/bin/env node
'use strict';

/* Shared pure converter: the Node CLI and the local app use the same mapping. */
const inNode = typeof module !== 'undefined' && !!module.exports;
const fs = inNode ? require('node:fs') : null;
const path = inNode ? require('node:path') : null;
const METRICS = {stepCount:'steps',activeEnergyBurned:'activeEnergy',restingHeartRate:'restingHeartRate'};
const BASE_FIELDS = ['metric','kind','start_time_ms','start_time_local','end_time_ms','end_time_local','source_name','source_bundle_identifier','unit_reported_by_tool','source_record_id','source_record_id_status','record_representation','quality_flags'];
const SYNTHETIC_FLAGS = ['syntheticPreview','syntheticWorkspace'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const present = x => x !== undefined && x !== null;
const previewMarked = value => object(value)&&[value,value.unmapped,value.starter,value.unmapped?.starter].some(meta=>object(meta)&&SYNTHETIC_FLAGS.some(key=>meta[key]===true));
function dateValid(s){
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && +s.slice(0,4) >= 1000 && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}
function instant(s){
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  if (!m || !dateValid(m[1]) || +m[2] > 23 || +m[3] > 59 || +m[4] > 59 || +m[8] > 14 || +m[9] > 59 || (+m[8] === 14 && +m[9] !== 0)) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return {text:s,ms,offset:m[6] === 'Z' ? 0 : (m[7] === '-' ? -1 : 1) * (+m[8]*60 + +m[9])};
}
function convertStarter(input, window){
  if (!object(input) || input.format !== 'personal-health-json-starter' || input.schema_version !== '1.0') throw new Error('Expected personal-health-json-starter schema_version 1.0.');
  if (!window || !dateValid(window.from) || !dateValid(window.to) || window.from > window.to) throw new Error('Choose a valid inclusive --from / --to date window.');
  for (const key of ['measurements','workouts']) if (input[key] !== undefined && !Array.isArray(input[key])) throw new Error(key + ' must be an array when present.');
  for(const key of SYNTHETIC_FLAGS)if(present(input[key])&&typeof input[key]!=='boolean')throw new Error(key+' must be an explicit boolean when present.');
  const syntheticPreview=previewMarked(input);
  const selected = {from:window.from,to:window.to};
  const report = {
    format:'health-tracker-starter-conversion-review',version:1,window:selected,
    windowPolicy:'Whole intervals within recorded local calendar dates; end is exclusive. UTC is used only when the local timestamp is absent. Partial intervals are excluded, never clipped or prorated.',
    coverage:'Selected conversion scope, not proof of complete retrieval. Missing metrics remain unknown.',
    counts:{measurements:(input.measurements || []).length,workouts:(input.workouts || []).length,converted:0,unsupported:0,outsideWindow:0,partialWindow:0,invalid:0},
    excludedTopLevel:Object.keys(input).filter(k=>!['format','schema_version','measurements','workouts',...SYNTHETIC_FLAGS].includes(k)).map(field=>({field,count:Array.isArray(input[field]) ? input[field].length : null})),
    omittedFields:[],issues:[],
    limitations:[
      'The local-file app review uses the source-local calendar dates recorded in the starter; its window is still selected scope, not proof of complete retrieval.',
      'The app determines local-file transport from the picker; a file-supplied relay label is not trusted as the route.',
      'Null IDs stay null. The app derives identity from kind, writer label, type, timestamp strings, value and unit; identical rows may collapse and differing values at the same interval are held aside.',
      'The app rounds reported workout duration to seconds; the original duration_sec is retained in starter provenance.',
      'Pre-aggregated buckets are not raw samples, independent events or verified daily totals. No cross-writer or cross-bucket total is calculated.'
    ]
  };
  const relay = {format:'health-tracker-relay',version:1,source:'personal-health-json-starter',relayedBy:'local-converter',retrievedAt:null,window:selected,records:[],...(syntheticPreview?{syntheticPreview:true}:{})};
  function issue(rowPath,status,code){ report.issues.push({path:rowPath,status,code}); }
  function omitted(rowPath,fields){ if (fields.length) report.omittedFields.push({path:rowPath,fields}); }
  function fail(code){ const e = new Error(code); e.code = code; throw e; }
  function timestamp(row,prefix,rowPath){
    const local = row[prefix+'_time_local'], epoch = row[prefix+'_time_ms'];
    if (!present(local) && !present(epoch)) return null;
    if (present(epoch) && (!Number.isSafeInteger(epoch) || !Number.isFinite(new Date(epoch).getTime()))) fail(prefix+'_epoch_invalid');
    if (present(local)){
      const value = instant(local);
      if (!value) fail(prefix+'_offset_timestamp_invalid');
      if (present(epoch) && value.ms !== epoch) fail(prefix+'_timestamp_mismatch');
      return value;
    }
    const text = new Date(epoch).toISOString();
    if (!dateValid(text.slice(0,10))) fail(prefix+'_year_unsupported');
    issue(rowPath,'warning',prefix+'_utc_from_epoch');
    return {text,ms:epoch,offset:0};
  }
  function quantity(value,rowPath){
    if (value === null) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (!object(value)) fail('workout_quantity_invalid');
    omitted(rowPath,Object.keys(value).filter(k=>!['value','unit','unit_reported_by_tool'].includes(k)));
    if (!Object.hasOwn(value,'value') || (value.value !== null && (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0))) fail('workout_quantity_value_invalid');
    const out = {value:value.value};
    for (const key of ['unit','unit_reported_by_tool']) if (Object.hasOwn(value,key)){
      if (value[key] !== null && typeof value[key] !== 'string') fail('workout_quantity_unit_invalid');
      out[key] = value[key];
    }
    return out;
  }
  function convert(row,index,collection){
    const rowPath = collection + '[' + index + ']';
    try {
      if (!object(row)) fail('record_not_object');
      const workout = collection === 'workouts';
      for (const key of ['metric','kind']) if (present(row[key]) && typeof row[key] !== 'string') fail(key+'_invalid');
      const metric = present(row.metric) ? row.metric : row.kind;
      const kind = workout ? 'workout' : (typeof metric === 'string' && Object.hasOwn(METRICS,metric) ? METRICS[metric] : null);
      if (!kind){ report.counts.unsupported++; issue(rowPath,'unsupported','metric_not_in_pilot_allowlist'); return; }
      if (!workout && typeof row.kind === 'string' && Object.hasOwn(METRICS,row.kind) && METRICS[row.kind] !== kind) fail('metric_kind_conflict');
      const allowed = BASE_FIELDS.concat(SYNTHETIC_FLAGS,workout ? ['activity','duration_sec','energy','distance'] : ['value']);
      omitted(rowPath,Object.keys(row).filter(k=>!allowed.includes(k)));
      const original = {};
      for (const key of allowed){
        if (!Object.hasOwn(row,key)) continue;
        if(SYNTHETIC_FLAGS.includes(key)){if(present(row[key])&&typeof row[key]!=='boolean')fail(key+'_invalid');original[key]=row[key];continue;}
        if (['energy','distance'].includes(key)){ original[key] = quantity(row[key],rowPath+'.'+key); continue; }
        if (key === 'quality_flags'){
          if (row[key] !== null && (!Array.isArray(row[key]) || row[key].some(v=>typeof v !== 'string'))) fail('quality_flags_invalid');
          original[key] = row[key] === null ? null : row[key].slice(); continue;
        }
        if (['value','duration_sec','start_time_ms','end_time_ms'].includes(key)){
          if (row[key] !== null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]))) fail(key+'_invalid');
        } else if (row[key] !== null && typeof row[key] !== 'string') fail(key+'_invalid');
        original[key] = row[key];
      }
      if (!workout && (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0)) fail('measurement_value_invalid');
      if (workout && present(row.duration_sec) && row.duration_sec < 0) fail('duration_negative');
      const writer = present(row.source_name) && row.source_name.trim() ? row.source_name : (present(row.source_bundle_identifier) && row.source_bundle_identifier.trim() ? row.source_bundle_identifier : 'unknown');
      if (writer.trim().length > 60) fail('source_label_exceeds_relay_limit');
      const type = workout ? row.activity ?? null : row.record_representation ?? null;
      if (type && type.length > 60) fail('type_exceeds_relay_limit');
      const start = timestamp(row,'start',rowPath), end = timestamp(row,'end',rowPath);
      if (!start) fail('start_missing');
      if (end && end.ms < start.ms) fail('end_precedes_start');
      const bucket = row.record_representation === 'pre_aggregated_quantity_bucket';
      if (bucket && (!end || end.ms <= start.ms)) fail('bucket_requires_positive_interval');
      const first = start.text.slice(0,10);
      const last = end && end.ms > start.ms ? new Date(end.ms - 1 + end.offset*60000).toISOString().slice(0,10) : first;
      if (first > selected.to || last < selected.from){ report.counts.outsideWindow++; issue(rowPath,'outsideWindow','outside_selected_dates'); return; }
      if (first < selected.from || last > selected.to){ report.counts.partialWindow++; issue(rowPath,'partialWindow','whole_interval_crosses_selected_dates'); return; }
      if (!row.source_record_id) issue(rowPath,'warning','provider_id_unknown');
      if (!present(row.unit_reported_by_tool) && !workout) issue(rowPath,'warning','unit_unknown');
      if (!present(row.record_representation)) issue(rowPath,'warning','representation_unknown');
      if (workout && Number.isFinite(row.duration_sec) && !Number.isInteger(row.duration_sec)) issue(rowPath,'warning','app_rounds_duration_original_retained');
      if (bucket) issue(rowPath,'warning','pre_aggregated_bucket_not_raw_sample');
      const previewRecord=syntheticPreview||previewMarked(row);if(previewRecord)relay.syntheticPreview=true;
      relay.records.push({kind,sourceApp:writer,sourceRecordId:row.source_record_id || null,type,start:start.text,end:end ? end.text : null,...(previewRecord?{syntheticPreview:true}:{}),
        value:workout ? null : row.value,unit:row.unit_reported_by_tool ?? null,durationSec:workout ? row.duration_sec ?? null : null,device:null,
        starter:{format:input.format,schema_version:input.schema_version,conversion:'local whitelist v1',...original,...(previewRecord?{syntheticPreview:true}:{})}});
      report.counts.converted++;
    } catch(e){ if (!e.code) throw e; report.counts.invalid++; issue(rowPath,'invalid',e.code); }
  }
  (input.measurements || []).forEach((r,i)=>convert(r,i,'measurements'));
  (input.workouts || []).forEach((r,i)=>convert(r,i,'workouts'));
  if(relay.syntheticPreview){report.syntheticPreview=true;report.limitations.push('Synthetic walkthrough provenance is retained on the relay and records. This candidate cannot be imported into a personal record.');}
  return {relay,report};
}

function main(args){
  if (args.length === 1 && args[0] === '--help'){
    console.log('node convert-starter.js --input FILE --from YYYY-MM-DD --to YYYY-MM-DD --output-dir NEW_DIRECTORY\nWrites a review report and, only without invalid rows, a relay candidate. Does not import or send data.'); return;
  }
  const opts = {};
  for (let i=0;i<args.length;i+=2){
    if (!['--input','--from','--to','--output-dir'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--') || Object.hasOwn(opts,args[i])) throw new Error('Use --help for the required arguments; options must appear once.');
    opts[args[i]] = args[i+1];
  }
  if (Object.keys(opts).length !== 4) throw new Error('All four arguments are required; use --help.');
  let input;
  try { input = JSON.parse(fs.readFileSync(opts['--input'],'utf8')); } catch(e){ throw new Error('Input could not be read as JSON. No output was written.'); }
  const result = convertStarter(input,{from:opts['--from'],to:opts['--to']});
  fs.mkdirSync(opts['--output-dir'],{mode:0o700});
  fs.writeFileSync(path.join(opts['--output-dir'],'review.json'),JSON.stringify(result.report,null,2)+'\n',{flag:'wx',mode:0o600});
  if (result.report.counts.invalid){ console.error('Review written; invalid records must be corrected before a relay candidate is produced.'); process.exitCode=2; return; }
  fs.writeFileSync(path.join(opts['--output-dir'],'relay.json'),JSON.stringify(result.relay,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(result.report.counts.converted + ' records converted. Review review.json and relay.json before any separately authorized import.');
}

/* Health Auto Export CSV carries no timezone or original writer. Both limits remain explicit. */
function readExportCSV(text){
  text=String(text).replace(/^\uFEFF/,'');
  const rows=[]; let row=[],cell='',quoted=false,closed=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){ if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;} }else cell+=c; continue; }
    if(c==='"'){ if(cell||closed)throw new Error('Invalid CSV quoting.'); quoted=true; continue; }
    if(c===','||c==='\n'||c==='\r'){
      row.push(cell);cell='';closed=false;
      if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++; if(row.some(x=>x!==''))rows.push(row); row=[];} continue;
    }
    if(closed)throw new Error('Unexpected text after a quoted CSV field.');
    cell+=c;
  }
  if(quoted)throw new Error('Unclosed CSV field.');
  if(cell||row.length){row.push(cell);if(row.some(x=>x!==''))rows.push(row);}
  if(!rows.length)throw new Error('The CSV is empty.');
  const headers=rows.shift();
  while(headers.at(-1)==='')headers.pop();
  if(new Set(headers).size!==headers.length)throw new Error('Duplicate CSV headers.');
  return {headers,rows:rows.map(r=>{
    while(r.length>headers.length&&r.at(-1)==='')r.pop();
    if(r.length!==headers.length)throw new Error('CSV row width does not match its headers.');
    return Object.fromEntries(headers.map((h,i)=>[h,r[i]]));
  })};
}
function prepareLocalFiles(files){
  if(!Array.isArray(files)||!files.length)throw new Error('Choose a local file.');
  if(files.length===1&&/\.json$/i.test(files[0].name)){
    const obj=JSON.parse(files[0].text);
    if(!object(obj)||obj.format!=='personal-health-json-starter'||obj.schema_version!=='1.0')throw new Error('This JSON format is not supported yet. Choose a starter JSON or Health Auto Export daily-summary/workout CSV.');
    const rows=[...(obj.measurements||[]),...(obj.workouts||[])];
    const dates=rows.map(r=>r.start_time_local?.slice(0,10)|| (Number.isSafeInteger(r.start_time_ms)?new Date(r.start_time_ms).toISOString().slice(0,10):null)).filter(dateValid).sort();
    return {obj,rows:rows.length,from:dates[0],to:dates.at(-1),needsTimezone:false};
  }
  const parsed=files.map(f=>{
    if(!/\.csv$/i.test(f.name))throw new Error('Select only the main health-summary and workout CSV files together.');
    const csv=readExportCSV(f.text);
    // Health Auto Export names the workout column 'Type'; this converter was written against
    // 'Workout Type'. Same data, different label, and the mismatch made every workout CSV
    // unrecognisable. Normalise once here so detection, validation and mapping below stay as
    // they were, and a file using either spelling works.
    if(!csv.headers.includes('Workout Type')&&csv.headers.includes('Type')&&['Start','End','Duration'].every(k=>csv.headers.includes(k))){
      csv.headers=csv.headers.map(h=>h==='Type'?'Workout Type':h);
      for(const row of csv.rows){ if(row.Type!==undefined&&row['Workout Type']===undefined){ row['Workout Type']=row.Type; delete row.Type; } }
    }
    const kind=csv.headers.includes('Workout Type')&&['Start','End','Duration'].every(k=>csv.headers.includes(k))?'workouts':csv.headers[0]==='Date/Time'&&csv.headers.some(h=>['Step Count (steps)','Active Energy (kcal)','Resting Heart Rate (bpm)'].includes(h))?'metrics':null;
    if(!kind)throw new Error('Unsupported CSV: use the main daily health summary or workout summary. Routes, ECG and workout time-series files are not imported.');
    return {...csv,kind};
  });
  const dates=parsed.flatMap(f=>f.rows.map(r=>(r[f.kind==='metrics'?'Date/Time':'Start']||'').slice(0,10))).filter(dateValid).sort();
  if(!dates.length)throw new Error('No dated records found in the selected files.');
  return {obj:{format:'health-auto-export-csv',files:parsed},rows:parsed.reduce((n,f)=>n+f.rows.length,0),from:dates[0],to:dates.at(-1),needsTimezone:true};
}
function exportLocalInstant(value,timeZone){
  const m=String(value||'').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if(!m||!dateValid(m[1])||+m[2]>23||+m[3]>59||+(m[4]||0)>59)throw new Error('Invalid local CSV timestamp.');
  if(!timeZone)throw new Error('Confirm the CSV timezone before review.');
  const local=m[1]+'T'+m[2]+':'+m[3]+':'+(m[4]||'00');
  const nominal=Date.parse(local+'Z');
  const fmt=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const offset=ms=>{const p=Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return (Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second+'Z')-ms)/60000;};
  const offsets=[...new Set([-36,0,36].map(h=>offset(nominal+h*3600000)))];
  const matches=offsets.filter(o=>offset(nominal-o*60000)===o);
  if(matches.length!==1)throw new Error('CSV timestamp is ambiguous or nonexistent in this timezone (daylight-saving change). Export an offset-bearing JSON record.');
  const o=matches[0],absolute=Math.abs(o),zone=(o<0?'-':'+')+String(Math.floor(absolute/60)).padStart(2,'0')+':'+String(absolute%60).padStart(2,'0');
  return local+zone;
}
function convertHealthAutoExport(input,window,timeZone){
  if(input?.format!=='health-auto-export-csv'||!Array.isArray(input.files))throw new Error('Expected prepared Health Auto Export CSV files.');
  if(!window||!dateValid(window.from)||!dateValid(window.to)||window.from>window.to)throw new Error('Choose valid inclusive dates.');
  const report={format:'health-auto-export-conversion-review',version:1,window:{...window},counts:{measurements:0,workouts:0,converted:0,unsupported:0,outsideWindow:0,partialWindow:0,invalid:0},issues:[],limitations:[
    'CSV timezone is supplied by you; it is absent from the file. Original timestamp text and precision are retained.',
    'Daily values are exported aggregates, not raw samples. Original writer, device and provider IDs are unavailable.',
    'Sleep totals/stages remain separate reported quantities; no sleep interval or combined total is manufactured.',
    'Original routes and detailed workout time series remain in your export folder and are not imported.',
    'Exact repeats collapse by derived identity. Changed values in a matching bucket are held for review, not silently replaced.'
  ]};
  const relay={format:'health-tracker-relay',version:1,source:'Health Auto Export CSV',retrievedAt:null,window:{...window},records:[]};
  function issue(path,status,code){report.issues.push({path,status,code});}
  function add(record,path){
    const start=record.start.slice(0,10),end=record.end,off=end&&end.match(/([+-])(\d{2}):(\d{2})$/);
    const offset=off?(off[1]==='-'?-1:1)*(+off[2]*60 + +off[3]):0;
    const last=end?new Date(Date.parse(end)-1+offset*60000).toISOString().slice(0,10):start;
    if(start>window.to||last<window.from){report.counts.outsideWindow++;issue(path,'outsideWindow','outside_selected_dates');return;}
    if(start<window.from||last>window.to){report.counts.partialWindow++;issue(path,'partialWindow','whole_interval_crosses_selected_dates');return;}
    relay.records.push(record);report.counts.converted++;
  }
  for(const [fi,file] of input.files.entries())for(const [ri,row] of file.rows.entries()){
    const p='file['+fi+'].row['+ri+']';
    if(file.kind==='metrics'){
      const fields=file.headers.filter(h=>h!=='Date/Time'&&row[h].trim()!=='');
      report.counts.measurements+=fields.length;
      let start,end;
      try{
        if(!/^\d{4}-\d{2}-\d{2} 00:00:00$/.test(row['Date/Time']))throw new Error('Expected daily midnight summaries.');
        start=exportLocalInstant(row['Date/Time'],timeZone);
        const next=new Date(Date.parse(start.slice(0,10)+'T00:00:00Z')+86400000).toISOString().slice(0,10);
        end=exportLocalInstant(next+' 00:00:00',timeZone);
      }catch(e){report.counts.invalid+=fields.length;issue(p,'invalid',e.message);continue;}
      for(const header of fields){
        const match=header.match(/^(.*) \(([^()]*(?:\([^()]*\)[^()]*)*)\)$/),raw=row[header].trim(),value=Number(raw);
        if(!match||match[1].length>60){report.counts.unsupported++;issue(p,'unsupported','unrecognized_metric_header');continue;}
        if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw)||!Number.isFinite(value)){report.counts.invalid++;issue(p,'invalid','invalid_numeric_metric');continue;}
        const label=match[1],originalUnit=match[2];
        const mapped={'Step Count (steps)':['steps','count'],'Active Energy (kcal)':['activeEnergy','kcal'],'Resting Heart Rate (bpm)':['restingHeartRate','count/min'],'Weight (lbs)':['weight','lb'],'Weight (kg)':['weight','kg']}[header];
        const [kind,unit]=mapped||['other',originalUnit];
        if(mapped&&(value<0||(kind==='weight'&&value===0))){report.counts.invalid++;issue(p,'invalid','invalid_supported_metric_value');continue;}
        add({kind,type:label,sourceApp:'unknown',sourceRecordId:null,start,end,value,unit,durationSec:null,device:null,healthAutoExport:{format:'CSV',representation:'daily aggregate',originalField:header,originalUnit,originalStart:row['Date/Time'],timeZone,timezoneBasis:'user-supplied; absent from CSV',bucketEnd:'derived next local midnight; not measurement duration',originalWriter:'unknown'}},p);
      }
    }else{
      report.counts.workouts++;
      try{
        const start=exportLocalInstant(row.Start,timeZone),end=exportLocalInstant(row.End,timeZone),d=row.Duration.match(/^(\d+):(\d{2}):(\d{2})$/);
        if(!d||+d[2]>59||+d[3]>59||Date.parse(end)<=Date.parse(start)||!row['Workout Type'].trim())throw new Error('Invalid workout duration, type or interval.');
        const details={};
        for(const field of ['Active Energy (kcal)','Resting Energy (kcal)','Distance (km)','Distance (mi)','Avg. Heart Rate (bpm)','Max. Heart Rate (bpm)','Step Count']){
          if(row[field]!==undefined&&row[field].trim()!==''&&Number.isFinite(Number(row[field])))details[field]=Number(row[field]);
        }
        add({kind:'workout',type:row['Workout Type'],sourceApp:'unknown',sourceRecordId:null,start,end,durationSec:+d[1]*3600 + +d[2]*60 + +d[3],value:null,unit:null,device:null,healthAutoExport:{format:'CSV',representation:'workout summary',originalStart:row.Start,originalEnd:row.End,originalDuration:row.Duration,timestampPrecision:'minute',timeZone,timezoneBasis:'user-supplied; absent from CSV',originalWriter:'unknown',details}},p);
      }catch(e){report.counts.invalid++;issue(p,'invalid',e.message);}
    }
  }
  issue('export','warning','original_writer_device_and_provider_ids_unavailable');
  issue('export','warning','timezone_supplied_by_user');
  issue('export','warning','daily_aggregates_not_raw_samples');
  return {relay,report};
}
if (inNode){
  module.exports = {convertStarter,prepareLocalFiles,convertHealthAutoExport,exportLocalInstant,readExportCSV};
  if (require.main === module){ try { main(process.argv.slice(2)); } catch(e){ console.error(e.code ? 'Conversion stopped ('+e.code+'); existing files are preserved.' : e.message); process.exitCode=1; } }
} else { globalThis.healthTrackerConvertStarter = convertStarter; globalThis.healthTrackerPrepareLocalFiles=prepareLocalFiles; globalThis.healthTrackerConvertHealthAutoExport=convertHealthAutoExport; }
