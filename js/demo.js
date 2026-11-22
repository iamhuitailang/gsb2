/* 演示数据：默认规则集 + 带内洞与狭窄连接的地图（程序化生成，无需资源文件） */
(function (global) {
  'use strict';

  const E = global.TileEngine;

  function makeDefaultRules() {
    const rules = E.emptyRuleset();
    rules.terrains = [
      { id: 'grass', name: '草地', color: '#58b368' },
      { id: 'stone', name: '岩石', color: '#9aa3b2' },
      { id: 'water', name: '水域', color: '#4a90d9' },
    ];

    rules.terrains.forEach((t, ti) => {
      E.ensureTerrainSlots(rules, t.id);
      let base = 100 * (ti + 1);
      for (const cat of E.CAT_ORDER) {
        E.registry.shapes[cat].forEach((shape, si) => {
          const slot = rules.tiles[t.id][cat][si];
          // 故意留缺项，且都能在演示地图上实际出现：
          // 岩石缺 edge 的一个端头形态；水域缺 connector（贯通细带会命中）
          const intentionallyMissing =
            (t.id === 'stone' && cat === 'edge' && si === 0) ||
            (t.id === 'water' && cat === 'connector' && si === 0);
          if (!intentionallyMissing) {
            slot.tileId = base++;
            // 内部图块给两个外观变体，演示变体与可复现性
            if (cat === 'interior' && si === 0 && t.id === 'grass') {
              slot.variantIds = ['grass-in-a', 'grass-in-b'];
            }
          }
        });
      }
    });

    // 自定义规则：演示覆盖与同优先级冲突检测（两条 priority 相同的规则）
    rules.customRules = [
      {
        id: 'r1',
        name: '草地西北角有石邻接时用专用块',
        terrain: 'grass',
        priority: 10,
        match: [-1, -1, -1, -1, -1, -1, -1, 0], // NW 必须不是草地
        tileId: 9001,
        rot: 0,
        variantIds: [],
      },
      {
        id: 'r2',
        name: '冲突演示：同优先级、更宽的条件',
        terrain: 'grass',
        priority: 10, // 与 r1 同优先级，同时命中时检查器会标红并列出双方
        match: [-1, -1, -1, -1, -1, -1, -1, -1],
        tileId: 9002,
        rot: 0,
        variantIds: [],
      },
    ];
    rules.nextCustomRuleId = 3;
    return rules;
  }

  /*
   * 地图布局（20x14），#=草地 o=石头 ~=水 .=空
   * 包含：1 格宽狭窄连接（草地第 7 行）、完全内洞（草地内部）、
   * 1 格宽贯通水渠（产生 connector）、石头端头（产生 edge）。
   */
  const LAYOUT = [
    '....................',
    '...####..........o..',
    '..######........oo..',
    '..##..##......oooo..',
    '..##..##......oo....',
    '..#######......o....',
    '....####............',
    '......#.............',
    '......#.#######.....',
    '......#####.#####...',
    '......#####...###...',
    '..~~..############..',
    '.~~~~~~~~~~~~~~~~...',
    '..~~................',
  ];

  function makeDemoGrid() {
    const h = LAYOUT.length;
    const w = LAYOUT[0].length;
    const g = new E.Grid(w, h);
    const map = { '#': 'grass', 'o': 'stone', '~': 'water' };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = LAYOUT[y][x];
        if (map[ch]) g.set(x, y, map[ch]);
      }
    }
    return g;
  }

  global.TileDemo = { makeDefaultRules, makeDemoGrid };
})(typeof window !== 'undefined' ? window : globalThis);
