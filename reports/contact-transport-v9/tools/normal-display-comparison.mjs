import { readFile,writeFile,mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { launchBrowser,sourceVersion } from '../../../scripts/browser-tools.mjs';
const root='reports/contact-transport-v9',output=root+'/normal-display',browser=await launchBrowser();await mkdir(output,{recursive:true});
const matrix=JSON.parse(await readFile(root+'/acceptance-20261014/quality-cache/curved.json','utf8'));
const lighting=matrix.rows.find(r=>r.count===1&&r.view==='contact'&&r.scenario==='day'&&r.seed===0).lighting;
const report={version:sourceVersion(),scope:'Current same-build normal PBR comparison; explicit debugMode=0 and 32 rendered frames, original numerical matrix unchanged. Archived quality screenshots can retain last diagnostic framebuffer.',lighting,rows:[],errors:[]};
try {
 for(const [name,transport,source] of [['legacy-immediate','legacy','immediate'],['physical-immediate','physical','immediate'],['physical-cache','physical','cache']]) {
  const page=await browser.newPage({viewport:{width:960,height:600}});page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(`http://localhost:8090/demo/ballpool.html?diagnostic=1&count=1&camera=contact&transport=${transport}&radianceSource=${source}`);
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  await page.evaluate(lighting=>ballPool.relight(lighting),lighting);
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  const state=await page.evaluate(async()=>{
   const d=ballPool,f=d.scene.lumen.finalGather;d.widget.useDefaultRenderLoop=false;d.camera('contact');
   await f.configure({seed:0,sequenceEpoch:null,model:d.model,execution:'split',sampling:'reconstructed',quality:'auto',smoothReceivers:true});
   f._sampleEpoch=0;f.freezeSampling=false;d.scene.lumen.debugMode=0;
   for(let i=0;i<32;i++)d.widget.render();return {snapshot:d.snapshot(),debug:d.scene.lumen.debugMode,samples:f.samples,receiver:f.metrics.resolution};
  });
  assert.equal(state.debug,0);await page.screenshot({path:output+'/'+name+'.png'});report.rows.push({name,transport,source,state});await page.close();
 }
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.errors.push(String(error));report.status='failed';console.error(error);}finally{await browser.close();}
await writeFile(output+'/comparison.json',JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,rows:report.rows.length,errors:report.errors}));if(report.status!=='passed')process.exitCode=1;
