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
 if(length(delta)>footprint||dot(ns,s)<.995)return false;
 if(!lumen_fgCurve(p))return dot(ng,g)>=.995&&abs(dot(delta,ng))<=.005;
 if(dot(ng,g)<.95||dot(ng,ns)<.8660253||dot(g,s)<.8660253)return false;
 // For the registered convex sphere, radial normals must follow the chord.
 // The symmetric tangent test is independent of triangle Ng discontinuities.
 if(abs(dot(delta,normalize(ns+s)))>.001)return false;
 vec3 dn=s-ns;float dn2=dot(dn,dn);
 if(dn2<1e-10)return length(delta)<.0005;
 float radius=dot(delta,dn)/dn2;
 return radius>=.20&&radius<=.50&&length(delta-radius*dn)<.001;
}
`;
export default { declarations, functions };
