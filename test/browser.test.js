/* test/browser.test.js — 通过 CDP 驱动无头 Chrome，验证三种视图、冲突、路线播放与命中检测
 * 用法：
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless --disable-gpu --remote-debugging-port=9222 \
 *     --user-data-dir=/tmp/occl-cdp "http://127.0.0.1:8901/index.html" &
 *   node test/browser.test.js
 */
'use strict';
const http = require('http');

const CDP = process.env.CDP_PORT || 9233;
function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + CDP + path, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.error('  ✗ ' + m)); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const tabs = await get('/json');
  const tab = tabs.find(t => t.url.includes('index.html'));
  if (!tab) throw new Error('未找到打开 index.html 的标签页');
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
    const res = await new Promise(resolve => { pending.set(myId, resolve); ws.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } })); });
    if (res.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    return res.result.value;
  };
  await evalJs(`window.__occlAutoConfirm = true`);
  const nonBlank = async () => evalJs(`(function(){const d=document.getElementById('cv').getContext('2d').getImageData(0,0,960,640).data;let n=0;for(let i=3;i<d.length;i+=400)if(d[i]!==0)n++;return n;})()`);

  console.log('1. 页面加载与初始渲染');
  ok(await evalJs(`document.querySelectorAll('canvas').length === 1`), '画布存在');
  ok((await nonBlank()) > 50, '画布有实际绘制内容');
  ok(await evalJs(`document.getElementById('conflictBadge').textContent === '无冲突'`), '默认场景无冲突');
  ok(await evalJs(`document.getElementById('routeList').children.length === 2`), '自带两条路线');

  console.log('2. 三种视图切换');
  for (const v of ['footprint', 'order', 'normal']) {
    await evalJs(`document.querySelector('button[data-view="${v}"]').click()`);
    await sleep(150);
    ok((await nonBlank()) > 50, v + ' 视图正常绘制');
  }

  console.log('3. 冲突演示与稳定回退');
  await evalJs(`document.getElementById('btnConflictDemo').click()`);
  await sleep(100);
  ok((await evalJs(`document.getElementById('conflictBadge').textContent`)).includes('冲突'), '冲突演示后徽章显示冲突数');
  const cfText = await evalJs(`document.getElementById('conflictList').innerText`);
  ok(cfText.includes('穿插'), '冲突说明含高度穿插描述');
  await evalJs(`document.getElementById('btnConflictDemo').click()`);
  await evalJs(`document.getElementById('btnConflictDemo').click()`);
  ok((await evalJs(`document.getElementById('conflictList').innerText`)) === cfText, '同配置重复生成，冲突说明一致（确定性）');
  await evalJs(`document.getElementById('btnConflictDemo').click()`); // 还原

  console.log('4. 路线：桥下 vs 桥上');
  await evalJs(`document.getElementById('btnGotoUnder').click()`);
  await sleep(150);
  const underInfo = await evalJs(`document.getElementById('posInfo').textContent`);
  ok(underInfo.includes('地面') && underInfo.includes('(5,'), '桥下定位到桥格且层面为地面：' + underInfo);
  await evalJs(`document.getElementById('btnGotoOver').click()`);
  await sleep(150);
  const overInfo = await evalJs(`document.getElementById('posInfo').textContent`);
  ok(overInfo.includes('桥上'), '桥上定位层面为桥面：' + overInfo);
  // 同格两种层面的前后关系必须相反
  const relation = await evalJs(`(function(){
    const scene=window.__occlTest.scene();
    const under=OcclCore.computeOrder(scene, OcclCore.buildRenderables(scene,{pos:{x:5,y:3},z:0,floor:'ground'}));
    const over=OcclCore.computeOrder(scene, OcclCore.buildRenderables(scene,{pos:{x:5,y:3},z:scene.terrain.deckTop,floor:'top'}));
    return JSON.stringify({u:under.order.indexOf('hero')-under.order.indexOf('bridge'),o:over.order.indexOf('hero')-over.order.indexOf('bridge')});
  })()`);
  const rel = JSON.parse(relation);
  ok(rel.u < 0 && rel.o > 0, '同格：桥下桥盖人（u=' + rel.u + '），桥上人盖桥（o=' + rel.o + '）');

  console.log('5. 重放一致性核对');
  const replay = await evalJs(`(function(){document.getElementById('btnReplayCheck').click();return document.getElementById('replayResult').innerText;})()`);
  ok(replay.includes('一致'), '重放指纹核对通过：' + replay);

  console.log('6. 命中检测与物体核对');
  const pt = JSON.parse(await evalJs(`(function(){const g=window.__occlTest.scene().grid;return JSON.stringify(OcclCore.iso(5.5,3.5,1.35,g));})()`));
  const hit = await evalJs(`OcclRender.hitTest(window.__occlTest.scene(), window.__occlTest.result(), {x:${pt.x},y:${pt.y}})`);
  ok(hit === 'hero' || hit === 'bridge', '桥上格点击命中角色或桥（实际：' + hit + '）');
  await evalJs(`(function(){const cv=document.getElementById('cv');const b=cv.getBoundingClientRect();cv.dispatchEvent(new MouseEvent('click',{clientX:b.left+${pt.x},clientY:b.top+${pt.y}}));})()`);
  await sleep(100);
  const inspect = await evalJs(`document.getElementById('inspectBody').innerText`);
  ok(inspect.includes('绘制序号') && inspect.includes('盖住'), '核对面板给出序号与遮挡依据');

  console.log('7. 截图保存');
  const before = await evalJs(`window.__occlTest.shots().length`);
  await evalJs(`document.getElementById('btnShot').click()`);
  const after = await evalJs(`window.__occlTest.shots().length`);
  ok(after === before + 1, '关键位置截图已保存（' + before + ' → ' + after + '）');
  ok(await evalJs(`document.querySelector('#shotList img').src.startsWith('data:image/png')`), '截图为 PNG dataURL');

  console.log('8. 暂停与逐步检查');
  await evalJs(`document.querySelector('.route-item button').click()`);
  await sleep(100);
  await evalJs(`document.getElementById('btnPause').click()`);
  ok((await evalJs(`document.getElementById('routeBadge').textContent`)).includes('暂停'), '暂停生效');
  const i1 = await evalJs(`window.__occlTest.playback().i`);
  await evalJs(`document.getElementById('btnStep').click()`);
  const i2 = await evalJs(`window.__occlTest.playback().i`);
  ok(i2 === i1 + 1, '逐步前进一帧（' + i1 + ' → ' + i2 + '）');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  ws.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
