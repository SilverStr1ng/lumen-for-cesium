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










vec4 czm_packDepth(float depth)
{
    
    
    vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * depth;
    enc = fract(enc);
    enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
    return enc;
}



#line 0
uniform highp sampler2D u_depthTexture;

in vec2 v_textureCoordinates;

void main()
{
    out_FragColor = czm_packDepth(texture(u_depthTexture, v_textureCoordinates).r);
}
