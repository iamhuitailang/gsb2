namespace SamplerLab {
  // ---------- 采样点布局（教学用固定布局，不代表任何具体 GPU 的真实位置） ----------

  const CENTER: SamplePoint[] = [{ ox: 0.5, oy: 0.5, label: 'C' }];

  /** 四点旋转网格(Rotated Grid)，常见 MSAA 4x 教学布局 */
  const MSAA4: SamplePoint[] = [
    { ox: 0.375, oy: 0.125, label: 'S0' },
    { ox: 0.875, oy: 0.375, label: 'S1' },
    { ox: 0.125, oy: 0.625, label: 'S2' },
    { ox: 0.625, oy: 0.875, label: 'S3' },
  ];

  export function samplePoints(mode: SampleMode): SamplePoint[] {
    return mode === 'center' ? CENTER : MSAA4.map((p) => ({ ...p }));
  }

  // ---------- 绕序归一化与诊断 ----------

  export function diagnoseTriangle(t: Triangle): TriDiagnosis {
    const v = t.v;
    const duplicatePairs: number[][] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        if (epsEqualV(v[i], v[j], 1e-9)) duplicatePairs.push([i, j]);
      }
    }

    const signedArea2 = cross2(v[0], v[1], v[2]);
    const aEps = areaEpsilon(v);
    const messages: string[] = [];
    let kind: TriIssueKind = 'ok';
    let normalized: [Vec2, Vec2, Vec2] | null = null;

    if (duplicatePairs.length > 0) {
      kind = 'duplicate-vertex';
      messages.push(
        `存在重复顶点（顶点对 ${duplicatePairs.map((p) => p.join(' 与 ')).join('；')}），三角形退化，不参与光栅化。`,
      );
    } else if (Math.abs(signedArea2) <= aEps) {
      kind = 'degenerate-area';
      messages.push(
        `面积接近零（|2·面积|=${signedArea2.toExponential(2)}，容差 ${aEps.toExponential(2)}），视为退化三角形，不参与光栅化。薄三角请把宽度保持在半个采样间距以上才能稳定被采到。`,
      );
    } else {
      if (signedArea2 > 0) {
        normalized = [cloneV(v[0]), cloneV(v[1]), cloneV(v[2])];
        messages.push('顶点顺序为逆时针(CCW)，直接采用。');
      } else {
        kind = 'reversed-winding';
        normalized = [cloneV(v[0]), cloneV(v[2]), cloneV(v[1])];
        messages.push(
          '顶点顺序为顺时针(CW，屏幕坐标 y 向下时 signedArea<0)，已自动交换第 2、3 个顶点归一化为 CCW 再光栅化；面本身不剔除，但共享边的遍历方向也会随之翻转。',
        );
      }
    }

    return { triId: t.id, kind, signedArea2, normalized, duplicatePairs, messages };
  }

  // ---------- 半开填充规则 ----------

  /**
   * 有向边 p->q 在点 s 处的边函数 cross(q-p, s-p)。
   * CCW 三角形内部满足三条边 E 均为正。
   */
  export function edgeFunc(p: Vec2, q: Vec2, s: Vec2): number {
    return (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x);
  }

  /**
   * 左上填充规则（CCW 归一化后）：
   *  - 左边：dy < 0（边向上走），含边界
   *  - 上边：dy == 0 且 dx > 0（水平向右走），含边界
   *  - 其余边为开放边，落在边上的点不算在内
   * 共用一条边的两个 CCW 三角形必然沿相反方向遍历该边，于是边上的点恰好只被一边收下。
   */
  function edgeIsInclusive(p: Vec2, q: Vec2): boolean {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    return dy < -1e-9 || (Math.abs(dy) <= 1e-9 && dx > 1e-9);
  }

  function edgeTolerance(p: Vec2, q: Vec2, s: Vec2): number {
    const scale =
      Math.abs(q.x - p.x) + Math.abs(q.y - p.y) + Math.abs(s.x) + Math.abs(s.y) + 1;
    return 1e-7 * scale;
  }

  export interface EdgeTest {
    value: number;
    inclusive: boolean;
    inside: boolean;
  }

  /** 点 s 对归一化 CCW 三角形三条边的逐项判定，供检查器展示 */
  export function testEdges(v: [Vec2, Vec2, Vec2], s: Vec2): EdgeTest[] {
    const edges: [Vec2, Vec2][] = [
      [v[0], v[1]],
      [v[1], v[2]],
      [v[2], v[0]],
    ];
    return edges.map(([p, q]) => {
      const value = edgeFunc(p, q, s);
      const inclusive = edgeIsInclusive(p, q);
      const eps = edgeTolerance(p, q, s);
      const inside = inclusive ? value >= -eps : value > eps;
      return { value, inclusive, inside };
    });
  }

  export function pointInTriangle(v: [Vec2, Vec2, Vec2], s: Vec2): { inside: boolean; edges: EdgeTest[] } {
    const edges = testEdges(v, s);
    return { inside: edges.every((e) => e.inside), edges };
  }

  // ---------- 共享边分析 ----------

  export function findSharedEdges(tris: Triangle[], diagnoses: Map<string, TriDiagnosis>): SharedEdgeInfo[] {
    const result: SharedEdgeInfo[] = [];
    const live = tris.filter((t) => t.enabled && diagnoses.get(t.id)?.normalized);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const va = diagnoses.get(a.id)!.normalized!;
        const vb = diagnoses.get(b.id)!.normalized!;
        const edgesA: [Vec2, Vec2][] = [
          [va[0], va[1]],
          [va[1], va[2]],
          [va[2], va[0]],
        ];
        const edgesB: [Vec2, Vec2][] = [
          [vb[0], vb[1]],
          [vb[1], vb[2]],
          [vb[2], vb[0]],
        ];
        for (const [pa, qa] of edgesA) {
          for (const [pb, qb] of edgesB) {
            const sameDir = epsEqualV(pa, pb, 1e-6) && epsEqualV(qa, qb, 1e-6);
            const oppDir = epsEqualV(pa, qb, 1e-6) && epsEqualV(qa, pb, 1e-6);
            if (!sameDir && !oppDir) continue;
            const exact = epsEqualV(pa, sameDir ? pb : qb, 1e-9) && epsEqualV(qa, sameDir ? qb : pb, 1e-9);
            const note = oppDir
              ? '两三角形沿相反方向遍历共用边：半开规则保证边上采样点恰好被一侧覆盖，不重不漏。'
              : '两三角形沿相同方向遍历共用边（几何上二者位于边的同一侧或绕序未正确相对）：边上的点会同时落入或同时落空，需要让其中一个三角形翻转顶点顺序。';
            result.push({
              triA: a.id,
              triB: b.id,
              a: cloneV(pa),
              b: cloneV(qa),
              oppositeDirection: oppDir,
              exact,
              note,
            });
          }
        }
      }
    }
    return result;
  }
}
