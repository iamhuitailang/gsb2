/* UI 渲染：编辑器表格、面板、判定结果、轨迹、对照、检查点。 */
(function () {
  'use strict';

  const U = window.RTUI;
  const M = U.M;
  const J = U.J;
  const state = U.state;
  const el = U.el;
  const LANES = U.LANES;

  U.renderChartTitle = function () {
    if (document.activeElement !== el.chartTitle) el.chartTitle.value = state.chart.title;
  };

  U.renderSections = function () {
    const starts = M.sectionTimes(M.getSections(state.chart));
    el.sectionsTable.tBodies[0].innerHTML = state.chart.sections.map(function (s, i) {
      const first = i === 0;
      return '<tr data-index="' + i + '">'
        + '<td><input type="number" step="0.25" min="0" value="' + s.beat
        + '" data-field="beat"' + (first ? ' disabled title="第一段固定从 0 拍开始"' : '')
        + '></td>'
        + '<td><input type="number" step="1" min="20" max="400" value="' + s.bpm
        + '" data-field="bpm"></td>'
        + '<td><span class="sig-cell"><input type="number" min="1" max="16" step="1" value="'
        + s.sigNum + '" data-field="sigNum" aria-label="每小节拍数"><span>/</span>'
        + '<input type="number" min="1" max="16" step="1" value="' + s.sigDen
        + '" data-field="sigDen" aria-label="拍号分母"></span></td>'
        + '<td class="num">' + U.fmtSec(starts[i], 3) + '</td>'
        + '<td>' + (first ? '<span class="row-tag">起始</span>'
          : '<button type="button" class="icon-x" data-remove="' + i
            + '" title="删除变速点" aria-label="删除变速点">×</button>') + '</td></tr>';
    }).join('');
  };

  U.renderNotes = function () {
    const sorted = state.chart.notes.slice().sort(function (a, b) {
      return a.beat - b.beat || a.lane - b.lane;
    });
    if (!sorted.length) {
      el.notesTable.tBodies[0].innerHTML = '<tr><td colspan="6" class="hint"'
        + ' style="padding:12px 8px">还没有音符，点上面的「+ 单点 / + 长按」。</td></tr>';
      return;
    }
    el.notesTable.tBodies[0].innerHTML = sorted.map(function (n) {
      const idx = state.chart.notes.indexOf(n);
      const pos = M.barBeatLabel(state.chart, n.beat);
      const headT = M.secondsAtBeat(state.chart, n.beat);
      const laneOptions = LANES.map(function (l) {
        return '<option value="' + l + '"' + (l === n.lane ? ' selected' : '') + '>'
          + (l + 1) + '</option>';
      }).join('');
      return '<tr data-id="' + n.id + '">'
        + '<td><span class="type-tag">' + (n.type === 'hold' ? '长按' : '单点') + '</span></td>'
        + '<td><select data-field="lane" aria-label="轨道">' + laneOptions + '</select></td>'
        + '<td><input type="number" step="0.0625" min="0" value="' + n.beat
        + '" data-field="beat" aria-label="拍"></td>'
        + '<td>' + (n.type === 'hold'
          ? '<input type="number" step="0.25" min="0.25" value="' + n.durBeats
            + '" data-field="durBeats" aria-label="时值（拍）">'
          : '<span class="row-tag">—</span>') + '</td>'
        + '<td class="row-tag" title="' + U.esc(pos.label) + ' · ' + U.fmtSec(headT) + '">'
        + U.esc('第' + pos.bar + '小节·' + M.fmtBeat(pos.beatInBar) + '拍') + '</td>'
        + '<td><button type="button" class="icon-x" data-remove="' + idx
        + '" title="删除音符" aria-label="删除音符">×</button></td></tr>';
    }).join('');
  };

  U.renderIssues = function () {
    const v = M.validateChart(state.chart);
    const issues = v.issues.slice();
    if (!issues.length) issues.push({ level: 'ok', message: '拍号、变速与音符顺序均有效。' });
    el.issuesList.innerHTML = issues.map(function (i) {
      return '<li data-level="' + i.level + '">' + U.esc(i.message) + '</li>';
    }).join('');
    el.issuesPill.textContent = v.ok ? '有效' : '有错误';
    el.issuesPill.className = 'pill ' + (v.ok ? 'ok' : 'bad');
  };

  U.renderWindowsEditor = function () {
    el.windowsBody.innerHTML = ['A', 'B'].map(function (k) {
      const w = state.windows[k];
      const fields = [
        ['perfectMs', w.perfectMs], ['earlyMs', w.earlyMs],
        ['lateMs', w.lateMs], ['releaseGraceMs', w.releaseGraceMs],
      ];
      return '<tr data-key="' + k + '">'
        + '<td><span class="win-dot" style="background:var(--win-' + k.toLowerCase()
        + ')"></span>' + U.esc(w.name) + '</td>'
        + fields.map(function (f) {
          return '<td><input type="number" min="0" step="5" value="' + f[1]
            + '" data-field="' + f[0] + '"></td>';
        }).join('')
        + '</tr>';
    }).join('');
  };

  U.renderHud = function (result) {
    el.hudScore.textContent = String(Math.round(result.score));
    el.hudMax.textContent = '/ ' + result.maxScore;
    el.hudCombo.textContent = String(result.combo);
    el.hudMaxcombo.textContent = '最高 ' + result.maxCombo;
  };

  U.renderPads = function () {
    LANES.forEach(function (lane) {
      const pad = document.querySelector('.pad[data-lane="' + lane + '"]');
      if (!pad) return;
      const em = pad.querySelector('em');
      if (em) {
        const n = state.events.filter(function (e) {
          return e.lane === lane && e.kind === 'press' && e.source === 'live';
        }).length;
        em.textContent = n + ' 次';
      }
      const holding = state.liveResult && state.liveResult.active
        ? Object.keys(state.liveResult.active).some(function (id) {
          return state.liveResult.active[id].lane === lane;
        })
        : false;
      pad.classList.toggle('is-holding', holding);
    });
  };

  U.flash = function (text, tone) {
    el.hudFlash.textContent = text;
    el.hudFlash.style.color = tone === 'miss'
      ? U.cssVar('--s-miss')
      : tone === 'early' ? U.cssVar('--s-early')
        : tone === 'late' ? U.cssVar('--s-late') : U.cssVar('--s-success');
    el.hudFlash.classList.add('show');
    clearTimeout(U.flash._t);
    U.flash._t = setTimeout(function () { el.hudFlash.classList.remove('show'); }, 550);
  };

  U.renderNowLine = function () {
    const t = state.playhead;
    const beat = M.beatAtSeconds(state.chart, t);
    const pos = M.barBeatLabel(state.chart, beat);
    const s = pos.section;
    el.nowBar.textContent = pos.label;
    el.nowSub.textContent = s.bpm + ' BPM · ' + s.sigNum + '/' + s.sigDen + ' · '
      + U.fmtSec(t) + ' · ' + M.fmtBeat(beat) + ' 拍';
    el.clock.textContent = U.fmtSec(t);
  };

  U.renderResults = function (result) {
    const w = U.activeWindows();
    el.resultSummary.textContent = J.summaryLine(result);
    el.resultSub.textContent = '分数 ' + Math.round(result.score) + ' / ' + result.maxScore
      + ' · 准确率 ' + (result.accuracy * 100).toFixed(1) + '% · 最高连击 '
      + result.maxCombo + ' · 窗口 ' + w.name;

    const rows = result.noteList.map(function (r) {
      const head = r.head;
      let detail = '';
      if (r.type === 'hold') {
        if (!head) detail = '未开始';
        else if (head.state === 'miss') detail = '头部超时（超过 +' + w.lateMs + ' ms）';
        else if (!r.tail) detail = '按住中 · 尾部 ' + U.fmtSec(r.tailTime);
        else if (r.tail.state === 'complete') {
          detail = '尾部完成（' + (r.tail.via === 'auto' ? '按到末尾自动' : '宽限内松开') + '）';
        } else if (r.tail.state === 'earlyRelease') {
          detail = '提前松开 · 距尾部还有 ' + Math.round(r.tail.remainingMs) + ' ms';
        }
      } else if (head && head.state === 'miss') {
        detail = '在 +' + w.lateMs + ' ms 内无输入';
      }
      const score = head && head.state === 'hit'
        ? head.points + (r.tail && r.tail.state === 'complete' ? J.POINTS.holdBonus : 0)
        : 0;
      const headDelta = head && head.state === 'hit' ? head.dtMs : null;
      const overall = r.overall || 'pending';
      return '<tr>'
        + '<td><span class="id-chip">' + U.esc(r.id) + '</span></td>'
        + '<td>' + (r.type === 'hold' ? '长按' : '单点') + '</td>'
        + '<td class="num">' + U.esc(M.barBeatLabel(state.chart, r.beat).label) + '</td>'
        + '<td class="num">' + U.fmtSec(r.headTime)
        + (r.type === 'hold'
          ? '<br><span class="row-tag">→ ' + U.fmtSec(r.tailTime) + '</span>' : '') + '</td>'
        + '<td><span class="state" data-s="' + overall + '">' + U.esc(U.labelOf(overall))
        + '</span></td>'
        + '<td class="num">' + (headDelta == null ? '—' : U.fmtMs(headDelta))
        + (r.tail && r.tail.state === 'earlyRelease'
          ? '<br><span class="row-tag">尾 ' + U.fmtMs(r.tail.deltaMs) + '</span>' : '') + '</td>'
        + '<td class="num">' + score + '</td>'
        + '<td class="wrap hint">' + U.esc(detail) + '</td></tr>';
    }).join('');
    el.resultsTable.tBodies[0].innerHTML = rows
      || '<tr><td colspan="8" class="hint" style="padding:12px 8px">谱面还没有音符。</td></tr>';

    const stray = result.stray || [];
    el.strayList.innerHTML = stray.length
      ? stray.map(function (s) {
        return '<li>' + U.fmtSec(s.t) + ' · 轨道 ' + (s.lane + 1) + ' · '
          + (s.reason === 'lane-held' ? '长按占用中' : '无目标') + '</li>';
      }).join('')
      : '<li class="empty">无。正常抬手不计入杂散输入。</li>';
  };

  U.renderTrace = function (result) {
    const traces = result.traces || [];
    el.traceTable.tBodies[0].innerHTML = traces.length
      ? traces.map(function (tr) {
        const cands = (tr.candidates || []).map(function (c) {
          let reason;
          if (c.chosen) reason = '命中';
          else if (c.reason === 'ok') reason = '较远';
          else if (c.reason === 'consumed') reason = '已消费';
          else if (c.reason === 'missed') reason = '已判漏拍';
          else if (c.reason === 'missing') reason = '不存在';
          else reason = '超窗';
          return '<span class="cand' + (c.chosen ? ' ok' : '') + '">'
            + U.esc(c.noteId) + ' · ' + U.fmtDelta(c.dtMs) + 'ms · ' + U.esc(reason)
            + (c.lostTo ? ' → ' + U.esc(c.lostTo) : '') + '</span>';
        }).join(' ');
        const out = tr.outcome === 'stray' || tr.outcome === 'no-target'
          ? '无命中（杂散）'
          : tr.outcome === 'lane-held' ? '轨道占用，忽略'
            : tr.outcome === 'idle-release' ? '空抬手（正常）'
              : U.labelOf(tr.outcome);
        const fallback = tr.kind === 'release'
          ? '<span class="hint">抬起不参与选择</span>'
          : '<span class="hint">轨道内无候选</span>';
        return '<tr>'
          + '<td class="num">' + U.fmtSec(tr.t) + '</td>'
          + '<td>' + (tr.lane + 1) + '</td>'
          + '<td>' + (tr.kind === 'release' ? '抬起 · ' : '按下 · ') + U.esc(out) + '</td>'
          + '<td class="num">' + (tr.noteId ? U.esc(tr.noteId) : '—') + '</td>'
          + '<td class="wrap">' + (cands || fallback) + '</td></tr>';
      }).join('')
      : '<tr><td colspan="5" class="hint" style="padding:12px 8px">还没有输入。'
        + '用 D / F / J / K 或下方按键区模拟。</td></tr>';
  };

  U.chip = function (value) {
    const allowed = ['success', 'early', 'late', 'miss', 'earlyRelease',
      'complete', 'holding', 'pending'];
    const cls = allowed.indexOf(value) >= 0 ? value : 'pending';
    return '<span class="state" data-s="' + cls + '">' + U.esc(U.labelOf(value)) + '</span>';
  };

  U.renderCompare = function () {
    const cmp = J.compareWindows(state.chart, state.events,
      state.windows.A, state.windows.B, state.biasMs, { endTime: U.chartEnd() });
    state.lastCompare = cmp;

    const rows = el.onlyDivergent.checked ? cmp.rows : cmp.allRows;
    el.compareStats.innerHTML = '分歧 <b>' + cmp.divergentNoteIds.length + '</b> 个音符 · 表中 '
      + rows.length + ' / ' + cmp.allRows.length + ' 行';

    el.windowCards.innerHTML = ['A', 'B'].map(function (k) {
      const w = state.windows[k];
      const res = k === 'A' ? cmp.a : cmp.b;
      return '<div class="window-card">'
        + '<header><span class="dot" style="background:var(--win-' + k.toLowerCase()
        + ')"></span>' + U.esc(w.name) + ' · ' + Math.round(res.score) + ' 分</header>'
        + '<div class="wc-line">成功 ±' + w.perfectMs + ' · 早 −' + w.earlyMs
        + ' · 晚 +' + w.lateMs + ' · 尾宽限 ' + w.releaseGraceMs + ' ms</div>'
        + '<div class="wc-counts">' + U.esc(J.summaryLine(res)) + '</div></div>';
    }).join('');

    el.compareTable.tBodies[0].innerHTML = rows.length
      ? rows.map(function (r) {
        const time = r.part === 'tail' ? r.tailTime : r.headTime;
        return '<tr' + (r.divergent ? ' class="is-divergent"' : '') + '>'
          + '<td>' + (r.divergent
            ? '<span class="legend-badge" title="A/B 分歧">≠</span>' : '') + '</td>'
          + '<td><span class="id-chip">' + U.esc(r.noteId) + '</span></td>'
          + '<td>' + (r.part === 'tail' ? '长按尾' : '头部') + '</td>'
          + '<td class="num">' + U.fmtSec(time) + '</td>'
          + '<td class="num">' + U.fmtMs(r.rawMs) + '</td>'
          + '<td class="num">' + U.fmtMs(r.effMs) + '</td>'
          + '<td>' + U.chip(r.a) + '</td>'
          + '<td>' + U.chip(r.b) + '</td></tr>';
      }).join('')
      : '<tr><td colspan="8" class="hint" style="padding:12px 8px">'
        + '两套窗口结论完全一致，没有分歧音符。把输入偏差拖到边缘附近试试。</td></tr>';
  };

  U.snapshotSummary = function (time) {
    const snap = J.snapshotAt(state.chart, U.effectiveEvents(), U.activeWindows(), time);
    let done = 0;
    let holding = 0;
    Object.keys(snap.results).forEach(function (id) {
      const r = snap.results[id];
      if (r.head) done += 1;
      if (r.head && r.head.state === 'hit' && r.type === 'hold' && !r.tail) holding += 1;
    });
    return '已判 ' + done + ' 个音符' + (holding ? '，按住中 ' + holding : '')
      + '，连击 ' + snap.combo + '，' + snap.score + ' 分';
  };

  U.renderCheckpoints = function () {
    const cps = state.checkpoints.slice().sort(function (a, b) { return a.time - b.time; });
    el.cpList.innerHTML = cps.length ? cps.map(function (cp) {
      const pos = M.barBeatLabel(state.chart, M.beatAtSeconds(state.chart, cp.time));
      const cid = U.esc(cp.id);
      return '<div class="cp-row" data-id="' + cid + '">'
        + '<span class="cp-time">' + U.fmtSec(cp.time) + '</span>'
        + '<span class="cp-desc">' + U.esc(cp.label || pos.label) + ' · '
        + U.esc(U.snapshotSummary(cp.time)) + '</span>'
        + '<div class="cp-actions">'
        + '<button type="button" class="btn btn-sm" data-cp-replay="' + cid
        + '">从检查点重放</button>'
        + '<button type="button" class="btn btn-sm btn-ghost" data-cp-jump="' + cid
        + '">跳到此</button>'
        + '<button type="button" class="btn btn-sm btn-ghost" data-cp-del="' + cid
        + '" aria-label="删除检查点">×</button>'
        + '</div></div>';
    }).join('')
      : '<div class="cp-empty">还没有检查点。播放到变速点或长按尾部附近，'
        + '点「在当前时刻设检查点」。</div>';

    const v = state.verify;
    el.verifyBadge.className = 'verify-badge' + (v ? (v.ok ? ' ok' : ' bad') : '');
    el.verifyBadge.textContent = v ? (v.ok ? '重放一致 ✓' : '重放不一致 ✕') : '—';
    if (!v) {
      el.replayDetail.innerHTML = '';
      return;
    }
    const items = v.items.map(function (it) {
      return '<div class="verify-item"><span class="vk">' + U.esc(it.k) + '</span>'
        + '<span class="vv ' + (it.ok ? 'ok' : 'bad') + '">' + U.esc(it.v)
        + '</span></div>';
    }).join('');
    el.replayDetail.innerHTML = '<h4>检查点 ' + U.fmtSec(v.fromTime)
      + ' 起重放 vs 整段判定</h4><div class="verify-grid">' + items + '</div>';
  };

  U.fingerprint = function (res) {
    return res.noteList.map(function (n) {
      return [
        n.id,
        n.overall || 'pending',
        n.head ? n.head.state + ':' + (n.head.tier || '') : '',
        n.tail ? n.tail.state : '',
      ].join('|');
    }).join(',');
  };

  U.verifyReplay = function (snapshot, fromTime) {
    const resumed = J.evaluate(state.chart, U.effectiveEvents(), U.activeWindows(), {
      from: snapshot,
      endTime: U.chartEnd(),
    });
    const full = U.computeFull();
    const scoreOk = resumed.score === full.score;
    const comboOk = resumed.maxCombo === full.maxCombo && resumed.combo === full.combo;
    const notesOk = U.fingerprint(resumed) === U.fingerprint(full);
    state.verify = {
      ok: scoreOk && comboOk && notesOk,
      fromTime: fromTime,
      items: [
        { k: '分数', v: resumed.score + ' / ' + full.score, ok: scoreOk },
        { k: '连击（当前 / 最高）', v: resumed.combo + '·' + resumed.maxCombo + ' / '
          + full.combo + '·' + full.maxCombo, ok: comboOk },
        { k: '每个音符结局', v: notesOk ? '完全一致' : '存在差异', ok: notesOk },
        { k: '重放起点', v: U.fmtSec(fromTime), ok: true },
      ],
    };
    U.toast(state.verify.ok ? '检查点重放一致' : '检查点重放不一致');
  };

  U.verifyAllCheckpoints = function () {
    const cps = state.checkpoints.slice().sort(function (a, b) { return a.time - b.time; });
    if (!cps.length) {
      state.verify = null;
      return;
    }
    const full = U.computeFull();
    const items = [];
    let ok = true;
    cps.forEach(function (cp) {
      const snap = J.snapshotAt(state.chart, U.effectiveEvents(), U.activeWindows(), cp.time);
      const resumed = J.evaluate(state.chart, U.effectiveEvents(), U.activeWindows(), {
        from: snap,
        endTime: U.chartEnd(),
      });
      const good = resumed.score === full.score
        && resumed.maxCombo === full.maxCombo
        && resumed.combo === full.combo
        && U.fingerprint(resumed) === U.fingerprint(full);
      ok = ok && good;
      items.push({
        k: '检查点 ' + U.fmtSec(cp.time),
        v: good ? '一致 · ' + resumed.score + ' 分 / 连击 ' + resumed.maxCombo
          : '不一致 · ' + resumed.score + ' vs ' + full.score,
        ok: good,
      });
    });
    state.verify = { ok: ok, fromTime: cps[0].time, items: items };
  };
})();
