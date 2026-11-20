export const SOLID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;

uniform mat4 uModel;
uniform mat4 uViewProjection;
uniform mat3 uNormalMatrix;

out vec3 vWorldPos;
out vec3 vNormal;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vNormal = normalize(uNormalMatrix * aNormal);
  gl_Position = uViewProjection * world;
}
`;

export const SOLID_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
in vec3 vNormal;

uniform vec3 uColor;
uniform float uRoughness;
uniform float uEmissive;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform float uSelected;
uniform vec3 uAccent;

out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uCameraPos - vWorldPos);
  vec3 l = normalize(uSunDir);

  float ndl = max(dot(n, l), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 sky = vec3(0.34, 0.44, 0.62);
  vec3 ground = vec3(0.09, 0.08, 0.10);
  vec3 ambient = mix(ground, sky, hemi) * 0.55;

  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), mix(96.0, 6.0, uRoughness));
  float specAmount = (1.0 - uRoughness) * 0.55;

  // Soft rim light so silhouettes read against the dark background.
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * 0.25;

  vec3 base = uColor;
  vec3 color = base * (ambient + ndl * vec3(1.0, 0.94, 0.84) * 0.85);
  color += vec3(1.0) * spec * specAmount;
  color += base * uEmissive;
  color += vec3(0.45, 0.6, 0.9) * rim;

  color = mix(color, uAccent, uSelected * 0.35);
  color += uAccent * uSelected * 0.12;

  // Tonemap (Reinhard) + gamma.
  color = color / (color + vec3(1.0));
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color, 1.0);
}
`;

export const LINE_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aColor;

uniform mat4 uViewProjection;

out vec3 vColor;

void main() {
  vColor = aColor;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`;

export const LINE_FS = `#version 300 es
precision highp float;

in vec3 vColor;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  fragColor = vec4(vColor, uOpacity);
}
`;

export const GRID_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;

uniform mat4 uViewProjection;

out vec3 vWorldPos;

void main() {
  vWorldPos = aPosition;
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
}
`;

export const GRID_FS = `#version 300 es
precision highp float;

in vec3 vWorldPos;
uniform vec3 uColor;
uniform vec3 uAccent;
uniform float uOpacity;
uniform float uFadeDistance;

out vec4 fragColor;

void main() {
  vec3 c = vWorldPos.xz;
  vec2 grid = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  float line = min(grid.x, grid.y);
  float alpha = 1.0 - min(line, 1.0);
  float dist = length(vWorldPos.xz);
  float fade = 1.0 - smoothstep(uFadeDistance * 0.35, uFadeDistance, dist);
  vec3 color = mix(uColor, uAccent, smoothstep(40.0, 90.0, dist));
  fragColor = vec4(color, alpha * fade * uOpacity);
}
`;

export const POINT_VS = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;

uniform mat4 uViewProjection;
uniform float uPointSize;

void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
}
`;

export const POINT_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
uniform float uOpacity;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  float edge = smoothstep(0.5, 0.42, r);
  fragColor = vec4(uColor, edge * uOpacity);
}
`;

export const SHADOW_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0, 0.0, 0.0, 0.45);
}
`;
