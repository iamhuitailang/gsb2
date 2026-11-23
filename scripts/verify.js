#!/usr/bin/env node
/**
 * 端到端验证：
 *   1. 生成示例素材
 *   2. 核对示例（音调 ↔ 字幕 ↔ 两种语言）
 *   3. 用示例项目走一次真实导出
 *   4. 读回成品并逐项校验
 *
 * 任一环节失败即退出码 1，可直接用于 CI / 交付前自查。
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

import { ensureSampleSet, checkSampleSet, buildSampleProject, SAMPLE_DIR } from './samples.js';
import { startExport, getJob } from '../server/export.js';
import { probeMedia } from '../server/ffmpeg.js';

function log(section, message) {
  console.log(`\n[${section}] ${message}`);
}

function waitForJob(id, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('导出超时')), timeoutMs);
    const tick = setInterval(() => {
      const job = getJob(id);
      if (!job) return;
      if (job.status === 'done') {
        clearInterval(tick);
        clearTimeout(timer);
        resolve(job);
      } else if (job.status === 'failed') {
        clearInterval(tick);
        clearTimeout(timer);
        reject(new Error(job.error?.message || '导出失败'));
      }
    }, 150);
  });
}

async function main() {
  let failures = 0;
  const fail = (message) => {
    failures += 1;
    console.error(`  ✕ ${message}`);
  };
  const pass = (message) => console.log(`  ✓ ${message}`);

  log('1/5', '生成示例素材');
  const sample = await ensureSampleSet();
  console.log(`  目录：${sample.dir}`);
  pass(`生成 / 复用 ${sample.generated.length} 个文件`);

  log('2/5', '核对示例素材（音调起音 vs 字幕时点 vs 双语对齐）');
  const report = await checkSampleSet();
  for (const check of report.checks) {
    if (check.ok) pass(check.label);
    else fail(`${check.label} ${check.detail ? JSON.stringify(check.detail) : ''}`);
  }
  const crossMax = Math.max(...report.crossLanguage.map((item) => item.delta ?? 0));
  pass(`双语同一时点最大起音差 ${(crossMax * 1000).toFixed(1)}ms`);

  log('3/5', '用示例项目导出 MKV');
  const project = await buildSampleProject();
  const outputPath = path.join(SAMPLE_DIR, 'verify-output.mkv');
  // 每次使用新的默认音轨组合，验证“换默认不丢副轨”
  project.audioTracks = project.audioTracks.map((track) => ({
    ...track,
    default: track.language === 'en',
  }));
  project.subtitleTracks = project.subtitleTracks.map((track) => ({
    ...track,
    default: track.language === 'en',
  }));

  const jobId = await startExport(
    {
      name: project.name,
      video: { token: project.video.token },
      audioTracks: project.audioTracks,
      subtitleTracks: project.subtitleTracks,
    },
    { outputPath },
  );
  const job = await waitForJob(jobId);
  if (job.status !== 'done') {
    fail(`导出台账状态 ${job.status}`);
    process.exit(1);
  }
  pass(`导出完成：${job.result.outputPath}`);

  log('4/5', '读回校验');
  const verification = job.result.verification;
  for (const check of verification.checks) {
    if (check.ok) pass(check.label);
    else fail(`${check.label} ${check.detail ? JSON.stringify(check.detail) : ''}`);
  }
  for (const issue of verification.issues) fail(issue.message);

  const probe = await probeMedia(outputPath);
  const audioStreams = probe.streams.filter((stream) => stream.codecType === 'audio');
  const subtitleStreams = probe.streams.filter((stream) => stream.codecType === 'subtitle');
  if (audioStreams.length === 2) pass('成品保留 2 条音轨');
  else fail(`成品音轨数 ${audioStreams.length}，期望 2`);
  if (subtitleStreams.length === 2) pass('成品保留 2 条字幕轨');
  else fail(`成品字幕轨数 ${subtitleStreams.length}，期望 2`);

  const defaultAudio = audioStreams.find((stream) => stream.disposition.default);
  if (defaultAudio?.language === 'eng') pass('默认音轨切换到英语后读回仍为英语');
  else fail(`默认音轨语言为 ${defaultAudio?.language}，期望 eng`);

  log('5/5', '示例音轨音调对齐');
  const sampleAlignment = job.result.sampleAlignment || [];
  for (const item of sampleAlignment) {
    if (item.skipped) {
      console.log(`  · ${item.reason}`);
      continue;
    }
    if (item.ok) pass(`${item.name} 起音与偏移一致（最大 ${(item.maxDelta * 1000).toFixed(1)}ms）`);
    else fail(`${item.name} 起音偏差 ${item.maxDelta} 秒`);
  }

  if (failures) {
    console.error(`\n结果：${failures} 项失败`);
    process.exit(1);
  }

  console.log('\n结果：全部通过');
  console.log(`成品：${outputPath}`);
  console.log(`配置：${job.result.configPath}`);

  if (process.argv.includes('--clean')) {
    rmSync(outputPath, { force: true });
    rmSync(job.result.configPath, { force: true });
    console.log('已清理验证产物');
  }
  void once;
}

main().catch((error) => {
  console.error(`验证失败：${error.stack || error.message}`);
  process.exit(1);
});
