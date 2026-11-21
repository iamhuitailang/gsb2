/*
 * 逐字播放器。
 *
 * 事件序列直接由解析单元构建：每个字形是一个 step，wait 标记在其锚定字形之后插入等待。
 * 进度以「已显示字形数（0..charCount）」为唯一真相，因此重排版后进度仍与文字对应。
 */
(function (global) {
  'use strict';

  function createPlayer(parsed, options) {
    const opts = Object.assign({
      charIntervalMs: 55, // 每个字形的基础间隔
      defaultWaitMs: 400, // [pause] / 无时长 wait 的默认停顿
      onTick: null,       // (revealedCount, ctx)
      onStateChange: null // (state)
    }, options || {});

    // 构建 step 序列：{type:'char', charIndex} | {type:'wait', duration, marker}
    const steps = [];
    for (const u of parsed.units) {
      if (u.type === 'char') {
        steps.push({ type: 'char', charIndex: u.charIndex });
      } else if (u.type === 'wait') {
        steps.push({ type: 'wait', duration: u.duration || opts.defaultWaitMs, marker: u });
      } else if (u.type === 'page') {
        steps.push({ type: 'page', marker: u });
      }
    }

    let state = 'idle'; // idle | playing | waiting | paused | done
    let stepIndex = 0;
    let revealed = 0;
    let timer = null;
    let waitingOn = null; // {until, stepIndex}

    function emit() {
      if (typeof opts.onTick === 'function') {
        opts.onTick(revealed, { state, stepIndex, waiting: waitingOn });
      }
    }
    function setState(s) {
      state = s;
      if (typeof opts.onStateChange === 'function') opts.onStateChange(state);
    }
    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule(delay, fn) {
      clearTimer();
      timer = setTimeout(fn, delay);
    }

    function runFrom(index) {
      stepIndex = index;
      if (stepIndex >= steps.length) {
        setState('done');
        emit();
        return;
      }
      setState('playing');
      tick();
    }

    function tick() {
      if (state === 'paused' || state === 'idle') return;
      if (stepIndex >= steps.length) {
        setState('done');
        emit();
        return;
      }
      const step = steps[stepIndex];
      if (step.type === 'char') {
        revealed = step.charIndex + 1;
        stepIndex++;
        emit();
        schedule(opts.charIntervalMs, tick);
      } else if (step.type === 'wait') {
        waitingOn = { until: Date.now() + step.duration, stepIndex, duration: step.duration };
        setState('waiting');
        emit();
        schedule(step.duration, () => {
          waitingOn = null;
          stepIndex++;
          setState('playing');
          tick();
        });
      } else if (step.type === 'page') {
        // 分页不阻塞播放，仅通知（UI 可滚动到对应页）
        stepIndex++;
        emit();
        schedule(0, tick);
      }
    }

    // 找到「显示到第 n 个字形」时对应的 step 下标
    function stepForReveal(n) {
      let chars = 0;
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].type === 'char') {
          chars++;
          if (chars === n) return i + 1;
        }
      }
      return steps.length;
    }

    const api = {
      play() {
        if (state === 'playing' || state === 'waiting') return;
        if (state === 'done') {
          stepIndex = 0;
          revealed = 0;
        }
        runFrom(stepIndex);
      },
      pause() {
        clearTimer();
        waitingOn = null;
        setState('paused');
        emit();
      },
      toggle() {
        if (state === 'playing' || state === 'waiting') this.pause();
        else this.play();
      },
      // 跳到指定字形（0..charCount），立即渲染对应进度并暂停
      seekTo(charIndex) {
        clearTimer();
        const n = Math.max(0, Math.min(parsed.charCount, Math.floor(charIndex)));
        revealed = n;
        stepIndex = stepForReveal(n);
        waitingOn = null;
        setState(n >= parsed.charCount ? 'done' : 'paused');
        emit();
      },
      // 立即显示全文
      showAll() {
        clearTimer();
        revealed = parsed.charCount;
        stepIndex = steps.length;
        waitingOn = null;
        setState('done');
        emit();
      },
      reset() {
        clearTimer();
        revealed = 0;
        stepIndex = 0;
        waitingOn = null;
        setState('idle');
        emit();
      },
      setInterval(ms) {
        opts.charIntervalMs = Math.max(1, ms);
      },
      getState() {
        return { state, revealed, stepIndex, total: parsed.charCount, waitingOn };
      },
      steps
    };

    return api;
  }

  global.TT = global.TT || {};
  global.TT.player = { create: createPlayer };
})(typeof window !== 'undefined' ? window : globalThis);
