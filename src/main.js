// 主控：加载素材、播放同步、参数面板、遮罩、项目存取、导出
import {
  $, $$, clamp, toast, formatTime, rgb01ToHex,
  readFileAsDataURL, loadImage, uid, ensureFiniteDuration,
} from "./utils.js";
import {
  createProject, segmentAt, segmentIndexAt, splitSegment, deleteSegment,
  paramsAt, upsertKeyframe, removeKeyframeAt, writeParam, keyframeAt,
} from "./project.js";
import { Renderer } from "./renderer.js";
import { MaskEditor } from "./mask.js";
import { Timeline } from "./timeline.js";
import {
  autosaveProject, loadAutosave, saveProjectRecord, listProjectRecords,
  loadProjectRecord, deleteProjectRecord,
} from "./storage.js";
import { Exporter } from "./exporter.js";
import {
  generateSampleVideo, generateBackgroundImage, generateBackgroundVideo,
  getCachedSamples,
} from "./sample-generator.js";

class App {
  constructor() {
    this.project = createProject();
    this.time = 0;
    this.playing = false;
    this.viewMode = "alpha";
    this.maskMode = "remove";
    this.brushSize = 24;
    this.feather = 6;
    this.eyedropActive = false;
    this.bgImageEl = null;
    this.bgVideoEl = null;
    this._segId = null;
    this._autoSaveTimer = 0;

    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = "auto";

    this.renderer = new Renderer($("#glCanvas"));
    this.timeline = new Timeline($("#timelineCanvas"), {
      onScrub: (t) => this.scrub(t),
    });
    this.maskEditor = new MaskEditor($("#maskCanvas"), () => ({
      project: this.project,
      time: this.time,
      seg: this._currentSeg(),
      brushSize: this.brushSize,
      feather: this.feather,
      mode: this.maskMode,
      onChange: () => this.scheduleAutoSave(),
    }));
    this.maskEditor.mode = "remove";

    this._bindUI();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
    this._restoreAutosave();
  }

  // ---------------- 素材加载 ----------------
  async loadSourceFromDataUrl(dataUrl, name, sample = false) {
    const v = this.video;
    v.src = dataUrl;
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error("源视频加载失败"));
    });
    // MediaRecorder 产物可能 duration=Infinity，修复后再进入业务逻辑
    const dur = await ensureFiniteDuration(v);
    this._sourceDuration = isFinite(dur) ? dur : v.duration;
    this.project.source = sample
      ? { sample: true, name }
      : { name, dataUrl, type: v.videoType || "video/*" };
    // 修正时间段边界
    this._normalizeSegments(this.sourceDuration);
    this.time = 0;
    v.currentTime = 0;
    this.renderer.resetTemporal();
    this.timeline.setProject(this.project, this.sourceDuration);
    this._syncSliderToTime();
    $("#emptyState").classList.add("hidden");
    $("#syncState").textContent = name;
    this.scheduleAutoSave();
    toast(`已载入源视频：${name}`, "success");
  }

  get sourceDuration() {
    return isFinite(this._sourceDuration) ? this._sourceDuration : this.video.duration;
  }

  async importSourceFile(file) {
    const dataUrl = await readFileAsDataURL(file);
    await this.loadSourceFromDataUrl(dataUrl, file.name);
  }

  async loadSample() {
    try {
      let cached = await getCachedSamples();
      if (!cached.video) {
        toast("首次使用，正在本地生成示例素材…");
        await generateSampleVideo((p, msg) => this._sampleProgress(p, msg));
        cached = await getCachedSamples();
      }
      await this.loadSourceFromDataUrl(cached.video.dataUrl, cached.video.name, true);
      // 顺手准备好示例背景
      if (!cached.bgImage) await generateBackgroundImage().catch(() => {});
    } catch (e) {
      console.error(e);
      toast("示例生成失败：" + e.message, "error", 5000);
    }
  }

  _sampleProgress(p, msg) {
    $("#syncState").textContent = `${msg} ${Math.round(p * 100)}%`;
  }

  async setBackgroundFile(file) {
    const dataUrl = await readFileAsDataURL(file);
    const isVideo = file.type.startsWith("video/");
    this.project.background = {
      mode: isVideo ? "video" : "image",
      name: file.name,
      dataUrl,
      fit: this.project.background.fit,
    };
    await this._instantiateBackground();
    this.scheduleAutoSave();
  }

  async useSampleBackground(kind) {
    const cached = await getCachedSamples();
    let meta = kind === "image" ? cached.bgImage : cached.bgVideo;
    if (!meta) {
      meta = kind === "image"
        ? await generateBackgroundImage()
        : await generateBackgroundVideo((p) => this._sampleProgress(p, "生成动态背景"));
    }
    this.project.background = {
      mode: kind, name: meta.name, dataUrl: meta.dataUrl, fit: "cover",
    };
    await this._instantiateBackground();
    this.scheduleAutoSave();
  }

  async _instantiateBackground() {
    const bg = this.project.background;
    this.bgImageEl = null;
    this.bgVideoEl = null;
    $("#bgFileName").textContent = bg.name || "";
    if (bg.mode === "none" || !bg.dataUrl) return;
    if (bg.mode === "image") {
      this.bgImageEl = await loadImage(bg.dataUrl);
    } else {
      const bv = document.createElement("video");
      bv.src = bg.dataUrl;
      bv.muted = true; bv.playsInline = true; bv.loop = true;
      await new Promise((res, rej) => {
        bv.onloadedmetadata = res;
        bv.onerror = () => rej(new Error("背景视频加载失败"));
      });
      await ensureFiniteDuration(bv).catch(() => {});
      this.bgVideoEl = bv;
    }
  }

  _bgElement() {
    if (this.project.background.mode === "image") return this.bgImageEl;
    if (this.project.background.mode === "video") return this.bgVideoEl;
    return null;
  }

  // ---------------- 播放 ----------------
  togglePlay() {
    const v = this.video;
    if (!v.src) return;
    if (v.paused) {
      v.play();
      if (this.bgVideoEl) this.bgVideoEl.play().catch(() => {});
      this.playing = true;
      $("#btnPlay").textContent = "⏸ 暂停";
    } else {
      v.pause();
      if (this.bgVideoEl) this.bgVideoEl.pause();
      this.playing = false;
      $("#btnPlay").textContent = "▶ 播放";
    }
  }

  scrub(t) {
    if (!this.video.src) return;
    this.time = clamp(t, 0, this.sourceDuration || 0);
    this.video.currentTime = this.time;
    this.renderer.resetTemporal();
    if (this.bgVideoEl) {
      const bd = isFinite(this.bgVideoEl.duration) ? this.bgVideoEl.duration : 1;
      this.bgVideoEl.currentTime = this.time % bd;
    }
    this._syncSliderToTime();
    this.maskEditor.drawOverlay();
  }

  _loop() {
    const v = this.video;
    if (v.src && v.readyState >= 2 && !this.exporting) {
      this.time = v.currentTime;
      // 背景视频联动：偏差过大时对齐
      if (this.bgVideoEl && !v.paused) {
        const bd = isFinite(this.bgVideoEl.duration) ? this.bgVideoEl.duration : 1;
        const target = this.time % bd;
        if (Math.abs(this.bgVideoEl.currentTime - target) > 0.25) {
          this.bgVideoEl.currentTime = target;
        }
      }
      this._renderFrame();
      // 遮罩画布对齐到视频 contain 显示区
      const wrapRect = $("#canvasWrap").getBoundingClientRect();
      this.maskEditor.syncFrame(wrapRect, v.videoWidth, v.videoHeight);
      $("#timeCur").textContent = formatTime(this.time);
      $("#timeDur").textContent = formatTime(this.sourceDuration);
      this.timeline.setTime(this.time);
      this._onSegmentChange();
      if (!v.paused) this._syncSliderToTime();
    }
    requestAnimationFrame(this._loop);
  }

  _renderFrame() {
    const seg = this._currentSeg();
    if (!seg) return;
    // 遮罩栅格化（仅在变化时重算）
    const maskCanvas = this._rasterizeMask(seg);
    const opts = {
      mode: this.viewMode,
      params: paramsAt(this.project, this.time),
      keyColor: this.project.keyColor,
      temporal: this.project.temporal,
      maskCanvas,
      bgFit: this.project.background.fit,
      time: this.time,
    };
    this.renderer.render(this.video, this._bgElement(), opts);
  }

  _rasterizeMask(seg) {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!w) return null;
    const sig = `${seg.id}:${seg.masks.length}:${w}x${h}:` +
      seg.masks.map((m) => m.points.length).join(",");
    if (this._maskSig === sig) return this._maskCanvas;
    this._maskCanvas = this.maskEditor.rasterize(seg, w, h);
    this._maskSig = sig;
    return this._maskCanvas;
  }

  _currentSeg() {
    if (!this.sourceDuration) return this.project.segments[0];
    return segmentAt(this.project, this.time);
  }

  _onSegmentChange() {
    const seg = this._currentSeg();
    if (seg.id !== this._segId) {
      this._segId = seg.id;
      this.renderer.resetTemporal(); // 跨时间段重置，避免参数突变拖影
      this._maskSig = null;
      this.maskEditor.drawOverlay();
      const idx = segmentIndexAt(this.project, this.time);
      $("#segInfo").textContent =
        `当前：时间段 ${idx + 1}/${this.project.segments.length} · 起始 ${formatTime(seg.start)}`;
    }
  }

  _normalizeSegments(dur) {
    const segs = this.project.segments;
    segs.forEach((s, i) => {
      if (s.end !== null && s.end > dur) s.end = dur;
      if (i > 0) s.start = segs[i - 1].end ?? dur;
    });
    if (segs.length && segs[segs.length - 1].end !== null) {
      segs[segs.length - 1].end = null;
    }
  }

  // ---------------- 参数面板 ----------------
  _syncSliderToTime() {
    const p = paramsAt(this.project, this.time);
    for (const k of ["similarity", "softness", "spill", "shadow"]) {
      $(`#${k}`).value = Math.round(p[k]);
      $(`#${k}Val`).textContent = Math.round(p[k]);
    }
    const seg = this._currentSeg();
    const kf = seg ? keyframeAt(seg, this.time) : null;
    $("#btnAddKf").textContent = kf ? "◆ 更新当前关键帧" : "◆ 添加关键帧";
  }

  _bindUI() {
    // 视图模式
    $$("#viewMode .seg").forEach((b) => b.addEventListener("click", () => {
      this.viewMode = b.dataset.mode;
      $$("#viewMode .seg").forEach((x) => x.classList.toggle("active", x === b));
      this.renderer.resetTemporal();
    }));

    // 抠像参数滑块
    ["similarity", "softness", "spill", "shadow"].forEach((k) => {
      const el = $(`#${k}`);
      el.addEventListener("input", () => {
        const val = Number(el.value);
        $(`#${k}Val`).textContent = val;
        writeParam(this.project, this.time, k, val);
        this.timeline.draw();
        this.scheduleAutoSave();
      });
    });

    // 主色
    $("#keyColorPick").addEventListener("input", (e) => {
      this.project.keyColor = e.target.value;
      $("#keySwatch").style.background = e.target.value;
      this.scheduleAutoSave();
    });

    // 取色器
    $("#btnEyedrop").addEventListener("click", () => this._toggleEyedrop());

    // 时间稳定
    $("#temporal").addEventListener("input", (e) => {
      this.project.temporal = Number(e.target.value) / 100;
      $("#temporalVal").textContent = `${e.target.value}%`;
      this.scheduleAutoSave();
    });

    // 播放控制
    $("#btnPlay").addEventListener("click", () => this.togglePlay());
    $("#btnHome").addEventListener("click", () => this.scrub(0));
    this.video.addEventListener("ended", () => {
      this.playing = false;
      $("#btnPlay").textContent = "▶ 播放";
    });

    // 时间段
    $("#btnSplitSeg").addEventListener("click", () => {
      const ns = splitSegment(this.project, this.time);
      if (!ns) return toast("播放头位于时间段边界，无法切分", "error");
      this._maskSig = null;
      this.timeline.setProject(this.project, this.sourceDuration);
      this.maskEditor.drawOverlay();
      toast("已切分时间段，遮罩与参数可独立调整");
      this.scheduleAutoSave();
    });
    $("#btnDelSeg").addEventListener("click", () => {
      const seg = this._currentSeg();
      if (!deleteSegment(this.project, seg.id)) return toast("首个时间段不可删除", "error");
      this._maskSig = null;
      this.timeline.setProject(this.project, this.sourceDuration);
      this.maskEditor.drawOverlay();
      this.scheduleAutoSave();
    });

    // 关键帧
    $("#btnAddKf").addEventListener("click", () => {
      const p = paramsAt(this.project, this.time);
      upsertKeyframe(this.project, this.time, p);
      this.timeline.draw();
      this._syncSliderToTime();
      toast("关键帧已保存");
      this.scheduleAutoSave();
    });
    $("#btnDelKf").addEventListener("click", () => {
      if (!removeKeyframeAt(this.project, this.time)) {
        return toast("该时间段至少保留一个关键帧，或播放头不在关键帧上", "error");
      }
      this.timeline.draw();
      this._syncSliderToTime();
      this.scheduleAutoSave();
    });

    // 右侧 tabs
    $$(".tab").forEach((t) => t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".tab-panel").forEach((p) =>
        p.classList.toggle("active", p.dataset.tab === t.dataset.tab));
    }));

    // 遮罩
    $$("#maskMode .seg").forEach((b) => b.addEventListener("click", () => {
      this.maskMode = b.dataset.mode;
      this.maskEditor.mode = b.dataset.mode;
      $$("#maskMode .seg").forEach((x) => x.classList.toggle("active", x === b));
      this.maskEditor.drawOverlay();
    }));
    $("#brushSize").addEventListener("input", (e) => {
      this.brushSize = Number(e.target.value);
      $("#brushSizeVal").textContent = e.target.value;
      this.maskEditor.drawOverlay();
    });
    $("#maskFeather").addEventListener("input", (e) => {
      this.feather = Number(e.target.value);
      $("#maskFeatherVal").textContent = e.target.value;
      this._maskSig = null; // 羽化改了需要重新栅格化
    });
    $("#btnMaskUndo").addEventListener("click", () => {
      if (this.maskEditor.undo(this._currentSeg())) {
        this._maskSig = null;
        this.scheduleAutoSave();
      }
    });
    $("#btnMaskClear").addEventListener("click", () => {
      if (this.maskEditor.clear(this._currentSeg())) {
        this._maskSig = null;
        this.scheduleAutoSave();
      }
    });

    // 背景
    $$("#bgMode .seg").forEach((b) => b.addEventListener("click", () => {
      $$("#bgMode .seg").forEach((x) => x.classList.toggle("active", x === b));
      const mode = b.dataset.mode;
      this.project.background.mode = mode;
      $("#btnBgFile").disabled = mode === "none";
      if (mode === "none") {
        this.bgImageEl = null; this.bgVideoEl = null;
        this.project.background.dataUrl = null;
        this.project.background.name = "";
        $("#bgFileName").textContent = "";
      } else if (mode === "image" && !this.project.background.dataUrl) {
        // 自动提示可用示例
        toast("可选择本地图片，或在项目菜单载入示例背景");
      }
      this.scheduleAutoSave();
    }));
    $("#btnBgFile").addEventListener("click", async () => {
      // 还没有任何背景时，优先提供与示例短片配套的本地生成背景
      const hasOwn = !!this.project.background.dataUrl;
      if (!hasOwn) {
        const mode = this.project.background.mode;
        const cached = await getCachedSamples();
        const key = mode === "image" ? cached.bgImage : cached.bgVideo;
        if (key || mode === "image") {
          const ok = confirm(
            mode === "image"
              ? "确定使用本地生成的示例背景图吗？（取消则选择自己的文件）"
              : "确定使用本地生成的示例动态背景吗？（取消则选择自己的文件）"
          );
          if (ok) {
            await this.useSampleBackground(mode);
            return;
          }
        }
      }
      $("#fileBg").click();
    });
    $("#fileBg").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) await this.setBackgroundFile(f);
      e.target.value = "";
    });
    $("#bgFit").addEventListener("change", (e) => {
      this.project.background.fit = e.target.value;
      this.scheduleAutoSave();
    });

    // 顶栏
    $("#btnSample").addEventListener("click", () => this.loadSample());
    $("#btnEmptySample").addEventListener("click", () => this.loadSample());
    $("#btnEmptyImport").addEventListener("click", () => $("#fileSrc").click());
    $("#btnImportSrc").addEventListener("click", () => $("#fileSrc").click());
    $("#fileSrc").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) await this.importSourceFile(f);
      e.target.value = "";
    });
    $("#projectName").addEventListener("input", (e) => {
      this.project.name = e.target.value;
      this.scheduleAutoSave();
    });
    this._bindProjectMenu();
    $("#btnExport").addEventListener("click", () => this._openExport());

    // 键盘快捷键
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
      if (e.code === "Space") { e.preventDefault(); this.togglePlay(); }
      if (e.code === "Escape" && this.eyedropActive) this._toggleEyedrop(false);
    });
  }

  // ---------------- 取色器 ----------------
  _toggleEyedrop(force) {
    const turnOn = force === undefined ? !this.eyedropActive : force;
    this.eyedropActive = turnOn;
    $("#btnEyedrop").classList.toggle("btn-primary", turnOn);
    $("#eyedropHint").classList.toggle("hidden", !turnOn);
    $("#maskCanvas").style.pointerEvents = turnOn ? "none" : "auto";
    if (turnOn) {
      const handler = (e) => {
        e.stopPropagation();
        this._pickColorAt(e);
        this._toggleEyedrop(false);
        $("#canvasWrap").removeEventListener("pointerdown", handler, true);
      };
      $("#canvasWrap").addEventListener("pointerdown", handler, true);
    }
  }

  _pickColorAt(e) {
    const v = this.video;
    if (!v.videoWidth) return;
    // 与遮罩画布同一 contain 几何，保证取色坐标与画面一致
    const rect = this.maskEditor.canvas.getBoundingClientRect();
    const fx = clamp((e.clientX - rect.left) / rect.width);
    const fy = clamp((e.clientY - rect.top) / rect.height);
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, fx * v.videoWidth, fy * v.videoHeight, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = rgb01ToHex([r / 255, g / 255, b / 255]);
    this.project.keyColor = hex;
    $("#keyColorPick").value = hex;
    $("#keySwatch").style.background = hex;
    this.scheduleAutoSave();
    toast(`已拾取主色 ${hex}`);
  }

  // ---------------- 项目菜单 ----------------
  _bindProjectMenu() {
    const menu = $("#projectMenu");
    $("#btnProjectMenu").addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("hidden");
    });
    window.addEventListener("pointerdown", () => menu.classList.add("hidden"));
    menu.addEventListener("click", async (e) => {
      const action = e.target.dataset.action;
      if (!action) return;
      menu.classList.add("hidden");
      switch (action) {
        case "save": await this._saveRecord(); break;
        case "export": await this._exportProjectFile(); break;
        case "import": $("#fileProject").click(); break;
        case "list": await this._openProjectList(); break;
        case "new": this._newProject(); break;
      }
    });
    $("#fileProject").addEventListener("change", async (e) => {
      const f = e.target.files[0];
      if (f) await this._importProjectFile(f);
      e.target.value = "";
    });
    $("#btnProjectsClose").addEventListener("click", () =>
      $("#projectsDialog").classList.add("hidden"));
  }

  async _saveRecord() {
    const record = {
      id: this.project._id || uid("proj"),
      name: this.project.name,
      updatedAt: Date.now(),
      data: this.project,
    };
    this.project._id = record.id;
    await saveProjectRecord(record);
    toast("项目已保存到本机浏览器存储", "success");
  }

  async _exportProjectFile() {
    const blob = new Blob([JSON.stringify(this.project, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `${this.project.name || "project"}.gss.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    toast("项目文件已导出（含素材与全部参数）", "success");
  }

  async _importProjectFile(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await this._hydrateProject(data);
      toast("项目已导入", "success");
    } catch (e) {
      toast("项目文件解析失败：" + e.message, "error", 5000);
    }
  }

  async _hydrateProject(data) {
    this.project = data;
    this.project._id = this.project._id || uid("proj");
    $("#projectName").value = this.project.name;
    $("#keyColorPick").value = this.project.keyColor;
    $("#keySwatch").style.background = this.project.keyColor;
    $("#temporal").value = Math.round(this.project.temporal * 100);
    $("#temporalVal").textContent = `${Math.round(this.project.temporal * 100)}%`;
    if (this.project.source?.dataUrl) {
      await this.loadSourceFromDataUrl(this.project.source.dataUrl, this.project.source.name);
    } else if (this.project.source?.sample) {
      const cached = await getCachedSamples();
      if (cached.video) {
        await this.loadSourceFromDataUrl(cached.video.dataUrl, this.project.source.name, true);
      } else {
        toast("示例素材缓存已清空，正在重新生成…");
        await this.loadSample();
      }
    }
    if (this.project.background?.dataUrl) {
      await this._instantiateBackground();
      const mode = this.project.background.mode;
      $$("#bgMode .seg").forEach((x) =>
        x.classList.toggle("active", x.dataset.mode === mode));
      $("#btnBgFile").disabled = mode === "none";
      $("#bgFit").value = this.project.background.fit || "cover";
    }
    this._maskSig = null;
    this.scrub(0);
  }

  async _openProjectList() {
    const records = await listProjectRecords();
    const box = $("#projectList");
    box.innerHTML = "";
    if (!records.length) {
      box.innerHTML = `<p class="hint">还没有保存过项目。</p>`;
    }
    for (const r of records) {
      const item = document.createElement("div");
      item.className = "project-item";
      item.innerHTML = `
        <div class="meta"><b></b><span></span></div>
        <button class="btn btn-small">打开</button>
        <button class="btn btn-small btn-danger">删除</button>`;
      item.querySelector("b").textContent = r.name;
      item.querySelector("span").textContent = new Date(r.updatedAt).toLocaleString();
      const [, openBtn, delBtn] = item.querySelectorAll("button");
      openBtn.addEventListener("click", async () => {
        const rec = await loadProjectRecord(r.id);
        await this._hydrateProject(rec.data);
        $("#projectsDialog").classList.add("hidden");
      });
      delBtn.addEventListener("click", async () => {
        if (!confirm(`删除项目「${r.name}」？`)) return;
        await deleteProjectRecord(r.id);
        this._openProjectList();
      });
      box.appendChild(item);
    }
    $("#projectsDialog").classList.remove("hidden");
  }

  _newProject() {
    if (!confirm("新建空项目？当前未保存的修改会丢失。")) return;
    this.project = createProject();
    this.video.removeAttribute("src");
    this.video.load();
    this.bgImageEl = null; this.bgVideoEl = null;
    $("#emptyState").classList.remove("hidden");
    $("#projectName").value = this.project.name;
    this._maskSig = null;
  }

  scheduleAutoSave() {
    clearTimeout(this._autoSaveTimer);
    this._autoSaveTimer = setTimeout(async () => {
      try {
        await autosaveProject({
          id: this.project._id || uid("proj"),
          name: this.project.name,
          updatedAt: Date.now(),
          data: this.project,
        });
        if (!this.project._id) {
          const rec = await loadAutosave();
          this.project._id = rec.id;
        }
      } catch (e) { console.warn("自动保存失败", e); }
    }, 800);
  }

  async _restoreAutosave() {
    const rec = await loadAutosave();
    // dataUrl 型源体积大，若存储被清理则不恢复，避免半残状态
    if (rec?.data?.segments && (rec.data.source?.sample || rec.data.source?.dataUrl)) {
      this._hydrateProject(rec.data).catch((e) => console.warn("恢复项目失败", e));
    }
  }

  // 导出用：按时间段栅格化遮罩并缓存（同一时间段的帧复用结果）
  _maskForExport(t) {
    const w = this.video.videoWidth, h = this.video.videoHeight;
    const seg = segmentAt(this.project, t);
    const sig = `${seg.id}:${seg.masks.length}:${w}x${h}:` +
      seg.masks.map((m) => `${m.points.length}/${m.feather}/${m.mode}`).join(",");
    if (!this._exportMaskCache) this._exportMaskCache = new Map();
    if (!this._exportMaskCache.has(sig)) {
      this._exportMaskCache.set(sig, this.maskEditor.rasterize(seg, w, h));
    }
    return this._exportMaskCache.get(sig);
  }

  // ---------------- 导出 ----------------
  _openExport() {
    if (!this.video.src) return toast("请先载入源视频", "error");
    $("#exportDialog").classList.remove("hidden");
    const updateHint = () => {
      const fmt = $("input[name=expFmt]:checked").value;
      const hints = {
        pngseq: "逐帧渲染为带 alpha 通道的 PNG，打包成 zip，可直接导入 PR/AE/剪映。",
        alpha: "输出带透明通道的 WebM（Chrome/Edge 支持 VP8/VP9 alpha；Safari 不支持时请选 PNG 序列）。",
        composite: "把前景合成到当前替换背景后输出；背景为视频时按时间轴对齐。",
      };
      $("#expHint").textContent = hints[fmt];
    };
    $$("input[name=expFmt]").forEach((r) => r.addEventListener("change", updateHint));
    updateHint();

    $("#btnExpStart").onclick = () => this._runExport();
    $("#btnExpClose").onclick = () => {
      $("#exportDialog").classList.add("hidden");
    };
  }

  async _runExport() {
    const fmt = $("input[name=expFmt]:checked").value;
    const fps = Number($("#expFps").value);
    const scale = Number($("#expScale").value);
    const useTemporal = $("#expTemporal").checked;
    const wrap = $("#expProgressWrap");
    wrap.classList.remove("hidden");
    const prog = $("#expProgress"), txt = $("#expProgressText");
    $("#btnExpStart").disabled = true;
    $("#btnExpCancel").classList.remove("hidden");

    const onProgress = (p, msg) => {
      prog.value = Math.round(p * 100);
      txt.textContent = msg;
    };
    const exporter = new Exporter({
      renderer: this.renderer,
      video: this.video,
      bgElement: this._bgElement(),
      project: this.project,
      duration: this.sourceDuration,
      getFrameOpts: (t, mode) => ({
        mode: mode || this.viewMode,
        params: paramsAt(this.project, t),
        keyColor: this.project.keyColor,
        temporal: this.project.temporal,
        maskCanvas: this._maskForExport(t),
        bgFit: this.project.background.fit,
        time: t,
      }),
    });
    $("#btnExpCancel").onclick = () => exporter.cancel();
    this.exporting = true;
    this._exportMaskCache = null;

    try {
      if (fmt === "pngseq") {
        await exporter.exportPngSequence({ fps, scale, useTemporal, onProgress });
      } else {
        await exporter.exportVideo({
          fps, scale, useTemporal, alpha: fmt === "alpha", onProgress,
        });
      }
      if (!exporter.cancelled) toast("导出完成", "success", 4000);
    } catch (e) {
      console.error(e);
      toast("导出失败：" + e.message, "error", 5000);
    } finally {
      this.exporting = false;
      this._exportMaskCache = null;
      $("#btnExpStart").disabled = false;
      $("#btnExpCancel").classList.add("hidden");
      wrap.classList.add("hidden");
      this._maskSig = null; // 导出期间改过 mask 缓存状态，强制刷新
      this.renderer.resetTemporal();
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  try {
    window.app = new App();
  } catch (e) {
    console.error(e);
    toast("初始化失败：" + e.message, "error", 8000);
  }
});
