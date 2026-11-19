'use strict';
// 报告库存储:导入供应商 HTML 报告及其本地资源,落盘到 data/reports/<id>/。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildCheckResult, classifyUrl, extractResources } = require('./html-utils');

class ReportStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  /**
   * 导入一份报告。
   * @param {string} title 用户填写的标题(仅按文本存储/展示)
   * @param {string} sourcePath 本地 HTML 文件路径
   */
  import({ title, sourcePath }) {
    const html = fs.readFileSync(sourcePath, 'utf8');
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'report.html'), html);

    // 本地(相对路径)资源随报告拷贝入库;外部资源不抓取、不联网。
    const { resources } = extractResources(html);
    const copiedAssets = [];
    for (const r of resources) {
      if (classifyUrl(r.url) !== 'local') continue;
      const name = path.basename(decodeURIComponent(r.url.split(/[?#]/)[0]));
      if (!name || name.includes('..')) continue;
      const from = path.resolve(path.dirname(sourcePath), r.url.split(/[?#]/)[0]);
      if (!from.startsWith(path.resolve(path.dirname(sourcePath)) + path.sep)) continue;
      if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dir, name));
      copiedAssets.push(name);
    }

    const meta = {
      id,
      title: String(title ?? ''),
      originalFileName: path.basename(sourcePath),
      importedAt: new Date().toISOString(),
      assets: copiedAssets,
      check: buildCheckResult(html),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  list() {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => this.get(e.name))
      .filter(Boolean)
      .sort((a, b) => a.importedAt.localeCompare(b.importedAt));
  }

  get(id) {
    if (!/^[\w-]+$/.test(id)) return null;
    const metaPath = path.join(this.root, id, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  }

  htmlPath(id) {
    if (!this.get(id)) return null;
    return path.join(this.root, id, 'report.html');
  }

  /** 只允许报告目录内的扁平文件名,防路径穿越。 */
  assetPath(id, name) {
    if (!this.get(id)) return null;
    if (!/^[\w.%-]+$/.test(name) || name.includes('..')) return null;
    const p = path.join(this.root, id, name);
    return fs.existsSync(p) ? p : null;
  }
}

module.exports = { ReportStore };
