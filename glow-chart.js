/* Glow live mockup: the BV chart module (thin strokes, AT1 axes, crosshair on hover and tap, arrow keys), copied unchanged from the BW hub (glow-next-level.html), which took it from BV. */
const GlowChart=(()=>{
  const NS='http://www.w3.org/2000/svg';
  const el=(t,a,p)=>{const e=document.createElementNS(NS,t);for(const k in a||{})e.setAttribute(k,a[k]);if(p)p.appendChild(e);return e;};
  const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDate=s=>{const d=new Date(s+'T12:00:00');return MON[d.getMonth()]+' '+d.getDate();};
  const fmtDay=s=>{const d=new Date(s+'T12:00:00');return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]+', '+fmtDate(s);};
  function niceTicks(lo,hi,n){const span=hi-lo||1,p=Math.pow(10,Math.floor(Math.log10(span))),steps=[10,5,2,1,.5,.2,.1].map(x=>x*p);
    for(const c of steps){const t=[];for(let v=Math.ceil(lo/c)*c;v<=hi+1e-9;v+=c)t.push(+v.toFixed(6));if(t.length>=(n||3))return {ticks:t,lo,hi};}return {ticks:[lo,hi],lo,hi};}
  function cursor(){const L=[];return {i:null,on(f){L.push(f);},set(i,src){this.i=i;L.forEach(f=>f(i,src));}};}
  /* spec: {days, from, to, series:[{get,color,colorOf(v,i),width,dash,dots,dotR,ring,label,opacity}], bands:[{lo,hi,fill}], hline:{y,color,width},
            marks:[{i,color,label}], yFmt, height, ticks, pad, cursor, today(i), rightFmt, interactive(true), styleCurrent(false)} */
  function make(root,spec){
    root.classList.add('gc');root.innerHTML='';root.style.position='relative';root.style.touchAction='pan-y';
    const svg=el('svg',{class:'gc-svg',style:'display:block;width:100%;height:'+(spec.height||220)+'px;overflow:visible'},root);
    const inter=spec.interactive!==false;if(inter){root.tabIndex=0;root.setAttribute('role','img');root.style.outline='none';root.style.cursor='crosshair';}
    const cur=spec.cursor||cursor();let state={},sel=null;
    function draw(){
      const W=root.clientWidth||600,H=spec.height||220,ml=spec.padLeft||40,mr=spec.padRight||(spec.rightFmt?66:14),mt=10,mb=22,iw=W-ml-mr,ih=H-mt-mb;
      svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.innerHTML='';
      const D=spec.days,a=Math.max(0,spec.from|0),b=Math.min(D.length-1,spec.to),n=b-a;const xs=i=>ml+(n?(i-a)/n*iw:iw/2);
      let lo=Infinity,hi=-Infinity;const see=v=>{if(v!=null&&isFinite(v)){lo=Math.min(lo,v);hi=Math.max(hi,v);}};
      for(let i=a;i<=b;i++){spec.series.forEach(s=>see(s.get(D[i],i)));(spec.bands||[]).forEach(bd=>{see(bd.lo(D[i],i));see(bd.hi(D[i],i));});}
      if(spec.hline)see(spec.hline.y);if(!isFinite(lo)){lo=0;hi=1;}
      let nt;if(spec.yFixed){lo=spec.yFixed[0];hi=spec.yFixed[1];nt=niceTicks(lo,hi,spec.ticks||3);}else{const padv=(hi-lo||1)*(spec.pad==null?.08:spec.pad);nt=niceTicks(lo-padv,hi+padv,spec.ticks||3);lo=nt.lo;hi=nt.hi;}
      const inY=v=>v!=null&&(!spec.yFixed||(v>=lo&&v<=hi));
      const ys=v=>mt+ih-(v-lo)/(hi-lo||1)*ih;const g=el('g',{},svg);const fs=spec.fontSize||11;
      // AT1 axes: faint guides at rounded ticks, labels left (and right when asked), first, middle and last dates
      nt.ticks.forEach(t=>{el('line',{x1:ml,x2:ml+iw,y1:ys(t),y2:ys(t),stroke:'var(--line)','stroke-width':spec.gridW||.6},g);
        const tx=el('text',{x:ml-6,y:ys(t)+3.5,'text-anchor':'end','font-size':fs,fill:'var(--faint)'},g);tx.textContent=(spec.yFmt||(v=>v))(t);
        if(spec.rightFmt){const r=el('text',{x:ml+iw+6,y:ys(t)+3.5,'font-size':fs,fill:'var(--faint)'},g);r.textContent=spec.rightFmt(t);}});
      const xt=[a,Math.round((a+b)/2),b].filter((v,i,arr)=>arr.indexOf(v)===i);
      xt.forEach((i,k)=>{const t=el('text',{x:xs(i),y:H-6,'font-size':fs,fill:'var(--faint)','text-anchor':k===0?'start':k===xt.length-1?'end':'middle'},g);t.textContent=fmtDate(D[i].date);});
      (spec.bands||[]).forEach(bd=>{let up='',dn='';for(let i=a;i<=b;i++){const l=bd.lo(D[i],i),h=bd.hi(D[i],i);if(l==null||h==null)continue;up+=(up?'L':'M')+xs(i).toFixed(1)+' '+ys(h).toFixed(1)+' ';dn=('L'+xs(i).toFixed(1)+' '+ys(l).toFixed(1)+' ')+dn;}
        if(up)el('path',{d:up+dn.replace(/^L/,'L')+'Z',fill:bd.fill||'var(--brass-soft)',stroke:'none'},g);});
      if(spec.hline)el('line',{x1:ml,x2:ml+iw,y1:ys(spec.hline.y),y2:ys(spec.hline.y),stroke:spec.hline.color||'var(--line-strong)','stroke-width':spec.hline.width||.75},g);
      if(spec.today!=null&&spec.today>=a&&spec.today<=b){const x=xs(spec.today);el('line',{x1:x,x2:x,y1:mt,y2:mt+ih,stroke:'var(--line-strong)','stroke-width':.75,'stroke-dasharray':'1 3'},g);
        if(spec.todayLabel!==false){const t=el('text',{x:x+4,y:mt+ih-4,'font-size':10,fill:'var(--faint)'},g);t.textContent='today';}}
      spec.series.forEach(s=>{if(s.dots){for(let i=a;i<=b;i++){const v=s.get(D[i],i);if(v==null)continue;const r=s.dotR||3.2,c=s.colorOf?s.colorOf(v,i):s.color;
          el('circle',{cx:xs(i),cy:ys(v),r,fill:s.ring&&s.ring(D[i])?'var(--bg)':c,stroke:c,'stroke-width':1.25},g);}return;}
        if(s.colorOf){let prev=null;for(let i=a;i<=b;i++){const v=s.get(D[i],i);if(!inY(v)){prev=null;continue;}if(prev)el('path',{d:'M'+xs(prev.i).toFixed(1)+' '+ys(prev.v).toFixed(1)+' L'+xs(i).toFixed(1)+' '+ys(v).toFixed(1),fill:'none',stroke:s.colorOf((v+prev.v)/2,i),'stroke-width':s.width||1.5,'stroke-dasharray':s.dash||'none','stroke-linecap':'round',opacity:s.opacity||1},g);prev={i,v};}return;}   // a line whose colour changes along it
        let d='',pen=false;for(let i=a;i<=b;i++){const v=s.get(D[i],i);if(!inY(v)){pen=false;continue;}d+=(pen?'L':'M')+xs(i).toFixed(1)+' '+ys(v).toFixed(1)+' ';pen=true;if(s.breakAfter&&s.breakAfter(D[i],i))pen=false;}
        if(d)el('path',{d,fill:'none',stroke:s.color,'stroke-width':s.width||1.5,'stroke-dasharray':s.dash||'none','stroke-linejoin':'round','stroke-linecap':'round',opacity:s.opacity==null?1:s.opacity},g);});
      (spec.marks||[]).forEach(m=>{if(m.i<a||m.i>b)return;const v=m.y!=null?m.y:null;if(v==null)return;el('circle',{cx:xs(m.i),cy:ys(v),r:3.5,fill:'var(--bg)',stroke:m.color||'var(--brass)','stroke-width':1.25},g);
        if(m.label){const t=el('text',{x:xs(m.i)-7,y:ys(v)+3.5,'font-size':fs,fill:m.color||'var(--brass)','text-anchor':'end'},g);t.textContent=m.label;}});
      (spec.labels||[]).forEach(L=>{const v=L.y;if(v==null||L.i<a||L.i>b)return;const t=el('text',{x:xs(L.i)+(L.dx||6),y:ys(v)+(L.dy||-6),'font-size':fs,fill:L.color||'var(--muted)','text-anchor':L.anchor||'start'},g);t.textContent=L.text;});
      state={xs,ys,a,b,ml,iw,mt,ih,W,H};
      if(inter){const ov=el('g',{class:'gc-ov','pointer-events':'none'},svg);state.ov=ov;if(sel!=null)showSel(sel);}
    }
    function showSel(i){if(!state.ov)return;state.ov.innerHTML='';if(i<state.a||i>state.b)return;const x=state.xs(i);
      el('line',{x1:x,x2:x,y1:state.mt,y2:state.mt+state.ih,stroke:'var(--ink)','stroke-width':.75,opacity:.55},state.ov);
      spec.series.forEach(s=>{const v=s.get(spec.days[i],i);if(v==null||(spec.yFixed&&(v<spec.yFixed[0]||v>spec.yFixed[1])))return;el('circle',{cx:x,cy:state.ys(v),r:(s.dotR||3.2)+1.2,fill:'var(--bg)',stroke:s.colorOf?s.colorOf(v,i):s.color,'stroke-width':1.5},state.ov);});}
    function pick(clientX){const r=svg.getBoundingClientRect();const x=(clientX/(window.glowZoomOf?window.glowZoomOf(svg):1)-r.left)*(state.W/(r.width||state.W));const n=state.b-state.a;let i=state.a+Math.round((x-state.ml)/(state.iw||1)*n);i=Math.max(state.a,Math.min(state.b,i));cur.set(i,root);}
    if(inter){root.addEventListener('pointermove',e=>{if(e.pointerType==='touch'&&!e.buttons)return;pick(e.clientX);});
      root.addEventListener('pointerdown',e=>{root.focus({preventScroll:true});pick(e.clientX);});
      root.addEventListener('keydown',e=>{const i=cur.i==null?state.b:cur.i;const m={ArrowLeft:i-1,ArrowRight:i+1,Home:state.a,End:state.b}[e.key];if(m==null)return;e.preventDefault();cur.set(Math.max(state.a,Math.min(state.b,m)),root);});
      cur.on(i=>{sel=i;showSel(i);});}
    const ro=new ResizeObserver(()=>draw());ro.observe(root);draw();
    return {draw,cursor:cur,setRange(a,b){spec.from=a;spec.to=b;draw();},spec};
  }
  return {make,cursor,fmtDate,fmtDay,niceTicks};
})();
window.GlowChart = GlowChart;
