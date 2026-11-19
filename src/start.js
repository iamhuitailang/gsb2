'use strict';
// 一键启动:第二站点(18081)+ 隔离预览源(18082)+ 业务页(18080),并生成样例。
const path = require('node:path');
const { ReportStore } = require('./store');
const { createMainServer } = require('./main-server');
const { createPreviewServer } = require('./preview-server');
const { createSecondSite } = require('./second-site');
const { generateSamples } = require('./generate-samples');

async function main() {
  const ports = {
    main: Number(process.env.PORT_MAIN || 18080),
    second: Number(process.env.PORT_SECOND || 18081),
    preview: Number(process.env.PORT_PREVIEW || 18082),
  };

  const second = await createSecondSite(ports.second);
  const previewStore = new ReportStore(path.join(__dirname, '..', 'data', 'reports'));
  const preview = await createPreviewServer(previewStore, ports.preview);
  const mainServer = await createMainServer(
    { store: previewStore, previewBase: preview.baseUrl }, ports.main);

  const sampleFile = generateSamples(
    path.join(__dirname, '..', 'public', 'samples'), second.baseUrl, mainServer.baseUrl);

  console.log('本地报告库已启动:');
  console.log(`  业务页(采购系统):   ${mainServer.baseUrl}/`);
  console.log(`  隔离预览源:         ${preview.baseUrl}  (报告内容只从这里出)`);
  console.log(`  第二站点(外部模拟): ${second.baseUrl}  (请求计数: ${second.baseUrl}/count)`);
  console.log(`  样例报告:           ${sampleFile}`);
  console.log('\n在业务页导入样例报告后,可从列表预览或独立预览地址打开。');
}

main().catch((err) => { console.error(err); process.exit(1); });
