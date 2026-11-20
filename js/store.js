// 应用状态与布光方案数据模型
// 方案 = 灯光集合 + 环境光 + 阴影开关 + 对象材质/可见性覆盖
// 因此两个方案做 diff 时可以明确区分“变化来自灯光”还是“来自材质/对象”
import { MATERIAL_LIBRARY, materialName } from './materials.js';

export const state = {
  lights: [],            // 灯光描述数组（见 scene.js defaultLights）
  ambient: { enabled: true, color: '#404654', intensity: 0.6 },
  shadows: true,         // 阴影总开关（只切换渲染开关，不改动任何几何）
  showHelpers: true,     // 是否显示灯光覆盖范围
  overrides: {},         // oid -> { hidden, materialKey, color }
  schemes: [],           // 已保存的布光方案
  camera: { position: [10, 8, 12], target: [0, 1.5, 0] },
  nextLightId: 100,
};

// 深拷贝（状态均为纯 JSON 数据）
const clone = o => JSON.parse(JSON.stringify(o));

export function snapshotScheme(name) {
  return {
    name,
    lights: clone(state.lights),
    ambient: clone(state.ambient),
    shadows: state.shadows,
    overrides: clone(state.overrides),
  };
}

export function applySchemeToState(scheme) {
  state.lights = clone(scheme.lights);
  state.ambient = clone(scheme.ambient);
  state.shadows = scheme.shadows;
  state.overrides = clone(scheme.overrides || {});
}

// ---------- 序列化（项目保存 / 恢复） ----------
export function serializeProject() {
  return {
    app: 'lighting-workbench',
    version: 1,
    savedAt: new Date().toISOString(),
    lights: state.lights,
    ambient: state.ambient,
    shadows: state.shadows,
    overrides: state.overrides,
    schemes: state.schemes,
    camera: state.camera,
    nextLightId: state.nextLightId,
  };
}

export function loadProject(data) {
  if (!data || data.app !== 'lighting-workbench') throw new Error('不是有效的项目文件');
  state.lights = data.lights || [];
  state.ambient = data.ambient || { enabled: true, color: '#404654', intensity: 0.6 };
  state.shadows = data.shadows !== false;
  state.overrides = data.overrides || {};
  state.schemes = data.schemes || [];
  state.camera = data.camera || { position: [10, 8, 12], target: [0, 1.5, 0] };
  state.nextLightId = data.nextLightId || 1000;
}

// ---------- 方案差异比较 ----------
const LIGHT_PROP_NAMES = {
  color: '颜色', intensity: '强度', position: '位置', target: '目标点',
  distance: '范围', angle: '角度', penumbra: '半影', decay: '衰减',
  castShadow: '投射阴影', visible: '启用', name: '名称', type: '类型',
};

function fmtVal(v) {
  if (Array.isArray(v)) return '(' + v.map(n => (+n).toFixed(1)).join(', ') + ')';
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (typeof v === 'number') return (+v).toFixed(2).replace(/\.?0+$/, '');
  return String(v);
}

function sameVal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// 返回 { lights: [...], materials: [...] }，分别描述灯光侧与材质/对象侧的变化
export function diffSchemes(a, b, objectLabel) {
  const lights = [];
  const materials = [];
  const label = objectLabel || (oid => oid);

  // 灯光差异
  const mapA = new Map(a.lights.map(l => [l.id, l]));
  const mapB = new Map(b.lights.map(l => [l.id, l]));
  for (const [id, la] of mapA) {
    const lb = mapB.get(id);
    if (!lb) { lights.push(`灯光「${la.name}」被移除`); continue; }
    for (const key of Object.keys(LIGHT_PROP_NAMES)) {
      if (key === 'id') continue;
      if (!sameVal(la[key], lb[key])) {
        lights.push(`灯光「${lb.name}」${LIGHT_PROP_NAMES[key]}：${fmtVal(la[key])} → ${fmtVal(lb[key])}`);
      }
    }
  }
  for (const [id, lb] of mapB) {
    if (!mapA.has(id)) lights.push(`新增灯光「${lb.name}」`);
  }

  // 环境光 / 阴影
  if (a.shadows !== b.shadows) lights.push(`阴影总开关：${a.shadows ? '开' : '关'} → ${b.shadows ? '开' : '关'}`);
  if (a.ambient.enabled !== b.ambient.enabled) {
    lights.push(`环境光：${a.ambient.enabled ? '开' : '关'} → ${b.ambient.enabled ? '开' : '关'}`);
  } else if (a.ambient.enabled) {
    if (a.ambient.color !== b.ambient.color) lights.push(`环境光颜色：${a.ambient.color} → ${b.ambient.color}`);
    if (a.ambient.intensity !== b.ambient.intensity) {
      lights.push(`环境光强度：${fmtVal(a.ambient.intensity)} → ${fmtVal(b.ambient.intensity)}`);
    }
  }

  // 材质 / 对象可见性差异
  const oids = new Set([...Object.keys(a.overrides || {}), ...Object.keys(b.overrides || {})]);
  for (const oid of oids) {
    const oa = (a.overrides || {})[oid] || {};
    const ob = (b.overrides || {})[oid] || {};
    const name = label(oid);
    if (!!oa.hidden !== !!ob.hidden) {
      materials.push(`对象「${name}」：${oa.hidden ? '隐藏' : '显示'} → ${ob.hidden ? '隐藏' : '显示'}`);
    }
    const ka = oa.materialKey || null, kb = ob.materialKey || null;
    if (ka !== kb) {
      materials.push(`对象「${name}」材质：${materialName(ka)} → ${materialName(kb)}`);
    } else if (kb && oa.color !== ob.color) {
      materials.push(`对象「${name}」材质颜色：${oa.color || MATERIAL_LIBRARY[kb].defaultColor} → ${ob.color || MATERIAL_LIBRARY[kb].defaultColor}`);
    }
  }

  return { lights, materials };
}
