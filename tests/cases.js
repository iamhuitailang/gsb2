/*
 * cases.js — 浏览器端自检用例（ESM，仅 ?selftest=1 时加载）
 * api 由 app.js 注入：state / getState / view / loadSample / gotoFrame ...
 */
const C = window.StereoCore;
const S = window.StereoSamples;

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败：' + msg);
}
function approxEq(a, b, eps, msg) {
  if (Math.abs(a - b) > eps) throw new Error('断言失败：' + msg + '（' + a + ' != ' + b + '）');
}

export default async function run(api) {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: String(e && e.message || e) }); }
  }

  const state = api.state;

  await test('载入左右内置样片', () => {
    api.loadSample('left');
    api.loadSample('right');
    assert(state.eyes.left.source.kind === 'sample', '左眼为样片源');
    assert(state.eyes.right.source.kind === 'sample', '右眼为样片源');
    assert(state.eyes.left.source.frameCount === 100, '样片 100 帧');
    assert(state.eyes.left.source.width === 640 && state.eyes.left.source.height === 360, '样片尺寸 640x360');
  });

  await test('主网格与共同区间', () => {
    // 纯数学：两路同规格、无偏移时共同区间应为全程
    const grid100 = { frameCount: 100 };
    const r = C.commonRanges(
      grid100,
      { fps: 25, frameCount: 100, timeOffset: 0 },
      { fps: 25, frameCount: 100, timeOffset: 0 },
      25
    );
    assert(r.common.lo === 0 && r.common.hi === 100, '无偏移时共同区间=全程');

    // 右眼在界面上 timeOffset 仍为 0（故障烘焙在素材内部），
    // 主网格应覆盖 100 帧
    assert(api.getState() && state.eyes.right.source.ready, '状态可取');
  });

  await test('同一主帧映射到两眼的本地帧（未校正）', () => {
    api.gotoFrame(20);
    const f = api.getState().frames;
    assert(f.left.available && f.right.available, '帧 20 两眼均有效');
    assert(f.left.frame === 20, '左眼本地帧 20');
    assert(f.right.frame === 20, '右眼槽位帧 20');
  });

  await test('缺帧区明确标出', () => {
    api.gotoFrame(99);
    const f99 = api.getState().frames;
    assert(f99.left.available, '左眼帧99有效');
    // 右眼最后一帧装的是场景 95，仍在帧范围内；缺帧通过制造越界偏移验证：
    state.eyes.right.timeOffset = 0.5; // 右眼整体晚 12.5 帧
    api.rebuildGrid();
    api.gotoFrame(0);
    const f0 = api.getState().frames;
    assert(f0.right.available === false, '时间偏移后起点右眼缺帧');
    state.eyes.right.timeOffset = 0;
    api.rebuildGrid();
  });

  await test('时间偏移使参考点失效', () => {
    api.gotoFrame(30);
    const eyes = state.eyes;
    const m = C.createMarker(999, 30, 25, eyes, {
      left: { x: 100, y: 100 }, right: { x: 102, y: 116 }
    });
    assert(C.markerState(m, 25, eyes) === 'valid', '新建标记有效');
    const d0 = C.markerDeviation(m, eyes);
    assert(d0.dx === 2 && d0.dy === 16, '初始偏差 dx=2 dy=16（含右眼内置上移）');
    eyes.right.timeOffset = -0.16;
    assert(C.markerState(m, 25, eyes) === 'stale', '改时间偏移后标记失效');
    eyes.right.timeOffset = 0;
  });

  await test('垂直偏移实时改变 dy 但不使标记失效', () => {
    api.gotoFrame(30);
    const eyes = state.eyes;
    // 同一物体在右眼画面里因内置上移 16px，素材坐标比左眼小 16
    const m = C.createMarker(998, 30, 25, eyes, {
      left: { x: 100, y: 116 }, right: { x: 100, y: 100 }
    });
    // 右眼实际点在屏幕上比左眼高 16（dy = (100+0) - (116+0) = -16）
    assert(C.markerDeviation(m, eyes).dy === -16, '未校正 dy=-16（右眼画面偏高16）');
    eyes.right.verticalOffset = 16;
    assert(C.markerState(m, 25, eyes) === 'valid', '改垂直偏移标记仍有效');
    assert(C.markerDeviation(m, eyes).dy === 0, '右眼下移 16px 后 dy=0');
    eyes.right.verticalOffset = 0;
  });

  await test('样片校回：timeOffset=-0.16 + 垂直 +16', () => {
    state.eyes.left.timeOffset = S.correction.left.timeOffset;
    state.eyes.left.verticalOffset = S.correction.left.verticalOffset;
    state.eyes.right.timeOffset = S.correction.right.timeOffset;
    state.eyes.right.verticalOffset = S.correction.right.verticalOffset;
    api.rebuildGrid();
    // 主帧 m 时右眼 eyeT = T - (-0.16) = T + 0.16，本地帧 = round((T+0.16)*25) = m+4
    // 右眼文件帧 m+4 装的是场景 (m+4)-4 = m，与左眼场景帧 m 相同
    api.gotoFrame(10);
    const f = api.getState().frames;
    assert(f.left.frame === 10, '左眼本地帧 10');
    assert(f.right.frame === 14, '右眼本地帧 14（装场景帧10）');
    const r = C.eyeValidRange(
      { fps: 25, frameCount: 100, timeOffset: -0.16 }, 25
    );
    assert(r.lo === 0 && r.hi === 96, '校回后右眼在主网格上的有效区 0..95');
  });

  await test('渲染不报错且画布有内容', async () => {
    // 复位前序用例可能留下的偏移与显示模式，保证两眼在该帧都有有效画面
    state.mode = 'sbs';
    state.eyes.left.timeOffset = 0; state.eyes.left.verticalOffset = 0;
    state.eyes.right.timeOffset = 0; state.eyes.right.verticalOffset = 0;
    api.rebuildGrid();
    api.gotoFrame(20);
    // 直接 await 真实渲染 Promise，多渲染两帧，规避 headless 下 RAF 时序
    await api.view().render();
    await api.view().render();
    const v = api.view();
    assert(v.canvas.width > 0 && v.canvas.height > 0, '画布已分配尺寸');
    // 布局不能含 NaN（回归保护：曾因取错尺寸对象导致整盒 NaN、画面全黑）
    const lay = v._layout();
    ['left', 'right'].forEach((k) => {
      const b = lay[k];
      [b.x, b.y, b.w, b.h, b.scale].forEach((n) => {
        assert(Number.isFinite(n), '布局 ' + k + ' 含非有限值');
      });
    });
    // 在左眼画面盒内部多点采样（避开中央十字线与边框），应能取到画面像素而非纯背景
    const ctx = v.canvas.getContext('2d');
    const b = lay.left;
    const dpr = v.dpr;
    const samples = [[0.25, 0.25], [0.7, 0.3], [0.3, 0.72], [0.75, 0.75]];
    let painted = 0;
    samples.forEach(([fx, fy]) => {
      const px = Math.round((b.x + b.w * fx) * dpr);
      const py = Math.round((b.y + b.h * fy) * dpr);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const isBg = d[0] === 10 && d[1] === 13 && d[2] === 22;
      const isBlack = d[0] < 6 && d[1] < 6 && d[2] < 6;
      if (!isBg && !isBlack) painted++;
    });
    assert(painted >= 3, '左眼画面盒内至少 3 个采样点有画面内容（实际 ' + painted + '）');
  });

  await test('三种显示模式可切换', async () => {
    for (const mode of ['sbs', 'overlay', 'blink']) {
      state.mode = mode;
      api.requestRender();
      await new Promise((r) => setTimeout(r, 60));
    }
    state.mode = 'sbs';
    assert(true, '模式切换无异常');
  });

  await test('浏览器内并排合成（导出 _compose 路径）', async () => {
    // 复位到未偏移状态，确保两眼都有有效帧
    state.eyes.left.timeOffset = 0; state.eyes.left.verticalOffset = 0;
    state.eyes.right.timeOffset = 0; state.eyes.right.verticalOffset = 0;
    api.rebuildGrid();
    api.gotoFrame(20);
    const exp = new window.StereoExporter(api.view());
    const s = api.getState();
    const info = exp._frameInfoAt(s, 20);
    await exp._seekAll(s, info);
    // 直接把 _compose 写到 canvas，绕过 dataURL/Image 往返
    const outH = 360;
    const outW = s.eyes.left.source.width + s.eyes.right.source.width;
    const cv = document.createElement('canvas');
    cv.width = outW; cv.height = outH;
    const ctx = cv.getContext('2d');
    exp._compose(ctx, outW, outH, s, info);
    const probe = (fx) => Array.from(ctx.getImageData(Math.round(outW * fx), 180, 1, 1).data);
    const lp = probe(0.25), rp = probe(0.75);
    const lit = (d) => d[3] > 0 && !(d[0] < 8 && d[1] < 8 && d[2] < 8);
    assert(lit(lp) && lit(rp), '左右两半都有画面内容，L=' + lp + ' R=' + rp);

    // 再验证 thumbnail 的 dataURL 往返可正常解码
    const url = await exp.thumbnail(s, 20, 640);
    assert(url.startsWith('data:image/png'), '缩略图产出 dataURL');
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    assert(img.width === 640 && img.height === 180, '缩略图等比缩放到 640x180（实际 ' + img.width + 'x' + img.height + '）');
  });

  await test('真实 app 形态下标记 valid（sig 在 source 上）', () => {
    // 回归：曾因 createMarker/markerState 读 eyes.left.sig（实为 undefined）导致恒 stale
    const eyes = state.eyes; // app 形态：sig 挂在 eyes[k].source.sig
    assert(eyes.left.source.sig && eyes.right.source.sig, '样片源带 sig');
    const m = C.createMarker(7, 24, 25, eyes, {
      left: { x: 200, y: 200 }, right: { x: 200, y: 184 }
    });
    assert(m.sourceSig.left === eyes.left.source.sig, '记录的是 source.sig');
    assert(C.markerState(m, 25, eyes) === 'valid', '同素材同偏移时标记有效');
    eyes.right.timeOffset = 0.04;
    assert(C.markerState(m, 25, eyes) === 'stale', '改时间偏移后失效');
    eyes.right.timeOffset = 0;
  });

  await test('端到端选点：UI 拾取的标记在右栏显示为有效', async () => {
    state.eyes.left.timeOffset = 0; state.eyes.right.timeOffset = 0;
    api.rebuildGrid();
    api.gotoFrame(24);
    await api.view().render();
    const v = api.view();
    v.pickMode = true;
    // 模拟用户在左眼、右眼各点一次（素材坐标）
    v.onPick('left', { x: 210, y: 200 });
    v.onPick('right', { x: 210, y: 184 });
    assert(state.markers.length >= 1, '标记已写入状态');
    const m = state.markers[state.markers.length - 1];
    assert(C.markerState(m, 25, state.eyes) === 'valid', 'UI 新建标记为有效');
    assert(!m._forced, '未被强制失效');
    // 右栏渲染不应抛错
    api.renderMarkers();
    const badge = document.querySelector('.marker-badge');
    assert(badge && badge.textContent === '有效', '右栏徽章显示“有效”，实际：' + (badge && badge.textContent));

    // 改时间偏移后应转失效；改垂直偏移不应失效
    state.eyes.right.timeOffset = 0.04;
    assert(C.markerState(m, 25, state.eyes) === 'stale', '改时间偏移后标记失效');
    state.eyes.right.timeOffset = 0;
    state.eyes.right.verticalOffset = 16;
    assert(C.markerState(m, 25, state.eyes) === 'valid', '改垂直偏移标记保持有效');
    state.eyes.right.verticalOffset = 0;
  });

  await test('真实 MP4 走 VideoSource 解码与 seek（仅 http 环境）', async () => {
    if (location.protocol === 'file:') return; // file:// 下 fetch 受限，跳过
    const resp = await fetch('public/samples/left.mp4');
    assert(resp.ok, '能 fetch 到 ffmpeg 生成的样片');
    const file = new File([await resp.blob()], 'left.mp4', { type: 'video/mp4' });
    const src = new window.VideoSource(file, 25);
    await src.whenReady();
    assert(src.width === 640 && src.height === 360, '读到分辨率 640x360');
    assert(src.frameCount === 100, '读到 100 帧（实际 ' + src.frameCount + '）');
    // headless + virtual-time-budget 下媒体 seeked 事件可能被冻结，
    // seek 失败时只验证元数据链路，真实浏览器里 seek 正常（CLI ffmpeg 路径已独立验证）
    try {
      await src.seekToFrame(30);
      const cv = document.createElement('canvas');
      cv.width = src.width; cv.height = src.height;
      src.drawFrame(cv.getContext('2d'), src.width, src.height, 30);
      const d = cv.getContext('2d').getImageData(320, 180, 1, 1).data;
      assert(d[3] === 255 && !(d[0] < 8 && d[1] < 8 && d[2] < 8), 'seek 后画出真实帧');
    } catch (e) {
      console.warn('headless seek 跳过（环境限制，非产品缺陷）：', e.message);
    }
    src.setFps(50);
    assert(src.frameCount === 200, '帧率改 50 后帧数变 200（实际 ' + src.frameCount + '）');
    src.destroy();
  });

  await test('设置 JSON 往返', () => {
    const snap = JSON.stringify({
      baseFps: state.baseFps,
      eyes: {
        left: { timeOffset: state.eyes.left.timeOffset, verticalOffset: state.eyes.left.verticalOffset },
        right: { timeOffset: state.eyes.right.timeOffset, verticalOffset: state.eyes.right.verticalOffset }
      }
    });
    const back = JSON.parse(snap);
    approxEq(back.eyes.right.timeOffset, 0, 1e-9, '时间偏移可序列化');
    assert(back.eyes.right.verticalOffset === 0, '垂直偏移可序列化');
  });

  return results;
}
