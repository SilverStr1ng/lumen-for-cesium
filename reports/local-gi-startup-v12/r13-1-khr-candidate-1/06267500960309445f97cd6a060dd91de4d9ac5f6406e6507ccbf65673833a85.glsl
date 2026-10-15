#version 300 es

#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    precision highp int;
#else
    precision mediump float;
    precision mediump int;
    #define highp mediump
#endif
precision highp sampler3D;

#define OES_texture_float_linear

#define OES_texture_float


#line 0
layout(location = 0) out vec4 out_FragColor;



#line 0
uniform bool u_lumenFgPackedNormals;
uniform sampler2D u_lumenFgNodes,u_lumenFgVertices;uniform int u_lumenFgNodeCount,u_lumenFgBarrierBudget;

vec2 lumen_fgOct(vec3 v) {
 v/=dot(abs(v),vec3(1));
 if(v.z<0.0)v.xy=(1.0-abs(v.yx))*mix(vec2(-1),vec2(1),greaterThanEqual(v.xy,vec2(0)));
 return v.xy*.5+.5;
}
vec3 lumen_fgUnoct(vec2 v) {
 v=v*2.0-1.0;vec3 n=vec3(v,1.0-abs(v.x)-abs(v.y));
 if(n.z<0.0)n.xy=(1.0-abs(n.yx))*mix(vec2(-1),vec2(1),greaterThanEqual(n.xy,vec2(0)));
 return normalize(n);
}
vec3 lumen_fgNg(vec4 n){return u_lumenFgPackedNormals?lumen_fgUnoct(n.xy):normalize(n.xyz);}
vec3 lumen_fgNs(vec4 n){return u_lumenFgPackedNormals?lumen_fgUnoct(n.zw):normalize(n.xyz);}
vec4 lumen_fgPack(vec3 ng,vec3 ns,float owner){return u_lumenFgPackedNormals?vec4(lumen_fgOct(ng),lumen_fgOct(ns)):vec4(ng,owner);}
bool lumen_fgCurve(vec4 p){return u_lumenFgPackedNormals&&p.a>=4096.0&&p.a<8192.0;}
bool lumen_fgCompatible(vec4 p,vec4 n,vec4 q,vec4 hn,float footprint){
 if(p.a<.5||abs(p.a-q.a)>.1)return false;
 vec3 ng=lumen_fgNg(n),g=lumen_fgNg(hn),ns=lumen_fgNs(n),s=lumen_fgNs(hn),delta=q.xyz-p.xyz;
 if(length(delta)>footprint)return false;
 if(!lumen_fgCurve(p))return dot(ns,s)>=.995&&dot(ng,g)>=.995&&abs(dot(delta,ng))<=.005;
 if(dot(ns,s)<.95||dot(ng,g)<.8660253||dot(ng,ns)<.8660253||dot(g,s)<.8660253)return false;
 
 
 
 
 
 vec3 centerA=p.xyz-.34*ns,centerB=q.xyz-.34*s;
 return length(centerA-centerB)<=.0292;
}

vec4 lumen_fgFetch(sampler2D image,int i){int width=textureSize(image,0).x;return texelFetch(image,ivec2(i%width,i/width),0);}
bool lumen_fgBox(vec3 o,vec3 d,vec3 lo,vec3 hi,float distance){
 float a=0.0,b=distance;
 for(int axis=0;axis<3;axis++){
  if(abs(d[axis])<1e-8){if(o[axis]<lo[axis]||o[axis]>hi[axis])return false;}
  else{float x=(lo[axis]-o[axis])/d[axis],y=(hi[axis]-o[axis])/d[axis];a=max(a,min(x,y));b=min(b,max(x,y));}
 }return b>=a;
}
bool lumen_fgSegment(vec3 p,vec3 q,vec3 ng){
 vec3 delta=q-p;float distance=length(delta);
 if(distance<0.0004)return true;
 vec3 o=p+ng*0.0002,d=delta/distance;distance-=0.0002;
 int node=0;
 for(int visit=0;visit<256;visit++){
  if(node>=u_lumenFgNodeCount)return true;
  if(visit>=u_lumenFgBarrierBudget)return false;
  vec4 lo=lumen_fgFetch(u_lumenFgNodes,node*2),hi=lumen_fgFetch(u_lumenFgNodes,node*2+1);
  if(!lumen_fgBox(o,d,lo.xyz,hi.xyz,distance)){node=int(lo.w);continue;}
  if(hi.w<0.0){node++;continue;}
  int packed=int(hi.w),start=packed/16,count=packed%16;
  for(int j=0;j<8;j++){
   if(j>=count)break;int triangle=start+j;
   vec3 a=lumen_fgFetch(u_lumenFgVertices,triangle*3).xyz,e1=lumen_fgFetch(u_lumenFgVertices,triangle*3+1).xyz-a,e2=lumen_fgFetch(u_lumenFgVertices,triangle*3+2).xyz-a;
   vec3 crossDir=cross(d,e2);float determinant=dot(e1,crossDir);if(abs(determinant)<1e-9)continue;
   float inv=1.0/determinant;vec3 s=o-a;float u=dot(s,crossDir)*inv;
   if(u<0.0||u>1.0)continue;vec3 c=cross(s,e1);float v=dot(d,c)*inv;
   if(v<0.0||u+v>1.0)continue;float t=dot(e2,c)*inv;
   
   
   if(t>0.00001&&t<distance)return false;
  }node=int(lo.w);
 }return false;
}precision highp sampler2D;
uniform sampler2D u_rRaw,u_rPosition,u_rNormal;
uniform ivec2 u_rOffset;
void main(){
 ivec2 c=ivec2(gl_FragCoord.xy),size=textureSize(u_rRaw,0);vec4 p=texelFetch(u_rPosition,c+u_rOffset,0),n=texelFetch(u_rNormal,c+u_rOffset,0);
 vec4 links=vec4(0);if(p.a<.5||texelFetch(u_rRaw,c,0).a<.5){out_FragColor=links;return;}
 for(int i=0;i<4;i++){
  ivec2 dir=i==0?ivec2(1,0):i==1?ivec2(-1,0):i==2?ivec2(0,1):ivec2(0,-1),q=c+dir;
  if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,size)))continue;
  vec4 hp=texelFetch(u_rPosition,q+u_rOffset,0),hn=texelFetch(u_rNormal,q+u_rOffset,0);
  if(texelFetch(u_rRaw,q,0).a<.5||!lumen_fgCompatible(p,n,hp,hn,lumen_fgCurve(p)?.05:1e20)||dot(lumen_fgNs(n),lumen_fgNs(hn))<.995)continue;
  links[i]=(lumen_fgCurve(p)||lumen_fgSegment(p.xyz,hp.xyz,lumen_fgNg(n)))?1.0:0.0;
 }out_FragColor=links;
}