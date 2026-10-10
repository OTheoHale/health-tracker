/* One duplicate selector for Fitness and scores. Original records are never changed; Watch summary
   values win, and secondary traces can fill only missing minutes inside the selected time window. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.WorkoutSessions=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const num=Number.isFinite;
  const watch=w=>/apple\s*watch|watch\d|watchos/i.test([w.writer,w.sourceApp,w.device,w.unmapped?.healthAutoExport?.originalWriter,w.unmapped?.starter?.source_name].filter(Boolean).join(' '));
  const ids=w=>[...new Set([w.id,...(w.parts||[]),...(w.aliases||[]).map(a=>a.id),...(w.also||[]).map(a=>a.id)].filter(Boolean))];
  const paired=(pairs,a,b)=>(pairs||[]).some(p=>Array.isArray(p)&&p.length===2&&((a.includes(p[0])&&b.includes(p[1]))||(a.includes(p[1])&&b.includes(p[0]))));
  const splitBetween=(a,b,links)=>paired(links?.split,ids(a),ids(b));
  function record(r,day){
    const m=r?.unmapped?.healthAutoExport||{},start=Date.parse(r.start),end=Date.parse(r.end);
    if(!num(start)||!num(end)||end<=start)return null;
    const d=r.detail||{},hr=d.hr||{},units={m:1,km:1000,mi:1609.344,yd:.9144,ft:.3048},q=m.distance,factor=q&&units[String(q.units||'').toLowerCase()];
    return {id:r.id,type:r.type||'Workout',name:r.type||'',writer:r.sourceApp||'',isWatch:watch(r),day:day||m.day,start,end,minutes:Math.max(1,Math.ceil((end-start)/60000)),movingSec:num(r.durationSec)?r.durationSec:null,
      hr:Array.isArray(hr.avg)?hr.avg:null,hrMin:Array.isArray(hr.min)?hr.min:null,hrMax:Array.isArray(hr.max)?hr.max:null,distanceM:Array.isArray(d.distanceM)?d.distanceM:null,steps:Array.isArray(d.steps)?d.steps:null,
      recovery:d.recovery&&Array.isArray(d.recovery.sec)?d.recovery:null,distance:q&&num(q.qty)&&factor?q.qty*factor:null,
      indoor:typeof d.indoor==='boolean'?d.indoor:/indoor|treadmill/i.test(String(r.type||'')),outdoor:typeof d.indoor==='boolean'?!d.indoor:/outdoor|trail/i.test(String(r.type||''))&&!/indoor|treadmill/i.test(String(r.type||''))};
  }
  const order=(a,b)=>Number(b.isWatch===true||watch(b))-Number(a.isWatch===true||watch(a))||a.start-b.start||String(a.id).localeCompare(String(b.id));
  function withTraces(group){
    const [first,...aliases]=group.slice().sort(order),out={...first,aliases:aliases.slice(),also:aliases.map(w=>({id:w.id,type:w.type,writer:w.writer})),curveSources:[]},length=Math.max(1,Math.ceil((first.end-first.start)/60000));
    for(const key of ['hr','hrMin','hrMax','distanceM','steps']){
      const own=Array.isArray(first[key])?first[key].slice():null,values=own||Array(length).fill(null);let filled=false;
      for(const other of aliases){let used=false;for(let i=0;i<length;i++){
        if(num(values[i]))continue;const at=first.start+i*60000,index=Math.floor((at-other.start)/60000);
        if(at>=other.start&&at<other.end&&Array.isArray(other[key])&&num(other[key][index])){values[i]=other[key][index];filled=used=true;}
      }if(used)out.curveSources.push({id:other.id,writer:other.writer,curve:key});}
      out[key]=own||filled?values:null;
    }
    // Recovery is relative to the finish: a different finish cannot be relabelled as this one's trace.
    if(!out.recovery){const donor=aliases.find(w=>w.end===first.end&&w.recovery);if(donor){out.recovery=donor.recovery;out.curveSources.push({id:donor.id,writer:donor.writer,curve:'recovery'});}}
    return out;
  }
  function select(rows,links={}){
    let groups=(rows||[]).filter(Boolean).slice().sort(order).map(w=>[w]);
    // BC2 (Speed, Oct 9): with no join or split pairs (his usual case) no pair of workouts can match, so their id lists are not built for
    // every pair (769 workouts: about 0.35 to 0.6 s each time new rows arrive); the overlap is tested before the split.
    const joins=Array.isArray(links.join)&&links.join.length>0,splits=Array.isArray(links.split)&&links.split.length>0;
    const groupIds=g=>g.flatMap(ids),split=(a,b)=>splits&&paired(links.split,groupIds(a),groupIds(b)),manual=g=>g.some(w=>w.manual);
    // Resolve explicit joins first so an alias can connect an earlier and a later host; any explicit split wins.
    for(let changed=joins;changed;){changed=false;outer:for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
      const a=groups[i],b=groups[j];if(!manual(a)&&!manual(b)&&!split(a,b)&&paired(links.join,groupIds(a),groupIds(b))){a.push(...b);a.sort(order);groups.splice(j,1);changed=true;break outer;}
    }}
    groups.sort((a,b)=>order(a[0],b[0]));const kept=[];
    for(const group of groups){const w=group[0],host=kept.find(g=>{
      if(manual(g)||manual(group))return false;const k=g[0],over=Math.min(k.end,w.end)-Math.max(k.start,w.start);
      return over>0&&over>=.5*Math.min(k.end-k.start,w.end-w.start)&&!split(g,group);
    });if(host)host.push(...group);else kept.push(group);}
    return kept.map(withTraces).sort((a,b)=>a.start-b.start||String(a.id).localeCompare(String(b.id)));
  }
  return {record,select,watch,ids,splitBetween};
});
