/* WebAudio 节拍音与点按音：全部程序合成，不加载任何素材。 */
(function (root) {
  'use strict';

  let ctx = null;
  let master = null;
  let muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.28;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setMuted(v) {
    muted = !!v;
    if (master) master.gain.value = muted ? 0 : 0.28;
  }

  function isMuted() { return muted; }

  /** 单个短音：accent 用于小节第一拍（更高、更响）。 */
  function blip(when, accent, freqBase) {
    const c = ensure();
    if (!c || muted) return;
    const t = Math.max(when, c.currentTime + 0.001);
    const osc = c.createOscillator();
    const gain = c.createGain();
    const freq = freqBase || (accent ? 1480 : 980);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  function click(when, good) {
    blip(when, !!good, good ? 1760 : 420);
  }

  function tick() {
    const c = ensure();
    if (!c) return;
    blip(c.currentTime + 0.001, false, 620);
  }

  /** 从 startTime 起，按 ticks（含 time/accent）排程。 */
  function scheduleTicks(ticks, fromTime, leadMs) {
    const c = ensure();
    if (!c) return;
    const lead = (leadMs == null ? 0 : leadMs) / 1000;
    const now = c.currentTime + lead;
    ticks.forEach((tk) => {
      if (tk.time >= fromTime - 1e-6 && tk.time < fromTime + 30) {
        const when = now + Math.max(0, tk.time - fromTime);
        blip(when, tk.accent);
      }
    });
  }

  function now() {
    return ensure() ? ctx.currentTime : 0;
  }

  function reset() {
    if (ctx) ctx.close();
    ctx = null;
    master = null;
  }

  root.RTAudio = { ensure, setMuted, isMuted, click, tick, blip, scheduleTicks, now, reset };
})(typeof globalThis !== 'undefined' ? globalThis : this);
