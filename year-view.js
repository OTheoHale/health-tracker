/* Glow AU (FIX_LIST AU, items 36 to 45): the Year tab inside Progress. His whole record of daily Apple Health values, month by
   month (AU2) and as the year views AU1 to AU9. Reads daily values only: the history file's day summaries, the daily rollups and
   the projection's daily view, through the same Scores index the Vitals read; never minute detail beyond what that index already
   holds. Nothing runs until the Year tab is open, and the derived table (about 22 months) is kept per score index and day, so the
   page's normal draw never pays for it (AU speed rule). health-tracker.html only calls YearView.hook(api) from renderProgress;
   api hands over the page's own readers: S, scoreIndex, sleepNights, stepsGoal, scorePerson, gradeTone, render, on. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.YearView=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const G=globalThis,KEY='health-tracker.progress.tab';
  let tab=(()=>{try{return localStorage.getItem(KEY)==='year'?'year':'overview';}catch(_){return 'overview';}})(),month=null,api=null,wired=false;
  const kept=new WeakMap();   // score index -> {k, t}: a new index means new rows (sealed rows are shared, any change hands over a new array)
  const pad=n=>String(n).padStart(2,'0'),dn=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10))/864e5;
  const dOf=n=>{const t=new Date(n*864e5);return t.getUTCFullYear()+'-'+pad(t.getUTCMonth()+1)+'-'+pad(t.getUTCDate());},add=(d,k)=>dOf(dn(d)+k);
  const num=Number.isFinite,mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null,sum=a=>a.reduce((s,v)=>s+v,0);
  const quant=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);if(!s.length)return null;const i=(s.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return s[lo]+(s[hi]-s[lo])*(i-lo);};
  const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monLabel=m=>MON[+m.slice(5,7)-1]+' '+m.slice(0,4),dayLabel=d=>MON[+d.slice(5,7)-1]+' '+(+d.slice(8,10))+', '+d.slice(0,4);
  const fmt=(v,dp)=>v===null||v===undefined||!num(v)?'—':dp?v.toFixed(dp):Math.round(v).toLocaleString('en-US');
  const paceTxt=p=>num(p)&&p>0?Math.floor(p)+':'+pad(Math.round((p-Math.floor(p))*60)%60)+' /mi':'—';
  const lastDay=m=>dOf(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)/864e5);
  const TOT=['step_count','active_energy','basal_energy_burned','apple_exercise_time'];

  /* ---------- the derived table: one row a closed day, one row a month ---------- */
  function table(){
    const st=api.S(),x=api.on&&api.scoreIndex?api.scoreIndex(st):null;if(!x||typeof G.Scores==='undefined')return null;
    const today=G.todayYmd(),obs=Object.keys(st.observations||{}).length+'|'+(st.waistManual||[]).length+'|'+JSON.stringify((st.prefs&&st.prefs.goalsV2)||{})+'|'+api.stepsGoal(st);
    const held=kept.get(x),k=today+'|'+obs;if(held&&held.k===k)return held.t;
    const t0=(G.performance||Date).now(),t=compute(st,x,today);t.ms=Math.round((G.performance||Date).now()-t0);kept.set(x,{k,t});return t;
  }
  function compute(st,x,today){
    const S=G.Scores,H=G.HealthAutoExport,to=add(today,-1),per=api.scorePerson(st)||{},goal=api.stepsGoal(st),g=G.goalsV2(st);
    // Totals: the projection's daily view (what Today shows), else the Scores index's day total, else the history file's day
    const proj=new Map();
    try{const v=G.sourceProjection(st);for(const r of (v&&v.records)||[]){const m=r.unmapped&&r.unmapped.healthAutoExport;if(!m||m.representation!=='derived daily view'||!TOT.includes(m.metric)||!num(r.value)||(r.clashes||[]).length)continue;
      let mm=proj.get(m.metric);if(!mm)proj.set(m.metric,mm=new Map());const d=m.day||G.sourceLocalDay(r.start);if(!mm.has(d)||r.value>mm.get(d))mm.set(d,r.value);}}catch(_){}
    const exHist=new Map();
    for(const r of G.haeRowsFor(st,['apple_exercise_time'])){const m=r.unmapped.healthAutoExport;if(m.representation!=='history day summary'||!num(r.value)||(r.clashes||[]).length)continue;const f=(H.metric('apple_exercise_time').units||{})[r.unit]||1,v=r.value*f;if(!exHist.has(m.day)||v>exHist.get(m.day))exHist.set(m.day,v);}
    const rolled=new Set();   // metric|day pairs read from a stored daily rollup rather than the live projection (checked for weekly totals below)
    const total=(metric,d)=>{const p=proj.get(metric);if(p&&p.has(d))return p.get(d);if(metric==='apple_exercise_time'){if(exHist.has(d))return exHist.get(d);return null;}
      const l=(x.live.get(metric)||new Map()).get(d);if(l&&num(l.v)){if(l.rolled)rolled.add(metric+'|'+d);return l.v;}const h=(x.totals.get(metric)||new Map()).get(d);return h&&h.length?Math.max(...h):null;};
    // A reading: the day's own sample (overnight median for HRV, else the latest), else the history file's day average
    const reading=(metric,d,kind)=>{const own=kind==='overnight'?S.overnight(x,metric,d):kind==='mean'?mean(((x.samples.get(metric)||new Map()).get(d)||[]).map(o=>o.v)):(l=>l&&l.length?l.reduce((a,b)=>b.t>=a.t?b:a).v:null)((x.samples.get(metric)||new Map()).get(d));
      if(num(own))return own;const a=(x.approx.get(metric)||new Map()).get(d);return a&&a.length?mean(a):null;};
    // Weight, body fat and lean mass as the trend cards read them (latest reading of the day, display units)
    const latestPerDay=(names,conv)=>{const best=new Map();for(const r of G.haeRowsFor(st,names)){if(!num(r.value)||(r.clashes||[]).length)continue;const def=H.metric(r.unmapped.healthAutoExport.metric),f=def&&def.units?def.units[r.unit]:1;if(!num(f))continue;
      const d=G.sourceLocalDay(r.start),b=best.get(d);if(!b||r.start>b.s)best.set(d,{s:r.start,v:conv(r.value*f)});}return new Map([...best].map(([d,b])=>[d,b.v]));};
    const weight=new Map();for(const w of G.weightRowsLb(st))weight.set(w.date,w.lb);
    const fat=latestPerDay(['body_fat_percentage'],v=>v),lean=latestPerDay(['lean_body_mass'],kg=>kg/.45359237),wdef=H.metric('waist_circumference'),waist=latestPerDay(['waist_circumference'],v=>wdef&&wdef.unit==='cm'?v/2.54:v);
    for(const w of st.waistManual||[])if(w&&w.date&&num(w.inches)&&!waist.has(w.date))waist.set(w.date,w.inches);
    // Sessions (merged as Fitness merges them); nights: the page's nights first (the Fitness Grade's), else the index's (history nights)
    const types=S.TABLE.strength.types.map(t=>t.toLowerCase()),isStrength=t=>{t=String(t||'').toLowerCase();return types.some(k=>t.includes(k.replace(' training','')))||types.includes(t);};
    const byDay=new Map();for(const s of S.sessions(x)){if(!s||!s.day)continue;if(!byDay.has(s.day))byDay.set(s.day,[]);byDay.get(s.day).push(s);}
    const miles=s=>{const m=num(s.distance)?s.distance:Array.isArray(s.distanceM)?sum(s.distanceM.filter(num)):null;return m?m/1609.344:null;};
    const nights=api.sleepNights(st);
    // The first day with a daily value
    let first=to;for(const m of [x.totals.get('step_count'),x.live.get('step_count'),x.approx.get('resting_heart_rate'),x.nights])for(const d of (m?m.keys():[]))if(d<first&&d>='2015-01-01')first=d;
    const days=new Map(),order=[];
    for(let d=first;d<=to;d=add(d,1)){
      const ss=byDay.get(d)||[],n=nights.get(d),xn=x.nights.get(d),sleepH=n&&num(n.minutes)?n.minutes/60:xn&&num(xn.tst)?xn.tst:null,steps=total('step_count',d);
      const o={d,steps,active:total('active_energy',d),resting:total('basal_energy_burned',d),exercise:total('apple_exercise_time',d),rhr:reading('resting_heart_rate',d),hrv:reading('heart_rate_variability',d,'overnight'),sleepH,
        weight:weight.has(d)?weight.get(d):null,fat:fat.has(d)?fat.get(d):null,lean:lean.has(d)?lean.get(d):null,vo2:reading('vo2_max',d),walk6:(v=>num(v)?v/1609.344:null)(reading('six_minute_walking_test_distance',d)),rec:reading('cardio_recovery',d),
        speed:reading('walking_speed',d,'mean'),stepLen:reading('walking_step_length',d,'mean'),dbl:reading('walking_double_support_percentage',d,'mean'),asym:reading('walking_asymmetry_percentage',d,'mean'),
        runs:ss.filter(s=>/run/i.test(s.type)).map(s=>({d,mi:miles(s),min:num(s.movingSec)?s.movingSec/60:s.minutes,type:s.type}))};
      o.gi={date:d,steps,worn:steps!==null||sleepH!==null,workoutData:steps!==null||sleepH!==null||ss.length>0,workoutMinutes:sum(ss.map(s=>s.minutes||0)),strength:sum(ss.filter(s=>isStrength(s.type)).map(s=>s.minutes||0)),sleepH,proteinG:null,proteinTargetG:null,net:null};
      days.set(d,o);order.push(o);
    }
    /* Stored daily rollups from before the live feed come in a weekly series (dated Wednesdays through 2025 on his Oct 8 copy) and each
       holds that week's total, not the day's (resting energy about 7 times a day, steps and active energy up to 23 times). A pre-feed
       rollup with another one 7 or 14 days before or after is such a week: it is left out and counted, never shown as a day (the day is then
       missing, never zero). History-file days, a lone rollup and the live projection's days are kept. */
    const af=(st.autoFeed&&st.autoFeed.contract&&st.autoFeed.contract.activeFrom)||to,dropped={};
    for(const [k,metric] of [['steps','step_count'],['active','active_energy'],['resting','basal_energy_burned']]){
      const pre=new Set([...rolled].filter(p=>p.startsWith(metric+'|')).map(p=>p.slice(metric.length+1)).filter(d=>d<af));
      dropped[k]=[...pre].filter(d=>[-14,-7,7,14].some(n=>pre.has(add(d,n)))).sort();
      for(const d of dropped[k]){const o=days.get(d);if(!o)continue;o[k]=null;if(k==='steps'){o.gi.steps=null;o.gi.worn=o.sleepH!==null;o.gi.workoutData=o.gi.worn||o.gi.workoutMinutes>0;}}
    }
    // The Fitness Grade on these days: VO2 max from the last 60 days, the latest weigh-in, waist from the last 90 days
    const carry=(key,maxAge)=>{let last=null;const out=new Map();for(const o of order){if(num(o[key]))last=o;out.set(o.d,last&&(maxAge===null||dn(o.d)-dn(last.d)<=maxAge)?last[key]:null);}return out;};
    const vo2At=carry('vo2',60),wAt=carry('weight',null);let lw=null;const waistAt=new Map();for(const o of order){if(waist.has(o.d))lw=o.d;waistAt.set(o.d,lw&&dn(o.d)-dn(lw)<=90?waist.get(lw):null);}
    const heightIn=num(+g.heightIn)&&+g.heightIn>0?+g.heightIn:null,tbl=G.Norms&&G.Norms.metrics&&G.Norms.metrics.vo2_max;
    const gradeAt=(list,end,w)=>{const age=S.ageOn(end,per.birthYear||null,per.birthMonth||null),dec=num(age)?(age<30?'20-29':age<40?'30-39':age<50?'40-49':age<60?'50-59':age<70?'60-69':'70-79'):null,pts=tbl&&dec?((tbl[per.sex]||tbl.male)[dec]||{}).p:null,v=vo2At.get(end);
      return G.FitnessGrade.grade({days:list,window:w,age:age||0,vo2:num(v)&&pts?{value:v,points:pts}:null,body:{waistIn:waistAt.get(end),heightIn,weightLb:wAt.get(end)}});};
    for(let i=6;i<order.length;i++){const r=gradeAt(order.slice(i-6,i+1).map(o=>o.gi),order[i].d,'day');order[i].grade={letter:r.letter,shown:r.shown};}
    // Months
    const months=[],byMonth=new Map();for(const o of order){const m=o.d.slice(0,7);if(!byMonth.has(m))byMonth.set(m,[]);byMonth.get(m).push(o);}
    let prevW=null,prevF=null;
    for(const [m,list] of byMonth){
      const v=k=>list.map(o=>o[k]).filter(num),last=k=>{for(let i=list.length-1;i>=0;i--)if(num(list[i][k]))return list[i][k];return null;},firstOf=k=>{for(const o of list)if(num(o[k]))return o[k];return null;};
      const runs=list.flatMap(o=>o.runs),paced=runs.filter(r=>num(r.mi)&&r.mi>=.5&&num(r.min)),gr=gradeAt(list.map(o=>o.gi),list[list.length-1].d,'all'),steps=v('steps');
      const wEnd=last('weight'),fEnd=last('fat'),wBase=prevW!==null?prevW:firstOf('weight'),fBase=prevF!==null?prevF:firstOf('fat');
      months.push({m,from:list[0].d,to:list[list.length-1].d,days:list.length,partial:list[list.length-1].d<lastDay(m),steps:mean(steps),stepDays:steps.length,goalDays:steps.filter(s=>s>=goal).length,
        active:mean(v('active')),resting:mean(v('resting')),exercise:mean(v('exercise')),exDays:v('exercise').length,runs:runs.length,miles:sum(runs.map(r=>r.mi||0)),pace:paced.length?sum(paced.map(r=>r.min))/sum(paced.map(r=>r.mi)):null,
        rhr:mean(v('rhr')),rhrN:v('rhr').length,hrv:mean(v('hrv')),hrvN:v('hrv').length,sleep:mean(v('sleepH')),nights:v('sleepH').length,weight:wEnd,wChange:wEnd!==null&&wBase!==null?wEnd-wBase:null,fat:fEnd,fChange:fEnd!==null&&fBase!==null?fEnd-fBase:null,
        vo2:last('vo2'),walk6:last('walk6'),speed:mean(v('speed')),grade:gr});
      if(wEnd!==null)prevW=wEnd;if(fEnd!==null)prevF=fEnd;
    }
    return {first,to,today,goal,days,order,months,dropped,heightIn,goalLb:num(g.weightLb&&g.weightLb.jan7)&&g.weightLb.jan7>0?g.weightLb.jan7:null};
  }

  /* ---------- drawing ---------- */
  const tone=p=>num(p)?api.gradeTone(Math.max(0,Math.min(100,p))):'var(--faint)';
  const card=(id,emoji,title,body,sub)=>'<section class="k-card yv-card" data-yv-card="'+id+'" data-feedback-id="year-'+id+'" data-feedback-label="Year: '+esc(title)+'"><div class="k-head"><span aria-hidden="true">'+emoji+'</span><span class="k-title">'+esc(title)+'</span></div>'+(sub?'<p class="hint keep yv-sub">'+sub+'</p>':'')+body+'</section>';
  const stat=(label,value,title)=>'<span class="yv-stat"'+(title?' title="'+esc(title)+'"':'')+'><small>'+esc(label)+'</small><b>'+value+'</b></span>';
  const inRange=(t,R)=>t.order.filter(o=>o.d>=R.from&&o.d<=R.to);
  const ptsOf=(t,R,k)=>inRange(t,R).filter(o=>num(o[k])).map(o=>[o.d,o[k]]);
  /* One line chart: daily dots, a 7-day average line (broken over gaps of more than 10 days), an optional shaded band and a goal line. */
  function chart(o){
    const W=320,H=o.h||120,L=34,R=8,T=8,B=16,x0=dn(o.from),x1=Math.max(dn(o.to),x0+1);
    const all=o.series.flatMap(s=>s.pts.map(p=>p[1])).concat(o.band||[]).concat(o.hline?[o.hline.v]:[]).filter(num);
    if(!o.series.some(s=>s.pts.length))return '<p class="hint keep yv-none">No readings in this range</p>';
    let lo=Math.min(...all),hi=Math.max(...all);if(hi-lo<1e-9){lo-=1;hi+=1;}const sp=(hi-lo)*.08;lo-=sp;hi+=sp;
    const X=d=>L+(dn(d)-x0)/(x1-x0)*(W-L-R),Y=v=>T+(1-(v-lo)/(hi-lo))*(H-T-B),f=v=>v.toFixed(1),dp=o.dp||0;
    let g='';
    if(o.band&&o.band.every(num))g+='<rect x="'+L+'" y="'+f(Y(o.band[1]))+'" width="'+(W-L-R)+'" height="'+f(Math.max(1,Y(o.band[0])-Y(o.band[1])))+'" fill="'+o.series[0].colour+'" opacity=".13"/>';
    g+='<text x="'+(L-4)+'" y="'+f(Y(hi-sp)+4)+'" class="yv-ax" text-anchor="end">'+fmt(hi-sp,dp)+'</text><text x="'+(L-4)+'" y="'+f(Y(lo+sp)+3)+'" class="yv-ax" text-anchor="end">'+fmt(lo+sp,dp)+'</text>';
    // month ticks, at most about seven labels
    const ms=[];for(let d=o.from.slice(0,8)+'01';d<=o.to;d=add(lastDay(d.slice(0,7)),1))if(d>=o.from)ms.push(d);
    const every=Math.max(1,Math.ceil(ms.length/7));ms.forEach((d,i)=>{const xx=f(X(d));g+='<line x1="'+xx+'" x2="'+xx+'" y1="'+T+'" y2="'+(H-B)+'" class="yv-grid"/>'+(i%every?'':'<text x="'+xx+'" y="'+(H-4)+'" class="yv-ax" text-anchor="middle">'+MON[+d.slice(5,7)-1]+(d.slice(5,7)==='01'||i===0?" '"+d.slice(2,4):'')+'</text>');});
    if(ms.length<2){const days=dn(o.to)-dn(o.from);for(let k=0;k<=days;k+=7){const d=add(o.from,k);g+='<text x="'+f(X(d))+'" y="'+(H-4)+'" class="yv-ax" text-anchor="middle">'+(+d.slice(8,10))+'</text>';}}
    if(o.hline&&num(o.hline.v))g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+f(Y(o.hline.v))+'" y2="'+f(Y(o.hline.v))+'" class="yv-goal"/><text x="'+(W-R)+'" y="'+f(Y(o.hline.v)-3)+'" class="yv-ax" text-anchor="end">'+esc(o.hline.label)+'</text>';
    for(const s of o.series){
      const few=s.pts.length<60,r=few?2.4:1.5;
      if(s.dots!==false)for(const [d,v] of s.pts)g+='<circle cx="'+f(X(d))+'" cy="'+f(Y(v))+'" r="'+r+'" fill="'+s.colour+'" opacity="'+(s.smooth?.4:.9)+'"><title>'+esc(dayLabel(d)+': '+fmt(v,dp)+(o.unit?' '+o.unit:''))+'</title></circle>';
      if(s.smooth||s.line){const segs=[];let cur=[];s.pts.forEach(([d,v],i)=>{if(i&&dn(d)-dn(s.pts[i-1][0])>10){segs.push(cur);cur=[];}const w=s.smooth?s.pts.filter(p=>dn(p[0])<=dn(d)&&dn(p[0])>dn(d)-7).map(p=>p[1]):[v];cur.push([d,mean(w)]);});segs.push(cur);
        for(const seg of segs)if(seg.length>1)g+='<polyline fill="none" stroke="'+s.colour+'" stroke-width="'+(s.smooth?2:1.6)+'" stroke-linejoin="round" points="'+seg.map(([d,v])=>f(X(d))+','+f(Y(v))).join(' ')+'"/>';}
    }
    return '<svg class="yv-svg" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(o.label||'')+'">'+g+'</svg>';
  }
  // Month bars (a tap opens that month)
  const bars=(items,unit,dp)=>{const max=Math.max(...items.map(i=>num(i.v)?i.v:0),1e-9),every=Math.max(1,Math.ceil(items.length/12));
    return '<div class="yv-bars">'+items.map((i,k)=>'<button type="button" class="yv-bar'+(month===i.m?' on':'')+'" data-yv="month" data-m="'+i.m+'" title="'+esc(monLabel(i.m)+': '+fmt(i.v,dp)+' '+unit+(i.note?' · '+i.note:''))+'"><i style="height:'+Math.round(100*(num(i.v)?i.v:0)/max)+'%;background:'+(i.colour||'var(--c-green)')+'"></i><small>'+(k%every?'':MON[+i.m.slice(5,7)-1].slice(0,1)+(i.m.slice(5,7)==='01'?"'"+i.m.slice(2,4):''))+'</small></button>').join('')+'</div>';};

  /* AU2: the month-by-month table */
  function monthTable(t){
    const goalK=Math.round(t.goal/1000)+'k',head=['Month','Grade','Steps',goalK+' days','Active','Resting','Exercise','Runs','Miles','Pace','Resting HR','HRV','Sleep','Weight','Body fat','VO₂ max','6-min walk','Walk speed'];
    const ch=(v,dp,sign)=>num(v)?(sign&&v>0?'+':'')+(dp?v.toFixed(dp):Math.round(v).toLocaleString('en-US')):'';
    const row=s=>{const gr=s.grade,parts=gr.components.filter(c=>c.score!==null).map(c=>c.name+' '+c.score).join(' · ')||'no parts yet',few=s.stepDays<20||s.partial;
      const gcell=gr.letter?'<b style="color:'+tone(gr.shown)+'">'+gr.letter+'</b> <small>'+gr.shown+'%</small>':gr.shown!==null&&gr.shown!==undefined?'<small title="Needs 5 parts for a letter">('+gr.shown+'%)</small>':'<small>—</small>';
      const td=(v,colour,title)=>'<td'+(colour?' style="color:'+colour+'"':'')+(title?' title="'+esc(title)+'"':'')+'>'+v+'</td>';
      return '<tr class="'+(month===s.m?'on':'')+'" data-yv="month" data-m="'+s.m+'" tabindex="0" role="button" aria-label="'+esc('Open '+monLabel(s.m))+'"><th scope="row">'+monLabel(s.m)+(few?'<small> '+(s.partial?'so far, ':'')+s.stepDays+' d</small>':'')+'</th>'+
        td(gcell,null,gr.blocks?'Fitness Grade, '+gr.days+' days in '+gr.blocks+' weeks: '+parts:(gr.note||'Building'))+td(fmt(s.steps),tone(100*s.steps/t.goal),s.stepDays+' days with steps')+td(s.stepDays?s.goalDays+'<small>/'+s.stepDays+'</small>':'—',s.stepDays?tone(100*s.goalDays/s.stepDays):null)+
        td(fmt(s.active))+td(fmt(s.resting))+td(s.exDays?fmt(s.exercise)+'<small> min</small>':'—',tone(100*s.exercise/30),'Average a day, '+s.exDays+' days')+td(s.runs||'—')+td(s.runs?fmt(s.miles,1):'—')+td(paceTxt(s.pace))+
        td(s.rhrN?fmt(s.rhr):'—',null,s.rhrN+' readings')+td(s.hrvN?fmt(s.hrv):'—',null,s.hrvN+' readings')+td(s.nights?fmt(s.sleep,1)+'<small> h · '+s.nights+'</small>':'—',s.nights?tone(100*s.sleep/7):null,s.nights+' nights')+
        td(s.weight!==null?fmt(s.weight,1)+(s.wChange!==null?' <small>'+ch(s.wChange,1,true)+'</small>':''):'—',null,'Last weigh-in of the month and the change in it')+td(s.fat!==null?fmt(s.fat,1)+'%'+(s.fChange!==null?' <small>'+ch(s.fChange,1,true)+'</small>':''):'—')+
        td(fmt(s.vo2,1))+td(s.walk6!==null?fmt(s.walk6,2)+'<small> mi</small>':'—')+td(s.speed!==null?fmt(s.speed,2)+'<small> mph</small>':'—')+'</tr>';};
    return card('months','🗓️','Month by month','<div class="yv-scroll"><table class="yv-table"><thead><tr>'+head.map((h,i)=>'<th scope="col"'+(i?'':' class="yv-c0"')+'>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+t.months.map(row).join('')+'</tbody></table></div>',
      'Averages a day unless named; weight and body fat at the month’s end with the change in it. Tap a month to see it below.');
  }
  // The honest limits, said once on the tab (AU2)
  const limits=t=>{const n=Object.values(t.dropped).reduce((a,v)=>a+v.length,0);
    return '<p class="hint keep yv-limits" data-yv-limits>'+fmt(t.order.length)+' days since '+esc(dayLabel(t.first))+'. Before the program only the Fitness Grade can be worked out: Faith, Temple, Family, Growth and Home need check-offs (from Sep 21, 2026). The Year grade leaves out Protein and Net Fuel (food logs: about 23 days in 2025), so a month can read differently from the Fitness page. Readings before the live feed are Apple Health’s day averages.'+(n?' Wednesdays in 2025 are missing for steps and energy: the stored rows for them hold a week’s total, not a day’s, so they are left out.':'')+'</p>';};
  // "This month against the last 3 months" for a reading
  function vsThree(t,R,k,lower,unit,dp){
    const m=(R.month||t.to.slice(0,7)),vals=(a,b)=>t.order.filter(o=>o.d>=a&&o.d<=b&&num(o[k])).map(o=>o[k]);
    const cur=vals(m+'-01',lastDay(m)),startPrev=dOf(Date.UTC(+m.slice(0,4),+m.slice(5,7)-4,1)/864e5),prev=vals(startPrev,add(m+'-01',-1));
    if(cur.length<3||prev.length<7)return '<small class="yv-cmp">'+esc(monLabel(m))+': needs more readings</small>';
    const a=mean(cur),b=mean(prev),dlt=a-b,steady=Math.abs(dlt)<(k==='hrv'?2:1),good=lower?dlt<0:dlt>0;
    return '<small class="yv-cmp">'+esc(monLabel(m))+' <b>'+fmt(a,dp)+'</b> '+unit+' · last 3 months '+fmt(b,dp)+' · <b style="color:'+(steady?'var(--muted)':good?'var(--c-green)':'var(--c-orange)')+'">'+(steady?'→ steady':(dlt>0?'↑ ':'↓ ')+fmt(Math.abs(dlt),dp)+(good?' better':' worse'))+'</b></small>';
  }
  /* AU1 1: resting heart rate and HRV, his own normal band */
  function heartCard(t,R){
    const one=(k,name,unit,colour,lower)=>{const p=ptsOf(t,R,k),v=p.map(x=>x[1]),band=v.length>=7?[quant(v,.25),quant(v,.75)]:null;
      return '<div class="yv-metric"><div class="yv-mhead"><b>'+name+'</b>'+vsThree(t,R,k,lower,unit,0)+'</div>'+chart({from:R.from,to:R.to,series:[{pts:p,colour,smooth:true}],band,unit,label:name+' by day with a 7-day average'})+(band?'<small class="yv-band">Your normal: '+fmt(band[0])+' to '+fmt(band[1])+' '+unit+' (the middle half of '+v.length+' readings)</small>':'')+'</div>';};
    return card('heart','❤️','Resting heart rate and HRV',one('rhr','Resting heart rate','bpm','var(--c-red)',true)+one('hrv','Heart rate variability','ms','var(--c-green)',false),'Dots are days, the line a 7-day average, the shaded band your own normal.');
  }
  /* AU1 2: weight and body composition */
  function weightCard(t,R){
    const p=ptsOf(t,R,'weight');if(!p.length)return card('weight','⚖️','Weight journey','<p class="hint keep yv-none">No weigh-ins in this range</p>');
    const hi=p.reduce((a,b)=>b[1]>a[1]?b:a),lo=p.reduce((a,b)=>b[1]<a[1]?b:a),end=p[p.length-1];
    const recent=p.filter(x=>dn(x[0])>dn(end[0])-28),use=recent.length>=3?recent:p,xs=use.map(x=>dn(x[0])),ys=use.map(x=>x[1]),mx=mean(xs),my=mean(ys),sxx=sum(xs.map(v=>(v-mx)*(v-mx))),slope=sxx>0?sum(xs.map((v,i)=>(v-mx)*(ys[i]-my)))/sxx*7:null;
    const ago=t.order.filter(o=>num(o.weight)&&Math.abs(dn(o.d)-(dn(end[0])-365))<=21).sort((a,b)=>Math.abs(dn(a.d)-(dn(end[0])-365))-Math.abs(dn(b.d)-(dn(end[0])-365)))[0];
    const stats='<div class="yv-stats">'+stat('Highest',fmt(hi[1],1)+' lb',dayLabel(hi[0]))+stat('Lowest',fmt(lo[1],1)+' lb',dayLabel(lo[0]))+stat('Per week',slope===null?'—':(slope>0?'+':'')+fmt(slope,1)+' lb',recent.length>=3?'the last 28 days of weigh-ins':'every weigh-in shown')+
      stat('A year ago',ago?fmt(ago.weight,1)+' lb <small>'+(end[1]-ago.weight>0?'+':'')+fmt(end[1]-ago.weight,1)+'</small>':'—',ago?dayLabel(ago.d):'no weigh-in near that day')+'</div>';
    const mini=(k,name,unit,colour)=>'<div class="yv-mini"><small>'+name+'</small>'+chart({from:R.from,to:R.to,series:[{pts:ptsOf(t,R,k),colour,line:true}],unit,dp:1,h:70,label:name})+'</div>';
    return card('weight','⚖️','Weight journey',stats+chart({from:R.from,to:R.to,series:[{pts:p,colour:'var(--brass)',line:true}],hline:t.goalLb?{v:t.goalLb,label:'goal '+fmt(t.goalLb)}:null,unit:'lb',dp:0,h:130,label:'Weight'})+'<div class="pg-two yv-two">'+mini('fat','Body fat','%','var(--c-orange)')+mini('lean','Lean mass','lb','var(--c-green)')+'</div>',p.length+' weigh-ins');
  }
  /* AU1 3: running over time */
  function runCard(t,R){
    const runs=inRange(t,R).flatMap(o=>o.runs),paced=runs.filter(r=>num(r.mi)&&r.mi>=.5&&num(r.min)),ms=t.months.filter(s=>s.to>=R.from&&s.from<=R.to);
    if(!runs.length)return card('runs','🏃','Running','<p class="hint keep yv-none">No runs in this range</p>');
    const mi=sum(runs.map(r=>r.mi||0)),longest=runs.filter(r=>num(r.mi)).sort((a,b)=>b.mi-a.mi)[0],fast=paced.filter(r=>r.mi>=1).sort((a,b)=>a.min/a.mi-b.min/b.mi)[0],weeks=Math.max(1,(dn(R.to)-dn(R.from)+1)/7);
    const best=ms.filter(s=>s.runs).sort((a,b)=>b.miles-a.miles)[0];
    const stats='<div class="yv-stats">'+stat('Runs',fmt(runs.length))+stat('Miles',fmt(mi,1))+stat('Pace',paceTxt(paced.length?sum(paced.map(r=>r.min))/sum(paced.map(r=>r.mi)):null),'all runs of half a mile or more')+stat('Per week',fmt(runs.length/weeks,1))+
      stat('Longest',longest?fmt(longest.mi,2)+' mi':'—',longest?dayLabel(longest.d):'')+stat('Fastest',fast?paceTxt(fast.min/fast.mi):'—',fast?dayLabel(fast.d)+', '+fmt(fast.mi,2)+' mi':'runs of a mile or more')+(R.month?'':stat('Best month',best?fmt(best.miles,1)+' mi':'—',best?monLabel(best.m):''))+'</div>';
    const body=R.month?'<ul class="yv-list">'+runs.map(r=>'<li><span>'+esc(dayLabel(r.d))+'</span><b>'+(num(r.mi)?fmt(r.mi,2)+' mi':'—')+'</b><small>'+(num(r.mi)&&r.mi>=.5?paceTxt(r.min/r.mi):fmt(r.min)+' min')+'</small></li>').join('')+'</ul>'
      :'<small class="yv-cap">Miles a month</small>'+bars(ms.map(s=>({m:s.m,v:s.miles,note:s.runs+' runs, '+paceTxt(s.pace)})),'mi',1)+'<small class="yv-cap">Average pace a month (lower is faster)</small>'+chart({from:R.from,to:R.to,series:[{pts:ms.filter(s=>num(s.pace)).map(s=>[s.from,s.pace]),colour:'var(--c-blue,#7fb2ff)',line:true}],unit:'min/mi',dp:1,h:80,label:'Average pace by month'});
    return card('runs','🏃','Running',stats+body);
  }
  /* AU1 4: the activity calendar, days coloured by steps against his goal */
  function calendarCard(t,R){
    const goal=t.goal,col=s=>!num(s)?'var(--sunk-2,rgba(255,255,255,.08))':s>=goal?'var(--c-green)':s>=.75*goal?'var(--c-yellow)':s>=.5*goal?'var(--c-orange)':'var(--c-red)';
    const years=[];for(let y=+R.from.slice(0,4);y<=+R.to.slice(0,4);y++)years.push(y);
    const grid=y=>{const a=R.month?R.from:(y+'-01-01'<R.from?R.from:y+'-01-01'),b=R.month?R.to:(y+'-12-31'>R.to?R.to:y+'-12-31'),start=add(a,-new Date(dn(a)*864e5).getUTCDay()),cols=Math.ceil((dn(b)-dn(start)+1)/7),c=R.month?16:9,gap=2;
      let g='';for(let d=start;d<=b;d=add(d,1)){if(d<a)continue;const i=dn(d)-dn(start),o=t.days.get(d);g+='<rect x="'+(Math.floor(i/7)*(c+gap))+'" y="'+((i%7)*(c+gap))+'" width="'+c+'" height="'+c+'" rx="2" fill="'+col(o&&o.steps)+'"'+(o&&num(o.steps)?'':' opacity=".5"')+'><title>'+esc(dayLabel(d)+': '+(o&&num(o.steps)?fmt(o.steps)+' steps':'no steps'))+'</title></rect>';}
      return '<div class="yv-cal">'+(R.month?'':'<small>'+y+'</small>')+'<svg viewBox="0 0 '+(cols*(c+gap))+' '+(7*(c+gap))+'" style="max-width:'+(cols*(c+gap))+'px" role="img" aria-label="'+esc((R.month?monLabel(R.month):y)+' steps by day')+'">'+g+'</svg></div>';};
    const days=inRange(t,R).filter(o=>num(o.steps));let run=0,best=0,bestEnd=null;for(const o of inRange(t,R)){if(num(o.steps)&&o.steps>=goal){run++;if(run>best){best=run;bestEnd=o.d;}}else run=0;}
    let cur=0;for(let i=t.order.length-1;i>=0&&num(t.order[i].steps)&&t.order[i].steps>=goal;i--)cur++;
    const ms=t.months.filter(s=>s.to>=R.from&&s.from<=R.to&&s.stepDays>=10).sort((a,b)=>b.steps-a.steps);
    const stats='<div class="yv-stats">'+stat(Math.round(goal/1000)+'k days',fmt(days.filter(o=>o.steps>=goal).length)+'<small>/'+days.length+'</small>')+stat('Longest streak',best+' d',bestEnd?dayLabel(add(bestEnd,-(best-1)))+' to '+dayLabel(bestEnd):'')+(R.month?'':stat('Streak now',cur+' d')+stat('Best month',ms[0]?fmt(ms[0].steps):'—',ms[0]?monLabel(ms[0].m):'')+stat('Lightest month',ms.length>1?fmt(ms[ms.length-1].steps):'—',ms.length>1?monLabel(ms[ms.length-1].m):''))+'</div>';
    const key='<div class="yv-key">'+[['var(--c-green)','goal'],['var(--c-yellow)','75%'],['var(--c-orange)','50%'],['var(--c-red)','under half']].map(([c,l])=>'<span><i style="background:'+c+'"></i>'+l+'</span>').join('')+'</div>';
    return card('calendar','👣','Activity calendar',stats+(R.month?grid(+R.from.slice(0,4)):years.map(grid).join(''))+key,'Each square a day, by steps against your '+fmt(goal)+'.');
  }
  // A tapped month: its grade, its parts and its best and worst days; the cards below zoom to it
  function monthDetail(t,R){
    const s=t.months.find(x=>x.m===R.month);if(!s)return '';
    const list=inRange(t,R),pick=(k,hi)=>{const v=list.filter(o=>num(o[k]));if(!v.length)return null;return v.reduce((a,b)=>(hi?b[k]>a[k]:b[k]<a[k])?b:a);};
    const dd=(label,o,k,dp,unit)=>stat(label,o?fmt(o[k],dp)+(unit?' '+unit:''):'—',o?dayLabel(o.d):'');
    const gr=s.grade,parts=gr.components.map(c=>'<span class="yv-part"><small>'+esc(c.name)+'</small><b style="color:'+tone(c.score)+'">'+(c.score===null?'—':c.score)+'</b></span>').join('');
    return card('month','📅',monLabel(s.m)+(s.partial?' so far':''),'<div class="yv-mtop"><b class="yv-letter" style="color:'+tone(gr.shown)+'">'+(gr.letter||'–')+'</b><span>'+(gr.shown===null||gr.shown===undefined?'No Fitness Grade: '+esc(gr.note||'needs 5 parts'):gr.shown+'% Fitness Grade, '+gr.blocks+' weeks')+'</span><button type="button" class="k-chip" data-yv="back">Back to the year</button></div><div class="yv-parts">'+parts+'</div>'+
      '<div class="yv-stats">'+dd('Most steps',pick('steps',true),'steps',0)+dd('Fewest steps',pick('steps',false),'steps',0)+dd('Longest sleep',pick('sleepH',true),'sleepH',1,'h')+dd('Shortest sleep',pick('sleepH',false),'sleepH',1,'h')+dd('Most active energy',pick('active',true),'active',0,'kcal')+dd('Least active energy',pick('active',false),'active',0,'kcal')+'</div>');
  }
  /* ---------- the tab, its clicks and its styles ---------- */
  const STYLE='.yv-tabs{display:flex;gap:6px;margin:0 0 6px}.yv-tab[aria-selected="true"]{background:var(--brass-soft,rgba(207,174,99,.2));color:var(--brass-ink,var(--brass))}'+
    '.yv-limits{margin:2px 0 10px;font-size:12px;line-height:1.45}.yv-sub{margin:0 0 6px}.yv-scroll{overflow-x:auto;margin:0 -4px}.yv-table{border-collapse:collapse;font-size:12.5px;white-space:nowrap;width:max-content;min-width:100%}'+
    '.yv-table th,.yv-table td{padding:5px 8px;text-align:right;border-bottom:1px solid var(--line)}.yv-table thead th{font-weight:600;color:var(--muted);font-size:11.5px;position:sticky;top:0}.yv-table th[scope=row],.yv-table .yv-c0{text-align:left;position:sticky;left:0;background:var(--card,var(--bg));z-index:1}'+
    '.yv-table tbody tr{cursor:pointer}.yv-table tbody tr:hover td,.yv-table tbody tr.on td,.yv-table tbody tr.on th{background:var(--sunk)}.yv-table small{color:var(--muted);font-weight:400}'+
    '.yv-svg{display:block;width:100%;height:auto;margin:4px 0}.yv-ax{font-size:9px;fill:var(--muted)}.yv-grid{stroke:var(--line);stroke-width:.6}.yv-goal{stroke:var(--brass);stroke-dasharray:4 3;stroke-width:1.2}'+
    '.yv-metric+.yv-metric{margin-top:10px}.yv-mhead{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}.yv-cmp,.yv-band,.yv-cap{color:var(--muted);font-size:12px}.yv-cap{display:block;margin-top:8px}'+
    '.yv-stats{display:flex;flex-wrap:wrap;gap:6px 16px;margin:4px 0 6px}.yv-stat{display:flex;flex-direction:column}.yv-stat small{color:var(--muted);font-size:11.5px}.yv-stat b{font-size:15px}.yv-stat b small{font-size:11.5px;color:var(--muted);font-weight:500}'+
    '.yv-two{gap:8px;margin-top:4px}.yv-mini small{color:var(--muted);font-size:11.5px}.yv-bars{display:flex;align-items:flex-end;gap:2px;height:84px;margin:4px 0 0}.yv-bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;padding:0;border:0;background:none;cursor:pointer;min-width:0}'+
    '.yv-bar i{display:block;width:100%;border-radius:3px 3px 0 0;min-height:1px}.yv-bar small{font-size:9px;color:var(--muted);height:12px}.yv-bar.on i{outline:2px solid var(--ink)}'+
    '.yv-cal{margin:6px 0}.yv-cal small{color:var(--muted);font-size:11.5px}.yv-cal svg{display:block;width:100%;height:auto}.yv-key{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--muted)}.yv-key i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}'+
    '.yv-list{list-style:none;margin:6px 0 0;padding:0}.yv-list li{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid var(--line);font-size:13px}.yv-list li span{flex:1}.yv-list small{color:var(--muted)}'+
    '.yv-mtop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.yv-mtop .k-chip{margin-left:auto}.yv-letter{font-size:28px}.yv-parts{display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0}.yv-part{display:flex;flex-direction:column}.yv-part small{color:var(--muted);font-size:11.5px}.yv-none{margin:8px 0}';
  function wire(){
    if(wired||typeof document==='undefined')return;wired=true;
    const s=document.createElement('style');s.id='yv-style';s.textContent=STYLE;document.head.appendChild(s);
    const act=el=>{const k=el.dataset.yv;
      if(k==='tab'){tab=el.dataset.v==='year'?'year':'overview';month=null;try{localStorage.setItem(KEY,tab);}catch(_){}}
      else if(k==='month')month=month===el.dataset.m?null:el.dataset.m;
      else if(k==='back')month=null;
      else return;
      if(api&&api.render)api.render();
      if(k==='month'&&month)requestAnimationFrame(()=>{const c=document.querySelector('[data-yv-card="month"]');if(c)c.scrollIntoView({behavior:'smooth',block:'start'});});};
    document.addEventListener('click',e=>{const el=e.target.closest&&e.target.closest('[data-yv]');if(el&&el.closest('#main')){e.preventDefault();act(el);}});
    document.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const el=e.target.closest&&e.target.closest('tr[data-yv]');if(el){e.preventDefault();act(el);}});
  }
  const tabs=()=>'<div class="yv-tabs" role="tablist" aria-label="Progress views" data-yv-tabs>'+[['overview','Overview'],['year','Year']].map(([v,l])=>'<button type="button" role="tab" class="k-chip yv-tab" aria-selected="'+(tab===v)+'" data-yv="tab" data-v="'+v+'">'+l+'</button>').join('')+'</div>';
  function page(){
    let t=null;try{t=table();}catch(e){console.error('year view',e);return '<section class="k-card"><p class="hint keep">The Year could not be worked out: '+esc(e&&e.message||e)+'</p></section>';}
    if(!t||!t.order.length)return '<section class="k-card"><p class="hint keep">The Year needs Apple Health days from Health Auto Export.</p></section>';
    if(month&&!t.months.some(s=>s.m===month))month=null;
    const R=month?{from:month+'-01',to:lastDay(month)<t.to?lastDay(month):t.to,month}:{from:t.first,to:t.to};
    return limits(t)+monthTable(t)+(month?monthDetail(t,R):'')+'<div class="pg-two">'+heartCard(t,R)+weightCard(t,R)+'</div><div class="pg-two">'+runCard(t,R)+calendarCard(t,R)+'</div>';
  }
  /* The page's one call: the tab strip for the Progress head, and the whole Year page when that tab is open. */
  function hook(a){
    api=a;wire();
    if(tab!=='year')return {tabs:tabs(),html:''};
    return {tabs:tabs(),html:'<div class="progress yv" data-yv-page data-period="year"><div class="pg-head">'+tabs()+'</div>'+page()+'</div>'};
  }
  return {hook,table:()=>api?table():null,state:()=>({tab,month})};
});
