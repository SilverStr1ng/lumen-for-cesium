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
precision highp sampler2D;
uniform sampler2D u_borderSource;
void main() {
ivec2 pixel=ivec2(gl_FragCoord.xy),tile=pixel/10,c=pixel%10;
if(c.x==0&&c.y==0) c=ivec2(8,8);
else if(c.x==9&&c.y==0) c=ivec2(1,8);
else if(c.x==0&&c.y==9) c=ivec2(8,1);
else if(c.x==9&&c.y==9) c=ivec2(1,1);
else if(c.x==0) c=ivec2(1,9-c.y);
else if(c.x==9) c=ivec2(8,9-c.y);
else if(c.y==0) c=ivec2(9-c.x,1);
else if(c.y==9) c=ivec2(9-c.x,8);
out_FragColor=texelFetch(u_borderSource,tile*8+c-1,0);
}