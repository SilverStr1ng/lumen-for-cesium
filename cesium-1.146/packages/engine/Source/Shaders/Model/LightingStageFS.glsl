// Shadow receiver sets visibility BEFORE material lighting and atmosphere.
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
        // Environment maps were provided, use them for IBL
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

    // clearcoatF0 = vec3(pow((ior - 1.0) / (ior + 1.0), 2.0)), but without KHR_materials_ior, ior is a constant 1.5.
    vec3 f0 = vec3(0.04);
    vec3 f90 = vec3(1.0);
    // Note: clearcoat Fresnel computed with dot(n, v) instead of dot(v, h).
    // This is to make it energy conserving with a simple layering function.
    float NdotV = clamp(dot(normal, viewDirection), 0.0, 1.0);
    vec3 F = fresnelSchlick2(f0, f90, NdotV);

    // compute specular reflection from direct lighting
    float roughness = material.clearcoatRoughness;
    float alphaRoughness = roughness * roughness;
    float directStrength = computeDirectSpecularStrength(normal, lightDirection, viewDirection, halfwayDirection, alphaRoughness);
    vec3 directReflection = F * directStrength * NdotL;
    vec3 color = lightColorHdr * directReflection;

    #ifdef SPECULAR_IBL
        // Find the direction in which to sample the environment map
        vec3 reflectMC = normalize(model_iblReferenceFrameMatrix * reflect(-viewDirection, normal));
        vec3 iblColor = computeSpecularIBL(reflectMC, NdotV, f0, roughness);
        color += iblColor * material.occlusion;
    #endif

    float clearcoatFactor = material.clearcoatFactor;
    vec3 clearcoatColor = color * clearcoatFactor;

    // Dim base layer based on transmission loss through clearcoat
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
        // Applied after computeIBL has derived the current material energy allocation.
    }
    #endif

    #ifdef LUMEN_MODEL_LIGHTING
    lumen_iblDiffuseResponse = material.diffuse;
    lumen_environmentDiffuse = vec3(0.0);
    lumen_environmentSpecular = vec3(0.0);
    lumen_environmentMultiple = vec3(0.0);
    #endif
    // Accumulate colors from base layer
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
        // Mask every visible registered ball, including receivers rejected by
        // the support gate. Diagnostics must not remove failures from coverage.
        if(u_lumenDebugMode==18)color=vec3(u_lumenFgCurved?1.0:0.0,acos(clamp(dot(lumen_triangleNormal(position),material.normalEC),-1.0,1.0)),lumen_volumeCoverage);
        // Small integer IDs remain exact in the HDR half-float scene target.
        if(u_lumenDebugMode==19)color=vec3(u_lumenFgCurved?128.0+u_lumenFgSurfaceId-4096.0:u_lumenDiagnosticSurface,u_lumenFgCurved?1.0:0.0,u_lumenFgCurved&&((u_lumenEyeToLocal*vec4(position,1.0)).z<=u_lumenDiagnosticFloorZ+0.04)?8.0:u_lumenDiagnosticSurface>0.0?4.0:0.0);
        if(u_lumenDebugMode==20){float angle=clamp(acos(clamp(dot(lumen_triangleNormal(position),material.normalEC),-1.0,1.0))/(czm_pi/6.0),0.0,1.0);color=u_lumenFgCurved?vec3(angle,0,1.0-angle):vec3(0);}
        #endif
    }
    #endif
    return color;
}
#endif

/**
 * Compute the material color under the current lighting conditions.
 * All other material properties are passed through so further stages
 * have access to them.
 *
 * @param {czm_modelMaterial} material The material properties from {@MaterialStageFS}
 * @param {ProcessedAttributes} attributes
 */
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
        // Remaining alpha/clipping/log-depth stages still execute in the original main.
        return;
    #endif
    #ifdef LIGHTING_PBR
        #ifdef HAS_NORMALS
            // Attribute normal is the macro normal before normal mapping. Align for double-sided faces.
            vec3 geometricNormal = normalize(attributes.normalEC);
            #if defined(HAS_DOUBLE_SIDED_MATERIAL)
                if (czm_backFacing()) geometricNormal = -geometricNormal;
            #endif
            #if defined(LUMEN_MODEL_LIGHTING) && defined(LUMEN_RECEIVER_COMPOSITE)
                // Registered sphere Ns is the attribute normal; DDGI/FG geometry
                // bias must still use the true triangle Ng. PBR response keeps Ns.
                if(u_lumenFgCurved)geometricNormal=lumen_triangleNormal(attributes.positionEC);
            #endif
            vec3 color = computePbrLighting(material, attributes.positionEC, geometricNormal);
        #else
            vec3 color = material.diffuse * material.occlusion + material.emissive;
        #endif
        // In HDR mode, the frame buffer is in linear color space. The
        // post-processing stages (see PostProcessStageCollection) will handle
        // tonemapping. However, if HDR is not enabled, we must tonemap else large
        // values may be clamped to 1.0
        #ifndef HDR
            color = czm_pbrNeutralTonemapping(color);
        #endif
    #else // unlit
        vec3 color = material.diffuse;
    #endif

    #ifdef HAS_POINT_CLOUD_COLOR_STYLE
        // The colors resulting from point cloud styles are adjusted differently.
        color = czm_gammaCorrect(color);
    #elif !defined(HDR)
        // If HDR is not enabled, the frame buffer stores sRGB colors rather than
        // linear colors so the linear value must be converted.
        color = czm_linearToSrgb(color);
    #endif

    material.diffuse = color;
}
