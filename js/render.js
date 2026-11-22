// 渲染管线：采样率统一、声道映射、预延迟、卷积、干/湿/混合三模式。
// 预览与导出共用 renderMix()，保证“导出即所得”。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});
  const dsp = RL.dsp;

  // 重采样：浏览器优先走 OfflineAudioContext（高质量），否则线性回退
  async function resampleTo(audio, targetRate, ctx) {
    if (audio.sampleRate === targetRate) {
      return { channels: audio.channels.map((c) => c.slice()), method: '无需重采样' };
    }
    if (ctx && typeof ctx.createBuffer === 'function' && audio.sampleRate !== targetRate) {
      try {
        const frames = audio.channels[0].length;
        const src = ctx.createBuffer(audio.channels.length, frames, audio.sampleRate);
        audio.channels.forEach((c, i) => src.copyToChannel(c, i));
        const outLen = Math.round(frames * targetRate / audio.sampleRate);
        const off = new OfflineAudioContext(audio.channels.length, outLen, targetRate);
        const node = off.createBufferSource();
        node.buffer = src;
        node.connect(off.destination);
        node.start();
        const rendered = await off.startRendering();
        return {
          channels: Array.from({ length: rendered.numberOfChannels }, (_, i) =>
            rendered.getChannelData(i).slice()),
          method: `浏览器重采样 ${audio.sampleRate}→${targetRate}Hz`,
        };
      } catch (e) {
        /* 落到线性重采样 */
      }
    }
    return {
      channels: dsp.resampleLinear(audio.channels, audio.sampleRate, targetRate),
      method: `线性重采样 ${audio.sampleRate}→${targetRate}Hz（回退路径）`,
    };
  }

  // 声道适配方案（只处理 1/2 声道），返回处理说明与适配后的声道。
  // 规则：单声道遇到立体声 → 上混为立体声（复制到 L/R），保留空间感；
  //       立体声干声遇到单声道响应 → 降混为单声道（无空间信息可保留）；
  //       两端声道数相同则原样处理。
  function adaptChannels(dryCh, irCh) {
    let outCh = Math.max(dryCh.length, irCh.length);
    const log = [];
    let dry = dryCh, ir = irCh;

    if (dry.length === 1 && ir.length === 2) {
      dry = [dry[0], dry[0]];
      log.push('干声单声道→立体声：复制到 L/R（保留响应的立体声空间感）');
    } else if (dry.length === 2 && ir.length === 1) {
      const l = dry[0], r = dry[1];
      const m = new Float32Array(l.length);
      for (let i = 0; i < l.length; i++) m[i] = 0.5 * (l[i] + r[i]);
      dry = [m];
      outCh = 1; // 响应无空间信息，输出降为单声道
      log.push('响应为单声道、无空间信息：干声 L/R 等比例叠加为单声道输出');
    } else if (dry.length === 1 && ir.length === 1) {
      log.push('两端均为单声道，直接处理');
    } else {
      log.push('两端均为立体声，L/R 分别卷积');
    }
    return { dry, ir, outCh, log };
  }

  // 在响应前插入 preDelayMs 的静音（保留完整片尾，不截断响应）
  function insertPreDelay(irChannels, sampleRate, preDelayMs) {
    const pad = Math.max(0, Math.round(preDelayMs / 1000 * sampleRate));
    if (!pad) return { channels: irChannels.map((c) => c.slice()), pad };
    return {
      channels: irChannels.map((c) => {
        const out = new Float32Array(c.length + pad);
        out.set(c, pad);
        return out;
      }),
      pad,
    };
  }

  function padTo(ch, len) {
    if (ch.length === len) return ch;
    const out = new Float32Array(len);
    out.set(ch);
    return out;
  }

  function mixStems(stems, wetGain, normalize) {
    const outCh = stems.dry.length;
    const len = stems.wet[0].length;
    const dry = stems.dry.map((c) => padTo(c, len));
    const wet = stems.wet;
    let mix = dry.map((c, i) => {
      const o = new Float32Array(len);
      const w = wet[i];
      for (let j = 0; j < len; j++) o[j] = c[j] + w[j] * wetGain;
      return o;
    });
    let normGain = 1;
    if (normalize) {
      let peak = 0;
      for (const ch of mix) peak = Math.max(peak, dsp.peakOf(ch));
      if (peak > 1) {
        normGain = 1 / peak;
        mix = mix.map((ch) => {
          const o = new Float32Array(ch.length);
          for (let i = 0; i < ch.length; i++) o[i] = ch[i] * normGain;
          return o;
        });
      }
    } else {
      let peak = 0;
      for (const ch of mix) peak = Math.max(peak, dsp.peakOf(ch));
      if (peak > 1) normGain = null; // null 表示削波告警
    }
    return { mix, normGain };
  }

  // 主渲染入口。
  // params: { preDelayMs, wetGain, normalize }
  // 返回干/湿/混合三组同源数据 + 完整处理日志，供预览、导出、核对共用。
  async function renderMix(dryAudio, irAudio, params, ctx) {
    const log = [];
    const targetRate = Math.max(dryAudio.sampleRate, irAudio.sampleRate);
    log.push(`目标采样率取两者较大值：${targetRate} Hz`);

    const [dryR, irR] = await Promise.all([
      resampleTo(dryAudio, targetRate, ctx),
      resampleTo(irAudio, targetRate, ctx),
    ]);
    log.push(`干声：${dryR.method}`);
    log.push(`响应：${irR.method}`);

    const adapted = adaptChannels(dryR.channels, irR.channels);
    log.push(...adapted.log);

    const delayed = insertPreDelay(adapted.ir, targetRate, params.preDelayMs);
    if (delayed.pad) log.push(`预延迟：响应整体后移 ${params.preDelayMs} ms（${delayed.pad} 采样）`);

    const outCh = adapted.outCh;
    const wetRaw = [];
    for (let c = 0; c < outCh; c++) {
      // 同通道直接卷积；立体声输入经适配后通道数已对齐
      wetRaw.push(dsp.convolve(adapted.dry[c], delayed.channels[c]));
    }

    // 湿声能量归一化：卷积会累积 IR 的全部能量，峰值通常远大于干声。
    // 先把湿声峰值对齐到干声峰值，湿声比例滑块才有统一、可预期的量纲。
    const dryPeak = Math.max(...adapted.dry.map((c) => dsp.peakOf(c)));
    const wetRawPeak = Math.max(...wetRaw.map((c) => dsp.peakOf(c)));
    const wetBalance = wetRawPeak > 0 ? dryPeak / wetRawPeak : 1;
    const wet = wetRaw.map((c) => {
      const o = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) o[i] = c[i] * wetBalance;
      return o;
    });
    log.push(`湿声能量对齐：卷积结果峰值对齐干声（×${wetBalance.toFixed(4)}），再由房间声比例控制`);

    const totalLen = wet[0].length; // = 干声长度 + 延迟 + 响应长度 - 1，片尾天然保留
    const dryStem = adapted.dry.map((c) => padTo(c, totalLen));
    const { mix, normGain } = mixStems(
      { dry: dryStem, wet },
      params.wetGain,
      params.normalize,
    );
    if (normGain !== null && normGain < 1) {
      log.push(`防削波归一化：混合峰值超 0 dBFS，整体 ×${normGain.toFixed(4)}`);
    }

    const verify = {
      sampleRate: targetRate,
      channels: outCh,
      frames: totalLen,
      durationSec: totalLen / targetRate,
      dryFrames: adapted.dry[0].length,
      irFrames: delayed.channels[0].length,
      preDelaySamples: delayed.pad,
      wetOnlyStartsAt: delayed.pad, // 湿声第一个非零采样的位置（脉冲输入时严格成立）
      wetBalance,
      peak: Math.max(...mix.map((c) => dsp.peakOf(c))),
      normGain,
    };
    return { dry: dryStem, wet, mix, sampleRate: targetRate, outCh, log, verify };
  }

  RL.render = { renderMix, adaptChannels, insertPreDelay, resampleTo, mixStems };
})(typeof globalThis !== 'undefined' ? globalThis : this);
