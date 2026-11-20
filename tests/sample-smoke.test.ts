import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseObj } from '/Users/sunmengmeng/works/gsb2/tasks/6339/repo/src/core/obj-parser';
import { parseMtl } from '/Users/sunmengmeng/works/gsb2/tasks/6339/repo/src/core/mtl-parser';
import { buildScene } from '/Users/sunmengmeng/works/gsb2/tasks/6339/repo/src/core/build-scene';

const dir = join('/Users/sunmengmeng/works/gsb2/tasks/6339/repo/public/samples');

describe('内置样例端到端', () => {
  const objText = readFileSync(join(dir, 'sample-model.obj'), 'utf8');
  const mtlText = readFileSync(join(dir, 'sample-material.mtl'), 'utf8');
  const parsed = parseObj(objText, 'sample-model.obj');
  const mtl = parseMtl(mtlText, 'sample-material.mtl');
  const model = buildScene({
    parsed,
    mtls: [mtl],
    availableTextures: new Set(['checkerboard.png']),
    objFileName: 'sample-model.obj',
  });

  it('对象与组结构符合预期，重名对象被消歧', () => {
    expect(model.objects.map((o) => o.rawName)).toEqual(['CubeA', 'CubeA', 'Pyramid']);
    expect(model.objects[0].label).toBe('CubeA');
    expect(model.objects[1].label).toBe('CubeA #2');
    const groupNames = model.objects.map((o) => o.children.map((g) => g.rawName));
    expect(groupNames[0]).toEqual(['Bottom', 'Top']);
    expect(groupNames[2]).toContain('ErrorCases');
  });

  it('正常几何可查看（顶点/面数为正，金字塔不被异常面连累）', () => {
    expect(model.root.vertexCount).toBeGreaterThan(0);
    expect(model.root.faceCount).toBeGreaterThan(10);
    const pyramid = model.objects.find((o) => o.rawName === 'Pyramid')!;
    const sides = pyramid.children.find((g) => g.rawName === 'Sides')!;
    expect(sides.faceCount).toBe(4);
  });

  it('各类异常都有带行号的警告', () => {
    const codes = new Set(model.warnings.map((w) => w.code));
    for (const expected of [
      'MTL_MATERIAL_NOT_FOUND',
      'OBJ_FACE_INDEX_OUT_OF_RANGE',
      'OBJ_FACE_INVALID',
      'OBJ_UNSUPPORTED_STATEMENT',
      'OBJ_VERTEX_INVALID',
      'TEXTURE_FILE_MISSING',
    ]) {
      expect(codes.has(expected), `缺少警告类型 ${expected}`).toBe(true);
    }
    const missingTex = model.warnings.find((w) => w.code === 'TEXTURE_FILE_MISSING');
    expect(missingTex?.message).toContain('does-not-exist.png');
    expect(model.missingMaterials).toContain('NotDefinedAnywhere');
  });

  it('checkerboard.png 存在的材质不报贴图缺失', () => {
    expect(model.missingTextures.has('CheckerMat')).toBe(false);
    expect(model.missingTextures.get('MissingTextureMat')).toEqual(['does-not-exist.png']);
  });
});
