/*
 * DemoDSP — deterministic speech synthesis, echo simulation, delay estimation,
 * and a small NLMS acoustic echo canceller. Plain browser script + CommonJS export.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DemoDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAMPLE_RATE = 16000;
  const DURATION = 14;
  const N = SAMPLE_RATE * DURATION;
  const FIXED_SEED = 16261;

  const TIMELINE = Object.freeze({
    start: 0,
    trainStart: 0.18,
    trainEnd: 4.15,
    doubleTalk1Start: 4.65,
    doubleTalk1End: 7.55,
    changeAt: 8.15,
    farOnlyAfterChangeEnd: 10.55,
    doubleTalk2Start: 10.82,
    doubleTalk2End: 13.55,
    end: DURATION
  });

  const FIXED_PARAMS = Object.freeze({
    seed: FIXED_SEED,
    delay1Ms: 145,
    gain: 0.46,
    reflectionDelayMs: 48,
    reflectionGain: 0.18,
    delay2Ms: 285,
    noiseDb: -58
  });

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a += 0x6D2B79F5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function nextPow2(v) {
    let p = 1;
    while (p < v) p <<= 1;
    return p;
  }

  function rmsRange(x, start, end) {
    const a = Math.max(0, Math.floor(start));
    const b = Math.min(x.length, Math.floor(end));
    if (b <= a) return 0;
    let sum = 0;
    for (let i = a; i < b; i++) sum += x[i] * x[i];
    return Math.sqrt(sum / (b - a));
  }

  function rms(x) { return rmsRange(x, 0, x.length); }

  function dbFs(rmsValue) {
    return 20 * Math.log10(Math.max(1e-7, rmsValue) / 1);
  }

  function meanDb(x, start, end) {
    return dbFs(rmsRange(x, start, end));
  }

  /* ---------------- deterministic synthetic speech ---------------- */

  function makeSyllables() {
    const far = [];
    const push = (arr, start, dur, f0, vowel) => arr.push({ start, dur, f0, vowel });

    // Initial far-end-only learning utterance.
    for (let i = 0; i < 10; i++) {
      const start = 0.28 + i * 0.385;
      const dur = 0.22 + (i % 3) * 0.035;
      push(far, start, dur, 116 + (i % 4) * 5, i % 3);
    }
    // First double-talk block, with enough far energy between near syllables.
    [4.62, 5.02, 5.43, 5.86, 6.28, 6.72, 7.13, 7.62, 8.04].forEach((s, i) => {
      push(far, s, i === 8 ? 0.48 : 0.25 + (i % 2) * 0.06, 112 + (i % 5) * 6, (i + 1) % 3);
    });
    // After the path change: far-dominant reconvergence passage.
    [8.62, 9.02, 9.43, 9.84, 10.22].forEach((s, i) => {
      push(far, s, 0.27 + (i % 2) * 0.05, 118 + (i % 4) * 5, i % 3);
    });
    // Second double-talk block.
    [10.78, 11.2, 11.62, 12.05, 12.48, 12.9, 13.3].forEach((s, i) => {
      push(far, s, 0.24 + (i % 2) * 0.06, 114 + (i % 5) * 5, (i + 2) % 3);
    });

    const near = [];
    [4.91, 5.47, 6.03, 6.62, 7.18].forEach((s, i) => {
      push(near, s, [0.11, 0.15, 0.1, 0.16, 0.12][i], 210 + (i % 3) * 14, (i + 1) % 3);
    });
    [10.94, 11.5, 12.08, 12.66, 13.19].forEach((s, i) => {
      push(near, s, [0.12, 0.1, 0.16, 0.11, 0.14][i], 218 + (i % 4) * 12, i % 3);
    });
    return { far, near };
  }

  function formantWeight(f, vowel) {
    const vowels = [
      [730, 1090, 2440],  // a
      [470, 1920, 2560],  // i
      [520, 880, 2380]    // u
    ];
    const [f1, f2, f3] = vowels[vowel % vowels.length];
    const g1 = Math.exp(-Math.pow((f - f1) / 95, 2));
    const g2 = 0.72 * Math.exp(-Math.pow((f - f2) / 140, 2));
    const g3 = 0.42 * Math.exp(-Math.pow((f - f3) / 230, 2));
    return 0.16 + g1 + g2 + g3;
  }

  function makeFricative(n, seed) {
    const rng = mulberry32(seed);
    const out = new Float32Array(n);
    let prev = 0;
    let hp = 0;
    for (let i = 0; i < n; i++) {
      const z = rng() * 2 - 1;
      hp = 0.84 * (hp + z - prev);
      prev = z;
      out[i] = hp;
    }
    return out;
  }

  function synthesizeVoice(syllables, seed, targetActiveRms) {
    const out = new Float32Array(N);
    const rng = mulberry32(seed);
    const fricative = makeFricative(N, seed ^ 0x9e3779b9);

    for (const syl of syllables) {
      const start = Math.floor(syl.start * SAMPLE_RATE);
      const len = Math.floor(syl.dur * SAMPLE_RATE);
      const f0 = syl.f0;
      const phase0 = rng() * Math.PI * 2;
      const attack = Math.floor(0.014 * SAMPLE_RATE);
      const release = Math.floor(Math.min(0.055, syl.dur * 0.38) * SAMPLE_RATE);

      for (let j = 0; j < len; j++) {
        const idx = start + j;
        if (idx < 0 || idx >= N) continue;
        const tt = j / SAMPLE_RATE;
        const progress = j / len;
        let env = 1;
        if (j < attack) env = j / attack;
        else if (j > len - release) env = Math.max(0, (len - j) / release);
        // Gentle syllable pulse, not a constant organ tone.
        env *= 0.82 + 0.18 * Math.sin(Math.PI * clamp(progress, 0, 1));

        const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * (5.2 + (syl.vowel % 2)) * tt + phase0);
        const phase = phase0 + 2 * Math.PI * f0 * vibrato * tt;
        let v = 0;
        for (let h = 1; h <= 20; h++) {
          const freq = h * f0 * vibrato;
          const rolloff = Math.pow(h, -0.92);
          v += rolloff * formantWeight(freq, syl.vowel) * Math.sin(h * phase + phase0 * 0.17 * h);
        }
        // Onset consonant/breath noise gives the correlator a broadband anchor.
        const consonantEnv = Math.exp(-tt / 0.045) * clamp(1 - tt / 0.09, 0, 1);
        v = 0.052 * v * env + 0.055 * fricative[idx] * consonantEnv;
        out[idx] += v * (0.92 + 0.08 * Math.sin(2 * Math.PI * 3.7 * tt));
      }
    }

    // Scale by active-region RMS so sparse near syllables remain clearly present.
    let activeSum = 0, activeCount = 0, peak = 0;
    for (let i = 0; i < N; i++) {
      const a = Math.abs(out[i]);
      if (a > 0.012) { activeSum += out[i] * out[i]; activeCount++; }
      peak = Math.max(peak, a);
    }
    const activeRms = Math.sqrt(activeSum / Math.max(1, activeCount));
    let gain = targetActiveRms / Math.max(1e-5, activeRms);
    if (peak * gain > 0.92) gain *= 0.92 / (peak * gain);
    for (let i = 0; i < N; i++) out[i] = Math.tanh(out[i] * gain * 1.05) / Math.tanh(1.05);
    return out;
  }

  function generateSources(seed = FIXED_SEED) {
    const syllables = makeSyllables();
    return {
      far: synthesizeVoice(syllables.far, seed + 11, 0.125),
      near: synthesizeVoice(syllables.near, seed + 29, 0.19)
    };
  }

  /* ---------------- echo path and mix ---------------- */

  function lowpassInPlace(x, alpha = 0.58) {
    let y = 0;
    for (let i = 0; i < x.length; i++) {
      y += alpha * (x[i] - y);
      x[i] = y;
    }
  }

  function buildEcho(far, params) {
    const d1 = Math.round(params.delay1Ms * SAMPLE_RATE / 1000);
    const d2 = Math.round(params.delay2Ms * SAMPLE_RATE / 1000);
    const rel = Math.round(params.reflectionDelayMs * SAMPLE_RATE / 1000);
    const g = params.gain;
    const rg = params.reflectionGain;
    const change = Math.floor(TIMELINE.changeAt * SAMPLE_RATE);
    const cross = Math.floor(0.025 * SAMPLE_RATE);
    const echo = new Float32Array(far.length);

    for (let n = 0; n < far.length; n++) {
      const readPath = (d) => {
        let v = 0;
        if (n >= d) v += g * far[n - d];
        if (n >= d + rel) v += rg * far[n - d - rel];
        return v;
      };
      let v;
      if (params.delay2Ms == null || n < change - cross / 2) {
        v = readPath(d1);
      } else if (n > change + cross / 2) {
        v = readPath(d2);
      } else {
        const w = clamp((n - (change - cross / 2)) / cross, 0, 1);
        v = (1 - w) * readPath(d1) + w * readPath(d2);
      }
      echo[n] = v;
    }
    // Light hands-free channel coloration; NLMS short kernels can model this tail.
    lowpassInPlace(echo, 0.62);
    return echo;
  }

  function buildMic(echo, near, params) {
    const mic = new Float32Array(N);
    const rng = mulberry32((params.seed || FIXED_SEED) + 101);
    const noiseAmp = Math.pow(10, (params.noiseDb ?? -58) / 20);
    let peak = 0;
    for (let i = 0; i < N; i++) {
      mic[i] = echo[i] + near[i] + (rng() * 2 - 1) * noiseAmp;
      peak = Math.max(peak, Math.abs(mic[i]));
    }
    // Keep the exported/audible mix inside full scale; this only activates at
    // aggressive gain settings and does not use the near reference in the AEC.
    if (peak > 0.96) {
      const scale = 0.96 / peak;
      for (let i = 0; i < N; i++) mic[i] *= scale;
    }
    return mic;
  }

  /* ---------------- FFT / delay estimation ---------------- */

  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = sign * 2 * Math.PI / len;
      const wr = Math.cos(angle), wi = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let cwr = 1, cwi = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = i + k + half;
          const tr = re[b] * cwr - im[b] * cwi;
          const ti = re[b] * cwi + im[b] * cwr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
          const nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr;
          cwr = nwr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function correlationAt(x, y, lag) {
    const d = Math.round(lag);
    let num = 0, ex = 0, ey = 0;
    const end = Math.min(x.length, y.length);
    for (let n = d; n < end; n++) {
      const xv = x[n - d], yv = y[n];
      num += xv * yv;
      ex += xv * xv;
      ey += yv * yv;
    }
    return { num, confidence: Math.abs(num) / Math.sqrt(Math.max(1e-12, ex * ey)) };
  }

  function estimateDelay(x, y, options = {}) {
    const sr = options.sampleRate || SAMPLE_RATE;
    const minLag = Math.max(0, Math.round((options.minMs ?? 20) * sr / 1000));
    const maxLag = Math.min(x.length - 2, Math.round((options.maxMs ?? 500) * sr / 1000));
    if (maxLag <= minLag + 2) return { lag: 0, ms: 0, confidence: 0, peaks: [] };

    const len = nextPow2(x.length + y.length);
    const xr = new Float64Array(len), xi = new Float64Array(len);
    const yr = new Float64Array(len), yi = new Float64Array(len);
    xr.set(x); yr.set(y);
    fft(xr, xi, false);
    fft(yr, yi, false);

    for (let k = 0; k < len; k++) {
      // Y * conj(X): inverse transform peak at y[n] = x[n-d].
      const pr = yr[k] * xr[k] + yi[k] * xi[k];
      const pi = yi[k] * xr[k] - yr[k] * xi[k];
      xr[k] = pr; xi[k] = pi;
      if (options.phat) {
        const m = Math.hypot(pr, pi) + 1e-10;
        xr[k] = pr / m; xi[k] = pi / m;
      }
    }
    fft(xr, xi, true);

    let bestLag = minLag, bestVal = -Infinity;
    const peaks = [];
    for (let d = minLag; d <= maxLag; d++) {
      const v = xr[d];
      if (v > bestVal) { bestVal = v; bestLag = d; }
    }
    const direct = correlationAt(x, y, bestLag);

    // A later reflection: search beyond a pitch-period/minimum-separation guard.
    let secondLag = null, secondConf = 0, secondVal = -Infinity;
    const secondMin = bestLag + Math.round((options.reflectionMinMs ?? 18) * sr / 1000);
    const secondMax = Math.min(maxLag, bestLag + Math.round((options.reflectionMaxMs ?? 130) * sr / 1000));
    if (options.findReflection !== false && secondMax > secondMin + 4) {
      for (let d = secondMin; d <= secondMax; d++) {
        if (xr[d] > secondVal) {
          secondVal = xr[d];
          secondLag = d;
        }
      }
      if (secondLag != null) secondConf = correlationAt(x, y, secondLag).confidence;
    }

    return {
      lag: bestLag,
      ms: bestLag * 1000 / sr,
      confidence: clamp(direct.confidence, 0, 1),
      rawPeak: bestVal,
      secondLag,
      secondMs: secondLag == null ? null : secondLag * 1000 / sr,
      secondConfidence: clamp(secondConf, 0, 1),
      spectrum: xr
    };
  }

  function estimateInitialPath(far, mic) {
    const a = Math.floor(TIMELINE.trainStart * SAMPLE_RATE);
    const b = Math.floor((TIMELINE.trainEnd - 0.12) * SAMPLE_RATE);
    const x = far.subarray(a, b);
    const y = mic.subarray(a, b);
    const est = estimateDelay(x, y, { minMs: 50, maxMs: 500, reflectionMinMs: 18, reflectionMaxMs: 115 });
    return {
      ...est,
      preRms: rmsRange(mic, a, b),
      preDb: dbFs(rmsRange(mic, a, b)),
      farRms: rmsRange(far, a, b)
    };
  }

  /* ---------------- NLMS echo canceller ---------------- */

  function makeBank(base, taps) {
    return { base, taps, w: new Float64Array(taps) };
  }

  function bankPredict(bank, x, n) {
    let pred = 0;
    let norm = 0;
    const w = bank.w;
    for (let k = 0; k < bank.taps; k++) {
      const idx = n - bank.base - k;
      if (idx >= 0) {
        const xv = x[idx];
        pred += w[k] * xv;
        norm += xv * xv;
      }
    }
    return { pred, norm };
  }

  function bankUpdate(bank, x, n, updateGain) {
    const w = bank.w;
    for (let k = 0; k < bank.taps; k++) {
      const idx = n - bank.base - k;
      if (idx >= 0) w[k] += updateGain * x[idx];
    }
  }

  function cancelEcho(far, mic, options) {
    const sr = options.sampleRate || SAMPLE_RATE;
    const mode = options.mode || 'adaptive';
    const continuous = mode === 'adaptive';
    const total = mic.length;
    const out = new Float32Array(total);
    const hat = new Float32Array(total);
    const frameSize = Math.round(0.01 * sr);
    const taps = options.taps || 56;
    const guard = options.guard == null ? 8 : options.guard;
    const initialLag = options.initialLag;
    const initialSecondLag = options.initialSecondLag || initialLag + Math.round(48 * sr / 1000);
    const reflectionOffset = initialSecondLag - initialLag;
    const changeSample = options.changeSample || Math.floor(TIMELINE.changeAt * sr);

    let lag = initialLag;
    let secondLag = initialSecondLag;
    let banks = [makeBank(lag - guard, taps), makeBank(secondLag - guard, taps)];

    const stateAtFrame = [];
    const track = [];
    let dtd = false;
    let pathChange = false;
    let candidateLag = null;
    let candidateCount = 0;
    let detectedSample = null;
    let lockedSample = null;
    let adaptUntil = Math.floor(TIMELINE.trainEnd * sr);
    const initialTrainEndSample = Math.floor(TIMELINE.trainEnd * sr);
    let echoGainEstimate = 0.46;
    let baselineRes = 0.01;
    let smoothErle = 0;
    let lastEstimateFrame = -100;
    let finalWeights = null;
    let trainedWeights = null;
    let firstDetectedSample = null;
    let firstLockedSample = null;

    function recentLagEstimate(nSample) {
      // Use a same-start block longer than the largest expected echo lag.
      const blockLen = Math.round(0.46 * sr);
      const start = Math.max(0, nSample - blockLen);
      if (nSample - start < Math.round(0.3 * sr)) return null;
      const x = far.subarray(start, nSample);
      const y = mic.subarray(start, nSample);
      return estimateDelay(x, y, {
        minMs: 55,
        maxMs: 365,
        findReflection: false,
        phat: false
      });
    }

    for (let n = 0; n < total; n++) {
      const frame = Math.floor(n / frameSize);
      if (n % frameSize === 0) {
        const look = Math.round(0.035 * sr);
        const a = Math.max(0, n - look);
        const micR = rmsRange(mic, a, n);
        const hatR = rmsRange(hat, a, n);
        const resR = rmsRange(out, a, n);
        const farR = rmsRange(far, Math.max(0, n - Math.round(0.08 * sr)), n);

        const frameEnd = Math.min(total, n + frameSize);
        const micFrameR = rmsRange(mic, n, frameEnd);
        const farFrameR = rmsRange(far, n, frameEnd);

        if (n < initialTrainEndSample) {
          dtd = false;
          if (farFrameR > 0.015) {
            const ratio = clamp(micFrameR / Math.max(0.005, farFrameR), 0.15, 1.2);
            echoGainEstimate = 0.985 * echoGainEstimate + 0.015 * ratio;
          }
        } else if (pathChange || n < adaptUntil) {
          // Reacquisition is reference-led; do not let a high residual freeze it.
          dtd = false;
        } else {
          if (baselineRes < 1e-4) baselineRes = Math.max(0.006, resR);
          baselineRes = 0.985 * baselineRes + 0.015 * Math.max(0.002, Math.min(resR, baselineRes * 2.2));
          const delayedFarR = rmsRange(far, Math.max(0, n - lag), Math.min(total, n - lag + frameSize * 2));
          const expectedEchoR = echoGainEstimate * delayedFarR * 1.25 + 0.006;
          const levelDoubleTalk = micFrameR > expectedEchoR * 1.35 && micFrameR > 0.024;
          const residualDoubleTalk = resR > Math.max(0.024, baselineRes * 2.0) && micR > hatR * 1.15;
          const farActive = farR > 0.014;
          dtd = farActive && (levelDoubleTalk || residualDoubleTalk);
          if (!farActive) dtd = true; // freeze when there is no useful far reference
        }

        // Online bulk-delay tracker. Keep polling during reacquisition; accept
        // a move only after two stable, reasonably strong correlations. This
        // prevents a periodic speech peak or a short double-talk syllable from
        // moving the coarse delay.
        if (continuous && n >= initialTrainEndSample && frame - lastEstimateFrame >= 4) {
          lastEstimateFrame = frame;
          const est = recentLagEstimate(Math.min(total, n + frameSize * 2));
          if (est && est.confidence > 0.34) {
            track.push({ sample: n, time: n / sr, lag: est.lag, ms: est.ms, confidence: est.confidence });
            const trustworthy = est.confidence > 0.58 && (!dtd || est.confidence > 0.82);
            const diff = Math.abs(est.lag - lag);
            if (trustworthy && diff > Math.round(0.012 * sr)) {
              if (candidateLag != null && Math.abs(est.lag - candidateLag) <= 16) candidateCount++;
              else { candidateLag = est.lag; candidateCount = 1; }
              if (candidateCount >= 2) {
                lag = est.lag;
                secondLag = lag + reflectionOffset;
                banks = [makeBank(lag - guard, taps), makeBank(clamp(secondLag - guard, 0, total), taps)];
                pathChange = true;
                dtd = false;
                detectedSample = n;
                if (firstDetectedSample == null) firstDetectedSample = n;
                lockedSample = null;
                adaptUntil = n + Math.round(0.62 * sr);
                candidateLag = null;
                candidateCount = 0;
                smoothErle = 0;
              }
            } else if (est.confidence < 0.45) {
              candidateLag = null;
              candidateCount = 0;
            } else if (diff <= Math.round(0.012 * sr)) {
              candidateLag = null;
              candidateCount = 0;
            }
          }
        }

        let status = 'double-talk-hold';
        if (n < initialTrainEndSample) status = 'learning';
        else if (pathChange || n < adaptUntil) status = 'reacquiring';
        else if (dtd) status = 'double-talk-hold';
        else status = 'locked';
        stateAtFrame[frame] = { frame, sample: n, time: n / sr, dtd, pathChange, status, lag, micR, hatR, resR };
      }

      const activeBanks = banks;
      let prediction = 0;
      const predictions = [];
      for (const bank of activeBanks) {
        const p = bankPredict(bank, far, n);
        predictions.push(p);
        prediction += p.pred;
      }
      hat[n] = prediction;
      const error = mic[n] - prediction;
      out[n] = error;

      const inInitialTraining = n < initialTrainEndSample;
      const inReacquireGrace = continuous && n < adaptUntil && n >= initialTrainEndSample;
      const farInstant = Math.abs(far[Math.max(0, n - 1)]);
      const allowAdapt = inInitialTraining ||
        (continuous && (inReacquireGrace || (!dtd && farInstant > 0.004)));
      if (allowAdapt) {
        // One combined NLMS denominator for both sparse arrival banks keeps the
        // summed correction passive; per-bank denominators can overshoot.
        let referenceEnergy = 0;
        for (const p of predictions) referenceEnergy += p.norm;
        referenceEnergy += activeBanks.length * taps * 0.001;
        const mu = inInitialTraining ? 0.35 : (inReacquireGrace ? 0.45 : 0.18);
        const updateGain = mu * error / referenceEnergy;
        for (const bank of activeBanks) bankUpdate(bank, far, n, updateGain);
      }
      if (continuous && n === initialTrainEndSample - 1) {
        trainedWeights = [banks[0].w.slice(), banks[1].w.slice()];
      }

      if (continuous && pathChange && detectedSample != null) {
        const since = n - detectedSample;
        if (since > Math.round(0.22 * sr) && n % frameSize === 0) {
          const echoWindow = rmsRange(mic, Math.max(0, n - 800), n);
          const errWindow = rmsRange(out, Math.max(0, n - 800), n);
          const erle = dbFs(echoWindow) - dbFs(errWindow);
          smoothErle = smoothErle ? 0.9 * smoothErle + 0.1 * erle : erle;
          if (smoothErle > 13 && since > Math.round(0.32 * sr)) {
            pathChange = false;
            lockedSample = n;
            if (firstLockedSample == null) firstLockedSample = n;
            adaptUntil = n;
          }
        }
        if (since > Math.round(1.4 * sr)) pathChange = false;
      }
    }

    if (continuous) finalWeights = [banks[0].w, banks[1].w];

    return {
      output: out,
      hat,
      track,
      stateAtFrame,
      events: {
        changeSample,
        changeTime: TIMELINE.changeAt,
        detectedSample: firstDetectedSample ?? detectedSample,
        detectedTime: firstDetectedSample == null ? null : firstDetectedSample / sr,
        lockedSample: firstLockedSample ?? lockedSample,
        lockedTime: firstLockedSample == null ? null : firstLockedSample / sr,
        reacquireSeconds: firstDetectedSample != null && firstLockedSample != null ? (firstLockedSample - firstDetectedSample) / sr : null
      },
      trainedWeights,
      finalWeights
    };
  }

  /* ---------------- metrics / representative tables ---------------- */

  function correlationCoefficient(a, b, start, end) {
    const i0 = Math.max(0, Math.floor(start || 0));
    const i1 = Math.min(a.length, Math.floor(end || a.length));
    let ma = 0, mb = 0, n = 0;
    for (let i = i0; i < i1; i++) { ma += a[i]; mb += b[i]; n++; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = i0; i < i1; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return num / Math.sqrt(Math.max(1e-12, da * db));
  }

  function linearGain(output, reference, start, end) {
    const i0 = Math.floor(start * SAMPLE_RATE), i1 = Math.floor(end * SAMPLE_RATE);
    let num = 0, den = 0;
    for (let i = i0; i < i1; i++) { num += output[i] * reference[i]; den += reference[i] * reference[i]; }
    return num / Math.max(1e-10, den);
  }

  function makeWindowMetrics(signals, adaptive, fixed, echo) {
    const win = Math.round(0.05 * SAMPLE_RATE);
    const reliableLagTrack = adaptive.track.filter((p) => p.confidence >= 0.55);
    const rows = [];
    for (let start = 0; start < N; start += win) {
      const end = Math.min(N, start + win);
      const t = (start + end) / 2 / SAMPLE_RATE;
      const micR = rmsRange(signals.mic, start, end);
      const farR = rmsRange(signals.far, start, end);
      const nearR = rmsRange(signals.near, start, end);
      const echoR = rmsRange(echo, start, end);
      const adR = rmsRange(adaptive.output, start, end);
      const fxR = rmsRange(fixed.output, start, end);
      const adEchoRes = new Float32Array(end - start);
      const fxEchoRes = new Float32Array(end - start);
      for (let i = start, j = 0; i < end; i++, j++) {
        adEchoRes[j] = echo[i] - adaptive.hat[i];
        fxEchoRes[j] = echo[i] - fixed.hat[i];
      }
      const adEchoResR = rms(adEchoRes);
      const fxEchoResR = rms(fxEchoRes);
      const frameIndex = clamp(Math.round(t / 0.01), 0, adaptive.stateAtFrame.length - 1);
      const lagStateFrame = adaptive.stateAtFrame[frameIndex];
      let confidenceState = null;
      for (const p of reliableLagTrack) {
        if (!confidenceState || Math.abs(p.time - t) < Math.abs(confidenceState.time - t)) confidenceState = p;
      }
      rows.push({
        time: +t.toFixed(3),
        farDb: +dbFs(farR).toFixed(2),
        nearDb: +dbFs(nearR).toFixed(2),
        micDb: +dbFs(micR).toFixed(2),
        adaptiveOutDb: +dbFs(adR).toFixed(2),
        fixedOutDb: +dbFs(fxR).toFixed(2),
        adaptiveErleDb: +clamp(dbFs(echoR) - dbFs(adEchoResR), -30, 60).toFixed(2),
        fixedErleDb: +clamp(dbFs(echoR) - dbFs(fxEchoResR), -30, 60).toFixed(2),
        estimatedLagMs: lagStateFrame ? +(lagStateFrame.lag * 1000 / SAMPLE_RATE).toFixed(1) : null,
        lagConfidence: confidenceState ? +confidenceState.confidence.toFixed(3) : null
      });
    }
    return rows;
  }

  function segmentMetrics(name, start, end, signals, adaptive, fixed, echo) {
    const s = Math.floor(start * SAMPLE_RATE), e = Math.floor(end * SAMPLE_RATE);
    const echoR = rmsRange(echo, s, e);
    const adResEcho = (() => {
      let sum = 0;
      for (let i = s; i < e; i++) { const v = echo[i] - adaptive.hat[i]; sum += v * v; }
      return Math.sqrt(sum / (e - s));
    })();
    const fxResEcho = (() => {
      let sum = 0;
      for (let i = s; i < e; i++) { const v = echo[i] - fixed.hat[i]; sum += v * v; }
      return Math.sqrt(sum / (e - s));
    })();
    return {
      segment: name,
      startSec: start,
      endSec: end,
      micRmsDb: +dbFs(rmsRange(signals.mic, s, e)).toFixed(2),
      adaptiveOutRmsDb: +dbFs(rmsRange(adaptive.output, s, e)).toFixed(2),
      fixedOutRmsDb: +dbFs(rmsRange(fixed.output, s, e)).toFixed(2),
      adaptiveErleDb: +clamp(dbFs(echoR) - dbFs(adResEcho), -30, 60).toFixed(2),
      fixedErleDb: +clamp(dbFs(echoR) - dbFs(fxResEcho), -30, 60).toFixed(2),
      adaptiveNearGain: +linearGain(adaptive.output, signals.near, start, end).toFixed(3),
      fixedNearGain: +linearGain(fixed.output, signals.near, start, end).toFixed(3),
      adaptiveNearCorr: +correlationCoefficient(adaptive.output, signals.near, s, e).toFixed(3),
      fixedNearCorr: +correlationCoefficient(fixed.output, signals.near, s, e).toFixed(3)
    };
  }

  function makeCsv(rows, columns) {
    const cols = columns || Object.keys(rows[0] || {});
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
  }

  function encodeWav(samples, sampleRate = SAMPLE_RATE) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const v = clamp(samples[i], -1, 1);
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function buildScenario(userParams = {}) {
    const params = { ...FIXED_PARAMS, ...userParams };
    const sources = generateSources(params.seed);
    const echo = buildEcho(sources.far, params);
    const mic = buildMic(echo, sources.near, params);
    const initial = estimateInitialPath(sources.far, mic);

    const common = {
      sampleRate: SAMPLE_RATE,
      initialLag: initial.lag,
      initialSecondLag: initial.secondLag,
      changeSample: Math.floor(TIMELINE.changeAt * SAMPLE_RATE)
    };
    const adaptive = cancelEcho(sources.far, mic, { ...common, mode: 'adaptive' });
    // Give the fixed canceller the same converged initial coefficients: its
    // failure after the path change is caused specifically by not tracking.
    const fixed = cancelEcho(sources.far, mic, { ...common, mode: 'fixed' });

    if (+params.delay1Ms === +params.delay2Ms) {
      const sameSample = Math.floor(TIMELINE.changeAt * SAMPLE_RATE);
      adaptive.events.noPathChange = true;
      adaptive.events.detectedSample = sameSample;
      adaptive.events.detectedTime = TIMELINE.changeAt;
      adaptive.events.lockedSample = sameSample;
      adaptive.events.lockedTime = TIMELINE.changeAt;
      adaptive.events.reacquireSeconds = 0;
    }

    const signalSet = { ...sources, echo, mic };
    const windows = makeWindowMetrics(signalSet, adaptive, fixed, echo);
    const segments = [
      segmentMetrics('初始远端学习段', TIMELINE.trainStart + 0.15, TIMELINE.trainEnd - 0.15, signalSet, adaptive, fixed, echo),
      segmentMetrics('第一次双讲：短音节保留', TIMELINE.doubleTalk1Start + 0.1, TIMELINE.doubleTalk1End, signalSet, adaptive, fixed, echo),
      segmentMetrics('延时突变与重新跟踪', TIMELINE.changeAt - 0.25, TIMELINE.farOnlyAfterChangeEnd, signalSet, adaptive, fixed, echo),
      segmentMetrics('第二次双讲：新路径下消回声', TIMELINE.doubleTalk2Start, TIMELINE.doubleTalk2End, signalSet, adaptive, fixed, echo)
    ];

    return {
      sampleRate: SAMPLE_RATE,
      duration: DURATION,
      timeline: TIMELINE,
      params,
      signals: signalSet,
      initial,
      adaptive,
      fixed,
      windows,
      segments,
      windowCsv: makeCsv(windows),
      segmentCsv: makeCsv(segments)
    };
  }

  return {
    SAMPLE_RATE, DURATION, N, FIXED_SEED, TIMELINE, FIXED_PARAMS,
    mulberry32, clamp, rms, rmsRange, dbFs,
    generateSources, buildEcho, buildMic, estimateDelay, estimateInitialPath,
    cancelEcho, buildScenario, encodeWav, makeCsv, correlationCoefficient, linearGain
  };
});
