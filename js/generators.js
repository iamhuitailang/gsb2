// 内置素材：短脉冲、节奏干声、两份程序化房间响应（无需真实房间录音）。
// 所有素材统一 48kHz；干声为单声道，房间响应为立体声。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});
  const dsp = RL.dsp;

  const SR = 48000;

  function mono(name, buf) {
    return { name, sampleRate: SR, channels: [buf], generated: true };
  }

  function silence(sec) {
    return new Float32Array(Math.round(sec * SR));
  }

  function add(dst, src, at) {
    const start = Math.round(at * SR);
    for (let i = 0; i < src.length && start + i < dst.length; i++) {
      dst[start + i] += src[i];
    }
  }

  function kick(rng) {
    const n = Math.round(0.25 * SR);
    const b = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = 120 * Math.exp(-t * 30) + 45;
      phase += 2 * Math.PI * f / SR;
      b[i] = Math.sin(phase) * Math.exp(-t * 9);
    }
    return b;
  }

  function hat(rng, durSec, hp) {
    const n = Math.round(durSec * SR);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) b[i] = dsp.gaussian(rng) * Math.exp(-i / SR * 90);
    // 简易高通：一阶差分，突出金属感
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const v = b[i] - hp * prev;
      prev = b[i];
      b[i] = v * 0.5;
    }
    return b;
  }

  function ping(rng, freq) {
    const n = Math.round(0.6 * SR);
    const b = new Float32Array(n);
    const partials = [[1, 1], [2.01, 0.45], [3.02, 0.22]];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (const [mult, amp] of partials) {
        v += amp * Math.sin(2 * Math.PI * freq * mult * t);
      }
      b[i] = v / 1.67 * Math.exp(-t * 7);
    }
    return b;
  }

  // 1) 短脉冲：前置 50ms 静音后的单位脉冲，方便直接“看到”响应形状
  function genPulse() {
    const b = silence(0.5);
    b[Math.round(0.05 * SR)] = 1;
    return mono('短脉冲（50ms 处单位脉冲）', b);
  }

  // 2) 纯鼓点节奏（2 小节，120 BPM）
  function genRhythmDrums() {
    const rng = dsp.makeRng(1001);
    const b = silence(6);
    const beat = 0.5; // 120 BPM，每拍 0.5s
    for (let i = 0; i < 8; i++) add(b, kick(rng), i * beat);
    for (let i = 0; i < 8; i++) add(b, hat(rng, 0.08, 0.82), i * beat + beat / 2);
    return mono('节奏声·纯鼓点（120 BPM）', b);
  }

  // 3) 鼓 + 镲的细密节奏（16 分音符感）
  function genRhythmHats() {
    const rng = dsp.makeRng(2002);
    const b = silence(6);
    const step = 0.125;
    for (let i = 0; i < 32; i++) {
      if (i % 4 === 0) add(b, kick(rng), i * step);
      add(b, hat(rng, i % 2 ? 0.04 : 0.09, 0.85), i * step);
    }
    return mono('节奏声·鼓与镲（16 分）', b);
  }

  // 4) 音高序列（不同音高的 ping，暴露反射的音染）
  function genRhythmMelody() {
    const rng = dsp.makeRng(3003);
    const b = silence(6);
    const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    for (let i = 0; i < 12; i++) {
      add(b, ping(rng, scale[i % scale.length]), i * 0.45);
    }
    return mono('节奏声·音高序列', b);
  }

  // 程序化房间响应：直达声 + 离散早期反射 + 带高频阻尼的指数尾声
  function makeRoomIR(cfg, seed) {
    const rng = dsp.makeRng(seed);
    const total = Math.round(cfg.lengthSec * SR);
    const L = total;
    const lr = [new Float32Array(L), new Float32Array(L)];
    const directAt = Math.round(cfg.preDelayMs / 1000 * SR);

    // 直达声（首波），左右同相
    lr[0][directAt] = 1;
    lr[1][directAt] = 1;

    // 早期反射：独立左右路径，幅度随时间衰减
    const reflections = [];
    for (let k = 0; k < cfg.earlyCount; k++) {
      const t = cfg.preDelayMs / 1000 + 0.008 + rng() * (cfg.earlyWindowMs / 1000);
      const amp = cfg.earlyLevel * Math.exp(-t * cfg.earlyDecay);
      const pan = rng() * 2 - 1; // -1..1
      const idx = Math.round(t * SR);
      if (idx < L) {
        lr[0][idx] += amp * (1 - Math.max(0, pan) * 0.7);
        lr[1][idx] += amp * (1 - Math.max(0, -pan) * 0.7);
        reflections.push({ time: t, amp, pan, channel: pan >= 0 ? 'R' : 'L' });
      }
    }

    // 晚期尾声：高斯噪声 × 指数包络 × 随时间变暗的低通
    const lateStart = directAt + Math.round(cfg.earlyWindowMs / 1000 * SR);
    const tau = cfg.rt60Sec / Math.log(1000); // 衰减到 -60dB 的时间常数
    for (let c = 0; c < 2; c++) {
      const ch = lr[c];
      for (let i = lateStart; i < L; i++) {
        const t = (i - lateStart) / SR;
        ch[i] += dsp.gaussian(rng) * cfg.lateLevel * Math.exp(-t / tau);
      }
      // 阻尼：对尾声分段做低通，截止频率随时间下降
      const seg = Math.round(0.05 * SR);
      for (let s = lateStart; s < L; s += seg) {
        const end = Math.min(s + seg, L);
        const t = (s - lateStart) / SR;
        const cutoff = Math.max(300, cfg.cutoffStart * Math.exp(-t * cfg.damping));
        const tmp = ch.subarray(s, end);
        dsp.onePoleLowPass(tmp, cutoff, SR);
      }
      // 末端 30ms 等功率淡出，保证尾部干净可核对
      const fade = Math.round(0.03 * SR);
      for (let i = L - fade; i < L; i++) {
        const w = Math.sin(((L - i) / fade) * Math.PI / 2);
        ch[i] *= w;
      }
    }

    // 归一化到固定峰值，保证不同响应之间音量可比
    let peak = 0;
    for (const ch of lr) peak = Math.max(peak, dsp.peakOf(ch));
    const g = cfg.targetPeak / peak;
    for (const ch of lr) for (let i = 0; i < L; i++) ch[i] *= g;

    reflections.sort((a, b) => a.time - b.time);
    return {
      name: cfg.name,
      sampleRate: SR,
      channels: lr,
      generated: true,
      meta: { preDelayMs: cfg.preDelayMs, rt60Sec: cfg.rt60Sec, reflections },
    };
  }

  const ROOM_SMALL = {
    name: '程序化响应 A·小房间',
    lengthSec: 1.0,
    preDelayMs: 12,
    earlyCount: 14,
    earlyWindowMs: 90,
    earlyLevel: 0.85,
    earlyDecay: 14,
    lateLevel: 0.35,
    rt60Sec: 0.45,
    cutoffStart: 6500,
    damping: 2.2,
    targetPeak: 0.7,
  };

  const ROOM_HALL = {
    name: '程序化响应 B·大厅',
    lengthSec: 2.6,
    preDelayMs: 32,
    earlyCount: 22,
    earlyWindowMs: 220,
    earlyLevel: 0.9,
    earlyDecay: 6,
    lateLevel: 0.5,
    rt60Sec: 1.8,
    cutoffStart: 9000,
    damping: 1.1,
    targetPeak: 0.7,
  };

  RL.generators = {
    SR,
    dry: [genPulse, genRhythmDrums, genRhythmHats, genRhythmMelody],
    rooms: [
      () => makeRoomIR(ROOM_SMALL, 11),
      () => makeRoomIR(ROOM_HALL, 22),
    ],
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
