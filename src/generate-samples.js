'use strict';
// 生成样例报告:一张表格 + 一张本地图片 + 一个指向第二站点的图片引用
// + 一个模仿"报告内按钮"的脚本(试图替业务页发起操作,预览中不会运行)。
//
// 用法: node src/generate-samples.js [输出目录] [第二站点URL] [业务页URL]
const fs = require('node:fs');
const path = require('node:path');
const { barChartPng } = require('./png');

function generateSamples(outDir, secondSiteUrl, mainUrl) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'chart-local.png'), barChartPng());

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>2026 年 11 月供货对账报告</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 20px; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #888; padding: 4px 10px; }
  th { background: #dfe7f5; }
  button { padding: 6px 14px; }
</style>
</head>
<body>
  <h1>2026 年 11 月供货对账报告</h1>
  <p>供应商:华东样例五金有限公司 · 报告编号 GSB2-2026-1119</p>

  <h2>供货明细</h2>
  <table>
    <tr><th>物料编码</th><th>名称</th><th>数量</th><th>单价(元)</th><th>金额(元)</th></tr>
    <tr><td>M-1001</td><td>六角螺栓 M8×30</td><td>12000</td><td>0.42</td><td>5040.00</td></tr>
    <tr><td>M-1002</td><td>平垫圈 Φ8</td><td>24000</td><td>0.06</td><td>1440.00</td></tr>
    <tr><td>M-1003</td><td>尼龙锁紧螺母 M8</td><td>12000</td><td>0.35</td><td>4200.00</td></tr>
    <tr><td>M-1004</td><td>弹簧垫圈 8#</td><td>12000</td><td>0.08</td><td>960.00</td></tr>
    <tr><th colspan="4">合计</th><th>11640.00</th></tr>
  </table>

  <h2>月度供货趋势</h2>
  <p><img src="chart-local.png" alt="月度供货趋势图(本地图片)" width="360"></p>

  <h2>供应商实时库存</h2>
  <p><img src="${secondSiteUrl}/tracker.png" alt="实时库存图(外部站点)"></p>

  <h2>回执</h2>
  <button id="mark-read" type="button">在报告内标记为已读</button>
  <script>
    // 模仿"报告内按钮":试图携带业务页会话,替用户调用业务接口。
    // 在隔离预览中,这段脚本不会运行。
    document.getElementById('mark-read').addEventListener('click', function () {
      fetch('${mainUrl}/api/report-action', { method: 'POST', credentials: 'include' });
      document.body.insertAdjacentHTML('beforeend', '<p>已读状态已同步到采购系统</p>');
    });
  </script>
</body>
</html>
`;
  const file = path.join(outDir, 'sample-report.html');
  fs.writeFileSync(file, html);
  return file;
}

if (require.main === module) {
  const outDir = process.argv[2] || path.join(__dirname, '..', 'public', 'samples');
  const secondSiteUrl = process.argv[3] || 'http://localhost:18081';
  const mainUrl = process.argv[4] || 'http://localhost:18080';
  const file = generateSamples(outDir, secondSiteUrl, mainUrl);
  console.log(`样例报告已生成: ${file}`);
}

module.exports = { generateSamples };
