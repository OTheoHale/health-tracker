/* Glow V3.5 G5, the Fitness Grade (docs/research/fitness-grade-method-2026-10-01.md §3, the build brief's G5). A Life's
   Essential 8 style composite: seven components scored 0 to 100 on published break points, the unweighted mean of those
   present, the letter from Glow's ladder. Pure: days in, scores out; nothing is stored and no store is read. Shown, not
   scored: HRV, resting HR, heart-rate recovery, body fat, hydration, fitness age, Health Age, Readiness.
   Windows (§3, "How a window is scored"): Day = the trailing 7 closed days (today's progress is shown beside, never
   graded) and never Net Fuel (the brief: weekly or longer only); Week = the last 7 closed days; Month = the last 28 (four
   blocks); All = every complete 7-day block since the program start, else "Building n of 7 days" and no letter.
   Weekly-bound components are scored per 7-day block, then averaged over the blocks, so a big week cannot cover an empty
   one. Missing data is never a zero. S, SS and SSS need all seven components; with fewer the letter caps at A. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.FitnessGrade=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const CUTS=[[95,'SSS'],[90,'SS'],[85,'S'],[80,'A'],[70,'B'],[55,'C'],[40,'D'],[0,'F']];   // RANK_CUTOFFS, unchanged
  const letterOf=p=>Number.isFinite(p)?CUTS.find(([c])=>p>=c)[1]:null;
  const COMPONENTS=[
    {id:'movement',name:'Movement',group:'habits'},{id:'strength',name:'Muscle strengthening',group:'habits'},{id:'sleep',name:'Sleep',group:'habits'},
    {id:'vo2',name:'VO₂ max',group:'measured'},{id:'body',name:'Body size',group:'measured'},{id:'protein',name:'Protein',group:'habits'},{id:'net',name:'Net Fuel',group:'habits'}];
  const mean=a=>a.length?a.reduce((n,v)=>n+v,0)/a.length:null;
  // 1. Movement: moderate-equivalent minutes per block (LE8 table) or steps (linear 2,000 to 8,000; 6,000 at 60+), the higher.
  function minutesScore(m){return m<=0?0:m<30?20:m<60?40:m<90?60:m<120?80:m<150?90:100;}
  function stepsScore(meanSteps,age){const top=age>=60?6000:8000;return Math.max(0,Math.min(100,100*(meanSteps-2000)/(top-2000)));}
  // 3. Sleep: block mean hours (LE8 table).
  function sleepScore(h){return h>=7&&h<9?100:h>=9&&h<10?90:h>=6&&h<7?70:(h>=5&&h<6)||h>=10?40:h>=4&&h<5?20:0;}
  // 4. VO2 max: the FRIEND percentile for sex and decade, linear between the published points; 95th or more = 100.
  function vo2Score(value,points){
    if(!Number.isFinite(value)||!points)return null;
    const ks=[5,10,25,50,75,90,95].filter(k=>Number.isFinite(points[k]));if(!ks.length)return null;
    if(value>=points[95])return 100;if(value<points[5])return Math.max(0,5*value/points[5]);
    for(let i=0;i<ks.length-1;i++){const a=ks[i],b=ks[i+1];if(value>=points[a]&&value<points[b])return a+(b-a)*(value-points[a])/(points[b]-points[a]);}
    return 100;
  }
  // 5. Body size: waist-to-height (NICE NG246) when a waist is logged, else BMI on the WHO classes; never both.
  function bodyScore(b){
    if(!b)return null;
    if(Number.isFinite(b.waistIn)&&Number.isFinite(b.heightIn)&&b.heightIn>0){const r=b.waistIn/b.heightIn;return {score:r<.5?100:r<.6?70:30,by:'waist-to-height',value:r};}
    if(Number.isFinite(b.weightLb)&&Number.isFinite(b.heightIn)&&b.heightIn>0){const bmi=703*b.weightLb/(b.heightIn*b.heightIn);return {score:bmi<25?100:bmi<30?70:bmi<35?30:bmi<40?15:0,by:'BMI',value:bmi};}
    return null;
  }
  // 7. Net Fuel: the block's mean daily deficit against the plan; full within 250 kcal, zero at 750 away, either side.
  function netScore(meanDeficit,plan){const off=Math.abs(meanDeficit-(plan||0));return off<=250?100:off>=750?0:100*(1-(off-250)/500);}
  /* One block of 7 closed days: [{steps, workoutMinutes, worn, strength (minutes of strength work), sleepH, proteinG,
     proteinTargetG, net (deficit kcal, complete days only)}]. Returns each weekly-bound component's score or null. */
  function block(days,o){
    const age=o.age||0,worn=days.filter(d=>d.worn),stepDays=days.filter(d=>Number.isFinite(d.steps));
    const minutes=worn.length?minutesScore(days.reduce((n,d)=>n+(d.workoutMinutes||0),0)):null,steps=stepDays.length>=5?stepsScore(mean(stepDays.map(d=>d.steps)),age):null;
    const movement=minutes===null&&steps===null?null:Math.max(minutes===null?-1:minutes,steps===null?-1:steps);
    const anyWorkout=days.some(d=>d.workoutData),sDays=days.filter(d=>(d.strength||0)>=15).length,strength=anyWorkout?(sDays>=2?100:sDays===1?50:0):null;
    const nights=days.filter(d=>Number.isFinite(d.sleepH)),sleep=nights.length>=5?sleepScore(mean(nights.map(d=>d.sleepH))):null;
    const pDays=days.filter(d=>Number.isFinite(d.proteinG)&&d.proteinTargetG>0),protein=pDays.length>=4?mean(pDays.map(d=>100*Math.min(1,d.proteinG/d.proteinTargetG))):null;
    const nDays=days.filter(d=>Number.isFinite(d.net)),net=o.noNet||nDays.length<5?null:netScore(mean(nDays.map(d=>d.net)),o.plan);
    return {movement,strength,sleep,protein,net,foodDays:pDays.length};
  }
  /* grade({days (oldest first, closed days only), window:'day'|'week'|'month'|'all', age, plan, vo2:{value, points},
     body:{waistIn, heightIn, weightLb}}) */
  function grade(input){
    const o=input||{},w=o.window||'week',days=(o.days||[]).slice();
    const want=w==='month'?28:w==='all'?Math.floor(days.length/7)*7:7,use=days.slice(Math.max(0,days.length-want));
    if(use.length<7)return {window:w,building:days.length,components:COMPONENTS.map(c=>({...c,score:null})),present:0,percent:null,letter:null,note:'Building '+days.length+' of 7 days'};
    const blocks=[];for(let i=use.length;i-7>=0;i-=7)blocks.unshift(block(use.slice(i-7,i),{age:o.age,plan:o.plan,noNet:w==='day'}));
    const avg=k=>{const v=blocks.map(b=>b[k]).filter(x=>x!==null&&Number.isFinite(x));return v.length?mean(v):null;};
    const body=bodyScore(o.body),vo2=o.vo2?vo2Score(o.vo2.value,o.vo2.points):null;
    const score={movement:avg('movement'),strength:avg('strength'),sleep:avg('sleep'),vo2,body:body?body.score:null,protein:avg('protein'),net:avg('net')};
    // V3.6 N8 (ASSUMED A6): Net Fuel's credit is capped by what the scale confirms, min(logged, scale), the scale score on the
    // same 250 and 750 band from the deficit the smoothed weight implies; with no qualifying pair it is not capped and says so.
    const sc=o.scale&&Number.isFinite(o.scale.deficit)&&score.net!==null?netScore(o.scale.deficit,o.plan):null,netLogged=score.net;
    if(sc!==null&&sc<score.net)score.net=sc;
    // Each component is shown as a whole number and the grade is the mean of what is shown (the research file's worked example).
    const components=COMPONENTS.map(c=>({...c,score:score[c.id]===null?null:Math.round(score[c.id]),detail:c.id==='body'&&body?body.by:null}));
    const present=components.filter(c=>c.score!==null),percent=present.length?mean(present.map(c=>c.score)):null;
    const habits=present.filter(c=>c.group==='habits').length,measured=present.filter(c=>c.group==='measured').length;
    const eligible=present.length>=5&&habits>=2&&measured>=1;
    let letter=eligible?letterOf(percent):null;const capped=!!letter&&present.length<7&&['S','SS','SSS'].includes(letter);if(capped)letter='A';
    const groupMean=g=>{const v=present.filter(c=>c.group===g).map(c=>c.score);return v.length?mean(v):null;};
    return {window:w,components,present:present.length,percent,shown:percent===null?null:Math.round(percent),letter,capped,provisional:!eligible&&present.length>0,
      net:netLogged===null?null:{logged:Math.round(netLogged),scale:sc===null?null:Math.round(sc),confirmed:sc!==null,capped:sc!==null&&sc<netLogged},
      habits:groupMean('habits'),measured:groupMean('measured'),blocks:blocks.length,foodDays:blocks.reduce((n,b)=>n+b.foodDays,0),days:use.length};
  }
  // The "+ Faith" row: a displayed blend only; the pure Fitness Grade never changes.
  const blend=(fitness,faith,share)=>fitness===null||faith===null||!Number.isFinite(faith)?fitness:(1-share)*fitness+share*faith;
  return {COMPONENTS,grade,blend,letterOf,minutesScore,stepsScore,sleepScore,vo2Score,bodyScore,netScore};
});

/* V3.6 R1: the Nutrition Grade lives in this file beside the Fitness Grade (both pure grade engines), so the Mac wrapper's
   local server serves it with no native change; it exports NutritionGrade (require('./fitness-grade.js').NutritionGrade). */
/* Glow V3.6 R1, the Nutrition Grade (docs/research/nutrition-grade-method-2026-10-03.md §2, the build brief's R1). A
   nutrient profile of what was logged, not "diet quality": Glow receives nutrient totals per day, never foods, food
   groups or added sugar. Seven components scored 0 to 100 (HEI-2020's method: proportional between published standards,
   by density per 1,000 kcal; DRI adequacy as percent of the RDA or AI, capped, with a UL guard), the unweighted mean of
   those present, the letter from Glow's ladder (Life's Essential 8's shape). Pure: days in, scores out.
   Fix AZ1 (his decision, Oct 9; retires AD1's 7-closed-day blocks): the grade grades exactly the days it is given (a
   day, 3 days, a week, a month, all), pooled over the window's graded days. A graded day has dietary energy of at least
   300 kcal (his change from 800); no food in the window is no grade (a dash, never an F). The open day is graded as soon
   as it reaches 300 kcal and is reported "so far". Each component reads the pooled intake over the graded days that
   report that nutrient, and counts when it is reported on at least half of them (1 of 1, 2 of 3, 4 of 7); zero or absent
   is "not reported", never zero intake. All seven components count on any window, the basket included. A letter needs 5
   of 7 components; S, SS and SSS need all 7, otherwise the letter caps at A. Sex unset: potassium and the basket are missing
   ("set sex in Settings"; no male fallback). The RDA, AI and UL values were verified at the NASEM summary tables (below). */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports.NutritionGrade=factory();
  else root.NutritionGrade=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const CUTS=[[95,'SSS'],[90,'SS'],[85,'S'],[80,'A'],[70,'B'],[55,'C'],[40,'D'],[0,'F']];   // RANK_CUTOFFS, unchanged
  const letterOf=p=>Number.isFinite(p)?CUTS.find(([c])=>p>=c)[1]:null;
  const FLOOR_KCAL=300,MIN_DAYS=1,LOW_KCAL=1500;   // AZ1: 300 kcal makes a graded day; one graded day can be graded
  const need=n=>Math.max(1,Math.ceil(n/2));   // AZ1: a nutrient counts when reported on at least half the graded days
  const COMPONENTS=[
    {id:'satfat',name:'Saturated fat',group:'limits'},{id:'sodium',name:'Sodium',group:'limits'},{id:'fatq',name:'Fat quality',group:'limits'},
    {id:'fibre',name:'Fibre',group:'adequacy'},{id:'potassium',name:'Potassium',group:'adequacy'},{id:'calcium',name:'Calcium',group:'adequacy'},{id:'basket',name:'Vitamins and minerals',group:'adequacy',low:true}];
  const BASKET=['mg','zn','fe','vitA','vitC','vitE','vitK','b6'];
  // Age bands 19-30, 31-50, 51-70, 71+. Verified Oct 3, 2026 (R4) against the Food and Nutrition Board, NASEM, DRI summary
  // tables (RDA and AI, vitamins and elements; prepublication copy): nationalacademies.org/cdn/materials/9fb9fae8-82dc-4e60-8521-30dd740d1b5e
  const band=age=>age>=71?3:age>=51?2:age>=31?1:0;
  const RDA={   // male, female per band (vitamin K and potassium are AIs)
    mg:{m:[400,420,420,420],f:[310,320,320,320]},zn:{m:[11,11,11,11],f:[8,8,8,8]},fe:{m:[8,8,8,8],f:[18,18,8,8]},
    vitA:{m:[900,900,900,900],f:[700,700,700,700]},vitC:{m:[90,90,90,90],f:[75,75,75,75]},vitE:{m:[15,15,15,15],f:[15,15,15,15]},
    vitK:{m:[120,120,120,120],f:[90,90,90,90]},b6:{m:[1.3,1.3,1.7,1.7],f:[1.3,1.3,1.5,1.5]},
    calcium:{m:[1000,1000,1000,1200],f:[1000,1000,1200,1200]},potassium:{m:[3400,3400,3400,3400],f:[2600,2600,2600,2600]}};
  /* Tolerable upper levels, verified Oct 3, 2026 against the same tables (UL, vitamins and elements):
     nationalacademies.org/cdn/materials/9fb9faeb-1faf-41d1-b2f7-381c9b8bdbef. Magnesium's UL is for a pharmacological agent only
     and vitamin E's for supplements and fortified foods; vitamin A's is for preformed vitamin A only, which a food total that
     includes carotenoids cannot show: none of the three is applied to food totals. */
  const UL={calcium:[2500,2500,2000,2000],zn:[40,40,40,40],fe:[45,45,45,45],vitC:[2000,2000,2000,2000],b6:[100,100,100,100]};
  const mean=a=>a.length?a.reduce((n,v)=>n+v,0)/a.length:null,sum=a=>a.reduce((n,v)=>n+v,0);
  const clamp=v=>Math.max(0,Math.min(100,v));
  const has=v=>Number.isFinite(v)&&v>0;   // zero or absent = not reported
  const graded=d=>!!d&&Number.isFinite(d.kcal)&&d.kcal>=FLOOR_KCAL;
  /* The limits' standards are HEI-2020's, verified Oct 3, 2026 at its Table 1 (epi.grants.cancer.gov/hei/hei-2020-table1.html):
     saturated fat 8 to 16 % of energy, sodium 1.1 to 2.0 g per 1,000 kcal, (PUFA + MUFA) / SFA 2.5 to 1.2. Fibre's 14 g per
     1,000 kcal is the Dietary Guidelines' figure, still [R] (its PDF was not reachable); no info text quotes it. */
  // Linear between a best and a worst point (either direction).
  const between=(x,best,worst)=>clamp(100*(worst-x)/(worst-best));
  // Adequacy with the UL guard: min(100, intake/target), and above the UL 100 - 100 x (intake - UL) / (0.5 x UL), floor 0.
  function adequacy(intake,target,ul){
    let s=clamp(100*intake/target),flag=false;
    if(Number.isFinite(ul)&&intake>ul){s=Math.min(s,clamp(100-100*(intake-ul)/(0.5*ul)));flag=true;}
    return {score:s,ul:flag};
  }
  /* The window's days, pooled (AZ1: any number of days): [{kcal, sat, mufa, pufa, fibre, sodium, potassium, calcium, mg, zn,
     fe, vitA, vitC, vitE, vitK, b6}] (g, mg, mcg as the adapter declares). Returns each component's score or null, the
     graded-day count and why. */
  function block(days,o){
    const g=days.filter(graded),sex=o.sex==='male'?'m':o.sex==='female'?'f':null,age=Number.isFinite(o.age)?o.age:null,b=age===null?null:band(age);
    const out={graded:g.length,kcal:g.length?mean(g.map(d=>d.kcal)):null,scores:{},vals:{},ul:[],why:{}};
    if(!g.length){out.why.block='no food logged';for(const c of COMPONENTS)out.scores[c.id]=null;return out;}
    const min=need(g.length);
    const rep=k=>g.filter(d=>has(d[k])),pool=k=>{const r=rep(k);return r.length>=min?{n:r.length,sum:sum(r.map(d=>d[k])),kcal:sum(r.map(d=>d.kcal)),mean:mean(r.map(d=>d[k]))}:null;};
    const s=out.scores,v=out.vals;   // v: the working values the drawer prints
    const sf=pool('sat');s.satfat=sf?between(100*sf.sum*9/sf.kcal,8,16):null;if(sf)v.satfat={pctKcal:100*sf.sum*9/sf.kcal,days:sf.n};
    const na=pool('sodium');s.sodium=na?between(na.sum/(na.kcal/1000),1100,2000):null;if(na)v.sodium={per1000:na.sum/(na.kcal/1000),mean:na.mean,days:na.n};
    const fb=pool('fibre');s.fibre=fb?clamp(100*(fb.sum/(fb.kcal/1000))/14):null;if(fb)v.fibre={per1000:fb.sum/(fb.kcal/1000),mean:fb.mean,days:fb.n};
    const fq=g.filter(d=>has(d.sat)&&has(d.mufa)&&has(d.pufa));
    const ratio=fq.length?(sum(fq.map(d=>d.mufa))+sum(fq.map(d=>d.pufa)))/sum(fq.map(d=>d.sat)):null;s.fatq=fq.length>=min?between(ratio,2.5,1.2):null;if(fq.length>=min)v.fatq={ratio,days:fq.length};
    const k=pool('potassium');s.potassium=k&&sex?adequacy(k.mean,RDA.potassium[sex][b===null?1:b]).score:null;if(k)v.potassium={mean:k.mean,target:sex?RDA.potassium[sex][b===null?1:b]:null,days:k.n};
    if(k&&!sex)out.why.potassium='set sex in Settings';
    const ca=pool('calcium'),caT=b===null?null:sex?RDA.calcium[sex][b]:RDA.calcium.m[b]===RDA.calcium.f[b]?RDA.calcium.m[b]:null;   // calcium needs sex only where the RDA differs (51 to 70)
    if(ca)v.calcium={mean:ca.mean,target:caT,days:ca.n};
    if(ca&&caT!==null){const a=adequacy(ca.mean,caT,UL.calcium[b]);s.calcium=a.score;if(a.ul)out.ul.push('calcium');}else{s.calcium=null;if(ca)out.why.calcium=b===null?'set birth year in Settings':'set sex in Settings';}
    if(sex&&b!==null){
      const parts=[];for(const n of BASKET){const p=pool(n);if(!p)continue;const a=adequacy(p.mean,RDA[n][sex][b],UL[n]?UL[n][b]:undefined);parts.push(a.score);if(a.ul)out.ul.push(n);}
      s.basket=parts.length>=4?mean(parts):null;out.basketN=parts.length;v.basket={n:parts.length,of:BASKET.length};if(parts.length<4)out.why.basket='needs 4 vitamins and minerals reported';
    }else{s.basket=null;out.why.basket=sex?'set birth year in Settings':'set sex in Settings';}
    for(const c of COMPONENTS)if(s[c.id]===undefined)s[c.id]=null;
    return out;
  }
  /* grade({days (oldest first; exactly the window's days, one per date, no-food days included), window (a label only:
     'day'|'3d'|'week'|'month'|'all'|...), sex:'male'|'female'|null, age, open (true when the last day is the open day)}).
     AZ1: grades exactly the days given; no graded day = no grade. */
  function grade(input){
    const o=input||{},w=o.window||'week',days=(o.days||[]).filter(Boolean);
    const g=days.filter(graded),food=days.some(d=>Number.isFinite(d.kcal)&&d.kcal>0);
    const soFar=!!o.open&&days.length>0&&graded(days[days.length-1]);
    const cov=n=>n+' of 7 components, '+g.length+' of '+days.length+(days.length===1?' day':' days')+' graded'+(soFar?' (today so far)':'');
    const base={window:w,days:days.length,graded:g.length,gradedOf:days.length,blocks:1,soFar,food};
    if(!g.length){const note=food?'Under '+FLOOR_KCAL+' kcal logged':'No food logged';
      return {...base,components:COMPONENTS.map(c=>({...c,score:null,why:note})),present:0,percent:null,shown:null,letter:null,capped:false,provisional:false,
        limits:null,adequacy:null,qualifying:0,lowIntake:false,vals:{},kcal:null,ul:[],coverage:cov(0),note};}
    const b=block(days,o);
    // Each component is shown as a whole number and the grade is the mean of what is shown (the research's worked example).
    const components=COMPONENTS.map(c=>{const v=b.scores[c.id];return {...c,score:v===null?null:Math.round(v),why:v===null?(b.why[c.id]||'not reported on half the graded days'):null};});
    const present=components.filter(c=>c.score!==null);
    const percent=present.length?mean(present.map(c=>c.score)):null;
    const eligible=present.length>=5;
    let letter=eligible?letterOf(percent):null;
    const capped=!!letter&&['S','SS','SSS'].includes(letter)&&present.length<7;if(capped)letter='A';
    const gmean=x=>{const v=present.filter(c=>c.group===x).map(c=>c.score);return v.length?mean(v):null;};
    const closed=(soFar?days.slice(0,-1):days).filter(graded),closedKcal=closed.length?mean(closed.map(d=>d.kcal)):null;   // an open day's partial intake never reads as low intake
    return {...base,components,present:present.length,percent,shown:percent===null?null:Math.round(percent),letter,capped,provisional:!eligible&&present.length>0,
      limits:gmean('limits'),adequacy:gmean('adequacy'),qualifying:1,lowIntake:Number.isFinite(closedKcal)&&closedKcal<LOW_KCAL,vals:b.vals,kcal:b.kcal,ul:[...new Set(b.ul)],
      coverage:cov(present.length),note:present.length?(eligible?null:'Needs 5 of 7 components'):'No nutrient detail yet'};
  }
  // The nutrients shown, not scored: the days each was reported over the window's days (AZ1: the whole window).
  const SHOWN=[['sugar','Total sugar'],['cholesterol','Cholesterol'],['caffeine','Caffeine'],['water','Water'],['vitD','Vitamin D'],['b12','Vitamin B12']];
  function shown(days){const d=(days||[]).filter(Boolean);return SHOWN.map(([k,name])=>({id:k,name,days:d.filter(x=>has(x[k])).length,of:d.length}));}
  return {COMPONENTS,BASKET,RDA,UL,FLOOR_KCAL,MIN_DAYS,grade,block,shown,letterOf,graded,adequacy,between};
});
