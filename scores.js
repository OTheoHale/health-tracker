/* Glow scores (V3.1). Pure: no DOM, no storage, no clock; rows and numbers in, results out. The formulas,
   constants and worked cases are docs/research/SCORES_SPEC_2026-09-26.md (section letters in comments);
   test-scores.js asserts every worked case. Scores measure the body; points reward doing; they never feed
   each other. Scores are derived and never stored, so Rebuild from export recomputes them.
   Constants marked ASSUMED in the spec are starting values (approved Sept 26) and live in TABLE so they
   can be tuned in one place. Every result is {value,label,colour,confidence,inputs,missing} plus its own
   detail; value null means "—", never zero. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./norms.js'),require('./workout-sessions.js'));
  else root.Scores=factory(root.Norms,root.WorkoutSessions);
})(typeof globalThis!=='undefined'?globalThis:this,function(NORMS,WORKOUTS){
  'use strict';
  const TABLE=Object.freeze({
    zone:'America/Los_Angeles',
    baselineDays:60,
    readiness:{weights:{hrv:50,rhr:25,sleep:15,load:10},z7:0.6,z1:0.4,centre:75,perZ:25,lnSdFloor:0.05,rhrSdFloor:1.5,cap:69,minBaseline:7,lowBaseline:14,fullBaseline:30,rolling:7,rollingMin:4},
    sleep:{needH:8,floorH:4,duration:50,consistency:30,interruptions:20,window:14,minNights:5,sdFull:20,sdZero:90,perWake:2,perWakeMin:0.25,freeWakeMin:10,wakeSegmentMin:2,bankNights:7,bankCapH:2,nightFrom:3,nightTo:13,bedtimeOwedH:1,bedtimeLeadMin:15,wakeNights:14,wakeMin:3},
    load:{zones:[[90,5],[80,4],[70,3],[60,2],[50,1]],effortWeights:[[9,4],[6,3],[3,2],[0,1]],defaultWeight:2,everyday:[[6,2],[3,1]],missingShare:0.2,chronic:28,acute:7,chronicMin:14,
      bands:{Recover:[0,0.8],Pace:[0.5,1.0],Ready:[0.8,1.3],Go:[1.0,1.5]},trend:[[0.6,'Well Below'],[0.8,'Below'],[1.3,'Steady'],[1.5,'Above']],redAfter:3},
    fuel:{mlPerOz:29.5735,proteinPerKg:1.6,kcalFree:150,kcalSlope:500,waterWeight:0.5,proteinShare:0.5,burnDays:7,burnMin:3},
    healthAge:{perSd:10,clampSd:2,vo2Clamp:20,weights:{vo2:0.40,rhr:0.15,hrv:0.10,bodyFat:0.10,sleep:0.10,steps:0.10,walk:0.05},rhrMedian:65,rhrSd:11.1,hrvMedian:42,hrvLnSd:0.3986,bodyFatMean:26.1,bodyFatSd:6.82,sleepIn:[7,9],steps:7500,stepsSd:2500,walk:1.43,walkSd:0.15,window:30,minDays:10,minWeighIns:3,changeDays:91},
    vo2:{freshDays:60,staleDays:180},
    recovery:{hardShare:0.80,fallbackShare:0.65,halfLifeDays:10,windowDays:30,minSessions:3,endWithinSec:10,around60:[50,70],coolDownDrop:15},
    warning:{window:30,minNights:14,rhr:5,rr:3,spo2:3,temp:0.5,sds:2},
    momentum:{short:7,shortMin:5,long:28,longMin:20,pct:5},
    merge:{gapMin:10},
    hrMax:{minSessions:10,days:365},
    mobility:{speed:[0.8,1.43],asymmetry:[15,12],doubleSupport:[40,12],walkSpan:153,mphToMs:0.44704},
    strength:{targetDays:8,window:28,types:['Traditional Strength Training','Functional Strength Training','Core Training']},
    run:{minMin:20,minM:3000,easy:[0.60,0.80],skip:5,window:28,minRuns:3,trendPct:2},
    durability:{minMin:50,skip:10,maxGapMin:2,steadyCv:0.08,window:60,minRuns:2,bands:[5,8,12]},
    // D5 Fast Resilience (V3.3 Phase 2, 7.1): a 180-day window (the spec's 90 is the alternative), the 8-and-8 floor, and
    // SD floors so one quiet baseline cannot blow a small difference up.
    fastResilience:{window:180,minDays:8,perD:25,lnSdFloor:0.05,rhrSdFloor:1.5,sleepSdFloor:4,minSamples:3,bands:{steady:90,slight:75,noticeable:50}}
  });

  /* ---- small maths ---- */
  const num=v=>typeof v==='number'&&Number.isFinite(v);
  const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
  const sum=a=>a.reduce((s,v)=>s+v,0);
  const mean=a=>a.length?sum(a)/a.length:null;
  const median=a=>{if(!a.length)return null;const s=a.slice().sort((x,y)=>x-y),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
  const sd=a=>{if(!a.length)return null;const m=mean(a);return Math.sqrt(sum(a.map(v=>(v-m)*(v-m)))/a.length);};       // population (C4)
  const robustSd=a=>{if(!a.length)return null;const m=median(a);return 1.4826*median(a.map(v=>Math.abs(v-m)));};       // C4
  const present=a=>a.filter(num);
  const STEPS=['Low','Medium','High'];
  const stepDown=(confidence,steps)=>{if(!confidence)return confidence;return STEPS[Math.max(0,STEPS.indexOf(confidence)-(steps||1))];};
  /* Calendar days as 'YYYY-MM-DD', moved with UTC arithmetic so no clock or zone is read. */
  const dayMs=day=>Date.UTC(+day.slice(0,4),+day.slice(5,7)-1,+day.slice(8,10));
  const addDays=(day,n)=>new Date(dayMs(day)+n*86400000).toISOString().slice(0,10);
  const daysBetween=(from,to)=>Math.round((dayMs(to)-dayMs(from))/86400000);
  const weekday=day=>new Date(dayMs(day)).getUTCDay();                                                                    // 0 = Sunday
  const mondayOf=day=>addDays(day,-((weekday(day)+6)%7));

  /* ---- colour scales (spec §0): names, so the page maps them to its own tokens and key ---- */
  function goalColour(pct,closed){return pct>=100?'green':pct>=75?'yellow':pct>=40?'orange':closed?'red':'orange';}
  function qualityColour(score,closed){return score>=90?'violet':score>=75?'green':score>=50?'yellow':score>=25?'orange':closed?'red':'orange';}
  function readinessColour(v){return v>=90?'violet':v>=70?'green':v>=40?'yellow':v>=20?'orange':'red';}
  function ageColour(delta){return delta<=-10?'violet':delta<=0?'green':delta<5?'yellow':'orange';}

  /* ---- C5 age ---- */
  function ageOn(date,birthYear,birthMonth){
    if(!Number.isInteger(birthYear)||birthYear<1900)return null;
    const month=Number.isInteger(birthMonth)&&birthMonth>=1&&birthMonth<=12?birthMonth:7,y=+date.slice(0,4),m=+date.slice(5,7);   // July 1 when the month is unknown
    const age=y-birthYear-(m<month?1:0);return age>=0&&age<130?age:null;
  }
  /* The band a table offers for this age: the one that holds it, else the nearest. 'all' fits everyone. */
  function bandFor(bands,age){
    const keys=Object.keys(bands||{});if(!keys.length)return null;if(keys.includes('all'))return 'all';
    const span=k=>k.split('-').map(Number);
    if(!num(age))return keys.includes('30-39')?'30-39':keys.includes('20-39')?'20-39':keys.includes('25-49')?'25-49':keys[0];
    const inside=keys.find(k=>{const [a,b]=span(k);return age>=a&&age<=b;});if(inside)return inside;
    return keys.slice().sort((x,y)=>Math.min(...span(x).map(v=>Math.abs(v-age)))-Math.min(...span(y).map(v=>Math.abs(v-age))))[0];
  }

  /* ---- A1 Readiness ---- */
  function readinessLabel(v){return v>=85?'Go':v>=70?'Ready':v>=40?'Pace':'Recover';}
  /* z of tonight and of the 7-day mean against the 60-day baseline. values are ln(SDNN) for HRV, bpm for
     resting heart rate (better = lower, so its sign is flipped). */
  function zScores(today,recent,baseline,floor,lowerIsBetter){
    const base=present(baseline||[]),out={z1:null,z7:null,mu:null,sigma:null,n:base.length};
    if(base.length<2)return out;
    out.mu=mean(base);out.sigma=Math.max(sd(base),floor);
    const z=v=>(lowerIsBetter?out.mu-v:v-out.mu)/out.sigma;
    if(num(today))out.z1=z(today);
    const r=present(recent||[]);if(r.length>=TABLE.readiness.rollingMin)out.z7=z(mean(r));
    return out;
  }
  function readiness(input){
    const T=TABLE.readiness,i=input||{},w=T.weights,days=i.baselineDays||{},subs={},missing=[];
    const usable=(z,n)=>z!==null&&(n===undefined||n>=T.minBaseline);
    const zH=num(i.z7)&&num(i.z1)?T.z7*i.z7+T.z1*i.z1:num(i.z7)?i.z7:num(i.z1)?i.z1:null;
    if(usable(zH,days.hrv))subs.hrv=clamp(T.centre+T.perZ*zH,0,100);else missing.push('HRV');
    if(usable(num(i.zR)?i.zR:null,days.rhr))subs.rhr=clamp(T.centre+T.perZ*i.zR,0,100);else missing.push('Resting heart rate');
    if(num(i.sleep))subs.sleep=i.sleep;else missing.push('Sleep');
    const load=i.load;
    if(load&&num(load.L)&&num(load.hi))subs.load=clamp(100-100*Math.max(0,load.L-load.hi)/Math.max(load.hi,1),0,100);else missing.push('Yesterday’s load');
    const capReasons=(i.capReasons||[]).filter(Boolean),result={value:null,label:null,colour:null,confidence:null,inputs:{zH,zR:num(i.zR)?i.zR:null,subs},missing,raw:null,capped:false,capReasons};
    if(subs.hrv===undefined&&subs.rhr===undefined){
      // Fewer than 7 baseline days for both, or no reading of either today: "—" with the baseline count.
      const n=Math.max(days.hrv||0,days.rhr||0);
      result.building=n<T.minBaseline?{n,N:T.minBaseline}:null;
      return result;
    }
    const names=Object.keys(subs),total=sum(names.map(k=>w[k]));
    result.raw=sum(names.map(k=>w[k]*subs[k]))/total;
    const shown=capReasons.length?Math.min(result.raw,T.cap):result.raw;
    result.capped=capReasons.length>0&&result.raw>T.cap;
    result.value=Math.round(shown);result.label=readinessLabel(result.value);result.colour=readinessColour(result.value);
    const both=subs.hrv!==undefined&&subs.rhr!==undefined,least=Math.min(subs.hrv!==undefined?(days.hrv===undefined?Infinity:days.hrv):Infinity,subs.rhr!==undefined?(days.rhr===undefined?Infinity:days.rhr):Infinity);
    let confidence=!both||least<T.lowBaseline?'Low':subs.sleep===undefined||subs.load===undefined||least<T.fullBaseline?'Medium':'High';
    // Day averages from a catch-up export fill the baseline only, and cost one step until 30 sample-based
    // days exist (E3); so does standing in yesterday's resting heart rate (C7).
    if(i.approxBaseline)confidence=stepDown(confidence,1);
    if(i.rhrYesterday)confidence=stepDown(confidence,1);
    result.confidence=confidence;
    return result;
  }

  /* ---- A2 Sleep and Sleep Bank ---- */
  function sleepBand(v){return v>=96?'Very High':v>=81?'High':v>=61?'OK':v>=41?'Low':'Very Low';}
  function sleepScore(input){
    const T=TABLE.sleep,i=input||{},need=num(i.need)&&i.need>T.floorH?i.need:T.needH;
    if(!num(i.tst))return {value:null,label:null,colour:'blue',confidence:null,inputs:{},missing:['No sleep recorded']};
    const DUR=T.duration*clamp((i.tst-T.floorH)/(need-T.floorH),0,1);
    // Bedtime consistency: tonight plus the previous 13 nights, as minutes after noon.
    let spread=num(i.sd)?i.sd:null,nights=num(i.nights)?i.nights:null;
    if(Array.isArray(i.starts)){const s=present(i.starts);nights=s.length;spread=s.length?sd(s):null;}
    const hasConsistency=spread!==null&&(nights===null||nights>=T.minNights);
    const CON=hasConsistency?T.consistency*clamp((T.sdZero-spread)/(T.sdZero-T.sdFull),0,1):null;
    const segments=num(i.wakes),wakes=segments?i.wakes:1,wakeMin=num(i.wakeMin)?i.wakeMin:0;
    const INT=clamp(T.interruptions-T.perWake*Math.max(0,wakes-1)-T.perWakeMin*Math.max(0,wakeMin-T.freeWakeMin),0,T.interruptions);
    const raw=hasConsistency?DUR+CON+INT:(DUR+INT)/(T.duration+T.interruptions)*100,value=Math.round(raw);
    return {value,label:sleepBand(value),colour:'blue',confidence:hasConsistency&&segments?'High':'Medium',raw,
      inputs:{tst:i.tst,need,duration:DUR,consistency:CON,interruptions:INT,spread,nights,wakes,wakeMin},missing:[...(hasConsistency?[]:['Bedtime consistency (needs 5 nights)']),...(segments?[]:['Wake-up count'])]};
  }
  /* nights: hours asleep, newest first (index 0 = last night); a missing night is null and is skipped. */
  function sleepBank(nights,need){
    const T=TABLE.sleep,n=num(need)?need:T.needH,list=(nights||[]).slice(0,T.bankNights);
    if(!list.some(num))return {hours:null,text:null,nights:0};
    let bank=0,count=0;list.forEach((tst,i)=>{if(num(tst)){bank+=(T.bankNights-i)/T.bankNights*(tst-n);count++;}});
    bank=Math.min(bank,T.bankCapH);
    return {hours:bank,text:clock(bank,true),nights:count};
  }
  /* ±h:mm, rounded to the minute, with a true minus sign. */
  function clock(hours,signed){
    const minutes=Math.round(Math.abs(hours)*60),text=Math.floor(minutes/60)+':'+String(minutes%60).padStart(2,'0');
    return (hours<0&&minutes?'−':signed&&minutes?'+':'')+text;
  }

  /* Tonight's bedtime for the plan line (ASSUMED): his usual wake time, less the sleep he needs, less up to
     an hour of what the Sleep Bank owes, less a quarter hour to fall asleep; to the nearest five minutes.
     Times are minutes after noon, so an evening and the morning after stay in order. */
  function timeOfDay(afterNoonMinutes){
    const m=((Math.round(afterNoonMinutes)+720)%1440+1440)%1440,h=Math.floor(m/60),h12=h%12||12;
    return h12+':'+String(m%60).padStart(2,'0')+(h<12?' am':' pm');
  }
  function bedtime(input){
    const T=TABLE.sleep,i=input||{};if(!num(i.wake))return null;
    const need=num(i.need)&&i.need>T.floorH?i.need:T.needH,owed=num(i.bank)&&i.bank<0?Math.min(T.bedtimeOwedH,-i.bank):0,at=Math.round((i.wake-(need+owed)*60-T.bedtimeLeadMin)/5)*5;
    return {afterNoon:at,text:timeOfDay(at),owed,clears:owed>0};
  }

  /* ---- A3 Load ---- */
  function zoneWeight(hr,hrMax){
    if(!num(hr)||!num(hrMax)||hrMax<=0)return 0;
    const p=hr*100/hrMax;for(const [edge,weight] of TABLE.load.zones)if(p>=edge)return weight;return 0;
  }
  const effortWeight=effort=>{if(!num(effort))return TABLE.load.defaultWeight;for(const [edge,weight] of TABLE.load.effortWeights)if(effort>=edge)return weight;return 1;};
  /* One session's load. curve = per-minute average heart rate (null where there was no sample). */
  function sessionLoad(session,hrMax){
    const s=session||{},curve=Array.isArray(s.hr)?s.hr:null,known=curve?curve.filter(num).length:0;
    if(known&&num(hrMax)){
      const load=sum(curve.map(v=>zoneWeight(v,hrMax))),missingShare=1-known/curve.length;
      return {load,source:'curve',minutes:curve.length,missingShare,weak:missingShare>TABLE.load.missingShare};
    }
    const minutes=num(s.minutes)?Math.max(0,Math.round(s.minutes)):0;
    return {load:minutes*effortWeight(s.effort),source:num(s.effort)?'effort':'default',minutes,missingShare:1,weak:true};
  }
  function everydayLoad(values){let points=0;for(const v of values||[])if(num(v))for(const [edge,p] of TABLE.load.everyday)if(v>=edge){points+=p;break;}return points;}
  /* The same from a rolled-up day: minutes per band (key × step = the band's lower edge). */
  function everydayLoadFromBands(bands,step){
    let points=0;const s=num(step)?step:0.5;
    for(const [key,minutes] of Object.entries(bands||{})){const edge=+key*s;if(!num(edge)||!num(minutes))continue;for(const [from,p] of TABLE.load.everyday)if(edge>=from){points+=p*minutes;break;}}
    return points;
  }
  function loadTrend(a7,c28){
    if(!num(a7)||!num(c28)||c28<=0)return null;
    const r=a7/c28;if(r<0.6)return 'Well Below';if(r<0.8)return 'Below';if(r<=1.3)return 'Steady';if(r<=1.5)return 'Above';return 'Well Above';
  }
  function loadBand(c28,label){
    if(!num(c28))return null;const [lo,hi]=TABLE.load.bands[label]||TABLE.load.bands.Ready;
    return {lo:c28*lo,hi:c28*hi,from:TABLE.load.bands[label]?label:'Ready'};
  }
  /* input: L today; history = L of D−28…D−1, oldest first, null for a day without a Watch;
     readinessLabel; closed (the day is over); wellAboveDays (consecutive days the trend read Well Above). */
  function load(input){
    const T=TABLE.load,i=input||{},history=(i.history||[]).slice(-T.chronic),known=present(history),recent=present(history.slice(-T.acute));
    const C28=known.length>=T.chronicMin?mean(known):null,A7=recent.length?mean(recent):null;
    const band=C28===null?null:loadBand(C28,i.readinessLabel),trend=loadTrend(A7,C28);
    if(!num(i.L))return {value:null,label:null,colour:null,confidence:null,inputs:{C28,A7},missing:['No heart-rate data for the day'],band,trend};
    const value=Math.round(i.L);
    let colour='brass',label='so far';
    if(band){
      if(i.L>band.hi){colour='orange';label='above';}
      else if(i.L>=band.lo){colour='green';label='in band';}
      else if(i.closed){colour='yellow';label='below';}
    }else label=null;
    if((i.wellAboveDays||0)>=T.redAfter&&!(band&&i.L<band.lo))colour='red';
    return {value,label,colour,confidence:C28===null?'Low':i.weak?'Medium':'High',inputs:{L:i.L,C28,A7,days:known.length},missing:C28===null?['A target band (needs 14 days)']:[],band,trend};
  }

  /* ---- A4 Fuel ---- */
  /* waterMl null = no water record. A day still running reads that as none so far; a day that is over has
     no water figure, and Fuel is "—". The food half counts only when both its parts can be scored: with a
     part missing (no protein, no calories, or no target for one) nothing is averaged around the gap and the
     ring falls back to water alone, saying so. */
  function fuel(input){
    const T=TABLE.fuel,i=input||{},known=num(i.waterMl);
    if(!(num(i.waterTargetMl)&&i.waterTargetMl>0))return {value:null,label:null,colour:null,confidence:null,inputs:{},missing:['Water target']};
    if(!known&&i.closed)return {value:null,label:null,colour:null,confidence:null,inputs:{},missing:['Water']};
    const w=(known?i.waterMl:0)/i.waterTargetMl,inner=Math.min(w,1),food=i.foodLogged!==false&&(num(i.kcal)||num(i.proteinG));
    const only=missing=>{const value=Math.round(100*inner);return {value,label:'Water only',colour:goalColour(value,i.closed),confidence:'Low',inputs:{inner,outer:null,water:w},missing};};
    if(!food)return only(['Food']);
    const p=num(i.proteinG)&&num(i.proteinTargetG)&&i.proteinTargetG>0?clamp(i.proteinG/i.proteinTargetG,0,1):null;
    let c=null;if(num(i.kcal)&&num(i.kcalTarget)){const d=Math.abs(i.kcal-i.kcalTarget);c=d<=T.kcalFree?1:Math.max(0,1-(d-T.kcalFree)/T.kcalSlope);}
    const missing=[...(p!==null?[]:[num(i.proteinG)?'Protein target':'Protein']),...(c!==null?[]:[num(i.kcal)?'Calorie target':'Calories'])];
    if(missing.length)return only(missing);
    const outer=T.proteinShare*p+(1-T.proteinShare)*c,value=Math.round(100*(T.waterWeight*inner+(1-T.waterWeight)*outer));
    return {value,label:null,colour:goalColour(value,i.closed),confidence:'High',
      inputs:{inner,outer,water:w,protein:p,calories:c,innerColour:goalColour(Math.round(100*inner),i.closed),outerColour:goalColour(Math.round(100*outer),i.closed)},missing};
  }

  /* ---- A5 Faith ---- */
  /* items: the day's planned prayers, fast and church; status done | partial (with pct) | excused | anything else. */
  function faith(items){
    const planned=(items||[]).filter(x=>x&&x.status!=='excused'&&x.status!=='rest');
    if(!planned.length)return {value:null,label:null,colour:'purple',confidence:null,inputs:{done:0,planned:0},missing:['Nothing planned']};
    const credit=x=>x.status==='done'?1:x.status==='partial'?clamp((num(x.pct)?x.pct:50)/100,0,1):0,done=sum(planned.map(credit));
    return {value:Math.round(100*done/planned.length),label:null,colour:'purple',confidence:null,inputs:{done,planned:planned.length},missing:[]};
  }

  /* ---- D5 Fast Resilience: how his body carries a fast (Faith colour, never framed as a cost) ----
     input: {lnH:{fast:[],other:[]}, rhr:{fast:[],other:[]}, sleep:{fast:[],other:[]}, fastDays, otherDays, min}. Each list holds
     the outcome on the night after a kept fast day and after other days: ln(SDNN) for HRV, bpm for resting heart rate,
     the Sleep score. For each outcome d = (mean_fast − mean_other) / SD_other (SD floored), with the sign flipped for
     resting heart rate so that negative always means "carried less well". Resilience = clamp(100 + 25·mean(d), 0, 100),
     rounded; 100 means no measurable change. It needs 8 kept fast days and 8 other days (the spec's statistical floor). */
  function fastResilienceLabel(v){const b=TABLE.fastResilience.bands;return v>=b.steady?'Steady':v>=b.slight?'Slight dip':v>=b.noticeable?'Noticeable dip':'Marked dip';}
  function fastResilience(input){
    const T=TABLE.fastResilience,i=input||{},min=num(i.min)?i.min:T.minDays;
    const fastDays=num(i.fastDays)?i.fastDays:null,otherDays=num(i.otherDays)?i.otherDays:null;
    const base={value:null,label:null,colour:'violet',confidence:null,inputs:{fastDays,otherDays,window:num(i.window)?i.window:T.window,min,outcomes:{}},missing:[]};
    if(fastDays!==null&&fastDays<min)base.missing.push((min-fastDays)+' more fast day'+(min-fastDays===1?'':'s'));
    if(otherDays!==null&&otherDays<min)base.missing.push((min-otherDays)+' more other day'+(min-otherDays===1?'':'s'));
    if(base.missing.length)return base;
    const ds=[];
    for(const [key,flip,floor] of [['lnH',false,T.lnSdFloor],['rhr',true,T.rhrSdFloor],['sleep',false,T.sleepSdFloor]]){
      const g=i[key]||{},fast=present(g.fast||[]),other=present(g.other||[]);
      if(fast.length<T.minSamples||other.length<T.minSamples)continue;
      const mf=mean(fast),mo=mean(other),s=Math.max(sd(other),floor),d=(mf-mo)/s*(flip?-1:1);
      ds.push(d);base.inputs.outcomes[key]={fast:mf,other:mo,sd:s,d,n:[fast.length,other.length],plain:key==='lnH'?(Math.exp(mf-mo)-1)*100:mf-mo};
    }
    if(!ds.length){base.missing.push('A night’s HRV, resting heart rate or Sleep score after fast days and other days');return base;}
    const value=Math.round(clamp(100+T.perD*mean(ds),0,100));
    const least=Math.min(fastDays===null?Infinity:fastDays,otherDays===null?Infinity:otherDays);
    return {...base,value,label:fastResilienceLabel(value),confidence:least>=3*min?'High':least>=2*min?'Medium':'Low',inputs:{...base.inputs,meanD:mean(ds)}};
  }
  /* The rows' side: options.isFast(day) answers 'fast' (a fast day he kept), 'other' or null (left out); the outcomes are read
     on the following morning (the night that ends the next day). The window ends the day before `day`. */
  function fastResilienceFor(x,day,options){
    const o=options||{},T=TABLE.fastResilience,window=num(o.window)?o.window:T.window,isFast=typeof o.isFast==='function'?o.isFast:()=>null;
    const g={lnH:{fast:[],other:[]},rhr:{fast:[],other:[]},sleep:{fast:[],other:[]}},days={fast:0,other:0};
    for(let k=window;k>=1;k--){
      const d=addDays(day,-k),kind=isFast(d);if(kind!=='fast'&&kind!=='other')continue;
      const next=addDays(d,1);if(next>day)continue;
      const h=overnight(x,'heart_rate_variability',next),r=restingHr(x,next),s=sleepFor(x,next,{need:o.need});
      const lnH=num(h)&&h>0?Math.log(h):null,rhr=r&&!r.yesterday&&num(r.value)?r.value:null,sleep=s&&num(s.value)?s.value:null;
      if(lnH===null&&rhr===null&&sleep===null)continue;
      days[kind]++;if(lnH!==null)g.lnH[kind].push(lnH);if(rhr!==null)g.rhr[kind].push(rhr);if(sleep!==null)g.sleep[kind].push(sleep);
    }
    return fastResilience({...g,fastDays:days.fast,otherDays:days.other,window,min:o.min});
  }

  /* ---- B1 Fitness age ---- */
  function fitnessAge(vo2,options){
    const F=NORMS.fitnessAge,a=F.anchors,o=options||{};
    if(!num(vo2))return {value:null,exact:null,label:null,colour:null,confidence:null,inputs:{},missing:['VO₂ max']};
    let exact;
    if(vo2>=a[0][1])exact=a[0][0]-(vo2-a[0][1])/((a[0][1]-a[1][1])/(a[1][0]-a[0][0]));
    else if(vo2<=a[a.length-1][1]){const n=a.length-1;exact=a[n][0]+(a[n][1]-vo2)/((a[n-1][1]-a[n][1])/(a[n][0]-a[n-1][0]));}
    else for(let k=1;k<a.length;k++)if(vo2>=a[k][1]){const slope=(a[k-1][1]-a[k][1])/(a[k][0]-a[k-1][0]);exact=a[k-1][0]+(a[k-1][1]-vo2)/slope;break;}
    const value=clamp(Math.round(exact),F.min,F.max),label=exact<=F.min?F.min+' or younger':exact>=F.max?F.max+'+':String(value);
    const stale=!!o.stale,delta=num(o.age)?value-o.age:null;
    return {value,exact,label,colour:delta===null?null:ageColour(delta),confidence:stale?'Low':'High',inputs:{vo2,age:num(o.age)?o.age:null,delta,stale,asOf:o.asOf||null},missing:[]};
  }

  /* ---- B2 Health Age (a heuristic, labelled as such) ---- */
  function healthAge(input){
    const H=TABLE.healthAge,i=input||{},z=v=>clamp(v,-H.clampSd,H.clampSd),factors=[];
    const add=(id,label,weight,offset,value)=>factors.push({id,label,weight,offset,value});
    if(!num(i.age))return {value:null,label:null,colour:null,confidence:null,inputs:{factors:[]},missing:['Birth year']};
    if(num(i.vo2)){const f=fitnessAge(i.vo2);add('vo2','VO₂ max',H.weights.vo2,clamp(f.exact-i.age,-H.vo2Clamp,H.vo2Clamp),i.vo2);}
    if(num(i.rhr))add('rhr','Resting heart rate',H.weights.rhr,-H.perSd*z((H.rhrMedian-i.rhr)/H.rhrSd),i.rhr);
    if(num(i.sdnn)&&i.sdnn>0)add('hrv','HRV',H.weights.hrv,-H.perSd*z((Math.log(i.sdnn)-Math.log(H.hrvMedian))/H.hrvLnSd),i.sdnn);
    if(num(i.bodyFat))add('bodyFat','Body fat',H.weights.bodyFat,-H.perSd*z((H.bodyFatMean-Math.max(i.bodyFat,8))/H.bodyFatSd),i.bodyFat);
    if(num(i.tst))add('sleep','Sleep',H.weights.sleep,i.tst<H.sleepIn[0]?H.perSd*Math.min(H.clampSd,H.sleepIn[0]-i.tst):i.tst>H.sleepIn[1]?H.perSd*Math.min(H.clampSd,i.tst-H.sleepIn[1]):0,i.tst);
    if(num(i.steps))add('steps','Steps',H.weights.steps,-H.perSd*z((i.steps-H.steps)/H.stepsSd),i.steps);
    if(num(i.walk))add('walk','Walking speed',H.weights.walk,-H.perSd*z((i.walk-H.walk)/H.walkSd),i.walk);
    const vo2=factors.some(f=>f.id==='vo2'),fresh=vo2&&!i.vo2Stale,n=factors.length;
    const confidence=fresh&&n>=6?'High':(fresh&&n>=4)||(vo2&&n>=6)?'Medium':vo2&&n>=3?'Low':null;
    const all=['vo2','rhr','hrv','bodyFat','sleep','steps','walk'],names={vo2:'VO₂ max',rhr:'Resting heart rate',hrv:'HRV',bodyFat:'Body fat',sleep:'Sleep',steps:'Steps',walk:'Walking speed'};
    const missing=all.filter(id=>!factors.some(f=>f.id===id)).map(id=>names[id]);
    if(!confidence)return {value:null,label:null,colour:null,confidence:null,inputs:{factors:[],age:i.age},missing};
    const total=sum(factors.map(f=>f.weight));
    for(const f of factors){f.share=f.weight/total;f.contribution=f.share*f.offset;}
    const exact=i.age+sum(factors.map(f=>f.contribution)),value=Math.round(exact);
    return {value,exact,label:String(value),colour:ageColour(value-i.age),confidence,inputs:{age:i.age,factors,asOf:i.asOf||null,
      pullingUp:factors.filter(f=>f.contribution>=0.05).sort((a,b)=>b.contribution-a.contribution).map(f=>f.label),
      helping:factors.filter(f=>f.contribution<=-0.05).sort((a,b)=>a.contribution-b.contribution).map(f=>f.label)},missing};
  }
  /* Health Age is fixed for the week: recomputed each Monday over the 30 days ending the Sunday before. */
  function healthAgeWindow(day){const asOf=mondayOf(day),to=addDays(asOf,-1);return {asOf,from:addDays(to,-(TABLE.healthAge.window-1)),to};}

  /* ---- C Where I Stand ---- */
  const RUNGS=NORMS.rungs,RUNG_COLOUR={poor:'red',below:'orange',avg:'yellow',good:'green',trained:'green',athlete:'violet',elite:'violet'};
  function who(options){const o=options||{};return {sex:o.sex==='female'?'female':'male',age:num(o.age)?o.age:null};}
  /* Cut-offs where a value ENTERS each rung. Missing percentiles are interpolated linearly between the
     published neighbours (§C.2); a lower-is-better metric reads its cut-offs as upper limits. */
  function cutsFor(metric,options){
    const def=NORMS.metrics[metric],w=who(options);if(!def||def.kind!=='ranked')return null;
    const bands=def[w.sex]||def.male,band=bandFor(bands,w.age),t=bands&&bands[band];if(!t)return null;
    let cuts;
    if(t.cuts)cuts={...t.cuts};
    else{
      const p=t.p,shift=def.shift||0;
      const p20=p[10]+(10/15)*(p[25]-p[10]),p40=p[25]+(15/25)*(p[50]-p[25]),p60=p[50]+(10/25)*(p[75]-p[50]),p80=p[75]+(5/15)*(p[90]-p[75]);
      cuts=def.dir==='down'?{below:p80+shift,avg:p60+shift,good:p40+shift,trained:p20+shift,athlete:(p[5]!==undefined?p[5]:p[10])+shift}
        :{below:p20,avg:p40,good:p60,trained:p80,athlete:p[95]};
      if(t.elite!==undefined)cuts.elite=t.elite;
    }
    return {metric,def,band,cuts,source:t.source,tags:t.tags||{},appleLevels:t.appleLevels||null,p:t.p||null,shift:def.shift||0};
  }
  /* Roughly where a value sits among men of the band (share he is ahead of), from the published percentiles. */
  function percentileOf(value,table){
    if(!table||!table.p||!num(value))return null;
    const v=value-(table.def.dir==='down'?table.shift:0),pts=Object.keys(table.p).map(Number).sort((a,b)=>a-b).map(k=>[k,table.p[k]]);
    let pct;
    if(v<=pts[0][1])pct=pts[0][0];else if(v>=pts[pts.length-1][1])pct=pts[pts.length-1][0];
    else for(let k=1;k<pts.length;k++)if(v<=pts[k][1]){const [a,x]=pts[k-1],[b,y]=pts[k];pct=a+(b-a)*(v-x)/(y-x);break;}
    return Math.round(table.def.dir==='down'?100-pct:pct);
  }
  function appleLevel(value,levels){if(!levels||!num(value))return null;return value<levels.low?'Low':value<levels.belowAverage?'Below Average':value<=levels.aboveAverage?'Above Average':'High';}
  const roundUp=(gap,precision)=>{const n=Math.ceil(gap/precision-1e-9)*precision,places=precision<1?String(precision).split('.')[1].length:0;return +n.toFixed(places);};
  function stand(metric,value,options){
    const table=cutsFor(metric,options);
    if(!table||!num(value))return {metric,value:null,rung:null,label:null,colour:null,missing:[NORMS.metrics[metric]?NORMS.metrics[metric].label:metric]};
    const def=table.def,down=def.dir==='down',order=RUNGS.filter(r=>r==='poor'||table.cuts[r]!==undefined);
    let rung='poor';for(const r of order.slice(1))if(down?value<=table.cuts[r]:value>=table.cuts[r])rung=r;
    const at=order.indexOf(rung),nextRung=order[at+1]||null;
    let next=null,gapText;
    if(nextRung){
      const gap=Math.abs(table.cuts[nextRung]-value),shown=roundUp(gap,def.precision);
      next={rung:nextRung,label:NORMS.labels[nextRung],gap,shown,cut:table.cuts[nextRung]};
      gapText=(down?'−':'+')+shown.toLocaleString('en-US')+' '+def.unit+' to '+NORMS.labels[nextRung];
    }else gapText=rung==='elite'?'Top rung':NORMS.labels[rung]+' is the top rung';
    const gapSD=next?(def.logScale?Math.abs(Math.log(next.cut)-Math.log(value)):next.gap)/def.sd:null;
    return {metric,value,unit:def.unit,rung,label:NORMS.labels[rung],colour:RUNG_COLOUR[rung],star:rung==='elite',next,gapText,gapSD,weight:def.weight,
      flag:def.flagAtOrBelow!==undefined&&value<=def.flagAtOrBelow,percentile:percentileOf(value,table),
      appleLevel:appleLevel(value,table.appleLevels),cuts:table.cuts,order,band:table.band,source:table.source,tags:table.tags,direction:def.dir,note:def.note||null,association:def.association||null};
  }
  /* Target-range metrics: in range, or the distance to the nearest edge (§C.7). */
  function range(metric,value,options){
    const def=NORMS.metrics[metric],w=who(options),o=options||{};
    if(!def||def.kind!=='target'||!num(value))return {metric,value:null,state:null,colour:null,missing:[def?def.label:metric]};
    // Waist (V3.4): one standard, waist-to-height. `value` is the waist in centimetres; the height comes with the person.
    // Like every other metric, the band, the high cut and the distance are in the value's unit (cm); the page converts once.
    if(def.ratio==='height'){if(!num(o.heightCm)||o.heightCm<=0)return {metric,value:null,state:null,colour:null,missing:['Height']};
      const t=def.male.all,ratio=value/o.heightCm,[lo,hi]=t.in,state=ratio<lo?'under':ratio>hi?'over':'in',edge=state==='under'?lo:state==='over'?hi:ratio,cm=Math.abs(ratio-edge)*o.heightCm,inches=cm/2.54;
      return {metric,value,ratio,unit:'cm',state,distance:cm,colour:state==='in'?'green':state==='under'?'yellow':ratio>=t.high?'orange':'yellow',text:state==='in'?'In range':(Math.round(inches*10)/10).toLocaleString('en-US')+' in'+(state==='over'?' over the range':' under'),
        in:[lo*o.heightCm,hi*o.heightCm],over:null,high:t.high*o.heightCm,athlete:null,band:'all',source:t.source,tags:t.tags||{},gapSD:Math.abs(ratio-edge)/def.sd,weight:def.weight,note:null};}
    const bands=def[w.sex]||def.male,band=bandFor(bands,w.age),t=bands[band],[lo,hi]=t.in;
    const state=value<lo?'under':value>hi?'over':'in',distance=state==='under'?lo-value:state==='over'?value-hi:0;
    let colour='green';
    if(state==='under')colour=t.lowOrange!==undefined&&value<t.lowOrange?'orange':'yellow';
    if(state==='over')colour=t.high!==undefined&&value>=t.high?'orange':'yellow';
    const amount=metric==='sleep_duration'?clock(distance):(Math.round(distance*10)/10).toLocaleString('en-US')+' '+def.unit;
    return {metric,value,unit:def.unit,state,distance,colour,text:state==='in'?'In range':amount+(state==='over'?' over the range':' under'),
      in:t.in,over:t.over||null,high:t.high===undefined?null:t.high,athlete:t.athlete||null,band,source:t.source,tags:t.tags||{},gapSD:distance/def.sd,weight:def.weight,note:def.note||null};
  }
  /* V3.4 (B11): the published tier a value sits in, for a colour bar or a tier word. Returns
     {tone, word, index, count, cuts, source, convention}; null without a value. */
  function tier(metric,value,options){
    const def=NORMS.tiers&&NORMS.tiers[metric],w=who(options);if(!def||!num(value))return null;
    const rows=def.all||(def[w.sex]||def.male)[bandFor(def[w.sex]||def.male,w.age)],i=rows.findIndex(r=>value<r[0]);
    return {tone:rows[i][1],word:rows[i][2],index:i,count:rows.length,cuts:rows.map(r=>r[0]).filter(Number.isFinite),source:def.source,convention:def.convention};
  }
  function floorCheck(metric,value,options){
    const def=NORMS.metrics[metric],o=options||{};
    if(!def||def.kind!=='floor'||!num(value))return {metric,value:null,ok:null,missing:[def?def.label:metric]};
    if(metric==='six_minute_walking_test_distance'){const lln=walkLowerLimit(o);return lln===null?{metric,value,ok:null,missing:['Height and weight']}:{metric,value,ok:value>=lln,floor:lln,unit:def.unit};}
    return {metric,value,ok:value>=def.floor?true:value<def.warn?false:null,floor:def.floor,warn:def.warn,unit:def.unit};
  }
  /* Top three places where effort moves a rung soonest. entries: results of stand() and range(), each with
     a confidence; ranked ones at their top rung and targets inside their range are left out. */
  function biggestGains(entries){
    return (entries||[]).filter(e=>e&&num(e.gapSD)&&(e.state?e.state!=='in':!!e.next)&&(e.confidence===undefined||e.confidence==='High'||e.confidence==='Medium'))
      .map(e=>({...e,priority:e.weight/(e.gapSD+0.25)})).sort((a,b)=>b.priority-a.priority).slice(0,3);
  }

  /* ---- E4 sessions: same-type workouts at most 10 minutes apart are one session (a scoring view only) ---- */
  function mergeSessions(workouts,links){
    const gap=TABLE.merge.gapMin*60000,list=(workouts||[]).filter(w=>w&&num(w.start)&&num(w.end)&&w.end>w.start).slice().sort((a,b)=>a.start-b.start||a.end-b.end),out=[];
    const place=(into,from,offset,length)=>{const a=(into||[]).slice();while(a.length<length)a.push(null);(from||[]).forEach((v,k)=>{const at=offset+k;if(at<length&&(a[at]===null||a[at]===undefined))a[at]=v;});return a;};
    for(const w of list){
      const last=out.filter(s=>s.type===w.type).pop();
      if(last&&w.start-last.end<=gap&&!WORKOUTS.splitBetween(last,w,links)){
        const offset=Math.max(0,Math.floor((w.start-last.start)/60000)),end=Math.max(last.end,w.end),length=Math.max(1,Math.ceil((end-last.start)/60000));
        const had=key=>last[key]||w[key];
        for(const key of ['hr','hrMin','hrMax','distanceM','steps'])if(had(key))last[key]=place(last[key]||Array(Math.ceil((last.end-last.start)/60000)).fill(null),w[key]||[],offset,length);
        last.gaps.push(Math.max(0,(w.start-last.end)/60000));
        last.end=end;last.minutes=length;last.parts.push(w.id);last.recovery=w.recovery||null;last.name=last.name||w.name;
        last.aliases=[...(last.aliases||[]),...(w.aliases||[])];last.also=[...(last.also||[]),...(w.also||[])];
        for(const key of ['distance','energy','movingSec'])if(num(w[key]))last[key]=(num(last[key])?last[key]:0)+w[key];
        if(w.indoor)last.indoor=true;if(!w.outdoor)last.outdoor=false;
      }else out.push({...w,minutes:Math.max(1,Math.ceil((w.end-w.start)/60000)),parts:[w.id],gaps:[]});
    }
    return out;
  }
  /* ---- C6 HRmax ---- */
  function hrMaxOf(sessions,options){
    const o=options||{},T=TABLE.hrMax;
    if(num(o.override)&&o.override>100&&o.override<240)return {value:o.override,source:'Your setting'};
    const seconds=[];
    for(const s of sessions||[]){const peaks=present(s.hrMax||[]).sort((a,b)=>b-a);if(peaks.length>=2)seconds.push(peaks[1]);}
    if(seconds.length>=T.minSessions)return {value:Math.max(...seconds),source:'Your workouts',sessions:seconds.length};
    if(num(o.age))return {value:208-0.7*o.age,source:'Age estimate (208 − 0.7 × age)',sessions:seconds.length};
    return {value:null,source:null,sessions:seconds.length};
  }

  /* ---- D3 Recovery Speed ---- */
  function hrAt60(recovery){
    const T=TABLE.recovery,r=recovery||{},sec=r.sec||[],avg=r.avg||[];let before=null,after=null;
    for(let k=0;k<sec.length;k++){if(!num(sec[k])||!num(avg[k])||sec[k]<T.around60[0]||sec[k]>T.around60[1])continue;
      if(sec[k]<=60&&(before===null||sec[k]>sec[before]))before=k;if(sec[k]>=60&&(after===null||sec[k]<sec[after]))after=k;}
    if(before===null||after===null)return null;
    if(sec[before]===sec[after])return avg[before];
    return avg[before]+(avg[after]-avg[before])*(60-sec[before])/(sec[after]-sec[before]);
  }
  function endHr(recovery){
    const r=recovery||{},sec=r.sec||[],avg=r.avg||[];let best=null;
    for(let k=0;k<sec.length;k++)if(num(sec[k])&&num(avg[k])&&(best===null||Math.abs(sec[k])<Math.abs(sec[best])))best=k;
    return best!==null&&Math.abs(sec[best])<=TABLE.recovery.endWithinSec?avg[best]:null;
  }
  function coolDown(session){
    if(/cool/i.test(String(session.name||session.type||'')))return true;
    const hr=present(session.hr||[]);if(hr.length<3)return false;
    const tail=(session.hr||[]).slice(-2).filter(num),last10=(session.hr||[]).slice(-10).filter(num);
    return tail.length>0&&mean(tail)<Math.max(...last10)-TABLE.recovery.coolDownDrop;
  }
  /* sessions carry daysAgo (whole days before the day being scored), recovery {sec,avg}, the per-minute
     hr and hrMax curves and a name. rhr = resting heart rate for the fallback's reserve. */
  function recoverySpeed(sessions,options){
    const T=TABLE.recovery,o=options||{},hrMax=o.hrMax,recent=(sessions||[]).filter(s=>s&&num(s.daysAgo)&&s.daysAgo>=0&&s.daysAgo<T.windowDays);
    const weight=s=>Math.pow(0.5,s.daysAgo/T.halfLifeDays),weighted=(list,pick)=>sum(list.map(s=>weight(s)*pick(s)))/sum(list.map(weight));
    const none=missing=>({value:null,label:null,colour:null,confidence:null,mode:null,inputs:{sessions:[]},missing});
    if(!num(hrMax))return none(['Maximum heart rate']);
    const hard=[];
    for(const s of recent){const end=num(s.endHr)?s.endHr:endHr(s.recovery),at60=num(s.hr60)?s.hr60:hrAt60(s.recovery);
      if(end===null||at60===null||end<T.hardShare*hrMax||coolDown(s))continue;hard.push({...s,end,at60,drop:end-at60});}
    if(hard.length>=T.minSessions){
      const value=Math.round(weighted(hard,s=>s.drop));
      return {value,unit:'bpm',label:'Estimate',colour:null,confidence:hard.length>=6?'High':'Medium',mode:'primary',graded:true,inputs:{sessions:hard,hrMax},missing:[]};
    }
    const soft=[];
    for(const s of recent){const tail=present((s.hrMax||[]).slice(-2)),start=num(s.startHr)?s.startHr:tail.length?Math.max(...tail):null,at60=num(s.hr60)?s.hr60:hrAt60(s.recovery),rest=num(s.rhr)?s.rhr:o.rhr;
      if(start===null||at60===null||!num(rest)||start<T.fallbackShare*hrMax||start<=rest)continue;soft.push({...s,start,at60,drop:start-at60,nd:(start-at60)/(start-rest)*100});}
    if(soft.length<T.minSessions)return none(['Three workouts with a recovery curve in 30 days ('+Math.max(hard.length,soft.length)+'/'+T.minSessions+')']);
    return {value:Math.round(weighted(soft,s=>s.nd)),unit:'%',bpm:Math.round(weighted(soft,s=>s.drop)),label:'Fallback',colour:null,confidence:'Fallback',mode:'fallback',graded:false,
      gradeNote:'Not graded: no hard finishes',inputs:{sessions:soft,hrMax,hardFinishes:hard.length},missing:[]};
  }

  /* ---- D7 Early Warning ---- */
  /* night: tonight's values; typical[metric] = the prior 30 nights' values. A metric joins with 14 nights. */
  function earlyWarning(night,typical){
    const T=TABLE.warning,n=night||{},t=typical||{},checks=[],names={rhr:'Resting heart rate',rr:'Breathing rate',spo2:'Blood oxygen',temp:'Wrist temperature'};
    for(const id of ['rhr','rr','spo2','temp']){
      const base=present(t[id]||[]).slice(-T.window),value=n[id];
      if(base.length<T.minNights||!num(value)){checks.push({id,label:names[id],taking:false,nights:base.length,value:num(value)?value:null});continue;}
      const mid=median(base),spread=robustSd(base),margin=Math.max(T[id],T.sds*spread);
      const outlier=id==='spo2'?value<=mid-margin:id==='temp'?Math.abs(value-mid)>=margin:value>=mid+margin;
      checks.push({id,label:names[id],taking:true,nights:base.length,value,median:mid,sd:spread,threshold:id==='spo2'?mid-margin:mid+margin,low:mid-margin,high:mid+margin,outlier});
    }
    const taking=checks.filter(c=>c.taking),outliers=taking.filter(c=>c.outlier),caps=outliers.filter(c=>c.id==='rr'||c.id==='temp').map(c=>c.label);
    const on=outliers.length>=2;
    return {on,value:outliers.length,label:on?'Early Warning':null,colour:on?'orange':null,confidence:!taking.length?null:checks.find(c=>c.id==='temp').taking&&taking.length===4?'High':'Medium',
      outliers:outliers.map(c=>c.label),capReasons:on?[...new Set([...caps,'Early Warning'])]:caps,checks,inputs:{metrics:taking.length},missing:checks.filter(c=>!c.taking).map(c=>c.label)};
  }

  /* ---- D11 Momentum ---- */
  /* values: one per day, oldest first, ending today; null where the score had no value. */
  function momentum(values,kind){
    const T=TABLE.momentum,v=(values||[]).slice(-T.long),short=present(v.slice(-T.short)),long=present(v);
    if(short.length<T.shortMin||long.length<T.longMin)return {arrow:null,pct:null,colour:null,missing:['28 days of this score ('+long.length+'/'+T.longMin+')']};
    const m7=mean(short),m28=mean(long);if(!m28)return {arrow:null,pct:null,colour:null,missing:[]};
    const pct=(m7-m28)/m28*100,arrow=pct>=T.pct?'↑':pct<=-T.pct?'↓':'→';
    const colour=kind==='load'?'brass':kind==='faith'?'violet':arrow==='↑'?'green':arrow==='↓'?'yellow':'neutral';
    return {arrow,pct,m7,m28,colour,missing:[]};
  }

  /* ---- D8 Mobility (stretch) ---- */
  function walkLowerLimit(o){
    const cm=o&&o.heightCm,kg=o&&o.weightKg,age=o&&o.age;if(!num(cm)||!num(kg)||!num(age))return null;
    return 7.57*cm-5.02*Math.max(age,40)-1.76*kg-309-TABLE.mobility.walkSpan;                       // Enright: predicted − 153 m; the equation starts at 40
  }
  function mobility(input){
    const M=TABLE.mobility,i=input||{},subs={};
    const speed=num(i.speedMs)?i.speedMs:num(i.speedMph)?i.speedMph*M.mphToMs:null;
    if(speed!==null)subs.speed=100*clamp((speed-M.speed[0])/(M.speed[1]-M.speed[0]),0,1);
    if(num(i.asymmetry))subs.asymmetry=100*clamp((M.asymmetry[0]-i.asymmetry)/M.asymmetry[1],0,1);
    if(num(i.doubleSupport))subs.doubleSupport=100*clamp((M.doubleSupport[0]-i.doubleSupport)/M.doubleSupport[1],0,1);
    const lln=walkLowerLimit(i);
    if(num(i.sixMinute)&&lln!==null)subs.sixMinute=100*clamp((i.sixMinute-lln)/M.walkSpan,0,1);
    const parts=Object.values(subs);
    if(parts.length<2)return {value:null,label:null,colour:null,confidence:null,inputs:{subs,speed},missing:['Two walking measures']};
    const value=Math.round(mean(parts));
    return {value,label:null,colour:qualityColour(value,true),confidence:parts.length>=3?'High':'Medium',inputs:{subs,speed,lowerLimit:lln},missing:[]};
  }
  /* ---- D10 Strength Balance (stretch) ---- */
  function strengthBalance(input){
    const i=input||{},days=num(i.strengthDays)?i.strengthDays:0,value=Math.round(100*Math.min(1,days/TABLE.strength.targetDays));
    return {value,label:'Cardio '+(i.cardioDays||0)+' · Strength '+days,colour:goalColour(value,true),confidence:'High',inputs:{strengthDays:days,cardioDays:i.cardioDays||0,target:TABLE.strength.targetDays},missing:[]};
  }
  /* ---- D1 Run Efficiency and D2 Durability (shown once history brings the runs in) ---- */
  function metresPerBeat(distanceM,hr,from){
    let metres=0,beats=0;for(let k=from||0;k<Math.min((distanceM||[]).length,(hr||[]).length);k++)if(num(distanceM[k])&&num(hr[k])){metres+=distanceM[k];beats+=hr[k];}
    return beats?metres/beats:null;
  }
  function runEfficiency(run){return metresPerBeat(run.distanceM,run.hr,TABLE.run.skip);}
  function cardiacDrift(run){
    const skip=TABLE.durability.skip,d=(run.distanceM||[]).slice(skip),h=(run.hr||[]).slice(skip),half=Math.floor(Math.min(d.length,h.length)/2);
    if(half<1)return null;
    const first=metresPerBeat(d.slice(0,half),h.slice(0,half)),second=metresPerBeat(d.slice(half,2*half),h.slice(half,2*half));
    return first&&second!==null?(first-second)/first*100:null;
  }
  const driftColour=v=>v<=TABLE.durability.bands[0]?'green':v<=TABLE.durability.bands[1]?'yellow':v<=TABLE.durability.bands[2]?'orange':'red';
  function medianScore(values,min,places){const v=present(values||[]);if(v.length<min)return null;const f=Math.pow(10,places);return Math.round(median(v)*f)/f;}

  /* =======================================================================================
     Rows. The health drawer's rows, as hae-adapter.js and the history importer write them,
     read once into day-keyed tables. Representation decides what a row may be used for (E3):
       minute aggregate     a sample (sparse metrics keep every one)
       history day summary  a day value from the one-time history import: baselines and history only,
                            never "today" and never an overnight value (sleep nights are whole nights)
       daily rollup         an all-day stream after 35 days: exact totals and 24 hourly figures
       workout session      a workout, with its per-minute curves in `detail`
     ======================================================================================= */
  const SPARSE=new Set(['heart_rate_variability','resting_heart_rate','respiratory_rate','blood_oxygen_saturation','vo2_max','weight_body_mass','weight_&_body_mass','body_fat_percentage','lean_body_mass','walking_speed','walking_asymmetry_percentage','walking_double_support_percentage','six_minute_walking_test_distance','walking_step_length','apple_sleeping_wrist_temperature','cardio_recovery','height','waist_circumference']);
  const TOTALS=new Set(['step_count','active_energy','basal_energy_burned','time_in_daylight']);
  const HISTORY='history day summary',SAMPLE='minute aggregate',ROLLUP='daily rollup';
  const metaOf=r=>{const m=r&&r.unmapped&&r.unmapped.healthAutoExport;return m&&m.format==='JSON'?m:null;};
  const zoneParts=new Map();
  /* Local clock of an instant: minutes after midnight and the calendar day, in the feed's zone. */
  function localClock(ms,zone){
    const z=zone||TABLE.zone;let f=zoneParts.get(z);
    if(!f){f=new Intl.DateTimeFormat('en-GB',{timeZone:z,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});zoneParts.set(z,f);}
    const p=Object.fromEntries(f.formatToParts(new Date(ms)).map(x=>[x.type,x.value]));
    return {day:p.year+'-'+p.month+'-'+p.day,minutes:+p.hour*60+ +p.minute};
  }
  /* Which stored rows the engine may read: only those the projection accepts. For the days the feed scores
     that is its active rows. Rows from before the scoring start are body readings too (left out of points,
     not of scores), so the same projection is asked again with the start moved back: every rule it has
     (the row's contract, its writers, open clashes, rolled-up days) decides there as well. History day
     summaries pass by the projection's own list. `project` is hae-adapter.js project(), handed in so this
     file stays free of it. */
  function readable(rows,contract,project,view){
    const shown=view||project(rows,contract);if(!shown||shown.ok===false)return null;
    const ids=new Set(shown.activeIds.concat(shown.historyIds||[]));
    const early=(rows||[]).filter(r=>{const m=metaOf(r);return !!m&&m.feedId===contract.feedId&&typeof m.day==='string'&&m.day<contract.activeFrom&&m.representation!==HISTORY;});
    if(early.length){const before=project(early,{...contract,activeFrom:'1000-01-01'});if(before&&before.ok!==false)for(const id of before.activeIds)ids.add(id);}
    return ids;
  }
  function select(rows,ids){return (rows||[]).filter(r=>ids.has(r.id)&&!(r.clashes||[]).length);}
  /* Do the indexed rows give this row's measure a value of their own on its day? A history file asks before it
     steps aside for a day the store holds (V3.2.1): a stored row the scores cannot read held the day and left it
     empty. true or false for a measure the index reads; null for one it does not (the caller keeps its own rule). */
  function holds(x,row){
    const m=metaOf(row);if(!x||!m||typeof m.metric!=='string'||typeof m.day!=='string')return null;
    if(m.metric==='sleep_analysis'){
      // A night is filed under the day it ends (addNight), so that is the day asked about.
      const end=row.end?Date.parse(row.end):NaN,day=Number.isFinite(end)?localClock(end,x.zone).day:m.day,n=x.nights.get(day);
      return !!n&&!n.history;
    }
    if(TOTALS.has(m.metric)){const t=x.live.get(m.metric);return !!t&&t.has(m.day);}
    if(SPARSE.has(m.metric)){const name=m.metric==='weight_&_body_mass'?'weight_body_mass':m.metric,s=x.samples.get(name);return !!s&&s.has(m.day);}
    return null;
  }
  const afterNoon=minutes=>(minutes-720+1440)%1440;                                                 // half an hour before midnight → 690, half an hour after → 750
  const textMinutes=start=>{const h=+String(start).slice(11,13),m=+String(start).slice(14,16);return h>=0&&h<24&&m>=0&&m<60?h*60+m:null;};
  function index(rows,options){
    const o=options||{},zone=o.timeZone||TABLE.zone;
    // Pairs of workout ids he set by hand: `join` makes two entries one session, `split` keeps two apart.
    const pairs=list=>(Array.isArray(list)?list:[]).filter(p=>Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='string'));
    const x={zone,links:{join:pairs(o.links&&o.links.join),split:pairs(o.links&&o.links.split)},samples:new Map(),approx:new Map(),totals:new Map(),live:new Map(),nights:new Map(),workouts:[],effort:new Map(),effortRolled:new Map(),heartDays:new Set(),water:new Map(),memo:new Map(),rows:0};
    const put=(map,metric,day,value)=>{let m=map.get(metric);if(!m){m=new Map();map.set(metric,m);}let list=m.get(day);if(!list){list=[];m.set(day,list);}list.push(value);};
    for(const r of rows||[]){
      const m=metaOf(r);if(!m||(r.clashes||[]).length)continue;
      if(r.kind==='workout'){if(m.representation==='workout session')x.workouts.push(r);continue;}
      const metric=m.metric,day=m.day,rep=m.representation;if(typeof metric!=='string'||typeof day!=='string')continue;
      x.rows++;
      const factor=num(m.unitFactor)?m.unitFactor:1,value=num(r.value)?r.value*factor:null;
      if(metric==='sleep_analysis'){addNight(x,r,m,zone);continue;}
      if(metric==='heart_rate'){if(rep===SAMPLE||rep===ROLLUP)x.heartDays.add(day);continue;}
      if(metric==='physical_effort'){
        if(rep===SAMPLE&&value!==null){let list=x.effort.get(day);if(!list){list=[];x.effort.set(day,list);}list.push({t:Date.parse(r.start),v:value});}
        else if(rep===ROLLUP)x.effortRolled.set(day,m);
        continue;
      }
      if(metric==='dietary_water'){if(rep===SAMPLE&&value!==null&&r.sourceApp==='Bevel')x.water.set(day,(x.water.get(day)||0)+value);continue;}   // Bevel only, each drink once
      if(TOTALS.has(metric)){
        if(rep===HISTORY&&value!==null)put(x.totals,metric,day,value);
        // The day's own total from the rows the page hands over (the projection's figure wins when the page supplies it).
        else if(rep===ROLLUP){const total=value!==null?value:Array.isArray(m.hours)?sum(m.hours.map(h=>num(h)?h:0)):null;if(total!==null){let t=x.live.get(metric);if(!t){t=new Map();x.live.set(metric,t);}t.set(day,{v:total,rolled:true});}}
        else if(rep===SAMPLE&&value!==null){let t=x.live.get(metric);if(!t){t=new Map();x.live.set(metric,t);}const c=t.get(day);if(!c)t.set(day,{v:value,rolled:false});else if(!c.rolled)c.v+=value;}
        continue;
      }
      if(!SPARSE.has(metric)||value===null)continue;
      const name=metric==='weight_&_body_mass'?'weight_body_mass':metric;
      if(rep===HISTORY)put(x.approx,name,day,value);
      else if(rep===SAMPLE)put(x.samples,name,day,{t:Date.parse(r.start),v:value});
    }
    for(const list of x.effort.values())list.sort((a,b)=>a.t-b.t);
    x.sessionsRaw=x.workouts.map(workoutOf).filter(Boolean);
    return x;
  }
  /* C2: the night of D is the main sleep that ENDS on D between 03:00 and 13:00; the longest wins; naps are ignored. */
  function addNight(x,r,m,zone){
    const st=m.stats||{},hours=k=>num(st[k])?st[k]:null;
    const staged=['core','deep','rem'].map(hours).filter(v=>v!==null);
    const tst=hours('totalSleep')||hours('asleep')||(staged.length?sum(staged):null);if(!tst)return;
    const start=Date.parse(r.start),end=r.end?Date.parse(r.end):NaN;
    let day=m.day,startMin=null,endMin=null;
    if(Number.isFinite(end)){const c=localClock(end,zone);if(c.minutes<TABLE.sleep.nightFrom*60||c.minutes>TABLE.sleep.nightTo*60)return;day=c.day;endMin=c.minutes;}
    if(Number.isFinite(start)&&Number.isFinite(end))startMin=localClock(start,zone).minutes;
    const night={day,tst,awake:hours('awake'),core:hours('core'),deep:hours('deep'),rem:hours('rem'),inBed:hours('inBed'),start:Number.isFinite(start)&&Number.isFinite(end)?start:null,end:Number.isFinite(end)?end:null,
      startAfterNoon:startMin===null?null:afterNoon(startMin),endAfterNoon:endMin===null?null:afterNoon(endMin),midAfterNoon:startMin===null?null:afterNoon(Math.round(localClock((start+end)/2,zone).minutes)),history:m.representation===HISTORY,source:r.sourceApp};
    const held=x.nights.get(day);
    // A live night outranks a history night for the same day; otherwise the longer sleep is the main one.
    if(!held||(held.history&&!night.history)||(held.history===night.history&&night.tst>held.tst))x.nights.set(day,night);
  }
  function workoutOf(r){return metaOf(r)?WORKOUTS.record(r,metaOf(r).day):null;}
  /* Fitness and scores share duplicate ownership. E4's adjacent same-type analysis grouping remains
     score-only; it cannot undo an explicit split, including a split naming a duplicate's alias. */
  function selectedSessions(x){
    if(!x.memo.has('selected-sessions'))x.memo.set('selected-sessions',WORKOUTS.select(x.sessionsRaw,x.links));
    return x.memo.get('selected-sessions');
  }
  function sessions(x){
    if(!x.memo.has('sessions'))x.memo.set('sessions',mergeSessions(selectedSessions(x),x.links));
    return x.memo.get('sessions');
  }
  const memo=(x,key,make)=>{if(!x.memo.has(key))x.memo.set(key,make());return x.memo.get(key);};
  const night=(x,day)=>x.nights.get(day)||null;
  /* C3: the overnight value of a sparse metric is the median of its samples timed inside the night. */
  function overnight(x,metric,day){
    return memo(x,'o|'+metric+'|'+day,()=>{
      // The Watch gives one wrist temperature for a night and stamps it as it sees fit (the night's start, its end,
      // midnight), so that figure belongs to the day it is filed under, whether or not it falls inside the night.
      const own=()=>{if(metric!=='apple_sleeping_wrist_temperature')return null;const list=(x.samples.get(metric)||new Map()).get(day)||[];return list.length?list.slice().sort((a,b)=>a.t-b.t)[list.length-1].v:null;};
      const n=night(x,day);if(!n||n.start===null||n.end===null)return own();
      const values=[];for(const d of [addDays(day,-1),day])for(const s of (x.samples.get(metric)||new Map()).get(d)||[])if(s.t>=n.start&&s.t<=n.end)values.push(s.v);
      return values.length?median(values):own();
    });
  }
  const latestOf=list=>list&&list.length?list.reduce((a,b)=>b.t>=a.t?b:a).v:null;
  // A reading taken now and then: the day's figure in a history file is that reading. A measure the Watch
  // reports all day is different: its day average is not last night's value and not a current one (E3).
  const EVENT=new Set(['vo2_max','weight_body_mass','body_fat_percentage','lean_body_mass','waist_circumference','six_minute_walking_test_distance','height','cardio_recovery']);
  const dayApprox=(x,metric,day)=>{const v=(x.approx.get(metric)||new Map()).get(day);return v&&v.length?mean(v):null;};
  /* A day's value: the sample-based value when the day has one. A baseline may fall back on the history day
     average (approx); a current value may not, unless the metric is a now-and-then reading. */
  function baselineValue(x,metric,day,kind,current){
    const exact=kind==='overnight'?overnight(x,metric,day):latestOf((x.samples.get(metric)||new Map()).get(day));
    if(exact!==null)return {v:exact,approx:false};
    if(current&&!EVENT.has(metric))return null;
    const a=dayApprox(x,metric,day);return a===null?null:{v:a,approx:true};
  }
  function baseline(x,metric,day,kind,transform){
    const values=[];let approx=0,exact=0;
    for(let k=TABLE.baselineDays;k>=1;k--){const b=baselineValue(x,metric,addDays(day,-k),kind);if(!b)continue;const v=transform?transform(b.v):b.v;if(!num(v))continue;values.push(v);if(b.approx)approx++;else exact++;}
    return {values,approx,exact};
  }
  /* C7: the day's resting heart rate is its latest sample; none → yesterday's, marked. */
  function restingHr(x,day){
    const at=d=>latestOf((x.samples.get('resting_heart_rate')||new Map()).get(d)),today=at(day);
    if(today!==null)return {value:today,yesterday:false};
    const before=at(addDays(day,-1));return before===null?null:{value:before,yesterday:true};
  }
  function sleepFor(x,day,options){
    return memo(x,'sleep|'+day+'|'+((options&&options.need)||''),()=>{
      const n=night(x,day);if(!n)return sleepScore({});
      const starts=[];for(let k=0;k<TABLE.sleep.window;k++){const p=night(x,addDays(day,-k));if(p&&num(p.startAfterNoon))starts.push(p.startAfterNoon);}
      const result=sleepScore({tst:n.tst,need:options&&options.need,starts,wakeMin:num(n.awake)?n.awake*60:0});
      const nights=[];for(let k=0;k<TABLE.sleep.bankNights;k++){const p=night(x,addDays(day,-k));nights.push(p?p.tst:null);}
      result.bank=sleepBank(nights,options&&options.need);result.night=n;return result;
    });
  }
  /* His usual wake time from the last 14 nights (needs 3), and tonight's bedtime from it. */
  function bedtimeFor(x,day,options){
    const T=TABLE.sleep,wakes=[];for(let k=0;k<T.wakeNights;k++){const n=night(x,addDays(day,-k));if(n&&num(n.endAfterNoon))wakes.push(n.endAfterNoon);}
    if(wakes.length<T.wakeMin)return null;
    const sleep=sleepFor(x,day,options);
    return bedtime({wake:median(wakes),need:options&&options.need,bank:sleep.bank?sleep.bank.hours:null});
  }
  function hrMaxFor(x,day,options){
    const o=options||{};return memo(x,'hrmax|'+day+'|'+(o.override||'')+'|'+(o.age||''),()=>hrMaxOf(sessions(x).filter(s=>s.day<=day&&daysBetween(s.day,day)<TABLE.hrMax.days),o));
  }
  /* Effort minutes outside every workout window, and each workout's mean effort, for one day. */
  function effortFor(x,day){
    return memo(x,'effort|'+day,()=>{
      const rolled=x.effortRolled.get(day),selected=selectedSessions(x),owner=new Map();for(const w of selected)for(const id of WORKOUTS.ids(w))owner.set(id,w.id);
      if(rolled){let points=0;for(const h of rolled.hours||[])if(h&&h.out)points+=everydayLoadFromBands(h.out,rolled.bandStep);const per={};for(const [id,p] of Object.entries(rolled.workouts||{})){const into=owner.get(id);if(!into)continue;const sum=per[into]||(per[into]={sum:0,n:0});sum.sum+=p.sum;sum.n+=p.n;}return {known:true,everyday:points,workouts:per};}
      const list=x.effort.get(day);if(!list)return {known:false,everyday:0,workouts:{}};
      // Preserve the raw input-order attribution kept by HAE rollups, then resolve its duplicate owner.
      const windows=x.sessionsRaw.filter(w=>w.day===day||w.day===addDays(day,-1)),outside=[],per={};
      for(const s of list){const w=windows.find(a=>s.t>=a.start&&s.t<=a.end),id=w&&owner.get(w.id);if(id){const p=per[id]||(per[id]={sum:0,n:0});p.sum+=s.v;p.n++;}else outside.push(s.v);}
      return {known:true,everyday:everydayLoad(outside),workouts:per};
    });
  }
  /* L(D). A day counts when the Watch was worn: heart-rate or effort rows, a workout, or (history only) a
     day summary of steps or energy. A day with none of these is missing, not zero. */
  function loadOf(x,day,options){
    return memo(x,'L|'+day+'|'+((options&&options.hrMax)||''),()=>{
      const hrMax=options&&options.hrMax,effort=effortFor(x,day),list=sessions(x).filter(s=>s.day===day);
      let workout=0,weak=false;const parts=[];
      for(const s of list){
        const per=s.parts.map(id=>effort.workouts[id]).filter(Boolean),n=sum(per.map(p=>p.n)),meanEffort=n?sum(per.map(p=>p.sum))/n:null;
        // Without a curve the fallback is duration × weight: the time he was moving, not the span on the clock.
        const r=sessionLoad({hr:s.hr,minutes:num(s.movingSec)&&s.movingSec>0?Math.min(s.minutes,s.movingSec/60):s.minutes,effort:meanEffort},hrMax);workout+=r.load;weak=weak||r.weak;parts.push({id:s.id,type:s.type,load:r.load,source:r.source,minutes:r.minutes});
      }
      const history=['step_count','active_energy'].some(k=>((x.totals.get(k)||new Map()).get(day)||[]).length>0||(x.live.get(k)||new Map()).has(day));
      const worn=x.heartDays.has(day)||effort.known||list.length>0;
      if(!worn&&!history)return {L:null,workout:0,everyday:0,parts,approx:false,weak:false};
      // Without the day's effort rows its everyday part is unknown and counts as 0: the load is a floor.
      return {L:workout+effort.everyday,workout,everyday:effort.everyday,parts,approx:!effort.known,weak:weak||!effort.known};
    });
  }
  /* A day's load as the band and the trend may read it. A day without its everyday effort (imported history)
     holds its workouts only, a floor: counted as a load it pulled the 28-day mean down, so an ordinary day read
     as far above it (V3.2). Such a day is drawn, faded, and sets nothing. */
  function fullLoad(x,day,options){const d=loadOf(x,day,options);return d.approx?null:d.L;}
  const workoutBaselineLoad=d=>d.parts.length||(!d.approx&&d.L!==null)?d.workout:null;
  function loadFor(x,day,options){
    const o=options||{},today=loadOf(x,day,o),full=[],workouts=[];
    for(let k=TABLE.load.chronic;k>=1;k--){const date=addDays(day,-k),d=loadOf(x,date,o);full.push(fullLoad(x,date,o));workouts.push(workoutBaselineLoad(d));}
    const fullDays=present(full).length,workoutDays=present(workouts).length,workoutsOnly=fullDays<TABLE.load.chronicMin,history=workoutsOnly?workouts:full;
    const result=load({L:workoutsOnly?workoutBaselineLoad(today):today.L,history,readinessLabel:o.readinessLabel,closed:o.closed,wellAboveDays:workoutsOnly?0:o.wellAboveDays,weak:today.weak||workoutsOnly});
    Object.assign(result.inputs,{workout:today.workout,everyday:today.everyday,parts:today.parts,approx:today.approx||workoutsOnly,totalLoad:today.L,baselineKind:workoutsOnly?'workouts':'full',fullDays,workoutDays,days:present(history).length,closed:o.closed===true});
    return result;
  }
  /* Consecutive days, ending yesterday, whose trend label read Well Above (the only road to red). */
  function wellAboveRun(x,day,options){
    let run=0;
    for(let k=1;k<=TABLE.load.redAfter;k++){const d=addDays(day,-k),h=[];for(let j=TABLE.load.chronic;j>=1;j--)h.push(fullLoad(x,addDays(d,-j),options));
      const known=present(h),recent=present(h.slice(-TABLE.load.acute));if(known.length<TABLE.load.chronicMin||!recent.length||loadTrend(mean(recent),mean(known))!=='Well Above')break;run++;}
    return run;
  }
  function typicalNights(x,metric,day,kind){
    const out=[];for(let k=TABLE.warning.window;k>=1;k--){const d=addDays(day,-k),v=kind==='overnight'?overnight(x,metric,d):latestOf((x.samples.get(metric)||new Map()).get(d));if(v!==null)out.push(v);}
    return out;
  }
  function warningFor(x,day){
    return memo(x,'warn|'+day,()=>{
      const rhr=restingHr(x,day);
      return earlyWarning({rhr:rhr&&!rhr.yesterday?rhr.value:null,rr:overnight(x,'respiratory_rate',day),spo2:overnight(x,'blood_oxygen_saturation',day),temp:overnight(x,'apple_sleeping_wrist_temperature',day)},
        {rhr:typicalNights(x,'resting_heart_rate',day,'latest'),rr:typicalNights(x,'respiratory_rate',day,'overnight'),spo2:typicalNights(x,'blood_oxygen_saturation',day,'overnight'),temp:typicalNights(x,'apple_sleeping_wrist_temperature',day,'overnight')});
    });
  }
  /* Readiness of a day, from the rows alone. options: need (sleep), hrMax override, age. */
  function readinessFor(x,day,options){
    const o=options||{};
    return memo(x,'ready|'+day+'|'+JSON.stringify([o.need||null,o.hrMaxOverride||null,o.age||null]),()=>{
      const T=TABLE.readiness,ln=v=>v>0?Math.log(v):null;
      const hToday=overnight(x,'heart_rate_variability',day),recent=[];
      for(let k=0;k<T.rolling;k++){const v=overnight(x,'heart_rate_variability',addDays(day,-k));if(v!==null)recent.push(ln(v));}
      const hBase=baseline(x,'heart_rate_variability',day,'overnight',ln),h=zScores(hToday===null?null:ln(hToday),recent,hBase.values,T.lnSdFloor,false);
      const rToday=restingHr(x,day),rBase=baseline(x,'resting_heart_rate',day,'latest'),r=zScores(rToday?rToday.value:null,[],rBase.values,T.rhrSdFloor,true);
      const sleep=sleepFor(x,day,{need:o.need}),hrMax=hrMaxFor(x,day,{override:o.hrMaxOverride,age:o.age}).value;
      // Yesterday's load against yesterday's own band (its Readiness label is not re-derived: Ready stands in).
      const y=addDays(day,-1),yLoad=loadFor(x,y,{hrMax,closed:true});
      const warning=warningFor(x,day);
      const approx=(hBase.approx>0&&hBase.exact<T.fullBaseline)||(rBase.approx>0&&rBase.exact<T.fullBaseline);
      const result=readiness({z1:h.z1,z7:h.z7,zR:r.z1,sleep:sleep.value,load:yLoad.value!==null&&yLoad.band?{L:yLoad.inputs.L,hi:yLoad.band.hi}:null,capReasons:warning.capReasons,
        baselineDays:{hrv:hBase.values.length,rhr:rBase.values.length},approxBaseline:approx,rhrYesterday:!!(rToday&&rToday.yesterday)});
      result.inputs.hrv={tonight:hToday,mu:h.mu,sigma:h.sigma,z1:h.z1,z7:h.z7,days:hBase.values.length,approxDays:hBase.approx,band:h.mu===null?null:[Math.exp(h.mu-0.5*h.sigma),Math.exp(h.mu+0.5*h.sigma)]};
      result.inputs.rhr={today:rToday?rToday.value:null,yesterday:!!(rToday&&rToday.yesterday),mu:r.mu,sigma:r.sigma,days:rBase.values.length,approxDays:rBase.approx};
      result.inputs.sleep=sleep.value;result.inputs.load=yLoad.value===null?null:{L:yLoad.value,band:yLoad.band,label:yLoad.label};
      result.warning=warning;
      return result;
    });
  }
  /* A window's current values of a sparse metric, newest last, each {day,v,approx}: sample-based days only,
     except for a now-and-then reading, whose history day value is the reading. */
  /* A window's days (a 30-day median, not one current value). Two measures may take a history file's day figure
     there (Mintay, Sept 27, V3.2.2): the Watch reports one resting heart rate a day, so the day's figure is that
     reading, and a day's mean walking speed is what a 30-day median is made of. HRV stays on overnight samples;
     latestReading (one current value) takes no day figure for any all-day measure. */
  const WINDOW_DAY=new Set(['resting_heart_rate','walking_speed']);
  function series(x,metric,from,to,kind){
    const day=WINDOW_DAY.has(metric)&&(kind||'latest')==='latest';
    const out=[];for(let d=from;d<=to;d=addDays(d,1)){const b=baselineValue(x,metric,d,kind||'latest',!day);if(b)out.push({day:d,v:b.v,approx:b.approx});}
    return out;
  }
  /* The newest reading on or before a day, with its age in days (a current value, as above). */
  function latestReading(x,metric,day,maxDays){
    for(let k=0;k<=(maxDays||TABLE.vo2.staleDays);k++){const d=addDays(day,-k),b=baselineValue(x,metric,d,'latest',true);if(b)return {value:b.v,day:d,age:k,approx:b.approx};}
    return null;
  }
  /* Steps for a day: the projection's total when the page supplies it, else the history day summary. */
  function stepsOn(x,day,projected){
    if(projected&&num(projected[day]))return projected[day];
    const live=(x.live.get('step_count')||new Map()).get(day);if(live)return live.v;
    const h=(x.totals.get('step_count')||new Map()).get(day);return h&&h.length?Math.max(...h):null;
  }
  function healthAgeFor(x,day,options){
    const o=options||{},H=TABLE.healthAge,w=healthAgeWindow(day),age=num(o.age)?o.age:null;
    const med=(metric,kind)=>{const s=series(x,metric,w.from,w.to,kind).map(p=>p.v);return s.length>=H.minDays?median(s):null;};
    const vo2=latestReading(x,'vo2_max',w.to,TABLE.vo2.staleDays),fat=series(x,'body_fat_percentage',w.from,w.to).map(p=>p.v);
    const nights=[],steps=[];for(let d=w.from;d<=w.to;d=addDays(d,1)){const n=night(x,d);if(n)nights.push(n.tst);const s=stepsOn(x,d,o.steps);if(s!==null)steps.push(s);}
    const walk=med('walking_speed');
    const result=healthAge({age,vo2:vo2?vo2.value:null,vo2Stale:!!vo2&&vo2.age>TABLE.vo2.freshDays,rhr:med('resting_heart_rate'),sdnn:med('heart_rate_variability','overnight'),
      bodyFat:fat.length>=H.minWeighIns?median(fat):null,tst:nights.length>=H.minDays?mean(nights):null,steps:steps.length>=H.minDays?mean(steps):null,walk:walk===null?null:walk*TABLE.mobility.mphToMs,asOf:w.asOf});
    result.window=w;return result;
  }
  /* Health Age now, and its change against the same sum 13 weeks (91 days) earlier, from kept data. */
  function healthAgeTrend(x,day,options){
    const now=healthAgeFor(x,day,options),then=healthAgeFor(x,addDays(day,-TABLE.healthAge.changeDays),{...options,age:options&&num(options.ageThen)?options.ageThen:options&&options.age});
    now.change=now.exact!==undefined&&now.value!==null&&then.value!==null?Math.round((now.exact-then.exact)*10)/10:null;now.before=then.value===null?null:{value:then.value,asOf:then.window.asOf};
    return now;
  }
  function fitnessAgeFor(x,day,options){
    const o=options||{},r=latestReading(x,'vo2_max',day,TABLE.vo2.staleDays);
    if(!r)return fitnessAge(null);
    return fitnessAge(r.value,{age:o.age,stale:r.age>TABLE.vo2.freshDays,asOf:r.day});
  }
  function recoveryFor(x,day,options){
    const o=options||{},rhr=restingHr(x,day);
    const list=sessions(x).filter(s=>s.day<=day&&s.recovery).map(s=>({...s,daysAgo:daysBetween(s.day,day)}));
    return recoverySpeed(list,{hrMax:o.hrMax,rhr:rhr?rhr.value:o.rhr});
  }
  /* Where I Stand: current values (30-day window; VO₂ max the latest within 60 days), graded. */
  function standFor(x,day,options){
    const o=options||{},from=addDays(day,-29),who={sex:o.sex,age:o.age},rows=[];
    const values=(metric,kind)=>series(x,metric,from,day,kind).map(p=>p.v),fromFile=metric=>series(x,metric,from,day).filter(p=>p.approx).length;
    const vo2=latestReading(x,'vo2_max',day,TABLE.vo2.staleDays);
    const push=(entry,confidence,extra)=>rows.push({...entry,confidence,...(extra||{})});
    // C.6: the current value is the latest within 60 days. An older reading is dated context: shown with its
    // date, never given a rung.
    const fresh=!!vo2&&vo2.age<=TABLE.vo2.freshDays;
    push(stand('vo2_max',fresh?vo2.value:null,who),fresh?'High':null,{asOf:vo2?vo2.day:null,stale:!!vo2&&!fresh,last:vo2&&!fresh?vo2.value:null,note:vo2&&!fresh?'Last reading is over '+TABLE.vo2.freshDays+' days old':null,group:'fitness'});
    const recovery=o.recovery||recoveryFor(x,day,o);
    push(recovery.mode==='primary'?stand('heart_rate_recovery',recovery.value,who):{metric:'heart_rate_recovery',value:null,rung:null,label:null,colour:null,note:recovery.mode==='fallback'?recovery.gradeNote:null,fallback:recovery.mode==='fallback'?recovery:null,missing:recovery.missing},recovery.mode==='primary'?recovery.confidence:null,{group:'fitness'});
    const rhr=values('resting_heart_rate'),hrv=values('heart_rate_variability','overnight');
    push(stand('resting_heart_rate',rhr.length?median(rhr):null,who),rhr.length>=10?'High':rhr.length>=5?'Medium':rhr.length?'Low':null,{group:'fitness',days:rhr.length,historyDays:fromFile('resting_heart_rate')});
    push(stand('heart_rate_variability',hrv.length?median(hrv):null,who),hrv.length>=10?'High':hrv.length>=5?'Medium':hrv.length?'Low':null,{group:'fitness',days:hrv.length});
    const steps=[],nights=[];for(let d=from;d<=day;d=addDays(d,1)){const s=stepsOn(x,d,o.steps);if(s!==null&&d<day)steps.push(s);const n=night(x,d);if(n)nights.push(n.tst);}
    push(stand('step_count',steps.length?mean(steps):null,who),steps.length>=10?'High':steps.length>=5?'Medium':steps.length?'Low':null,{group:'body',days:steps.length});
    const fat=latestReading(x,'body_fat_percentage',day,90);
    push(range('body_fat_percentage',fat?fat.value:null,who),fat?(fat.age<=30?'High':'Medium'):null,{group:'body',asOf:fat?fat.day:null});
    push(range('sleep_duration',nights.length?mean(nights):null,who),nights.length>=10?'High':nights.length>=5?'Medium':nights.length?'Low':null,{group:'body',days:nights.length});
    const waist=latestReading(x,'waist_circumference',day,180);
    if(waist)push(range('waist_circumference',waist.value*2.54,{...who,heightCm:o.heightCm}),'Medium',{group:'body',asOf:waist.day});
    const walk=values('walking_speed'),six=latestReading(x,'six_minute_walking_test_distance',day,90);
    const floors=[floorCheck('walking_speed',walk.length?median(walk)*TABLE.mobility.mphToMs:null),floorCheck('six_minute_walking_test_distance',six?six.value:null,{heightCm:o.heightCm,weightKg:o.weightKg,age:o.age})];
    return {rows,gains:biggestGains(rows),floors,warning:warningFor(x,day),asOf:day,band:cutsFor('vo2_max',who).band};
  }
  function momentumFor(valueOn,day,kind){const v=[];for(let k=TABLE.momentum.long-1;k>=0;k--){const r=valueOn(addDays(day,-k));v.push(num(r)?r:null);}return momentum(v,kind);}
  function mobilityFor(x,day,options){
    const o=options||{},from=addDays(day,-29),med=m=>{const s=series(x,m,from,day).map(p=>p.v);return s.length?median(s):null;};
    return mobility({speedMph:med('walking_speed'),asymmetry:med('walking_asymmetry_percentage'),doubleSupport:med('walking_double_support_percentage'),sixMinute:med('six_minute_walking_test_distance'),heightCm:o.heightCm,weightKg:o.weightKg,age:o.age});
  }
  function strengthFor(x,day){
    const from=addDays(day,-(TABLE.strength.window-1)),strength=new Set(),cardio=new Set(),types=TABLE.strength.types.map(t=>t.toLowerCase());
    for(const s of sessions(x)){if(s.day<from||s.day>day)continue;(types.some(t=>String(s.type).toLowerCase().includes(t.replace(' training',''))||String(s.type).toLowerCase()===t)?strength:cardio).add(s.day);}
    return strengthBalance({strengthDays:strength.size,cardioDays:cardio.size});
  }
  function runsFor(x,day,options){
    const o=options||{},R=TABLE.run,D=TABLE.durability,hrMax=o.hrMax,runs=sessions(x).filter(s=>/run/i.test(s.type)&&s.day<=day&&s.hr&&s.distanceM);
    const easy=s=>{const m=mean(present(s.hr));return num(hrMax)&&m>=R.easy[0]*hrMax&&m<=R.easy[1]*hrMax;};
    // Outdoor by the export's flag where the record carries it (V3.2), else by name: a run that does not say where it was
    // is left out rather than guessed at.
    const eff=(from,to)=>runs.filter(s=>s.day>=from&&s.day<=to&&s.outdoor&&!s.indoor&&s.minutes>=R.minMin&&sum(present(s.distanceM))>=R.minM&&easy(s)).map(runEfficiency);
    const now=medianScore(eff(addDays(day,-(R.window-1)),day),R.minRuns,2),before=medianScore(eff(addDays(day,-(2*R.window-1)),addDays(day,-R.window)),R.minRuns,2);
    const change=now!==null&&before?(now-before)/before*100:null;
    const steady=s=>{const d=present(s.distanceM.slice(D.skip));if(d.length<2)return false;const m=mean(d);return m>0&&sd(d)/m<=D.steadyCv;};
    const drifts=runs.filter(s=>daysBetween(s.day,day)<D.window&&s.minutes>=D.minMin&&!s.gaps.some(g=>g>D.maxGapMin)&&steady(s)).map(cardiacDrift).filter(num);
    const drift=medianScore(drifts,D.minRuns,1);
    return {efficiency:{value:now,unit:'m per beat',before,change,arrow:change===null?null:change>=R.trendPct?'↑':change<=-R.trendPct?'↓':'→',colour:change===null?null:change>=R.trendPct?'green':change<=-R.trendPct?'yellow':'neutral',missing:now===null?['Three easy outdoor runs in 28 days']:[]},
      durability:{value:drift,unit:'%',colour:drift===null?null:driftColour(drift),runs:drifts.length,missing:drift===null?['Two steady runs of 50 minutes in 60 days']:[]}};
  }

  return {TABLE,NORMS,
    // formulas
    readiness,readinessLabel,readinessColour,zScores,sleepScore,sleepBand,sleepBank,clock,timeOfDay,bedtime,zoneWeight,sessionLoad,everydayLoad,everydayLoadFromBands,loadTrend,loadBand,load,fuel,faith,
    fitnessAge,healthAge,healthAgeWindow,ageOn,bandFor,cutsFor,stand,range,tier,floorCheck,appleLevel,biggestGains,mergeSessions,hrMaxOf,hrAt60,endHr,recoverySpeed,earlyWarning,momentum,
    mobility,walkLowerLimit,strengthBalance,runEfficiency,cardiacDrift,driftColour,goalColour,qualityColour,ageColour,fastResilience,fastResilienceLabel,
    // rows
    readable,select,holds,index,sessions,night,overnight,restingHr,baseline,series,latestReading,sleepFor,bedtimeFor,hrMaxFor,effortFor,loadOf,loadFor,wellAboveRun,warningFor,readinessFor,healthAgeFor,healthAgeTrend,fitnessAgeFor,recoveryFor,standFor,momentumFor,mobilityFor,strengthFor,runsFor,stepsOn,fastResilienceFor,
    // helpers the page shares
    addDays,daysBetween,mondayOf,median,mean,sd,robustSd,stepDown};
});
