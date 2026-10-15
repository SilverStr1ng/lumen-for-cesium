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

#define u_lumenDebugMode 0
#define LUMEN_WORLD_SUPPORTED
#define USE_IBL_LIGHTING
#define DIFFUSE_IBL
#define CUSTOM_SPHERICAL_HARMONICS
#define HAS_ATMOSPHERE
#define COMPUTE_POSITION_WC_ATMOSPHERE
#define HAS_NORMALS
#define HAS_TEXCOORD_0
#define HAS_EMISSIVE_FACTOR
#define USE_METALLIC_ROUGHNESS
#define HAS_BASE_COLOR_FACTOR
#define HAS_METALLIC_FACTOR
#define HAS_ROUGHNESS_FACTOR
#define METADATA_PICKING_VALUE_TYPE float
#define METADATA_PICKING_VALUE_STRING 0.0
#define METADATA_PICKING_VALUE_COMPONENT_X 0.0
#define METADATA_PICKING_VALUE_COMPONENT_Y 0.0
#define METADATA_PICKING_VALUE_COMPONENT_Z 0.0
#define METADATA_PICKING_VALUE_COMPONENT_W 0.0
#define LUMEN_MODEL_LIGHTING
#define LIGHTING_PBR
#define OES_texture_float_linear

#define OES_texture_float


#line 0
layout(location = 0) out vec4 out_FragColor;







const float czm_infinity = 5906376272000.0;  







struct czm_ray
{
    vec3 origin;
    vec3 direction;
};







struct czm_raySegment
{
    float start;
    float stop;
};







const czm_raySegment czm_emptyRaySegment = czm_raySegment(-czm_infinity, -czm_infinity);







const czm_raySegment czm_fullRaySegment = czm_raySegment(0.0, czm_infinity);







const float czm_epsilon7 = 0.0000001;

uniform vec3 czm_atmosphereRayleighCoefficient;
uniform vec3 czm_atmosphereMieCoefficient;
uniform float czm_atmosphereMieScaleHeight;
uniform float czm_atmosphereRayleighScaleHeight;






float czm_approximateTanh(float x) {
    float x2 = x * x;
    return max(-1.0, min(1.0, x * (27.0 + x2) / (27.0 + 9.0 * x2)));
}












czm_raySegment czm_raySphereIntersectionInterval(czm_ray ray, vec3 center, float radius)
{
    vec3 o = ray.origin;
    vec3 d = ray.direction;

    vec3 oc = o - center;

    float a = dot(d, d);
    float b = 2.0 * dot(d, oc);
    float c = dot(oc, oc) - (radius * radius);

    float det = (b * b) - (4.0 * a * c);

    if (det < 0.0) {
        return czm_emptyRaySegment;
    }

    float sqrtDet = sqrt(det);

    float t0 = (-b - sqrtDet) / (2.0 * a);
    float t1 = (-b + sqrtDet) / (2.0 * a);

    czm_raySegment result = czm_raySegment(t0, t1);
    return result;
}

uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;
uniform float czm_gamma;









float czm_maximumComponent(vec2 v)
{
    return max(v.x, v.y);
}
float czm_maximumComponent(vec3 v)
{
    return max(max(v.x, v.y), v.z);
}
float czm_maximumComponent(vec4 v)
{
    return max(max(max(v.x, v.y), v.z), v.w);
}






















struct czm_modelMaterial {
    vec4 baseColor;
    vec3 diffuse;
    float alpha;
    vec3 specular;
    float roughness;
    vec3 normalEC;
    float occlusion;
    vec3 emissive;
#ifdef USE_SPECULAR
    float specularWeight;
#endif
#ifdef USE_ANISOTROPY
    vec3 anisotropicT;
    vec3 anisotropicB;
    float anisotropyStrength;
#endif
#ifdef USE_CLEARCOAT
    float clearcoatFactor;
    float clearcoatRoughness;
    vec3 clearcoatNormal;
    
#endif
};
















const float czm_pi = 3.141592653589793;

uniform float czm_atmosphereLightIntensity;
uniform float czm_atmosphereMieAnisotropy;
uniform vec3 czm_viewerPositionWC;

















const vec4 K_HSB2RGB = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);

vec3 czm_HSBToRGB(vec3 hsb)
{
    vec3 p = abs(fract(hsb.xxx + K_HSB2RGB.xyz) * 6.0 - K_HSB2RGB.www);
    return hsb.z * mix(K_HSB2RGB.xxx, clamp(p - K_HSB2RGB.xxx, 0.0, 1.0), hsb.y);
}


















const vec4 K_RGB2HSB = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);

vec3 czm_RGBToHSB(vec3 rgb)
{
    vec4 p = mix(vec4(rgb.bg, K_RGB2HSB.wz), vec4(rgb.gb, K_RGB2HSB.xy), step(rgb.b, rgb.g));
    vec4 q = mix(vec4(p.xyw, rgb.r), vec4(rgb.r, p.yzx), step(p.x, rgb.r));

    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + czm_epsilon7)), d / (q.x + czm_epsilon7), q.x);
}
















void czm_computeScattering(
    czm_ray primaryRay,
    float primaryRayLength,
    vec3 lightDirection,
    float atmosphereInnerRadius,
    out vec3 rayleighColor,
    out vec3 mieColor,
    out float opacity
) {
    const float ATMOSPHERE_THICKNESS = 111e3; 
    const int PRIMARY_STEPS_MAX = 16; 
    const int LIGHT_STEPS_MAX = 4; 

    
    rayleighColor = vec3(0.0);
    mieColor = vec3(0.0);
    opacity = 0.0;

    float atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;

    vec3 origin = vec3(0.0);

    
    czm_raySegment primaryRayAtmosphereIntersect = czm_raySphereIntersectionInterval(primaryRay, origin, atmosphereOuterRadius);

    
    if (primaryRayAtmosphereIntersect == czm_emptyRaySegment) {
        return;
    }

    
    
    
    
    float x = 1e-7 * primaryRayAtmosphereIntersect.stop / length(primaryRayLength);
    
    
    float w_stop_gt_lprl = 0.5 * (1.0 + czm_approximateTanh(x));

    
    float start_0 = primaryRayAtmosphereIntersect.start;
    primaryRayAtmosphereIntersect.start = max(primaryRayAtmosphereIntersect.start, 0.0);
    
    primaryRayAtmosphereIntersect.stop = min(primaryRayAtmosphereIntersect.stop, length(primaryRayLength));

    
    
    
    float x_o_a = start_0 - ATMOSPHERE_THICKNESS; 
    float w_inside_atmosphere = 1.0 - 0.5 * (1.0 + czm_approximateTanh(x_o_a));
    int PRIMARY_STEPS = PRIMARY_STEPS_MAX - int(w_inside_atmosphere * 12.0); 
    int LIGHT_STEPS = LIGHT_STEPS_MAX - int(w_inside_atmosphere * 2.0); 

    
    float rayPositionLength = primaryRayAtmosphereIntersect.start;
    
    
    float totalRayLength = primaryRayAtmosphereIntersect.stop - rayPositionLength;
    float rayStepLengthIncrease = w_inside_atmosphere * ((1.0 - w_stop_gt_lprl) * totalRayLength / (float(PRIMARY_STEPS * (PRIMARY_STEPS + 1)) / 2.0));
    float rayStepLength = max(1.0 - w_inside_atmosphere, w_stop_gt_lprl) * totalRayLength / max(7.0 * w_inside_atmosphere, float(PRIMARY_STEPS));

    vec3 rayleighAccumulation = vec3(0.0);
    vec3 mieAccumulation = vec3(0.0);
    vec2 opticalDepth = vec2(0.0);
    vec2 heightScale = vec2(czm_atmosphereRayleighScaleHeight, czm_atmosphereMieScaleHeight);

    
    for (int i = 0; i < PRIMARY_STEPS_MAX; ++i) {

        
        
        if (i >= PRIMARY_STEPS) {
            break;
        }

        
        vec3 samplePosition = primaryRay.origin + primaryRay.direction * (rayPositionLength + rayStepLength);

        
        float sampleHeight = length(samplePosition) - atmosphereInnerRadius;

        
        vec2 sampleDensity = exp(-sampleHeight / heightScale) * rayStepLength;
        opticalDepth += sampleDensity;

        
        czm_ray lightRay = czm_ray(samplePosition, lightDirection);
        czm_raySegment lightRayAtmosphereIntersect = czm_raySphereIntersectionInterval(lightRay, origin, atmosphereOuterRadius);

        float lightStepLength = lightRayAtmosphereIntersect.stop / float(LIGHT_STEPS);
        float lightPositionLength = 0.0;

        vec2 lightOpticalDepth = vec2(0.0);

        
        for (int j = 0; j < LIGHT_STEPS_MAX; ++j) {

            
            
            if (j >= LIGHT_STEPS) {
                break;
            }

            
            vec3 lightPosition = samplePosition + lightDirection * (lightPositionLength + lightStepLength * 0.5);

            
            float lightHeight = length(lightPosition) - atmosphereInnerRadius;

            
            lightOpticalDepth += exp(-lightHeight / heightScale) * lightStepLength;

            
            lightPositionLength += lightStepLength;
        }

        
        vec3 attenuation = exp(-((czm_atmosphereMieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) + (czm_atmosphereRayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x))));

        
        rayleighAccumulation += sampleDensity.x * attenuation;
        mieAccumulation += sampleDensity.y * attenuation;

        
        rayPositionLength += (rayStepLength += rayStepLengthIncrease);
    }

    
    rayleighColor = czm_atmosphereRayleighCoefficient * rayleighAccumulation;
    mieColor = czm_atmosphereMieCoefficient * mieAccumulation;

    
    opacity = length(exp(-((czm_atmosphereMieCoefficient * opticalDepth.y) + (czm_atmosphereRayleighCoefficient * opticalDepth.x))));
}

uniform vec3 czm_sunDirectionWC;
uniform vec3 czm_lightDirectionWC;
uniform float czm_fogDensity;













float czm_branchFreeTernary(bool comparison, float a, float b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec2 czm_branchFreeTernary(bool comparison, vec2 a, vec2 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec3 czm_branchFreeTernary(bool comparison, vec3 a, vec3 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}














vec4 czm_branchFreeTernary(bool comparison, vec4 a, vec4 b) {
    float useA = float(comparison);
    return a * useA + b * (1.0 - useA);
}

uniform float czm_pixelRatio;
uniform vec2 czm_currentFrustum;
uniform float czm_orthographicIn3D;










const float czm_sceneMode2D = 2.0;

uniform float czm_sceneMode;
uniform vec4 czm_frustumPlanes;
uniform vec4 czm_viewport;
uniform sampler2D czm_planarFillIdTexture;
#ifdef LOG_DEPTH
in float v_depthFromNearPlusOne;

#ifdef POLYGON_OFFSET
uniform vec2 u_polygonOffset;
#endif

#endif
















void czm_writeLogDepth(float depth)
{
#if (defined(LOG_DEPTH) && (__VERSION__ == 300 || defined(GL_EXT_frag_depth)))
    
    
    
    
    if (depth <= 0.9999999 || depth > czm_farDepthFromNearPlusOne) {
        discard;
    }

#ifdef POLYGON_OFFSET
    
    float factor = u_polygonOffset[0];
    float units = u_polygonOffset[1];

#if (__VERSION__ == 300 || defined(GL_OES_standard_derivatives))
    
    if (factor != 0.0) {
        
        float x = dFdx(depth);
        float y = dFdy(depth);
        float m = sqrt(x * x + y * y);

        
        depth += m * factor;
    }
#endif

#endif

    gl_FragDepth = log2(depth) * czm_oneOverLog2FarDepthFromNearPlusOne;

#ifdef POLYGON_OFFSET
    
    gl_FragDepth += czm_epsilon7 * units;
#endif

#endif
}










void czm_writeLogDepth() {
#ifdef LOG_DEPTH
    czm_writeLogDepth(v_depthFromNearPlusOne);
#endif
}







vec3 czm_linearToSrgb(vec3 linearIn) 
{
    return pow(linearIn, vec3(1.0/2.2));
}

vec4 czm_linearToSrgb(vec4 linearIn) 
{
    vec3 srgbOut = pow(linearIn.rgb, vec3(1.0/2.2));
    return vec4(srgbOut, linearIn.a);
}










vec3 czm_gammaCorrect(vec3 color) {
#ifdef HDR
    color = pow(color, vec3(czm_gamma));
#endif
    return color;
}

vec4 czm_gammaCorrect(vec4 color) {
#ifdef HDR
    color.rgb = pow(color.rgb, vec3(czm_gamma));
#endif
    return color;
}

vec3 lambertianDiffuse(vec3 diffuseColor)
{
    return diffuseColor / czm_pi;
}

vec3 fresnelSchlick2(vec3 f0, vec3 f90, float VdotH)
{
    float versine = 1.0 - VdotH;
    
    float versineSquared = versine * versine;
    return f0 + (f90 - f0) * versineSquared * versineSquared * versine;
}

#ifdef USE_ANISOTROPY






float smithVisibilityGGX_anisotropic(float bitangentRoughness, float tangentialRoughness, vec3 lightDirection, vec3 viewDirection)
{
    vec3 roughnessScale = vec3(tangentialRoughness, bitangentRoughness, 1.0);
    float GGXV = lightDirection.z * length(roughnessScale * viewDirection);
    float GGXL = viewDirection.z * length(roughnessScale * lightDirection);
    float v = 0.5 / (GGXV + GGXL);
    return clamp(v, 0.0, 1.0);
}






float GGX_anisotropic(float bitangentRoughness, float tangentialRoughness, vec3 halfwayDirection)
{
    float roughnessSquared = bitangentRoughness * tangentialRoughness;
    vec3 f = halfwayDirection * vec3(bitangentRoughness, tangentialRoughness, roughnessSquared);
    float w2 = roughnessSquared / dot(f, f);
    return roughnessSquared * w2 * w2 / czm_pi;
}
#endif













float smithVisibilityGGX(float alphaRoughness, float NdotL, float NdotV)
{
    float alphaRoughnessSq = alphaRoughness * alphaRoughness;

    float GGXV = NdotL * sqrt(NdotV * NdotV * (1.0 - alphaRoughnessSq) + alphaRoughnessSq);
    float GGXL = NdotV * sqrt(NdotL * NdotL * (1.0 - alphaRoughnessSq) + alphaRoughnessSq);

    float GGX = GGXV + GGXL;
    if (GGX > 0.0)
    {
        return 0.5 / GGX;
    }
    return 0.0;
}










float GGX(float alphaRoughness, float NdotH)
{
    float alphaRoughnessSquared = alphaRoughness * alphaRoughness;
    float f = (NdotH * alphaRoughnessSquared - NdotH) * NdotH + 1.0;
    return alphaRoughnessSquared / (czm_pi * f * f);
}











float computeDirectSpecularStrength(vec3 normal, vec3 lightDirection, vec3 viewDirection, vec3 halfwayDirection, float alphaRoughness)
{
    float NdotL = clamp(dot(normal, lightDirection), 0.0, 1.0);
    float NdotV = clamp(dot(normal, viewDirection), 0.0, 1.0);
    float G = smithVisibilityGGX(alphaRoughness, NdotL, NdotV);
    float NdotH = clamp(dot(normal, halfwayDirection), 0.0, 1.0);
    float D = GGX(alphaRoughness, NdotH);
    return G * D;
}


















void czm_pbrLighting(vec3 viewDirectionEC, vec3 normalEC, vec3 lightDirectionEC, czm_modelMaterial material, out vec3 directDiffuse, out vec3 directSpecular)
{
    vec3 halfwayDirectionEC = normalize(viewDirectionEC + lightDirectionEC);
    float VdotH = clamp(dot(viewDirectionEC, halfwayDirectionEC), 0.0, 1.0);
    float NdotL = clamp(dot(normalEC, lightDirectionEC), 0.001, 1.0);

    vec3 f0 = material.specular;
    float reflectance = czm_maximumComponent(f0);
    
    
    vec3 f90 = vec3(clamp(reflectance * 25.0, 0.0, 1.0));
    vec3 F = fresnelSchlick2(f0, f90, VdotH);

    #if defined(USE_SPECULAR)
        F *= material.specularWeight;
    #endif

    float alphaRoughness = material.roughness * material.roughness;
    #ifdef USE_ANISOTROPY
        mat3 tbn = mat3(material.anisotropicT, material.anisotropicB, normalEC);
        vec3 lightDirection = lightDirectionEC * tbn;
        vec3 viewDirection = viewDirectionEC * tbn;
        vec3 halfwayDirection = halfwayDirectionEC * tbn;
        float anisotropyStrength = material.anisotropyStrength;
        float tangentialRoughness = mix(alphaRoughness, 1.0, anisotropyStrength * anisotropyStrength);
        float bitangentRoughness = clamp(alphaRoughness, 0.001, 1.0);
        float G = smithVisibilityGGX_anisotropic(bitangentRoughness, tangentialRoughness, lightDirection, viewDirection);
        float D = GGX_anisotropic(bitangentRoughness, tangentialRoughness, halfwayDirection);
        vec3 specularContribution = F * G * D;
    #else
        float specularStrength = computeDirectSpecularStrength(normalEC, lightDirectionEC, viewDirectionEC, halfwayDirectionEC, alphaRoughness);
        vec3 specularContribution = F * specularStrength;
    #endif

    vec3 diffuseColor = material.diffuse;
    
    vec3 diffuseContribution = (1.0 - F) * lambertianDiffuse(diffuseColor);

    
    directDiffuse = diffuseContribution * NdotL;
    directSpecular = specularContribution * NdotL;
}

vec3 czm_pbrLighting(vec3 viewDirectionEC, vec3 normalEC, vec3 lightDirectionEC, czm_modelMaterial material) {
    vec3 directDiffuse, directSpecular;
    czm_pbrLighting(viewDirectionEC, normalEC, lightDirectionEC, material, directDiffuse, directSpecular);
    return directDiffuse + directSpecular;
}

uniform vec3 czm_lightDirectionEC;
uniform vec3 czm_lightColorHdr;
uniform vec4 czm_backgroundColor;






vec3 czm_srgbToLinear(vec3 srgbIn)
{
    return pow(srgbIn, vec3(2.2));
}

vec4 czm_srgbToLinear(vec4 srgbIn) 
{
    vec3 linearOut = pow(srgbIn.rgb, vec3(2.2));
    return vec4(linearOut, srgbIn.a);
}





















vec2 czm_computeTextureTransform(vec2 texCoord, mat3 textureTransform)
{
    return vec2(textureTransform * vec3(texCoord, 1.0));
}






const float czm_epsilon3 = 0.001;















vec4 czm_computeAtmosphereColor(
    vec3 positionWC,
    vec3 lightDirection,
    vec3 rayleighColor,
    vec3 mieColor,
    float opacity
) {
    
    vec3 cameraToPositionWC = positionWC - czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);

    float cosAngle = dot(cameraToPositionWCDirection, lightDirection);
    float cosAngleSq = cosAngle * cosAngle;

    float G = czm_atmosphereMieAnisotropy;
    float GSq = G * G;

    
    float rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);
    
    float miePhase = 3.0 / (25.1327412287) * ((1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));

    
    vec3 rayleigh = rayleighPhase * rayleighColor;
    vec3 mie = miePhase * mieColor;

    vec3 color = (rayleigh + mie) * czm_atmosphereLightIntensity;

    return vec4(color, opacity);
}















vec4 czm_computeAtmosphereColor(
    czm_ray primaryRay,
    vec3 lightDirection,
    vec3 rayleighColor,
    vec3 mieColor,
    float opacity
) {
    vec3 direction = normalize(primaryRay.direction);

    float cosAngle = dot(direction, lightDirection);
    float cosAngleSq = cosAngle * cosAngle;

    float G = czm_atmosphereMieAnisotropy;
    float GSq = G * G;

    
    float rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);
    
    float miePhase = 3.0 / (25.1327412287) * ((1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));

    
    vec3 rayleigh = rayleighPhase * rayleighColor;
    vec3 mie = miePhase * mieColor;

    vec3 color = (rayleigh + mie) * czm_atmosphereLightIntensity;

    return vec4(color, opacity);
}


uniform vec3 czm_atmosphereHsbShift;









vec3 czm_applyHSBShift(vec3 rgb, vec3 hsbShift, bool ignoreBlackPixels) {
    
    vec3 hsb = czm_RGBToHSB(rgb);

    
    
    hsb.x += hsbShift.x; 
    hsb.y = clamp(hsb.y + hsbShift.y, 0.0, 1.0); 

    
    
    
    
    if (ignoreBlackPixels) {
        hsb.z = hsb.z > czm_epsilon7 ? hsb.z + hsbShift.z : 0.0;
    } else {
        hsb.z = hsb.z + hsbShift.z;
    }
    hsb.z = clamp(hsb.z, 0.0, 1.0);

    
    return czm_HSBToRGB(hsb);
}














void czm_computeGroundAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity) {
    vec3 cameraToPositionWC = positionWC - czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czm_viewerPositionWC, cameraToPositionWCDirection);

    float atmosphereInnerRadius = length(positionWC);

    czm_computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );
}












vec3 czm_getDynamicAtmosphereLightDirection(vec3 positionWC, float lightEnum) {
    const float NONE = 0.0;
    const float SCENE_LIGHT = 1.0;
    const float SUNLIGHT = 2.0;

    vec3 lightDirection =
        positionWC * float(lightEnum == NONE) +
        czm_lightDirectionWC * float(lightEnum == SCENE_LIGHT) +
        czm_sunDirectionWC * float(lightEnum == SUNLIGHT);
    return normalize(lightDirection);
}

uniform float czm_fogVisualDensityScalar;












vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor)
{
    float scalar = distanceToCamera * czm_fogDensity;
    float fog = 1.0 - exp(-(scalar * scalar));
    return mix(color, fogColor, fog);
}














vec3 czm_fog(float distanceToCamera, vec3 color, vec3 fogColor, float fogModifierConstant)
{
    float scalar = distanceToCamera * czm_fogDensity;
    float fog = 1.0 - exp(-((fogModifierConstant * scalar + fogModifierConstant) * (scalar * (1.0 + fogModifierConstant))));
    return mix(color, fogColor, fog);
}










vec3 czm_inverseGamma(vec3 color) {
    return pow(color, vec3(1.0 / czm_gamma));
}






vec3 czm_pbrNeutralTonemapping(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;

    float x = min(color.r, min(color.g, color.b));
    float offset = czm_branchFreeTernary(x < 0.08, x - 6.25 * x * x, 0.04);
    color -= offset;

    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;

    const float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;

    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, newPeak * vec3(1.0, 1.0, 1.0), g);
}

uniform float czm_fogMinimumBrightness;
uniform float czm_atmosphereDynamicLighting;
uniform vec3 czm_ellipsoidRadii;
uniform mat4 czm_model;
uniform sampler2D czm_brdfLut;
uniform samplerCube czm_specularEnvironmentMaps;
uniform float czm_specularEnvironmentMapsMaximumLOD;










vec4 czm_textureCube(samplerCube sampler, vec3 p) {
#if __VERSION__ == 300
    return texture(sampler, p);
#else
    return textureCube(sampler, p);
#endif
}












vec4 czm_textureCube(samplerCube sampler, vec3 p, float lod) {
#if __VERSION__ == 300
    return textureLod(sampler, p, lod);
#elif defined(GL_EXT_shader_texture_lod)
    return textureCubeLodEXT(sampler, p, lod);
#endif
}
uniform vec3 czm_sphericalHarmonicCoefficients[9];















vec3 czm_sphericalHarmonics(vec3 normal, vec3 coefficients[9])
{
    vec3 L00 = coefficients[0];
    vec3 L1_1 = coefficients[1];
    vec3 L10 = coefficients[2];
    vec3 L11 = coefficients[3];
    vec3 L2_2 = coefficients[4];
    vec3 L2_1 = coefficients[5];
    vec3 L20 = coefficients[6];
    vec3 L21 = coefficients[7];
    vec3 L22 = coefficients[8];

    float x = normal.x;
    float y = normal.y;
    float z = normal.z;

    vec3 L =
          L00
        + L1_1 * y
        + L10 * z
        + L11 * x
        + L2_2 * (y * x)
        + L2_1 * (y * z)
        + L20 * (3.0 * z * z - 1.0)
        + L21 * (z * x)
        + L22 * (x * x - y * y);
        
    return max(L, vec3(0.0));
}














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
uniform bool u_lumenEnabled;
uniform vec3 u_lumenIrradiance;
uniform float u_lumenCoverage;
uniform bool u_lumenPbrDiffuseResponse;
uniform bool u_lumenEnhancedIbl;
uniform bool u_lumenWorldEnabled;
uniform bool u_lumenLinearAtlas;
uniform sampler2D u_lumenProbeIrradiance;
uniform sampler2D u_lumenProbeDistances;
uniform sampler2D u_lumenProbePositions;
uniform mat4 u_lumenEyeToLocal;
uniform vec3 u_lumenProbeOrigin;
uniform vec3 u_lumenProbeCounts;
uniform float u_lumenProbeSpacing;
uniform float u_lumenNormalBias;
uniform float u_lumenWorldGain;
uniform bool u_lumenLegacyKernel;
uniform vec4 u_lumenGatherControl;
uniform vec2 model_iblFactor;
uniform mat3 model_iblReferenceFrameMatrix;
uniform vec3 model_sphericalHarmonicCoefficients[9];
uniform bool u_isInFog;
uniform vec3 u_emissiveFactor;
uniform vec4 u_baseColorFactor;
uniform float u_metallicFactor;
uniform float u_roughnessFactor;
uniform float u_lumenDiagnosticFloorZ;
uniform float u_lumenDiagnosticSurface;
uniform bool u_lumenFgPackedNormals;
uniform bool u_lumenFgCurved;
uniform bool u_lumenFgLazyFallback;
uniform float u_lumenFgSurfaceId;
uniform float u_lumenFgFallbackCode;
uniform bool u_lumenReceiverSupported;
uniform bool u_lumenFgEnabled;
uniform bool u_lumenFgRawMode;
uniform sampler2D u_lumenFgNodes;
uniform sampler2D u_lumenFgVertices;
uniform int u_lumenFgNodeCount;
uniform int u_lumenFgBarrierBudget;
uniform bool u_lumenFgHistory;
uniform sampler2D u_lumenFgFiltered;
uniform sampler2D u_lumenFgTexture;
uniform sampler2D u_lumenFgNeighborhood;
uniform sampler2D u_lumenReceiverPosition;
uniform sampler2D u_lumenReceiverNormal;
uniform vec2 u_lumenReceiverSize;
uniform vec2 u_lumenFgSize;
uniform vec2 u_lumenFgOffset;
uniform vec2 u_lumenFgSceneSize;
uniform vec4 czm_pickColor;
in vec3 v_atmosphereRayleighColor;
in vec3 v_atmosphereMieColor;
in float v_atmosphereOpacity;
in vec3 v_positionWC;
in vec3 v_positionEC;
in vec3 v_positionMC;
in vec3 v_normalEC;
in vec2 v_texCoord_0;
struct ProcessedAttributes
{
    vec3 positionWC;
    vec3 positionEC;
    vec3 positionMC;
    vec3 normalEC;
    vec2 texCoord_0;
};
struct SelectedFeature
{
    float _empty;
};
struct FeatureIds
{
    float _empty;
};
struct Metadata
{
    float _empty;
};
struct MetadataClass
{
    float _empty;
};
struct MetadataStatistics
{
    float _empty;
};
void setDynamicVaryings(inout ProcessedAttributes attributes)
{
    attributes.texCoord_0 = v_texCoord_0;
}
void initializeFeatureIds(out FeatureIds featureIds, ProcessedAttributes attributes)
{
}
void initializeFeatureIdAliases(inout FeatureIds featureIds)
{
}
void initializeMetadata(FeatureIds featureIds, out Metadata metadata, out MetadataClass metadataClass, out MetadataStatistics metadataStatistics, ProcessedAttributes attributes)
{
}
void metadataPickingStage(Metadata metadata, MetadataClass metadataClass, inout vec4 metadataValues)
{
    METADATA_PICKING_VALUE_TYPE value = METADATA_PICKING_VALUE_TYPE(METADATA_PICKING_VALUE_STRING);
    metadataValues.x = METADATA_PICKING_VALUE_COMPONENT_X;
    metadataValues.y = METADATA_PICKING_VALUE_COMPONENT_Y;
    metadataValues.z = METADATA_PICKING_VALUE_COMPONENT_Z;
    metadataValues.w = METADATA_PICKING_VALUE_COMPONENT_W;
}


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

#ifdef LUMEN_MODEL_LIGHTING
vec3 lumen_environmentDiffuse = vec3(0.0);
vec3 lumen_environmentSpecular = vec3(0.0);
vec3 lumen_environmentMultiple = vec3(0.0);
vec3 lumen_iblDiffuseResponse = vec3(0.0);
#endif
#ifdef DIFFUSE_IBL
vec3 sampleDiffuseEnvironment(vec3 cubeDir)
{
    #ifdef CUSTOM_SPHERICAL_HARMONICS
        return czm_sphericalHarmonics(cubeDir, model_sphericalHarmonicCoefficients); 
    #else
        return czm_sphericalHarmonics(cubeDir, czm_sphericalHarmonicCoefficients); 
    #endif
}
#endif

#ifdef SPECULAR_IBL
vec3 sampleSpecularEnvironment(vec3 cubeDir, float roughness)
{
    #ifdef CUSTOM_SPECULAR_IBL
        float lod = roughness * model_specularEnvironmentMapsMaximumLOD;
        return czm_textureCube(model_specularEnvironmentMaps, cubeDir, lod).rgb;
    #else
        float lod = roughness * czm_specularEnvironmentMapsMaximumLOD;
        return czm_textureCube(czm_specularEnvironmentMaps, cubeDir, lod).rgb;
    #endif
}
vec3 computeSpecularIBL(vec3 cubeDir, float NdotV, vec3 f0, float roughness)
{
    
    
    vec3 f90 = max(vec3(1.0 - roughness), f0);
    vec3 F = fresnelSchlick2(f0, f90, NdotV);

    vec2 brdfLut = texture(czm_brdfLut, vec2(NdotV, roughness)).rg;
    vec3 specularSample = sampleSpecularEnvironment(cubeDir, roughness);

    return specularSample * (F * brdfLut.x + brdfLut.y);
}
#endif

#if defined(DIFFUSE_IBL) || defined(SPECULAR_IBL)










vec3 textureIBL(vec3 viewDirectionEC, vec3 normalEC, czm_modelMaterial material) {
    vec3 f0 = material.specular;
    float roughness = material.roughness;
    float specularWeight = 1.0;
    #ifdef USE_SPECULAR
        specularWeight = material.specularWeight;
    #endif
    float NdotV = clamp(dot(normalEC, viewDirectionEC), 0.0, 1.0);

    
    
    vec3 f90 = max(vec3(1.0 - roughness), f0);
    vec3 singleScatterFresnel = fresnelSchlick2(f0, f90, NdotV);

    vec2 brdfLut = texture(czm_brdfLut, vec2(NdotV, roughness)).rg;
    vec3 FssEss = specularWeight * (singleScatterFresnel * brdfLut.x + brdfLut.y);

    vec3 averageFresnel = f0 + (1.0 - f0) / 21.0;
    float Ems = specularWeight * (1.0 - brdfLut.x - brdfLut.y);
    vec3 FmsEms = FssEss * averageFresnel * Ems / (1.0 - averageFresnel * Ems);
    bool enhanced = false;
    #ifdef LUMEN_MODEL_LIGHTING
        enhanced = u_lumenEnabled && u_lumenEnhancedIbl;
    #endif
    
    vec3 scattering = 1.0 - FssEss - FmsEms;
    vec3 dielectricScattering = (enhanced ? max(vec3(0.0), scattering) : scattering) * material.diffuse;
    vec3 normalMC = normalize(model_iblReferenceFrameMatrix * normalEC);
    #ifdef DIFFUSE_IBL
        
        vec3 irradiance = sampleDiffuseEnvironment(normalMC);
        vec3 diffuseContribution = irradiance * (enhanced ? dielectricScattering : FmsEms + dielectricScattering) * model_iblFactor.x;
    #else
        vec3 diffuseContribution = vec3(0.0);
    #endif
    #ifdef LUMEN_MODEL_LIGHTING
        lumen_iblDiffuseResponse = dielectricScattering;
        
        if (u_lumenEnabled) diffuseContribution *= 1.0 - lumen_environmentCoverage;
    #endif
    #ifdef SPECULAR_IBL
        
        
        vec3 multipleContribution = enhanced ? sampleSpecularEnvironment(normalMC, 1.0) * FmsEms * model_iblFactor.y : vec3(0.0);
    #elif defined(DIFFUSE_IBL)
        vec3 multipleContribution = enhanced ? irradiance * FmsEms * model_iblFactor.x : vec3(0.0);
    #else
        vec3 multipleContribution = vec3(0.0);
    #endif

    #ifdef USE_ANISOTROPY
        
        vec3 anisotropyDirection = material.anisotropicB;
        vec3 anisotropicTangent = cross(anisotropyDirection, viewDirectionEC);
        vec3 anisotropicNormal = cross(anisotropicTangent, anisotropyDirection);
        float bendFactor = 1.0 - material.anisotropyStrength * (1.0 - roughness);
        float bendFactorPow4 = bendFactor * bendFactor * bendFactor * bendFactor;
        vec3 bentNormal = normalize(mix(anisotropicNormal, normalEC, bendFactorPow4));
        vec3 reflectEC = reflect(-viewDirectionEC, bentNormal);
    #else
        vec3 reflectEC = reflect(-viewDirectionEC, normalEC);
    #endif

    #ifdef SPECULAR_IBL
        vec3 reflectMC = normalize(model_iblReferenceFrameMatrix * reflectEC);
        vec3 radiance = sampleSpecularEnvironment(reflectMC, roughness);
        vec3 specularContribution = radiance * FssEss * model_iblFactor.y;
    #else
        vec3 specularContribution = vec3(0.0);
    #endif

    #ifdef LUMEN_MODEL_LIGHTING
    lumen_environmentDiffuse = diffuseContribution;
    lumen_environmentSpecular = specularContribution;
    lumen_environmentMultiple = multipleContribution;
    #endif
    return diffuseContribution + specularContribution + multipleContribution;
}
#endif







vec2 nearestPointOnEllipseFast(vec2 pos, vec2 radii) {
    vec2 p = abs(pos);
    vec2 inverseRadii = 1.0 / radii;
    vec2 evoluteScale = (radii.x * radii.x - radii.y * radii.y) * vec2(1.0, -1.0) * inverseRadii;

    
    
    
    vec2 tTrigs = vec2(0.70710678118);
    vec2 v = radii * tTrigs;

    
    vec2 evolute = evoluteScale * tTrigs * tTrigs * tTrigs;
    
    vec2 q = normalize(p - evolute) * length(v - evolute);
    
    tTrigs = (q + evolute) * inverseRadii;
    tTrigs = normalize(clamp(tTrigs, 0.0, 1.0));
    v = radii * tTrigs;

    return v * sign(pos);
}

vec3 computeEllipsoidPositionWC(vec3 positionMC) {
    
    
    vec3 positionWC = (czm_model * vec4(positionMC, 1.0)).xyz;

    vec2 positionEllipse = vec2(length(positionWC.xy), positionWC.z);
    vec2 nearestPoint = nearestPointOnEllipseFast(positionEllipse, czm_ellipsoidRadii.xz);

    
    return vec3(nearestPoint.x * normalize(positionWC.xy), nearestPoint.y);
}

void applyFog(inout vec4 color, vec4 groundAtmosphereColor, vec3 lightDirection, float distanceToCamera) {

    vec3 fogColor = groundAtmosphereColor.rgb;

    
    const float NONE = 0.0;
    if (czm_atmosphereDynamicLighting != NONE) {
        float darken = clamp(dot(normalize(czm_viewerPositionWC), lightDirection), czm_fogMinimumBrightness, 1.0);
        fogColor *= darken;
    }

    
    #ifndef HDR
        fogColor.rgb = czm_pbrNeutralTonemapping(fogColor.rgb);
        fogColor.rgb = czm_inverseGamma(fogColor.rgb);
    #endif

    vec3 withFog = czm_fog(distanceToCamera, color.rgb, fogColor, czm_fogVisualDensityScalar);
    color = vec4(withFog, color.a);
}

void atmosphereStage(inout vec4 color, in ProcessedAttributes attributes) {
    vec3 rayleighColor;
    vec3 mieColor;
    float opacity;

    vec3 positionWC;
    vec3 lightDirection;

    
    
    
    
    if (false) {
        positionWC = computeEllipsoidPositionWC(attributes.positionMC);
        lightDirection = czm_getDynamicAtmosphereLightDirection(positionWC, czm_atmosphereDynamicLighting);

        
        czm_computeGroundAtmosphereScattering(
            positionWC,
            lightDirection,
            rayleighColor,
            mieColor,
            opacity
        );
    } else {
        positionWC = attributes.positionWC;
        lightDirection = czm_getDynamicAtmosphereLightDirection(positionWC, czm_atmosphereDynamicLighting);
        rayleighColor = v_atmosphereRayleighColor;
        mieColor = v_atmosphereMieColor;
        opacity = v_atmosphereOpacity;
    }

    
    const bool ignoreBlackPixels = true;
    rayleighColor = czm_applyHSBShift(rayleighColor, czm_atmosphereHsbShift, ignoreBlackPixels);
    mieColor = czm_applyHSBShift(mieColor, czm_atmosphereHsbShift, ignoreBlackPixels);

    vec4 groundAtmosphereColor = czm_computeAtmosphereColor(positionWC, lightDirection, rayleighColor, mieColor, opacity);

    if (u_isInFog) {
        float distanceToCamera = length(attributes.positionEC);
        applyFog(color, groundAtmosphereColor, lightDirection, distanceToCamera);
    } else {
        
    }
}

void geometryStage(out ProcessedAttributes attributes)
{
  attributes.positionMC = v_positionMC;
  attributes.positionEC = v_positionEC;

  #if defined(COMPUTE_POSITION_WC_CUSTOM_SHADER) || defined(COMPUTE_POSITION_WC_STYLE) || defined(COMPUTE_POSITION_WC_ATMOSPHERE)
  attributes.positionWC = v_positionWC;
  #endif

  #ifdef HAS_NORMALS
  
  attributes.normalEC = normalize(v_normalEC);
  #endif

  #ifdef HAS_TANGENTS
  attributes.tangentEC = normalize(v_tangentEC);
  #endif

  #ifdef HAS_BITANGENTS
  attributes.bitangentEC = normalize(v_bitangentEC);
  #endif

  
  setDynamicVaryings(attributes);
}


bool isDefaultStyleColor(vec3 color)
{
    return all(greaterThan(color, vec3(1.0 - czm_epsilon3)));
}

vec3 blend(vec3 sourceColor, vec3 styleColor, float styleColorBlend)
{
    vec3 blendColor = mix(sourceColor, styleColor, styleColorBlend);
    vec3 color = isDefaultStyleColor(styleColor.rgb) ? sourceColor : blendColor;
    return color;
}

#ifdef HAS_NORMAL_TEXTURE
vec2 getNormalTexCoords()
{
    vec2 texCoord = TEXCOORD_NORMAL;
    #ifdef HAS_NORMAL_TEXTURE_TRANSFORM
        texCoord = czm_computeTextureTransform(texCoord, u_normalTextureTransform);
    #endif
    return texCoord;
}
#endif

#if defined(HAS_NORMAL_TEXTURE) || defined(HAS_CLEARCOAT_NORMAL_TEXTURE)
vec3 computeTangent(in vec3 position, in vec2 normalTexCoords)
{
    vec2 tex_dx = dFdx(normalTexCoords);
    vec2 tex_dy = dFdy(normalTexCoords);
    float determinant = tex_dx.x * tex_dy.y - tex_dy.x * tex_dx.y;
    vec3 tangent = tex_dy.t * dFdx(position) - tex_dx.t * dFdy(position);
    return tangent / determinant;
}
#endif

#ifdef USE_ANISOTROPY
struct NormalInfo {
    vec3 tangent;
    vec3 bitangent;
    vec3 normal;
    vec3 geometryNormal;
};

NormalInfo getNormalInfo(ProcessedAttributes attributes)
{
    vec3 geometryNormal = attributes.normalEC;
    #ifdef HAS_NORMAL_TEXTURE
        vec2 normalTexCoords = getNormalTexCoords();
    #endif

    #ifdef HAS_BITANGENTS
        vec3 tangent = attributes.tangentEC;
        vec3 bitangent = attributes.bitangentEC;
    #else 
        vec3 tangent = computeTangent(attributes.positionEC, normalTexCoords);
        tangent = normalize(tangent - geometryNormal * dot(geometryNormal, tangent));
        vec3 bitangent = normalize(cross(geometryNormal, tangent));
    #endif

    #ifdef HAS_NORMAL_TEXTURE
        mat3 tbn = mat3(tangent, bitangent, geometryNormal);
        
        vec3 normalSample;
        #if defined(HAS_NORMAL_CONSTANT_LOD) && defined(HAS_CONSTANT_LOD)
            #ifdef HAS_NORMAL_TEXTURE_TRANSFORM
                normalSample = constantLodTextureLookup(u_normalTexture, u_normalTextureConstantLodParams, u_normalTextureTransform).rgb;
            #else
                normalSample = constantLodTextureLookup(u_normalTexture, u_normalTextureConstantLodParams).rgb;
            #endif
        #else
            normalSample = texture(u_normalTexture, normalTexCoords).rgb;
        #endif
        
        normalSample = 2.0 * normalSample - 1.0;
        #ifdef HAS_NORMAL_TEXTURE_SCALE
            normalSample.xy *= u_normalTextureScale;
        #endif
        vec3 normal = normalize(tbn * normalSample);
    #else
        vec3 normal = geometryNormal;
    #endif

    #ifdef HAS_DOUBLE_SIDED_MATERIAL
        if (czm_backFacing()) {
            tangent *= -1.0;
            bitangent *= -1.0;
            normal *= -1.0;
            geometryNormal *= -1.0;
        }
    #endif

    NormalInfo normalInfo;
    normalInfo.tangent = tangent;
    normalInfo.bitangent = bitangent;
    normalInfo.normal = normal;
    normalInfo.geometryNormal = geometryNormal;

    return normalInfo;
}
#endif

#if defined(HAS_NORMAL_TEXTURE) && !defined(HAS_WIREFRAME)
vec3 getNormalFromTexture(ProcessedAttributes attributes, vec3 geometryNormal)
{
    vec2 normalTexCoords = getNormalTexCoords();

    
    #ifdef HAS_BITANGENTS
        vec3 t = attributes.tangentEC;
        vec3 b = attributes.bitangentEC;
    #else
        vec3 t = computeTangent(attributes.positionEC, normalTexCoords);
        t = normalize(t - geometryNormal * dot(geometryNormal, t));
        vec3 b = normalize(cross(geometryNormal, t));
    #endif

    mat3 tbn = mat3(t, b, geometryNormal);
    
    vec3 normalSample;
    #if defined(HAS_NORMAL_CONSTANT_LOD) && defined(HAS_CONSTANT_LOD)
        #ifdef HAS_NORMAL_TEXTURE_TRANSFORM
            normalSample = constantLodTextureLookup(u_normalTexture, u_normalTextureConstantLodParams, u_normalTextureTransform).rgb;
        #else
            normalSample = constantLodTextureLookup(u_normalTexture, u_normalTextureConstantLodParams).rgb;
        #endif
    #else
        normalSample = texture(u_normalTexture, normalTexCoords).rgb;
    #endif
    
    normalSample = 2.0 * normalSample - 1.0;
    #ifdef HAS_NORMAL_TEXTURE_SCALE
        normalSample.xy *= u_normalTextureScale;
    #endif
    return normalize(tbn * normalSample);
}
#endif

#ifdef HAS_CLEARCOAT_NORMAL_TEXTURE
vec3 getClearcoatNormalFromTexture(ProcessedAttributes attributes, vec3 geometryNormal)
{
    vec2 normalTexCoords = TEXCOORD_CLEARCOAT_NORMAL;
    #ifdef HAS_CLEARCOAT_NORMAL_TEXTURE_TRANSFORM
        normalTexCoords = vec2(u_clearcoatNormalTextureTransform * vec3(normalTexCoords, 1.0));
    #endif

    
    #ifdef HAS_BITANGENTS
        vec3 t = attributes.tangentEC;
        vec3 b = attributes.bitangentEC;
    #else
        vec3 t = computeTangent(attributes.positionEC, normalTexCoords);
        t = normalize(t - geometryNormal * dot(geometryNormal, t));
        vec3 b = normalize(cross(geometryNormal, t));
    #endif

    mat3 tbn = mat3(t, b, geometryNormal);
    vec3 normalSample = texture(u_clearcoatNormalTexture, normalTexCoords).rgb;
    normalSample = 2.0 * normalSample - 1.0;
    #ifdef HAS_CLEARCOAT_NORMAL_TEXTURE_SCALE
        normalSample.xy *= u_clearcoatNormalTextureScale;
    #endif
    return normalize(tbn * normalSample);
}
#endif

#ifdef HAS_NORMALS
vec3 computeNormal(ProcessedAttributes attributes)
{
    
    vec3 normal = attributes.normalEC;

    #if defined(HAS_NORMAL_TEXTURE) && !defined(HAS_WIREFRAME)
        normal = getNormalFromTexture(attributes, normal);
    #endif

    #ifdef HAS_DOUBLE_SIDED_MATERIAL
        if (czm_backFacing()) {
            normal = -normal;
        }
    #endif

    return normal;
}
#endif

#ifdef HAS_BASE_COLOR_TEXTURE
vec4 getBaseColorFromTexture()
{
    vec2 baseColorTexCoords = TEXCOORD_BASE_COLOR;
    #ifdef HAS_BASE_COLOR_TEXTURE_TRANSFORM
        baseColorTexCoords = czm_computeTextureTransform(baseColorTexCoords, u_baseColorTextureTransform);
    #endif

    vec4 baseColorWithAlpha;
    #if defined(HAS_BASE_COLOR_CONSTANT_LOD) && defined(HAS_CONSTANT_LOD)
        #ifdef HAS_BASE_COLOR_TEXTURE_TRANSFORM
            baseColorWithAlpha = czm_srgbToLinear(constantLodTextureLookup(u_baseColorTexture, u_baseColorTextureConstantLodParams, u_baseColorTextureTransform));
        #else
            baseColorWithAlpha = czm_srgbToLinear(constantLodTextureLookup(u_baseColorTexture, u_baseColorTextureConstantLodParams));
        #endif
    #else
        baseColorWithAlpha = czm_srgbToLinear(texture(u_baseColorTexture, baseColorTexCoords));
    #endif

    #ifdef HAS_BASE_COLOR_FACTOR
        baseColorWithAlpha *= u_baseColorFactor;
    #endif

    return baseColorWithAlpha;
}
#endif

#ifdef HAS_EMISSIVE_TEXTURE
vec3 getEmissiveFromTexture()
{
    vec2 emissiveTexCoords = TEXCOORD_EMISSIVE;
    #ifdef HAS_EMISSIVE_TEXTURE_TRANSFORM
        emissiveTexCoords = czm_computeTextureTransform(emissiveTexCoords, u_emissiveTextureTransform);
    #endif

    vec3 emissive = czm_srgbToLinear(texture(u_emissiveTexture, emissiveTexCoords).rgb);
    #ifdef HAS_EMISSIVE_FACTOR
        emissive *= u_emissiveFactor;
    #endif

    return emissive;
}
#endif

#if defined(LIGHTING_PBR) && defined(USE_SPECULAR_GLOSSINESS)
void setSpecularGlossiness(inout czm_modelMaterial material)
{
    #ifdef HAS_SPECULAR_GLOSSINESS_TEXTURE
        vec2 specularGlossinessTexCoords = TEXCOORD_SPECULAR_GLOSSINESS;
        #ifdef HAS_SPECULAR_GLOSSINESS_TEXTURE_TRANSFORM
            specularGlossinessTexCoords = czm_computeTextureTransform(specularGlossinessTexCoords, u_specularGlossinessTextureTransform);
        #endif

        vec4 specularGlossiness = czm_srgbToLinear(texture(u_specularGlossinessTexture, specularGlossinessTexCoords));
        vec3 specular = specularGlossiness.rgb;
        float glossiness = specularGlossiness.a;
        #ifdef HAS_LEGACY_SPECULAR_FACTOR
            specular *= u_legacySpecularFactor;
        #endif

        #ifdef HAS_GLOSSINESS_FACTOR
            glossiness *= u_glossinessFactor;
        #endif
    #else
        #ifdef HAS_LEGACY_SPECULAR_FACTOR
            vec3 specular = clamp(u_legacySpecularFactor, vec3(0.0), vec3(1.0));
        #else
            vec3 specular = vec3(1.0);
        #endif

        #ifdef HAS_GLOSSINESS_FACTOR
            float glossiness = clamp(u_glossinessFactor, 0.0, 1.0);
        #else
            float glossiness = 1.0;
        #endif
    #endif

    #ifdef HAS_DIFFUSE_TEXTURE
        vec2 diffuseTexCoords = TEXCOORD_DIFFUSE;
        #ifdef HAS_DIFFUSE_TEXTURE_TRANSFORM
            diffuseTexCoords = czm_computeTextureTransform(diffuseTexCoords, u_diffuseTextureTransform);
        #endif

        vec4 diffuse = czm_srgbToLinear(texture(u_diffuseTexture, diffuseTexCoords));
        #ifdef HAS_DIFFUSE_FACTOR
            diffuse *= u_diffuseFactor;
        #endif
    #elif defined(HAS_DIFFUSE_FACTOR)
        vec4 diffuse = clamp(u_diffuseFactor, vec4(0.0), vec4(1.0));
    #else
        vec4 diffuse = vec4(1.0);
    #endif

    material.diffuse = diffuse.rgb * (1.0 - czm_maximumComponent(specular));
    
    
    material.alpha = diffuse.a;

    material.specular = specular;

    
    material.roughness = 1.0 - glossiness;
}
#elif defined(LIGHTING_PBR)
float setMetallicRoughness(inout czm_modelMaterial material)
{
    #ifdef HAS_METALLIC_ROUGHNESS_TEXTURE
        vec2 metallicRoughnessTexCoords = TEXCOORD_METALLIC_ROUGHNESS;
        #ifdef HAS_METALLIC_ROUGHNESS_TEXTURE_TRANSFORM
            metallicRoughnessTexCoords = czm_computeTextureTransform(metallicRoughnessTexCoords, u_metallicRoughnessTextureTransform);
        #endif

        vec3 metallicRoughness = texture(u_metallicRoughnessTexture, metallicRoughnessTexCoords).rgb;
        float metalness = clamp(metallicRoughness.b, 0.0, 1.0);
        float roughness = clamp(metallicRoughness.g, 0.0, 1.0);
        #ifdef HAS_METALLIC_FACTOR
            metalness = clamp(metalness * u_metallicFactor, 0.0, 1.0);
        #endif

        #ifdef HAS_ROUGHNESS_FACTOR
            roughness = clamp(roughness * u_roughnessFactor, 0.0, 1.0);
        #endif
    #else
        #ifdef HAS_METALLIC_FACTOR
            float metalness = clamp(u_metallicFactor, 0.0, 1.0);
        #else
            float metalness = 1.0;
        #endif

        #ifdef HAS_ROUGHNESS_FACTOR
            float roughness = clamp(u_roughnessFactor, 0.0, 1.0);
        #else
            float roughness = 1.0;
        #endif
    #endif

    
    const vec3 REFLECTANCE_DIELECTRIC = vec3(0.04);
    vec3 f0 = mix(REFLECTANCE_DIELECTRIC, material.baseColor.rgb, metalness);

    material.specular = f0;

    
    material.diffuse = mix(material.baseColor.rgb, vec3(0.0), metalness);

    
    material.roughness = roughness;

    return metalness;
}
#ifdef USE_SPECULAR
void setSpecular(inout czm_modelMaterial material, in float metalness)
{
    #ifdef HAS_SPECULAR_TEXTURE
        vec2 specularTexCoords = TEXCOORD_SPECULAR;
        #ifdef HAS_SPECULAR_TEXTURE_TRANSFORM
            specularTexCoords = czm_computeTextureTransform(specularTexCoords, u_specularTextureTransform);
        #endif
        float specularWeight = texture(u_specularTexture, specularTexCoords).a;
        #ifdef HAS_SPECULAR_FACTOR
            specularWeight *= u_specularFactor;
        #endif
    #else
        #ifdef HAS_SPECULAR_FACTOR
            float specularWeight = u_specularFactor;
        #else
            float specularWeight = 1.0;
        #endif
    #endif

    #ifdef HAS_SPECULAR_COLOR_TEXTURE
        vec2 specularColorTexCoords = TEXCOORD_SPECULAR_COLOR;
        #ifdef HAS_SPECULAR_COLOR_TEXTURE_TRANSFORM
            specularColorTexCoords = czm_computeTextureTransform(specularColorTexCoords, u_specularColorTextureTransform);
        #endif
        vec3 specularColorSample = texture(u_specularColorTexture, specularColorTexCoords).rgb;
        vec3 specularColorFactor = czm_srgbToLinear(specularColorSample);
        #ifdef HAS_SPECULAR_COLOR_FACTOR
            specularColorFactor *= u_specularColorFactor;
        #endif
    #else
        #ifdef HAS_SPECULAR_COLOR_FACTOR
            vec3 specularColorFactor = u_specularColorFactor;
        #else
            vec3 specularColorFactor = vec3(1.0);
        #endif
    #endif
    material.specularWeight = specularWeight;
    vec3 f0 = material.specular;
    vec3 dielectricSpecularF0 = min(f0 * specularColorFactor, vec3(1.0));
    material.specular = mix(dielectricSpecularF0, material.baseColor.rgb, metalness);
}
#endif
#ifdef USE_ANISOTROPY
void setAnisotropy(inout czm_modelMaterial material, in NormalInfo normalInfo)
{
    mat2 rotation = mat2(u_anisotropy.xy, -u_anisotropy.y, u_anisotropy.x);
    float anisotropyStrength = u_anisotropy.z;

    vec2 direction = vec2(1.0, 0.0);
    #ifdef HAS_ANISOTROPY_TEXTURE
        vec2 anisotropyTexCoords = TEXCOORD_ANISOTROPY;
        #ifdef HAS_ANISOTROPY_TEXTURE_TRANSFORM
            anisotropyTexCoords = czm_computeTextureTransform(anisotropyTexCoords, u_anisotropyTextureTransform);
        #endif
        vec3 anisotropySample = texture(u_anisotropyTexture, anisotropyTexCoords).rgb;
        direction = anisotropySample.rg * 2.0 - vec2(1.0);
        anisotropyStrength *= anisotropySample.b;
    #endif

    direction = rotation * direction;
    mat3 tbn = mat3(normalInfo.tangent, normalInfo.bitangent, normalInfo.normal);
    vec3 anisotropicT = tbn * normalize(vec3(direction, 0.0));
    vec3 anisotropicB = cross(normalInfo.geometryNormal, anisotropicT);

    material.anisotropicT = anisotropicT;
    material.anisotropicB = anisotropicB;
    material.anisotropyStrength = anisotropyStrength;
}
#endif
#ifdef USE_CLEARCOAT
void setClearcoat(inout czm_modelMaterial material, in ProcessedAttributes attributes)
{
    #ifdef HAS_CLEARCOAT_TEXTURE
        vec2 clearcoatTexCoords = TEXCOORD_CLEARCOAT;
        #ifdef HAS_CLEARCOAT_TEXTURE_TRANSFORM
            clearcoatTexCoords = czm_computeTextureTransform(clearcoatTexCoords, u_clearcoatTextureTransform);
        #endif
        float clearcoatFactor = texture(u_clearcoatTexture, clearcoatTexCoords).r;
        #ifdef HAS_CLEARCOAT_FACTOR
            clearcoatFactor *= u_clearcoatFactor;
        #endif
    #else
        #ifdef HAS_CLEARCOAT_FACTOR
            float clearcoatFactor = u_clearcoatFactor;
        #else
            
            float clearcoatFactor = 0.0;
        #endif
    #endif

    #ifdef HAS_CLEARCOAT_ROUGHNESS_TEXTURE
        vec2 clearcoatRoughnessTexCoords = TEXCOORD_CLEARCOAT_ROUGHNESS;
        #ifdef HAS_CLEARCOAT_ROUGHNESS_TEXTURE_TRANSFORM
            clearcoatRoughnessTexCoords = czm_computeTextureTransform(clearcoatRoughnessTexCoords, u_clearcoatRoughnessTextureTransform);
        #endif
        float clearcoatRoughness = texture(u_clearcoatRoughnessTexture, clearcoatRoughnessTexCoords).g;
        #ifdef HAS_CLEARCOAT_ROUGHNESS_FACTOR
            clearcoatRoughness *= u_clearcoatRoughnessFactor;
        #endif
    #else
        #ifdef HAS_CLEARCOAT_ROUGHNESS_FACTOR
            float clearcoatRoughness = u_clearcoatRoughnessFactor;
        #else
            float clearcoatRoughness = 0.0;
        #endif
    #endif

    material.clearcoatFactor = clearcoatFactor;
    
    material.clearcoatRoughness = clearcoatRoughness;
    #ifdef HAS_CLEARCOAT_NORMAL_TEXTURE
        material.clearcoatNormal = getClearcoatNormalFromTexture(attributes, attributes.normalEC);
    #else
        material.clearcoatNormal = attributes.normalEC;
    #endif
}
#endif
#endif

void materialStage(inout czm_modelMaterial material, ProcessedAttributes attributes, SelectedFeature feature)
{
    #ifdef USE_ANISOTROPY
        NormalInfo normalInfo = getNormalInfo(attributes);
        material.normalEC = normalInfo.normal;
    #elif defined(HAS_NORMALS)
        material.normalEC = computeNormal(attributes);
    #endif

    vec4 baseColorWithAlpha = vec4(1.0);
    
    
    
    
    
    #ifdef HAS_BACKGROUND_FILL
        baseColorWithAlpha = czm_srgbToLinear(czm_backgroundColor);
    #elif defined(HAS_BASE_COLOR_TEXTURE)
        baseColorWithAlpha = getBaseColorFromTexture();
    #elif defined(HAS_BASE_COLOR_FACTOR)
        baseColorWithAlpha = u_baseColorFactor;
    #endif

    #ifdef HAS_IMAGERY
    baseColorWithAlpha = blendBaseColorWithImagery(baseColorWithAlpha);
    #endif 

    #ifdef HAS_POINT_CLOUD_COLOR_STYLE
        baseColorWithAlpha = v_pointCloudColor;
    #elif defined(HAS_COLOR_0)
        vec4 color = attributes.color_0;
        
        #ifdef HAS_SRGB_COLOR
            color = czm_srgbToLinear(color);
        #endif
        baseColorWithAlpha *= color;
    #endif

    #ifdef USE_CPU_STYLING
        baseColorWithAlpha.rgb = blend(baseColorWithAlpha.rgb, feature.color.rgb, model_colorBlend);
    #endif
    material.baseColor = baseColorWithAlpha;
    material.diffuse = baseColorWithAlpha.rgb;
    material.alpha = baseColorWithAlpha.a;

    #ifdef HAS_OCCLUSION_TEXTURE
        vec2 occlusionTexCoords = TEXCOORD_OCCLUSION;
        #ifdef HAS_OCCLUSION_TEXTURE_TRANSFORM
            occlusionTexCoords = czm_computeTextureTransform(occlusionTexCoords, u_occlusionTextureTransform);
        #endif
        material.occlusion = texture(u_occlusionTexture, occlusionTexCoords).r;
    #endif

    #ifdef HAS_EMISSIVE_TEXTURE
        material.emissive = getEmissiveFromTexture();
    #elif defined(HAS_EMISSIVE_FACTOR)
        material.emissive = u_emissiveFactor;
    #endif

    #if defined(LIGHTING_PBR) && defined(USE_SPECULAR_GLOSSINESS)
        setSpecularGlossiness(material);
    #elif defined(LIGHTING_PBR)
        float metalness = setMetallicRoughness(material);
        #ifdef USE_SPECULAR
            setSpecular(material, metalness);
        #endif
        #ifdef USE_ANISOTROPY
            setAnisotropy(material, normalInfo);
        #endif
        #ifdef USE_CLEARCOAT
            setClearcoat(material, attributes);
        #endif
    #endif
}

void featureIdStage(out FeatureIds featureIds, ProcessedAttributes attributes) {
  initializeFeatureIds(featureIds, attributes);
  initializeFeatureIdAliases(featureIds);
}

void metadataStage(
  FeatureIds featureIds,
  out Metadata metadata,
  out MetadataClass metadataClass,
  out MetadataStatistics metadataStatistics,
  ProcessedAttributes attributes
  )
{
  initializeMetadata(featureIds, metadata, metadataClass, metadataStatistics, attributes);
}

#ifdef LUMEN_RECEIVER_COMPOSITE

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
}
#endif

#ifdef LUMEN_MODEL_LIGHTING
float lumen_shadowVisibility = 1.0;
#endif
#ifdef LUMEN_GBUFFER
vec4 lumen_albedo = vec4(0.0);
vec4 lumen_normalRoughness = vec4(0.0);
vec4 lumen_positionDepth = vec4(0.0);
vec4 lumen_emissive = vec4(0.0);
#endif

#ifdef USE_IBL_LIGHTING
vec3 computeIBL(vec3 position, vec3 normal, vec3 lightDirection, vec3 lightColorHdr, czm_modelMaterial material)
{
    #if defined(DIFFUSE_IBL) || defined(SPECULAR_IBL)
        
        vec3 viewDirection = -normalize(position);
        vec3 iblColor = textureIBL(viewDirection, normal, material);
        return iblColor;
    #endif
    
    return vec3(0.0);
}
#endif

#ifdef USE_CLEARCOAT
vec3 addClearcoatReflection(vec3 baseLayerColor, vec3 position, vec3 lightDirection, vec3 lightColorHdr, czm_modelMaterial material)
{
    vec3 viewDirection = -normalize(position);
    vec3 halfwayDirection = normalize(viewDirection + lightDirection);
    vec3 normal = material.clearcoatNormal;
    float NdotL = clamp(dot(normal, lightDirection), 0.001, 1.0);

    
    vec3 f0 = vec3(0.04);
    vec3 f90 = vec3(1.0);
    
    
    float NdotV = clamp(dot(normal, viewDirection), 0.0, 1.0);
    vec3 F = fresnelSchlick2(f0, f90, NdotV);

    
    float roughness = material.clearcoatRoughness;
    float alphaRoughness = roughness * roughness;
    float directStrength = computeDirectSpecularStrength(normal, lightDirection, viewDirection, halfwayDirection, alphaRoughness);
    vec3 directReflection = F * directStrength * NdotL;
    vec3 color = lightColorHdr * directReflection;

    #ifdef SPECULAR_IBL
        
        vec3 reflectMC = normalize(model_iblReferenceFrameMatrix * reflect(-viewDirection, normal));
        vec3 iblColor = computeSpecularIBL(reflectMC, NdotV, f0, roughness);
        color += iblColor * material.occlusion;
    #endif

    float clearcoatFactor = material.clearcoatFactor;
    vec3 clearcoatColor = color * clearcoatFactor;

    
    return baseLayerColor * (1.0 - clearcoatFactor * F) + clearcoatColor;
}
#endif

#if defined(LIGHTING_PBR) && defined(HAS_NORMALS)
vec3 computePbrLighting(in czm_modelMaterial material, in vec3 position, in vec3 geometricNormal)
{
    #ifdef USE_CUSTOM_LIGHT_COLOR
        vec3 lightColorHdr = model_lightColorHdr;
    #else
        vec3 lightColorHdr = czm_lightColorHdr;
    #endif

    vec3 viewDirection = -normalize(position);
    vec3 normal = material.normalEC;
    vec3 lightDirection = normalize(czm_lightDirectionEC);

    vec3 directDiffuse, directSpecular;
    czm_pbrLighting(viewDirection, normal, lightDirection, material, directDiffuse, directSpecular);
    vec3 directColor = lightColorHdr * (directDiffuse + directSpecular);

    #ifdef LUMEN_MODEL_LIGHTING
    vec3 indirectDiffuse = vec3(0.0), queriedE = vec3(0.0);
    if (u_lumenEnabled) {
        directColor *= lumen_shadowVisibility;
        vec3 irradiance = lumen_irradiance(position, normal, geometricNormal);
        queriedE = irradiance;
        
    }
    #endif

    #ifdef LUMEN_MODEL_LIGHTING
    lumen_iblDiffuseResponse = material.diffuse;
    lumen_environmentDiffuse = vec3(0.0);
    lumen_environmentSpecular = vec3(0.0);
    lumen_environmentMultiple = vec3(0.0);
    #endif
    
    vec3 color = directColor + material.emissive;
    #ifdef USE_IBL_LIGHTING
        color += computeIBL(position, normal, lightDirection, lightColorHdr, material);
    #endif

    #ifdef USE_CLEARCOAT
        color = addClearcoatReflection(color, position, lightDirection, lightColorHdr, material);
    #endif

    #ifdef LUMEN_MODEL_LIGHTING
    if (u_lumenEnabled) {
        vec3 response = u_lumenPbrDiffuseResponse ? lumen_iblDiffuseResponse : material.diffuse;
        indirectDiffuse = response * queriedE * (lumen_materialCoverage / czm_pi);
        color += indirectDiffuse;
        #ifdef LUMEN_DIAGNOSTICS
        if (u_lumenDebugMode == 1) color = directColor;
        if (u_lumenDebugMode == 2) color = indirectDiffuse;
        if (u_lumenDebugMode == 3) color = material.emissive;
        if (u_lumenDebugMode == 4) color = queriedE;
        if (u_lumenDebugMode == 5) color = vec3(lumen_dataCoverage);
        if (u_lumenDebugMode == 6) color = vec3(lumen_shadowVisibility);
        if (u_lumenDebugMode == 7) color = lightColorHdr * directDiffuse * lumen_shadowVisibility;
        if (u_lumenDebugMode == 8) color = lightColorHdr * directSpecular * lumen_shadowVisibility;
        if (u_lumenDebugMode == 9) color = lumen_environmentSpecular;
        if (u_lumenDebugMode == 10) color = lumen_environmentDiffuse;
        if (u_lumenDebugMode == 11) color -= indirectDiffuse;
        if (u_lumenDebugMode == 12) color = lumen_environmentMultiple;
        #ifdef LUMEN_RECEIVER_COMPOSITE
        if(u_lumenDebugMode==13||u_lumenFgRawMode)color=lumen_rawFg;
        if(u_lumenDebugMode==14)color=lumen_filteredFg;
        if(u_lumenDebugMode==15)color=vec3(lumen_fgWeight);
        if(u_lumenDebugMode==16){ivec2 c=ivec2(gl_FragCoord.xy/u_lumenFgSceneSize*u_lumenReceiverSize-u_lumenFgOffset);color=(all(greaterThanEqual(c,ivec2(0)))&&all(lessThan(c,ivec2(u_lumenFgSize))))?texelFetch(u_lumenFgNeighborhood,c,0).rrr:vec3(0);}
        if(u_lumenDebugMode==17)color=vec3(lumen_fgFallbackReason);
        
        
        if(u_lumenDebugMode==18)color=vec3(u_lumenFgCurved?1.0:0.0,acos(clamp(dot(lumen_triangleNormal(position),material.normalEC),-1.0,1.0)),lumen_volumeCoverage);
        
        if(u_lumenDebugMode==19)color=vec3(u_lumenFgCurved?128.0+u_lumenFgSurfaceId-4096.0:u_lumenDiagnosticSurface,u_lumenFgCurved?1.0:0.0,u_lumenFgCurved&&((u_lumenEyeToLocal*vec4(position,1.0)).z<=u_lumenDiagnosticFloorZ+0.04)?8.0:u_lumenDiagnosticSurface>0.0?4.0:0.0);
        if(u_lumenDebugMode==20){float angle=clamp(acos(clamp(dot(lumen_triangleNormal(position),material.normalEC),-1.0,1.0))/(czm_pi/6.0),0.0,1.0);color=u_lumenFgCurved?vec3(angle,0,1.0-angle):vec3(0);}
        #endif
        #endif
    }
    #endif
    return color;
}
#endif









void lightingStage(inout czm_modelMaterial material, ProcessedAttributes attributes)
{
    #ifdef LUMEN_RECEIVER_PASS
        #if defined(LUMEN_MODEL_LIGHTING) && defined(LUMEN_RECEIVER_COMPOSITE)
        vec3 ng=lumen_triangleNormal(attributes.positionEC);
        float alignment=dot(ng,material.normalEC);
        if(u_lumenReceiverSupported&&alignment>=(u_lumenFgCurved?0.8660253:0.999)) {
            lumen_receiverPosition=vec4((u_lumenEyeToLocal*vec4(attributes.positionEC,1.0)).xyz,u_lumenFgSurfaceId);
            lumen_receiverNormal=lumen_fgPack(normalize(mat3(u_lumenEyeToLocal)*ng),normalize(mat3(u_lumenEyeToLocal)*material.normalEC),u_lumenFgSurfaceId);
        }
        #endif
        
        return;
    #endif
    #ifdef LIGHTING_PBR
        #ifdef HAS_NORMALS
            
            vec3 geometricNormal = normalize(attributes.normalEC);
            #if defined(HAS_DOUBLE_SIDED_MATERIAL)
                if (czm_backFacing()) geometricNormal = -geometricNormal;
            #endif
            #if defined(LUMEN_MODEL_LIGHTING) && defined(LUMEN_RECEIVER_COMPOSITE)
                
                
                if(u_lumenFgCurved)geometricNormal=lumen_triangleNormal(attributes.positionEC);
            #endif
            vec3 color = computePbrLighting(material, attributes.positionEC, geometricNormal);
        #else
            vec3 color = material.diffuse * material.occlusion + material.emissive;
        #endif
        
        
        
        
        #ifndef HDR
            color = czm_pbrNeutralTonemapping(color);
        #endif
    #else 
        vec3 color = material.diffuse;
    #endif

    #ifdef HAS_POINT_CLOUD_COLOR_STYLE
        
        color = czm_gammaCorrect(color);
    #elif !defined(HDR)
        
        
        color = czm_linearToSrgb(color);
    #endif

    material.diffuse = color;
}

















const float PLANAR_DEPTH_PULL = 0.9995;



const float BEHIND_DEPTH_PUSH = 1.0002;

const float FEATURE_ID_TOLERANCE = 0.5;

const float FEATURE_ID_OFFSET = 1.0;

czm_modelMaterial defaultModelMaterial()
{
    czm_modelMaterial material;
    material.diffuse = vec3(0.0);
    material.specular = vec3(1.0);
    material.roughness = 1.0;
    material.occlusion = 1.0;
    material.normalEC = vec3(0.0, 0.0, 1.0);
    material.emissive = vec3(0.0);
    material.alpha = 1.0;
    return material;
}

vec4 handleAlpha(vec3 color, float alpha)
{
    #ifdef ALPHA_MODE_MASK
    if (alpha < u_alphaCutoff) {
        discard;
    }
    #endif

    return vec4(color, alpha);
}

void lineStyleStage()
{
    #if defined(HAS_LINE_PATTERN) && !defined(HAS_EDGE_VISIBILITY)
    const float maskLength = 16.0;
    float dashPosition = fract(v_lineCoord / maskLength);
    float maskIndex = floor(dashPosition * maskLength);
    float maskTest = floor(u_linePattern / pow(2.0, maskIndex));
    if (mod(maskTest, 2.0) < 1.0) {
        discard;
    }
    #endif
}

SelectedFeature selectedFeature;



bool isEdge = false;

void main()
{
    #if defined(PRIMITIVE_TYPE_POINTS) && defined(HAS_POINT_DIAMETER)
    
    float distanceToCenter = length(gl_PointCoord - vec2(0.5));
    if (distanceToCenter > 0.5) {
        discard;
    }
    #endif

    #ifdef HAS_POINT_CLOUD_SHOW_STYLE
        if (v_pointCloudShow == 0.0)
        {
            discard;
        }
    #endif

    #ifdef HAS_MODEL_SPLITTER
    modelSplitterStage();
    #endif

    czm_modelMaterial material = defaultModelMaterial();

    ProcessedAttributes attributes;
    geometryStage(attributes);

    FeatureIds featureIds;
    featureIdStage(featureIds, attributes);

    
    
    
    
    
    
    
    
    #ifdef HAS_PLANAR_FILL_ID_PASS
    if (u_isPlanarFillIdPass) {
        float fid = float(featureIds.PLANAR_FILL_FEATURE_ID) + FEATURE_ID_OFFSET;
        out_FragColor = vec4(fid, 0.0, 0.0, 1.0);
        
        #ifdef LOG_DEPTH
        czm_writeLogDepth();
        #endif
        return;
    }
    #endif

    Metadata metadata;
    MetadataClass metadataClass;
    MetadataStatistics metadataStatistics;
    metadataStage(featureIds, metadata, metadataClass, metadataStatistics, attributes);

    
    
    #ifndef METADATA_PICKING_ENABLED

    #ifdef HAS_SELECTED_FEATURE_ID
    selectedFeatureIdStage(selectedFeature, featureIds);
    #endif

    #ifndef CUSTOM_SHADER_REPLACE_MATERIAL
    materialStage(material, attributes, selectedFeature);
    #endif

    #ifdef HAS_CUSTOM_FRAGMENT_SHADER
    customShaderStage(material, attributes, featureIds, metadata, metadataClass, metadataStatistics);
    #endif

    
    
    #if defined(LUMEN_GBUFFER) && defined(LUMEN_MODEL_LIGHTING)
    lumen_albedo = vec4(material.diffuse, 1.0);
    lumen_normalRoughness = vec4(normalize(material.normalEC), material.roughness);
    lumen_positionDepth = vec4(attributes.positionEC, -attributes.positionEC.z);
    lumen_emissive = vec4(material.emissive, 1.0);
    #endif
    lightingStage(material, attributes);

    #ifdef HAS_SELECTED_FEATURE_ID
    cpuStylingStage(material, selectedFeature);
    #endif

    #ifdef HAS_MODEL_COLOR
    modelColorStage(material);
    #endif

    #ifdef HAS_PRIMITIVE_OUTLINE
    primitiveOutlineStage(material);
    #endif

    vec4 color = handleAlpha(material.diffuse, material.alpha);

    
    
    #else
    
    

    vec4 metadataValues = vec4(0.0, 0.0, 0.0, 0.0);
    metadataPickingStage(metadata, metadataClass, metadataValues);
    vec4 color = metadataValues;

    #endif
    
    

    lineStyleStage();

    #ifdef HAS_CLIPPING_PLANES
    modelClippingPlanesStage(color);
    #endif

    #ifdef ENABLE_CLIPPING_POLYGONS
    modelClippingPolygonsStage();
    #endif

    #ifdef HAS_VECTOR_LOOKUP
    modelVectorLookupStage(color);
    #endif

    
    
    #ifndef METADATA_PICKING_ENABLED

    #if defined(HAS_SILHOUETTE) && defined(HAS_NORMALS)
    silhouetteStage(color);
    #endif

    #ifdef HAS_ATMOSPHERE
    atmosphereStage(color, attributes);
    #endif

    #ifdef HAS_EDGE_VISIBILITY
    edgeVisibilityStage(color, featureIds);
    edgeDetectionStage(color, featureIds);
    
    
    
    if (u_isEdgePass) {
        isEdge = true;
    }
    #endif

    #endif
    
    

    out_FragColor = color;

    
    
    
    
    
    
    
    
    
    #ifdef LOG_DEPTH
    czm_writeLogDepth();
    #endif

    
    
    
    
    
    
    
    
    #ifdef HAS_PLANAR_FILL_DEPTH
    gl_FragDepth *= PLANAR_DEPTH_PULL;
    #endif

    
    
    
    
    
    
    
    
    
    
    #ifdef HAS_PLANAR_FILL_BEHIND
    {
        vec2 screenCoord = gl_FragCoord.xy / czm_viewport.zw;
        float storedEncoded = texture(czm_planarFillIdTexture, screenCoord).r;
        float storedFeatureId = storedEncoded - FEATURE_ID_OFFSET;
        float myFeatureId = float(featureIds.PLANAR_FILL_FEATURE_ID);

        
        if (storedFeatureId >= 0.0 && abs(storedFeatureId - myFeatureId) < FEATURE_ID_TOLERANCE) {
            
            
            
            gl_FragDepth *= BEHIND_DEPTH_PUSH;
        }
    }
    #endif
}

