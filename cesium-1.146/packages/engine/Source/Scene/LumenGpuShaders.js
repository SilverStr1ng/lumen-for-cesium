import DeveloperError from "../../../core/Source/DeveloperError.js";
import finalGatherSampling from "./LumenFinalGatherSampling.js";
import receiverNormals from "./LumenFinalGatherNormals.js";
import LumenStageFS from "../Shaders/Model/LumenStageFS.js";

const worldUniforms = `
uniform sampler2D u_lumenProbeIrradiance;
uniform sampler2D u_lumenProbeDistances;
uniform sampler2D u_lumenProbePositions;
uniform mat4 u_lumenEyeToLocal;
uniform vec3 u_lumenProbeOrigin, u_lumenProbeCounts, u_lumenIrradiance;
uniform float u_lumenProbeSpacing, u_lumenNormalBias, u_lumenWorldGain, u_lumenCoverage;
uniform bool u_lumenWorldEnabled, u_lumenLinearAtlas;
uniform vec4 u_lumenGatherControl;
uniform bool u_lumenLegacyKernel;
`;
const common = `
precision highp sampler2D;
uniform sampler2D u_nodes, u_vertices, u_uv, u_materials, u_atlas;
uniform sampler2D u_hits, u_direct, u_cache, u_visibility, u_weights;
uniform int u_nodesCount, u_budget, u_rays, u_first;
uniform int u_tieRankOffset;
uniform vec3 u_sunDirection, u_sunRadiance, u_skyRadiance;
uniform ivec2 u_neutral;
uniform bool u_visibilityOptimized;
uniform bool u_queryAnyHit;
uniform bool u_queryStats;
// Production shaders preprocess all traversal counter writes away.
#ifdef LUMEN_QUERY_COUNTS
vec3 traversalCounts=vec3(0.0);
#define countNode() traversalCounts.x+=1.0
#define countTriangle() traversalCounts.y+=1.0
#define countAlpha() traversalCounts.z+=1.0
#else
#define countNode()
#define countTriangle()
#define countAlpha()
#endif
uniform int u_upperHemisphere;
vec4 fetch1(sampler2D t, int i) { int w=textureSize(t,0).x; return texelFetch(t,ivec2(i%w,i/w),0); }
vec4 mat(int m,int i) {return texelFetch(u_materials,ivec2(i,m),0);}
float wrapUV(float v, float mode) {
    if(mode==33071.0) return clamp(v,0.0,0.9999999);
    if(mode==33648.0) {v=mod(v,2.0);return v>1.0?2.0-v:v;}
    return fract(v);
}
vec2 wrap2(vec2 p,vec2 modes) {return vec2(wrapUV(p.x,modes.x),wrapUV(p.y,modes.y));}
vec4 image(int m,int slot,vec2 uv) {
    vec4 rect=mat(m,3+slot*3), transform=mat(m,4+slot*3), info=mat(m,5+slot*3);
    if(info.w<0.5) return vec4(1.0);
    uv*=transform.zw;
    uv=mat2(cos(info.x),sin(info.x),-sin(info.x),cos(info.x))*uv+transform.xy;
    vec2 p=wrap2(uv,info.yz)*rect.zw-0.5, f=fract(p), base=floor(p);
    vec4 c=vec4(0.0);
    for(int y=0;y<2;y++) for(int x=0;x<2;x++) {
        ivec2 pixel=ivec2(floor(wrap2((base+vec2(x,y)+0.5)/rect.zw,info.yz)*rect.zw));
        c+=texelFetch(u_atlas,ivec2(rect.xy)+pixel,0)*(x==0?1.0-f.x:f.x)*(y==0?1.0-f.y:f.y);
    }
    return c;
}
void triangle(int t,out vec3 a,out vec3 b,out vec3 c,out int m,out vec2 uv0,out vec4 uv12) {
    vec4 p=fetch1(u_vertices,t*3),q=fetch1(u_vertices,t*3+1),r=fetch1(u_vertices,t*3+2);
    a=p.xyz;b=q.xyz;c=r.xyz;m=int(p.w);uv0=vec2(q.w,r.w);uv12=fetch1(u_uv,t);
}
vec2 hitUV(vec2 uv0,vec4 uv12,vec2 bary) {return uv0*(1.0-bary.x-bary.y)+uv12.xy*bary.x+uv12.zw*bary.y;}
// SAH may visit coincident, oppositely wound surfaces in a different order.
// Only bit-exact distance ties use original median rank, never a distance epsilon.
float traversalRank(int t) {
    if(u_tieRankOffset<0) return float(t);
    return fetch1(u_uv,u_tieRankOffset+t/4)[t%4];
}
// Stackless pre-order traversal. An exhausted budget is Unknown (-1), never sky.
vec4 traceWithExitTies(vec3 origin,vec3 direction,float maximum,int ignore,bool anyHit,bool preferSolidExit) {
    int node=0;vec4 best=vec4(0.0,0.0,0.0,maximum);
    for(int visit=0;visit<4096;visit++) {
        if(node>=u_nodesCount) return best;
        if(visit>=u_budget) return vec4(-1.0,0.0,0.0,maximum);
        countNode();
        vec4 lo=fetch1(u_nodes,node*2),hi=fetch1(u_nodes,node*2+1);
        float near=0.0,far=best.w;
        for(int axis=0;axis<3;axis++) {
            if(abs(direction[axis])<1e-10) {if(origin[axis]<lo[axis]||origin[axis]>hi[axis]) far=-1.0;}
            else {float a=(lo[axis]-origin[axis])/direction[axis],b=(hi[axis]-origin[axis])/direction[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
        }
        if(far<near) {node=int(lo.w);continue;}
        if(hi.w<0.0) {node++;continue;}
        int packed=int(hi.w),start=packed/16,count=packed%16;
        for(int j=0;j<8;j++) {
            if(j>=count) break;int t=start+j;if(t==ignore) continue;countTriangle();
            vec3 a,b,c;int material;vec2 uv0;vec4 uv12;
            triangle(t,a,b,c,material,uv0,uv12);
            vec3 e1=b-a,e2=c-a,p=cross(direction,e2);float det=dot(e1,p);
            if(abs(det)<1e-10) continue;
            vec3 s=origin-a;float u=dot(s,p)/det;
            if(u<0.0||u>1.0) continue;
            vec3 q=cross(s,e1);float v=dot(direction,q)/det;
            if(v<0.0||u+v>1.0) continue;
            float d=dot(e2,q)/det;if(d<0.00001||d>best.w) continue;
            if(d==best.w) {
                if(best.x==0.0) continue;
                bool candidateExit=det<0.0 && mat(material,2).w>0.5;
                int previousMaterial=int(fetch1(u_vertices,(int(abs(best.x))-2)*3).w);
                bool previousExit=best.x < -1.0 && mat(previousMaterial,2).w>0.5;
                if(preferSolidExit && candidateExit!=previousExit) {if(!candidateExit) continue;}
                else if(traversalRank(t)>=traversalRank(int(abs(best.x))-2)) continue;
            }
            vec4 params=mat(material,1);
            if(params.w>0.5) {countAlpha();}
            if(params.w>0.5 && image(material,0,hitUV(uv0,uv12,vec2(u,v))).a*mat(material,0).a<params.y) continue;
            best=vec4((det<0.0?-1.0:1.0)*float(t+2),u,v,d);
            if(anyHit) return best;
        }
        node=int(lo.w);
    }
    return node>=u_nodesCount?best:vec4(-1.0,0.0,0.0,maximum);
}
// Ordinary transport and shadow rays retain the original exact-tie ordering.
vec4 trace(vec3 origin,vec3 direction,float maximum,int ignore,bool anyHit) {
    return traceWithExitTies(origin,direction,maximum,ignore,anyHit,false);
}
// Farthest root-box corner is a conservative complete local trace domain.
// This includes blockers beyond 100 metres and does not infer sky at a cutoff.
float completeDistance(vec3 origin) {
    vec3 lo=fetch1(u_nodes,0).xyz, hi=fetch1(u_nodes,1).xyz;
    return max(100.0,length(max(abs(lo-origin),abs(hi-origin)))+1.0);
}
// Exact any-hit: defer UV and alpha fetches until an accepted geometric hit.
vec4 occluded(vec3 origin,vec3 direction,float maximum,int ignore) {
    vec3 inverseDirection=vec3(0.0);
    for(int axis=0;axis<3;axis++) if(abs(direction[axis])>=1e-10) inverseDirection[axis]=1.0/direction[axis];
    int node=0;
    for(int visit=0;visit<4096;visit++) {
        if(node>=u_nodesCount) return vec4(0.0,0.0,0.0,maximum);
        if(visit>=u_budget) return vec4(-1.0,0.0,0.0,maximum);
        countNode();
        vec4 lo=fetch1(u_nodes,node*2),hi=fetch1(u_nodes,node*2+1);
        float near=0.0,far=maximum;
        for(int axis=0;axis<3;axis++) {
            if(abs(direction[axis])<1e-10) {if(origin[axis]<lo[axis]||origin[axis]>hi[axis]) far=-1.0;}
            else {float a=(lo[axis]-origin[axis])*inverseDirection[axis],b=(hi[axis]-origin[axis])*inverseDirection[axis];near=max(near,min(a,b));far=min(far,max(a,b));}
        }
        if(far<near) {node=int(lo.w);continue;}
        if(hi.w<0.0) {node++;continue;}
        int packed=int(hi.w),start=packed/16,count=packed%16;
        for(int j=0;j<8;j++) {
            if(j>=count) break;int t=start+j;if(t==ignore) continue;countTriangle();
            vec4 a=fetch1(u_vertices,t*3),b=fetch1(u_vertices,t*3+1),c=fetch1(u_vertices,t*3+2);
            vec3 e1=b.xyz-a.xyz,e2=c.xyz-a.xyz,p=cross(direction,e2);float det=dot(e1,p);
            if(abs(det)<1e-10) continue;
            vec3 delta=origin-a.xyz;float u=dot(delta,p)/det;
            if(u<0.0||u>1.0) continue;
            vec3 q=cross(delta,e1);float v=dot(direction,q)/det;
            if(v<0.0||u+v>1.0) continue;
            float d=dot(e2,q)/det;if(d<0.00001||d>=maximum) continue;
            int material=int(a.w);vec4 params=mat(material,1);
            if(params.w>0.5) {countAlpha();}
            if(params.w>0.5 && image(material,0,hitUV(vec2(b.w,c.w),fetch1(u_uv,t),vec2(u,v))).a*mat(material,0).a<params.y) continue;
            return vec4((det<0.0?-1.0:1.0)*float(t+2),u,v,d);
        }
        node=int(lo.w);
    }
    return vec4(node>=u_nodesCount?0.0:-1.0,0.0,0.0,maximum);
}
vec3 rayDirection(int i) {
    float z=1.0-2.0*(float(i)+0.5)/float(u_rays),a=float(i)*2.399963229728653;
    float r=sqrt(max(0.0,1.0-z*z));return vec3(cos(a)*r,sin(a)*r,z);
}
vec3 linearRGB(vec3 c) {return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c));}
void surface(vec4 hit,out vec3 position,out vec3 normal,out vec3 albedo,out vec3 emission,out int t,out bool black) {
    t=int(abs(hit.x))-2;vec3 a,b,c;int m;vec2 uv0;vec4 uv12;
    triangle(t,a,b,c,m,uv0,uv12);
    position=a*(1.0-hit.y-hit.z)+b*hit.y+c*hit.z;
    normal=normalize(cross(b-a,c-a));black=hit.x<0.0&&mat(m,1).z<0.5;
    if(hit.x<0.0) normal=-normal;
    vec2 uv=hitUV(uv0,uv12,hit.yz);
    albedo=linearRGB(image(m,0,uv).rgb)*mat(m,0).rgb*(1.0-mat(m,1).x*image(m,1,uv).b);
    if(m==u_neutral.x||m==u_neutral.y) albedo=vec3(dot(albedo,vec3(1.0/3.0)));
    emission=linearRGB(image(m,2,uv).rgb)*mat(m,2).rgb;
}
`;
const gather = `#define LUMEN_WORLD_SUPPORTED\nprecision highp sampler2D;\n${worldUniforms}\n${LumenStageFS}`;
export const relocate = `${common + worldUniforms}
void main() {
    ivec2 c=ivec2(gl_FragCoord.xy);int nx=int(u_lumenProbeCounts.x);
    vec3 logical=u_lumenProbeOrigin+vec3(c.x%nx,c.x/nx,c.y)*u_lumenProbeSpacing;
    vec3 p=logical;bool safe=true;
    for(int attempt=0;attempt<3;attempt++) {
        float closest=1e20;vec3 shift=vec3(0.0);
        for(int j=0;j<6;j++) {
            vec3 d=vec3(0.0);d[j/2]=(j%2==0?1.0:-1.0);
            // Do not oscillate back into an already exited touching solid.
            if(dot(d,p-logical)<-0.000001) continue;
            vec4 h=traceWithExitTies(p,d,u_lumenProbeSpacing*0.3,-1,false,true);
            if(h.x < -1.0 && h.w<closest) {
                vec3 a,b,cc;int m;vec2 uv0;vec4 uv12;triangle(int(-h.x)-2,a,b,cc,m,uv0,uv12);
                if(mat(m,2).w>0.5) {closest=h.w;shift=normalize(cross(b-a,cc-a))*(h.w+0.08);}
            }
        }
        if(closest==1e20) break;
        vec3 candidate=p+shift,n=normalize(shift);float distance=length(shift);
        if(length(candidate-logical)>u_lumenProbeSpacing*0.45) {safe=false;break;}
        vec4 h=traceWithExitTies(p,n,distance,-1,false,true);
        if(h.x>=-1.0) {safe=false;break;}
        int m=int(fetch1(u_vertices,(int(-h.x)-2)*3).w);
        if(mat(m,2).w<0.5) {safe=false;break;}
        float remaining=distance-h.w-0.0002;
        if(remaining>0.0 && trace(p+n*(h.w+0.0002),n,remaining,-1,false).x!=0.0) {safe=false;break;}
        p=candidate;
    }
    out_FragColor=vec4(p,safe?1.0:0.0);
}`;
export const intersect = `${common + worldUniforms}
void main() {ivec2 c=ivec2(gl_FragCoord.xy);int width=textureSize(u_lumenProbePositions,0).x;
vec3 p=texelFetch(u_lumenProbePositions,ivec2(c.y%width,c.y/width),0).xyz;
out_FragColor=trace(p,rayDirection(c.x),completeDistance(p),-1,false);}`;
export const classify = `${common + worldUniforms}
void main() {ivec2 c=ivec2(gl_FragCoord.xy);int probe=c.x+c.y*textureSize(u_lumenProbePositions,0).x;
int back=0,unknown=0;
for(int i=0;i<512;i++) {if(i>=u_rays) break;vec4 h=texelFetch(u_hits,ivec2(i,probe),0);
if(h.x==-1.0) unknown++;if(h.x < -1.0) {int m=int(fetch1(u_vertices,(int(-h.x)-2)*3).w);if(mat(m,2).w>0.5) back++;}}
out_FragColor=vec4(texelFetch(u_lumenProbePositions,c,0).xyz,texelFetch(u_lumenProbePositions,c,0).a>0.5&&unknown==0&&float(back)/float(u_rays)<0.25?1.0:0.0);}`;
// Energy-independent sun visibility. RGB = visibility, validity, actual trace flag.
export const visibility = `${common + worldUniforms}
void main() {ivec2 c=ivec2(gl_FragCoord.xy);int width=textureSize(u_lumenProbePositions,0).x;
if(texelFetch(u_lumenProbePositions,ivec2(c.y%width,c.y/width),0).a<0.5) {out_FragColor=vec4(0.0);return;}
vec4 h=texelFetch(u_hits,c,0);
if(abs(h.x)<=1.0) {out_FragColor=vec4(0.0,h.x==0.0?1.0:0.0,0.0,0.0);return;}
int t=int(abs(h.x))-2;vec3 a,b,cc;int m;vec2 uv0;vec4 uv12;
triangle(t,a,b,cc,m,uv0,uv12);
vec3 p=a*(1.0-h.y-h.z)+b*h.y+cc*h.z,n=normalize(cross(b-a,cc-a));
bool black=h.x<0.0&&mat(m,1).z<0.5;if(h.x<0.0) n=-n;
if(black||dot(n,u_sunDirection)<=0.0) {out_FragColor=vec4(0.0,1.0,0.0,0.0);return;}
vec3 origin=p+n*0.015;float maximum=completeDistance(origin);
vec4 shadow=u_visibilityOptimized?occluded(origin,u_sunDirection,maximum,t):trace(origin,u_sunDirection,maximum,t,true);
out_FragColor=vec4(shadow.x==0.0?1.0:0.0,shadow.x==-1.0?0.0:1.0,1.0,0.0);
}`;
export const direct = `${common + worldUniforms}
void main() {ivec2 c=ivec2(gl_FragCoord.xy);vec4 h=texelFetch(u_hits,c,0);
int width=textureSize(u_lumenProbePositions,0).x;
if(texelFetch(u_lumenProbePositions,ivec2(c.y%width,c.y/width),0).a<0.5) {out_FragColor=vec4(0.0);return;}
if(h.x==0.0) {out_FragColor=vec4(u_upperHemisphere==1 && rayDirection(c.x).z<0.0 ? vec3(0.0) : u_skyRadiance,1.0);return;}
if(h.x==-1.0) {out_FragColor=vec4(0.0);return;}
vec3 p,n,rho,emission;int t;bool black;surface(h,p,n,rho,emission,t,black);
if(black) {out_FragColor=vec4(0.0,0.0,0.0,1.0);return;}
float cosine=max(0.0,dot(n,u_sunDirection));vec4 visible=texelFetch(u_visibility,c,0);
bool needsSun=cosine>0.0&&any(greaterThan(u_sunRadiance,vec3(0.0)));
out_FragColor=vec4(rho*u_sunRadiance*cosine*visible.r/czm_pi+emission,needsSun?visible.g:1.0);}`;
export const bounce = `${common + gather}
void main() {ivec2 c=ivec2(gl_FragCoord.xy);vec4 value=texelFetch(u_direct,c,0),h=texelFetch(u_hits,c,0);
if(u_first==0 && abs(h.x)>1.0 && value.a>0.5) {
vec3 p,n,rho,emission;int t;bool black;surface(h,p,n,rho,emission,t,black);
if(!black) value.rgb+=rho*lumen_worldIrradiance(p,n).rgb/czm_pi;
}
out_FragColor=value;}`;
const integrationDirection = `
vec3 octDecode(vec2 p) {vec3 v=vec3(p,1.0-abs(p.x)-abs(p.y));if(v.z<0.0) v.xy=(1.0-abs(v.yx))*mix(vec2(-1.0),vec2(1.0),greaterThanEqual(v.xy,vec2(0.0)));return normalize(v);}
vec3 integrationDirection(ivec2 c) {
if(c.x==0&&c.y==0) c=ivec2(8,8);
else if(c.x==9&&c.y==0) c=ivec2(1,8);
else if(c.x==0&&c.y==9) c=ivec2(8,1);
else if(c.x==9&&c.y==9) c=ivec2(1,1);
else if(c.x==0) c=ivec2(1,9-c.y);
else if(c.x==9) c=ivec2(8,9-c.y);
else if(c.y==0) c=ivec2(9-c.x,1);
else if(c.y==9) c=ivec2(9-c.x,8);
return octDecode((vec2(c)-0.5)/8.0*2.0-1.0);
}`;
export const weights = `${common + integrationDirection}
void main() {
ivec2 c=ivec2(gl_FragCoord.xy);vec3 direction=integrationDirection(ivec2(c.y%8+1,c.y/8+1));
float cosine=max(0.0,dot(direction,rayDirection(c.x)));
out_FragColor=vec4(cosine*(4.0*czm_pi/float(u_rays)),pow(cosine,16.0),0.0,0.0);
}`;
// Geometric validity is independent of energy/solar visibility. Unknown is excluded.
export const moments = `${common + worldUniforms + integrationDirection}
void main() {
ivec2 pixel=ivec2(gl_FragCoord.xy),tile=pixel/8,c=pixel%8+1;int probe=tile.x+tile.y*textureSize(u_lumenProbePositions,0).x;
if(texelFetch(u_lumenProbePositions,tile,0).a<0.5) {out_FragColor=vec4(0.0);return;}
vec3 direction=integrationDirection(c);
float mean=0.0,second=0.0,weights=0.0,known=0.0;
for(int i=0;i<512;i++) {if(i>=u_rays) break;
vec4 h=texelFetch(u_hits,ivec2(i,probe),0);if(h.x==-1.0) continue;
known++;
#ifdef LUMEN_USE_LUT
float w=texelFetch(u_weights,ivec2(i,(c.y-1)*8+c.x-1),0).g;
#else
float w=pow(max(0.0,dot(direction,rayDirection(i))),16.0);
#endif
float d=min(h.w,u_lumenProbeSpacing*8.0);mean+=d*w;second+=d*d*w;weights+=w;
}
out_FragColor=vec4(mean/max(weights,1e-20),second/max(weights,1e-20),0.0,known/float(u_rays));
}`;
export const integrate = `${common + worldUniforms + integrationDirection}
void main() {
ivec2 pixel=ivec2(gl_FragCoord.xy),tile=pixel/8,c=pixel%8+1;int probe=tile.x+tile.y*textureSize(u_lumenProbePositions,0).x;
if(texelFetch(u_lumenProbePositions,tile,0).a<0.5) {out_FragColor=vec4(0.0);return;}
vec3 direction=integrationDirection(c),E=vec3(0.0);float known=0.0;
for(int i=0;i<512;i++) {if(i>=u_rays) break;vec4 L=texelFetch(u_cache,ivec2(i,probe),0);
if(L.a<0.5) continue;known++;
#ifdef LUMEN_USE_LUT
E+=L.rgb*texelFetch(u_weights,ivec2(i,(c.y-1)*8+c.x-1),0).r;
#else
E+=L.rgb*max(0.0,dot(direction,rayDirection(i)))*(4.0*czm_pi/float(u_rays));
#endif
}
out_FragColor=vec4(E,known/float(u_rays));
}`;
// Copy from a separate 8x8 image; never sample the image attached for writing.
export const border = `precision highp sampler2D;
uniform sampler2D u_borderSource;
void main() {
ivec2 pixel=ivec2(gl_FragCoord.xy),tile=pixel/10,c=pixel%10;
if(c.x==0&&c.y==0) c=ivec2(8,8);
else if(c.x==9&&c.y==0) c=ivec2(1,8);
else if(c.x==0&&c.y==9) c=ivec2(8,1);
else if(c.x==9&&c.y==9) c=ivec2(1,1);
else if(c.x==0) c=ivec2(1,9-c.y);
else if(c.x==9) c=ivec2(8,9-c.y);
else if(c.y==0) c=ivec2(9-c.x,1);
else if(c.y==9) c=ivec2(9-c.x,8);
out_FragColor=texelFetch(u_borderSource,tile*8+c-1,0);
}`;
export const momentsBorder = border;
export const queryTrace = `#define LUMEN_QUERY_COUNTS
${common}
uniform sampler2D u_queryOrigin,u_queryDirection;
void main() {ivec2 c=ivec2(gl_FragCoord.xy);vec4 a=texelFetch(u_queryOrigin,c,0),b=texelFetch(u_queryDirection,c,0);vec4 hit=u_queryAnyHit?(u_visibilityOptimized?occluded(a.xyz,b.xyz,a.w,int(b.w)):trace(a.xyz,b.xyz,a.w,int(b.w),true)):trace(a.xyz,b.xyz,a.w,int(b.w),false);out_FragColor=u_queryStats?vec4(traversalCounts,hit.x==-1.0?-1.0:(hit.x==0.0?0.0:1.0)):hit;}`;
export const querySample = `${gather}
uniform sampler2D u_queryOrigin,u_queryDirection,u_queryGeometricNormal;
void main() {ivec2 c=ivec2(gl_FragCoord.xy);out_FragColor=lumen_worldIrradianceWithNormals(texelFetch(u_queryOrigin,c,0).xyz,texelFetch(u_queryGeometricNormal,c,0).xyz,texelFetch(u_queryDirection,c,0).xyz);}`;
export const fgCopy = `precision highp sampler2D;uniform sampler2D u_fgCopySource;void main(){out_FragColor=texelFetch(u_fgCopySource,ivec2(gl_FragCoord.xy),0);}`;
// Explicit diagnostic rays; no readback or source ablation in production.
export const queryTransport = `${common + gather}
uniform sampler2D u_queryOrigin,u_queryDirection;
uniform int u_transportPart;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);vec3 o=texelFetch(u_queryOrigin,c,0).xyz,d=texelFetch(u_queryDirection,c,0).xyz;
 vec4 h=trace(o,d,completeDistance(o),-1,false);if(u_transportPart==0){out_FragColor=h;return;}
 if(h.x==-1.0){out_FragColor=vec4(0,0,0,-1);return;}
 if(h.x==0.0){out_FragColor=vec4(u_transportPart==1&&(u_upperHemisphere==0||d.z>=0.0)?u_skyRadiance:vec3(0),1);return;}
 if(u_transportPart==1){out_FragColor=vec4(0,0,0,1);return;}
 vec3 p,n,rho,emission;int t;bool black;surface(h,p,n,rho,emission,t,black);
 if(u_transportPart==5){out_FragColor=vec4(p,black?0.0:1.0);return;}
 if(u_transportPart==6){out_FragColor=vec4(n,1);return;}
 if(black){out_FragColor=vec4(0,0,0,1);return;}
 if(u_transportPart==2){out_FragColor=vec4(emission,1);return;}
 if(u_transportPart==4){vec4 e=lumen_worldIrradiance(p,n);out_FragColor=vec4(rho*e.rgb/czm_pi,e.a);return;}
 vec3 origin=p+n*0.015;vec4 s=trace(origin,u_sunDirection,completeDistance(origin),t,false);
 if(u_transportPart==7){out_FragColor=vec4(origin,length(origin-p));return;}
 if(u_transportPart==8){out_FragColor=s;return;}
 out_FragColor=vec4(s.x==0.0?rho*u_sunRadiance*max(0.0,dot(n,u_sunDirection))/czm_pi:vec3(0),s.x==-1.0?-1.0:1.0);
}`;
const finalGather = `${finalGatherSampling}
vec4 fgRadiance(vec4 h,vec3 d){
 if(h.x==-1.0)return vec4(0,0,0,-1);
 if(h.x==0.0)return vec4(u_upperHemisphere==0||d.z>=0.0?u_skyRadiance:vec3(0),1);
 vec3 y,n,rho,emission;int t;bool black;surface(h,y,n,rho,emission,t,black);if(black)return vec4(0,0,0,1);
 vec3 L=emission;float cosine=max(0.0,dot(n,u_sunDirection));
 if(cosine>0.0&&any(greaterThan(u_sunRadiance,vec3(0)))){
  vec3 p=y+n*0.015;vec4 shadow=occluded(p,u_sunDirection,completeDistance(p),t);
  if(shadow.x==-1.0)return vec4(0,0,0,-2);
  if(shadow.x==0.0)L+=rho*u_sunRadiance*cosine/czm_pi;
 }
 if(u_fgPreviousEnabled){vec4 field=lumen_worldIrradiance(y,n);
  // Partial active support retains the R5 normalized gather contract. No support
  // is missing data, not known black irradiance. Keep it distinct from Unknown.
  if(field.a<=0.0)return vec4(0);L+=rho*field.rgb/czm_pi;
 }
 return vec4(L,1);
}
vec4 receiverFinalGather(vec3 p,vec3 ng,vec3 ns){
 if(dot(ng,ns)<0.8660253)return vec4(0);
 vec3 origin=p+ng*u_fgRayBias,sum=vec3(0);
 for(int i=0;i<1024;i++){if(i>=u_fgSamples)break;vec3 d=fgDirection(ns,i,ivec2(gl_FragCoord.xy)+u_fgPixelOffset);
  if(dot(ng,d)<=0.0)continue;
  vec4 L=fgRadiance(trace(origin,d,completeDistance(origin),-1,false),d);
  if(L.a<=0.0)return vec4(0,0,0,L.a);sum+=L.rgb;
 }
 return vec4(sum*(czm_pi/float(u_fgSamples)),1);
}`;
export const queryFinalGather = `${common + gather + finalGather}
uniform sampler2D u_queryOrigin,u_queryDirection,u_queryGeometricNormal;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);out_FragColor=receiverFinalGather(texelFetch(u_queryOrigin,c,0).xyz,normalize(texelFetch(u_queryGeometricNormal,c,0).xyz),normalize(texelFetch(u_queryDirection,c,0).xyz));}`;
const exactGather = LumenStageFS.replace(
  "if(u_lumenGatherControl.x<0.5 && distance>m.x) {float variance=max(0.0001,m.y-m.x*m.x);float visibility=variance/(variance+(distance-m.x)*(distance-m.x));reliability*=max(0.000001,visibility*visibility*visibility);}",
  "if(distance>0.0004){vec4 segment=occluded(biased,(probe.xyz-biased)/distance,distance-0.0002,-1);if(segment.x==-1.0)return vec4(0,0,0,-1);if(segment.x!=0.0)continue;}",
);
export const queryExactProbeVisibility = `#define LUMEN_WORLD_SUPPORTED
${common + worldUniforms + exactGather}
uniform sampler2D u_queryOrigin,u_queryDirection,u_queryGeometricNormal;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);out_FragColor=lumen_worldIrradianceWithNormals(texelFetch(u_queryOrigin,c,0).xyz,texelFetch(u_queryGeometricNormal,c,0).xyz,texelFetch(u_queryDirection,c,0).xyz);}`;
export const receiverTrace = `${common + gather + finalGather + receiverNormals.declarations + receiverNormals.functions}
uniform sampler2D u_receiverPosition,u_receiverNormal;uniform ivec2 u_receiverOffset;uniform int u_fgStart,u_fgWidth;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);
#ifdef LUMEN_FG_PLANAR
 ivec2 p=ivec2(c.x%u_fgWidth,c.y);int lane=c.x/u_fgWidth;
#else
 ivec2 p=ivec2(c.x/4,c.y);int lane=c.x%4;
#endif
 ivec2 r=p+u_receiverOffset;vec4 x=texelFetch(u_receiverPosition,r,0);int i=u_fgStart+lane;
 if(x.a<0.5||i>=u_fgSamples){out_FragColor=vec4(0);return;}
 vec4 n=texelFetch(u_receiverNormal,r,0);vec3 ng=lumen_fgNg(n),ns=lumen_fgNs(n),o=x.xyz+ng*u_fgRayBias,d=fgDirection(ns,i,r+u_fgPixelOffset);
 // Negative distance is disjoint from every real hit, Miss and Unknown.
 // Negative triangle IDs already encode backfaces and cannot be a zero tag.
 if(dot(ng,d)<=0.0){out_FragColor=vec4(0,0,0,-1);return;}
 out_FragColor=trace(o,d,completeDistance(o),-1,false);
}`;
export const receiverShade = `${common + gather + finalGather + receiverNormals.declarations + receiverNormals.functions}
uniform sampler2D u_receiverPosition,u_receiverNormal,u_receiverHits,u_fgAccumulation;uniform ivec2 u_receiverOffset;uniform int u_fgStart,u_fgWidth;
void main(){ivec2 p=ivec2(gl_FragCoord.xy),r=p+u_receiverOffset;vec4 x=texelFetch(u_receiverPosition,r,0);
 if(x.a<0.5){out_FragColor=vec4(0);return;}
 vec3 ns=lumen_fgNs(texelFetch(u_receiverNormal,r,0));vec4 sum=u_fgStart==0?vec4(0,0,0,1):texelFetch(u_fgAccumulation,p,0);
 for(int j=0;j<4;j++){int i=u_fgStart+j;if(i>=u_fgSamples)break;
#ifdef LUMEN_FG_PLANAR
  ivec2 hitPixel=ivec2(p.x+j*u_fgWidth,p.y);
#else
  ivec2 hitPixel=ivec2(p.x*4+j,p.y);
#endif
  vec4 h=texelFetch(u_receiverHits,hitPixel,0);if(h.w<0.0)continue;vec4 L=fgRadiance(h,fgDirection(ns,i,r+u_fgPixelOffset));if(L.a<=0.0)sum.a=min(sum.a,L.a);sum.rgb+=L.rgb*(czm_pi/float(u_fgSamples));}
 out_FragColor=sum;
}`;
export function receiverFused(batch) {
  if (batch !== 4 && batch !== 8) {
    throw new DeveloperError("FG fused batch must be 4 or 8");
  }
  return (
    `${
      common +
      gather +
      finalGather +
      receiverNormals.declarations +
      receiverNormals.functions
    }uniform sampler2D u_receiverPosition,u_receiverNormal,u_fgAccumulation;uniform ivec2 u_receiverOffset;uniform int u_fgStart;\n` +
    `void main(){ivec2 p=ivec2(gl_FragCoord.xy),r=p+u_receiverOffset;vec4 x=texelFetch(u_receiverPosition,r,0);if(x.a<0.5){out_FragColor=vec4(0);return;}vec4 n=texelFetch(u_receiverNormal,r,0);vec3 ng=lumen_fgNg(n),ns=lumen_fgNs(n),o=x.xyz+ng*u_fgRayBias;float distance=completeDistance(o);vec4 sum=u_fgStart==0?vec4(0,0,0,1):texelFetch(u_fgAccumulation,p,0);for(int j=0;j<${
      batch
    };j++){int i=u_fgStart+j;if(i>=u_fgSamples)break;vec3 d=fgDirection(ns,i,r+u_fgPixelOffset);if(dot(ng,d)<=0.0)continue;vec4 h=trace(o,d,distance,-1,false),L=fgRadiance(h,d);if(L.a<=0.0)sum.a=min(sum.a,L.a);sum.rgb+=L.rgb*(czm_pi/float(u_fgSamples));}out_FragColor=sum;}`
  );
}
// Conservative spatial support: a low-resolution cell cannot borrow light across
// any non-coplanar world triangle in its reconstruction neighborhood. Triangle
// AABBs and planes may reject extra cells; they never invent receiver geometry.
export const receiverNeighborhood = `${common + receiverNormals.declarations + receiverNormals.functions}
 uniform sampler2D u_receiverPosition,u_receiverNormal,u_fgRaw;uniform ivec2 u_receiverOffset;
 uniform mat4 u_fgLocalToEye;uniform float u_fgNeighborhoodScale;uniform bool u_fgNeedsNeighborhood;
 void main(){ivec2 c=ivec2(gl_FragCoord.xy),r=c+u_receiverOffset;vec4 p=texelFetch(u_receiverPosition,r,0),E=texelFetch(u_fgRaw,c,0);
  if(p.a<0.5||E.a<0.5){out_FragColor=vec4(0);return;}
  // Curved borrowing must pass per-pair convex-sphere guides; this is never a
  // planar free-space neighborhood, even when its raw result is complete.
  if(lumen_fgCurve(p)){out_FragColor=vec4(0);return;}
  if(!u_fgNeedsNeighborhood){out_FragColor=vec4(1);return;}
  vec3 ng=lumen_fgNg(texelFetch(u_receiverNormal,r,0));
  float radius=max(0.04,6.0*czm_metersPerPixel(u_fgLocalToEye*vec4(p.xyz,1.0),1.0)*u_fgNeighborhoodScale);
  int node=0;bool safe=false;
  for(int visit=0;visit<4096;visit++){
   if(node>=u_nodesCount){safe=true;break;}if(visit>=u_budget)break;
   vec4 lo=fetch1(u_nodes,node*2),hi=fetch1(u_nodes,node*2+1);
   if(any(greaterThan(lo.xyz,p.xyz+radius))||any(lessThan(hi.xyz,p.xyz-radius))){node=int(lo.w);continue;}
   if(hi.w<0.0){node++;continue;}
   int packed=int(hi.w),start=packed/16,count=packed%16;
   for(int j=0;j<8;j++){if(j>=count)break;int t=start+j;
    vec3 a=fetch1(u_vertices,t*3).xyz,b=fetch1(u_vertices,t*3+1).xyz,d=fetch1(u_vertices,t*3+2).xyz;
    vec3 crossNormal=cross(b-a,d-a);if(dot(crossNormal,crossNormal)<1e-16){out_FragColor=vec4(0);return;}
    vec3 n=normalize(crossNormal);
    // Receiver positions have passed through float model/view transforms.
    // Bound coplanar roundoff below the existing 0.2mm ray bias, rather than
    // randomly rejecting the very same floor/wall triangle at adjacent pixels.
    float roundoff=min(0.0002,64.0*1.1920928955078125e-7*max(1.0,max(abs(p.x),max(abs(p.y),abs(p.z)))));
    if(abs(dot(n,ng))>0.99999&&abs(dot(a-p.xyz,ng))<roundoff)continue;
    if(abs(dot(p.xyz-a,n))>radius*1.733)continue;
    if(any(greaterThan(min(a,min(b,d)),p.xyz+radius))||any(lessThan(max(a,max(b,d)),p.xyz-radius)))continue;
    out_FragColor=vec4(0);return;
   }node=int(lo.w);
  }out_FragColor=vec4(safe?1.0:0.0);
 }`;
export const displayBlend = `precision highp float;
uniform sampler2D u_displayHistory,u_displayTarget;
uniform float u_displayAlpha;
void main(){ivec2 p=ivec2(gl_FragCoord.xy);vec4 target=texelFetch(u_displayTarget,p,0);out_FragColor=vec4(mix(texelFetch(u_displayHistory,p,0).rgb,target.rgb,u_displayAlpha),target.a);}`;
export default {
  receiverTrace,
  receiverShade,
  receiverNeighborhood,
  fgCopy,
  queryFinalGather,
  queryExactProbeVisibility,
  displayBlend,
  relocate,
  intersect,
  classify,
  visibility,
  weights,
  moments,
  momentsBorder,
  border,
  direct,
  bounce,
  integrate,
  queryTrace,
  querySample,
};
