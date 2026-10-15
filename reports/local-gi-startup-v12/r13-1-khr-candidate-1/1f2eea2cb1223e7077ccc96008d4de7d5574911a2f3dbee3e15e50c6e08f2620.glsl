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
















const float czm_pi = 3.141592653589793;



#line 0

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
uniform bool u_contactTransport;

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


float traversalRank(int t) {
    if(u_tieRankOffset<0) return float(t);
    return fetch1(u_uv,u_tieRankOffset+t/4)[t%4];
}

vec4 traceRange(vec3 origin,vec3 direction,float maximum,int ignore,bool anyHit,bool preferSolidExit,float minimum) {
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
            float d=dot(e2,q)/det;if(d<=minimum||d>best.w) continue;
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

vec4 traceWithExitTies(vec3 o,vec3 d,float maximum,int ignore,bool anyHit,bool preferSolidExit){return traceRange(o,d,maximum,ignore,anyHit,preferSolidExit,0.00001);}
vec4 trace(vec3 origin,vec3 direction,float maximum,int ignore,bool anyHit) {
    return traceWithExitTies(origin,direction,maximum,ignore,anyHit,false);
}


float completeDistance(vec3 origin) {
    vec3 lo=fetch1(u_nodes,0).xyz, hi=fetch1(u_nodes,1).xyz;
    return max(100.0,length(max(abs(lo-origin),abs(hi-origin)))+1.0);
}

vec4 occludedRange(vec3 origin,vec3 direction,float maximum,int ignore,float minimum) {
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
            float d=dot(e2,q)/det;if(d<=minimum||d>=maximum) continue;
            int material=int(a.w);vec4 params=mat(material,1);
            if(params.w>0.5) {countAlpha();}
            if(params.w>0.5 && image(material,0,hitUV(vec2(b.w,c.w),fetch1(u_uv,t),vec2(u,v))).a*mat(material,0).a<params.y) continue;
            return vec4((det<0.0?-1.0:1.0)*float(t+2),u,v,d);
        }
        node=int(lo.w);
    }
    return vec4(node>=u_nodesCount?0.0:-1.0,0.0,0.0,maximum);
}
vec4 occluded(vec3 o,vec3 d,float maximum,int ignore){return occludedRange(o,d,maximum,ignore,0.00001);}



float outwardFloat(float p,float n){if(n==0.0)return p;if(p==0.0)return n>0.0?uintBitsToFloat(1u):-uintBitsToFloat(1u);uint bits=floatBitsToUint(p);return uintBitsToFloat((p>0.0)==(n>0.0)?bits+1u:bits-1u);}
vec3 spawnSurface(vec4 h,vec3 n,vec3 direction){
 vec3 a,b,c;int m;vec2 uv0;vec4 uv12;triangle(int(abs(h.x))-2,a,b,c,m,uv0,uv12);
 vec3 p=a*(1.0-h.y-h.z)+b*h.y+c*h.z;
 if(!u_contactTransport)return p+n*0.015;
 vec3 extent=abs(b-a)+abs(c-a);float size=max(extent.x,max(extent.y,extent.z));
 vec3 error=0.000000894071*(abs(a)*(1.0-h.y-h.z)+abs(b)*h.y+abs(c)*h.z+vec3(size));
 vec3 offset=n*(dot(abs(n),error)*(dot(n,direction)>=0.0?1.0:-1.0)),o=p+offset;
 return vec3(outwardFloat(o.x,offset.x),outwardFloat(o.y,offset.y),outwardFloat(o.z,offset.z));
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

uniform sampler2D u_lumenProbeIrradiance;
uniform sampler2D u_lumenProbeDistances;
uniform sampler2D u_lumenProbePositions;
uniform mat4 u_lumenEyeToLocal;
uniform vec3 u_lumenProbeOrigin, u_lumenProbeCounts, u_lumenIrradiance;
uniform float u_lumenProbeSpacing, u_lumenNormalBias, u_lumenWorldGain, u_lumenCoverage;
uniform bool u_lumenWorldEnabled, u_lumenLinearAtlas;
uniform vec4 u_lumenGatherControl;
uniform bool u_lumenLegacyKernel;

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
}
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
}