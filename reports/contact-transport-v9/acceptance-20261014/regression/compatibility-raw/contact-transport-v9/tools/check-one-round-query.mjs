import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { launchBrowser,sourceVersion } from '../../../scripts/browser-tools.mjs';
const root='reports/contact-transport-v9',finite=JSON.parse(await readFile(root+'/acceptance-20261014/surface-finite/surface-cache.json','utf8')),
 browser=await launchBrowser(),report={version:sourceVersion(),purpose:'Same frozen K1 points/directions compare immediate and cache; no quality threshold changes',rows:[],errors:[]};
try{
 for(const count of [1,2]){
  const page=await browser.newPage({viewport:{width:960,height:600}});page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(`http://localhost:8090/demo/ballpool.html?count=${count}&diagnostic=1&camera=contact`);await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  await page.evaluate(()=>ballPool.relight({bounces:1}));
  const old=finite.rows.find(r=>r.count===count&&r.depth===1),rows={};
  for(const source of ['immediate','cache']){
   await page.evaluate(source=>ballPool.setRadianceSource(source),source);
   rows[source]={};for(const [region,data]of Object.entries(old.regions)){
    const query=await page.evaluate(points=>ballPool.world.sampleFinalGather(points,{samples:1024,seed:0,sampling:'reconstructed',epoch:31}),data.points);
    rows[source][region]={query,reference:data.reference,nrmse:Math.sqrt(query.reduce((s,q,i)=>s+q.irradiance.reduce((a,v,k)=>a+(v-data.reference[i].irradiance[k])**2,0),0)/Math.max(.00001,data.reference.reduce((s,r)=>s+r.irradiance.reduce((a,v)=>a+v*v,0),0)))};
   }
  }
  report.rows.push({count,...rows,backendDelta:Object.fromEntries(Object.keys(rows.immediate).map(k=>[k,Math.max(...rows.immediate[k].query.flatMap((q,i)=>q.irradiance.map((v,c)=>Math.abs(v-rows.cache[k].query[i].irradiance[c]))))]))});
  await page.close();
 }
}catch(e){report.errors.push(String(e));console.error(e);}finally{await browser.close();}
report.status=report.errors.length?'failed':'measured';await mkdir(root+'/one-round-control',{recursive:true});await writeFile(root+'/one-round-control/query.json',JSON.stringify(report,null,2),{flag:'wx'});if(report.errors.length)process.exitCode=1;
