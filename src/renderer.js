// WebGL 抠像渲染管线（WebGL1，零依赖）
// pass 1 色度键 → pass 2 局部遮罩 → pass 3 时间域稳定（前后帧 alpha 混合，抑制运动闪烁）
// → pass 4 合成（原始 / 透明棋盘 / 替换背景），同时支持离屏渲染供逐帧导出
import { clamp, hexToRgb01 } from "./utils.js";

const VERT = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// pass 1：色度键
const KEY_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec3 uKey;
uniform float uSimilarity;   // 0..1
uniform float uSoftness;     // 0..1
uniform float uSpill;        // 0..1
uniform float uShadow;       // 0..1
uniform float uEdge;         // 1.0 / 输出宽度，用于边缘清理

float keyDist(vec3 c) {
  // 主距离：相对主色的“主导通道优势”，对光照变化更鲁棒
  float dom = max(0.0, c.g - max(c.r, c.b));
  float keyDom = max(0.0, uKey.g - max(uKey.r, uKey.b));
  float dDom = abs(dom - keyDom);
  // 辅距离：RGB 欧氏距离，处理色相偏移
  float dRgb = length(c - uKey) * 0.55;
  return max(dDom, dRgb);
}

void main() {
  vec3 c = texture2D(uSrc, vUv).rgb;
  float d = keyDist(c);

  float lo = uSimilarity;
  float hi = clamp(uSimilarity + uSoftness * 0.85 + 0.02, 0.0, 1.0);
  float a = clamp((d - lo) / max(hi - lo, 0.001), 0.0, 1.0);
  a = a * a * (3.0 - 2.0 * a); // smoothstep，过渡更顺

  // 暗部保护：深色像素（黑发等）即使色相偏绿也保留
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float gate = mix(0.02, 0.32, uShadow);
  float darkKeep = 1.0 - smoothstep(gate, gate + 0.18, luma);
  a = mix(a, 1.0, darkKeep * uShadow);

  // 溢色修正：边缘像素把超出红/蓝均值的绿通道压回去
  float rbAvg = (c.r + c.b) * 0.5;
  float greenExcess = max(0.0, c.g - rbAvg);
  float edgeWeight = (1.0 - a) * uSpill;
  vec3 col = c;
  col.g = c.g - greenExcess * edgeWeight * 0.9;
  // 轻微向中性色回拉，处理边缘整体偏绿
  float tint = (c.g - rbAvg) * 0.5 * edgeWeight;
  col.r = c.r + tint * 0.35;
  col.b = c.b + tint * 0.35;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), a);
}`;

// pass 2：局部遮罩（mask.r = 保留强度，mask.g = 移除强度）
const MASK_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uColor;
uniform sampler2D uMask;
void main() {
  vec4 c = texture2D(uColor, vUv);
  vec3 m = texture2D(uMask, vUv).rgb;
  float a = c.a;
  a = mix(a, 1.0, m.r);
  a = mix(a, 0.0, m.g);
  gl_FragColor = vec4(c.rgb, clamp(a, 0.0, 1.0));
}`;

// pass 3：时间域稳定，ping-pong 混合历史帧
const TEMPORAL_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uHistory;
uniform float uBlend;   // 历史权重 0..0.95
uniform float uReset;   // 1 = 直接采用当前帧（跳帧/切时间段时）
void main() {
  vec4 cur = texture2D(uCur, vUv);
  vec4 his = texture2D(uHistory, vUv);
  vec4 out4 = mix(cur, his, uReset > 0.5 ? 0.0 : uBlend);
  gl_FragColor = out4;
}`;

// pass 4：合成到屏幕/导出目标
const COMPOSITE_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFg;
uniform sampler2D uBg;
uniform int uMode;         // 0 原始 1 棋盘 2 背景
uniform int uHasBg;
uniform int uFit;          // 0 cover 1 contain 2 stretch
uniform int uOpaque;       // 1=上屏输出不透明；0=导出 FBO 保留 straight alpha
uniform vec2 uFgSize;
uniform vec2 uBgSize;

vec3 checker(vec2 uv) {
  vec2 g = floor(uv * uFgSize / 14.0);
  float f = mod(g.x + g.y, 2.0);
  return mix(vec3(0.72), vec3(0.42), f);
}

// cover/contain 下把前景 uv 映射到背景 uv
vec2 mapBgUv(vec2 uv) {
  if (uFit == 2) return uv;
  float fgAspect = uFgSize.x / uFgSize.y;
  float bgAspect = uBgSize.x / uBgSize.y;
  vec2 s = vec2(1.0);
  if (uFit == 0) { // cover：背景放大覆盖
    s = bgAspect > fgAspect ? vec2(1.0, fgAspect / bgAspect)
                            : vec2(bgAspect / fgAspect, 1.0);
  } else {         // contain：背景完整显示
    s = bgAspect > fgAspect ? vec2(bgAspect / fgAspect, 1.0)
                            : vec2(1.0, fgAspect / bgAspect);
  }
  vec2 mapped = (uv - 0.5) * s + 0.5;
  return clamp(mapped, vec2(0.0), vec2(1.0));
}

void main() {
  vec4 fg = texture2D(uFg, vUv);
  if (uMode == 0) {
    gl_FragColor = texture2D(uBg, vUv); // 原始背景模式下 uBg 绑定源纹理
    return;
  }
  vec3 base;
  if (uMode == 1 || uHasBg == 0) {
    base = checker(vUv);
  } else {
    base = texture2D(uBg, mapBgUv(vUv)).rgb;
  }
  vec3 rgb = mix(base, fg.rgb, fg.a);
  // 上屏时整个画面不透明，避免透明画布让深色页面背景透进来压暗替换背景；
  // 导出到 FBO 时保留前景自身 alpha（PNG/透明视频需要）
  float outA = uOpaque > 0 ? 1.0 : fg.a;
  gl_FragColor = vec4(rgb, outA);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error("Shader 编译失败: " + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("Program 链接失败: " + gl.getProgramInfoLog(p));
  }
  const loc = (n) => gl.getUniformLocation(p, n);
  return {
    prog: p,
    u: {
      aPos: gl.getAttribLocation(p, "aPos"),
      aUv: gl.getAttribLocation(p, "aUv"),
      samplers: ["uSrc", "uColor", "uCur", "uHistory", "uFg", "uMask", "uBg"]
        .map((n) => ({ n, l: loc(n) }))
        .filter((x) => x.l !== null),
      loc,
    },
  };
}

function makeTexture(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function makeFbo(gl, tex) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return fbo;
}

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // 导出 readPixels / 2D 绘制需要
      antialias: false,
    });
    if (!gl) throw new Error("当前浏览器不支持 WebGL");
    this.gl = gl;
    this.pKey = program(gl, KEY_FRAG);
    this.pMask = program(gl, MASK_FRAG);
    this.pTemp = program(gl, TEMPORAL_FRAG);
    this.pComp = program(gl, COMPOSITE_FRAG);

    // 全屏四边形
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1,
        -1, 1, 0, 1, 1, -1, 1, 0, 1, 1, 1, 1,
      ]),
      gl.STATIC_DRAW
    );
    this.quad = buf;

    this.srcTex = gl.createTexture();
    this.maskTex = gl.createTexture();
    this.bgTex = gl.createTexture();
    [this.srcTex, this.maskTex, this.bgTex].forEach((t) => {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    });
    // 1x1 黑色像素初始化，保证未上传遮罩时采样结果为 (0,0,0) → 不影响 alpha
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));

    this.width = 0;
    this.height = 0;
    this.keyBuf = null;  // pass1 色度键输出 / pass3 临时输出
    this.maskBuf = null; // pass2 遮罩后当前帧
    this.histBuf = null; // 上一帧时间稳定结果（跨帧保留）
    this.fgBuf = null;   // 本帧最终前景
    this.temporalReset = true;
    this._lastTime = -1;
  }

  _bindQuad(p) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.u.aPos);
    gl.vertexAttribPointer(p.u.aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(p.u.aUv);
    gl.vertexAttribPointer(p.u.aUv, 2, gl.FLOAT, false, 16, 8);
  }

  _setSize(w, h) {
    if (this.width === w && this.height === h) return;
    const gl = this.gl;
    this.width = w; this.height = h;
    [this.keyBuf, this.maskBuf, this.histBuf].forEach((p) => {
      if (!p) return;
      gl.deleteTexture(p.tex);
      gl.deleteFramebuffer(p.fbo);
    });
    const mk = () => {
      const tex = makeTexture(gl, w, h);
      return { tex, fbo: makeFbo(gl, tex) };
    };
    this.keyBuf = mk();
    this.maskBuf = mk();
    this.histBuf = mk();
    this.resetTemporal();
  }

  resetTemporal() { this.temporalReset = true; }

  _uploadSource(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  uploadMask(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  _uploadBg(source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  // 跳变检测：时间倒退或大步前进时重置时间稳定，避免拖影
  _checkTimeJump(t) {
    if (this._lastTime < 0) { this._lastTime = t; return; }
    const dt = t - this._lastTime;
    if (dt < -0.05 || dt > 0.12) this.resetTemporal();
    this._lastTime = t;
  }

  /**
   * 渲染一帧
   * @param source 视频/图像元素（前景源）
   * @param bgSource 背景元素（image/video），可为 null
   * @param opts { mode, params, keyColor, temporal, maskCanvas, bgFit, bgSize, time, forceReset }
   * @param target null=上屏，或 { tex, fbo } 离屏
   */
  render(source, bgSource, opts, target = null) {
    const gl = this.gl;
    const w = (source.videoWidth || source.naturalWidth || source.width) | 0;
    const h = (source.videoHeight || source.naturalHeight || source.height) | 0;
    if (!w || !h) return null;
    this._setSize(w, h);
    this._checkTimeJump(opts.time ?? 0);
    if (opts.forceReset) this.resetTemporal();

    this._uploadSource(source);
    if (bgSource) this._uploadBg(bgSource);
    if (opts.maskCanvas) this.uploadMask(opts.maskCanvas);

    const key = hexToRgb01(opts.keyColor);
    const p = opts.params;

    // ---- pass 1 色度键 → keyBuf ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.keyBuf.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.pKey.prog);
    this._bindQuad(this.pKey);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    const uk = this.pKey.u.loc;
    gl.uniform1i(uk("uSrc"), 0);
    gl.uniform3fv(uk("uKey"), key);
    gl.uniform1f(uk("uSimilarity"), p.similarity / 100);
    gl.uniform1f(uk("uSoftness"), p.softness / 100);
    gl.uniform1f(uk("uSpill"), p.spill / 100);
    gl.uniform1f(uk("uShadow"), p.shadow / 100);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ---- pass 2 遮罩 → maskBuf（采样 keyBuf） ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskBuf.fbo);
    gl.useProgram(this.pMask.prog);
    this._bindQuad(this.pMask);
    const um = this.pMask.u.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.keyBuf.tex);
    gl.uniform1i(um("uColor"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(um("uMask"), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // ---- pass 3 时间稳定：当前(maskBuf) + 历史(histBuf) → keyBuf ----
    // 三个缓冲互不相同，不存在“采样与渲染目标同一纹理”的反馈回路
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.keyBuf.fbo);
    gl.useProgram(this.pTemp.prog);
    this._bindQuad(this.pTemp);
    const ut = this.pTemp.u.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.maskBuf.tex);
    gl.uniform1i(ut("uCur"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.histBuf.tex);
    gl.uniform1i(ut("uHistory"), 1);
    gl.uniform1f(ut("uBlend"), clamp(opts.temporal ?? 0, 0, 0.95));
    gl.uniform1f(ut("uReset"), this.temporalReset ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    this.temporalReset = false;

    // 轮转：本帧结果成为下一帧的历史，旧历史缓冲回收为 scratch
    const fg = this.keyBuf;
    this.keyBuf = this.histBuf;
    this.histBuf = fg;
    this.fgBuf = fg;

    // ---- pass 4 合成 ----
    const outFbo = target ? target.fbo : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    if (!target) {
      const cw = gl.canvas.clientWidth, ch = gl.canvas.clientHeight;
      if (gl.canvas.width !== cw || gl.canvas.height !== ch) {
        gl.canvas.width = cw; gl.canvas.height = ch;
      }
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    } else {
      gl.viewport(0, 0, w, h);
    }
    gl.useProgram(this.pComp.prog);
    this._bindQuad(this.pComp);
    const uc = this.pComp.u.loc;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fg.tex);
    gl.uniform1i(uc("uFg"), 0);
    gl.activeTexture(gl.TEXTURE1);
    const mode = opts.mode === "original" ? 0 : opts.mode === "alpha" ? 1 : 2;
    if (mode === 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    } else if (mode === 2 && bgSource) {
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, fg.tex); // 占位
    }
    gl.uniform1i(uc("uBg"), 1);
    gl.uniform1i(uc("uMode"), mode);
    gl.uniform1i(uc("uHasBg"), mode === 2 && bgSource ? 1 : 0);
    // 上屏始终不透明；离屏 FBO 仅在 alpha 导出时保留透明，合成导出也输出不透明
    gl.uniform1i(uc("uOpaque"), target ? (mode === 1 ? 0 : 1) : 1);
    gl.uniform1i(uc("uFit"), opts.bgFit === "contain" ? 1 : opts.bgFit === "stretch" ? 2 : 0);
    gl.uniform2f(uc("uFgSize"), w, h);
    if (bgSource) {
      gl.uniform2f(
        uc("uBgSize"),
        bgSource.videoWidth || bgSource.naturalWidth || w,
        bgSource.videoHeight || bgSource.naturalHeight || h
      );
    } else {
      gl.uniform2f(uc("uBgSize"), w, h);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    return { fgTex: fg.tex, width: w, height: h };
  }

  // 导出用：创建离屏渲染目标
  makeTarget(w, h) {
    const gl = this.gl;
    const tex = makeTexture(gl, w, h);
    const fbo = makeFbo(gl, tex);
    return { tex, fbo, w, h };
  }

  // 导出用：把 FBO 内容（straight alpha）读出并翻转画到 2D canvas
  blitFboToCanvas2D(fbo, w, h, ctx2d, outW, outH) {
    const gl = this.gl;
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const img = new ImageData(pixels, w, h);
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    tmp.getContext("2d").putImageData(img, 0, 0);
    ctx2d.clearRect(0, 0, outW, outH);
    ctx2d.save();
    ctx2d.scale(1, -1);
    ctx2d.drawImage(tmp, 0, 0, outW, -outH);
    ctx2d.restore();
  }

  // 导出用：把当前前景 RGBA（straight alpha）读出并画到 2D canvas（处理 Y 翻转）
  blitFgToCanvas2D(ctx2d, outW, outH) {
    this.blitFboToCanvas2D(this.fgBuf.fbo, this.width, this.height, ctx2d, outW, outH);
  }
}
