// 编辑器主控：组装 Three.js 场景、指针笔刷交互、分块增量刷新与工具状态。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createTerrainMesh } from '../render/terrain-view.js';
import { VegetationRenderer } from '../render/vegetation-view.js';
import { BrushCursor, MaskOverlay, ChunkGrid } from '../render/helpers.js';
import { TOOL, CHUNK_SIZE } from '../core/constants.js';

const TOOL_COLORS = {
  [TOOL.PAINT]: 0x7dffa1,
  [TOOL.ERASE]: 0xff6b6b,
  [TOOL.REPLACE]: 0xffd166,
  [TOOL.MASK]: 0x66ccff,
};

export class Editor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} world { terrain, mask, scatter, rules }
   * @param {object} callbacks 状态回调（统计、脏块等）
   */
  constructor(canvas, world, callbacks = {}) {
    this.canvas = canvas;
    this.terrain = world.terrain;
    this.mask = world.mask;
    this.scatter = world.scatter;
    this.rules = world.rules;
    this.callbacks = callbacks;

    this.tool = TOOL.PAINT;
    this.brushRadius = 12;
    this.brushStrength = 0.8;
    this.maskMode = 1; // 1 = 加遮罩，-1 = 减遮罩
    this.replaceRuleId = this.rules[0]?.id;
    this.showChunks = false;
    this.showMask = false;
    this.maxChunksPerFrame = 6;

    this._dragging = false;
    this._lastStroke = null; // 上一帧笔刷落点，用于拖动节流
    this._needsFullRefresh = false;

    this._initThree();
    this._initWorld();
    this._initPointer();
    this._startLoop();
  }

  _initThree() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbfd4e6);
    this.scene.fog = new THREE.Fog(0xbfd4e6, 140, 320);

    const size = this.terrain.width;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
    this.camera.position.set(size * 0.85, size * 0.75, size * 0.85);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 8;
    this.controls.maxDistance = size * 2.4;

    const hemi = new THREE.HemisphereLight(0xeaf4ff, 0x55603f, 0.85);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(size * 0.6, size, size * 0.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = size * 0.75;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = size * 4;
    this.scene.add(sun);

    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _initWorld() {
    this.terrainMesh = createTerrainMesh(this.terrain);
    this.scene.add(this.terrainMesh);

    this.vegetation = new VegetationRenderer(this.scene, this.rules);
    this.maskOverlay = new MaskOverlay(this.mask, this.terrain);
    this.scene.add(this.maskOverlay.mesh);
    this.chunkGrid = new ChunkGrid(this.terrain);
    this.scene.add(this.chunkGrid.lines);

    this.cursor = new BrushCursor();
    this.scene.add(...this.cursor.objects);

    // 初始全量刷新一次
    this._needsFullRefresh = true;
  }

  _initPointer() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => this._onDown(e));
    dom.addEventListener('pointermove', (e) => this._onMove(e));
    window.addEventListener('pointerup', () => {
      this._dragging = false;
      this._lastStroke = null;
      this.controls.enabled = true;
    });
    dom.addEventListener('pointerleave', () => this.cursor.hide());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _setNdc(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _pickTerrain(e) {
    this._setNdc(e);
    this._raycaster.setFromCamera(this._pointerNdc, this.camera);
    const hit = this._raycaster.intersectObject(this.terrainMesh, false)[0];
    return hit ?? null;
  }

  _onDown(e) {
    if (e.button !== 0) return;
    const hit = this._pickTerrain(e);
    if (!hit) return;
    this._dragging = true;
    this.controls.enabled = false;
    this._lastStroke = null;
    this._strokeAt(hit.point);
  }

  _onMove(e) {
    const hit = this._pickTerrain(e);
    if (!hit) {
      this.cursor.hide();
      return;
    }
    this.cursor.show(
      hit.point.x,
      hit.point.y,
      hit.point.z,
      this.brushRadius,
      TOOL_COLORS[this.tool],
    );
    if (this._dragging) this._strokeAt(hit.point);
  }

  /**
   * 一次笔刷落点。拖动时按半径的 35% 做空间节流 —— 即使 pointermove 在同一帧
   * 多次触发、或几帧停在同一像素，也不会重复堆放（格状态本身也是幂等的）。
   */
  _strokeAt(point) {
    const p = { x: point.x, z: point.z };
    if (this._lastStroke) {
      const moved = Math.hypot(p.x - this._lastStroke.x, p.z - this._lastStroke.z);
      if (moved < this.brushRadius * 0.35) return;
    }
    this._lastStroke = p;

    if (this.tool === TOOL.MASK) {
      const region = this.mask.paint(p, this.brushRadius, this.maskMode * this.brushStrength);
      if (region) {
        this.scatter.markRegionDirty(region);
        this.maskOverlay.update();
      }
      return;
    }
    this.scatter.applyBrush(this.tool, p, this.brushRadius, this.replaceRuleId);
    this.callbacks.onStroke?.();
  }

  _startLoop() {
    const tick = () => {
      requestAnimationFrame(tick);
      this.controls.update();

      // 每帧只重建预算内的脏块，大区域编辑不卡帧
      if (this.scatter.dirtyChunks.size > 0 || this._needsFullRefresh) {
        const changes = this._needsFullRefresh
          ? this.scatter.flushDirty()
          : this.scatter.flushDirty(this.maxChunksPerFrame);
        const changedRules = new Set();
        for (const ch of changes) {
          for (const inst of ch.instances) changedRules.add(inst.ruleId);
        }
        if (this._needsFullRefresh) {
          this.vegetation.update(this.scatter.getAllInstances());
          this._needsFullRefresh = false;
        } else if (changes.length > 0) {
          // 受影响规则整组重填，保证被擦除的实例从 InstancedMesh 移除
          this.vegetation.update(this.scatter.getAllInstances(), changedRules);
        }
        this.callbacks.onStats?.(this.scatter.getStats(), this.scatter.dirtyChunks.size);
      }

      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 对外操作（UI 面板调用） ----------

  setTool(tool) {
    this.tool = tool;
  }

  setBrushRadius(r) {
    this.brushRadius = r;
  }

  setBrushStrength(v) {
    this.brushStrength = v;
  }

  setMaskMode(mode) {
    this.maskMode = mode;
  }

  setReplaceRule(ruleId) {
    this.replaceRuleId = ruleId;
  }

  toggleChunks(v) {
    this.showChunks = v;
    this.chunkGrid.setVisible(v);
  }

  toggleMask(v) {
    this.showMask = v;
    this.maskOverlay.setVisible(v);
    if (v) this.maskOverlay.update();
  }

  /** 规则编辑后：交给引擎做格网迁移与脏块标记，渲染层同步实例池。 */
  applyRules(rules) {
    const gridChanged = Math.abs(
      this.scatter.cellSize - this.scatter._cellSizeForRules(rules),
    ) > 1e-9;
    const idsChanged = rules.length !== this.rules.length ||
      rules.some((r, i) => r.id !== this.rules[i]?.id);
    this.scatter.invalidateRules(rules);
    this.rules = rules;
    if (gridChanged || idsChanged) {
      this.vegetation.rebuildPools(rules, this.scatter.getAllInstances());
    } else {
      // id 不变（改密度/颜色/约束）：重建模板材质，实例矩阵由脏块刷新
      this.vegetation.syncRuleTemplates(rules, this.scatter.getAllInstances());
    }
    this._needsFullRefresh = true;
    if (this.showMask) this.maskOverlay.update();
  }

  setSeed(seed) {
    this.scatter.setSeed(seed);
    this._needsFullRefresh = true;
  }

  /** 加载项目后整体替换世界对象。 */
  replaceWorld(world) {
    this.terrain = world.terrain;
    this.mask = world.mask;
    this.scatter = world.scatter;
    this.rules = world.rules;

    this.scene.remove(this.terrainMesh);
    this.terrainMesh.geometry.dispose();
    this.terrainMesh.material.dispose();
    this.terrainMesh = createTerrainMesh(this.terrain);
    this.scene.add(this.terrainMesh);

    this.vegetation.rebuildPools(this.rules, this.scatter.getAllInstances());
    this.maskOverlay = new MaskOverlay(this.mask, this.terrain);
    this.maskOverlay.setVisible(this.showMask);
    this.scene.add(this.maskOverlay.mesh);

    this._needsFullRefresh = true;
    this.callbacks.onStats?.(this.scatter.getStats(), this.scatter.dirtyChunks.size);
  }

  refreshStats() {
    this.callbacks.onStats?.(this.scatter.getStats(), this.scatter.dirtyChunks.size);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

export { CHUNK_SIZE };
