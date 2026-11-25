const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const core = require("../public/js/core.js");

test("pickChannelValue 各取色方式", () => {
  assert.equal(core.pickChannelValue("red", 10, 20, 30, 40), 10);
  assert.equal(core.pickChannelValue("green", 10, 20, 30, 40), 20);
  assert.equal(core.pickChannelValue("blue", 10, 20, 30, 40), 30);
  assert.equal(core.pickChannelValue("alpha", 10, 20, 30, 40), 40);
  assert.equal(core.pickChannelValue("average", 30, 60, 90, 255), 60);
  const luma = core.pickChannelValue("luma", 255, 0, 0, 255);
  assert.ok(Math.abs(luma - 0.2126 * 255) < 1e-9);
  assert.throws(() => core.pickChannelValue("nope", 1, 2, 3, 4));
});

test("applyChannelTransform 反转与强度，并钳制 0..255", () => {
  assert.equal(core.applyChannelTransform(0, true, 1), 255);
  assert.equal(core.applyChannelTransform(255, true, 1), 0);
  assert.equal(core.applyChannelTransform(128, false, 1), 128);
  assert.equal(core.applyChannelTransform(128, false, 2), 255); // 钳制
  assert.equal(core.applyChannelTransform(128, false, 0), 0);
  assert.equal(core.applyChannelTransform(200, true, 0.5), Math.round((1 - 200 / 255) * 0.5 * 255));
});

test("resizeRect: stretch 铺满", () => {
  const r = core.resizeRect(100, 50, 200, 200, "stretch");
  assert.deepEqual(r, { sx: 0, sy: 0, sw: 100, sh: 50, dx: 0, dy: 0, dw: 200, dh: 200 });
});

test("resizeRect: crop 等比放大后居中，源上裁切、目标铺满", () => {
  const r = core.resizeRect(100, 100, 200, 100, "crop");
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 0);
  assert.equal(r.dw, 200);
  assert.equal(r.dh, 100);
  // 2:1 的目标比例 -> 源上居中裁出 100x50 的区域
  assert.equal(r.sw, 100);
  assert.equal(r.sh, 50);
  assert.equal(r.sx, 0);
  assert.equal(r.sy, 25);
});

test("resizeRect: pad 同比例铺满、异比例居中留边", () => {
  // 同宽高比：完全铺满，无留边
  const same = core.resizeRect(128, 128, 200, 200, "pad");
  assert.deepEqual([same.dx, same.dy, same.dw, same.dh], [0, 0, 200, 200]);
  // 宽源进方目标：宽铺满、上下留边
  const r = core.resizeRect(200, 100, 100, 100, "pad");
  assert.deepEqual([r.dx, r.dy, r.dw, r.dh], [0, 25, 100, 50]);
  // 方源进宽目标：高铺满、左右留边
  const wide = core.resizeRect(128, 128, 200, 100, "pad");
  assert.deepEqual([wide.dx, wide.dy, wide.dw, wide.dh], [50, 0, 100, 100]);
});

test("resizeRect: pad 等比缩小后居中留边", () => {
  const r = core.resizeRect(200, 100, 100, 100, "pad");
  assert.equal(r.dw, 100);
  assert.equal(r.dh, 50);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 25); // 上下各留 25px 边
});

test("deriveRole 后缀匹配且取最长后缀", () => {
  const suffixes = core.DEFAULT_SUFFIXES;
  assert.deepEqual(
    core.deriveRole("brick_albedo.png", suffixes),
    { role: "albedo", suffix: "_albedo", group: "brick" }
  );
  assert.equal(core.deriveRole("readme.txt", suffixes), null);
  assert.equal(core.deriveRole("wall_normal.png", suffixes).role, "normal");
});

test("matchGroups 按角色归组，未识别文件单独成组", () => {
  const files = [
    { id: "1", name: "brick_albedo.png" },
    { id: "2", name: "brick_normal.png" },
    { id: "3", name: "brick_roughness.png" },
    { id: "4", name: "notes.png" },
  ];
  const groups = core.matchGroups(files, core.DEFAULT_SUFFIXES);
  assert.equal(groups.length, 2);
  const brick = groups.find((g) => g.name === "brick");
  assert.ok(brick);
  assert.equal(brick.files.albedo.id, "1");
  assert.equal(brick.files.normal.id, "2");
  assert.equal(brick.files.roughness.id, "3");
  assert.equal(groups.find((g) => g.name === "notes").unassigned.length, 1);
});

test("matchGroups 同组同角色重复时后者进 unassigned 并给警告", () => {
  const files = [
    { id: "1", name: "brick_albedo.png" },
    { id: "2", name: "Brick_Albedo.PNG" }, // 大小写变体：同一组同一角色
  ];
  const groups = core.matchGroups(files, core.DEFAULT_SUFFIXES);
  const brick = groups.find((g) => g.name === "brick");
  assert.equal(brick.files.albedo.id, "1");
  assert.equal(brick.unassigned.length, 1);
  assert.equal(brick.warnings.length, 1);
});

test("matchGroups: 显式 unassigned + group 提示进入指定组的未分配", () => {
  const files = [
    { id: "1", name: "brick_albedo.png" },
    { id: "2", name: "brick_albedo_small.png", role: "unassigned", group: "brick" },
  ];
  const groups = core.matchGroups(files, core.DEFAULT_SUFFIXES);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "brick");
  assert.equal(groups[0].files.albedo.id, "1");
  assert.equal(groups[0].unassigned.length, 1);
  assert.equal(groups[0].unassigned[0].id, "2");
});

test("matchGroups 手工 role/group 优先于文件名推断", () => {
  const files = [{ id: "1", name: "brick_albedo_small.png", role: "albedo", group: "brick" }];
  const groups = core.matchGroups(files, core.DEFAULT_SUFFIXES);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].name, "brick");
  assert.equal(groups[0].files.albedo.id, "1");
});

test("uniqueName 同名保护：冲突追加序号", () => {
  const existing = ["a.png", "b.txt"];
  assert.equal(core.uniqueName("a.png", existing), "a_2.png");
  assert.equal(core.uniqueName("c.png", existing), "c.png");
  existing.push("a_2.png");
  assert.equal(core.uniqueName("a.png", existing), "a_3.png");
  assert.equal(core.uniqueName("noext", ["noext"]), "noext_2");
});

test("renderPattern 模板替换", () => {
  assert.equal(core.renderPattern("{group}_{output}", "brick", "orm"), "brick_orm");
  assert.equal(core.renderPattern("tex/{group}/{output}.x", "a/b", "o"), "tex/a/b/o.x");
});

test("normalizeProject 容错补全默认字段", () => {
  const p = core.normalizeProject({
    app: "mtpack",
    version: 1,
    outputs: [{ name: "x", filename: "x", channels: [{ channel: "r", source: { type: "constant", value: 12 } }] }],
  });
  assert.equal(p.outputs[0].channels.length, 4); // 自动补齐到 RGBA
  assert.equal(p.settings.outputWidth, 256);
  assert.equal(p.outputs[0].channels[0].source.value, 12);
  assert.throws(() => core.normalizeProject({ app: "other" }), /mtpack/);
  assert.throws(() => core.normalizeProject({ app: "mtpack", outputs: [] }), /输出/);
});

test("crc32 与已知向量一致", () => {
  assert.equal(core.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(core.crc32(new Uint8Array(0)), 0);
});

test("zipStore 产出结构合法的 ZIP，可用 zlib 解包回原文", () => {
  const entries = [
    { name: "a.txt", bytes: new TextEncoder().encode("hello") },
    { name: "dir/b.bin", bytes: Uint8Array.from([0, 1, 2, 255]) },
  ];
  const zip = core.zipStore(entries);
  // EOCD 签名
  assert.ok(zip.subarray(zip.length - 22, zip.length - 18).join(",") === [0x50, 0x4b, 5, 6].join(","));
  const unzipped = zlib.inflateRawSync; // 占位确认 zlib 可用
  assert.equal(typeof unzipped, "function");
  // 用系统 unzip 验证（Node 无内置 ZIP 解包）
  const { execFileSync } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtpack-zip-"));
  const zipPath = path.join(dir, "t.zip");
  fs.writeFileSync(zipPath, zip);
  execFileSync("unzip", ["-q", zipPath, "-d", dir]);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "hello");
  assert.deepEqual([...fs.readFileSync(path.join(dir, "dir/b.bin"))], [0, 1, 2, 255]);
});

test("defaultProject 含 ORM/法线/颜色三个默认输出", () => {
  const p = core.defaultProject();
  assert.equal(p.outputs.length, 3);
  assert.equal(p.outputs[0].channels.length, 3);
  assert.equal(p.outputs[1].isNormal, true);
});
