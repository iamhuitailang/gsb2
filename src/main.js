// 应用入口：生成示例地形 → 组装核心世界 → 启动编辑器与面板。

import './styles.css';
import { generateTerrain } from './core/terrain.js';
import { PaintMask } from './core/mask.js';
import { ScatterLayer } from './core/scatter.js';
import { DEFAULT_RULES } from './core/rules.js';
import { DEFAULT_SEED } from './core/constants.js';
import { Editor } from './ui/editor.js';
import { Panel } from './ui/panel.js';
import { saveProject, loadProject, exportInstancesJSON, exportInstancesCSV } from './core/project.js';

function bootstrap() {
  // —— 程序生成的小地形与默认树草规则（无需任何外部资源）——
  const terrain = generateTerrain({ size: 128, resolution: 129, seed: DEFAULT_SEED });
  const mask = new PaintMask({ width: terrain.width, depth: terrain.depth, cellSize: 1 });
  const rules = DEFAULT_RULES();
  const scatter = new ScatterLayer({ terrain, mask, rules, seed: DEFAULT_SEED });

  const world = { terrain, mask, scatter, rules };

  const canvas = document.querySelector('#viewport');
  const panelRoot = document.querySelector('#panel');

  const editor = new Editor(canvas, world, {
    onStats: (stats, pending) => panel.setStats(stats, pending),
    onStroke: () => editor.refreshStats(),
  });

  const panel = new Panel(panelRoot, {
    getRules: () => rules,
    getSeed: () => scatter.seed,
    getWorld: () => ({ name: 'vegetation-project', terrain, mask, scatter, rules }),
    setTool: (tool) => editor.setTool(tool),
    setBrushRadius: (v) => editor.setBrushRadius(v),
    setBrushStrength: (v) => editor.setBrushStrength(v),
    setMaskMode: (m) => editor.setMaskMode(m),
    setReplaceRule: (id) => editor.setReplaceRule(id),
    toggleChunks: (v) => editor.toggleChunks(v),
    toggleMask: (v) => editor.toggleMask(v),
    setSeed: (seed) => {
      editor.setSeed(seed);
      editor.refreshStats();
    },
    applyRules: (nextRules) => {
      editor.applyRules(nextRules);
      editor.refreshStats();
    },
    replaceWorld: (restored) => {
      // 用恢复出的对象替换闭包里的世界引用
      Object.assign(world, restored);
      editor.replaceWorld(restored);
    },
  });

  editor.refreshStats();

  // 暴露给控制台调试 / README 中的高级用法
  window.__veg = {
    world,
    editor,
    panel,
    saveProject,
    loadProject,
    exportInstancesJSON,
    exportInstancesCSV,
  };
}

bootstrap();
