import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeLabel, randomId, randomToken } from './util.js';
import { normalizeAssetKey, sanitizeReport } from './sanitize.js';

/**
 * 按报告存放：data/reports/<reportId>/
 *   meta.json      标题、文件名等纯文本信息（展示时一律当文本处理）
 *   report.html    净化后的报告正文片段
 *   check.json     资源检查结果
 *   assets/<name>  随报告导入的本地资源
 */
export class ReportStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'reports');
  }

  dir(reportId) {
    if (!/^rpt_[a-f0-9]{16}$/.test(reportId)) throw new Error('invalid report id');
    return path.join(this.root, reportId);
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }

  async list() {
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const reports = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^rpt_[a-f0-9]{16}$/.test(entry.name)) continue;
      try {
        reports.push(await this.getMeta(entry.name));
      } catch {
        // 损坏的报告目录跳过，不影响列表
      }
    }
    reports.sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
    return reports;
  }

  async getMeta(reportId) {
    const raw = await fs.readFile(path.join(this.dir(reportId), 'meta.json'), 'utf8');
    return JSON.parse(raw);
  }

  async getCheck(reportId) {
    const raw = await fs.readFile(path.join(this.dir(reportId), 'check.json'), 'utf8');
    return JSON.parse(raw);
  }

  async readBody(reportId) {
    return fs.readFile(path.join(this.dir(reportId), 'report.html'), 'utf8');
  }

  assetPath(reportId, storedName) {
    if (!/^[a-z0-9][a-z0-9._-]{0,80}$/i.test(storedName)) throw new Error('invalid asset name');
    return path.join(this.dir(reportId), 'assets', storedName);
  }

  /**
   * @param {object} input
   * @param {string} input.title 导入者提供的标题（纯文本）
   * @param {string} input.fileName 导入者提供的文件名（纯文本）
   * @param {string} input.html 报告 HTML
   * @param {Array<{path: string, contentType?: string, dataBase64?: string, text?: string}>} input.assets
   * @param {string[]} input.declaredExternalUrls 作者声明的外部资源
   */
  async importReport({ title, fileName, html, assets = [], declaredExternalUrls = [] }) {
    if (typeof html !== 'string') throw new Error('报告 HTML 必须是字符串');
    const reportId = randomId();
    const reportToken = randomToken();

    const assetsByKey = new Map();
    const prepared = [];
    const basenameCount = new Map();
    let assetIndex = 0;
    for (const asset of assets) {
      if (!asset || typeof asset.path !== 'string') continue;
      const key = normalizeAssetKey(asset.path);
      if (!key || assetsByKey.has(key)) continue;
      assetIndex += 1;
      const ext = path.extname(key);
      const storedName = `asset-${assetIndex}${/^\.[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : ''}`;
      const bytes = typeof asset.text === 'string'
        ? Buffer.from(asset.text, 'utf8')
        : Buffer.from(String(asset.dataBase64 ?? ''), 'base64');
      const entry = {
        key,
        originalPath: asset.path,
        storedName,
        contentType: typeof asset.contentType === 'string'
          ? asset.contentType.slice(0, 120)
          : 'application/octet-stream',
        content: typeof asset.text === 'string' ? asset.text : undefined,
        bytes,
      };
      assetsByKey.set(key, entry);
      prepared.push(entry);
      const basename = key.split('/').pop();
      basenameCount.set(basename, (basenameCount.get(basename) ?? 0) + 1);
    }

    // 从文件选择框导入时浏览器只给文件名，报告里却常写 images/chart.png。
    // 因此再按“唯一文件名”做一次别名匹配；同名资源有歧义时不做猜测。
    for (const entry of prepared) {
      const basename = entry.key.split('/').pop();
      if (basename === entry.key) continue;
      if (basenameCount.get(basename) === 1 && !assetsByKey.has(basename)) {
        assetsByKey.set(basename, entry);
      }
    }

    const { body, check } = sanitizeReport({
      html,
      reportId,
      token: reportToken,
      assets: assetsByKey,
    });

    const externalMap = new Map();
    for (const entry of check.resources) {
      if (entry.status !== 'external' || !entry.url) continue;
      if (!externalMap.has(entry.url)) {
        externalMap.set(entry.url, {
          url: entry.url,
          kinds: new Set(),
          source: entry.kind === 'declared' ? 'declared' : 'report',
        });
      }
      externalMap.get(entry.url).kinds.add(entry.kind === 'declared' ? 'author-declared' : entry.kind);
    }
    for (const url of declaredExternalUrls) {
      if (typeof url !== 'string' || !url.trim()) continue;
      const trimmed = url.trim().slice(0, 2000);
      if (!externalMap.has(trimmed)) {
        externalMap.set(trimmed, { url: trimmed, kinds: new Set(), source: 'declared' });
      }
    }
    check.externalResources = [...externalMap.values()].map((item) => ({
      url: item.url,
      kinds: [...item.kinds],
      source: item.source,
      loaded: false,
    }));

    const meta = {
      id: reportId,
      token: reportToken,
      title: normalizeLabel(title, '未命名报告', 200),
      fileName: normalizeLabel(fileName, 'report.html', 200),
      importedAt: new Date().toISOString(),
      sizeBytes: Buffer.byteLength(html, 'utf8'),
      assets: prepared.map((a) => ({
        path: a.originalPath,
        storedName: a.storedName,
        contentType: a.contentType,
        sizeBytes: a.bytes.length,
      })),
      summary: check.summary,
      externalCount: check.externalResources.length,
    };

    const dir = this.dir(reportId);
    await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(dir, 'report.html'), body);
    await fs.writeFile(path.join(dir, 'check.json'), JSON.stringify(check, null, 2));
    for (const asset of prepared) {
      await fs.writeFile(path.join(dir, 'assets', asset.storedName), asset.bytes);
    }
    return meta;
  }

  async remove(reportId) {
    await fs.rm(this.dir(reportId), { recursive: true, force: true });
  }
}
