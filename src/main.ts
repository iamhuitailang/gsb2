import './styles.css';
import { Store } from './store';
import { AudioEngine } from './audio/AudioEngine';
import { Timeline } from './ui/timeline';
import { TrackHeaders } from './ui/trackHeaders';
import { MediaBin } from './ui/mediaBin';
import { Toolbar } from './ui/toolbar';
import { exportMix } from './audio/exporter';

const store = new Store();
const engine = new AudioEngine();

const timelineCanvas = document.getElementById('timeline-canvas') as HTMLCanvasElement;
const rulerCanvas = document.getElementById('ruler-canvas') as HTMLCanvasElement;
const timelineScroll = document.getElementById('timeline-scroll') as HTMLElement;
const headersScroll = document.getElementById('headers-scroll') as HTMLElement;
const headersEl = document.getElementById('track-headers') as HTMLElement;

const timeline = new Timeline(timelineCanvas, rulerCanvas, timelineScroll, store, engine);
new TrackHeaders(headersEl, store, engine);
new MediaBin(document.getElementById('media-bin') as HTMLElement, store, engine);
new Toolbar(store, engine);

/* 纵向滚动同步：左侧轨道头与右侧时间线共用同一 scrollTop */
timelineScroll.addEventListener('scroll', () => {
  headersScroll.scrollTop = timelineScroll.scrollTop;
}, { passive: true });

/* 轨道数量变化后重新计算画布高度 */
let prevTrackCount = store.project.tracks.length;
store.subscribe(() => {
  if (store.project.tracks.length !== prevTrackCount) {
    prevTrackCount = store.project.tracks.length;
    timeline.refresh();
  }
});

/* Toast 提示 */
const toastHost = document.getElementById('toast-container')!;
window.addEventListener('arranger:toast', (e) => {
  const message = (e as CustomEvent<string>).detail;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastHost.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('hide');
    window.setTimeout(() => toast.remove(), 300);
  }, 2600);
});

/* 页面隐藏/关闭前立即落盘，保证刷新可恢复 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') store.flushSave();
});
window.addEventListener('pagehide', () => store.flushSave());
window.addEventListener('beforeunload', () => store.flushSave());

/* 首次用户手势时初始化音频上下文（浏览器自动播放策略要求） */
const initAudio = () => {
  void engine.ensureContext();
  window.removeEventListener('pointerdown', initAudio);
  window.removeEventListener('keydown', initAudio);
};
window.addEventListener('pointerdown', initAudio);
window.addEventListener('keydown', initAudio);

/* 预加载示例资源，让波形尽快显示 */
void engine.loadProject(store.project).then(() => timeline.refresh());

/* 调试/自动化测试钩子（数据仍全部保存在本地） */
Object.assign(window as unknown as Record<string, unknown>, {
  __store: store,
  __engine: engine,
  __timeline: timeline,
  __exportMix: exportMix,
});
