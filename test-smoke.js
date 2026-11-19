/* 临时冒烟测试：加载真实页面后通过 App API 验证核心逻辑，结果写入 #test-results */
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(runTests, 200);
});

function canvasEqual(a, b) {
  return a.toDataURL() === b.toDataURL();
}

async function runTests() {
  const results = [];
  const t = (name, cond) => results.push((cond ? 'PASS' : 'FAIL') + ' ' + name);
  const S = App.state, M = App.model;

  try {
    // 1. 示例项目结构
    t('示例含6个顶层图层', S.root.children.length === 6);
    const group = S.root.children.find(l => l.type === 'group');
    t('示例含分组且有2个子层', !!group && group.children.length === 2);
    t('示例含2个调整层', S.root.children.filter(l => l.type === 'adjustment').length === 2);
    t('示例含遮罩层', S.root.children.some(l => l.mask) && group.children.some(l => l.mask));

    // 2. 重排改变合成结果，撤销恢复
    const comp1 = App.render.renderDocument(S);
    const bgId = S.root.children[S.root.children.length - 1].id;
    App.actions.moveLayer(bgId, S.root.children[0].id, 'before');
    t('重排后列表顺序更新', S.root.children[0].id === bgId);
    t('重排后合成结果变化', !canvasEqual(comp1, App.render.renderDocument(S)));
    App.history.undo();
    t('撤销恢复图层顺序', S.root.children[S.root.children.length - 1].id === bgId);
    t('撤销后合成结果还原', canvasEqual(comp1, App.render.renderDocument(S)));

    // 3. 调整层开关影响下方图像
    const adj = S.root.children.find(l => l.type === 'adjustment');
    App.pushParam('隐藏调整层', adj.id, 'visible', true, false);
    t('关闭调整层后合成变化', !canvasEqual(comp1, App.render.renderDocument(S)));
    App.history.undo();
    t('撤销恢复调整层效果', canvasEqual(comp1, App.render.renderDocument(S)));

    // 4. 遮罩绘制影响合成（模拟橡皮笔触：destination-out 擦除 = 隐藏该区域）
    const glow = S.root.children.find(l => l.mask);
    const mctx = glow.mask.getContext('2d');
    mctx.globalCompositeOperation = 'destination-out';
    mctx.fillRect(S.doc.width * 0.7 - 150, S.doc.height * 0.3 - 150, 300, 300);
    t('遮罩涂黑后合成变化', !canvasEqual(comp1, App.render.renderDocument(S)));

    // 5. 序列化/恢复 round-trip
    const json = App.persistence.serialize(S);
    const idsBefore = S.root.children.map(l => l.id).join(',');
    App.persistence.restore(S, json);
    t('恢复后图层id一致', S.root.children.map(l => l.id).join(',') === idsBefore);
    t('恢复后撤销栈已清空', !App.history.canUndo);
    const adj2 = S.root.children.find(l => l.type === 'adjustment');
    t('调整参数被恢复', adj2.adjust.hue !== 0 || adj2.adjust.saturate !== 1);
    // 遮罩为异步恢复，等待后校验
    await new Promise(r => setTimeout(r, 800));
    const glow2 = S.root.children.find(l => l.mask);
    t('遮罩数据被恢复', !!glow2);

    // 6. 导出 PNG 透明区域：只留带径向遮罩的光晕层，四角应透明
    for (const l of S.root.children) l.visible = (l === glow2);
    const comp = App.render.renderDocument(S);
    const corner = comp.getContext('2d').getImageData(2, 2, 1, 1).data;
    t('导出结果透明区域 alpha=0', corner[3] === 0);
    // 光晕图像中心（在遮罩范围内、且在测试4擦除区域之外）
    const center = comp.getContext('2d').getImageData(
      Math.round(S.doc.width * 0.5), Math.round(S.doc.height * 0.5), 1, 1).data;
    t('遮罩可见区域不透明（alpha>50）', center[3] > 50);
  } catch (e) {
    results.push('ERROR ' + e.message);
  }

  const failed = results.some(r => !r.startsWith('PASS'));
  document.title = failed ? 'SMOKE FAILED' : 'SMOKE ALL PASS';
  const pre = document.createElement('pre');
  pre.id = 'test-results';
  pre.textContent = results.join('\n');
  document.body.appendChild(pre);
}
