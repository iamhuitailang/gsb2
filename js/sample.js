/* 内置示例项目：包含遮罩、分组与调整层，可逐层开关比较合成结果。
 * 遮罩由程序生成（渐变），图像素材全部来自 js/generators.js。 */
window.App = window.App || {};

App.sample = (function () {

  /* 径向渐变遮罩：中心不透明（显示）→ 边缘透明（隐藏）。
   * 遮罩统一用 alpha 通道表达：不透明=显示，透明=隐藏。 */
  function radialMask(state, cx, cy, r) {
    const c = App.util.makeCanvas(state.doc.width, state.doc.height);
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.65)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /* 水平线性渐变遮罩：左显示右隐藏 */
  function linearMask(state) {
    const c = App.util.makeCanvas(state.doc.width, state.doc.height);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, c.width, 0);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function build(state) {
    const W = state.doc.width, H = state.doc.height;
    const M = App.model;

    // 背景：天空渐变
    const bg = M.createImageLayer('背景 · 天空渐变', 'sky', W, H);

    // 噪点纹理（叠加，增加颗粒感）
    const noise = M.createImageLayer('噪点纹理（叠加）', 'noise', W, H);
    noise.blendMode = 'overlay';
    noise.opacity = 0.28;

    // 提亮调整层：作用于它下方的背景与噪点
    const adjBright = M.createAdjustment('调整 · 提亮');
    adjBright.adjust.brightness = 1.12;
    adjBright.adjust.contrast = 1.08;

    // 组：装饰图形（条纹 + 散景），组本身带径向遮罩
    const group = M.createGroup('组 · 装饰图形');
    group.opacity = 0.9;
    group.mask = radialMask(state, W * 0.5, H * 0.45, W * 0.55);

    const stripes = M.createImageLayer('斜条纹（叠加+渐变遮罩）', 'stripes', W, H);
    stripes.blendMode = 'overlay';
    stripes.opacity = 0.55;
    stripes.mask = linearMask(state);

    const bokeh = M.createImageLayer('散景圆点（滤色）', 'bokeh', W, H);
    bokeh.blendMode = 'screen';
    bokeh.opacity = 0.85;

    group.children = [bokeh, stripes]; // 顶层在前

    // 暖色调调整层：作用于下方所有内容
    const adjWarm = M.createAdjustment('调整 · 暖色调');
    adjWarm.adjust.hue = 18;
    adjWarm.adjust.saturate = 1.3;
    adjWarm.adjust.brightness = 1.05;

    // 顶部光晕
    const glow = M.createImageLayer('顶部光晕（滤色+径向遮罩）', 'radial', W, H);
    glow.blendMode = 'screen';
    glow.opacity = 0.75;
    glow.mask = radialMask(state, W * 0.7, H * 0.3, W * 0.4);

    // children 顶层在前
    state.root.children = [glow, adjWarm, group, adjBright, noise, bg];
    state.selectedId = null;
    state.maskEditId = null;
    App.history.clear();
    App.refreshUI();
    App.requestRender();
  }

  return { build };
})();
