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

uniform float czm_pixelRatio;
uniform vec2 czm_currentFrustum;
uniform float czm_orthographicIn3D;










const float czm_sceneMode2D = 2.0;

uniform float czm_sceneMode;
uniform vec4 czm_frustumPlanes;
uniform vec4 czm_viewport;















const float czm_pi = 3.141592653589793;
















const float czm_twoPi = 6.283185307179586;














float czm_metersPerPixel(vec4 positionEC, float pixelRatio)
{
    float width = czm_viewport.z;
    float height = czm_viewport.w;
    float pixelWidth;
    float pixelHeight;

    float top = czm_frustumPlanes.x;
    float bottom = czm_frustumPlanes.y;
    float left = czm_frustumPlanes.z;
    float right = czm_frustumPlanes.w;

    if (czm_sceneMode == czm_sceneMode2D || czm_orthographicIn3D == 1.0)
    {
        float frustumWidth = right - left;
        float frustumHeight = top - bottom;
        pixelWidth = frustumWidth / width;
        pixelHeight = frustumHeight / height;
    }
    else
    {
        float distanceToPixel = -positionEC.z;
        float inverseNear = 1.0 / czm_currentFrustum.x;
        float tanTheta = top * inverseNear;
        pixelHeight = 2.0 * distanceToPixel * tanTheta / height;
        tanTheta = right * inverseNear;
        pixelWidth = 2.0 * distanceToPixel * tanTheta / width;
    }

    return max(pixelWidth, pixelHeight) * pixelRatio;
}













float czm_metersPerPixel(vec4 positionEC)
{
    return czm_metersPerPixel(positionEC, czm_pixelRatio);
}









bool czm_backFacing()
{
    
    return gl_FrontFacing == false;
}



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
#define LUMEN_WORLD_SUPPORTED
precision highp sampler2D;

uniform sampler2D u_lumenProbeIrradiance;
uniform sampler2D u_lumenProbeDistances;
uniform sampler2D u_lumenProbePositions;
uniform mat4 u_lumenEyeToLocal;
uniform vec3 u_lumenProbeOrigin, u_lumenProbeCounts, u_lumenIrradiance;
uniform float u_lumenProbeSpacing, u_lumenNormalBias, u_lumenWorldGain, u_lumenCoverage;
uniform bool u_lumenWorldEnabled, u_lumenLinearAtlas;
uniform vec4 u_lumenGatherControl;
uniform bool u_lumenLegacyKernel;



float lumen_materialCoverage = 0.0;
float lumen_dataCoverage = 0.0;
float lumen_environmentCoverage = 0.0;
float lumen_volumeCoverage = 0.0;

#ifdef LUMEN_WORLD_SUPPORTED
vec2 lumen_octEncode(vec3 v) {
    v /= dot(abs(v), vec3(1.0));
    if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * mix(vec2(-1.0), vec2(1.0), greaterThanEqual(v.xy, vec2(0.0)));
    return v.xy * 0.5 + 0.5;
}
vec4 lumen_atlas(sampler2D atlas, ivec2 tile, vec3 direction) {
    vec2 p = lumen_octEncode(direction) * 8.0 + 0.5;
    if (u_lumenLinearAtlas) return texture(atlas,(vec2(tile*10)+p+0.5)/vec2(textureSize(atlas,0)));
    ivec2 i = ivec2(floor(p)) + tile * 10;
    vec2 f = fract(p);
    return mix(mix(texelFetch(atlas,i,0),texelFetch(atlas,i+ivec2(1,0),0),f.x),mix(texelFetch(atlas,i+ivec2(0,1),0),texelFetch(atlas,i+ivec2(1,1),0),f.x),f.y);
}
vec4 lumen_worldIrradianceWithBias(vec3 positionEC, vec3 geometricNormalEC, vec3 shadingNormalEC, float normalBias) {
    lumen_volumeCoverage = 0.0;
    vec3 p = (u_lumenEyeToLocal * vec4(positionEC,1.0)).xyz;
    vec3 n = normalize(mat3(u_lumenEyeToLocal) * shadingNormalEC);
    vec3 ng = normalize(mat3(u_lumenEyeToLocal) * geometricNormalEC);
    
    vec3 biased=p+ng*normalBias;
    vec3 kernelPosition=u_lumenLegacyKernel?p:biased;
    vec3 q = (kernelPosition-u_lumenProbeOrigin)/u_lumenProbeSpacing;
    if (any(lessThan(q,vec3(0.0))) || any(greaterThan(q,u_lumenProbeCounts-1.0))) return vec4(0.0);
    lumen_volumeCoverage = 1.0;
    ivec3 counts = ivec3(u_lumenProbeCounts);
    ivec3 base = clamp(ivec3(floor(q)),ivec3(0),counts-2);
    vec3 f = q-vec3(base);
    vec3 irradiance = vec3(0.0); float weight = 0.0,available = 0.0;
    for (int z=0;z<2;z++) for (int y=0;y<2;y++) for (int x=0;x<2;x++) {
        ivec3 c=base+ivec3(x,y,z);ivec2 tile=ivec2(c.x+counts.x*c.y,c.z);
        vec4 probe=texelFetch(u_lumenProbePositions,tile,0);
        if (probe.a<0.5) continue;
        vec3 delta=biased-probe.xyz;float distance=length(delta);
        vec4 e=lumen_atlas(u_lumenProbeIrradiance,tile,n);
        vec4 m=lumen_atlas(u_lumenProbeDistances,tile,delta/max(distance,0.00001));
        if(e.a<0.95 || m.a<0.95) continue;
        vec3 a=mix(1.0-f,f,vec3(x,y,z));float trilinear=a.x*a.y*a.z;
        available+=trilinear;
        vec3 toward=probe.xyz-p;float wrap=(dot(toward/max(length(toward),0.00001),ng)+1.0)*0.5;
        float facing=u_lumenGatherControl.w>=0.0 ? u_lumenGatherControl.w : max(0.05,wrap*wrap);
        float reliability=facing;
        if(u_lumenGatherControl.x<0.5 && distance>m.x) {float variance=max(0.0001,m.y-m.x*m.x);float visibility=variance/(variance+(distance-m.x)*(distance-m.x));reliability*=max(0.000001,visibility*visibility*visibility);}
        if(!u_lumenLegacyKernel && u_lumenGatherControl.y<0.5 && reliability<0.2) reliability*=reliability*reliability/0.04;
        float w=trilinear*reliability;
        if(u_lumenLegacyKernel && u_lumenGatherControl.y<0.5 && w<0.2) w*=w*w/0.04;
        if(u_lumenGatherControl.z>=0.0) e.rgb=vec3(u_lumenGatherControl.z);
        weight+=w;irradiance+=e.rgb*w;
    }
    return vec4(weight>1e-10 ? irradiance/weight : vec3(0.0),clamp(available,0.0,1.0));
}
vec4 lumen_worldIrradianceWithNormals(vec3 p,vec3 ng,vec3 ns) { return lumen_worldIrradianceWithBias(p,ng,ns,u_lumenNormalBias); }
vec4 lumen_worldIrradiance(vec3 positionEC, vec3 normalEC) { return lumen_worldIrradianceWithNormals(positionEC,normalEC,normalEC); }
#endif
#ifdef LUMEN_RECEIVER_COMPOSITE
vec3 lumen_rawFg=vec3(0.0),lumen_filteredFg=vec3(0.0);
float lumen_fgWeight=0.0,lumen_fgFallbackReason=1.0;

vec3 lumen_triangleNormal(vec3 p) {
    vec3 triangle=cross(dFdx(p),dFdy(p));
    if(!(dot(triangle,triangle)>1e-16))return vec3(0.0);
    vec3 ng=normalize(triangle);
    if(!gl_FrontFacing)ng=-ng;
    #ifdef HAS_DOUBLE_SIDED_MATERIAL
    if(czm_backFacing())ng=-ng;
    #endif
    return ng;
}
#ifdef LUMEN_FG_RECONSTRUCTION
bool lumen_fgSegment(vec3 p,vec3 q,vec3 ng);
#endif
vec4 lumen_fgPack(vec3 ng,vec3 ns,float owner);
bool lumen_fgCurve(vec4 p);
bool lumen_fgCompatible(vec4 p,vec4 n,vec4 q,vec4 hn,float footprint);
vec3 lumen_reconstructFg(vec3 positionEC,vec3 ns,vec3 baseline) {
    lumen_rawFg=vec3(0.0);lumen_filteredFg=vec3(0.0);lumen_fgWeight=0.0;
    lumen_fgFallbackReason=1.0;
    #ifdef LUMEN_FG_REASONS
    if(!u_lumenFgEnabled)lumen_fgFallbackReason=u_lumenFgFallbackCode;
    #endif
    vec3 ngEC=lumen_triangleNormal(positionEC);
    if(!u_lumenFgEnabled||dot(ngEC,ns)<(u_lumenFgCurved?0.8660253:0.999))return baseline;
    vec3 p=(u_lumenEyeToLocal*vec4(positionEC,1.0)).xyz,ng=normalize(mat3(u_lumenEyeToLocal)*ngEC);
    vec4 currentP=vec4(p,u_lumenFgSurfaceId),currentN=lumen_fgPack(ng,normalize(mat3(u_lumenEyeToLocal)*ns),u_lumenFgSurfaceId);
    #ifdef LUMEN_WORLD_SUPPORTED
    
    
    vec3 volumeQ=((u_lumenLegacyKernel?p:p+ng*u_lumenNormalBias)-u_lumenProbeOrigin)/u_lumenProbeSpacing;
    if(any(lessThan(volumeQ,vec3(0.0)))||any(greaterThan(volumeQ,u_lumenProbeCounts-1.0))) {
        lumen_fgFallbackReason=9.0;
        return baseline;
    }
    #endif
    vec2 q=gl_FragCoord.xy/u_lumenFgSceneSize*u_lumenReceiverSize-u_lumenFgOffset-0.5;
    
    if(all(equal(u_lumenReceiverSize,u_lumenFgSceneSize)))q=floor(gl_FragCoord.xy)-u_lumenFgOffset;
    ivec2 base=ivec2(floor(q)),size=ivec2(u_lumenFgSize);vec2 f=fract(q);
    ivec2 nearest=ivec2(floor(q+0.5));
    if(all(greaterThanEqual(nearest,ivec2(0)))&&all(lessThan(nearest,size))) {
        vec4 raw=texelFetch(u_lumenFgTexture,nearest,0);if(raw.a>0.5){lumen_rawFg=raw.rgb;lumen_fgFallbackReason=6.0;}else lumen_fgFallbackReason=raw.a==-2.0?4.0:raw.a<0.0?3.0:5.0;
    }
    else lumen_fgFallbackReason=9.0;
    float footprint=max(0.02,3.0*czm_metersPerPixel(vec4(positionEC,1.0),1.0)*u_lumenFgSceneSize.y/u_lumenReceiverSize.y);

    #ifdef LUMEN_FG_RECONSTRUCTION
    if(u_lumenFgHistory) {
        
        
        ivec2 best=ivec2(-1);float nearestDistance=1e20;vec3 bestPosition=vec3(0);vec4 bestE=vec4(0);
        for(int y=0;y<2;y++)for(int x=0;x<2;x++){
            ivec2 c=base+ivec2(x,y);
            if(any(lessThan(c,ivec2(0)))||any(greaterThanEqual(c,size))){lumen_fgFallbackReason=9.0;continue;}
            vec4 raw=texelFetch(u_lumenFgTexture,c,0),r=texelFetch(u_lumenReceiverPosition,c+ivec2(u_lumenFgOffset),0),n=texelFetch(u_lumenReceiverNormal,c+ivec2(u_lumenFgOffset),0);
            if(raw.a<.5){lumen_fgFallbackReason=raw.a==-2.0?4.0:raw.a<0.0?3.0:5.0;continue;}
            if(abs(r.a-u_lumenFgSurfaceId)>.1){lumen_fgFallbackReason=7.0;continue;}
            vec3 delta=r.xyz-p;float distance=length(delta);
            if(!lumen_fgCompatible(currentP,currentN,r,n,footprint)||abs(dot(delta,u_lumenEyeToLocal[2].xyz))>footprint){lumen_fgFallbackReason=8.0;continue;}
            if(distance<nearestDistance){best=c;nearestDistance=distance;bestPosition=r.xyz;bestE=texelFetch(u_lumenFgFiltered,c,0);if(bestE.a<.5)bestE=raw;}
        }
        if(best.x<0)return baseline;
        bool safe=texelFetch(u_lumenFgNeighborhood,best,0).r>.5;
        if(!lumen_fgCurve(currentP)&&!safe&&!lumen_fgSegment(p,bestPosition,ng)){lumen_fgFallbackReason=6.0;return baseline;}
        
        
        lumen_filteredFg=bestE.rgb;lumen_fgWeight=1.0;lumen_fgFallbackReason=0.0;
        return lumen_filteredFg*u_lumenWorldGain;
    }
    #endif
    vec3 sum=vec3(0.0);float weight=0.0;
    for(int y=0;y<2;y++)for(int x=0;x<2;x++) {
        ivec2 c=base+ivec2(x,y);if(any(lessThan(c,ivec2(0)))||any(greaterThanEqual(c,size)))continue;
        vec4 E=texelFetch(u_lumenFgTexture,c,0),r=texelFetch(u_lumenReceiverPosition,c+ivec2(u_lumenFgOffset),0),n=texelFetch(u_lumenReceiverNormal,c+ivec2(u_lumenFgOffset),0);
        #ifdef LUMEN_FG_REASONS
        if(u_lumenFgHistory){vec4 h=texelFetch(u_lumenFgFiltered,c,0);if(h.a>.5)E=h;}
        #endif
        
        if((!lumen_fgCurve(currentP)&&texelFetch(u_lumenFgNeighborhood,c,0).r<0.5)||E.a<0.5||!lumen_fgCompatible(currentP,currentN,r,n,footprint))continue;
        vec3 delta=r.xyz-p;
        if(!u_lumenFgPackedNormals&&abs(n.a-r.a)>.1)continue;
        vec2 a=mix(1.0-f,f,vec2(x,y));float w=a.x*a.y;sum+=E.rgb*w;weight+=w;
    }
    if(weight>0.0001){lumen_filteredFg=sum/weight;lumen_fgWeight=clamp(weight,0.0,1.0);if(weight>0.999)lumen_fgFallbackReason=0.0;}
    
    return mix(baseline,lumen_filteredFg*u_lumenWorldGain,lumen_fgWeight);
}
#endif
vec3 lumen_irradiance(vec3 positionEC,vec3 normalEC,vec3 geometricNormalEC) {
    lumen_materialCoverage=u_lumenCoverage;
    lumen_environmentCoverage=u_lumenCoverage;
    lumen_dataCoverage=u_lumenCoverage;
    #if defined(LUMEN_WORLD_SUPPORTED) && !defined(LUMEN_GBUFFER)
    if(u_lumenWorldEnabled) {
        #ifdef LUMEN_RECEIVER_COMPOSITE
        
        
        if(u_lumenFgLazyFallback && u_lumenDebugMode==0) {
            vec3 p=(u_lumenEyeToLocal*vec4(positionEC,1.0)).xyz;
            vec3 ng=normalize(mat3(u_lumenEyeToLocal)*geometricNormalEC);
            vec3 q=((u_lumenLegacyKernel?p:p+ng*u_lumenNormalBias)-u_lumenProbeOrigin)/u_lumenProbeSpacing;
            bool inside=all(greaterThanEqual(q,vec3(0.0)))&&all(lessThanEqual(q,u_lumenProbeCounts-1.0));
            vec3 candidate=lumen_reconstructFg(positionEC,normalEC,vec3(0.0));
            if(inside&&lumen_fgWeight==1.0) {
                lumen_volumeCoverage=1.0;
                
                
                return candidate;
            }
            vec4 fallback=lumen_worldIrradianceWithNormals(positionEC,geometricNormalEC,normalEC);
            lumen_dataCoverage*=fallback.a;
            lumen_materialCoverage*=lumen_volumeCoverage;
            lumen_environmentCoverage*=lumen_volumeCoverage;
            return candidate + fallback.rgb*u_lumenWorldGain*(1.0-lumen_fgWeight);
        }
        #endif
        vec4 field=lumen_worldIrradianceWithNormals(positionEC,geometricNormalEC,normalEC);
        lumen_dataCoverage*=field.a;
        
        
        
        lumen_materialCoverage*=lumen_volumeCoverage;
        
        
        lumen_environmentCoverage*=lumen_volumeCoverage;
        vec3 E=field.rgb*u_lumenWorldGain;
        #ifdef LUMEN_RECEIVER_COMPOSITE
        E=lumen_reconstructFg(positionEC,normalEC,E);
        #endif
        return E;
    }
    #endif
    return u_lumenIrradiance;
}
uniform int u_fgSamples,u_fgRayOrder,u_fgSeed,u_fgSampling,u_fgEpoch;uniform ivec2 u_fgPixelOffset;uniform bool u_fgPreviousEnabled;uniform float u_fgRayBias;
float reverseBits(int i){uint b=uint(i);b=(b<<16u)|(b>>16u);b=((b&0x55555555u)<<1u)|((b&0xAAAAAAAAu)>>1u);b=((b&0x33333333u)<<2u)|((b&0xCCCCCCCCu)>>2u);b=((b&0x0F0F0F0Fu)<<4u)|((b&0xF0F0F0F0u)>>4u);b=((b&0x00FF00FFu)<<8u)|((b&0xFF00FF00u)>>8u);return float(b)*2.3283064365386963e-10;}
uint fgHash(uint x){x^=x>>16u;x*=0x7feb352du;x^=x>>15u;x*=0x846ca68bu;return x^(x>>16u);}
vec3 fgDirection(vec3 ng,int i,ivec2 pixel){

 vec3 t=normalize(cross(abs(ng.z)<0.9?vec3(0,0,1):vec3(0,1,0),ng)),b=cross(ng,t);
 float u=(float(i)+0.5)/float(u_fgSamples),v=fract(reverseBits(i)+float(u_fgSeed)*0.61803398875);
 if(u_fgSampling!=0) {
  uint key=fgHash(uint(pixel.x)*0x9e3779b9u^uint(pixel.y)*0x85ebca6bu^uint(u_fgSeed)),epoch=u_fgSampling==2?uint(u_fgEpoch):0u;
  float shift0=float(fgHash(key^epoch^0xa511e9b3u)>>8u)*(1.0/16777216.0);
  float shift1=float(fgHash(key^fgHash(epoch^0x63d83595u)^0x68bc21ebu)>>8u)*(1.0/16777216.0);
  if(u_fgRayOrder!=0&&(u_fgSamples&(u_fgSamples-1))==0){int j=(i+u_fgSamples-int(floor(shift1*float(u_fgSamples))))%u_fgSamples;i=int(reverseBits(j)*float(u_fgSamples));u=(float(i)+0.5)/float(u_fgSamples);}
  u=fract(u+shift0);v=fract(reverseBits(i)+shift1);
 }
 float phi=czm_twoPi*v;

 return t*sqrt(u)*cos(phi)+b*sqrt(u)*sin(phi)+ng*sqrt(1.0-u);
}

uniform sampler2D u_surfaceMetadata,u_surfaceRadiance;
uniform bool u_surfaceEnabled;
vec4 surfaceCached(vec4 h){
 if(h.x==-1.0)return vec4(0,0,0,-1);
 if(abs(h.x)<=1.0)return vec4(0);
 int t=int(abs(h.x))-2;vec4 meta=fetch1(u_surfaceMetadata,t);int n=int(meta.y);
 if(n<1||h.x<0.0)return vec4(0);
 vec2 q=clamp(h.yz,vec2(0),vec2(0.999999))*float(n);ivec2 cell=ivec2(floor(q));
 if(cell.x+cell.y>=n)cell.y=n-1-cell.x;
 int upper=cell.x+cell.y<n-1&&fract(q.x)+fract(q.y)>1.0?1:0;
 int index=int(meta.x)+cell.x*(2*n-cell.x)+2*cell.y+upper;
 return fetch1(u_surfaceRadiance,index);
}

vec4 fgRadiance(vec4 h,vec3 d){
 if(h.x==-1.0)return vec4(0,0,0,-1);
 if(h.x==0.0)return vec4(u_upperHemisphere==0||d.z>=0.0?u_skyRadiance:vec3(0),1);
 vec3 y,n,rho,emission;int t;bool black;surface(h,y,n,rho,emission,t,black);if(black)return vec4(0,0,0,1);
 if(u_surfaceEnabled){vec4 cached=surfaceCached(h);if(cached.a!=0.0)return cached;}
 vec3 L=emission;float cosine=max(0.0,dot(n,u_sunDirection));
 if(cosine>0.0&&any(greaterThan(u_sunRadiance,vec3(0)))){
  vec3 p=spawnSurface(h,n,u_sunDirection);vec4 shadow=occludedRange(p,u_sunDirection,completeDistance(p),t,u_contactTransport?0.0:0.00001);
  if(shadow.x==-1.0)return vec4(0,0,0,-2);
  if(shadow.x==0.0)L+=rho*u_sunRadiance*cosine/czm_pi;
 }
 if(u_fgPreviousEnabled){vec4 field=lumen_worldIrradianceWithBias(y,n,n,u_contactTransport?0.0:u_lumenNormalBias);
  
  
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
}uniform bool u_lumenFgPackedNormals;

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
}