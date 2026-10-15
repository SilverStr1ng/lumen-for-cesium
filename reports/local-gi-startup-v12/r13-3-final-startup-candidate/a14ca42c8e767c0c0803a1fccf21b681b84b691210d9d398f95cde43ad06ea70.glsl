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

#define HDR
#define OES_texture_float_linear

#define OES_texture_float


#line 0
layout(location = 0) out vec4 out_FragColor;

uniform float czm_gamma;
uniform float czm_morphTime;









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


#line 0
uniform samplerCube u_cubeMap;

in vec3 v_texCoord;

void main()
{
    vec4 color = czm_textureCube(u_cubeMap, normalize(v_texCoord));
    out_FragColor = vec4(czm_gammaCorrect(color).rgb, czm_morphTime);
}
