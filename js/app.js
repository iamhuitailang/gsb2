/* 界面装配：精度/模式联动、双预览、误差与字节统计、接缝定位、二进制导入导出与复现校验。 */
(function (global) {
  const MPC = global.MPC;
  const { formatBytes, formatNum } = MPC.util;

  const state = {
    seed: 20261125,
    scene: null,
    bits: 12,
    mode: 'global',
    threshold: 0.01,
    exaggerate: 0,
    viewMode: 'block',
    showSeams: true,
    showT: true,
    currentPack: null,     // 当前选中精度/模式下的 pack 结果
    imported: null,        // 读回的二进制数据
    verify: null,          // 复现校验结果
    sourceLabel: '程序生成',
  };

  const $ = (id) => document.getElementById(id);

  function init() {
    buildControls();
    regenerate();
    bindImportExport();
    requestAnimationFrame(frame);
  }

  function buildControls() {
    const bitsEl = $('bits');
    MPC.quantize.PRECISION_LEVELS.forEach(p => {
      const o = document.createElement('option');
      o.value = p.bits; o.textContent = p.label;
      bitsEl.appendChild(o);
    });
    bitsEl.value = String(state.bits);
    bitsEl.addEventListener('change', () => { state.bits = parseInt(bitsEl.value, 10); recompute(); });

    const modeEl = $('mode');
    MPC.quantize.RANGE_MODES.forEach(m => {
      const o = document.createElement('option');
      o.value = m.id; o.textContent = m.label;
      modeEl.appendChild(o);
    });
    modeEl.addEventListener('change', () => { state.mode = modeEl.value; recompute(); });

    $('threshold').addEventListener('input', (e) => {
      state.threshold = parseFloat(e.target.value);
      $('thresholdVal').textContent = formatNum(state.threshold, 4) + ' m';
      recompute();
    });
    $('exaggerate').addEventListener('input', (e) => {
      state.exaggerate = parseInt(e.target.value, 10);
      $('exaggerateVal').textContent = state.exaggerate === 0 ? '关' : '×' + state.exaggerate;
      syncViewOptions();
    });
    $('viewMode').addEventListener('change', (e) => { state.viewMode = e.target.value; syncViewOptions(); });
    $('showSeams').addEventListener('change', (e) => { state.showSeams = e.target.checked; syncViewOptions(); });
    $('showT').addEventListener('change', (e) => { state.showT = e.target.checked; syncViewOptions(); });
    $('seedBtn').addEventListener('click', () => {
      const v = parseInt($('seedInput').value, 10);
      if (Number.isFinite(v)) { state.seed = v >>> 0; regenerate(); }
    });
    $('regenBtn').addEventListener('click', () => {
      state.seed = (Math.random() * 0xffffffff) >>> 0;
      $('seedInput').value = state.seed;
      regenerate();
    });
  }

  function regenerate() {
    $('seedInput').value = state.seed;
    state.scene = MPC.meshgen.generateScene(state.seed);
    state.imported = null; state.verify = null;
    state.sourceLabel = '程序生成（种子 ' + state.seed + '）';
    $('sourceBadge').textContent = state.sourceLabel;
    $('fileStatus').className = 'status idle';
    $('fileStatus').textContent = '当前为程序生成数据，尚未读回文件。';
    recompute();
  }

  function recompute() {
    state.currentPack = MPC.quantize.packScene(state.scene, state.mode, state.bits, state.threshold);
    refreshStats();
    syncViewOptions();
  }

  function syncViewOptions() {
    for (const v of [viewOrig, viewRest]) {
      v.mode = state.viewMode;
      v.exaggerate = state.exaggerate;
      v.showSeams = state.showSeams;
      v.showTJunctions = state.showT;
      v.heatMax = Math.max(state.currentPack.overall.max * 1.05, 1e-9);
      v.dirty = true;
    }
  }

  let viewOrig, viewRest, camOrig, camRest;
  function frame() {
    if (viewOrig && viewOrig.dirty) viewOrig.draw(state.scene, null);
    if (viewRest && viewRest.dirty) viewRest.draw(state.scene, state.currentPack);
    requestAnimationFrame(frame);
  }

  // ---------------- 统计面板 ----------------
  function refreshStats() {
    const pack = state.currentPack;
    const acc = MPC.binary.byteAccounting(state.scene, pack);

    $('summaryHead').innerHTML =
      `<span class="chip">${state.bits} 位/轴</span>` +
      `<span class="chip">${MPC.quantize.RANGE_MODES.find(m => m.id === state.mode).label}</span>` +
      `<span class="chip">裂缝阈值 ${formatNum(state.threshold, 4)} m</span>`;

    // 总览误差
    const ov = pack.overall;
    $('overallErrors').innerHTML = `
      <tr><td>所有顶点（${ov.vertexCount} 个）</td>
      <td>${formatNum(ov.max)}</td><td>${formatNum(ov.mean)}</td><td>${formatNum(ov.rms)}</td></tr>`;

    // 每块误差 + 范围
    const rows = pack.qBlocks.map((qb, i) => {
      const e = pack.errors[i];
      const r = qb.range;
      const span = `x ${formatNum(r.maxX - r.minX, 2)} / y ${formatNum(r.maxY - r.minY, 2)} / z ${formatNum(r.maxZ - r.minZ, 2)}`;
      const steps = ['X', 'Y', 'Z'].map(a => formatNum(MPC.quantize.rangeStep(r, a, state.bits), 5)).join(', ');
      return `<tr>
        <td><span class="dot" style="background:rgb(${MPC.render.BLOCK_COLORS[i].map(c => Math.round(c * 255)).join(',')})"></span>${qb.name}</td>
        <td class="num">${qb.positions.length / 3}</td>
        <td class="num">${formatNum(e.max)}</td>
        <td class="num">${formatNum(e.rms)}</td>
        <td class="num small">${span}<br>步长 ${steps}</td>
      </tr>`;
    }).join('');
    $('blockRows').innerHTML = rows;

    // 字节构成
    $('byteRows').innerHTML = [
      ['紧凑位置码（' + state.bits + ' 位打包）', acc.codeBytes, true],
      ['对照：f32 原始位置', acc.f32PosOnly, false],
      ['UV 坐标（f32）', acc.uvBytes, false],
      ['索引（' + (state.scene.blocks.some(b => b.indices.length > 0xffff) ? 'u32' : 'u16') + '）', acc.indexBytes, false],
      ['范围/模式元数据', acc.rangeBytes, false],
      ['接缝表', acc.seamBytes, false],
      ['UV 贴图边界表', acc.uvSeamBytes, false],
      ['文件头/CRC', acc.fixed, false],
    ].map(([label, n, hl]) => `<tr class="${hl ? 'hl' : ''}"><td>${label}</td><td class="num">${formatBytes(n)}</td><td class="num">${n}</td></tr>`).join('');
    $('byteTotal').textContent = formatBytes(acc.total) + '（' + acc.total + ' 字节）';
    $('byteSaved').textContent = `位置部分 f32→${state.bits} 位节省 ${formatBytes(acc.packedVsF32)}（${(acc.packedVsF32 / acc.f32PosOnly * 100).toFixed(1)}%）`;

    // 接缝
    const seamHtml = pack.seamReport.seams.map(s => {
      const worstTxt = s.worst ? `z=${formatNum(s.worst.pair.z, 2)} m` : '—';
      const status = s.maxGap > state.threshold
        ? `<span class="bad">超阈值 ${s.overThreshold}/${s.pairCount} 对</span>`
        : `<span class="ok">未超阈值</span>`;
      return `<tr>
        <td>${s.name}<div class="small muted">${s.axis}，块 ${s.blockA} ↔ 块 ${s.blockB}</div></td>
        <td class="num">${s.pairCount} + ${s.extraCount} T接</td>
        <td class="num">${formatNum(s.maxGap, 6)}</td>
        <td class="num">${formatNum(s.maxTGap, 6)}<div class="small muted">基线 ${formatNum(s.worstT ? s.worstT.baseline : 0, 4)} · 量化增量 ${formatNum(s.maxTGapDelta, 6)}</div></td>
        <td class="num">${formatNum(s.meanGap, 6)}</td>
        <td>${status}<div class="small muted">最差点 ${worstTxt}</div></td>
        <td><button class="mini" data-seam="${s.id}">定位</button></td>
      </tr>`;
    }).join('');
    $('seamRows').innerHTML = seamHtml;
    document.querySelectorAll('button[data-seam]').forEach(btn => {
      btn.addEventListener('click', () => focusSeam(btn.dataset.seam));
    });

    // UV 贴图边界健康检查（明确区别于裂缝）
    $('uvRows').innerHTML = pack.seamReport.uvChecks.map(u => `
      <tr><td>${u.blockName} 内贴图边界</td>
      <td class="num">${u.count} 对复制顶点</td>
      <td class="num">${formatNum(u.maxCopyDistance, 6)}</td>
      <td>${u.maxCopyDistance === 0
        ? '<span class="ok">位置完全一致，仅 UV 不同 —— 不计为裂缝</span>'
        : '<span class="warn">复制顶点出现位置差，需排查</span>'}</td></tr>`).join('');

    // 模式说明（接缝对齐时说明改了哪些块）
    $('modeNotes').innerHTML = pack.notes.map(n => {
      const b = state.scene.blocks[n.blockId];
      return `<div class="note"><b>${b.name}</b>：${n.text}</div>`;
    }).join('');
    if (state.mode === 'aligned') {
      const comps = pack.components.map(c => c.map(i => state.scene.blocks[i].name).join(' + ')).join('；');
      $('alignedBanner').style.display = '';
      $('alignedBanner').innerHTML = '接缝连通分量：<b>' + comps +
        '</b>。同分量块共用一个量化范围，接边上相同坐标必产生相同整数码，因此几何接缝错位恒为 0；独立块不受牵连。';
    } else {
      $('alignedBanner').style.display = 'none';
    }
  }

  // ---------------- 接缝定位 ----------------
  function focusSeam(seamId) {
    const seam = state.scene.seams.find(s => s.id === seamId);
    const rep = state.currentPack.seamReport.seams.find(s => s.id === seamId);
    const target = rep.worst ? rep.worst.pointA : seam.pairs[0] && [seam.pairs[0].x, seam.pairs[0].y, seam.pairs[0].z];
    if (!target) return;
    for (const cam of [camOrig, camRest]) {
      cam.target = [target[0], target[1], target[2]];
      cam.dist = 3;
    }
    viewOrig.dirty = true; viewRest.dirty = true;
    flash('已定位到 ' + seam.name + ' 最大错位点（红圈），两个视图同步放大；可再用"错位夸大"观察。');
  }

  // ---------------- 导入/导出 ----------------
  function bindImportExport() {
    $('exportBtn').addEventListener('click', doExport);
    $('importFile').addEventListener('change', doImport);
    $('importCorrupt').addEventListener('click', testCorrupt);
  }

  function doExport() {
    // 导出内容：原始 f32 参考位置 + 当前参数下的紧凑码 + 接缝 + 范围
    const bytes = MPC.binary.encode(state.scene, state.currentPack, { threshold: state.threshold });
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `meshpack-v1-seed${state.seed}-${state.mode}-${state.bits}bit.bin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    flash('已导出 v1 二进制（' + formatBytes(bytes.length) + '），含 CRC32 校验。');
  }

  async function doImport(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    let decoded;
    try {
      decoded = MPC.binary.decode(buf);
    } catch (err) {
      handleDecodeError(err);
      e.target.value = '';
      return;
    }
    applyImport(decoded, file.name, buf.length);
    e.target.value = '';
  }

  const BLOCK_DISPLAY_NAMES = ['A 粗块', 'B 细条', 'C 小块', 'D 独立块'];

  function applyImport(decoded, name, fileSize) {
    const { scene, mode, bits, threshold, codesPerBlock, warnings, storeRestored } = decoded;
    // 恢复网格名称（文件中只存了编号）
    scene.blocks.forEach((b, i) => { b.name = BLOCK_DISPLAY_NAMES[i] || ('块' + i); });
    // 复现校验：用种子重新生成，逐顶点比对；再按文件参数重新量化比对码与还原值
    const verify = verifyRoundtrip(scene, mode, bits, codesPerBlock);
    state.imported = decoded;
    state.verify = verify;
    state.scene = scene;
    state.mode = mode; state.bits = bits; state.threshold = threshold;
    $('mode').value = mode; $('bits').value = String(bits);
    $('threshold').value = threshold; $('thresholdVal').textContent = formatNum(threshold, 4) + ' m';
    state.sourceLabel = '读回文件 ' + name;
    $('sourceBadge').textContent = state.sourceLabel;

    const allWarn = [...warnings, ...verify.warnings];
    const el = $('fileStatus');
    if (allWarn.length) {
      el.className = 'status warn';
      el.innerHTML = '读回完成但有提示：<ul>' + allWarn.map(w => `<li>${escapeHtml(w)}</li>`).join('') + '</ul>预览与误差仍基于文件内容正常显示。';
    } else {
      el.className = 'status ok';
      el.innerHTML = `读回成功：v${MPC.binary.FORMAT_VERSION}，${formatBytes(fileSize)}，` +
        `存储的是${storeRestored ? '还原后位置' : '原始位置参考'}。复现校验全部通过：种子重建逐顶点一致、重算量化码一致、接缝错位复现一致。`;
    }
    $('verifyBox').innerHTML = renderVerify(verify);
    recompute();
    flash('文件已读回，预览与误差计算基于二进制内容复现。');
  }

  function verifyRoundtrip(importedScene, mode, bits, importedCodes) {
    const warnings = [];
    const regen = MPC.meshgen.generateScene(importedScene.seed);
    let posMismatch = 0, codeMismatch = 0, totalCodes = 0;
    if (regen.blocks.length !== importedScene.blocks.length) {
      warnings.push('块数量与同种子重新生成的场景不一致。');
    }
    const n = Math.min(regen.blocks.length, importedScene.blocks.length);
    for (let i = 0; i < n; i++) {
      const a = regen.blocks[i].positions, b = importedScene.blocks[i].positions;
      const len = Math.min(a.length, b.length);
      for (let k = 0; k < len; k++) if (a[k] !== b[k]) posMismatch++;
      if (a.length !== b.length) warnings.push('块 ' + i + ' 顶点数与重新生成结果不同。');
    }
    // 按文件参数重新量化重新生成的场景，比对整数码
    const repack = MPC.quantize.packScene(regen, mode, bits, 0);
    for (let i = 0; i < n; i++) {
      const a = repack.qBlocks[i].codes, b = importedCodes[i];
      const len = Math.min(a.length, b.length);
      totalCodes += len;
      for (let k = 0; k < len; k++) if (a[k] !== b[k]) codeMismatch++;
    }
    // 接缝错位复现：直接用文件内场景 + 重算 pack 的最大错位
    const repackImported = MPC.quantize.packScene(importedScene, mode, bits, 0);
    const gap = repackImported.seamReport.globalMaxGap;

    if (posMismatch === 0 && codeMismatch === 0) {
      return { ok: true, posMismatch, codeMismatch, totalCodes, gap, warnings };
    }
    if (posMismatch > 0) warnings.push(posMismatch + ' 个位置分量与同种子重建结果不一致（f32 级别）。');
    if (codeMismatch > 0) warnings.push(codeMismatch + '/' + totalCodes + ' 个量化码无法复现。');
    return { ok: false, posMismatch, codeMismatch, totalCodes, gap, warnings };
  }

  function renderVerify(v) {
    const rows = [
      ['种子重建顶点位置', v.posMismatch === 0 ? '逐分量一致 ✓' : v.posMismatch + ' 处不一致 ✗'],
      ['量化码复现', v.codeMismatch === 0 ? v.totalCodes + ' 个码全部一致 ✓' : v.codeMismatch + '/' + v.totalCodes + ' 不一致 ✗'],
      ['接缝最大错位（重算）', formatNum(v.gap, 6) + ' m'],
    ];
    return '<table class="verify"><tbody>' + rows.map(([k, val]) =>
      `<tr><td>${k}</td><td>${val}</td></tr>`).join('') + '</tbody></table>';
  }

  // 构造一个被截断的文件，演示不完整文件的具体提示
  async function testCorrupt() {
    const bytes = MPC.binary.encode(state.scene, state.currentPack, { threshold: state.threshold });
    const cut = Math.floor(bytes.length * 0.55);
    const truncated = bytes.slice(0, cut);
    let decoded;
    try {
      decoded = MPC.binary.decode(truncated);
    } catch (err) {
      handleDecodeError(err);
      return;
    }
    // CRC 不匹配但结构完整的情况
    applyImport(decoded, '模拟截断文件.bin', truncated.length);
  }

  function handleDecodeError(err) {
    const el = $('fileStatus');
    el.className = 'status error';
    const detail = err.offset != null ? err.offset : '?';
    el.innerHTML = `文件未能载入：<b>${escapeHtml(err.message)}</b><br>
      <span class="muted">错误类型 ${err.name}，偏移 ${detail}。当前程序生成的预览与误差面板保持不变，可继续查看。</span>`;
    flash('读取失败：' + err.message);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  let flashTimer = null;
  function flash(msg) {
    const el = $('toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  // 启动（DOM 就绪后）
  function boot() {
    const c1 = $('canvasOrig'), c2 = $('canvasRest');
    camOrig = new MPC.render.OrbitCamera();
    camRest = new MPC.render.OrbitCamera();
    viewOrig = new MPC.render.MeshView(c1, camOrig);
    viewRest = new MPC.render.MeshView(c2, camRest);
    // 两个视图相机同步：任一视图操作后镜像参数
    const sync = () => {
      camRest.yaw = camOrig.yaw; camRest.pitch = camOrig.pitch;
      camRest.dist = camOrig.dist; camRest.target = camOrig.target.slice();
      viewOrig.dirty = true; viewRest.dirty = true;
    };
    for (const c of [c1, c2]) {
      c.addEventListener('pointerup', sync);
      c.addEventListener('wheel', sync, { passive: true });
    }
    init();
  }
  global.addEventListener('DOMContentLoaded', boot);
  global.MPC_APP = { state, verifyRoundtrip };
})(typeof globalThis !== 'undefined' ? globalThis : this);
