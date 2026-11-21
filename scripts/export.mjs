#!/usr/bin/env node
/**
 * 无头导出 CLI：读取工程 + 素材目录，输出 PNG、来源说明与 manifest。
 *
 * 用法：
 *   node scripts/export.mjs --project samples/demo-project.json \
 *        --assets samples/materials --out out
 *
 * 素材查找顺序：
 *   1. 工程中记录的相对 url（相对工程文件所在目录）
 *   2. 素材目录中按文件名递归查找
 *   3. 工程中记录的 fileName
 * 找不到或解码失败时，会按「常量补齐」规则继续，并在结果中记录原因。
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { deserializeProject } from "../src/lib/project.js";
import { buildExportPlan, runExportPlan } from "../src/lib/batch.js";
import { buildManifest } from "../src/lib/report.js";
import { renderOutputItem } from "../src/lib/render.js";
import { decodePng } from "../src/lib/pngDecode.js";
import { decodeTga, isTga } from "../src/lib/tga.js";
import { SUPPORTED_FORMATS } from "../src/lib/formats.js";

function parseArgs(argv) {
  const args = { project: null, assets: null, out: "export", format: "png" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`参数 ${arg} 缺少值`);
      return v;
    };
    switch (arg) {
      case "--project":
      case "-p":
        args.project = next();
        break;
      case "--assets":
      case "-a":
        args.assets = next();
        break;
      case "--out":
      case "-o":
        args.out = next();
        break;
      case "--format":
      case "-f":
        args.format = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return args;
}

function usage() {
  console.log(`材质贴图通道打包 - 无头导出

用法:
  node scripts/export.mjs --project <工程.json> [--assets <素材目录>] [--out <输出目录>]

参数:
  --project, -p   工程 JSON 文件（必填）
  --assets,  -a   素材根目录（默认取工程文件目录）
  --out,     -o   输出目录（默认 ./export）
  --format,  -f   输出格式（当前支持 png）

支持读取的源图格式: ${SUPPORTED_FORMATS.join(", ")}
`);
}

function listFiles(root, max = 20000) {
  const found = [];
  const walk = (dir) => {
    if (found.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
      if (found.length >= max) return;
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

async function loadImage(filePath) {
  const bytes = new Uint8Array(readFileSync(filePath));
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "tga" || isTga(bytes, filePath)) {
    return decodeTga(bytes);
  }
  if (ext === "png") {
    return decodePng(bytes, (data) => inflateSync(data));
  }
  throw new Error(`不支持直接解码 .${ext}，请改用 PNG 或 TGA（或用浏览器界面读取）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!args.project) {
    usage();
    process.exitCode = 2;
    return;
  }

  const projectPath = resolve(args.project);
  if (!existsSync(projectPath)) throw new Error(`工程文件不存在：${projectPath}`);
  const projectDir = dirname(projectPath);
  const assetsDir = resolve(args.assets || projectDir);
  const outDir = resolve(args.out);

  const project = deserializeProject(readFileSync(projectPath, "utf8"));
  const files = listFiles(assetsDir);
  const byName = new Map();
  for (const f of files) {
    const base = f.split(sep).pop();
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(f);
  }

  const imageCache = new Map();
  async function loadRoleImage(material, role) {
    const saved = material.images?.[role];
    if (!saved) return null;
    const key = `${material.id}:${role}`;
    if (imageCache.has(key)) return imageCache.get(key);
    const candidates = [];
    if (saved.url) {
      const p = resolve(projectDir, saved.url);
      if (existsSync(p)) candidates.push(p);
    }
    if (saved.fileName) {
      const direct = resolve(assetsDir, saved.fileName);
      if (existsSync(direct)) candidates.push(direct);
      for (const f of byName.get(saved.fileName) || []) candidates.push(f);
    }
    const unique = [...new Set(candidates.filter((p) => statSync(p).isFile()))];
    if (unique.length === 0) {
      imageCache.set(key, null);
      return null;
    }
    const file = unique[0];
    try {
      const img = await loadImage(file);
      const result = { ...img, fileName: saved.fileName || file.split(sep).pop(), path: relative(assetsDir, file) };
      imageCache.set(key, result);
      return result;
    } catch (err) {
      const result = { error: err.message, fileName: saved.fileName || file.split(sep).pop(), width: 0, height: 0 };
      imageCache.set(key, result);
      return result;
    }
  }

  const plan = buildExportPlan(project, { format: args.format });

  const results = await runExportPlan(
    plan,
    async (item) => {
      const material = project.materials.find((m) => m.id === item.materialId);
      const images = new Map();
      const roles = new Set();
      for (const ch of Object.values(item.channels)) {
        if (ch.source?.kind === "role") roles.add(ch.source.role);
      }
      for (const role of roles) {
        const img = await loadRoleImage(material, role);
        // 找不到文件时不要塞 error 对象：按需求用常量补齐；
        // 只有文件存在但解码失败才让该项失败（renderOutputItem 会检查 error）。
        if (img) images.set(role, img);
      }
      const rendered = await renderOutputItem({
        material,
        output: { ...item, name: item.outputName },
        size: { width: item.width, height: item.height, fitMode: item.fitMode },
        images,
        deflate: (bytes) => deflateSync(bytes, { level: 9 }),
        failOnDecodeError: true,
      });
      return rendered;
    },
    {
      onProgress: ({ done, total }) => {
        process.stderr.write(`\r处理中 ${done}/${total}`);
      },
    },
  );
  process.stderr.write("\n");

  const written = [];
  for (const item of results.succeeded) {
    const target = join(outDir, item.zipPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.png || Buffer.alloc(0));
    written.push(target);
  }
  mkdirSync(outDir, { recursive: true });
  const manifest = buildManifest({
    project,
    plan,
    succeeded: results.succeeded,
    failed: results.failed,
  });
  writeFileSync(join(outDir, "manifest.txt"), manifest);
  for (const item of results.succeeded) {
    if (item.reportText) {
      const target = join(outDir, item.reportPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, item.reportText);
    }
  }

  console.log(`成功 ${results.succeeded.length} 项，失败 ${results.failed.length} 项，跳过 ${plan.skipped.length} 项`);
  console.log(`输出目录：${outDir}`);
  for (const item of results.succeeded) console.log(`  ✓ ${item.zipPath}`);
  for (const item of [...results.failed, ...plan.skipped]) {
    console.log(`  ✗ ${item.materialName} / ${item.outputName}: ${item.error || item.reason}`);
  }
  if (results.failed.length > 0 || plan.skipped.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`导出失败：${err.message}`);
  process.exitCode = 1;
});
