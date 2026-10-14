import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { launchBrowser,sourceVersion,environment } from '../../../scripts/browser-tools.mjs';
const output='reports/contact-transport-v9/showcase-reviewed';
await mkdir(output,{recursive:true});
const browser=await launchBrowser(), report={version:sourceVersion(),validatorSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),states:[],links:[],errors:[]};
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto('http://localhost:8090/reports/contact-transport-v9/index.html');
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('recommended=false'));
  assert(await page.locator('#results').innerText().then(t=>t.includes('18/60')));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const links=await page.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href));
  for(const href of links) { const response=await page.request.head(href);report.links.push({href,status:response.status()});assert(response.ok(),href); }
  await page.screenshot({path:output+'/report.png',fullPage:true});
  await page.goto('http://localhost:8090/demo/ballpool.html?radianceSource=cache&count=64');
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  report.environment=await environment(page,browser);
  report.states.push({type:'static',state:await page.evaluate(()=>ballPool.snapshot())});
  await page.screenshot({path:output+'/ballpool-cache-static.png'});
  await page.getByRole('button',{name:/播放物理/}).click();
  await page.waitForFunction(()=>ballPool.snapshot().phase==='physics-preview');
  await page.evaluate(()=>new Promise(resolve=>{let frames=0;const step=()=>++frames>=30?resolve():requestAnimationFrame(step);requestAnimationFrame(step);}));
  report.states.push({type:'moving-preview',state:await page.evaluate(()=>ballPool.snapshot())});
  await page.screenshot({path:output+'/ballpool-cache-preview.png'});
  await page.getByRole('button',{name:/暂停/}).click();
  await page.getByRole('button',{name:/定格.*GI/}).click();
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  report.states.push({type:'frozen-updated',state:await page.evaluate(()=>ballPool.snapshot())});
  await page.screenshot({path:output+'/ballpool-cache-frozen.png'});
  assert.deepEqual(report.errors,[]);
  await page.close(); report.status='passed';
} catch(error) { report.errors.push(String(error));report.status='failed';console.error(error); }
finally { await browser.close(); }
await writeFile(output+'/showcase.json',JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,states:report.states.map(s=>({type:s.type,phase:s.state.phase})),links:report.links.length,errors:report.errors}));
if(report.status!=='passed')process.exitCode=1;
