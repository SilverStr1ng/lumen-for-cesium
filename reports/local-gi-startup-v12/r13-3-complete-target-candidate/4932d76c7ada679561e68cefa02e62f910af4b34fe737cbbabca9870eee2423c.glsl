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

#define MRT
#define OES_texture_float_linear

#define OES_texture_float


#line 0


#line 0
#ifdef MRT
layout (location = 0) out vec4 out_FragData_0;
layout (location = 1) out vec4 out_FragData_1;
#else
layout (location = 0) out vec4 out_FragColor;
#endif

uniform vec4 u_bgColor;
uniform sampler2D u_depthTexture;

in vec2 v_textureCoordinates;

void main()
{
    if (texture(u_depthTexture, v_textureCoordinates).r < 1.0)
    {
#ifdef MRT
        out_FragData_0 = u_bgColor;
        out_FragData_1 = vec4(u_bgColor.a);
#else
        out_FragColor = u_bgColor;
#endif
        return;
    }
    
    discard;
}
