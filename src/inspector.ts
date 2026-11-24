namespace SamplerLab {
  // ---------- 需求 2/4：单像素放大 + 采样点归属 + 两种混合对比 ----------

  export class PixelInspector {
    readonly el: HTMLElement;
    private zoomCanvas: HTMLCanvasElement;
    private detail: HTMLElement;
    private zoomSize = 280;

    constructor() {
      this.zoomCanvas = h('canvas', { className: 'zoom-canvas' });
      this.detail = h('div', { className: 'inspector-detail' });
      this.el = h('div', { className: 'inspector' }, [
        h('h3', { textContent: '像素检查器' }),
        this.zoomCanvas,
        this.detail,
      ]);
    }

    render(scene: SceneConfig, out: RasterOutput, selected: { px: number; py: number } | null): void {
      clear(this.detail);
      if (!selected) {
        const zctx = this.zoomCanvas.getContext('2d')!;
        this.zoomCanvas.width = this.zoomSize;
        this.zoomCanvas.height = this.zoomSize;
        zctx.clearRect(0, 0, this.zoomSize, this.zoomSize);
        this.detail.append(h('p', { className: 'hint', textContent: '在左侧画布点选一个像素查看采样布点。' }));
        return;
      }
      const pixel = out.pixels[selected.py][selected.px];
      this.drawZoom(scene, out, selected.px, selected.py);
      this.detail.append(this.summaryBlock(scene, pixel));
      for (const s of pixel.samples) this.detail.append(this.sampleBlock(scene, s));
      this.detail.append(this.blendBlock(pixel));
    }

    private drawZoom(scene: SceneConfig, out: RasterOutput, px: number, py: number): void {
      const size = this.zoomSize;
      this.zoomCanvas.width = size;
      this.zoomCanvas.height = size;
      const ctx = this.zoomCanvas.getContext('2d')!;
      ctx.clearRect(0, 0, size, size);
      const toX = (wx: number) => (wx - px) * size;
      const toY = (wy: number) => (wy - py) * size;

      // 背景与最终像素色（取整后即帧缓冲值）
      ctx.fillStyle = rgbToCss(scene.background);
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = rgbToCss(out.pixels[py][px].final);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, 0, size, size);
      ctx.globalAlpha = 1;

      // 裁剪到像素方块，画各三角形在本像素内的覆盖区域（用 Path2D 填充半透明色）
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.clip();
      for (const t of scene.triangles) {
        if (!t.enabled) continue;
        const d = out.diagnoses.get(t.id);
        if (!d || !d.normalized) continue;
        const v = d.normalized;
        ctx.beginPath();
        ctx.moveTo(toX(v[0].x), toY(v[0].y));
        ctx.lineTo(toX(v[1].x), toY(v[1].y));
        ctx.lineTo(toX(v[2].x), toY(v[2].y));
        ctx.closePath();
        ctx.fillStyle = rgbToCss(t.color);
        ctx.globalAlpha = 0.28;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();

      // 采样点：用胜出面颜色填点，描边表示覆盖/背景
      const pixel = out.pixels[py][px];
      for (const s of pixel.samples) {
        const cx = s.point.ox * size;
        const cy = s.point.oy * size;
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fillStyle = rgbToCss(s.color);
        ctx.fill();
        ctx.strokeStyle = s.winnerId ? '#57e389' : 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s.point.label, cx, cy + 0.5);
      }

      // 边框与坐标标注
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(4, 4, 96, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`像素 (${px}, ${py})`, 10, 18);
    }

    private summaryBlock(scene: SceneConfig, pixel: PixelResult): HTMLElement {
      const triCount = new Set(pixel.samples.flatMap((s) => s.candidates.map((c) => c.triId))).size;
      return h('div', { className: 'block' }, [
        h('div', { className: 'kv' }, [
          h('span', { textContent: `采样模式：${scene.sampleMode === 'center' ? '中心采样 ×1' : '旋转网格 ×4'}` }),
        ]),
        h('div', { className: 'kv' }, [
          h('span', {
            textContent: `候选面 ${triCount} 个 · 覆盖采样点 ${pixel.coveredCount}/${pixel.samples.length}`,
          }),
        ]),
      ]);
    }

    private sampleBlock(scene: SceneConfig, s: SampleResult): HTMLElement {
      const winner = s.winnerId ? scene.triangles.find((t) => t.id === s.winnerId) : null;
      const head = h('div', { className: 'sample-head' }, [
        h('strong', { textContent: `采样点 ${s.point.label}` }),
        h('span', { className: 'mono', textContent: `(${fmt(s.point.ox)}, ${fmt(s.point.oy)})` }),
        swatch(s.color, '该采样点最终颜色'),
        h(
          'span',
          { className: s.winnerId ? 'tag tag-win' : 'tag tag-bg' },
          [s.winnerId ? `胜出：${winner?.name ?? s.winnerId}（depth=${winner?.depth.toFixed(2)}）` : '背景'],
        ),
      ]);

      const rows: HTMLElement[] = [];
      if (s.candidates.length === 0) {
        rows.push(h('div', { className: 'row muted', textContent: '无面覆盖（所有边函数判定均在外侧）。' }));
      }
      const triById = new Map(scene.triangles.map((t) => [t.id, t]));
      for (const c of s.candidates) {
        const t = triById.get(c.triId)!;
        const won = s.winnerId === c.triId;
        const ev = c.edgeValues.map((v) => fmt(v, 2)).join(', ');
        rows.push(
          h('div', { className: `row ${won ? 'row-win' : 'row-lose'}` }, [
            swatch(t.color),
            h('span', { className: 'tri-name', textContent: t.name }),
            h('span', { className: 'mono', textContent: `depth=${t.depth.toFixed(2)}` }),
            h('span', { className: 'mono edgevals', textContent: `边函数 E=[${ev}]` }),
            h('span', { className: `tag ${won ? 'tag-win' : 'tag-lose'}` }, [
              won ? '深度胜' : '深度负',
            ]),
          ]),
        );
      }
      return h('div', { className: 'block sample-block' }, [head, ...rows]);
    }

    private blendBlock(pixel: PixelResult): HTMLElement {
      const dStored = channelDelta(pixel.blendedStored, pixel.blendedLinear);
      const make = (title: string, c: RGB, desc: string, active: boolean) =>
        h('div', { className: `blend-item ${active ? 'blend-active' : ''}` }, [
          h('div', { className: 'blend-title', textContent: title }),
          swatch(c),
          h('div', { className: 'blend-meta' }, [
            h('div', { textContent: rgbToHex(c) }),
            h('div', { className: 'mono', textContent: `rgb(${toByteChannel(c.r)}, ${toByteChannel(c.g)}, ${toByteChannel(c.b)})` }),
            h('div', { className: 'hint', textContent: desc }),
          ]),
        ]);
      return h('div', { className: 'block' }, [
        h('h4', { textContent: '像素颜色合并对比' }),
        make(
          '直接混合存储值',
          pixel.blendedStored,
          '对 sRGB 编码值直接算术平均。编码函数是凹的，暗背景上的边缘会被压暗、发闷。',
          false,
        ),
        make(
          '按亮度线性混合',
          pixel.blendedLinear,
          '先解码到线性光再平均、重新编码；暗背景上的边缘比直接平均更亮，过渡符合物理直觉。',
          false,
        ),
        h('div', { className: 'kv mono delta' }, [
          h('span', {
            textContent: `两法差（8位通道）: ΔR=${dStored.dr} ΔG=${dStored.dg} ΔB=${dStored.db}`,
          }),
        ]),
      ]);
    }
  }
}
