// Directional irradiance E and distance moments use bordered 8x8 octahedral tiles.
// All world positions are local metres; eye->local is formed in CPU double precision.
float lumen_materialCoverage = 0.0;

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
vec4 lumen_worldIrradiance(vec3 positionEC, vec3 normalEC) {
    vec3 p = (u_lumenEyeToLocal * vec4(positionEC,1.0)).xyz;
    vec3 n = normalize(mat3(u_lumenEyeToLocal) * normalEC);
    vec3 q = (p-u_lumenProbeOrigin)/u_lumenProbeSpacing;
    if (any(lessThan(q,vec3(0.0))) || any(greaterThan(q,u_lumenProbeCounts-1.0))) return vec4(0.0);
    ivec3 counts = ivec3(u_lumenProbeCounts);
    ivec3 base = clamp(ivec3(floor(q)),ivec3(0),counts-2);
    vec3 f = q-vec3(base),biased = p+n*u_lumenNormalBias;
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
        vec3 toward=probe.xyz-p;float wrap=(dot(toward/max(length(toward),0.00001),n)+1.0)*0.5;
        float w=trilinear*max(0.05,wrap*wrap);
        if(distance>m.x) {float variance=max(0.0001,m.y-m.x*m.x);float visibility=variance/(variance+(distance-m.x)*(distance-m.x));w*=max(0.000001,visibility*visibility*visibility);}
        if(w<0.2) w*=w*w/0.04;
        weight+=w;irradiance+=e.rgb*w;
    }
    return weight>1e-10 ? vec4(irradiance/weight,clamp(available,0.0,1.0)) : vec4(0.0);
}
#endif
vec3 lumen_irradiance(vec3 positionEC,vec3 normalEC) {
    lumen_materialCoverage=u_lumenCoverage;
    #if defined(LUMEN_WORLD_SUPPORTED) && !defined(LUMEN_GBUFFER)
    if(u_lumenWorldEnabled) {
        vec4 field=lumen_worldIrradiance(positionEC,normalEC);
        lumen_materialCoverage*=field.a;
        return field.rgb*u_lumenWorldGain;
    }
    #endif
    return u_lumenIrradiance;
}
