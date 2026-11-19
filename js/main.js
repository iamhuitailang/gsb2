/* 启动：优先恢复本地存档，否则加载示例或新建 */
'use strict';

window.addEventListener('DOMContentLoaded', () => {
  initEditor();
  initUI();

  const saved = loadFromLocal();
  if (saved && saved.level) {
    setLevel(saved.level);
    toast('已恢复上次编辑的地图');
  } else if (window.SAMPLE_LEVEL) {
    const { level } = deserializeLevel(JSON.parse(JSON.stringify(window.SAMPLE_LEVEL)));
    if (level) setLevel(level);
  }
  if (!Ed.level) {
    const level = createLevel('未命名关卡', 16, 60, 34);
    level.layers.push(createLayer('图层 1', 16));
    setLevel(level);
  }
});
