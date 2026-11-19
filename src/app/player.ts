import type { Store } from './state.ts';
import { simulateScene } from '../core/simulation.ts';
import type { SceneRenderer } from '../render/renderer.ts';

export interface PlayerOptions {
  store: Store;
  renderer: SceneRenderer;
}

export interface Player {
  start(): void;
  stop(): void;
  requestRender(): void;
  readonly lastSimMs: number;
}

/**
 * 播放循环。
 *
 * 每个新时刻都由无状态仿真从项目参数重算，所以拖动、跳帧、改参数
 * 都不会残留旧状态。渲染按需进行：只有播放推进、参数变化或显式请求
 * 时才重绘。
 */
export function createPlayer(options: PlayerOptions): Player {
  const { store, renderer } = options;
  let running = false;
  let frameHandle = 0;
  let lastTimestamp = 0;
  let needsRender = true;
  let smoothedFps = 0;
  let lastSimMs = 0;

  function renderFrame() {
    const current = store.state;
    const started = performance.now();
    const simulation = simulateScene(
      current.project.scene,
      current.project.emitters,
      current.playback.time,
    );
    const simMs = performance.now() - started;

    const output = renderer.render({
      scene: current.project.scene,
      emitters: current.project.emitters,
      simulation,
      time: current.playback.time,
      showEmitterMarkers: current.view.showMarkers,
      showGrid: current.view.showGrid,
      selectedEmitterId: current.view.selectedEmitterId,
    });

    const frameMs = performance.now() - started;
    smoothedFps = frameMs > 0 ? smoothedFps * 0.85 + (1000 / frameMs) * 0.15 : 0;
    lastSimMs = simMs;

    store.update((app) => {
      app.stats = {
        particleCount: simulation.total,
        simMs,
        drawMs: output.drawMs,
        frameMs,
        fps: smoothedFps,
        overCap: simulation.overBudget,
        omitted: simulation.omittedTotal,
        capped: simulation.capped,
        scanReduced: simulation.scanReduced,
        aliveTotal: simulation.aliveTotal,
        perEmitter: simulation.emitters.map((result) => {
          const emitter = app.project.emitters.find((e) => e.id === result.emitterId);
          return {
            id: result.emitterId,
            name: emitter?.name ?? result.emitterId,
            count: result.particles.length,
            alive: result.aliveCount,
            omitted: result.omitted,
            simMs: result.simMs,
            budget: result.budget,
            enabled: emitter?.enabled ?? false,
          };
        }),
      };
    }, 'stats');
  }

  function tick(timestamp: number) {
    if (!running) return;
    const current = store.state;
    const rawDelta = lastTimestamp === 0 ? 0 : timestamp - lastTimestamp;
    lastTimestamp = timestamp;
    const delta = Math.min(rawDelta, 100) / 1000;

    if (current.playback.playing && delta > 0) {
      store.update((app) => {
        const duration = Math.max(0.05, app.project.scene.duration);
        let next = app.playback.time + delta;
        if (next >= duration) {
          if (app.playback.loop) next %= duration;
          else {
            next = duration;
            app.playback.playing = false;
          }
        }
        app.playback.time = next;
      }, 'playback');
      needsRender = true;
    }

    if (needsRender) {
      renderFrame();
      needsRender = false;
    }

    frameHandle = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTimestamp = 0;
      frameHandle = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (frameHandle) cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    },
    requestRender() {
      needsRender = true;
    },
    get lastSimMs() {
      return lastSimMs;
    },
  };
}

/**
 * 逐帧步进：先暂停，再按帧率前进一格。
 * 先把当前时间量化到帧号再加减，避免浮点累积误差导致「按一下没动」。
 */
export function stepTime(store: Store, direction: 1 | -1): void {
  const state = store.state;
  const fps = Math.max(1, state.playback.stepFps ?? state.project.scene.fps);
  const duration = Math.max(0.05, state.project.scene.duration);
  const lastFrame = Math.floor(duration * fps + 1e-6);
  const currentFrame = Math.round(state.playback.time * fps);
  let nextFrame = currentFrame + direction;

  if (nextFrame < 0) nextFrame = state.playback.loop ? lastFrame : 0;
  if (nextFrame > lastFrame) nextFrame = state.playback.loop ? 0 : lastFrame;

  const next = Math.min(duration, nextFrame / fps);
  store.update((app) => {
    app.playback.playing = false;
    app.playback.time = next;
  }, 'playback');
}

/**
 * 拖动/跳转到指定时间。
 * 这里按「绝对定位」处理：夹在 [0, duration] 内，不因循环而回绕；
 * 循环只影响播放推进，否则拖到最右端会突然跳回 0。
 */
export function seekTime(store: Store, time: number): void {
  const duration = Math.max(0.05, store.state.project.scene.duration);
  const next = Math.min(duration, Math.max(0, Number.isFinite(time) ? time : 0));
  store.update((app) => {
    app.playback.time = next;
  }, 'playback');
}
