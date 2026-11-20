import { describe, expect, it } from 'vitest';
import { parseObj } from '../src/core/obj-parser';

describe('parseObj 基础解析', () => {
  it('解析顶点、纹理坐标与法线', () => {
    const parsed = parseObj(
      ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vt 0 0', 'vt 1 0', 'vn 0 0 1', 'f 1/1/1 2/2/1 3//1'].join('\n'),
      't.obj',
    );
    expect(parsed.vertices).toHaveLength(3);
    expect(parsed.texcoords).toHaveLength(2);
    expect(parsed.normals).toHaveLength(1);
    expect(parsed.faces).toHaveLength(1);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('无 o/g 声明时生成默认对象与默认组', () => {
    const parsed = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3', 't.obj');
    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0].groups).toHaveLength(1);
    expect(parsed.objects[0].groups[0].faceIndices).toHaveLength(1);
  });

  it('记录 mtllib 与 usemtl', () => {
    const parsed = parseObj(
      'mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl M\nf 1 2 3',
      't.obj',
    );
    expect(parsed.mtllibs).toEqual(['a.mtl']);
    expect(parsed.faces[0].material).toBe('M');
  });

  it('支持负索引（相对末尾）', () => {
    const parsed = parseObj(
      ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f -3 -2 -1'].join('\n'),
      't.obj',
    );
    expect(parsed.faces[0].invalid).toBeUndefined();
    expect(parsed.faces[0].vertices.map((r) => r.v)).toEqual([-3, -2, -1]);
  });
});

describe('parseObj 异常与警告', () => {
  it('无法解析的面标记 invalid 且带行号，但不影响其它面', () => {
    const text = [
      'v 0 0 0', // 1
      'v 1 0 0', // 2
      'v 0 1 0', // 3
      'v 1 1 0', // 4
      'f x y z', // 5 无效
      'f 1 2 3', // 6 正常
      'f 1 2', // 7 顶点不足
    ].join('\n');
    const parsed = parseObj(text, 't.obj');
    expect(parsed.faces).toHaveLength(3);
    expect(parsed.faces[0].invalid).toContain('无法解析');
    expect(parsed.faces[1].invalid).toBeUndefined();
    expect(parsed.faces[2].invalid).toContain('至少需要 3 个顶点');
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain('OBJ_FACE_INVALID');
    expect(parsed.warnings.every((w) => w.line !== null)).toBe(true);
    expect(parsed.warnings[0].line).toBe(5);
  });

  it('不支持的指令产生带行号的 UNSUPPORTED 警告', () => {
    const parsed = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\ncurv 0 1 1 2\nf 1 2 3', 't.obj');
    const w = parsed.warnings.find((x) => x.code === 'OBJ_UNSUPPORTED_STATEMENT');
    expect(w).toBeDefined();
    expect(w!.line).toBe(4);
    expect(w!.file).toBe('t.obj');
  });

  it('顶点分量不足时报 OBJ_VERTEX_INVALID', () => {
    const parsed = parseObj('v 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3', 't.obj');
    expect(parsed.warnings.some((w) => w.code === 'OBJ_VERTEX_INVALID')).toBe(true);
    expect(parsed.vertices).toHaveLength(2);
  });

  it('空 usemtl 产生警告并回退默认材质', () => {
    const parsed = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl\nf 1 2 3', 't.obj');
    expect(parsed.warnings.some((w) => w.code === 'OBJ_USEMTL_EMPTY')).toBe(true);
    expect(parsed.faces[0].material).toBeNull();
  });

  it('注释行与空行被忽略', () => {
    const parsed = parseObj('# comment\n\nv 0 0 0 # inline\nv 1 0 0\nv 0 1 0\nf 1 2 3', 't.obj');
    expect(parsed.vertices).toHaveLength(3);
    expect(parsed.warnings).toHaveLength(0);
  });
});
