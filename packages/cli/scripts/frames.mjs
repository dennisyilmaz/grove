#!/usr/bin/env node
/** Frame times for a running `grove visualize`, measured in headless Chrome over CDP.
 *  Usage: node packages/cli/scripts/frames.mjs http://127.0.0.1:4317 [label] */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2];
const LABEL = process.argv[3] ?? URL_;
const CHROME =
  process.env.CHROME ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");
if (!URL_) {
  process.stderr.write("usage: frames.mjs <url of a running grove visualize> [label]\n");
  process.exit(1);
}
const PORT = Number(process.env.CDP_PORT ?? 9333);
const profile = mkdtempSync(join(tmpdir(), "grove-frames-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1600,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("chrome never came up");
}

await endpoint();
const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?${URL_}`, { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};

await send("Page.enable");
for (let i = 0; i < 100; i++) {
  const ready = await evaluate("typeof G!=='undefined' && !!G && typeof draw==='function'").catch(
    () => false,
  );
  if (ready) break;
  await sleep(200);
}
await evaluate("typeof recompute==='function'?1:0");

const probe = `
(async()=>{
  const has=typeof recompute==='function';
  const out=[];
  const bench=async(label,setup)=>{
    setup();
    if(has)recompute(true);
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const ts=[];
    for(let i=0;i<60;i++){
      const t0=performance.now();
      mark();draw();
      await new Promise(r=>requestAnimationFrame(r));
      ts.push(performance.now()-t0);
    }
    ts.sort((a,b)=>a-b);
    const raw=[];
    for(let i=0;i<25;i++){const t0=performance.now();draw();raw.push(performance.now()-t0);}
    raw.sort((a,b)=>a-b);
    out.push({label,cpu:+raw[12].toFixed(2),
      units:has?units.length:N.filter(n=>n.kind!=='symbol').length,
      edges:has?UE.length:E.length,
      p50:+ts[30].toFixed(2),p95:+ts[57].toFixed(2),max:+ts[59].toFixed(2)});
  };
  for(const z of [0.15,0.5,1,3,8,20]) await bench('zoom '+z,()=>{zoom=z;panx=0;pany=0;if(typeof fly!=='undefined')fly=null;});
  if(has){
    const f=N.find(n=>n.kind==='file');
    await bench('selected',()=>{zoom=3;sel=f.id;});
    await bench('all files',()=>{sel=null;zoom=3;if(typeof flatMode!=='undefined')flatMode='off';});
    if(typeof flatMode!=='undefined')flatMode='auto';
  }
  return out;
})()`;
const rows = await evaluate(probe);
console.log(`\n${LABEL}`);
console.log("label        units   edges   draw      p50      p95      max");
for (const r of rows) {
  console.log(
    String(r.label).padEnd(12),
    String(r.units).padStart(5),
    String(r.edges).padStart(7),
    `${r.cpu}ms`.padStart(7),
    `${r.p50}ms`.padStart(8),
    `${r.p95}ms`.padStart(8),
    `${r.max}ms`.padStart(8),
  );
}
ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
