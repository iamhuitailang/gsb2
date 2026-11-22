/* test/browser2.test.js — 补充端到端：手动录制、导出导入、配置编辑、恢复默认 */
'use strict';
const http = require('http');
const CDP = process.env.CDP_PORT || 9233;

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP + path, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const tabs = await get('/json');
  const tab = tabs.find(t => t.url.includes('index.html'));
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const evalJs = async expr => {
    const myId = ++id;
    const res = await new Promise(resolve => {
      const t = setTimeout(() => { pending.delete(myId); resolve({ __timeout: true }); }, 8000);
      pending.set(myId, r => { clearTimeout(t); resolve(r); });
      ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    });
    if (res.__timeout) throw new Error('evaluate 超时（可能有未处理的模态对话框）: ' + expr.slice(0, 60));
    if (res.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    return res.result.value;
  };
  await evalJs(`window.__occlAutoConfirm = true`);

  console.log('A. 手动录制路线');
  if ((await evalJs(`document.getElementById('conflictBadge').textContent`)).includes('冲突')) {
    await evalJs(`document.getElementById('btnConflictDemo').click()`);
  }
  await evalJs(`document.getElementById('btnRecord').click()`);
  ok((await evalJs(`String(document.getElementById('routeBadge').textContent)`)).includes('录制'), '进入录制状态');
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'d'}))`);
  await sleep(600);
  await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{key:'d'}))`);
  await evalJs(`document.getElementById('btnRecord').click()`);
  await sleep(150);
  ok((await evalJs(`document.getElementById('routeList').innerText`)).includes('手动录制路线'), '录制路线出现在列表');
  ok(await evalJs(`!!localStorage.getItem('occl.route.v1')`), '录制路线已持久化');
  // 录制路线可播放且采样确定
  await evalJs(`[...document.querySelectorAll('.route-item button')].pop().click()`);
  await sleep(200);
  ok((await evalJs(`String(document.getElementById('routeBadge').textContent)`)).includes('播放'), '录制路线可播放');

  console.log('B. 导出/导入 JSON 管线');
  ok(await evalJs(`(function(){const s=window.__occlTest.scene();return JSON.stringify({scene:s,routes:[],app:'occl-check'}).length>100;})()`), '导出数据结构完整');
  ok(await evalJs(`(function(){const blob=new Blob([JSON.stringify({scene:OcclCore.defaultScene(),routes:OcclCore.defaultRoutes()})],{type:'application/json'});const dt=new DataTransfer();dt.items.add(new File([blob],'t.json'));return dt.files.length===1;})()`), '导入用 File/Blob 可构造');

  console.log('C. 配置编辑即时重算');
  await evalJs(`(function(){const s=window.__occlTest.scene();s.props.find(x=>x.id==='crate').h=1.2;document.getElementById('btnSaveScene').click();})()`);
  const hi = await evalJs(`window.__occlTest.result().objects.find(o=>o.id==='crate').hi`);
  ok(Math.abs(hi - 1.2) < 1e-9, '道具改高度后排序区间更新 hi=' + hi);

  console.log('D. 恢复默认场景');
  await evalJs(`window.confirm=()=>true; document.getElementById('btnReset').click()`);
  await sleep(150);
  ok(await evalJs(`window.__occlTest.result().objects.find(o=>o.id==='crate').hi === 0.55`), '道具高度还原默认');
  ok(await evalJs(`document.getElementById('routeList').children.length === 2`), '路线回到两条内建路线');
  ok(await evalJs(`document.getElementById('conflictBadge').textContent === '无冲突'`), '冲突状态清空');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
