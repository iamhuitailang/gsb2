/*
 * 应用层：两个 ViewerPanel、共享时钟、同步总线、扫掠测试、
 * manifest 导入/导出、localStorage 持久化与主渲染循环。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'multi-angle-viewer/v1';
  const deepClone = (v) => JSON.parse(JSON.stringify(v));
  const $ = (id) => document.getElementById(id);

  /* ---------------- 共享时钟 ---------------- */

  const clock = {
    ms: 0,
    last: performance.now(),
    playing: true,
    actionId: ExampleData.ACTIONS[0].id,
    getMs() { return this.ms; },
    setMs(from, v) {
      this.ms = Math.max(0, v);
      if (syncEnabled()) bus.broadcast(from, 'ms', this.ms);
    },
    getPlaying() { return this.playing; },
    setPlaying(from, v) {
      this.playing = v;
      if (syncEnabled()) bus.broadcast(from, 'playing', v);
    },
    getActionId() { return this.actionId; },
    setActionId(from, id) {
      this.actionId = id;
      this.ms = 0;
      if (syncEnabled()) bus.broadcast(from, 'action', id);
    },
  };

  function syncEnabled() {
    return $('chk-sync').checked;
  }

  /* ---------------- 数据集仓库（含导入的 manifest） ---------------- */

  const datasets = ExampleData.datasets.map(deepClone);
  const imageCache = new Map();

  const bus = {
    listDatasets: () => datasets,
    getDatasetById(id) {
      const found = datasets.find((d) => d.id === id);
      return found || datasets[0];
    },
    addDataset(dataset) {
      const existing = datasets.findIndex((d) => d.id === dataset.id);
      if (existing >= 0) datasets[existing] = dataset;
      else datasets.push(dataset);
      rebuildDatasetSelects();
    },
    loadImageCanvas(source, w, h) {
      if (imageCache.has(source)) return imageCache.get(source);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(0, 0, w, h);
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, w, h);
      img.onerror = () => {
        ctx.strokeStyle = '#f87171';
        ctx.strokeRect(2, 2, w - 4, h - 4);
        ctx.fillStyle = '#f87171';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('图片加载失败: ' + source, w / 2, h / 2);
      };
      img.src = source;
      imageCache.set(source, c);
      return c;
    },
    emit(from, type, value) {
      if (!syncEnabled()) return;
      bus.broadcast(from, type, value);
    },
    broadcast(from, type, value) {
      for (const p of panels) {
        if (p.tag === from) continue;
        if (type === 'camera') p.receiveCamera(value);
        else if (type === 'ms') {
          // ms 由时钟统一驱动，这里仅用于未来扩展
        }
      }
    },
    exportPanel(panel) {
      const json = Exporter.toJSON(panel.dataset, panel.state.mirror, true);
      download(`${panel.dataset.id}.config.json`, json);
      toast(`已导出 ${panel.state.label} 的配置（${panel.dataset.name}）`);
    },
    persistPanel(tag, datasetId, state, dataset) {
      const store = loadStore();
      // 只持久化与默认值不同的帧覆盖项，避免把整个程序化数据塞进 localStorage
      const overrides = {};
      for (const seq of Object.values(dataset.sequences)) {
        for (const f of seq.frames) {
          const def = dataset.defaultAnchor;
          if (f.anchorX !== def.x || f.anchorY !== def.y) {
            overrides[f.id] = { anchorX: f.anchorX, anchorY: f.anchorY };
          }
          const base = ExampleData.datasets.find((d) => d.id === datasetId);
          const baseFrame = base && base.sequences[seq.actionId + ':' + seq.directionId]
            && base.sequences[seq.actionId + ':' + seq.directionId].frames.find((x) => x.id === f.id);
          if (baseFrame && f.duration !== baseFrame.duration) {
            overrides[f.id] = Object.assign(overrides[f.id] || {}, { duration: f.duration });
          }
        }
      }
      store.panels[tag] = {
        datasetId,
        label: state.label,
        camera: state.camera,
        mirror: state.mirror,
        alignAnchors: state.alignAnchors,
        transitionMode: state.transitionMode,
        overrides,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    },
  };

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { panels: {} };
    } catch {
      return { panels: {} };
    }
  }

  function applyOverrides(dataset, overrides) {
    if (!overrides) return;
    for (const seq of Object.values(dataset.sequences)) {
      for (const f of seq.frames) {
        const o = overrides[f.id];
        if (!o) continue;
        if (o.anchorX != null) f.anchorX = o.anchorX;
        if (o.anchorY != null) f.anchorY = o.anchorY;
        if (o.duration != null) f.duration = o.duration;
      }
    }
  }

  /* ---------------- 面板初始化 ---------------- */

  const store = loadStore();
  function initialDataset(tag, fallbackIndex) {
    const saved = store.panels[tag];
    const id = saved && saved.datasetId;
    const base = id && datasets.find((d) => d.id === id);
    const dataset = deepClone(base || datasets[fallbackIndex]);
    if (saved) applyOverrides(dataset, saved.overrides);
    return dataset;
  }

  const panels = [
    (window.__panelA = new ViewerPanel($('panel-a-root'), {
      tag: 'A', bus, clock,
      dataset: initialDataset('A', 0),
      persisted: store.panels.A,
    })),
    (window.__panelB = new ViewerPanel($('panel-b-root'), {
      tag: 'B', bus, clock,
      dataset: initialDataset('B', 1),
      persisted: store.panels.B,
    })),
  ];

  function rebuildDatasetSelects() {
    for (const p of panels) {
      const current = p.dataset.id;
      p.datasetSelect.innerHTML = '';
      for (const d of datasets) {
        const o = document.createElement('option');
        o.value = d.id;
        o.textContent = d.name;
        p.datasetSelect.appendChild(o);
      }
      p.datasetSelect.value = current;
    }
  }

  /* ---------------- 全局控件 ---------------- */

  const actionSelect = $('global-action');
  for (const a of ExampleData.ACTIONS) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.name;
    actionSelect.appendChild(o);
  }
  actionSelect.value = clock.actionId;
  actionSelect.addEventListener('change', () => clock.setActionId('global', actionSelect.value));

  const playBtn = $('btn-play');
  playBtn.addEventListener('click', () => {
    clock.setPlaying('global', !clock.playing);
    playBtn.textContent = clock.playing ? '⏸ 暂停' : '▶ 播放';
  });

  $('chk-sync').addEventListener('change', () => {
    for (const p of panels) p.root.classList.toggle('synced', $('chk-sync').checked);
  });
  for (const p of panels) p.root.classList.add('synced');

  /* ---------------- 整圈扫掠测试 ---------------- */

  let sweeping = null;
  $('btn-sweep').addEventListener('click', () => {
    if (sweeping) return;
    const start = performance.now();
    const duration = 3000;
    const startAngle = panels[0].state.camera;
    const trace = [];
    let lastId = null;
    sweeping = { start };
    toast('扫掠中：镜头顺时针转一整圈…');
    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const angle = Angle.norm(startAngle + t * 360);
      for (const p of panels) p.setCamera(angle, false);
      const id = Angle.selectDirection(ExampleData.DIRECTIONS, angle).id;
      if (id !== lastId) {
        trace.push({ angle: Math.round(angle), id });
        lastId = id;
      }
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        sweeping = null;
        const order = trace.map((x) => x.id).join(' → ');
        const ok = trace.length === 9 && trace[0].id === trace[trace.length - 1].id;
        toast(`${ok ? '✓' : '✗'} 扫掠完成：${trace.length - 1} 次切换，首尾均为 ${trace[0].id}（${order}）`);
      }
    }
    requestAnimationFrame(step);
  });

  /* ---------------- 导出 / 导入 ---------------- */

  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('btn-export-all').addEventListener('click', () => {
    const payload = {
      format: Exporter.FORMAT,
      exportedAt: new Date().toISOString(),
      examples: datasets.map((d) => {
        const mirrorOn = Exporter.buildConfig(d, true);
        const mirrorOff = Exporter.buildConfig(d, false);
        return {
          id: d.id, name: d.name, description: d.description,
          withMirrorFallback: mirrorOn,
          withoutMirrorFallback: mirrorOff,
        };
      }),
    };
    download('all-examples.config.json', JSON.stringify(payload, null, 2));
    toast('已导出全部数据集（含镜像开/关两份配置）');
  });

  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const configs = json.examples
        ? json.examples.map((x) => x.withMirrorFallback)
        : [json];
      for (const cfg of configs) {
        const ds = Exporter.parseConfig(cfg);
        ds.palette = {
          body: '#0f766e', bodyBack: '#115e59', hood: '#0d9488', pants: '#334155',
          shoe: '#111827', skin: '#e8b890', glove: '#dc2626', arrow: '#0d9488',
        };
        bus.addDataset(ds);
      }
      rebuildDatasetSelects();
      toast(`已导入 ${configs.length} 个 manifest，可在面板下拉中选择`);
    } catch (err) {
      toast('导入失败：' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  /* ---------------- 自检徽标 ---------------- */

  const badge = $('selftest-badge');
  const st = SelfTest.runAll();
  badge.className = 'selftest ' + (st.passed === st.total ? 'pass' : 'fail');
  badge.textContent = st.passed === st.total
    ? `自检 ${st.passed}/${st.total} 通过`
    : `自检失败 ${st.passed}/${st.total}（见控制台）`;
  if (st.passed !== st.total) {
    for (const r of st.results) {
      if (!r.pass) console.error('[selftest]', r.name, r.detail);
    }
  }

  /* ---------------- 主循环 ---------------- */

  function frame(now) {
    const dt = now - clock.last;
    clock.last = now;
    if (clock.playing && !sweeping) clock.ms += dt;
    for (const p of panels) p.render(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------------- Toast ---------------- */

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
})();
