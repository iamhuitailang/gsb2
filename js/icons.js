/*
 * icons.js — 简单绘制的线性图标（内联 SVG，无外部资源）
 * 统一 24x24 viewBox，currentColor 继承组件颜色
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    factory(global);
    module.exports = global.ULCIcons;
  } else factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var P = {
    avatar: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/>',
    wifi: '<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10.5 10.5 0 0 1 14 0"/><path d="M8.2 15.3a6 6 0 0 1 7.6 0"/><circle cx="12" cy="19" r="1.2"/>',
    battery: '<rect x="2" y="8" width="17" height="8" rx="2"/><path d="M22 11v2"/><rect x="4" y="10" width="9" height="4" rx="1" fill="currentColor" stroke="none"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    quest: '<path d="M5 4h11l3 3v13H5z"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/>',
    bag: '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>'
  };

  function svg(name, size) {
    var body = P[name];
    if (!body) {
      body = '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8"/>';
    }
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      body + '</svg>';
  }

  var names = Object.keys(P);

  root.ULCIcons = { svg: svg, names: names };
});
