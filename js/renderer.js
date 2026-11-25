// WebGL2 渲染器。职责:
//  G-buffer(颜色/速度/深度)-> 历史 ping-pong + TAA resolve ->
//  分块统计 -> 显示。
// 所有"重开"都走 reset(reason) 唯一入口,事件对象带原因码,
// UI 与导出的 JSON 共用同一份事件流。
import {
  GBUF_VS, GBUF_FS, RESOLVE_VS, RESOLVE_FS, STATS_VS, STATS_FS,
  DISPLAY_VS, DISPLAY_FS,
} from './shaders.js';
import {
  createCube, createInstancedCube, createQuad, createFullscreenTriangle,
  uploadInstances,
} from './geometry.js';
import { mat4Multiply, mat4Perspective, mat4Compose } from './math.js';
import { frameJitter } from './prng.js';
import { FIXED_DT } from './clock.js';

export const RESET_REASON = {
  FIRST_FRAME: 'first-frame',
  MANUAL: 'manual-reset',
  CAMERA_JUMP: 'camera-jump',
  LOOP: 'loop-restart',
  SEEK: 'seek-replay',
  RESIZE: 'canvas-resize',
  SEED: 'seed-change',
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    throw new Error(`Shader 编译失败:\n${log}\n--- src ---\n${src}`);
  }
  return sh;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`Program 链接失败: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

function makeTexture(gl, w, h, internal, format, type, filter = gl.NEAREST) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function fboWith(gl, colors, depthTex = null) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  colors.forEach((tex, i) => gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0,
  ));
  if (depthTex) {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0,
    );
  }
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (ok !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`FBO 不完整: 0x${ok.toString(16)}`);
  return fbo;
}

export class Renderer {
  constructor(canvas) {
    this.gl = canvas.getContext('webgl2', {
      antialias: false, // 抗锯齿交给 TAA/程序化 fwidth,避免平台 MSAA 干扰对比
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('需要 WebGL2 支持');
    const gl = this.gl;
    this._float16 = !!gl.getExtension('EXT_color_buffer_half_float');
    this._float32 = !!gl.getExtension('EXT_color_buffer_float');
    if (!this._float16 && !this._float32) {
      throw new Error('需要浮点颜色缓冲扩展(EXT_color_buffer_float/half_float)');
    }
    // 格式选择策略:RGBA16F 优先。它是 TAA 的工业界常规选择(HDR 范围与
    // 精度都够用),且部分驱动(如 SwiftShader)在"MRT+深度+采样"组合下
    // 对 RGBA32F 采样会静默返回 0。只有显式要求高精度且通过组合探测时才用 32F。
    // URL 带 ?float32=1 可强制 32F 用于对比验证。
    const force32 = new URLSearchParams(location.search).get('float32') === '1';
    this._supportsFloat32Sampling = this._float32 ? this._probeFloat32Sampling() : false;
    const use32 = force32 && this._float32 && this._supportsFloat32Sampling;
    if (use32 || !this._float16) {
      // 显式强制 32F,或驱动根本不支持 16F 渲染
      this._colorInternal = gl.RGBA32F;
      this._colorType = gl.FLOAT;
    } else {
      this._colorInternal = gl.RGBA16F;
      this._colorType = gl.HALF_FLOAT;
    }

    this.progG = program(gl, GBUF_VS, GBUF_FS);
    this.progR = program(gl, RESOLVE_VS, RESOLVE_FS);
    this.progS = program(gl, STATS_VS, STATS_FS);
    this.progD = program(gl, DISPLAY_VS, DISPLAY_FS);

    this.cube = createCube(gl);                 // 非实例:遮挡物、漂浮方块
    this.instCube = createInstancedCube(gl, 16); // 实例:栅栏板条
    this.quad = createQuad(gl);
    this.tri = createFullscreenTriangle(gl);

    // TAA 可调参数(UI 暴露)
    this.config = {
      historyMix: 15 / 16,
      speedReject: 8.0,   // px/帧
      weightFloor: 0.25,
      depthEps: 0.004,
      jitterEnabled: true,
    };

    this.events = [];
    this.jitterIndex = 0;
    this._prev = null;      // 上一帧矩阵/场景状态
    this.historyValid = 0;
    this.frame = -1;
    this.lastStats = null;
    this.lastReset = null;
    this._resizeObserver = null;
  }

  // RGBA32F 采样往返探测,刻意复刻真实用法:MRT(3 颜色)+ 深度附件 +
  // LINEAR 采样源。简单单纹理往返在部分驱动上通过,但组合场景仍会失败。
  _probeFloat32Sampling() {
    const gl = this.gl;
    const S = 16;
    const mk = (internal, format, type, filter) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, S, S, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const src = mk(gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.LINEAR);
    const o0 = mk(gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.LINEAR);
    const o1 = mk(gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    const o2 = mk(gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST);
    const depth = mk(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.NEAREST);

    const fboWrite = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboWrite);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
    gl.clearColor(0.7, 0.6, 0.5, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const fboRead = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRead);
    [o0, o1, o2].forEach((t, i) => gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0,
    ));
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this._cleanupProbe(src, o0, o1, o2, depth, fboWrite, fboRead);
      return false;
    }
    const vs = `#version 300 es
layout(location=0) in vec2 a; out vec2 v;
void main(){ v=a*0.5+0.5; gl_Position=vec4(a,0.0,1.0); }`;
    const fs = `#version 300 es
precision highp float;
in vec2 v; uniform sampler2D u;
layout(location=0) out vec4 c0; layout(location=1) out vec4 c1; layout(location=2) out vec4 c2;
void main(){ vec3 s = texture(u, v).rgb; c0=vec4(s,1.0); c1=vec4(1.0,0.0,0.0,1.0); c2=vec4(s*0.5,1.0); }`;
    const compile = (type, s) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, s); gl.compileShader(sh);
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      this._cleanupProbe(src, o0, o1, o2, depth, fboWrite, fboRead, p);
      return false;
    }
    gl.useProgram(p);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform1i(gl.getUniformLocation(p, 'u'), 0);
    gl.viewport(0, 0, S, S);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const buf = new Float32Array(4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.FLOAT, buf);
    const ok = Math.abs(buf[0] - 0.7) < 0.05 && Math.abs(buf[1] - 0.6) < 0.05;
    this._cleanupProbe(src, o0, o1, o2, depth, fboWrite, fboRead, p, vao, vbo);
    return ok;
  }

  _cleanupProbe(...objs) {
    const gl = this.gl;
    for (const o of objs) {
      if (!o) continue;
      if (o instanceof WebGLProgram) gl.deleteProgram(o);
      else if (o instanceof WebGLFramebuffer) gl.deleteFramebuffer(o);
      else if (o instanceof WebGLVertexArrayObject) gl.deleteVertexArray(o);
      else if (o instanceof WebGLBuffer) gl.deleteBuffer(o);
      else gl.deleteTexture(o);
    }
  }

  onEvent(fn) { this._eventFn = fn; }

  _emitReset(reason, frame) {
    const ev = { type: 'reset', reason, frame, t: frame * FIXED_DT };
    this.events.push(ev);
    this.lastReset = ev;
    if (this._eventFn) this._eventFn(ev);
  }

  // ---- 缓冲分配(尺寸变化时整体重建)----
  allocate(w, h) {
    const gl = this.gl;
    this.w = w; this.h = h;
    this.texel = [1 / w, 1 / h];

    const C = (filter) => makeTexture(
      gl, w, h, this._colorInternal, gl.RGBA, this._colorType, filter,
    );
    // G-buffer
    this.sceneTex = C(gl.LINEAR);
    this.velocityTex = C(gl.NEAREST);
    this.gDepthTex = makeTexture(gl, w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT);
    this.gFbo = fboWith(gl, [this.sceneTex, this.velocityTex], this.gDepthTex);

    // 历史 ping-pong:每对含 颜色/调试/重影 + 深度
    this.pairs = [0, 1].map(() => ({
      color: C(gl.LINEAR),
      debug: C(gl.NEAREST),
      ghost: C(gl.NEAREST),
      depth: makeTexture(gl, w, h, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT),
      fbo: null,
    }));
    this.pairs[0].fbo = fboWith(
      gl, [this.pairs[0].color, this.pairs[0].debug, this.pairs[0].ghost], this.pairs[0].depth,
    );
    this.pairs[1].fbo = fboWith(
      gl, [this.pairs[1].color, this.pairs[1].debug, this.pairs[1].ghost], this.pairs[1].depth,
    );
    this.srcPair = 0;

    // 分块统计纹理(16x16 像素一块):与颜色纹理同格式,规避驱动 32F 采样缺陷
    this.tw = Math.max(1, Math.ceil(w / 16));
    this.th = Math.max(1, Math.ceil(h / 16));
    this.tileA = makeTexture(gl, this.tw, this.th, this._colorInternal, gl.RGBA, this._colorType);
    this.tileB = makeTexture(gl, this.tw, this.th, this._colorInternal, gl.RGBA, this._colorType);
    this.tileC = makeTexture(gl, this.tw, this.th, this._colorInternal, gl.RGBA, this._colorType);
    this.statsFbo = fboWith(gl, [this.tileA, this.tileB, this.tileC]);
  }

  // ---- 统一重开入口 ----
  reset(reason) {
    this.jitterIndex = 0;
    this.historyValid = 0;
    this._prev = null;
    this.frame = -1;
    this._emitReset(reason, this.currentFrame ?? 0);
  }

  attachResize(canvas, reasonFn) {
    // 记录当前已分配尺寸;首次回调若只是从 0 布局变成实际尺寸而与已分配
    // 尺寸一致,不算缩放,避免启动时凭空产生一次 canvas-resize 重开。
    let allocatedW = canvas.width;
    let allocatedH = canvas.height;
    this._resizeObserver = new ResizeObserver(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(64, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(64, Math.round(canvas.clientHeight * dpr));
      if (w === allocatedW && h === allocatedH) return;
      allocatedW = w; allocatedH = h;
      canvas.width = w; canvas.height = h;
      this.allocate(w, h);
      this.reset(RESET_REASON.RESIZE);
      if (reasonFn) reasonFn(w, h);
    });
    this._resizeObserver.observe(canvas);
  }

  _uniforms(p, names) {
    const gl = this.gl;
    const u = {};
    for (const n of names) u[n] = gl.getUniformLocation(p, n);
    return u;
  }

  _viewProj(jitter) {
    const gl = this.gl;
    const aspect = this.w / this.h;
    const jx = jitter.x * this.texel[0] * (this.config.jitterEnabled ? 1 : 0);
    const jy = jitter.y * this.texel[1] * (this.config.jitterEnabled ? 1 : 0);
    const proj = mat4Perspective(
      Math.PI / 4, aspect, 0.1, 20, jx, jy,
    );
    return mat4Multiply(proj, this._state.camera.view);
  }

  // state = scene.evaluate(frame);prevState = 上一帧 evaluate 结果(首帧/重开后为 null)
  renderFrame(state, prevState, frameInfo) {
    const gl = this.gl;
    this.currentFrame = state.frame;

    // 相机瞬移由场景判定,触发全量重开
    if (state.camera.jump && this.frame !== state.frame) {
      this.jitterIndex = 0;
      this.historyValid = 0;
      this._emitReset(RESET_REASON.CAMERA_JUMP, state.frame);
    }
    if (frameInfo && frameInfo.wrapped) {
      this.jitterIndex = 0;
      this.historyValid = 0;
      this._emitReset(RESET_REASON.LOOP, state.frame);
    }

    const jitter = frameJitter(this.jitterIndex);
    this._state = state;
    const vp = this._viewProj(jitter);
    // 前一帧 VP:用前一帧的抖动序号与相机
    let prevVp;
    if (prevState && this.historyValid) {
      const prevJitter = frameJitter(Math.max(0, this.jitterIndex - 1));
      const aspect = this.w / this.h;
      const pjx = prevJitter.x * this.texel[0] * (this.config.jitterEnabled ? 1 : 0);
      const pjy = prevJitter.y * this.texel[1] * (this.config.jitterEnabled ? 1 : 0);
      const pProj = mat4Perspective(Math.PI / 4, aspect, 0.1, 20, pjx, pjy);
      prevVp = mat4Multiply(pProj, prevState.camera.view);
    } else {
      prevVp = vp; // 无历史时速度为 0
    }

    this._gbufferPass(state, prevState, vp, prevVp);

    // 深度 blit:当前深度进入"新历史"深度纹理
    const dst = this.pairs[1 - this.srcPair];
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.gFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst.fbo);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h,
      gl.DEPTH_BUFFER_BIT, gl.NEAREST);

    this._resolvePass(dst);
    this._statsPass(dst);

    // 历史翻转
    this.srcPair = 1 - this.srcPair;
    this.jitterIndex += 1;
    this.historyValid = 1;
    this.frame = state.frame;

    return {
      jitter,
      jitterIndex: this.jitterIndex,
      historyValid: this.historyValid,
      srcPair: this.srcPair,
      stats: this.lastStats,
    };
  }

  _gbufferPass(state, prevState, vp, prevVp) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.06, 0.06, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const p = this.progG;
    gl.useProgram(p);
    const u = this._uniforms(p, [
      'uModel', 'uPrevModel', 'uViewProj', 'uPrevViewProj', 'uInstanced',
      'uColor', 'uIsWall', 'uWallHalf', 'uResolution',
    ]);
    gl.uniformMatrix4fv(u.uViewProj, false, vp);
    gl.uniformMatrix4fv(u.uPrevViewProj, false, prevVp);
    gl.uniform2f(u.uResolution, this.w, this.h);

    const ps = prevState || state;
    // 墙:单位四边形 * (halfW, halfH, 1) 后平移到 z 平面
    const wallDef = this._sceneDefs.wall;
    const wallModel = mat4Compose([0, 0, wallDef.z], 0, [wallDef.halfW, wallDef.halfH, 1]);
    gl.bindVertexArray(this.quad.vao);
    gl.uniformMatrix4fv(u.uModel, false, wallModel);
    gl.uniformMatrix4fv(u.uPrevModel, false, wallModel); // 墙静止:前后帧矩阵相同
    gl.uniform1i(u.uInstanced, 0);
    gl.uniform1i(u.uIsWall, 1);
    gl.uniform2f(u.uWallHalf, wallDef.halfW, wallDef.halfH);
    gl.uniform3f(u.uColor, 0.72, 0.7, 0.66);
    gl.drawArrays(gl.TRIANGLES, 0, this.quad.vertexCount);
    gl.uniform1i(u.uIsWall, 0);

    // 栅栏(实例化)
    gl.bindVertexArray(this.instCube.vao);
    for (const key of ['fenceA', 'fenceB']) {
      const def = this._sceneDefs[key];
      const n = def.slats.length;
      const mats = def.slats.map((s) => {
        const local = mat4FromOffsetScale(s.offset, s.scale);
        return mat4Multiply(state.models[key], local);
      });
      const prevMats = def.slats.map((s) => {
        const local = mat4FromOffsetScale(s.offset, s.scale);
        return mat4Multiply(ps.models[key], local);
      });
      uploadInstances(gl, this.instCube, mats, prevMats);
      gl.uniformMatrix4fv(u.uModel, false, IDENTITY);
      gl.uniformMatrix4fv(u.uPrevModel, false, IDENTITY);
      gl.uniform1i(u.uInstanced, 1);
      gl.uniform3fv(u.uColor, def.color);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.cube.vertexCount, n);
    }

    // 遮挡物 / 漂浮方块(非实例)
    gl.uniform1i(u.uInstanced, 0);
    for (const key of ['occluder', 'floatBox']) {
      const def = this._sceneDefs[key];
      gl.uniformMatrix4fv(u.uModel, false, state.models[key]);
      gl.uniformMatrix4fv(u.uPrevModel, false, ps.models[key]);
      gl.uniform3fv(u.uColor, def.color);
      gl.drawArrays(gl.TRIANGLES, 0, this.cube.vertexCount);
    }
    gl.bindVertexArray(null);
  }

  _resolvePass(dst) {
    const gl = this.gl;
    const src = this.pairs[this.srcPair];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, this.w, this.h);

    const p = this.progR;
    gl.useProgram(p);
    const u = this._uniforms(p, [
      'uSceneColor', 'uHistoryColor', 'uVelocity', 'uCurrentDepth', 'uHistoryDepth',
      'uTexel', 'uHistoryValid', 'uHistoryMix', 'uSpeedReject', 'uWeightFloor', 'uDepthEps',
    ]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.uniform1i(u.uSceneColor, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.color);
    gl.uniform1i(u.uHistoryColor, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.velocityTex);
    gl.uniform1i(u.uVelocity, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.gDepthTex);
    gl.uniform1i(u.uCurrentDepth, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, src.depth);
    gl.uniform1i(u.uHistoryDepth, 4);
    gl.uniform2f(u.uTexel, ...this.texel);
    gl.uniform1i(u.uHistoryValid, this.historyValid);
    gl.uniform1f(u.uHistoryMix, this.config.historyMix);
    gl.uniform1f(u.uSpeedReject, this.config.speedReject);
    gl.uniform1f(u.uWeightFloor, this.config.weightFloor);
    gl.uniform1f(u.uDepthEps, this.config.depthEps);

    gl.bindVertexArray(this.tri.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _statsPass(dst) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, this.tw, this.th);

    const p = this.progS;
    gl.useProgram(p);
    const u = this._uniforms(p, [
      'uSceneColor', 'uResolved', 'uVelocity', 'uDebug', 'uGhost',
      'uTexel', 'uInvTiles', 'uEdgeThresh',
    ]);
    const bind = (slot, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, slot);
    };
    bind(0, this.sceneTex, u.uSceneColor);
    bind(1, dst.color, u.uResolved);
    bind(2, this.velocityTex, u.uVelocity);
    bind(3, dst.debug, u.uDebug);
    bind(4, dst.ghost, u.uGhost);
    gl.uniform2f(u.uTexel, ...this.texel);
    gl.uniform2f(u.uInvTiles, 1 / this.tw, 1 / this.th);
    gl.uniform1f(u.uEdgeThresh, 0.08);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.statsFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.bindVertexArray(this.tri.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    // CPU 求和
    const n = this.tw * this.th;
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.tw, this.th, gl.RGBA, gl.FLOAT, a);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, this.tw, this.th, gl.RGBA, gl.FLOAT, b);
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(0, 0, this.tw, this.th, gl.RGBA, gl.FLOAT, c);
    let ghostSum = 0, edgeGhostSum = 0, wSum = 0, count = 0;
    let seDiff = 0, seCount = 0, sfDiff = 0, sCount = 0;
    let edgeMotion = 0, motion = 0, disoccl = 0;
    for (let i = 0; i < n; i++) {
      ghostSum += a[i * 4]; edgeGhostSum += a[i * 4 + 1];
      wSum += a[i * 4 + 2]; count += a[i * 4 + 3];
      seDiff += b[i * 4]; seCount += b[i * 4 + 1];
      sfDiff += b[i * 4 + 2]; sCount += b[i * 4 + 3];
      edgeMotion += c[i * 4]; motion += c[i * 4 + 1]; disoccl += c[i * 4 + 2];
    }
    this.lastStats = {
      frame: this.currentFrame,
      ghost: count ? ghostSum / count : 0,          // 全图平均重影亮度
      edgeGhost: edgeMotion ? edgeGhostSum / edgeMotion : 0, // 移动边缘上的平均重影
      movingEdgePx: edgeMotion,
      movingPx: motion,
      disoccludedPx: disoccl,
      meanWeight: count ? wSum / count : 0,
      staticEdgeDelta: seCount ? seDiff / seCount : 0, // 静止细线:历史对边缘的改动
      staticFlatDelta: sCount ? sfDiff / sCount : 0,
      staticEdgePx: seCount,
      staticPx: sCount,
    };
  }

  // 显示到默认帧缓冲;mode 见 shaders.DISPLAY_FS
  display(mode, debugChannel = 0, splitX = 0.5) {
    const gl = this.gl;
    const src = this.pairs[this.srcPair];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.DEPTH_TEST);

    const p = this.progD;
    gl.useProgram(p);
    const u = this._uniforms(p, [
      'uSceneColor', 'uResolved', 'uDebug', 'uGhost', 'uVelocity', 'uTexel',
      'uMode', 'uDebugChannel', 'uSplitX',
    ]);
    const bind = (slot, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, slot);
    };
    bind(0, this.sceneTex, u.uSceneColor);
    bind(1, src.color, u.uResolved);
    bind(2, src.debug, u.uDebug);
    bind(3, src.ghost, u.uGhost);
    bind(4, this.velocityTex, u.uVelocity);
    gl.uniform2f(u.uTexel, ...this.texel);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1i(u.uDebugChannel, debugChannel);
    gl.uniform1f(u.uSplitX, splitX);
    gl.bindVertexArray(this.tri.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // 供探针/导出读取任意纹理的单个或整块像素
  readTexture(which, x, y, w = 1, h = 1) {
    const gl = this.gl;
    const src = this.pairs[this.srcPair];
    const map = {
      scene: this.sceneTex,
      resolved: src.color,
      debug: src.debug,
      ghost: src.ghost,
      velocity: this.velocityTex,
    };
    const tex = map[which];
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const out = new Float32Array(w * h * 4);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    gl.deleteFramebuffer(fbo);
    return out;
  }

  setSceneDefs(defs) { this._sceneDefs = defs; }

  // 导出用:离屏读回显示结果(避免 preserveDrawingBuffer 依赖)
  readDisplay(mode, debugChannel, splitX) {
    // 先把显示结果渲染到一块离屏纹理再读回
    const gl = this.gl;
    if (!this._displayTex || this._displayW !== this.w) {
      this._displayW = this.w;
      this._displayTex = makeTexture(
        gl, this.w, this.h, this._colorInternal, gl.RGBA, this._colorType, gl.NEAREST,
      );
      this._displayFbo = fboWith(gl, [this._displayTex]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._displayFbo);
    gl.viewport(0, 0, this.w, this.h);
    const p = this.progD;
    gl.useProgram(p);
    const u = this._uniforms(p, [
      'uSceneColor', 'uResolved', 'uDebug', 'uGhost', 'uVelocity', 'uTexel',
      'uMode', 'uDebugChannel', 'uSplitX',
    ]);
    const src = this.pairs[this.srcPair];
    const bind = (slot, tex, loc) => {
      gl.activeTexture(gl.TEXTURE0 + slot);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc, slot);
    };
    bind(0, this.sceneTex, u.uSceneColor);
    bind(1, src.color, u.uResolved);
    bind(2, src.debug, u.uDebug);
    bind(3, src.ghost, u.uGhost);
    bind(4, this.velocityTex, u.uVelocity);
    gl.uniform2f(u.uTexel, ...this.texel);
    gl.uniform1i(u.uMode, mode);
    gl.uniform1i(u.uDebugChannel, debugChannel);
    gl.uniform1f(u.uSplitX, splitX);
    gl.bindVertexArray(this.tri.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    const out = new Float32Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, out);
    return out;
  }
}

const IDENTITY = new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

function mat4FromOffsetScale(offset, scale) {
  // 板条局部矩阵:平移 * 缩放(与 math.mat4Compose 同布局,零旋转)
  const m = new Float32Array(16);
  m[0] = scale[0]; m[5] = scale[1]; m[10] = scale[2]; m[15] = 1;
  m[12] = offset[0]; m[13] = offset[1]; m[14] = offset[2];
  return m;
}
