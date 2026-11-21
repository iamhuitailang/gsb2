/*
 * measure.js — 用 canvas + 本机字体测量文本，输出组件内在尺寸
 * 引擎不依赖 DOM；这里提供浏览器侧的测量实现，Node 测试可注入假测量
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    factory(global);
    module.exports = global.ULCMeasure;
  } else factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var FONT_STACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", sans-serif';
  var FONT_SIZE = 13;
  var ICON_BOX = { w: 22, h: 22 };
  var TEXT_PAD_X = 2;

  var ctx = null;
  function canvasCtx() {
    if (ctx) return ctx;
    if (typeof document === 'undefined') return null;
    ctx = document.createElement('canvas').getContext('2d');
    ctx.font = FONT_SIZE + 'px ' + FONT_STACK;
    return ctx;
  }

  function textWidth(str) {
    var c = canvasCtx();
    if (!c) return str.length * FONT_SIZE; // Node 兜底：每字按字号宽估算
    return c.measureText(str).width;
  }

  function resolveVar(node, vars) {
    if (node.textVar && vars[node.textVar] != null) return String(vars[node.textVar]);
    return node.text || '';
  }

  /* 超出 maxWidth 时返回省略号截断后的显示文本（渲染层与测量共用） */
  function ellipsize(str, maxWidth) {
    if (!maxWidth || maxWidth <= 0) return str;
    var full = textWidth(str);
    if (full <= maxWidth) return str;
    var dots = '…';
    var out = '';
    for (var i = 0; i < str.length; i++) {
      if (textWidth(str.slice(0, i + 1) + dots) > maxWidth) break;
      out = str.slice(0, i + 1);
    }
    return out + dots;
  }

  function measureNode(node, vars) {
    if (node.type === 'icon') {
      var s = Math.max(node.width && node.width.mode === 'fixed' ? node.width.value : ICON_BOX.w,
        node.height && node.height.mode === 'fixed' ? node.height.value : ICON_BOX.h);
      return { w: s, h: s };
    }
    if (node.type === 'bar') {
      var w = node.width.mode === 'fixed' ? node.width.value : 120;
      var h = node.barHeight || (node.height.mode === 'fixed' ? node.height.value : 12);
      return { w: w, h: h };
    }
    if (node.type === 'edge') {
      return { w: node.width.mode === 'fixed' ? node.width.value : 40,
        h: node.height.mode === 'fixed' ? node.height.value : 2 };
    }
    if (node.type === 'panel') {
      return { w: 40, h: 24 }; // panel 由引擎按子组件递归测量
    }
    var str = resolveVar(node, vars);
    var tw = Math.ceil(textWidth(str)) + TEXT_PAD_X * 2;
    return { w: Math.max(tw, 4), h: FONT_SIZE + 4 };
  }

  root.ULCMeasure = {
    measureNode: measureNode,
    resolveVar: resolveVar,
    ellipsize: ellipsize,
    textWidth: textWidth,
    FONT_STACK: FONT_STACK,
    FONT_SIZE: FONT_SIZE
  };
});
