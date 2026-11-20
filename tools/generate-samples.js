#!/usr/bin/env node
'use strict';
/*
 * generate-samples.js — 生成合成样例点云(确定性,无第三方依赖)
 *
 * 场景: 一块带起伏的薄板 + 一个小立柱,两次扫描存在已知的相对位姿
 *   - scan_a.xyz: 参考扫描,含颜色,末尾混入 5 个离群点和 3 个坏行
 *   - scan_b.xyz: 第二次扫描(同一物体),整体绕 Z 旋转 8° 并平移,
 *                 采样视角不同(点数略少),用于配准练习
 *   - scan_a.ply: 同 scan_a 的 PLY ascii 版本(含 1 个坏行),演示格式与坏行报告
 *
 * 用法: node tools/generate-samples.js [输出目录]
 */
const fs = require('fs');
const path = require('path');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 物体表面采样: 薄板 z = 0.15*sin(x)*cos(y),x/y ∈ [-3,3]
function surfacePoint(rand) {
  const x = rand() * 6 - 3;
  const y = rand() * 6 - 3;
  const z = 0.15 * Math.sin(x) * Math.cos(y);
  // 立柱: 中心 (1.2, -0.8),半径 0.45,高度 1.6
  const dx = x - 1.2, dy = y + 0.8;
  if (dx * dx + dy * dy < 0.45 * 0.45) {
    return [x, y, z + rand() * 1.6];
  }
  return [x, y, z];
}

function colorOf(p) {
  // 高度上色: 蓝(低) → 绿 → 红(高)
  const t = Math.max(0, Math.min(1, (p[2] + 0.2) / 2.0));
  const r = Math.round(60 + t * 195);
  const g = Math.round(120 + Math.sin(t * Math.PI) * 100);
  const b = Math.round(220 - t * 180);
  return [r, g, b];
}

function rotateZ(p, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
}

function generate() {
  const rand = mulberry32(20261120);
  const scanA = [];
  for (let i = 0; i < 4200; i++) {
    const p = surfacePoint(rand);
    // 轻微测量噪声
    p[0] += (rand() - 0.5) * 0.01;
    p[1] += (rand() - 0.5) * 0.01;
    p[2] += (rand() - 0.5) * 0.01;
    scanA.push({ p: p, c: colorOf(p) });
  }
  // 5 个明显离群点
  const outliers = [
    [[9.5, 8.1, 7.2], [255, 255, 255]],
    [[-8.3, 7.7, -6.5], [255, 0, 255]],
    [[7.1, -9.2, 5.0], [0, 255, 255]],
    [[-7.7, -8.8, 8.9], [255, 255, 0]],
    [[10.2, 0.5, -7.4], [128, 0, 255]]
  ];

  // 第二扫: 绕 Z 旋转 8° + 平移 (0.6, 0.4, 0.05),不同采样位置/数量
  const rad = 8 * Math.PI / 180;
  const scanB = [];
  const randB = mulberry32(20261121);
  for (let i = 0; i < 3600; i++) {
    let p = surfacePoint(randB);
    p[0] += (randB() - 0.5) * 0.012;
    p[1] += (randB() - 0.5) * 0.012;
    p[2] += (randB() - 0.5) * 0.012;
    p = rotateZ(p, rad);
    p[0] += 0.6; p[1] += 0.4; p[2] += 0.05;
    scanB.push({ p: p, c: colorOf(p) });
  }

  return { scanA: scanA, scanB: scanB, outliers: outliers, transformB: {
    // 生成时 B = Rz(8°) * A + t; 用户在工具中要对 B 施加逆变换才能对齐 A
    generated: { rotationZDeg: 8, translation: [0.6, 0.4, 0.05] },
    correction: { rotationZDeg: -8, translation: [-0.6, -0.4, -0.05] }
  } };
}

function fmt(v) { return v.toFixed(4); }

function writeXYZ(file, rows, badLines) {
  const lines = [
    '# 合成点云样例 — 点云检查工具 generate-samples.js 生成',
    '# 列定义: x y z r g b (颜色 0-255)',
    '# 本文件包含 ' + (badLines ? badLines.length : 0) + ' 个故意写入的坏行,用于演示坏行报告'
  ];
  rows.forEach(function (r) {
    lines.push(r.p.map(fmt).concat(r.c.map(String)).join(' '));
  });
  if (badLines) badLines.forEach(function (b) { lines.push(b.text); });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function writePLY(file, rows, badLine) {
  const n = rows.length;
  const header = [
    'ply', 'format ascii 1.0',
    'comment 合成 PLY 样例(含 1 个坏行)',
    'element vertex ' + n,
    'property float x', 'property float y', 'property float z',
    'property uchar red', 'property uchar green', 'property uchar blue',
    'end_header'
  ];
  const body = rows.map(function (r) {
    return r.p.map(fmt).concat(r.c.map(String)).join(' ');
  });
  body.splice(Math.floor(n / 2), 0, badLine);
  fs.writeFileSync(file, header.concat(body).join('\n') + '\n');
}

function main() {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });
  const data = generate();

  const badA = [
    { text: '1.0 2.0 oops 10 20 30' },
    { text: '不完整一行 3.14' },
    { text: '# 上面两行是故意构造的坏行(本行是注释,不算坏行)' }
  ];
  // 第三行是注释不会报错,只保留前两个真正的坏行
  const realBad = badA.slice(0, 2);

  // scan_a: 正常点 + 5 个离群点,末尾追加 2 个坏行(注释行由 writeXYZ 另行处理)
  const rowsA = data.scanA.concat(
    data.outliers.map(function (o) { return { p: o[0], c: o[1] }; }));
  writeXYZ(path.join(outDir, 'scan_a.xyz'), rowsA, realBad);
  writePLY(path.join(outDir, 'scan_a.ply'), data.scanA, '3.0 nan 1.0 100 100 100');
  writeXYZ(path.join(outDir, 'scan_b.xyz'), data.scanB, null);

  const readme = [
    '# 合成样例说明',
    '',
    '由 `node tools/generate-samples.js` 确定性生成(固定随机种子),可随时重建。',
    '',
    '## 文件',
    '',
    '| 文件 | 内容 |',
    '| --- | --- |',
    '| `scan_a.xyz` | 参考扫描 ' + data.scanA.length + ' 点(带颜色) + 5 个离群点 + 2 个坏行 |',
    '| `scan_a.ply` | 同一场景的 PLY ascii 版本,' + data.scanA.length + ' 点 + 1 个坏行 |',
    '| `scan_b.xyz` | 第二次扫描 ' + data.scanB.length + ' 点,相对 A 的真实位姿见下 |',
    '',
    '## scan_b 位姿关系(配准练习参考答案)',
    '',
    '生成时 B 由 A 经如下变换得到: 绕 Z 旋转 ' + data.transformB.generated.rotationZDeg +
      '°,平移 [' + data.transformB.generated.translation.join(', ') + ']',
    '',
    '在工具中选中 scan_b,对它施加**逆变换**即可对齐 scan_a:',
    '',
    '- 旋转(度) rz: ' + data.transformB.correction.rotationZDeg,
    '- 平移: [' + data.transformB.correction.translation.join(', ') + ']',
    '',
    '对齐后最近邻 RMSE 可从约 0.19 降到约 0.06(残差为两次扫描不同采样位置所致)。',
    '',
    '## 建议练习流程',
    '',
    '1. 导入 `scan_a.xyz`,确认弹出 2 个坏行报告,有效点仍可渲染;',
    '2. 用「离群点筛除」(默认 k=8, 1.0σ)预览并剔除 5 个离群点;',
    '3. 再导入 `scan_b.xyz`,切到叠加视图,用微调按钮把 B 向参考答案对齐;',
    '4. 点「计算配准误差」观察 RMSE 下降;',
    '5. 框选一块区域做裁剪,再用「撤销」恢复;',
    '6. 保存工程并导出处理后的 XYZ 与工程说明。',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README.md'), readme);

  console.log('样例已生成到 ' + outDir);
  console.log('  scan_a.xyz  ' + data.scanA.length + ' 点 + 5 离群 + 2 坏行');
  console.log('  scan_a.ply  ' + data.scanA.length + ' 点 + 1 坏行');
  console.log('  scan_b.xyz  ' + data.scanB.length + ' 点 (旋转8°+平移)');
}

main();
