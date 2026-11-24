namespace SamplerLab {
  // ---------- 平移重放 ----------
  // 轨迹只存「基底快照 + 逐步增量」，回放时按顺序应用同样的浮点加法，
  // 不依赖 requestAnimationFrame 时序，因此任何机器上结果完全一致。

  export function emptyTrack(): ReplayTrack {
    return { base: [], steps: [] };
  }

  /** 开始录制：把当前所有三角形顶点固化为基底 */
  export function beginTrack(scene: SceneConfig): void {
    scene.track = {
      base: scene.triangles.map((t) => ({
        triId: t.id,
        v: t.v.map((p) => cloneV(p)) as [Vec2, Vec2, Vec2],
      })),
      steps: [],
    };
  }

  export function hasTrack(scene: SceneConfig): boolean {
    return scene.track.base.length > 0;
  }

  /** 录制中追加一次平移（顶点手动编辑会清空轨迹） */
  export function recordMove(scene: SceneConfig, triId: string, dx: number, dy: number): void {
    if (!hasTrack(scene)) beginTrack(scene);
    const t = scene.triangles.find((x) => x.id === triId);
    if (!t) return;
    t.v = t.v.map((p) => v2(round6(p.x + dx), round6(p.y + dy))) as [Vec2, Vec2, Vec2];
    scene.track.steps.push({ triId, dx, dy });
  }

  /** 非录制状态下的直接平移，不写轨迹 */
  export function nudgeNow(scene: SceneConfig, triId: string, dx: number, dy: number): void {
    const t = scene.triangles.find((x) => x.id === triId);
    if (!t) return;
    t.v = t.v.map((p) => v2(round6(p.x + dx), round6(p.y + dy))) as [Vec2, Vec2, Vec2];
  }

  /** 顶点手动编辑：轨迹已无法描述当前状态，作废 */
  export function invalidateTrack(scene: SceneConfig): void {
    scene.track = emptyTrack();
  }

  /** 回到基底并回放前 frame 步（frame 可超出长度，表示停在最后一步） */
  export function replayToFrame(scene: SceneConfig, frame: number): number {
    if (!hasTrack(scene)) return 0;
    for (const snap of scene.track.base) {
      const t = scene.triangles.find((x) => x.id === snap.triId);
      if (t) t.v = snap.v.map((p) => cloneV(p)) as [Vec2, Vec2, Vec2];
    }
    const upto = Math.max(0, Math.min(frame, scene.track.steps.length));
    for (let i = 0; i < upto; i++) {
      const step = scene.track.steps[i];
      const t = scene.triangles.find((x) => x.id === step.triId);
      if (t) t.v = t.v.map((p) => v2(round6(p.x + step.dx), round6(p.y + step.dy))) as [Vec2, Vec2, Vec2];
    }
    return upto;
  }

  export function trackLength(scene: SceneConfig): number {
    return scene.track.steps.length;
  }

  /** 防止浮点漂移累积：所有顶点坐标保留 6 位小数 */
  function round6(x: number): number {
    return Math.round(x * 1e6) / 1e6;
  }
}
