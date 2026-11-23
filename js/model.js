/* 数据模型：工程、速度表、拍号表、tick<->秒 换算、小节线、校验 */
const Model = (() => {
  const PPQ = 480; // 每四分音符 tick 数

  let trackSeq = 1;
  let noteSeq = 1;

  function createTrack(name, instrument) {
    return {
      id: 't' + (trackSeq++) + '_' + Math.random().toString(36).slice(2, 8),
      name: name || 'Track',
      instrument: instrument || 'piano', // 'piano' | 'drums'
      muted: false,
      solo: false,
      notes: [],
    };
  }

  function createProject() {
    return {
      app: 'local-midi-arranger',
      version: 1,
      name: '未命名工程',
      ppq: PPQ,
      lengthMeasures: 8,
      tempoMap: [{ tick: 0, bpm: 120 }],
      timeSigs: [{ tick: 0, num: 4, den: 4 }],
      tracks: [createTrack('Piano', 'piano')],
    };
  }

  function newNote(track, tick, pitch, dur, vel) {
    const n = {
      id: 'n' + (noteSeq++) + '_' + Math.random().toString(36).slice(2, 8),
      tick, pitch, dur, vel: vel == null ? 100 : vel,
      allowOverlap: false,
    };
    track.notes.push(n);
    return n;
  }

  /* ---------- 速度表：tick <-> 秒 ---------- */
  function sortedTempo(project) {
    return project.tempoMap.slice().sort((a, b) => a.tick - b.tick);
  }

  function ticksToSeconds(project, tick) {
    const map = sortedTempo(project);
    let sec = 0;
    for (let i = 0; i < map.length; i++) {
      const cur = map[i];
      const nextTick = i + 1 < map.length ? map[i + 1].tick : Infinity;
      const end = Math.min(tick, nextTick);
      if (end > cur.tick) sec += ((end - cur.tick) / project.ppq) * (60 / cur.bpm);
      if (tick <= nextTick) break;
    }
    return sec;
  }

  function secondsToTicks(project, seconds) {
    const map = sortedTempo(project);
    let sec = 0;
    for (let i = 0; i < map.length; i++) {
      const cur = map[i];
      const nextTick = i + 1 < map.length ? map[i + 1].tick : Infinity;
      const segSec = nextTick === Infinity
        ? Infinity
        : ((nextTick - cur.tick) / project.ppq) * (60 / cur.bpm);
      if (seconds <= sec + segSec) {
        return cur.tick + ((seconds - sec) * project.ppq * cur.bpm) / 60;
      }
      sec += segSec;
    }
    const last = map[map.length - 1];
    return last.tick + ((seconds - sec) * project.ppq * last.bpm) / 60;
  }

  /* ---------- 拍号与小节线 ---------- */
  function sortedSigs(project) {
    return project.timeSigs.slice().sort((a, b) => a.tick - b.tick);
  }

  function measureTicks(project, sig) {
    return sig.num * ((project.ppq * 4) / sig.den);
  }

  // 返回 [{tick, num, den, length}]，覆盖 lengthMeasures 个小节
  function measureBoundaries(project) {
    const sigs = sortedSigs(project);
    const out = [];
    let tick = 0, si = 0;
    for (let m = 0; m < project.lengthMeasures; m++) {
      while (si + 1 < sigs.length && sigs[si + 1].tick <= tick) si++;
      const s = sigs[si];
      const len = measureTicks(project, s);
      out.push({ tick, num: s.num, den: s.den, length: len });
      tick += len;
    }
    return out;
  }

  function totalTicks(project) {
    const b = measureBoundaries(project);
    if (!b.length) return 0;
    const last = b[b.length - 1];
    return last.tick + last.length;
  }

  // tick -> {measure, beat, tickInBeat}（beat 从 0 起）
  function tickToPosition(project, tick) {
    const bounds = measureBoundaries(project);
    let m = 0;
    for (let i = 0; i < bounds.length; i++) {
      if (tick < bounds[i].tick + bounds[i].length) { m = i; break; }
      m = i;
    }
    const b = bounds[Math.max(0, m)];
    const beatLen = (project.ppq * 4) / b.den;
    const inMeasure = Math.max(0, tick - b.tick);
    const beat = Math.floor(inMeasure / beatLen);
    return { measure: m, beat, tickInBeat: inMeasure - beat * beatLen };
  }

  function formatPosition(project, tick) {
    const p = tickToPosition(project, tick);
    return `${p.measure + 1}.${p.beat + 1}.${Math.round(p.tickInBeat)}`;
  }

  /* ---------- 校验 ---------- */
  // 返回 [{type, trackIndex, noteId, msg}]
  function validateProject(project) {
    const issues = [];
    const total = totalTicks(project);
    project.tracks.forEach((tr, ti) => {
      const byPitch = new Map();
      for (const n of tr.notes) {
        if (typeof n.pitch !== 'number' || n.pitch < 0 || n.pitch > 127) {
          issues.push({ type: 'invalid', trackIndex: ti, noteId: n.id, msg: `音高 ${n.pitch} 超出 0–127 范围` });
        }
        if (typeof n.dur !== 'number' || n.dur <= 0) {
          issues.push({ type: 'invalid', trackIndex: ti, noteId: n.id, msg: `音符时值非法（${n.dur} tick）` });
        }
        if (typeof n.tick !== 'number' || n.tick < 0) {
          issues.push({ type: 'invalid', trackIndex: ti, noteId: n.id, msg: `音符位置非法（tick=${n.tick}）` });
        }
        if (n.tick + n.dur > total) {
          issues.push({
            type: 'range', trackIndex: ti, noteId: n.id,
            msg: `音符结束于 ${formatPosition(project, n.tick + n.dur)}，超出工程 ${project.lengthMeasures} 小节的范围`,
          });
        }
        const arr = byPitch.get(n.pitch) || [];
        for (const m of arr) {
          if (n.tick < m.tick + m.dur && m.tick < n.tick + n.dur && !n.allowOverlap && !m.allowOverlap) {
            issues.push({
              type: 'overlap', trackIndex: ti, noteId: n.id,
              msg: `音高 ${n.pitch} 在 ${formatPosition(project, Math.max(n.tick, m.tick))} 处与同轨音符重叠`,
            });
          }
        }
        arr.push(n);
        byPitch.set(n.pitch, arr);
      }
    });
    return issues;
  }

  /* ---------- 工程载入（JSON 校验与修复） ---------- */
  // 支持两种输入：
  //  A) tracks[].notes 内嵌（本应用保存的格式）
  //  B) 扁平 notes: [{track, tick, dur, pitch, vel}]，track 为轨道下标
  // 返回 {project, issues}
  function normalizeProject(raw) {
    const issues = [];
    const p = createProject();
    if (!raw || typeof raw !== 'object') throw new Error('工程文件不是合法的 JSON 对象');
    p.name = typeof raw.name === 'string' ? raw.name : '未命名工程';
    p.ppq = PPQ; // 内部固定 480
    p.lengthMeasures = Math.max(1, Math.round(raw.lengthMeasures) || 8);

    if (Array.isArray(raw.tempoMap) && raw.tempoMap.length) {
      p.tempoMap = raw.tempoMap
        .filter(t => t && isFinite(t.tick) && isFinite(t.bpm) && t.bpm > 0)
        .map(t => ({ tick: Math.max(0, Math.round(t.tick)), bpm: +t.bpm }));
      if (!p.tempoMap.length || p.tempoMap.every(t => t.tick !== 0)) {
        p.tempoMap.unshift({ tick: 0, bpm: 120 });
      }
    }
    if (Array.isArray(raw.timeSigs) && raw.timeSigs.length) {
      p.timeSigs = raw.timeSigs
        .filter(s => s && isFinite(s.tick) && isFinite(s.num) && isFinite(s.den) && s.num > 0 && s.den > 0)
        .map(s => ({ tick: Math.max(0, Math.round(s.tick)), num: Math.round(s.num), den: Math.round(s.den) }));
      if (!p.timeSigs.length || p.timeSigs.every(s => s.tick !== 0)) {
        p.timeSigs.unshift({ tick: 0, num: 4, den: 4 });
      }
    }

    p.tracks = [];
    if (Array.isArray(raw.tracks)) {
      raw.tracks.forEach((rt, i) => {
        const tr = createTrack(typeof rt.name === 'string' ? rt.name : `Track ${i + 1}`,
          rt.instrument === 'drums' ? 'drums' : 'piano');
        tr.muted = !!rt.muted;
        tr.solo = !!rt.solo;
        if (Array.isArray(rt.notes)) {
          for (const rn of rt.notes) addNoteChecked(tr, rn, i, issues);
        }
        p.tracks.push(tr);
      });
    }
    // 扁平 notes 格式：校验轨道下标是否有效
    if (Array.isArray(raw.notes)) {
      for (const rn of raw.notes) {
        const ti = rn && rn.track;
        if (!Number.isInteger(ti) || ti < 0 || ti >= p.tracks.length) {
          issues.push({
            type: 'invalid-track', trackIndex: -1, noteId: null,
            msg: `音符（pitch=${rn && rn.pitch}, tick=${rn && rn.tick}）指向无效轨道 ${ti}，已忽略`,
          });
          continue;
        }
        addNoteChecked(p.tracks[ti], rn, ti, issues);
      }
    }
    if (!p.tracks.length) p.tracks.push(createTrack('Piano', 'piano'));
    return { project: p, issues };
  }

  function addNoteChecked(tr, rn, trackIndex, issues) {
    const ok = rn && isFinite(rn.tick) && isFinite(rn.dur) && isFinite(rn.pitch);
    if (!ok || rn.dur <= 0 || rn.pitch < 0 || rn.pitch > 127 || rn.tick < 0) {
      issues.push({
        type: 'invalid', trackIndex, noteId: null,
        msg: `轨道 ${trackIndex + 1} 中一条音符数据非法（tick=${rn && rn.tick}, dur=${rn && rn.dur}, pitch=${rn && rn.pitch}），已忽略`,
      });
      return;
    }
    const n = newNote(tr, Math.round(rn.tick), Math.round(rn.pitch), Math.round(rn.dur),
      isFinite(rn.vel) ? Math.max(1, Math.min(127, Math.round(rn.vel))) : 100);
    n.allowOverlap = !!rn.allowOverlap;
  }

  return {
    PPQ, createProject, createTrack, newNote,
    ticksToSeconds, secondsToTicks,
    measureBoundaries, totalTicks, tickToPosition, formatPosition,
    validateProject, normalizeProject,
  };
})();
