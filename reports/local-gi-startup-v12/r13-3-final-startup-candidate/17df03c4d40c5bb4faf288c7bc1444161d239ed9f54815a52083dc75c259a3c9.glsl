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

#define TEXTURE_UNITS 0
#define ENABLE_DAYNIGHT_SHADING
#define DYNAMIC_ATMOSPHERE_LIGHTING
#define GROUND_ATMOSPHERE
#define INCLUDE_WEB_MERCATOR_Y
#define LOG_DEPTH
#define HDR
#define USE_SHADOW_DEPTH_TEXTURE
#define OES_texture_float_linear

#define OES_texture_float


#line 0
layout(location = 0) out vec4 out_FragColor;











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










float czm_unpackDepth(vec4 packedDepth)
{
    
    
    return dot(packedDepth, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}







const float czm_epsilon7 = 0.0000001;







const float czm_infinity = 5906376272000.0;  


float czm_sampleShadowMap(highp samplerCube shadowMap, vec3 d)
{
    return czm_unpackDepth(czm_textureCube(shadowMap, d));
}

float czm_sampleShadowMap(highp sampler2D shadowMap, vec2 uv)
{
#ifdef USE_SHADOW_DEPTH_TEXTURE
    return texture(shadowMap, uv).r;
#else
    return czm_unpackDepth(texture(shadowMap, uv));
#endif
}

float czm_shadowDepthCompare(samplerCube shadowMap, vec3 uv, float depth)
{
    return step(depth, czm_sampleShadowMap(shadowMap, uv));
}

float czm_shadowDepthCompare(sampler2D shadowMap, vec2 uv, float depth)
{
    return step(depth, czm_sampleShadowMap(shadowMap, uv));
}

struct czm_shadowParameters
{
#ifdef USE_CUBE_MAP_SHADOW
    vec3 texCoords;
#else
    vec2 texCoords;
#endif

    float depthBias;
    float depth;
    float nDotL;
    vec2 texelStepSize;
    float normalShadingSmooth;
    float darkness;
};

uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;






const float czm_epsilon2 = 0.01;

uniform float czm_fogDensity;
uniform float czm_gamma;













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
















const float czm_oneOverPi = 0.3183098861837907;
















const float czm_oneOverTwoPi = 0.15915494309189535;

uniform mat3 czm_normal3D;






struct czm_ray
{
    vec3 origin;
    vec3 direction;
};

uniform mat4 czm_inverseModelView;






struct czm_raySegment
{
    float start;
    float stop;
};







const czm_raySegment czm_emptyRaySegment = czm_raySegment(-czm_infinity, -czm_infinity);







const czm_raySegment czm_fullRaySegment = czm_raySegment(0.0, czm_infinity);

uniform float czm_pixelRatio;
uniform vec2 czm_currentFrustum;
uniform float czm_orthographicIn3D;










const float czm_sceneMode2D = 2.0;

uniform float czm_sceneMode;
uniform vec4 czm_frustumPlanes;
uniform vec4 czm_viewport;

float czm_private_shadowVisibility(float visibility, float nDotL, float normalShadingSmooth, float darkness)
{
#ifdef USE_NORMAL_SHADING
#ifdef USE_NORMAL_SHADING_SMOOTH
    float strength = clamp(nDotL / normalShadingSmooth, 0.0, 1.0);
#else
    float strength = step(0.0, nDotL);
#endif
    visibility *= strength;
#endif

    visibility = max(visibility, darkness);
    return visibility;
}

#ifdef USE_CUBE_MAP_SHADOW
float czm_shadowVisibility(samplerCube shadowMap, czm_shadowParameters shadowParameters)
{
    float depthBias = shadowParameters.depthBias;
    float depth = shadowParameters.depth;
    float nDotL = shadowParameters.nDotL;
    float normalShadingSmooth = shadowParameters.normalShadingSmooth;
    float darkness = shadowParameters.darkness;
    vec3 uvw = shadowParameters.texCoords;

    depth -= depthBias;
    float visibility = czm_shadowDepthCompare(shadowMap, uvw, depth);
    return czm_private_shadowVisibility(visibility, nDotL, normalShadingSmooth, darkness);
}
#else
float czm_shadowVisibility(sampler2D shadowMap, czm_shadowParameters shadowParameters)
{
    float depthBias = shadowParameters.depthBias;
    float depth = shadowParameters.depth;
    float nDotL = shadowParameters.nDotL;
    float normalShadingSmooth = shadowParameters.normalShadingSmooth;
    float darkness = shadowParameters.darkness;
    vec2 uv = shadowParameters.texCoords;

    depth -= depthBias;
#ifdef USE_SOFT_SHADOWS
    vec2 texelStepSize = shadowParameters.texelStepSize;
    float radius = 1.0;
    float dx0 = -texelStepSize.x * radius;
    float dy0 = -texelStepSize.y * radius;
    float dx1 = texelStepSize.x * radius;
    float dy1 = texelStepSize.y * radius;
    float visibility = (
        czm_shadowDepthCompare(shadowMap, uv, depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx0, dy0), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(0.0, dy0), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx1, dy0), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx0, 0.0), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx1, 0.0), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx0, dy1), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(0.0, dy1), depth) +
        czm_shadowDepthCompare(shadowMap, uv + vec2(dx1, dy1), depth)
    ) * (1.0 / 9.0);
#else
    float visibility = czm_shadowDepthCompare(shadowMap, uv, depth);
#endif

    return czm_private_shadowVisibility(visibility, nDotL, normalShadingSmooth, darkness);
}
#endif


uniform mat4 shadowMap_cascadeMatrices[4];

mat4 czm_cascadeMatrix(vec4 weights)
{
    return shadowMap_cascadeMatrices[0] * weights.x +
           shadowMap_cascadeMatrices[1] * weights.y +
           shadowMap_cascadeMatrices[2] * weights.z +
           shadowMap_cascadeMatrices[3] * weights.w;
}


uniform vec4 shadowMap_cascadeSplits[2];

vec4 czm_cascadeWeights(float depthEye)
{
    
    vec4 near = step(shadowMap_cascadeSplits[0], vec4(depthEye));
    vec4 far = step(depthEye, shadowMap_cascadeSplits[1]);
    return near * far;
}

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





















float czm_getSpecular(vec3 lightDirectionEC, vec3 toEyeEC, vec3 normalEC, float shininess)
{
    vec3 toReflectedLight = reflect(-lightDirectionEC, normalEC);
    float specular = max(dot(toReflectedLight, toEyeEC), 0.0);

    
    
    return pow(specular, max(shininess, czm_epsilon2));
}




vec4 czm_getWaterNoise(sampler2D normalMap, vec2 uv, float time, float angleInRadians)
{
    float cosAngle = cos(angleInRadians);
    float sinAngle = sin(angleInRadians);

    
    vec2 s0 = vec2(1.0/17.0, 0.0);
    vec2 s1 = vec2(-1.0/29.0, 0.0);
    vec2 s2 = vec2(1.0/101.0, 1.0/59.0);
    vec2 s3 = vec2(-1.0/109.0, -1.0/57.0);

    
    s0 = vec2((cosAngle * s0.x) - (sinAngle * s0.y), (sinAngle * s0.x) + (cosAngle * s0.y));
    s1 = vec2((cosAngle * s1.x) - (sinAngle * s1.y), (sinAngle * s1.x) + (cosAngle * s1.y));
    s2 = vec2((cosAngle * s2.x) - (sinAngle * s2.y), (sinAngle * s2.x) + (cosAngle * s2.y));
    s3 = vec2((cosAngle * s3.x) - (sinAngle * s3.y), (sinAngle * s3.x) + (cosAngle * s3.y));

    vec2 uv0 = (uv/103.0) + (time * s0);
    vec2 uv1 = uv/107.0 + (time * s1) + vec2(0.23);
    vec2 uv2 = uv/vec2(897.0, 983.0) + (time * s2) + vec2(0.51);
    vec2 uv3 = uv/vec2(991.0, 877.0) + (time * s3) + vec2(0.71);

    uv0 = fract(uv0);
    uv1 = fract(uv1);
    uv2 = fract(uv2);
    uv3 = fract(uv3);
    vec4 noise = (texture(normalMap, uv0)) +
                 (texture(normalMap, uv1)) +
                 (texture(normalMap, uv2)) +
                 (texture(normalMap, uv3));

    
    return ((noise / 4.0) - 0.5) * 2.0;
}

uniform float czm_frameNumber;
uniform float czm_eyeHeight;
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









bool czm_backFacing()
{
    
    return gl_FrontFacing == false;
}

uniform vec3 czm_lightDirectionWC;
uniform vec3 czm_sunDirectionWC;
uniform vec3 czm_lightColor;













struct czm_material
{
    vec3 diffuse;
    float specular;
    float shininess;
    vec3 normal;
    vec3 emission;
    float alpha;
};


















struct czm_materialInput
{
    float s;
    vec2 st;
    vec3 str;
    vec3 normalEC;
    mat3 tangentToEyeMatrix;
    vec3 positionToEyeEC;
    float height;
    float slope;
    float aspect;
    float waterMask;
};

uniform float czm_morphTime;






vec2 czm_ellipsoidTextureCoordinates(vec3 normal)
{
    return vec2(atan(normal.y, normal.x) * czm_oneOverTwoPi + 0.5, asin(normal.z) * czm_oneOverPi + 0.5);
}























mat3 czm_eastNorthUpToEyeCoordinates(vec3 positionMC, vec3 normalEC)
{
    vec3 tangentMC = normalize(vec3(-positionMC.y, positionMC.x, 0.0));  
    vec3 tangentEC = normalize(czm_normal3D * tangentMC);                
    vec3 bitangentEC = normalize(cross(normalEC, tangentEC));            

    return mat3(
        tangentEC.x,   tangentEC.y,   tangentEC.z,
        bitangentEC.x, bitangentEC.y, bitangentEC.z,
        normalEC.x,    normalEC.y,    normalEC.z);
}

uniform vec3 czm_ellipsoidRadii;










const float czm_sceneMode3D = 3.0;











const float czm_sceneModeColumbusView = 1.0;

uniform vec3 czm_lightDirectionEC;


















float czm_getLambertDiffuse(vec3 lightDirectionEC, vec3 normalEC)
{
    return max(dot(lightDirectionEC, normalEC), 0.0);
}













vec3 czm_geodeticSurfaceNormal(vec3 positionOnEllipsoid, vec3 ellipsoidCenter, vec3 oneOverEllipsoidRadiiSquared)
{
    return normalize((positionOnEllipsoid - ellipsoidCenter) * oneOverEllipsoidRadiiSquared);
}

uniform mat4 czm_inverseView;















vec3 czm_pointAlongRay(czm_ray ray, float time)
{
    return ray.origin + (time * ray.direction);
}

uniform vec3 czm_ellipsoidInverseRadii;






czm_raySegment czm_rayEllipsoidIntersectionInterval(czm_ray ray, vec3 ellipsoid_center, vec3 ellipsoid_inverseRadii)
{
   
    vec3 q = ellipsoid_inverseRadii * (czm_inverseModelView * vec4(ray.origin, 1.0)).xyz;
    vec3 w = ellipsoid_inverseRadii * (czm_inverseModelView * vec4(ray.direction, 0.0)).xyz;

    q = q - ellipsoid_inverseRadii * (czm_inverseModelView * vec4(ellipsoid_center, 1.0)).xyz;

    float q2 = dot(q, q);
    float qw = dot(q, w);

    if (q2 > 1.0) 
    {
        if (qw >= 0.0) 
        {
            return czm_emptyRaySegment;
        }
        else 
        {
            float qw2 = qw * qw;
            float difference = q2 - 1.0; 
            float w2 = dot(w, w);
            float product = w2 * difference;

            if (qw2 < product) 
            {
                return czm_emptyRaySegment;
            }
            else if (qw2 > product) 
            {
                float discriminant = qw * qw - product;
                float temp = -qw + sqrt(discriminant); 
                float root0 = temp / w2;
                float root1 = difference / temp;
                if (root0 < root1)
                {
                    czm_raySegment i = czm_raySegment(root0, root1);
                    return i;
                }
                else
                {
                    czm_raySegment i = czm_raySegment(root1, root0);
                    return i;
                }
            }
            else 
            {
                float root = sqrt(difference / w2);
                czm_raySegment i = czm_raySegment(root, root);
                return i;
            }
        }
    }
    else if (q2 < 1.0) 
    {
        float difference = q2 - 1.0; 
        float w2 = dot(w, w);
        float product = w2 * difference; 
        float discriminant = qw * qw - product;
        float temp = -qw + sqrt(discriminant); 
        czm_raySegment i = czm_raySegment(0.0, temp / w2);
        return i;
    }
    else 
    {
        if (qw < 0.0) 
        {
            float w2 = dot(w, w);
            czm_raySegment i = czm_raySegment(0.0, -qw / w2);
            return i;
        }
        else 
        {
            return czm_emptyRaySegment;
        }
    }
}

uniform mat4 czm_view;













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
















vec3 czm_saturation(vec3 rgb, float adjustment)
{
    
    const vec3 W = vec3(0.2125, 0.7154, 0.0721);
    vec3 intensity = vec3(dot(rgb, W));
    return mix(intensity, rgb, adjustment);
}















vec3 czm_hue(vec3 rgb, float adjustment)
{
    const mat3 toYIQ = mat3(0.299,     0.587,     0.114,
                            0.595716, -0.274453, -0.321263,
                            0.211456, -0.522591,  0.311135);
    const mat3 toRGB = mat3(1.0,  0.9563,  0.6210,
                            1.0, -0.2721, -0.6474,
                            1.0, -1.107,   1.7046);
    
    vec3 yiq = toYIQ * rgb;
    float hue = atan(yiq.z, yiq.y) + adjustment;
    float chroma = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
    
    vec3 color = vec3(yiq.x, chroma * cos(hue), chroma * sin(hue));
    return toRGB * color;
}

uniform float czm_splitPosition;









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

uniform vec3 czm_viewerPositionWC;






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



#line 0
uniform vec3 u_radiiAndDynamicAtmosphereColor;

uniform float u_atmosphereLightIntensity;
uniform float u_atmosphereRayleighScaleHeight;
uniform float u_atmosphereMieScaleHeight;
uniform float u_atmosphereMieAnisotropy;
uniform vec3 u_atmosphereRayleighCoefficient;
uniform vec3 u_atmosphereMieCoefficient;

const float ATMOSPHERE_THICKNESS = 111e3; 
const int PRIMARY_STEPS_MAX = 16; 
const int LIGHT_STEPS_MAX = 4; 













void computeScattering(
    czm_ray primaryRay,
    float primaryRayLength,
    vec3 lightDirection,
    float atmosphereInnerRadius,
    out vec3 rayleighColor,
    out vec3 mieColor,
    out float opacity
) {

    
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
    vec2 heightScale = vec2(u_atmosphereRayleighScaleHeight, u_atmosphereMieScaleHeight);

    
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

        
        vec3 attenuation = exp(-((u_atmosphereMieCoefficient * (opticalDepth.y + lightOpticalDepth.y)) + (u_atmosphereRayleighCoefficient * (opticalDepth.x + lightOpticalDepth.x))));

        
        rayleighAccumulation += sampleDensity.x * attenuation;
        mieAccumulation += sampleDensity.y * attenuation;

        
        rayPositionLength += (rayStepLength += rayStepLengthIncrease);
    }

    
    rayleighColor = u_atmosphereRayleighCoefficient * rayleighAccumulation;
    mieColor = u_atmosphereMieCoefficient * mieAccumulation;

    
    opacity = length(exp(-((u_atmosphereMieCoefficient * opticalDepth.y) + (u_atmosphereRayleighCoefficient * opticalDepth.x))));
}

vec4 computeAtmosphereColor(
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

    float G = u_atmosphereMieAnisotropy;
    float GSq = G * G;

    
    float rayleighPhase = 3.0 / (50.2654824574) * (1.0 + cosAngleSq);
    
    float miePhase = 3.0 / (25.1327412287) * ((1.0 - GSq) * (cosAngleSq + 1.0)) / (pow(1.0 + GSq - 2.0 * cosAngle * G, 1.5) * (2.0 + GSq));

    
    vec3 rayleigh = rayleighPhase * rayleighColor;
    vec3 mie = miePhase * mieColor;

    vec3 color = (rayleigh + mie) * u_atmosphereLightIntensity;

    return vec4(color, opacity);
}

#line 0
void computeAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity) {

    vec3 cameraToPositionWC = positionWC - czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czm_viewerPositionWC, cameraToPositionWCDirection);
    
    float atmosphereInnerRadius = length(positionWC);

    computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );
}

#line 0
uniform vec4 u_initialColor;

#if TEXTURE_UNITS > 0
uniform sampler2D u_dayTextures[TEXTURE_UNITS];
uniform vec4 u_dayTextureTranslationAndScale[TEXTURE_UNITS];
uniform bool u_dayTextureUseWebMercatorT[TEXTURE_UNITS];

#ifdef APPLY_ALPHA
uniform float u_dayTextureAlpha[TEXTURE_UNITS];
#endif

#ifdef APPLY_DAY_NIGHT_ALPHA
uniform float u_dayTextureNightAlpha[TEXTURE_UNITS];
uniform float u_dayTextureDayAlpha[TEXTURE_UNITS];
#endif

#ifdef APPLY_SPLIT
uniform float u_dayTextureSplit[TEXTURE_UNITS];
#endif

#ifdef APPLY_BRIGHTNESS
uniform float u_dayTextureBrightness[TEXTURE_UNITS];
#endif

#ifdef APPLY_CONTRAST
uniform float u_dayTextureContrast[TEXTURE_UNITS];
#endif

#ifdef APPLY_HUE
uniform float u_dayTextureHue[TEXTURE_UNITS];
#endif

#ifdef APPLY_SATURATION
uniform float u_dayTextureSaturation[TEXTURE_UNITS];
#endif

#ifdef APPLY_GAMMA
uniform float u_dayTextureOneOverGamma[TEXTURE_UNITS];
#endif

#ifdef APPLY_IMAGERY_CUTOUT
uniform vec4 u_dayTextureCutoutRectangles[TEXTURE_UNITS];
#endif

#ifdef APPLY_COLOR_TO_ALPHA
uniform vec4 u_colorsToAlpha[TEXTURE_UNITS];
#endif

uniform vec4 u_dayTextureTexCoordsRectangle[TEXTURE_UNITS];
#endif

#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
uniform sampler2D u_waterMask;
uniform vec4 u_waterMaskTranslationAndScale;
uniform float u_zoomedOutOceanSpecularIntensity;
#endif

#ifdef SHOW_OCEAN_WAVES
uniform sampler2D u_oceanNormalMap;
#endif

#if defined(ENABLE_DAYNIGHT_SHADING) || defined(GROUND_ATMOSPHERE)
uniform vec2 u_lightingFadeDistance;
#endif

#ifdef TILE_LIMIT_RECTANGLE
uniform vec4 u_cartographicLimitRectangle;
#endif

#ifdef GROUND_ATMOSPHERE
uniform vec2 u_nightFadeDistance;
#endif

#ifdef ENABLE_CLIPPING_PLANES
uniform highp sampler2D u_clippingPlanes;
uniform mat4 u_clippingPlanesMatrix;
uniform vec4 u_clippingPlanesEdgeStyle;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG) && defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
uniform float u_minimumBrightness;
#endif









#ifdef COLOR_CORRECT
uniform vec3 u_hsbShift; 
#endif





#ifdef HIGHLIGHT_FILL_TILE
uniform vec4 u_fillHighlightColor;
#endif



#ifdef TRANSLUCENT
uniform vec4 u_frontFaceAlphaByDistance;
uniform vec4 u_backFaceAlphaByDistance;
uniform vec4 u_translucencyRectangle;
#endif






#ifdef UNDERGROUND_COLOR
uniform vec4 u_undergroundColor;
uniform vec4 u_undergroundColorAlphaByDistance;
#endif




#ifdef ENABLE_VERTEX_LIGHTING
uniform float u_lambertDiffuseMultiplier;
uniform float u_vertexShadowDarkness;
#endif

in vec3 v_positionMC;
in vec3 v_positionEC;
in vec3 v_textureCoordinates;
in vec3 v_normalMC;
in vec3 v_normalEC;

#ifdef APPLY_MATERIAL
in float v_height;
in float v_slope;
in float v_aspect;
#endif

#if defined(FOG) || defined(GROUND_ATMOSPHERE) || defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
in float v_distance;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG)
in vec3 v_atmosphereRayleighColor;
in vec3 v_atmosphereMieColor;
in float v_atmosphereOpacity;
#endif

#if defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT)
float interpolateByDistance(vec4 nearFarScalar, float distance)
{
    float startDistance = nearFarScalar.x;
    float startValue = nearFarScalar.y;
    float endDistance = nearFarScalar.z;
    float endValue = nearFarScalar.w;
    float t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
    return mix(startValue, endValue, t);
}
#endif

#if defined(UNDERGROUND_COLOR) || defined(TRANSLUCENT) || defined(APPLY_MATERIAL)
vec4 alphaBlend(vec4 sourceColor, vec4 destinationColor)
{
    return sourceColor * vec4(sourceColor.aaa, 1.0) + destinationColor * (1.0 - sourceColor.a);
}
#endif

#ifdef TRANSLUCENT
bool inTranslucencyRectangle()
{
    return
        v_textureCoordinates.x > u_translucencyRectangle.x &&
        v_textureCoordinates.x < u_translucencyRectangle.z &&
        v_textureCoordinates.y > u_translucencyRectangle.y &&
        v_textureCoordinates.y < u_translucencyRectangle.w;
}
#endif

vec4 sampleAndBlend(
    vec4 previousColor,
    sampler2D textureToSample,
    vec2 tileTextureCoordinates,
    vec4 textureCoordinateRectangle,
    vec4 textureCoordinateTranslationAndScale,
    float textureAlpha,
    float textureNightAlpha,
    float textureDayAlpha,
    float textureBrightness,
    float textureContrast,
    float textureHue,
    float textureSaturation,
    float textureOneOverGamma,
    float split,
    vec4 colorToAlpha,
    float nightBlend)
{
    
    
    
    
    
    
    
    vec2 alphaMultiplier = step(textureCoordinateRectangle.st, tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

    alphaMultiplier = step(vec2(0.0), textureCoordinateRectangle.pq - tileTextureCoordinates);
    textureAlpha = textureAlpha * alphaMultiplier.x * alphaMultiplier.y;

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
    textureAlpha *= mix(textureDayAlpha, textureNightAlpha, nightBlend);
#endif

    vec2 translation = textureCoordinateTranslationAndScale.xy;
    vec2 scale = textureCoordinateTranslationAndScale.zw;
    vec2 textureCoordinates = tileTextureCoordinates * scale + translation;
    vec4 value = texture(textureToSample, textureCoordinates);
    vec3 color = value.rgb;
    float alpha = value.a;

#ifdef APPLY_COLOR_TO_ALPHA
    vec3 colorDiff = abs(color.rgb - colorToAlpha.rgb);
    colorDiff.r = czm_maximumComponent(colorDiff);
    alpha = czm_branchFreeTernary(colorDiff.r < colorToAlpha.a, 0.0, alpha);
#endif

#if !defined(APPLY_GAMMA)
    vec4 tempColor = czm_gammaCorrect(vec4(color, alpha));
    color = tempColor.rgb;
    alpha = tempColor.a;
#else
    color = pow(color, vec3(textureOneOverGamma));
#endif

#ifdef APPLY_SPLIT
    float splitPosition = czm_splitPosition;
    
    if (split < 0.0 && gl_FragCoord.x > splitPosition) {
       alpha = 0.0;
    }
    
    else if (split > 0.0 && gl_FragCoord.x < splitPosition) {
       alpha = 0.0;
    }
#endif

#ifdef APPLY_BRIGHTNESS
    color = mix(vec3(0.0), color, textureBrightness);
#endif

#ifdef APPLY_CONTRAST
    color = mix(vec3(0.5), color, textureContrast);
#endif

#ifdef APPLY_HUE
    color = czm_hue(color, textureHue);
#endif

#ifdef APPLY_SATURATION
    color = czm_saturation(color, textureSaturation);
#endif

    float sourceAlpha = alpha * textureAlpha;
    float outAlpha = mix(previousColor.a, 1.0, sourceAlpha);
    outAlpha += sign(outAlpha) - 1.0;

    vec3 outColor = mix(previousColor.rgb * previousColor.a, color, sourceAlpha) / outAlpha;

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    

    return vec4(outColor, max(outAlpha, 0.0));
}

vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend);
vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, mat3 enuToEye, vec4 imageryColor, float specularMapValue, float fade);

const float fExposure = 2.0;

vec3 computeEllipsoidPosition()
{
    float mpp = czm_metersPerPixel(vec4(0.0, 0.0, -czm_currentFrustum.x, 1.0), 1.0);
    vec2 xy = gl_FragCoord.xy / czm_viewport.zw * 2.0 - vec2(1.0);
    xy *= czm_viewport.zw * mpp * 0.5;

    vec3 direction;
    if (czm_orthographicIn3D == 1.0)
    {
        direction = vec3(0.0, 0.0, -1.0);
    }
    else
    {
        direction = normalize(vec3(xy, -czm_currentFrustum.x));
    }

    czm_ray ray = czm_ray(vec3(0.0), direction);

    vec3 ellipsoid_center = czm_view[3].xyz;

    czm_raySegment intersection = czm_rayEllipsoidIntersectionInterval(ray, ellipsoid_center, czm_ellipsoidInverseRadii);

    vec3 ellipsoidPosition = czm_pointAlongRay(ray, intersection.start);
    return (czm_inverseView * vec4(ellipsoidPosition, 1.0)).xyz;
}

void czm_log_depth_main()
{
#ifdef TILE_LIMIT_RECTANGLE
    if (v_textureCoordinates.x < u_cartographicLimitRectangle.x || u_cartographicLimitRectangle.z < v_textureCoordinates.x ||
        v_textureCoordinates.y < u_cartographicLimitRectangle.y || u_cartographicLimitRectangle.w < v_textureCoordinates.y)
        {
            discard;
        }
#endif

#ifdef ENABLE_CLIPPING_PLANES
    float clipDistance = clip(gl_FragCoord, u_clippingPlanes, u_clippingPlanesMatrix);
#endif

#if defined(SHOW_REFLECTIVE_OCEAN) || defined(ENABLE_DAYNIGHT_SHADING) || defined(HDR)
    vec3 normalMC = czm_geodeticSurfaceNormal(v_positionMC, vec3(0.0), vec3(1.0));   
    vec3 normalEC = czm_normal3D * normalMC;                                         
#endif

#if defined(APPLY_DAY_NIGHT_ALPHA) && defined(ENABLE_DAYNIGHT_SHADING)
    float nightBlend = 1.0 - clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0, 0.0, 1.0);
#else
    float nightBlend = 0.0;
#endif

    
    
    
    
    vec4 color = computeDayColor(u_initialColor, clamp(v_textureCoordinates, 0.0, 1.0), nightBlend);

#ifdef SHOW_TILE_BOUNDARIES
    if (v_textureCoordinates.x < (1.0/256.0) || v_textureCoordinates.x > (255.0/256.0) ||
        v_textureCoordinates.y < (1.0/256.0) || v_textureCoordinates.y > (255.0/256.0))
    {
        color = vec4(1.0, 0.0, 0.0, 1.0);
    }
#endif

#if defined(ENABLE_DAYNIGHT_SHADING) || defined(GROUND_ATMOSPHERE)
    float cameraDist;
    if (czm_sceneMode == czm_sceneMode2D)
    {
        cameraDist = max(czm_frustumPlanes.x - czm_frustumPlanes.y, czm_frustumPlanes.w - czm_frustumPlanes.z) * 0.5;
    }
    else if (czm_sceneMode == czm_sceneModeColumbusView)
    {
        cameraDist = -czm_view[3].z;
    }
    else
    {
        cameraDist = length(czm_view[3]);
    }
    float fadeOutDist = u_lightingFadeDistance.x;
    float fadeInDist = u_lightingFadeDistance.y;
    if (czm_sceneMode != czm_sceneMode3D) {
        vec3 radii = czm_ellipsoidRadii;
        float maxRadii = max(radii.x, max(radii.y, radii.z));
        fadeOutDist -= maxRadii;
        fadeInDist -= maxRadii;
    }
    float fade = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.0, 1.0);
#else
    float fade = 0.0;
#endif

#if defined(HAS_WATER_MASK) && (defined(SHOW_REFLECTIVE_OCEAN) || defined(APPLY_MATERIAL))
    vec2 waterMaskTranslation = u_waterMaskTranslationAndScale.xy;
    vec2 waterMaskScale = u_waterMaskTranslationAndScale.zw;
    vec2 waterMaskTextureCoordinates = v_textureCoordinates.xy * waterMaskScale + waterMaskTranslation;
    waterMaskTextureCoordinates.y = 1.0 - waterMaskTextureCoordinates.y;

    float mask = texture(u_waterMask, waterMaskTextureCoordinates).r;

    #ifdef SHOW_REFLECTIVE_OCEAN
    if (mask > 0.0)
    {
        mat3 enuToEye = czm_eastNorthUpToEyeCoordinates(v_positionMC, normalEC);

        vec2 ellipsoidTextureCoordinates = czm_ellipsoidTextureCoordinates(normalMC);
        vec2 ellipsoidFlippedTextureCoordinates = czm_ellipsoidTextureCoordinates(normalMC.zyx);

        vec2 textureCoordinates = mix(ellipsoidTextureCoordinates, ellipsoidFlippedTextureCoordinates, czm_morphTime * smoothstep(0.9, 0.95, normalMC.z));

        color = computeWaterColor(v_positionEC, textureCoordinates, enuToEye, color, mask, fade);
    }
    #endif
#endif

#ifdef APPLY_MATERIAL
    czm_materialInput materialInput;
    materialInput.st = v_textureCoordinates.st;
    materialInput.normalEC = normalize(v_normalEC);
    materialInput.positionToEyeEC = -v_positionEC;
    materialInput.tangentToEyeMatrix = czm_eastNorthUpToEyeCoordinates(v_positionMC, normalize(v_normalEC));
    materialInput.slope = v_slope;
    materialInput.height = v_height;
    materialInput.aspect = v_aspect;
    #ifdef HAS_WATER_MASK
        materialInput.waterMask = mask;
    #endif

    czm_material material = czm_getMaterial(materialInput);
    vec4 materialColor = vec4(material.diffuse, material.alpha);
    color = alphaBlend(materialColor, color);
#endif

#ifdef ENABLE_VERTEX_LIGHTING
    float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalize(v_normalEC)) * u_lambertDiffuseMultiplier + u_vertexShadowDarkness, 0.0, 1.0);
    vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);
#elif defined(ENABLE_DAYNIGHT_SHADING)
    float diffuseIntensity = clamp(czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * 5.0 + 0.3, 0.0, 1.0);
    diffuseIntensity = mix(1.0, diffuseIntensity, fade);
    vec4 finalColor = vec4(color.rgb * czm_lightColor * diffuseIntensity, color.a);
#else
    vec4 finalColor = color;
#endif

#ifdef ENABLE_CLIPPING_PLANES
    vec4 clippingPlanesEdgeColor = vec4(1.0);
    clippingPlanesEdgeColor.rgb = u_clippingPlanesEdgeStyle.rgb;
    float clippingPlanesEdgeWidth = u_clippingPlanesEdgeStyle.a;

    if (clipDistance < clippingPlanesEdgeWidth)
    {
        finalColor = clippingPlanesEdgeColor;
    }
#endif

#ifdef ENABLE_CLIPPING_POLYGONS
    bool insideAny = vectorClip(v_textureCoordinates.xy);
    #ifdef CLIPPING_INVERSE
        if (!insideAny) {
            discard;
        }
    #else
        if (insideAny) {
            discard;
        }
    #endif
#endif

#ifdef HIGHLIGHT_FILL_TILE
    finalColor = vec4(mix(finalColor.rgb, u_fillHighlightColor.rgb, u_fillHighlightColor.a), finalColor.a);
#endif

#if defined(DYNAMIC_ATMOSPHERE_LIGHTING_FROM_SUN)
    vec3 atmosphereLightDirection = czm_sunDirectionWC;
#else
    vec3 atmosphereLightDirection = czm_lightDirectionWC;
#endif

#if defined(GROUND_ATMOSPHERE) || defined(FOG)
    if (!czm_backFacing())
    {
        bool dynamicLighting = false;
        #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_DAYNIGHT_SHADING) || defined(ENABLE_VERTEX_LIGHTING))
            dynamicLighting = true;
        #endif

        vec3 rayleighColor;
        vec3 mieColor;
        float opacity;

        vec3 positionWC;
        vec3 lightDirection;

        
        
        #ifdef PER_FRAGMENT_GROUND_ATMOSPHERE
            positionWC = computeEllipsoidPosition();
            lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(positionWC));
            computeAtmosphereScattering(
                positionWC,
                lightDirection,
                rayleighColor,
                mieColor,
                opacity
            );
        #else
            positionWC = v_positionMC;
            lightDirection = czm_branchFreeTernary(dynamicLighting, atmosphereLightDirection, normalize(positionWC));
            rayleighColor = v_atmosphereRayleighColor;
            mieColor = v_atmosphereMieColor;
            opacity = v_atmosphereOpacity;
        #endif

        #ifdef COLOR_CORRECT
            const bool ignoreBlackPixels = true;
            rayleighColor = czm_applyHSBShift(rayleighColor, u_hsbShift, ignoreBlackPixels);
            mieColor = czm_applyHSBShift(mieColor, u_hsbShift, ignoreBlackPixels);
        #endif

        vec4 groundAtmosphereColor = computeAtmosphereColor(positionWC, lightDirection, rayleighColor, mieColor, opacity);

        
        #ifdef FOG
            vec3 fogColor = groundAtmosphereColor.rgb;

            
            #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
                float darken = clamp(dot(normalize(czm_viewerPositionWC), atmosphereLightDirection), u_minimumBrightness, 1.0);
                fogColor *= darken;
            #endif

            #ifndef HDR
                fogColor.rgb = czm_pbrNeutralTonemapping(fogColor.rgb);
                fogColor.rgb = czm_inverseGamma(fogColor.rgb);
            #endif

            finalColor = vec4(czm_fog(v_distance, finalColor.rgb, fogColor.rgb, czm_fogVisualDensityScalar), finalColor.a);

        #else
            

            
            
            
            const float transmittanceModifier = 0.5;
            float transmittance = transmittanceModifier + clamp(1.0 - groundAtmosphereColor.a, 0.0, 1.0);

            vec3 finalAtmosphereColor = finalColor.rgb + groundAtmosphereColor.rgb * transmittance;

            #if defined(DYNAMIC_ATMOSPHERE_LIGHTING) && (defined(ENABLE_VERTEX_LIGHTING) || defined(ENABLE_DAYNIGHT_SHADING))
                float fadeInDist = u_nightFadeDistance.x;
                float fadeOutDist = u_nightFadeDistance.y;

                float sunlitAtmosphereIntensity = clamp((cameraDist - fadeOutDist) / (fadeInDist - fadeOutDist), 0.05, 1.0);
                float darken = clamp(dot(normalize(positionWC), atmosphereLightDirection), 0.0, 1.0);
                vec3 darkenendGroundAtmosphereColor = mix(groundAtmosphereColor.rgb, finalAtmosphereColor.rgb, darken);

                finalAtmosphereColor = mix(darkenendGroundAtmosphereColor, finalAtmosphereColor, sunlitAtmosphereIntensity);
            #endif

            #ifndef HDR
                finalAtmosphereColor.rgb = vec3(1.0) - exp(-fExposure * finalAtmosphereColor.rgb);
            #else
                finalAtmosphereColor.rgb = czm_saturation(finalAtmosphereColor.rgb, 1.6);
            #endif

            finalColor.rgb = mix(finalColor.rgb, finalAtmosphereColor.rgb, fade);
        #endif
    }
#endif

#ifdef UNDERGROUND_COLOR
    if (czm_backFacing())
    {
        float distanceFromEllipsoid = max(czm_eyeHeight, 0.0);
        float distance = max(v_distance - distanceFromEllipsoid, 0.0);
        float blendAmount = interpolateByDistance(u_undergroundColorAlphaByDistance, distance);
        vec4 undergroundColor = vec4(u_undergroundColor.rgb, u_undergroundColor.a * blendAmount);
        finalColor = alphaBlend(undergroundColor, finalColor);
    }
#endif

#ifdef HAS_VECTOR_LAYER
    finalColor = vectorPolygonRender(v_textureCoordinates.xy, finalColor);
    finalColor = vectorPolylineRender(v_textureCoordinates.xy, v_positionEC, finalColor);
#endif

#ifdef TRANSLUCENT
    if (inTranslucencyRectangle())
    {
        vec4 alphaByDistance = gl_FrontFacing ? u_frontFaceAlphaByDistance : u_backFaceAlphaByDistance;
        finalColor.a *= interpolateByDistance(alphaByDistance, v_distance);
    }
#endif

    out_FragColor =  finalColor;
}


#ifdef SHOW_REFLECTIVE_OCEAN

float waveFade(float edge0, float edge1, float x)
{
    float y = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return pow(1.0 - y, 5.0);
}

float linearFade(float edge0, float edge1, float x)
{
    return clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
}





const float oceanFrequencyLowAltitude = 825000.0;
const float oceanAnimationSpeedLowAltitude = 0.004;
const float oceanOneOverAmplitudeLowAltitude = 1.0 / 2.0;
const float oceanSpecularIntensity = 0.5;


const float oceanFrequencyHighAltitude = 125000.0;
const float oceanAnimationSpeedHighAltitude = 0.008;
const float oceanOneOverAmplitudeHighAltitude = 1.0 / 2.0;

vec4 computeWaterColor(vec3 positionEyeCoordinates, vec2 textureCoordinates, mat3 enuToEye, vec4 imageryColor, float maskValue, float fade)
{
    vec3 positionToEyeEC = -positionEyeCoordinates;
    float positionToEyeECLength = length(positionToEyeEC);

    
    vec3 normalizedPositionToEyeEC = normalize(normalize(positionToEyeEC));

    
    float waveIntensity = waveFade(70000.0, 1000000.0, positionToEyeECLength);

#ifdef SHOW_OCEAN_WAVES
    
    float time = czm_frameNumber * oceanAnimationSpeedHighAltitude;
    vec4 noise = czm_getWaterNoise(u_oceanNormalMap, textureCoordinates * oceanFrequencyHighAltitude, time, 0.0);
    vec3 normalTangentSpaceHighAltitude = vec3(noise.xy, noise.z * oceanOneOverAmplitudeHighAltitude);

    
    time = czm_frameNumber * oceanAnimationSpeedLowAltitude;
    noise = czm_getWaterNoise(u_oceanNormalMap, textureCoordinates * oceanFrequencyLowAltitude, time, 0.0);
    vec3 normalTangentSpaceLowAltitude = vec3(noise.xy, noise.z * oceanOneOverAmplitudeLowAltitude);

    
    float highAltitudeFade = linearFade(0.0, 60000.0, positionToEyeECLength);
    float lowAltitudeFade = 1.0 - linearFade(20000.0, 60000.0, positionToEyeECLength);
    vec3 normalTangentSpace =
        (highAltitudeFade * normalTangentSpaceHighAltitude) +
        (lowAltitudeFade * normalTangentSpaceLowAltitude);
    normalTangentSpace = normalize(normalTangentSpace);

    
    normalTangentSpace.xy *= waveIntensity;
    normalTangentSpace = normalize(normalTangentSpace);
#else
    vec3 normalTangentSpace = vec3(0.0, 0.0, 1.0);
#endif

    vec3 normalEC = enuToEye * normalTangentSpace;

    const vec3 waveHighlightColor = vec3(0.3, 0.45, 0.6);

    
    float diffuseIntensity = czm_getLambertDiffuse(czm_lightDirectionEC, normalEC) * maskValue;
    vec3 diffuseHighlight = waveHighlightColor * diffuseIntensity * (1.0 - fade);

#ifdef SHOW_OCEAN_WAVES
    
    
    float tsPerturbationRatio = normalTangentSpace.z;
    vec3 nonDiffuseHighlight = mix(waveHighlightColor * 5.0 * (1.0 - tsPerturbationRatio), vec3(0.0), diffuseIntensity);
#else
    vec3 nonDiffuseHighlight = vec3(0.0);
#endif

    
    float specularIntensity = czm_getSpecular(czm_lightDirectionEC, normalizedPositionToEyeEC, normalEC, 10.0);
    float surfaceReflectance = mix(0.0, mix(u_zoomedOutOceanSpecularIntensity, oceanSpecularIntensity, waveIntensity), maskValue);
    float specular = specularIntensity * surfaceReflectance;

#ifdef HDR
    specular *= 1.4;

    float e = 0.2;
    float d = 3.3;
    float c = 1.7;

    vec3 color = imageryColor.rgb + (c * (vec3(e) + imageryColor.rgb * d) * (diffuseHighlight + nonDiffuseHighlight + specular));
#else
    vec3 color = imageryColor.rgb + diffuseHighlight + nonDiffuseHighlight + specular;
#endif

    return vec4(color, imageryColor.a);
}

#endif 

#line 0
      vec4 computeDayColor(vec4 initialColor, vec3 textureCoordinates, float nightBlend)
      {
          vec4 color = initialColor;
          return color;
      }
#line 0

void czm_shadow_receive_main()
{
    czm_log_depth_main();
    czm_writeLogDepth();
}

#line 0
uniform sampler2D shadowMap_texture; 
uniform mat4 shadowMap_matrix; 
uniform vec3 shadowMap_lightDirectionEC; 
uniform vec4 shadowMap_lightPositionEC; 
uniform vec4 shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness; 
uniform vec4 shadowMap_texelSizeDepthBiasAndNormalShadingSmooth; 
#ifdef LOG_DEPTH 
in vec3 v_logPositionEC; 
#endif 
vec4 getPositionEC() 
{ 
    return vec4(v_positionEC, 1.0); 
} 
vec3 getNormalEC() 
{ 
    return vec3(1.0); 
} 
void applyNormalOffset(inout vec4 positionEC, vec3 normalEC, float nDotL) 
{ 
} 
void main() 
{ 
#ifndef LUMEN_MODEL_LIGHTING 
    czm_shadow_receive_main(); 
#endif 
    vec4 positionEC = getPositionEC(); 
    vec3 normalEC = getNormalEC(); 
    float depth = -positionEC.z; 
    czm_shadowParameters shadowParameters; 
    shadowParameters.texelStepSize = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.xy; 
    shadowParameters.depthBias = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.z; 
    shadowParameters.normalShadingSmooth = shadowMap_texelSizeDepthBiasAndNormalShadingSmooth.w; 
    shadowParameters.darkness = shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness.w; 
    shadowParameters.depthBias *= max(depth * 0.01, 1.0); 
    float maxDepth = shadowMap_cascadeSplits[1].w; 
    
    if (depth > maxDepth) 
    { 
#ifdef LUMEN_MODEL_LIGHTING 
        czm_shadow_receive_main(); 
#endif 
        return; 
    } 
    
    vec4 weights = czm_cascadeWeights(depth); 
    
    float nDotL = clamp(dot(normalEC, shadowMap_lightDirectionEC), 0.0, 1.0); 
    applyNormalOffset(positionEC, normalEC, nDotL); 
    
    vec4 shadowPosition = czm_cascadeMatrix(weights) * positionEC; 
    
    shadowParameters.texCoords = shadowPosition.xy; 
    shadowParameters.depth = shadowPosition.z; 
    shadowParameters.nDotL = nDotL; 
    float visibility = czm_shadowVisibility(shadowMap_texture, shadowParameters); 
    
    float shadowMapMaximumDistance = shadowMap_normalOffsetScaleDistanceMaxDistanceAndDarkness.z; 
    float fade = max((depth - shadowMapMaximumDistance * 0.8) / (shadowMapMaximumDistance * 0.2), 0.0); 
    visibility = mix(visibility, 1.0, fade); 
#ifdef LUMEN_MODEL_LIGHTING 
    if (u_lumenEnabled) { 
        lumen_shadowVisibility = visibility; 
        czm_shadow_receive_main(); 
    } else { 
        czm_shadow_receive_main(); 
        out_FragColor.rgb *= visibility; 
    } 
#else 
    out_FragColor.rgb *= visibility; 
#endif 
} 
