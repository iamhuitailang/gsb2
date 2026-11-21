// 端到端冒烟: 在真实 Chromium 里加载页面, 验证渲染、统计、拾取、编辑、区块联动和导出。
// 运行: node tests/e2e.smoke.mjs (需先在仓库根目录起静态服务, 端口 8123)
import { chromium } from 'playwright';

const URL = process.env.VOXEL_URL || 'http://127.0.0.1:8123/index.html';
const assert = (cond, msg) => {
  if (!cond) {
    console.error('✖ ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log('✔ ' + msg);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500); // 等 CDN three.js 加载与首帧渲染

// 1. 无 JS 报错, canvas 在渲染
assert(errors.length === 0, '页面加载无报错: ' + errors.join(' | '));
const canvas = await page.$('#viewport canvas');
assert(canvas !== null, 'WebGL canvas 已挂载');

// 2. 初始彩色墙统计非零
const stat = (id) => page.$eval('#' + id, (el) => el.textContent);
const voxelCount = Number(await stat('stVoxel'));
const rawFaces = Number(await stat('stRawFace'));
const quads = Number(await stat('stQuad'));
const tris = Number(await stat('stTri'));
assert(voxelCount > 0, `彩色墙体素数 > 0 (实际 ${voxelCount})`);
assert(rawFaces > quads, `贪婪合并生效: 小面 ${rawFaces} > 四边形 ${quads}`);
assert(tris === quads * 2, `三角形数 = 四边形 x2 (${tris} = ${quads}*2)`);
console.log(`   统计: 体素=${voxelCount} 可见小面=${rawFaces} 四边形=${quads} 三角形=${tris}`);

// 3. 实心立方体样例: 一个区块, 6 个大四边形, 384 个合并前小面
await page.click('#sampleCubeBtn');
await page.waitForTimeout(300);
assert((await stat('stChunk')) === '1', '实心立方体只占 1 个区块');
assert((await stat('stQuad')) === '6', '实心块外表面合并为 6 个大四边形');
assert((await stat('stRawFace')) === '384', '合并前可见小面 384 (6x8x8)');
assert((await stat('stTri')) === '12', '三角形数 12');

// 4. 回到彩色墙, 模拟点击做一次添加编辑, 统计增加且日志出现
await page.click('#sampleWallBtn');
await page.waitForTimeout(300);
const before = Number(await stat('stVoxel'));
const box = await page.$eval('#viewport canvas', (c) => {
  const r = c.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height };
});
// (0.5, 0.4) 经扫描确认命中墙面; mouse API 是视口坐标, 需加 canvas 左上角偏移(左侧面板)
const hitX = box.left + box.w * 0.5;
const hitY = box.top + box.h * 0.4;
await page.mouse.click(hitX, hitY);
await page.waitForTimeout(300);
const after = Number(await stat('stVoxel'));
assert(after === before + 1, `左键添加 1 格: ${before} -> ${after}`);
const logText = await page.$eval('#log li', (el) => el.textContent);
assert(/重建 \d+ 区块/.test(logText), '日志记录了区块重建: ' + logText.trim());

// 5. 删除工具: 右键点击, 体素数回落
await page.click('[data-tool="remove"]');
await page.mouse.click(hitX, hitY, { button: 'right' });
await page.waitForTimeout(300);
const afterRemove = Number(await stat('stVoxel'));
assert(afterRemove === before, `右键删除 1 格回到 ${before} (实际 ${afterRemove})`);

// 6. 边界挖空按钮: 跨边界两个区块都进入重建列表
await page.click('#hollowBtn');
await page.waitForTimeout(300);
const hollowLog = await page.$eval('#log li', (el) => el.textContent);
assert(/重建 2 区块/.test(hollowLog), '边缘挖空同时刷新两侧区块: ' + hollowLog.trim());

// 7. 显示开关不报错
await page.uncheck('#toggleBoundary');
await page.uncheck('#toggleGrid');
await page.waitForTimeout(200);
await page.check('#toggleBoundary');
await page.check('#toggleGrid');
assert(errors.length === 0, '切换边界/网格显示无报错');

// 8. OBJ 导出内容校验(拦截下载)
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }),
  page.click('#exportObjBtn'),
]);
const stream = await download.createReadStream();
let content = '';
for await (const chunk of stream) content += chunk;
assert(/^# voxel surface export/.test(content), 'OBJ 带文件头');
const vLines = content.match(/^v /gm) || [];
const fLines = content.match(/^f /gm) || [];
assert(fLines.length > 0 && vLines.length === fLines.length * 3, `OBJ 面与顶点一致: ${fLines.length} 面, ${vLines.length} 顶点`);
assert(/^v [-\d. ]+ [-\d. ]+ [-\d. ]+ [\d.]+ [\d.]+ [\d.]+/m.test(content), 'OBJ 顶点带 RGB 颜色');
assert(!/boundary|grid/i.test(content), 'OBJ 不含边界/网格等辅助对象');
console.log(`   导出 OBJ: ${download.suggestedFilename()}, ${fLines.length} 个三角面`);

// 9b. GLB 导出: 二进制魔数 glTF
const [glbDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }),
  page.click('#exportGlbBtn'),
]);
const glbBuf = await glbDl.createReadStream().then(async (s) => {
  const chunks = [];
  for await (const c of s) chunks.push(c);
  return Buffer.concat(chunks);
});
assert(glbBuf.toString('utf8', 0, 4) === 'glTF', 'GLB 文件头魔数正确');
assert(/\.glb$/.test(glbDl.suggestedFilename()), 'GLB 文件名正确');
console.log(`   导出 GLB: ${glbDl.suggestedFilename()}, ${glbBuf.length} 字节`);

// 9c. 删除命中的整个区块: 区块数下降, 且场景里不残留悬空旧表面
const chunksBefore = Number(await stat('stChunk'));
await page.mouse.move(hitX, hitY);
await page.waitForTimeout(150);
const hoverNow = await page.$eval('#hoverInfo', (el) => el.textContent);
assert(/区块\(/.test(hoverNow), '删除前已悬停在区块上: ' + hoverNow);
await page.click('#deleteChunkBtn');
await page.waitForTimeout(300);
const chunksAfter = Number(await stat('stChunk'));
assert(chunksAfter === chunksBefore - 1, `删除整个区块: ${chunksBefore} -> ${chunksAfter}`);
const deleteLog = await page.$eval('#log li', (el) => el.textContent);
assert(/删除区块/.test(deleteLog), '日志记录区块删除: ' + deleteLog.trim());

// 删区块后再导出 OBJ: 三角面数必须与页面统计一致(若有悬空旧表面会对不上)
const triExpected = Number(await stat('stTri'));
const [dl2] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }),
  page.click('#exportObjBtn'),
]);
const obj2 = await dl2.createReadStream().then(async (s) => {
  let t = '';
  for await (const c of s) t += c;
  return t;
});
const obj2Faces = (obj2.match(/^f /gm) || []).length;
assert(obj2Faces === triExpected, `删区块后导出面数=${obj2Faces} 与统计三角形=${triExpected} 一致(无悬空表面)`);

// 10. 工程保存/读取往返
const [saveDl] = await Promise.all([
  page.waitForEvent('download', { timeout: 5000 }),
  page.click('#saveBtn'),
]);
assert(/\.json$/.test(saveDl.suggestedFilename()), '工程文件为 JSON');
const savedJson = JSON.parse(
  await (await saveDl.createReadStream()).reduce((d, c) => d + c, '')
);
assert(savedJson.format === 'voxel-project' && savedJson.voxels.length > 0, '工程 JSON 含体素数据');
assert(savedJson.chunkSize === 8, '工程记录区块尺寸 8');

// 9d. 清空后读取工程, 体素数恢复
await page.click('#clearBtn');
await page.waitForTimeout(200);
assert((await stat('stVoxel')) === '0', '清空后体素数为 0');
const savePath = await saveDl.path();
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  page.click('#loadBtn'),
]);
await chooser.setFiles(savePath);
await page.waitForTimeout(400);
assert(
  Number(await stat('stVoxel')) === savedJson.voxels.length,
  `读取工程恢复 ${savedJson.voxels.length} 个体素`
);

await browser.close();
if (errors.length) {
  console.error('未预期报错:', errors);
  process.exitCode = 1;
} else {
  console.log('\n全部冒烟检查通过 ✅');
}
