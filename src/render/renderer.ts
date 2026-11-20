// WebGL2 渲染器：材质 / 线框 / 法线三种模式，环境光预设，包围盒辅助线
// 场景树节点直接驱动渲染，节点隐藏、颜色覆盖实时生效

import { bbox, v3, type BBox, type Mat4, type Vec3 } from '../core/math';
import type {
  DisplayMode,
  EnvironmentId,
  MaterialOverride,
  MtlMaterial,
  SceneModel,
  SceneNode,
  SubMesh,
} from '../core/types';
import { LINE_FRAG, LINE_VERT, MESH_FRAG, MESH_VERT } from './shaders';
import {
  createPlaceholderTexture,
  hexToRgb01,
  loadTextureFromUrl,
  type TextureResult,
} from './textures';

interface GpuMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  wireVao: WebGLVertexArrayObject;
  wireCount: number;
  normalVao: WebGLVertexArrayObject;
  normalCount: number;
  positions: Float32Array;
  indices: Uint32Array;
}

interface GpuGroup {
  node: SceneNode;
  meshes: { sub: SubMesh; gpu: GpuMesh; materialName: string | null }[];
}

interface EnvironmentPreset {
  id: EnvironmentId;
  label: string;
  ambient: Vec3;
  light: Vec3;
  lightDir: Vec3;
  background: [number, number, number];
}

export const ENVIRONMENTS: EnvironmentPreset[] = [
  {
    id: 'studio',
    label: '摄影棚',
    ambient: [0.32, 0.32, 0.34],
    light: [0.85, 0.83, 0.8],
    lightDir: v3.normalize([0.5, 0.9, 0.6]),
    background: [0.13, 0.14, 0.17],
  },
  {
    id: 'daylight',
    label: '日光',
    ambient: [0.22, 0.24, 0.28],
    light: [1.0, 0.97, 0.9],
    lightDir: v3.normalize([-0.4, 0.8, 0.5]),
    background: [0.45, 0.58, 0.72],
  },
  {
    id: 'night',
    label: '夜晚',
    ambient: [0.08, 0.09, 0.14],
    light: [0.45, 0.5, 0.75],
    lightDir: v3.normalize([0.3, 0.6, -0.7]),
    background: [0.03, 0.04, 0.08],
  },
];

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败: ${log}\n${src}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败: ${log}`);
  }
  return program;
}

/** 由三角索引生成线框线段（去重后的唯一边） */
function buildWireframe(indices: Uint32Array): Uint32Array {
  const edges = new Set<number>();
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * 1_000_003 + b : b * 1_000_003 + a;
    edges.add(key);
  };
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  const out = new Uint32Array(edges.size * 2);
  let p = 0;
  for (const key of edges) {
    out[p++] = Math.floor(key / 1_000_003);
    out[p++] = key % 1_000_003;
  }
  return out;
}

/** 由位置/法线生成法线可视化线段（顶点 -> 沿法线偏移） */
function buildNormalGlyphs(positions: Float32Array, normals: Float32Array): Float32Array {
  const count = positions.length / 3;
  const segs = new Float32Array(count * 6);
  const scale = 0.08;
  for (let i = 0; i < count; i++) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    segs[i * 6] = px;
    segs[i * 6 + 1] = py;
    segs[i * 6 + 2] = pz;
    segs[i * 6 + 3] = px + normals[i * 3] * scale;
    segs[i * 6 + 4] = py + normals[i * 3 + 1] * scale;
    segs[i * 6 + 5] = pz + normals[i * 3 + 2] * scale;
  }
  return segs;
}

/** 包围盒的 12 条边 */
function bboxLines(box: BBox): Float32Array {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const corners: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const edgePairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const out = new Float32Array(edgePairs.length * 6);
  edgePairs.forEach(([a, b], i) => {
    out.set(corners[a], i * 6);
    out.set(corners[b], i * 6 + 3);
  });
  return out;
}

export class GLRenderer {
  private gl: WebGL2RenderingContext;
  private meshProgram: WebGLProgram;
  private lineProgram: WebGLProgram;
  private meshUniforms: Record<string, WebGLUniformLocation | null>;
  private lineUniforms: Record<string, WebGLUniformLocation | null>;
  private gpuGroups: GpuGroup[] = [];
  private textures = new Map<string, TextureResult>();
  private placeholder: TextureResult;
  private model: SceneModel | null = null;
  private materialOverrides = new Map<string, MaterialOverride>();
  displayMode: DisplayMode = 'material';
  environment: EnvironmentPreset = ENVIRONMENTS[0];
  selectedNodeId: string | null = null;
  private bboxVao: WebGLVertexArrayObject | null = null;
  private bboxCount = 0;
  /** 按 dataUrl 缓存可用贴图，key 为文件名 basename */
  private textureUrlByName = new Map<string, string>();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('当前浏览器不支持 WebGL2，无法启动查看器');
    }
    this.gl = gl;
    this.meshProgram = linkProgram(gl, MESH_VERT, MESH_FRAG);
    this.lineProgram = linkProgram(gl, LINE_VERT, LINE_FRAG);
    this.meshUniforms = this.collectUniforms(this.meshProgram);
    this.lineUniforms = this.collectUniforms(this.lineProgram);
    this.placeholder = createPlaceholderTexture(gl);
    gl.enable(gl.DEPTH_TEST);
    // OBJ 文件的面绕序经常不一致，默认不做背面剔除，保证用户模型的面都能看到；
    // 着色器中对 gl_FrontFacing=false 的片元翻转法线，保证双面光照正确
  }

  private collectUniforms(program: WebGLProgram): Record<string, WebGLUniformLocation | null> {
    const gl = this.gl;
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    const out: Record<string, WebGLUniformLocation | null> = {};
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (info) out[info.name] = gl.getUniformLocation(program, info.name);
    }
    return out;
  }

  private uploadMesh(sub: SubMesh): GpuMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sub.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nrmBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sub.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const uvBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sub.uvs, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    const idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sub.indices, gl.STATIC_DRAW);

    // 线框
    const wire = buildWireframe(sub.indices);
    const wireVao = gl.createVertexArray()!;
    gl.bindVertexArray(wireVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const wireIdx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, wireIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, wire, gl.STATIC_DRAW);

    // 法线线段
    const normalPts = buildNormalGlyphs(sub.positions, sub.normals);
    const normalVao = gl.createVertexArray()!;
    gl.bindVertexArray(normalVao);
    const nrmLineBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmLineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normalPts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    return {
      vao,
      indexCount: sub.indices.length,
      wireVao,
      wireCount: wire.length,
      normalVao,
      normalCount: normalPts.length / 3,
      positions: sub.positions,
      indices: sub.indices,
    };
  }

  /** 注册可用于贴图加载的文件（basename -> dataUrl） */
  registerTextureFiles(files: { name: string; dataUrl: string }[]): void {
    for (const f of files) {
      const base = f.name.split(/[\\/]/).pop() ?? f.name;
      this.textureUrlByName.set(base, f.dataUrl);
    }
  }

  private async resolveTexture(path: string): Promise<TextureResult> {
    const base = path.split(/[\\/]/).pop() ?? path;
    const cached = this.textures.get(base);
    if (cached) return cached;
    const url = this.textureUrlByName.get(base);
    const result = url
      ? await loadTextureFromUrl(this.gl, url)
      : createPlaceholderTexture(this.gl);
    this.textures.set(base, result);
    return result;
  }

  /** 载入新场景：上传全部几何，并按 MTL 声明解析贴图（缺失自动占位） */
  async setModel(model: SceneModel): Promise<void> {
    this.disposeGpuResources();
    this.model = model;

    const groups: GpuGroup[] = [];
    const textureJobs: Promise<void>[] = [];

    const walk = (node: SceneNode): void => {
      if (node.submeshes.length > 0) {
        const meshes = node.submeshes.map((sub) => ({
          sub,
          gpu: this.uploadMesh(sub),
          materialName: sub.materialName,
        }));
        groups.push({ node, meshes });
      }
      for (const child of node.children) walk(child);
    };
    walk(model.root);
    this.gpuGroups = groups;

    for (const [, mat] of model.materials) {
      const refs = [mat.diffuseMap, mat.normalMap];
      for (const ref of refs) {
        if (!ref) continue;
        const base = ref.path.split(/[\\/]/).pop() ?? ref.path;
        if (!this.textures.has(base)) {
          textureJobs.push(
            this.resolveTexture(ref.path).then(() => undefined),
          );
        }
      }
    }
    await Promise.all(textureJobs);
    this.updateSelectionBBox();
  }

  setMaterialOverrides(overrides: Map<string, MaterialOverride>): void {
    this.materialOverrides = overrides;
  }

  setDisplayMode(mode: DisplayMode): void {
    this.displayMode = mode;
  }

  setEnvironment(id: EnvironmentId): void {
    const preset = ENVIRONMENTS.find((e) => e.id === id);
    if (preset) this.environment = preset;
  }

  setSelectedNode(id: string | null): void {
    this.selectedNodeId = id;
    this.updateSelectionBBox();
  }

  /** 节点隐藏/颜色改变后刷新包围盒缓存 */
  refreshSelectionBBox(): void {
    this.updateSelectionBBox();
  }

  private updateSelectionBBox(): void {
    const gl = this.gl;
    if (this.bboxVao) {
      gl.deleteVertexArray(this.bboxVao);
      this.bboxVao = null;
    }
    this.bboxCount = 0;
    if (!this.model || !this.selectedNodeId) return;
    const node = this.findNode(this.selectedNodeId);
    if (!node || node.hidden || bbox.isEmpty(node.bbox)) return;

    const lines = bboxLines(node.bbox);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.bboxVao = vao;
    this.bboxCount = lines.length / 3;
  }

  private findNode(id: string): SceneNode | null {
    if (!this.model) return null;
    let found: SceneNode | null = null;
    const walk = (node: SceneNode): void => {
      if (node.id === id) found = node;
      for (const child of node.children) walk(child);
    };
    walk(this.model.root);
    return found;
  }

  private isVisible(node: SceneNode): boolean {
    return !this.hiddenAncestor.has(node.id) && !node.hidden;
  }

  /** 渲染前按树遍历一次，记录祖先链上存在隐藏节点的节点 id */
  private computeHiddenAncestor(): Set<string> {
    const hiddenAncestor = new Set<string>();
    if (!this.model) return hiddenAncestor;
    const stack: { node: SceneNode; ancestorHidden: boolean }[] = [
      { node: this.model.root, ancestorHidden: false },
    ];
    while (stack.length > 0) {
      const { node, ancestorHidden } = stack.pop()!;
      const hidden = ancestorHidden || node.hidden;
      if (hidden) hiddenAncestor.add(node.id);
      for (const child of node.children) {
        stack.push({ node: child, ancestorHidden: hidden });
      }
    }
    return hiddenAncestor;
  }
  private hiddenAncestor = new Set<string>();

  private resolveMaterial(name: string | null, node: SceneNode): {
    color: [number, number, number];
    opacity: number;
    specular: Vec3;
    shininess: number;
    texture: TextureResult | null;
    material: MtlMaterial | null;
  } {
    const model = this.model!;
    const mat = name ? model.materials.get(name) ?? null : null;
    const fallback: MtlMaterial = {
      name: '__fallback__',
      diffuse: { r: 0.75, g: 0.75, b: 0.75 },
      ambient: { r: 0.2, g: 0.2, b: 0.2 },
      specular: { r: 0.1, g: 0.1, b: 0.1 },
      shininess: 16,
      opacity: 1,
      diffuseMap: null,
      normalMap: null,
    };
    const m = mat ?? fallback;
    const override = name ? this.materialOverrides.get(name) : undefined;

    let color: [number, number, number] = [m.diffuse.r, m.diffuse.g, m.diffuse.b];
    if (override?.diffuse) color = hexToRgb01(override.diffuse);
    if (node.colorOverride) color = hexToRgb01(node.colorOverride);

    const opacity = override?.opacity ?? m.opacity;
    let texture: TextureResult | null = null;
    if (m.diffuseMap && !node.colorOverride && !override?.diffuse) {
      const base = m.diffuseMap.path.split(/[\\/]/).pop() ?? m.diffuseMap.path;
      texture = this.textures.get(base) ?? this.placeholder;
    }
    return {
      color,
      opacity,
      specular: [m.specular.r, m.specular.g, m.specular.b],
      shininess: m.shininess,
      texture,
      material: mat,
    };
  }

  render(viewProj: Mat4, cameraPos: Vec3): void {
    const gl = this.gl;
    const env = this.environment;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(env.background[0], env.background[1], env.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (!this.model) return;
    this.hiddenAncestor = this.computeHiddenAncestor();

    if (this.displayMode === 'wireframe') {
      this.renderLines(viewProj, [0.85, 0.95, 1.0], 0.9, (entry) => {
        gl.bindVertexArray(entry.gpu.wireVao);
        gl.drawElements(gl.LINES, entry.gpu.wireCount, gl.UNSIGNED_INT, 0);
      });
    } else if (this.displayMode === 'normal') {
      // 先淡渲染实体，再叠加黄色法线
      this.renderMeshes(viewProj, cameraPos, true);
      this.renderLines(viewProj, [1.0, 0.85, 0.2], 1.0, (entry) => {
        gl.bindVertexArray(entry.gpu.normalVao);
        gl.drawArrays(gl.LINES, 0, entry.gpu.normalCount);
      });
    } else {
      this.renderMeshes(viewProj, cameraPos, false);
    }

    // 选中节点包围盒
    if (this.bboxVao && this.bboxCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, viewProj);
      gl.uniform3fv(this.lineUniforms.uColor, [0.25, 0.9, 1.0]);
      gl.uniform1f(this.lineUniforms.uAlpha, 1.0);
      gl.bindVertexArray(this.bboxVao);
      gl.drawArrays(gl.LINES, 0, this.bboxCount);
      gl.bindVertexArray(null);
    }
  }

  private renderLines(
    viewProj: Mat4,
    color: Vec3,
    alpha: number,
    draw: (entry: GpuGroup['meshes'][number]) => void,
  ): void {
    const gl = this.gl;
    gl.useProgram(this.lineProgram);
    gl.uniformMatrix4fv(this.lineUniforms.uViewProj, false, viewProj);
    gl.uniform3fv(this.lineUniforms.uColor, color);
    gl.uniform1f(this.lineUniforms.uAlpha, alpha);
    for (const group of this.gpuGroups) {
      if (!this.isVisible(group.node)) continue;
      for (const entry of group.meshes) draw(entry);
    }
    gl.bindVertexArray(null);
  }

  private renderMeshes(viewProj: Mat4, cameraPos: Vec3, faded: boolean): void {
    const gl = this.gl;
    const env = this.environment;
    gl.useProgram(this.meshProgram);
    const u = this.meshUniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uLightDir, env.lightDir);
    gl.uniform3fv(u.uAmbientColor, env.ambient);
    gl.uniform3fv(u.uLightColor, env.light);
    gl.uniform3fv(u.uCameraPos, cameraPos);

    for (const group of this.gpuGroups) {
      if (!this.isVisible(group.node)) continue;
      for (const entry of group.meshes) {
        const resolved = this.resolveMaterial(entry.materialName, group.node);
        const opacity = faded ? 0.35 : resolved.opacity;
        gl.uniform3fv(
          u.uBaseColor,
          faded
            ? [resolved.color[0] * 0.6, resolved.color[1] * 0.6, resolved.color[2] * 0.6]
            : resolved.color,
        );
        gl.uniform1f(u.uOpacity, opacity);
        gl.uniform3fv(u.uSpecular, resolved.specular);
        gl.uniform1f(u.uShininess, resolved.shininess);

        const tex = resolved.texture ?? this.placeholder;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex.texture);
        gl.uniform1i(u.uMap, 0);
        gl.uniform1f(u.uUseMap, resolved.texture ? 1 : 0);

        gl.bindVertexArray(entry.gpu.vao);
        gl.drawElements(gl.TRIANGLES, entry.gpu.indexCount, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
  }

  /** 供自动化自检读取像素，普通界面逻辑不使用 */
  get glContext(): WebGL2RenderingContext {
    return this.gl;
  }

  /** 当前使用占位贴图的材质名（供 UI 展示明确提示） */
  placeholderMaterials(): { material: string; paths: string[] }[] {
    if (!this.model) return [];
    const out: { material: string; paths: string[] }[] = [];
    for (const [name, paths] of this.model.missingTextures) {
      const anyPlaceholder = paths.some((p) => {
        const base = p.split(/[\\/]/).pop() ?? p;
        return this.textures.get(base)?.placeholder ?? true;
      });
      if (anyPlaceholder) out.push({ material: name, paths });
    }
    return out;
  }

  private disposeGpuResources(): void {
    const gl = this.gl;
    for (const group of this.gpuGroups) {
      for (const entry of group.meshes) {
        const g = entry.gpu;
        gl.deleteVertexArray(g.vao);
        gl.deleteVertexArray(g.wireVao);
        gl.deleteVertexArray(g.normalVao);
      }
    }
    for (const t of this.textures.values()) gl.deleteTexture(t.texture);
    this.textures.clear();
    this.gpuGroups = [];
  }

  dispose(): void {
    this.disposeGpuResources();
    this.gl.deleteTexture(this.placeholder.texture);
    if (this.bboxVao) this.gl.deleteVertexArray(this.bboxVao);
  }
}
