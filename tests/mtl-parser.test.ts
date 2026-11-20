import { describe, expect, it } from 'vitest';
import { parseMtl } from '../src/core/mtl-parser';

describe('parseMtl', () => {
  it('解析颜色、高光与不透明度（Tr 转换为 opacity）', () => {
    const mtl = parseMtl(
      ['newmtl A', 'Kd 0.2 0.4 0.6', 'Ks 0.1 0.1 0.1', 'Ns 64', 'Tr 0.3'].join('\n'),
      'a.mtl',
    );
    const a = mtl.materials.get('A')!;
    expect(a.diffuse).toEqual({ r: 0.2, g: 0.4, b: 0.6 });
    expect(a.shininess).toBe(64);
    expect(a.opacity).toBeCloseTo(0.7);
  });

  it('解析贴图路径并记录行号', () => {
    const mtl = parseMtl('newmtl B\nKd 1 1 1\nmap_Kd -s 2 2 tex/B.png', 'b.mtl');
    const b = mtl.materials.get('B')!;
    expect(b.diffuseMap?.path).toBe('tex/B.png');
    expect(b.diffuseMap?.line).toBe(3);
  });

  it('newmtl 之前的孤儿指令产生警告', () => {
    const mtl = parseMtl('Kd 1 0 0\nnewmtl A', 'a.mtl');
    expect(mtl.warnings.some((w) => w.code === 'MTL_ORPHAN_STATEMENT')).toBe(true);
  });

  it('无法解析的颜色与未知指令都产生带行号警告', () => {
    const mtl = parseMtl(
      ['newmtl A', 'Kd x y z', 'refl -type sphere foo'].join('\n'),
      'a.mtl',
    );
    const codes = mtl.warnings.map((w) => w.code);
    expect(codes).toContain('MTL_COLOR_INVALID');
    expect(codes).toContain('MTL_UNSUPPORTED_STATEMENT');
    expect(mtl.warnings.every((w) => w.file === 'a.mtl' && w.line !== null)).toBe(true);
  });
});
