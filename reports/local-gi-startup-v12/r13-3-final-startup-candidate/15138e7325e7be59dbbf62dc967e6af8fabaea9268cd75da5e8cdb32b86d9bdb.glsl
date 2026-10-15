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







const float czm_infinity = 5906376272000.0;  







const float czm_epsilon7 = 0.0000001;







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

uniform float czm_gamma;

















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

uniform float czm_atmosphereLightIntensity;
uniform float czm_atmosphereMieAnisotropy;
uniform vec3 czm_viewerPositionWC;
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

uniform vec3 czm_sunDirectionWC;
uniform vec3 czm_lightDirectionWC;
uniform mat4 czm_inverseModelView;









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
















vec3 czm_saturation(vec3 rgb, float adjustment)
{
    
    const vec3 W = vec3(0.2125, 0.7154, 0.0721);
    vec3 intensity = vec3(dot(rgb, W));
    return mix(intensity, rgb, adjustment);
}

uniform vec4 czm_backgroundColor;
uniform samplerCube czm_environmentMap;










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
uniform mat3 czm_temeToPseudoFixed;
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
















bool czm_isEmpty(czm_raySegment interval)
{
    return (interval.stop < 0.0);
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


in vec2 v_textureCoordinates;

uniform vec3 u_faceDirection; 
uniform vec3 u_positionWC;
uniform mat4 u_enuToFixedFrame;
uniform vec4 u_brightnessSaturationGammaIntensity;
uniform vec4 u_groundColor; 

vec4 getCubeMapDirection(vec2 uv, vec3 faceDir) {
    vec2 scaledUV = uv * 2.0 - 1.0;

    if (faceDir.x != 0.0) {
        return vec4(faceDir.x,  scaledUV.x * faceDir.x, -scaledUV.y, 0.0);
    } else if (faceDir.y != 0.0) {
        return vec4(scaledUV.x, -scaledUV.y * faceDir.y, faceDir.y, 0.0);
    } else {
        return vec4(scaledUV.x * faceDir.z, -faceDir.z, -scaledUV.y, 0.0); 
    }
}

void main() {    
    float height = length(u_positionWC);
    float atmosphereInnerRadius = u_radiiAndDynamicAtmosphereColor.y;
    float ellipsoidHeight = max(height - atmosphereInnerRadius, 0.0);

    
    vec3 positionWC = u_positionWC / height * (ellipsoidHeight + atmosphereInnerRadius);

    float atmosphereOuterRadius = u_radiiAndDynamicAtmosphereColor.x;
    float atmosphereHeight = atmosphereOuterRadius - atmosphereInnerRadius;

    vec3 direction = (u_enuToFixedFrame * getCubeMapDirection(v_textureCoordinates, u_faceDirection)).xyz;
    vec3 normalizedDirection = normalize(direction);

    czm_ray ray = czm_ray(positionWC, normalizedDirection);
    czm_raySegment intersection = czm_raySphereIntersectionInterval(ray, vec3(0.0), atmosphereInnerRadius);
    if (!czm_isEmpty(intersection)) {
        intersection = czm_rayEllipsoidIntersectionInterval(ray, vec3(0.0), czm_ellipsoidInverseRadii);
    }

    bool onEllipsoid = intersection.start >= 0.0;
    float rayLength = czm_branchFreeTernary(onEllipsoid, intersection.start, atmosphereOuterRadius);

    
    vec3 skyPositionWC = positionWC + normalizedDirection * rayLength;

    float lightEnum = u_radiiAndDynamicAtmosphereColor.z;
    vec3 lightDirectionWC = normalize(czm_getDynamicAtmosphereLightDirection(skyPositionWC, lightEnum));
    vec3 mieColor;
    vec3 rayleighColor;
    float opacity;
    czm_computeScattering(
        ray,
        rayLength,
        lightDirectionWC,
        atmosphereInnerRadius, 
        rayleighColor,
        mieColor,
        opacity
    );

    vec4 atmopshereColor = czm_computeAtmosphereColor(ray, lightDirectionWC, rayleighColor, mieColor, opacity);

#ifdef ATMOSPHERE_COLOR_CORRECT
    const bool ignoreBlackPixels = true;
    atmopshereColor.rgb = czm_applyHSBShift(atmopshereColor.rgb, czm_atmosphereHsbShift, ignoreBlackPixels);
#endif

    vec3 lookupDirection = -normalizedDirection;
     
    lookupDirection.x = -lookupDirection.x;
    lookupDirection = -normalize(czm_temeToPseudoFixed * lookupDirection);
    lookupDirection.x = -lookupDirection.x;

    
    float skyAlpha = clamp((1.0 - ellipsoidHeight / atmosphereHeight) * atmopshereColor.a, 0.0, 1.0);
    skyAlpha = czm_branchFreeTernary(length(atmopshereColor.rgb) <= czm_epsilon7, 0.0, skyAlpha); 

    
    float intensity = u_brightnessSaturationGammaIntensity.w;
    vec4 sceneSkyBoxColor = czm_textureCube(czm_environmentMap, lookupDirection);
    vec3 skyBackgroundColor = mix(czm_backgroundColor.rgb, sceneSkyBoxColor.rgb, sceneSkyBoxColor.a);
    vec4 combinedSkyColor = vec4(mix(skyBackgroundColor, atmopshereColor.rgb * intensity, skyAlpha), 1.0);

    
    vec3 up = normalize(positionWC);
    float occlusion = max(dot(lightDirectionWC, up), 0.05);
    vec4 groundColor = vec4(u_groundColor.rgb * u_groundColor.a * (vec3(intensity * occlusion) + atmopshereColor.rgb), 1.0);
    vec4 blendedGroundColor = mix(groundColor, atmopshereColor, clamp(ellipsoidHeight / atmosphereHeight, 0.0, 1.0));

    vec4 color = czm_branchFreeTernary(onEllipsoid, blendedGroundColor, combinedSkyColor);

    float brightness = u_brightnessSaturationGammaIntensity.x;
    float saturation = u_brightnessSaturationGammaIntensity.y;
    float gamma = u_brightnessSaturationGammaIntensity.z;

#ifdef ENVIRONMENT_COLOR_CORRECT
    color.rgb = mix(vec3(0.0), color.rgb, brightness);
    color.rgb = czm_saturation(color.rgb, saturation);
#endif
    color.rgb = pow(color.rgb, vec3(gamma)); 
    color.rgb = czm_gammaCorrect(color.rgb);

    out_FragColor = color;
}
