/* 主应用：状态、渲染、分配联动、同步对照、导出 */
(function () {
  'use strict';

  const { formatBytes, escapeHtml, clamp, uid, downloadBlob, createAsyncLock,
    progressModal, alertModal, modal } = Util;

  const state = {
    items: [],
    selectedItemId: null,
    plan: null,
    budget: 200 * 1024,
    webpSupported: true,
    bgMode: 'checker',
    viewport: null,
    candidateToken: 0
  };
  const encodeLock = createAsyncLock();
  let exporting = false;

  const $ = (id) => document.getElementById(id);

  /* =========================================================
   * 初始化
   * ========================================================= */
  async function init() {
    parseFailRules();
    state.webpSupported = await ImgEncoding.detectWebp();
    if (!state.webpSupported) {
      alertModal('浏览器不支持 WebP',
        '当前浏览器无法编码 WebP，候选将只剩 PNG，演示效果受限。建议使用最新版 Chrome/Edge。');
    }
    bindEvents();
    renderAll();
  }

  function parseFailRules() {
    const p = new URLSearchParams(location.search);
    const fail = p.get('fail');
    const failAll = p.get('failall');
    if (fail) ImgEncoding.failRules.webp.push(fail);
    if (failAll) ImgEncoding.failRules.all.push(failAll);
  }

  function bindEvents() {
    $('btn-import').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', onImportFiles);
    $('btn-samples').addEventListener('click', () => loadSamples());
    $('budget').addEventListener('input', onBudgetChange);
    $('btn-tight').addEventListener('click', () => applyScenario('tight'));
    $('btn-normal').addEventListener('click', () => applyScenario('normal'));
    $('btn-unlock').addEventListener('click', unlockAll);
    $('btn-export').addEventListener('click', exportBundle);

    $('cfg-priority').addEventListener('change', (e) => updateConfig('priority', e.target.value));
    $('cfg-minw').addEventListener('change', (e) => updateConfig('minW', parseInt(e.target.value, 10)));
    $('cfg-minh').addEventListener('change', (e) => updateConfig('minH', parseInt(e.target.value, 10)));
    $('cfg-alpha').addEventListener('change', (e) => updateConfig('keepAlpha', e.target.checked));
    $('cfg-remove').addEventListener('click', removeSelected);

    document.querySelectorAll('.cmp-controls [data-zoom]').forEach((btn) => {
      btn.addEventListener('click', () => state.viewport && state.viewport.setZoomMode(btn.dataset.zoom));
    });
    document.querySelectorAll('.cmp-controls [data-bg]').forEach((btn) => {
      btn.addEventListener('click', () => setBgMode(btn.dataset.bg));
    });
    window.addEventListener('resize', () => state.viewport && state.viewport.rerender());
  }

  /* =========================================================
   * 导入 / 示例
   * ========================================================= */
  async function onImportFiles(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const pm = progressModal('导入图片');
    try {
      const added = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        pm.set('解码 ' + file.name + '（' + (i + 1) + '/' + files.length + '）', i / files.length);
        try {
          const img = await ImgEncoding.loadImageFile(file);
          const canvas = ImgEncoding.imageToCanvas(img);
          added.push({
            id: uid('img'),
            name: file.name,
            sourceCanvas: canvas,
            width: canvas.width,
            height: canvas.height,
            hasAlpha: ImgEncoding.canvasHasAlpha(canvas),
            priority: 'mid',
            keepAlpha: false,
            minW: Math.max(1, Math.round(canvas.width * 0.5)),
            minH: Math.max(1, Math.round(canvas.height * 0.5)),
            sample: false,
            candidates: [],
            lockedPickId: null,
            encoding: false
          });
        } catch (err) {
          alertModal('导入失败', file.name + '：' + err.message);
        }
      }
      if (added.length) {
        state.items.push(...added);
        state.selectedItemId = added[0].id;
        pm.set('生成压缩候选…', 1);
        await encodeAllItems(added);
      }
    } finally {
      pm.close();
    }
  }

  async function loadSamples() {
    if (state.items.length && !confirm('载入示例将清空当前列表，是否继续？')) return;
    state.items = Samples.buildSampleItems();
    state.selectedItemId = state.items[0].id;
    state.plan = null;
    renderAll();
    const pm = progressModal('生成示例压缩候选');
    try {
      await encodeAllItems(state.items, (msg, r) => pm.set(msg, r));
      // 载入示例后默认给一个正常预算并自动出方案
      applyScenario('normal');
    } finally {
      pm.close();
    }
  }

  /** 为缺少候选的图片编码；最多 2 路并行，避免大画布同时占内存 */
  async function encodeAllItems(items, outerProgress) {
    const queue = items.filter((it) => !it.candidates.length && !it.encoding);
    if (!queue.length) return;
    const token = ++state.candidateToken;
    const myToken = token;
    let finished = 0;

    async function worker(item) {
      item.encoding = true;
      renderItemList();
      renderCandidates(item);
      try {
        const cands = await ImgEncoding.buildCandidates(item, (done, total, label) => {
          if (myToken !== state.candidateToken) return;
          if (outerProgress) {
            outerProgress(item.name + '：' + label + '（' + done + '/' + total + '）',
              (finished + done / total) / queue.length);
          } else if (state.selectedItemId === item.id) {
            $('cand-progress').textContent = '编码中 ' + done + '/' + total + ' · ' + label;
          }
        });
        item.candidates = cands;
      } catch (err) {
        item.candidates = [];
        alertModal('候选生成失败', item.name + '：' + err.message);
      } finally {
        item.encoding = false;
        finished++;
        if (myToken === state.candidateToken) {
          renderItemList();
          if (state.selectedItemId === item.id) renderCandidates(item);
          runAllocation();
        }
      }
    }

    const runners = [0, 1].map(async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) break;
        // 再包一层兜底，任何意外异常都不产生未处理 Promise 拒绝
        await encodeLock(() => worker(item).catch((err) =>
          alertModal('编码任务异常', item.name + '：' + err.message)));
      }
    });
    await Promise.all(runners);
  }

  /* =========================================================
   * 预算与分配
   * ========================================================= */
  function onBudgetChange(e) {
    const v = parseInt(e.target.value, 10);
    state.budget = Number.isFinite(v) && v > 0 ? v : null;
    renderBudgetHuman();
    runAllocation();
  }

  /** 预算场景：按真实编码后的最优可行候选总和计算，保证数值与演示效果可复现 */
  function scenarioBudget(kind) {
    let sum = 0;
    state.items.forEach((item) => {
      const best = Allocator.bestFeasible(item);
      const cheapest = Allocator.cheapestFeasible(item);
      if (!best || !cheapest) return;
      if (kind === 'normal') sum += best.bytes;
      else sum += cheapest.bytes;
    });
    if (kind === 'normal') return Math.round(sum * 0.92); // 略紧，触发少量降级
    return Math.round(sum * 0.82);                         // 极紧：多轮降级仍可能超
  }

  function applyScenario(kind) {
    if (!state.items.length) return;
    const v = scenarioBudget(kind);
    state.budget = v;
    $('budget').value = v;
    renderBudgetHuman();
    runAllocation();
  }

  function allEncoded() {
    return state.items.length > 0 && state.items.every((it) => it.candidates.length > 0 && !it.encoding);
  }

  function runAllocation() {
    if (!allEncoded() || !state.budget) {
      state.plan = null;
      renderPlanBar();
      exposeDebug();
      return;
    }
    state.plan = Allocator.allocate(state.items, state.budget);
    renderPlanBar();
    renderItemList();
    const item = getSelectedItem();
    if (item) renderCandidates(item);
    exposeDebug();
  }

  /** 仅供自动化测试读取的只读状态快照（不影响正常使用） */
  function exposeDebug() {
    window.__APP_DEBUG__ = {
      itemCount: state.items.length,
      encoding: state.items.filter((it) => it.encoding).map((it) => it.name),
      totalCandidates: state.items.reduce((s, it) => s + it.candidates.length, 0),
      allEncoded: allEncoded(),
      planFeasible: state.plan ? state.plan.feasible : null,
      planTotal: state.plan ? state.plan.total : null
    };
  }

  function unlockAll() {
    let changed = false;
    state.items.forEach((it) => {
      if (it.lockedPickId) { it.lockedPickId = null; changed = true; }
    });
    if (changed) {
      runAllocation();
      const item = getSelectedItem();
      if (item) renderCandidates(item);
    }
  }

  function toggleLock(candId) {
    const item = getSelectedItem();
    if (!item) return;
    const cand = item.candidates.find((c) => c.id === candId);
    if (!cand || !Allocator.feasible(cand)) return;
    item.lockedPickId = item.lockedPickId === candId ? null : candId;
    runAllocation();
    renderCandidates(item);
  }

  /* =========================================================
   * 单图配置
   * ========================================================= */
  function updateConfig(field, value) {
    const item = getSelectedItem();
    if (!item) return;
    if (field === 'minW' || field === 'minH') {
      if (!Number.isFinite(value) || value < 1) return;
      item[field] = value;
    } else {
      item[field] = value;
    }
    // 约束变化后重新评估违规并重新分配（候选本身不变，无需重新编码）
    item.candidates.forEach((c) => {
      c.violations = computeViolations(item, c);
    });
    if (item.lockedPickId) {
      const locked = item.candidates.find((c) => c.id === item.lockedPickId);
      if (locked && !Allocator.feasible(locked)) item.lockedPickId = null;
    }
    runAllocation();
    renderItemList();
    renderCandidates(item);
  }

  function computeViolations(item, cand) {
    const v = [];
    if (cand.width < item.minW || cand.height < item.minH) {
      v.push('低于最小尺寸 ' + item.minW + '×' + item.minH + 'px');
    }
    if (item.keepAlpha && cand.flattened) {
      v.push('透明通道被移除（该图要求保留透明）');
    }
    return v;
  }

  function removeSelected() {
    const item = getSelectedItem();
    if (!item) return;
    state.items = state.items.filter((it) => it.id !== item.id);
    if (state.selectedItemId === item.id) {
      state.selectedItemId = state.items[0] ? state.items[0].id : null;
    }
    runAllocation();
    renderAll();
  }

  /* =========================================================
   * 渲染：左侧列表
   * ========================================================= */
  function getSelectedItem() {
    return state.items.find((it) => it.id === state.selectedItemId) || null;
  }

  function pickedCandidate(item) {
    if (!state.plan) return null;
    return state.plan.picks.get(item.id) || null;
  }

  function renderItemList() {
    const list = $('item-list');
    $('item-count').textContent = state.items.length ? '（' + state.items.length + ' 张）' : '';
    if (!state.items.length) {
      list.innerHTML = '<div class="empty-hint">尚未导入图片。点击「导入图片」选择一组图片，' +
        '或「载入示例」查看内置演示。</div>';
      return;
    }
    list.innerHTML = state.items.map((item) => {
      const thumb = item.sourceCanvas.toDataURL('image/png');
      const picked = pickedCandidate(item);
      const priCls = item.priority;
      const priText = { high: '高优', mid: '中优', low: '低优' }[item.priority];
      const lockBadge = item.lockedPickId ? '<span class="badge lock">锁定</span>' : '';
      const alphaBadge = item.hasAlpha ? '<span class="badge alpha">含透明</span>' : '';
      const pickLine = item.encoding
        ? '<span class="muted">编码候选中…</span>'
        : picked
          ? '已选 ' + escapeHtml(picked.label) + ' · ' + formatBytes(picked.bytes)
          : '<span style="color:var(--bad)">无可行候选</span>';
      return '<div class="item-row ' + (item.id === state.selectedItemId ? 'active' : '') +
        '" data-id="' + item.id + '">' +
        '<div class="item-thumb"><img alt="" src="' + thumb + '"></div>' +
        '<div class="item-info">' +
          '<div class="item-name">' + escapeHtml(item.name) + '</div>' +
          '<div class="item-meta">' +
            '<span class="badge ' + priCls + '">' + priText + '</span>' +
            alphaBadge + lockBadge +
            '<span>' + item.width + '×' + item.height + '</span>' +
          '</div>' +
          '<div class="item-pick">' + pickLine + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    list.querySelectorAll('.item-row').forEach((row) => {
      row.addEventListener('click', () => selectItem(row.dataset.id));
    });
  }

  function selectItem(id) {
    state.selectedItemId = id;
    renderItemList();
    renderAll();
  }

  /* =========================================================
   * 渲染：配置卡片 + 候选表
   * ========================================================= */
  function renderConfig() {
    const item = getSelectedItem();
    $('detail-empty').classList.toggle('hidden', !!item);
    $('item-config').classList.toggle('hidden', !item);
    $('candidate-section').classList.toggle('hidden', !item);
    $('compare-section').classList.toggle('hidden', !item);
    if (!item) {
      if (state.viewport) { state.viewport.destroy(); state.viewport = null; }
      return;
    }
    $('cfg-name').textContent = item.name;
    $('cfg-priority').value = item.priority;
    $('cfg-minw').value = item.minW;
    $('cfg-minh').value = item.minH;
    $('cfg-alpha').checked = item.keepAlpha;
    $('cfg-alpha').disabled = !item.hasAlpha;
    $('cfg-meta').textContent = '原始尺寸 ' + item.width + '×' + item.height + 'px' +
      (item.hasAlpha ? ' · 原图含透明通道' : ' · 原图不含透明通道') +
      ' · 最小可接受尺寸 ' + item.minW + '×' + item.minH + 'px';
  }

  function renderCandidates(item) {
    if (!item) return;
    const tbody = $('candidate-table').querySelector('tbody');
    const picked = pickedCandidate(item);
    const pickedId = picked ? picked.id : null;

    if (item.encoding && !item.candidates.length) {
      $('cand-progress').textContent = '编码中…';
      tbody.innerHTML = '<tr><td colspan="7" class="muted">正在真实编码生成候选，请稍候…</td></tr>';
      return;
    }
    const failCount = item.candidates.filter((c) => c.status === 'fail').length;
    $('cand-progress').textContent = '共 ' + item.candidates.length + ' 个候选' +
      (failCount ? ' · ' + failCount + ' 个编码失败' : '');

    tbody.innerHTML = item.candidates.map((cand) => {
      const isPicked = cand.id === pickedId;
      const isLocked = item.lockedPickId === cand.id;
      const feasible = Allocator.feasible(cand);
      const rowCls = [
        isPicked ? 'selected' : '',
        !feasible ? 'blocked' : '',
        cand.status === 'fail' ? 'fail-row' : ''
      ].join(' ');

      let sizeCell;
      if (cand.status === 'fail') {
        sizeCell = '<span>编码失败</span>';
      } else {
        sizeCell = '<span class="size-bytes">' + cand.bytes.toLocaleString('zh-CN') + '</span>' +
          ' <span class="muted">(' + formatBytes(cand.bytes) + ')</span>' +
          '<div class="cand-sub">真实编码结果</div>';
      }

      const alphaCell = cand.hasOutputAlpha
        ? '<span class="ok">保留</span>'
        : (cand.flattened ? '<span class="violation">已移除</span>' : '不适用');

      let psnrCell = '—';
      if (cand.psnr !== null && cand.psnr !== undefined) {
        const grade = ImgEncoding.psnrGrade(cand.psnr);
        const pct = isFinite(cand.psnr) ? clamp(cand.psnr, 10, 50) / 50 * 100 : 100;
        psnrCell = '<div class="psnr-cell">' +
          ImgEncoding.psnrLabel(cand.psnr) +
          '<div class="cand-sub" style="color:' + grade.color + '">' + grade.text + '</div>' +
          '<div class="psnr-bar"><i style="width:' + pct + '%;background:' + grade.color + '"></i></div>' +
        '</div>';
      }

      let constraintCell;
      if (cand.status === 'fail') {
        constraintCell = '<span class="violation">' + escapeHtml(cand.failReason) + '</span>';
      } else if (cand.violations.length) {
        constraintCell = cand.violations.map((v) =>
          '<div class="violation">✕ ' + escapeHtml(v) + '</div>').join('');
      } else {
        constraintCell = '<span class="ok">✓ 满足全部约束</span>';
      }

      const radio = feasible && cand.status === 'ok'
        ? '<input type="radio" name="candpick" ' + (isPicked ? 'checked' : '') + '>' +
          (isLocked ? ' <span class="badge lock">已锁定</span>' : '')
        : '<span class="muted">不可选</span>';

      return '<tr class="' + rowCls + '" data-id="' + cand.id + '" title="' +
        (feasible ? '点击选择并锁定该候选' : '该候选不满足约束，无法选择') + '">' +
        '<td>' + radio + '</td>' +
        '<td><div class="cand-name">' + escapeHtml(cand.label) + '</div></td>' +
        '<td>' + sizeCell + '</td>' +
        '<td>' + cand.width + '×' + cand.height + '</td>' +
        '<td>' + alphaCell + '</td>' +
        '<td>' + psnrCell + '</td>' +
        '<td>' + constraintCell + '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const cand = item.candidates.find((c) => c.id === tr.dataset.id);
        if (cand && Allocator.feasible(cand)) toggleLock(cand.id);
        state.viewport && state.viewport.showCandidate(cand);
      });
    });

    if (!state.viewport) state.viewport = new Viewport();
    state.viewport.bindItem(item, picked);
  }

  /* =========================================================
   * 渲染：底部方案栏
   * ========================================================= */
  function renderPlanBar() {
    const totalEl = $('plan-total');
    const chipsEl = $('plan-chips');
    const reportEl = $('plan-report');
    const stepsWrap = $('plan-steps-wrap');

    $('btn-tight').disabled = $('btn-normal').disabled = !allEncoded();

    if (!state.items.length) {
      totalEl.textContent = '尚未生成方案';
      totalEl.className = 'plan-total';
      chipsEl.innerHTML = '';
      reportEl.classList.add('hidden');
      stepsWrap.classList.add('hidden');
      return;
    }
    if (!allEncoded()) {
      totalEl.textContent = '候选编码进行中，编码完成后自动出方案…';
      totalEl.className = 'plan-total';
      chipsEl.innerHTML = '';
      reportEl.classList.add('hidden');
      stepsWrap.classList.add('hidden');
      return;
    }
    if (!state.budget) {
      totalEl.textContent = '请输入有效的总字节上限';
      totalEl.className = 'plan-total over';
      reportEl.classList.add('hidden');
      stepsWrap.classList.add('hidden');
      return;
    }
    if (!state.plan) return;

    const plan = state.plan;
    const pct = clamp(plan.total / plan.budget * 100, 0, 999);
    totalEl.className = 'plan-total ' + (plan.feasible ? 'ok' : 'over');
    totalEl.innerHTML = (plan.feasible ? '✓ 方案在预算内：' : '✕ 无法满足预算：') +
      '<b>' + formatBytes(plan.total) + '</b> / ' + formatBytes(plan.budget) +
      ' <span class="muted">(' + pct.toFixed(1) + '%)</span>' +
      (plan.feasible ? ' · 余量 ' + formatBytes(plan.budget - plan.total)
                     : ' · 超出 ' + formatBytes(plan.total - plan.budget));

    chipsEl.innerHTML = state.items.map((item) => {
      const cand = plan.picks.get(item.id);
      if (!cand) return '<span class="chip" style="color:var(--bad)">' +
        escapeHtml(item.name) + '：无可行候选</span>';
      const sac = Allocator.sacrificeInfo(item, cand);
      const cls = 'chip' + (sac ? ' sacrificed' : '') + (item.lockedPickId ? ' locked' : '');
      const title = sac
        ? '为腾空间被压缩：最优档 ' + sac.bestLabel + '（' + formatBytes(sac.bestBytes) +
          '），实际省 ' + formatBytes(sac.bytesSaved)
        : (item.lockedPickId ? '手动锁定的候选' : '已取该图最优可行档');
      return '<span class="' + cls + '" title="' + escapeHtml(title) +
        '" data-item="' + item.id + '">' + escapeHtml(item.name) + ' · ' +
        escapeHtml(cand.format) + ' · ' + formatBytes(cand.bytes) +
        (sac ? ' ⚠压糊' : '') + (item.lockedPickId ? ' 🔒' : '') + '</span>';
    }).join('');
    chipsEl.querySelectorAll('.chip[data-item]').forEach((chip) => {
      chip.addEventListener('click', () => selectItem(chip.dataset.item));
    });

    // 步骤
    stepsWrap.classList.remove('hidden');
    $('plan-steps').innerHTML = plan.steps.map((s) => '<li>' + escapeHtml(s) + '</li>').join('');

    // 不可行报告
    if (plan.feasible) {
      reportEl.classList.add('hidden');
    } else {
      reportEl.classList.remove('hidden');
      const blockers = (plan.blockers || []).map((b) => {
        const diag = (plan.diagnosis || []).find((d) => d.itemId === b.item.id);
        const reasons = diag ? diag.reasons : ['没有满足约束的候选'];
        return '<li><b>' + escapeHtml(b.item.name) + '</b>（' +
          priText(b.item) + '优先级，最小 ' + b.item.minW + '×' + b.item.minH + 'px' +
          (b.item.keepAlpha ? '，必须保留透明' : '') + '）：<ul>' +
          reasons.map((r) => '<li>' + escapeHtml(r) + '</li>').join('') + '</ul></li>';
      }).join('');

      const overrunLines = (plan.diagnosis || [])
        .filter((d) => d.reasons.length && d.locked)
        .map((d) => '<li><b>' + escapeHtml(d.name) + '</b>：' +
          d.reasons.map(escapeHtml).join('；') + '</li>').join('');

      let html = '<h4>预算无法满足，卡住原因如下</h4>';
      if (blockers) html += '<ul>' + blockers + '</ul>';
      if (plan.floorTotal !== undefined) {
        html += '<p>各图降到最低可行档后的理论最低合计为 <b>' +
          formatBytes(plan.floorTotal) + '</b>，与预算相差 ' +
          formatBytes(Math.max(0, plan.floorTotal - plan.budget)) + '。</p>';
      }
      if (overrunLines) {
        html += '<p>锁定项占用了本可释放的空间：</p><ul>' + overrunLines + '</ul>';
      }
      html += '<p class="muted">可选做法：提高总字节上限、放宽某些图的最小尺寸或透明要求、' +
        '解锁手动锁定项，或更换原图后重新编码。</p>';
      reportEl.innerHTML = html;
    }
  }

  function priText(item) {
    return { high: '高', mid: '中', low: '低' }[item.priority];
  }

  function renderBudgetHuman() {
    $('budget-human').textContent = state.budget ? '≈ ' + formatBytes(state.budget) : '';
  }

  function renderAll() {
    renderBudgetHuman();
    renderItemList();
    renderConfig();
    const item = getSelectedItem();
    if (item) renderCandidates(item);
    renderPlanBar();
    setBgMode(state.bgMode, true);
  }

  /* =========================================================
   * 同步对照查看器
   * ========================================================= */
  class Viewport {
    constructor() {
      this.item = null;
      this.cand = null;
      this.mode = 'fit';
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.scrollW = $('scroll-orig').clientWidth || 800;
      this.scrollH = $('scroll-orig').clientHeight || 340;
      this.canvasOrig = $('canvas-orig');
      this.canvasCand = $('canvas-cand');
      this.scrollOrig = $('scroll-orig');
      this.scrollCand = $('scroll-cand');
      this._drag = null;
      this._onWheel = (e) => this.wheelZoom(e);
      this._onDown = (e) => this.dragStart(e);
      this._onMove = (e) => this.dragMove(e);
      this._onUp = () => this.dragEnd();
      [this.scrollOrig, this.scrollCand].forEach((el) => {
        el.addEventListener('wheel', this._onWheel, { passive: false });
        el.addEventListener('mousedown', this._onDown);
      });
      window.addEventListener('mousemove', this._onMove);
      window.addEventListener('mouseup', this._onUp);
    }

    destroy() {
      [this.scrollOrig, this.scrollCand].forEach((el) => {
        el.removeEventListener('wheel', this._onWheel);
        el.removeEventListener('mousedown', this._onDown);
      });
      window.removeEventListener('mousemove', this._onMove);
      window.removeEventListener('mouseup', this._onUp);
    }

    bindItem(item, picked) {
      this.item = item;
      this.drawOriginal();
      this.showCandidate(picked);
      this.setZoomMode('fit');
    }

    drawOriginal() {
      const src = this.item.sourceCanvas;
      this.canvasOrig.width = src.width;
      this.canvasOrig.height = src.height;
      this.canvasOrig.getContext('2d').drawImage(src, 0, 0);
      $('orig-label').textContent = this.item.name + ' · ' + src.width + '×' + src.height;
    }

    async showCandidate(cand) {
      if (!cand || !this.item) return;
      this.cand = cand;
      const c = this.canvasCand;
      if (cand.status === 'ok' && cand.blob) {
        const decoded = await ImgEncoding.blobToCanvas(cand.blob);
        c.width = decoded.width;
        c.height = decoded.height;
        c.getContext('2d').drawImage(decoded, 0, 0);
      } else {
        c.width = this.item.width;
        c.height = this.item.height;
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.fillStyle = 'rgba(240,98,92,.25)';
        ctx.fillRect(0, 0, c.width, c.height);
      }
      $('cand-label').textContent = cand.label + ' · ' + cand.width + '×' + cand.height +
        (cand.status === 'fail' ? ' · 编码失败' : ' · ' + formatBytes(cand.bytes));
      this.applyTransform();
    }

    setZoomMode(mode) {
      this.mode = mode;
      document.querySelectorAll('.cmp-controls [data-zoom]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.zoom === mode);
      });
      const refW = this.item ? this.item.sourceCanvas.width : 1;
      const refH = this.item ? this.item.sourceCanvas.height : 1;
      this.scrollW = this.scrollOrig.clientWidth;
      this.scrollH = this.scrollOrig.clientHeight;
      if (mode === 'fit') {
        this.scale = Math.min(this.scrollW / refW, this.scrollH / refH, 1);
      } else {
        this.scale = parseFloat(mode);
      }
      // 居中
      this.tx = (this.scrollW - refW * this.scale) / 2;
      this.ty = (this.scrollH - refH * this.scale) / 2;
      this.applyTransform();
    }

    wheelZoom(e) {
      if (!this.item) return;
      e.preventDefault();
      this.mode = 'custom';
      document.querySelectorAll('.cmp-controls [data-zoom]').forEach((btn) => btn.classList.remove('active'));
      const rect = this.scrollOrig.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
      const next = clamp(this.scale * factor, 0.05, 16);
      // 以指针为锚点缩放
      this.tx = mx - (mx - this.tx) * (next / this.scale);
      this.ty = my - (my - this.ty) * (next / this.scale);
      this.scale = next;
      this.applyTransform();
    }

    dragStart(e) {
      if (!this.item) return;
      this._drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
      this.scrollOrig.classList.add('dragging');
      this.scrollCand.classList.add('dragging');
      e.preventDefault();
    }

    dragMove(e) {
      if (!this._drag) return;
      this.tx = this._drag.tx + (e.clientX - this._drag.x);
      this.ty = this._drag.ty + (e.clientY - this._drag.y);
      this.applyTransform();
    }

    dragEnd() {
      this._drag = null;
      this.scrollOrig.classList.remove('dragging');
      this.scrollCand.classList.remove('dragging');
    }

    applyTransform() {
      [this.canvasOrig, this.canvasCand].forEach((cv) => {
        cv.style.transform = 'translate(' + this.tx + 'px,' + this.ty + 'px) scale(' + this.scale + ')';
        cv.style.transformOrigin = '0 0';
      });
      const pct = Math.round(this.scale * 100);
      $('zoom-readout').textContent = '缩放 ' + pct + '%';
    }

    rerender() {
      if (this.item && this.mode === 'fit') this.setZoomMode('fit');
      else this.applyTransform();
    }
  }

  function setBgMode(mode, silent) {
    state.bgMode = mode;
    const cls = mode === 'checker' ? 'bg-checker' : mode === 'white' ? 'bg-white' : 'bg-black';
    ['scroll-orig', 'scroll-cand'].forEach((id) => {
      const el = $(id);
      el.classList.remove('bg-checker', 'bg-white', 'bg-black');
      el.classList.add(cls);
    });
    document.querySelectorAll('.cmp-controls [data-bg]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.bg === mode);
    });
  }

  /* =========================================================
   * 导出
   * ========================================================= */
  async function exportBundle() {
    if (exporting) return;
    if (!allEncoded()) {
      alertModal('无法导出', '候选尚未全部编码完成，请稍候。');
      return;
    }
    // 导出前核验：每个选定候选必须是成功编码且字节数 > 0，失败不得算零字节成功。
    // 先于“方案不可行”的通用提示，确保编码失败时明确要求重选。
    const selected = state.items.map((item) => ({
      item,
      cand: state.plan ? state.plan.picks.get(item.id) : null
    }));
    const bad = selected.filter(({ cand }) =>
      !cand || cand.status !== 'ok' || !cand.blob || !(cand.blob.size > 0));
    if (bad.length) {
      const names = bad.map(({ item }) => item.name).join('、');
      modal({
        title: '存在编码失败的图片，需要重选',
        kind: 'err',
        body: '<p>以下图片当前选定的候选编码失败或数据无效，<b>不能按 0 字节计入导出</b>：</p>' +
          '<p><b>' + escapeHtml(names) + '</b></p>' +
          '<p>请在候选表中为这些图片改选其他候选后重新导出。</p>'
      });
      if (bad[0]) selectItem(bad[0].item.id);
      return;
    }

    if (!state.plan.feasible) {
      alertModal('无法导出',
        '当前整组方案超出预算。请调整预算、约束或锁定项后再导出。');
      return;
    }

    exporting = true;
    const pm = progressModal('导出整组图片');
    try {
      const ext = (cand) => cand.format === 'PNG' ? 'png' : 'webp';
      const usedNames = new Set();
      const zipFiles = [];
      const manifestRows = [];
      let totalBytes = 0;

      for (let i = 0; i < selected.length; i++) {
        const { item, cand } = selected[i];
        pm.set('打包 ' + item.name + '（' + (i + 1) + '/' + selected.length + '）', i / selected.length);

        const stem = item.name.replace(/\.[^.]+$/, '') || ('image-' + i);
        // ZIP 条目名做 ASCII 安全转写，原始名记录在清单的「源文件」列
        let outName = Util.asciiSafeName(stem) + '.' + ext(cand);
        let n = 2;
        while (usedNames.has(outName)) {
          outName = Util.asciiSafeName(stem) + '_' + n++ + '.' + ext(cand);
        }
        usedNames.add(outName);

        const buf = new Uint8Array(await cand.blob.arrayBuffer());
        if (!buf.length) {
          // 最后一道防线：任何 0 字节输出都拦截
          throw new Error(item.name + ' 编码输出为 0 字节，已中止导出，请重新选择候选');
        }
        zipFiles.push({ name: outName, bytes: buf });
        totalBytes += buf.length;

        manifestRows.push({
          source: item.name,
          output: outName,
          format: cand.format,
          width: cand.width,
          height: cand.height,
          bytes: cand.blob.size,
          psnr: cand.psnr === null ? '' : (isFinite(cand.psnr) ? cand.psnr.toFixed(2) : '无差异'),
          priority: { high: '高', mid: '中', low: '低' }[item.priority],
          keepAlpha: item.keepAlpha ? '是' : '否',
          outputAlpha: cand.hasOutputAlpha ? '是' : '否',
          locked: item.lockedPickId ? '是' : '否',
          candidate: cand.label
        });
      }

      const stamp = timestamp();
      const manifestCsv = buildCsv(manifestRows, totalBytes);
      zipFiles.push({
        // 条目名保持 ASCII 以兼容老旧解压工具；清单内容仍为带 BOM 的中文 CSV
        name: 'size-manifest.csv',
        bytes: new TextEncoder().encode('﻿' + manifestCsv)
      });

      const zipBlob = ZipWriter.buildZip(zipFiles);
      if (zipBlob.size <= 22) throw new Error('ZIP 打包结果异常');

      // 归档文件名带时间戳，绝不覆盖原文件或历史导出
      const zipName = 'image-budget-export-' + stamp + '.zip';
      downloadBlob(zipBlob, zipName);

      modal({
        title: '导出完成',
        kind: 'ok',
        body: '<p>已导出 <b>' + selected.length + '</b> 张图片与「尺寸大小清单」（size-manifest.csv）。</p>' +
          '<p>压缩包：<b>' + escapeHtml(zipName) + '</b></p>' +
          '<p>导出总大小 <b>' + formatBytes(totalBytes) + '</b>，预算 ' +
          formatBytes(state.budget) + '，余量 ' + formatBytes(state.budget - totalBytes) + '。</p>' +
          '<p class="muted">浏览器下载目录内的历史文件不会被覆盖；原图始终未被修改。</p>'
      });
    } catch (err) {
      alertModal('导出失败', err.message);
    } finally {
      exporting = false;
      pm.close();
    }
  }

  function buildCsv(rows, totalBytes) {
    const header = ['源文件', '导出文件名', '格式', '宽(px)', '高(px)', '实际字节',
      '字节(可读)', 'PSNR(dB)', '优先级', '要求透明', '输出含透明', '手动锁定', '所选候选'];
    const lines = [header.join(',')];
    rows.forEach((r) => {
      lines.push([
        r.source, r.output, r.format, r.width, r.height, r.bytes,
        formatBytes(r.bytes), r.psnr, r.priority, r.keepAlpha, r.outputAlpha,
        r.locked, r.candidate
      ].map(csvCell).join(','));
    });
    lines.push('');
    lines.push(['汇总', '导出总字节', totalBytes, '预算字节', state.budget,
      '余量', state.budget - totalBytes,
      '方案状态', state.plan.feasible ? '在预算内' : '超预算'].map(csvCell).join(','));
    lines.push(['导出时间', new Date().toLocaleString('zh-CN')].map(csvCell).join(','));
    return lines.join('\r\n');
  }

  function csvCell(v) {
    const s = String(v === null || v === undefined ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  document.addEventListener('DOMContentLoaded', init);
})();
