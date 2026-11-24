namespace SamplerLab {
  // ---------- 应用主控制器 ----------

  class App {
    private scene: SceneConfig;
    private out!: RasterOutput;
    private selected: { px: number; py: number } | null = null;
    private scale = 44;
    private frame = 0;
    private playing = false;
    private playTimer: number | null = null;
    private recording = false;

    private view: CanvasView;
    private inspector: PixelInspector;
    private panels: SidePanels;
    private statusEl: HTMLElement;
    private presetBar: HTMLElement;
    private titleEl: HTMLElement;

    constructor() {
      this.scene = defaultScene();
      this.statusEl = document.getElementById('status')!;
      this.presetBar = document.getElementById('preset-bar')!;
      this.titleEl = document.getElementById('preset-title')!;

      this.view = new CanvasView({
        onPickPixel: (px, py) => {
          this.selected = { px, py };
          this.refresh();
        },
        onDragTri: (triId, dx, dy, commit) => this.handleDrag(triId, dx, dy, commit),
      });
      document.getElementById('canvas-wrap')!.append(this.view.canvas);

      this.inspector = new PixelInspector();
      document.getElementById('inspector-wrap')!.append(this.inspector.el);

      this.panels = new SidePanels({
        onSceneMutate: () => this.refresh(),
        onTriNudge: (triId, dx, dy) => this.handleNudge(triId, dx, dy),
        onVertexEdit: (triId, index, axis, value) => {
          const t = this.scene.triangles.find((x) => x.id === triId);
          if (!t) return;
          t.v[index][axis] = value;
          invalidateTrack(this.scene);
          this.recording = false;
          this.frame = 0;
          this.refresh();
        },
        onReplay: (f) => this.seek(f),
        onScale: (s) => {
          this.scale = s;
          this.view.setScale(s);
        },
        onPlayToggle: () => this.togglePlay(),
        onReplayRecord: () => this.startRecording(),
        onReplayClear: () => this.clearTrack(),
        onSavePixel: () => this.savePixel(),
        onImport: (file) => this.importFile(file),
        onExportScene: () => this.exportScene(),
      });
      document.getElementById('side-wrap')!.append(this.panels.el);

      this.buildPresetBar();
      this.bindKeys();
      this.refresh();
    }

    // ---------- 预设 ----------

    private buildPresetBar(): void {
      for (const p of PRESETS) {
        const btn = h('button', { textContent: p.label, className: 'preset-btn' });
        btn.addEventListener('click', () => this.loadPreset(p));
        this.presetBar.append(btn);
      }
    }

    private loadPreset(p: Preset): void {
      this.stopPlay();
      this.scene = p.build();
      this.selected = null;
      this.frame = 0;
      this.recording = false;
      this.titleEl.textContent = p.label;
      document.getElementById('preset-desc')!.textContent = p.description;
      this.refresh();
      this.flash(`已载入例子：${p.label}`);
    }

    // ---------- 平移 / 录制 / 重放 ----------

    private handleDrag(triId: string, dx: number, dy: number, commit: boolean): void {
      if (commit) {
        this.frame = trackLength(this.scene);
        this.refresh();
        return;
      }
      if (dx === 0 && dy === 0) return;
      if (this.recording) recordMove(this.scene, triId, dx, dy);
      else nudgeNow(this.scene, triId, dx, dy);
      this.frame = trackLength(this.scene);
      this.refresh();
    }

    private handleNudge(triId: string, dx: number, dy: number): void {
      if (this.recording) recordMove(this.scene, triId, dx, dy);
      else nudgeNow(this.scene, triId, dx, dy);
      this.frame = trackLength(this.scene);
      this.refresh();
    }

    private startRecording(): void {
      this.stopPlay();
      beginTrack(this.scene);
      this.recording = true;
      this.frame = 0;
      this.flash('开始录制：接下来的每次平移都会写入轨迹');
      this.refresh();
    }

    private clearTrack(): void {
      this.stopPlay();
      invalidateTrack(this.scene);
      this.recording = false;
      this.frame = 0;
      this.refresh();
    }

    private seek(f: number): void {
      this.stopPlay();
      this.frame = replayToFrame(this.scene, f);
      this.refresh();
    }

    private togglePlay(): void {
      if (this.playing) {
        this.stopPlay();
        return;
      }
      if (!hasTrack(this.scene) || trackLength(this.scene) === 0) return;
      this.playing = true;
      // 固定 350ms 一步，纯函数式回放：速度只影响观感，不影响每帧结果
      this.playTimer = window.setInterval(() => {
        const len = trackLength(this.scene);
        if (this.frame >= len) {
          this.frame = 0;
          replayToFrame(this.scene, 0);
        } else {
          this.frame = replayToFrame(this.scene, this.frame + 1);
        }
        this.refresh();
      }, 350);
      this.refresh();
    }

    private stopPlay(): void {
      if (this.playTimer !== null) {
        clearInterval(this.playTimer);
        this.playTimer = null;
      }
      this.playing = false;
    }

    // ---------- 键盘平移 ----------

    private bindKeys(): void {
      window.addEventListener('keydown', (e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
        const step = e.shiftKey ? 1 : 0.25;
        const map: Record<string, [number, number]> = {
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
        };
        const d = map[e.key];
        if (!d) return;
        const active = this.scene.triangles.find((t) => t.enabled);
        if (!active) return;
        e.preventDefault();
        this.handleNudge(active.id, d[0], d[1]);
      });
    }

    // ---------- 保存 / 读取 ----------

    private savePixel(): void {
      if (!this.selected) return;
      const record = buildPixelRecord(this.scene, this.out, this.selected.px, this.selected.py);
      // 测试钩子：挂到 globalThis，便于自动化导入复现验证
      (globalThis as unknown as { __lastRecord?: PixelRecord }).__lastRecord = record;
      try {
        downloadRecord(record);
      } catch (err) {
        console.warn('浏览器拦截了文件下载，记录仍保留在内存中：', err);
      }
      this.flash(`已保存像素 (${this.selected.px}, ${this.selected.py}) 的完整记录 JSON`);
    }

    private exportScene(): void {
      const blob = new Blob([JSON.stringify(this.scene, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'scene.json';
      a.click();
      URL.revokeObjectURL(url);
      this.flash('已导出当前场景配置');
    }

    private async importFile(file: File): Promise<void> {
      try {
        const text = await file.text();
        const raw = JSON.parse(text);
        const record = validateRecord(raw);
        const report = reproduce(record);
        this.stopPlay();
        this.scene = record.scene;
        this.selected = { ...record.selectedPixel };
        this.frame = trackLength(this.scene);
        this.recording = false;
        this.refresh();
        if (report.ok) {
          this.flash(`已读入记录并复现成功：像素 (${record.selectedPixel.px}, ${record.selectedPixel.py}) 全部采样点与颜色一致 ✓`);
        } else {
          this.flash('复现存在差异：' + report.mismatches.join('；'), true);
        }
      } catch (err) {
        this.flash('导入失败：' + (err instanceof Error ? err.message : String(err)), true);
      }
    }

    // ---------- 渲染 ----------

    private refresh(): void {
      this.out = rasterize(this.scene);
      this.view.setScale(this.scale);
      this.view.update(this.scene, this.out, this.selected);
      this.inspector.render(this.scene, this.out, this.selected);
      const activeId = this.scene.triangles[0]?.id ?? null;
      this.panels.renderScene(this.scene, this.selected, this.scale);
      this.panels.renderTriangles(this.scene, this.out, activeId);
      this.panels.renderDiagnosis(this.out);
      this.panels.renderReplay(this.scene, this.frame, this.playing);
      this.statusEl.textContent =
        `画布 ${this.scene.width}×${this.scene.height} · ` +
        `${this.scene.sampleMode === 'center' ? '中心采样' : 'MSAA 4x'} · ` +
        `${this.scene.blendMode === 'linear' ? '线性混合' : '存储值混合'} · ` +
        (this.recording ? '● 录制中' : this.playing ? '▶ 重放中' : '空闲');
    }

    private flash(msg: string, warn = false): void {
      const el = document.getElementById('toast')!;
      el.textContent = msg;
      el.className = warn ? 'toast show warn' : 'toast show';
      window.setTimeout(() => (el.className = 'toast'), 3200);
    }
  }

  window.addEventListener('DOMContentLoaded', () => new App());
}
