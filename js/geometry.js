/* 投影校正工具 —— 四边形几何与合法性判定
 *
 * 四角拖动时必须区分三类非法状态，并给出能看懂的原因：
 *  1. 反向（绕序翻转）—— 某条边的局部叉积符号与整体绕序相反；
 *  2. 自交（蝴蝶结形）—— 非相邻边出现交点；
 *  3. 退化 —— 面积过小、三点共线等，单应矩阵无法求解。
 * 非法时上层保留上一次有效画面，仅用红字提示，不更新变换。
 */
(function (global) {
  'use strict';

  var PCAL = global.PCAL;
  var M = PCAL.math;

  /** 有向面积（正=逆时针，负=顺时针，0=共线退化）。 */
  function polygonArea(pts) {
    var s = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      s += p.x * q.y - q.x * p.y;
    }
    return s / 2;
  }

  /** 线段相交判定（含端点接触），返回布尔。 */
  function segmentsIntersect(p1, p2, p3, p4) {
    function ccw(a, b, c) {
      // 叉积 (b-a)×(c-a)：>0 表示 c 在有向边 a→b 的左侧
      return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0;
    }
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }

  /**
   * 校验四边形。返回：
   *   { valid: true,  reason: null, orientation: 'cw'|'ccw' }
   *   { valid: false, reason: '...可读原因...' }
   * pts 顺序固定为 左上、右上、右下、左下。
   */
  function validateQuad(pts) {
    if (!pts || pts.length !== 4) return { valid: false, reason: '角点数据不完整' };

    // 1) 重合 / 三点共线 / 面积过小 —— 单应无解（先排除退化，避免退化形状误报为自交）
    var area = polygonArea(pts);
    var minSpan = Infinity;
    for (var i = 0; i < 4; i++) {
      var p = pts[i], q = pts[(i + 1) % 4];
      var d = M.dist(p.x, p.y, q.x, q.y);
      if (d < 1e-6) return { valid: false, reason: '第 ' + (i + 1) + '、' + (((i + 1) % 4) + 1) + ' 个角点重合，四边形已退化' };
      if (d < minSpan) minSpan = d;
    }
    // 连续三点共线：即使总面积不为零（第四点撑起三角形），单应也无解
    var names0 = ['左上', '右上', '右下', '左下'];
    for (var ci = 0; ci < 4; ci++) {
      var a = pts[ci], b = pts[(ci + 1) % 4], c = pts[(ci + 2) % 4];
      var cr = M.cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y);
      if (Math.abs(cr) < 1e-6 * (minSpan * minSpan + 1)) {
        return { valid: false, reason: '「' + names0[ci] + '、' + names0[(ci + 1) % 4] + '、' + names0[(ci + 2) % 4] + '」三点共线，无法建立透视关系' };
      }
    }

    // 2) 自交：检查两组对边（0-1 与 2-3，1-2 与 3-0）
    if (segmentsIntersect(pts[0], pts[1], pts[2], pts[3]) ||
        segmentsIntersect(pts[1], pts[2], pts[3], pts[0])) {
      return { valid: false, reason: '对边发生交叉（蝴蝶结形），四边形自交，请把拖过对角的角点拉回' };
    }

    if (Math.abs(area) < 1e-4) {
      return { valid: false, reason: '四点近似共线，面积趋近于零，无法建立透视关系' };
    }

    // 3) 反向/凹折：凸四边形四个顶点叉积必须同号
    var signs = [];
    for (var k = 0; k < 4; k++) {
      var a = pts[k], b = pts[(k + 1) % 4], c = pts[(k + 2) % 4];
      signs.push(M.cross(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y));
    }
    var pos = signs.filter(function (v) { return v > 0; }).length;
    var neg = signs.filter(function (v) { return v < 0; }).length;
    if (pos > 0 && neg > 0) {
      // 找到发生凹折的顶点提示给操作员
      var overall = area > 0 ? 1 : -1;
      var bad = -1;
      for (var t = 0; t < 4; t++) {
        if (signs[t] * overall < 0) { bad = t; break; }
      }
      var names = ['左上', '右上', '右下', '左下'];
      return {
        valid: false,
        reason: '绕序在「' + names[bad] + '」角点处反向（局部凹折），透视面不成立，请回退该角点'
      };
    }

    return { valid: true, reason: null, orientation: area > 0 ? 'ccw' : 'cw' };
  }

  /** 射线法判断点是否在多边形内（用于点击拾取、遮罩范围判断）。 */
  function pointInPolygon(px, py, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].x, yi = pts[i].y;
      var xj = pts[j].x, yj = pts[j].y;
      var intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /** 四边形包围盒。 */
  function quadBounds(pts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, width: maxX - minX, height: maxY - minY };
  }

  PCAL.geometry = {
    polygonArea: polygonArea,
    segmentsIntersect: segmentsIntersect,
    validateQuad: validateQuad,
    pointInPolygon: pointInPolygon,
    quadBounds: quadBounds
  };
})(window);
