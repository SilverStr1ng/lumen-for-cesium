// Explicit synchronous validation only. Never imported by the render loop.
const decode=(x,y)=>{x=x*2-1;y=y*2-1;let z=1-Math.abs(x)-Math.abs(y);
  if(z<0){const a=x;x=(1-Math.abs(y))*(a>=0?1:-1);y=(1-Math.abs(a))*(y>=0?1:-1);}
  const l=Math.hypot(x,y,z);return [x/l,y/l,z/l];};
export function captureCurved(lab) {
  const fg=lab.scene.lumen.finalGather,w=lab.world;
  if(!fg.ready||!w?.ready)throw Error(`Curved capture unavailable: ${fg.metrics.status}`);
  const previousLoop=lab.widget.useDefaultRenderLoop,previousDebug=lab.scene.lumen.debugMode,previousFreeze=fg.freezeSampling;
  lab.widget.useDefaultRenderLoop=false;fg.freezeSampling=true;
  try {
    const width=lab.scene.drawingBufferWidth,height=lab.scene.drawingBufferHeight;
    const frame=mode=>{lab.scene.lumen.debugMode=mode;lab.widget.render();const f=lab.scene._view.sceneFramebuffer._colorFramebuffer,
      fb=f._multisampleFramebuffer?.getColorFramebuffer()??f.framebuffer;return w._read(fb,width,height);};
    const mask=frame(18),weights=frame(15),reasons=frame(17),owners=frame(19);
    const [rw,rh]=fg.metrics.receiverResolution,[fw,fh]=fg.metrics.resolution,
      p=w._read(fg.receiver.framebuffer,rw,rh,0),n=w._read(fg.receiver.framebuffer,rw,rh,1),
      raw=w._read(fg.ping.find(t=>t.texture===fg.texture).framebuffer,fw,fh),
      history=fg.reconstruction?.history[fg.reconstruction._index],
      hn=history?w._read(history.framebuffer,fw,fh,3):null,
      E=fg.reconstruction?.texture?(()=>{const targets=fg.reconstruction.filterTargets;
        return w._read(targets[1].framebuffer,fw,fh);})():raw;
    let pixels=0,total=0,inside=0,edge=0,edgeWeight=0,contact=0,contactWeight=0,unsupported=0;
    const angleBins=Array(7).fill(0),fallback={},points=[];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const i=(y*width+x)*4;if(owners[i]<128)continue;
      pixels++;total+=weights[i];if(mask[i+2]>.5)inside++;if(mask[i+1]>Math.PI/6)unsupported++;
      angleBins[Math.min(6,Math.floor(mask[i+1]*180/Math.PI/5))]++;
      const reason=Math.round(reasons[i]);fallback[reason]=(fallback[reason]??0)+1;
      let boundary=false,other=false;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height){boundary=true;continue;}
        const j=((y+dy)*width+x+dx)*4;if(owners[j]<128)boundary=true;
        if(owners[j]>.5&&Math.abs(owners[i]-owners[j])>.1)other=true;
      }
      if(boundary){edge++;edgeWeight+=weights[i];}if(other){contact++;contactWeight+=weights[i];}
    }
    let receivers=0,valid=0,maxHistoryNormalDegrees=0;
    for(let y=0;y<fh;y++)for(let x=0;x<fw;x++) {
      const i=(y*fw+x)*4,r=((y+fg.offset.y)*rw+x+fg.offset.x)*4;if(p[r+3]<4096)continue;
      receivers++;if(raw[i+3]>.5)valid++;
      const ng=decode(n[r],n[r+1]),ns=decode(n[r+2],n[r+3]);
      if(hn){const hng=decode(hn[i],hn[i+1]),hns=decode(hn[i+2],hn[i+3]);
        const angle=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((s,v,k)=>s+v*b[k],0))))*180/Math.PI;
        maxHistoryNormalDegrees=Math.max(maxHistoryNormalDegrees,angle(ng,hng),angle(ns,hns));}
      if(x%Math.max(1,Math.floor(fw/22))===0&&y%Math.max(1,Math.floor(fh/16))===0)
        points.push({pixel:[x,y],position:Array.from(p.slice(r,r+3)),geometricNormal:ng,normal:ns,
          owner:p[r+3],raw:Array.from(raw.slice(i,i+3)),E:Array.from(E.slice(i,i+3)),valid:raw[i+3]>.5});
    }
    return {generation:lab.snapshot().generation,revision:w.finalGatherSnapshot.revision,round:w.finalGatherSnapshot.round,
      seed:fg.seed,epoch:fg.metrics.sampleEpoch,receiver:[rw,rh],samples:fg.samples,resolution:[width,height],
      pixels,insideVolumePixels:inside,meanWeight:pixels?total/pixels:0,unsupportedPixels:unsupported,
      edgePixels:edge,edgeMeanWeight:edge?edgeWeight/edge:0,contactPixels:contact,contactMeanWeight:contact?contactWeight/contact:0,
      angleBins5Degrees:angleBins,fallback,receivers,validRawFraction:receivers?valid/receivers:0,maxHistoryNormalDegrees,points};
  } finally {lab.scene.lumen.debugMode=previousDebug;fg.freezeSampling=previousFreeze;lab.widget.useDefaultRenderLoop=previousLoop;lab.scene.requestRender();}
}
