namespace SamplerLab {
  interface PreparedTri {
    tri: Triangle;
    v: [Vec2, Vec2, Vec2];
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  }

  export interface RasterOutput {
    width: number;
    height: number;
    mode: SampleMode;
    points: SamplePoint[];
    pixels: PixelResult[][];
    diagnoses: Map<string, TriDiagnosis>;
    sharedEdges: SharedEdgeInfo[];
  }

  function prepare(scene: SceneConfig): { list: PreparedTri[]; diagnoses: Map<string, TriDiagnosis> } {
    const diagnoses = new Map<string, TriDiagnosis>();
    const list: PreparedTri[] = [];
    for (const t of scene.triangles) {
      const d = diagnoseTriangle(t);
      diagnoses.set(t.id, d);
      if (t.enabled && d.normalized) {
        list.push({ tri: t, v: d.normalized, bounds: triBounds(d.normalized) });
      }
    }
    return { list, diagnoses };
  }

  function resolvePixel(
    px: number,
    py: number,
    points: SamplePoint[],
    prepared: PreparedTri[],
    scene: SceneConfig,
  ): PixelResult {
    const samples: SampleResult[] = points.map((point, index) => {
      const s = v2(px + point.ox, py + point.oy);
      const candidates: SampleCoverage[] = [];
      for (const pt of prepared) {
        const { inside, edges } = pointInTriangle(pt.v, s);
        if (inside) {
          candidates.push({
            triId: pt.tri.id,
            edgeValues: [edges[0].value, edges[1].value, edges[2].value],
          });
        }
      }
      // 深度测试：depth 小者胜；平手时取列表中靠后的三角形（顺序即 id 顺序，结果确定可重放）
      let winner: PreparedTri | null = null;
      for (const pt of prepared) {
        if (!candidates.some((c) => c.triId === pt.tri.id)) continue;
        if (winner === null || pt.tri.depth < winner.tri.depth) winner = pt;
      }
      return {
        index,
        point,
        candidates,
        winnerId: winner ? winner.tri.id : null,
        color: winner ? cloneRGB(winner.tri.color) : cloneRGB(scene.background),
      };
    });

    const covered = samples.map((s) => s.winnerId !== null);
    const blendedStored = blendStored({
      sampleColors: samples.map((s) => s.color),
      covered,
      background: scene.background,
    });
    const blendedLinear = blendLinear({
      sampleColors: samples.map((s) => s.color),
      covered,
      background: scene.background,
    });
    return {
      px,
      py,
      samples,
      blendedStored,
      blendedLinear,
      final: scene.blendMode === 'stored' ? blendedStored : blendedLinear,
      coveredCount: covered.filter(Boolean).length,
    };
  }

  export function rasterize(scene: SceneConfig): RasterOutput {
    const { list, diagnoses } = prepare(scene);
    const points = samplePoints(scene.sampleMode);
    const pixels: PixelResult[][] = [];
    for (let py = 0; py < scene.height; py++) {
      const row: PixelResult[] = [];
      for (let px = 0; px < scene.width; px++) {
        // 包围盒快速跳过：没有任何三角形与该像素方块相交时直接给全背景结果
        const hit = list.some(
          (pt) =>
            pt.bounds.maxX >= px &&
            pt.bounds.minX <= px + 1 &&
            pt.bounds.maxY >= py &&
            pt.bounds.minY <= py + 1,
        );
        row.push(hit ? resolvePixel(px, py, points, list, scene) : resolvePixel(px, py, points, [], scene));
      }
      pixels.push(row);
    }
    return {
      width: scene.width,
      height: scene.height,
      mode: scene.sampleMode,
      points,
      pixels,
      diagnoses,
      sharedEdges: findSharedEdges(scene.triangles, diagnoses),
    };
  }

  /** 生成可直接画到 canvas 的低分辨率帧缓冲 */
  export function toFramebuffer(out: RasterOutput): ImageData {
    const img = new ImageData(out.width, out.height);
    for (let py = 0; py < out.height; py++) {
      for (let px = 0; px < out.width; px++) {
        const c = out.pixels[py][px].final;
        const k = (py * out.width + px) * 4;
        img.data[k] = toByteChannel(c.r);
        img.data[k + 1] = toByteChannel(c.g);
        img.data[k + 2] = toByteChannel(c.b);
        img.data[k + 3] = 255;
      }
    }
    return img;
  }

  // ---------- 像素记录序列化（需求 5） ----------

  export function serializePixel(scene: SceneConfig, out: RasterOutput, px: number, py: number): SerializedPixel {
    const pixel = out.pixels[py][px];
    const triById = new Map(scene.triangles.map((t) => [t.id, t]));
    return {
      px,
      py,
      candidates: pixel.samples
        .flatMap((s) => s.candidates.map((c) => c.triId))
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .map((id) => {
          const t = triById.get(id)!;
          return {
            triId: id,
            name: t.name,
            depth: t.depth,
            color: cloneRGB(t.color),
            coveredSamples: pixel.samples.filter((s) => s.candidates.some((c) => c.triId === id)).map((s) => s.index),
          };
        }),
      samples: pixel.samples.map((s) => ({
        label: s.point.label,
        ox: s.point.ox,
        oy: s.point.oy,
        winnerId: s.winnerId,
        winnerDepth: s.winnerId === null ? null : triById.get(s.winnerId)!.depth,
        color: cloneRGB(s.color),
        coveredBy: s.candidates.map((c) => c.triId),
      })),
      blendedStored: cloneRGB(pixel.blendedStored),
      blendedLinear: cloneRGB(pixel.blendedLinear),
      final: cloneRGB(pixel.final),
    };
  }

  export function buildPixelRecord(scene: SceneConfig, out: RasterOutput, px: number, py: number): PixelRecord {
    return {
      format: 'sampling-lab-pixel',
      version: 1,
      savedAt: new Date().toISOString(),
      scene: cloneScene(scene),
      selectedPixel: { px, py },
      pixel: serializePixel(scene, out, px, py),
    };
  }

  export function cloneScene(scene: SceneConfig): SceneConfig {
    return JSON.parse(JSON.stringify(scene)) as SceneConfig;
  }
}
