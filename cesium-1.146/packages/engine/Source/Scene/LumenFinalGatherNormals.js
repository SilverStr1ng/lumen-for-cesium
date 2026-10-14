// Scoped convex-sphere receiver guides. No extra attachment or sampler.
export const declarations = "uniform bool u_lumenFgPackedNormals;\n";
export const functions = `
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
bool lumen_fgCurve(vec4 p){return u_lumenFgPackedNormals&&p.a>=4096.0;}
bool lumen_fgCompatible(vec4 p,vec4 n,vec4 q,vec4 hn,float footprint){
 if(p.a<.5||abs(p.a-q.a)>.1)return false;
 vec3 ng=lumen_fgNg(n),g=lumen_fgNg(hn),ns=lumen_fgNs(n),s=lumen_fgNs(hn),delta=q.xyz-p.xyz;
 if(length(delta)>footprint)return false;
 if(!lumen_fgCurve(p))return dot(ns,s)>=.995&&dot(ng,g)>=.995&&abs(dot(delta,ng))<=.005;
 if(dot(ns,s)<.95||dot(ng,g)<.8660253||dot(ng,ns)<.8660253||dot(g,s)<.8660253)return false;
 // Registered topology: radius .34m, >=16 longitude / 8 latitude divisions.
 // A chord of the triangulated sphere has unequal endpoint radii. Its radial
 // normals predict centers within the polygon sag plus measured FP16 error:
 // .34*(1-cos(sqrt(2)*pi/16)) + .0015 < .0146m at either endpoint.
 // This bound applies only to the same registered convex owner, never planes.
 vec3 centerA=p.xyz-.34*ns,centerB=q.xyz-.34*s;
 return length(centerA-centerB)<=.0292;
}
`;
export default { declarations, functions };
