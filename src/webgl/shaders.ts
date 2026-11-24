// WebGL1 着色器。法线图始终按 OpenGL 约定存储，uFlipG=1 时翻绿（DirectX 约定）。
// 镜像半的左手切线基通过负 handedness 体现在 B 上，不需要着色器特判。

export const MESH_VS = `
attribute vec3 aPosition;
attribute vec3 aT;
attribute vec3 aB;
attribute vec3 aN;
attribute vec2 aUV;
attribute float aValid;

uniform mat4 uViewProj;

varying vec3 vT;
varying vec3 vB;
varying vec3 vN;
varying vec2 vUV;
varying float vValid;
varying vec4 vClip;

void main() {
  vT = aT;
  vB = aB;
  vN = aN;
  vUV = aUV;
  vValid = aValid;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
  vClip = gl_Position;
}
`;

export const MESH_FS = `
precision highp float;

varying vec3 vT;
varying vec3 vB;
varying vec3 vN;
varying vec2 vUV;
varying float vValid;
varying vec4 vClip;

uniform sampler2D uNormalMap;
uniform vec3 uLightDir;   // 指向光源，世界空间
uniform vec3 uViewDir;    // 指向相机，世界空间
uniform float uFlipG;     // 0 = OpenGL, 1 = DirectX(翻绿)
uniform float uUseTex;    // 0 = 平面着色调试，1 = 法线图
uniform float uDiffuse;
uniform float uSpecular;
uniform float uShininess;
uniform float uSelected;
uniform float uHalfTint;  // 0 普通半, 1 镜像半（轻微染色提示）

void main() {
  vec3 geoN = normalize(vN);
  vec3 nrm = geoN;
  if (vValid > 0.5 && uUseTex > 0.5) {
    vec3 raw = texture2D(uNormalMap, vUV).rgb * 2.0 - 1.0;
    raw.y = mix(raw.y, -raw.y, uFlipG);
    raw = normalize(raw);
    nrm = normalize(raw.x * normalize(vT) + raw.y * normalize(vB) + raw.z * geoN);
  }

  vec3 L = normalize(uLightDir);
  vec3 V = normalize(uViewDir);
  float lambert = max(dot(nrm, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(nrm, H), 0.0), uShininess) * step(0.0001, lambert);

  vec3 base = vec3(0.78, 0.76, 0.70);
  base = mix(base, vec3(0.70, 0.76, 0.82), uHalfTint * 0.35);
  vec3 color = base * (0.12 + uDiffuse * lambert);
  color += uSpecular * spec * vec3(1.0, 0.96, 0.86);

  if (vValid < 0.5) {
    // 无法决定方向的面：屏幕空间红色斜纹警示（不依赖 UV，退化 UV 也能稳定显示）
    vec2 sp = vClip.xy / vClip.w;
    float stripe = step(0.5, fract((sp.x + sp.y) * 18.0));
    color = mix(vec3(0.85, 0.12, 0.08), vec3(0.32, 0.04, 0.02), stripe);
  }
  if (uSelected > 0.5) {
    color = mix(color, vec3(1.0, 0.75, 0.15), 0.45);
  }
  gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

export const LINE_VS = `
attribute vec3 aPosition;
attribute vec3 aColor;
uniform mat4 uViewProj;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uViewProj * vec4(aPosition, 1.0);
}
`;

export const LINE_FS = `
precision mediump float;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, 1.0);
}
`;
