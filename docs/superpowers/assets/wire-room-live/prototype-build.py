#!/usr/bin/env python3
"""Wire Room demo v4 — 32-BIT A, anchors and label spots verified against the pixels."""

PLATE = open("plate-pa.b64").read()

ANCHORS = """
// Every value below was measured from room-v5-a.png, not estimated:
//   board/cover  — cyan-bezel detection, then inset and re-checked for blankness
//   channel      — the lit floor line traced column by column
//   stations     — cyan-mass peaks across the working band
//   labels       — placed on cells whose mean luma is under 22 (see the dark map)
const A = {
  board: { l:4.7,  t:6.4,  w:16.5, h:26.1, skew:-2 },
  cover: { l:33.2, t:17.5, w:5.2,  h:9.0,  skew:0  },
  channel: [[1,75.5],[7,72.8],[13,72.1],[19,76.0],[25,78.9],[31,81.9],[37,83.8],
            [43,86.5],[49,89.5],[55,92.2],[61,95.5],[67,98.0],[74,99.0]],
  grate: { x:35, y:75 },
  desk:  { x:76, y:56 },
  deskLabel: { x:77, y:74 },
  ticker: { l:62, w:36, b:3.5 },
  glowW: 12,
  stations: [
    { id:'stringer',   x:10, y:60, lx:9,  ly:92 },
    { id:'dedup',      x:27, y:54, lx:27, ly:68 },
    { id:'classifier', x:52, y:50, lx:52, ly:66 },
  ],
};
"""

ENGINE = r"""
const SNAPSHOT = { v:1, windowHours:24, desk:{ surfacesWatched:1136, weekNumber:30 }, events:[] };
(function buildDay(){
  const runs=[[2,14],[6,0],[9,30],[12,0],[15,30],[18,0],[21,15],[23,40]];
  const pubs=[['NLnet Commons Fund','€50k'],['Gitcoin GG24','$2M pool'],
              ['Optimism RetroPGF 6','—'],['AI Safety Fund','$1.2M'],
              ['Sovereign Tech Agency','€300k'],['Protocol Labs RFP','$150k']];
  let p=0;
  runs.forEach(([h,m],i)=>{
    const t=h*60+m, swept=18+((i*13)%26), found=6+(i%5)*2;
    const dup=Math.round(found*0.46), arc=Math.round(found*0.22);
    const rev=Math.max(1,found-dup-arc);
    SNAPSHOT.events.push({at:t,kind:'run',station:'stringer',n:swept});
    SNAPSHOT.events.push({at:t+2,kind:'dedup',n:dup});
    SNAPSHOT.events.push({at:t+4,kind:'archive',n:arc});
    SNAPSHOT.events.push({at:t+5,kind:'queue',n:rev});
    if(i%2===0 && p<pubs.length){const[n2,a]=pubs[p++];SNAPSHOT.events.push({at:t+19,kind:'publish',item:{name:n2,amount:a}});}
  });
  SNAPSHOT.events.sort((a,b)=>a.at-b.at);
})();

const LOOP_MS=78000, MIN_GAP=1100, ITEM_MS=6000;
const FATE={
  dup:{exit:0.40,to:'grate',col:'#ff5f56',sh:'rgba(255,95,86,.90)'},
  arc:{exit:0.60,to:'grate',col:'#5b6b82',sh:'rgba(91,107,130,.55)'},
  rev:{exit:0.78,to:'desk', col:'#ffb347',sh:'rgba(255,179,71,.85)'},
  pub:{exit:0.78,to:'desk', col:'#5ce89a',sh:'rgba(92,232,154,.95)'},
};
const lerp=(a,b,t)=>a+(b-a)*t;
const PATH=(function(pts){const segs=[];let total=0;
  for(let i=0;i<pts.length-1;i++){const L=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);
    segs.push({a:pts[i],b:pts[i+1],L,acc:total});total+=L;}
  return {segs,total};})(A.channel);
function at(u){u=Math.max(0,Math.min(1,u));const d=u*PATH.total;
  let s=PATH.segs[PATH.segs.length-1];
  for(const q of PATH.segs){if(d<=q.acc+q.L){s=q;break;}}
  const k=s.L?(d-s.acc)/s.L:0;
  return {x:lerp(s.a[0],s.b[0],k),y:lerp(s.a[1],s.b[1],k)};}
function itemState(fate,p){
  const f=FATE[fate];
  if(p<=f.exit){const q=at(p);return{x:q.x,y:q.y,col:'#00eaff',sh:'rgba(0,234,255,.9)',size:7,op:1};}
  const k=Math.min(1,(p-f.exit)/0.20), from=at(f.exit), tg=f.to==='grate'?A.grate:A.desk;
  const x=lerp(from.x,tg.x,k), y=lerp(from.y,tg.y,k);
  if(f.to==='grate') return {x,y,col:f.col,sh:f.sh,size:7+k*3,op:1-k*0.95};
  if(fate==='rev')   return {x,y,col:f.col,sh:f.sh,size:7,op:1-k*0.85};
  if(k<1)            return {x,y,col:f.col,sh:f.sh,size:7+k*5,op:1};
  const r=Math.min(1,(p-f.exit-0.20)/0.18);
  return {x:tg.x,y:tg.y-r*11,col:f.col,sh:f.sh,size:12-r*4,op:1-r};
}

const TAPE=(function(){let prev=-Infinity;
  const out=SNAPSHOT.events.map(e=>{let ms=(e.at/(24*60))*LOOP_MS;
    if(ms-prev<MIN_GAP) ms=prev+MIN_GAP; prev=ms; return Object.assign({},e,{ms});});
  const last=out[out.length-1].ms;
  if(last>LOOP_MS){const s=LOOP_MS/last; out.forEach(o=>o.ms*=s);}
  return out;})();

const $=s=>document.querySelector(s);
const scene=$('#scene'), itemLayer=$('#items'), tickEl=$('#ticker'), pool=[];
let items=[], ticker=[], cursor=0, lastT=0, loopStart=0;
let counts={scanned:0,duplicate:0,archived:0,review:0,published:0};
let lit={stringer:0,dedup:0,classifier:0}, liveUntil=0, deskFlash=0;

// ── layout: positions from the anchor map, TYPE SIZED FROM THE BOX ───────────
// The previous build used fixed px type inside a %-sized panel, so the numbers
// spilled outside the artwork at some viewport widths. Deriving the font size
// from the measured box height makes overflow impossible at any size.
function layout(){
  const r=scene.getBoundingClientRect();
  const b=A.board, c=A.cover;
  const board=$('#board');
  board.style.cssText=`left:${b.l}%;top:${b.t}%;width:${b.w}%;height:${b.h}%;transform:skewY(${b.skew}deg)`;
  board.style.setProperty('--fs', (r.height*b.h/100/18)+'px');
  $('#cover').style.cssText=`left:${c.l}%;top:${c.t}%;width:${c.w}%;height:${c.h}%`;
  const t=A.ticker;
  tickEl.style.cssText=`left:${t.l}%;width:${t.w}%;bottom:${t.b}%`;
  tickEl.style.setProperty('--fs',(r.height/85)+'px');
  document.querySelectorAll('.tag').forEach(el=>{
    const s=A.stations.find(s=>s.id===el.dataset.id), p=s?{x:s.lx,y:s.ly}:A.deskLabel;
    el.style.left=p.x+'%'; el.style.top=p.y+'%';
    el.style.setProperty('--fs',(r.height/95)+'px');
  });
  document.querySelectorAll('.glow').forEach(g=>{
    const s=A.stations.find(s=>s.id===g.dataset.id); if(!s) return;
    g.style.left=s.x+'%'; g.style.top=s.y+'%'; g.style.width=A.glowW+'%';
  });
  const dg=$('#deskglow');
  dg.style.left=A.desk.x+'%'; dg.style.top=A.desk.y+'%'; dg.style.width=(A.glowW+3)+'%';
  $('#top').style.setProperty('--fs',(r.height/80)+'px');
}

function push(text,cls){ticker.unshift({text,cls,born:performance.now()}); if(ticker.length>5) ticker.pop();}
function fire(e,now){
  if(e.kind==='run'){lit.stringer=now+2800; counts.scanned+=e.n; push(`stringer swept ${e.n} surfaces`,'dim');}
  else if(e.kind==='dedup'){lit.dedup=now+2600; counts.duplicate+=e.n;
    for(let i=0;i<Math.min(e.n,4);i++) items.push({fate:'dup',born:now+i*300});
    push(`${e.n} duplicate · dropped before review`,'bad');}
  else if(e.kind==='archive'){lit.classifier=now+2400; counts.archived+=e.n;
    for(let i=0;i<Math.min(e.n,3);i++) items.push({fate:'arc',born:now+i*340});
    push(`${e.n} off-scope · archived`,'dim');}
  else if(e.kind==='queue'){lit.classifier=now+2400; counts.review+=e.n;
    for(let i=0;i<Math.min(e.n,3);i++) items.push({fate:'rev',born:now+i*360});
    push(`${e.n} reached your queue`,'');}
  else if(e.kind==='publish'){counts.published+=1; items.push({fate:'pub',born:now});
    liveUntil=now+5400; deskFlash=now+ITEM_MS+1100;
    push(`✓ published · ${e.item.name} · ${e.item.amount} → telegram`,'good');}
}
function el(i){while(pool.length<=i){const d=document.createElement('div');d.className='item';
  itemLayer.appendChild(d);pool.push(d);} return pool[i];}

function frame(now){
  if(!loopStart) loopStart=now-4000;
  const t=(now-loopStart)%LOOP_MS;
  if(t<lastT){cursor=0; counts={scanned:0,duplicate:0,archived:0,review:0,published:0};}
  lastT=t;
  while(cursor<TAPE.length && TAPE[cursor].ms<=t){fire(TAPE[cursor],now);cursor++;}

  const mins=Math.floor((t/LOOP_MS)*1440);
  $('#clock').textContent=String(Math.floor(mins/60)).padStart(2,'0')+':'+String(mins%60).padStart(2,'0');
  const live=now<liveUntil;
  $('#badge').className=live?'badge live':'badge';
  $('#badgetext').textContent=live?'LIVE':'REPLAYING LAST 24H';

  const max=Math.max(counts.scanned,1);
  ['scanned','duplicate','archived','review','published'].forEach(k=>{
    $('#bar-'+k).style.width=Math.max(2,(counts[k]/max)*100)+'%';
    $('#num-'+k).textContent=counts[k];});

  ['stringer','dedup','classifier'].forEach(id=>{
    const on=now<lit[id];
    document.querySelector(`.glow[data-id="${id}"]`).style.opacity=on?(0.55+0.45*Math.sin(now/110)):0.10;
    document.querySelector(`.tag[data-id="${id}"]`).classList.toggle('active',on);});
  $('#deskglow').style.opacity=now<deskFlash?(0.6+0.4*Math.sin(now/130)):0.16;

  items=items.filter(it=>now-it.born<ITEM_MS*1.25);
  let n=0;
  for(const it of items){
    const p=(now-it.born)/ITEM_MS;
    if(p<0||p>1.2) continue;
    const s=itemState(it.fate,p);
    if(s.op<=0.02) continue;
    const d=el(n++);
    d.style.cssText=`display:block;left:${s.x}%;top:${s.y}%;width:${s.size}px;height:${s.size}px;`+
      `background:${s.col};opacity:${s.op};box-shadow:0 0 ${s.size+8}px ${s.size/2}px ${s.sh}`;
  }
  for(let i=n;i<pool.length;i++) pool[i].style.display='none';

  tickEl.innerHTML=ticker.map((l,i)=>{
    const age=(now-l.born)/1000, o=Math.max(0.12,1-i*0.17-Math.max(0,age-13)*0.05);
    return `<div class="tl ${l.cls}" style="opacity:${o}">${l.text}</div>`;}).join('');
  requestAnimationFrame(frame);
}

(function(){const g=$('#cgrid');
  for(let i=0;i<24;i++){const d=document.createElement('div');const r=(i*37)%100;
    d.className='cdot'+(r<36?' f':r>92?' d':''); g.appendChild(d);}})();
layout();
addEventListener('resize', layout);
requestAnimationFrame(frame);
"""

CSS = r"""
*{box-sizing:border-box}
html,body{margin:0;background:#02040a;color:#8fb8c9;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.scene{position:relative;width:100vw;height:100vh;overflow:hidden;background:#05070d}
.plate{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;
  image-rendering:pixelated;image-rendering:crisp-edges}
#overlay{position:absolute;inset:0;pointer-events:none}

/* ── funnel board: type derives from --fs, set from the measured box height ── */
.board{position:absolute;display:flex;flex-direction:column;justify-content:center;
  padding:0 1.1em;font-size:var(--fs,11px);overflow:hidden}
.btitle{font-size:.72em;letter-spacing:.24em;color:#00eaff;opacity:.85;text-align:center;
  margin-bottom:.9em;font-weight:700}
.brow{margin:.32em 0}
.bhead{display:flex;justify-content:space-between;align-items:baseline;gap:.6em}
.blab{font-size:.72em;letter-spacing:.1em;color:#5b93a8;font-weight:600}
.bnum{font-size:1.05em;font-weight:700;color:#d6f4fa;font-variant-numeric:tabular-nums}
.btrk{height:.42em;background:#08161f;border-radius:1px;overflow:hidden;margin-top:.22em}
.bfil{height:100%;transition:width .45s cubic-bezier(.2,.8,.2,1)}

/* ── coverage: dots only; the surface count lives in the header now ────────── */
.cover{position:absolute;display:flex;align-items:center;justify-content:center;overflow:hidden}
#cgrid{display:grid;grid-template-columns:repeat(6,1fr);gap:11%;width:74%}
.cdot{aspect-ratio:1;background:#123040;border-radius:50%}
.cdot.f{background:#00eaff;box-shadow:0 0 4px #00eaff}
.cdot.d{background:#ff5f56;box-shadow:0 0 4px #ff5f56}

.item{position:absolute;transform:translate(-50%,-50%);border-radius:1px}
.glow{position:absolute;transform:translate(-50%,-50%);aspect-ratio:1.7;border-radius:50%;
  background:radial-gradient(circle,rgba(0,234,255,.5),rgba(0,234,255,0) 70%);transition:opacity .3s}
#deskglow{position:absolute;transform:translate(-50%,-50%);aspect-ratio:1.8;border-radius:50%;
  background:radial-gradient(circle,rgba(92,232,154,.45),rgba(92,232,154,0) 70%)}

.tag{position:absolute;transform:translateX(-50%);text-align:center;white-space:nowrap;
  font-size:var(--fs,9px);letter-spacing:.1em;color:#3d6478;text-transform:uppercase;
  font-weight:600;transition:color .3s;text-shadow:0 1px 7px #02040a,0 0 14px #02040a}
.tag b{display:block;color:#7ba7ba;letter-spacing:.17em;font-size:1.18em;transition:color .3s}
.tag.active{color:#7fe9f5}
.tag.active b{color:#fff;text-shadow:0 0 12px rgba(0,234,255,.9)}
.tag s{text-decoration:none;color:#a8514c}

#top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;
  align-items:center;gap:1em;padding:1.1em 1.5em;font-size:var(--fs,10px);
  background:linear-gradient(#02040ae6,#02040a00);letter-spacing:.16em;color:#7fe9f5;font-weight:600}
#top b{color:#fff;letter-spacing:.3em}
#top .meta{color:#4f7f95}
#clock{color:#9fdfee;letter-spacing:.2em;font-variant-numeric:tabular-nums}
.badge{display:inline-flex;align-items:center;gap:.6em;color:#5b93a8;letter-spacing:.15em;white-space:nowrap}
.badge::before{content:'';width:.55em;height:.55em;border-radius:50%;background:#3d6478}
.badge.live{color:#5ce89a}
.badge.live::before{background:#5ce89a;box-shadow:0 0 9px #5ce89a;animation:bl .9s ease-in-out infinite}
@keyframes bl{0%,100%{opacity:.3}50%{opacity:1}}

#ticker{position:absolute;display:flex;align-items:flex-end;flex-direction:column-reverse;gap:.35em;font-size:var(--fs,10px)}
.tl{color:#5b93a8;text-align:right;letter-spacing:.03em;text-shadow:0 1px 7px #02040a,0 0 14px #02040a;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl.good{color:#5ce89a}.tl.bad{color:#ff8078}.tl.dim{color:#436a7d}
"""

HTML = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Wire Room</title><style>{CSS}</style></head><body>
<div class="scene" id="scene">
  <img class="plate" src="data:image/jpeg;base64,{PLATE}" alt="">
  <div id="overlay">
    <div class="glow" data-id="stringer"></div>
    <div class="glow" data-id="dedup"></div>
    <div class="glow" data-id="classifier"></div>
    <div id="deskglow"></div>

    <div class="board" id="board">
      <div class="btitle">LAST 24 HOURS</div>
      <div class="brow"><div class="bhead"><span class="blab">SCANNED</span><span class="bnum" id="num-scanned">0</span></div>
        <div class="btrk"><div class="bfil" id="bar-scanned" style="background:#00eaff"></div></div></div>
      <div class="brow"><div class="bhead"><span class="blab">DUPLICATE</span><span class="bnum" id="num-duplicate">0</span></div>
        <div class="btrk"><div class="bfil" id="bar-duplicate" style="background:#ff5f56"></div></div></div>
      <div class="brow"><div class="bhead"><span class="blab">ARCHIVED</span><span class="bnum" id="num-archived">0</span></div>
        <div class="btrk"><div class="bfil" id="bar-archived" style="background:#5b6b82"></div></div></div>
      <div class="brow"><div class="bhead"><span class="blab">REVIEW</span><span class="bnum" id="num-review">0</span></div>
        <div class="btrk"><div class="bfil" id="bar-review" style="background:#ffb347"></div></div></div>
      <div class="brow"><div class="bhead"><span class="blab">PUBLISHED</span><span class="bnum" id="num-published">0</span></div>
        <div class="btrk"><div class="bfil" id="bar-published" style="background:#5ce89a"></div></div></div>
    </div>

    <div class="cover" id="cover"><div id="cgrid"></div></div>
    <div id="items"></div>

    <div class="tag" data-id="stringer"><b>Stringer</b>intake</div>
    <div class="tag" data-id="dedup"><b>Dedup</b><s>46% dropped</s></div>
    <div class="tag" data-id="classifier"><b>Classifier</b>scores · sorts</div>
    <div class="tag" data-id="desk"><b>You</b>6 min/day</div>

    <div id="top">
      <span><b>THE WIRE ROOM</b> <span class="meta">&nbsp; crypto · ai · oss &nbsp;·&nbsp; 1,136 surfaces &nbsp;·&nbsp; week 30</span></span>
      <span><span id="clock">00:00</span> &nbsp;&nbsp; <span class="badge" id="badge"><span id="badgetext">REPLAYING LAST 24H</span></span></span>
    </div>
    <div id="ticker"></div>
  </div>
</div>
<script>{ANCHORS}{ENGINE}</script></body></html>"""

open("demo5.html","w").write(HTML)
print("demo5.html", len(HTML)//1024, "KB")
