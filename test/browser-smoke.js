// 浏览器集成冒烟测试：headless Chrome 加载 smoke.html 后运行。
// 覆盖：渲染管线（含采样率不一致）、播放器模式/seek/停止、WAV 导出回读链路。
(function () {
  const RL = window.RoomLab;
  const out = [];
  const ok = (name, cond, detail) => out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);

  window.addEventListener('load', async () => {
    try {
      // 1. 采样率不一致的完整管线
      const base = RL.generators.dry[1]();
      const dry44 = {
        name: '44.1k 测试干声', sampleRate: 44100,
        channels: RL.dsp.resampleLinear(base.channels, 48000, 44100),
      };
      const r = await RL.render.renderMix(
        dry44, RL.generators.rooms[0](),
        { preDelayMs: 30, wetGain: 0.9, normalize: true }, null);
      ok('采样率统一到 48k', r.sampleRate === 48000);
      ok('重采样被记录', r.log.some((l) => l.includes('重采样')));
      ok('单声道干声上混立体声', r.outCh === 2 && r.mix.length === 2);
      ok('片尾完整保留', r.verify.frames === r.verify.dryFrames + r.verify.irFrames - 1);

      // 2. 播放器三模式增益矩阵（先同步湿声比例到渲染参数 0.9）
      const player = new RL.StemPlayer();
      player.load(r);
      player.setWetGain(0.9);
      player.play();
      await new Promise((res) => setTimeout(res, 100));
      for (const [mode, gd, gw] of [['dry', 1, 0], ['wet', 0, 0.9], ['mix', 1, 0.9]]) {
        player.setMode(mode);
        const vd = player.gainDry.gain.value, vw = player.gainWet.gain.value;
        ok(`模式 ${mode} 增益`, Math.abs(vd - gd) < 0.05 && Math.abs(vw - gw) < 0.05,
          `dry=${vd.toFixed(2)} wet=${vw.toFixed(2)}`);
      }
      // seek 保持同一位置
      player.seek(1.25);
      ok('seek 后两条 source 共用偏移', Math.abs(player.offsetSec - 1.25) < 1e-6 && player.playing);
      player.stop();
      ok('停止后 source 全部清除（无回声残留）',
        player.srcDry === null && player.srcWet === null && !player.playing);

      // 3. WAV 导出 + 回读核对（与 app.js doExport/readback 同一套 API）
      for (const bd of [16, 24, '32f']) {
        const buf = RL.wav.encodeWav(r.mix, r.sampleRate, bd);
        const dec = RL.wav.decodeWav(buf);
        let maxDiff = 0;
        for (let c = 0; c < dec.channels.length; c++)
          for (let i = 0; i < dec.channels[0].length; i++)
            maxDiff = Math.max(maxDiff, Math.abs(dec.channels[c][i] - r.mix[c][i]));
        const tol = bd === 16 ? 1e-4 : 1e-6;
        ok(`导出 ${bd} 回读一致`,
          dec.sampleRate === r.sampleRate && dec.channels.length === 2 &&
          dec.channels[0].length === r.mix[0].length && maxDiff < tol,
          `maxDiff=${maxDiff.toExponential(2)}`);
      }

      // 4. 立体声通道独立性（回读后 L/R 不串道）
      const buf16 = RL.wav.encodeWav(r.mix, r.sampleRate, 16);
      const dec = RL.wav.decodeWav(buf16);
      let lrSame = 0;
      for (let i = 0; i < dec.channels[0].length; i++)
        lrSame = Math.max(lrSame, Math.abs(dec.channels[0][i] - dec.channels[1][i]));
      ok('回读后 L/R 仍独立', lrSame > 1e-3, `L-R max=${lrSame.toExponential(2)}`);

      // 5. 干声有效内容结束后仍有尾声（干声缓冲尾部本身是静音，要用最后一个非零采样做参考）
      const env = RL.analyze.envelope({ channels: dec.channels });
      const dryCh = r.dry[0];
      let dryLastNz = 0;
      for (let i = 0; i < dryCh.length; i++) if (Math.abs(dryCh[i]) > 1e-9) dryLastNz = i;
      let tailPeak = 0;
      for (let i = dryLastNz + 1; i < env.length; i++) tailPeak = Math.max(tailPeak, env[i]);
      ok('片尾能量保留在干声有效内容之后', tailPeak > 1e-4,
        `dryLastNz=${dryLastNz}, tail=${(20 * Math.log10(Math.max(tailPeak, 1e-10))).toFixed(1)}dBFS`);
      // 输出缓冲长度仍包含完整 IR 尾（即使尾部衰减到零，长度不截断）
      ok('输出缓冲长度未截断', env.length === r.verify.frames);
    } catch (e) {
      out.push('FAIL 异常：' + e.message + ' @ ' + (e.stack || '').split('\n')[1]);
    }
    const pre = document.createElement('pre');
    pre.id = 'smoke';
    pre.textContent = out.join('\n');
    document.body.appendChild(pre);
  });
})();
