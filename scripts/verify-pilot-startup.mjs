import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {launchBrowser, sourceVersion} from "./browser-tools.mjs";
import {newOutput, pilotBase} from "./pilot-validation.mjs";
import {installStartupObserver} from "./startup-observer.mjs";
const output = await newOutput("startup"), contract = JSON.parse(await readFile("docs/product/local-gi-startup-v1.json", "utf8"));
const report = {version: sourceVersion(["scripts/verify-pilot-startup.mjs", "scripts/startup-observer.mjs", "docs/product/local-gi-startup-v1.json"]), contract, configuration: {starts: Number(process.env.LUMEN_STARTUP_RUNS ?? 5), displays: (process.env.LUMEN_PILOT_DISPLAYS ?? "models,tiles").split(","), profile: process.env.LUMEN_STARTUP_PROFILE ?? "enhanced", browser: "fresh sandboxed browser/profile per cold row; driver cache uncontrolled", cpuProfile: process.env.LUMEN_STARTUP_CPU !== "0"}, rows: [], errors: [], status: "not-run"};
const percentile = (v, p) => [...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
for (const display of report.configuration.displays) for (let n=0; n<report.configuration.starts; n++) {
  let browser, timer, session;
  const row = {display, run: n, cache: "fresh-process-profile; driver cache uncontrolled", errors: []};
  try {
    console.log(JSON.stringify({display, run:n, phase:"navigation"}));
    browser = await launchBrowser();
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    page.on("pageerror", e=>row.errors.push(String(e)));
    await page.exposeFunction("recordStartupInput", r=>{});
    await page.addInitScript(installStartupObserver);
    session = await page.context().newCDPSession(page);
    if (report.configuration.cpuProfile) { await session.send("Profiler.enable"); await session.send("Profiler.setSamplingInterval",{interval:1000}); await session.send("Profiler.start"); }
    let inFlight=0;
    timer = setInterval(()=>{
      if(inFlight>=4)return;
      inFlight++;
      session.send("Input.dispatchKeyEvent",{type:"keyDown",key:"F8",code:"F8",windowsVirtualKeyCode:119,timestamp:Date.now()/1000}).catch(()=>{}).finally(()=>inFlight--);
    },200);
    await page.goto(pilotBase()+`pilot-${display}.html?profile=${report.configuration.profile}`, {waitUntil:"commit", timeout:contract.measurementDeadlineMilliseconds});
    await page.waitForFunction(profile=> {
      const s=window.startupProbe;
      return !!(s && (profile === "enhanced" ? s.targetFGFrame : s.firstNewGIFrame));
    },report.configuration.profile,{timeout:contract.measurementDeadlineMilliseconds});
    await page.waitForTimeout(200);
    row.measurement = await page.evaluate(()=>startupProbe.finish());
    row.status = await page.evaluate(()=>pilotSession.status());
    if (report.configuration.cpuProfile) {
      const {profile} = await session.send("Profiler.stop");
      await writeFile(`${output}/${display}-${n}.cpuprofile`,JSON.stringify(profile),{flag:"wx"});
    }
    const m=row.measurement, limits=contract.limitsMilliseconds;
    m.sources=await Promise.all(m.sources.map(async(source,index)=>{
      const hash=createHash("sha256").update(source).digest("hex"), file=`${hash}.glsl`;
      try {await writeFile(`${output}/${file}`,source,{flag:"wx"});} catch(e){if(e.code!=="EEXIST")throw e;}
      return {index,hash,bytes:Buffer.byteLength(source),file};
    }));
    const inputs=m.inputs.filter(i=>i.shellReady).map(i=>i.delay);
    row.summary={shellInteractive:m.shellInteractive,firstSceneFrame:m.firstSceneFrame,firstAssetFrame:m.firstAssetFrame,firstNewGIFrame:m.firstNewGIFrame,targetFGFrame:m.targetFGFrame,inputCount:inputs.length,inputP95:percentile(inputs,.95)??null,inputMax:inputs.length?Math.max(...inputs):null,maxMainThreadGap:Math.max(0,...m.gaps.map(g=>g.duration),...m.tasks.map(t=>t.duration)),programs:m.programs.length,extensions:m.extensions};
    row.checks={shell:m.shellInteractive!==null&&m.shellInteractive<=limits.shellInteractive,asset:m.firstAssetFrame!==null&&m.firstAssetFrame<=limits.firstAssetFrame,gi:m.firstNewGIFrame!==null&&m.firstNewGIFrame<=limits.firstNewGIFrame,input:inputs.length>=5&&row.summary.inputP95<=limits.inputP95&&row.summary.inputMax<=limits.inputMax,gap:row.summary.maxMainThreadGap<=limits.maxMainThreadGap,fg:report.configuration.profile!=="enhanced"||m.targetFGFrame!==null,complete:!m.overflow&&!row.errors.length};
    row.passed=Object.values(row.checks).every(Boolean);
  } catch(error) { row.errors.push(String(error)); row.passed=false;
    try {row.measurement=await browser.contexts()[0].pages()[0].evaluate(()=>startupProbe.finish());}catch{}
  } finally { clearInterval(timer); await browser?.close(); }
  report.rows.push(row);
  await writeFile(`${output}/${display}-${n}.json`,JSON.stringify(row,null,2),{flag:"wx"});
  console.log(JSON.stringify({display,run:n,passed:row.passed,summary:row.summary,errors:row.errors}));
}
report.status=report.rows.every(r=>r.passed)?(report.configuration.starts>=5&&report.configuration.displays.length===2?"passed":"not-run"):"failed";
await writeFile(output+"/startup.json",JSON.stringify(report,null,2),{flag:"wx"});
console.log(JSON.stringify({output,status:report.status}));
if(report.status!=="passed")process.exitCode=1;
