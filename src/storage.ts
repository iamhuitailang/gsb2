namespace SamplerLab {
  // ---------- 需求 5：保存单像素记录 + 读回配置复现 ----------

  export function downloadRecord(record: PixelRecord): void {
    const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pixel-${record.selectedPixel.px}-${record.selectedPixel.py}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  export function validateRecord(raw: unknown): PixelRecord {
    if (typeof raw !== 'object' || raw === null) throw new Error('记录不是 JSON 对象');
    const r = raw as Partial<PixelRecord>;
    if (r.format !== 'sampling-lab-pixel') throw new Error('format 字段不匹配，不是本工具的像素记录');
    if (r.version !== 1) throw new Error(`不支持的记录版本: ${String(r.version)}`);
    if (!r.scene || !Array.isArray(r.scene.triangles)) throw new Error('记录中缺少 scene.triangles');
    if (!r.pixel || typeof r.pixel.px !== 'number' || typeof r.pixel.py !== 'number') {
      throw new Error('记录中缺少 pixel 坐标');
    }
    return raw as PixelRecord;
  }

  export interface ReproReport {
    ok: boolean;
    mismatches: string[];
    record: PixelRecord;
    actual: SerializedPixel;
  }

  /** 用记录里的输入配置重新跑一遍光栅化，逐项比对保存的像素结果 */
  export function reproduce(record: PixelRecord): ReproReport {
    const scene = record.scene;
    const out = rasterize(scene);
    const { px, py } = record.selectedPixel;
    if (px < 0 || py < 0 || px >= scene.width || py >= scene.height) {
      throw new Error(`记录中的像素 (${px}, ${py}) 超出画布 ${scene.width}x${scene.height}`);
    }
    const actual = serializePixel(scene, out, px, py);
    const expected = record.pixel;
    const mismatches: string[] = [];

    if (actual.samples.length !== expected.samples.length) {
      mismatches.push(`采样点数量 ${expected.samples.length} -> ${actual.samples.length}`);
    }
    const n = Math.min(actual.samples.length, expected.samples.length);
    for (let i = 0; i < n; i++) {
      const a = actual.samples[i];
      const e = expected.samples[i];
      if (a.winnerId !== e.winnerId) {
        mismatches.push(`采样点 ${e.label} 胜出面不一致：保存=${e.winnerId ?? '背景'} 复现=${a.winnerId ?? '背景'}`);
      }
      const covA = a.coveredBy.slice().sort().join(',');
      const covE = e.coveredBy.slice().sort().join(',');
      if (covA !== covE) {
        mismatches.push(`采样点 ${e.label} 覆盖列表不一致：保存=[${covE}] 复现=[${covA}]`);
      }
      for (const ch of ['r', 'g', 'b'] as const) {
        if (Math.abs(a.color[ch] - e.color[ch]) > 1e-6) {
          mismatches.push(`采样点 ${e.label} 颜色通道 ${ch.toUpperCase()} 不一致`);
        }
      }
    }
    for (const mode of ['blendedStored', 'blendedLinear', 'final'] as const) {
      for (const ch of ['r', 'g', 'b'] as const) {
        if (Math.abs(actual[mode][ch] - expected[mode][ch]) > 1e-6) {
          mismatches.push(`${mode} 通道 ${ch.toUpperCase()} 无法复现`);
        }
      }
    }
    return { ok: mismatches.length === 0, mismatches, record, actual };
  }
}
