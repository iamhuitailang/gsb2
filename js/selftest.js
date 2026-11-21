/*
 * 同一套断言，浏览器里在页头显示通过数，node 里由 test/angle.test.mjs 运行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./angle.js'),
      require('./exporter.js'),
      require('./example-data.js')
    );
  } else root.SelfTest = factory(root.Angle, root.Exporter, root.ExampleData);
})(typeof self !== 'undefined' ? self : this, function (Angle, Exporter, ExampleData) {
  'use strict';

  function runAll() {
    const results = [];
    const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || '' });
    const eq = (name, actual, expected) =>
      ok(name, actual === expected, `期望 ${expected}，实际 ${actual}`);

    const D = ExampleData.DIRECTIONS;
    const missing = ExampleData.datasets.find((d) => d.id === 'missing');
    const standard = ExampleData.datasets.find((d) => d.id === 'standard');
    const shift = ExampleData.datasets.find((d) => d.id === 'anchor-shift');

    // 1. 基本方向选择
    eq('0° 选到 N', Angle.selectDirection(D, 0).id, 'N');
    eq('90° 选到 E', Angle.selectDirection(D, 90).id, 'E');
    eq('40° 选到 NE', Angle.selectDirection(D, 40).id, 'NE');

    // 2. 0/360 跨界：首尾不能选到离得最远的图
    eq('355° 选到 N（不是 E/对面）', Angle.selectDirection(D, 355).id, 'N');
    eq('359.9° 选到 N', Angle.selectDirection(D, 359.9).id, 'N');
    eq('181° 选到 S', Angle.selectDirection(D, 181).id, 'S');

    // 3. 角度边界确定性：分界上取顺时针的下一个方向
    eq('22.5° 边界取 NE（顺时针一侧）', Angle.selectDirection(D, 22.5).id, 'NE');
    eq('67.5° 边界取 E', Angle.selectDirection(D, 67.5).id, 'E');

    // 3b. 边界位置正好在相邻方向中点，且数量与方向数相等
    const bnds = Angle.boundaries(D);
    eq('边界数量等于方向数', bnds.length, D.length);
    eq('N/NE 分界在 22.5°', bnds[0], 22.5);
    eq('NW/N 跨界分界在 337.5°', bnds[bnds.length - 1], 337.5);
    eq('圆环距离：355° 距 N 仅 5°', Angle.circularDistance(355, 0), 5);
    eq('圆环距离：180° 距 N 为 180°', Angle.circularDistance(180, 0), 180);

    // 4. 拖一整圈：序列长度必须与方向数一致，且只在边界切换
    const trace = [];
    let prev = null;
    let switches = 0;
    for (let a = 0; a <= 360; a += 0.5) {
      const id = Angle.selectDirection(D, a).id;
      if (id !== prev) {
        if (prev) switches += 1;
        trace.push({ angle: a % 360, id });
        prev = id;
      }
    }
    eq('一整圈恰好 8 次方向切换', switches, 8);
    eq('一整圈回到起点 N', trace[0].id, 'N');
    eq('一圈结束仍是 N', trace[trace.length - 1].id, 'N');
    const ordered = trace.map((t) => t.id);
    ok('切换按顺时针 N→NE→…→NW',
      JSON.stringify(ordered) === JSON.stringify(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'N']),
      ordered.join('→'));

    // 5. 镜像角度
    eq('E(90) 镜像为 W(270)', Angle.mirrorAngle(90), 270);
    eq('N(0) 镜像为 N', Angle.mirrorAngle(0), 0);
    eq('S(180) 镜像为 S', Angle.mirrorAngle(180), 180);
    eq('NE(45) 镜像为 NW(315)', Angle.mirrorAngle(45), 315);

    // 6. 缺素材审计：镜像开/关结果不同
    const auditOff = Angle.audit(missing, false);
    const auditOn = Angle.audit(missing, true);
    ok('镜像关：walk/W 无替代来源',
      auditOff.some((r) => r.type === 'direction' && r.actionId === 'walk' && r.directionId === 'W' && !r.mirrorSource));
    const wMirror = auditOn.find((r) => r.type === 'direction' && r.actionId === 'walk' && r.directionId === 'W');
    eq('镜像开：walk/W 由 E 镜像补齐', wMirror.mirrorSource, 'E');
    const nUnresolved = auditOn.find((r) => r.type === 'direction' && r.actionId === 'walk' && r.directionId === 'N');
    ok('walk/N 镜像后仍是自己，无替代', nUnresolved && !nUnresolved.mirrorSource);
    const frameGap = auditOn.find((r) => r.type === 'frame' && r.actionId === 'idle' && r.directionId === 'SE');
    ok('idle/SE 第 3 帧缺帧被列出', frameGap && JSON.stringify(frameGap.indexes) === '[2]');

    // 7. resolve 替代标记
    const rW = Angle.resolve(missing, 270, 'walk', true, 0.2);
    eq('resolve walk/W 返回 E 的序列', rW.substitute && rW.substitute.sourceDirectionId, 'E');
    const rN = Angle.resolve(missing, 0, 'walk', true, 0.2);
    ok('walk/N 无替代时标记 unresolved', rN.unresolved);
    const rWoff = Angle.resolve(missing, 270, 'walk', false, 0.2);
    ok('镜像关时 walk/W 为 unresolved', rWoff.unresolved);

    // 8. 缺帧时沿用上一有效帧
    const se = missing.sequences['idle:SE'];
    const atGap = Angle.frameAtProgress(se.frames, 0.7);
    eq('缺帧位置沿用前一帧（index 1）', atGap.frame.id, 'idle-SE-1');
    ok('held 标记为 true', atGap.held);

    // 9. 动作进度连续：同 progress 换方向，帧序号一致
    const p = 0.55;
    const s1 = Angle.resolve(standard, 0, 'walk', true, p);
    const s2 = Angle.resolve(standard, 180, 'walk', true, p);
    eq('同 progress 不同方向帧序号一致', s1.frameIndex, s2.frameIndex);

    // 10. 锚点错位组与标准版锚点确实不同
    ok('锚点错位组 E 向锚点偏离标准',
      shift.sequences['idle:E'].frames[0].anchorX !== standard.sequences['idle:E'].frames[0].anchorX);

    // 11. 导出/导入往返一致
    const cfg = Exporter.buildConfig(missing, true);
    eq('导出格式标识', cfg.format, Exporter.FORMAT);
    ok('导出含 walk/W→E 替代关系',
      cfg.substitutions.some((s) => s.actionId === 'walk' && s.directionId === 'W' && s.sourceDirectionId === 'E'));
    ok('导出 unresolved 含 walk/N',
      cfg.unresolved.some((u) => u.actionId === 'walk' && u.directionId === 'N'));
    const back = Exporter.parseConfig(cfg);
    eq('导入后序列数一致', Object.keys(back.sequences).length, Object.keys(missing.sequences).length);
    eq('导入后锚点一致',
      back.sequences['idle:SE'].frames[0].anchorX,
      missing.sequences['idle:SE'].frames[0].anchorX);
    eq('导入后时长一致',
      back.sequences['idle:SE'].frames[0].duration,
      missing.sequences['idle:SE'].frames[0].duration);

    return {
      results,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
    };
  }

  return { runAll };
});
