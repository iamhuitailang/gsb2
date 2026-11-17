import { sampleChartPng } from './png.js';

/**
 * 本地样例报告。刻意包含：
 *   - 文字与表格；
 *   - 一张随报告提供的本地图片（images/chart.png）；
 *   - 一个指向第二个本地站点的图片引用；
 *   - 一段模仿“报告内按钮”的脚本：它会给按钮绑事件，并在加载时尝试
 *     读取业务接口、向第二站点发信标。预览里它必须完全不运行。
 */
export function buildSampleReport(config) {
  const trackerImage = `${config.origins.tracker}/pixel.png?from=sample-report`;
  const businessApi = `${config.origins.business}/api/me`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>交付质量周报（供应商样例）</title>
<link rel="stylesheet" href="styles/report.css">
</head>
<body>
<h1>交付质量周报</h1>
<p class="lead">供应商：华东精密组件（样例数据）</p>

<h2>批次抽检结果</h2>
<table>
  <thead>
    <tr><th>批次号</th><th>抽检数</th><th>合格数</th><th>不良率</th></tr>
  </thead>
  <tbody>
    <tr><td>B-2026-1101</td><td>120</td><td>118</td><td>1.67%</td></tr>
    <tr><td>B-2026-1102</td><td>80</td><td>80</td><td>0.00%</td></tr>
    <tr><td>B-2026-1103</td><td>150</td><td>141</td><td>6.00%</td></tr>
  </tbody>
</table>

<h2>趋势图</h2>
<p>下图随报告一起提供，应能在隔离预览中正常显示：</p>
<img id="local-chart" src="images/chart.png" alt="近三期不良率趋势图" width="160" height="96">

<h2>作者标注的外部资源</h2>
<p>下面这张图片引用指向第二个本地站点，预览时不应发起请求：</p>
<img id="external-chart" src="${trackerImage}" alt="外部趋势图">

<h2>交互（报告内脚本按钮）</h2>
<p>供应商在报告里放了这段脚本，希望读者点击按钮后回传确认：</p>
<button id="approve" type="button">确认交期</button>
<p id="approve-result">（脚本未运行）</p>

<script>
  // 模仿“报告内按钮”：如果脚本运行，会立刻标记标题、尝试联系业务接口、
  // 并向第二个本地站点发图片信标。
  document.title = 'SCRIPT_RAN';
  window.__gsb2ReportScriptRan = true;
  document.getElementById('approve').addEventListener('click', function () {
    document.getElementById('approve-result').textContent = '已确认（脚本运行了）';
    fetch('${businessApi}', { credentials: 'include' }).catch(function () {});
    const beacon = new Image();
    beacon.src = '${trackerImage}&from=button';
  });
  const beacon = new Image();
  beacon.src = '${trackerImage}&from=script';
</script>
</body>
</html>`;

  const css = `
body { font-family: -apple-system, "PingFang SC", sans-serif; color: #1f2328; }
.lead { color: #59636e; }
#approve { padding: 4px 12px; }
`.trim();

  return {
    title: '交付质量周报（本地样例）',
    fileName: 'sample-report.html',
    html,
    assets: [
      {
        path: 'images/chart.png',
        contentType: 'image/png',
        dataBase64: sampleChartPng().toString('base64'),
      },
      {
        path: 'styles/report.css',
        contentType: 'text/css',
        text: css,
      },
    ],
  };
}
