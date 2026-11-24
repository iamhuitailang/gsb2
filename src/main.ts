import { SamplerEngine } from './audio/engine.ts';
import { loadSamples } from './audio/loader.ts';
import { midiToName } from './audio/notes.ts';
import { Recorder } from './audio/recorder.ts';
import type { Recording, SampleFailure } from './types.ts';
import { h } from './ui/dom.ts';
import { KeyboardView } from './ui/keyboard.ts';
import { SampleStatusPanel } from './ui/sampleStatusPanel.ts';
import { SplicePanel } from './ui/splicePanel.ts';
import { TransportPanel } from './ui/transportPanel.ts';
import { VoiceLogPanel } from './ui/voiceLogPanel.ts';
import { VoicePolicyPanel } from './ui/voicePolicyPanel.ts';
import './styles.css';

const LOW_MIDI = 48; // C3
const HIGH_MIDI = 76; // E5
const MAX_VOICES = 12;

const statusEl = document.querySelector<HTMLElement>('#engine-status')!;
const bannerEl = document.querySelector<HTMLElement>('#load-banner')!;

let engine: SamplerEngine | null = null;
let ctx: AudioContext | null = null;
let velocityThreshold = 80;
const recorder = new Recorder();
let keyboard: KeyboardView | null = null;
let replayTimers: ReturnType<typeof setTimeout>[] = [];
let velocity = 96;

function showBanner(failures: SampleFailure[]): void {
  if (failures.length === 0) {
    bannerEl.classList.add('hidden');
    return;
  }
  bannerEl.classList.remove('hidden');
  bannerEl.replaceChildren(
    h('strong', {}, ['部分样本加载失败，对应键区已自动回退：']),
    h(
      'ul',
      {},
      failures.map((f) =>
        h('li', {}, [
          `${f.keyZone}（${f.file}）：${f.kind === 'missing' ? '文件缺失' : '文件损坏无法解码'} —— ${f.message}`,
        ]),
      ),
    ),
  );
}

function updateVoiceCount(): void {
  document.querySelector('#voice-count')!.textContent = `活动声部 ${engine?.activeVoiceCount ?? 0}`;
}

function handleNoteOn(note: number): void {
  if (!engine || !ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  engine.noteOn(note, velocity, ctx.currentTime);
  keyboard?.setActive(note, true);
  if (recorder.recording) recorder.recordOn(ctx.currentTime, note, velocity);
}

function handleNoteOff(note: number): void {
  if (!engine || !ctx) return;
  engine.noteOff(note, ctx.currentTime);
  keyboard?.setActive(note, false);
  if (recorder.recording) recorder.recordOff(ctx.currentTime, note);
}

function stopReplay(): void {
  for (const t of replayTimers) clearTimeout(t);
  replayTimers = [];
}

function replay(rec: Recording): void {
  if (!engine || !ctx) return;
  stopReplay();
  const base = ctx.currentTime + 0.08;
  for (const ev of rec.events) {
    replayTimers.push(
      setTimeout(() => {
        if (ev.type === 'on') {
          engine!.noteOn(ev.note, ev.velocity ?? 96, base + ev.time);
          keyboard?.setActive(ev.note, true);
        } else {
          engine!.noteOff(ev.note, base + ev.time);
          keyboard?.setActive(ev.note, false);
        }
      }, ev.time * 1000),
    );
  }
}

async function boot(): Promise<void> {
  statusEl.textContent = '加载采样中…';
  ctx = new AudioContext();
  const load = await loadSamples('/samples/manifest.json', ctx);
  velocityThreshold = load.manifest.velocityThreshold;

  const voiceLog = new VoiceLogPanel();
  engine = new SamplerEngine(ctx, load.samples, velocityThreshold, MAX_VOICES, {
    onVoiceStart: (info) => {
      voiceLog.addStart(info);
      keyboard?.flashUsedSample(
        info.note,
        `${midiToName(info.choice.usedRoot)}·${info.choice.usedLayer === 'soft' ? '轻' : '重'}`,
      );
      updateVoiceCount();
    },
    onVoiceEnd: (ev) => {
      voiceLog.addEnd(ev);
      updateVoiceCount();
    },
    onError: (msg) => console.warn('sampler error:', msg),
  });

  showBanner(load.failures);

  // 键盘
  keyboard = new KeyboardView(LOW_MIDI, HIGH_MIDI, {
    onNoteOn: handleNoteOn,
    onNoteOff: handleNoteOff,
  });
  document.querySelector('#keyboard')!.replaceChildren(keyboard.el);
  for (const f of load.failures) keyboard.markFault(f.root);

  // 各侧边面板
  document
    .querySelector('#sample-status')!
    .replaceChildren(new SampleStatusPanel(load).el);
  document
    .querySelector('#splice-panel')!
    .replaceChildren(new SplicePanel(engine, engine.loopSamples).el);
  document
    .querySelector('#voice-policy')!
    .replaceChildren(new VoicePolicyPanel(engine, updateVoiceCount).el);
  document.querySelector('#voice-log')!.replaceChildren(voiceLog.el);

  const recDot = document.querySelector('#rec-indicator')!;
  const transport = new TransportPanel(
    {
      onStart: () => ctx && recorder.start(ctx.currentTime),
      onStop: () => (ctx ? recorder.stop(ctx.currentTime) : null),
      onReplay: replay,
      onExportWav: (rec: Recording) =>
        SamplerEngine.renderOffline(
          load.manifest.sampleRate,
          load.samples,
          velocityThreshold,
          engine!.voiceLimit,
          engine!.getCrossfade(),
          rec.events,
          rec.duration,
        ),
    },
    recDot as HTMLElement,
  );
  document.querySelector('#transport')!.replaceChildren(transport.el);

  // 力度控制
  const velSlider = document.querySelector<HTMLInputElement>('#velocity')!;
  const velValue = document.querySelector<HTMLElement>('#velocity-value')!;
  velSlider.addEventListener('input', () => {
    velocity = Number(velSlider.value);
    velValue.textContent = String(velocity);
  });
  document.querySelector('#vel-soft')!.addEventListener('click', () => {
    velSlider.value = '50';
    velocity = 50;
    velValue.textContent = '50';
  });
  document.querySelector('#vel-hard')!.addEventListener('click', () => {
    velSlider.value = '110';
    velocity = 110;
    velValue.textContent = '110';
  });

  // 页面隐藏/关闭时全停，避免后台长鸣
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) engine?.panic();
  });
  window.addEventListener('pagehide', () => engine?.dispose());

  statusEl.textContent = `就绪 · ${load.samples.length}/${load.manifest.samples.length} 个样本可用`;
  setInterval(updateVoiceCount, 500);
}

// 浏览器自动播放策略：第一次用户手势里创建/恢复 AudioContext
const bootOverlay = h('div', { class: 'boot-overlay' }, [
  h('div', { class: 'boot-card' }, [
    h('h2', {}, ['钟声采样乐器']),
    h('p', {}, ['点击开始以加载采样并启用音频（浏览器要求在用户手势后启动音频）。']),
    h('button', { class: 'btn primary big' }, ['开始演奏']),
  ]),
]);
document.body.append(bootOverlay);
bootOverlay.querySelector('button')!.addEventListener('click', async () => {
  bootOverlay.remove();
  try {
    await boot();
  } catch (err) {
    statusEl.textContent = '初始化失败';
    bannerEl.classList.remove('hidden');
    bannerEl.replaceChildren(
      h('strong', {}, ['采样加载失败：']),
      h('span', {}, [err instanceof Error ? err.message : String(err)]),
      h('p', {}, ['请先运行 npm run generate:samples 生成试听素材，再刷新页面。']),
    );
  }
});
