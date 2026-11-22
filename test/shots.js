/* test/shots.js — CDP 抓取桥下/桥上/冲突三种关键状态截图 */
'use strict';
const http = require('http');
const fs = require('fs');

http.get('http://127.0.0.1:' + (process.env.CDP_PORT || 9233) + '/json', r => {
  let d = '';
  r.on('data', c => d += c);
  r.on('end', async () => {
    const tab = JSON.parse(d).find(t => t.url.includes('index.html'));
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise(res => ws.addEventListener('open', res));
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    });
    const ev = async ex => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, returnByValue: true } })); });
    const shot = async name => {
      const i = ++id;
      const r = await new Promise(res => { pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
      fs.writeFileSync('/tmp/occl-shots/' + name + '.png', Buffer.from(r.data, 'base64'));
    };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    await ev(`document.querySelector('button[data-view="normal"]').click()`);
    await ev(`document.getElementById('btnGotoUnder').click()`);
    await sleep(300);
    await shot('key-under-bridge');

    await ev(`document.getElementById('btnGotoOver').click()`);
    await sleep(300);
    await shot('key-on-bridge');

    await ev(`document.getElementById('btnConflictDemo').click()`);
    await sleep(200);
    await shot('key-conflict');

    console.log('shots saved');
    ws.close();
  });
});
