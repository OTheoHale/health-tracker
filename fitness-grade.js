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
    // Each component is shown as a whole number and the grade is the mean of what is shown (the research file's worked example).
    const components=COMPONENTS.map(c=>({...c,score:score[c.id]===null?null:Math.round(score[c.id]),detail:c.id==='body'&&body?body.by:null}));
    const present=components.filter(c=>c.score!==null),percent=present.length?mean(present.map(c=>c.score)):null;
    const habits=present.filter(c=>c.group==='habits').length,measured=present.filter(c=>c.group==='measured').length;
    const eligible=present.length>=5&&habits>=2&&measured>=1;
    let letter=eligible?letterOf(percent):null;const capped=!!letter&&present.length<7&&['S','SS','SSS'].includes(letter);if(capped)letter='A';
    const groupMean=g=>{const v=present.filter(c=>c.group===g).map(c=>c.score);return v.length?mean(v):null;};
    return {window:w,components,present:present.length,percent,shown:percent===null?null:Math.round(percent),letter,capped,provisional:!eligible&&present.length>0,
      habits:groupMean('habits'),measured:groupMean('measured'),blocks:blocks.length,foodDays:blocks.reduce((n,b)=>n+b.foodDays,0),days:use.length};
  }
  // The "+ Faith" row: a displayed blend only; the pure Fitness Grade never changes.
  const blend=(fitness,faith,share)=>fitness===null||faith===null||!Number.isFinite(faith)?fitness:(1-share)*fitness+share*faith;
  return {COMPONENTS,grade,blend,letterOf,minutesScore,stepsScore,sleepScore,vo2Score,bodyScore,netScore};
});
