/*
 * export.js — 导出运行配置
 * 剥离：previewOnly 组件及其子树、预览辅助字段、假数据
 * 保留：锚点/尺寸/条件/真实数据绑定，供真实游戏运行时消费
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var api = factory(require('./model.js'));
    module.exports = api;
    root.ULCExport = api;
  } else root.ULCExport = factory(root.ULCModel);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  /* 仅编辑器使用、运行时不需要的字段 */
  var STRIP_FIELDS = ['previewOnly'];

  function buildRuntimeConfig(nodes, screens, activeStateName) {
    var dropped = { previewOnly: 0, fields: 0, fakeBindings: 0 };

    var excluded = {};
    nodes.forEach(function (n) {
      if (n.previewOnly) {
        excluded[n.id] = true;
        dropped.previewOnly++;
        M.descendantIds(nodes, n.id).forEach(function (d) { excluded[d] = true; });
      }
    });

    var runtimeNodes = nodes.filter(function (n) { return !excluded[n.id]; }).map(function (n) {
      var out = {};
      for (var k in n) {
        if (STRIP_FIELDS.indexOf(k) >= 0) { dropped.fields++; continue; }
        out[k] = n[k];
      }
      // 文本：有绑定出绑定，否则出静态文本；预览变量绑定若没有对应 dataBinding 视为假数据剔除
      if (out.textVar && !n.dataBinding) {
        delete out.textVar;
        dropped.fakeBindings++;
      }
      if (out.fillVar && !n.dataBinding) {
        delete out.fillVar;
        dropped.fakeBindings++;
      }
      return out;
    });

    return {
      meta: {
        format: 'ui-layout-runtime/v1',
        exportedAt: new Date().toISOString(),
        note: '运行配置：不含编辑器辅助线与预览假数据'
      },
      screens: screens,
      initialState: activeStateName || 'default',
      nodes: runtimeNodes,
      dropped: dropped
    };
  }

  /* 预览工程文件：完整可编辑配置（含 previewOnly），用于在另一台机器上继续检查 */
  function buildEditorProject(nodes, screens, previews) {
    return {
      meta: { format: 'ui-layout-editor/v1', exportedAt: new Date().toISOString() },
      screens: screens,
      previews: previews.map(function (p) {
        return { name: p.name, screenId: p.screenId, vars: p.vars, showGuides: p.showGuides };
      }),
      nodes: nodes
    };
  }

  return {
    buildRuntimeConfig: buildRuntimeConfig,
    buildEditorProject: buildEditorProject
  };
});
