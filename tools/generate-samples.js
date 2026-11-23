'use strict';
/*
 * tools/generate-samples.js
 * 生成 public/samples/ 下的内置样例：
 *   - 六张面图 face-{0..5}-{name}.png（带方向文字、上/右箭头、四角坐标）
 *   - 一张经纬样例 equirect-sample.png
 *   - manifest.json：记录每个面的文件与“载入时应使用的初始朝向”
 *
 * 每张面 PNG 本身都是正确朝向（内部视角正读）。manifest 里把 0 号右面的
 * 初始 rot 设为 1（顺时针 90°），复现“有一个面转反了”的场景；
 * 正确的配置是 rot=0，页面接缝面板会给出“只需转向”的结论。
 */
const fs = require('fs');
const path = require('path');
const CubeCore = require('../src/cube.js');
const Samples = require('../src/samples.js');
const { encodePNG } = require('../src/png.js');

const OUT = path.join(__dirname, '..', 'public', 'samples');
const SIZE = Number(process.env.SAMPLE_SIZE || 512);
const EQ_W = 2048;

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sample = Samples.makeSampleFaces({ size: SIZE, equirectWidth: EQ_W });
  const manifest = {
    size: SIZE,
    note: '内置样例。每张 PNG 都是正确朝向；0 号右面的初始 rot=1 是故意转错的。',
    faces: {},
  };
  for (const f of CubeCore.FACES) {
    const tex = sample.faces[f.id].tex;
    const name = `face-${f.id}-${f.name.toLowerCase()}.png`;
    fs.writeFileSync(path.join(OUT, name), encodePNG(tex.width, tex.height, tex.data));
    const wrong = f.id === 0;
    manifest.faces[f.id] = {
      file: name,
      width: tex.width,
      height: tex.height,
      rot: wrong ? 1 : 0,
      flipH: false,
      fixRot: 0,
      note: wrong ? '故意转错的一面（初始 rot=1）' : '',
    };
  }
  const eq = Samples.makeSampleEquirect({ size: SIZE, width: EQ_W });
  fs.writeFileSync(path.join(OUT, 'equirect-sample.png'), encodePNG(eq.width, eq.height, eq.tex.data));
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log('已写出样例到 ' + OUT);
  console.log('  六面图 ' + SIZE + '×' + SIZE + '，经纬图 ' + EQ_W + '×' + EQ_W / 2);
}

main();
