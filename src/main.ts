import { buildMesh, type MeshData, effectiveFrame } from './core/geometry.ts';
import { generateTexture, type NormalTextureData, type TextureKind, type ChannelView } from './core/textures.ts';
import { type AppState, defaultState } from './core/state.ts';
import { buildWorldMesh, shadePoint, type WorldFace, type WorldMesh } from './core/world.ts';
import { lightDirection, buildSeamReport, reportToText, downloadJson, downloadText } from './core/report.ts';
import { loadState, saveState, clearSavedState } from './core/persistence.ts';
import { WebGLViewport } from './webgl/Viewport.ts';
import { attachOrbit, type OrbitTarget } from './ui/orbit.ts';
import { drawChannelCanvas, channelLabel, texelInfo } from './ui/channelView.ts';
import { v3 } from './core/math.ts';

// ---------- 应用状态 ----------
const state: AppState = loadState() ?? defaultState();
let mesh: MeshData = buildMesh(state.preset);
let texture: NormalTextureData = generateTexture(state.textureKind);
let world: WorldMesh = buildWorldMesh(mesh, state.model);
let orbitTarget: OrbitTarget = 'camera';

const canvasLeft = document.getElementById('glLeft') as HTMLCanvasElement;
const canvasRight = document.getElementById('glRight') as HTMLCanvasElement;
const canvasAll = document.getElementById('glAll') as HTMLCanvasElement;
const vpLeft = new WebGLViewport(canvasLeft, { half: 'normalUV' });
const vpRight = new WebGLViewport(canvasRight, { half: 'mirrorUV' });
const vpAll = new WebGLViewport(canvasAll, { half: 'all' });
const viewports = [vpLeft, vpRight, vpAll];
for (const vp of viewports) {
  vp.setTexture(texture);
  vp.uploadWorld(world);
}

const sidePanel = document.getElementById('sidePanel') as HTMLElement;
const topActions = document.getElementById('topActions') as HTMLElement;
const viewportFoot = document.getElementById('viewportFoot') as HTMLElement;

let saveTimer: number | undefined;
function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => saveState(state), 250);
}

function refreshWorld(): void {
  world = buildWorldMesh(mesh, state.model);
  for (const vp of viewports) vp.uploadWorld(world);
  renderAll();
}

function renderAll(): void {
  const lightDir = lightDirection(state.light.yawDeg, state.light.pitchDeg);
  const flipG = state.convention === 'directx' ? 1 : 0;
  const gizmoFace: WorldFace | null =
    state.showGizmo && state.selection.faceId !== null
      ? world.faces[state.selection.faceId]
      : null;
  const common = {
    world,
    cam: state.camera,
    lightDir,
    flipG: flipG as 0 | 1,
    useTexture: true,
    diffuse: state.diffuseIntensity,
    specular: state.specularIntensity,
    shininess: state.shininess,
    selectionFaceId: state.selection.faceId,
    gizmoFace,
    highlightSeams: state.highlightSeams,
    wireframe: state.wireframe,
  };
  vpLeft.render({ ...common, halfTint: 0 });
  vpRight.render({ ...common, halfTint: 1 });
  vpAll.render({ ...common, halfTint: 0.6 });
  updateConventionBadge();
  updateSelectionPanel();
  updateChannelPanel();
  updateFoot();
  scheduleSave();
}

/** 约定切换后，让静态 badge DOM 与 state 保持同步 */
function updateConventionBadge(): void {
  const badge = document.getElementById('conventionBadge');
  if (badge) {
    if (state.convention === 'opengl') {
      badge.className = 'convention-badge badge-gl';
      badge.textContent = '当前生效：OpenGL（绿通道原样使用）';
    } else {
      badge.className = 'convention-badge badge-dx';
      badge.textContent = '当前生效：DirectX（着色器内翻绿 uFlipG=1）';
    }
  }
  const presetNote = document.getElementById('presetNote');
  if (presetNote) presetNote.textContent = mesh.presetNote;
  const textureNote = document.getElementById('textureNote');
  if (textureNote) {
    textureNote.textContent =
      state.textureKind === 'flat'
        ? '平法线图处处为 (128,128,255)，只反映几何光照，用于排除纹理因素。'
        : '定向凹凸带沿 v 起伏的棱与斜槽，镜像半 B 翻向时亮边立即变暗边。';
  }
}

// ---------- 顶部操作 ----------
function buildTopActions(): void {
  const mk = (label: string, fn: () => void, primary = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', fn);
    return b;
  };
  topActions.append(
    mk('保存快照', () => {
      saveState(state);
      flash(b => {
        b.textContent = '已保存 ✓';
      });
    }, true),
    mk('导出 JSON', () =>
      downloadJson(`normal-bench-${Date.now()}.json`, { app: 'normal-map-debug-bench', state }),
    ),
    mk('导入 JSON', () => importJson()),
    mk('恢复已存', () => {
      const loaded = loadState();
      if (loaded) Object.assign(state, loaded);
      rebuildAfterPresetOrTexture();
    }),
    mk('重置全部', () => {
      clearSavedState();
      Object.assign(state, defaultState());
      rebuildAfterPresetOrTexture();
    }),
  );

  function flash(fn: (b: HTMLButtonElement) => void) {
    const btn = topActions.querySelector('button.primary') as HTMLButtonElement;
    const old = btn.textContent;
    fn(btn);
    setTimeout(() => {
      btn.textContent = old;
    }, 1200);
  }
}

function importJson(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const incoming = parsed.state ?? parsed;
        Object.assign(state, defaultState(), incoming);
        rebuildAfterPresetOrTexture();
      } catch (err) {
        alert('JSON 解析失败：' + String(err));
      }
    };
    reader.readAsText(file);
  });
  input.click();
}

function rebuildAfterPresetOrTexture(): void {
  mesh = buildMesh(state.preset);
  texture = generateTexture(state.textureKind);
  for (const vp of viewports) vp.setTexture(texture);
  if (state.selection.faceId !== null && state.selection.faceId >= mesh.faces.length) {
    state.selection = { faceId: null, u: 0, v: 0, half: null };
  }
  refreshWorld();
  buildSidePanel();
}

// ---------- 侧栏 ----------
function buildSidePanel(): void {
  sidePanel.innerHTML = '';
  sidePanel.append(
    presetGroup(),
    textureGroup(),
    conventionGroup(),
    modelGroup(),
    lightGroup(),
    displayGroup(),
    channelGroup(),
    selectionGroup(),
    invalidGroup(),
    reportGroup(),
  );
  renderAll();
}

function group(title: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'group';
  const h = document.createElement('h3');
  h.textContent = title;
  el.append(h);
  return el;
}

function seg<T extends string>(
  options: [T, string][],
  get: () => T,
  set: (v: T) => void,
  redrawWorld = false,
  afterChange?: () => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'seg';
  for (const [value, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    if (get() === value) b.classList.add('active');
    b.addEventListener('click', () => {
      set(value);
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      if (afterChange) afterChange();
      else if (redrawWorld) refreshWorld();
      else renderAll();
    });
    wrap.append(b);
  }
  return wrap;
}

function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
  redrawWorld = false,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  const tag = document.createElement('span');
  tag.className = 'value-tag';
  tag.textContent = get().toFixed(step < 1 ? 1 : 0);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    tag.textContent = v.toFixed(step < 1 ? 1 : 0);
    if (redrawWorld) refreshWorld();
    else renderAll();
  });
  row.append(lab, input, tag);
  return row;
}

function presetGroup(): HTMLElement {
  const g = group('1 · 接缝示例预设');
  g.append(
    seg(
      [
        ['correct', '正确基线'],
        ['broken-seam', '刻意设错'],
        ['degenerate', '退化/缺方向'],
      ],
      () => state.preset,
      (v) => {
        state.preset = v;
      },
      false,
      () => rebuildAfterPresetOrTexture(),
    ),
  );
  const note = document.createElement('p');
  note.className = 'note';
  note.id = 'presetNote';
  note.textContent = mesh.presetNote;
  g.append(note);
  return g;
}

function textureGroup(): HTMLElement {
  const g = group('2 · 法线纹理');
  g.append(
    seg(
      [
        ['flat', '平法线'],
        ['directional', '定向凹凸'],
      ],
      () => state.textureKind,
      (v) => {
        state.textureKind = v as TextureKind;
      },
      false,
      () => rebuildAfterPresetOrTexture(),
    ),
  );
  const note = document.createElement('p');
  note.className = 'note';
  note.id = 'textureNote';
  note.textContent =
    state.textureKind === 'flat'
      ? '平法线图处处为 (128,128,255)，只反映几何光照，用于排除纹理因素。'
      : '定向凹凸带沿 v 起伏的棱与斜槽，镜像半 B 翻向时亮边立即变暗边。';
  g.append(note);
  return g;
}

function conventionGroup(): HTMLElement {
  const g = group('3 · 绿通道约定（无需重导模型）');
  g.append(
    seg(
      [
        ['opengl', 'OpenGL +Y↑'],
        ['directx', 'DirectX +Y↓'],
      ],
      () => state.convention,
      (v) => {
        state.convention = v;
      },
      false,
    ),
  );
  const badge = document.createElement('p');
  badge.id = 'conventionBadge';
  badge.innerHTML =
    state.convention === 'opengl'
      ? '<span class="convention-badge badge-gl">当前生效：OpenGL（绿通道原样使用）</span>'
      : '<span class="convention-badge badge-dx">当前生效：DirectX（着色器内翻绿 uFlipG=1）</span>';
  g.append(badge);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '切换只改 uniform，几何与切线基保持不变；原始纹理字节可在下方第 7 组单独查看。';
  g.append(note);
  return g;
}

function modelGroup(): HTMLElement {
  const g = group('4 · 模型姿态（旋转 / 不等比缩放 / 翻转）');
  const axes: ['X', 'Y', 'Z'] = ['X', 'Y', 'Z'];
  axes.forEach((axis, i) => {
    g.append(
      slider(
        `旋转${axis}`,
        -180,
        180,
        1,
        () => state.model.rotationDeg[i],
        (v) => {
          state.model.rotationDeg[i] = v;
        },
        true,
      ),
    );
  });
  axes.forEach((axis, i) => {
    g.append(
      slider(
        `缩放${axis}`,
        0.25,
        2.5,
        0.05,
        () => state.model.scaleAbs[i],
        (v) => {
          state.model.scaleAbs[i] = v;
        },
        true,
      ),
    );
  });
  const flipRow = document.createElement('div');
  flipRow.className = 'row flip-row';
  const lab = document.createElement('label');
  lab.textContent = '轴翻转';
  flipRow.append(lab);
  axes.forEach((axis, i) => {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.model.flips[i];
    cb.addEventListener('change', () => {
      state.model.flips[i] = cb.checked;
      refreshWorld();
    });
    l.append(cb, document.createTextNode(axis));
    flipRow.append(l);
  });
  g.append(flipRow);
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '法线/切向统一走 inverse-transpose 法线矩阵（仅归一化、不重新正交化），负缩放轴也能给出垂直于切平面的正确基底。';
  g.append(note);
  return g;
}

function lightGroup(): HTMLElement {
  const g = group('5 · 方向光（两个视口共用一盏灯）');
  const mode = seg(
    [
      ['camera', '拖拽=转相机'],
      ['light', '拖拽=转灯光'],
    ],
    () => orbitTarget,
    (v) => {
      orbitTarget = v as OrbitTarget;
    },
    false,
  );
  g.append(mode);
  g.append(
    slider('灯方位角', -180, 180, 1, () => state.light.yawDeg, (v) => {
      state.light.yawDeg = v;
    }),
    slider('灯仰角', -85, 85, 1, () => state.light.pitchDeg, (v) => {
      state.light.pitchDeg = v;
    }),
    slider('漫反射', 0, 1.5, 0.05, () => state.diffuseIntensity, (v) => {
      state.diffuseIntensity = v;
    }),
    slider('高光', 0, 1.5, 0.05, () => state.specularIntensity, (v) => {
      state.specularIntensity = v;
    }),
    slider('光泽度', 4, 96, 1, () => state.shininess, (v) => {
      state.shininess = v;
    }),
  );
  return g;
}

function displayGroup(): HTMLElement {
  const g = group('6 · 显示与检查');
  const checks: [string, () => boolean, (v: boolean) => void][] = [
    ['切线 gizmo', () => state.showGizmo, (v) => (state.showGizmo = v)],
    ['高亮接缝/折痕', () => state.highlightSeams, (v) => (state.highlightSeams = v)],
    ['线框', () => state.wireframe, (v) => (state.wireframe = v)],
  ];
  const grid = document.createElement('div');
  grid.className = 'check-grid';
  for (const [label, get, set] of checks) {
    const l = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = get();
    cb.addEventListener('change', () => {
      set(cb.checked);
      renderAll();
    });
    l.append(cb, document.createTextNode(label));
    grid.append(l);
  }
  g.append(grid);
  const btn = document.createElement('button');
  btn.textContent = '镜头聚焦镜像接缝';
  btn.style.width = '100%';
  btn.style.marginTop = '6px';
  btn.addEventListener('click', () => {
    state.camera = { yawDeg: 0, pitchDeg: 8, distance: 5.2 };
    renderAll();
  });
  g.append(btn);
  return g;
}

function channelGroup(): HTMLElement {
  const g = group('7 · 原始纹理通道');
  const canvas = document.createElement('canvas');
  canvas.id = 'channelCanvas';
  canvas.width = 256;
  canvas.height = 256;
  g.append(canvas);
  const views: [ChannelView, string][] = [
    ['rgb', 'RGB'],
    ['r', 'R'],
    ['g', 'G'],
    ['b', 'B'],
    ['a', 'A'],
    ['height', '高度场'],
  ];
  g.append(
    seg(
      views,
      () => state.channelView,
      (v) => {
        state.channelView = v;
      },
      false,
    ),
  );
  const title = document.createElement('p');
  title.className = 'note';
  title.textContent = channelLabel(state.channelView);
  const info = document.createElement('pre');
  info.className = 'info';
  info.id = 'channelInfo';
  g.append(title, info);
  return g;
}

function selectionGroup(): HTMLElement {
  const g = group('8 · 选中面：表面法线与贴图坐标轴');
  const info = document.createElement('pre');
  info.className = 'info';
  info.id = 'selectionInfo';
  g.append(info);
  return g;
}

function invalidGroup(): HTMLElement {
  const g = group('9 · 缺失/无法决定方向的面');
  const list = document.createElement('div');
  list.className = 'face-list';
  list.id = 'invalidList';
  g.append(list);
  const note = document.createElement('p');
  note.className = 'note';
  note.id = 'invalidNote';
  g.append(note);
  return g;
}

function reportGroup(): HTMLElement {
  const g = group('10 · 接缝对照报告');
  const row = document.createElement('div');
  row.className = 'row';
  const mkBtn = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  };
  row.append(
    mkBtn('生成报告', () => {
      const r = buildSeamReport(mesh, world, texture, state);
      if (!r) return alert('没有找到含两侧面的接缝。');
      (document.getElementById('reportPreview') as HTMLPreElement).textContent = reportToText(r);
    }),
    mkBtn('下载 .txt', () => {
      const r = buildSeamReport(mesh, world, texture, state);
      if (r) downloadText(`seam-report-${Date.now()}.txt`, reportToText(r));
    }),
    mkBtn('下载 .json', () => {
      const r = buildSeamReport(mesh, world, texture, state);
      if (r) downloadJson(`seam-report-${Date.now()}.json`, r);
    }),
  );
  const preview = document.createElement('pre');
  preview.className = 'info';
  preview.id = 'reportPreview';
  preview.textContent = '点击“生成报告”查看接缝两侧的贴图方向与着色数值。';
  g.append(row, preview);
  return g;
}

// ---------- 动态信息更新 ----------
function updateSelectionPanel(): void {
  const info = document.getElementById('selectionInfo');
  if (!info) return;
  const sel = state.selection;
  if (sel.faceId === null) {
    info.textContent = '在任一视口点击三角面进行选择。\n红=T（沿 u）  绿=B（沿 v）  蓝=N（表面法线）';
    return;
  }
  const face = world.faces[sel.faceId];
  const src = effectiveFrame(mesh.faces[sel.faceId]);
  const f = (v: number[]) => v.map((n) => n.toFixed(3)).join(', ');
  const lightDir = lightDirection(state.light.yawDeg, state.light.pitchDeg);
  const camYaw = (state.camera.yawDeg * Math.PI) / 180;
  const camPitch = (state.camera.pitchDeg * Math.PI) / 180;
  const eye: [number, number, number] = [
    state.camera.distance * Math.cos(camPitch) * Math.sin(camYaw),
    state.camera.distance * Math.sin(camPitch),
    state.camera.distance * Math.cos(camPitch) * Math.cos(camYaw),
  ];
  const viewDir = v3.normalize(v3.neg(eye));
  const shading = shadePoint({
    face,
    uv: [sel.u, sel.v],
    texture,
    convention: state.convention,
    lightDir,
    viewDir,
    diffuse: state.diffuseIntensity,
    specular: state.specularIntensity,
    shininess: state.shininess,
  });
  info.textContent = [
    `面 #${face.id}（${face.half === 'normalUV' ? '普通 UV 半' : '镜像 UV 半'}，折面 ${face.panelId}）`,
    `UV = (${sel.u.toFixed(4)}, ${sel.v.toFixed(4)})`,
    `UV 有向面积符号 = ${src.uvAreaSign}（-1 即镜像翻转）   手性 = ${src.handedness}`,
    `有效 = ${face.valid}${face.reason ? `  ⚠ ${face.reason}` : ''}`,
    '',
    `世界 T (沿 u, 红) = (${f(face.frame.T)})`,
    `世界 B (沿 v, 绿) = (${f(face.frame.B)})`,
    `世界 N (法线, 蓝) = (${f(face.frame.N)})`,
    '',
    `贴图法线(切线空间) = (${f(shading.tangentNormal)})`,
    `扰动后世界法线    = (${f(shading.worldNormal)})`,
    `几何法线          = (${f(shading.geometricNormal)})`,
    `Lambert = ${shading.lambert.toFixed(4)}   高光 = ${shading.spec.toFixed(4)}`,
    `最终颜色 = (${shading.color.map((n) => n.toFixed(3)).join(', ')})`,
  ].join('\n');
}

function updateChannelPanel(): void {
  const canvas = document.getElementById('channelCanvas') as HTMLCanvasElement | null;
  if (!canvas) return;
  const cross: [number, number] | null =
    state.selection.faceId !== null ? [state.selection.u, state.selection.v] : null;
  drawChannelCanvas(canvas, texture, state.channelView, state.convention, cross);
  const info = document.getElementById('channelInfo');
  if (info) {
    info.textContent =
      cross !== null
        ? texelInfo(texture, cross, state.convention)
        : '选中一个面后在此显示该 UV 的原始通道字节。';
  }
  const title = info?.previousElementSibling;
  if (title instanceof HTMLElement) title.textContent = channelLabel(state.channelView);
}

function updateFoot(): void {
  const invalid = mesh.faces.filter((f) => !effectiveFrame(f).valid);
  const conflicts = mesh.coincident.filter((g) => g.directionConflict);
  viewportFoot.innerHTML =
    `<b>图例：</b>` +
    `<span class="legend-fold">■ 折痕硬边</span> · ` +
    `<span class="legend-mirror">■ 镜像接缝（重合空间顶点不共享贴图方向）</span> · ` +
    `<span class="legend-bad">■ 红斜纹=无法决定方向的面</span><br>` +
    `当前预设 <b>${mesh.preset}</b>：${mesh.presetNote}<br>` +
    `重合顶点组 ${mesh.coincident.length} 个，其中贴图方向冲突 ${conflicts.length} 个；` +
    `无效面 ${invalid.length} 个。拖拽旋转（按第 5 组模式决定转相机还是灯），滚轮缩放，点击拾取。`;
  const list = document.getElementById('invalidList');
  const note = document.getElementById('invalidNote');
  if (list) {
    list.innerHTML = '';
    if (invalid.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'note';
      empty.textContent = '所有面的贴图方向均可决定。';
      list.append(empty);
    }
    for (const f of invalid) {
      const b = document.createElement('button');
      b.className = 'invalid' + (state.selection.faceId === f.id ? ' selected' : '');
      b.textContent = `面 #${f.id}：${effectiveFrame(f).reason ?? '方向无效'}`;
      b.addEventListener('click', () => {
        state.selection = {
          faceId: f.id,
          u: 0.5,
          v: 0.5,
          half: f.half,
        };
        renderAll();
      });
      list.append(b);
    }
  }
  if (note) {
    note.className = invalid.length ? 'note bad' : 'note';
    note.textContent = invalid.length
      ? `共 ${invalid.length} 个面无法决定贴图方向，已在 3D 视图中以红斜纹标出并列入报告。`
      : '无异常。';
  }
}

// ---------- 拾取 ----------
function bindPicking(vp: WebGLViewport, canvas: HTMLCanvasElement): void {
  canvas.addEventListener('click', (e) => {
    const hit = vp.pick(e.clientX, e.clientY, state.camera, world);
    if (!hit) return;
    state.selection = {
      faceId: hit.face.id,
      u: hit.uv[0],
      v: hit.uv[1],
      half: hit.face.half,
    };
    renderAll();
  });
}

// ---------- 启动 ----------
function main(): void {
  buildTopActions();
  buildSidePanel();
  for (const [vp, canvas] of [
    [vpLeft, canvasLeft],
    [vpRight, canvasRight],
    [vpAll, canvasAll],
  ] as const) {
    bindPicking(vp, canvas);
    attachOrbit(canvas, () => orbitTarget, state.camera, state.light, () => renderAll());
  }
  window.addEventListener('resize', () => renderAll());
  renderAll();
}

main();
