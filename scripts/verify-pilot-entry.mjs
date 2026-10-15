import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchBrowser,sourceVersion} from './browser-tools.mjs';
const output=process.env.LUMEN_REPORT_DIRECTORY??'reports/local-gi-pilot-v10/entry-first';await mkdir(output,{recursive:true});
const browser=await launchBrowser(),report={version:sourceVersion(),scope:'Actual Cesium classes/WebGL; explicit Worker faults are injected, not claimed natural device faults',checks:[],errors:[]};
try {
 const page=await browser.newPage({viewport:{width:640,height:400}});page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto('http://localhost:8090/demo/regression.html?fixture=untextured&backend=gpu');
 await page.waitForFunction(()=>lumenTest?.world?.ready,null,{timeout:120000});
 report.checks=await page.evaluate(async()=>{
  const d=lumenTest,l=d.scene.lumen,old=l.world,options={...old.options,backend:'gpu'},result=[],Native=window.Worker;
  for(const name of ['invalid-options','worker-constructor','gpu-post-message','cpu-post-message']) {
   let failed=false,created=0,terminated=0;
   try {
    if(name==='worker-constructor') window.Worker=class{constructor(){throw Error('injected Worker constructor failure');}};
    if(name.endsWith('post-message')) window.Worker=class extends Native{constructor(...a){super(...a);created++;}postMessage(){throw Error('injected postMessage failure');}terminate(){terminated++;super.terminate();}};
    l.loadWorld({...options,...(name==='invalid-options'?{spacing:0}:{}),backend:name==='cpu-post-message'?'cpu':'gpu'});
   }catch{failed=true;}finally{window.Worker=Native;}
   d.widget.render();result.push({name,passed:failed&&l.world===old&&!old.isDestroyed()&&created===terminated,created,terminated});
  }
  const broken=l.loadWorld({...options,url:new URL('/fixtures/not-present-r11.glb',location.href).href});let rejected=false;try{await broken.completed;}catch{rejected=true;}
  d.widget.render();result.push({name:'404-closes-worker-without-destroyed-update',passed:rejected&&broken.isDestroyed()&&l.world===undefined});
  const next=l.loadWorld(options);await next.completed;result.push({name:'retry',passed:next.ready&&!next.isDestroyed()});
  l.unloadWorld();d.widget.render();result.push({name:'unload',passed:l.world===undefined&&next.isDestroyed()});
  return result;
 });assert(report.checks.every(c=>c.passed));assert.deepEqual(report.errors,[]);await page.close();report.status='passed';
}catch(error){report.errors.push(String(error));report.status='failed';console.error(error);}finally{await browser.close();}
await writeFile(output+'/entry.json',JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,checks:report.checks,errors:report.errors}));if(report.status!=='passed')process.exitCode=1;
