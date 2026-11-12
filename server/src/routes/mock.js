import { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createApplication,
  findApplication,
  listApplications,
  resetApplications,
} from '../mock-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const mockSiteDir = path.resolve(__dirname, '../public/mock-site');

const router = Router();

// 模拟业务系统 API：只监听本机，由同源 Express 提供
router.get('/api/applications', (req, res) => {
  res.json(listApplications());
});

router.get('/api/applications/:applicationNo', (req, res) => {
  const found = findApplication(req.params.applicationNo);
  if (!found) return res.status(404).json({ error: '申请不存在' });
  res.json(found);
});

router.post('/api/applications', (req, res) => {
  try {
    const created = createApplication(req.body);
    res.status(201).json(created);
  } catch (err) {
    if (err.status === 409) return res.status(409).json({ error: err.message, code: err.code });
    res.status(400).json({ error: err.message });
  }
});

// 测试辅助：清空模拟后台数据
router.post('/api/applications-reset', (req, res) => {
  resetApplications();
  res.json({ ok: true });
});

export default router;
