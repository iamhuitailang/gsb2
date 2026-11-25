// 可选：用无头 Chrome 预生成示例素材并保存到 public/samples/
// 用法：npm run generate:samples
// 注意：示例素材也可以在网页内一键生成，本脚本只是给 CI/演示用的离线备份。
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "samples");
const PORT = 8123;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json",
};

const server = createServer(async (req, res) => {
  const p = normalize(join(ROOT, decodeURIComponent(req.url.split("?")[0])));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(p === ROOT ? join(ROOT, "index.html") : p);
    res.writeHead(200, { "Content-Type": MIME[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(PORT, r));
await mkdir(OUT, { recursive: true });

// 用 CDP 驱动页面执行生成函数并把 Blob 拉回 Node
const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const chrome = chromeCandidates.find((p) => existsSync(p));
if (!chrome) {
  console.error("未找到 Chrome/Chromium，请在网页内使用「载入/重建示例素材」按钮生成。");
  process.exit(1);
}

const proc = spawn(chrome, [
  "--headless=new", "--disable-gpu", "--no-first-run",
  "--remote-debugging-port=9222", `--user-data-dir=/tmp/gss-chrome-${Date.now()}`,
  `http://localhost:${PORT}/index.html`,
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i++) {
  await sleep(250);
  try {
    const list = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
    wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { proc.kill(); process.exit(1); }

// 极简 WS 客户端（Node 24 内置 WebSocket）
const ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await sleep(1500);

const expr = `
(async () => {
  const mod = await import('/src/sample-generator.js');
  const video = await mod.generateSampleVideo(() => {});
  const bgImage = await mod.generateBackgroundImage();
  const bgVideo = await mod.generateBackgroundVideo(() => {});
  const b64 = async (blob) => {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };
  return {
    video: { name: video.name, b64: await b64(video.blob), type: video.blob.type },
    bgImage: { name: bgImage.name, b64: await b64(bgImage.blob), type: bgImage.blob.type },
    bgVideo: { name: bgVideo.name, b64: await b64(bgVideo.blob), type: bgVideo.blob.type },
  };
})()
`;
const { result } = await send("Runtime.evaluate", {
  expression: expr, awaitPromise: true, returnByValue: true,
});
if (result.exceptionDetails) {
  console.error(result.exceptionDetails.text);
  proc.kill(); process.exit(1);
}
for (const item of Object.values(result.value)) {
  await writeFile(join(OUT, item.name), Buffer.from(item.b64, "base64"));
  console.log("已写出", join("public/samples", item.name));
}
ws.close();
proc.kill();
server.close();
console.log("完成。");
