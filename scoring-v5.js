/* Scoring V2 (rule step 5, effective Mon 2026-09-21; Mintay Sept 25). Pure and exact: every credit is a
   fraction {n,d} of safe integers in [0,1], so the quarter-point rounding happens once, in QuarterPoints.baseQ.
   The table holds every value Mintay may change; a changed table is a new table from a date, and each
   claim records the credit it was paid, so earlier claims never move. No storage, no evidence reading. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.ScoringV5=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const DEFAULT_TABLE=Object.freeze({
    id:'points-v5-2026-09-21',effectiveFrom:'2026-09-21',
    sleepTargetMin:420,                       // nightly points = hours ÷ 7 h, capped at 100%
    stepsTarget:12000,
    waterTargetOz:100,waterFloorOz:60,        // proportional; the target is never set below 60
    deficitFullKcal:825,deficitOnTrackKcal:750,
    ateOutKeepPct:[100,75,50,30],             // 0, 1, 2, 3+ times eaten out
    sodaPct:10,sodaCapPct:20,alcoholPct:25,alcoholCapPct:50,
    sleepCredit:{weekTargetMin:2940,fullDebtMin:294,zeroDebtMin:840,bankCapMin:420},
    perfectDayPct:5,perfectWeekPct:10,dailyCapPct:150,
    deficitCurve:[[500,8],[800,10],[1000,12]]
  });
  const gcd=(a,b)=>{a=Math.abs(a);b=Math.abs(b);while(b){[a,b]=[b,a%b];}return a||1;};
  function fraction(n,d){
    if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||d<=0)throw new RangeError('A credit needs safe integer parts.');
    if(n<=0)return {n:0,d:1};if(n>=d)return {n:1,d:1};
    const g=gcd(n,d);return {n:n/g,d:d/g};
  }
  const whole=v=>Number.isFinite(v)?Math.max(0,Math.round(v)):null;
  function table(t){return t&&typeof t==='object'?{...DEFAULT_TABLE,...t,sleepCredit:{...DEFAULT_TABLE.sleepCredit,...(t.sleepCredit||{})}}:DEFAULT_TABLE;}

  /* The nutrition percentage, exact: the deficit sets the base (full at 825 kcal), eating out keeps a
     share of it, then soda and alcohol subtract percentage points (each capped); never below 0. */
  function nutrition(inputs,t){
    const x=table(t),deficit=whole(inputs&&inputs.deficit);if(deficit===null)return null;
    const ate=Math.max(0,Math.min(3,Math.floor(+inputs.ateOut||0))),keep=x.ateOutKeepPct[ate];
    const soda=Math.min(x.sodaCapPct,x.sodaPct*Math.max(0,Math.floor(+inputs.soda||0))),alcohol=Math.min(x.alcoholCapPct,x.alcoholPct*Math.max(0,Math.floor(+inputs.alcohol||0)));
    const base=Math.min(deficit,x.deficitFullKcal);                      // in kcal of 825
    // percent = base/825 × keep − penalties  →  over 825×100
    return fraction(base*keep-(soda+alcohol)*x.deficitFullKcal,x.deficitFullKcal*100);
  }
  /* The credit fraction for one item kind, or null when its input is unknown (the day stays pending). */
  function credit(kind,inputs,t){
    const x=table(t),i=inputs||{};
    if(kind==='sleep'){const m=whole(i.minutes);return m===null?null:fraction(m,x.sleepTargetMin);}
    if(kind==='steps'){const s=whole(i.steps),target=whole(i.target)||x.stepsTarget;return s===null?null:fraction(s,target);}
    if(kind==='water'){if(!Number.isFinite(i.oz))return null;const target=Math.max(x.waterFloorOz,whole(i.targetOz)||x.waterTargetOz);return fraction(Math.round(i.oz*100),target*100);}
    if(kind==='nutrition')return nutrition(i,x);
    if(kind==='minutes'){const got=whole(i.minutes),target=whole(i.target);return got===null||!target?null:fraction(got,target);}
    throw new RangeError('Unsupported credit kind: '+String(kind)+'.');
  }
  /* Sleep Credit: a running balance against 7 h a night from the table's start, debt and surplus
     carried, surplus banked up to +7 h. Full credit within 4.9 h of debt, none at 14 h, linear between.
     nights: [{date, minutes|null}] in date order; a missing night leaves the credit unknown. */
  function sleepCredit(nights,t){
    const x=table(t),s=x.sleepCredit,daily=Math.round(s.weekTargetMin/7);let balance=0;
    for(const night of nights||[]){if(!Number.isFinite(night.minutes))return {balanceMin:null,credit:null};balance=Math.min(s.bankCapMin,balance+Math.round(night.minutes)-daily);}
    const debt=Math.max(0,-balance);
    const c=debt<=s.fullDebtMin?{n:1,d:1}:debt>=s.zeroDebtMin?{n:0,d:1}:fraction(s.zeroDebtMin-debt,s.zeroDebtMin-s.fullDebtMin);
    return {balanceMin:balance,credit:c};
  }
  function deficitPoints(deficit,t){const x=table(t);if(!Number.isFinite(deficit))return 0;for(const [kcal,points] of x.deficitCurve.slice().sort((a,b)=>b[0]-a[0]))if(deficit>=kcal)return points;return 0;}
  function dailyCapQ(perfectQ,t){const x=table(t);if(!Number.isSafeInteger(perfectQ)||perfectQ<0)throw new RangeError('Perfect-day points must be a safe integer.');return Math.floor(perfectQ*x.dailyCapPct/100);}
  const percent=c=>c?Math.round(1000*c.n/c.d)/10:null;
  return {DEFAULT_TABLE,table,fraction,credit,nutrition,sleepCredit,deficitPoints,dailyCapQ,percent};
});
