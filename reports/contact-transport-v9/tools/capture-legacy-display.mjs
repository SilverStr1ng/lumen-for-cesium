import { readFile,writeFile } from 'node:fs/promises';
import { launchBrowser,sourceVersion,environment } from '../../../scripts/browser-tools.mjs';
const output='reports/contact-transport-v9/showcase-reviewed', browser=await launchBrowser();
const matrix=JSON.parse(await readFile('reports/contact-transport-v9/acceptance-20261014/quality-cache/curved.json','utf8'));
const lighting=matrix.rows.find(r=>r.count===1&&r.view==='contact'&&r.scenario==='day'&&r.seed===0).lighting;
try {
  const page=await browser.newPage({viewport:{width:960,height:600}}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('http://localhost:8090/demo/ballpool.html?count=1&camera=contact&transport=legacy');
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  await page.evaluate(lighting=>ballPool.relight(lighting),lighting);
  await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  await page.screenshot({path:output+'/legacy-normal-display.png'});
  await writeFile(output+'/legacy-display.json',JSON.stringify({version:sourceVersion(),scope:'Current compiled production with explicit legacy origin/probe remainder, normal PBR display; not an archived R9 pixel diff',environment:await environment(page,browser),state:await page.evaluate(()=>ballPool.snapshot()),lighting,errors},null,2),{flag:'wx'});
  if(errors.length)process.exitCode=1;
}finally{await browser.close();}
