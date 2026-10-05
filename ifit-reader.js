/* Glow V3.7 Block 5 (docs/V3.7_BUILD_BRIEF.md O1, O4, O5, O10; research vo2max-estimate-method-2026-10-04.md §5).
   Pure: reads an iFIT TCX text into a session summary with 3-minute windows, estimates VO2 max from those windows (ACSM
   cost over the heart-rate reserve), and judges the shadow ledger's gate. Nothing is stored and no store is read; the
   local day is the page's job (sourceLocalDay), so `start` stays the ISO string. Per-second points never leave parse (A31). */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.IfitReader=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const fin=Number.isFinite,WIN=180;
  const num=s=>{if(s==null)return null;const t=String(s).trim();if(!t)return null;const v=Number(t);return fin(v)?v:null;};
  const mean=a=>a.length?a.reduce((n,v)=>n+v,0)/a.length:null;
  const median=a=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  // Strict ISO with a zone, so WebKit and V8 agree on what parses.
  const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)$/;
  const ROOT=/<(?:[\w.-]+:)?TrainingCenterDatabase\b/;
  const P='(?:[\\w.-]+:)?';
  const blocks=(text,tag)=>{const re=new RegExp('<'+P+tag+'\\b[^>]*>([\\s\\S]*?)</'+P+tag+'>','g'),out=[];let m;while((m=re.exec(text)))out.push(m[1]);return out;};
  const val=(body,tag)=>{const m=new RegExp('<'+P+tag+'\\b[^>]*>([^<]*)</'+P+tag+'>').exec(body);return m?m[1]:null;};
  const count=(text,re)=>(text.match(re)||[]).length;

  // Both readers return raw strings per trackpoint and lap; one conversion below keeps their results identical.
  function scan(text){
    if(!new RegExp('</'+P+'TrainingCenterDatabase>').test(text))return {reason:'the file is cut off or garbled'};
    if(count(text,new RegExp('<'+P+'Trackpoint\\b','g'))!==count(text,new RegExp('</'+P+'Trackpoint>','g')))return {reason:'the file is cut off or garbled'};
    const points=blocks(text,'Trackpoint').map(b=>{const hr=blocks(b,'HeartRateBpm')[0];
      return {time:val(b,'Time'),d:val(b,'DistanceMeters'),hr:hr==null?null:val(hr,'Value'),alt:val(b,'AltitudeMeters'),watts:val(b,'Watts')};});
    const laps=blocks(text,'Lap').map(b=>{const own=b.replace(new RegExp('<'+P+'Track\\b[^>]*>[\\s\\S]*?</'+P+'Track>','g'),'');
      return {totalTimeSec:val(own,'TotalTimeSeconds'),distanceM:val(own,'DistanceMeters'),calories:val(own,'Calories'),avgWatts:val(own,'AverageWatts')??val(own,'AvgWatts')};});
    return {points,laps};
  }
  function dom(text){
    const doc=new DOMParser().parseFromString(text,'application/xml');
    if(doc.getElementsByTagName('parsererror').length||doc.getElementsByTagNameNS('*','parsererror').length)return {reason:'the file is cut off or garbled'};
    if(!doc.documentElement||doc.documentElement.localName!=='TrainingCenterDatabase')return {reason:'not a TCX file'};
    const all=(el,tag)=>Array.from(el.getElementsByTagNameNS('*',tag)),first=(el,tag)=>{const e=el.getElementsByTagNameNS('*',tag)[0];return e?e.textContent:null;};
    const child=(el,tag)=>{for(const c of Array.from(el.children||[]))if(c.localName===tag)return c.textContent;return null;};
    const points=all(doc,'Trackpoint').map(e=>{const hr=e.getElementsByTagNameNS('*','HeartRateBpm')[0];
      return {time:first(e,'Time'),d:first(e,'DistanceMeters'),hr:hr?first(hr,'Value'):null,alt:first(e,'AltitudeMeters'),watts:first(e,'Watts')};});
    const laps=all(doc,'Lap').map(e=>({totalTimeSec:child(e,'TotalTimeSeconds'),distanceM:child(e,'DistanceMeters'),calories:child(e,'Calories'),avgWatts:first(e,'AverageWatts')??first(e,'AvgWatts')}));
    return {points,laps};
  }

  function parse(text,opts){
    const fileName=(opts&&opts.fileName)||null;
    if(typeof text!=='string'||!ROOT.test(text))return {ok:false,reason:'not a TCX file'};
    let raw;try{raw=typeof DOMParser==='function'?dom(text):scan(text);}catch(e){return {ok:false,reason:'the file is cut off or garbled'};}
    if(raw.reason)return {ok:false,reason:raw.reason};
    if(!raw.points.length)return {ok:false,reason:'no trackpoints'};
    const pts=[];
    for(const p of raw.points){
      const time=p.time==null?'':String(p.time).trim(),ms=ISO.test(time)?Date.parse(time):NaN;
      if(!fin(ms))return {ok:false,reason:'unreadable time'};
      const hr=num(p.hr),d=num(p.d),alt=num(p.alt),watts=num(p.watts);pts.push({ms,d:d!=null&&d>=0&&d<1e6?d:null,hr:hr!=null&&hr>=25&&hr<=250?hr:null,alt:alt!=null&&Math.abs(alt)<1e4?alt:null,watts:watts!=null&&watts>=0&&watts<5000?watts:null});   // review F11: out-of-range values are not readings
    }
    pts.sort((a,b)=>a.ms-b.ms);
    const t0=pts[0].ms,last=pts[pts.length-1].ms;for(const p of pts)p.t=(p.ms-t0)/1000;
    const dists=pts.filter(p=>p.d!=null),alts=pts.filter(p=>p.alt!=null),withHR=pts.filter(p=>p.hr!=null);
    let elevGainM=0;for(let i=1;i<alts.length;i++)if(alts[i].alt>alts[i-1].alt)elevGainM+=alts[i].alt-alts[i-1].alt;
    const durationSec=(last-t0)/1000,windows=[];if(!(durationSec>=60))return {ok:false,reason:'too short to be a session'};   // review F1: a single point or a zero span is refused at review
    for(let w=0;w*WIN<=durationSec;w++){
      const lo=w*WIN,hi=lo+WIN,inW=pts.filter(p=>p.t>=lo&&p.t<hi);if(!inW.length)continue;
      // Each window runs from the last point before it, so consecutive windows share an edge and no second is lost.
      const edge=ok=>{let a=null;for(const p of pts){if(p.t>=lo)break;if(ok(p))a=p;}const own=inW.filter(ok);return {a:a||own[0]||null,b:own.length?own[own.length-1]:null};};
      const dd=edge(p=>p.d!=null),sec=dd.a&&dd.b?dd.b.t-dd.a.t:inW[inW.length-1].t-inW[0].t;
      const speed=dd.a&&dd.b&&sec>0?(dd.b.d-dd.a.d)/(sec/60):null;
      const da=edge(p=>p.d!=null&&p.alt!=null),run=da.a&&da.b?da.b.d-da.a.d:0;
      const grade=da.a&&da.b&&run>0?(da.b.alt-da.a.alt)/run:null;
      const hrs=inW.filter(p=>p.hr!=null).map(p=>p.hr),ws=inW.filter(p=>p.watts!=null).map(p=>p.watts);
      windows.push({t0:lo,sec,speed,grade,hr:mean(hrs),hrCoverage:hrs.length/inW.length,watts:mean(ws)});
    }
    const laps=raw.laps.map(l=>({totalTimeSec:num(l.totalTimeSec),distanceM:num(l.distanceM),calories:num(l.calories),avgWatts:num(l.avgWatts)}));
    const session={fileName,start:new Date(t0).toISOString(),end:new Date(last).toISOString(),durationSec,distanceM:dists.length?dists[dists.length-1].d:null,
      hasHR:withHR.length>0,hrCoverage:withHR.length/pts.length,hasAltitude:alts.length>0,elevGainM:alts.length?elevGainM:null,laps,windows};
    session.digest=digest(text);session.id=sessionId(session,text);
    return {ok:true,session};
  }

  // FNV-1a twice (forward, then backward from another basis): synchronous, so V8 and JavaScriptCore give the same id without crypto.subtle.
  function digest(text){
    const s=String(text);let a=0x811c9dc5,b=0x9e3779b9^s.length;
    for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),0x01000193);b=Math.imul(b^s.charCodeAt(s.length-1-i),0x01000193);}
    return ((a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0')).slice(0,12);
  }
  const sessionId=(session,text)=>'ifit:'+Math.floor(Date.parse(session.start)/1000)+':'+digest(text);

  // ACSM walking below 100 m/min, running from 134, a straight blend between (A33).
  function oxygenCost(S,G){
    if(!fin(S)||!fin(G))return null;const g=Math.min(.15,Math.max(0,G));
    const walk=.1*S+1.8*S*g+3.5,run=.2*S+.9*S*g+3.5;
    return S<=100?walk:S>=134?run:walk+(run-walk)*(S-100)/34;
  }
  // A34: a typed maximum wins; else the larger of the observed peak and Tanaka 208 − 0.7 × age.
  function hrMaxFor(o){
    o=o||{};if(fin(o.typed)&&o.typed>0)return {value:o.typed,source:'typed'};
    const obs=fin(o.observedMax)&&o.observedMax>0?o.observedMax:null,age=fin(o.age)&&o.age>0?208-.7*o.age:null;
    if(obs==null&&age==null)return null;
    return obs!=null&&(age==null||obs>=age)?{value:obs,source:'observed'}:{value:age,source:'age'};
  }
  // O4: the reserve method per window; windows shorter than half a window (a file's tail) are too noisy to count.
  function sessionEstimate(session,o){
    const rest=o&&o.rest,max=o&&o.max;
    if(!session||!session.hasHR||!session.hasAltitude||!fin(rest)||!fin(max)||max<=rest)return null;
    const est=[];
    for(const w of session.windows||[]){
      if(!(w.hrCoverage>=.8)||!(w.speed>=55)||w.grade==null||!fin(w.hr)||!(w.sec>=WIN/2))continue;
      const hrr=(w.hr-rest)/(max-rest);if(!(hrr>=.4))continue;
      est.push((oxygenCost(w.speed,w.grade)-3.5)/hrr+3.5);
    }
    return est.length?{value:median(est),windows:est.length}:null;
  }
  // The displayed value: the median of the newest 5 eligible sessions.
  function displayEstimate(sessions,o){
    const restFor=o&&o.restFor,max=o&&o.max,vals=[];
    const list=(sessions||[]).filter(s=>s&&s.start).slice().sort((a,b)=>Date.parse(b.start)-Date.parse(a.start));
    for(const s of list){if(vals.length>=5)break;const rest=typeof restFor==='function'?restFor(s.start):null,e=sessionEstimate(s,{rest,max});if(e)vals.push(e.value);}
    return vals.length?{value:median(vals),sessions:vals.length}:null;
  }

  // O10, research §5.3: live rows with a gap of 7 days or more; open at 0.85 (0.80 when several variants are scored) with
  // |bias| ≤ 1.0 over the last 12 (at least 8); closed above 1.0 over the last 8; between, the state holds.
  function vo2Gate(ledger,opts){
    opts=opts||{};const variant=opts.variant||'ifit',cut=opts.several?.8:.85,was=!!opts.wasOpen;
    const rows=(ledger||[]).filter(r=>r&&r.source==='live'&&r.gapDays>=7&&fin(r.reading)&&r.variants&&fin(r.variants[variant])&&fin(r.variants.cf))
      .slice().sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const last=rows.slice(-12),n=last.length;
    if(n<8)return {open:false,variant,ratio:null,n,bias:null,reason:'needs 8 live readings 7 or more days apart; has '+n};
    const ratioOf=rs=>{const v=mean(rs.map(r=>Math.abs(r.variants[variant]-r.reading))),c=mean(rs.map(r=>Math.abs(r.variants.cf-r.reading)));return c>0?v/c:v>0?Infinity:1;};
    const ratio=ratioOf(last),ratio8=ratioOf(rows.slice(-8)),bias=mean(last.map(r=>r.variants[variant]-r.reading)),r2=x=>Math.round(x*100)/100;
    if(ratio8>1)return {open:false,variant,ratio,n,bias,reason:'closed: error ratio '+r2(ratio8)+' over the last 8 is above 1.0'};
    if(ratio<=cut&&Math.abs(bias)<=1)return {open:true,variant,ratio,n,bias,reason:'open: error ratio '+r2(ratio)+' at or below '+cut+' over '+n+', bias '+r2(bias)};
    return {open:was,variant,ratio,n,bias,reason:(was?'still open':'still closed')+': error ratio '+r2(ratio)+(Math.abs(bias)>1?', bias '+r2(bias)+' beyond 1.0':'')+' (between thresholds)'};
  }
  // O6 / research §5.1: one frozen row; the errors are kept so a later model change cannot rewrite what was claimed.
  function ledgerRow(o){
    o=o||{};const day=s=>s?Date.parse(String(s).slice(0,10)+'T00:00:00Z'):NaN,a=day(o.anchorDate),b=day(o.date);
    const variants={},err={};
    for(const k of Object.keys(o.variants||{})){const v=o.variants[k];variants[k]=fin(v)?v:null;
      err[k]=fin(v)&&fin(o.reading)?Object.freeze({signed:v-o.reading,abs:Math.abs(v-o.reading)}):null;}
    return Object.freeze({id:o.id==null?null:o.id,date:o.date||null,reading:fin(o.reading)?o.reading:null,anchorDate:o.anchorDate||null,anchor:fin(o.anchor)?o.anchor:null,
      gapDays:fin(a)&&fin(b)?Math.round((b-a)/86400000):null,variants:Object.freeze(variants),err:Object.freeze(err),modelVersion:o.modelVersion||null,source:o.source==='backfill'?'backfill':'live'});
  }

  /* O6 variants (research §3.2, §4, A37): dates are 'YYYY-MM-DD'; series are [{day, v}] oldest first. Pure and never stored by
     itself: the ledger freezes what these returned the day before a reading arrived. */
  const dnum=d=>Date.parse(d+'T12:00:00Z')/86400000,between=(s,a,b)=>s.filter(x=>x.day>=a&&x.day<=b).map(x=>x.v);
  const back=(d,n)=>new Date((dnum(d)-n)*86400000).toISOString().slice(0,10);
  // Carried forward: the median of the Apple readings in the 14 days ending at the latest reading before the day
  function carriedForward(readings,day){const before=(readings||[]).filter(x=>x.day<day&&fin(x.v));if(!before.length)return null;const last=before[before.length-1];return {value:median(between(before,back(last.day,13),last.day)),anchorDate:last.day};}
  // Drift: anchor x (W_A / W_now) x (RHR_A / RHR_now)^beta, clamped to 0.88 to 1.12 of the anchor and to Apple's 14 to 65;
  // W a 7-day median weight, RHR a 14-day median; none in the first 7 days after the anchor or without 7 days of each.
  function driftEstimate(o){
    const cf=carriedForward(o.readings,o.day);if(!cf||!fin(cf.value))return null;const beta=fin(o.beta)?o.beta:0.5,A=cf.value,ad=cf.anchorDate;
    if(dnum(o.day)-dnum(ad)<7)return null;
    const w=(s,end,n)=>{const v=between(s||[],back(end,n-1),end);return v.length>=Math.min(7,n)?median(v):null;},WA=w(o.weights,ad,7),WN=w(o.weights,back(o.day,1),7),RA=w(o.rhr,back(ad,1),14),RN=w(o.rhr,back(o.day,1),14);
    if(!fin(WA)||!fin(WN)||!fin(RA)||!fin(RN)||WN<=0||RN<=0)return null;
    let v=A*(WA/WN)*Math.pow(RA/RN,beta);v=Math.max(0.88*A,Math.min(1.12*A,v));v=Math.max(14,Math.min(65,v));
    return {value:v,anchor:A,anchorDate:ad,weightTerm:WA/WN,rhrTerm:Math.pow(RA/RN,beta),beta};
  }

  return {parse,digest,sessionId,oxygenCost,hrMaxFor,sessionEstimate,displayEstimate,vo2Gate,ledgerRow,median,carriedForward,driftEstimate};
});
