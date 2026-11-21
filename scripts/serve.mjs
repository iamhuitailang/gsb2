#!/usr/bin/env node
/**
 * 零依赖静态服务器，用来在浏览器打开工具。
 * 用法：npm start  然后访问 http://localhost:4173
 *
 * 只服务本仓库目录；禁止路径穿越；对未知扩展名返回 404。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tga": "image/x-tga",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, status, message, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(message);
}

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const target = normalize(join(ROOT, pathname));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      send(res, 403, "禁止访问仓库目录之外的文件");
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      send(res, 404, `找不到 ${pathname}`);
      return;
    }
    const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    send(res, 400, `请求无效：${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`材质贴图通道打包工具已启动：http://${HOST}:${PORT}`);
  console.log(`仓库目录：${ROOT}`);
  console.log("按 Ctrl+C 停止。");
});
