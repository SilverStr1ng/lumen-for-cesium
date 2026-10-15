#version 300 es
precision highp sampler3D;

#define OES_texture_float_linear

#define OES_texture_float


#line 0


#line 0
in vec4 position;
in vec2 textureCoordinates;

out vec2 v_textureCoordinates;

void main() 
{
    gl_Position = position;
    v_textureCoordinates = textureCoordinates;
}
