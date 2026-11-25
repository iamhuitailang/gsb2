// 全部 GLSL 集中在此,便于逐段核对。管线:
//   G-buffer(MRT: 颜色 / 像素速度 / 深度)
//   -> TAA resolve(新历史颜色 + 调试权重纹理 + 重影差纹理 + 历史深度 blit)
//   -> stats 分块降采样(全图重影与静止边缘指标)
//   -> display(单帧 / TAA / 分屏 / 区域掩膜 / 调试通道)

const COMMON = `#version 300 es
precision highp float;
`;

// ---------- G-buffer ----------
export const GBUF_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aInstance0;
layout(location=3) in vec4 aInstance1;
layout(location=4) in vec4 aInstance2;
layout(location=5) in vec4 aInstance3;
layout(location=6) in vec4 aPrevInstance0;
layout(location=7) in vec4 aPrevInstance1;
layout(location=8) in vec4 aPrevInstance2;
layout(location=9) in vec4 aPrevInstance3;
uniform mat4 uModel;
uniform mat4 uPrevModel;
uniform mat4 uViewProj;
uniform mat4 uPrevViewProj;
uniform int uInstanced;
out vec3 vNormal;
out vec3 vWorld;
out vec2 vVelocity; // 像素单位速度
void main() {
  mat4 inst = mat4(aInstance0, aInstance1, aInstance2, aInstance3);
  mat4 prevInst = mat4(aPrevInstance0, aPrevInstance1, aPrevInstance2, aPrevInstance3);
  mat4 m = uInstanced == 1 ? uModel * inst : uModel;
  mat4 pm = uInstanced == 1 ? uPrevModel * prevInst : uPrevModel;
  vec4 world = m * vec4(aPos, 1.0);
  vec4 prevWorld = pm * vec4(aPos, 1.0);
  vec4 clip = uViewProj * world;
  vec4 prevClip = uPrevViewProj * prevWorld;
  vec2 curNdc = clip.xy / clip.w;
  vec2 prevNdc = prevClip.xy / prevClip.w;
  // NDC 差 -> 像素差(在片元端乘分辨率, varying 先传 NDC)
  vVelocity = (curNdc - prevNdc) * 0.5;
  vNormal = mat3(m) * aNormal;
  vWorld = world.xyz;
  gl_Position = clip;
}
`;

export const GBUF_FS = COMMON + `
in vec3 vNormal;
in vec3 vWorld;
in vec2 vVelocity;
uniform vec3 uColor;
uniform int uIsWall;
uniform vec2 uWallHalf;
uniform vec2 uResolution;
layout(location=0) out vec4 outColor;
layout(location=1) out vec4 outVelocity;

// 静止细线墙:三组频率的竖线 + 一组横线,宽度逐级逼近 1 像素,
// fwidth 解析抗锯齿 —— 单帧边缘稳,但亚像素相位会被逐帧抖动驱动。
vec3 wallShade(vec3 base) {
  float fx = fwidth(vWorld.x);
  float fy = fwidth(vWorld.y);
  float line = 0.0;
  // 宽竖线(约 4-6px)
  float p1 = fract(vWorld.x * 1.6);
  line = max(line, 1.0 - smoothstep(0.05 * 1.6 - fx, 0.05 * 1.6 + fx, p1));
  // 中等竖线(约 1-2px)
  float p2 = fract(vWorld.x * 5.5 + 0.37);
  line = max(line, 1.0 - smoothstep(0.02 * 5.5 - fx, 0.02 * 5.5 + fx, p2));
  // 亚像素细竖线(标称宽度 <1px,抖动下时隐时现 —— 静止细线测试靶)
  float p3 = fract(vWorld.x * 13.0 + 0.71);
  line = max(line, 1.0 - smoothstep(0.008 * 13.0 - fx, 0.008 * 13.0 + fx, p3));
  // 横向细线
  float p4 = fract(vWorld.y * 9.0 + 0.2);
  line = max(line, 1.0 - smoothstep(0.01 * 9.0 - fy, 0.01 * 9.0 + fy, p4));
  vec3 dark = base * 0.25;
  return mix(base, dark, clamp(line, 0.0, 1.0));
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.6));
  float diff = 0.35 + 0.65 * max(dot(n, lightDir), 0.0);
  vec3 color = uColor * diff;
  if (uIsWall == 1) {
    color = wallShade(uColor);
  }
  outColor = vec4(color, 1.0);
  outVelocity = vec4(vVelocity * uResolution, 0.0, 1.0);
}
`;

// ---------- TAA resolve ----------
export const RESOLVE_VS = `#version 300 es
layout(location=0) in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv * 0.5 + 0.5;
  gl_Position = vec4(aUv, 0.0, 1.0);
}
`;

export const RESOLVE_FS = COMMON + `
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform sampler2D uHistoryColor;
uniform sampler2D uVelocity;
uniform sampler2D uCurrentDepth;
uniform sampler2D uHistoryDepth;
uniform vec2 uTexel;
uniform int uHistoryValid;   // 0 = 全量重开(跳变/缩放/手动)
uniform float uHistoryMix;   // 基准历史权重,默认 15/16
uniform float uSpeedReject;  // 速度(像素/帧)达到该值时权重压到地板
uniform float uWeightFloor;  // 高速移动时的权重地板
uniform float uDepthEps;     // 深度不一致判定阈值
layout(location=0) out vec4 outResolved;
layout(location=1) out vec4 outDebug;           // r=最终权重 g=显露标记 b=速度归一 a=clamp 量
layout(location=2) out vec4 outGhost;           // |TAA - 单帧|,即"历史对本帧的改动"

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// 邻域 min/max(3x3 + 十字 5 采样),历史颜色向当前帧邻域收缩(方差裁剪)
void neighborhood(vec2 uv, out vec3 lo, out vec3 hi, out vec3 avg) {
  vec3 c[9];
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      c[(y+1)*3 + (x+1)] = texture(uSceneColor, uv + vec2(x, y) * uTexel).rgb;
    }
  }
  lo = c[0]; hi = c[0]; avg = vec3(0.0);
  for (int i = 0; i < 9; i++) { lo = min(lo, c[i]); hi = max(hi, c[i]); avg += c[i]; }
  avg /= 9.0;
  // 十字扩展两档,覆盖亚像素抖动的散布范围
  for (int i = 0; i < 4; i++) {
    vec2 d;
    if (i == 0) d = vec2( 2, 0); else if (i == 1) d = vec2(-2, 0);
    else if (i == 2) d = vec2(0,  2); else d = vec2(0, -2);
    vec3 s = texture(uSceneColor, uv + d * uTexel).rgb;
    lo = min(lo, s); hi = max(hi, s);
  }
}

vec3 clipAABB(vec3 hist, vec3 lo, vec3 hi, out float clampAmt) {
  vec3 center = 0.5 * (lo + hi);
  vec3 radius = 0.5 * (hi - lo);
  vec3 rel = hist - center;
  vec3 unit = max(abs(rel), vec3(1e-5));
  vec3 t = radius / unit;
  float tmax = min(t.x, min(t.y, t.z));
  vec3 clamped = tmax < 1.0 ? center + rel * tmax : hist;
  clampAmt = luma(abs(clamped - hist)) / max(luma(abs(hist)) + 1e-4, 1e-4);
  return clamped;
}

void main() {
  vec3 current = texture(uSceneColor, vUv).rgb;
  vec2 velPx = texture(uVelocity, vUv).xy;
  vec2 reprojUv = vUv - velPx * uTexel;
  float speed = length(velPx);

  // ---- 显露判定:重投影位置落在屏外,或前后深度对不上 ----
  bool offscreen = reprojUv.x < 0.0 || reprojUv.x > 1.0
                || reprojUv.y < 0.0 || reprojUv.y > 1.0;
  float curDepth = texture(uCurrentDepth, vUv).r;
  float histDepth = texture(uHistoryDepth, reprojUv).r;
  bool depthMismatch = abs(curDepth - histDepth) >
                       (uDepthEps + 1e-3 * max(curDepth, histDepth));
  bool disoccluded = uHistoryValid == 0 || offscreen || depthMismatch;

  // ---- 历史权重的四段调制(每一段都能在调试纹理里单独看到原因)----
  float w = uHistoryMix;
  if (disoccluded) {
    w = 0.0;                                  // 1) 刚显露 / 重开:彻底抛开历史
  } else {
    float speedK = clamp(1.0 - speed / uSpeedReject, 0.0, 1.0);
    w = mix(uWeightFloor, uHistoryMix, speedK); // 2) 高速边缘降权
    // 3) 邻域亮度闪烁:当前帧明显偏离邻域均值时再降一档
    vec3 lo, hi, avg;
    neighborhood(vUv, lo, hi, avg);
    float flicker = abs(luma(current) - luma(avg))
                  / max(luma(hi) - luma(lo) + 1e-3, 1e-3);
    w *= clamp(1.0 - 0.6 * flicker, 0.35, 1.0);
  }

  vec3 histRaw = texture(uHistoryColor, reprojUv).rgb;
  vec3 lo, hi, avg;
  neighborhood(vUv, lo, hi, avg);
  float clampAmt = 0.0;
  vec3 hist = clipAABB(histRaw, lo, hi, clampAmt);
  if (disoccluded) hist = current; // 4) 无历史时直接取当前帧

  vec3 resolved = mix(current, hist, w);
  float ghostLum = luma(abs(resolved - current));

  outResolved = vec4(resolved, 1.0);
  outDebug = vec4(w, disoccluded ? 1.0 : 0.0,
                  clamp(speed / uSpeedReject, 0.0, 1.0), clamp(clampAmt, 0.0, 1.0));
  outGhost = vec4(abs(resolved - current), ghostLum);
}
`;

// ---------- 分块统计(每 16x16 一块,CPU 求和得到全图指标)----------
export const STATS_VS = RESOLVE_VS;

export const STATS_FS = COMMON + `
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform sampler2D uResolved;
uniform sampler2D uVelocity;
uniform sampler2D uDebug;
uniform sampler2D uGhost;
uniform vec2 uTexel;       // 全图 texel
uniform vec2 uInvTiles;    // 1 / 统计纹理尺寸
uniform float uEdgeThresh;
layout(location=0) out vec4 outTileA; // r=全图重影亮度和 g=移动边缘重影和 b=权重和 a=像素数
layout(location=1) out vec4 outTileB; // r=静止边缘变化和 g=静止边缘像素数 b=静止平坦区变化和 a=静止像素数
// 移动边缘像素数与移动边缘总数等计数由 CPU 侧从 tileB 之外的
// 专用 tileC 读取(见 renderer 中第三附件)。
layout(location=2) out vec4 outTileC; // r=移动边缘像素数 g=移动像素数(含非边缘) b=显露像素数 a=保留

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  // 本块对应的全图像素范围:vUv 是块中心(低分辨率目标上的片元 UV),
  // 块编号 = floor(vUv * 块数),块在全图中的原点 = 块编号 / 块数。
  vec2 tileCount = 1.0 / uInvTiles;
  vec2 tileId = floor(vUv * tileCount);
  vec2 origin = tileId * uInvTiles;
  vec2 tilePx = max(floor(uInvTiles / uTexel), vec2(1.0));

  float ghostSum = 0.0, edgeGhostSum = 0.0, wSum = 0.0, count = 0.0;
  float staticEdgeDiff = 0.0, staticEdgeCount = 0.0;
  float staticFlatDiff = 0.0, staticCount = 0.0;
  float edgeMotionCount = 0.0, motionCount = 0.0, disocclCount = 0.0;

  for (float yy = 0.0; yy < 16.0; yy++) {
    for (float xx = 0.0; xx < 16.0; xx++) {
      if (xx >= tilePx.x || yy >= tilePx.y) continue;
      vec2 uv = origin + (vec2(xx, yy) + 0.5) * uTexel;
      vec3 cur = texture(uSceneColor, uv).rgb;
      vec3 taa = texture(uResolved, uv).rgb;
      vec2 vel = texture(uVelocity, uv).xy;
      float speed = length(vel);
      vec4 dbg = texture(uDebug, uv);
      float diff = abs(luma(taa) - luma(cur));

      // 边缘:亮度梯度(拉普拉斯近似)
      float l = luma(texture(uSceneColor, uv - vec2(uTexel.x, 0.0)).rgb);
      float r = luma(texture(uSceneColor, uv + vec2(uTexel.x, 0.0)).rgb);
      float u = luma(texture(uSceneColor, uv + vec2(0.0, uTexel.y)).rgb);
      float d = luma(texture(uSceneColor, uv - vec2(0.0, uTexel.y)).rgb);
      float grad = abs(luma(cur) * 4.0 - l - r - u - d);
      bool edge = grad > uEdgeThresh;

      float gh = texture(uGhost, uv).a;
      count += 1.0;
      wSum += dbg.r;
      ghostSum += gh;
      if (speed > 0.5) {
        motionCount += 1.0;
        if (edge) { edgeMotionCount += 1.0; edgeGhostSum += gh; }
      }
      if (dbg.g > 0.5) disocclCount += 1.0;

      if (speed < 0.25) {
        staticCount += 1.0;
        if (edge) { staticEdgeDiff += diff; staticEdgeCount += 1.0; }
        else { staticFlatDiff += diff; }
      }
    }
  }
  outTileA = vec4(ghostSum, edgeGhostSum, wSum, count);
  outTileB = vec4(staticEdgeDiff, staticEdgeCount, staticFlatDiff, staticCount);
  outTileC = vec4(edgeMotionCount, motionCount, disocclCount, 0.0);
}
`;

// ---------- 显示 ----------
export const DISPLAY_VS = RESOLVE_VS;

export const DISPLAY_FS = COMMON + `
in vec2 vUv;
uniform sampler2D uSceneColor;
uniform sampler2D uResolved;
uniform sampler2D uDebug;
uniform sampler2D uGhost;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
uniform int uMode;   // 0 单帧 1 TAA 2 分屏 3 区域掩膜 4 调试通道
uniform int uDebugChannel; // 0 权重 1 显露 2 速度 3 clamp 4 重影热力
uniform float uSplitX;
layout(location=0) out vec4 outColor;

float lumaLocal(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 heat(float v) {
  // 蓝 -> 青 -> 黄 -> 红 的单极性热力
  v = clamp(v, 0.0, 1.0);
  return vec3(smoothstep(0.3, 0.9, v),
              smoothstep(0.1, 0.6, v) * (1.0 - smoothstep(0.75, 1.0, v)) + 0.25 * v,
              (1.0 - smoothstep(0.0, 0.35, v)) * 0.8);
}

void main() {
  vec3 cur = texture(uSceneColor, vUv).rgb;
  vec3 taa = texture(uResolved, vUv).rgb;
  vec3 col;

  if (uMode == 0) {
    col = cur;
  } else if (uMode == 1) {
    col = taa;
  } else if (uMode == 2) {
    col = vUv.x < uSplitX ? cur : taa;
  } else if (uMode == 3) {
    // 区域掩膜:移动边缘橙、静止细线蓝,底色压暗
    vec2 vel = texture(uVelocity, vUv).xy;
    float speed = length(vel);
    float lc = lumaLocal(cur);
    float grad = abs(lc * 4.0
      - lumaLocal(texture(uSceneColor, vUv - vec2(uTexel.x, 0.0)).rgb)
      - lumaLocal(texture(uSceneColor, vUv + vec2(uTexel.x, 0.0)).rgb)
      - lumaLocal(texture(uSceneColor, vUv + vec2(0.0, uTexel.y)).rgb)
      - lumaLocal(texture(uSceneColor, vUv - vec2(0.0, uTexel.y)).rgb));
    vec3 base = cur * 0.55;
    vec3 orange = vec3(0.85, 0.35, 0.15);
    vec3 blue = vec3(0.22, 0.53, 0.9);
    col = base;
    // 梯度阈值与 stats pass 的 uEdgeThresh(0.08)对齐
    if (grad > 0.08 && speed > 0.5) col = mix(col, orange, 0.8);
    if (grad > 0.08 && speed < 0.25) col = mix(col, blue, 0.8);
  } else {
    vec4 dbg = texture(uDebug, vUv);
    if (uDebugChannel == 0) col = vec3(dbg.r);
    else if (uDebugChannel == 1) col = vec3(dbg.g);
    else if (uDebugChannel == 2) {
      vec2 vel = texture(uVelocity, vUv).xy;
      col = vec3(vel.x * 0.25 + 0.5, vel.y * 0.25 + 0.5, 0.5);
    } else if (uDebugChannel == 3) col = vec3(dbg.a);
    else col = heat(texture(uGhost, vUv).a * 2.5);
  }
  // 简单 gamma
  col = pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
