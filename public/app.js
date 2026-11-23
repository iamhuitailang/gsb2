/**
 * TrackWeave 前端。
 *
 * 三条原则：
 *   1. 预览与导出共用 public/shared 下的同一套时间规则，前端不另写一份。
 *   2. 切换默认轨 / 字幕只改状态，永远不碰 player.currentTime。
 *   3. 所有警告都挂在具体轨道上，用户能直接看到是哪一条轨、差多少秒。
 */
import {
  LANGUAGES,
  guessLanguageFromFileName,
  languageInfo,
  normalizeLanguage,
} from './shared/languages.js';
import { parseSubtitles, activeCues, shiftAndClipCues } from './shared/subtitles.js';
import {
  formatClock,
  formatSigned,
  resolveAudioTimeline,
  resolveSubtitleTimeline,
} from './shared/timeline.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  project: emptyProject(),
  env: null,
  plan: null,
  activeSubtitleId: null,
  soloAudioId: null,
  filter: 'all',
  pickerPurpose: 'video',
  pickerSelection: new Set(),
  pickerDir: null,
  sampleCheck: null,
  lastVerification: null,
  exporting: false,
  jobSource: null,
};

const audioEls = new Map(); // trackId -> HTMLAudioElement
const cueCache = new Map(); // token -> Promise<parsed>
const player = $('#player');

function emptyProject() {
  return {
    name: '未命名项目',
    video: null,
    audioTracks: [],
    subtitleTracks: [],
    outputPath: '',
    notes: [],
  };
}

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function secondsLabel(value) {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return formatClock(Number(value));
}

function shortSeconds(value) {
  if (value == null) return '—';
  return `${Number(value).toFixed(2)}s`;
}

function allTracks() {
  return [...state.project.audioTracks, ...state.project.subtitleTracks];
}

function trackById(id) {
  return allTracks().find((track) => track.id === id) || null;
}

function trackGroup(track) {
  return track.kind === 'subtitle' ? state.project.subtitleTracks : state.project.audioTracks;
}

function videoDuration() {
  const fromProject = Number(state.project.video?.duration || 0);
  const fromPlayer = Number(player.duration || 0);
  return fromProject > 0 ? fromProject : Number.isFinite(fromPlayer) ? fromPlayer : 0;
}

function notify(message, tone = 'info', timeout = 3600) {
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${tone === 'info' ? '' : tone}`;
  el.textContent = message;
  stack.append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, timeout);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.error?.message || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const refreshOverlay = debounce(updateOverlay, 30);

/* ------------------------------------------------------------------ */
/* 环境与初始化                                                       */
/* ------------------------------------------------------------------ */

async function loadEnv() {
  try {
    const env = await api('/api/env');
    state.env = env;
    const badge = $('#ffmpeg-badge');
    if (env.capabilities?.available) {
      badge.textContent = 'ffmpeg 就绪';
      badge.className = 'badge badge-ok';
      badge.title = `${env.capabilities.versionLine}\n音频编码：${env.capabilities.audioEncoders.join(', ') || '无'}\n字幕编码：${env.capabilities.subtitleEncoders.join(', ') || '无'}`;
    } else {
      badge.textContent = 'ffmpeg 不可用';
      badge.className = 'badge badge-bad';
      badge.title = env.ffmpegError?.message || '未找到 ffmpeg';
    }
  } catch (error) {
    notify(`无法读取环境信息：${error.message}`, 'error');
  }
}

async function bootstrap() {
  bindGlobalEvents();
  await loadEnv();
  // 示例素材由服务端按需生成；首次启动也能直接进入可试听、可核对的状态。
  try {
    await loadSampleProject({ silent: true });
    notify('已载入内置示例素材，可直接播放与核对', 'info');
    return;
  } catch {
    /* 示例生成失败（例如缺 ffmpeg）时保留空项目，用户仍可浏览本地文件 */
  }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* 项目载入 / 素材添加                                                */
/* ------------------------------------------------------------------ */

function makeTrack(base, kind) {
  return {
    id: base.id || uid(kind === 'subtitle' ? 'sub' : 'audio'),
    kind,
    token: base.token,
    path: base.path || '',
    name: base.name || '未命名',
    language: normalizeLanguage(base.language || guessLanguageFromFileName(base.name || '')),
    offset: Number(base.offset || 0),
    enabled: base.enabled !== false,
    default: Boolean(base.default),
    sourceDuration: Number(base.sourceDuration || base.duration || 0),
    supported: base.supported !== false,
    supportIssue: base.supportIssue || null,
    format: base.format || (base.extension ? base.extension.toUpperCase() : null),
    cueCount: base.cueCount ?? null,
    codec: base.codec || null,
    sampleRate: base.sampleRate ?? null,
    channels: base.channels ?? null,
    size: base.size ?? null,
    cues: [],
    pending: kind === 'subtitle' && base.supported !== false,
  };
}

async function addEntries(entries, kind) {
  const results = [];
  for (const entry of entries) {
    try {
      const imported = await api('/api/import', { method: 'POST', body: JSON.stringify({ paths: [entry.path] }) });
      const item = imported.results[0];
      if (!item?.ok) throw new Error(item?.error?.message || '导入失败');
      results.push(item);
    } catch (error) {
      notify(`「${entry.name}」导入失败：${error.message}`, 'error');
    }
  }
  if (!results.length) return;

  if (kind === 'video') {
    const item = results[0];
    setVideoFromImport(item);
    return;
  }

  for (const item of results) {
    if (item.kind === 'subtitle') {
      const supported = item.subtitle?.ok === true && !item.issue;
      const track = makeTrack(
        {
          ...item,
          supported,
          supportIssue: supported
            ? null
            : item.issue || item.subtitle?.reason || '字幕无法解析',
          format: item.subtitle?.format || item.extension,
          cueCount: item.subtitle?.cueCount ?? null,
          sourceDuration: item.subtitle?.sourceDuration ?? 0,
          default: state.project.subtitleTracks.length === 0,
        },
        'subtitle',
      );
      state.project.subtitleTracks.push(track);
      if (supported) loadSubtitleCues(track);
      else track.pending = false;
    } else if (item.kind === 'audio') {
      const track = makeTrack(
        {
          ...item,
          supported: Boolean(item.audio),
          supportIssue: item.audio ? null : item.issue || '没有可用的音频流',
          codec: item.audio?.codec,
          sampleRate: item.audio?.sampleRate,
          channels: item.audio?.channels,
          sourceDuration: item.duration || 0,
          default: state.project.audioTracks.length === 0,
        },
        'audio',
      );
      state.project.audioTracks.push(track);
      ensureAudioElement(track);
    } else if (item.kind === 'video') {
      if (!state.project.video) {
        setVideoFromImport(item);
      } else {
        notify(`已忽略第二个视频「${item.name}」，一个项目只支持一个视频`, 'warn');
      }
    }
  }
  normalizeDefaultFlags();
  renderAll();
}

function setVideoFromImport(item) {
  state.project.video = {
    token: item.token,
    path: item.path,
    name: item.name,
    duration: Number(item.duration || item.video?.duration || 0),
    width: item.video?.width ?? null,
    height: item.video?.height ?? null,
    codec: item.video?.codec || null,
  };
  player.src = `/media/${item.token}`;
  player.muted = true;
  $('#video-placeholder').hidden = true;
  if (!state.project.outputPath) {
    const dir = item.path.replace(/[\\/][^\\/]+$/, '');
    const base = item.name.replace(/\.[^.]+$/, '');
    const sep = item.path.includes('\\') && !item.path.includes('/') ? '\\' : '/';
    state.project.outputPath = `${dir}${sep}${base}.trackweave.mkv`;
  }
  if (state.project.name === '未命名项目') {
    state.project.name = item.name.replace(/\.[^.]+$/, '');
  }
  normalizeDefaultFlags();
  resetAudioElements();
  renderAll();
  notify(`已载入视频「${item.name}」`, 'ok');
}

async function loadSubtitleCues(track) {
  if (!track.token) return track;
  if (cueCache.has(track.token)) {
    const parsed = await cueCache.get(track.token);
    applySubtitle(track, parsed);
    return track;
  }
  const promise = (async () => {
    const response = await fetch(`/media/${track.token}`);
    if (!response.ok) throw new Error(`无法读取字幕「${track.name}」`);
    const text = await response.text();
    return parseSubtitles(text, { fileName: track.name });
  })();
  cueCache.set(track.token, promise);
  try {
    const parsed = await promise;
    applySubtitle(track, parsed);
  } catch (error) {
    track.supported = false;
    track.supportIssue = error.message;
    track.pending = false;
    renderAll();
  }
  return track;
}

function applySubtitle(track, parsed) {
  track.cues = parsed.cues;
  track.format = parsed.format;
  track.cueCount = parsed.cues.length;
  track.sourceDuration = parsed.cues.reduce((max, cue) => Math.max(max, cue.end), 0);
  track.styleLost = parsed.styleLost;
  track.pending = false;
  renderAll();
}

async function loadSampleProject({ silent = false } = {}) {
  const { project } = await api('/api/samples/project');
  const next = emptyProject();
  next.name = project.name;
  next.video = project.video;
  next.outputPath = project.outputPath || '';
  next.notes = project.notes || [];

  next.audioTracks = project.audioTracks.map((track) =>
    makeTrack({ ...track, codec: 'pcm_s16le', channels: 1, sampleRate: 48000 }, 'audio'),
  );
  next.subtitleTracks = project.subtitleTracks.map((track) => makeTrack(track, 'subtitle'));

  state.project = next;
  state.plan = null;
  state.lastVerification = null;
  state.sampleCheck = null;
  state.soloAudioId = null;

  player.src = `/media/${next.video.token}`;
  player.muted = true;
  $('#video-placeholder').hidden = true;
  resetAudioElements();
  for (const track of next.subtitleTracks) await loadSubtitleCues(track);
  normalizeDefaultFlags();
  pickActiveSubtitle(next.subtitleTracks.find((track) => track.default)?.id || next.subtitleTracks[0]?.id);
  renderAll();
  if (!silent) notify('示例素材已载入：中文音轨开头多 0.8 秒、英文末尾多 1.2 秒，可对照时间线查看', 'ok');
}

/* ------------------------------------------------------------------ */
/* 默认轨 / 顺序 / 偏移                                               */
/* ------------------------------------------------------------------ */

function normalizeDefaultFlags() {
  for (const group of [state.project.audioTracks, state.project.subtitleTracks]) {
    const usable = group.filter((track) => track.enabled && track.supported);
    const defaults = usable.filter((track) => track.default);
    if (defaults.length > 1) {
      defaults.slice(1).forEach((track) => {
        track.default = false;
      });
    }
    if (!defaults.length && usable.length) usable[0].default = true;
    for (const track of group) {
      if (!usable.includes(track)) track.default = false;
    }
  }
}

function setDefault(track) {
  const group = trackGroup(track);
  for (const item of group) item.default = item === track;
  if (track.kind === 'subtitle') {
    pickActiveSubtitle(track.id);
  } else if (state.soloAudioId) {
    state.soloAudioId = null;
  }
  syncPlayback();
  renderAll();
  notify(`默认${track.kind === 'subtitle' ? '字幕' : '音轨'}：${track.name}`, 'info', 2200);
}

function moveTrack(track, direction) {
  const group = trackGroup(track);
  const index = group.indexOf(track);
  const target = index + direction;
  if (target < 0 || target >= group.length) return;
  group.splice(index, 1);
  group.splice(target, 0, track);
  renderAll();
}

function setOffset(track, value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return;
  track.offset = Math.round(number * 1000) / 1000;
  renderAll();
}

function nudgeOffset(track, delta) {
  track.offset = Math.round((track.offset + delta) * 1000) / 1000;
  renderAll();
}

function toggleEnabled(track) {
  track.enabled = !track.enabled;
  if (!track.enabled && track.default) track.default = false;
  normalizeDefaultFlags();
  syncPlayback();
  renderAll();
}

function removeTrack(track) {
  const group = trackGroup(track);
  const index = group.indexOf(track);
  if (index >= 0) group.splice(index, 1);
  const el = audioEls.get(track.id);
  if (el) {
    el.pause();
    el.src = '';
    audioEls.delete(track.id);
  }
  if (state.soloAudioId === track.id) state.soloAudioId = null;
  if (state.activeSubtitleId === track.id) state.activeSubtitleId = null;
  normalizeDefaultFlags();
  syncPlayback();
  renderAll();
}

/* ------------------------------------------------------------------ */
/* 本地计划（与导出共用 shared 规则）                                 */
/* ------------------------------------------------------------------ */

function buildLocalPlan() {
  const duration = videoDuration();
  // 默认轨先归一，后面构造的计划副本才能拿到正确标记。
  normalizeDefaultFlags();
  const audioTracks = state.project.audioTracks.map((track, index) => {
    const timeline = track.supported
      ? resolveAudioTimeline({
          offset: track.offset,
          sourceDuration: track.sourceDuration,
          videoDuration: duration,
        })
      : null;
    const warnings = [];
    if (!track.supported) {
      warnings.push({
        code: 'unsupported',
        severity: 'error',
        message: track.supportIssue || '格式不受支持',
      });
    }
    if (timeline) warnings.push(...timeline.warnings);
    return { ...track, order: index, timeline, warnings };
  });

  const subtitleTracks = state.project.subtitleTracks.map((track, index) => {
    const shifted =
      track.supported && track.cues.length
        ? shiftAndClipCues(track.cues, { offset: track.offset, videoDuration: duration })
        : { cues: [], warnings: [], summary: {} };
    const timeline = track.supported
      ? resolveSubtitleTimeline({
          offset: track.offset,
          cues: track.cues,
          sourceDuration: track.sourceDuration,
          videoDuration: duration,
        })
      : null;
    const warnings = [];
    if (!track.supported) {
      warnings.push({
        code: 'unsupported',
        severity: 'error',
        message: track.supportIssue || '格式不受支持',
      });
    }
    if (track.supported) {
      warnings.push(...timeline.warnings, ...shifted.warnings);
      if (track.styleLost) {
        warnings.push({
          code: 'style-lost',
          severity: 'info',
          message: 'ASS/SSA 样式不会保留，导出为纯文本字幕',
        });
      }
      if (!shifted.cues.length && track.cues.length) {
        warnings.push({
          code: 'no-cues-after-align',
          severity: 'error',
          message: '按当前偏移，所有字幕都落在视频范围外',
        });
      }
    }
    // 字幕还在解析时不参与导出就绪判断，避免刚添加就闪红。
    const ready = track.supported && !track.pending;
    return {
      ...track,
      order: index,
      cues: track.cues,
      shiftedCues: shifted.cues,
      cueSummary: shifted.summary,
      timeline,
      warnings,
      ready,
    };
  });

  const warnings = [];
  if (!state.project.video) {
    warnings.push({
      code: 'no-video',
      severity: 'warning',
      message: '还没有视频；时间线按 0 秒计算',
      kind: 'project',
    });
  }
  for (const plan of [...audioTracks, ...subtitleTracks]) {
    for (const warning of plan.warnings) {
      warnings.push({ ...warning, trackId: plan.id, trackName: plan.name, kind: plan.kind });
    }
  }
  for (const note of state.project.notes || []) {
    warnings.push({ code: 'project-note', severity: 'info', message: note, kind: 'project' });
  }

  const enabledAudio = audioTracks.filter((track) => track.enabled && track.supported);
  const enabledSubs = subtitleTracks.filter((track) => track.enabled && track.ready);
  const errors = [];
  if (!state.project.video) errors.push({ code: 'no-video', message: '请先添加视频' });
  if (!enabledAudio.length) errors.push({ code: 'no-audio', message: '至少启用一条音轨' });
  if (!enabledSubs.length) errors.push({ code: 'no-subtitle', message: '至少启用一条字幕' });
  for (const track of [...audioTracks, ...subtitleTracks]) {
    if (track.enabled && !track.supported) {
      errors.push({
        code: 'unsupported-track',
        message: `「${track.name}」格式不受支持：${track.supportIssue}`,
        trackId: track.id,
      });
    }
  }
  for (const track of enabledAudio) {
    if (track.timeline?.fullyOutside) {
      errors.push({
        code: 'track-outside',
        message: `「${track.name}」按当前偏移没有内容落在视频内`,
        trackId: track.id,
      });
    }
  }
  for (const track of subtitleTracks) {
    if (track.enabled && track.ready && track.supported && !track.shiftedCues.length) {
      errors.push({
        code: 'empty-subtitle',
        message: `「${track.name}」按当前偏移没有剩余字幕`,
        trackId: track.id,
      });
    }
  }

  const counts = { info: 0, warning: 0, error: 0 };
  for (const warning of warnings) counts[warning.severity || 'info'] += 1;

  return {
    video: state.project.video,
    audioTracks,
    subtitleTracks,
    warnings,
    warningCounts: counts,
    errors,
    ready: errors.length === 0,
    videoDuration: duration,
  };
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

function renderAll() {
  const plan = buildLocalPlan();
  state.plan = plan;
  renderHeader(plan);
  renderRail(plan);
  renderTimeline(plan);
  renderIssues(plan);
  renderExportState(plan);
  updateOverlay();
  updateScrubMarkers(plan);
}

function renderHeader(plan) {
  $('#project-name').textContent = state.project.name || '未命名项目';
  const video = state.project.video;
  $('#project-video').textContent = video
    ? `${video.name} · ${secondsLabel(plan.videoDuration)} · ${video.width || '?'}×${video.height || '?'}`
    : '尚未载入视频';
  $('#video-meta').textContent = video ? `${video.name} · ${plan.videoDuration.toFixed(2)}s` : '未载入视频';
  $('#sum-audio').textContent = String(plan.audioTracks.length);
  $('#sum-subtitle').textContent = String(plan.subtitleTracks.length);
  $('#sum-warnings').textContent = String(plan.warningCounts.error + plan.warningCounts.warning);
  // 正在输入时不覆盖用户刚敲的路径。
  const outputInput = $('#output-path');
  if (document.activeElement !== outputInput && outputInput.value !== (state.project.outputPath || '')) {
    outputInput.value = state.project.outputPath || '';
  }
}

function languagePill(track) {
  const info = languageInfo(track.language);
  return `<span class="lang-pill ${info.code === 'zh' ? 'zh' : info.code === 'en' ? 'en' : ''}">${info.code === 'und' ? '未指定' : `${info.label} ${info.tag}`}</span>`;
}

function languageSelect(track, kind) {
  const options = LANGUAGES.map(
    (lang) =>
      `<option value="${lang.code}" ${lang.code === track.language ? 'selected' : ''}>${lang.label} · ${lang.tag}</option>`,
  ).join('');
  return `<select class="lang-select" data-action="language" data-id="${track.id}" aria-label="${kind === 'subtitle' ? '字幕' : '音轨'}语言">${options}</select>`;
}

function renderTrackCard(track, planTrack, index, total) {
  const isSub = track.kind === 'subtitle';
  const timeline = planTrack.timeline;
  const classes = ['track-card'];
  if (track.default) classes.push('is-default');
  if (!track.enabled) classes.push('is-disabled');
  if (track.warnings.some((warning) => warning.severity === 'error')) classes.push('has-error');
  if (state.soloAudioId === track.id) classes.push('is-playing');

  const meta = [];
  if (isSub) {
    meta.push(`<span>${track.pending ? '解析中…' : `${planTrack.shiftedCues?.length ?? 0} 条字幕`}</span>`);
    if (track.format) meta.push(`<span>${String(track.format).toUpperCase()}</span>`);
    if (track.sourceDuration) meta.push(`<span class="mono">${shortSeconds(track.sourceDuration)}</span>`);
  } else {
    meta.push(`<span class="mono">${shortSeconds(track.sourceDuration)}</span>`);
    if (track.codec) meta.push(`<span>${track.codec}</span>`);
    if (track.sampleRate) meta.push(`<span class="mono">${(track.sampleRate / 1000).toFixed(1)}kHz</span>`);
    if (track.channels) meta.push(`<span>${track.channels}ch</span>`);
  }

  const alerts = [];
  if (!track.supported) {
    alerts.push(`<div class="track-alert error">⚠ ${escapeHtml(track.supportIssue || '格式不受支持')}</div>`);
  } else if (timeline) {
    if (timeline.overflow > 0.005) {
      alerts.push(
        `<div class="track-alert">超出视频末尾 ${timeline.overflow.toFixed(2)}s：预览到此静音，导出会截断</div>`,
      );
    }
    if (isSub && planTrack.cueSummary?.clippedHead) {
      alerts.push(`<div class="track-alert">${planTrack.cueSummary.clippedHead} 条字幕开头被视频起点裁掉</div>`);
    }
    if (isSub && planTrack.cueSummary?.droppedAfter) {
      alerts.push(`<div class="track-alert">${planTrack.cueSummary.droppedAfter} 条字幕落在视频末尾之后，不会显示</div>`);
    }
  }

  const offsetInput = `
    <div class="offset-field">
      <label for="offset-${track.id}">相对视频偏移（秒）</label>
      <div class="offset-row">
        <button class="nudge" data-action="nudge" data-id="${track.id}" data-delta="-0.1" title="提前 0.1 秒">−</button>
        <input id="offset-${track.id}" type="number" step="0.01" value="${track.offset.toFixed(2)}"
          data-action="offset" data-id="${track.id}" />
        <button class="nudge" data-action="nudge" data-id="${track.id}" data-delta="0.1" title="延后 0.1 秒">＋</button>
      </div>
    </div>`;

  const buttons = isSub
    ? `
      <button class="mini-toggle ${track.default ? 'is-on' : ''}" data-action="default" data-id="${track.id}" ${!track.enabled || !track.supported ? 'disabled' : ''}>默认</button>
      <button class="mini-toggle ${state.activeSubtitleId === track.id ? 'is-on' : ''}" data-action="activate-sub" data-id="${track.id}" ${!track.enabled || !track.supported ? 'disabled' : ''}>预览</button>`
    : `
      <button class="mini-toggle ${track.default ? 'is-on' : ''}" data-action="default" data-id="${track.id}" ${!track.enabled || !track.supported ? 'disabled' : ''}>默认</button>
      <button class="mini-toggle ${state.soloAudioId === track.id ? 'is-on' : ''}" data-action="solo" data-id="${track.id}" ${!track.enabled || !track.supported ? 'disabled' : ''}>${state.soloAudioId === track.id ? '停止试听' : '试听'}</button>`;

  return `
    <article class="${classes.join(' ')}" draggable="true" data-track-id="${track.id}" data-kind="${track.kind}">
      <div class="track-top">
        <span class="drag-handle" title="拖动调整顺序">⣿</span>
        <div class="track-identity">
          <div class="track-title">
            <strong title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</strong>
            ${track.default ? '<span class="default-pill">默认</span>' : ''}
            ${!track.supported ? '<span class="issue-pill">不支持</span>' : ''}
            ${languagePill(track)}
          </div>
          <div class="track-sub">
            ${meta.join('')}
            <span>顺序 ${index + 1}/${total}</span>
          </div>
        </div>
        <div class="track-order">
          <button class="order-btn" data-action="up" data-id="${track.id}" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button class="order-btn" data-action="down" data-id="${track.id}" title="下移" ${index === total - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>
      <div class="track-controls">
        ${offsetInput}
        <div class="track-buttons">
          ${buttons}
          <button class="mini-toggle ${track.enabled ? 'is-on' : ''}" data-action="toggle" data-id="${track.id}">${track.enabled ? '启用' : '停用'}</button>
          <button class="mini-toggle danger" data-action="remove" data-id="${track.id}" title="移除">✕</button>
        </div>
      </div>
      <div class="track-foot">
        ${languageSelect(track, track.kind)}
        <button class="mini-toggle" data-action="locate" data-id="${track.id}" title="跳到该轨第一个有效时点">定位</button>
      </div>
      ${alerts.join('')}
    </article>`;
}

function renderRail(plan) {
  const audioList = $('#audio-list');
  const subList = $('#subtitle-list');

  audioList.innerHTML = plan.audioTracks.length
    ? plan.audioTracks
        .map((track, index) => renderTrackCard(track, track, index, plan.audioTracks.length))
        .join('')
    : '<p class="empty">还没有音轨。添加独立音频文件，或载入示例。</p>';

  subList.innerHTML = plan.subtitleTracks.length
    ? plan.subtitleTracks
        .map((track, index) => renderTrackCard(track, track, index, plan.subtitleTracks.length))
        .join('')
    : '<p class="empty">还没有字幕。支持 SRT / VTT / ASS / SSA。</p>';

  const exportReady = plan.ready && !state.exporting;
  $('#btn-export').disabled = !exportReady;
  $('#btn-export-2').disabled = !exportReady;
  const sampleBtn = $('#btn-verify-output');
  sampleBtn.disabled = !state.lastVerification?.outputPath || state.exporting;
}

function renderTimeline(plan) {
  const container = $('#timeline');
  const duration = plan.videoDuration;
  if (!duration || (!plan.audioTracks.length && !plan.subtitleTracks.length)) {
    container.innerHTML = '<div class="timeline-empty">添加素材后显示每条轨道在视频中的落点</div>';
    $('#timeline-scale').textContent = '—';
    return;
  }
  $('#timeline-scale').textContent = `0 – ${duration.toFixed(2)}s`;

  const pct = (value) => `${Math.max(0, Math.min(100, (value / duration) * 100))}%`;
  const widthPct = (start, end) => `${Math.max(0, Math.min(100, ((end - start) / duration) * 100))}%`;

  const rows = [];
  for (const track of [...plan.audioTracks, ...plan.subtitleTracks]) {
    const segments = [];
    if (track.kind === 'audio' && track.timeline && track.supported) {
      const tl = track.timeline;
      if (tl.headSilence > 0) {
        segments.push(
          `<span class="tl-seg pad" style="left:0;width:${widthPct(0, tl.headSilence)}" title="开头补静音 ${shortSeconds(tl.headSilence)}"></span>`,
        );
      }
      const effectiveEnd = Math.min(duration, tl.placedEnd);
      if (effectiveEnd > tl.headSilence) {
        segments.push(
          `<span class="tl-seg audio" style="left:${pct(tl.headSilence)};width:${widthPct(tl.headSilence, effectiveEnd)}" title="音轨有效区间"></span>`,
        );
      }
      if (tl.overflow > 0) {
        // 溢出不占视频时间轴，只在右端画一小段斜线标记，提示“还有内容在视频外”。
        segments.push(
          `<span class="tl-seg overflow" style="right:0;left:auto;width:8px" title="超出视频 ${shortSeconds(tl.overflow)}，导出会截断"></span>`,
        );
      }
    } else if (track.kind === 'subtitle' && track.supported) {
      const cues = track.shiftedCues || [];
      const maxCues = 200;
      for (const cue of cues.slice(0, maxCues)) {
        segments.push(
          `<span class="tl-seg cue" style="left:${pct(cue.start)};width:${widthPct(cue.start, cue.end)}" title="${escapeHtml(`${formatClock(cue.start, { millis: true })} ${cue.text.slice(0, 40)}`)}"></span>`,
        );
      }
    }
    const label = `${escapeHtml(track.name)}${track.default ? ' · 默认' : ''}`;
    rows.push(`
      <div class="tl-row">
        <div class="tl-label" title="${escapeHtml(track.name)}">${label}<span class="lang">${languageInfo(track.language).short}</span></div>
        <div class="tl-track" data-timeline-track="${track.id}">
          ${segments.join('')}
          <div class="tl-overlay-playhead" data-playhead style="left:${pct(player.currentTime || 0)}"></div>
        </div>
      </div>`);
  }

  container.innerHTML = rows.join('');
  updatePlayheads();
}

function renderIssues(plan) {
  const list = $('#issue-list');
  const items = plan.warnings
    .filter((warning) => state.filter === 'all' || warning.severity === state.filter)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const errorsWithoutTrack = plan.errors.filter(
    (error) => !plan.warnings.some((warning) => warning.message === error.message),
  );
  if (state.filter === 'all' || state.filter === 'error') {
    for (const error of errorsWithoutTrack) {
      items.unshift({ ...error, severity: 'error', kind: error.kind || 'project', trackName: null });
    }
  }

  if (!items.length) {
    list.innerHTML = '<li class="issue-empty">没有发现问题。</li>';
    return;
  }

  list.innerHTML = items
    .map((warning) => {
      const severity = warning.severity || 'info';
      const label = { error: '错误', warning: '提醒', info: '说明' }[severity] || '说明';
      const jump = warning.trackId
        ? `<button class="issue-jump" data-action="issue-locate" data-id="${warning.trackId}">定位</button>`
        : '';
      return `
        <li class="issue-item ${severity}">
          <span class="severity">${label}</span>
          <span class="issue-msg">${escapeHtml(warning.message)}
            <small>${warning.trackName ? escapeHtml(warning.trackName) : kindLabel(warning.kind)}</small>
          </span>
          ${jump}
        </li>`;
    })
    .join('');
}

function kindLabel(kind) {
  return { audio: '音轨', subtitle: '字幕', video: '视频', project: '项目' }[kind] || '项目';
}

function severityRank(severity) {
  return { error: 3, warning: 2, info: 1 }[severity] || 0;
}

function renderExportState(plan) {
  const badge = $('#export-state');
  if (state.exporting) {
    badge.textContent = '导出中';
    badge.className = 'badge badge-warn';
    return;
  }
  if (plan.ready) {
    badge.textContent = '可导出';
    badge.className = 'badge badge-ok';
  } else {
    badge.textContent = `${plan.errors.length} 项待处理`;
    badge.className = 'badge badge-bad';
  }
  const enabledAudio = plan.audioTracks.filter((track) => track.enabled && track.supported);
  const enabledSubs = plan.subtitleTracks.filter((track) => track.enabled && track.supported);
  $('#export-meta').textContent =
    `将写入 ${enabledAudio.length} 条音轨、${enabledSubs.length} 条字幕到一个 MKV；` +
    `默认音轨「${enabledAudio.find((track) => track.default)?.name || '—'}」，` +
    `默认字幕「${enabledSubs.find((track) => track.default)?.name || '—'}」。` +
    '其余启用的轨道会作为副轨保留。';
}

/* ------------------------------------------------------------------ */
/* 字幕预览 / 时点核对                                                */
/* ------------------------------------------------------------------ */

function pickActiveSubtitle(id) {
  state.activeSubtitleId = id || null;
}

function primarySubtitlePlan(plan) {
  const usable = plan.subtitleTracks.filter((track) => track.enabled && track.supported);
  if (!usable.length) return null;
  const active = usable.find((track) => track.id === state.activeSubtitleId);
  if (active) return active;
  // 没显式选过就跟默认轨；默认轨被停用后回落到第一条可用轨。
  return usable.find((track) => track.default) || usable[0];
}

function secondarySubtitlePlan(plan, primary) {
  return (
    plan.subtitleTracks.find(
      (track) => track.enabled && track.supported && track.id !== primary?.id,
    ) || null
  );
}

function currentCues(trackPlan, time) {
  if (!trackPlan) return [];
  return activeCues(trackPlan.shiftedCues || [], time);
}

function updateOverlay() {
  const plan = state.plan;
  if (!plan) return;
  const time = player.currentTime || 0;
  const overlay = $('#subtitle-overlay');
  const primary = primarySubtitlePlan(plan);
  const secondary = primary ? secondarySubtitlePlan(plan, primary) : null;
  const lines = [];

  // 画面上只显示当前选中的一条；另一条放在「时点核对」两栏里对照，
  // 这样点「切换到另一条字幕」时能立刻看出画面字幕变了。
  if (primary) {
    const cues = currentCues(primary, time);
    $('#active-subtitle-lang').textContent = `字幕 ${languageInfo(primary.language).short} · ${primary.name}`;
    for (const cue of cues) {
      lines.push(`<span class="subtitle-line is-default">${escapeHtml(cue.text)}</span>`);
    }
  } else {
    $('#active-subtitle-lang').textContent = '字幕 —';
  }

  overlay.innerHTML = lines.join('');
  renderBenchCues(plan, primary, secondary, time);
}

function renderBenchCues(plan, primary, secondary, time) {
  $('#bench-time').textContent = `${formatClock(time, { millis: true })} / ${formatClock(plan.videoDuration, { millis: true })}`;

  const renderLane = (laneId, tagId, trackPlan, fallbackLabel) => {
    const lane = $(laneId);
    const tag = $(tagId);
    if (!trackPlan) {
      lane.className = 'cue-lane';
      tag.textContent = fallbackLabel;
      $(`${laneId} p`).textContent = '—';
      $(`${laneId} p`).classList.add('dim');
      return;
    }
    const cues = currentCues(trackPlan, time);
    const info = languageInfo(trackPlan.language);
    tag.textContent = `${info.short} · ${trackPlan.name}${trackPlan.default ? ' · 默认' : ''}`;
    lane.className = `cue-lane ${trackPlan.id === primary?.id ? 'primary' : 'secondary'}`;
    const p = $(`${laneId} p`);
    p.classList.toggle('dim', cues.length === 0);
    p.textContent = cues.length ? cues.map((cue) => cue.text).join('\n') : '（该时点无字幕）';
  };

  renderLane('#lane-primary', '#lane-primary-tag', primary, '字幕 A');
  renderLane('#lane-secondary', '#lane-secondary-tag', secondary, '字幕 B');

  const swap = $('#btn-swap-subtitle');
  const usable = plan.subtitleTracks.filter((track) => track.enabled && track.supported);
  swap.disabled = usable.length < 2;
  if (usable.length >= 2 && primary) {
    const other = usable.find((track) => track.id !== primary.id);
    swap.textContent = `切换到「${other.name}」`;
  } else {
    swap.textContent = '切换到另一条字幕';
  }

  const cueStarts = (primary?.shiftedCues || []).map((cue) => cue.start).sort((a, b) => a - b);
  const hasNext = cueStarts.some((start) => start > time + 0.01);
  const hasPrev = cueStarts.some((start) => start < time - 0.01);
  $('#btn-jump-next').disabled = !hasNext;
  $('#btn-jump-prev').disabled = !hasPrev;
}

function jumpToCue(direction) {
  const plan = state.plan;
  const primary = plan && primarySubtitlePlan(plan);
  if (!primary) return;
  const cues = [...(primary.shiftedCues || [])].sort((a, b) => a.start - b.start);
  const time = player.currentTime || 0;
  const target =
    direction > 0
      ? cues.find((cue) => cue.start > time + 0.01)
      : [...cues].reverse().find((cue) => cue.start < time - 0.01);
  if (target) seekTo(target.start + 0.001);
}

function seekTo(time) {
  const duration = player.duration || videoDuration();
  const clamped = Math.max(0, Math.min(duration || time, time));
  player.currentTime = clamped;
  syncPlayback();
  updateOverlay();
  updatePlayheads();
}

/* ------------------------------------------------------------------ */
/* 音频播放同步                                                       */
/* ------------------------------------------------------------------ */

function ensureAudioElement(track) {
  if (!track.token || audioEls.has(track.id)) return audioEls.get(track.id);
  const el = new Audio(`/media/${track.token}`);
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  el.volume = 0.85;
  el.addEventListener('error', () => {
    track.supported = false;
    track.supportIssue = '浏览器无法解码该音频，导出仍会用它';
  });
  audioEls.set(track.id, el);
  return el;
}

function resetAudioElements() {
  for (const el of audioEls.values()) {
    el.pause();
    el.src = '';
  }
  audioEls.clear();
  for (const track of state.project.audioTracks) ensureAudioElement(track);
}

function desiredSourceTime(track) {
  return (player.currentTime || 0) - track.offset;
}

function syncPlayback() {
  const playing = !player.paused && !player.ended;
  const anySolo = state.soloAudioId;
  // 和真实播放器一致：正常播放只响默认音轨；点「试听」时只响那一条。
  // 这样两种语言不会同时叠在一起，切换默认音轨立即生效。
  const usable = state.project.audioTracks.filter((track) => track.enabled && track.supported);
  const defaultTrack = usable.find((track) => track.default) || usable[0] || null;
  const audibleId = anySolo || defaultTrack?.id || null;

  for (const track of state.project.audioTracks) {
    const el = audioEls.get(track.id) || ensureAudioElement(track);
    if (!el) continue;
    const shouldPlay = track.id === audibleId && track.enabled && track.supported;
    if (!shouldPlay) {
      el.pause();
      continue;
    }
    const wanted = desiredSourceTime(track);
    const inRange = wanted >= 0 && (track.sourceDuration <= 0 || wanted < track.sourceDuration - 0.02);
    if (!inRange) {
      el.pause();
      if (wanted < 0) el.currentTime = 0;
      continue;
    }
    if (Math.abs((el.currentTime || 0) - wanted) > 0.22) {
      try {
        el.currentTime = wanted;
      } catch {
        /* seeking 未就绪时忽略 */
      }
    }
    el.muted = false;
    if (playing) {
      if (el.paused) {
        el.play().catch(() => {
          /* 浏览器拒绝自动播放时，用户再点一次播放即可 */
        });
      }
    } else if (!el.paused) {
      el.pause();
    }
  }
}

let syncTimer = null;
function startSyncLoop() {
  if (syncTimer) return;
  syncTimer = setInterval(syncPlayback, 250);
}

function pauseAllAudio() {
  for (const el of audioEls.values()) el.pause();
}

/* ------------------------------------------------------------------ */
/* 播放器事件                                                         */
/* ------------------------------------------------------------------ */

function setupPlayerEvents() {
  const play = () => {
    syncPlayback();
    startSyncLoop();
    updatePlayButton();
  };
  const pause = () => {
    pauseAllAudio();
    updatePlayButton();
  };
  player.addEventListener('play', play);
  player.addEventListener('pause', pause);
  player.addEventListener('seeked', () => {
    syncPlayback();
    updateOverlay();
    updatePlayheads();
  });
  player.addEventListener('timeupdate', () => {
    // timeupdate 每秒约 4 次；字幕重绘用节流，播放头则每帧都跟。
    refreshOverlay();
    updatePlayheads();
  });
  player.addEventListener('loadedmetadata', () => {
    if (state.project.video && (!state.project.video.duration || Math.abs(state.project.video.duration - player.duration) > 0.5)) {
      state.project.video.duration = player.duration;
      renderAll();
    }
  });
  player.addEventListener('ended', pause);
  player.addEventListener('error', () => {
    if (player.src) notify('视频无法在浏览器内播放；导出不受影响，仍可正常封装', 'warn', 5000);
  });
  player.addEventListener('click', togglePlay);
  player.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#video-frame').requestFullscreen?.();
  });
}

function togglePlay() {
  if (!state.project.video) {
    notify('先添加视频', 'warn');
    return;
  }
  if (player.paused) player.play().catch((error) => notify(`无法播放：${error.message}`, 'error'));
  else player.pause();
}

function updatePlayButton() {
  $('#btn-play').textContent = player.paused ? '▶' : '❚❚';
  document.body.classList.toggle('is-playing', !player.paused);
}

function updatePlayheads() {
  const duration = player.duration || videoDuration() || 0;
  const ratio = duration ? Math.min(1, Math.max(0, (player.currentTime || 0) / duration)) : 0;
  $('#scrub-playhead').style.left = `${ratio * 100}%`;
  for (const el of $$('[data-playhead]')) el.style.left = `${ratio * 100}%`;
  $('#timecode').textContent = `${formatClock(player.currentTime, { millis: true })} / ${formatClock(duration, { millis: true })}`;
}

function updateScrubMarkers(plan) {
  const container = $('#scrub-markers');
  const duration = plan.videoDuration;
  if (!duration) {
    container.innerHTML = '';
    return;
  }
  const primary = primarySubtitlePlan(plan);
  const cues = primary?.shiftedCues || [];
  container.innerHTML = cues
    .slice(0, 60)
    .map((cue) => {
      const left = Math.min(99.5, Math.max(0, (cue.start / duration) * 100));
      return `<span class="mark ${primary.language === 'zh' ? 'zh' : 'en'}" style="left:${left}%" title="${escapeHtml(formatClock(cue.start, { millis: true }))}"></span>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* 拾取文件                                                           */
/* ------------------------------------------------------------------ */

const PICKER_COPY = {
  video: { title: '选择视频', note: '一个项目只能使用一个视频。', accept: (entry) => entry.kind === 'video' },
  audio: { title: '选择音频', note: '可多选；每段独立音频会作为一条音轨。', accept: (entry) => entry.kind === 'audio' },
  subtitle: {
    title: '选择字幕',
    note: '可多选；支持 SRT / VTT / ASS / SSA，位图字幕请先转换。',
    accept: (entry) => entry.kind === 'subtitle',
  },
  config: {
    title: '载入轨道配置',
    note: '选择导出时生成的 .tracks.json，继续编辑偏移与默认轨。',
    accept: (entry) => entry.type === 'file' && entry.extension === 'json',
  },
};

async function openPicker(purpose) {
  state.pickerPurpose = purpose;
  state.pickerSelection.clear();
  const copy = PICKER_COPY[purpose];
  $('#picker-purpose').textContent = copy.title;
  $('#picker-note').textContent = copy.note;
  $('#picker-confirm').textContent = purpose === 'config' ? '载入配置' : '添加所选';
  $('#picker-confirm').disabled = true;
  const dialog = $('#picker');
  if (!dialog.open) dialog.showModal();
  await loadPickerDir(state.pickerDir);
}

async function loadPickerDir(dir) {
  try {
    const data = await api(`/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);
    state.pickerDir = data.dir;
    $('#picker-path').textContent = data.dir;
    $('#picker-roots').innerHTML = (data.roots || [])
      .map((root) => `<button class="root-btn" type="button" data-root="${escapeAttr(root.path)}">${escapeHtml(root.label)}</button>`)
      .join('');
    renderPickerList(data);
  } catch (error) {
    notify(`无法列出目录：${error.message}`, 'error');
  }
}

function renderPickerList(data) {
  const copy = PICKER_COPY[state.pickerPurpose];
  const list = $('#picker-list');
  const rows = [];
  if (data.parent) rows.push({ type: 'up', name: '..', path: data.parent, kind: 'directory' });
  for (const entry of data.entries) {
    if (entry.type === 'directory') {
      rows.push(entry);
      continue;
    }
    if (copy.accept(entry)) rows.push(entry);
  }
  if (!rows.length) {
    list.innerHTML = '<li class="picker-empty">这个目录里没有可用文件</li>';
    return;
  }
  list.innerHTML = rows
    .map((entry) => {
      if (entry.type === 'up') {
        return `<li class="picker-item" data-dir="${escapeAttr(entry.path)}"><span class="kind-icon">↰</span><span class="fname">上一级</span><span></span></li>`;
      }
      if (entry.type === 'directory') {
        return `<li class="picker-item" data-dir="${escapeAttr(entry.path)}"><span class="kind-icon">▸</span><span class="fname">${escapeHtml(entry.name)}</span><span></span></li>`;
      }
      const selected = state.pickerSelection.has(entry.path);
      const icon = entry.kind === 'video' ? '▣' : entry.kind === 'audio' ? '♪' : entry.kind === 'subtitle' ? '字' : '·';
      const size = entry.size != null ? bytes(entry.size) : '';
      const issue = entry.kind === 'subtitle' && !entry.supportedTextSubtitle ? '（位图/不支持）' : '';
      return `<li class="picker-item ${selected ? 'is-selected' : ''} ${issue ? 'is-unsupported' : ''}"
          data-file="${escapeAttr(entry.path)}" data-name="${escapeAttr(entry.name)}" data-kind="${entry.kind}">
          <span class="kind-icon">${icon}</span>
          <span class="fname" title="${escapeAttr(entry.path)}">${escapeHtml(entry.name)}</span>
          <span class="fmeta">${size}${issue}</span>
        </li>`;
    })
    .join('');
}

function togglePickerSelection(path, name, kind) {
  if (state.pickerPurpose === 'video' || state.pickerPurpose === 'config') {
    state.pickerSelection.clear();
    state.pickerSelection.add(path);
  } else if (state.pickerSelection.has(path)) {
    state.pickerSelection.delete(path);
  } else {
    state.pickerSelection.add(path);
  }
  for (const el of $$('#picker-list .picker-item[data-file]')) {
    el.classList.toggle('is-selected', state.pickerSelection.has(el.dataset.file));
  }
  $('#picker-confirm').disabled = state.pickerSelection.size === 0;
  void name;
  void kind;
}

async function confirmPicker() {
  const paths = [...state.pickerSelection];
  if (!paths.length) return;
  const purpose = state.pickerPurpose;
  $('#picker').close();
  state.pickerSelection.clear();

  if (purpose === 'config') {
    await loadConfigFile(paths[0]);
    return;
  }

  const entries = paths.map((p) => ({ path: p, name: p.split(/[\\/]/).pop() }));
  await addEntries(entries, purpose);
}

async function uploadFiles(fileList) {
  const purpose = state.pickerPurpose;
  const files = [...fileList];
  if (!files.length) return;
  const target = purpose === 'config' ? null : purpose;
  if (purpose === 'config') {
    notify('上传配置请直接拖入 JSON 到命令行或放到本地目录后选择', 'warn');
    return;
  }
  const added = [];
  for (const file of files) {
    try {
      const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        body: file,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message || '上传失败');
      added.push({ path: payload.path, name: payload.name });
    } catch (error) {
      notify(`「${file.name}」上传失败：${error.message}`, 'error');
    }
  }
  if (added.length) {
    $('#picker').close();
    await addEntries(added, target);
  }
}

async function loadConfigFile(configPath) {
  try {
    const { config } = await api(`/api/config?path=${encodeURIComponent(configPath)}`);
    const next = emptyProject();
    next.name = config.projectName || '导入的项目';
    next.outputPath = config.output?.path || '';

    const importPaths = [config.video?.path, ...config.audioTracks.map((t) => t.path), ...config.subtitleTracks.map((t) => t.path)]
      .filter(Boolean);
    const imported = await api('/api/import', { method: 'POST', body: JSON.stringify({ paths: importPaths }) });
    const byPath = new Map();
    for (const item of imported.results) {
      if (item.ok) byPath.set(item.path, item);
    }
    const videoItem = byPath.get(config.video.path);
    if (!videoItem) throw new Error('配置中的视频文件无法读取');
    next.video = {
      token: videoItem.token,
      path: videoItem.path,
      name: videoItem.name,
      duration: videoItem.duration || config.video.duration,
      width: videoItem.video?.width ?? config.video.width,
      height: videoItem.video?.height ?? config.video.height,
      codec: videoItem.video?.codec,
    };

    for (const track of config.audioTracks) {
      const item = byPath.get(track.path);
      if (!item) continue;
      next.audioTracks.push(
        makeTrack(
          {
            id: track.id,
            token: item.token,
            path: item.path,
            name: track.name || item.name,
            language: track.language,
            offset: track.offset,
            enabled: track.enabled,
            default: track.default,
            sourceDuration: track.sourceDuration || item.duration,
            supported: Boolean(item.audio),
            supportIssue: item.audio ? null : item.issue,
            codec: item.audio?.codec,
            sampleRate: item.audio?.sampleRate,
            channels: item.audio?.channels,
          },
          'audio',
        ),
      );
    }
    for (const track of config.subtitleTracks) {
      const item = byPath.get(track.path);
      if (!item) continue;
      next.subtitleTracks.push(
        makeTrack(
          {
            id: track.id,
            token: item.token,
            path: item.path,
            name: track.name || item.name,
            language: track.language,
            offset: track.offset,
            enabled: track.enabled,
            default: track.default,
            sourceDuration: track.sourceDuration,
            supported: item.subtitle?.ok === true && !item.issue,
            supportIssue: item.issue || (item.subtitle?.ok === false ? item.subtitle.reason : null),
            format: track.format,
            cueCount: track.cueCount,
          },
          'subtitle',
        ),
      );
    }

    state.project = next;
    state.lastVerification = null;
    player.src = `/media/${next.video.token}`;
    player.muted = true;
    $('#video-placeholder').hidden = true;
    resetAudioElements();
    for (const track of next.subtitleTracks) {
      if (track.supported) await loadSubtitleCues(track);
      else track.pending = false;
    }
    normalizeDefaultFlags();
    pickActiveSubtitle(next.subtitleTracks.find((track) => track.default)?.id || null);
    renderAll();
    notify(`已载入配置，可继续调整偏移后重新导出`, 'ok');
  } catch (error) {
    notify(`载入配置失败：${error.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 导出与读回                                                         */
/* ------------------------------------------------------------------ */

function projectPayload() {
  return {
    name: state.project.name,
    video: state.project.video ? { token: state.project.video.token } : null,
    audioTracks: state.project.audioTracks.map((track) => ({
      id: track.id,
      token: track.token,
      name: track.name,
      language: track.language,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
    })),
    subtitleTracks: state.project.subtitleTracks.map((track) => ({
      id: track.id,
      token: track.token,
      name: track.name,
      language: track.language,
      offset: track.offset,
      enabled: track.enabled,
      default: track.default,
    })),
  };
}

async function beginExport() {
  if (state.exporting) return;
  if (!state.project.video) {
    notify('请先添加视频', 'warn');
    return;
  }
  const outputPath = $('#output-path').value.trim();
  state.project.outputPath = outputPath;

  state.exporting = true;
  renderAll();
  $('#export-result').hidden = true;
  $('#progress-wrap').hidden = false;
  setProgress(0, '校验项目…');
  player.pause();
  pauseAllAudio();

  try {
    // 先让服务端用真实文件重新构建一次计划；本地计划只负责界面即时反馈。
    const preflight = await api('/api/plan', {
      method: 'POST',
      body: JSON.stringify(projectPayload()),
    });
    if (!preflight.plan.ready) {
      const message = preflight.plan.errors.map((error) => error.message).join('；');
      throw new Error(`项目尚未就绪：${message}`);
    }

    const { jobId, eventsUrl } = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify({ project: projectPayload(), outputPath }),
    });
    followJob(jobId, eventsUrl);
  } catch (error) {
    state.exporting = false;
    $('#progress-wrap').hidden = true;
    renderAll();
    notify(error.message, 'error', 6000);
    showExportError(error);
  }
}

function followJob(jobId, eventsUrl) {
  if (state.jobSource) state.jobSource.close();
  const source = new EventSource(eventsUrl);
  state.jobSource = source;

  source.addEventListener('progress', (event) => {
    const payload = JSON.parse(event.data);
    setProgress(payload.progress ?? 0, payload.message || '');
    if (payload.status === 'done') {
      source.close();
      state.jobSource = null;
      state.exporting = false;
      $('#progress-wrap').hidden = true;
      $('#export-result').hidden = false;
      state.lastVerification = { ...payload.result, outputPath: payload.result.outputPath };
      renderExportResult(payload.result);
      renderAll();
      notify(payload.result.verification.ok ? '导出完成，读回校验通过' : '导出完成，但读回校验发现问题', payload.result.verification.ok ? 'ok' : 'warn', 6000);
    } else if (payload.status === 'failed') {
      source.close();
      state.jobSource = null;
      state.exporting = false;
      $('#progress-wrap').hidden = true;
      renderAll();
      showExportError(payload.error || { message: '导出失败' });
      notify(payload.error?.message || '导出失败', 'error', 7000);
    }
  });

  source.addEventListener('error', () => {
    // EventSource 在服务端结束时也会触发 error；若不是 done/failed 状态则轮询一次兜底。
    if (!state.exporting) return;
    source.close();
    state.jobSource = null;
    pollJob(jobId).catch(() => {
      state.exporting = false;
      renderAll();
      notify('与导出任务的连接中断，请查看任务状态或重试', 'error', 6000);
    });
  });
}

async function pollJob(jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  if (job.status === 'done') {
    state.exporting = false;
    $('#progress-wrap').hidden = true;
    $('#export-result').hidden = false;
    state.lastVerification = { ...job.result, outputPath: job.result.outputPath };
    renderExportResult(job.result);
    renderAll();
    return;
  }
  if (job.status === 'failed') {
    state.exporting = false;
    $('#progress-wrap').hidden = true;
    renderAll();
    showExportError(job.error);
    return;
  }
  setProgress(job.progress || 0, job.message || '导出中…');
  setTimeout(() => pollJob(jobId).catch(() => {}), 800);
}

function setProgress(progress, label) {
  $('#progress-wrap').hidden = false;
  $('#progress-bar').style.width = `${Math.max(0, Math.min(100, progress))}%`;
  $('#progress-value').textContent = `${Math.round(progress)}%`;
  $('#progress-label').textContent = label;
}

function renderExportResult(result) {
  const container = $('#export-result');
  const v = result.verification;
  const checks = v?.checks || [];
  container.className = `result ${v?.ok ? 'ok' : 'bad'}`;
  container.innerHTML = `
    <div><strong>${v?.ok ? '读回校验通过' : '读回校验发现问题'}</strong>
      <span class="muted"> · ${result.audioCount} 条音轨 / ${result.subtitleCount} 条字幕 · ${bytes(result.size)} · ${(result.elapsedMs / 1000).toFixed(1)}s</span>
    </div>
    <div class="result-path">成品：${escapeHtml(result.outputPath)}</div>
    <div class="result-path">配置：${escapeHtml(result.configPath)}</div>
    <div class="check-list">
      ${checks
        .map(
          (item) => `<div class="check-row ${item.ok ? 'ok' : 'bad'}">
            <span class="tick">${item.ok ? '✓' : '✕'}</span>
            <span>${escapeHtml(item.label)}${item.detail && !item.ok ? `<small>${escapeHtml(JSON.stringify(item.detail))}</small>` : ''}</span>
          </div>`,
        )
        .join('')}
    </div>
    ${v?.issues?.length ? `<div class="track-alert error">${v.issues.map((issue) => escapeHtml(issue.message)).join('<br>')}</div>` : ''}
    <div class="result-actions">
      <button class="btn btn-mini" id="btn-copy-config" type="button">复制配置路径</button>
      <button class="btn btn-mini" id="btn-result-verify" type="button">重新读回校验</button>
    </div>
  `;
  $('#btn-verify-output').disabled = false;
  $('#btn-copy-config').addEventListener('click', () => {
    navigator.clipboard?.writeText(result.configPath).then(
      () => notify('配置路径已复制', 'ok', 1800),
      () => notify(result.configPath, 'info', 4000),
    );
  });
  $('#btn-result-verify').addEventListener('click', () => verifyOutputFile(result.outputPath, result.configPath));
}

function showExportError(error) {
  const container = $('#export-result');
  container.hidden = false;
  container.className = 'result bad';
  const details = error?.details?.errors || error?.details?.tracks || null;
  container.innerHTML = `
    <div><strong>导出失败</strong></div>
    <div class="result-path">${escapeHtml(error?.message || '未知错误')}</div>
    ${details ? `<div class="track-alert error">${details.map((item) => escapeHtml(item.message || item.name || JSON.stringify(item))).join('<br>')}</div>` : ''}
  `;
}

async function verifyOutputFile(outputPath, configPath) {
  try {
    notify('正在读回成品…', 'info', 1500);
    const { verification } = await api('/api/verify', {
      method: 'POST',
      body: JSON.stringify({ path: outputPath, configPath }),
    });
    state.lastVerification = { outputPath, ...state.lastVerification, verification };
    $('#export-result').hidden = false;
    renderExportResult({
      outputPath,
      configPath,
      verification,
      audioCount: verification.readBack.audioTracks.length,
      subtitleCount: verification.readBack.subtitleTracks.length,
      size: state.lastVerification?.size || 0,
      elapsedMs: state.lastVerification?.elapsedMs || 0,
    });
    notify(verification.ok ? '读回校验通过' : '读回校验发现问题', verification.ok ? 'ok' : 'warn', 4000);
  } catch (error) {
    notify(`读回失败：${error.message}`, 'error', 6000);
  }
}

/* ------------------------------------------------------------------ */
/* 示例核对                                                           */
/* ------------------------------------------------------------------ */

async function runSampleCheck() {
  const status = $('#sample-status');
  status.textContent = '核对中…';
  status.className = 'warn';
  try {
    const report = await api('/api/samples/check', { method: 'POST', body: '{}' });
    state.sampleCheck = report;
    $('#sample-status').textContent = report.ok ? '通过' : '有问题';
    $('#sample-status').className = report.ok ? 'ok' : 'bad';
    renderSampleReport(report);
    renderAll();
  } catch (error) {
    $('#sample-status').textContent = '失败';
    $('#sample-status').className = 'bad';
    notify(`示例核对失败：${error.message}`, 'error');
  }
}

function renderSampleReport(report) {
  const container = $('#sample-report');
  const rows = [];
  for (const [code, info] of Object.entries(report.languages)) {
    const label = languageInfo(code).label;
    const offsets = info.differences.map((item) => item.delta).filter((value) => value != null);
    const maxDelta = offsets.length ? Math.max(...offsets.map(Math.abs)) : null;
    rows.push(`
      <div class="sample-row">
        <div>
          <strong>${label} · 音调 ↔ 字幕</strong>
          <small class="mono">音轨起点 ${info.onsets.slice(0, 3).map((t) => t.toFixed(2)).join(' / ')}… · 推荐偏移 ${formatSigned(info.recommendedOffset)}</small>
        </div>
        <span class="${maxDelta != null && maxDelta < 0.02 ? 'ok' : 'warn'}">${maxDelta == null ? '—' : `${(maxDelta * 1000).toFixed(0)}ms`}</span>
      </div>`);
  }
  const crossMax = Math.max(...report.crossLanguage.map((item) => item.delta ?? 0));
  rows.push(`
    <div class="sample-row">
      <div>
        <strong>双语同一时点</strong>
        <small>${report.cues.length} 个时点，两种语言音调起音最大相差</small>
      </div>
      <span class="${crossMax < 0.02 ? 'ok' : 'bad'}">${(crossMax * 1000).toFixed(0)}ms</span>
    </div>`);
  const failed = report.checks.filter((check) => !check.ok);
  if (failed.length) {
    rows.push(
      `<div class="sample-row"><div><strong class="bad">未通过项</strong><small>${failed.map((item) => escapeHtml(item.label)).join('；')}</small></div><span class="bad">${failed.length}</span></div>`,
    );
  }
  container.innerHTML = rows.join('');
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                           */
/* ------------------------------------------------------------------ */

function bindGlobalEvents() {
  $('#btn-sample').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await loadSampleProject();
    } catch (error) {
      notify(`载入示例失败：${error.message}`, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  $('#btn-open-picker').addEventListener('click', () => openPicker('video'));
  $('#btn-load-config').addEventListener('click', () => openPicker('config'));
  $('[data-action="greet-sample"]').addEventListener('click', () => loadSampleProject().catch((error) => notify(error.message, 'error')));
  $('[data-action="greet-picker"]').addEventListener('click', () => openPicker('video'));

  $$('[data-add]').forEach((button) => {
    button.addEventListener('click', () => openPicker(button.dataset.add));
  });

  $('#btn-export').addEventListener('click', beginExport);
  $('#btn-export-2').addEventListener('click', beginExport);

  $('#output-path').addEventListener('change', (event) => {
    state.project.outputPath = event.target.value.trim();
  });

  $$('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      $$('.filter').forEach((item) => item.classList.toggle('is-active', item === button));
      renderIssues(state.plan || buildLocalPlan());
    });
  });

  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-back-1').addEventListener('click', () => seekTo((player.currentTime || 0) - 1));
  $('#btn-fwd-1').addEventListener('click', () => seekTo((player.currentTime || 0) + 1));
  $$('.speed-btn').forEach((button) => {
    button.addEventListener('click', () => {
      player.playbackRate = Number(button.dataset.speed);
      $$('.speed-btn').forEach((item) => item.classList.toggle('is-active', item === button));
    });
  });

  $('#scrub').addEventListener('pointerdown', (event) => {
    const track = event.currentTarget;
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    seekTo(ratio * (player.duration || videoDuration()));
  });

  $('#btn-swap-subtitle').addEventListener('click', () => {
    const plan = state.plan;
    const primary = plan && primarySubtitlePlan(plan);
    if (!primary) return;
    const usable = plan.subtitleTracks.filter((track) => track.enabled && track.supported);
    const other = usable.find((track) => track.id !== primary.id);
    if (!other) return;
    const time = player.currentTime;
    pickActiveSubtitle(other.id);
    renderAll();
    // 明确回到原位置，验证“切换后画面保持当前位置”。
    player.currentTime = time;
    updateOverlay();
    notify(`已切换到「${other.name}」，画面保持在 ${formatClock(time, { millis: true })}`, 'ok', 3000);
  });

  $('#btn-jump-next').addEventListener('click', () => jumpToCue(1));
  $('#btn-jump-prev').addEventListener('click', () => jumpToCue(-1));

  $('#btn-check-samples').addEventListener('click', runSampleCheck);

  $('#btn-verify-output').addEventListener('click', () => {
    const target = state.lastVerification;
    if (target?.outputPath) verifyOutputFile(target.outputPath, target.configPath);
  });

  $('#btn-rename').addEventListener('click', () => {
    $('#rename-input').value = state.project.name;
    $('#rename-dialog').showModal();
  });
  $('#rename-cancel').addEventListener('click', () => $('#rename-dialog').close());
  $('#rename-confirm').addEventListener('click', () => {
    const value = $('#rename-input').value.trim();
    if (value) state.project.name = value;
    $('#rename-dialog').close();
    renderAll();
  });

  // 轨道卡片：事件委托
  document.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const id = actionEl.dataset.id;
    const track = id ? trackById(id) : null;

    if (action === 'up' || action === 'down') {
      if (track) moveTrack(track, action === 'up' ? -1 : 1);
      return;
    }
    if (action === 'default') {
      if (track) setDefault(track);
      return;
    }
    if (action === 'toggle') {
      if (track) toggleEnabled(track);
      return;
    }
    if (action === 'remove') {
      if (track) removeTrack(track);
      return;
    }
    if (action === 'nudge') {
      if (track) nudgeOffset(track, Number(actionEl.dataset.delta));
      return;
    }
    if (action === 'solo') {
      if (!track) return;
      state.soloAudioId = state.soloAudioId === track.id ? null : track.id;
      syncPlayback();
      renderAll();
      if (state.soloAudioId && player.paused) {
        player.play().catch(() => {});
      }
      return;
    }
    if (action === 'activate-sub') {
      if (!track) return;
      const time = player.currentTime;
      pickActiveSubtitle(track.id);
      renderAll();
      player.currentTime = time;
      updateOverlay();
      return;
    }
    if (action === 'locate') {
      if (!track) return;
      locateTrack(track);
      return;
    }
    if (action === 'issue-locate') {
      if (track) locateTrack(track);
      return;
    }
  });

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset?.action === 'offset') {
      const track = trackById(target.dataset.id);
      if (track) setOffset(track, target.value);
    }
    if (target.dataset?.action === 'language') {
      const track = trackById(target.dataset.id);
      if (track) {
        track.language = normalizeLanguage(target.value);
        renderAll();
      }
    }
  });

  // 拖动排序
  let dragTrackId = null;
  document.addEventListener('dragstart', (event) => {
    const card = event.target.closest('.track-card');
    if (!card) return;
    dragTrackId = card.dataset.trackId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragTrackId);
  });
  document.addEventListener('dragover', (event) => {
    const card = event.target.closest('.track-card');
    if (!card || !dragTrackId) return;
    if (card.dataset.trackId !== dragTrackId) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    const card = event.target.closest('.track-card');
    if (!card || !dragTrackId) return;
    event.preventDefault();
    const source = trackById(dragTrackId);
    const target = trackById(card.dataset.trackId);
    if (!source || !target || source.kind !== target.kind) return;
    const group = trackGroup(source);
    const from = group.indexOf(source);
    const to = group.indexOf(target);
    group.splice(from, 1);
    group.splice(to, 0, source);
    dragTrackId = null;
    renderAll();
  });

  // 键盘
  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if ($('#picker').open || $('#rename-dialog').open) return;
    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.code === 'ArrowLeft') {
      seekTo((player.currentTime || 0) - (event.shiftKey ? 5 : 1));
    } else if (event.code === 'ArrowRight') {
      seekTo((player.currentTime || 0) + (event.shiftKey ? 5 : 1));
    }
  });

  // 拾取器
  $('#picker-cancel').addEventListener('click', () => $('#picker').close());
  $('#picker-confirm').addEventListener('click', confirmPicker);
  $('#picker-up').addEventListener('click', () => {
    const current = $('#picker-path').textContent;
    const parent = current.replace(/[\\/][^\\/]+$/, '');
    if (parent && parent !== current) loadPickerDir(parent);
  });
  $('#picker-list').addEventListener('click', (event) => {
    const dirItem = event.target.closest('[data-dir]');
    if (dirItem) {
      loadPickerDir(dirItem.dataset.dir);
      return;
    }
    const fileItem = event.target.closest('[data-file]');
    if (fileItem) togglePickerSelection(fileItem.dataset.file, fileItem.dataset.name, fileItem.dataset.kind);
  });
  $('#picker-roots').addEventListener('click', (event) => {
    const root = event.target.closest('[data-root]');
    if (root) loadPickerDir(root.dataset.root);
  });
  $('#picker-upload').addEventListener('change', (event) => uploadFiles(event.target.files));

  window.addEventListener('beforeunload', () => {
    if (state.jobSource) state.jobSource.close();
  });
}

function locateTrack(track) {
  if (!state.plan) return;
  const planTrack = [...state.plan.audioTracks, ...state.plan.subtitleTracks].find(
    (item) => item.id === track.id,
  );
  let time = null;
  if (track.kind === 'subtitle') {
    const cues = planTrack?.shiftedCues || [];
    time = cues.length ? cues[0].start : null;
  } else if (planTrack?.timeline) {
    time = planTrack.timeline.effectiveStart;
  }
  if (time == null) {
    notify(`「${track.name}」在当前偏移下没有落在视频内的内容`, 'warn');
    return;
  }
  seekTo(time);
  notify(`已定位到「${track.name}」的起点 ${formatClock(time, { millis: true })}`, 'info', 2400);
}

/* ------------------------------------------------------------------ */
/* 杂项                                                               */
/* ------------------------------------------------------------------ */

function bytes(value) {
  const n = Number(value || 0);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

setupPlayerEvents();
startSyncLoop();
bootstrap().catch((error) => notify(`初始化失败：${error.message}`, 'error', 8000));
