import normals from "./LumenFinalGatherNormals.js";
export const declarations = `${normals.declarations}uniform sampler2D u_lumenFgNodes,u_lumenFgVertices;uniform int u_lumenFgNodeCount,u_lumenFgBarrierBudget;
`;
export const functions = `${normals.functions}
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
   // Conservative opaque geometry barriers also reject alpha-mask triangles.
   // This may reject a transparent texel, but cannot borrow through a thin wall.
   if(t>0.00001&&t<distance)return false;
  }node=int(lo.w);
 }return false;
}`;
export default { declarations, functions };
