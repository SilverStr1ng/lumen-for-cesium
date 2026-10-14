import {createBallPool,ballPoolGltf} from "../lumen/ballpool-scene.js";
import {BallPoolPhysics} from "./ballpool-physics.js";
import {LightingEnvironment} from "./lighting-environment.js";
const C=Cesium,$=id=>document.getElementById(id),params=new URLSearchParams(location.search);
C.Ion.defaultAccessToken="";
const widget=new C.CesiumWidget("view",{baseLayer:false,terrainProvider:new C.EllipsoidTerrainProvider(),
  msaaSamples:1,contextOptions:{webgl:{preserveDrawingBuffer:params.has("diagnostic")}}}),scene=widget.scene;
scene.highDynamicRange=true;scene.gBuffer.enabled=false;scene.postProcessStages.exposure=1;
scene.postProcessStages.tonemapper=C.Tonemapper.PBR_NEUTRAL;scene.postProcessStages.fxaa.enabled=false;
scene.atmosphere.dynamicLighting=C.DynamicAtmosphereLightingType.SCENE_LIGHT;
scene.shadowMap.enabled=true;scene.shadowMap.size=2048;scene.shadowMap.normalOffset=false;scene.shadowMap.softShadows=true;
scene.lumen.diffuseResponse="cesium";scene.lumen.iblPolicy="enhanced";
const frame=C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(114.1,22.3,2)),
  rotation=C.Matrix4.getMatrix3(frame,new C.Matrix3()),environment=new LightingEnvironment(true),
  fg=scene.lumen.finalGather;
fg.mode="fg";fg.quality=params.get("fgQuality")??"auto";fg.sampling="reconstructed";fg.smoothReceivers=true;
const lighting={sunDirection:[-.8,.6,1.1],sunRadiance:[2,2,2],skyRadiance:[.15,.18,.22],bounces:3,environmentMode:"upper-hemisphere"};
let descriptor=createBallPool({count:Number(params.get("count")??64),seed:Number(params.get("seed")??19),segments:Number(params.get("segments")??24)}),
  physics,model,asset,generation=0,phase="frozen-pending",playing=false,disposed=false,dirty=true,pending,poseKey,
  lastTick,modelBuilds=0,worldBuilds=0,tossId=0,failNext=false;
const pendingModels=new Set(),loadingCancels=new Set(),urls=new Set(),events=[],latencies=[],errors=[],resources={peakAdditionalBytes:0,peakSceneBytes:0};
const labels={"static-ready":"静态 GI 就绪","physics-preview":"物理预览：局部 GI 暂停","frozen-pending":"姿态已暂停；需要定格并更新 GI",
  "building-world":"定格姿态：正在构建新几何快照","lighting":"定格姿态：正在求解间接光","converging":"定格姿态：FG 正在收敛",
  "failed":"更新失败：基础照明预览","cancelled":"旧请求已取消","disposed":"场景已释放"};
const setPhase=(next,own=generation)=>{if(own!==generation||disposed)return;phase=next;
  events.push({phase:next,generation,at:performance.now(),worldGeneration:scene.lumen.world?._ballpoolGeneration??null});
  if(events.length>256)events.shift();$("state").textContent=`${labels[next]} · 几何 ${generation}`;};
function resourceMetrics() {
  const w=scene.lumen.world,models=new Set([model,...pendingModels].filter(Boolean));
  const environmentTextures=new Set([...models].flatMap(m=>{const e=m.environmentMapManager;return [e?.radianceCubeMap,...(e?._radianceMapTextures??[]),...(e?._specularMapTextures??[]),e?._irradianceMapTexture].filter(Boolean);}));
  const environmentGpuBytes=[...environmentTextures].reduce((sum,t)=>sum+(t.sizeInBytes??0),0),
    modelGpuBytes=[...models].reduce((sum,m)=>sum+(m.statistics?.geometryByteLength??0)+(m.statistics?.texturesByteLength??0),0),
    worldGeometryBytes=[w?._nodes,w?._vertices,w?._uv,w?._atlas,w?._materials].reduce((sum,t)=>sum+(t?.sizeInBytes??0),0),
    assetCpuBytes=[...urls].reduce((sum,u)=>sum+u.bytes,0),
    workerCpuBytes=w?.packet?.bvh?.cpuRetainedBytes??0,
    mainWorldCpuBytes=(w?._order?.byteLength??0)+(w?._baseMaterials?.byteLength??0),
    physicsWasmReservedBytes=physics?.memoryBytes??0,
    sceneBytes=modelGpuBytes+worldGeometryBytes+environmentGpuBytes+assetCpuBytes+workerCpuBytes+mainWorldCpuBytes+physicsWasmReservedBytes,
    total=sceneBytes+(fg.metrics.memoryBytes??0)+(fg.metrics.snapshotBytes??0);
  resources.peakSceneBytes=Math.max(resources.peakSceneBytes,sceneBytes);resources.peakAdditionalBytes=Math.max(resources.peakAdditionalBytes,total);
  return {modelGpuBytes,worldGeometryBytes,environmentGpuBytes,assetCpuBytes,workerCpuBytes,mainWorldCpuBytes,physicsWasmReservedBytes,sceneBytes,fgBytes:fg.metrics.memoryBytes??0,
    snapshots:fg.metrics.snapshotBytes??0,totalAdditionalBytes:total,...resources,
    worldGpuBytes:w?.memoryBytes??0,driverVram:"not-run",wasmHeap:physicsWasmReservedBytes?"measured reserved linear memory":"not-run",workerJsHeap:"not-run"};
}
Object.defineProperty(fg,"additionalSceneBytes",{get:()=>resourceMetrics().sceneBytes,configurable:true});
function invalidate() {
  ++generation;fg.release();fg.model=undefined;scene.lumen.enabled=false;
  for(const cancel of [...loadingCancels])cancel();
  const old=scene.lumen.world;scene.lumen.world=undefined;old?.destroy();
  fg.metrics.snapshotBytes=0;
  fg.metrics.effectiveMode="preview";fg.metrics.status="local GI invalidated for physics/frozen rebuild";
  if(model)model.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(1,1);
  dirty=true;pending=undefined;poseKey=undefined;scene.requestRender();
}
function syncDisplay() {
  if(!model?.ready)return;
  for(const b of descriptor.balls) {
    const node=model.getNode(`ball-${b.ballId}`);if(!node)throw Error("Missing shared descriptor node");
    node.matrix=C.Matrix4.fromTranslationQuaternionRotationScale(C.Cartesian3.fromArray(b.position),
      new C.Quaternion(...b.rotation),new C.Cartesian3(b.radius,b.radius,b.radius));
  }
  scene.requestRender();
}
function pause(){playing=false;lastTick=undefined;if(phase==="physics-preview")setPhase("frozen-pending");}
function play(){if(disposed||!physics)return;invalidate();playing=true;physics.wake();setPhase("physics-preview");}
function toss(){if(!playing)play();physics.toss(descriptor.balls[(tossId++)%descriptor.balls.length].ballId);syncDisplay();}
function light() {
  const d=C.Cartesian3.negate(C.Cartesian3.normalize(C.Cartesian3.fromArray(lighting.sunDirection),new C.Cartesian3()),new C.Cartesian3());
  scene.light=new C.DirectionalLight({direction:C.Matrix3.multiplyByVector(rotation,d,new C.Cartesian3()),color:new C.Color(...lighting.sunRadiance),intensity:1});
  const changed=environment.update(lighting);if(changed&&model?.environmentMapManager.enabled)model.environmentMapManager.reset();scene.requestRender();
}
function camera(name) {
  scene.camera.cancelFlight();
  if(name==="earth"){scene.camera.setView({destination:C.Cartesian3.fromDegrees(114.1,22.3,22000000)});return;}
  const eye=C.Cartesian3.fromArray(name==="close"?[-1.8,-2.9,1.6]:[8,-10,8]),
    target=C.Cartesian3.fromArray(name==="close"?[0,0,.65]:[0,0,.4]),
    d=C.Cartesian3.normalize(C.Cartesian3.subtract(target,eye,new C.Cartesian3()),new C.Cartesian3()),
    right=C.Cartesian3.normalize(C.Cartesian3.cross(d,C.Cartesian3.UNIT_Z,new C.Cartesian3()),new C.Cartesian3()),
    up=C.Cartesian3.cross(right,d,new C.Cartesian3());
  scene.camera.setView({destination:C.Matrix4.multiplyByPoint(frame,eye,new C.Cartesian3()),orientation:{
    direction:C.Matrix3.multiplyByVector(rotation,d,new C.Cartesian3()),up:C.Matrix3.multiplyByVector(rotation,up,new C.Cartesian3())}});
}
function releaseAsset(a){if(a&&urls.delete(a))URL.revokeObjectURL(a.url);}
async function rebuild(captured,own) {
  const started=performance.now(),encoded=ballPoolGltf(captured),json=JSON.stringify(encoded.gltf),
    blob=new Blob([json],{type:"model/gltf+json"}),owned={url:URL.createObjectURL(blob),bytes:blob.size};
  urls.add(owned);let fresh,w;
  try {
    if(failNext){failNext=false;throw Error("injected snapshot build failure");}
    fresh=await C.Model.fromGltfAsync({url:owned.url,modelMatrix:frame,upAxis:C.Axis.Z,forwardAxis:C.Axis.X,
      shadows:C.ShadowMode.ENABLED,incrementallyLoadTextures:false,environmentMapOptions:{enabled:true,generateSphericalHarmonics:false,mipmapLevels:7}});
    pendingModels.add(fresh);fresh._lumenCurvedSurfaces=new Map(captured.balls.map(b=>[`ball-${b.ballId}`,b]));
    fresh._ballpoolGeneration=own;fresh.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(1,1);
    if(own!==generation||disposed){fresh.destroy();pendingModels.delete(fresh);releaseAsset(owned);return {cancelled:true};}
    scene.primitives.add(fresh);await new Promise((resolve,reject)=>{
      if(fresh.ready){resolve();return;}
      const cleanup=()=>{removeReady();removeError();loadingCancels.delete(cancel);},
        cancel=()=>{cleanup();reject(Error("cancelled model generation"));},
        removeReady=fresh.readyEvent.addEventListener(()=>{cleanup();resolve();}),
        removeError=fresh.errorEvent.addEventListener(e=>{cleanup();reject(e);});
      loadingCancels.add(cancel);
    });
    if(own!==generation||disposed){scene.primitives.remove(fresh);pendingModels.delete(fresh);releaseAsset(owned);return {cancelled:true};}
    const previous=model,oldAsset=asset;model=fresh;asset=owned;pendingModels.delete(fresh);modelBuilds++;
    resourceMetrics();if(previous)scene.primitives.remove(previous);releaseAsset(oldAsset);
    fg.model=fresh;
    w=scene.lumen.loadWorld({backend:"gpu",url:owned.url,workerUrl:new URL("../lumen/gpu-worker.js",import.meta.url).href,
      modelMatrix:frame,axisMatrix:C.Matrix4.toArray(fresh._sceneGraph.axisCorrectionMatrix),
      spacing:2,rays:128,bounces:3,maxBatch:128,targetGpuMilliseconds:3,captureFinalGather:true,...lighting});
    w._ballpoolGeneration=own;worldBuilds++;setPhase("lighting",own);
    await w.completed;
    if(own!==generation||disposed||scene.lumen.world!==w){return {cancelled:true};}
    dirty=false;scene.lumen.enabled=true;fresh.imageBasedLighting.imageBasedLightingFactor=new C.Cartesian2(0,1);
    setPhase(fg.mode==="ddgi"?"static-ready":"converging",own);const latency={generation:own,count:captured.balls.length,triangles:encoded.triangles,
      modelAndWorldMilliseconds:performance.now()-started,started,lightingFinished:performance.now(),
      resource:resourceMetrics(),geometryHash:await descriptorHash(captured)};
    latencies.push(latency);scene.requestRender();return latency;
  } catch(e) {
    if(own!==generation||disposed){
      if(fresh&&fresh!==model&&!fresh.isDestroyed()){scene.primitives.remove(fresh);if(!fresh.isDestroyed())fresh.destroy();}
      pendingModels.delete(fresh);if(asset!==owned)releaseAsset(owned);return {cancelled:true};
    }
    if(w&&scene.lumen.world===w){scene.lumen.world=undefined;w.destroy();}
    fg.release();scene.lumen.enabled=false;
    if(fresh&&fresh!==model&&!fresh.isDestroyed()){scene.primitives.remove(fresh);if(!fresh.isDestroyed())fresh.destroy();}
    pendingModels.delete(fresh);if(asset!==owned)releaseAsset(owned);
    setPhase("failed",own);const message=String(e.message??e);errors.push({generation:own,message});$("error").textContent=message;throw e;
  }
}
function freeze() {
  if(disposed)return Promise.reject(Error("Ball Pool disposed"));
  pause();physics.capture();syncDisplay();
  const key=JSON.stringify(descriptor.balls);
  if(pending&&poseKey===key)return pending;
  if(!dirty&&scene.lumen.world?.ready)return Promise.resolve({unchanged:true});
  invalidate();const own=generation,captured=structuredClone(descriptor);captured.generation=own;descriptor.generation=own;
  poseKey=key;setPhase("frozen-pending");setPhase("building-world");
  const request=rebuild(captured,own);pending=request;
  const clear=()=>{if(pending===request)pending=undefined;};request.then(clear,clear);return request;
}
async function reset(count=Number($("count").value)) {
  pause();invalidate();physics?.destroy();physics=undefined;descriptor=createBallPool({count,seed:descriptor.seed,segments:descriptor.segments});
  const own=generation,freshPhysics=await BallPoolPhysics.create(descriptor);
  if(own!==generation||disposed){freshPhysics.destroy();return;}
  physics=freshPhysics;
  $("count").value=String(count);await freeze();
}
async function configureQuality(quality){await fg.configure({model,quality,smoothReceivers:true,sampling:"reconstructed"});$("fgQuality").value=quality;scene.requestRender();}
async function relight(changes={}) {
  Object.assign(lighting,changes);light();
  const w=scene.lumen.world;if(dirty||!w?.ready||playing)return;
  scene.lumen.enabled=false;fg.release();setPhase("lighting");const own=generation;
  await w.solve({...lighting,publicationMode:"snapshot"});
  if(own===generation&&scene.lumen.world===w){scene.lumen.enabled=true;setPhase("converging");}
}
async function descriptorHash(d=descriptor){const bytes=new TextEncoder().encode(JSON.stringify(d));return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");}
function snapshot(){return {phase,generation,playing,dirty,modelBuilds,worldBuilds,descriptor:structuredClone(descriptor),
  worldGeneration:scene.lumen.world?._ballpoolGeneration??null,modelGeneration:model?._ballpoolGeneration??null,
  worldRevision:scene.lumen.world?.requestedRevision??null,snapshotRevision:scene.lumen.world?.finalGatherSnapshot?.revision??null,
  historyFrames:fg.reconstruction?.frames??0,fg:{...fg.metrics},resources:resourceMetrics(),events:[...events],latencies:[...latencies],errors:[...errors]};}
function dispose(){if(disposed)return;pause();invalidate();disposed=true;phase="disposed";physics?.destroy();
  for(const fresh of pendingModels){if(!fresh.isDestroyed()){scene.primitives.remove(fresh);if(!fresh.isDestroyed())fresh.destroy();}}
  pendingModels.clear();if(model&&!model.isDestroyed())scene.primitives.remove(model);model=undefined;
  for(const a of [...urls])releaseAsset(a);widget.destroy();}
scene.preUpdate.addEventListener(()=>{
  if(!playing)return;const now=performance.now();physics.advance(lastTick===undefined?0:(now-lastTick)/1000);lastTick=now;syncDisplay();
});
scene.postRender.addEventListener(()=>{
  if(disposed)return;resourceMetrics();
  if(phase==="converging"&&fg.ready&&fg._stableFrames>=(fg.reconstruction?.targetFrames??32)) {
    setPhase("static-ready");const l=latencies.at(-1);if(l&&l.generation===generation&&!l.convergedMilliseconds)l.convergedMilliseconds=performance.now()-l.started;
  }
  $("metrics").textContent=`请求 ${fg.mode} / ${fg.quality} · 实际 ${fg.metrics.effectiveMode??"preview"}\n${scene.drawingBufferWidth}×${scene.drawingBufferHeight} → ${fg.metrics.receiverResolution?.join("×")??"…"}\n${fg.samples??0}r · epoch ${fg.metrics.sampleEpoch??0} · 历史 ${fg._stableFrames}\n${fg.metrics.status}\n附加峰值 ${(resources.peakAdditionalBytes/1048576).toFixed(2)} / 64 MiB\n球 ${descriptor.balls.length} · 步数 ${physics?.ticks??0}\n回退 ${fg.metrics.fallbackReason??fg.fallbackReason}`;
});
for(const b of document.querySelectorAll("[data-camera]"))b.onclick=()=>camera(b.dataset.camera);
const catchUI=f=>()=>Promise.resolve().then(f).catch(e=>{$("error").textContent=String(e.message??e);});
$("play").onclick=play;$("pause").onclick=pause;$("toss").onclick=toss;$("freeze").onclick=catchUI(freeze);$("reset").onclick=catchUI(()=>reset());
$("count").onchange=catchUI(()=>reset());$("fgQuality").onchange=catchUI(()=>configureQuality($("fgQuality").value));
$("compare").onchange=catchUI(async()=>{const v=$("compare").value;scene.lumen.debugMode=v==="without"?11:0;
  await fg.configure({mode:v==="ddgi"?"ddgi":"fg",model});if(!dirty&&phase==="converging"&&v==="ddgi")setPhase("static-ready");});
$("debug").onchange=()=>{scene.lumen.debugMode=Number($("debug").value);};
$("sun").onchange=catchUI(()=>{const a=Number($("sun").value)*Math.PI/180;return relight({sunDirection:[Math.cos(a),Math.sin(a),1.1]});});
$("sky").onchange=catchUI(()=>{const x=Number($("sky").value);return relight({skyRadiance:[x*.83,x,x*1.22]});});
$("capture").onclick=catchUI(async()=>{const {captureCurved}=await import("./curved-diagnostics.js");$("coverage").textContent=JSON.stringify(captureCurved(window.ballPool),null,2);});
window.ballPool={widget,scene,frame,lighting,play,pause,toss,freeze,reset,camera,relight,configureQuality,snapshot,dispose,
  get world(){return scene.lumen.world;},get model(){return model;},get descriptor(){return descriptor;},get physics(){return physics;},
  step(n=1){if(!playing)play();for(let i=0;i<n;i++)physics.step();syncDisplay();},
  injectBuildFailure(){failNext=true;},descriptorHash};
window.earthLab=window.ballPool;
addEventListener("pagehide",dispose,{once:true});
try {
  scene.imageryLayers.addImageryProvider(await C.TileMapServiceImageryProvider.fromUrl("../cesium-1.146/Build/CesiumUnminified/Assets/Textures/NaturalEarthII"));
  light();camera(params.get("camera")??"overview");$("fgQuality").value=fg.quality;$("count").value=String(descriptor.balls.length);
  physics=await BallPoolPhysics.create(descriptor);await freeze();
} catch(e){$("error").textContent=String(e.message??e);}
