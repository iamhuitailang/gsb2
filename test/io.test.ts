import { describe, expect, it } from 'vitest';
import { exportLevel, importLevel, SAVE_FORMAT } from '../src/core/io';
import { createLevel } from '../src/core/levels';
import { COLOR_BITS } from '../src/core/types';

describe('保存与导入', () => {
  it('导出再导入得到等价关卡', () => {
    const level = createLevel(4, '往返测试');
    level.cells[0][0] = { kind: 'source', dir: 1, colors: COLOR_BITS.R | COLOR_BITS.G };
    level.cells[1][1] = { kind: 'mirror', orient: 0, locked: true };
    level.cells[2][2] = { kind: 'target', required: 7 };
    level.cells[3][3] = { kind: 'wall' };

    const text = exportLevel(level);
    const parsed = importLevel(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.globalErrors).toEqual([]);
    expect(parsed.level!.name).toBe('往返测试');
    expect(parsed.level!.cells[0][0]).toEqual(level.cells[0][0]);
    expect(parsed.level!.cells[1][1]).toEqual(level.cells[1][1]);
    expect(parsed.level!.cells[2][2]).toEqual(level.cells[2][2]);
    expect(parsed.level!.cells[3][3]).toEqual(level.cells[3][3]);
    expect(parsed.level!.cells[0][1]).toEqual({ kind: 'empty' });
  });

  it('JSON 非法时给出解析错误且不产出关卡', () => {
    const res = importLevel('{not json');
    expect(res.ok).toBe(false);
    expect(res.globalErrors[0]).toContain('JSON');
    expect(res.level).toBeUndefined();
  });

  it('格式标识不符报整体错误', () => {
    const res = importLevel(JSON.stringify({ format: 'other/v0', size: 4, cells: [] }));
    expect(res.ok).toBe(false);
    expect(res.globalErrors.join()).toContain(SAVE_FORMAT);
  });

  it('同一格重复定义 => 格子冲突并指出行列(1 起)', () => {
    const payload = {
      format: SAVE_FORMAT,
      size: 4,
      cells: [
        { r: 1, c: 1, kind: 'wall' },
        { r: 1, c: 1, kind: 'target', required: 0 },
      ],
    };
    const res = importLevel(JSON.stringify(payload));
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ r: 1, c: 1 });
    expect(res.errors[0].reason).toContain('(2, 2)');
  });

  it('越界坐标与非法字段逐格报错', () => {
    const payload = {
      format: SAVE_FORMAT,
      size: 4,
      cells: [
        { r: 9, c: 0, kind: 'wall' },
        { r: 0, c: 0, kind: 'mirror', orient: 5 },
        { r: 0, c: 1, kind: 'source', dir: 9, colors: 3 },
      ],
    };
    const res = importLevel(JSON.stringify(payload));
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(3);
  });

  it('缺少光源/收光点报整体错误', () => {
    const res = importLevel(
      JSON.stringify({ format: SAVE_FORMAT, size: 4, cells: [{ r: 0, c: 0, kind: 'wall' }] }),
    );
    expect(res.ok).toBe(false);
    expect(res.globalErrors.join()).toContain('光源');
    expect(res.globalErrors.join()).toContain('收光点');
  });
});
