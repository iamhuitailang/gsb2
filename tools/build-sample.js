#!/usr/bin/env node
/**
 * 生成内置示例角色的运行时导出文件 tools/sample.runtime.json
 * 用法：node tools/build-sample.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { window: {}, console, Image: class { }, performance: { now: () => 0 } };
sandbox.window.document = { addEventListener() { } };
vm.createContext(sandbox);

const jsDir = path.join(__dirname, '..', 'js');
for (const f of ['math.js', 'model.js', 'ik.js', 'pose.js', 'history.js', 'sample.js']) {
  vm.runInContext(fs.readFileSync(path.join(jsDir, f), 'utf8'), sandbox, { filename: f });
}

const project = sandbox.window.Sample.buildSampleProject();

const runtime = {
  format: 'bone-runtime-anim',
  formatVersion: 1,
  exportedAt: new Date().toISOString(),
  name: project.name,
  bones: project.bones.map((b) => ({ id: b.id, name: b.name, parentId: b.parentId, rest: b.rest })),
  parts: project.parts.filter((p) => p.visible).map((p) => ({
    id: p.id, name: p.name, boneId: p.boneId, shape: p.shape,
    offset: p.offset, fill: p.fill, stroke: p.stroke, opacity: p.opacity,
  })),
  images: project.images,
  ik: project.ik.map((c) => ({
    id: c.id, name: c.name, rootBoneId: c.rootBoneId, midBoneId: c.midBoneId,
    effBoneId: c.effBoneId, enabled: c.enabled, bend: c.bend, target: c.target,
  })),
  animations: project.animations.map((a) => ({
    id: a.id, name: a.name, frameRate: a.frameRate,
    frameCount: a.frameCount, loop: a.loop, keys: a.keys, ikKeys: a.ikKeys,
  })),
};

const out = path.join(__dirname, 'sample.runtime.json');
fs.writeFileSync(out, JSON.stringify(runtime, null, 2));
console.log('已生成 ' + out);
console.log('骨骼 ' + runtime.bones.length + '，部件 ' + runtime.parts.length +
  '，IK ' + runtime.ik.length + '，动作 ' + runtime.animations.length);
