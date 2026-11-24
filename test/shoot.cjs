/* 截图脚本：node test/shoot.cjs <场景配置> <输出路径>
   场景配置: crack(perBlock 8位热力图) | aligned(对齐8位块色) | wire(全局8位线框) */
const [,, config, outPath] = process.argv;
const SETUP = {
  crack: `document.getElementById('mode').value='perBlock';document.getElementById('mode').dispatchEvent(new Event('change'));
          document.getElementById('bits').value='8';document.getElementById('bits').dispatchEvent(new Event('change'));
          document.getElementById('viewMode').value='heat';document.getElementById('viewMode').dispatchEvent(new Event('change'));`,
  aligned: `document.getElementById('mode').value='aligned';document.getElementById('mode').dispatchEvent(new Event('change'));
            document.getElementById('bits').value='8';document.getElementById('bits').dispatchEvent(new Event('change'));`,
  wire: `document.getElementById('mode').value='global';document.getElementById('mode').dispatchEvent(new Event('change'));
         document.getElementById('bits').value='8';document.getElementById('bits').dispatchEvent(new Event('change'));
         document.getElementById('viewMode').value='wire';document.getElementById('viewMode').dispatchEvent(new Event('change'));`,
};
(async () => {
  const list = await (await fetch('http://localhost:9333/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); } };
  const send = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://localhost:8765/index.html' });
  await new Promise(r => setTimeout(r, 1300));
  await send('Runtime.evaluate', { expression: SETUP[config] });
  await new Promise(r => setTimeout(r, 700));
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 820, deviceScaleFactor: 1, mobile: false });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
  ws.close();
  console.log('saved', outPath);
})().catch(e => { console.error(e); process.exit(1); });
