/*
 * engine.js — 纯函数布局引擎
 * 输入组件树 + 屏幕 + 状态变量 + 文本测量函数，输出每组件帧、隐藏原因、排版问题
 * 不碰 DOM，方便 Node 下做单测
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var api = factory(require('./model.js'));
    module.exports = api;
    root.ULCEngine = api;
  } else root.ULCEngine = factory(root.ULCModel);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';

  var SLOTS = M.anchorSlots();
  var H_SLOTS = ['leftAnchor', 'rightAnchor'];
  var V_SLOTS = ['topAnchor', 'bottomAnchor'];

  function solveLayout(nodes, screen, vars, measure) {
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var evars = Object.assign({}, vars, {
      __screenWidth__: screen.w,
      __screenHeight__: screen.h,
      __orientation__: screen.w >= screen.h ? 'landscape' : 'portrait'
    });

    var issues = [];
    var issueIds = {};
    function issue(rec) {
      if (issueIds[rec.id]) return;
      issueIds[rec.id] = true;
      issues.push(rec);
    }

    /* ---------- 1. 悬空参照与环 ---------- */
    M.findDanglingRefs(nodes).forEach(function (d) {
      var n = byId[d.nodeId];
      issue({
        id: 'dangling-' + d.nodeId + '-' + d.slot,
        kind: 'error',
        type: 'danglingRef',
        message: '「' + n.name + '」的' + slotLabel(d.slot) + '参照了已删除的组件（' + d.ref + '），定位失效',
        nodeIds: [d.nodeId],
        detail: { slot: d.slot },
        fixSuggestions: [{
          label: '清除失效的' + slotLabel(d.slot),
          ops: [{ kind: 'clearSlot', nodeId: d.nodeId, slot: d.slot }]
        }]
      });
    });

    var cycleNodes = {};
    M.findCycles(nodes).forEach(function (path) {
      path.forEach(function (id) { cycleNodes[id] = true; });
      var names = path.map(function (id) { return byId[id] ? byId[id].name : id; });
      issue({
        id: 'cycle-' + path.join('>'),
        kind: 'error',
        type: 'cycle',
        message: '定位参照形成循环：' + names.join(' → '),
        nodeIds: path.filter(function (id) { return byId[id]; })
      });
    });

    /* ---------- 2. 隐藏集合（条件 + 父级传播） ---------- */
    var hiddenReason = {};
    nodes.forEach(function (n) {
      if (n.hiddenWhen && M.evalCondition(n.hiddenWhen, evars)) {
        hiddenReason[n.id] = { reason: 'condition', text: M.conditionSummary(n.hiddenWhen, nodes) };
      }
    });
    var propagate = function () {
      var changed = false;
      nodes.forEach(function (n) {
        if (n.parentId && hiddenReason[n.parentId] && !hiddenReason[n.id]) {
          hiddenReason[n.id] = { reason: 'parent', text: '父组件「' + byId[n.parentId].name + '」被隐藏' };
          changed = true;
        }
      });
      return changed;
    };
    while (propagate()) { /* 收敛 */ }

    /* ---------- 3. 拓扑序 ---------- */
    var order = [];
    var tstate = {};
    function depsOf(n) {
      var deps = M.anchorRefsOf(n).filter(function (r) { return byId[r]; });
      if (n.parentId && byId[n.parentId]) deps.push(n.parentId);
      return deps.filter(function (d, i) { return deps.indexOf(d) === i; });
    }
    function visit(id) {
      if (tstate[id] === 2) return;
      if (tstate[id] === 1 || cycleNodes[id]) return; // 环上节点走兜底
      tstate[id] = 1;
      depsOf(byId[id]).forEach(visit);
      tstate[id] = 2;
      order.push(id);
    }
    nodes.forEach(function (n) { visit(n.id); });

    /* ---------- 4. 帧求解 ---------- */
    var frames = {};
    var screenFrame = {
      x: 0, y: 0, w: screen.w, h: screen.h,
      safe: screen.safe || { top: 0, right: 0, bottom: 0, left: 0 }
    };

    function refFrame(ref) {
      if (ref === M.SCREEN_ID) return screenFrame;
      if (frames[ref]) return frames[ref];
      // 流式父容器的帧在第一遍可能尚未撑开，用内在尺寸兜底，保证锚点位置不漂移
      var rn = byId[ref];
      if (rn && rn.type === 'panel') {
        var im = intrinsic(rn);
        return { x: 0, y: 0, w: im.w, h: im.h };
      }
      return null;
    }

    function isHidden(id) { return !!hiddenReason[id]; }

    function anchorPoint(anchor, axis, ownSize) {
      var f = refFrame(anchor.ref);
      if (!f) return null;
      var sf = f.safe || { top: 0, right: 0, bottom: 0, left: 0 };
      if (axis === 'x') {
        var edgeX;
        if (anchor.ref === M.SCREEN_ID) {
          // 屏幕右边缘：组件内侧贴边，需要减自身宽
          edgeX = anchor.edge === 'right' ? screen.w - sf.right - ownSize : sf.left;
        } else {
          // 组件参照：锚右边缘 = 排在其右侧，锚左边缘 = 左对齐，均不减自身
          edgeX = anchor.edge === 'right' ? f.x + f.w : f.x;
        }
        if (anchor.mode === 'ratio') {
          var baseX = anchor.ref === M.SCREEN_ID ? sf.left : f.x;
          var spanX = anchor.ref === M.SCREEN_ID
            ? screen.w - sf.left - sf.right : f.w;
          var px = baseX + anchor.value * spanX;
          var align = anchor.align || 'start';
          if (align === 'center') return px - ownSize / 2;
          if (align === 'end') return px - ownSize;
          return px;
        }
        if (anchor.edge !== 'right') return edgeX + anchor.value;
        // 屏幕右锚：向内退边距；组件右锚：排在其右侧再加边距
        return anchor.ref === M.SCREEN_ID ? edgeX - anchor.value : edgeX + anchor.value;
      }
      var edgeY;
      if (anchor.ref === M.SCREEN_ID) {
        edgeY = anchor.edge === 'bottom' ? screen.h - sf.bottom - ownSize : sf.top;
      } else {
        edgeY = anchor.edge === 'bottom' ? f.y + f.h : f.y;
      }
      if (anchor.mode === 'ratio') {
        var baseY = anchor.ref === M.SCREEN_ID ? sf.top : f.y;
        var spanY = anchor.ref === M.SCREEN_ID
          ? screen.h - sf.top - sf.bottom : f.h;
        var py = baseY + anchor.value * spanY;
        var alignY = anchor.align || 'start';
        if (alignY === 'center') return py - ownSize / 2;
        if (alignY === 'end') return py - ownSize;
        return py;
      }
      if (anchor.edge !== 'bottom') return edgeY + anchor.value;
      // 屏幕下锚：向内退边距；组件下锚：排在其下方再加边距
      return anchor.ref === M.SCREEN_ID ? edgeY - anchor.value : edgeY + anchor.value;
    }

    function checkRefAvailable(n) {
      SLOTS.forEach(function (s) {
        var a = n[s];
        if (!a || a.ref === M.SCREEN_ID) return;
        if (!byId[a.ref]) return; // 悬空已在前面报错
        if (isHidden(a.ref)) {
          issue({
            id: 'refHidden-' + n.id + '-' + s,
            kind: 'error',
            type: 'refHidden',
            message: '「' + n.name + '」的' + slotLabel(s) + '参照了被隐藏的「' + byId[a.ref].name + '」',
            nodeIds: [n.id, a.ref],
            fixSuggestions: [{
              label: '改为参照屏幕边缘',
              ops: [{ kind: 'setAnchor', nodeId: n.id, slot: s, anchor: screenAnchorFor(s) }]
            }]
          });
        }
      });
    }

    function liveAnchor(n, slot) {
      var a = n[slot];
      if (!a) return null;
      if (a.ref === M.SCREEN_ID) return a;
      if (!byId[a.ref] || isHidden(a.ref)) return null;
      return a;
    }

    /* 内容测量（带缓存） */
    var intrinsicCache = {};
    function intrinsic(n) {
      if (intrinsicCache[n.id]) return intrinsicCache[n.id];
      var m;
      if (n.type === 'panel') m = panelIntrinsic(n);
      else m = measure(n, evars);
      if (n.maxWidth > 0 && m.w > n.maxWidth) m = { w: n.maxWidth, h: m.h };
      intrinsicCache[n.id] = m;
      return m;
    }

    function visibleChildren(n) {
      return M.childrenOf(nodes, n.id).filter(function (c) { return !isHidden(c.id); });
    }

    function panelIntrinsic(n) {
      var kids = visibleChildren(n);
      var padV = n.padding[0], padH = n.padding[1];
      if (n.layout === 'none' || kids.length === 0) {
        var mw = 0, mh = 0;
        kids.forEach(function (k) {
          var im = intrinsic(k);
          mw = Math.max(mw, im.w); mh = Math.max(mh, im.h);
        });
        return { w: mw + padH * 2, h: mh + padV * 2 };
      }
      var gap = n.gap, totalGap = gap * (kids.length - 1);
      if (n.layout === 'row') {
        var w = padH * 2 + totalGap, h = 0;
        kids.forEach(function (k) {
          var im = intrinsic(k);
          w += im.w; h = Math.max(h, im.h);
        });
        return { w: w, h: h + padV * 2 };
      }
      var h2 = padV * 2 + totalGap, w2 = 0;
      kids.forEach(function (k) {
        var im = intrinsic(k);
        h2 += im.h; w2 = Math.max(w2, im.w);
      });
      return { w: w2 + padH * 2, h: h2 };
    }

    function sizeFromSpec(n, axis, spanBetween) {
      var spec = axis === 'x' ? n.width : n.height;
      var minS = axis === 'x' ? n.minWidth : n.minHeight;
      var intr = intrinsic(n)[axis === 'x' ? 'w' : 'h'];
      var v;
      if (spec.mode === 'fixed') v = spec.value;
      else if (spec.mode === 'fill') v = spanBetween != null ? spanBetween : intr;
      else v = intr;
      if (minS > 0 && v < minS) v = minS;
      return v;
    }

    function solveAxis(n, axis, slots) {
      var a0 = liveAnchor(n, slots[0]);
      var a1 = liveAnchor(n, slots[1]);
      var sizeSpec = axis === 'x' ? n.width : n.height;
      var minS = axis === 'x' ? n.minWidth : n.minHeight;
      var intr = intrinsic(n)[axis === 'x' ? 'w' : 'h'];

      var pos, size;
      if (a0 && a1) {
        var p0 = anchorPoint(a0, axis, 0);
        var p1 = anchorPoint(a1, axis, 0);
        if (p0 == null || p1 == null) {
          size = intr; pos = 0;
        } else if (p1 < p0) {
          size = intr; pos = p0;
          issue({
            id: 'anchorFlip-' + n.id + '-' + axis,
            kind: 'warning',
            type: 'anchorFlip',
            message: '「' + n.name + '」的两个' + (axis === 'x' ? '水平' : '垂直') + '锚点在当前屏幕下倒置',
            nodeIds: [n.id]
          });
        } else {
          var span = p1 - p0;
          if (sizeSpec.mode === 'fixed' || sizeSpec.mode === 'content') size = sizeFromSpec(n, axis, span);
          else size = span;
          pos = p0;
          if (minS > 0 && span < minS) issueMinWidth(n, axis, span, minS, a0, a1);
        }
      } else if (a0 || a1) {
        size = sizeFromSpec(n, axis, null);
        var p = anchorPoint(a0 || a1, axis, size);
        pos = p == null ? 0 : p;
      } else {
        size = sizeFromSpec(n, axis, null);
        pos = 0; // 流式布局随后覆盖
      }
      return { pos: pos, size: size };
    }

    function issueMinWidth(n, axis, span, minS, a0, a1) {
      var suggestions = [{
        label: '把最小可读' + (axis === 'x' ? '宽度' : '高度') + '调到 ' + Math.round(span),
        ops: [{ kind: 'setNodeProp', nodeId: n.id,
          prop: axis === 'x' ? 'minWidth' : 'minHeight', value: Math.round(span) }]
      }];
      var ratioOp = tryRatioSuggestion(n, a0, a1, axis);
      if (ratioOp) suggestions.push(ratioOp);
      issue({
        id: 'minsize-' + n.id + '-' + axis,
        kind: 'conflict',
        type: 'minSize',
        message: '「' + n.name + '」可用空间 ' + Math.round(span) + 'px，小于最小可读' +
          (axis === 'x' ? '宽度' : '高度') + ' ' + minS + 'px',
        nodeIds: [n.id],
        fixSuggestions: suggestions
      });
    }

    function tryRatioSuggestion(n, a0, a1, axis) {
      var slot = axis === 'x'
        ? (a0 && a0.mode === 'fixed' ? 'leftAnchor' : (a1 && a1.mode === 'fixed' ? 'rightAnchor' : null))
        : (a0 && a0.mode === 'fixed' ? 'topAnchor' : (a1 && a1.mode === 'fixed' ? 'bottomAnchor' : null));
      if (!slot) return null;
      var a = n[slot];
      var f = refFrame(a.ref);
      if (!f) return null;
      var span = axis === 'x' ? f.w : f.h;
      var ratio = span > 0 ? Math.min(1, Math.max(0, a.value / span)) : 0;
      return {
        label: '把' + slotLabel(slot) + '从固定边距改为比例位置',
        ops: [{ kind: 'setAnchor', nodeId: n.id, slot: slot,
          anchor: { ref: a.ref, edge: a.edge, mode: 'ratio',
            value: Math.round(ratio * 100) / 100, align: a.align || 'start' } }]
      };
    }

    function fillShare(panel, frame) {
      var kids = visibleChildren(panel);
      var padH = panel.padding[1];
      var fixedUsed = padH * 2 + panel.gap * (kids.length - 1);
      var fillCount = 0;
      kids.forEach(function (k) {
        if (k.width.mode === 'fill') fillCount++;
        else fixedUsed += intrinsic(k).w;
      });
      if (!fillCount) return 0;
      return Math.max(0, (frame.w - fixedUsed) / fillCount);
    }

    function flowLayout(n, frame) {
      var kids = visibleChildren(n);
      if (!kids.length || n.layout === 'none') return;
      // 环上的容器没有正常帧（走兜底定位），跳过流式排列避免崩溃
      if (!frame) return;
      var padV = n.padding[0], padH = n.padding[1];
      // 帧系统统一使用屏幕绝对坐标：从父容器原点 + 内边距起排
      var cursor = n.layout === 'row' ? frame.x + padH : frame.y + padV;
      var cross = n.layout === 'row' ? frame.y + padV : frame.x + padH;
      var share = fillShare(n, frame);
      kids.forEach(function (k) {
        var im = intrinsic(k);
        if (n.layout === 'row') {
          var kw = k.width.mode === 'fill'
            ? Math.max(im.w, share, k.minWidth || 0)
            : im.w;
          frames[k.id] = { x: cursor, y: cross, w: kw, h: im.h };
          cursor += kw + n.gap;
        } else {
          var kh = k.height.mode === 'fill'
            ? Math.max(im.h, frame.h - padV * 2, k.minHeight || 0)
            : im.h;
          frames[k.id] = { x: cross, y: cursor, w: im.w, h: kh };
          cursor += kh + n.gap;
        }
      });
    }

    order.forEach(function (id) {
      var n = byId[id];
      if (isHidden(id)) return;
      checkRefAvailable(n);
      if (cycleNodes[id]) {
        var im0 = measure(n, evars);
        frames[id] = { x: 0, y: 0, w: im0.w, h: im0.h, fallback: true };
        return;
      }
      // 流式布局子项：位置由父容器 flowLayout 统一分配，这里只求尺寸
      var pf = n.parentId && byId[n.parentId];
      if (pf && (pf.layout === 'row' || pf.layout === 'column')) {
        var imf = intrinsic(n);
        frames[id] = { x: 0, y: 0, w: imf.w, h: imf.h, flowChild: true };
        return;
      }
      var h = solveAxis(n, 'x', H_SLOTS);
      var v = solveAxis(n, 'y', V_SLOTS);
      frames[id] = { x: h.pos, y: v.pos, w: h.size, h: v.size };
    });

    /* 第二遍：所有节点帧（含流式子项占位帧）就绪后，按树前序让流式容器
       用屏幕绝对坐标覆盖子组件位置，保证后续遮挡/裁切检测基于真实帧。
       不能用锚点拓扑序：它把父排在子之前，那时子项占位帧尚未生成 */
    var treeOrder = [];
    (function buildTreeOrder() {
      var roots = nodes.filter(function (n) { return !n.parentId || !byId[n.parentId]; });
      var walk = function (n) {
        treeOrder.push(n.id);
        M.childrenOf(nodes, n.id).forEach(walk);
      };
      roots.forEach(walk);
    })();
    treeOrder.forEach(function (id) {
      var n = byId[id];
      if (isHidden(id) || n.type !== 'panel') return;
      if (n.layout === 'row' || n.layout === 'column') flowLayout(n, frames[id]);
    });

    /* 第三遍：流式容器已撑开为最终尺寸，重算所有锚定组件（非流式子项）的位置。
       解决“quest 锚 topbar 底边，但 topbar 高度在第二遍才确定”的时序问题 */
    order.forEach(function (id) {
      var n = byId[id];
      if (isHidden(id) || cycleNodes[id]) return;
      var pf = n.parentId && byId[n.parentId];
      if (pf && (pf.layout === 'row' || pf.layout === 'column')) return;
      var f = frames[id];
      if (!f) return;
      var h = solveAxis(n, 'x', H_SLOTS);
      var v = solveAxis(n, 'y', V_SLOTS);
      f.x = h.pos; f.y = v.pos;
    });
    /* 位置变化后流式容器需要再排一遍以同步子项坐标 */
    treeOrder.forEach(function (id) {
      var n = byId[id];
      if (isHidden(id) || n.type !== 'panel') return;
      if (n.layout === 'row' || n.layout === 'column') flowLayout(n, frames[id]);
    });

    /* 流式子项最终帧就位后，回填被最小可读宽度顶住的标记等（帧已在 flowLayout 写出） */
    order.forEach(function (id) {
      var n = byId[id];
      if (isHidden(id)) return;
      var pf = n.parentId && byId[n.parentId];
      if (!pf || (pf.layout !== 'row' && pf.layout !== 'column')) return;
      var minS = pf.layout === 'row' ? n.minWidth : n.minHeight;
      var f = frames[id];
      if (f && minS > 0 && f[pf.layout === 'row' ? 'w' : 'h'] < minS) {
        issue({
          id: 'flowminsize-' + n.id,
          kind: 'conflict',
          type: 'minSize',
          message: '「' + n.name + '」在「' + pf.name + '」中被压缩到 ' +
            Math.round(f[pf.layout === 'row' ? 'w' : 'h']) + 'px，小于最小可读' +
            (pf.layout === 'row' ? '宽度' : '高度') + ' ' + minS + 'px',
          nodeIds: [n.id],
          fixSuggestions: [{
            label: '移除「' + n.name + '」的最小可读' + (pf.layout === 'row' ? '宽度' : '高度') + '限制',
            ops: [{ kind: 'setNodeProp', nodeId: n.id,
              prop: pf.layout === 'row' ? 'minWidth' : 'minHeight', value: 0 }]
          }]
        });
      }
    });

    /* ---------- 5. 裁切 / 安全区 / 遮挡 ---------- */
    var visibleNodes = nodes.filter(function (n) {
      return !isHidden(n.id) && frames[n.id] && !cycleNodes[n.id];
    });

    visibleNodes.forEach(function (n) {
      var f = frames[n.id];
      if (n.type === 'edge') return;
      if (f.x < 0 || f.y < 0 || f.x + f.w > screen.w || f.y + f.h > screen.h) {
        issue({
          id: 'clip-' + n.id,
          kind: 'warning',
          type: 'clip',
          message: '「' + n.name + '」超出屏幕物理边界，会被裁切（超出 ' +
            Math.round(overScreen(f, screen)) + 'px）',
          nodeIds: [n.id]
        });
      }
      var sf = screenFrame.safe;
      var inScreen = f.x >= 0 && f.y >= 0 && f.x + f.w <= screen.w && f.y + f.h <= screen.h;
      if (inScreen && (f.x < sf.left || f.y < sf.top ||
          f.x + f.w > screen.w - sf.right || f.y + f.h > screen.h - sf.bottom)) {
        issue({
          id: 'safe-' + n.id,
          kind: 'warning',
          type: 'safeArea',
          message: '「' + n.name + '」侵入屏幕保留区（刘海/手势条），可能被系统遮挡',
          nodeIds: [n.id]
        });
      }
    });

    function rigid(n, axis) {
      var spec = axis === 'x' ? n.width : n.height;
      if (spec.mode === 'fixed' || spec.mode === 'fill') return true;
      if (n.maxWidth > 0) return true;
      var minS = axis === 'x' ? n.minWidth : n.minHeight;
      var f = frames[n.id];
      // 帧已被最小可读宽度顶住：窄屏下无法再压缩，视为刚性
      if (minS > 0 && f && f[axis === 'x' ? 'w' : 'h'] <= minS + 0.5) return true;
      return false;
    }

    for (var i = 0; i < visibleNodes.length; i++) {
      for (var j = i + 1; j < visibleNodes.length; j++) {
        var a = visibleNodes[i], b = visibleNodes[j];
        if (a.type === 'edge' || b.type === 'edge') continue;
        if (isAncestor(a, b) || isAncestor(b, a)) continue;
        if (isFullScreenRoot(a) || isFullScreenRoot(b)) continue;
        // 模态遮罩层（暂停菜单等）覆盖下层内容是预期行为，不参与遮挡/冲突检测
        if (a.overlay || b.overlay) continue;
        if (isContained(a, b) || isContained(b, a)) continue;
        var fa = frames[a.id], fb = frames[b.id];
        var ox = Math.min(fa.x + fa.w, fb.x + fb.w) - Math.max(fa.x, fb.x);
        var oy = Math.min(fa.y + fa.h, fb.y + fb.h) - Math.max(fa.y, fb.y);
        if (ox <= 0 || oy <= 0) continue;
        // 横跨容器宽度的条（如顶部状态栏）与下方兄弟整宽重叠属正常纵向堆叠，
        // 只在纵向真正打架时报告
        var spansContainer = isSpanningContainer(a, fa) || isSpanningContainer(b, fb);
        if (spansContainer) continue;
        // 分别评估两个轴：哪个轴上双方都不可压缩，就是该轴的约束冲突；
        // 水平相撞是窄屏状态栏最典型的问题，优先取水平轴
        var axis = null;
        if (ox > 0 && rigid(a, 'x') && rigid(b, 'x')) axis = 'x';
        else if (oy > 0 && rigid(a, 'y') && rigid(b, 'y')) axis = 'y';
        var overlapPx = axis === 'y' ? Math.round(oy) : Math.round(ox);
        if (axis) {
          issueConflict(a, b, axis, overlapPx);
        } else {
          issue({
            id: 'occl-' + [a.id, b.id, axis].sort().join('-'),
            kind: 'warning',
            type: 'occlusion',
            message: '「' + a.name + '」与「' + b.name + '」相互遮挡 ' + overlapPx + 'px（至少一方可压缩，属遮挡警告）',
            nodeIds: [a.id, b.id]
          });
        }
      }
    }

    function isAncestor(maybeParent, node) {
      var p = node.parentId;
      while (p) {
        if (p === maybeParent.id) return true;
        p = byId[p] ? byId[p].parentId : null;
      }
      return false;
    }

    /* 包含关系（含直接父级）：一个组件的帧完全落在另一个组件内部时不算遮挡，
       流式子组件天然位于父容器内 */
    function isContained(outer, inner) {
      var fo = frames[outer.id], fi = frames[inner.id];
      if (!fo || !fi) return false;
      return fi.x >= fo.x - 0.5 && fi.y >= fo.y - 0.5 &&
        fi.x + fi.w <= fo.x + fo.w + 0.5 &&
        fi.y + fi.h <= fo.y + fo.h + 0.5;
    }

    /* 铺满屏幕的根容器只是逻辑画布，不参与遮挡检测 */
    function isFullScreenRoot(n) {
      var f = frames[n.id];
      return n.parentId == null &&
        f.x === 0 && f.y === 0 && f.w === screen.w && f.h === screen.h;
    }

    /* 横跨父容器（或屏幕）90% 以上宽度的条形容器，与兄弟的整宽重叠视为正常堆叠 */
    function isSpanningContainer(n, f) {
      if (n.type !== 'panel') return false;
      var pf;
      if (n.parentId && byId[n.parentId]) pf = frames[n.parentId];
      else pf = { w: screen.w };
      return pf && f.w >= pf.w * 0.9;
    }

    function issueConflict(a, b, axis, overlapPx) {
      var low = a.priority <= b.priority ? a : b;
      var axisText = axis === 'x' ? '宽' : '高';
      var suggestions = [];

      if (low.width.mode === 'content' || low.maxWidth > 0 || low.minWidth > 0) {
        var lf = frames[low.id];
        var high = low === a ? b : a;
        var hf = frames[high.id];
        var cap;
        if (axis === 'x') {
          // low 在 high 左侧：可用宽 = high 左缘 - low 左缘；反之取右侧剩余
          cap = lf.x <= hf.x
            ? Math.max(24, Math.round(hf.x - lf.x))
            : Math.max(24, Math.round((hf.x + hf.w) - lf.x));
        } else {
          cap = Math.round(lf.w);
        }
        // 同时压住最大宽并放开超出可用空间的最小可读宽，组件才能真正缩进去
        var capOps = [{ kind: 'setNodeProp', nodeId: low.id,
          prop: axis === 'x' ? 'maxWidth' : 'maxHeight', value: cap }];
        var minProp = axis === 'x' ? 'minWidth' : 'minHeight';
        if (low[minProp] > cap) {
          capOps.push({ kind: 'setNodeProp', nodeId: low.id, prop: minProp, value: cap });
        }
        suggestions.push({
          label: '把「' + low.name + '」压缩到 ' + cap + 'px 内（限最大宽' +
            (low[minProp] > cap ? '并下调最小可读宽' : '') + '，文字省略号）',
          ops: capOps
        });
      }
      var threshold = (axis === 'x' ? screen.w : screen.h) + 1;
      suggestions.push({
        label: '屏幕' + axisText + '度低于 ' + threshold +
          'px 时主动隐藏「' + low.name + '」',
        ops: [{ kind: 'setNodeProp', nodeId: low.id, prop: 'hiddenWhen',
          value: { any: [{ var: axis === 'x' ? '__screenWidth__' : '__screenHeight__', op: '<', value: threshold }] } }]
      });
      var slot = axis === 'x' ? 'leftAnchor' : 'topAnchor';
      if (low[slot] && low[slot].mode === 'fixed') {
        var aa = low[slot], rf = refFrame(aa.ref);
        if (rf) {
          var span = axis === 'x' ? rf.w : rf.h;
          suggestions.push({
            label: '辅助：把「' + low.name + '」的' + slotLabel(slot) + '改为比例位置（缓解漂移，可能仍需配合压缩）',
            ops: [{ kind: 'setAnchor', nodeId: low.id, slot: slot,
              anchor: { ref: aa.ref, edge: aa.edge, mode: 'ratio',
                value: Math.round(Math.min(1, aa.value / Math.max(1, span)) * 100) / 100,
                align: aa.align || 'start' } }]
          });
        }
      }
      issue({
        id: 'conflict-' + [a.id, b.id, axis].map(String).sort().join('-'),
        kind: 'conflict',
        type: 'overlapConflict',
        message: '约束冲突：「' + a.name + '」与「' + b.name + '」在' +
          (axis === 'x' ? '水平' : '垂直') + '方向上都无法压缩，相撞 ' + overlapPx + 'px',
        nodeIds: [a.id, b.id],
        detail: { axis: axis, overlap: overlapPx },
        fixSuggestions: suggestions
      });
    }

    /* ---------- 6. 汇总 ---------- */
    var hiddenIds = Object.keys(hiddenReason);
    return {
      frames: frames,
      hiddenReason: hiddenReason,
      hiddenIds: hiddenIds,
      issues: issues,
      order: order,
      stats: {
        total: nodes.length,
        visible: visibleNodes.length,
        hidden: hiddenIds.length,
        errors: issues.filter(function (x) { return x.kind === 'error'; }).length,
        conflicts: issues.filter(function (x) { return x.kind === 'conflict'; }).length,
        warnings: issues.filter(function (x) { return x.kind === 'warning'; }).length
      }
    };
  }

  function hitTest(result, x, y) {
    var hit = null;
    result.order.forEach(function (id) {
      if (result.hiddenReason[id]) return;
      var f = result.frames[id];
      if (!f) return;
      if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) hit = id;
    });
    return hit;
  }

  function overScreen(f, screen) {
    return Math.max(0, -f.x, -f.y, f.x + f.w - screen.w, f.y + f.h - screen.h);
  }

  function slotLabel(slot) {
    return {
      leftAnchor: '左锚点', rightAnchor: '右锚点',
      topAnchor: '上锚点', bottomAnchor: '下锚点'
    }[slot] || slot;
  }

  function screenAnchorFor(slot) {
    var edgeMap = { leftAnchor: 'left', rightAnchor: 'right', topAnchor: 'top', bottomAnchor: 'bottom' };
    return { ref: M.SCREEN_ID, edge: edgeMap[slot], mode: 'fixed', value: 8, align: 'start' };
  }

  return {
    solveLayout: solveLayout,
    hitTest: hitTest,
    slotLabel: slotLabel,
    screenAnchorFor: screenAnchorFor
  };
});
