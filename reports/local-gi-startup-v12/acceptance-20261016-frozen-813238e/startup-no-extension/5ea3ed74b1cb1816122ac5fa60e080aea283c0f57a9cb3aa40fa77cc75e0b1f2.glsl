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



#line 0
precision highp sampler2D;uniform sampler2D u_fgCopySource;void main(){out_FragColor=texelFetch(u_fgCopySource,ivec2(gl_FragCoord.xy),0);}