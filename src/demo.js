/* 演示路线：封闭卵形环线，含上下坡、缓弯与一处回头急弯。
   控制点在拉伸圆上按均匀角度生成、一侧局部内收形成急弯，
   程序化保证 Catmull-Rom 不产生曲率尖峰、接缝落在平顺段。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./road.js'));
  else root.RoadDemo = factory(root.RoadMesh);
})(typeof self !== 'undefined' ? self : this, function (Road) {
  'use strict';

  // 13 个控制点（x, y 平面，z 高程）。左侧（a≈π）局部内收形成回头急弯。
  const controlPoints = [
    [72, 0, 4],
    [63.7, 21.4, 9.5],
    [40.8, 37.9, 10.7],
    [8.6, 45.7, 7.2],
    [-24.3, 43, 1.3],
    [-47.5, 30.5, -3.1],
    [-56.7, 11, -4.3],
    [-56.7, -11, -3.4],
    [-47.5, -30.5, -2.8],
    [-24.3, -43, -4.2],
    [8.6, -45.7, -6.2],
    [40.8, -37.9, -6.2],
    [63.7, -21.4, -2.5],
  ];

  // 每段独立参数：width 路面宽(m)，height 整体抬高(m)，crossfall 横坡(°)
  function makeSpans(overrides = {}) {
    const spans = controlPoints.map(() => Road.defaultSpanParams(8, 0, 2));
    // 直道略宽，急弯（span4/5/7/8）收窄并加超高横坡
    spans[0].width = 9; spans[0].crossfall = 1.5;
    spans[1].width = 9; spans[1].crossfall = 2;
    spans[2].width = 8.5; spans[2].crossfall = 2;
    spans[3].width = 8; spans[3].crossfall = 3;
    spans[4].width = 7; spans[4].crossfall = 6;   // 急弯入口超高
    spans[5].width = 7; spans[5].crossfall = 7;
    spans[6].width = 8; spans[6].crossfall = 3;
    spans[7].width = 7; spans[7].crossfall = 7;   // 急弯
    spans[8].width = 7; spans[8].crossfall = 6;
    spans[9].width = 8; spans[9].crossfall = 3;
    spans[10].width = 8.5; spans[10].crossfall = 2;
    spans[11].width = 9; spans[11].crossfall = 2;
    spans[12].width = 9; spans[12].crossfall = 1.5;
    Object.entries(overrides).forEach(([i, p]) => Object.assign(spans[+i], p));
    return spans;
  }

  // 会折叠的参数：把急弯三段（span5/7/8，最小半径约 7.2m）加宽到 30m，
  // 半幅 15m 远大于转弯半径，内缘倒行、路面自交 —— 用于核对折叠提示。
  // 段值位于各段中点、相邻中点间线性过渡，因此需同时加宽相邻段才能让弯心达到峰值。
  const foldOverride = { 5: { width: 30 }, 7: { width: 30 }, 8: { width: 30 } };
  const foldSpans = [5, 7, 8];

  return { controlPoints, makeSpans, foldOverride, foldSpan: 7, foldSpans };
});
