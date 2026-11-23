/* 本地合成音色：钢琴（振荡器+包络）与鼓组（噪声/正弦合成）。不加载任何外部音色库。 */
const Synth = (() => {
  let ctx = null;
  let master = null;
  let noiseBuf = null;

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function now() { return ensure().currentTime; }

  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function getNoise() {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }

  /* 钢琴：三角波基音 + 正弦泛音，低通随力度开合，指数衰减 */
  function piano(pitch, vel, when, dur) {
    ensure();
    const f = midiToFreq(pitch);
    const v = vel / 127;
    const g = ctx.createGain();
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 600 + v * 3800;
    flt.Q.value = 0.5;
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = f * 3;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    const g3 = ctx.createGain(); g3.gain.value = 0.12;
    o1.connect(flt); o2.connect(g2); g2.connect(flt); o3.connect(g3); g3.connect(flt);
    flt.connect(g); g.connect(master);
    const hold = Math.max(0.05, dur);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(v * 0.85, when + 0.005);
    g.gain.exponentialRampToValueAtTime(Math.max(v * 0.22, 0.001), when + Math.min(hold, 1.0));
    g.gain.setValueAtTime(Math.max(v * 0.22, 0.001), when + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + hold + 0.3);
    [o1, o2, o3].forEach(o => { o.start(when); o.stop(when + hold + 0.4); });
  }

  function noiseHit(when, dur, filterType, freq, q, gain) {
    const src = ctx.createBufferSource();
    src.buffer = getNoise();
    const flt = ctx.createBiquadFilter();
    flt.type = filterType; flt.frequency.value = freq; flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(flt); flt.connect(g); g.connect(master);
    src.start(when); src.stop(when + dur + 0.05);
  }

  function toneHit(when, f0, f1, dur, gain) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, when);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), when + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g); g.connect(master);
    o.start(when); o.stop(when + dur + 0.05);
  }

  /* 鼓组：按 GM 鼓键位映射到合成音色 */
  function drums(pitch, vel, when) {
    ensure();
    const v = vel / 127;
    switch (pitch) {
      case 35: case 36: // kick
        toneHit(when, 150, 45, 0.22, v * 0.9);
        noiseHit(when, 0.02, 'lowpass', 3000, 1, v * 0.4);
        break;
      case 38: case 40: // snare
        noiseHit(when, 0.16, 'bandpass', 1800, 0.8, v * 0.7);
        toneHit(when, 190, 120, 0.1, v * 0.4);
        break;
      case 39: // clap
        noiseHit(when, 0.03, 'bandpass', 1200, 1.5, v * 0.5);
        noiseHit(when + 0.02, 0.08, 'bandpass', 1200, 1.5, v * 0.5);
        break;
      case 41: toneHit(when, 110, 70, 0.25, v * 0.6); break;   // low tom
      case 43: toneHit(when, 130, 85, 0.25, v * 0.6); break;
      case 45: toneHit(when, 155, 100, 0.22, v * 0.6); break;
      case 47: toneHit(when, 180, 120, 0.2, v * 0.6); break;
      case 48: toneHit(when, 210, 140, 0.18, v * 0.6); break;
      case 50: toneHit(when, 240, 160, 0.16, v * 0.6); break;  // high tom
      case 42: case 44: // closed hat
        noiseHit(when, 0.05, 'highpass', 7000, 1, v * 0.35);
        break;
      case 46: // open hat
        noiseHit(when, 0.35, 'highpass', 7000, 1, v * 0.35);
        break;
      case 49: case 52: case 57: // crash
        noiseHit(when, 1.0, 'highpass', 5000, 0.7, v * 0.4);
        break;
      case 51: case 53: case 59: // ride
        noiseHit(when, 0.5, 'highpass', 6000, 2, v * 0.3);
        toneHit(when, 800, 780, 0.2, v * 0.08);
        break;
      default: // 其他键位按踩镲处理
        noiseHit(when, 0.06, 'highpass', 7000, 1, v * 0.3);
    }
  }

  function playNote(instrument, pitch, vel, when, durSec) {
    if (instrument === 'drums') drums(pitch, vel, when);
    else piano(pitch, vel, when, durSec);
  }

  return { ensure, now, playNote };
})();
