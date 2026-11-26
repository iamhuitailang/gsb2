/*
 * core.js — 立体校对工具的纯逻辑核心（无 DOM 依赖，可在 Node 下单测）
 *
 * 约定：
 *  - 所有时间单位为秒，帧号为从 0 开始的整数
 *  - timeOffset：该眼相对主时间线的时间偏移，正值 = 该眼画面“晚”到
 *      主时刻 T 时，该眼对应的本地时刻 eyeT = T - timeOffset
 *  - verticalOffset：该眼画面在屏幕上向下平移的像素数，正值 = 向下移
 *  - 主时间线本身也是一条帧网格（baseFps），拖动时间线即停在某个主帧上
 */
(function (global) {
  'use strict';

  var EPS = 1e-9;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function round2(v) { return Math.round(v * 100) / 100; }

  /** 时间 -> 最近帧号 */
  function timeToFrame(t, fps) { return Math.round(t * fps); }

  /** 帧号 -> 时间 */
  function frameToTime(f, fps) { return f / fps; }

  /** 时间码 HH:MM:SS:FF */
  function formatTimecode(seconds, fps) {
    seconds = Math.max(0, seconds);
    var totalFrames = Math.round(seconds * fps);
    var ff = totalFrames % fps;
    var totalSecs = Math.floor(totalFrames / fps);
    var ss = totalSecs % 60;
    var mm = Math.floor(totalSecs / 60) % 60;
    var hh = Math.floor(totalSecs / 3600);
    function pad(n) { return String(n).padStart(2, '0'); }
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
  }

  /**
   * 主时间线帧网格：覆盖两路画面能到达的全部时间，从时刻 0 开始。
   * eyeInfos: [{ fps, frameCount, timeOffset }]
   */
  function buildMasterGrid(eyeInfos, baseFps) {
    var tMax = 0;
    for (var i = 0; i < eyeInfos.length; i++) {
      var e = eyeInfos[i];
      if (!e || !e.frameCount) continue;
      tMax = Math.max(tMax, e.timeOffset + e.frameCount / e.fps);
    }
    var lastFrame = Math.max(0, Math.ceil(tMax * baseFps - EPS) - 1);
    return {
      baseFps: baseFps,
      firstFrame: 0,
      lastFrame: lastFrame,
      frameCount: lastFrame + 1,
      duration: (lastFrame + 1) / baseFps
    };
  }

  /**
   * 某只眼在主帧网格上的有效帧区间 [lo, hi)
   * 帧 f 被显示的主时刻窗口：[off + (f-0.5)/fps, off + (f+0.5)/fps)
   * 全部帧的并集：[off - 0.5/fps, off + (n-0.5)/fps)
   */
  function eyeValidRange(e, baseFps) {
    var lo = Math.ceil(baseFps * (e.timeOffset - 0.5 / e.fps) - EPS);
    var hi = Math.ceil(baseFps * (e.timeOffset + (e.frameCount - 0.5) / e.fps) - EPS);
    return { lo: Math.max(0, lo), hi: Math.max(0, hi) };
  }

  /** 两路各自的有效区间 + 共同可预览区间（相对主网格裁剪） */
  function commonRanges(grid, eyeA, eyeB, baseFps) {
    var a = eyeValidRange(eyeA, baseFps);
    var b = eyeValidRange(eyeB, baseFps);
    var maxHi = grid.frameCount;
    a = { lo: clamp(a.lo, 0, maxHi), hi: clamp(a.hi, 0, maxHi) };
    b = { lo: clamp(b.lo, 0, maxHi), hi: clamp(b.hi, 0, maxHi) };
    var lo = Math.max(a.lo, b.lo);
    var hi = Math.min(a.hi, b.hi);
    if (hi < lo) hi = lo;
    return { left: a, right: b, common: { lo: lo, hi: hi } };
  }

  /**
   * 主帧 masterFrame 上某只眼应显示的本地帧。
   * 返回 available=false 时调用方应画“缺帧”占位。
   */
  function eyeFrameAt(masterFrame, baseFps, e) {
    var T = masterFrame / baseFps;
    var eyeT = T - e.timeOffset;
    var f = Math.round(eyeT * e.fps);
    return {
      eyeTime: eyeT,
      frame: f,
      available: f >= 0 && f < e.frameCount
    };
  }

  /** 把某只眼的本地帧号反解成它出现在主时间线上的主帧（用于时间线标注） */
  function eyeFrameToMaster(frame, e, baseFps) {
    var T = e.timeOffset + frame / e.fps;
    return clamp(Math.round(T * baseFps), 0, Number.MAX_SAFE_INTEGER);
  }

  /* ---------------- 参考点标记 ---------------- */

  /** 取眼对象的素材签名，兼容 app 形态（sig 挂在 .source 上）与单测形态 */
  function eyeSig(eye) {
    return (eye.source && eye.source.sig != null) ? eye.source.sig : eye.sig;
  }

  /**
   * 创建一对参考点。picks = { left:{x,y}, right:{x,y} }，坐标为素材原始像素。
   */
  function createMarker(id, masterFrame, baseFps, eyes, picks) {
    return {
      id: id,
      masterFrame: masterFrame,
      baseFps: baseFps,
      sourceSig: {
        left: eyeSig(eyes.left),
        right: eyeSig(eyes.right)
      },
      timeOffsetAtPick: {
        left: eyes.left.timeOffset,
        right: eyes.right.timeOffset
      },
      left: { x: picks.left.x, y: picks.left.y },
      right: { x: picks.right.x, y: picks.right.y },
      sourceSize: {
        left: {
          w: (eyes.left.source && eyes.left.source.width) || eyes.left.width,
          h: (eyes.left.source && eyes.left.source.height) || eyes.left.height
        },
        right: {
          w: (eyes.right.source && eyes.right.source.width) || eyes.right.width,
          h: (eyes.right.source && eyes.right.source.height) || eyes.right.height
        }
      },
      createdAt: Date.now()
    };
  }

  /**
   * 标记状态：
   *  - valid：素材、时间偏移、主帧率都没变，标记仍对应同一目标时刻
   *  - stale：换了素材 / 改过时间偏移 / 改过帧率，原对应关系失效，需复核
   * 注意：改垂直偏移不会使标记失效，偏差值会随垂直偏移实时更新，
   *       正好可以一边看着 dy 一边把纵向误差调到 0。
   */
  function markerState(m, baseFps, eyes) {
    if (m.baseFps !== baseFps) return 'stale';
    if (m.sourceSig.left !== eyeSig(eyes.left)) return 'stale';
    if (m.sourceSig.right !== eyeSig(eyes.right)) return 'stale';
    if (m.timeOffsetAtPick.left !== eyes.left.timeOffset) return 'stale';
    if (m.timeOffsetAtPick.right !== eyes.right.timeOffset) return 'stale';
    return 'valid';
  }

  /**
   * 横纵偏差。屏幕上点的 y = 素材 y + verticalOffset（正值向下）。
   * 返回：
   *   dx/dy          以左眼素材像素为基准的差值
   *   dxPct/dyPct    占左眼宽/高的百分比
   *   dxNorm/dyNorm  归一化坐标差（百分比），两路分辨率不同时用这个比较
   */
  function markerDeviation(m, eyes) {
    var dx = m.right.x - m.left.x;
    var dy = (m.right.y + eyes.right.verticalOffset) - (m.left.y + eyes.left.verticalOffset);
    var lw = m.sourceSize.left.w, lh = m.sourceSize.left.h;
    var rw = m.sourceSize.right.w, rh = m.sourceSize.right.h;
    return {
      dx: round2(dx),
      dy: round2(dy),
      dxPct: round2(dx / lw * 100),
      dyPct: round2(dy / lh * 100),
      dxNorm: round2((m.right.x / rw - m.left.x / lw) * 100),
      dyNorm: round2((m.right.y / rh - m.left.y / lh) * 100)
    };
  }

  var api = {
    EPS: EPS,
    clamp: clamp,
    round2: round2,
    timeToFrame: timeToFrame,
    frameToTime: frameToTime,
    formatTimecode: formatTimecode,
    buildMasterGrid: buildMasterGrid,
    eyeValidRange: eyeValidRange,
    commonRanges: commonRanges,
    eyeFrameAt: eyeFrameAt,
    eyeFrameToMaster: eyeFrameToMaster,
    createMarker: createMarker,
    markerState: markerState,
    markerDeviation: markerDeviation
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.StereoCore = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
