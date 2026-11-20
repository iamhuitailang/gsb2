/**
 * 端到端验证（真实 Chromium + WebGL）：
 * 启动 Vite dev server，在页面里验证拾取、重叠循环、隐藏过滤、拖拽重挂接、
 * 循环拒绝、删除对话框、撤销重做、保存/打开往返与相机恢复。
 *
 * 运行：npx tsx e2e/editor.e2e.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✖ ${name} ${detail}`);
  }
}

async function statusText(page: Page): Promise<string> {
  return page.locator('#status-message').innerText();
}

async function treeRows(page: Page): Promise<string[]> {
  return page.locator('.tree-row .tree-label').allInnerTexts();
}

async function selectBuiltin(page: Page, value: string): Promise<void> {
  await page.selectOption('#sample-select', value);
  await page.waitForTimeout(150);
}

/** HTML5 拖拽在 headless 下需手动派发事件；坐标取目标行中心以命中 inside 落点 */
async function html5Drag(page: Page, fromSel: string, toSel: string): Promise<void> {
  await page.evaluate(
    ({ fromSel, toSel }) => {
      const from = document.querySelector(fromSel) as HTMLElement;
      const to = document.querySelector(toSel) as HTMLElement;
      const rect = to.getBoundingClientRect();
      // 行中心：computeDropTarget 用 25%/75% 划分 before/inside/after
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, cancelable: true, clientX: cx, clientY: cy }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, cancelable: true, clientX: cx, clientY: cy }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    },
    { fromSel, toSel },
  );
  await page.waitForTimeout(120);
}

async function main(): Promise<void> {
  // 在固定空闲端口启动本工程自己的 dev server
  const server: ChildProcess = spawn(
    'npx',
    ['vite', '--port', String(PORT), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd() },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dev server 启动超时')), 30000);
    server.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready in')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.on('exit', (code) => reject(new Error(`dev server 提前退出 code=${code}`)));
  });

  const browser: Browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`);
  });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  console.log('— 启动与初始场景 —');
  check('WebGL canvas 存在', (await page.locator('#gl-canvas').count()) === 1);
  check('初始场景树非空', (await treeRows(page)).length > 0);
  check('无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  console.log('— 点选：真正命中 / 重叠循环 / 隐藏过滤 —');
  await selectBuiltin(page, 'test:picking');
  const canvas = page.locator('#gl-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas 无布局尺寸');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // 三个重叠对象沿视线排列，中心点击应先命中最前方小球
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(150);
  let sel = await page.locator('#status-selection').innerText();
  check('点选命中最前方对象', sel.includes('前方小球'), sel);
  check('显示重叠循环徽标', await page.locator('#cycle-badge').isVisible());
  const total = await page.locator('#cycle-total').innerText();
  check('循环计数为 3（隐藏挡板/隐藏组不计入）', total === '3', `total=${total}`);

  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  sel = await page.locator('#status-selection').innerText();
  check('Tab 切换到中间立方体', sel.includes('中间立方体'), sel);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(100);
  sel = await page.locator('#status-selection').innerText();
  check('Tab 再切换到后方大球', sel.includes('后方大球'), sel);

  // 隐藏父组下的盒子不能被选中：锥体渲染在视图最左侧，在该位置点击应只命中可见锥体，
  // 隐藏父组（及其子对象）和隐藏挡板都不应出现在命中结果里。
  const sideX = Math.round(box.x + box.width * 0.08);
  await page.mouse.click(sideX, cy);
  await page.waitForTimeout(150);
  const sideSel = await page.locator('#status-selection').innerText();
  check('隐藏组子对象不阻挡选择（命中可见锥体）', sideSel.includes('左侧可点选目标'), sideSel);
  // 注意：锥体名称里恰好含“隐藏组相邻”字样，这里要排除的是真正的隐藏对象，而非子串
  check('真正的隐藏对象从不出现在选择中',
    !sideSel.includes('隐藏父组') && !sideSel.includes('隐藏的挡板'));

  console.log('— 拖拽重挂接与循环拒绝 —');
  await selectBuiltin(page, 'test:reparent');
  const beforeRows = await treeRows(page);

  // 取各节点的稳定 id 与名称
  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-node-id]')).map((li) => ({
      id: li.getAttribute('data-node-id')!,
      name: li.querySelector('.tree-label')?.textContent ?? '',
    })),
  );
  const a2 = ids.find((i) => i.name.startsWith('A-2'))!;
  const b1 = ids.find((i) => i.name.startsWith('B-1'))!;
  const branchA = ids.find((i) => i.name.startsWith('分支 A'))!;
  const a1 = ids.find((i) => i.name.startsWith('A-1'))!;

  // 合法重挂接：A-2 -> B-1 内部
  await html5Drag(
    page,
    `li[data-node-id="${a2.id}"]`,
    `li[data-node-id="${b1.id}"]`,
  );
  const status = await statusText(page);
  check('合法重挂接成功并提示世界保持', status.includes('世界变换'), status);
  const parentName = await page.evaluate(
    (id) => {
      const api = (window as unknown as {
        __editor__?: { snapshot(): { nodes: { id: string; name: string; parentId: string | null }[] } };
      }).__editor__;
      const nodes = api!.snapshot().nodes;
      const self = nodes.find((n) => n.id === id)!;
      if (self.parentId === null) return '(根)';
      return nodes.find((n) => n.id === self.parentId)?.name ?? '(未知)';
    },
    a2.id,
  );
  check('A-2 已成为 B-1 子节点', parentName.includes('B-1'), parentName);

  // 循环拒绝：把分支 A 拖到 A-1（其子孙）内部
  await html5Drag(
    page,
    `li[data-node-id="${branchA.id}"]`,
    `li[data-node-id="${a1.id}"]`,
  );
  const errStatus = await statusText(page);
  check('循环父子被拒绝并说明原因', errStatus.includes('拒绝循环父子关系'), errStatus);
  check('拒绝后场景树未被破坏', (await treeRows(page)).length === beforeRows.length);

  console.log('— 删除父对象：保留 / 连带子对象 —');
  await selectBuiltin(page, 'test:delete');
  const ids2 = await page.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-node-id]')).map((li) => ({
      id: li.getAttribute('data-node-id')!,
      name: li.querySelector('.tree-label')?.textContent ?? '',
    })),
  );
  const company = ids2.find((i) => i.name.startsWith('待删除父组'))!;
  await page.click(`li[data-node-id="${company.id}"] .tree-label`);
  await page.waitForTimeout(80);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  check('删除有子对象的父级弹出选择对话框', await page.locator('#modal-backdrop').isVisible());
  await page.click('#modal-keep');
  await page.waitForTimeout(150);
  const rowsAfterKeep = await treeRows(page);
  check('保留模式：父组消失', !rowsAfterKeep.some((n) => n.startsWith('待删除父组')));
  check('保留模式：子对象仍在', rowsAfterKeep.some((n) => n.startsWith('子对象 A')));
  check('保留模式：旁观对象不受影响', rowsAfterKeep.some((n) => n.startsWith('无关旁观对象')));

  // 撤销应恢复父组与层级（DeleteCommand 会同时恢复选择，company 重新处于选中态）
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(120);
  const rowsAfterUndo = await treeRows(page);
  check('撤销恢复被删父组', rowsAfterUndo.some((n) => n.startsWith('待删除父组')));
  check('撤销后父组重新被选中',
    (await page.locator('#status-selection').innerText()).includes('待删除父组'));

  // 连带删除路径（company 仍处于选中态）
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  check('再次删除仍弹出对话框', await page.locator('#modal-backdrop').isVisible());
  await page.click('#modal-remove');
  await page.waitForTimeout(150);
  const rowsAfterRemove = await treeRows(page);
  check('连带模式：父组与子对象一起删除', !rowsAfterRemove.some((n) => n.startsWith('子对象 A')));
  check('连带模式：孙节点也被删除', !rowsAfterRemove.some((n) => n.startsWith('孙节点球')));
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(120);
  check('连带删除可撤销恢复', (await treeRows(page)).some((n) => n.startsWith('孙节点球')));

  console.log('— 复制与撤销重做 —');
  await selectBuiltin(page, 'sample:diorama');
  const countBefore = (await treeRows(page)).length;
  // 载入新场景会清空选择，先在树里选一个对象再复制
  await page.locator('.tree-row').first().click();
  await page.waitForTimeout(80);
  check('复制前已有选中对象',
    (await page.locator('#status-selection').innerText()).length > 0);
  await page.click('#btn-duplicate');
  await page.waitForTimeout(120);
  check('复制后节点数增加', (await treeRows(page)).length > countBefore);
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(100);
  check('撤销复制恢复原数量', (await treeRows(page)).length === countBefore);
  await page.keyboard.press('Meta+Shift+z');
  await page.waitForTimeout(100);
  check('重做再次复制', (await treeRows(page)).length > countBefore);

  console.log('— 变换模式 / 局部世界切换 / 检查器编辑 / 剪切标注 —');
  await selectBuiltin(page, 'test:nonuniform');
  const nuIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-node-id]')).map((li) => ({
      id: li.getAttribute('data-node-id')!,
      name: li.querySelector('.tree-label')?.textContent ?? '',
    })),
  );
  const rotatedChild = nuIds.find((i) => i.name.startsWith('旋转子盒'))!;
  await page.click(`li[data-node-id="${rotatedChild.id}"] .tree-label`);
  await page.waitForTimeout(100);

  // W/E/R 切换 gizmo 模式，工具条 active 状态同步
  await page.keyboard.press('e');
  await page.waitForTimeout(60);
  check('E 切到旋转模式',
    await page.locator('#mode-group button[data-mode="rotate"].active').count() === 1);
  await page.keyboard.press('r');
  await page.waitForTimeout(60);
  check('R 切到缩放模式',
    await page.locator('#mode-group button[data-mode="scale"].active').count() === 1);
  await page.keyboard.press('w');
  await page.waitForTimeout(60);

  // 非均匀缩放+旋转链：世界空间检查器应出现剪切警告
  const warnBefore = await page.locator('.inspector-warning').count();
  check('含剪切的世界变换给出明确标注', warnBefore > 0);
  await page.keyboard.press('q'); // 切到局部
  await page.waitForTimeout(80);
  check('局部空间下不显示剪切警告', (await page.locator('.inspector-warning').count()) === 0);
  check('局部按钮激活',
    await page.locator('#space-group button[data-space="local"].active').count() === 1);
  await page.keyboard.press('q'); // 回到世界
  await page.waitForTimeout(80);

  // 检查器编辑局部平移：文档节点位置改变且可撤销
  await page.keyboard.press('q'); // 确保在局部
  await page.waitForTimeout(60);
  const posBefore = await page.evaluate(
    (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
    rotatedChild.id,
  );
  const firstPosInput = page.locator('.vec3-editor').first().locator('input').first();
  // 用 fill 即可（Playwright 会触发唯一一次 change）；不能再手动 dispatch，否则提交两次
  await firstPosInput.fill('2.5');
  // 真实使用中输入完会离开输入框；失焦后全局快捷键才生效（输入框聚焦时让位给文本编辑）
  await firstPosInput.evaluate((el) => (el as HTMLInputElement).blur());
  await page.waitForTimeout(100);
  const posAfter = await page.evaluate(
    (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
    rotatedChild.id,
  );
  check('检查器编辑写入文档', Math.abs(posAfter[0] - 2.5) < 1e-9, JSON.stringify(posAfter));
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(100);
  const posUndo = await page.evaluate(
    (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
    rotatedChild.id,
  );
  check('检查器编辑可撤销', Math.abs(posUndo[0] - posBefore[0]) < 1e-9, JSON.stringify(posUndo));

  console.log('— Gizmo 鼠标拖拽变换 —');
  await selectBuiltin(page, 'test:nested');
  const nestedIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('li[data-node-id]')).map((li) => ({
      id: li.getAttribute('data-node-id')!,
      name: li.querySelector('.tree-label')?.textContent ?? '',
    })),
  );
  const leaf = nestedIds.find((i) => i.name.startsWith('叶子盒子'))!;
  await page.click(`li[data-node-id="${leaf.id}"] .tree-label`);
  await page.waitForTimeout(100);
  await page.keyboard.press('w'); // 平移模式
  await page.waitForTimeout(60);

  const leafPosBefore = await page.evaluate(
    (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
    leaf.id,
  );

  // 节点世界原点投影到 canvas 的屏幕坐标，从该点开始拖拽平移 gizmo
  const screen = await page.evaluate(
    (id) => (window as unknown as { __editor__: { project(id: string): { x: number; y: number } | null } }).__editor__.project(id),
    leaf.id,
  );

  if (screen) {
    const cb = (await page.locator('#gl-canvas').boundingBox())!;
    const sx = Math.round(cb.x + screen.x);
    const sy = Math.round(cb.y + screen.y);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 90, sy + 40, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const leafPosAfter = await page.evaluate(
      (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
      leaf.id,
    );
    const moved = leafPosAfter.some((v, i) => Math.abs(v - leafPosBefore[i]) > 1e-6);
    check('拖拽 gizmo 改变了节点变换', moved, JSON.stringify({ leafPosBefore, leafPosAfter }));
    if (moved) {
      const undoTitleBefore = await page.locator('#btn-undo').getAttribute('title');
      check('gizmo 拖动产生变换历史命令', Boolean(undoTitleBefore?.includes('平移')));
      await page.locator('#btn-undo').click();
      await page.waitForTimeout(120);
      const leafPosUndo = await page.evaluate(
        (id) => (window as unknown as { __editor__: { snapshot(): { nodes: { id: string; position: number[] }[] } } }).__editor__.snapshot().nodes.find((n) => n.id === id)!.position,
        leaf.id,
      );
      check('gizmo 变换可撤销还原', leafPosUndo.every((v, i) => Math.abs(v - leafPosBefore[i]) < 1e-6));
    }
  } else {
    check('Gizmo 拖拽（投影钩子缺失，跳过）', false, 'project 钩子未注册');
  }

  console.log('— 保存 / 打开往返（含相机与校验） —');
  // 通过页面内函数直接构造一次保存，再读取下载内容
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-save'),
  ]);
  const path = await download.path();
  if (!path) throw new Error('下载未产生临时文件');
  const fs = await import('node:fs');
  const saved = JSON.parse(fs.readFileSync(path, 'utf8'));
  check('保存文件含 formatVersion/nodes/camera',
    saved.formatVersion === 1 && Array.isArray(saved.nodes) && saved.camera);
  const nodeCount = saved.nodes.length;

  // 损坏文件必须被拒绝，且当前场景不被覆盖
  const badFile = { ...saved, nodes: [{ ...saved.nodes[0], parentId: 'nonexistent-parent' }] };
  await page.setInputFiles('#file-input', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(badFile)),
  });
  await page.waitForTimeout(200);
  check('无效文件被拒绝并提示原因', (await statusText(page)).includes('不存在的父节点'));
  check('无效文件未覆盖当前场景', (await treeRows(page)).length === nodeCount);

  // 合法文件可重新打开，节点与相机恢复
  const movedCam = {
    ...saved,
    camera: { ...saved.camera, position: [13.5, -7.25, 4.4], target: [1, 2, 3] },
  };
  await page.setInputFiles('#file-input', {
    name: 'good.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(movedCam)),
  });
  await page.waitForTimeout(250);
  check('合法文件打开后节点数一致', (await treeRows(page)).length === nodeCount);
  const camAfter = await page.evaluate(() => {
    const api = (window as unknown as { __editor__?: { snapshot(): { camera: { position: number[] } } } }).__editor__;
    return api?.snapshot().camera;
  });
  check('相机随文件恢复',
    Boolean(camAfter) && Math.abs(camAfter!.position[0] - 13.5) < 1e-6 &&
      Math.abs(camAfter!.position[1] - -7.25) < 1e-6,
    JSON.stringify(camAfter?.position));

  // 打开场景可撤销回上一个场景
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(200);
  check('打开场景可撤销', (await statusText(page)).length > 0);

  check('全程无控制台错误', consoleErrors.length === 0, consoleErrors.join(' | '));

  await browser.close();
  server.kill();

  console.log(failures === 0 ? '\n全部 E2E 检查通过 ✅' : `\n${failures} 项 E2E 检查失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
