import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5188/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1500, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__CD__ && window.__CD__.getState()');
await sleep(800);

// 1) 射线管线自检：横穿门洞右墙
const pipe = await page.evaluate(() => window.__CD__.debugRay([0, 1.5, 0], [0, 1.5, 5]));
console.log('射线管线测试 (0,1.5,0)->(0,1.5,5):', JSON.stringify(pipe));

// 2) 扫描并打印部分关键射线
const duration = await page.evaluate(() =>
  window.__CD__.getProject().route.waypoints.reduce((acc, w, i) => (i === 0 ? acc + w.hold : acc + w.moveTime + w.hold), 0),
);
for (let t = 0; t <= duration; t += 1.0) {
  await page.evaluate((tt) => window.__CD__.setTime(tt, true), t);
  await sleep(70);
  const row = await page.evaluate(() => {
    const s = window.__CD__.getState();
    return {
      t: +window.__CD__.getTime().toFixed(1),
      zone: s.zoneId,
      occ: s.occlusion.kind,
      from: s.occlusion.rayFrom?.map((v) => +v.toFixed(1)),
      to: s.occlusion.rayTo?.map((v) => +v.toFixed(1)),
    };
  });
  if (Math.round(t * 10) % 20 === 0 || row.occ !== 'clear') {
    console.log(`t=${String(row.t).padStart(5)} ${(row.zone ?? 'none').padEnd(14)} ${row.occ.padEnd(10)} ${JSON.stringify(row.from)} -> ${JSON.stringify(row.to)}`);
  }
}
await browser.close();
