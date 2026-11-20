/**
 * 引擎内置 GLSL。
 * 用户只编写 fragment shader 的“函数体部分”：uniform 声明 + main()，
 * 引擎在前面注入 precision 和内置 varying，因此报错行号需要减去前缀行数。
 */

export const FULLSCREEN_VERT = `
attribute vec2 aPosition;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  // 全屏通道没有真正的网格，给出稳定的默认值
  vNormal = vec3(0.0, 0.0, 1.0);
  vWorldPos = vec3(aPosition, 0.0);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const MESH_VERT = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uMVP;
uniform mat4 uModel;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vUv = aUv;
  // 无缩放旋转的模型：法线矩阵等价于 mat3(uModel)
  vNormal = normalize(mat3(uModel) * aNormal);
  vWorldPos = (uModel * vec4(aPosition, 1.0)).xyz;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}
`;

/** 用户 fragment shader 之前注入的前缀（行数变化必须同步给错误行号解析） */
export const FRAG_PREFIX = `
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
`;

/** 后处理 fragment shader 前缀：场景纹理由引擎提供 */
export const POST_FRAG_PREFIX = `
precision highp float;
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uTime;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;
`;

export const POST_VERT = FULLSCREEN_VERT;

/** FRAG_PREFIX 的行数（按 \n 切分后，用户第一行对应的偏移量） */
export const FRAG_PREFIX_LINES = FRAG_PREFIX.split('\n').length - 1;
export const POST_FRAG_PREFIX_LINES = POST_FRAG_PREFIX.split('\n').length - 1;

/** 引擎保留、不暴露到侧栏的 uniform 名 */
export const BUILTIN_UNIFORMS = new Set([
  'uTime',
  'uResolution',
  'uMVP',
  'uModel',
  'uScene',
]);
