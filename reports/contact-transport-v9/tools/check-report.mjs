import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { launchBrowser,sourceVersion } from '../../../scripts/browser-tools.mjs';
const root='reports/contact-transport-v9',output=root+'/showcase-pbr-final';await mkdir(output,{recursive:true});
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex'),browser=await launchBrowser(),report={version:sourceVersion(),htmlSha256:await hash(root+'/index.html'),summarySha256:await hash(root+'/summary-reviewed.json'),links:[],images:[],errors:[]};
try {
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto('http://localhost:8090/'+root+'/index.html');await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('recommended=false'));
 assert((await page.locator('#results').innerText()).includes('18/60'));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 for(const href of await page.locator('a').evaluateAll(nodes=>nodes.map(n=>n.href))) { const response=await page.request.head(href);report.links.push({href,status:response.status()});assert(response.ok(),href); }
 await page.waitForFunction(()=>Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0));
 report.images=await page.locator('img').evaluateAll(nodes=>nodes.map(n=>({src:n.src,width:n.naturalWidth,height:n.naturalHeight})));
 await page.screenshot({path:output+'/report.png',fullPage:true});assert.deepEqual(report.errors,[]);await page.close();report.status='passed';
}catch(error){report.errors.push(String(error));report.status='failed';console.error(error);}finally{await browser.close();}
await writeFile(output+'/report.json',JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({status:report.status,links:report.links.length,images:report.images.length,errors:report.errors}));if(report.status!=='passed')process.exitCode=1;
