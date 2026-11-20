// 项目存档与实例清单导出。
// 存档是纯 JSON（.json 文本），包含：地形高度场、遮罩、规则、种子、格状态与实例快照。

import { Terrain } from './terrain.js';
import { PaintMask } from './mask.js';
import { ScatterLayer } from './scatter.js';
import { ruleToJSON, ruleFromJSON } from './rules.js';
import { SCHEMA_VERSION, DEFAULT_SEED } from './constants.js';

/**
 * 保存项目（可 JSON.stringify 的普通对象）。
 * @param {{name?:string, terrain:Terrain, mask:PaintMask, scatter:ScatterLayer, rules:Array}} data
 */
export function saveProject({ name = 'vegetation-project', terrain, mask, scatter, rules }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    savedAt: new Date().toISOString(),
    seed: scatter.seed,
    rules: rules.map(ruleToJSON),
    terrain: terrain.toJSON(),
    mask: mask.toJSON(),
    scatter: scatter.toJSON(),
  };
}

/**
 * 恢复项目：重建地形引用、遮罩、规则与散布层（实例位置逐格还原）。
 * @returns {{name, terrain, mask, rules, scatter}}
 */
export function loadProject(json) {
  if (!json || json.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`不支持的项目版本（期望 ${SCHEMA_VERSION}）`);
  }
  const terrain = Terrain.fromJSON(json.terrain);
  const mask = PaintMask.fromJSON(json.mask);
  const rules = json.rules.map(ruleFromJSON);
  const scatter = new ScatterLayer({
    terrain,
    mask,
    rules,
    seed: json.seed ?? DEFAULT_SEED,
    cellSize: json.scatter.cellSize,
  });
  scatter.loadState(json.scatter, rules);
  return { name: json.name ?? 'restored-project', terrain, mask, rules, scatter };
}

/**
 * 导出实例清单（JSON 字符串）。
 * 每个实例含世界坐标、四元数、缩放与规则信息，字段命名兼容常见 DCC 导入流程。
 */
export function exportInstancesJSON(scatter, rules) {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const instances = scatter.getAllInstances().map((inst) => {
    const rule = ruleById.get(inst.ruleId);
    return {
      id: inst.cellIndex,
      model: inst.ruleId,
      kind: rule?.kind ?? 'unknown',
      name: rule?.name ?? inst.ruleId,
      position: {
        x: round(inst.x),
        y: round(inst.y),
        z: round(inst.z),
      },
      // 仅绕 Y 的旋转角（度），同时给出四元数方便直接接入
      rotationYDeg: round((inst.rotationY * 180) / Math.PI),
      quaternion: eulerYToQuaternion(inst.rotationY),
      scale: round(inst.scale),
      normal: {
        x: round(inst.normal.x),
        y: round(inst.normal.y),
        z: round(inst.normal.z),
      },
    };
  });
  return JSON.stringify(
    {
      format: 'vegetation-instances',
      schemaVersion: SCHEMA_VERSION,
      count: instances.length,
      seed: scatter.seed,
      instances,
    },
    null,
    2,
  );
}

/** 导出 CSV 实例清单（含表头）。 */
export function exportInstancesCSV(scatter, rules) {
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  const header = 'id,model,kind,posX,posY,posZ,rotationYDeg,scale,normalX,normalY,normalZ';
  const lines = [header];
  for (const inst of scatter.getAllInstances()) {
    const rule = ruleById.get(inst.ruleId);
    lines.push([
      inst.cellIndex,
      inst.ruleId,
      rule?.kind ?? 'unknown',
      round(inst.x), round(inst.y), round(inst.z),
      round((inst.rotationY * 180) / Math.PI),
      round(inst.scale),
      round(inst.normal.x), round(inst.normal.y), round(inst.normal.z),
    ].join(','));
  }
  return lines.join('\n');
}

function round(v) {
  return Math.round(v * 1e5) / 1e5;
}

// 纯绕 Y 旋转 → 单位四元数 (x,y,z,w)
function eulerYToQuaternion(rotY) {
  const half = rotY / 2;
  return {
    x: 0,
    y: round(Math.sin(half)),
    z: 0,
    w: round(Math.cos(half)),
  };
}
