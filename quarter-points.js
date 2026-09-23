/* Proposed rule 4: integer quarter-points only. No evidence, persistence or adoption. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else if(typeof define==='function'&&define.amd)define([],factory);
  else root.QuarterPoints=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const MAX=BigInt(Number.MAX_SAFE_INTEGER);
  const COSTS=[260,380,500,600,700,800,880,960,1000,1040];

  function object(value,name){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError(name+' must be an object.');
    return value;
  }
  function integer(value,name,minimum=0){
    if(!Number.isSafeInteger(value)||value<minimum)throw new RangeError(name+' must be a safe integer at least '+minimum+'.');
    return BigInt(value);
  }
  function number(value,name){
    if(value<0n||value>MAX)throw new RangeError(name+' exceeds the nonnegative safe integer range.');
    return Number(value);
  }
  function boolean(value,name,fallback){
    if(value===undefined)return fallback;
    if(typeof value!=='boolean')throw new TypeError(name+' must be boolean.');
    return value;
  }
  // Interpret a Number's canonical decimal spelling exactly, including exponent notation.
  function rational(value,name,positive=false){
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER||(positive&&value===0))throw new RangeError(name+' must be a finite '+(positive?'positive':'nonnegative')+' number within the safe range.');
    const [mantissa,exponent='0']=String(value).toLowerCase().split('e'),parts=mantissa.split('.');
    const scale=(parts[1]||'').length-Number(exponent),digits=BigInt(parts.join(''));
    return scale>=0?{n:digits,d:10n**BigInt(scale)}:{n:digits*10n**BigInt(-scale),d:1n};
  }
  function nearest(n,d){return number((2n*n+d)/(2n*d),'Rounded quarter-points');}

  /* kind defaults to ordinary; cardio receives already aggregated verified minutes.
     Size is a positive rational (default 1/1), applied before the single half-up rounding. */
  function baseQ(input){
    const f=object(input,'Base rule'),kind=f.kind===undefined?'ordinary':f.kind;
    const sizeN=integer(f.sizeNumerator===undefined?1:f.sizeNumerator,'Size numerator',1);
    const sizeD=integer(f.sizeDenominator===undefined?1:f.sizeDenominator,'Size denominator',1);
    let n,d;
    if(kind==='ordinary'){
      const importance=integer(f.importance,'Importance',1),difficulty=integer(f.difficulty,'Difficulty',1);
      if(importance>3n||difficulty>3n)throw new RangeError('Importance and difficulty must be from 1 to 3.');
      n=32n*(importance+difficulty);d=5n;
    }else if(kind==='cardio'){
      const minutes=rational(f.minutes,'Aggregated cardio minutes');
      if(minutes.n<=45n*minutes.d){n=32n*minutes.n;d=45n*minutes.d;}
      else{n=8n*minutes.n+120n*minutes.d;d=15n*minutes.d;}
    }else throw new RangeError('Unsupported base kind: '+String(kind)+'.');
    return nearest(n*sizeN,d*sizeD);
  }

  function bonusQ(base,options={}){
    const amount=integer(base,'Base quarter-points'),o=object(options,'Bonus options');
    const prior=integer(o.priorFull===undefined?0:o.priorFull,'Prior full count');
    const pending=boolean(o.pending,'Pending',false),recurring=boolean(o.recurring,'Recurring',true);
    if(pending||!recurring||prior<3n)return 0;
    return number(amount/(prior>=14n?5n:prior>=7n?10n:20n),'Bonus quarter-points');
  }

  /* Largest remainder; output is sorted by exact ID, independent of display order.
     Missing weight means 1. Explicit weights must be finite positive Numbers. */
  function allocateQ(total,leaves){
    const amount=integer(total,'Allocation quarter-points');
    if(!Array.isArray(leaves))throw new TypeError('Allocation leaves must be an array.');
    if(!leaves.length){if(amount)throw new RangeError('A positive allocation needs leaves.');return [];}
    const ids=new Set(),rows=leaves.map(leaf=>{
      object(leaf,'Allocation leaf');
      if(typeof leaf.id!=='string'||!leaf.id.trim()||ids.has(leaf.id))throw new TypeError('Allocation needs unique nonempty string IDs.');
      ids.add(leaf.id);
      return {id:leaf.id,weight:rational(Object.prototype.hasOwnProperty.call(leaf,'weight')?leaf.weight:1,'Leaf weight',true)};
    });
    const denominator=rows.reduce((d,row)=>row.weight.d>d?row.weight.d:d,1n);
    for(const row of rows)row.units=row.weight.n*(denominator/row.weight.d);
    const weight=rows.reduce((sum,row)=>sum+row.units,0n);
    for(const row of rows){const numerator=amount*row.units;row.amount=numerator/weight;row.remainder=numerator%weight;}
    const compareID=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
    rows.sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:compareID(a,b));
    const left=Number(amount-rows.reduce((sum,row)=>sum+row.amount,0n));
    for(let i=0;i<left;i++)rows[i].amount++;
    return rows.sort(compareID).map(row=>({id:row.id,amountQ:number(row.amount,'Leaf quarter-points')}));
  }

  /* After level 10 each level costs 5 more points than the one before (Mintay, 2026-09-23): the
     early game stays quick, and later levels keep getting a little harder instead of flattening out. */
  function costBig(level){return level<=10n?BigInt(COSTS[Number(level-1n)]):1040n+20n*(level-10n);}
  function costQ(level){return number(costBig(integer(level,'Level',1)),'Level cost');}
  function thresholdBig(level){
    if(level<=11n)return COSTS.slice(0,Number(level-1n)).reduce((sum,cost)=>sum+BigInt(cost),0n);
    const count=level-11n;
    return 7120n+1040n*count+10n*count*(count+1n);
  }
  /* thresholdQ is the cumulative start of this level, not the next level. */
  function levelFor(total){
    const amount=integer(total,'Lifetime quarter-points');
    let low=1n,high=2n;
    while(thresholdBig(high)<=amount){low=high;high*=2n;}
    while(high-low>1n){const middle=(low+high)/2n;if(thresholdBig(middle)<=amount)low=middle;else high=middle;}
    const threshold=thresholdBig(low),within=amount-threshold,cost=costBig(low);
    return {level:number(low,'Level'),withinQ:number(within,'Within-level quarter-points'),costQ:number(cost,'Level cost'),remainingQ:number(cost-within,'Remaining quarter-points'),thresholdQ:number(threshold,'Level threshold')};
  }

  /* Events are a string or {status}: full, partial, miss, pending, rest, unscheduled.
     Full increments even while pending; pending suppresses bonus, not the count.
     Partial/miss reset both; rest/unscheduled preserve both. Resolve late evidence
     by replaying chronology from before the pending event, not by clearing its flag. */
  function chainAdvance(chain,event){
    const c=object(chain,'Chain'),prior=integer(c.priorFull,'Prior full count');
    const pending=boolean(c.pending,'Pending',false),status=typeof event==='string'?event:object(event,'Chain event').status;
    if(status==='full')return {priorFull:number(prior+1n,'Prior full count'),pending};
    if(status==='partial'||status==='miss')return {priorFull:0,pending:false};
    if(status==='pending')return {priorFull:Number(prior),pending:true};
    if(status==='rest'||status==='unscheduled')return {priorFull:Number(prior),pending};
    throw new RangeError('Unsupported chain event: '+String(status)+'.');
  }

  return Object.freeze({baseQ,bonusQ,allocateQ,costQ,levelFor,chainAdvance});
});
