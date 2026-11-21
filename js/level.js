/* 内置演示小图：低顶、矮阶、刚够距离三种情形齐全；以及关卡存档。 */
(function () {
  const JR = (window.JR = window.JR || {});

  let seq = 1;
  function nid() {
    return 'e' + seq++;
  }

  function plat(x, y, w, h = 16, oneWay = false) {
    return { id: nid(), type: 'platform', x, y, w, h, oneWay };
  }
  function overhead(x, y, w, h = 16) {
    return { id: nid(), type: 'overhead', x, y, w, h };
  }
  function start(x, y, w, h) {
    return { id: nid(), type: 'start', x, y, w, h };
  }

  /* 演示图布局（y 向下，单位 px；坐标依据 tests/measure.mjs 与 tests/tune.mjs 实测反推）：
     P1 起跳地面；P2 矮阶（高 64：A 跳 121 轻松、B 跳 76 极限够不到）；
     低顶跨在 P1→P3 缺口上方：满弧线 133 条策略撞头，短跳（按住 0.3s 内）可从下方通过落到 P3；
     P4 远台目标：起跳区左上方、高差 96 的极限位置（A 最大跳高 121 刚够、B 76 够不到）；
     P5 薄平台：右侧高处，从下往上穿过、向下落才接住。 */
  function demoLevel() {
    seq = 1;
    const entities = [];
    const p1 = plat(0, 400, 300, 40);
    const p2 = plat(96, 336, 72, 16); // 矮阶：P1 左段上方，顶面高 64
    const p4 = plat(100, 304, 80, 16); // 远台目标：高差 64 + 水平 102，A 可达、B 横移余量不足够不到
    const ceil = overhead(275, 352, 80, 14); // 低顶：底面 y=366 净空 34，满跳撞头短跳过
    const p3 = plat(410, 400, 120, 40); // 缺口 110（300→410），低顶后落点
    const p5 = plat(560, 300, 84, 8, true); // 薄平台：右侧高处，演示从下穿
    const st = start(210, 336, 64, 64); // 起跳区域：靠右，边缘出生
    entities.push(p1, p2, p4, ceil, p3, p5, st);
    return { entities, targetId: p4.id };
  }

  const STORE_KEY = 'jump-reachability-saves-v1';

  function listSaves() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveLevel(name, level, paramsA, paramsB) {
    const saves = listSaves();
    const rec = {
      name,
      at: new Date().toISOString(),
      level: JSON.parse(JSON.stringify(level)),
      paramsA: JSON.parse(JSON.stringify(paramsA)),
      paramsB: JSON.parse(JSON.stringify(paramsB)),
    };
    const idx = saves.findIndex((s) => s.name === name);
    if (idx >= 0) saves[idx] = rec;
    else saves.push(rec);
    localStorage.setItem(STORE_KEY, JSON.stringify(saves));
    return rec;
  }

  function deleteSave(name) {
    localStorage.setItem(STORE_KEY, JSON.stringify(listSaves().filter((s) => s.name !== name)));
  }

  function exportJSON(rec) {
    return JSON.stringify(rec, null, 2);
  }

  function importJSON(text) {
    const rec = JSON.parse(text);
    if (!rec.level || !Array.isArray(rec.level.entities)) throw new Error('存档格式不正确：缺少 level.entities');
    return rec;
  }

  JR.demo = { demoLevel, nid };
  JR.storage = { listSaves, saveLevel, deleteSave, exportJSON, importJSON };
})();
