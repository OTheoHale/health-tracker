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
  'weight_&_body_mass':{kind:'weight',label:'Weight',unit:'kg',units:{kg:1,lb:0.45359237,lbs:0.45359237},reduce:'latest'},
  walking_running_distance:{kind:'other',label:'Walking and running distance',unit:'km',units:{km:1,mi:1.609344,m:0.001},reduce:'sum'},
  apple_exercise_time:{kind:'other',label:'Exercise time',unit:'min',units:{min:1,hr:60},reduce:'sum'},
  apple_stand_time:{kind:'other',label:'Stand time',unit:'min',units:{min:1,hr:60},reduce:'sum'},
  flights_climbed:{kind:'other',label:'Flights climbed',unit:'count',units:{count:1},reduce:'sum'}
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
function validateContract(c){
  return !object(c)||!feedId(c.feedId)||c.version!==1||c.format!==FORMAT||c.route!=='health-metrics'||c.grouping!=='minute'||c.timeZone!=='America/Los_Angeles'||!validDay(c.activeFrom)||c.sleepMode!=='exclude'?
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
function bucketId(c,metric,unit,source,start){return 'hae:bucket:v1:'+JSON.stringify([1,c.feedId,c.route,c.grouping,metric,unit,source,new Date(Date.parse(start)).toISOString(),'minute aggregate']);}
function signature(r){
  const v=clone(r),m=hae(v);if(m)delete m.delivery;
  for(const k of ['importedAt','lastSeenAt','lastRetrievedAt','sourceCorrectedAt','revision'])delete v[k];
  return JSON.stringify(ordered(v));
}
function contentSignature(r){const v=clone(r);delete v.clashes;delete v.resolutions;return signature(v);}
function quantity(v,positive){if(typeof v!=='number'||!Number.isFinite(v)||v<0||(positive&&v===0))throw new Error('invalid_quantity');return v;}
function parse(input,options){
  const c=options&&options.contract,d=options&&options.delivery,problem=validateContract(c)||validateDelivery(d);
  const report={format:'health-auto-export-json-review',version:1,counts:{input:0,accepted:0,invalid:0,excluded:0,duplicate:0,held:0},issues:[],excludedCollections:[],complete:false,
    limitations:['The payload does not attest export version or grouping; explicitly confirmed settings supply that contract. A shape-compatible settings change cannot be detected from these files alone.','File modification time orders local deliveries; it is not a provider revision or source retrieval time.','Missing buckets and metrics remain unknown. Imports grant no activity points.','Automatic workouts and sleep require separately supported routes. Existing CSV workouts and separate sleep quantities are retained.']};
  const stop=error=>({ok:false,error,records:[],report});
  if(problem)return stop(problem);
  if(d.feedId!==undefined&&d.feedId!==c.feedId)return stop('Native delivery belongs to a different feed namespace.');
  let obj=input;
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
    if(Object.keys(metric).some(k=>!['name','units','data'].includes(k))||typeof metric.units!=='string'||!own(def.units,metric.units)){report.counts.invalid++;issue(mp,'unsupported_metric_unit_or_schema');continue;}
    for(let ri=0;ri<metric.data.length;ri++){
      const row=metric.data[ri],rp=mp+'.data['+ri+']';report.counts.input++;
      if(report.counts.input>250000){report.counts.invalid++;issue(mp,'file_row_limit');return stop('File exceeds the supported row limit; reduce the export payload.');}
      try{
        const allowed=def.reduce==='heart'?['date','source','Min','Avg','Max']:['date','source','qty'];
        if(!object(row)||Object.keys(row).some(k=>!allowed.includes(k)))throw new Error('unsupported_supported_row_schema');
        const date=instant(row.date,true);
        if(!date||date.text.slice(17,19)!=='00')throw new Error('minute_bucket_requires_offset_minute_timestamp');
        const w=writer(row.source),day=dayAt(date.ms);let value,stats;
        if(def.reduce==='heart'){
          stats={min:quantity(row.Min),avg:quantity(row.Avg),max:quantity(row.Max)};
          if(stats.min>stats.avg||stats.avg>stats.max)throw new Error('invalid_heart_rate_range');value=stats.avg;
        }else value=quantity(row.qty,def.kind==='weight');
        const meta={format:'JSON',adapterVersion:1,contractVersion:c.version,feedId:c.feedId,metric:metric.name,grouping:c.grouping,representation:'minute aggregate',day,writerStatus:w.status,originalWriter:w.label,originalStart:row.date,originalTimestamp:row.date,timeZone:c.timeZone,timezoneBasis:'source offset retained; display and cutover use confirmed timezone',originalUnit:metric.units,bucketEnd:'No source end supplied for metric bucket',reduction:def.reduce,canonicalUnit:def.unit,unitFactor:def.units[metric.units],...(stats?{stats}:{}),providerIdentity:'unavailable',delivery:{fileId:d.fileId,digest:d.digest,modifiedAt:d.modifiedAt,...(own(d,'modifiedAtMs')?{modifiedAtMs:d.modifiedAtMs}:{}),receivedAt:d.receivedAt}};
        const r={id:bucketId(c,metric.name,def.unit,w.label,date.text),kind:def.kind,type:def.label+' (minute aggregate)',sourceApp:w.label,sourceRecordId:null,device:null,start:date.text,end:null,value,unit:metric.units,durationSec:null,elapsedSec:null,idRule:'Health Auto Export bucket v1: feed ID, route, grouping, metric, canonical unit, full writer, instant, representation; excludes value',origin:'source-recorded (local automatic file)',transport:'local folder',relayedBy:'local folder',source:'Health Auto Export JSON',relayedAt:null,window:{from:day,to:day},unmapped:{healthAutoExport:meta}};
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
  if(existing.some(r=>feedRecord(r)&&(!hae(r)||hae(r).feedId!==c.feedId)))return stop('Existing feed sources contain a different or unknown namespace; preserve them for review.');
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
    const def=own(METRICS,m.metric)?METRICS[m.metric]:null;
    if(!def||m.contractVersion!==c.version||m.grouping!==c.grouping||m.timeZone!==c.timeZone||m.representation!=='minute aggregate'||m.canonicalUnit!==def.unit||!instant(r.start)||m.day!==dayAt(Date.parse(r.start))||r.id!==bucketId(c,m.metric,def.unit,r.sourceApp,r.start)||r.sourceRecordId!==null)return stop('Parsed bucket identity or canonical unit is invalid.');
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
  const records=[],activeIds=[],heldIds=[],shadowIds=[],fallbackIds=[],csvCandidates=[],qualifiedDays=new Set(),groups=new Map(),report={complete:false,rawBuckets:0,active:0,held:0,shadow:0,projected:0,baselineFallback:0,latestData:null,latestActiveData:null,reasons:{},label:'Partial received data; missing buckets are unknown'};
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
    const key=JSON.stringify([m.metric,m.day]),group=groups.get(key)||[];group.push(r);groups.set(key,group);
  }
  function hold(group,reason){for(const r of group)heldIds.push(r.id);report.reasons[reason]=(report.reasons[reason]||0)+group.length;}
  function derived(group,def,day,value,type,reduction,stat){
    const inputIds=group.map(r=>r.id),source=group[0].sourceApp,last=group[group.length-1],m=hae(last);
    records.push({...clone(last),origin:'derived',id:'hae:projection:v1:'+JSON.stringify([contract.feedId,m.metric,def.unit,day,source,stat||reduction]),type,sourceRecordId:null,start:dayStart(day),end:null,value,unit:def.unit,durationSec:null,elapsedSec:null,idRule:'Derived display view; input bucket identities retained',unmapped:{healthAutoExport:{format:'JSON',adapterVersion:1,representation:'derived daily view',feedId:contract.feedId,canonicalUnit:def.unit,metric:m.metric,day,writerStatus:'single',inputIds,reduction,partial:true,complete:false,timeZone:contract.timeZone,originalUnits:[...new Set(group.map(x=>x.unit))],latestBucketStart:last.start}}});
    report.projected++;
  }
  for(const group of groups.values()){
    group.sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)||a.id.localeCompare(b.id));
    const first=group[0],m=hae(first),writers=new Set(group.map(r=>r.sourceApp));
    if(group.some(r=>hae(r).writerStatus!=='single')){hold(group,'unknown_or_compound_writer');continue;}
    if(writers.size!==1){hold(group,'multiple_writers');continue;}
    if(group.some(r=>(r.clashes||[]).length)){hold(group,'unresolved_revision');continue;}
    const def=own(METRICS,m.metric)?METRICS[m.metric]:null;
    if(!def||group.some(r=>hae(r).contractVersion!==contract.version||hae(r).timeZone!==contract.timeZone||hae(r).day!==dayAt(Date.parse(r.start))||hae(r).grouping!=='minute'||hae(r).representation!=='minute aggregate'||hae(r).canonicalUnit!==def.unit||r.sourceRecordId!==null||r.id!==bucketId(contract,m.metric,def.unit,r.sourceApp,r.start)||!own(def.units,r.unit)||!Number.isFinite(r.value*def.units[r.unit])||(def.reduce==='heart'&&(!object(hae(r).stats)||!['min','avg','max'].every(k=>Number.isFinite(hae(r).stats[k])))))){hold(group,'unsupported_bucket_contract');continue;}
    const last=group[group.length-1],number=r=>r.value*def.units[r.unit],sum=def.reduce==='sum'?group.reduce((total,r)=>total+number(r),0):null;
    if(def.reduce==='sum'&&!Number.isFinite(sum)){hold(group,'quantity_overflow');continue;}
    qualifiedDays.add(metricDayKey(m.metric,def.unit,m.day));
    for(const r of group){activeIds.push(r.id);report.latestActiveData=latest(report.latestActiveData,r.start);}
    if(def.reduce==='sum')derived(group,def,m.day,sum,def.label+' (partial received sum)','sum of distinct received minute buckets');
    else if(def.reduce==='latest')derived(group,def,m.day,number(last),def.label+' (latest received bucket)','latest reported bucket; no averaging');
    else{
      derived(group,def,m.day,group.reduce((v,r)=>Math.min(v,hae(r).stats.min),Infinity),def.label+' (minimum received)','minimum of received bucket minima','min');
      derived([last],def,m.day,hae(last).stats.avg,def.label+' (latest minute average)','latest reported minute average; daily average unknown','avg');
      derived(group,def,m.day,group.reduce((v,r)=>Math.max(v,hae(r).stats.max),-Infinity),def.label+' (maximum received)','maximum of received bucket maxima','max');
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
const api={parse,reconcile,project,validateContract,signature};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.HealthAutoExport=api;
})(typeof globalThis!=='undefined'?globalThis:this);
