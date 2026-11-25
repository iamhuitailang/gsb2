/**
 * 端到端测试：Node 无 DOM，用 tests/helpers/canvas-shim.js 提供最小 Canvas，
 * 跑通 image.js 合成 + PNG 编码 + batch.js 批量处理，再用 Python 解码校验。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { installDomShim } = require("./helpers/canvas-shim.js");

installDomShim();

const core = require("../public/js/core.js");
const imageApi = require("../public/js/image.js");
const batch = require("../public/js/batch.js");

// ------------------------------------------------------------------ //
// 8bit RGBA PNG 解码（样例全部 filter=0）
// ------------------------------------------------------------------ //

function decodePNG(file) {
  const data = fs.readFileSync(file);
  assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let pos = 8;
  let idat = Buffer.alloc(0);
  let w = 0;
  let h = 0;
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const tag = data.subarray(pos + 4, pos + 8).toString("ascii");
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (tag === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      assert.equal(body[8], 8);
      assert.equal(body[9], 6);
    } else if (tag === "IDAT") {
      idat = Buffer.concat([idat, body]);
    }
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  const stride = w * 4 + 1;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * stride], 0, "测试解码器只支持 filter 0");
    pixels.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * w * 4);
  }
  return { width: w, height: h, data: pixels };
}

function loadSampleImage(name) {
  const file = path.join(__dirname, "..", "public", "samples", name);
  const img = decodePNG(file);
  return {
    id: core.uid("img"),
    name: name.split("/").pop(),
    width: img.width,
    height: img.height,
    dataUrl: "file://" + file,
    image: { naturalWidth: img.width, naturalHeight: img.height, width: img.width, height: img.height, imageData: img },
  };
}

function makeProject() {
  const project = core.defaultProject();
  project.settings.outputWidth = 256;
  project.settings.outputHeight = 256;
  const brickFiles = {
    albedo: loadSampleImage("brick_albedo.png"),
    normal: loadSampleImage("brick_normal.png"),
    roughness: loadSampleImage("brick_roughness.png"),
    ao: loadSampleImage("brick_ao.png"),
    metallic: loadSampleImage("brick_metallic.png"),
  };
  const woodFiles = {
    albedo: loadSampleImage("wood_albedo.png"),
    normal: loadSampleImage("wood_normal.png"),
    roughness: loadSampleImage("wood_roughness.png"),
    ao: loadSampleImage("wood_ao.png"),
  };
  project.groups = [
    { name: "brick", files: brickFiles, unassigned: [], warnings: [] },
    { name: "wood", files: woodFiles, unassigned: [], warnings: [] },
    { name: "empty", files: {}, unassigned: [], warnings: [] },
  ];
  return { project, brickFiles, woodFiles };
}

test("E2E: ORM 合成 — AO→R、Roughness→G、常量 0→B、Alpha=255", () => {
  const { project, brickFiles } = makeProject();
  const orm = project.outputs[0];
  const { imageData, notes } = imageApi.composeOutput(project.groups[0], orm, project.settings);
  const ao = brickFiles.ao.image.imageData.data;
  const rough = brickFiles.roughness.image.imageData.data;
  for (let i = 0; i < 1000; i += 37) {
    assert.equal(imageData.data[i * 4], ao[i * 4]);           // R = AO 红通道
    assert.equal(imageData.data[i * 4 + 1], rough[i * 4]);    // G = 粗糙度红通道
    assert.equal(imageData.data[i * 4 + 2], 0);               // B 常量 0
    assert.equal(imageData.data[i * 4 + 3], 255);             // A 自动补满
  }
  assert.ok(notes.some((n) => n.usedFallback && n.channel === "b"));
});

test("E2E: 反转 + 强度生效", () => {
  const { project, brickFiles } = makeProject();
  const orm = project.outputs[0];
  const gSpec = orm.channels.find((c) => c.channel === "g");
  gSpec.invert = true;
  gSpec.strength = 1;
  const { imageData } = imageApi.composeOutput(project.groups[0], orm, project.settings);
  const rough = brickFiles.roughness.image.imageData.data;
  for (let i = 0; i < 500; i += 13) {
    assert.equal(imageData.data[i * 4 + 1], 255 - rough[i * 4]);
  }
});

test("E2E: 法线 OpenGL/DirectX 仅 G 通道翻转，R/B 不变", () => {
  const { project } = makeProject();
  const normalOut = project.outputs[1];
  project.settings.normalOrientation = "opengl";
  const gl = imageApi.composeOutput(project.groups[0], normalOut, project.settings).imageData;
  project.settings.normalOrientation = "directx";
  const dx = imageApi.composeOutput(project.groups[0], normalOut, project.settings).imageData;
  for (let i = 0; i < gl.data.length; i += 4) {
    assert.equal(gl.data[i], dx.data[i]);           // R 相同
    assert.equal(gl.data[i + 1], 255 - dx.data[i + 1]); // G 互补
    assert.equal(gl.data[i + 2], dx.data[i + 2]);   // B 相同
  }
});

test("E2E: 尺寸不一致 pad 留边 — 边缘是填充色，中心取自源图", () => {
  const { project } = makeProject();
  // 128x128 的源进 200x100 的宽目标：高向铺满 100、宽 100，左右各留 50px 边
  project.settings.outputWidth = 200;
  project.settings.outputHeight = 100;
  project.settings.resizePolicy = "pad";
  project.settings.padColor = { r: 12, g: 34, b: 56, a: 255 };
  const small = decodePNG(path.join(__dirname, "..", "public", "samples", "mismatch", "brick_albedo_small.png"));
  project.groups[0].files.albedo = {
    id: "small", name: "brick_albedo_small.png", width: 128, height: 128,
    image: { naturalWidth: 128, naturalHeight: 128, width: 128, height: 128, imageData: small },
  };
  const albedoOut = project.outputs[2];
  const { imageData, resizeInfos } = imageApi.composeOutput(project.groups[0], albedoOut, project.settings);
  const d = imageData.data;
  const idx = (x, y) => (y * 200 + x) * 4;
  // 左右留边区必须是填充色
  for (const [x, y] of [[2, 2], [25, 50], [175, 50], [197, 97]]) {
    const o = idx(x, y);
    assert.deepEqual([d[o], d[o + 1], d[o + 2]], [12, 34, 56], `留边区 (${x},${y})`);
  }
  // 中心（源绘制区内）必须来自源图
  assert.notEqual(d[idx(100, 50)], 12);
  assert.ok(resizeInfos.some((r) => r.mismatch && r.policy === "pad"));
});

test("E2E: crop 裁切策略下输出完全铺满、无填充边", () => {
  const { project } = makeProject();
  project.settings.outputWidth = 200;
  project.settings.outputHeight = 100;
  project.settings.resizePolicy = "crop";
  project.settings.padColor = { r: 99, g: 99, b: 99, a: 255 };
  const albedoOut = project.outputs[2];
  const { imageData, resizeInfos } = imageApi.composeOutput(project.groups[0], albedoOut, project.settings);
  const d = imageData.data;
  const corner = (d[2] << 16) | (d[3] << 8) | d[4];
  assert.notEqual(corner, (99 << 16) | (99 << 8) | 99);
  assert.ok(resizeInfos.some((r) => r.mismatch && r.policy === "crop"));
});

test("E2E: 批量处理 — 成功项保留、空组失败列原因、ZIP 内含 PNG 与来源说明", async () => {
  const { project } = makeProject();
  const result = await batch.runBatch(project);
  // 2 个有效组 × 3 输出 = 6 成功；空组 1 失败
  assert.equal(result.successes.length, 6);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].group, "empty");
  assert.match(result.failures[0].reason, /没有任何/);
  // 6 PNG + 6 来源说明 + 1 manifest
  const names = result.entries.map((e) => e.name).sort();
  assert.equal(names.filter((n) => n.endsWith(".png")).length, 6);
  assert.equal(names.filter((n) => n.endsWith("_sources.txt")).length, 6);
  assert.ok(names.includes("manifest.json"));
  assert.equal(result.manifest.results.length, 7);

  // 产出的 PNG 合法，且尺寸等于设置（IHDR 宽高位于字节 16..24）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtpack-e2e-"));
  const pngEntry = result.entries.find((e) => e.name.endsWith(".png"));
  const pngPath = path.join(dir, pngEntry.name.replace(/[\\/]/g, "_"));
  fs.writeFileSync(pngPath, pngEntry.bytes);
  const buf = fs.readFileSync(pngPath);
  assert.equal(buf.readUInt32BE(16), 256);
  assert.equal(buf.readUInt32BE(20), 256);

  // 来源说明含通道映射与补齐记录
  const txt = result.entries.find((e) => e.name.includes("brick") && e.name.endsWith("_sources.txt"));
  const text = new TextDecoder().decode(txt.bytes);
  assert.match(text, /通道映射/);
  assert.match(text, /常量/);
  assert.match(text, /实际处理记录/);
});

test("E2E: 同名保护 — 文件名模板冲突时自动追加序号", async () => {
  const { project } = makeProject();
  project.settings.filenamePattern = "same"; // 所有输出都叫 same
  const result = await batch.runBatch(project);
  const pngs = result.entries.filter((e) => e.name.endsWith(".png")).map((e) => e.name);
  assert.equal(new Set(pngs).size, pngs.length, "PNG 文件名必须唯一");
  assert.ok(pngs.includes("same.png"));
  assert.ok(pngs.some((n) => /same_\d+\.png/.test(n)));
});

test("E2E: failOnMissingRole 开启后缺来源判失败，其余项仍成功", async () => {
  const { project } = makeProject();
  project.settings.failOnMissingRole = true;
  delete project.groups[1].files.roughness; // wood 缺粗糙度
  const result = await batch.runBatch(project);
  const woodFailures = result.failures.filter((f) => f.group === "wood");
  assert.ok(woodFailures.length >= 1);
  assert.match(woodFailures[0].reason, /缺少来源角色/);
  // brick 三项依然成功
  assert.equal(result.successes.filter((s) => s.group === "brick").length, 3);
});

test("E2E: 工程保存与恢复往返", async () => {
  const { project } = makeProject();
  project.settings.embedImages = true;
  const json = batch.serializeProject(project, true);
  // 内嵌 dataUrl，shim 下的 Image 加载直接复用 imageData
  globalThis.Image = class {
    set src(v) {
      const file = project.groups.flatMap((g) => Object.values(g.files)).find((f) => f.dataUrl === v);
      this.naturalWidth = file.width;
      this.naturalHeight = file.height;
      this.width = file.width;
      this.height = file.height;
      this.imageData = file.image.imageData;
      setTimeout(() => this.onload(), 0);
    }
  };
  const { project: restored, decodeErrors } = await batch.rehydrateProject(json);
  assert.deepEqual(decodeErrors, []);
  assert.equal(restored.outputs.length, 3);
  assert.equal(restored.groups[0].files.normal.width, 256);
  const composed = imageApi.composeOutput(restored.groups[0], restored.outputs[1], restored.settings);
  assert.equal(composed.imageData.width, 256);
});
