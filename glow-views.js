/* Glow views (V3.1): the drawn pieces of the score pages and the Perfect tiers, as pure functions.
   Data in (what scores.js returns, or a day's due items), markup or a verdict out; no DOM, no storage, no
   clock. The page gathers the data and places the pieces; test-glow-views.js checks them without a browser.
   Colour is always a name (red · orange · yellow · green · violet, blue for sleep, brass for a measure)
   mapped to the page's tokens, so a colour means the same thing everywhere and every scale can show a key. */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./perfect-verdicts.js'));
  else root.GlowViews=factory(root.PerfectVerdicts);
})(typeof globalThis!=='undefined'?globalThis:this,function(Perfect){
  'use strict';
  const esc=s=>String(s===null||s===undefined?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>typeof v==='number'&&Number.isFinite(v),clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v)),f=n=>(+n).toFixed(1);
  const TONES={red:'var(--c-red)',orange:'var(--c-orange)',yellow:'var(--c-yellow)',green:'var(--c-green)',violet:'var(--c-violet)',purple:'var(--c-violet)',blue:'var(--sleep)',brass:'var(--brass)',neutral:'var(--muted)',loadLow:'#2458a0',loadTarget:'#18734b',loadHigh:'#a83843',
    // V3.4 (§1 tiers): the published-tier tones for body fat, BMI and waist; red is bad, purple elite, a caution tone below range
    caution:'#8a9bb0',tierBlue:'#6fb6e0',lightRed:'#f4a095',darkRed:'#a8283a'};
  /* A name from the table, or a colour of the page's own continuous scales (rgb(…), a token) passed through. */
  const tone=name=>TONES[name]||(/^(#[0-9a-f]{3,8}|rgb\(|hsl\(|var\(--)/i.test(String(name||''))?String(name):'var(--muted)');
  const n0=v=>Math.round(v).toLocaleString('en-US');

  // Mintay's Phase 4 scales: position against the actual target, never the chart's changing maximum.
  const mix=(a,b,t)=>'rgb('+a.map((v,i)=>Math.round(v+(b[i]-v)*clamp(t,0,1))).join(',')+')';
  function loadColour(value,band){
    if(!num(value)||!band||!num(band.lo)||!num(band.hi)||band.hi<=0)return tone('neutral');
    const blue=[36,88,160],green=[24,115,75],red=[168,56,67];
    return value<band.lo?mix(blue,green,value/band.lo):value<=band.hi?mix(green,green,0):mix(green,red,(value-band.hi)/band.hi);
  }
  // V3.6 H4 (decided Sept 30): hours against the sleep need (Settings, 7 h by default) to a hue, interpolated, never an RGB
  // mix: red at 4 h or more under, orange, yellow, green at 1 h under, blue-green within 30 minutes of the need, blue, then
  // purple (extra) from 1 h over. Every sleep chart carries the one-line key (sleepKey).
  const SLEEP_HUE=[[-4,2],[-3,28],[-2,50],[-1,128],[-0.5,165],[0.5,165],[1,272]];
  function piecewise(stops,x){if(x<=stops[0][0])return stops[0][1];for(let i=1;i<stops.length;i++)if(x<=stops[i][0]){const a=stops[i-1],b=stops[i];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}return stops[stops.length-1][1];}
  function sleepColour(minutes,target){
    if(!num(minutes)||!num(target)||target<=0)return tone('neutral');
    return 'hsl('+Math.round(piecewise(SLEEP_HUE,(minutes-target)/60)*10)/10+' 68% 62%)';
  }
  function sleepKey(target){
    const sw=[-4,-3,-2,-1,0,0.75,1].map(h=>'<i style="background:'+sleepColour(target+h*60,target)+'"></i>').join('');
    return '<p class="sleep-key" data-parity="V36-H4-01" role="img" aria-label="Sleep colours: red at 4 hours or more under your need, orange, yellow, green at 1 hour under, blue-green at the need, blue, purple from 1 hour over"><span>−4 h</span>'+sw+'<span>goal</span><span>+1 h</span></p>';
  }

  function loadGauge(load){
    const b=load&&load.band;if(!b)return '<div class="load-gauge empty" role="img" aria-label="Target band not yet available"></div>';
    const W=560,L=24,R=536,max=Math.max(b.hi*2,load.value*1.08,1),x=v=>L+clamp(v/max,0,1)*(R-L),mid=(b.lo+b.hi)/2;
    const stops=Array.from({length:64},(_,i)=>{const v=max*i/64;return '<rect x="'+f(x(v))+'" y="36" width="'+f((R-L)/64+.1)+'" height="18" fill="'+loadColour(v,b)+'"/>';}).join('');
    const marker=num(load.value)?'<path d="M'+f(x(load.value))+' 26l-6 -9h12Z" fill="var(--ink)"/><line x1="'+f(x(load.value))+'" x2="'+f(x(load.value))+'" y1="29" y2="60" stroke="var(--ink)" stroke-width="2"'+(load.inputs?.closed!==true?' stroke-dasharray="3 2"':'')+'/>':'';
    return '<svg class="load-gauge" viewBox="0 0 '+W+' 104" role="img" aria-label="'+esc('Load '+(num(load.value)?load.value:'unknown')+'; target '+Math.round(b.lo)+' to '+Math.round(b.hi)+'; '+(load.label||''))+'">'+stops+'<rect x="'+f(x(b.lo))+'" y="33" width="'+f(x(b.hi)-x(b.lo))+'" height="24" rx="3" fill="none" stroke="var(--ink)" stroke-width="1.5"/>'+marker+'<text x="'+f(x(mid))+'" y="83" text-anchor="middle" fill="var(--ink)" font-size="13">Target '+Math.round(b.lo)+'–'+Math.round(b.hi)+'</text><text x="24" y="83" fill="var(--muted)" font-size="12">0 · Low</text><text x="536" y="83" text-anchor="end" fill="var(--muted)" font-size="12">'+Math.round(max)+' · High</text></svg>';
  }
  function sleepWeek(days,target){
    const W=400,H=244,L=32,R=392,T=28,B=164,max=Math.max(target,...days.flatMap(d=>[d.asleep,d.inBed]).filter(num),60),top=Math.ceil(max/120)*120,step=(R-L)/Math.max(1,days.length),y=v=>B-v/top*(B-T),hours=v=>String(Math.round(v/60*10)/10)+' h';
    let out='<svg class="sleep-week-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Asleep and in-bed duration by night, hours; target '+hours(target)+'"><text x="2" y="10" fill="var(--muted)" font-size="11">Hours</text>';
    for(const v of [0,top/2,top])out+='<line x1="'+L+'" x2="'+R+'" y1="'+f(y(v))+'" y2="'+f(y(v))+'" stroke="var(--line)"/><text x="24" y="'+f(y(v)+4)+'" text-anchor="end" fill="var(--muted)" font-size="12">'+Math.round(v/60)+'</text>';
    out+='<line x1="'+L+'" x2="'+R+'" y1="'+f(y(target))+'" y2="'+f(y(target))+'" stroke="#9cc4f0" stroke-dasharray="5 4"/><text x="'+R+'" y="'+f(y(target)-5)+'" text-anchor="end" fill="var(--ink)" font-size="12">Target '+hours(target)+'</text>';
    days.forEach((d,i)=>{
      const x=L+step*(i+.5),wide=Math.min(32,step*.7),narrow=wide*.58,asleep=num(d.asleep),bed=num(d.inBed),title=d.date+': '+(asleep?hours(d.asleep)+' asleep':'No record')+'; '+(bed?hours(d.inBed)+' in bed':'in-bed duration unknown');
      out+='<g data-date="'+esc(d.date)+'"><title>'+esc(title)+'</title>';
      if(bed)out+='<rect data-kind="in-bed" x="'+f(x-wide/2)+'" y="'+f(y(d.inBed))+'" width="'+f(wide)+'" height="'+f(B-y(d.inBed))+'" rx="3" fill="none" stroke="#adc6e6" stroke-width="1.6"/>';
      if(asleep)out+='<rect data-kind="asleep" x="'+f(x-narrow/2)+'" y="'+f(y(d.asleep))+'" width="'+f(narrow)+'" height="'+f(B-y(d.asleep))+'" rx="2" fill="'+sleepColour(d.asleep,target)+'" stroke="#dbcfad" stroke-width=".7"/>';
      out+='<text x="'+f(x)+'" y="184" text-anchor="middle" fill="var(--ink)" font-size="13">'+esc(d.label)+'</text><text x="'+f(x)+'" y="201" text-anchor="middle" fill="var(--ink)" font-size="13">'+(asleep?hours(d.asleep):'—')+'</text><text x="'+f(x)+'" y="217" text-anchor="middle" fill="var(--muted)" font-size="12">'+(bed?hours(d.inBed):'—')+'</text></g>';
    });
    return out+'<text x="32" y="240" fill="var(--ink)" font-size="12">■ Asleep · □ In bed · — Unknown</text></svg>';
  }

  /* ---------- the ring: spiky and segmented, the app's own style ---------- */
  const SEGMENTS=40;
  /* share 0–1 fills the segments; `inner` draws a second, thin arc (Fuel's water); `target` {from,to} marks a
     band on the rim (Load's brass arc); without a value every segment stays faint and the centre reads "—". */
  function ring(o){
    const cx=60,cy=60,R=46,r=37,has=num(o.share),filled=has?Math.round(clamp(o.share,0,1)*SEGMENTS):0,colour=tone(o.colour);
    const at=(a,rr)=>f(cx+Math.cos(a)*rr)+' '+f(cy+Math.sin(a)*rr),angle=s=>s*Math.PI*2-Math.PI/2;
    let body='';
    for(let i=0;i<SEGMENTS;i++){
      const a0=angle(i/SEGMENTS)+.02,a1=angle((i+1)/SEGMENTS)-.02,on=i<filled,spike=on&&i%5===4?R+4:R;
      body+='<path d="M'+at(a0,r)+'L'+at(a0,R)+'L'+at((a0+a1)/2,spike)+'L'+at(a1,R)+'L'+at(a1,r)+'Z" fill="'+(on?colour:'var(--ring-off,rgba(255,255,255,.08))')+'"/>';
    }
    const arc=(from,to,rr,stroke,width)=>{const a=angle(clamp(from,0,1)),b=angle(clamp(to,0,.9999)),large=b-a>Math.PI?1:0;return '<path d="M'+at(a,rr)+'A'+rr+' '+rr+' 0 '+large+' 1 '+at(b,rr)+'" fill="none" stroke="'+stroke+'" stroke-width="'+width+'" stroke-linecap="round"/>';};
    if(o.target&&num(o.target.from)&&num(o.target.to)&&o.target.to>o.target.from)body+=arc(o.target.from,o.target.to,53,'var(--brass)',2.4);
    if(o.inner&&num(o.inner.share)){body+='<circle cx="60" cy="60" r="31" fill="none" stroke="var(--ring-off,rgba(255,255,255,.08))" stroke-width="3"/>';if(o.inner.share>0)body+=arc(0,o.inner.share,31,tone(o.inner.colour),3);}
    const centre=has||o.centre?String(o.centre===undefined?Math.round(o.share*100):o.centre):'—',size=centre.length>4?17:centre.length>3?21:26;
    const arrow=o.arrow&&o.arrow.arrow?' <span class="ring-arrow" style="color:'+tone(o.arrow.colour)+'" title="'+esc(o.arrow.title||'This week against the last four')+'">'+esc(o.arrow.arrow)+'</span>':'';
    return '<div class="score-ring'+(has?'':' empty')+'"'+(o.id?' data-score="'+esc(o.id)+'"':'')+'><svg viewBox="0 0 120 120" role="img" aria-label="'+esc(o.label||o.title+' '+centre)+'">'+body+
      '<text x="60" y="'+(size>22?68:66)+'" text-anchor="middle" font-size="'+size+'" class="ring-value">'+esc(centre)+'</text></svg><b>'+esc(o.title)+arrow+'</b>'+
      (o.word?'<em style="color:'+tone(o.wordColour||o.colour)+'">'+esc(o.word)+'</em>':'')+(o.chip?'<small class="ring-chip">'+esc(o.chip)+'</small>':'')+'</div>';
  }
  /* The key every coloured scale carries. steps: [[name,label],…] */
  function key(steps,lead){return '<p class="scale-key">'+(lead?'<span>'+esc(lead)+'</span>':'')+steps.map(([name,label])=>'<span><i style="background:'+tone(name)+'"></i>'+esc(label)+'</span>').join('')+'</p>';}
  const KEYS={
    goal:[['orange','Under 75%'],['yellow','75–99%'],['green','On target']],
    readiness:[['red','0–19'],['orange','20–39'],['yellow','40–69 Pace'],['green','70–89 Ready'],['violet','90–100']],
    quality:[['red','0–24'],['orange','25–49'],['yellow','50–74'],['green','75–89'],['violet','90–100']],
    rungs:[['red','Poor'],['orange','Below'],['yellow','Avg'],['green','Good · Trained'],['violet','Athlete · Elite']],
    vitals:[['red','Behind'],['orange',''],['yellow',''],['green','On target'],['violet','Excellent']],
    load:[['loadLow','Low'],['loadTarget','Target zone'],['loadHigh','High']]
  };

  /* ---------- a vital on the quality track (the approved Body look, Sept 26) ----------
     The track runs behind → on target → excellent in the ladder's own colours, one slot per rung. A ranked
     vital (HRV, resting heart rate, VO₂ max) sits where its rung puts it. A flag (breathing, blood oxygen,
     wrist temperature) has no rungs: it sits by how far it is from his own typical value, green within 60%
     of the way to the outlier line, yellow after that, orange from the line on; never red, and never
     better than green. The box is his typical range, the small dots recent nights, the knob last night. */
  const SLOT_TONES=['red','orange','yellow','green','green','violet','violet'];
  const PLACE={typical:4.5/7,yellow:3/7,outlier:2/7,floor:1/7+.03,ceiling:5/7-.03};
  /* side: 'high' when higher is the worry (breathing, resting heart rate), 'low' (blood oxygen), 'both' (temperature). */
  function flagPlace(value,typical,margin,side){
    if(!num(value)||!num(typical)||!(margin>0))return null;
    const d=side==='low'?typical-value:side==='both'?Math.abs(value-typical):value-typical,t=d/margin;
    const p=t<=0?PLACE.typical+Math.min(1,-t)*(PLACE.ceiling-PLACE.typical):t<=.6?PLACE.typical-(PLACE.typical-PLACE.yellow)*t/.6:PLACE.yellow-(PLACE.yellow-PLACE.outlier)*(t-.6)/.4;
    return clamp(p,PLACE.floor,PLACE.ceiling);
  }
  /* The colour of a place on a track; an edge belongs to the slot below it. */
  function placeTone(p,tones){const t=tones||SLOT_TONES;return t[clamp(Math.ceil(p*t.length-1e-9)-1,0,t.length-1)];}
  const track=tones=>'linear-gradient(90deg,'+tones.map((t,i)=>tone(t)+' '+f((i+.5)/tones.length*100)+'%').join(',')+')';
  function vital(o){
    const original=o.tones||SLOT_TONES,down=o.direction==='down',tones=down?original.slice().reverse():original,has=num(o.place),x=p=>f(clamp(down?1-p:p,0,1)*100),band=o.band&&num(o.band[0])&&num(o.band[1])?[Math.min(o.band[0],o.band[1]),Math.max(o.band[0],o.band[1])]:null;
    const name=has?o.tone||placeTone(o.place,original):null,colour=has?tone(name):'var(--faint)';
    const spoken=o.label+': '+(has?o.text+(o.word?', '+o.word:''):'no reading yet')+(band&&o.bandText?'; your typical range '+o.bandText:'');
    return '<div class="vital'+(has?'':' empty')+'"'+(o.id?' data-vital="'+esc(o.id)+'"':'')+(has?' data-tone="'+esc(name)+'"':'')+' data-direction="'+(down?'down':'up')+'"><div class="vital-name">'+(o.emoji?'<i class="vital-emo" aria-hidden="true">'+esc(o.emoji)+'</i>':'')+'<b>'+esc(o.label)+'</b>'+(o.info||'')+'<small>'+esc(o.sub||'')+'</small></div>'+
      '<div class="vital-track" role="img" aria-label="'+esc(spoken)+'" style="background:'+track(tones)+'">'+
      (band?'<i class="typical" style="left:'+Math.min(x(band[0]),x(band[1]))+'%;width:'+f(Math.max(3,(band[1]-band[0])*100))+'%"></i>':'')+
      (o.recent||[]).filter(num).map(p=>'<i class="dot" style="left:'+x(p)+'%"></i>').join('')+
      (num(o.goal)?'<i class="goal-tick" style="left:'+x(o.goal)+'%" title="'+esc(o.goalText||'Goal')+'"></i>':'')+(has?'<i class="knob" style="left:'+x(o.place)+'%;--glow:'+colour+'"></i>':'')+'</div>'+
      '<div class="vital-now">'+(o.status&&has?'<span class="vital-status" style="color:'+colour+'">'+esc(o.status)+'</span>':'')+'<b style="color:'+colour+'">'+esc(has?o.text:'—')+'</b>'+(o.note?'<small>'+esc(o.note)+'</small>':'')+'</div></div>';
  }
  /* A small coloured note beside a figure: "▼ 1.2 this month", "5 over the healthy range", "steady". */
  function chip(o){return '<span class="trend-chip" data-tone="'+esc(o.tone||'neutral')+'" style="color:'+tone(o.tone||'neutral')+'">'+(o.arrow?'<i aria-hidden="true">'+esc(o.arrow)+'</i> ':'')+esc(o.text)+'</span>';}

  /* ---------- Where I Stand: a ladder row, a range row ---------- */
  const RUNG_LABEL={poor:'Poor',below:'Below',avg:'Avg',good:'Good',trained:'Trained',athlete:'Athlete',elite:'Elite'},RUNG_TONE={poor:'red',below:'orange',avg:'yellow',good:'green',trained:'green',athlete:'violet',elite:'violet'};
  const RUNGS=['poor','below','avg','good','trained','athlete','elite'];
  /* Where the marker sits, as a share of the whole ladder: inside his rung, by how far the value has come
     from that rung's cut-off toward the next. The bottom and the top rung have no far edge, so the marker
     rests a fixed way in. */
  function ladderMark(e){
    const order=e.order,i=order.indexOf(e.rung),down=e.direction==='down',cut=r=>e.cuts[r];
    let within=.5;
    if(i>0&&i<order.length-1){const a=cut(order[i]),b=cut(order[i+1]);within=clamp((e.value-a)/(b-a||1),0,1);}
    else if(i===0&&order.length>1){const b=cut(order[1]),span=Math.abs(cut(order[Math.min(2,order.length-1)])-b)||1;within=clamp(1-(down?e.value-b:b-e.value)/(span*1.5),.06,.94);}
    else if(i>0){const a=cut(order[i]),span=Math.abs(a-cut(order[i-1]))||1;within=clamp((down?a-e.value:e.value-a)/(span*1.5),.06,.94);}
    return (i+within)/order.length;
  }
  /* A ranked value on the vitals track: where its rung puts it, in its rung's colour, on a track of its own rungs. */
  function rungPlace(e){return e&&e.rung?{place:ladderMark(e),tone:RUNG_TONE[e.rung],tones:e.order.map(r=>RUNG_TONE[r]),word:RUNG_LABEL[e.rung]}:null;}
  /* The short row of the Body summary: the measure and its rung (or range state) as an outlined chip. */
  function standLine(e,o){
    const opt=o||{},name=esc(opt.name||e.metric),graded=e&&(e.rung||e.state),word=!graded?'—':e.rung?RUNG_LABEL[e.rung]+(e.star?' ✦':''):e.state==='in'?'In range':e.state==='over'?'Above healthy range':'Under the range',colour=!graded?'neutral':e.rung?RUNG_TONE[e.rung]:e.colour;
    return '<div class="stand-line"'+(e&&e.metric?' data-metric="'+esc(e.metric)+'"':'')+(graded?' data-tone="'+esc(colour)+'"':'')+'><span>'+name+(!graded&&opt.note?' <small>'+esc(opt.note)+'</small>':'')+'</span><b class="rung-pill" style="color:'+tone(colour)+';border-color:'+tone(colour)+'">'+esc(word)+'</b></div>';
  }
  function ladder(e,o){
    const opt=o||{},name=esc(opt.name||e.name||e.metric),sub=opt.sub?'<small>'+esc(opt.sub)+'</small>':'';
    if(!e||!e.rung)return '<div class="stand-row empty"'+(e&&e.metric?' data-metric="'+esc(e.metric)+'"':'')+'><div class="stand-name"><b>'+name+'</b>'+sub+(opt.info||'')+'</div><div class="stand-ladder muted">'+RUNGS.map(r=>'<span>'+RUNG_LABEL[r]+'</span>').join('')+'</div><div class="stand-value"><b>—</b><small>'+esc(opt.note||(e&&e.note)||'No reading yet')+'</small></div></div>';
    /* V3.3 (1.2): the bar always runs low → high, left to right. When lower is better the rungs are drawn
       elite … poor so the numbers still rise to the right and the colours flip (purple left, red right);
       the marker moves right as the value rises. The floors come from the score table (e.cuts), never typed. */
    const down=e.direction==='down',shown=down?e.order.slice().reverse():e.order,mark=down?1-ladderMark(e):ladderMark(e),colour=tone(RUNG_TONE[e.rung]);
    const rungs=shown.map(r=>'<span class="'+(r===e.rung?'on':'')+'" style="--rung:'+tone(RUNG_TONE[r])+'">'+RUNG_LABEL[r]+(r==='elite'?' ✦':'')+'</span>').join('');
    const value=opt.text||(e.unit==='steps'?n0(e.value):String(Math.round(e.value*10)/10));
    return '<div class="stand-row" data-metric="'+esc(e.metric)+'" data-rung="'+esc(e.rung)+'" data-direction="'+(down?'down':'up')+'"><div class="stand-name"><b>'+name+'</b>'+sub+(opt.info||'')+'</div>'+
      '<div class="stand-ladder" role="img" aria-label="'+esc((opt.name||e.metric)+': '+RUNG_LABEL[e.rung]+', '+e.gapText)+'" style="grid-template-columns:repeat('+e.order.length+',1fr)">'+rungs+'<i class="mark" style="left:'+f(mark*100)+'%"></i></div>'+ladderAxis(e,shown)+
      '<div class="stand-value"><b>'+esc(value)+' <small>'+esc(e.unit==='steps'?'':e.unit)+'</small></b><span class="rung-chip" style="background:'+colour+'">'+RUNG_LABEL[e.rung]+(e.star?' ✦':'')+'</span>'+
      '<small>'+[e.appleLevel?'Apple: '+e.appleLevel:null,num(e.percentile)&&opt.percentile!==false?'ahead of about '+e.percentile+'%':null,opt.asOf||null].filter(Boolean).map(esc).join(' · ')+'</small>'+
      '<small class="gap" style="color:'+colour+'">'+esc(e.gapText)+(e.flag?' · at or under 12: worth a word with a doctor':'')+'</small></div></div>';
  }
  /* The x-axis under a ladder (V3.3, 1.2): the number where each rung begins, read from the score table's
     cuts and written at the boundary between two rung spans, low → high whatever the metric's direction. */
  function ladderAxis(e,shown){
    if(!e||!e.cuts||!Array.isArray(shown)||shown.length<2)return '';
    const n=shown.length,down=e.direction==='down',ticks=[];
    for(let i=1;i<n;i++){const r=down?shown[i-1]:shown[i],v=e.cuts[r];if(num(v))ticks.push('<em style="left:'+f(i/n*100)+'%">'+esc(axisText(v,Math.abs(v)<1000&&Math.round(v*10)/10!==Math.round(v)?1:0))+'</em>');}   // the table's floor, one decimal where it has one
    return '<div class="stand-axis" aria-hidden="true">'+ticks.join('')+(e.unit&&e.unit!=='steps'?'<small>'+esc(e.unit)+'</small>':'')+'</div>';
  }
  /* ---------- the goal bar (V3.3, 1.3): the one bar whose x-axis is DATE ----------
     o: {start:{value,date}, goal:{value,date}, now:{value,date}, checkpoints:[{date,name}], unit, digits,
         onPace (true green, false warm, null neutral), label}. The start value sits at the left with its date, the
         goal value at the right with its date; checkpoints are dated ticks; the marker is the latest reading,
         placed by its date and drawn with its value. No words on the face. Dates are 'YYYY-MM-DD'. */
  /* M/D, with /YY when the year differs from the bar's first date (9/21 → 1/7/27). */
  const shortDate=(d,ref)=>d&&/^\d{4}-\d{2}-\d{2}$/.test(d)?(+d.slice(5,7))+'/'+(+d.slice(8,10))+(ref&&d.slice(0,4)!==ref.slice(0,4)?'/'+d.slice(2,4):''):'';
  function goalBar(o){
    const opt=o||{},s=opt.start||{},g=opt.goal||{},nw=opt.now||{},dg=opt.digits===undefined?1:opt.digits,fmt=v=>num(v)?(Math.round(v*10**dg)/10**dg).toLocaleString('en-US'):'—';
    const ok=s.date&&g.date&&g.date>s.date&&num(s.value)&&num(g.value);
    if(!ok)return '<div class="goal-bar-date empty" role="img" aria-label="'+esc((opt.label||'Goal')+': not set')+'"><div class="gb-track"></div><div class="gb-ends"><span>'+esc(fmt(s.value))+'</span><span>'+esc(fmt(g.value))+'</span></div></div>';
    /* Fix N1 (Mintay, Oct 6): a value axis with headroom. The bar runs from the lowest of start, now and goal less a pad to the highest plus a pad,
       so a back-slip still sits inside it; the dot is where he is now, start and goal are marked and labelled where they fall. */
    if(opt.valueAxis&&num(s.value)&&num(g.value)){
      const pad=num(opt.pad)?opt.pad:10,nv=num(nw.value)?nw.value:null,vals=[s.value,g.value].concat(nv===null?[]:[nv]),lo=Math.min.apply(null,vals)-pad,hi=Math.max.apply(null,vals)+pad,vx=v=>clamp((v-lo)/(hi-lo),0,1),colour=opt.onPace===true?'green':opt.onPace===false?'orange':'neutral';
      const a=vx(s.value),b=vx(g.value),n=nv===null?a:vx(nv),from=Math.min(a,n),to=Math.max(a,n);
      const ticks=(opt.checkpoints||[]).filter(c=>c&&num(c.value)&&c.value>lo&&c.value<hi).map(c=>'<i class="gb-tick" style="left:'+f(vx(c.value)*100)+'%" title="'+esc((c.name?c.name+' · ':'')+(c.date?shortDate(c.date):''))+'"></i>').join('');
      const label=(x,v,d,cls)=>'<span class="gb-vl '+cls+'" style="left:'+f(x*100)+'%"><b>'+esc(fmt(v))+'</b>'+(d?'<small>'+esc(d)+'</small>':'')+'</span>';
      const spoken=(opt.label||'Goal')+': start '+fmt(s.value)+(opt.unit?' '+opt.unit:'')+(s.date?' on '+shortDate(s.date):'')+', goal '+fmt(g.value)+(opt.unit?' '+opt.unit:'')+(g.date?' by '+shortDate(g.date):'')+(nv===null?'':'; now '+fmt(nv)+(nw.date?' on '+shortDate(nw.date):''));
      return '<div class="goal-bar-date gb-value" role="img" aria-label="'+esc(spoken)+'" data-tone="'+colour+'">'+
        '<div class="gb-track"><i class="gb-fill" style="left:'+f(from*100)+'%;width:'+f((to-from)*100)+'%;background:'+tone(colour)+'"></i><i class="gb-mark start" style="left:'+f(a*100)+'%" title="Start"></i><i class="gb-mark goal" style="left:'+f(b*100)+'%" title="Goal"></i>'+ticks+(nv===null?'':'<b class="gb-now" style="left:'+f(n*100)+'%;--glow:'+tone(colour)+'">'+(opt.quietNow?'':'<span>'+esc(fmt(nv))+'</span>')+'</b>')+(num(opt.longTerm)&&opt.longTerm>lo&&opt.longTerm<hi?'<i class="gb-long" style="left:'+f(vx(opt.longTerm)*100)+'%" title="Long term '+esc(fmt(opt.longTerm))+'"></i>':'')+'</div>'+
        '<div class="gb-vends">'+label(a,s.value,s.date?shortDate(s.date):'','start')+label(b,g.value,g.date?shortDate(g.date,s.date||undefined):'','goal')+'</div></div>';
    }
    const span=between(s.date,g.date)||1,x=d=>clamp(between(s.date,d)/span,0,1),hasNow=num(nw.value)&&!!nw.date,xn=hasNow?x(nw.date):0;
    const colour=opt.onPace===true?'green':opt.onPace===false?'orange':'neutral';
    const ticks=(opt.checkpoints||[]).filter(c=>c&&c.date>s.date&&c.date<g.date).map(c=>'<i class="gb-tick" style="left:'+f(x(c.date)*100)+'%" title="'+esc((c.name?c.name+' · ':'')+shortDate(c.date))+'"><em>'+esc(shortDate(c.date))+'</em></i>').join('');
    const spoken=(opt.label||'Goal')+': '+fmt(s.value)+(opt.unit?' '+opt.unit:'')+' on '+shortDate(s.date)+' to '+fmt(g.value)+(opt.unit?' '+opt.unit:'')+' by '+shortDate(g.date,s.date)+(hasNow?'; latest '+fmt(nw.value)+' on '+shortDate(nw.date,s.date):'');
    return '<div class="goal-bar-date" role="img" aria-label="'+esc(spoken)+'" data-tone="'+colour+'">'+
      '<div class="gb-track"><i class="gb-fill" style="width:'+f(xn*100)+'%;background:'+tone(colour)+'"></i>'+ticks+(hasNow?'<b class="gb-now" style="left:'+f(xn*100)+'%;--glow:'+tone(colour)+'">'+(opt.quietNow?'':'<span>'+esc(fmt(nw.value))+'</span>')+'</b>':'')+(num(opt.longTerm)?'<i class="gb-long" title="Long term '+esc(fmt(opt.longTerm))+'"></i>':'')+'</div>'+
      '<div class="gb-ends"><span><b>'+esc(fmt(s.value))+'</b><small>'+esc(shortDate(s.date))+'</small></span><span><b>'+esc(fmt(g.value))+'</b><small>'+esc(shortDate(g.date,s.date))+'</small></span></div></div>';
  }
  /* A change arrow (V3.3, 1.4): the amount beside an arrow, green when the move is toward the goal, warm (orange)
     when away, neutral when nothing moved. o: {now, prev, better:'down'|'up', unit, digits, period}. */
  function delta(o){
    const opt=o||{};if(!num(opt.now)||!num(opt.prev))return '';
    const dg=opt.digits===undefined?1:opt.digits,d=Math.round((opt.now-opt.prev)*10**dg)/10**dg;
    if(d===0)return chip({tone:'neutral',arrow:'→',text:'no change'+(opt.period?' '+opt.period:'')});
    const up=d>0,toward=opt.better==='down'?!up:opt.better==='up'?up:null,name=toward===null?'neutral':toward?'green':'orange';
    return chip({tone:name,arrow:up?'↑':'↓',text:Math.abs(d).toLocaleString('en-US')+(opt.unit?' '+opt.unit:'')+(opt.period?' '+opt.period:'')});
  }
  function rangeRow(e,o){
    const opt=o||{},name=esc(opt.name||e.metric),sub=opt.sub?'<small>'+esc(opt.sub)+'</small>':'';
    if(!e||!e.state)return '<div class="stand-row empty"'+(e&&e.metric?' data-metric="'+esc(e.metric)+'"':'')+'><div class="stand-name"><b>'+name+'</b>'+sub+(opt.info||'')+'</div><div class="stand-range muted"></div><div class="stand-value"><b>—</b><small>'+esc(opt.note||'No reading yet')+'</small></div></div>';
    const [a,b]=e.in,span=(b-a)||1,lo=Math.min(opt.from!==undefined?opt.from:a-span*.9,e.value-span*.15),hi=Math.max(opt.to!==undefined?opt.to:b+span*1.3,e.value+span*.15),x=v=>f(clamp((v-lo)/(hi-lo)*100,0,100));
    const zone=(from,to,colour,label)=>'<i class="zone" style="left:'+x(from)+'%;width:'+f(Math.max(0,x(to)-x(from)))+'%;background:color-mix(in srgb,'+tone(colour)+' 62%,transparent)" title="'+esc(label)+'"></i>';
    const zones=zone(Math.max(a,lo),b,'green','In range')+(e.athlete&&opt.athlete!==false?zone(Math.max(e.athlete[0],lo),Math.min(e.athlete[1],b),'violet','Athlete zone'):'');
    const ticks=[a,b].filter(v=>v>lo&&v<hi).map(v=>'<em style="left:'+x(v)+'%">'+esc(opt.tick?opt.tick(v):v)+'</em>').join('');
    return '<div class="stand-row" data-metric="'+esc(e.metric)+'" data-state="'+esc(e.state)+'"><div class="stand-name"><b>'+name+'</b>'+sub+(opt.info||'')+'</div>'+
      '<div class="stand-range" role="img" aria-label="'+esc((opt.name||e.metric)+': '+e.text)+'">'+zones+'<i class="mark" style="left:'+x(e.value)+'%"></i>'+ticks+'</div>'+
      '<div class="stand-value"><b>'+esc(opt.text||String(Math.round(e.value*10)/10))+' <small>'+esc(opt.unit===undefined?e.unit:opt.unit)+'</small></b><small class="gap" style="color:'+tone(e.colour)+'">'+esc(e.text)+'</small>'+(opt.asOf?'<small>'+esc(opt.asOf)+'</small>':'')+'</div></div>';
  }

  /* ---------- small charts ---------- */
  /* A band chart: the day's value as a bar, the target band behind it (Load's 28 days). */
  function bandChart(days,o){
    const opt=o||{},W=560,H=150,L=8,B=20,values=days.flatMap(d=>[d.value,d.lo,d.hi]).filter(num),top=Math.max(10,...values)*1.12,n=days.length||1,w=(W-2*L)/n,y=v=>f(H-B-(v/top)*(H-B-8));
    let out='<svg class="band-chart" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(opt.label||'Daily values against their band')+'" preserveAspectRatio="none">';
    days.forEach((d,i)=>{if(num(d.lo)&&num(d.hi))out+='<rect x="'+f(L+i*w)+'" y="'+y(d.hi)+'" width="'+f(w+.5)+'" height="'+f(Math.max(1,y(d.lo)-y(d.hi)))+'" fill="color-mix(in srgb,var(--brass) 22%,transparent)"/>';});
    days.forEach((d,i)=>{if(!num(d.value)){out+='<rect x="'+f(L+i*w+w*.3)+'" y="'+f(H-B-2)+'" width="'+f(w*.4)+'" height="2" fill="var(--line-strong)"><title>'+esc(d.title||'No data')+'</title></rect>';return;}
      out+='<rect x="'+f(L+i*w+w*.2)+'" y="'+y(d.value)+'" width="'+f(w*.6)+'" height="'+f(Math.max(1.5,H-B-y(d.value)))+'" rx="2" fill="'+tone(d.colour)+'"'+(d.approx?' opacity=".55"':'')+'><title>'+esc(d.title||'')+'</title></rect>';});
    const marks=opt.ticks||[];marks.forEach(([i,label])=>{out+='<text x="'+f(L+i*w+w/2)+'" y="'+(H-5)+'" text-anchor="middle" class="axis">'+esc(label)+'</text>';});
    // The scale: half and the full height of what is drawn, written on the chart's own lines.
    if(opt.scale!==false)for(const v of [top/1.12/2,top/1.12]){out+='<line class="grid" x1="'+L+'" x2="'+(W-L)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="'+(L+2)+'" y="'+f(+y(v)-3)+'">'+esc(axisText(v)+(opt.unit?' '+opt.unit:''))+'</text>';}
    return out+'</svg>';
  }
  /* Round figures for an axis: three ticks across what is drawn. */
  const axisText=(v,digits)=>num(digits)?(+v).toFixed(digits):Math.abs(v)>=1000?n0(v):Math.abs(v)>=20?String(Math.round(v)):String(Math.round(v*10)/10);
  /* A line through points with gaps where a value is missing. With `axis` it carries a labelled scale: `axis.x`
     names the points (the first, the middle and the last are written), `axis.unit` the figures up the side.
     `reference` {value,label} is a dashed line to read the trend against (his own age under Health Age). */
  function spark(values,o){
    const opt=o||{},axis=opt.axis||null,ref=opt.reference&&num(opt.reference.value)?opt.reference:null,W=opt.width||260,H=opt.height||(axis?120:70),known=values.filter(num);if(!known.length)return '';
    let lo=Math.min(...known,...(ref?[ref.value]:[])),hi=Math.max(...known,...(ref?[ref.value]:[]));if(hi-lo<1e-9){lo-=1;hi+=1;}const pad=(hi-lo)*.15,d0=lo,d1=hi;lo-=pad;hi+=pad;
    const L=axis?38:6,R=axis?10:6,T=axis?14:6,B=axis?22:6;
    // V3.6 H2: with `xs` (a day number for each value) a point sits at its date inside `domain` (default: the first and last
    // xs), so readings that arrive in clusters look clustered; without it, values are evenly spaced (a daily series).
    const xs=Array.isArray(opt.xs)&&opt.xs.length===values.length?opt.xs:null,x0=xs?(opt.domain?opt.domain[0]:Math.min(...xs)):0,x1=xs?(opt.domain?opt.domain[1]:Math.max(...xs)):0;
    const x=i=>f(xs?L+(xs[i]-x0)/((x1-x0)||1)*(W-L-R):values.length===1?(L+W-R)/2:L+i*(W-L-R)/(values.length-1)),y=v=>f(H-B-(v-lo)/(hi-lo)*(H-B-T));
    let d='',pen=false;values.forEach((v,i)=>{if(!num(v)){pen=false;return;}d+=(pen?'L':'M')+x(i)+' '+y(v);pen=true;});
    const last=values.map((v,i)=>[v,i]).filter(p=>num(p[0])).pop();
    let frame='';
    if(axis){
      for(const v of [d0,(d0+d1)/2,d1])frame+='<line class="grid" x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="'+(L-5)+'" y="'+f(+y(v)+3.5)+'" text-anchor="end">'+esc(axisText(v,axis.digits))+'</text>';
      if(axis.unit)frame+='<text class="axis unit" x="'+(L-5)+'" y="9" text-anchor="end">'+esc(axis.unit)+'</text>';
      const names=axis.x||[],at=[...new Set([0,Math.floor((values.length-1)/2),values.length-1])];
      // V3.7 X5: a middle name that would run into an end name is left out (an estimate of the text width at the axis font)
      const wid=i=>String(names[i]==null?'':names[i]).length*6.2,span=(i,k)=>{const c=+x(i);return k===0?[c,c+wid(i)]:k===at.length-1?[c-wid(i),c]:[c-wid(i)/2,c+wid(i)/2];},hit=(a,b)=>a[0]<b[1]+3&&b[0]<a[1]+3;
      if(at.length===3&&(hit(span(at[1],1),span(at[0],0))||hit(span(at[1],1),span(at[2],2))))at.splice(1,1);
      at.forEach((i,k)=>{if(names[i]!==undefined&&names[i]!==null)frame+='<text class="axis" x="'+x(i)+'" y="'+(H-6)+'" text-anchor="'+(k===0?'start':k===at.length-1?'end':'middle')+'">'+esc(names[i])+'</text>';});
    }
    if(ref)frame+='<line class="ref" x1="'+L+'" x2="'+(W-R)+'" y1="'+y(ref.value)+'" y2="'+y(ref.value)+'" stroke="'+tone(ref.colour||'neutral')+'"/>'+(ref.label?'<text class="axis ref-label" x="'+(W-R)+'" y="'+f(+y(ref.value)-4)+'" text-anchor="end" fill="'+tone(ref.colour||'neutral')+'">'+esc(ref.label)+'</text>':'');
    return '<svg class="spark'+(axis?' with-axis':'')+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(opt.label||'Trend')+'">'+frame+'<path d="'+d+'" fill="none" stroke="'+tone(opt.colour||'brass')+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'+
      values.map((v,i)=>num(v)?'<circle'+(xs?' data-x="'+xs[i]+'"':'')+' cx="'+x(i)+'" cy="'+y(v)+'" r="'+(i===last[1]?3.4:opt.dots?2.2:1.8)+'" fill="'+tone(opt.colour||'brass')+'"/>':'').join('')+'</svg>';
  }
  /* V3.6 H1 (Mintay, Oct 3): THE one line chart. An x axis (the first, a middle and the last date; months for a span over 60
     days) and a y axis (the min, middle and max in the metric's unit): a few labels, never every number. Every point carries
     its date and value; the page's one delegated handler (health-tracker.html, `lcPick`) shows the popover (date, value,
     change from the previous reading, source) and moves an open metric drawer to that day ("On this day"). Pure: a string.
     o: {points:[{d,v}], domain:[from,to], w, h, unit, digits, colour, band:[lo,hi], hlines:[{v,cls,label}], plan:[{d,v}],
     metric, source, name, selected, small, fmt:'signed'} */
  const MON3=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dnum=s=>{const q=String(s).split('-').map(Number);return Date.UTC(q[0],q[1]-1,q[2])/864e5;},dstr=n=>new Date(Math.round(n)*864e5).toISOString().slice(0,10),dlab=s=>MON3[+s.slice(5,7)-1]+' '+(+s.slice(8));
  function lcNum(v,digits,signed){const t=Math.abs(v)>=1000?Math.round(Math.abs(v)).toLocaleString('en-US'):(digits?Math.abs(v).toFixed(digits):String(Math.round(Math.abs(v))));return (v<0?'−':signed&&v>0?'+':'')+t;}
  function lineChart(o){
    const W=o.w||268,H=o.h||132,small=!!o.small,pl=o.pl!=null?o.pl:small?28:34,pr=6,pt=8,pb=small?14:18,digits=o.digits||0,signed=o.fmt==='signed';
    const all=(o.points||[]).filter(p=>p&&num(p.v)&&/^\d{4}-\d{2}-\d{2}$/.test(p.d)).sort((a,b)=>a.d.localeCompare(b.d));
    const d0=o.domain?o.domain[0]:all.length?all[0].d:null,d1=o.domain?o.domain[1]:all.length?all[all.length-1].d:null;if(!d0||!d1)return '';
    const t0=dnum(d0),t1=Math.max(dnum(d1),t0+1),pts=all.filter(p=>dnum(p.d)>=t0&&dnum(p.d)<=t1),plan=(o.plan||[]).filter(p=>num(p.v));
    const ext=pts.map(p=>p.v).concat((o.bands||[]).flatMap(b=>[b&&b.lo,b&&b.hi]).filter(num),o.band||[],(o.hlines||[]).map(l=>l.v),plan.map(p=>p.v),(o.marks||[]).map(m=>m.v)).filter(num);if(!ext.length)return '';
    const lo0=Math.min(...ext),hi0=Math.max(...ext),span=(hi0-lo0)||Math.max(1,Math.abs(hi0)*.1),lo=lo0-span*.1,hi=hi0+span*.1;
    const x=t=>pl+(t-t0)/(t1-t0)*(W-pl-pr),y=v=>pt+(1-(v-lo)/(hi-lo))*(H-pt-pb);
    const pv=pts.map(p=>p.v),yMin=pv.length?Math.min(...pv):lo0,yMax=pv.length?Math.max(...pv):hi0,gap=Math.abs(y(yMin)-y(yMax));let ys=yMin===yMax||gap<12?[yMin]:gap<24?[yMin,yMax]:[yMin,(yMin+yMax)/2,yMax];   // V3.7: labels never collide (one when the readings are within 12 px)
    /* AT1 (his words, Oct 9: "there are no numbers (x and y) we just need enough to know roughly"): a full-size chart reads against 3 to 5 rounded
       ticks with faint guides (196, 198, 200, 202), not labels at the readings themselves; a small tile keeps its two end dates (X5). */
    let yDigits=digits;
    if(!small&&o.niceY!==false){
      const raw=((hi-lo)||1)/3,e0=Math.floor(Math.log10(raw)),dec=s=>{const x=String(+s.toFixed(6));return x.includes('.')?Math.min(2,x.split('.')[1].length):0;};
      const tickAt=s=>{const a=Math.ceil((lo-1e-9)/s)*s,list=[];for(let v=a;v<=hi+1e-9&&list.length<9;v+=s)list.push(+v.toFixed(6));return list;};
      // steps of 1, 2 or 5 times a power of ten, nearest the span's third first; 3 or 4 ticks, else 2 to 5
      const cands=[e0-1,e0,e0+1].flatMap(k=>[1,2,5].map(m=>m*Math.pow(10,k))).sort((a,b)=>Math.abs(Math.log(a/raw))-Math.abs(Math.log(b/raw))).map(s=>({s,list:tickAt(s)}));
      const best=cands.find(c=>c.list.length>=3&&c.list.length<=4)||cands.find(c=>c.list.length>=2&&c.list.length<=5);
      if(best){ys=best.list;yDigits=dec(best.s);}}
    const col=o.colour||'var(--verd,#79d6a9)';let g='';
    ys.forEach(v=>{g+='<line class="lc-grid" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+f(y(v))+'" y2="'+f(y(v))+'"/>';});
    if(o.band&&num(o.band[0])&&num(o.band[1])){const by=y(Math.min(hi,o.band[1])),bh=Math.max(2,y(Math.max(lo,o.band[0]))-by);g+='<rect class="lc-band" x="'+pl+'" y="'+f(by)+'" width="'+(W-pl-pr)+'" height="'+f(bh)+'" rx="6"/>';}
    // V3.7 B5: target bands (ideal green, close yellow, bad red) from a table the app holds; edges may be open (±Infinity); clipped to the chart
    (o.bands||[]).forEach(b=>{if(!b)return;const a=Math.max(lo,num(b.lo)?b.lo:-Infinity),z=Math.min(hi,num(b.hi)?b.hi:Infinity);if(!(z>a))return;const by=y(z),bh=Math.max(1,y(a)-by);g+='<rect class="lc-tband '+(b.kind||'ideal')+'" data-band="'+(b.kind||'ideal')+'" data-lo="'+(num(b.lo)?b.lo:'')+'" data-hi="'+(num(b.hi)?b.hi:'')+'" x="'+pl+'" y="'+f(by)+'" width="'+(W-pl-pr)+'" height="'+f(bh)+'"/>';});
    (o.hlines||[]).forEach(l=>{g+='<line class="lc-h '+(l.cls||'')+'" data-v="'+l.v+'" x1="'+pl+'" x2="'+(W-pr)+'" y1="'+f(y(l.v))+'" y2="'+f(y(l.v))+'"/>';});
    // V3.7 B5: the plan line's band (weight against the plan, A58): a ribbon of ±planBand around the plan line
    if(plan.length>1&&num(o.planBand)&&o.planBand>0)g+='<path class="lc-tband ideal" data-band="plan" data-width="'+o.planBand+'" d="'+plan.map((p,i)=>(i?'L':'M')+f(x(dnum(p.d)))+' '+f(y(p.v+o.planBand))).join('')+plan.slice().reverse().map(p=>'L'+f(x(dnum(p.d)))+' '+f(y(p.v-o.planBand))).join('')+'Z"/>';
    if(plan.length>1)g+='<path class="lc-plan"'+(o.planAttrs||'')+' d="'+plan.map((p,i)=>(i?'L':'M')+f(x(dnum(p.d)))+' '+f(y(p.v))).join('')+'"/>';
    if(pts.length>1)g+='<path class="lc-line" stroke="'+col+'" d="'+pts.map((p,i)=>(i?'L':'M')+f(x(dnum(p.d)))+' '+f(y(p.v))).join('')+'"/>';
    pts.forEach((p,i)=>{const last=i===pts.length-1;g+='<circle class="'+(last?'lc-last':'lc-pt')+'" data-d="'+p.d+'" data-v="'+p.v+'"'+(p.attrs||'')+' cx="'+f(x(dnum(p.d)))+'" cy="'+f(y(p.v))+'" r="'+(last?(small?3:4.5):(small?1.8:2.4))+'" fill="'+(last?'#ece6d6':col)+'"'+(last?' stroke="'+col+'" stroke-width="2"':'')+'>'+(p.title?'<title>'+esc(p.title)+'</title>':'')+'</circle>';});
    (o.marks||[]).forEach(m=>{if(num(m.v))g+='<circle class="lc-mark"'+(m.attrs||'')+' cx="'+f(x(dnum(m.d)))+'" cy="'+f(y(m.v))+'" r="'+(m.r||3.6)+'" fill="'+(m.colour||'#cfae63')+'"'+(m.stroke?' stroke="'+m.stroke+'" stroke-width="2"':'')+'>'+(m.title?'<title>'+esc(m.title)+'</title>':'')+'</circle>';});
    let labs='';const lab=(c,t,xx,yy,tf,a)=>'<span class="lc-ax '+c+'" '+(a||'')+' style="left:'+f(xx/W*100)+'%;top:'+f(yy/H*100)+'%;transform:'+tf+'">'+esc(t)+'</span>';
    // V3.7 X5: a small chart (a 140 x 50 tile) carries no y labels and only its two end dates; min and max live in its drawer
    if(!small)ys.forEach((v,i)=>{labs+=lab('y',lcNum(v,yDigits,signed),pl-4,y(v),'translate(-100%,-50%)','data-y="'+(ys.length===1?'one':i===0?'min':i===ys.length-1?'max':'mid')+'"');});
    const long=t1-t0>60,ticks=o.xTicks||(small?[t0,t1]:[t0,(t0+t1)/2,t1]).map((t,i)=>({d:dstr(t),label:long?MON3[new Date(Math.round(t)*864e5).getUTCMonth()]:small&&dstr(t1).slice(0,7)===dstr(t0).slice(0,7)?String(+dstr(t).slice(8)):dlab(dstr(t))}));   // V3.7 X5: a small chart inside one month shows day numbers (the month is in its drawer)
    ticks.forEach((tk,i)=>{labs+=lab('x',tk.label,x(dnum(tk.d)),H-pb+3,i===0?'none':i===ticks.length-1?'translate(-100%,0)':'translate(-50%,0)','data-x="'+(['first','mid','last'][Math.min(i,2)])+'" data-d="'+tk.d+'"');});
    (o.hlines||[]).forEach(l=>{if(l.label)labs+=lab('hl '+(l.cls||''),l.label,W-pr,y(l.v)-2,'translate(-100%,-100%)','data-hl="'+l.v+'"');});
    (o.pointLabels||[]).forEach(p=>{if(num(p.v))labs+=lab('pl',p.label,x(dnum(p.d))+(p.left?-6:6),y(p.v),p.left?'translate(-100%,-50%)':'translate(0,-50%)','data-pl="'+p.d+'"');});
    const name=o.name||o.metric||'Trend';
    return '<div class="lc'+(small?' small':'')+'" data-lc="'+esc(o.metric||'')+'" data-unit="'+esc(o.unit||'')+'" data-digits="'+digits+'" data-source="'+esc(o.source||'')+'" data-name="'+esc(name)+'" data-fmt="'+(signed?'signed':'')+'" data-n="'+pts.length+'"'+(o.parity?' data-parity="'+o.parity+'"':'')+'>'+
      '<svg class="lc-svg'+(o.svgClass?' '+o.svgClass:'')+'" viewBox="0 0 '+W+' '+H+'" tabindex="0" role="img" aria-label="'+esc(name+' over time, '+dlab(dstr(t0))+' to '+dlab(dstr(t1))+'. Tap a point for the day; arrow keys move between points, Enter opens one.')+'">'+g+'<line class="lc-guide" y1="'+pt+'" y2="'+(H-pb)+'" visibility="hidden"/><circle class="lc-sel" r="5.5" visibility="hidden"/></svg>'+labs+'</div>';
  }
  /* Two groups of one outcome side by side, each value a dot and the mean a bar (Faith × Readiness). */
  function twoGroups(a,b,o){
    const opt=o||{},W=300,H=110,all=a.values.concat(b.values).filter(num);if(!all.length)return '';
    let lo=Math.min(...all),hi=Math.max(...all);if(hi-lo<1){lo-=1;hi+=1;}const pad=(hi-lo)*.12;lo=Math.max(opt.min===undefined?-Infinity:opt.min,lo-pad);hi=Math.min(opt.max===undefined?Infinity:opt.max,hi+pad);
    const y=v=>f(H-24-(v-lo)/(hi-lo||1)*(H-42)),mean=l=>l.length?l.reduce((s,v)=>s+v,0)/l.length:null;
    const group=(g,cx)=>{const m=mean(g.values.filter(num));return g.values.filter(num).map((v,i)=>'<circle cx="'+f(cx-22+((i*37)%44))+'" cy="'+y(v)+'" r="3" fill="'+tone(g.colour)+'" opacity=".55"/>').join('')+(m===null?'':'<line x1="'+(cx-34)+'" x2="'+(cx+34)+'" y1="'+y(m)+'" y2="'+y(m)+'" stroke="'+tone(g.colour)+'" stroke-width="3" stroke-linecap="round"/><text x="'+(cx+40)+'" y="'+f(+y(m)+4)+'" class="axis strong">'+Math.round(m)+'</text>')+'<text x="'+cx+'" y="'+(H-6)+'" text-anchor="middle" class="axis">'+esc(/\(\d+\)$/.test(g.label)?g.label:g.label+' · '+g.values.filter(num).length)+'</text>';};
    const scale=[lo,hi].map(v=>'<line class="grid" x1="26" x2="'+(W-4)+'" y1="'+y(v)+'" y2="'+y(v)+'"/><text class="axis" x="22" y="'+f(+y(v)+3.5)+'" text-anchor="end">'+esc(axisText(v))+'</text>').join('')+(opt.unit?'<text class="axis unit" x="4" y="9">'+esc(opt.unit)+'</text>':'');
    return '<svg class="two-groups" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(opt.label||a.label+' against '+b.label)+'">'+scale+group(a,95)+group(b,215)+'</svg>';
  }

  /* =======================================================================================
     Perfect tiers (decided Sept 26). Two tracks, Perfect (everything due, all areas, Faith included) and
     Perfect Fitness (the fitness items due, plus the Cardio and Strength rings), each by Day, Week and
     Month. "Due when necessary": an item with a weekly or monthly quota never blocks a day unless that
     day is its last chance to still meet the quota; weeks judge weekly quotas and months monthly ones; a
     day with nothing due is neutral and breaks no streak. Recognition only in V3.1: no points follow.
     ======================================================================================= */
  const dayMs=d=>Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10)),addDays=(d,k)=>new Date(dayMs(d)+k*86400000).toISOString().slice(0,10),between=(a,b)=>Math.round((dayMs(b)-dayMs(a))/86400000);
  /* A quota is {from,to,target,count,left}: count = done within the window up to and including the day;
     left = the chances still open from that morning on, the day itself included (the days the item is
     scheduled and not excused: an appointment that can only fall on a Wednesday or a Friday has no chance
     on a weekend). Without `left` every calendar day to the window's end is taken as a chance. It is
     necessary on a day when what is still missing, counting from that morning, needs every chance left. */
  function necessary(quota,date,doneToday){
    return Perfect?Perfect.necessary(quota,date,doneToday):false;
  }
  /* day: {date, items:[{id,name,fitness,done,neutral,optional,quota}], rings:{cardio:{applicable,closed},strength:{…}}} */
  function day(d){
    return Perfect?Perfect.day(d):{date:d.date,perfect:null,fitness:null,due:0,done:0,open:[],fitnessDue:0,fitnessDone:0,fitnessOpen:[],unavailable:true};
  }
  /* A span of days (a week or a month) with the quotas it judges: each {name,fitness,target,count,neutral}.
     today closes nothing early: a span still running reports what it has so far and whether it can still
     be perfect. */
  function span(days,quotas,today,track){
    return Perfect?Perfect.span(days,quotas,today,track):{perfect:null,running:true,possible:false,days:0,perfectDays:0,missed:[],quotas:[],unavailable:true};
  }
  /* Streak over verdicts oldest first: true counts, false ends it, null (nothing due, or still running) is skipped. */
  function streak(verdicts){
    let current=0,best=0,run=0;
    for(const v of verdicts){if(v===null||v===undefined)continue;if(v){run++;best=Math.max(best,run);}else run=0;}
    for(let i=verdicts.length-1;i>=0;i--){const v=verdicts[i];if(v===null||v===undefined)continue;if(v)current++;else break;}
    return {current,best};
  }
  function monthDays(month){const out=[];for(let d=month+'-01';d.slice(0,7)===month;d=addDays(d,1))out.push(d);return out;}
  const mondayOf=d=>addDays(d,-((new Date(dayMs(d)).getUTCDay()+6)%7));

  /* The medal (V3.2, his pick of Sept 27): a cameo cut from the room's own stone in a brass frame, with a flame
     inside that grows with the tier: an ember for a day, a fuller flame with a halo for a week, full bloom
     and a beaded frame for a month. Perfect burns gold, Perfect Fitness malachite. Not yet earned, the stone
     is dull and the flame only an outline. `mark` (D, W, M, or ×3 once earned more than once) sits on the plaque. */
  const MEDAL_TIERS={day:{rx:29,ry:35,frame:2,flame:.6,halo:0,beads:0},week:{rx:32,ry:38,frame:3,flame:.82,halo:.55,beads:0},month:{rx:35,ry:41,frame:4,flame:1.04,halo:.9,beads:26}};
  function medal(o){
    const earned=!!o.earned,t=MEDAL_TIERS[o.tier]||MEDAL_TIERS.day,fit=o.track==='fitness',id='md-'+esc(o.id||o.track+'-'+o.tier);
    const fire=fit?['#f2fff8','#9be8c4','#79d6a9']:['#fffaf0','#ffe8a8','#e3b262'],brass=fit?'#b9c7a0':'#e3b262',frame=earned?brass:'var(--line-strong,rgba(255,255,255,.26))';
    const k=t.flame,flame='M0 '+f(-25*k)+'C'+f(-12*k)+' '+f(-7*k)+' '+f(-10*k)+' '+f(9*k)+' 0 '+f(18*k)+'C'+f(10*k)+' '+f(9*k)+' '+f(12*k)+' '+f(-7*k)+' 0 '+f(-25*k)+'Z';
    let beads='';for(let i=0;i<t.beads;i++){const a=i/t.beads*Math.PI*2;beads+='<circle cx="'+f(Math.cos(a)*(t.rx+6))+'" cy="'+f(Math.sin(a)*(t.ry+6))+'" r="1.3"/>';}
    const defs='<defs><radialGradient id="'+id+'-stone" cx=".35" cy=".3"><stop offset="0" stop-color="#4a5c4f"/><stop offset=".55" stop-color="#2c3a30"/><stop offset="1" stop-color="#15201a"/></radialGradient>'+
      '<radialGradient id="'+id+'-bloom" cx=".5" cy=".5"><stop offset="0" stop-color="'+fire[0]+'"/><stop offset=".5" stop-color="'+fire[1]+'" stop-opacity=".7"/><stop offset="1" stop-color="'+fire[2]+'" stop-opacity="0"/></radialGradient><clipPath id="'+id+'-cut"><ellipse rx="'+t.rx+'" ry="'+t.ry+'"/></clipPath></defs>';
    const stone='<ellipse class="medal-stone" rx="'+t.rx+'" ry="'+t.ry+'" fill="'+(earned?'url(#'+id+'-stone)':'var(--ring-off,rgba(255,255,255,.07))')+'" stroke="'+frame+'" stroke-width="'+t.frame+'"/>'+
      '<g clip-path="url(#'+id+'-cut)" fill="none" stroke="'+(earned?'#6f927a':'var(--line,rgba(255,255,255,.1))')+'" stroke-linecap="round" opacity="'+(earned?.6:.5)+'"><path d="M-26 -18Q-8 -25 -4 -4Q0 18 -18 32" stroke-width="1.2"/><path d="M26 -26Q10 -8 15 12Q18 26 6 38" stroke-width=".9"/></g>';
    const light=earned?(t.halo?'<ellipse class="medal-halo" rx="'+f(t.rx*.78)+'" ry="'+f(t.ry*.78)+'" fill="url(#'+id+'-bloom)" opacity="'+t.halo+'"/>':'')+'<path class="medal-flame" data-flame="'+esc(o.tier||'day')+'" d="'+flame+'" fill="'+(t.halo?fire[0]:fire[2])+'"/>'
      :'<path class="medal-flame unlit" d="'+flame+'" fill="none" stroke="var(--faint,rgba(255,255,255,.3))" stroke-width="1" stroke-dasharray="2 3"/>';
    const plaque='<rect class="medal-plaque" x="-15" y="'+f(t.ry-6)+'" width="30" height="14" rx="7" fill="'+(earned?brass:'var(--sunk,rgba(255,255,255,.06))')+'" stroke="'+frame+'" stroke-width=".8"/><text y="'+f(t.ry+4.5)+'" text-anchor="middle" font-size="10" class="medal-mark" fill="'+(earned?'#1a1206':'var(--faint)')+'">'+esc(o.mark||'✦')+'</text>';
    return '<div class="medal'+(earned?' earned':'')+'" data-track="'+esc(o.track)+'" data-tier="'+esc(o.tier)+'"><svg viewBox="-50 -50 100 108" role="img" aria-label="'+esc(o.title+(earned?': earned':': not yet'))+'">'+defs+
      (beads?'<g class="medal-beads" fill="'+frame+'">'+beads+'</g>':'')+stone+light+plaque+'</svg><b>'+esc(o.title)+'</b><small>'+esc(o.note||'')+'</small></div>';
  }
  /* A month at a glance: gold = a Perfect day, a green rim = Perfect Fitness, dim = nothing due, plain = open. */
  function calendar(month,verdicts,today){
    const days=monthDays(month),by=new Map((verdicts||[]).map(v=>[v.date,v])),lead=(new Date(dayMs(days[0])).getUTCDay()+6)%7;
    const cell=d=>{const v=by.get(d),future=d>today,cls=[future?'future':'',v&&v.perfect===true?'perfect':v&&v.perfect===false?'open':'rest',v&&v.fitness===true?'fit':'',d===today?'today':''].filter(Boolean).join(' ');
      const say=future?'ahead':!v||v.perfect===null?'nothing due':v.perfect?'Perfect day':v.done+' of '+v.due+' due done';
      return '<span class="'+cls+'" title="'+esc(d+': '+say+(v&&v.fitness===true?' · Perfect Fitness':''))+'">'+(+d.slice(8))+'</span>';};
    return '<div class="perfect-cal" role="img" aria-label="'+esc('Perfect days in '+month)+'">'+['M','T','W','T','F','S','S'].map(h=>'<em>'+h+'</em>').join('')+(lead?'<span class="pad" style="grid-column:span '+lead+'"></span>':'')+days.map(cell).join('')+'</div>';
  }

  return {lineChart,sleepKey,esc,tone,TONES,KEYS,SEGMENTS,SLOT_TONES,PLACE,ring,key,vital,flagPlace,placeTone,rungPlace,chip,standLine,ladder,ladderMark,ladderAxis,goalBar,delta,shortDate,rangeRow,bandChart,spark,twoGroups,loadColour,sleepColour,loadGauge,sleepWeek,necessary,day,span,streak,monthDays,mondayOf,addDays,medal,MEDAL_TIERS,calendar,RUNG_LABEL,RUNG_TONE};
});
