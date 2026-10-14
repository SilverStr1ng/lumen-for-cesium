import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { launchBrowser,sourceVersion } from '../../../scripts/browser-tools.mjs';
import { loadGeometry } from '../../../lumen/gltf.js';
import { BVH } from '../../../lumen/bvh.js';
import { normalize } from '../../../lumen/math.js';
import { referenceIrradiance } from '../../../lumen/path-reference.js';
const root='reports/contact-transport-v9',matrix=JSON.parse(await readFile(root+'/acceptance-20261014/quality-cache/curved.json','utf8')),
 browser=await launchBrowser(),report={version:sourceVersion(),validatorSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),scope:'Supplementary actual E_used at existing projected pixels; independent geometry/Ng/Ns from camera rays. Original low receiver gates unchanged.',rows:[],errors:[]};
const output=process.argv.find(v=>v.startsWith('--output='))?.slice(9)??root+'/final-pixel-reference-reviewed';
const nrmse=(points,refs)=>Math.sqrt(points.reduce((s,p,i)=>s+p.E_used.reduce((a,v,k)=>a+(v-refs[i].irradiance[k])**2,0),0)/Math.max(.00001,refs.reduce((s,r)=>s+r.irradiance.reduce((a,v)=>a+v*v,0),0)));
try{
 for(const count of [1,2]){
  const page=await browser.newPage({viewport:{width:960,height:600}});page.on('pageerror',e=>report.errors.push(String(e)));
  await page.goto(`http://localhost:8090/demo/ballpool.html?count=${count}&diagnostic=1`);await page.waitForFunction(()=>ballPool.snapshot().phase==='static-ready',null,{timeout:180000});
  const payload=await page.evaluate(async()=>({gltf:await(await fetch(ballPool.world.options.url)).json(),balls:ballPool.descriptor.balls})),geometry=await loadGeometry(`data:model/gltf+json;base64,${Buffer.from(JSON.stringify(payload.gltf)).toString('base64')}`),bvh=new BVH(geometry,{strategy:'sah'});
  for(const row of matrix.rows.filter(r=>r.count===count)){
   const group=[];for(const [name,data]of Object.entries(row.regionErrors))for(const point of data.points)group.push({region:name,point,pixel:point.pixel.map((v,k)=>Math.min(row.resolution[k]-1,Math.floor((v+.5)*row.resolution[k]/row.receiver[k])))});
   const rays=await page.evaluate(({view,pixels})=>{
    ballPool.camera(view);ballPool.widget.render();const inverse=Cesium.Matrix4.inverse(ballPool.world.options.modelMatrix,new Cesium.Matrix4());
    return pixels.map(p=>{const r=ballPool.scene.camera.getPickRay(new Cesium.Cartesian2(p[0]+.5,ballPool.scene.drawingBufferHeight-p[1]-.5)),o=Cesium.Matrix4.multiplyByPoint(inverse,r.origin,new Cesium.Cartesian3()),d=Cesium.Matrix4.multiplyByPointAsVector(inverse,r.direction,new Cesium.Cartesian3());return {origin:[o.x,o.y,o.z],direction:[d.x,d.y,d.z]};});
   },{view:row.view,pixels:group.map(g=>g.pixel)});
   const points=group.map((g,i)=>{
    const h=bvh.trace(rays[i].origin,rays[i].direction,{maxDistance:1000}),position=h.status==='Hit'?[0,1,2].map(k=>geometry.positions[h.triangle*9+k]*(1-h.u-h.v)+geometry.positions[h.triangle*9+3+k]*h.u+geometry.positions[h.triangle*9+6+k]*h.v):null;
    if(!position)return {...g,trace:h};
    const vertices=[0,1,2].map(j=>Array.from(geometry.positions.subarray(h.triangle*9+j*3,h.triangle*9+j*3+3))),ball=payload.balls.find(b=>vertices.every(v=>Math.abs(Math.hypot(...v.map((x,k)=>x-b.position[k]))-b.radius)<.00002)),ng=Array.from(geometry.normals.slice(h.triangle*3,h.triangle*3+3)),ns=ball?normalize(position.map((v,k)=>v-ball.position[k])):ng;
    return {...g,trace:h,position,ng,ns,actualOwner:ball?4096+ball.ballId:null};
   });
   const regional={};for(const name of Object.keys(row.regionErrors)){
    const p=points.filter(p=>p.region===name),refs=p.map((p,i)=>p.position?referenceIrradiance(bvh,p.position,p.ns,{...row.lighting,rayOriginPolicy:'physical'},8192,7019+i,p.ng):null);
    if(!p.length)continue;if(refs.some(r=>!r)){regional[name]={status:'failed',reason:'Projected pixel no longer hits geometry',points:p};continue;}
    const error=nrmse(p.map(p=>({...p.point,E_used:p.point.E_used})),refs);regional[name]={status:error<=.2?'passed':'failed',nrmse:error,points:p,reference:refs};
   }
   report.rows.push({count,scenario:row.scenario,seed:row.seed,view:row.view,regions:regional});
  }
  await page.close();
 }
}catch(e){report.errors.push(String(e));console.error(e);}finally{await browser.close();}
report.status=report.errors.length||report.rows.some(r=>Object.values(r.regions).some(g=>g.status!=='passed'))?'failed':'passed';await mkdir(output,{recursive:true});await writeFile(output+'/used.json',JSON.stringify(report,null,2),{flag:'wx'});if(report.status!=='passed')process.exitCode=1;
