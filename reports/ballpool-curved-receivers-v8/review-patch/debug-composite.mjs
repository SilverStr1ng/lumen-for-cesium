import {launchBrowser} from '../../../scripts/browser-tools.mjs';
import { readFile } from 'node:fs/promises';
const b=await launchBrowser(),p=await b.newPage({viewport:{width:1280,height:800}});
p.on('console',m=>{if(m.type()==='error')console.log(m.text());});
try {
await p.goto('http://localhost:8090/demo/globe.html?diagnostic=1');
await p.waitForFunction(()=>earthLab.world?.ready,null,{timeout:180000});
const prior=JSON.parse(await readFile('reports/ddgi-visual-quality-v4/before/diagnostics.json','utf8'));
await p.evaluate(async(prior)=>{earthLab.scene.context.logShaderCompilation=true;await earthLab.restoreView(prior.settings);await earthLab.scene.lumen.finalGather.configure({mode:'fg',quality:'high',sampling:'reconstructed',model:earthLab.model});},prior);
await p.waitForFunction(()=>earthLab.scene.lumen.finalGather.ready);
console.log(await p.evaluate(async()=>{try{const d=await import('/demo/fg-reconstruction-diagnostics.js');return await d.sampleComposite(earthLab,[{position:[-8.95,-1.5,.15],normal:[0,0,1]}]);}catch(e){return {name:e.name,message:e.message,stack:e.stack};}}));
}finally{await b.close();}
