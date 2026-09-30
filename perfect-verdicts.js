/* One clock-free verdict contract for Collection and dated rewards. No store access or writes. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.PerfectVerdicts=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const dayMs=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10));
  function necessary(quota,date,doneToday){
    if(!quota||!(quota.target>0)||date<quota.from||date>quota.to)return false;
    const before=Math.max(0,(quota.count||0)-(doneToday?1:0)),missing=quota.target-before;
    const left=Number.isFinite(quota.left)?quota.left:Math.round((dayMs(quota.to)-dayMs(date))/86400000)+1;
    return missing>0&&missing>=left;
  }
  function day(d){
    const due=[],fit=[];
    for(const it of d.items||[]){
      if(it.neutral)continue;
      const needed=it.quota?necessary(it.quota,d.date,!!it.done):!it.optional;
      if(!needed)continue;
      due.push(it);if(it.fitness)fit.push(it);
    }
    const rings=['cardio','strength'].map(k=>d.rings&&d.rings[k]).filter(r=>r&&r.applicable),open=due.filter(it=>!it.done);
    const fitOpen=fit.filter(it=>!it.done).map(it=>it.name).concat(rings.filter(r=>!r.closed).map(r=>r.label||'Ring'));
    return {date:d.date,perfect:due.length?open.length===0:null,due:due.length,done:due.length-open.length,open:open.map(it=>it.name),
      fitness:fit.length||rings.length?fitOpen.length===0:null,fitnessDue:fit.length+rings.length,fitnessDone:fit.length+rings.length-fitOpen.length,fitnessOpen:fitOpen};
  }
  function span(days,quotas,today,track){
    const pick=v=>track==='fitness'?v.fitness:v.perfect,judged=days.filter(v=>v.date<=today),lived=judged.filter(v=>pick(v)!==null),missed=judged.filter(v=>pick(v)===false);
    const mine=(quotas||[]).filter(q=>!q.neutral&&(track!=='fitness'||q.fitness)),over=!days.length||days[days.length-1].date<today,short=mine.filter(q=>(q.count||0)<q.target);
    const broken=missed.length>0||(over&&short.length>0);
    return {perfect:lived.length===0&&!mine.length?null:over?!broken&&lived.length>0:broken?false:null,running:!over,possible:!broken,days:lived.length,perfectDays:lived.filter(v=>pick(v)===true).length,missed:missed.map(v=>v.date),
      quotas:mine.map(q=>({name:q.name,target:q.target,count:q.count||0,met:(q.count||0)>=q.target}))};
  }
  return {necessary,day,span};
});
