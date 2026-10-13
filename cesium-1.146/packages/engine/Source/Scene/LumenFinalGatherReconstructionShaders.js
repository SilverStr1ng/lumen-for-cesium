import { declarations, functions } from "./LumenFinalGatherGeometry.js";
const geometry = declarations + functions;
export const temporal = `${geometry}precision highp float;
precision highp sampler2D;
uniform sampler2D u_rRaw,u_rPosition,u_rNormal,u_rNeighborhood;
uniform sampler2D u_rHistoryE,u_rHistoryM,u_rHistoryP,u_rHistoryN;
uniform mat4 u_rPreviousVP,u_rLocalToEye;
uniform ivec2 u_rOffset;
uniform bool u_rHistoryValid,u_rNewInformation;
uniform float u_rMaxFrames;
layout(location=0) out vec4 out_FragData_0;
layout(location=1) out vec4 out_FragData_1;
layout(location=2) out vec4 out_FragData_2;
layout(location=3) out vec4 out_FragData_3;
float rLuma(vec3 x){return dot(x,vec3(.2126,.7152,.0722));}
void main(){
 ivec2 c=ivec2(gl_FragCoord.xy),size=textureSize(u_rRaw,0),r=c+u_rOffset;
 vec4 raw=texelFetch(u_rRaw,c,0),p=texelFetch(u_rPosition,r,0),n=texelFetch(u_rNormal,r,0);
 out_FragData_2=p;out_FragData_3=vec4(n.xyz,0);
 out_FragData_0=vec4(0);out_FragData_1=vec4(0,0,0,4);
 if(raw.a<.5||p.a<.5)return;
 float l=rLuma(raw.rgb);
 // FP16 E and second moment must be representable. Raw FLOAT is never clipped.
 if(any(greaterThan(abs(raw.rgb),vec3(60000)))||!(l<200.0)){out_FragData_1.w=5.0;return;}
 vec3 oldE=vec3(0);vec2 oldM=vec2(0);float oldLength=0.0,total=0.0,reason=1.0;
 vec4 clip=u_rPreviousVP*vec4(p.xyz,1);
 // Unsafe reference footprints require an explicit world segment.
 if(u_rHistoryValid&&clip.w>0.0){
  vec2 pixel=(clip.xy/clip.w*.5+.5)*vec2(textureSize(u_rPosition,0))-vec2(u_rOffset)-.5;
  ivec2 base=ivec2(floor(pixel));vec2 fraction=fract(pixel);
  reason=2.0;
  float footprint=max(.04,2.0*czm_metersPerPixel(u_rLocalToEye*vec4(p.xyz,1),1.0));
  for(int y=0;y<2;y++)for(int x=0;x<2;x++){
   ivec2 q=base+ivec2(x,y);if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,size)))continue;
   vec4 e=texelFetch(u_rHistoryE,q,0),hp=texelFetch(u_rHistoryP,q,0),hn=texelFetch(u_rHistoryN,q,0);
   vec3 delta=hp.xyz-p.xyz;
   reason=3.0;
   if(e.a<.5||abs(hp.a-p.a)>.1||dot(hn.xyz,n.xyz)<.995||abs(dot(delta,n.xyz))>.005||length(delta)>footprint)continue;
   if(texelFetch(u_rNeighborhood,c,0).r<.5&&!lumen_fgSegment(p.xyz,hp.xyz,n.xyz))continue;
   vec2 a=mix(1.0-fraction,fraction,vec2(x,y));float w=a.x*a.y;
   oldE+=e.rgb*w;oldM+=texelFetch(u_rHistoryM,q,0).xy*w;oldLength+=e.a*w;total+=w;
  }
 }
 float lengthNow=1.0;vec3 E=raw.rgb;
 vec2 M=vec2(l,l*l);
 float variance=max(.01,l*l*.5);
 if(total>.0001){
  oldE/=total;oldM/=total;oldLength/=total;reason=0.0;
  // Static source/geometry validation already rejects stale history. A single
  // noisy sample must never clamp the old mean toward itself: that would
  // amplify rare emitter hits and make E inconsistent with its moments.
  lengthNow=u_rNewInformation?min(oldLength+1.0,u_rMaxFrames):oldLength;
  float a=u_rNewInformation?1.0/lengthNow:0.0;
  E=mix(oldE,raw.rgb,a);M=mix(oldM,vec2(l,l*l),a);
  variance=max(0.0,M.y-M.x*M.x)/max(1.0,lengthNow);
 }
 out_FragData_0=vec4(E,lengthNow);
 out_FragData_1=vec4(M,variance,reason);
}`;
export const connections = `${
  geometry
}precision highp float;precision highp sampler2D;
uniform sampler2D u_rRaw,u_rPosition,u_rNormal;
uniform ivec2 u_rOffset;
void main(){
 ivec2 c=ivec2(gl_FragCoord.xy),size=textureSize(u_rRaw,0);vec4 p=texelFetch(u_rPosition,c+u_rOffset,0),n=texelFetch(u_rNormal,c+u_rOffset,0);
 vec4 links=vec4(0);if(p.a<.5||texelFetch(u_rRaw,c,0).a<.5){out_FragColor=links;return;}
 for(int i=0;i<4;i++){
  ivec2 dir=i==0?ivec2(1,0):i==1?ivec2(-1,0):i==2?ivec2(0,1):ivec2(0,-1),q=c+dir;
  if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,size)))continue;
  vec4 hp=texelFetch(u_rPosition,q+u_rOffset,0),hn=texelFetch(u_rNormal,q+u_rOffset,0);
  if(texelFetch(u_rRaw,q,0).a<.5||abs(hp.a-p.a)>.1||dot(hn.xyz,n.xyz)<.995||abs(dot(hp.xyz-p.xyz,n.xyz))>.005)continue;
  links[i]=lumen_fgSegment(p.xyz,hp.xyz,n.xyz)?1.0:0.0;
 }out_FragColor=links;
}`;
export const spatial = `
precision highp float;precision highp sampler2D;
uniform sampler2D u_rInput,u_rMoments,u_rPosition,u_rNormal,u_rConnections;
uniform ivec2 u_rOffset;
uniform int u_rStep;
float rLuma(vec3 x){return dot(x,vec3(.2126,.7152,.0722));}
void main(){
 ivec2 c=ivec2(gl_FragCoord.xy),size=textureSize(u_rInput,0);vec4 e=texelFetch(u_rInput,c,0);
 if(e.a<.5){out_FragColor=vec4(0);return;}
 vec4 p=texelFetch(u_rPosition,c+u_rOffset,0),n=texelFetch(u_rNormal,c+u_rOffset,0),m=texelFetch(u_rMoments,c,0);
 float variance=max(m.z,.0001),lum=rLuma(e.rgb);vec3 sum=e.rgb;float total=1.0;
 for(int i=0;i<4;i++){
  ivec2 dir=i==0?ivec2(1,0):i==1?ivec2(-1,0):i==2?ivec2(0,1):ivec2(0,-1),q=c+dir*u_rStep;
  if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,size)))continue;
  bool connected=true;for(int j=0;j<2;j++){if(j>=u_rStep)break;if(texelFetch(u_rConnections,c+dir*j,0)[i]<.5)connected=false;}
  if(!connected)continue;
  vec4 a=texelFetch(u_rInput,q,0),hp=texelFetch(u_rPosition,q+u_rOffset,0),hn=texelFetch(u_rNormal,q+u_rOffset,0),hm=texelFetch(u_rMoments,q,0);
  if(a.a<.5||abs(hp.a-p.a)>.1||dot(hn.xyz,n.xyz)<.995||abs(dot(hp.xyz-p.xyz,n.xyz))>.005)continue;
  float sigma=sqrt(variance+max(hm.z,.0001));
  // Wide uncertainty for fresh histories; mature estimates preserve E gradients.
  if(min(a.a,e.a)<4.0)sigma=max(sigma,.25*max(lum,rLuma(a.rgb))+.02);
  float w=.5*exp(-abs(rLuma(a.rgb)-lum)/(4.0*sigma+.005));
  sum+=a.rgb*w;total+=w;
 }out_FragColor=vec4(sum/total,e.a);
}`;
export default { temporal, connections, spatial };
