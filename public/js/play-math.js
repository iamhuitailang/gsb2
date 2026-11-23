/*
 * play-math.js —— 播放位置与循环漂移计算（纯函数，无 Web Audio 依赖）
 *
 * 渲染后的区间 AudioBuffer 长度为 outputFrames（已按 rate 归一化），
 * 对应源区间 sourceFrames。循环回绕时位置映射全部走这里，
 * 每一圈的误差可量化、有界，避免"越放越偏"无法排查。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PlayMath = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 输出采样位置 -> 区间内源采样位置
  function outputToSource(outFrame, sourceFrames, outputFrames) {
    return Math.min(sourceFrames - 1, (outFrame * sourceFrames) / outputFrames);
  }

  // 区间内源采样位置 -> 输出采样位置（切模式/速度后重建播放位置用）
  function sourceToOutput(srcFrameInRegion, sourceFrames, outputFrames) {
    return Math.round((srcFrameInRegion * outputFrames) / sourceFrames);
  }

  // 一次完整循环的理想输出时长与实际（整帧量化）输出时长之差（秒）
  // rate 为播放速度倍率，理想输出帧数 = sourceFrames / rate
  function loopDriftSeconds(sourceFrames, rate, sampleRate) {
    const ideal = sourceFrames / rate / sampleRate;
    const actual = Math.round(sourceFrames / rate) / sampleRate;
    return actual - ideal;
  }

  // 累计 N 圈后的漂移（秒）
  function accumulatedDrift(sourceFrames, rate, sampleRate, loops) {
    return loopDriftSeconds(sourceFrames, rate, sampleRate) * loops;
  }

  // 格式化秒为 m:ss.mmm，供 UI 复用
  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + '.' +
      String(ms).padStart(3, '0');
  }

  return {
    outputToSource,
    sourceToOutput,
    loopDriftSeconds,
    accumulatedDrift,
    formatTime,
  };
});
