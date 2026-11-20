import type {
  CompileResult,
  PreviewMode,
  UniformMeta,
  UniformValue,
} from '../types';
import {
  BUILTIN_UNIFORMS,
  FRAG_PREFIX,
  FRAG_PREFIX_LINES,
  FULLSCREEN_VERT,
  MESH_VERT,
  POST_FRAG_PREFIX,
  POST_FRAG_PREFIX_LINES,
  POST_VERT,
} from './shaders';
import { compileShader, linkProgram, parseShaderLog } from './glUtils';
import { reconcileUniforms, parseUniforms } from './uniforms';
import { createGridGeometry } from './geometry';
import { uploadDataUrl } from './textures';
import {
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4RotateX,
  mat4RotateY,
  type Mat4,
} from './mat4';

interface ProgramBundle {
  program: WebGLProgram;
  uniforms: UniformMeta[];
  /** name -> uniform location（含内置项；未使用的 uniform 可能为 null） */
  locations: Map<string, WebGLUniformLocation | null>;
}

const BUILTIN_LOCATION_NAMES = ['uTime', 'uResolution', 'uMVP', 'uModel', 'uScene'];

const ATTR_POSITION = 0;
const ATTR_NORMAL = 1;
const ATTR_UV = 2;

/** 全屏三角形：单个大三角形覆盖整个裁剪空间 */
const FULLSCREEN_TRI = new Float32Array([-1, -1, 3, -1, -1, 3]);

export class RenderEngine {
  readonly gl: WebGLRenderingContext;
  private canvas: HTMLCanvasElement;

  private main: ProgramBundle | null = null;
  private post: ProgramBundle | null = null;
  private hasMainFailed = false;

  private width = 1;
  private height = 1;
  private fbo: WebGLFramebuffer | null = null;
  private sceneTexture: WebGLTexture | null = null;
  private depthBuffer: WebGLRenderbuffer | null = null;

  private fallbackTexture: WebGLTexture;
  /** dataURL -> GL 纹理对象的缓存 */
  private textureCache = new Map<string, WebGLTexture>();

  // 几何缓冲
  private triBuffer: WebGLBuffer;
  private meshPos: WebGLBuffer;
  private meshNormal: WebGLBuffer;
  private meshUv: WebGLBuffer;
  private meshIndex: WebGLBuffer;
  private meshIndexCount: number;

  // 网格相机常量
  private proj: Mat4 = mat4Identity();
  private view: Mat4 = mat4Identity();
  private model: Mat4 = mat4Identity();
  private mvp: Mat4 = mat4Identity();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', {
      preserveDrawingBuffer: true, // 编译失败 / 暂停时保留上一帧；导出 PNG 也需要
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!gl) {
      throw new Error('当前浏览器不支持 WebGL，请更换现代浏览器后重试。');
    }
    this.gl = gl;

    this.triBuffer = this.makeArrayBuffer(FULLSCREEN_TRI);
    const geo = createGridGeometry(32, 2);
    this.meshPos = this.makeArrayBuffer(geo.positions);
    this.meshNormal = this.makeArrayBuffer(geo.normals);
    this.meshUv = this.makeArrayBuffer(geo.uvs);
    this.meshIndex = this.makeIndexBuffer(geo.indices);
    this.meshIndexCount = geo.indices.length;

    this.fallbackTexture = this.makeFallbackTexture();
    this.view = mat4LookAt([0, 1.15, 3.1], [0, 0, 0], [0, 1, 0]);
  }

  private makeArrayBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  private makeIndexBuffer(data: Uint16Array): WebGLBuffer {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buf;
  }

  private makeFallbackTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([180, 180, 190, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  /** 编译主着色器和（可选的）后处理着色器；失败时保留旧程序，画布不闪 */
  compile(mainSource: string, postSource: string, prevValues: Record<string, UniformValue>): CompileResult {
    const gl = this.gl;

    // 1. 主着色器
    const mainFragSrc = FRAG_PREFIX + mainSource;
    const fragResult = compileShader(gl, gl.FRAGMENT_SHADER, mainFragSrc);
    if (!fragResult.shader) {
      this.hasMainFailed = true;
      return {
        ok: false,
        diagnostics: parseShaderLog(fragResult.log, FRAG_PREFIX_LINES),
        uniforms: this.main?.uniforms ?? [],
      };
    }
    const vertResult = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VERT);
    const meshVertResult = compileShader(gl, gl.VERTEX_SHADER, MESH_VERT);
    if (!vertResult.shader || !meshVertResult.shader) {
      this.hasMainFailed = true;
      const log = vertResult.log || meshVertResult.log;
      gl.deleteShader(fragResult.shader);
      if (vertResult.shader) gl.deleteShader(vertResult.shader);
      if (meshVertResult.shader) gl.deleteShader(meshVertResult.shader);
      return {
        ok: false,
        diagnostics: parseShaderLog(log, 0),
        uniforms: this.main?.uniforms ?? [],
      };
    }

    const bindAttrs = (program: WebGLProgram) => {
      gl.bindAttribLocation(program, ATTR_POSITION, 'aPosition');
      gl.bindAttribLocation(program, ATTR_NORMAL, 'aNormal');
      gl.bindAttribLocation(program, ATTR_UV, 'aUv');
    };
    // 同一份 fragment 分别与全屏 / 网格 vertex 链接
    const fullLink = linkProgram(gl, [vertResult.shader, fragResult.shader], bindAttrs);
    const meshLink = linkProgram(gl, [meshVertResult.shader, fragResult.shader], bindAttrs);
    // 链接完成后着色器对象不再单独需要，显式释放（program 仍持有自己的编译副本）
    gl.deleteShader(vertResult.shader);
    gl.deleteShader(meshVertResult.shader);
    gl.deleteShader(fragResult.shader);
    if (!fullLink.program || !meshLink.program) {
      this.hasMainFailed = true;
      gl.deleteShader(vertResult.shader);
      gl.deleteShader(meshVertResult.shader);
      gl.deleteShader(fragResult.shader);
      return {
        ok: false,
        diagnostics: parseShaderLog(fullLink.log || meshLink.log, 0),
        uniforms: this.main?.uniforms ?? [],
      };
    }

    const metas = parseUniforms(mainSource);
    const values = reconcileUniforms(metas, prevValues);

    // 全部成功后才替换旧程序 —— 失败路径上 this.main 完全不动
    this.disposeProgram(this.main);
    this.main = {
      program: fullLink.program,
      uniforms: metas,
      locations: this.collectLocations(fullLink.program, metas),
    };
    this.meshProgram = meshLink.program;
    this.hasMainFailed = false;

    // 2. 后处理着色器（可选）。compilePost 会把 post 专属 uniform 的默认值合并进 values
    this.disposeProgram(this.post);
    this.post = null;
    const postDiagnostics = this.compilePost(postSource, values);

    return {
      ok: postDiagnostics.length === 0,
      diagnostics: postDiagnostics,
      uniforms: this.postUniforms.length > 0 ? this.postUniforms : metas,
      // 返回新对象，避免与调用方持有的旧表共享引用
      values: { ...values },
    };
  }

  private meshProgram: WebGLProgram | null = null;

  private compilePost(
    postSource: string,
    values: Record<string, UniformValue>,
  ): CompileResult['diagnostics'] {
    if (!postSource.trim()) return [];
    const gl = this.gl;
    const src = POST_FRAG_PREFIX + postSource;
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, src);
    if (!frag.shader) {
      return parseShaderLog(frag.log, POST_FRAG_PREFIX_LINES);
    }
    const vert = compileShader(gl, gl.VERTEX_SHADER, POST_VERT);
    if (!vert.shader) return parseShaderLog(vert.log, 0);
    const linked = linkProgram(gl, [vert.shader, frag.shader], (program) => {
      gl.bindAttribLocation(program, ATTR_POSITION, 'aPosition');
      gl.bindAttribLocation(program, ATTR_NORMAL, 'aNormal');
      gl.bindAttribLocation(program, ATTR_UV, 'aUv');
    });
    gl.deleteShader(vert.shader);
    gl.deleteShader(frag.shader);
    if (!linked.program) return parseShaderLog(linked.log, 0);

    // 后处理可访问主着色器里同名的 uniform
    const metas = this.main?.uniforms ?? [];
    const postMetas = parseUniforms(postSource);
    const merged = new Map<string, UniformMeta>();
    for (const m of metas) merged.set(m.name, m);
    for (const m of postMetas) if (!merged.has(m.name)) merged.set(m.name, m);
    const allMetas = [...merged.values()];
    this.post = {
      program: linked.program,
      uniforms: allMetas,
      locations: this.collectLocations(linked.program, allMetas),
    };
    // 后处理新引入的 uniform 就地补默认值 / 保留旧值
    const reconciled = reconcileUniforms(allMetas, values);
    for (const [name, v] of Object.entries(reconciled)) values[name] = v;
    return [];
  }

  private collectLocations(
    program: WebGLProgram,
    metas: UniformMeta[],
  ): Map<string, WebGLUniformLocation | null> {
    const gl = this.gl;
    const map = new Map<string, WebGLUniformLocation | null>();
    for (const meta of metas) {
      map.set(meta.name, gl.getUniformLocation(program, meta.name));
    }
    // 内置 uniform 一并缓存，渲染热路径不再查询
    for (const name of BUILTIN_LOCATION_NAMES) {
      if (!map.has(name)) map.set(name, gl.getUniformLocation(program, name));
    }
    return map;
  }

  /** 当前主程序暴露的 uniform 元数据（编译失败时返回上一次的） */
  get activeUniforms(): UniformMeta[] {
    return this.main?.uniforms ?? [];
  }

  /** 后处理程序可见的全部 uniform（含主程序同名项） */
  get postUniforms(): UniformMeta[] {
    return this.post?.uniforms ?? [];
  }

  get isInErrorState(): boolean {
    return this.hasMainFailed;
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.proj = mat4Perspective(
      Math.PI / 4,
      this.width / this.height,
      0.1,
      100,
    );
    this.rebuildFramebuffer();
  }

  private rebuildFramebuffer() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer);

    this.sceneTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.depthBuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.width, this.height);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTexture, 0,
    );
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** 保证 dataURL 对应一张 GL 纹理，返回纹理对象 */
  private resolveTexture(dataUrl: string): WebGLTexture {
    const gl = this.gl;
    const cached = this.textureCache.get(dataUrl);
    if (cached) return cached;
    const tex = uploadDataUrl(gl, dataUrl, (t) => {
      this.textureCache.set(dataUrl, t);
    });
    if (tex) this.textureCache.set(dataUrl, tex);
    return tex ?? this.fallbackTexture;
  }

  /** 纹理 dataURL 改变后，丢弃旧缓存条目（GL 对象延迟回收） */
  invalidateTexture(dataUrl: string) {
    const gl = this.gl;
    const tex = this.textureCache.get(dataUrl);
    if (tex) {
      gl.deleteTexture(tex);
      this.textureCache.delete(dataUrl);
    }
  }

  private setUniform(
    location: WebGLUniformLocation | null,
    meta: UniformMeta,
    value: UniformValue,
    textureUnit: number,
  ): number {
    const gl = this.gl;
    if (!location) return textureUnit;
    switch (meta.kind) {
      case 'float':
        gl.uniform1f(location, Number(value));
        break;
      case 'int':
        gl.uniform1i(location, Math.round(Number(value)));
        break;
      case 'bool':
        gl.uniform1i(location, value ? 1 : 0);
        break;
      case 'vec2':
        gl.uniform2fv(location, value as number[]);
        break;
      case 'vec3':
      case 'color':
        gl.uniform3fv(location, value as number[]);
        break;
      case 'vec4':
        gl.uniform4fv(location, value as number[]);
        break;
      case 'texture': {
        const dataUrl = String(value ?? '');
        gl.activeTexture(gl.TEXTURE0 + textureUnit);
        gl.bindTexture(
          gl.TEXTURE_2D,
          dataUrl ? this.resolveTexture(dataUrl) : this.fallbackTexture,
        );
        gl.uniform1i(location, textureUnit);
        return textureUnit + 1;
      }
    }
    return textureUnit;
  }

  private uploadUserUniforms(
    bundle: ProgramBundle,
    values: Record<string, UniformValue>,
    startUnit: number,
  ) {
    let unit = startUnit;
    for (const meta of bundle.uniforms) {
      if (BUILTIN_UNIFORMS.has(meta.name)) continue;
      const v = values[meta.name];
      if (v === undefined) continue;
      const loc = bundle.locations.get(meta.name) ?? null;
      unit = this.setUniform(loc, meta, v, unit);
    }
  }

  private bindFullscreenAttribs() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuffer);
    gl.enableVertexAttribArray(ATTR_POSITION);
    gl.vertexAttribPointer(ATTR_POSITION, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(ATTR_NORMAL);
    gl.disableVertexAttribArray(ATTR_UV);
  }

  private bindMeshAttribs() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
    gl.enableVertexAttribArray(ATTR_POSITION);
    gl.vertexAttribPointer(ATTR_POSITION, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshNormal);
    gl.enableVertexAttribArray(ATTR_NORMAL);
    gl.vertexAttribPointer(ATTR_NORMAL, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.meshUv);
    gl.enableVertexAttribArray(ATTR_UV);
    gl.vertexAttribPointer(ATTR_UV, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.meshIndex);
  }

  /** 渲染一帧。time 由外部（应用层时间线）完全决定，保证可重复 */
  render(
    time: number,
    mode: PreviewMode,
    postEnabled: boolean,
    values: Record<string, UniformValue>,
  ) {
    const gl = this.gl;
    if (!this.main || this.hasMainFailed) return; // 错误状态：保留画布上一次成功的画面
    const usePost = postEnabled && this.post !== null;

    if (usePost) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.08, 0.09, 0.12, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (mode === 'fullscreen') {
      this.renderFullscreen(this.main.program, time, values);
    } else {
      this.renderMesh(this.meshProgram!, time, values);
    }

    if (usePost && this.post) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(this.post.program);
      this.bindFullscreenAttribs();
      const locs = this.post.locations;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sceneTexture);
      const sceneLoc = locs.get('uScene') ?? null;
      if (sceneLoc) gl.uniform1i(sceneLoc, 0);
      const resLoc = locs.get('uResolution') ?? null;
      if (resLoc) gl.uniform2f(resLoc, this.width, this.height);
      const timeLoc = locs.get('uTime') ?? null;
      if (timeLoc) gl.uniform1f(timeLoc, time);
      this.uploadUserUniforms(this.post, values, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  private renderFullscreen(
    program: WebGLProgram,
    time: number,
    values: Record<string, UniformValue>,
  ) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(program);
    this.bindFullscreenAttribs();
    this.uploadBuiltins(this.main!, time);
    this.uploadUserUniforms(this.main!, values, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private renderMesh(
    program: WebGLProgram,
    time: number,
    values: Record<string, UniformValue>,
  ) {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(program);
    this.bindMeshAttribs();

    // 固定倾角 + 绕 Y 轴匀速旋转；时间暂停则旋转也停
    mat4Identity(this.model);
    mat4RotateX(this.model, this.model, -0.6);
    mat4RotateY(this.model, this.model, time * 0.3);
    mat4Multiply(this.mvp, this.proj, this.view);
    mat4Multiply(this.mvp, this.mvp, this.model);

    const locs = this.main!.locations;
    const mvpLoc = locs.get('uMVP') ?? null;
    const modelLoc = locs.get('uModel') ?? null;
    if (mvpLoc) gl.uniformMatrix4fv(mvpLoc, false, this.mvp);
    if (modelLoc) gl.uniformMatrix4fv(modelLoc, false, this.model);
    this.uploadBuiltins(this.main!, time);
    this.uploadUserUniforms(this.main!, values, 0);
    gl.drawElements(gl.TRIANGLES, this.meshIndexCount, gl.UNSIGNED_SHORT, 0);
  }

  private uploadBuiltins(bundle: ProgramBundle, time: number) {
    const gl = this.gl;
    const timeLoc = bundle.locations.get('uTime') ?? null;
    const resLoc = bundle.locations.get('uResolution') ?? null;
    if (timeLoc) gl.uniform1f(timeLoc, time);
    if (resLoc) gl.uniform2f(resLoc, this.width, this.height);
  }

  /** 导出当前画布为 PNG dataURL */
  exportPng(): string {
    return this.canvas.toDataURL('image/png');
  }

  private disposeProgram(bundle: ProgramBundle | null) {
    if (!bundle) return;
    this.gl.deleteProgram(bundle.program);
  }

  dispose() {
    const gl = this.gl;
    this.disposeProgram(this.main);
    this.disposeProgram(this.post);
    if (this.meshProgram) gl.deleteProgram(this.meshProgram);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.sceneTexture) gl.deleteTexture(this.sceneTexture);
    if (this.depthBuffer) gl.deleteRenderbuffer(this.depthBuffer);
    for (const tex of this.textureCache.values()) gl.deleteTexture(tex);
    gl.deleteTexture(this.fallbackTexture);
    const bufs = [this.triBuffer, this.meshPos, this.meshNormal, this.meshUv, this.meshIndex];
    bufs.forEach((b) => gl.deleteBuffer(b));
  }
}
