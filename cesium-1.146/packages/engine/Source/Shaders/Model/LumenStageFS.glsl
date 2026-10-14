// Directional irradiance E and distance moments use bordered 8x8 octahedral tiles.
// All world positions are local metres; eye->local is formed in CPU double precision.
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
    // Ng biases geometry; Ns only addresses directional E. Logical grid stays unrelocated.
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
// The derivative normal is the actual triangle normal. Attribute normals may be smooth.
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
    // Resident volume ownership applies equally to eager and lazy FG. Ng was
    // evaluated above, before this per-fragment bounds branch.
    vec3 volumeQ=((u_lumenLegacyKernel?p:p+ng*u_lumenNormalBias)-u_lumenProbeOrigin)/u_lumenProbeSpacing;
    if(any(lessThan(volumeQ,vec3(0.0)))||any(greaterThan(volumeQ,u_lumenProbeCounts-1.0))) {
        lumen_fgFallbackReason=9.0;
        return baseline;
    }
    #endif
    vec2 q=gl_FragCoord.xy/u_lumenFgSceneSize*u_lumenReceiverSize-u_lumenFgOffset-0.5;
    // Full-resolution ROI is an exact current-pixel lookup, including at wall edges.
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
        // Select one geometrically corresponding center before any barrier query.
        // At most one bounded world segment per high-resolution receiver pixel.
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
        // A valid, connected center supplies a complete E estimate. The source's
        // discarded interpolation neighbors do not darken it or blend in DDGI.
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
        // Reject Unknown and other surfaces. Never average foreground/background positions.
        if((!lumen_fgCurve(currentP)&&texelFetch(u_lumenFgNeighborhood,c,0).r<0.5)||E.a<0.5||!lumen_fgCompatible(currentP,currentN,r,n,footprint))continue;
        vec3 delta=r.xyz-p;
        if(!u_lumenFgPackedNormals&&abs(n.a-r.a)>.1)continue;
        vec2 a=mix(1.0-f,f,vec2(x,y));float w=a.x*a.y;sum+=E.rgb*w;weight+=w;
    }
    if(weight>0.0001){lumen_filteredFg=sum/weight;lumen_fgWeight=clamp(weight,0.0,1.0);if(weight>0.999)lumen_fgFallbackReason=0.0;}
    // Both sides are complete irradiance E. Receiver rho/pi is applied once by PBR.
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
        // This branch is uniform for the draw. Ng derivatives run before any
        // per-fragment volume/validity branch. Debug coverage stays eager.
        if(u_lumenFgLazyFallback && u_lumenDebugMode==0) {
            vec3 p=(u_lumenEyeToLocal*vec4(positionEC,1.0)).xyz;
            vec3 ng=normalize(mat3(u_lumenEyeToLocal)*geometricNormalEC);
            vec3 q=((u_lumenLegacyKernel?p:p+ng*u_lumenNormalBias)-u_lumenProbeOrigin)/u_lumenProbeSpacing;
            bool inside=all(greaterThanEqual(q,vec3(0.0)))&&all(lessThanEqual(q,u_lumenProbeCounts-1.0));
            vec3 candidate=lumen_reconstructFg(positionEC,normalEC,vec3(0.0));
            if(inside&&lumen_fgWeight==1.0) {
                lumen_volumeCoverage=1.0;
                // Selected complete FG E has valid support. Explicit DDGI
                // support diagnostics take the eager branch below.
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
        // E is already normalized over reliable, valid support. Availability
        // diagnoses missing samples; multiplying it again invents dark energy.
        // Resident volume coverage controls ownership of diffuse lighting.
        lumen_materialCoverage*=lumen_volumeCoverage;
        // Missing/interior support cannot reveal an unoccluded diffuse sky inside the volume.
        // Raw data support remains field.a, independently observable from energy/visibility.
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
