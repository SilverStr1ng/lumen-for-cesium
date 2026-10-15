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
uniform float u_radiusTS;

in vec2 v_textureCoordinates;

vec2 rotate(vec2 p, vec2 direction)
{
    return vec2(p.x * direction.x - p.y * direction.y, p.x * direction.y + p.y * direction.x);
}

vec4 addBurst(vec2 position, vec2 direction, float lengthScalar)
{
    vec2 rotatedPosition = rotate(position, direction) * vec2(25.0, 0.75);
    float radius = length(rotatedPosition) * lengthScalar;
    float burst = 1.0 - smoothstep(0.0, 0.55, radius);
    return vec4(burst);
}

void main()
{
    float lengthScalar = 2.0 / sqrt(2.0);
    vec2 position = v_textureCoordinates - vec2(0.5);
    float radius = length(position) * lengthScalar;
    float surface = step(radius, u_radiusTS);
    vec4 color = vec4(vec2(1.0), surface + 0.2, surface);

    float glow = 1.0 - smoothstep(0.0, 0.55, radius);
    color.ba += mix(vec2(0.0), vec2(1.0), glow) * 0.75;

    vec4 burst = vec4(0.0);

    
    
    
    
    
    
    
    
    
    

    burst += 0.4 * addBurst(position, vec2(0.38942,  0.92106), lengthScalar);  
    burst += 0.4 * addBurst(position, vec2(0.99235,  0.12348), lengthScalar);  
    burst += 0.4 * addBurst(position, vec2(0.60327, -0.79754), lengthScalar);  

    burst += 0.3 * addBurst(position, vec2(0.31457,  0.94924), lengthScalar);  
    burst += 0.3 * addBurst(position, vec2(0.97931,  0.20239), lengthScalar);  
    burst += 0.3 * addBurst(position, vec2(0.66507, -0.74678), lengthScalar);  

    

    color += clamp(burst, vec4(0.0), vec4(1.0)) * 0.15;

    out_FragColor = clamp(color, vec4(0.0), vec4(1.0));
}
