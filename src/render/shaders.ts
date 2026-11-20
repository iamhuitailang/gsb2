// GLSL ES 3.00 着色器源码

export const MESH_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;

uniform mat4 uViewProj;

out vec3 vWorldPos;
out vec3 vNormal;
out vec2 vUv;

void main() {
  vWorldPos = aPosition;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const MESH_FRAG = /* glsl */ `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;
in vec2 vUv;

uniform vec3 uBaseColor;
uniform float uOpacity;
uniform sampler2D uMap;
uniform float uUseMap;
uniform vec3 uSpecular;
uniform float uShininess;

uniform vec3 uLightDir;
uniform vec3 uAmbientColor;
uniform vec3 uLightColor;
uniform vec3 uCameraPos;

out vec4 fragColor;

void main() {
  vec4 texel = mix(vec4(1.0), texture(uMap, vUv), uUseMap);
  vec3 base = uBaseColor * texel.rgb;

  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  float diffuse = max(dot(n, normalize(uLightDir)), 0.0);
  vec3 ambient = uAmbientColor * base;
  vec3 lambert = uLightColor * base * diffuse;

  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 halfDir = normalize(normalize(uLightDir) + viewDir);
  float specPower = max(uShininess, 1.0);
  float spec = pow(max(dot(n, halfDir), 0.0), specPower);
  vec3 specular = uLightColor * uSpecular * spec;

  fragColor = vec4(ambient + lambert + specular, uOpacity * texel.a);
}
`;

export const LINE_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;

uniform mat4 uViewProj;

void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const LINE_FRAG = /* glsl */ `#version 300 es
precision highp float;

uniform vec3 uColor;
uniform float uAlpha;

out vec4 fragColor;

void main() {
  fragColor = vec4(uColor, uAlpha);
}
`;
