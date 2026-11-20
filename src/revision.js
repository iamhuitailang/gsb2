/* 修订版对照：抽取两版全部帧的画面指纹，用带增删（gap）的动态规划做单调对齐，
 * 再把每条意见从旧时间轴迁移到新时间轴。
 *  - NCC ≥ 0.85 视为高置信，自动迁移；
 *  - 0.60..0.85 或命中增删区间 → 待人工确认；
 *  - 无法对应（gap 对齐）→ 放在最近的 gap 边界并标红待确认。 */
'use strict';

const Revision = {
  GAP_PENALTY: 0.35,   // 每跳过一帧的代价（NCC 满分为 1）
  CONF_AUTO: 0.85,
  CONF_SOFT: 0.60,

  /** 帧级单调对齐。oldSigs/ newSigs: Float32Array[]。返回 { mapOldToNew, mapNewToOld, scores } */
  align(oldSigs, newSigs) {
    const n = oldSigs.length, m = newSigs.length;
    const NEG = -1e9;
    // DP 表 + 回溯方向（0=匹配, 1=旧侧gap即新帧插入, 2=新侧gap即旧帧删除）
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const bt = new Uint8Array((n + 1) * (m + 1));
    const idx = (i, j) => i * (m + 1) + j;

    for (let i = 1; i <= n; i++) { dp[i][0] = -i * this.GAP_PENALTY; bt[idx(i, 0)] = 2; }
    for (let j = 1; j <= m; j++) { dp[0][j] = -j * this.GAP_PENALTY; bt[idx(0, j)] = 1; }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const score = Thumbnails.ncc(oldSigs[i - 1], newSigs[j - 1]);
        const match = dp[i - 1][j - 1] + score;
        const ins = dp[i][j - 1] - this.GAP_PENALTY;     // 新视频多了一帧
        const del = dp[i - 1][j] - this.GAP_PENALTY;     // 新视频少了一帧
        if (match >= ins && match >= del) {
          dp[i][j] = match; bt[idx(i, j)] = 0;
        } else if (ins >= del) {
          dp[i][j] = ins; bt[idx(i, j)] = 1;
        } else {
          dp[i][j] = del; bt[idx(i, j)] = 2;
        }
      }
    }

    const mapOldToNew = new Array(n).fill(null);
    const mapNewToOld = new Array(m).fill(null);
    const scores = new Array(n).fill(null);
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const dir = bt[idx(i, j)];
      if (dir === 0) {
        mapOldToNew[i - 1] = j - 1;
        mapNewToOld[j - 1] = i - 1;
        scores[i - 1] = Thumbnails.ncc(oldSigs[i - 1], newSigs[j - 1]);
        i--; j--;
      } else if (dir === 1) {
        j--;
      } else {
        i--;
      }
    }

    // gap 兜底：未匹配的旧帧找最近的新帧边界，供人工确认时定位
    for (let k = 0; k < n; k++) {
      if (mapOldToNew[k] == null) {
        let lo = k - 1, hi = k;
        while (lo >= 0 && mapOldToNew[lo] == null) lo--;
        while (hi < n && mapOldToNew[hi] == null) hi++;
        const left = lo >= 0 ? mapOldToNew[lo] + 1 : 0;
        const right = hi < n ? mapOldToNew[hi] : m - 1;
        mapOldToNew[k] = clamp(Math.round((left + right) / 2), 0, m - 1);
        scores[k] = 0;
      }
    }
    return { mapOldToNew, mapNewToOld, scores };
  },

  /** 依据对齐结果生成意见映射 */
  mapComments(comments, alignment, newFrameCount) {
    const { mapOldToNew, scores } = alignment;
    return comments.map((c) => {
      const newStart = mapOldToNew[clamp(c.startFrame, 0, mapOldToNew.length - 1)] ?? 0;
      let newEnd = null;
      if (c.endFrame != null) {
        newEnd = mapOldToNew[clamp(c.endFrame, 0, mapOldToNew.length - 1)] ?? newStart;
        if (newEnd < newStart) newEnd = newStart;
      }
      const startScore = scores[clamp(c.startFrame, 0, scores.length - 1)] ?? 0;
      const endScore = c.endFrame != null
        ? scores[clamp(c.endFrame, 0, scores.length - 1)] ?? 0
        : startScore;
      const confidence = round3(Math.min(startScore, endScore));
      const method = confidence >= this.CONF_AUTO ? '画面自动匹配' : '画面匹配（低置信，需人工确认）';
      return {
        commentId: c.id,
        newStart: clamp(newStart, 0, newFrameCount - 1),
        newEnd: newEnd == null ? null : clamp(newEnd, 0, newFrameCount - 1),
        confidence,
        method,
      };
    });
  },
};
