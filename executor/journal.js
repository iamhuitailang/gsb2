'use strict';

/**
 * 执行记录（journal）：每个导入批次一份，落盘在 data/runs/<runId>/journal.json。
 * 进程退出后，resume 从这里读回未完成的状态。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNS_DIR = process.env.GSB_RUNS_DIR
  ? path.resolve(process.env.GSB_RUNS_DIR)
  : path.join(__dirname, '..', 'data', 'runs');

function ensureRunsDir() {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function runDir(runId) {
  return path.join(RUNS_DIR, runId);
}

function journalPath(runId) {
  return path.join(runDir(runId), 'journal.json');
}

function pausePath(runId) {
  return path.join(runDir(runId), 'pause.flag');
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${stamp}-${rand}`;
}

function save(run) {
  ensureRunsDir();
  fs.mkdirSync(runDir(run.runId), { recursive: true });
  run.updatedAt = new Date().toISOString();
  const target = journalPath(run.runId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(run, null, 2)}\n`);
  fs.renameSync(tmp, target);
  fs.writeFileSync(path.join(RUNS_DIR, 'latest.json'), `${JSON.stringify({ runId: run.runId })}\n`);
}

function load(runId) {
  const target = journalPath(runId);
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function latestRunId() {
  ensureRunsDir();
  const latest = path.join(RUNS_DIR, 'latest.json');
  if (fs.existsSync(latest)) {
    try {
      const { runId } = JSON.parse(fs.readFileSync(latest, 'utf8'));
      if (runId && fs.existsSync(journalPath(runId))) return runId;
    } catch {
      /* ignore */
    }
  }
  const dirs = fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(journalPath(name)))
    .sort();
  return dirs.length ? dirs[dirs.length - 1] : null;
}

function listRuns() {
  ensureRunsDir();
  return fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(journalPath(name)))
    .sort()
    .map((runId) => {
      const run = load(runId);
      return { runId, createdAt: run.createdAt, file: run.file, counts: summarize(run) };
    });
}

function summarize(run) {
  const counts = {};
  for (const item of run.items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  return counts;
}

function appendEvent(run, type, detail = {}) {
  run.events = run.events || [];
  run.events.push({ at: new Date().toISOString(), type, ...detail });
}

function markPause(runId, on) {
  const file = pausePath(runId);
  if (on) {
    fs.mkdirSync(runDir(runId), { recursive: true });
    fs.writeFileSync(file, `${new Date().toISOString()}\n`);
  } else if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

function pauseRequested(runId) {
  return fs.existsSync(pausePath(runId));
}

module.exports = {
  RUNS_DIR,
  runDir,
  journalPath,
  newRunId,
  save,
  load,
  latestRunId,
  listRuns,
  summarize,
  appendEvent,
  markPause,
  pauseRequested,
};
