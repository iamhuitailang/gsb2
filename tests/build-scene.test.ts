import { describe, expect, it } from 'vitest';
import { buildScene, flattenNodes } from '../src/core/build-scene';
import { parseMtl } from '../src/core/mtl-parser';
import { parseObj } from '../src/core/obj-parser';

function build(text: string, mtlText = '', textures = new Set<string>()) {
  const parsed = parseObj(text, 'model.obj');
  const mtls = mtlText ? [parseMtl(mtlText, 'lib.mtl')] : [];
  const model = buildScene({ parsed, mtls, availableTextures: textures, objFileName: 'model.obj' });
  return { parsed, model };
}

const quad = [
  'mtllib lib.mtl',
  'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0',
  'vn 0 0 1',
  'usemtl Red',
  'f 1//1 2//1 3//1 4//1',
].join('\n');

describe('buildScene 几何构建', () => {
  it('四边形扇面三角化为两个三角形并计算统计', () => {
    const { model } = build(quad, 'newmtl Red\nKd 1 0 0');
    const group = model.objects[0].children[0];
    expect(group.faceCount).toBe(2);
    expect(group.vertexCount).toBe(4);
    expect(group.submeshes).toHaveLength(1);
    expect(group.submeshes[0].indices).toHaveLength(6);
    expect(group.bbox.min).toEqual([0, 0, 0]);
    expect(group.bbox.max).toEqual([1, 1, 0]);
  });

  it('面没有法线时自动生成面法线', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n');
    const { model } = build(text);
    const sub = model.objects[0].children[0].submeshes[0];
    expect(sub.normals.every((n) => Number.isFinite(n))).toBe(true);
    // 三角面在 z=0 平面，法线指向 +z 或 -z，z 分量绝对值为 1
    expect(Math.abs(sub.normals[2])).toBeCloseTo(1);
  });

  it('负索引正确解析为数组位置', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n');
    const { model } = build(text);
    const sub = model.objects[0].children[0].submeshes[0];
    expect(sub.indices).toHaveLength(3);
    expect(model.warnings.filter((w) => w.code === 'OBJ_FACE_INDEX_OUT_OF_RANGE')).toHaveLength(0);
  });
});

describe('buildScene 材质与缺失处理', () => {
  it('引用未定义材质时回退默认材质并只警告一次', () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 1 1 0',
      'usemtl Ghost',
      'f 1 2 3',
      'f 1 3 4',
    ].join('\n');
    const { model } = build(text);
    expect(model.missingMaterials).toEqual(['Ghost']);
    const notFound = model.warnings.filter((w) => w.code === 'MTL_MATERIAL_NOT_FOUND');
    expect(notFound).toHaveLength(1);
    const sub = model.objects[0].children[0].submeshes[0];
    expect(sub.materialName).toBe('__default__');
  });

  it('越界索引的面被跳过并记录行号，其它面保留', () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'f 1 2 99', // 行 4 越界
      'f 1 2 3', // 行 5 正常
    ].join('\n');
    const { model } = build(text);
    const oob = model.warnings.filter((w) => w.code === 'OBJ_FACE_INDEX_OUT_OF_RANGE');
    expect(oob).toHaveLength(1);
    expect(oob[0].line).toBe(4);
    expect(model.objects[0].children[0].faceCount).toBe(1);
  });

  it('零索引按 OBJ 规范视为非法', () => {
    const text = ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 0 3'].join('\n');
    const { model } = build(text);
    expect(model.warnings.some((w) => w.code === 'OBJ_FACE_INDEX_OUT_OF_RANGE')).toBe(true);
  });

  it('贴图缺失时记录材质与占位信息，存在时不报告', () => {
    const mtlText = 'newmtl Red\nKd 1 0 0\nmap_Kd img.png';
    const missing = build(quad, mtlText, new Set());
    expect(missing.model.missingTextures.get('Red')).toEqual(['img.png']);
    expect(missing.model.warnings.some((w) => w.code === 'TEXTURE_FILE_MISSING')).toBe(true);

    const ok = build(quad, mtlText, new Set(['img.png']));
    expect(ok.model.missingTextures.size).toBe(0);
  });

  it('同组内不同材质拆分为不同 SubMesh', () => {
    const text = [
      'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 1 1 1', 'v 0 1 1',
      'usemtl A', 'f 1 2 3',
      'usemtl B', 'f 1 3 4',
    ].join('\n');
    const { model } = build(text, 'newmtl A\nKd 1 0 0\nnewmtl B\nKd 0 1 0');
    const subs = model.objects[0].children[0].submeshes;
    expect(subs.map((s) => s.materialName).sort()).toEqual(['A', 'B']);
  });
});

describe('buildScene 结构与稳定 ID', () => {
  it('重名对象得到不同 ID 与消歧展示名', () => {
    const text = [
      'o Same',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'f 1 2 3',
      'o Same',
      'v 2 0 0', 'v 3 0 0', 'v 2 1 0',
      'f 4 5 6',
    ].join('\n');
    const { model } = build(text);
    expect(model.objects.map((o) => o.id)).toEqual(['o:0', 'o:1']);
    expect(model.objects[0].label).toBe('Same');
    expect(model.objects[1].label).toBe('Same #2');
    const flat = flattenNodes(model.root);
    expect(flat.get('o:0')).toBe(model.objects[0]);
    expect(flat.get('o:1')).toBe(model.objects[1]);
  });

  it('节点 ID 在重新构建后保持稳定（项目恢复的基础）', () => {
    const text = [
      'o A', 'g G1',
      'v 0 0 0', 'v 1 0 0', 'v 0 1 0',
      'f 1 2 3',
      'o B',
      'v 2 0 0', 'v 3 0 0', 'v 2 1 0',
      'f 4 5 6',
    ].join('\n');
    const first = build(text).model;
    const second = build(text).model;
    const ids1 = [...flattenNodes(first.root).keys()];
    const ids2 = [...flattenNodes(second.root).keys()];
    expect(ids1).toEqual(ids2);
  });
});
