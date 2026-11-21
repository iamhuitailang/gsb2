import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMaterial,
  createOutput,
  createProject,
  defaultPresetsFor,
  deserializeProject,
  detectRoleFromFileName,
  emptyChannel,
  groupFilesByMaterial,
  normalizeChannels,
  outputPreset,
  rebindImages,
  resolveOutputSize,
  serializeProject,
} from "../src/lib/project.js";
import { APP_SCHEMA } from "../src/lib/constants.js";

/* ---------------------------- 文件名识别 ---------------------------- */

test("识别常见命名：角色在尾部", () => {
  assert.equal(detectRoleFromFileName("brick_wall_02_Normal.png").role, "normal");
  assert.equal(detectRoleFromFileName("brick_wall_02_Normal.png").baseName, "brick_wall_02");
  assert.equal(detectRoleFromFileName("brick_wall_02_albedo.png").role, "albedo");
  assert.equal(detectRoleFromFileName("rock_basecolor.jpg").role, "albedo");
  assert.equal(detectRoleFromFileName("rock_roughness.tga").role, "roughness");
  assert.equal(detectRoleFromFileName("rock_AO.png").role, "ao");
  assert.equal(detectRoleFromFileName("rock_metallic.png").role, "metallic");
  assert.equal(detectRoleFromFileName("rock_height.png").role, "height");
});

test("角色大小写与分隔符不敏感", () => {
  const a = detectRoleFromFileName("Metal Plate-Normal.tga");
  const b = detectRoleFromFileName("metal.plate.normal.tga");
  assert.equal(a.role, "normal");
  assert.equal(b.role, "normal");
});

test("角色词出现在前缀时不会被误判（metal_plate_Metallic）", () => {
  const info = detectRoleFromFileName("metal_plate_Metallic.png");
  assert.equal(info.role, "metallic");
  assert.equal(info.baseName, "metal_plate");
});

test("多个角色词同时出现时取最靠后的（brick_normal_roughness）", () => {
  const info = detectRoleFromFileName("brick_normal_roughness.png");
  assert.equal(info.role, "roughness");
  assert.equal(info.baseName, "brick_normal");
});

test("分组键忽略大小写", () => {
  const groups = groupFilesByMaterial(["Brick_Albedo.png", "brick_Normal.png", "brick_roughness.png"]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].files.length, 3);
});

test("无法识别时回退 other 并保留原始名", () => {
  const info = detectRoleFromFileName("whatever.png");
  assert.equal(info.role, "other");
  assert.equal(info.baseName, "whatever");
});

test("按 baseName 把文件分组为材质", () => {
  const groups = groupFilesByMaterial([
    "brick_Albedo.png",
    "brick_Normal.png",
    "brick_Roughness.png",
    "wood_Albedo.png",
    "wood_Normal.png",
  ]);
  assert.equal(groups.length, 2);
  const brick = groups.find((g) => g.baseName === "brick");
  assert.equal(brick.files.length, 3);
});
/* ---------------------------- 通道规范化 ---------------------------- */

test("normalizeChannels 补齐缺失通道并夹紧取值范围", () => {
  const channels = normalizeChannels({
    r: { source: { kind: "role", role: "nonexistent" }, strength: 99, constant: 999 },
    g: { source: { kind: "constant" }, sample: "bogus" },
  });
  assert.deepEqual(channels.r.source, { kind: "constant" }, "未知角色回退常量");
  assert.equal(channels.r.strength, 4, "强度上限 4");
  assert.equal(channels.r.constant, 255, "常量上限 255");
  assert.equal(channels.g.sample, "luminance", "未知取色方式回退亮度");
  assert.ok(channels.b && channels.a, "缺失通道补齐");
});

test("resolveOutputSize 优先输出自身尺寸，否则跟随材质", () => {
  const material = createMaterial("m");
  material.targetWidth = 1024;
  material.targetHeight = 512;
  material.fitMode = "crop";
  const inherit = createOutput({ name: "a" });
  assert.deepEqual(resolveOutputSize(material, inherit), {
    width: 1024,
    height: 512,
    fitMode: "crop",
  });
  const override = createOutput({ name: "b", width: 256, height: 256, fitMode: "scale" });
  assert.deepEqual(resolveOutputSize(material, override), {
    width: 256,
    height: 256,
    fitMode: "scale",
  });
});

test("预设输出：ORM 映射 AO/粗糙度/金属度", () => {
  const material = createMaterial("m");
  material.images = { ao: { role: "ao" }, roughness: { role: "roughness" }, metallic: { role: "metallic" } };
  const orm = outputPreset("orm", material);
  assert.equal(orm.channels.r.source.role, "ao");
  assert.equal(orm.channels.g.source.role, "roughness");
  assert.equal(orm.channels.b.source.role, "metallic");
});

test("预设输出：颜色图按 RGB 三通道取色", () => {
  const color = outputPreset("color", createMaterial());
  assert.equal(color.channels.r.sample, "red");
  assert.equal(color.channels.g.sample, "green");
  assert.equal(color.channels.b.sample, "blue");
});

test("defaultPresetsFor 生成 3 组预设", () => {
  assert.equal(defaultPresetsFor(createMaterial()).length, 3);
});

/* ---------------------------- 工程序列化 ---------------------------- */

function projectWithChannels() {
  const project = createProject("测试工程");
  const material = project.materials[0];
  material.name = "砖墙";
  material.targetWidth = 512;
  material.targetHeight = 256;
  material.fitMode = "pad";
  material.images = {
    albedo: { role: "albedo", fileName: "brick_Albedo.png", width: 512, height: 256, bytes: 1000 },
    normal: { role: "normal", fileName: "brick_Normal.tga", width: 512, height: 128, bytes: 2000 },
  };
  material.outputs = [
    createOutput({
      name: "ORM",
      type: "orm",
      channels: {
        r: emptyChannel("role", "ao", 200),
        g: { ...emptyChannel("role", "roughness", 128), invert: true, strength: 0.4 },
        b: { source: { kind: "constant" }, constant: 17 },
        a: emptyChannel("constant", null, 255),
      },
    }),
  ];
  project.selectedOutputId = material.outputs[0].id;
  return project;
}

test("序列化后反序列化能完整恢复通道映射", () => {
  const project = projectWithChannels();
  const json = JSON.stringify(serializeProject(project));
  const restored = deserializeProject(json);
  assert.equal(restored.schema, APP_SCHEMA);
  assert.equal(restored.materials.length, 1);
  const material = restored.materials[0];
  assert.equal(material.name, "砖墙");
  assert.equal(material.targetWidth, 512);
  assert.equal(material.fitMode, "pad");
  const output = material.outputs[0];
  assert.equal(output.name, "ORM");
  assert.equal(output.channels.r.source.role, "ao");
  assert.equal(output.channels.g.invert, true);
  assert.equal(output.channels.g.strength, 0.4);
  assert.equal(output.channels.g.source.role, "roughness", "强度 0.4 不应被默认值覆盖");
  assert.equal(output.channels.b.source.kind, "constant");
  assert.equal(output.channels.b.constant, 17);
  assert.equal(restored.selectedOutputId, output.id);
});

test("反序列化拒绝错误版本", () => {
  assert.throws(() => deserializeProject({ schema: "other/9", materials: [] }), /不支持的工程版本/);
});

test("反序列化逐条列出问题", () => {
  const raw = {
    schema: APP_SCHEMA,
    materials: [{ name: "坏材质", targetWidth: 0, targetHeight: 10, outputs: [] }],
  };
  try {
    deserializeProject(raw);
    assert.fail("应当抛错");
  } catch (err) {
    assert.match(err.message, /1 处问题/);
    assert.match(err.message, /坏材质/);
  }
});

test("反序列化拒绝空材质列表", () => {
  assert.throws(() => deserializeProject({ schema: APP_SCHEMA, materials: [] }), /缺少材质列表/);
});

test("反序列化非法 JSON 给出可读错误", () => {
  assert.throws(() => deserializeProject("{not json"), /不是合法 JSON/);
});

test("含贴图保存会写入 dataUrl，普通保存不会", () => {
  const project = projectWithChannels();
  project.materials[0].images.albedo.dataUrl = "data:image/png;base64,AAAA";
  const plain = serializeProject(project);
  assert.equal(plain.materials[0].images.albedo.dataUrl, undefined);
  const embedded = serializeProject(project, { embedImages: true });
  assert.equal(embedded.materials[0].images.albedo.dataUrl, "data:image/png;base64,AAAA");
});

/* ---------------------------- 重新绑定 ---------------------------- */

test("rebindImages 按文件名把来源贴图重新绑定到材质", () => {
  const project = projectWithChannels();
  const loaded = [
    { fileName: "brick_Albedo.png", width: 512, height: 256, data: new Uint8ClampedArray(512 * 256 * 4) },
    { fileName: "brick_Normal.tga", width: 512, height: 128, data: new Uint8ClampedArray(512 * 128 * 4) },
  ];
  const result = rebindImages(project, loaded);
  assert.equal(result.bound.length, 2);
  assert.equal(result.missing.length, 0);
  assert.equal(project.materials[0].images.albedo.data.length, 512 * 256 * 4);
  assert.equal(project.materials[0].images.normal.restored, true);
});

test("rebindImages 报告缺失的文件名", () => {
  const project = projectWithChannels();
  const result = rebindImages(project, [
    { fileName: "other_albedo.png", width: 1, height: 1, data: new Uint8ClampedArray(4) },
  ]);
  assert.equal(result.bound.length, 0);
  assert.equal(result.missing.length, 2);
  assert.equal(result.missing[0].fileName, "brick_Albedo.png");
});

test("rebindImages 在有多张候选时报告歧义而不是随便选", () => {
  const project = projectWithChannels();
  const dup = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const result = rebindImages(project, [
    { ...dup, fileName: "brick_Albedo.png" },
    { ...dup, fileName: "brick_Albedo.png" },
  ]);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].count, 2);
});

test("preset outputs 的通道配置可被 normalizeChannels 无损往返", () => {
  const out = createOutput({ type: "orm", channels: outputPreset("orm").channels });
  const normalized = normalizeChannels(JSON.parse(JSON.stringify(out.channels)));
  assert.deepEqual(normalized, out.channels);
});
