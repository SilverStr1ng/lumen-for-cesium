#version 300 es
precision highp sampler3D;

#define COMPUTE_POSITION_WC_ATMOSPHERE
#define HAS_ATMOSPHERE
#define COMPUTE_POSITION_WC_ATMOSPHERE
#define HAS_NORMALS
#define HAS_TEXCOORD_0
#define HAS_DOUBLE_SIDED_MATERIAL
#define SHADOW_MAP
#define OES_texture_float_linear

#define OES_texture_float


#line 0






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

uniform vec3 czm_viewerPositionWC;
uniform vec3 czm_sunDirectionWC;
uniform vec3 czm_lightDirectionWC;
uniform mat3 czm_normal;
uniform mat4 czm_modelView;
uniform mat3 czm_normal3D;
uniform mat4 czm_modelView3D;












struct czm_modelVertexOutput {
  vec3 positionMC;
  float pointSize;
};

uniform mat4 czm_model;
uniform mat4 czm_projection;













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

uniform float czm_atmosphereDynamicLighting;











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



#line 0
in vec3 a_positionMC;
in vec3 a_normalMC;
in vec2 a_texCoord_0;
out vec3 v_atmosphereRayleighColor;
out vec3 v_atmosphereMieColor;
out float v_atmosphereOpacity;
out vec3 v_positionWC;
out vec3 v_positionEC;
out vec3 v_positionMC;
out vec3 v_normalEC;
out vec2 v_texCoord_0;
struct ProcessedAttributes
{
    vec3 positionMC;
    vec3 normalMC;
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
void initializeAttributes(out ProcessedAttributes attributes)
{
    attributes.positionMC = a_positionMC;
    attributes.normalMC = a_normalMC;
    attributes.texCoord_0 = a_texCoord_0;
}
void setDynamicVaryings(inout ProcessedAttributes attributes)
{
    v_texCoord_0 = attributes.texCoord_0;
}
void initializeFeatureIds(out FeatureIds featureIds, ProcessedAttributes attributes)
{
}
void initializeFeatureIdAliases(inout FeatureIds featureIds)
{
}
void setFeatureIdVaryings()
{
}
void initializeMetadata(FeatureIds featureIds, out Metadata metadata, out MetadataClass metadataClass, out MetadataStatistics metadataStatistics, ProcessedAttributes attributes)
{
}
void setMetadataVaryings()
{
}
void atmosphereStage(ProcessedAttributes attributes) {
    vec3 lightDirection = czm_getDynamicAtmosphereLightDirection(v_positionWC, czm_atmosphereDynamicLighting);

    czm_computeGroundAtmosphereScattering(
        
        v_positionWC,
        lightDirection,
        v_atmosphereRayleighColor,
        v_atmosphereMieColor,
        v_atmosphereOpacity
    );
}

vec4 geometryStage(inout ProcessedAttributes attributes, mat4 modelView, mat3 normal)
{
    vec4 computedPosition;

    
    vec3 positionMC = attributes.positionMC;
    v_positionMC = positionMC;
    v_positionEC = (modelView * vec4(positionMC, 1.0)).xyz;

    #if defined(USE_2D_POSITIONS) || defined(USE_2D_INSTANCING)
    vec3 position2D = attributes.position2D;
    vec3 positionEC = (u_modelView2D * vec4(position2D, 1.0)).xyz;
    computedPosition = czm_projection * vec4(positionEC, 1.0);
    #else
    computedPosition = czm_projection * vec4(v_positionEC, 1.0);
    #endif

    
    #if defined(COMPUTE_POSITION_WC_CUSTOM_SHADER) || defined(COMPUTE_POSITION_WC_STYLE) || defined(COMPUTE_POSITION_WC_ATMOSPHERE) || defined(ENABLE_CLIPPING_POLYGONS)
    
    
    v_positionWC = (czm_model * vec4(positionMC, 1.0)).xyz;
    #endif

    #ifdef HAS_NORMALS
    v_normalEC = normalize(normal * attributes.normalMC);
    #endif

    #ifdef HAS_TANGENTS
    v_tangentEC = normalize(normal * attributes.tangentMC);
    #endif

    #ifdef HAS_BITANGENTS
    v_bitangentEC = normalize(normal * attributes.bitangentMC);
    #endif

    
    
    setDynamicVaryings(attributes);

    return computedPosition;
}

void featureIdStage(out FeatureIds featureIds, ProcessedAttributes attributes) 
{
  initializeFeatureIds(featureIds, attributes);
  initializeFeatureIdAliases(featureIds);
  setFeatureIdVaryings();
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
  setMetadataVaryings();
}



czm_modelVertexOutput defaultVertexOutput(vec3 positionMC) {
    czm_modelVertexOutput vsOutput;
    vsOutput.positionMC = positionMC;
    vsOutput.pointSize = 1.0;
    return vsOutput;
}

void main()
{
    
    
    ProcessedAttributes attributes;
    initializeAttributes(attributes);

    #ifdef HAS_IMAGERY
    initializeImageryAttributes();
    #endif

    
    
    #ifdef USE_DEQUANTIZATION
    dequantizationStage(attributes);
    #endif

    #ifdef HAS_MORPH_TARGETS
    morphTargetsStage(attributes);
    #endif

    #ifdef HAS_SKINNING
    skinningStage(attributes);
    #endif

    #ifdef HAS_PRIMITIVE_OUTLINE
    primitiveOutlineStage();
    #endif

    
    
    
    #ifdef HAS_BITANGENTS
    attributes.bitangentMC = normalize(cross(attributes.normalMC, attributes.tangentMC) * attributes.tangentSignMC);
    #endif

    FeatureIds featureIds;
    featureIdStage(featureIds, attributes);

    #ifdef HAS_SELECTED_FEATURE_ID
    SelectedFeature feature;
    selectedFeatureIdStage(feature, featureIds);
    
    cpuStylingStage(attributes.positionMC, feature);
    #endif

    #if defined(USE_2D_POSITIONS) || defined(USE_2D_INSTANCING)
    
    
    
    
    mat4 modelView = czm_modelView3D;
    mat3 normal = czm_normal3D;
    #else
    
    
    mat4 modelView = czm_modelView;
    mat3 normal = czm_normal;
    #endif

    
    #ifdef HAS_INSTANCING

        
        
        
        
        #ifdef USE_LEGACY_INSTANCING
        mat4 instanceModelView;
        mat3 instanceModelViewInverseTranspose;

        legacyInstancingStage(attributes, instanceModelView, instanceModelViewInverseTranspose);

        modelView = instanceModelView;
        normal = instanceModelViewInverseTranspose;
        #else
        instancingStage(attributes);
        #endif

        #ifdef USE_PICKING
        v_pickColor = a_pickColor;
        #endif

    #endif

    Metadata metadata;
    MetadataClass metadataClass;
    MetadataStatistics metadataStatistics;
    metadataStage(featureIds, metadata, metadataClass, metadataStatistics, attributes);

    #ifdef HAS_VERTICAL_EXAGGERATION
    verticalExaggerationStage(attributes);
    #endif

    #ifdef HAS_CUSTOM_VERTEX_SHADER
    czm_modelVertexOutput vsOutput = defaultVertexOutput(attributes.positionMC);
    customShaderStage(vsOutput, attributes, featureIds, metadata, metadataClass, metadataStatistics);
    #endif

    
    
    vec4 positionClip = geometryStage(attributes, modelView, normal);

    
    #ifdef ENABLE_CLIPPING_POLYGONS
    modelClippingPolygonsStage();
    #endif

    #if defined(HAS_LINE_CUMULATIVE_DISTANCE) || defined(HAS_LINE_PATTERN)
    lineStyleStageVS(attributes);
    #endif

    
    #ifdef HAS_ATMOSPHERE
    atmosphereStage(attributes);
    #endif

    #ifdef HAS_VECTOR_LOOKUP
    modelVectorLookupStage(attributes);
    #endif

    #ifdef HAS_SILHOUETTE
    silhouetteStage(attributes, positionClip);
    #endif

    #ifdef HAS_POINT_CLOUD_SHOW_STYLE
    float show = pointCloudShowStylingStage(attributes, metadata);
    #else
    float show = 1.0;
    #endif

    #ifdef HAS_POINT_CLOUD_BACK_FACE_CULLING
    show *= pointCloudBackFaceCullingStage();
    #endif

    #ifdef HAS_POINT_CLOUD_COLOR_STYLE
    v_pointCloudColor = pointCloudColorStylingStage(attributes, metadata);
    #endif

    #ifdef PRIMITIVE_TYPE_POINTS
        #ifdef HAS_CUSTOM_VERTEX_SHADER
        gl_PointSize = vsOutput.pointSize;
        #elif defined(HAS_POINT_CLOUD_POINT_SIZE_STYLE) || defined(HAS_POINT_CLOUD_ATTENUATION)
        gl_PointSize = pointCloudPointSizeStylingStage(attributes, metadata);
        #elif defined(HAS_POINT_DIAMETER)
        gl_PointSize = u_pointDiameter;
        #else
        gl_PointSize = 1.0;
        #endif

        gl_PointSize *= show;
    #endif

    
    
    
    
    gl_Position = positionClip;

    #ifdef HAS_EDGE_VISIBILITY
    edgeVisibilityStageVS();
    #endif

    #ifdef HAS_POINT_CLOUD_SHOW_STYLE
    v_pointCloudShow = show;
    #endif
}
