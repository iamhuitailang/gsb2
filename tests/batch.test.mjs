import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExportPlan,
  describeChannelSource,
  runExportPlan,
  sanitizeName,
  uniqueName,
} from "../src/lib/batch.js";
import { buildManifest, buildSourceReport } from "../src/lib/report.js";
import { createMaterial, createOutput, createProject, emptyChannel } from "../src/lib/project.js";
import { buildOutput } from "../src/lib/imaging.js";

function materialWith(name, outputs, size = [64, 64]) {
  const material = createMaterial(name);
  material.targetWidth = size[0];
  material.targetHeight = size[1];
  material.images = {
    albedo: { role: "albedo", fileName: `${name.replace(/\s/g, "_")}_Albedo.png`, width: 64, height: 64 },
    normal: { role: "normal", fileName: `${name.replace(/\s/g, "_")}_Normal.png`, width: 64, height: 64 },
  };
  material.outputs = outputs;
  return material;
}

function simpleOutput(name, type = "custom") {
  return createOutput({
    name,
    type,
    channels: {
      r: emptyChannel("role", "albedo"),
      g: emptyChannel("role", "normal"),
      b: emptyChannel("constant", null, 32),
      a: emptyChannel("constant", null, 255),
    },
  });
}

function projectWith(...materials) {
  const project = createProject("导出测试");
  project.materials = materials;
  project.activeMaterialId = materials[0].id;
  return project;
}

/* ---------------------------- 命名 ---------------------------- */

test("sanitizeName 处理非法字符与空名", () => {
  assert.equal(sanitizeName("a/b:c*?.png"), "a_b_c__.png");
  assert.equal(sanitizeName("   "), "unnamed");
  assert.equal(sanitizeName("CON"), "_CON");
  assert.equal(sanitizeName("..."), "unnamed");
});

test("uniqueName 追加序号且大小写不敏感", () => {
  const used = new Set(["basecolor.png"]);
  assert.equal(uniqueName("BaseColor.png", used), "BaseColor-2.png");
  assert.equal(uniqueName("BaseColor.png", used), "BaseColor-3.png");
});

/* ---------------------------- 导出计划 ---------------------------- */

test("不同材质的同名输出不会互相覆盖（目录隔离 + 全局去重）", () => {
  const a = materialWith("砖墙", [simpleOutput("BaseColor"), simpleOutput("Normal", "normal")]);
  const b = materialWith("木地板", [simpleOutput("BaseColor"), simpleOutput("Normal", "normal")]);
  const project = projectWith(a, b);
  const plan = buildExportPlan(project);
  const paths = plan.items.map((i) => i.zipPath);
  assert.equal(new Set(paths).size, paths.length, "导出路径必须唯一");
  assert.ok(paths.includes("砖墙/BaseColor.png"));
  assert.ok(paths.includes("木地板/BaseColor.png"));
});

test("同一材质内重名输出会自动加类型后缀并提示", () => {
  const a = materialWith("材质A", [simpleOutput("ORM"), simpleOutput("ORM")]);
  const plan = buildExportPlan(projectWith(a));
  const paths = plan.items.map((i) => i.zipPath);
  assert.equal(new Set(paths).size, 2);
  assert.ok(paths.some((p) => p.includes("ORM_Custom")), `got ${paths.join(", ")}`);
  assert.ok(paths.some((p) => p === "材质A/ORM.png"), `got ${paths.join(", ")}`);
  assert.ok(plan.warnings.some((w) => w.includes("重名")));
});

test("同名材质目录也会自动去重", () => {
  const a = materialWith("同名", [simpleOutput("X")]);
  const b = materialWith("同名", [simpleOutput("X")]);
  const plan = buildExportPlan(projectWith(a, b));
  const dirs = plan.items.map((i) => i.folder);
  assert.equal(new Set(dirs).size, 2, "目录应当被唯一化");
  assert.equal(new Set(plan.items.map((i) => i.zipPath)).size, 2);
});

test("停用的输出不进入导出计划", () => {
  const out = simpleOutput("BaseColor");
  out.enabled = false;
  const a = materialWith("停用", [out, simpleOutput("Normal", "normal")]);
  const plan = buildExportPlan(projectWith(a));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].outputName, "Normal");
});

test("尺寸非法的输出进入 skipped 并带原因，其它项仍保留", () => {
  const bad = simpleOutput("坏输出");
  bad.width = 99999;
  bad.height = 16;
  const a = materialWith("材质", [bad, simpleOutput("好输出")]);
  const plan = buildExportPlan(projectWith(a));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /宽度/);
  assert.equal(plan.items[0].outputName, "好输出");
});

test("没有启用输出的材质只给 warning，不报错", () => {
  const a = materialWith("空材质", []);
  const plan = buildExportPlan(projectWith(a));
  assert.equal(plan.items.length, 0);
  assert.ok(plan.warnings.some((w) => w.includes("没有启用的输出")));
});

test("文件名中的非法字符被清理", () => {
  const out = simpleOutput("A/B:C");
  const a = materialWith("材质/名", [out]);
  const plan = buildExportPlan(projectWith(a));
  assert.ok(!plan.items[0].zipPath.includes(":"));
  assert.ok(!/\/A\/B/.test(plan.items[0].zipPath));
  assert.match(plan.items[0].zipPath, /A_B_C\.png$/);
});

/* ---------------------------- 执行计划 ---------------------------- */

test("单项失败不中断，成功项保留，失败项带原因", async () => {
  const a = materialWith("材质", [simpleOutput("会失败"), simpleOutput("会成功")]);
  const plan = buildExportPlan(projectWith(a));
  const progress = [];
  const results = await runExportPlan(
    plan,
    async (item) => {
      if (item.outputName === "会失败") throw new Error("模拟解码失败：文件已损坏");
      return { png: new Uint8Array([1, 2, 3]), sources: [], reportText: "report", warnings: [] };
    },
    { onProgress: (p) => progress.push(p.phase) },
  );
  assert.equal(results.succeeded.length, 1);
  assert.equal(results.failed.length, 1);
  assert.equal(results.failed[0].error, "模拟解码失败：文件已损坏");
  assert.equal(results.succeeded[0].outputName, "会成功");
  assert.equal(results.succeeded[0].byteLength, 3);
  assert.equal(results.reports.length, 1, "成功项会生成来源说明");
  assert.ok(progress.includes("start") && progress.includes("item"));
});

test("连续同名输出在计划层已保证路径唯一", async () => {
  const a = materialWith("材质", [simpleOutput("同名"), simpleOutput("同名"), simpleOutput("同名")]);
  const plan = buildExportPlan(projectWith(a));
  const results = await runExportPlan(plan, async () => ({ png: new Uint8Array([0]), sources: [], reportText: "", warnings: [] }));
  const names = results.succeeded.map((i) => i.zipPath);
  assert.equal(new Set(names).size, 3);
});

/* ---------------------------- 来源说明 ---------------------------- */

function fakeBuild() {
  return buildOutput({
    width: 4,
    height: 4,
    fitMode: "pad",
    includeAlpha: false,
    channels: {
      r: { source: { kind: "role", role: "albedo" }, sample: "luminance" },
      g: { source: { kind: "role", role: "roughness" }, sample: "red", invert: true, strength: 1.5 },
      b: { source: { kind: "constant" }, constant: 12 },
      a: { source: { kind: "constant" }, constant: 255 },
    },
    resolveImage: (role) =>
      role === "albedo"
        ? { width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4).fill(128), fileName: "a.png" }
        : null,
  });
}

test("describeChannelSource 同时描述来源、取色、反相、强度与常量补齐", () => {
  const build = fakeBuild();
  const r = describeChannelSource(build.channels[0], "r");
  assert.match(r, /^R: 颜色 a\.png/);
  assert.match(r, /取 /);
  const g = describeChannelSource(build.channels[1], "g");
  assert.match(g, /缺少来源/);
  assert.match(g, /常量补齐/);
  const b = describeChannelSource(build.channels[2], "b");
  assert.match(b, /^B: 常量填充 = 12/);
});

test("buildSourceReport 包含尺寸策略、通道来源与警告", () => {
  const build = fakeBuild();
  const report = buildSourceReport({
    material: { name: "测试材质" },
    output: { name: "ORM", type: "orm", fileStem: "ORM", convention: "directx", includeAlpha: false },
    size: { width: 256, height: 256, fitMode: "crop" },
    build,
  });
  assert.match(report, /材质: 测试材质/);
  assert.match(report, /尺寸: 256 × 256/);
  assert.match(report, /尺寸策略: 缩放裁切/);
  assert.match(report, /法线方向: DirectX/);
  assert.match(report, /通道映射/);
  assert.match(report, /缺少「粗糙度」贴图/);
  assert.match(report, /来源尺寸 8×4/);
});

test("buildManifest 区分成功 / 失败 / 重命名", () => {
  const a = materialWith("砖墙", [simpleOutput("ORM"), simpleOutput("ORM")]);
  const project = projectWith(a);
  const plan = buildExportPlan(project);
  const failed = [{ materialName: "砖墙", outputName: "坏图", error: "文件损坏" }];
  const text = buildManifest({
    project,
    plan,
    succeeded: [{ ...plan.items[0], sources: [] }],
    failed,
  });
  assert.match(text, /工程: 导出测试/);
  assert.match(text, /## 成功/);
  assert.match(text, /## 失败 \/ 跳过/);
  assert.match(text, /文件损坏/);
  assert.match(text, /## 命名冲突处理/);
  assert.match(text, /重名/);
});

test("buildManifest 不会把跳过项重复计数", () => {
  const bad = simpleOutput("坏输出");
  bad.width = 99999; // 超出 1~8192
  const a = materialWith("材质", [bad, simpleOutput("好输出")]);
  const plan = buildExportPlan(projectWith(a));
  assert.equal(plan.items.length, 1);
  assert.equal(plan.skipped.length, 1);
  const text = buildManifest({ project: projectWith(a), plan, succeeded: [], failed: [...plan.skipped] });
  assert.match(text, /失败\/跳过: 1/);
  const occurrences = text.split("坏输出").length - 1;
  assert.equal(occurrences, 1);
});
