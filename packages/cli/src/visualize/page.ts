import { PACK } from "./pack.ts";

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>grove — knowledge</title>
<style>
:root{--bg:#080c12;--panel:#0f151d;--line:#1e2733;--dim:#7d8b9c;--text:#e6edf3}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}
#wrap{display:flex;height:100%}
#stage{flex:1;position:relative;background:
radial-gradient(1200px 800px at 50% 45%,#111a26 0%,#080c12 70%)}
canvas{display:block;width:100%;height:100%;cursor:grab}
canvas.drag{cursor:grabbing}
#side{width:340px;border-left:1px solid var(--line);background:var(--panel);
padding:14px;overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;gap:12px}
h1{font-size:13px;margin:0;letter-spacing:.04em}
.sub{color:var(--dim);font-size:11px;word-break:break-all;margin-top:2px}
.legend{display:flex;flex-wrap:wrap;gap:6px}
.tag{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dim);
border:1px solid var(--line);border-radius:99px;padding:2px 8px;cursor:pointer;
user-select:none}
.tag.off{opacity:.35}
.dot{width:8px;height:8px;border-radius:99px;flex-shrink:0}
.bar{width:14px;height:2px;flex-shrink:0}
.card{border-top:1px solid var(--line);padding-top:12px}
.card h2{font-size:11px;color:var(--dim);margin:0 0 6px;text-transform:uppercase;
letter-spacing:.08em}
#dtitle{font-weight:600;word-break:break-word}
#dbody{white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:28vh;
overflow-y:auto;margin-top:6px}
.meta{color:var(--dim);font-size:11px;margin-top:8px;white-space:pre-wrap;word-break:break-word}
.row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dim);cursor:pointer;
padding:1px 0}
.row:hover{color:var(--text)}
.row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hud{position:absolute;top:12px;left:14px;font-size:11px;color:var(--dim);
display:flex;align-items:center;gap:7px;max-width:calc(100% - 28px)}
#pulse{width:7px;height:7px;border-radius:99px;background:#3fb950;opacity:.3;
transition:opacity .25s;flex-shrink:0}
#pulse.on{opacity:1;box-shadow:0 0 10px #3fb950}
#crumb{position:absolute;top:34px;left:14px;font-size:11px;color:var(--dim);
max-width:calc(100% - 28px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#crumb span{cursor:pointer}
#crumb span:hover{color:var(--text)}
#ctrl{position:absolute;bottom:12px;left:14px;display:flex;gap:6px;align-items:center;
flex-wrap:wrap;max-width:calc(100% - 28px)}
button{background:#141c26;border:1px solid var(--line);color:var(--dim);
font:inherit;font-size:11px;padding:3px 9px;border-radius:5px;cursor:pointer}
button:hover{color:var(--text);border-color:#33404f}
button.on{color:#e6edf3;border-color:#3d5a7a;background:#16222f}
#tip{position:absolute;padding:4px 8px;background:#0f151dee;border:1px solid var(--line);
border-radius:5px;font-size:11px;pointer-events:none;opacity:0;transition:opacity .12s;
max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
input{width:100%;background:#0b1118;border:1px solid var(--line);color:var(--text);
font:inherit;font-size:12px;padding:5px 8px;border-radius:5px;outline:none}
input:focus{border-color:#3d5a7a}
#hits{display:flex;flex-direction:column;margin-top:4px}
.kbd{color:var(--dim);font-size:11px}
.hint{color:var(--dim);font-size:10px;margin-top:3px}
</style></head><body>
<div id="wrap"><div id="stage">
<canvas id="c"></canvas>
<div id="hud"><span id="pulse"></span><span id="hudtext">connecting</span></div>
<div id="crumb"></div>
<div id="ctrl">
<button id="bfit">fit</button>
<button id="bsym">symbols: auto</button>
<button id="bflat">files: auto</button>
<button id="biso">isolate</button>
<button id="bhop">1 hop</button>
<span class="kbd">drag pan · scroll zoom · click a folder to enter it · / search · f isolate · esc back</span>
</div>
<div id="tip"></div>
</div>
<div id="side">
<div><h1>grove — knowledge</h1><div class="sub" id="where">…</div></div>
<div><input id="q" placeholder="find a file, symbol, concept…" autocomplete="off"><div id="hits"></div></div>
<div><input id="ff" placeholder="filter: kind:symbol path:src/ tty:… branch:…" autocomplete="off">
<div class="hint" id="fhint"></div></div>
<div class="legend" id="legend"></div>
<div class="legend" id="elegend"></div>
<div class="meta" id="counts"></div>
<div class="card"><h2>selected</h2><div id="dtitle">Click a node.</div><div id="dbody"></div>
<div class="meta" id="dmeta"></div><div class="meta" id="dedges"></div></div>
<div class="card"><h2>connected</h2><div id="dlinks" class="meta">—</div></div>
</div></div>
<script>
${PACK}

const KINDS={file:{c:"#4f8cc9",label:"file"},symbol:{c:"#39c5cf",label:"symbol"},
concept:{c:"#e3b341",label:"concept"},fact:{c:"#3fb950",label:"fact"},stated:{c:"#a371f7",label:"stated"},
said:{c:"#db61a2",label:"said"},note:{c:"#d29922",label:"note"},terminal:{c:"#f78166",label:"terminal"}};
const EDGES={"co-change":{c:"125,155,190"},imports:{c:"95,140,200"},calls:{c:"120,190,220"},
references:{c:"57,197,207"},"links-to":{c:"227,179,65"},"co-edit":{c:"190,150,220"},
sibling:{c:"110,130,150"},anchor:{c:"63,185,80"},defines:{c:"57,197,207"},
wrote:{c:"247,129,102"},touched:{c:"247,129,102"}};
const GROUPC="#6f93bd",PAD=2.2,SPLIT=54,SYMPX=30,CAP=1200,MAXE=2600;
const cv=document.getElementById("c"),ctx=cv.getContext("2d"),tip=document.getElementById("tip");
const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.search);
const hilite=params.get("branch")||null;
const wantT=!params.get("kinds")||params.get("kinds").split(",").map(s=>s.trim()).includes("terminal");
let N=[],E=[],byId=new Map(),adj=new Map(),symsOf=new Map(),version="",tstamp="",sel=null,hot=null;
let G=null,ccCut=0;
let zoom=.7,panx=0,pany=0,W=0,H=0,dpr=1;
let drag=null,moved=false,symMode="auto",flatMode="auto";
const off=new Set(),eoff=new Set(["co-edit","sibling"]);
let hits=[],lastPts=new Map();
let files=[],tree=new Map(),local=new Map(),CIRC=new Map(),ORB=new Map();
let unit=new Map(),units=[],UE=[],vis=null,cutKey="";
let iso=null,hops=1,filt="",fly=null;

function size(){dpr=Math.min(devicePixelRatio||1,2);W=cv.clientWidth;H=cv.clientHeight;
cv.width=W*dpr;cv.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);dirty=true;}
addEventListener("resize",()=>{size();recompute(true);});

const kindOf=n=>n.group?"file":n.kind==="fact"&&n.stated?"stated":n.kind;
const colOf=n=>n.group?GROUPC:KINDS[kindOf(n)].c;
const shown=n=>!off.has(kindOf(n));
const fileOf=n=>{if(!n.path)return null;const b="f:"+n.path;
  return n.branch&&byId.has(b+"@"+n.branch)?b+"@"+n.branch:b;};
const onBranch=id=>!!hilite&&id.endsWith("@"+hilite);
let dirty=true;const mark=()=>{dirty=true;};
const sx=x=>W/2+panx+x*zoom,sy=y=>H/2+pany+y*zoom;
const dirOf=p=>{const i=p.lastIndexOf("/");return i<0?"":p.slice(0,i);};
const up=d=>{const i=d.lastIndexOf("/");return i<0?"":d.slice(0,i);};
const view=()=>({x0:(-W/2-panx)/zoom,x1:(W/2-panx)/zoom,y0:(-H/2-pany)/zoom,y1:(H/2-pany)/zoom});
const pos=id=>CIRC.get(id)||ORB.get(id)||null;

function buildTree(list){
  tree=new Map();
  const get=d=>{let t=tree.get(d);if(!t){t={dir:d,files:[],subs:new Set(),count:0};tree.set(d,t);}return t;};
  get("");
  for(const n of list){
    const d=dirOf(n.path);
    get("").count++;
    let acc="";
    if(d)for(const seg of d.split("/")){
      const parent=acc;acc=acc?acc+"/"+seg:seg;
      get(parent).subs.add(acc);if(acc!==d)get(acc).count++;}
    if(d)get(d).count++;
    get(d).files.push(n);}
}

const fileR=n=>3.2+Math.min(Math.sqrt(Math.max(n.weight,0))*1.1,7)
  +Math.min((symsOf.get(n.id)||[]).length*0.12,4);

function packDir(d){
  const t=tree.get(d);
  const kids=[];
  for(const s of [...t.subs].sort())kids.push({key:"g:"+s,r:packDir(s)});
  for(const f of t.files.slice().sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))
    kids.push({key:f.id,r:fileR(f)});
  kids.sort((a,b)=>b.r-a.r||(a.key<b.key?-1:1));
  const cs=kids.map(k=>({r:k.r+PAD,x:0,y:0}));
  const R=packSiblings(cs);
  local.set(d,kids.map((k,i)=>({key:k.key,x:cs[i].x,y:cs[i].y,r:k.r})));
  return R+PAD;
}

function buildLayout(){
  const all=N.filter(n=>n.kind==="file"&&n.path);
  buildTree(all);
  local=new Map();CIRC=new Map();
  const R=packDir("");
  CIRC.set("g:",{x:0,y:0,r:R});
  const drop=(d,cx,cy)=>{
    for(const k of local.get(d)||[]){
      const x=cx+k.x,y=cy+k.y;
      CIRC.set(k.key,{x,y,r:k.r});
      if(k.key.charCodeAt(0)===103)drop(k.key.slice(2),x,y);}};
  drop("",0,0);
}

function parseFilter(q){
  const terms=[],text=[];
  for(const raw of q.trim().split(/\\s+/)){
    if(!raw)continue;
    const i=raw.indexOf(":");
    const key=i>0?raw.slice(0,i).toLowerCase():"";
    if(i>0&&["kind","path","tty","branch","source"].includes(key))terms.push([key,raw.slice(i+1).toLowerCase()]);
    else text.push(raw.toLowerCase());}
  return {terms,text};
}
function passes(n,f){
  for(const [k,v] of f.terms){
    if(!v)continue;
    const got=k==="kind"?kindOf(n):k==="path"?(n.path||""):k==="branch"?(n.branch||""):(n.tty||n.source||"");
    if(!String(got).toLowerCase().includes(v))return false;}
  for(const t of f.text){
    const hay=(n.label+" "+n.title+" "+(n.path||"")).toLowerCase();
    if(!hay.includes(t))return false;}
  return true;
}

function isoSet(){
  if(!iso||!byId.has(iso))return null;
  const seen=new Set([iso]);let front=[iso];
  for(let h=0;h<hops;h++){
    const next=[];
    for(const id of front)for(const l of adj.get(id)||[])if(!seen.has(l.id)){seen.add(l.id);next.push(l.id);}
    front=next;}
  for(const id of [...seen]){const n=byId.get(id);
    if(n&&n.kind==="symbol"){const f=fileOf(n);if(f&&byId.has(f))seen.add(f);}}
  return seen;
}

function visibleSet(){
  const focus=isoSet();
  const f=parseFilter(filt);
  const active=filt.trim()!=="";
  if(!focus&&!active)return null;
  const out=new Set();
  for(const n of N){
    if(focus&&!focus.has(n.id))continue;
    if(active&&!passes(n,f))continue;
    out.add(n.id);}
  if(active)for(const id of [...out]){const n=byId.get(id);
    if(n&&n.kind==="symbol"){const fi=fileOf(n);if(fi&&byId.has(fi))out.add(fi);}}
  return out;
}

function liveCounts(){
  const m=new Map();
  for(const n of files){
    let d=dirOf(n.path);
    for(;;){m.set(d,(m.get(d)||0)+1);if(!d)break;d=up(d);}}
  return m;
}

function computeCut(live){
  const v=view(),keys=[],flat=flatMode==="off"||!!iso;
  const walk=key=>{
    if(key.charCodeAt(0)!==103){keys.push(key);return;}
    const dir=key.slice(2);
    if((live.get(dir)||0)===0)return;
    const c=CIRC.get(key);if(!c)return;
    const kids=local.get(dir);
    if(!kids||!kids.length){keys.push(key);return;}
    const gone=c.x+c.r<v.x0||c.x-c.r>v.x1||c.y+c.r<v.y0||c.y-c.r>v.y1;
    if(keys.length>CAP||(!flat&&(gone||c.r*zoom<SPLIT))){keys.push(key);return;}
    for(const k of kids){
      if(k.key.charCodeAt(0)===103)walk(k.key);
      else if(!vis||vis.has(k.key))keys.push(k.key);}};
  walk("g:");
  return keys;
}

function assignUnits(keys,live){
  const set=new Set(keys);
  unit=new Map();
  for(const n of files){
    if(set.has(n.id)){unit.set(n.id,n.id);continue;}
    let d=dirOf(n.path);
    for(;;){if(set.has("g:"+d)){unit.set(n.id,"g:"+d);break;}if(!d)break;d=up(d);}}
  units=[];
  for(const k of keys){
    if(k.charCodeAt(0)!==103){const n=byId.get(k);if(n)units.push(n);continue;}
    const dir=k.slice(2);
    units.push({id:k,group:true,dir,count:live.get(dir)||0,
      label:dir.split("/").pop()||"/",title:dir||"/",body:"",path:dir,weight:live.get(dir)||0,at:0});}
  const extra=[];
  for(const n of N){
    if(n.kind==="file"||n.kind==="symbol")continue;
    if(vis&&!vis.has(n.id))continue;
    extra.push(n);}
  placeKnowledge(extra);
  for(const n of extra)units.push(n);
}

function placeKnowledge(list){
  ORB=new Map();
  const by=new Map(),loose=[];
  for(const n of list){
    const u=n.path?unit.get("f:"+n.path)||null:null;
    if(u){const b=by.get(u);if(b)b.push(n);else by.set(u,[n]);}
    else loose.push(n);}
  for(const [u,ns] of by){
    const c=CIRC.get(u)||{x:0,y:0,r:6};
    ns.sort((a,b)=>a.id<b.id?-1:1);
    ns.forEach((n,i)=>{const a=(i+.5)/ns.length*6.283;
      ORB.set(n.id,{x:c.x+Math.cos(a)*(c.r+7),y:c.y+Math.sin(a)*(c.r+7)});});}
  loose.sort((a,b)=>a.id<b.id?-1:1);
  const R=(CIRC.get("g:")||{r:100}).r*1.1;
  loose.forEach((n,i)=>{const a=(i+.5)/Math.max(loose.length,1)*6.283;
    ORB.set(n.id,{x:Math.cos(a)*R,y:Math.sin(a)*R});});
}

function uOf(id){
  const n=byId.get(id);if(!n)return null;
  if(n.kind==="symbol"){const f=fileOf(n);return f?uOf(f):null;}
  if(n.kind==="file")return unit.get(id)||null;
  return vis&&!vis.has(id)?null:(ORB.has(id)?id:null);
}

function buildUnitEdges(){
  const m=new Map();
  for(const e of E){
    const a=uOf(e.src),b=uOf(e.dst);
    if(!a||!b||a===b)continue;
    const lo=a<b?a:b,hi=a<b?b:a,k=lo+"\\u0000"+hi+"\\u0000"+e.kind;
    const cur=m.get(k);
    if(cur)cur.weight+=e.weight;else m.set(k,{src:lo,dst:hi,kind:e.kind,weight:e.weight});}
  UE=[...m.values()].sort((a,b)=>b.weight-a.weight);
  const cc=UE.filter(e=>e.kind==="co-change").map(e=>e.weight).sort((a,b)=>a-b);
  ccCut=cc.length?cc[Math.floor(cc.length*.55)]:0;
}

function recompute(force){
  vis=visibleSet();
  files=N.filter(n=>n.kind==="file"&&n.path&&(!vis||vis.has(n.id)));
  const live=liveCounts();
  const keys=computeCut(live);
  const key=keys.join("\\u0000")+"|"+(vis?vis.size:-1)+"|"+flatMode;
  if(!force&&key===cutKey)return false;
  cutKey=key;
  assignUnits(keys,live);
  buildUnitEdges();
  return true;
}

function symbolsOf(u){
  if(symMode==="none"||off.has("symbol")||u.group)return null;
  const c=CIRC.get(u.id);if(!c)return null;
  if(symMode!=="all"&&c.r*zoom<SYMPX)return null;
  const list=symsOf.get(u.id)||[];
  const l=vis?list.filter(s=>vis.has(s.id)):list;
  return l.length?{c,l}:null;
}
function symAt(c,i,n){
  const t=(i+.5)/n,a=i*2.399963,r=c.r*(.28+.55*Math.sqrt(t));
  return {x:c.x+Math.cos(a)*r,y:c.y+Math.sin(a)*r};
}
function worldOf(n){
  if(n.kind!=="symbol")return pos(uOf(n.id)||n.id);
  const f=fileOf(n);if(!f)return null;
  const u=uOf(f);if(!u)return null;
  if(u!==f)return pos(u);
  const c=CIRC.get(f);if(!c)return null;
  const list=symsOf.get(f)||[],i=list.indexOf(n);
  return i<0?{x:c.x,y:c.y}:symAt(c,i,list.length);
}

function neighbourhood(id,unitId){
  if(!id)return null;
  const out=new Set([id]);
  if(unitId)out.add(unitId);
  if(byId.has(id))for(const l of adj.get(id)||[]){out.add(l.id);const u=uOf(l.id);if(u)out.add(u);}
  else for(const e of UE){if(e.src===id)out.add(e.dst);else if(e.dst===id)out.add(e.src);}
  return out;
}

const strokes=typeof Path2D!=="undefined";
const radOf=(n,c)=>n.group?Math.max(3,c.r*zoom)
  :n.kind==="file"?Math.max(1.7,Math.min(c.r*zoom,16))
  :n.kind==="terminal"?7:n.kind==="concept"?5:4.5;

function draw(){
  ctx.clearRect(0,0,W,H);
  const pts=new Map(),m=40;
  const groups=[];
  for(const n of units){
    if(!shown(n))continue;
    const c=n.group?CIRC.get(n.id):pos(n.id);
    if(!c)continue;
    const x=sx(c.x),y=sy(c.y);
    const r=radOf(n,c);
    const on=x>-m-r&&x<W+m+r&&y>-m-r&&y<H+m+r;
    pts.set(n.id,{x,y,r,n,on});
    if(n.group&&on)groups.push({x,y,r,n});
    if(n.kind==="file"&&on){
      const s=symbolsOf(n);
      if(s)for(let i=0;i<s.l.length;i++){
        const w=symAt(s.c,i,s.l.length),px=sx(w.x),py=sy(w.y);
        pts.set(s.l[i].id,{x:px,y:py,r:Math.max(1.4,s.c.r*zoom*.09),n:s.l[i],
          on:px>-m&&px<W+m&&py>-m&&py<H+m});}}}

  const selU=sel?uOf(sel)||sel:null;
  const near=neighbourhood(sel,selU);
  const lit=id=>!hilite||!G||!G.branches[hilite]||onBranch(id);

  for(const g of groups){
    ctx.beginPath();ctx.arc(g.x,g.y,g.r,0,6.283);
    ctx.fillStyle="rgba(79,140,201,.045)";ctx.fill();
    ctx.strokeStyle=g.n.id===sel?"#ffffffaa":GROUPC+"44";
    ctx.lineWidth=g.n.id===sel?1.8:1;ctx.stroke();}

  const lanes=new Map();
  const lane=(kind,alp,wid)=>{
    const key=kind+"|"+alp+"|"+wid;
    let l=lanes.get(key);
    if(!l){l={c:(EDGES[kind]||EDGES["co-change"]).c,a:alp,w:wid,path:strokes?new Path2D():null,segs:[]};
      lanes.set(key,l);}
    return l;};
  const hotPath=[];
  let drawn=0;
  for(const e of UE){
    if(eoff.has(e.kind))continue;
    const a=pts.get(e.src),b=pts.get(e.dst);
    if(!a||!b||(!a.on&&!b.on))continue;
    const on=selU&&(e.src===selU||e.dst===selU);
    if(on){hotPath.push([a,b]);continue;}
    if(e.kind==="co-change"&&e.weight<ccCut&&zoom<1.2)continue;
    if(drawn>=MAXE)continue;
    drawn++;
    const w=e.kind==="co-change"?Math.min(.12+e.weight*.25,.7):e.kind==="references"?Math.min(.15+e.weight*.05,.6):.22;
    const dim=(hilite&&!(lit(e.src)||lit(e.dst))?.3:1)*(near?.2:1);
    const alp=Math.round(w*dim*20)/20;
    const wid=Math.round((e.kind==="co-change"?Math.min(.4+e.weight*.4,1.8):.7)*4)/4;
    const l=lane(e.kind,alp,wid);
    if(l.path){l.path.moveTo(a.x,a.y);l.path.lineTo(b.x,b.y);}else l.segs.push([a,b]);}
  for(const l of lanes.values()){
    if(l.a<=0)continue;
    ctx.strokeStyle="rgba("+l.c+","+l.a+")";ctx.lineWidth=l.w;
    if(l.path)ctx.stroke(l.path);
    else{ctx.beginPath();for(const [a,b] of l.segs){ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.stroke();}}
  if(hotPath.length){ctx.strokeStyle="rgba(170,205,255,.85)";ctx.lineWidth=1.6;ctx.beginPath();
    for(const [a,b] of hotPath){ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);}ctx.stroke();}

  ctx.textAlign="center";
  const labels=[];
  for(const [id,p] of pts){
    if(!p.on)continue;
    const n=p.n;
    const faded=near&&!near.has(id);
    const bright=lit(id);
    if(!n.group){
      ctx.globalAlpha=(faded?.2:1)*(bright?1:.25)*(n.status==="settled"?.55:1)
        *(n.kind==="symbol"&&n.weight<2?.6:1);
      if(id===sel||id===hot){ctx.beginPath();ctx.arc(p.x,p.y,p.r+6,0,6.283);
        ctx.fillStyle=colOf(n)+"33";ctx.fill();}
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,6.283);ctx.fillStyle=colOf(n);ctx.fill();
      if(bright&&onBranch(id)){ctx.lineWidth=1.5;ctx.strokeStyle="#fff";ctx.stroke();}
      if(id===sel){ctx.lineWidth=2;ctx.strokeStyle="#fff";ctx.stroke();}}
    const want=id===hot||id===sel||id===selU||(near&&near.has(id))||n.group||
      (n.kind==="file"?p.r>4.2:n.kind==="symbol"?p.r>3:zoom>.9);
    if(want&&!faded){
      const raw=n.group?n.label+" ("+n.count+")":n.label;
      labels.push({x:p.x,y:n.group?p.y-p.r-4:p.y+p.r+10,
        pri:id===sel||id===selU||id===hot?1e9:n.group?1e6+p.r:p.r,
        a:bright?.92:.3,c:n.group?"#c3d3e4":"#9fb0c4",
        f:n.group?Math.max(9,Math.min(15,p.r*.22)):Math.max(8,Math.min(13,9*Math.sqrt(zoom))),
        t:raw.length>34?raw.slice(0,33)+"…":raw});}}
  const taken=new Set();
  labels.sort((a,b)=>b.pri-a.pri);
  for(const L of labels){
    const key=Math.round(L.x/68)+":"+Math.round(L.y/13);
    if(taken.has(key))continue;
    taken.add(key);
    ctx.globalAlpha=L.a;ctx.fillStyle=L.c;ctx.font=L.f+"px ui-monospace,monospace";
    ctx.fillText(L.t,L.x,L.y);}
  ctx.globalAlpha=1;
  lastPts=pts;
}

function frame(){
  if(fly)stepFly();
  if(dirty){dirty=false;draw();}
  requestAnimationFrame(frame);}

function stepFly(){
  const t=Math.min(1,(Date.now()-fly.t0)/fly.ms);
  const e=t<.5?2*t*t:1-Math.pow(-2*t+2,2)/2;
  zoom=fly.z0+(fly.z1-fly.z0)*e;
  panx=fly.px0+(fly.px1-fly.px0)*e;
  pany=fly.py0+(fly.py1-fly.py0)*e;
  if(t>=1){fly=null;recompute(false);updateCrumb();}
  mark();
}
function flyTo(x,y,r){
  const z=Math.max(.02,Math.min(60,.42*Math.min(W,H)/Math.max(r,1)));
  fly={t0:Date.now(),ms:260,z0:zoom,z1:z,px0:panx,px1:-x*z,py0:pany,py1:-y*z};
  mark();
}

function hit(mx,my){
  let best=null,bd=1e9;
  for(const [,p] of lastPts){
    if(!p.on||p.n.group)continue;
    const r=Math.max(6,p.r)+3,d=(p.x-mx)**2+(p.y-my)**2;
    if(d<r*r&&d<bd){bd=d;best=p.n;}}
  if(best)return best;
  for(const [,p] of lastPts){
    if(!p.on||!p.n.group)continue;
    const d=Math.hypot(p.x-mx,p.y-my);
    if(d<=p.r&&p.r<bd){bd=p.r;best=p.n;}}
  return best;
}

cv.addEventListener("mousedown",e=>{moved=false;drag={x:e.clientX,y:e.clientY};cv.classList.add("drag");});
addEventListener("mouseup",()=>{if(drag&&moved){recompute(false);updateCrumb();}
  drag=null;cv.classList.remove("drag");mark();});
addEventListener("mousemove",e=>{
  const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(!drag){
    const n=hit(mx,my);if((n?n.id:null)!==hot)mark();hot=n?n.id:null;
    if(n){tip.style.opacity="1";tip.style.left=(mx+14)+"px";tip.style.top=(my+12)+"px";
      tip.textContent=n.group?n.dir+"/  "+n.count+" files":
        n.kind==="symbol"?n.label+"  "+n.path+(n.line?":"+n.line:""):n.label;}
    else tip.style.opacity="0";
    return;}
  const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
  if(Math.abs(dx)+Math.abs(dy)>3)moved=true;
  drag.x=e.clientX;drag.y=e.clientY;
  panx+=dx;pany+=dy;mark();});
cv.addEventListener("click",e=>{
  if(moved)return;
  const r=cv.getBoundingClientRect(),n=hit(e.clientX-r.left,e.clientY-r.top);
  if(n&&n.group){
    if(sel===n.id){const c=CIRC.get(n.id);if(c)flyTo(c.x,c.y,c.r);pick(null);}
    else pick(n);
    return;}
  pick(n);});
cv.addEventListener("wheel",e=>{e.preventDefault();
  fly=null;
  const r=cv.getBoundingClientRect(),cx=e.clientX-r.left-W/2,cy=e.clientY-r.top-H/2;
  const z=Math.max(.02,Math.min(60,zoom*(e.deltaY<0?1.12:.89)));
  panx=cx-(cx-panx)*z/zoom;pany=cy-(cy-pany)*z/zoom;zoom=z;
  scheduleCut();mark();},{passive:false});
addEventListener("keydown",e=>{
  const typing=document.activeElement===$("q")||document.activeElement===$("ff");
  if(e.key==="/"&&!typing){e.preventDefault();$("q").focus();$("q").select();}
  else if(e.key==="f"&&!typing&&sel)isolate(sel);
  else if(e.key==="Escape"){if(iso)isolate(null);else if(sel)pick(null);else fit();
    $("q").blur();$("ff").blur();}});

let cutTimer=null;
function scheduleCut(){
  if(cutTimer)clearTimeout(cutTimer);
  cutTimer=setTimeout(()=>{cutTimer=null;recompute(false);updateCrumb();mark();},90);
}

function isolate(id){
  iso=id&&iso!==id?id:null;
  $("biso").classList.toggle("on",!!iso);
  recompute(true);fit();updateCounts();
}

function groupEdges(id){
  const out={};
  for(const e of UE)if(e.src===id||e.dst===id)out[e.kind]=(out[e.kind]||0)+1;
  const bits=Object.entries(out).map(([k,v])=>v+" "+k);
  return bits.length?"with: "+bits.join(", "):"no edges";
}
function edgeCounts(id){
  const inn={},out={},both={};
  for(const l of adj.get(id)||[]){const t=l.dir==="both"?both:l.dir==="in"?inn:out;t[l.kind]=(t[l.kind]||0)+1;}
  const fmt=o=>Object.entries(o).map(([k,v])=>v+" "+k).join(", ");
  const bits=[];
  if(Object.keys(inn).length)bits.push("in: "+fmt(inn));
  if(Object.keys(out).length)bits.push("out: "+fmt(out));
  if(Object.keys(both).length)bits.push("with: "+fmt(both));
  return bits.join("\\n")||"no edges";
}

function pick(n){
  sel=n?n.id:null;mark();
  const dt=$("dtitle"),db=$("dbody"),dm=$("dmeta"),de=$("dedges"),dl=$("dlinks");
  if(n&&n.group){
    dt.textContent=n.dir+"/";db.textContent="";
    dm.textContent="folder · "+n.count+" files · click again to enter";
    de.textContent=groupEdges(n.id);dl.replaceChildren();
    const sub=[...(tree.get(n.dir)||{subs:[]}).subs];
    for(const s of sub.slice(0,40))dl.appendChild(row({kind:"file",label:s},s+"/  "+(tree.get(s)||{count:0}).count));
    if(!sub.length)dl.textContent="leaf folder";
    return;}
  if(!n){dt.textContent="Click a node.";db.textContent="";dm.textContent="";de.textContent="";dl.textContent="—";return;}
  dt.textContent=n.title;
  showBody(n);
  const bits=[n.kind];
  if(n.path)bits.push(n.path+(n.line?":"+n.line:""));
  if(n.kind==="symbol")bits.push(n.weight>=2?"exported":"internal");
  if(n.stated)bits.push("stated by the user");
  if(n.tty)bits.push(n.tty);
  if(n.open)bits.push("open item");
  if(n.status)bits.push(n.status+(n.behind!=null?" · "+n.behind+" behind":""));
  if(n.branch)bits.push("on "+n.branch);
  if(n.at)bits.push(new Date(n.at).toLocaleString());
  dm.textContent=bits.join(" · ");
  de.textContent=edgeCounts(n.id);
  dl.replaceChildren();
  const links=(adj.get(n.id)||[]).slice(0,40);
  if(!links.length){dl.textContent="nothing linked";return;}
  for(const l of links){const o=byId.get(l.id);if(!o)continue;
    dl.appendChild(row(o,l.kind+(l.dir==="in"?" ←":l.dir==="out"?" →":" ·")+" "+o.label));}
}
function showBody(n){
  const db=$("dbody");
  if(n.body!==undefined){db.textContent=n.kind==="file"?(n.body?"last: "+n.body:""):n.body;return;}
  db.textContent="…";
  fetch("/api/node?id="+encodeURIComponent(n.base||n.id)).then(body)
    .then(r=>{n.body=r.body;if(sel===n.id)showBody(n);})
    .catch(()=>{if(sel===n.id)db.textContent="";});
}
function row(n,text){
  const el=document.createElement("div");el.className="row";
  const d=document.createElement("span");d.className="dot";d.style.background=colOf(n);
  const t=document.createElement("span");t.textContent=text;
  el.append(d,t);el.onclick=()=>reveal(n);return el;
}

function reveal(n){
  if(!n)return;
  off.delete(kindOf(n));
  const c=n.kind==="symbol"?CIRC.get(fileOf(n)):n.path?CIRC.get("f:"+n.path):null;
  const at=c||pos(n.id);
  if(at)flyTo(at.x,at.y,(c?c.r:8)*1.6);
  recompute(true);pick(n);refreshLegend();mark();
}

function fit(){
  const c=!iso&&!filt.trim()?CIRC.get("g:"):null;
  if(c){flyTo(c.x,c.y,c.r*1.16);return;}
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9,any=false;
  for(const n of units){
    const p=n.group?CIRC.get(n.id):pos(n.id);if(!p)continue;
    const r=p.r||6;any=true;
    x0=Math.min(x0,p.x-r);y0=Math.min(y0,p.y-r);x1=Math.max(x1,p.x+r);y1=Math.max(y1,p.y+r);}
  if(!any)return;
  flyTo((x0+x1)/2,(y0+y1)/2,Math.max(x1-x0,y1-y0)/2*1.1);
}

function updateCrumb(){
  const el=$("crumb");if(!el)return;
  el.replaceChildren();
  const v=view(),cx=(v.x0+v.x1)/2,cy=(v.y0+v.y1)/2;
  let deep="",cur="";
  for(;;){
    const t=tree.get(cur);if(!t)break;
    let next=null;
    for(const s of t.subs){const c=CIRC.get("g:"+s);
      if(c&&Math.hypot(c.x-cx,c.y-cy)<c.r){next=s;break;}}
    if(!next)break;
    cur=next;deep=next;}
  const segs=deep?deep.split("/"):[];
  const mk=(text,dir)=>{const s=document.createElement("span");s.textContent=text;
    s.onclick=()=>{const c=CIRC.get("g:"+dir);if(c)flyTo(c.x,c.y,c.r*1.12);};return s;};
  el.appendChild(mk("/",""));
  let acc="";
  for(const s of segs){acc=acc?acc+"/"+s:s;
    el.appendChild(document.createTextNode(" / "));el.appendChild(mk(s,acc));}
}

$("bfit").onclick=fit;
$("bsym").onclick=e=>{symMode=symMode==="auto"?"all":symMode==="all"?"none":"auto";
  e.target.textContent="symbols: "+symMode;mark();};
$("bflat").onclick=e=>{flatMode=flatMode==="auto"?"off":"auto";
  e.target.textContent="files: "+(flatMode==="auto"?"auto":"all");recompute(true);updateCounts();mark();};
$("biso").onclick=()=>{if(iso)isolate(null);else if(sel)isolate(sel);};
$("bhop").onclick=e=>{hops=hops>=3?1:hops+1;e.target.textContent=hops+" hop"+(hops>1?"s":"");
  if(iso){recompute(true);fit();updateCounts();}};

function search(q){
  hits=[];const h=$("hits");h.replaceChildren();
  q=q.trim().toLowerCase();if(!q)return;
  const score=n=>{const l=n.label.toLowerCase(),t=n.title.toLowerCase(),p=(n.path||"").toLowerCase();
    return l===q?0:l.startsWith(q)?1:l.includes(q)?2:t.includes(q)?3:p.includes(q)?4:9;};
  hits=N.map(n=>[score(n),n]).filter(x=>x[0]<9).sort((a,b)=>a[0]-b[0]||b[1].weight-a[1].weight).slice(0,12).map(x=>x[1]);
  for(const n of hits)h.appendChild(row(n,n.kind==="symbol"?n.label+"  "+n.path:n.label));
}
$("q").addEventListener("input",e=>search(e.target.value));
$("q").addEventListener("keydown",e=>{if(e.key==="Enter"&&hits.length)reveal(hits[0]);if(e.key==="Escape")e.target.blur();});

let ftimer=null;
$("ff").addEventListener("input",e=>{
  const v=e.target.value;
  if(ftimer)clearTimeout(ftimer);
  ftimer=setTimeout(()=>{filt=v;recompute(true);updateCounts();mark();},180);});
$("ff").addEventListener("keydown",e=>{if(e.key==="Escape"){e.target.value="";filt="";
  recompute(true);updateCounts();mark();e.target.blur();}});

function refreshLegend(){
  for(const el of $("legend").children)el.classList.toggle("off",off.has(el.dataset.k));
}
const lg=$("legend");
for(const [k,v] of Object.entries(KINDS)){
  const el=document.createElement("span");el.className="tag";el.dataset.k=k;
  el.innerHTML='<span class="dot" style="background:'+v.c+'"></span>'+v.label;
  el.onclick=()=>{off.has(k)?off.delete(k):off.add(k);refreshLegend();mark();};
  lg.appendChild(el);}
const elg=$("elegend");
for(const [k,v] of Object.entries(EDGES)){
  const el=document.createElement("span");el.className="tag";if(eoff.has(k))el.classList.add("off");
  el.innerHTML='<span class="bar" style="background:rgb('+v.c+')"></span>'+k;
  el.onclick=()=>{eoff.has(k)?eoff.delete(k):eoff.add(k);el.classList.toggle("off",eoff.has(k));mark();};
  elg.appendChild(el);}

function updateCounts(){
  if(!G)return;
  const folders=units.filter(u=>u.group).length;
  const sent=Object.entries(G.counts).map(([k,v])=>v+" "+k+(v===1||k==="said"?"":"s")).join("  ·  ");
  const drawn=units.length+" drawn"+(folders?" ("+folders+" folders)":"");
  const scope=iso?"\\nisolated: "+hops+" hop"+(hops>1?"s":"")+" from "+(byId.get(iso)||{label:iso}).label:"";
  const f=filt.trim()?"\\nfilter: "+(vis?vis.size:0)+" match":"";
  $("counts").textContent=(G.sliced?"sent: ":"")+sent+"\\n"+drawn+scope+f+
    (hilite?"\\n"+(G.branches[hilite]?G.branches[hilite]+" on "+hilite+" highlighted":"nothing carries branch "+hilite):"");
  $("fhint").textContent=filt.trim()?"":"kind: file symbol fact note said concept terminal";
}

const SYM=new Set(["co-change","co-edit","sibling","imports","calls"]);
function decode(g){
  return g.edges.map(e=>({src:g.nodes[e[0]].id,dst:g.nodes[e[1]].id,kind:g.kinds[e[2]],weight:e[3]}));
}
function index(){
  byId=new Map(N.map(n=>[n.id,n]));
  adj=new Map(N.map(n=>[n.id,[]]));symsOf=new Map();
  for(const n of N)if(n.kind==="symbol"){const f=fileOf(n);const l=symsOf.get(f);if(l)l.push(n);else symsOf.set(f,[n]);}
  for(const l of symsOf.values())l.sort((a,b)=>b.weight-a.weight||a.label.localeCompare(b.label));
  for(const e of E){const both=SYM.has(e.kind);
    const a=adj.get(e.src),b=adj.get(e.dst);
    if(a)a.push({id:e.dst,kind:e.kind,dir:both?"both":"out"});
    if(b)b.push({id:e.src,kind:e.kind,dir:both?"both":"in"});}
  if(iso&&!byId.has(iso))iso=null;
}
function settle(){
  if(sel&&byId.has(sel))pick(byId.get(sel));else if(sel&&sel.charCodeAt(0)!==103)pick(null);
  const p=$("pulse");p.classList.add("on");setTimeout(()=>p.classList.remove("on"),800);
  mark();
}
function load(g){
  const first=!N.length;
  G=g;version=g.version;tstamp=g.terminals;N=g.nodes;E=decode(g);
  index();
  buildLayout();
  recompute(true);
  $("where").textContent=g.root+(g.branch?"  ·  "+g.branch:"");
  updateCounts();updateCrumb();
  if(first)fit();
  $("hudtext").textContent=g.hud;
  settle();
}
function loadTerminals(t){
  tstamp=t.terminals;
  N=N.filter(n=>n.kind!=="terminal").concat(t.nodes);
  E=E.filter(e=>e.kind!=="wrote"&&e.kind!=="touched");
  const ids=new Set(N.map(n=>n.id)),seen=new Set(E.map(e=>e.src+"|"+e.dst+"|"+e.kind));
  const add=(src,dst,kind,weight)=>{const k=src+"|"+dst+"|"+kind;
    if(seen.has(k)||!ids.has(src)||!ids.has(dst)||src===dst)return;
    seen.add(k);E.push({src,dst,kind,weight});};
  for(const n of N)if(n.source)add("t:"+n.source,n.id,"wrote",1);
  const variants=new Map();
  for(const n of N)if(n.base)variants.set(n.base,(variants.get(n.base)||[]).concat(n.id));
  const resolve=id=>ids.has(id)?id:(variants.get(id)||[]).length===1?variants.get(id)[0]:null;
  for(const e of t.touched){const dst=resolve(e.dst);if(dst)add(e.src,dst,"touched",e.weight);}
  if(t.nodes.length)G.counts.terminal=t.nodes.length;else delete G.counts.terminal;
  index();
  recompute(true);
  updateCounts();
  settle();
}

async function body(r){
  if(r.ok)return r.json();
  const t=await r.text();let m=t;
  try{m=JSON.parse(t).error||t;}catch{}
  throw new Error(r.status+" "+m);
}
async function fetchGraph(){load(await body(await fetch("/api/graph"+location.search)));}
let busy=false,fails=0,retryAt=0;
async function tick(){
  if(busy||Date.now()<retryAt)return;
  busy=true;
  const hud=$("hudtext");
  try{
    if(!G)await fetchGraph();
    else{
      const v=await body(await fetch("/api/version"));
      if(v.version!==version)await fetchGraph();
      else if(wantT&&v.terminals!==tstamp)loadTerminals(await body(await fetch("/api/terminals")));}
    fails=0;
  }catch(e){
    fails++;retryAt=Date.now()+Math.min(30000,1500*Math.pow(2,fails));
    hud.textContent=e instanceof TypeError?"grove visualize stopped":"grove visualize: "+e.message;}
  finally{busy=false;}
}
size();tick();setInterval(tick,1500);frame();
</script></body></html>`;
