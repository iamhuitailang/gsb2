/* CDP 冒烟测试：驱动真实浏览器点击运行/暂停/单步/重置，验证编辑器与引擎联动 */
'use strict';

const http = require('http');

function getJSON(path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://localhost:9223' + path, { method: method || 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

// 极简 WebSocket 帧实现（RFC6455 客户端，仅用于 CDP 文本帧）
const crypto = require('crypto');
const net = require('net');

function createWS(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(u.port, u.hostname, () => {
      socket.write(
        `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    let handshake = '';
    let handshaken = false;
    const handlers = { message: [], close: [] };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (!handshaken) {
        handshake += chunk.toString('binary');
        const idx = handshake.indexOf('\r\n\r\n');
        if (idx < 0) return;
        handshaken = true;
        buf = Buffer.from(handshake.slice(idx + 4), 'binary');
        resolve({ send, on: (ev, fn) => handlers[ev].push(fn), close: () => socket.destroy() });
        pump();
      } else {
        buf = Buffer.concat([buf, chunk]);
        pump();
      }
    });
    socket.on('error', reject);

    function send(obj) {
      const payload = Buffer.from(JSON.stringify(obj));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.from([0x81, 0x80 | len]);
      } else if (len < 65536) {
        header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 255, len & 255]);
      } else {
        header = Buffer.from([0x81, 0x80 | 127, 0, 0, 0, 0, (len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
      }
      const mask = crypto.randomBytes(4);
      const masked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    }

    function pump() {
      while (buf.length >= 2) {
        const b0 = buf[0], b1 = buf[1];
        const opcode = b0 & 0x0f;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (buf.length < offset + len) return;
        const payload = buf.slice(offset, offset + len).toString();
        buf = buf.slice(offset + len);
        if (opcode === 1) handlers.message.forEach((fn) => fn(JSON.parse(payload)));
        if (opcode === 8) handlers.close.forEach((fn) => fn());
      }
    }
  });
}

(async () => {
  const targets = await getJSON('/json/new?http://localhost:8765/index.html', 'PUT');
  const target = Array.isArray(targets) ? targets[0] : targets;
  const ws = await createWS(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (msg) => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send({ id: mid, method, params: params || {} });
    });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.value));
    return r.result.value;
  };
  const click = async (sel) => evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);

  let failures = 0;
  const check = (name, cond, extra) => {
    if (cond) { console.log('  ✓ ' + name); }
    else { failures++; console.error('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')); }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1500);

  console.log('\n初始化');
  check('三个示例树标签渲染', await evalJs(`document.querySelectorAll('.tree-tab').length`) === 3);
  check('SVG 中渲染出巡逻树节点', await evalJs(`document.querySelectorAll('.node-card').length`) >= 5);
  check('连线渲染', await evalJs(`document.querySelectorAll('.edge').length`) >= 4);
  check('黑板初始字段 playerVisible=false', await evalJs(`document.querySelector('.bb-value-input[data-key="playerVisible"]').value`) === 'false');
  check('结构检查通过', (await evalJs(`document.querySelector('#propertyPanel').textContent`)).includes('结构合法'));

  console.log('\n运行 / 暂停 / 单步');
  await click('#btnRun');
  await sleep(1400);
  const stateDuringRun = await evalJs(`document.querySelector('#simState').textContent`);
  check('运行中状态显示 tick', stateDuringRun.includes('运行中'), stateDuringRun);
  const runningCount = await evalJs(`document.querySelectorAll('.node-card.st-running').length`);
  check('存在 running 着色的节点', runningCount >= 1, runningCount);
  const logLines = await evalJs(`document.querySelectorAll('.log-line').length`);
  check('运行日志有输出', logLines >= 2, logLines);

  await click('#btnPause');
  await sleep(200);
  check('暂停状态显示', (await evalJs(`document.querySelector('#simState').textContent`)).includes('暂停'));
  check('暂停时黑板输入框可编辑', await evalJs(`!document.querySelector('.bb-value-input').disabled`));

  // 暂停时修改黑板，再单步，验证从当前节点继续
  await evalJs(`
    (function(){
      const inp = document.querySelector('.bb-value-input[data-key="playerVisible"]');
      inp.value = 'true';
      inp.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
  check('黑板改值生效', await evalJs(`document.querySelector('.bb-value-input[data-key="playerVisible"]').value`) === 'true');
  const ticksBefore = await evalJs(`document.querySelector('#simState').textContent`);
  await click('#btnStep');
  await sleep(100);
  const ticksAfter = await evalJs(`document.querySelector('#simState').textContent`);
  check('单步后 tick 数增加', ticksAfter !== ticksBefore, { ticksBefore, ticksAfter });

  console.log('\n切换行为树');
  await evalJs(`[...document.querySelectorAll('.tree-tab')].find(t=>t.textContent.includes('发现目标')).click()`);
  await sleep(300);
  check('切到发现目标树', (await evalJs(`document.querySelector('.tree-tab.active').textContent`)).includes('发现目标'));
  check('发现目标树节点渲染', await evalJs(`document.querySelectorAll('.node-card').length`) === 9);
  check('切换后处于停止状态', (await evalJs(`document.querySelector('#simState').textContent`)).includes('停止'));

  console.log('\n重置整树');
  await click('#btnRun');
  await sleep(700);
  await click('#btnReset');
  await sleep(200);
  check('重置后状态停止', (await evalJs(`document.querySelector('#simState').textContent`)).includes('停止'));
  check('重置后黑板恢复初始值', await evalJs(`document.querySelector('.bb-value-input[data-key="playerVisible"]').value`) === 'false');
  check('重置后节点状态灯回到 idle', await evalJs(`document.querySelectorAll('.node-card.st-running, .node-card.st-success, .node-card.st-failure').length`) === 0);

  console.log('\n非法连线原因');
  // 编辑器拖拽连线与这里调用的是同一个 validateConnection，覆盖各非法场景的原因文案
  const reasonChecks = await evalJs(`
    (function(){
      const tree = BTEngineNS;
      // 用当前工程的发现目标树构造校验
      const proj = JSON.parse(localStorage.getItem('bt-debug-tool.project.v1'));
      const t = proj.trees.find(x => x.name.includes('发现目标'));
      const leaf = t.nodes.find(n => n.type === 'action');
      const other = t.nodes.find(n => n.id !== leaf.id);
      const selfConn = tree.validateConnection(t, leaf.id, leaf.id);
      const leafAsParent = tree.validateConnection(t, leaf.id, other.id);
      const okConn = tree.validateConnection(t, other.id, leaf.id);
      return {
        selfBlocked: selfConn.ok === false && selfConn.reason.includes('自身'),
        leafBlocked: leafAsParent.ok === false && leafAsParent.reason.includes('叶子'),
        reasonText: leafAsParent.reason,
        ok: okConn.ok === true || okConn.reason.includes('父节点') // 已挂父时也应给出明确原因
      };
    })()`);
  check('自连被拒绝且有原因', reasonChecks.selfBlocked, reasonChecks);
  check('叶子节点挂子被拒绝且说明原因', reasonChecks.leafBlocked, reasonChecks);
  check('非法原因是可读中文文案', reasonChecks.reasonText.length > 5, reasonChecks.reasonText);

  console.log('\n导出/导入往返');
  const roundTrip = await evalJs(`
    (function(){
      const before = JSON.parse(localStorage.getItem('bt-debug-tool.project.v1'));
      // 模拟「导出为文件 → 重新导入」的完整解析链路
      const restored = BTProject.parseImport(JSON.stringify(before));
      const condRefs = [];
      for (const t of restored.trees) for (const n of t.nodes) {
        if (n.type === 'condition') condRefs.push(n.params.key);
      }
      return {
        treeCount: restored.trees.length,
        nodeCounts: restored.trees.map(t => t.nodes.length),
        edgeCounts: restored.trees.map(t => t.edges.length),
        condRefs,
        scenePp: restored.scene.patrolPoints.length,
        bbKeys: Object.keys(restored.blackboard).sort(),
        allValid: restored.trees.every(t => BTEngineNS.validateTree(t).valid)
      };
    })()`);
  check('导入后 3 棵树完整恢复', roundTrip.treeCount === 3, roundTrip);
  check('节点与连线数量保持', roundTrip.nodeCounts.join(',') === '5,9,10' && roundTrip.edgeCounts.join(',') === '4,8,9', roundTrip);
  check('条件节点黑板字段引用恢复', roundTrip.condRefs.includes('playerVisible'), roundTrip.condRefs);
  check('场景与黑板恢复', roundTrip.scenePp === 4 && roundTrip.bbKeys.includes('state'), roundTrip);
  check('导入后所有树仍可运行', roundTrip.allValid, roundTrip);

  console.log('\n持久化');
  const stored = await evalJs(`JSON.parse(localStorage.getItem('bt-debug-tool.project.v1'))`);
  check('localStorage 已自动保存', stored && stored.trees.length === 3);
  check('保存的场景含巡逻点', stored.scene.patrolPoints.length === 4);

  console.log('\n场景标记');
  check('场景面板列出标记', (await evalJs(`document.querySelectorAll('#scenePanel .scene-row').length`)) >= 7);

  ws.close();
  await sleep(100);
  console.log('\n========================================');
  console.log(failures ? `浏览器冒烟测试：${failures} 项失败 ✗` : '浏览器冒烟测试：全部通过 ✓');
  console.log('========================================');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
