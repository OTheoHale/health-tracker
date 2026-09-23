/* Pure local Health Auto Export adapter; the file never supplies its own feed configuration. */
(function(root){
'use strict';
const FORMAT='health-auto-export-json-v2';
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>JSON.parse(JSON.stringify(x));
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
const ordered=x=>Array.isArray(x)?x.map(ordered):object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
const METRICS={
  step_count:{kind:'steps',label:'Steps',unit:'count',units:{count:1,steps:1},reduce:'sum'},
  active_energy:{kind:'activeEnergy',label:'Active energy',unit:'kcal',units:{kcal:1,kJ:1/4.184},reduce:'sum'},
  resting_heart_rate:{kind:'restingHeartRate',label:'Resting heart rate',unit:'bpm',units:{bpm:1,'count/min':1},reduce:'latest'},
  heart_rate:{kind:'other',label:'Heart rate',unit:'bpm',units:{bpm:1,'count/min':1},reduce:'heart'},
  weight_body_mass:{kind:'weight',label:'Weight',unit:'kg',units:{kg:1,lb:0.45359237,lbs:0.45359237},reduce:'latest'},
  // Health Auto Export emits weight_body_mass. The ampersand spelling below never matched a
  // real file, so weight looked supported and was silently dropped on every import. Kept in
  // case an older export used it.
  'weight_&_body_mass':{kind:'weight',label:'Weight',unit:'kg',units:{kg:1,lb:0.45359237,lbs:0.45359237},reduce:'latest'},
  walking_running_distance:{kind:'other',label:'Walking and running distance',unit:'km',units:{km:1,mi:1.609344,m:0.001},reduce:'sum'},
  apple_exercise_time:{kind:'other',label:'Exercise time',unit:'min',units:{min:1,hr:60},reduce:'sum'},
  apple_stand_time:{kind:'other',label:'Stand time',unit:'min',units:{min:1,hr:60},reduce:'sum'},
  flights_climbed:{kind:'other',label:'Flights climbed',unit:'count',units:{count:1},reduce:'sum'},
  // 'sum' only where a value accumulates across the bucket. Anything instantaneous — a rate,
  // percentage, speed or body measure — uses 'latest', because summing or averaging those
  // would report a number the source never recorded.
  basal_energy_burned:{kind:'other',label:'Resting energy',unit:'kcal',units:{kcal:1,kJ:1/4.184},reduce:'sum'},
  time_in_daylight:{kind:'other',label:'Time in daylight',unit:'min',units:{min:1,hr:60},reduce:'sum'},
  handwashing:{kind:'other',label:'Handwashing',unit:'s',units:{s:1,min:60},reduce:'sum'},
  toothbrushing:{kind:'other',label:'Toothbrushing',unit:'s',units:{s:1,min:60},reduce:'sum'},
  dietary_water:{kind:'other',label:'Water',unit:'ml',units:{ml:1,fl_oz_us:29.5735295625,L:1000},reduce:'sum'},
  caffeine:{kind:'other',label:'Caffeine',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  alcohol_consumption:{kind:'other',label:'Alcohol',unit:'count',units:{count:1},reduce:'sum'},
  breathing_disturbances:{kind:'other',label:'Breathing disturbances',unit:'count',units:{count:1},reduce:'sum'},
  apple_stand_hour:{kind:'other',label:'Stand hours',unit:'count',units:{count:1},reduce:'sum'},
  respiratory_rate:{kind:'other',label:'Respiratory rate',unit:'count/min',units:{'count/min':1},reduce:'latest'},
  heart_rate_variability:{kind:'other',label:'Heart rate variability',unit:'ms',units:{ms:1},reduce:'latest'},
  blood_oxygen_saturation:{kind:'other',label:'Blood oxygen',unit:'%',units:{'%':1},reduce:'latest'},
  vo2_max:{kind:'other',label:'VO2 max',unit:'ml/(kg·min)',units:{'ml/(kg·min)':1},reduce:'latest'},
  cardio_recovery:{kind:'other',label:'Cardio recovery',unit:'count/min',units:{'count/min':1},reduce:'latest'},
  walking_heart_rate_average:{kind:'other',label:'Walking heart rate',unit:'count/min',units:{'count/min':1,bpm:1},reduce:'latest'},
  physical_effort:{kind:'other',label:'Physical effort',unit:'kcal/hr·kg',units:{'kcal/hr·kg':1},reduce:'latest'},
  environmental_audio_exposure:{kind:'other',label:'Environmental sound',unit:'dBASPL',units:{dBASPL:1},reduce:'latest'},
  headphone_audio_exposure:{kind:'other',label:'Headphone sound',unit:'dBASPL',units:{dBASPL:1},reduce:'latest'},
  walking_speed:{kind:'other',label:'Walking speed',unit:'mi/hr',units:{'mi/hr':1,'km/hr':0.621371192},reduce:'latest'},
  walking_step_length:{kind:'other',label:'Step length',unit:'in',units:{in:1,cm:0.393700787},reduce:'latest'},
  walking_asymmetry_percentage:{kind:'other',label:'Walking asymmetry',unit:'%',units:{'%':1},reduce:'latest'},
  walking_double_support_percentage:{kind:'other',label:'Double support',unit:'%',units:{'%':1},reduce:'latest'},
  stair_speed_up:{kind:'other',label:'Stair speed up',unit:'ft/s',units:{'ft/s':1,'m/s':3.280839895},reduce:'latest'},
  stair_speed_down:{kind:'other',label:'Stair speed down',unit:'ft/s',units:{'ft/s':1,'m/s':3.280839895},reduce:'latest'},
  six_minute_walking_test_distance:{kind:'other',label:'Six-minute walk',unit:'m',units:{m:1,km:1000,ft:0.3048},reduce:'latest'},
  body_mass_index:{kind:'weight',label:'Body mass index',unit:'count',units:{count:1},reduce:'latest'},
  body_fat_percentage:{kind:'weight',label:'Body fat',unit:'%',units:{'%':1},reduce:'latest'},
  // Sleep arrives inside the Health Metrics export as an interval with stage durations,
  // so it carries its own reduce strategy and row schema. Honoured only when the
  // confirmed contract says sleepMode:'include'.
  sleep_analysis:{kind:'sleep',label:'Sleep',unit:'hr',units:{hr:1,min:1/60},reduce:'sleep'},
  lean_body_mass:{kind:'weight',label:'Lean body mass',unit:'kg',units:{kg:1,lb:0.45359237,lbs:0.45359237},reduce:'latest'},
  // Nutrition. Bevel logs food to the Health app, so these arrive in the same export.
  // All of them accumulate across the bucket, so every one uses 'sum'.
  dietary_energy:{kind:'other',label:'Food energy',unit:'kcal',units:{kcal:1,kJ:1/4.184},reduce:'sum'},
  protein:{kind:'other',label:'Protein',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  carbohydrates:{kind:'other',label:'Carbohydrates',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  fiber:{kind:'other',label:'Fiber',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  dietary_sugar:{kind:'other',label:'Sugar',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  total_fat:{kind:'other',label:'Total fat',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  saturated_fat:{kind:'other',label:'Saturated fat',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  monounsaturated_fat:{kind:'other',label:'Monounsaturated fat',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  polyunsaturated_fat:{kind:'other',label:'Polyunsaturated fat',unit:'g',units:{g:1,mg:0.001},reduce:'sum'},
  cholesterol:{kind:'other',label:'Cholesterol',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  sodium:{kind:'other',label:'Sodium',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  potassium:{kind:'other',label:'Potassium',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  calcium:{kind:'other',label:'Calcium',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  iron:{kind:'other',label:'Iron',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  magnesium:{kind:'other',label:'Magnesium',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  phosphorus:{kind:'other',label:'Phosphorus',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  zinc:{kind:'other',label:'Zinc',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  copper:{kind:'other',label:'Copper',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  manganese:{kind:'other',label:'Manganese',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  selenium:{kind:'other',label:'Selenium',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  iodine:{kind:'other',label:'Iodine',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  vitamin_a:{kind:'other',label:'Vitamin A',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  vitamin_c:{kind:'other',label:'Vitamin C',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  vitamin_d:{kind:'other',label:'Vitamin D',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  vitamin_e:{kind:'other',label:'Vitamin E',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  vitamin_k:{kind:'other',label:'Vitamin K',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  vitamin_b6:{kind:'other',label:'Vitamin B6',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  vitamin_b12:{kind:'other',label:'Vitamin B12',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  thiamin:{kind:'other',label:'Thiamin',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  riboflavin:{kind:'other',label:'Riboflavin',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  niacin:{kind:'other',label:'Niacin',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  folate:{kind:'other',label:'Folate',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  biotin:{kind:'other',label:'Biotin',unit:'mcg',units:{mcg:1,mg:1000},reduce:'sum'},
  pantothenic_acid:{kind:'other',label:'Pantothenic acid',unit:'mg',units:{mg:1,g:1000},reduce:'sum'},
  // Movement detail. Distance accumulates; the rest are instantaneous measures.
  cycling_distance:{kind:'other',label:'Cycling distance',unit:'km',units:{km:1,mi:1.609344,m:0.001},reduce:'sum'},
  running_speed:{kind:'other',label:'Running speed',unit:'mi/hr',units:{'mi/hr':1,'km/hr':0.621371192},reduce:'latest'},
  running_power:{kind:'other',label:'Running power',unit:'W',units:{W:1},reduce:'latest'},
  running_stride_length:{kind:'other',label:'Running stride length',unit:'m',units:{m:1,cm:0.01,ft:0.3048},reduce:'latest'},
  running_vertical_oscillation:{kind:'other',label:'Vertical oscillation',unit:'cm',units:{cm:1,m:100,in:2.54},reduce:'latest'},
  running_ground_contact_time:{kind:'other',label:'Ground contact time',unit:'ms',units:{ms:1},reduce:'latest'},
  underwater_depth:{kind:'other',label:'Underwater depth',unit:'ft',units:{ft:1,m:3.280839895},reduce:'latest'},
  underwater_temperature:{kind:'other',label:'Underwater temperature',unit:'degF',units:{degF:1},reduce:'latest'}
};
function validDay(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&+s.slice(0,4)>=1000&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;}
function instant(s,vendor){
  if(typeof s!=='string')return null;
  const m=vendor?s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/):s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if(!m||!validDay(m[1])||+m[2]>23||+m[3]>59||+m[4]>59)return null;
  const zone=vendor?m[5]+m[6]+':'+m[7]:m[5];
  if(zone!=='Z'&&(+zone.slice(1,3)>14||+zone.slice(4)>59||(+zone.slice(1,3)===14&&+zone.slice(4)!==0)))return null;
  const text=vendor?m[1]+'T'+m[2]+':'+m[3]+':'+m[4]+zone:s,ms=Date.parse(text);
  return Number.isFinite(ms)?{text,ms}:null;
}
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
const clockFormatter=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function dayAt(ms){const p=Object.fromEntries(dayFormatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
function dayStart(day){
  const nominal=Date.parse(day+'T00:00:00Z');let ms=nominal;
  for(let i=0;i<3;i++){const p=Object.fromEntries(clockFormatter.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));ms+=nominal-Date.parse(p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute+':'+p.second+'Z');}
  const offset=(nominal-ms)/60000,a=Math.abs(offset);
  return day+'T00:00:00'+(offset<0?'-':'+')+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0');
}
function feedId(s){return typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);}
// How a file's rows were bucketed before export. Each value carries the label that lands on every
// record it produces, so a number's resolution travels with it instead of being inferred later.
const GROUPINGS={minute:'minute aggregate',hour:'hour aggregate',day:'day aggregate',week:'week aggregate'};
function validateContract(c){
  return !object(c)||!feedId(c.feedId)||c.version!==1||c.format!==FORMAT||(c.route!=='health-metrics'&&c.route!=='workouts')||!own(GROUPINGS,c.grouping)||c.timeZone!=='America/Los_Angeles'||!validDay(c.activeFrom)||(c.sleepMode!=='exclude'&&c.sleepMode!=='include')?
    'Confirm the supported JSON v2, Health Metrics, minute-grouping feed contract with a stable feed ID, excluded sleep route and cutover date.':null;
}
// Native ordering retains fractional milliseconds; ISO text is only the legacy fallback/display.
function deliveryTime(d){return d&&own(d,'modifiedAtMs')?d.modifiedAtMs:Date.parse(d&&d.modifiedAt);}
function validateDelivery(d){
  return !object(d)||typeof d.fileId!=='string'||!d.fileId||d.fileId.length>1024||typeof d.digest!=='string'||!/^[a-f\d]{64}$/i.test(d.digest)||!instant(d.modifiedAt)||!instant(d.receivedAt)||!Number.isFinite(deliveryTime(d))?
    'A stable file identity, SHA-256 digest, modification time and local receipt time are required.':null;
}
function writer(source){
  if(source===undefined||source===null||source==='')return {label:'unknown',status:'unknown'};
  if(typeof source!=='string'||source.length>4096||/[\u0000-\u001f\u007f]/.test(source))throw new Error('invalid_writer');
  return {label:source,status:!source.trim()||/^(unknown|unspecified)$/i.test(source.trim())?'unknown':source.includes('|')?'compound':'single'};
}
function hae(r){const m=r&&r.unmapped&&r.unmapped.healthAutoExport;return m&&m.format==='JSON'&&m.adapterVersion===1?m:null;}
function feedRecord(r){const m=r&&r.unmapped&&r.unmapped.healthAutoExport;return !!(m&&m.format==='JSON'||r&&typeof r.id==='string'&&r.id.startsWith('hae:'));}
// One definition of "this row was imported under a different feed connection". reconcile() refuses
// a store that holds any, and the page offers to retire them; those two must never disagree.
// Apple's own devices, as Health Auto Export names them: "Mintesinot’s Apple Watch",
// "Mintay's Iphone 15". A compound label counts when any part is one. Apple writes the device name
// with a non-breaking space — "Apple\u00A0Watch" — so a literal space never matched and every
// Watch-only minute was treated as a third-party writer; \s covers U+00A0.
function workoutKcal(q){if(!q||!Number.isFinite(q.qty))return null;const u=String(q.units||'').toLowerCase();return u==='kcal'||u==='cal'?q.qty:u==='kj'?q.qty/4.184:null;}
function appleWriter(label){return typeof label==='string'&&label.split('|').some(part=>/apple\s+watch|iphone|^\s*(apple\s+)?health\s*$/i.test(part));}
function foreignToFeed(record,feedId){const m=hae(record);return feedRecord(record)&&(!m||m.feedId!==feedId);}
function bucketId(c,metric,unit,source,start){return 'hae:bucket:v1:'+JSON.stringify([1,c.feedId,c.route,c.grouping,metric,unit,source,new Date(Date.parse(start)).toISOString(),GROUPINGS[c.grouping]]);}
function signature(r){
  const v=clone(r),m=hae(v);if(m)delete m.delivery;
  for(const k of ['importedAt','lastSeenAt','lastRetrievedAt','sourceCorrectedAt','revision'])delete v[k];
  return JSON.stringify(ordered(v));
}
function contentSignature(r){const v=clone(r);delete v.clashes;delete v.resolutions;return signature(v);}
function quantity(v,positive){if(typeof v!=='number'||!Number.isFinite(v)||v<0||(positive&&v===0))throw new Error('invalid_quantity');return v;}
function workoutQuantity(v){return v&&typeof v==='object'&&Number.isFinite(Number(v.qty))?{qty:Number(v.qty),units:String(v.units||'')}:null;}
function parseWorkouts(obj,c,d,report,stop){
  if(!object(obj)||Object.keys(obj).some(k=>k!=='data')||!object(obj.data)||!Array.isArray(obj.data.workouts))
    return stop('Unsupported Health Auto Export envelope; expected the configured data.workouts route.');
  for(const [name,value] of Object.entries(obj.data))if(name!=='workouts')report.excludedCollections.push({name,count:Array.isArray(value)?value.length:null});
  const output=[],seen=new Set();
  for(let wi=0;wi<obj.data.workouts.length;wi++){
    const w=obj.data.workouts[wi],wp='workouts['+wi+']';report.counts.input++;
    try{
      if(!object(w)||typeof w.name!=='string'||!w.name.trim())throw new Error('invalid_workout_structure');
      const start=instant(w.start,true),end=instant(w.end,true);
      if(!start||!end||end.ms<=start.ms)throw new Error('invalid_workout_interval');
      if(typeof w.id!=='string'||!w.id.trim())throw new Error('workout_without_provider_identity');
      // Same session delivered twice is the same session, not two workouts.
      if(seen.has(w.id)){report.counts.duplicate++;continue;}
      seen.add(w.id);
      const src=object(w.source)?w.source:{};
      const writerName=typeof src.name==='string'&&src.name.trim()?src.name:'unknown';
      const wr=writer(writerName);
      const duration=Number.isFinite(Number(w.duration))?Math.round(Number(w.duration)):Math.round((end.ms-start.ms)/1000);
      const distance=workoutQuantity(w.distance),total=workoutQuantity(w.totalEnergy),active=workoutQuantity(w.activeEnergyBurned);
      const meta={format:'JSON',adapterVersion:1,contractVersion:c.version,feedId:c.feedId,route:'workouts',grouping:c.grouping,
        representation:'workout session',day:dayAt(start.ms),writerStatus:wr.status,originalWriter:wr.label,
        sourceIdentifier:typeof src.identifier==='string'?src.identifier:null,
        originalStart:w.start,originalEnd:w.end,timeZone:c.timeZone,
        timezoneBasis:'source offset retained; display and cutover use confirmed timezone',
        distance,totalEnergy:total,activeEnergy:active,
        speed:workoutQuantity(w.speed),stepCadence:workoutQuantity(w.stepCadence),
        providerIdentity:w.id,
        delivery:{fileId:d.fileId,digest:d.digest,modifiedAt:d.modifiedAt,...(own(d,'modifiedAtMs')?{modifiedAtMs:d.modifiedAtMs}:{}),receivedAt:d.receivedAt}};
      output.push({id:'hae:workout:v1:'+w.id,kind:'workout',type:w.name,sourceApp:wr.label,sourceRecordId:w.id,device:null,
        // Normalised instants, as the metrics route stores. Keeping Health Auto Export's raw
        // text here meant Date.parse(r.start) did not round-trip and reconcile rejected every
        // session; the original strings are retained in originalStart/originalEnd.
        start:start.text,end:end.text,value:distance?distance.qty:(total?total.qty:null),unit:distance?distance.units:(total?total.units:null),
        durationSec:duration,elapsedSec:Math.round((end.ms-start.ms)/1000),
        idRule:'Health Auto Export workout v1: the provider UUID, so the same session delivered twice is one record',
        origin:'source-recorded (local automatic file)',transport:'local folder',relayedBy:'local folder',source:'Health Auto Export',
        unmapped:{healthAutoExport:meta}});
      report.counts.accepted++;
    }catch(e){report.counts.invalid++;if(report.issues.length<200)report.issues.push({path:wp,code:e.message});}
  }
  report.complete=report.counts.invalid===0;
  // reconcile() reads parsed.feedId from the top level, not from the report. The metrics route sets
  // it; this one did not, so every workout file was refused as "a different or unknown feed
  // namespace" after parsing perfectly well.
  return {ok:report.counts.invalid===0,feedId:c.feedId,
    error:report.counts.invalid?'A supported workout or schema is invalid; no records were accepted from this file.':null,
    records:report.counts.invalid?[]:output,report};
}
function parse(input,options){
  const c=options&&options.contract,d=options&&options.delivery,problem=validateContract(c)||validateDelivery(d);
  const report={format:'health-auto-export-json-review',version:1,counts:{input:0,accepted:0,invalid:0,excluded:0,duplicate:0,held:0},issues:[],excludedCollections:[],complete:false,
    limitations:['The payload does not attest export version or grouping; explicitly confirmed settings supply that contract. A shape-compatible settings change cannot be detected from these files alone.','File modification time orders local deliveries; it is not a provider revision or source retrieval time.','Missing buckets and metrics remain unknown. Imports grant no activity points.','Automatic workouts and sleep require separately supported routes. Existing CSV workouts and separate sleep quantities are retained.']};
  const stop=error=>({ok:false,error,records:[],report});
  if(problem)return stop(problem);
  if(d.feedId!==undefined&&d.feedId!==c.feedId)return stop('Native delivery belongs to a different feed namespace.');
  let obj=input;
  if(c.route==='workouts'){
    if(typeof obj==='string'){try{obj=JSON.parse(obj);}catch(e){return stop('Invalid JSON; no records were accepted.');}}
    return parseWorkouts(obj,c,d,report,stop);
  }
  if(typeof input==='string'){try{obj=JSON.parse(input);}catch(e){return stop('Invalid JSON; no records were accepted.');}}
  if(!object(obj)||Object.keys(obj).some(k=>k!=='data')||!object(obj.data)||!Array.isArray(obj.data.metrics))return stop('Unsupported Health Auto Export envelope; expected the configured data.metrics route.');
  if([obj.data,obj.data.unmapped,obj.data.starter,obj.data.unmapped?.starter].some(meta=>object(meta)&&['syntheticPreview','syntheticWorkspace'].some(key=>own(meta,key))))return stop('Synthetic walkthrough metadata is not supported by this personal feed route.');
  for(const [name,value] of Object.entries(obj.data))if(name!=='metrics')report.excludedCollections.push({name,count:Array.isArray(value)?value.length:null});
  const output=[],seen=new Map();
  function issue(path,code){if(report.issues.length<200)report.issues.push({path,code});}
  for(let mi=0;mi<obj.data.metrics.length;mi++){
    const metric=obj.data.metrics[mi],mp='metrics['+mi+']';
    if(!object(metric)||typeof metric.name!=='string'||!Array.isArray(metric.data)){report.counts.invalid++;issue(mp,'invalid_metric_structure');continue;}
    const def=own(METRICS,metric.name)?METRICS[metric.name]:null;
    if(!def){report.counts.excluded+=metric.data.length;continue;}
    if(def.reduce==='sleep'&&c.sleepMode!=='include'){report.counts.excluded+=metric.data.length;report.excludedCollections.push({name:'sleep_analysis',count:metric.data.length});continue;}
    if(Object.keys(metric).some(k=>!['name','units','data'].includes(k))||typeof metric.units!=='string'||!own(def.units,metric.units)){report.counts.invalid++;issue(mp,'unsupported_metric_unit_or_schema');continue;}
    for(let ri=0;ri<metric.data.length;ri++){
      const row=metric.data[ri],rp=mp+'.data['+ri+']';report.counts.input++;
      if(report.counts.input>250000){report.counts.invalid++;issue(mp,'file_row_limit');return stop('File exceeds the supported row limit; reduce the export payload.');}
      try{
        const allowed=def.reduce==='heart'?['date','source','Min','Avg','Max']
          :def.reduce==='sleep'?['date','source','totalSleep','asleep','awake','core','deep','rem','inBed','sleepStart','sleepEnd','inBedStart','inBedEnd']
          :['date','source','qty'];
        if(!object(row)||Object.keys(row).some(k=>!allowed.includes(k)))throw new Error('unsupported_supported_row_schema');
        const date=instant(row.date,true);
        if(!date)throw new Error('unreadable_timestamp');
        if(c.grouping==='minute'&&date.text.slice(17,19)!=='00')throw new Error('minute_bucket_requires_offset_minute_timestamp');
        const w=writer(row.source),day=dayAt(date.ms);let value,stats;
        if(def.reduce==='heart'){
          stats={min:quantity(row.Min),avg:quantity(row.Avg),max:quantity(row.Max)};
          if(stats.min>stats.avg||stats.avg>stats.max)throw new Error('invalid_heart_rate_range');value=stats.avg;
        }else if(def.reduce==='sleep'){
          value=quantity(row.totalSleep);
          const hours=k=>row[k]===undefined?null:quantity(row[k]);
          stats={totalSleep:value,core:hours('core'),deep:hours('deep'),rem:hours('rem'),awake:hours('awake'),asleep:hours('asleep'),inBed:hours('inBed'),
            sleepStart:row.sleepStart||null,sleepEnd:row.sleepEnd||null,inBedStart:row.inBedStart||null,inBedEnd:row.inBedEnd||null};
          const staged=['core','deep','rem'].map(k=>stats[k]).filter(v=>typeof v==='number');
          // A night whose stages exceed its own total is not a night we can reason about.
          if(staged.length&&staged.reduce((a,b)=>a+b,0)>value+0.01)throw new Error('sleep_stages_exceed_total');
        }else value=quantity(row.qty,def.kind==='weight');
        const meta={format:'JSON',adapterVersion:1,contractVersion:c.version,feedId:c.feedId,metric:metric.name,grouping:c.grouping,representation:GROUPINGS[c.grouping],day,writerStatus:w.status,originalWriter:w.label,originalStart:row.date,originalTimestamp:row.date,timeZone:c.timeZone,timezoneBasis:'source offset retained; display and cutover use confirmed timezone',originalUnit:metric.units,bucketEnd:'No source end supplied for metric bucket',reduction:def.reduce,canonicalUnit:def.unit,unitFactor:def.units[metric.units],...(stats?{stats}:{}),providerIdentity:'unavailable',delivery:{fileId:d.fileId,digest:d.digest,modifiedAt:d.modifiedAt,...(own(d,'modifiedAtMs')?{modifiedAtMs:d.modifiedAtMs}:{}),receivedAt:d.receivedAt}};
        if(def.reduce==='sleep')meta.bucketStart=date.text;
        const r={id:bucketId(c,metric.name,def.unit,w.label,date.text),kind:def.kind,type:def.reduce==='sleep'?def.label+' (night)':def.label+' ('+GROUPINGS[c.grouping]+')',sourceApp:w.label,sourceRecordId:null,device:null,start:def.reduce==='sleep'?(instant(row.sleepStart,true)||date).text:date.text,end:def.reduce==='sleep'?(instant(row.sleepEnd,true)||{text:null}).text:null,value,unit:metric.units,durationSec:def.reduce==='sleep'&&typeof value==='number'?Math.round(value*3600):null,elapsedSec:null,idRule:'Health Auto Export bucket v1: feed ID, route, grouping, metric, canonical unit, full writer, instant, representation; excludes value',origin:'source-recorded (local automatic file)',transport:'local folder',relayedBy:'local folder',source:'Health Auto Export JSON',relayedAt:null,window:{from:day,to:day},unmapped:{healthAutoExport:meta}};
        const prev=seen.get(r.id);
        if(prev){if(signature(prev)!==signature(r))throw new Error('conflicting_same_bucket_in_file');report.counts.duplicate++;continue;}
        seen.set(r.id,r);output.push(r);if(w.status!=='single')report.counts.held++;
      }catch(e){report.counts.invalid++;issue(rp,e.message);}
    }
  }
  if(report.counts.invalid)return stop('A supported row or schema is invalid; no records were accepted from this file.');
  report.counts.accepted=output.length;report.feedId=c.feedId;
  return {ok:true,feedId:c.feedId,records:output,report};
}
function reconcile(existing,parsed,options){
  const c=options&&options.contract,d=options&&options.delivery,previous=options&&options.previousDelivery;
  const report={status:'accepted',added:0,revised:0,same:0,held:0,metadataUpdated:0};
  const stop=(error,status)=>({ok:!error,error:error||undefined,records:existing,changes:[],report:{...report,status:status||'invalid'}});
  const problem=validateContract(c)||validateDelivery(d);
  if(problem||!Array.isArray(existing)||!parsed||!parsed.ok||!Array.isArray(parsed.records))return stop(problem||'Only a fully validated file can be reconciled.');
  if(parsed.feedId!==c.feedId||(d.feedId!==undefined&&d.feedId!==c.feedId))return stop('Parsed file belongs to a different or unknown feed namespace.');
  // Whole-store precondition, deliberately: mixing two feed namespaces would let the same bucket
  // exist twice under different identities. It is also a dead end unless something can clear it,
  // so the page uses foreignToFeed below to offer that, rather than restating the rule itself.
  if(existing.some(r=>foreignToFeed(r,c.feedId)))return stop('Existing feed sources contain a different or unknown namespace; preserve them for review.');
  if(previous&&previous.feedId!==c.feedId)return stop('Previous delivery belongs to a different or unknown feed namespace.');
  report.feedId=c.feedId;
  const current=new Map(existing.map(r=>[r.id,r]));
  if(current.size!==existing.length)return stop('Existing source identities are duplicated; preserve and review the store.');
  if(previous&&previous.fileId!==d.fileId)return stop('The previous delivery belongs to a different file.');
  if(previous){
    const history=[previous.digest,...(previous.digests||[]),...(previous.digestHistory||[])].filter(x=>typeof x==='string').map(x=>x.toLowerCase());
    if(history.includes(d.digest.toLowerCase())){
      const currentRepeat=typeof previous.digest==='string'&&previous.digest.toLowerCase()===d.digest.toLowerCase()&&parsed.records.every(r=>current.has(r.id)&&contentSignature(current.get(r.id))===contentSignature(r));
      if(!currentRepeat){report.same=parsed.records.length;return stop(null,'replay');}
      report.status='replay';
    }
    if(report.status!=='replay'&&Number.isFinite(deliveryTime(previous))&&deliveryTime(d)<deliveryTime(previous)){report.held=parsed.records.length;return stop(null,'stale');}
    if(Number.isFinite(deliveryTime(previous))&&deliveryTime(d)===deliveryTime(previous)&&parsed.records.some(r=>!current.has(r.id)||contentSignature(current.get(r.id))!==contentSignature(r))){report.held=parsed.records.length;return stop(null,'conflict');}
  }
  for(const r of parsed.records){
    const m=hae(r),old=current.get(r.id),oldMeta=hae(old);
    if(!m||m.feedId!==c.feedId||!object(m.delivery)||m.delivery.fileId!==d.fileId||m.delivery.digest!==d.digest)return stop('Parsed records do not match the native delivery and feed namespace.');
    // A workout is a session, not a bucket. These checks were written for the metrics route alone
    // and demanded a METRICS entry, a 'minute aggregate' representation, a bucketId match and a null
    // sourceRecordId — none of which a session has or should have. Each route is checked against
    // what it actually is; neither is waved through.
    if(c.route==='workouts'){
      if(m.route!=='workouts'||m.contractVersion!==c.version||m.timeZone!==c.timeZone||m.representation!=='workout session'
        ||typeof r.sourceRecordId!=='string'||!r.sourceRecordId||r.id!=='hae:workout:v1:'+r.sourceRecordId
        ||typeof r.type!=='string'||!r.type||!instant(r.start)||!instant(r.end)||m.day!==dayAt(Date.parse(r.start)))
        return stop('Parsed workout identity is invalid.');
    }else{
    const def=own(METRICS,m.metric)?METRICS[m.metric]:null;
    if(!def||m.contractVersion!==c.version||m.grouping!==c.grouping||m.timeZone!==c.timeZone||m.representation!==GROUPINGS[c.grouping]||m.canonicalUnit!==def.unit||!instant(m.bucketStart||r.start)||m.day!==dayAt(Date.parse(m.bucketStart||r.start))||r.id!==bucketId(c,m.metric,def.unit,r.sourceApp,m.bucketStart||r.start)||r.sourceRecordId!==null)return stop('Parsed bucket identity or canonical unit is invalid.');
    }
    if(old&&!oldMeta)return stop('Incoming identity collides with a non-feed source.');
    if(old&&contentSignature(old)!==contentSignature(r)){
      const prior=oldMeta.delivery&&deliveryTime(oldMeta.delivery),now=deliveryTime(d);
      if(!Number.isFinite(prior)||now<=prior){report.held=parsed.records.length;return stop(null,now<prior?'stale':'conflict');}
    }
  }
  const updates=new Map(),changes=[];
  for(const r of parsed.records){
    const old=current.get(r.id);
    if(!old){const next=clone(r);next.importedAt=d.receivedAt;updates.set(r.id,next);changes.push({id:r.id,before:null,after:next});report.added++;}
    else if(contentSignature(old)===contentSignature(r)){
      report.same++;
      if(deliveryTime(hae(r).delivery)>deliveryTime(hae(old).delivery)){const next=clone(old);hae(next).delivery=clone(hae(r).delivery);updates.set(r.id,next);report.metadataUpdated++;}
    }else{
      const next=clone(r);next.importedAt=old.importedAt||d.receivedAt;next.sourceCorrectedAt=d.receivedAt;
      // Prior review history remains addressable; a changed evidence fingerprint requires new confirmation.
      for(const key of ['clashes','resolutions'])if(own(old,key))next[key]=clone(old[key]);
      updates.set(r.id,next);changes.push({id:r.id,before:old,after:next});report.revised++;
    }
  }
  const records=existing.map(r=>updates.get(r.id)||r);for(const r of parsed.records)if(!current.has(r.id))records.push(updates.get(r.id));
  return {ok:true,records,changes,report};
}
function project(raw,contract){
  const problem=validateContract(contract);
  if(problem||!Array.isArray(raw))return {ok:false,error:problem||'Source records must be an array.',records:[],activeIds:[],heldIds:[],shadowIds:[],report:{complete:false}};
  const records=[],activeIds=[],heldIds=[],shadowIds=[],fallbackIds=[],csvCandidates=[],sessions=[],qualifiedDays=new Set(),groups=new Map(),report={complete:false,rawBuckets:0,active:0,held:0,shadow:0,projected:0,baselineFallback:0,latestData:null,latestActiveData:null,reasons:{},label:'Partial received data; missing buckets are unknown'};
  const latest=(a,b)=>!a||Date.parse(b)>Date.parse(a)?b:a;
  function metricDayKey(metric,unit,day){return JSON.stringify([contract.feedId,metric,unit,day]);}
  function csvKey(r){
    const csv=r.unmapped&&r.unmapped.healthAutoExport;
    if(!csv||csv.format!=='CSV'||csv.representation!=='daily aggregate'||!instant(r.start)||!Number.isFinite(r.value)||r.value<0)return null;
    const byKind={steps:'step_count',activeEnergy:'active_energy',restingHeartRate:'resting_heart_rate',weight:'weight_&_body_mass'};
    const byLabel={'Walking + Running Distance':'walking_running_distance','Walking and Running Distance':'walking_running_distance','Apple Exercise Time':'apple_exercise_time','Apple Stand Time':'apple_stand_time','Flights Climbed':'flights_climbed'};
    const label=typeof csv.originalField==='string'?csv.originalField.replace(/ \([^()]*\)$/,''):'';
    const metric=own(byKind,r.kind)?byKind[r.kind]:own(byLabel,label)?byLabel[label]:null,def=metric&&METRICS[metric],day=dayAt(Date.parse(r.start));
    return def&&own(def.units,r.unit)&&day>=contract.activeFrom?metricDayKey(metric,def.unit,day):null;
  }
  for(const r of raw){
    const m=hae(r);if(!m){
      if(feedRecord(r)){heldIds.push(r.id);report.reasons.unknown_feed_namespace=(report.reasons.unknown_feed_namespace||0)+1;continue;}
      const key=csvKey(r);if(key)csvCandidates.push({record:r,key});else{records.push(r);activeIds.push(r.id);}continue;
    }
    report.rawBuckets++;
    if(!feedId(m.feedId)||m.feedId!==contract.feedId){heldIds.push(r.id);const reason=feedId(m.feedId)?'different_feed_namespace':'unknown_feed_namespace';report.reasons[reason]=(report.reasons[reason]||0)+1;continue;}
    if(!instant(r.start)||!validDay(m.day)){heldIds.push(r.id);report.reasons.unsupported_bucket_contract=(report.reasons.unsupported_bucket_contract||0)+1;continue;}
    report.latestData=latest(report.latestData,r.end||r.start);
    if(m.day<contract.activeFrom){shadowIds.push(r.id);continue;}
    // A workout is a session, not a metric bucket. It used to fall into the bucket grouping below,
    // find no METRICS entry and be held as outside the contract, so the workouts route imported
    // every session and displayed none of them. Sessions pass through as themselves.
    if(m.route==='workouts'){
      if(m.representation==='workout session'&&instant(r.end)){records.push(r);activeIds.push(r.id);sessions.push(r);}
      else{heldIds.push(r.id);report.reasons.unsupported_bucket_contract=(report.reasons.unsupported_bucket_contract||0)+1;}
      continue;
    }
    const key=JSON.stringify([m.metric,m.day]),group=groups.get(key)||[];group.push(r);groups.set(key,group);
  }
  function hold(group,reason){for(const r of group)heldIds.push(r.id);report.reasons[reason]=(report.reasons[reason]||0)+group.length;}
  function derived(group,def,day,value,type,reduction,stat,label){
    const inputIds=group.map(r=>r.id),source=label||group[0].sourceApp,last=group[group.length-1],m=hae(last);
    records.push({...clone(last),sourceApp:source,origin:'derived',id:'hae:projection:v1:'+JSON.stringify([contract.feedId,m.metric,def.unit,day,source,stat||reduction]),type,sourceRecordId:null,start:dayStart(day),end:null,value,unit:def.unit,durationSec:null,elapsedSec:null,idRule:'Derived display view; input bucket identities retained',unmapped:{healthAutoExport:{format:'JSON',adapterVersion:1,representation:'derived daily view',feedId:contract.feedId,canonicalUnit:def.unit,metric:m.metric,day,writerStatus:'single',inputIds,reduction,partial:true,complete:false,timeZone:contract.timeZone,originalUnits:[...new Set(group.map(x=>x.unit))],latestBucketStart:last.start}}});
    report.projected++;
  }
  for(let group of groups.values()){
    group.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
    // Apple Health wins disputes (Mintay, 2026-09-22). A bucket with an Apple device among its
    // writers — "Apple Watch|iFIT", "Apple Watch|iPhone" — is Apple Health's own figure for that
    // minute, already de-duplicated by the Health app's data-source priority before Health Auto
    // Export read it. Holding those buckets as "compound" left a full day of steps reading 340
    // instead of about 10,000. Other writers on a day Apple Health covers yield to it rather than
    // being added on top. Days with no Apple writer keep the old rules, so a blended
    // "Fitdays|MyFitnessPal" weight is still held and never shown as a measurement.
    const appleRows=group.filter(r=>hae(r).writerStatus!=='unknown'&&appleWriter(r.sourceApp));
    let label=null;
    if(appleRows.length){
      const others=group.filter(r=>!appleRows.includes(r));
      if(others.length)hold(others,'yielded_to_apple_health');
      group=appleRows;
      // Keep the writer's own name when one Apple device wrote the whole day, so days that already
      // projected keep the same derived identity; merged days are labelled as what they are.
      if(new Set(group.map(r=>r.sourceApp)).size>1)label='Apple Health';
    }else{
      const writers=new Set(group.map(r=>r.sourceApp));
      if(group.some(r=>hae(r).writerStatus!=='single')){hold(group,'unknown_or_compound_writer');continue;}
      if(writers.size!==1){hold(group,'multiple_writers');continue;}
    }
    const first=group[0],m=hae(first);
    if(group.some(r=>(r.clashes||[]).length)){hold(group,'unresolved_revision');continue;}
    const def=own(METRICS,m.metric)?METRICS[m.metric]:null;
    if(!def||group.some(r=>hae(r).contractVersion!==contract.version||hae(r).timeZone!==contract.timeZone||hae(r).day!==dayAt(Date.parse(hae(r).bucketStart||r.start))||hae(r).grouping!=='minute'||hae(r).representation!=='minute aggregate'||hae(r).canonicalUnit!==def.unit||r.sourceRecordId!==null||r.id!==bucketId(contract,m.metric,def.unit,r.sourceApp,hae(r).bucketStart||r.start)||!own(def.units,r.unit)||!Number.isFinite(r.value*def.units[r.unit])||(def.reduce==='heart'&&(!object(hae(r).stats)||!['min','avg','max'].every(k=>Number.isFinite(hae(r).stats[k])))))){hold(group,'unsupported_bucket_contract');continue;}
    const last=group[group.length-1],number=r=>r.value*def.units[r.unit];
    let sum=def.reduce==='sum'?group.reduce((total,r)=>total+number(r),0):null,credit=[];
    // Match the Move ring (Mintay, 2026-09-22). During a workout recorded by a connected app that
    // saved its own energy, Apple's minutes carry the Watch's reading while the ring credits the
    // app's figure: on September 21 the iFIT run was 400 kcal in minutes and 514 in the ring, and
    // swapping the workout's figure in for its window turned 739 into 850 against a ring of 856.
    // Apple's own workouts are already in the minutes and are left alone.
    if(def.kind==='activeEnergy'&&sum!==null){
      for(const w of sessions){
        const wm=hae(w),kcal=workoutKcal(wm.activeEnergy);
        if(wm.day!==m.day||appleWriter(w.sourceApp)||!(kcal>0))continue;
        const a=Date.parse(w.start),b=Date.parse(w.end);
        const inside=group.filter(r=>{const t=Date.parse(r.start);return t>=a&&t<=b;}).reduce((total,r)=>total+number(r),0);
        sum=sum-inside+kcal;credit.push(w);
      }
    }
    if(def.reduce==='sum'&&!Number.isFinite(sum)){hold(group,'quantity_overflow');continue;}
    qualifiedDays.add(metricDayKey(m.metric,def.unit,m.day));
    for(const r of group){activeIds.push(r.id);report.latestActiveData=latest(report.latestActiveData,r.start);}
    if(def.reduce==='sum'){
      derived(group,def,m.day,sum,def.label+' (partial received sum)',credit.length?'sum of received minute buckets, with '+credit.length+' connected-app workout'+(credit.length===1?'':'s')+' credited at its own energy for its window, as the Move ring does':'sum of distinct received minute buckets',null,label);
      if(credit.length){const meta=hae(records[records.length-1]);meta.inputIds=meta.inputIds.concat(credit.map(w=>w.id));meta.creditedWorkouts=credit.map(w=>w.id);}
    }
    // One night per wake day (Mintay, 2026-09-23): the latest reported night stands for that day,
    // keeping its own bedtime, wake time and stages rather than a midnight-anchored figure.
    else if(def.reduce==='sleep'){
      derived([last],def,m.day,number(last),def.label+' (night)','latest reported night; stages as reported','night',label);
      const night=records[records.length-1],stats=hae(last).stats||{};
      night.start=last.start;night.end=last.end;night.durationSec=Number.isFinite(stats.asleep)&&stats.asleep>0?Math.round(stats.asleep*3600):last.durationSec;
      hae(night).stats=clone(stats);
    }
    else if(def.reduce==='latest')derived(group,def,m.day,number(last),def.label+' (latest received bucket)','latest reported bucket; no averaging',null,label);
    else{
      derived(group,def,m.day,group.reduce((v,r)=>Math.min(v,hae(r).stats.min),Infinity),def.label+' (minimum received)','minimum of received bucket minima','min',label);
      derived([last],def,m.day,hae(last).stats.avg,def.label+' (latest minute average)','latest reported minute average; daily average unknown','avg',label);
      derived(group,def,m.day,group.reduce((v,r)=>Math.max(v,hae(r).stats.max),-Infinity),def.label+' (maximum received)','maximum of received bucket maxima','max',label);
    }
  }
  for(const candidate of csvCandidates){
    const r=candidate.record;
    if(qualifiedDays.has(candidate.key))shadowIds.push(r.id);else{records.push(r);activeIds.push(r.id);fallbackIds.push(r.id);}
  }
  report.baselineFallback=fallbackIds.length;
  report.active=activeIds.filter(id=>id.startsWith('hae:bucket:')).length;report.held=heldIds.length;report.shadow=shadowIds.length;
  return {ok:true,records,activeIds,heldIds,shadowIds,fallbackIds,report};
}
const api={parse,reconcile,project,validateContract,signature,foreignToFeed};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HealthAutoExport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
