#version 300 es
precision highp sampler3D;

#define OES_texture_float_linear

#define OES_texture_float


#line 0
uniform mat4 czm_projection;
uniform vec2 czm_entireFrustum;
uniform mat3 czm_temeToPseudoFixed;
uniform mat3 czm_viewRotation;


#line 0
in vec3 position;
out vec3 v_texCoord;

void main()
{
    vec3 p = czm_viewRotation * (czm_temeToPseudoFixed * (czm_entireFrustum.y * position));
    gl_Position = czm_projection * vec4(p, 1.0);
    v_texCoord = position.xyz;
}
