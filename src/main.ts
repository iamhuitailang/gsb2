import './style.css';
import {
  AppState,
  Mode,
  ToolKind,
  createInitialState,
  effectiveLevel,
  enterEditMode,
  enterPlayMode,
  generate,
  loadFromText,
  loadSolutionIntoPlay,
  paintCell,
  recomputeSim,
  resetPlay,
  resizeBoard,
  rotateMirrorInPlay,
  runSolve,
  saveToText,
  secondaryClick,
  setMessage,
} from './state';
import { renderBoard } from './board';
import { COLOR_BITS, DIR_NAMES, Direction, maskCode, maskName } from './core/types';

const state = createInitialState();
const app = document.querySelector<HTMLDivElement>('#app')!;

const TOOLS: { kind: ToolKind; glyph: string; label: string }[] = [
  { kind: 'empty', glyph: '⬜', label: '擦除' },
  { kind: 'wall', glyph: '🧱', label: '挡板' },
  { kind: 'source', glyph: '💡', label: '光源' },
  { kind: 'mirror', glyph: '╱', label: '可转片' },
  { kind: 'mirror-locked', glyph: '🔒', label: '锁定片' },
  { kind: 'target', glyph: '◉', label: '收光点' },
];

const STATUS_TEXT: Record<string, string> = {
  unsat: '无解',
  unique: '唯一解',
  multi: '至少两解',
  incomplete: '没搜完',
};

function colorCheckbox(mask: number, bit: number, key: string): string {
  const active = mask & bit;
  const name = bit === COLOR_BITS.R ? '红' : bit === COLOR_BITS.G ? '绿' : '蓝';
  return `<label class="${active ? 'active' : ''}"><input type="checkbox" data-color="${key}" ${active ? 'checked' : ''} />${name}</label>`;
}

function render(): void {
  // 测试钩子: 每次重渲染递增, 供端到端测试等待异步状态更新完成
  (window as unknown as { __renderCount?: number }).__renderCount =
    ((window as unknown as { __renderCount?: number }).__renderCount ?? 0) + 1;
  const level = effectiveLevel(state);
  const beamCount = state.sim.beams.length;

  app.innerHTML = `
    <div class="app">
      <header>
        <h1>灯路谜题 · 出关检查器</h1>
        <p>摆好反光片, 让每束彩灯到达指定收光点。校验器严格区分「无解 / 唯一解 / 至少两解 / 没搜完」。</p>
      </header>

      <div class="layout">
        <!-- 左栏: 模式 + 工具 + 生成 -->
        <div>
          <div class="panel">
            <h2>模式</h2>
            <div class="mode-switch">
              <button data-mode="edit" class="${state.mode === 'edit' ? 'active' : ''}">编辑布局</button>
              <button data-mode="play" class="${state.mode === 'play' ? 'active' : ''}">试玩转动</button>
            </div>
            <p class="hint">
              编辑模式: 左键放置/旋转, 右键锁定反光片或擦除。<br/>
              试玩模式: 左键转动未锁定的反光片, 锁定片不可动。
            </p>
          </div>

          ${
            state.mode === 'edit'
              ? `
          <div class="panel">
            <h2>格子工具</h2>
            <div class="tools">
              ${TOOLS.map(
                (t) => `
                <button class="tool-btn ${state.tool === t.kind ? 'active' : ''}" data-tool="${t.kind}">
                  <span class="tool-glyph">${t.glyph}</span>${t.label}
                </button>`,
              ).join('')}
            </div>

            <h2 style="margin-top:14px">光源参数</h2>
            <div class="row">
              <label>方向</label>
              <select id="source-dir">
                ${DIR_NAMES.map((d, i) => `<option value="${i}" ${state.sourceDir === i ? 'selected' : ''}>${d}</option>`).join('')}
              </select>
            </div>
            <div class="color-picker">
              ${colorCheckbox(state.sourceColors, COLOR_BITS.R, 'R')}
              ${colorCheckbox(state.sourceColors, COLOR_BITS.G, 'G')}
              ${colorCheckbox(state.sourceColors, COLOR_BITS.B, 'B')}
            </div>
            <p class="hint">勾选两色即为双色光源; 每色各发一束同路径的光。</p>

            <h2 style="margin-top:14px">收光点必要颜色</h2>
            <div class="color-picker">
              ${colorCheckbox(state.targetRequired, COLOR_BITS.R, 'TR')}
              ${colorCheckbox(state.targetRequired, COLOR_BITS.G, 'TG')}
              ${colorCheckbox(state.targetRequired, COLOR_BITS.B, 'TB')}
            </div>
            <p class="hint">全不选 = 任意颜色到达即可; 到达颜色须恰好等于所选掩码。</p>

            <h2 style="margin-top:14px">棋盘</h2>
            <div class="row">
              <label>尺寸</label>
              <select id="size-select">
                ${[3, 4, 5, 6, 7, 8].map((s) => `<option value="${s}" ${state.level.size === s ? 'selected' : ''}>${s}×${s}</option>`).join('')}
              </select>
            </div>
            <div class="row">
              <input type="text" id="level-name" value="${state.level.name}" placeholder="关卡名" />
            </div>
          </div>`
              : `
          <div class="panel">
            <h2>试玩</h2>
            <button class="full" id="reset-play">重置反光片</button>
            <button class="full" id="back-edit">回编辑布局</button>
            <p class="hint">左键点未锁定反光片即可转动; 右栏可逐束查看光路。</p>
          </div>`
          }

          <div class="panel">
            <h2>生成关卡</h2>
            <div class="row">
              <label>种子</label>
              <input type="number" id="seed-input" value="${state.seed}" min="0" />
            </div>
            <button class="full" id="btn-generate" ${state.solving ? 'disabled' : ''}>
              ${state.solving ? '<span class="spinner"></span>生成中…' : '一键生成小关(验证唯一解)'}
            </button>
            <p class="hint">同编号种子每次生成完全相同的关卡; 随机候选不唯一时回退内置样例。</p>
          </div>

          <div class="panel">
            <h2>保存 / 导入</h2>
            <button class="full" id="btn-export">导出 JSON</button>
            <button class="full" id="btn-import">导入 JSON</button>
            <p class="hint">导入若有格子冲突, 当前关卡保留不变, 冲突格行列会显示在下方消息里。</p>
          </div>
        </div>

        <!-- 中栏: 棋盘 + 消息 + 求解 -->
        <div>
          <div class="board-wrap">
            ${renderBoard(state)}
            <div class="row" style="width:100%; max-width:520px">
              <button class="primary" id="btn-solve" ${state.solving ? 'disabled' : ''}>
                ${state.solving ? '<span class="spinner"></span>搜索中…' : '自动校验(穷举求解)'}
              </button>
            </div>
            <div class="message ${state.messageKind}" style="width:100%; max-width:640px">
              ${state.solving ? '<span class="spinner"></span>' : ''}${state.message}
            </div>
            ${renderReport(state)}
          </div>
        </div>

        <!-- 右栏: 光束 + 收光点 -->
        <div>
          <div class="panel">
            <h2>光束 (${beamCount})</h2>
            <div class="beam-list">
              <div class="info-item clickable ${state.selectedBeam === null ? 'selected' : ''}" data-beam="-1">
                <div class="title">显示全部光束</div>
              </div>
              ${state.sim.beams
                .map((b) => {
                  const endText =
                    b.end === 'target'
                      ? `到达收光点 (${b.target![0] + 1}, ${b.target![1] + 1})`
                      : b.end === 'loop'
                        ? '形成回路 ⟳'
                        : b.end === 'escape'
                          ? '出界逃逸'
                          : b.end === 'wall'
                            ? '撞挡板'
                            : '被光源挡住';
                  return `
                  <div class="info-item clickable ${state.selectedBeam === b.id ? 'selected' : ''}" data-beam="${b.id}">
                    <div class="title">
                      <span class="dot ${b.color === 1 ? 'r' : b.color === 2 ? 'g' : 'b'}" style="display:inline-block"></span>
                      束 ${b.id + 1} · ${maskName(b.color)}
                    </div>
                    <div>${endText} · 经 ${b.path.length} 格</div>
                  </div>`;
                })
                .join('')}
            </div>
          </div>

          <div class="panel">
            <h2>收光点</h2>
            <div class="target-list">
              ${[...state.sim.targets.values()].map((t) => {
                const cell = level.cells[t.pos[0]][t.pos[1]];
                const required = cell.kind === 'target' ? cell.required : 0;
                return `
                <div class="info-item">
                  <div class="title">
                    (${t.pos[0] + 1}, ${t.pos[1] + 1})
                    <span class="badge ${t.satisfied ? 'ok' : 'bad'}">${t.satisfied ? '满足' : '未满足'}</span>
                  </div>
                  <div>要求: ${required === 0 ? '任意光' : maskName(required)}(${maskCode(required)})</div>
                  <div>收到: ${t.got === 0 ? '无光' : `${maskName(t.got)}(${maskCode(t.got)})`} · ${t.beamIds.length} 束合并</div>
                </div>`;
              }).join('') || '<div class="info-item">没有收光点</div>'}
            </div>
            <p class="hint">
              合并规则: 同格多束按位或(红+绿=黄, 三色=白); 要求非 0 时收到颜色必须恰好相等。
            </p>
          </div>

          ${
            state.sim.loopCount > 0
              ? `<div class="panel"><h2>回路</h2><div class="info-item">检测到 ${state.sim.loopCount} 条回路, 已用虚线和黄框标出。回路上的光无法到达收光点。</div></div>`
              : ''
          }
        </div>
      </div>
    </div>`;

  bindEvents();
}

function renderReport(state: AppState): string {
  const r = state.report;
  if (!r) return '';
  const status = r.status;
  return `
    <div class="panel" style="width:100%; max-width:640px">
      <h2>校验结果 <span class="badge status-${status}">${STATUS_TEXT[status]}</span></h2>
      <div class="info-item">
        可转动片 ${r.variableCount} 个 · 摆法总数 ${r.totalCombinations} ·
        实际访问 ${r.nodes} 节点 · 耗时 ${r.elapsedMs.toFixed(1)}ms
        ${r.stoppedEarly ? ' · <b>提前停止(结论仅为没搜完)</b>' : ' · 搜索完整'}
      </div>
      ${
        r.solutions.length > 0
          ? `<h2 style="margin-top:10px">找到的摆法 (展示前 ${Math.min(2, r.solutions.length)} 组)</h2>
             <div class="solution-list">
               ${r.solutions
                 .slice(0, 2)
                 .map((sol, i) => {
                   const seq = [...sol.assignments.values()].map((o) => (o === 0 ? '/' : '\\')).join(' ');
                   return `
                   <div class="info-item">
                     <div class="title">第 ${i + 1} 组解 ${i === 1 ? '(与第 1 组朝向确实不同)' : ''}</div>
                     <div>可转动片朝向顺序: <code>${seq}</code></div>
                     <button class="full" data-load-sol="${i}">放入试玩面板逐束看</button>
                   </div>`;
                 })
                 .join('')}
             </div>`
          : ''
      }
    </div>`;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

function bindEvents(): void {
  // 模式
  app.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      const mode = btn.dataset.mode as Mode;
      if (mode === 'play') enterPlayMode(state);
      else enterEditMode(state);
      render();
    };
  });

  // 工具
  app.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.onclick = () => {
      state.tool = btn.dataset.tool as ToolKind;
      render();
    };
  });

  // 棋盘格子
  app.querySelectorAll<HTMLElement>('.cell').forEach((el) => {
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    el.onclick = () => {
      if (state.mode === 'edit') paintCell(state, r, c);
      else rotateMirrorInPlay(state, r, c);
      render();
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      secondaryClick(state, r, c);
      render();
    };
  });

  // 光源方向/颜色
  const dirSel = app.querySelector<HTMLSelectElement>('#source-dir');
  if (dirSel) dirSel.onchange = () => (state.sourceDir = Number(dirSel.value) as Direction);
  app.querySelectorAll<HTMLInputElement>('[data-color]').forEach((cb) => {
    cb.onchange = () => {
      const key = cb.dataset.color!;
      const bit =
        key === 'R' || key === 'TR' ? COLOR_BITS.R : key === 'G' || key === 'TG' ? COLOR_BITS.G : COLOR_BITS.B;
      const target = key.startsWith('T') ? 'targetRequired' : 'sourceColors';
      if (cb.checked) state[target] |= bit;
      else state[target] &= ~bit;
      render();
    };
  });

  const sizeSel = app.querySelector<HTMLSelectElement>('#size-select');
  if (sizeSel)
    sizeSel.onchange = () => {
      resizeBoard(state, Number(sizeSel.value));
      render();
    };

  const nameInput = app.querySelector<HTMLInputElement>('#level-name');
  if (nameInput) nameInput.onchange = () => (state.level.name = nameInput.value);

  // 求解
  app.querySelector<HTMLButtonElement>('#btn-solve')!.onclick = async () => {
    await runSolve(state);
    render();
  };

  // 光束选择
  app.querySelectorAll<HTMLElement>('[data-beam]').forEach((el) => {
    el.onclick = () => {
      const id = Number(el.dataset.beam);
      state.selectedBeam = id < 0 ? null : id;
      render();
    };
  });

  // 加载某组解到试玩
  app.querySelectorAll<HTMLButtonElement>('[data-load-sol]').forEach((btn) => {
    btn.onclick = () => {
      loadSolutionIntoPlay(state, Number(btn.dataset.loadSol));
      render();
    };
  });

  // 试玩控制
  const resetBtn = app.querySelector<HTMLButtonElement>('#reset-play');
  if (resetBtn) resetBtn.onclick = () => { resetPlay(state); render(); };
  const backBtn = app.querySelector<HTMLButtonElement>('#back-edit');
  if (backBtn) backBtn.onclick = () => { enterEditMode(state); render(); };

  // 生成
  const seedInput = app.querySelector<HTMLInputElement>('#seed-input');
  if (seedInput)
    seedInput.onchange = () => (state.seed = Number(seedInput.value) || 0);
  app.querySelector<HTMLButtonElement>('#btn-generate')!.onclick = async () => {
    state.seed = Number(app.querySelector<HTMLInputElement>('#seed-input')!.value) || 0;
    await generate(state, state.seed);
    render();
  };

  // 导出/导入
  app.querySelector<HTMLButtonElement>('#btn-export')!.onclick = () => {
    const text = saveToText(state);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.level.name || 'level'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage(state, '已导出关卡 JSON 文件', 'ok');
    render();
  };

  app.querySelector<HTMLButtonElement>('#btn-import')!.onclick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        loadFromText(state, String(reader.result));
        render();
      };
      reader.readAsText(file);
    };
    input.click();
  };
}

recomputeSim(state);
render();
