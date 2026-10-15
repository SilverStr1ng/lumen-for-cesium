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

#define LOG_DEPTH
#define HDR
#define OES_texture_float_linear

#define OES_texture_float


#line 0
layout(location = 0) out vec4 out_FragColor;







const float czm_epsilon7 = 0.0000001;







const float czm_infinity = 5906376272000.0;  

uniform float czm_oneOverLog2FarDepthFromNearPlusOne;
uniform float czm_farDepthFromNearPlusOne;

















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

uniform vec3 czm_sunDirectionWC;
uniform vec3 czm_lightDirectionWC;
uniform mat4 czm_inverseModelView;






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

uniform float czm_morphTime;









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

uniform float czm_eyeHeight;
uniform vec3 czm_ellipsoidRadii;
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
float interpolateByDistance(vec4 nearFarScalar, float distance)
{
    float startDistance = nearFarScalar.x;
    float startValue = nearFarScalar.y;
    float endDistance = nearFarScalar.z;
    float endValue = nearFarScalar.w;
    float t = clamp((distance - startDistance) / (endDistance - startDistance), 0.0, 1.0);
    return mix(startValue, endValue, t);
}

void computeAtmosphereScattering(vec3 positionWC, vec3 lightDirection, out vec3 rayleighColor, out vec3 mieColor, out float opacity, out float underTranslucentGlobe)
{
    float ellipsoidRadiiDifference = czm_ellipsoidRadii.x - czm_ellipsoidRadii.z;

    
    float distanceAdjustMin = czm_ellipsoidRadii.x / 4.0;
    float distanceAdjustMax = czm_ellipsoidRadii.x;
    float distanceAdjustModifier = ellipsoidRadiiDifference / 2.0;
    float distanceAdjust = distanceAdjustModifier * clamp((czm_eyeHeight - distanceAdjustMin) / (distanceAdjustMax - distanceAdjustMin), 0.0, 1.0);

    
    
    float radiusAdjust = (ellipsoidRadiiDifference / 4.0) + distanceAdjust;
    float atmosphereInnerRadius = (length(czm_viewerPositionWC) - czm_eyeHeight) - radiusAdjust;

    
    vec3 cameraToPositionWC = positionWC - czm_viewerPositionWC;
    vec3 cameraToPositionWCDirection = normalize(cameraToPositionWC);
    czm_ray primaryRay = czm_ray(czm_viewerPositionWC, cameraToPositionWCDirection);

    underTranslucentGlobe = 0.0;

    
    #if defined(GLOBE_TRANSLUCENT)

        
        czm_raySegment primaryRayEarthIntersect = czm_raySphereIntersectionInterval(primaryRay, vec3(0.0), atmosphereInnerRadius + radiusAdjust);
        if (primaryRayEarthIntersect.start > 0.0 && primaryRayEarthIntersect.stop > 0.0) {

            
            vec3 direction = normalize(positionWC);
            czm_ray ellipsoidRay = czm_ray(positionWC, -direction);
            czm_raySegment ellipsoidIntersection = czm_rayEllipsoidIntersectionInterval(ellipsoidRay, vec3(0.0), czm_ellipsoidInverseRadii);
            vec3 onEarth = positionWC - (direction * ellipsoidIntersection.start);

            
            float angle = dot(normalize(czm_viewerPositionWC), normalize(onEarth));

            
            opacity = interpolateByDistance(vec4(0.0, 1.0, czm_ellipsoidRadii.x, 0.0), length(czm_viewerPositionWC - onEarth));
            vec3 horizonColor = vec3(0.1, 0.2, 0.3);
            vec3 nearColor = vec3(0.0);

            rayleighColor = mix(nearColor, horizonColor, exp(-angle) * opacity);

            
            underTranslucentGlobe = 1.0;
            return;
        }
    #endif

    computeScattering(
        primaryRay,
        length(cameraToPositionWC),
        lightDirection,
        atmosphereInnerRadius,
        rayleighColor,
        mieColor,
        opacity
    );

    
    
    float cameraHeight = czm_eyeHeight + atmosphereInnerRadius;
    float atmosphereOuterRadius = atmosphereInnerRadius + ATMOSPHERE_THICKNESS;
    opacity = clamp((atmosphereOuterRadius - cameraHeight) / (atmosphereOuterRadius - atmosphereInnerRadius), 0.0, 1.0);

    
    float nightAlpha = (u_radiiAndDynamicAtmosphereColor.z != 0.0) ? clamp(dot(normalize(positionWC), lightDirection), 0.0, 1.0) : 1.0;
    opacity *= pow(nightAlpha, 0.5);
}

#line 0
in vec3 v_outerPositionWC;

uniform vec3 u_hsbShift;

#ifndef PER_FRAGMENT_ATMOSPHERE
in vec3 v_mieColor;
in vec3 v_rayleighColor;
in float v_opacity;
in float v_translucent;
#endif

void czm_log_depth_main()
{
    float lightEnum = u_radiiAndDynamicAtmosphereColor.z;
    vec3 lightDirection = czm_getDynamicAtmosphereLightDirection(v_outerPositionWC, lightEnum);

    vec3 mieColor;
    vec3 rayleighColor;
    float opacity;
    float translucent;

    #ifdef PER_FRAGMENT_ATMOSPHERE
        computeAtmosphereScattering(
            v_outerPositionWC,
            lightDirection,
            rayleighColor,
            mieColor,
            opacity,
            translucent
        );
    #else
        mieColor = v_mieColor;
        rayleighColor = v_rayleighColor;
        opacity = v_opacity;
        translucent = v_translucent;
    #endif

    vec4 color = computeAtmosphereColor(v_outerPositionWC, lightDirection, rayleighColor, mieColor, opacity);

    #ifndef HDR
        color.rgb = czm_pbrNeutralTonemapping(color.rgb);
        color.rgb = czm_inverseGamma(color.rgb);
    #endif

    #ifdef COLOR_CORRECT
        const bool ignoreBlackPixels = true;
        color.rgb = czm_applyHSBShift(color.rgb, u_hsbShift, ignoreBlackPixels);
    #endif

    
    
    
    
    if (translucent == 0.0) {
        color.a = mix(color.b, 1.0, color.a) * smoothstep(0.0, 1.0, czm_morphTime);
    }

    out_FragColor = color;
}

#line 0

void main()
{
    czm_log_depth_main();
    czm_writeLogDepth();
}
