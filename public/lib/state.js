// 前端状态：项目、派生时间线、音频编排、校验。所有编辑都经过这里并即时重算。
import {
  normalizeProject, createProject, setTrim as applyTrim, setLocked as applyLocked,
  removeClip as applyRemove, reorderClips, setTransition as applyTransition,
  setFps as applyFps, maxAllowedDuration,
} from '../../src/project.js';
import { buildTimeline, dissolveBudget } from '../../src/timeline.js';
import { buildAudioPlan } from '../../src/audio.js';
import { clipLength, clamp } from '../../src/model.js';

export function clipFromMedia({ id, name, url, media, sampleSpec = null }) {
  const duration = media?.duration || sampleSpec?.duration || 0;
  const fps = media?.video?.fps || sampleSpec?.fps || 30;
  return {
    id,
    name,
    src: url,
    duration,
    srcIn: 0,
    srcOut: duration,
    fps,
    width: media?.video?.width || sampleSpec?.width || 960,
    height: media?.video?.height || sampleSpec?.height || 540,
    hasAudio: Boolean(media?.hasAudio),
    audioDuration: media?.audio?.duration || 0,
    locked: false,
    sample: Boolean(sampleSpec),
    toneHz: sampleSpec?.tone?.f0 || null,
    marker: sampleSpec?.marker || null,
  };
}

export function createStore(initial = null) {
  let project = normalizeProject(initial || createProject());
  const listeners = new Set();
  let derived = derive(project);

  function derive(p) {
    const timeline = buildTimeline(p);
    const audioPlan = buildAudioPlan(timeline, p);
    return {
      timeline,
      audioPlan,
      budget: dissolveBudget(timeline),
      maxDissolve: p.transitions.map((_, i) => maxAllowedDuration(p, i)),
    };
  }

  function emit(reason = 'update') {
    for (const fn of listeners) fn(derived, project, reason);
  }

  function commit(next, reason) {
    project = normalizeProject(next);
    derived = derive(project);
    emit(reason);
  }

  const store = {
    get project() { return project; },
    get timeline() { return derived.timeline; },
    get audioPlan() { return derived.audioPlan; },
    get budget() { return derived.budget; },
    get maxDissolve() { return derived.maxDissolve; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    replace(p, reason = 'replace') {
      commit(p, reason);
    },

    addClip(clip, reason = 'add-clip') {
      const next = normalizeProject(project);
      next.clips.push(clip);
      commit(next, reason);
      return next.clips.length - 1;
    },

    removeClip(index) {
      const next = applyRemove(project, index);
      commit(next, 'remove-clip');
    },

    moveClip(from, to) {
      const next = reorderClips(project, from, to);
      commit(next, 'move-clip');
    },

    setTrim(index, patch) {
      const next = applyTrim(project, index, patch);
      commit(next, 'trim');
    },

    // 载入 / 替换整段素材后，修正取点使其落在新的源时长内。
    setClipSource(index, media, { name } = {}) {
      const next = normalizeProject(project);
      const clip = next.clips[index];
      if (!clip) return;
      const duration = media?.duration || 0;
      clip.src = media?.url || clip.src;
      clip.duration = duration;
      clip.fps = media?.video?.fps || clip.fps;
      clip.width = media?.video?.width || clip.width;
      clip.height = media?.video?.height || clip.height;
      clip.hasAudio = Boolean(media?.hasAudio);
      clip.audioDuration = media?.audio?.duration || 0;
      clip.srcIn = clamp(clip.srcIn, 0, Math.max(0, duration - 1 / (clip.fps || 30)));
      clip.srcOut = clamp(clip.srcOut, clip.srcIn + 1 / (clip.fps || 30), duration);
      if (name) clip.name = name;
      commit(next, 'replace-source');
    },

    setLocked(index, locked) {
      const next = applyLocked(project, index, locked);
      commit(next, 'lock');
    },

    setTransition(index, patch) {
      const next = applyTransition(project, index, patch);
      commit(next, 'transition');
    },

    setFps(fps) {
      commit(applyFps(project, fps), 'fps');
    },

    setAudio(index, patch) {
      const next = normalizeProject(project);
      const tr = next.transitions[index];
      if (!tr) return;
      if (patch.mode) tr.audio.mode = patch.mode;
      if (patch.switchTime !== undefined) tr.audio.switchTime = patch.switchTime;
      commit(next, 'audio');
    },

    // 播放头（统一时间）落在某段内时，返回其对应的源时间；不在该段内返回 null。
    localTimeOf(index, t) {
      const row = derived.timeline.clips[index];
      if (!row) return null;
      if (t < row.start - 1e-6 || t > row.end + 1e-6) return null;
      const local = clamp(t - row.start, 0, row.len);
      return row.srcIn + local;
    },

    // 让某段截取窗口的入/出点夹在当前可用范围内。
    clampTrim(index, { srcIn, srcOut }) {
      const c = project.clips[index];
      if (!c) return null;
      const minLen = 1 / (c.fps || project.fps || 30);
      let a = srcIn != null ? srcIn : c.srcIn;
      let b = srcOut != null ? srcOut : c.srcOut;
      a = clamp(a, 0, Math.max(0, c.duration - minLen));
      b = clamp(b, a + minLen, c.duration);
      return { srcIn: a, srcOut: b };
    },

    stats() {
      return {
        clips: project.clips.length,
        duration: derived.timeline.duration,
        hardCutTotal: derived.timeline.hardCutTotal,
        dissolveTotal: derived.timeline.dissolveTotal,
        issues: derived.timeline.issues,
      };
    },
  };
  return store;
}

export function demoProject(samples) {
  // samples: [{id,label,fileName,url,media,expected}]
  const byLabel = Object.fromEntries(samples.map((s) => [s.expected?.label || s.label, s]));
  const A = byLabel.A;
  const B = byLabel.B;
  const C = byLabel.C;
  if (!A || !B || !C) throw new Error('演示需要三段内建素材');

  const clips = [A, B, C].map((s, i) => {
    const clip = clipFromMedia({
      id: `demo-${s.expected?.label || i}`,
      name: `${s.expected?.label || '?'} · ${s.expected?.title || s.fileName}`,
      url: s.url,
      media: s.media,
      sampleSpec: s.expected,
    });
    return clip;
  });

  // A：0.50–3.50（3.00 s，30 fps），B：1.00–3.00（2.00 s，25 fps），C：0.40–2.60（2.20 s，30 fps）
  clips[0].srcIn = 0.5;
  clips[0].srcOut = Math.min(3.5, clips[0].duration);
  clips[0].locked = true;
  clips[1].srcIn = Math.min(1.0, Math.max(0, clips[1].duration - 0.5));
  clips[1].srcOut = Math.min(3.0, clips[1].duration);
  clips[2].srcIn = Math.min(0.4, Math.max(0, clips[2].duration - 0.5));
  clips[2].srcOut = Math.min(2.6, clips[2].duration);

  const p = createProject({
    name: '演示：一处叠化 + 一处硬切',
    fps: 30,
    width: 960,
    height: 540,
    clips,
    transitions: [
      { type: 'dissolve', duration: 0.8, audio: { mode: 'follow', switchTime: null } },
      { type: 'cut', duration: 0, audio: { mode: 'follow', switchTime: null } },
    ],
  });
  return normalizeProject(p);
}

export { clipLength };
