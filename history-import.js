/* One-time history import (V3.1, option b). Reads a Health Auto Export JSON that covers a long span at day
   grain (such a file can be near a gigabyte) and turns it into rows the scores can use for baselines and
   history. Pure: bytes in, rows and a receipt out; the page does the file reading and
   the locked, sealed writes.

   Why its own path: the automatic intake reads whole files (the native reader stops at 128 MB) and its
   contract is minute grouping, so a day-summarised file dropped into the connected folder would be read as
   minute buckets and give wrong totals. Here the file is read in chunks and never parsed whole: the scanner
   walks the bytes and hands over one metric row or one workout at a time (a workout is read, reduced to its
   record and per-minute curves, and dropped), and passes over collections this app does not read without
   building them.

   What it writes
   - sparse metrics and sleep nights as `history day summary` rows (approx: a day's average, or the night as
     reported). Baselines and history may read them; the projection never counts them (hae-adapter.js).
   - daily totals of steps, energy and daylight, likewise marked, for history only.
   - workouts through the normal workout reader, so they keep the full record and its per-minute `detail`.
   What it never does
   - touch a stored row's facts. A metric-day the store already holds keeps its rows (the history row
     yields); a stored workout keeps everything, and only gains its heart-rate trace when it has none
     (`detail` is outside a row's signature, exactly as when a file is delivered again).
   - add a workout on or after the feed's scoring start: those days belong to the live feed, whose
     check-offs and points follow its own rows. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./hae-adapter.js'));
  else root.HistoryImport=factory(root.HealthAutoExport);
})(typeof globalThis!=='undefined'?globalThis:this,function(H){
  'use strict';
  const HISTORY=H.HISTORY,VERSION=1;
  // Day averages of readings, day sums of streams. Heavy all-day streams (heart rate, effort, sound) are
  // not re-derived from a summary: their minute rows and rollups come from the live feed only.
  const MEANS=['heart_rate_variability','resting_heart_rate','respiratory_rate','blood_oxygen_saturation','vo2_max','weight_body_mass','body_fat_percentage','lean_body_mass','body_mass_index',
    'walking_speed','walking_step_length','walking_asymmetry_percentage','walking_double_support_percentage','six_minute_walking_test_distance','stair_speed_up','stair_speed_down','cardio_recovery','walking_heart_rate_average','waist_circumference','height'];
  const SUMS=['step_count','active_energy','basal_energy_burned','time_in_daylight','apple_exercise_time'];
  // Wrist temperature is not in the adapter's METRICS yet: its unit is unverified until a real file shows
  // it. The importer keeps the value in the file's own unit and names that unit in the receipt.
  const OWN={apple_sleeping_wrist_temperature:{kind:'other',label:'Wrist temperature',reduce:'latest',signed:true}};
  // A reading taken now and then (a weigh-in, a VO2 max estimate) against a measure the Watch reports every
  // day. Spacing says different things about each: see the cadence rule in finish().
  const EVENTS=new Set(['vo2_max','weight_body_mass','body_fat_percentage','lean_body_mass','body_mass_index','waist_circumference','height','six_minute_walking_test_distance','cardio_recovery']);
  // The local clock of an instant, in the feed's zone: minutes after midnight as a clock on the wall reads.
  const wallClock=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const wallMinutes=ms=>{const p=Object.fromEntries(wallClock.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));return +p.hour*60+ +p.minute;};
  const kindOf=name=>name==='sleep_analysis'?'sleep':MEANS.includes(name)||OWN[name]?'mean':SUMS.includes(name)?'sum':null;
  const definition=(name,units)=>{if(OWN[name])return {...OWN[name],unit:units,units:{[units]:1}};return H.metric(name);};
  const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
  const finite=v=>typeof v==='number'&&Number.isFinite(v);

  /* ---------- SHA-256, fed in chunks (WebCrypto wants the whole file in memory) ---------- */
  const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(){
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),w=new Uint32Array(64),tail=new Uint8Array(64);
    let held=0,bytes=0,closed=false;
    function block(p,o){
      for(let i=0;i<16;i++)w[i]=(p[o+4*i]<<24|p[o+4*i+1]<<16|p[o+4*i+2]<<8|p[o+4*i+3])>>>0;
      for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+((a>>>7|a<<25)^(a>>>18|a<<14)^(a>>>3))+w[i-7]+((b>>>17|b<<15)^(b>>>19|b<<13)^(b>>>10)))>>>0;}
      let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],k=h[7];
      for(let i=0;i<64;i++){
        const t1=(k+((e>>>6|e<<26)^(e>>>11|e<<21)^(e>>>25|e<<7))+((e&f)^(~e&g))+K[i]+w[i])>>>0,t2=(((a>>>2|a<<30)^(a>>>13|a<<19)^(a>>>22|a<<10))+((a&b)^(a&c)^(b&c)))>>>0;
        k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
      }
      h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+k)>>>0;
    }
    function update(chunk){
      if(closed)throw new Error('digest already read');
      let o=0;const n=chunk.length;bytes+=n;
      if(held){const take=Math.min(64-held,n);tail.set(chunk.subarray(0,take),held);held+=take;o=take;if(held<64)return;block(tail,0);held=0;}
      for(;o+64<=n;o+=64)block(chunk,o);
      if(o<n){tail.set(chunk.subarray(o),0);held=n-o;}
    }
    function digest(){
      if(!closed){
        closed=true;const bits=bytes*8;tail[held++]=0x80;
        if(held>56){tail.fill(0,held);block(tail,0);held=0;}
        tail.fill(0,held,56);
        const high=Math.floor(bits/4294967296),low=bits>>>0;
        tail[56]=high>>>24;tail[57]=high>>>16&255;tail[58]=high>>>8&255;tail[59]=high&255;tail[60]=low>>>24;tail[61]=low>>>16&255;tail[62]=low>>>8&255;tail[63]=low&255;
        block(tail,0);
      }
      return Array.from(h,v=>v.toString(16).padStart(8,'0')).join('');
    }
    return {update,digest,get bytes(){return bytes;}};
  }

  /* ---------- the scanner: bytes in, one row or one workout out ----------
     It tracks only what JSON's structure needs (strings, escapes, brackets), so a multi-byte character can
     never be mistaken for structure, and a chunk may end anywhere, even inside a character or an escape.
     Paths read:  data.metrics[] {name, units, data[] → row}   and   data.workouts[] → workout.
     Key order inside an object does not matter; anything else is skipped without being built. */
  function scanner(handlers,options){
    const on=handlers||{},o=options||{},limits={row:o.maxRowBytes||1<<20,workout:o.maxWorkoutBytes||64<<20,key:4096,name:4096,units:4096};
    const frames=[],decoder=typeof TextDecoder!=='undefined'?new TextDecoder('utf-8'):null;
    let mode='walk',depth=0,inString=false,escape=false,capture=null,bytes=0,failure=null,bare=false;
    // Where a row or a workout should be an object, anything else (null, a number, text, a list) is refused by name.
    const refuse=r=>{if(on.invalid)on.invalid(r);};
    const top=()=>frames[frames.length-1];
    function role(){
      const t=top();if(!t)return 'root';
      if(t.object){const k=t.key;return t.role==='root'?(k==='data'?'data':'skip'):t.role==='data'?(k==='metrics'?'metrics':k==='workouts'?'workouts':'other'):t.role==='metric'?(k==='name'?'name':k==='units'?'units':k==='data'?'rows':'skip'):'skip';}
      return t.role==='metrics'?'metric':t.role==='rows'?'row':t.role==='workouts'?'workout':'skip';
    }
    const begin=(kind,at)=>{capture={kind,parts:[],start:at,size:0,limit:limits[kind],dropped:false};};
    function text(chunk,end){
      const c=capture;capture=null;
      if(c.dropped)return null;
      if(c.start<end)c.parts.push(chunk.subarray(c.start,end));
      if(c.parts.length===1)return decoder.decode(c.parts[0]);
      const stream=new TextDecoder('utf-8');let out='';for(const p of c.parts)out+=stream.decode(p,{stream:true});return out+stream.decode();
    }
    const parse=(kind,raw)=>{try{return JSON.parse(raw);}catch(e){if(on.invalid)on.invalid(kind);return undefined;}};
    function feed(chunk){
      if(failure)return;
      const n=chunk.length;
      for(let i=0;i<n;i++){
        const b=chunk[i];
        if(inString){
          if(escape)escape=false;
          else if(b===0x5C)escape=true;
          else if(b===0x22){
            inString=false;
            if(mode==='walk'&&capture){
              const kind=capture.kind,raw=text(chunk,i+1),value=raw===null?undefined:parse(kind,raw);
              if(kind==='key'){if(typeof value==='string')top().key=value;else top().key=null;}
              else if(typeof value==='string'&&on[kind])on[kind](value);
            }
          }
          continue;
        }
        if(b===0x22){
          inString=true;
          if(mode==='walk'){const t=top();if(t&&t.object&&t.expectKey)begin('key',i);else{const r=role();if(r==='name'||r==='units')begin(r,i);else if(r==='row'||r==='workout')refuse(r);}}
          continue;
        }
        if(mode!=='walk'){
          if(b===0x7B||b===0x5B)depth++;
          else if(b===0x7D||b===0x5D){
            if(--depth===0){
              const was=mode;mode='walk';
              if(was==='element'){
                // The limit holds however the file was cut: an element inside one chunk is measured here.
                if(capture.size+(i+1-capture.start)>capture.limit){capture.dropped=true;capture.parts=[];}
                const kind=capture.kind,dropped=capture.dropped,raw=text(chunk,i+1);
                if(dropped){if(on.oversize)on.oversize(kind);}
                else{const value=parse(kind,raw);if(value!==undefined&&on[kind])on[kind](value);}
              }
            }
          }
          continue;
        }
        if(b===0x7B||b===0x5B){
          const r=role(),isObject=b===0x7B;
          if((r==='root'||r==='data'||r==='metric')&&isObject){frames.push({object:true,role:r,expectKey:true,key:null});if(r==='metric'&&on.metricStart)on.metricStart();}
          else if((r==='metrics'||r==='rows'||r==='workouts')&&!isObject)frames.push({object:false,role:r});
          else if((r==='row'||r==='workout')&&isObject){mode='element';depth=1;begin(r,i);}
          else{if(r==='other'&&on.other)on.other(top().key);else if(r==='row'||r==='workout')refuse(r);mode='skip';depth=1;}
        }else if(b===0x7D||b===0x5D){
          const f=frames.pop();bare=false;
          if(!f||f.object!==(b===0x7D)){failure='The file’s brackets do not match.';return;}
          if(f.role==='metric'&&on.metricEnd)on.metricEnd();
        }else if(b===0x3A){const t=top();if(t&&t.object)t.expectKey=false;}
        else if(b===0x2C){bare=false;const t=top();if(t&&t.object){t.expectKey=true;t.key=null;}}
        else if(b>0x20&&!bare){bare=true;const r=role();if(r==='row'||r==='workout')refuse(r);}
      }
      bytes+=n;
      // A capture that continues into the next chunk keeps what it has; one past its limit is dropped.
      if(capture){
        if(!capture.dropped){const part=chunk.subarray(capture.start);capture.size+=part.length;if(capture.size>capture.limit){capture.dropped=true;capture.parts=[];}else capture.parts.push(part);}
        capture.start=0;
      }
    }
    function end(){
      if(failure)return {ok:false,error:failure,bytes};
      if(inString||mode!=='walk'||frames.length||capture)return {ok:false,error:'The file ends before its JSON does; it may be incomplete.',bytes};
      return {ok:true,bytes};
    }
    return {feed,end};
  }

  /* ---------- the reader: reduces rows to day values as they arrive ---------- */
  function reader(options){
    const o=options||{},contract=o.contract,problem=H.validateContract(contract);
    if(problem)throw new Error(problem);
    const placeholder='0'.repeat(64),at=o.at||new Date().toISOString();
    const delivery={id:'history',feedId:contract.feedId,fileId:String(o.fileName||'history.json').slice(0,1024),digest:placeholder,modifiedAt:o.modifiedAt||at,receivedAt:at};
    const workoutContract={...contract,route:'workouts'};
    const metrics=[],workouts=[],seenWorkouts=new Set(),others={},hours=new Map();
    const report={rows:0,invalidRows:0,oversizeRows:0,workouts:{seen:0,invalid:0,oversize:0,duplicate:0,withCurves:0,withRecovery:0}};
    let current=null;
    // The local day of an instant. Pacific time sits whole hours from UTC, so every instant of one UTC hour
    // falls on the same local day: one formatter call per hour of data, not per row.
    function dayOf(ms){const hour=Math.floor(ms/3600000);let d=hours.get(hour);if(!d){d=H.dayAt(ms);hours.set(hour,d);}return d;}
    const bucket=(day,writer)=>{let perDay=current.days.get(day);if(!perDay){perDay=new Map();current.days.set(day,perDay);}let s=perDay.get(writer);if(!s){s={n:0,sum:0,min:Infinity,max:-Infinity};perDay.set(writer,s);}return s;};
    function row(r){
      report.rows++;if(!current)return;current.rows++;
      if(!object(r)||typeof r.date!=='string'){current.invalid++;report.invalidRows++;return;}
      const t=H.instant(r.date,true)||H.instant(r.date);
      if(!t){current.invalid++;report.invalidRows++;return;}
      const day=dayOf(t.ms),writer=typeof r.source==='string'&&r.source.trim()?r.source:'unknown';
      if(r.date.slice(11,19)==='00:00:00')current.midnights.add(r.date.slice(0,10));else current.offMidnight=true;
      if(finite(r.totalSleep)||finite(r.asleep)||typeof r.sleepStart==='string'){current.nights.push({day,writer,row:r});return;}
      const value=finite(r.qty)?r.qty:finite(r.Avg)?r.Avg:null;
      if(value===null){current.invalid++;report.invalidRows++;return;}
      const s=bucket(day,writer);s.n++;s.sum+=value;s.min=Math.min(s.min,finite(r.Min)?r.Min:value);s.max=Math.max(s.max,finite(r.Max)?r.Max:value);
    }
    function workout(w){
      report.workouts.seen++;
      const parsed=H.parse({data:{workouts:[w]}},{contract:workoutContract,delivery});
      if(!parsed.ok||parsed.records.length!==1){report.workouts.invalid++;return;}
      const r=parsed.records[0];
      if(seenWorkouts.has(r.id)){report.workouts.duplicate++;return;}
      seenWorkouts.add(r.id);
      if(r.detail&&r.detail.hr)report.workouts.withCurves++;
      if(r.detail&&r.detail.recovery)report.workouts.withRecovery++;
      workouts.push(r);
    }
    const scan=scanner({
      metricStart(){current={name:null,units:null,rows:0,invalid:0,days:new Map(),nights:[],midnights:new Set(),offMidnight:false};},
      name(v){if(current)current.name=v;},units(v){if(current)current.units=v;},row,
      metricEnd(){if(current)metrics.push(current);current=null;},
      workout,other(name){others[String(name)]=(others[String(name)]||0)+1;},
      invalid(kind){if(kind==='workout')report.workouts.invalid++;else if(kind==='row'){report.rows++;report.invalidRows++;if(current){current.rows++;current.invalid++;}}},
      oversize(kind){if(kind==='workout'){report.workouts.seen++;report.workouts.oversize++;}else{report.rows++;report.oversizeRows++;}}
    },o);
    const hash=sha256();
    return {
      feed(chunk){hash.update(chunk);scan.feed(chunk);},
      /* Everything read, as candidates: history rows not yet matched against the store. */
      finish(){
        const state=scan.end(),digest=hash.digest();
        if(!state.ok)return {ok:false,error:state.error,digest,bytes:state.bytes};
        if(!metrics.length&&!report.workouts.seen)return {ok:false,error:'This file has no data.metrics or data.workouts to read; it does not look like a Health Auto Export JSON.',digest,bytes:state.bytes};
        const file={name:delivery.fileId,bytes:state.bytes,sha256:digest};
        const stamp={fileId:delivery.fileId,digest,modifiedAt:delivery.modifiedAt,receivedAt:at};
        for(const r of workouts)r.unmapped.healthAutoExport.delivery={...stamp};
        const rows=[],summary={};
        for(const m of metrics){
          const name=typeof m.name==='string'?m.name:'(unnamed)',kind=kindOf(name),def=kind&&typeof m.units==='string'?definition(name,m.units):null;
          const s=summary[name]||(summary[name]={unit:typeof m.units==='string'?m.units:null,rows:0,days:0,invalid:0,written:0,yielded:0});
          s.rows+=m.rows;s.invalid+=m.invalid;
          if(!kind){s.reason='not part of the history import';continue;}
          if(!def||!Object.prototype.hasOwnProperty.call(def.units,m.units)){s.reason='unit not recognised';continue;}
          // Rows a whole number of weeks apart are a week's figure, not a day's: a week's total for a sum
          // (two rows are enough to say so), a week's average for a measure the Watch reports daily, such as
          // heart rate variability or resting heart rate (three rows; two may be chance). A now-and-then
          // reading and a night keep such spacing while it is short: a VO2 max taken three Mondays running
          // is three readings, eight in a row is a weekly export. A night is also checked on its own below.
          const enough=kind==='sum'?2:kind==='mean'&&!EVENTS.has(name)?3:8;
          if(!m.offMidnight&&m.midnights.size>=enough&&weekly([...m.midnights])){s.reason=kind==='sum'?'weekly totals, not days':'weekly averages, not days';continue;}
          const made=kind==='sleep'?nights(m,def,contract,stamp,at):days(m,name,def,kind,contract,stamp,at);
          s.days+=made.length;rows.push(...made);
        }
        return {ok:true,file,digest,at,rows,workouts,summary,report,others};
      }
    };
  }
  /* Rows a whole number of weeks apart, each at midnight: the export grouped this metric by week (the
     year files do), and a week's figure is not a day's. */
  function weekly(stamps){
    if(stamps.length<2)return false;
    const days=[...new Set(stamps)].map(s=>Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10))/86400000).sort((a,b)=>a-b);
    if(days.length<2)return false;
    for(let i=1;i<days.length;i++){const gap=Math.round(days[i]-days[i-1]);if(gap<7||gap%7)return false;}
    return true;
  }
  const historyId=(feed,metric,unit,day)=>'hae:history:v1:'+JSON.stringify([feed,metric,unit,day]);
  function meta(contract,name,def,day,unit,stamp,extra){
    return {format:'JSON',adapterVersion:1,contractVersion:contract.version,feedId:contract.feedId,route:'health-metrics',metric:name,day,representation:HISTORY,grouping:'day',approx:true,timeZone:contract.timeZone,
      canonicalUnit:def.unit,unitFactor:def.units[unit],originalUnit:unit,providerIdentity:'unavailable',historyVersion:VERSION,delivery:{...stamp},...extra};
  }
  function base(contract,name,def,day,writer,at){
    return {id:historyId(contract.feedId,name,def.unit,day),kind:def.kind,type:def.label+' ('+HISTORY+')',sourceApp:writer,sourceRecordId:null,device:null,start:H.dayStart(day),end:null,
      idRule:'Health Auto Export history day summary v1: feed, metric, canonical unit and day',origin:'source-recorded (one-time history file)',transport:'local file',relayedBy:'history import',source:'Health Auto Export JSON',relayedAt:null,window:{from:day,to:day},importedAt:at};
  }
  function days(m,name,def,kind,contract,stamp,at){
    const out=[],signed=!!def.signed;
    for(const [day,writers] of [...m.days].sort((a,b)=>a[0]<b[0]?-1:1)){
      // Apple Health wins disputes (decided Sept 22): where an Apple device is among a day's writers, its
      // rows stand for the day. A sum never adds two writers together, so nothing is counted twice.
      let list=[...writers].filter(([,s])=>s.n&&finite(s.sum)),apple=list.filter(([w])=>H.appleWriter(w));
      if(apple.length)list=apple;if(!list.length)continue;
      let value,writer,samples;
      if(kind==='sum'){const best=list.reduce((a,b)=>b[1].sum>a[1].sum?b:a);value=best[1].sum;writer=best[0];samples=best[1].n;}
      else{samples=list.reduce((n,[,s])=>n+s.n,0);value=list.reduce((n,[,s])=>n+s.sum,0)/samples;writer=list.length===1?list[0][0]:[...new Set(list.flatMap(([w])=>w.split('|').map(x=>x.trim())))].join(' + ');}
      if(!finite(value)||(value<0&&!signed)||(def.kind==='weight'&&value<=0))continue;
      out.push({...base(contract,name,def,day,writer,at),value,unit:m.units,durationSec:null,elapsedSec:null,
        unmapped:{healthAutoExport:meta(contract,name,def,day,m.units,stamp,{reduction:kind==='sum'?'day sum':'day mean',samples,writerStatus:writer==='unknown'?'unknown':writer.includes('|')||writer.includes(' + ')?'compound':'single',originalWriter:writer})}});
    }
    return out;
  }
  /* A night is kept as reported, with its own bedtime, wake time and stages: one per wake day, the longest
     that ends in the morning (03:00–13:00); a day with only a daytime sleep keeps none. */
  function nights(m,def,contract,stamp,at){
    const byDay=new Map(),factor=def.units[m.units];
    for(const n of m.nights){
      const r=n.row,total=(finite(r.totalSleep)&&r.totalSleep>0?r.totalSleep:finite(r.asleep)&&r.asleep>0?r.asleep:['core','deep','rem'].reduce((s,k)=>s+(finite(r[k])?r[k]:0),0))*factor;
      if(!(total>0)||total>24)continue;
      const start=H.instant(r.sleepStart,true),end=H.instant(r.sleepEnd,true);
      let day=n.day;
      // The wake time is read off the wall clock, not counted from midnight: on the two days the clocks
      // change, 03:15 and 12:30 are 135 and 810 minutes after midnight and would fall outside 03:00–13:00.
      if(end){day=H.dayAt(end.ms);const minutes=wallMinutes(end.ms);if(minutes<180||minutes>780)continue;}
      const held=byDay.get(day);if(!held||total>held.total)byDay.set(day,{total,start,end,row:r,writer:n.writer});
    }
    const out=[],hours=(r,k)=>finite(r[k])&&r[k]>=0?r[k]:null;
    for(const [day,n] of [...byDay].sort((a,b)=>a[0]<b[0]?-1:1)){
      const r=n.row,stats={totalSleep:hours(r,'totalSleep'),core:hours(r,'core'),deep:hours(r,'deep'),rem:hours(r,'rem'),awake:hours(r,'awake'),asleep:hours(r,'asleep'),inBed:hours(r,'inBed'),
        sleepStart:r.sleepStart||null,sleepEnd:r.sleepEnd||null,inBedStart:r.inBedStart||null,inBedEnd:r.inBedEnd||null};
      for(const k of ['totalSleep','core','deep','rem','awake','asleep','inBed'])if(stats[k]!==null)stats[k]=stats[k]*factor;      // the adapter's sleep unit is hours
      if(!stats.totalSleep)stats.totalSleep=n.total;
      out.push({...base(contract,'sleep_analysis',def,day,n.writer,at),type:def.label+' (night, history)',start:n.start?n.start.text:H.dayStart(day),end:n.end?n.end.text:null,value:n.total,unit:'hr',durationSec:Math.round(n.total*3600),elapsedSec:null,
        unmapped:{healthAutoExport:{...meta(contract,'sleep_analysis',def,day,'hr',stamp,{reduction:'night',stats,samples:1,writerStatus:n.writer==='unknown'?'unknown':n.writer.includes('|')?'compound':'single',originalWriter:n.writer}),approx:false,unitFactor:1}}});
    }
    return out;
  }

  /* ---------- the plan: what the store lacks, and nothing it already has ---------- */
  function plan(existing,read,options){
    const o=options||{},contract=o.contract,held=new Set(),ids=new Map();
    for(const r of existing||[]){
      ids.set(r.id,r);
      const m=r.unmapped&&r.unmapped.healthAutoExport;
      if(m&&typeof m.metric==='string'&&typeof m.day==='string'&&m.representation!==HISTORY)held.add(m.metric+'|'+m.day);
    }
    const add=[],traces=[],summary=JSON.parse(JSON.stringify(read.summary)),w={...read.report.workouts,written:0,yielded:0,tracesAdded:0,leftToFeed:0};
    let same=0;
    for(const r of read.rows){
      const m=r.unmapped.healthAutoExport,s=summary[m.metric];
      if(ids.has(r.id)){same++;s.same=(s.same||0)+1;continue;}                              // this file, imported before
      if(held.has(m.metric+'|'+m.day)||(m.metric==='weight_body_mass'&&held.has('weight_&_body_mass|'+m.day))){s.yielded++;continue;}
      add.push(r);s.written++;
    }
    for(const r of read.workouts){
      const old=ids.get(r.id);
      if(old){
        if(r.detail&&r.detail.hr&&!(old.detail&&old.detail.hr)){traces.push({id:r.id,detail:r.detail});w.tracesAdded++;}
        else{w.yielded++;if(old.unmapped&&old.unmapped.healthAutoExport&&old.unmapped.healthAutoExport.delivery&&old.unmapped.healthAutoExport.delivery.digest===read.digest)same++;}
        continue;
      }
      if(r.unmapped.healthAutoExport.day>=contract.activeFrom){w.leftToFeed++;continue;}
      add.push(r);w.written++;
    }
    const daysOf=add.map(r=>r.unmapped.healthAutoExport.day).sort();
    return {add,traces,same,summary,workouts:w,span:daysOf.length?{from:daysOf[0],to:daysOf[daysOf.length-1]}:null};
  }
  /* Rows in write order, in batches small enough that each sealed write stays quick. */
  function batches(planned,size){
    const n=size||1500,out=[];let rows=[],traces=[],weight=0;
    const flush=()=>{if(rows.length||traces.length){out.push({rows,traces});rows=[];traces=[];weight=0;}};
    for(const r of planned.add){rows.push(r);weight+=r.detail?15:1;if(weight>=n)flush();}
    for(const t of planned.traces){traces.push(t);weight+=15;if(weight>=n)flush();}
    flush();return out;
  }
  /* One batch applied to a copy of the store's rows: new rows appended, a missing trace attached. Every row
     the store already held keeps its identity, its order and its signature. */
  function apply(existing,batch){
    const traces=new Map(batch.traces.map(t=>[t.id,t.detail])),have=new Set(existing.map(r=>r.id));
    const rows=traces.size?existing.map(r=>traces.has(r.id)&&!(r.detail&&r.detail.hr)?{...r,detail:{...(r.detail||{}),...traces.get(r.id)}}:r):existing.slice();
    for(const r of batch.rows)if(!have.has(r.id)){rows.push(r);have.add(r.id);}
    return rows;
  }
  function receipt(read,planned,options){
    const o=options||{},w=planned.workouts,metrics=planned.summary;
    const invalid=read.report.invalidRows+read.report.oversizeRows+w.invalid+w.oversize,unsupported=Object.values(metrics).filter(m=>m.reason).reduce((n,m)=>n+m.rows,0);
    return {id:'history:'+read.digest,at:read.at,transport:'history file',counts:{added:planned.add.length,same:planned.same,clash:0,invalid,unsupported},
      feedId:o.contract.feedId,status:o.status||'complete',file:read.file,span:planned.span,metrics,
      workouts:{seen:w.seen,written:w.written,withCurves:w.withCurves,withRecovery:w.withRecovery,tracesAdded:w.tracesAdded,yielded:w.yielded,leftToFeed:w.leftToFeed,duplicate:w.duplicate,invalid:w.invalid,oversize:w.oversize},
      otherCollections:read.others,unchanged:o.unchanged||null,receivedKinds:[...new Set(planned.add.map(r=>r.kind))],
      warnings:['Day values from a history file fill baselines and history only; they never stand for today, and the daily displays and check-offs never count them.']};
  }
  /* One digest over the signatures of a set of rows, to show that what was stored is what is still stored.
     A signature leaves out `detail` and delivery stamps, as the store's own comparison does. */
  function fingerprint(rows){
    const hash=sha256(),encoder=new TextEncoder();
    for(const r of rows)hash.update(encoder.encode(r.id+'\n'+H.signature(r)+'\n'));
    return hash.digest();
  }
  return {VERSION,HISTORY,MEANS,SUMS,sha256,scanner,reader,weekly,plan,batches,apply,receipt,fingerprint,historyId};
});
