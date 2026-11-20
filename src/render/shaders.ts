/** GLSL ES 3.00 着色器源码。 */

export const terrainVert = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;

uniform mat4 uViewProj;

out vec3 vNormal;
out vec3 vWorldPos;
out vec4 vColor;

void main() {
  vNormal = aNormal;
  vWorldPos = aPosition;
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const terrainFrag = /* glsl */ `#version 300 es
precision highp float;

in vec3 vNormal;
in vec3 vWorldPos;
in vec4 vColor;

uniform vec3 uLightDir;
uniform vec3 uCameraPos;
uniform float uWorldSize;

out vec4 fragColor;

// 未涂抹区域按高度 + 坡度生成默认地貌色
vec3 defaultTerrainColor(float h, float slope) {
  vec3 sand = vec3(0.76, 0.70, 0.52);
  vec3 grass = vec3(0.33, 0.52, 0.27);
  vec3 rock = vec3(0.45, 0.42, 0.39);
  vec3 snow = vec3(0.92, 0.94, 0.97);
  float t = clamp(h / uWorldSize * 2.0 + 0.5, 0.0, 1.0);
  vec3 c = mix(sand, grass, smoothstep(0.15, 0.45, t));
  c = mix(c, rock, smoothstep(0.55, 0.8, t) * 0.8);
  c = mix(c, snow, smoothstep(0.82, 0.97, t));
  c = mix(c, rock, smoothstep(0.55, 0.85, slope) * 0.85);
  return c;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 base = vColor.a > 0.001 ? vColor.rgb : defaultTerrainColor(vWorldPos.y, 1.0 - n.y);

  vec3 L = normalize(uLightDir);
  float diffuse = max(dot(n, L), 0.0);
  float ambient = 0.35;
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n, H), 0.0), 24.0) * 0.12;

  vec3 lit = base * (ambient + diffuse * 0.75) + vec3(spec);

  // 距离雾，弱化区块拼接的视觉边界
  float dist = length(uCameraPos - vWorldPos);
  float fog = smoothstep(uWorldSize * 1.1, uWorldSize * 2.2, dist);
  lit = mix(lit, vec3(0.10, 0.12, 0.16), fog);

  fragColor = vec4(lit, 1.0);
}
`;

export const lineVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
uniform mat4 uViewProj;
void main() {
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const lineFrag = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}
`;
