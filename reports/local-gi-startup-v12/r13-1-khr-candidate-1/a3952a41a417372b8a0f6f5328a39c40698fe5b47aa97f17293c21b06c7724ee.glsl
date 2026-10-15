#version 300 es
precision highp sampler3D;

#define COMPUTE_POSITION_WC_ATMOSPHERE
#define HAS_NORMALS
#define HAS_TEXCOORD_0
#define OES_texture_float_linear

#define OES_texture_float


#line 0
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


#line 0
in vec3 a_positionMC;
in vec3 a_normalMC;
in vec2 a_texCoord_0;
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
