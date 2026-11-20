// 应用状态：多网格条目、原始/清理版本、简化候选、选中态、项目序列化。
// 几何数据一律以纯数组形式保存，方便 JSON 持久化（恢复候选参数后可重算）。

import { Mesh, inspectMesh, cleanMesh, computeVertexNormals, connectedComponents, boundingBox } from '../core/mesh.js';
import { simplifyMesh } from '../core/simplify.js';
import { deviationReport } from '../core/metrics.js';

let nextId = 1;
const uid = (prefix) => `${prefix}_${nextId++}_${Date.now().toString(36)}`;

export function meshToJSON(mesh) {
  return {
    name: mesh.name,
    positions: Array.from(mesh.positions),
    indices: Array.from(mesh.indices),
    normals: mesh.normals ? Array.from(mesh.normals) : null,
  };
}

export function meshFromJSON(json) {
  return new Mesh({
    positions: Float32Array.from(json.positions),
    indices: Uint32Array.from(json.indices),
    normals: json.normals ? Float32Array.from(json.normals) : null,
    name: json.name,
  });
}

class Store {
  constructor() {
    this.entries = [];          // 网格条目
    this.activeEntryId = null;  // 当前选中的网格
    this.activeCandidateId = null;
    this.viewSettings = {
      mode: 'overlay',          // overlay | split
      showOriginal: true,
      showWireframe: true,
      showHeatmap: false,
      originalOpacity: 0.35,
      boundaryWeight: 10,
    };
    this.listeners = new Set();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  get activeEntry() { return this.entries.find((e) => e.id === this.activeEntryId) || null; }
  get activeCandidate() {
    const e = this.activeEntry;
    return e ? e.candidates.find((c) => c.id === this.activeCandidateId) || null : null;
  }

  /**
   * 从 Mesh 对象创建条目。原始网格永远保留，不可删除。
   */
  addEntry(mesh) {
    if (!mesh.normals) computeVertexNormals(mesh);
    const entry = {
      id: uid('mesh'),
      name: mesh.name || `网格 ${this.entries.length + 1}`,
      original: meshToJSON(mesh),
      inspection: inspectMesh(mesh),
      cleaned: null,          // { options, mesh, report }
      candidates: [],
      createdAt: new Date().toISOString(),
    };
    this.entries.push(entry);
    this.activeEntryId = entry.id;
    this.activeCandidateId = null;
    this.emit();
    return entry;
  }

  removeEntry(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return;
    this.entries.splice(idx, 1);
    if (this.activeEntryId === id) {
      this.activeEntryId = this.entries[0]?.id || null;
      this.activeCandidateId = this.activeEntry()?.candidates[0]?.id || null;
    }
    this.emit();
  }

  selectEntry(id) {
    this.activeEntryId = id;
    this.activeCandidateId = this.activeEntry ? this.activeEntry.candidates[0]?.id || null : null;
    this.emit();
  }

  selectCandidate(cid) {
    this.activeCandidateId = cid;
    this.emit();
  }

  /** 简化所基于的网格：清理过则用清理版，否则用原始版。 */
  baseMeshOf(entry) {
    return entry.cleaned ? meshFromJSON(entry.cleaned.mesh) : meshFromJSON(entry.original);
  }

  /**
   * 执行清理（只产生新版本，原始网格始终保留）。
   */
  applyCleanup(entryId, options) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return;
    const original = meshFromJSON(entry.original);
    const { mesh, report } = cleanMesh(original, options);
    entry.cleaned = { options: { ...options }, mesh: meshToJSON(mesh), report };
    // 旧候选基于清理前的网格，标记失效但保留记录（参数可用于重算）
    entry.candidates = [];
    this.activeCandidateId = null;
    this.emit();
  }

  revertCleanup(entryId) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.cleaned = null;
    entry.candidates = [];
    this.activeCandidateId = null;
    this.emit();
  }

  /**
   * 生成多个简化候选。
   * @param {Array<{mode:'faces'|'ratio', value:number}>} specs
   */
  generateCandidates(entryId, specs) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return [];
    const base = this.baseMeshOf(entry);
    const baseFaces = base.faceCount;
    const created = [];
    for (const spec of specs) {
      const target = spec.mode === 'ratio'
        ? Math.max(1, Math.round(baseFaces * spec.value))
        : Math.max(1, Math.round(spec.value));
      const t0 = performance.now();
      const result = simplifyMesh(base, target, { boundaryWeight: this.viewSettings.boundaryWeight });
      const timeMs = Math.round(performance.now() - t0);
      const dev = deviationReport(base, result.mesh);
      const candidate = {
        id: uid('lod'),
        mode: spec.mode,
        requested: spec.value,
        targetFaceCount: result.targetFaceCount,
        actualFaceCount: result.mesh.faceCount,
        actualVertexCount: result.mesh.vertexCount,
        baseFaceCount: baseFaces,
        baseVertexCount: base.vertexCount,
        ratio: result.mesh.faceCount / baseFaces,
        timeMs,
        boundaryWeight: this.viewSettings.boundaryWeight,
        componentBudgets: result.componentBudgets,
        componentFacesAfter: result.componentFacesAfter,
        warning: result.error,
        metrics: {
          hausdorff: dev.hausdorff,
          normalizedHausdorff: dev.normalizedHausdorff,
          rms: dev.rms,
          forwardMax: dev.forwardMax,
          backwardMax: dev.backwardMax,
        },
        mesh: meshToJSON(result.mesh),
        createdAt: new Date().toISOString(),
      };
      entry.candidates.push(candidate);
      created.push(candidate);
    }
    if (!this.activeCandidateId && created.length) this.activeCandidateId = created[0].id;
    this.emit();
    return created;
  }

  removeCandidate(entryId, candidateId) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return;
    entry.candidates = entry.candidates.filter((c) => c.id !== candidateId);
    if (this.activeCandidateId === candidateId) {
      this.activeCandidateId = entry.candidates[0]?.id || null;
    }
    this.emit();
  }

  setView(patch) {
    Object.assign(this.viewSettings, patch);
    this.emit();
  }

  /**
   * 项目保存：包含全部网格、清理状态与候选参数。
   * 体积优化：几何以普通数组存储；版本号用于后续兼容。
   */
  serializeProject() {
    return JSON.stringify({
      format: 'mesh-lod-compare',
      version: 1,
      savedAt: new Date().toISOString(),
      viewSettings: this.viewSettings,
      entries: this.entries.map((e) => ({
        id: e.id,
        name: e.name,
        original: e.original,
        inspection: e.inspection,
        cleaned: e.cleaned,
        candidates: e.candidates.map((c) => {
          // 几何可由参数重算，保存项目时仍一并保存以便离线快速恢复
          return c;
        }),
        createdAt: e.createdAt,
      })),
      activeEntryId: this.activeEntryId,
      activeCandidateId: this.activeCandidateId,
    }, null, 2);
  }

  loadProject(jsonText) {
    const data = JSON.parse(jsonText);
    if (data.format !== 'mesh-lod-compare') throw new Error('不是本工具的项目文件');
    if (data.version !== 1) throw new Error(`不支持的项目版本: ${data.version}`);
    this.entries = data.entries;
    // 选中态兜底：恢复的 id 可能已失效
    const entryExists = this.entries.some((e) => e.id === data.activeEntryId);
    this.activeEntryId = entryExists ? data.activeEntryId : (this.entries[0]?.id || null);
    const active = this.activeEntry;
    const candExists = active?.candidates.some((c) => c.id === data.activeCandidateId);
    this.activeCandidateId = candExists ? data.activeCandidateId : (active?.candidates[0]?.id || null);
    Object.assign(this.viewSettings, data.viewSettings || {});
    // 恢复后校验：候选参数可重算（提供“重新生成”入口，无需立即执行）
    this.emit();
  }

  /** 依据保存的候选参数重新生成（验证可恢复性，也用于换边界权重后重算）。 */
  regenerateCandidates(entryId) {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry || !entry.candidates.length) return;
    const specs = entry.candidates.map((c) => ({ mode: c.mode, value: c.requested }));
    entry.candidates = [];
    this.activeCandidateId = null;
    this.generateCandidates(entryId, specs);
  }
}

export const store = new Store();

export function entryStats(entry) {
  const base = entry.cleaned ? entry.cleaned.mesh : entry.original;
  const cc = connectedComponents(meshFromJSON(entry.cleaned ? entry.cleaned.mesh : entry.original));
  const bb = boundingBox(meshFromJSON(entry.original));
  return {
    componentCount: cc.count,
    baseVertexCount: base.positions.length / 3,
    baseFaceCount: base.indices.length / 3,
    originalVertexCount: entry.original.positions.length / 3,
    originalFaceCount: entry.original.indices.length / 3,
    diagonal: bb.diagonal,
  };
}
