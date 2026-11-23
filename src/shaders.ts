// GLSL ES 3.00 着色器。三套 program 共用固定 attribute location：
//   0 position(3) 1 normal(3)
//   2~5 model 矩阵四列(mat4)  6 color+selected(vec4)  7 pickId(float)
// 实例属性按“分块起始 + gl_InstanceID”手动索引——WebGL2 没有 gl_BaseInstance，
// drawElementsInstanced 的 baseInstance 参数在 ANGLE 翻译后不可靠，
// 因此每个分块用 uniform uBaseInstance 传入起始槽位。

const COMMON_VERT = /* glsl */ `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aModel0;
layout(location=3) in vec4 aModel1;
layout(location=4) in vec4 aModel2;
layout(location=5) in vec4 aModel3;
layout(location=6) in vec4 aColorSel;   // rgb 颜色，a=1 表示选中
layout(location=7) in float aPickId;

uniform mat4 uViewProj;
uniform int uBaseInstance;

int instanceIndex() {
  return uBaseInstance + gl_InstanceID;
}

mat4 buildModel() {
  return mat4(aModel0, aModel1, aModel2, aModel3);
}
`;

export const MAIN_VS = COMMON_VERT + /* glsl */ `
out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vColor;
out float vSelected;

void main() {
  mat4 model = buildModel();
  vec4 world = model * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  // inverse-transpose 法线矩阵：非均匀缩放与负缩放（镜像）后法线仍正确
  mat3 normalMat = transpose(inverse(mat3(model)));
  vNormal = normalize(normalMat * aNormal);
  vColor = aColorSel.rgb;
  vSelected = aColorSel.a;
  gl_Position = uViewProj * world;
}
`;

export const MAIN_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uCamPos;
in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vColor;
in float vSelected;
out vec4 outColor;

void main() {
  vec3 N = normalize(vNormal);
  // 镜像物体背面朝向观察点时 gl_FrontFacing 为 false，翻转法线避免发黑
  if (!gl_FrontFacing) N = -N;

  vec3 lightDir = normalize(vec3(0.55, 0.8, 0.35));
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  float diff = max(dot(N, lightDir), 0.0);
  float rim = pow(1.0 - max(dot(N, viewDir), 0.0), 2.5);

  vec3 base = vColor * (0.28 + 0.72 * diff) + rim * 0.12;
  // 选中：金色自发光，跟随实例自身形状（含镜像/非均匀缩放），无需额外几何
  if (vSelected > 0.5) {
    base = mix(base, vec3(1.0, 0.82, 0.35), 0.45);
  }
  outColor = vec4(base, 1.0);
}
`;

export const LINE_VS = COMMON_VERT + /* glsl */ `
void main() {
  mat4 model = buildModel();
  gl_Position = uViewProj * model * vec4(aPosition, 1.0);
}
`;

export const LINE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uLineColor;
out vec4 outColor;
void main() {
  outColor = vec4(uLineColor, 1.0);
}
`;

// ---------- 离屏点选：MRT 三附件 ----------
export const PICK_VS = COMMON_VERT + /* glsl */ `
out vec3 vWorldPos;
out vec3 vLocalPos;
out vec3 vLocalNormal;
flat out int vPickId;

void main() {
  mat4 model = buildModel();
  vec4 world = model * vec4(aPosition, 1.0);
  vWorldPos = world.xyz;
  vLocalPos = aPosition;
  vLocalNormal = aNormal; // 局部法线 -> 命中的是哪一个盒面
  vPickId = int(aPickId + 0.5);
  gl_Position = uViewProj * world;
}
`;

export const PICK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform bool uFloatColor;   // 有无 EXT_color_buffer_float
in vec3 vWorldPos;
in vec3 vLocalPos;
in vec3 vLocalNormal;
flat in int vPickId;
layout(location=0) out vec4 outId;      // rgb: 24bit 实例 id
layout(location=1) out vec4 outPos;     // xyz: 世界坐标（RGBA8 时为编码值），a: 深度 0~1
layout(location=2) out vec4 outNormal;  // xyz: 局部法线（编码到 0~1），w: 局部位置 x

vec3 encode01(vec3 v, float lo, float hi) {
  return clamp((v - lo) / (hi - lo), 0.0, 1.0);
}

void main() {
  // 24bit id：r=高字节 g=中字节 b=低字节
  float id = float(vPickId);
  float hi = floor(id / 65536.0);
  float mid = floor((id - hi * 65536.0) / 256.0);
  float lo = id - hi * 65536.0 - mid * 256.0;
  outId = vec4(hi / 255.0, mid / 255.0, lo / 255.0, 1.0);

  // 深度本身就在 0~1，两种附件格式都直接存，避免 16F 对接近 0 的深度截断
  float depth01 = gl_FragCoord.z;
  if (uFloatColor) {
    outPos = vec4(vWorldPos, depth01);
  } else {
    // 降级：世界坐标限制在 ±50 内编码到 0~1
    outPos = vec4(encode01(vWorldPos, -50.0, 50.0), depth01);
  }

  // 法线/局部位置范围约 [-0.5, 1]，映射到 [0,1]：x*0.5+0.5
  outNormal = vec4(
    vLocalNormal * 0.5 + 0.5,
    vLocalPos[0] * 0.5 + 0.5
  );
}
`;
