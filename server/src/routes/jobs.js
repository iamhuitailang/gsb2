import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import {
  countByStatus,
  createJob,
  db,
  getJob,
  getLogs,
  getRecords,
  listJobs,
  updateJobStatus,
} from '../db.js';
import { parseCsvBuffer } from '../csv.js';
import { isRunning, startJob, stopJob } from '../runner.js';
import { sseHandler } from '../sse.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// 导入 CSV：仅解析 + 落库为 preview 状态，不触发任何自动化
router.post('/jobs/import', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到 CSV 文件' });
    const { records, errors } = parseCsvBuffer(req.file.buffer);
    if (records.length === 0) {
      return res.status(422).json({ error: '没有可导入的有效记录', validationErrors: errors });
    }
    const safeName = path.basename(req.file.originalname).replace(/[^\w.\-一-龥]/g, '_');
    const job = createJob(safeName, safeName, records);
    res.status(201).json({
      job,
      records: getRecords(job.id),
      counts: countByStatus(job.id),
      validationErrors: errors,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs', (req, res) => {
  const jobs = listJobs().map((j) => ({ ...j, counts: countByStatus(j.id), running: isRunning(j.id) }));
  res.json(jobs);
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json({
    job: { ...job, running: isRunning(job.id) },
    records: getRecords(job.id),
    counts: countByStatus(job.id),
  });
});

// 预览确认：preview -> ready
router.post('/jobs/:id/confirm', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (job.status !== 'preview') return res.status(409).json({ error: `状态 ${job.status} 无需确认` });
  updateJobStatus(job.id, 'ready');
  res.json({ job: getJob(job.id) });
});

// 开始 / 恢复执行（ready、interrupted、failed 均可）
router.post('/jobs/:id/start', async (req, res, next) => {
  try {
    const result = await startJob(Number(req.params.id));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/stop', (req, res, next) => {
  try {
    res.json(stopJob(Number(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id/logs', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  res.json(getLogs(job.id, Number(req.query.limit) || 500));
});

router.get('/jobs/:id/events', sseHandler);

router.delete('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: '任务不存在' });
  if (isRunning(job.id)) return res.status(409).json({ error: '任务执行中，无法删除' });
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ ok: true });
});

export default router;
