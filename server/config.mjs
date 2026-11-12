/**
 * 集中式配置。所有限制都可通过环境变量覆盖。
 * 所有限制在上传/检查的多个阶段都会被强制执行，而不是只在一处校验。
 */
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = process.env.FIW_DATA_DIR
  ? path.resolve(process.env.FIW_DATA_DIR)
  : path.resolve(process.cwd(), 'data');

export const config = {
  port: Number(process.env.FIW_PORT || 8787),
  dataDir: DATA_DIR,
  dirs: {
    tmp: path.join(DATA_DIR, 'tmp'),
    accepted: path.join(DATA_DIR, 'accepted'),
    quarantine: path.join(DATA_DIR, 'quarantine'),
    db: path.join(DATA_DIR, 'app.db'),
  },
  limits: {
    // 单文件上传大小硬上限（busboy 在流式传输阶段即截断）
    maxUploadBytes: Number(process.env.FIW_MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
    // 允许的文件格式：键为内部类型标识，ext 为唯一可信的落盘扩展名
    allowed: {
      png: { ext: 'png', mime: 'image/png', label: 'PNG 图像' },
      jpeg: { ext: 'jpg', mime: 'image/jpeg', label: 'JPEG 图像' },
      gif: { ext: 'gif', mime: 'image/gif', label: 'GIF 图像' },
      webp: { ext: 'webp', mime: 'image/webp', label: 'WebP 图像' },
      bmp: { ext: 'bmp', mime: 'image/bmp', label: 'BMP 图像' },
      zip: { ext: 'zip', mime: 'application/zip', label: 'ZIP 压缩包' },
    },
    zip: {
      maxEntries: Number(process.env.FIW_ZIP_MAX_ENTRIES || 100),
      maxTotalUncompressedBytes: Number(
        process.env.FIW_ZIP_MAX_TOTAL || 20 * 1024 * 1024,
      ),
      maxEntryBytes: Number(process.env.FIW_ZIP_MAX_ENTRY || 10 * 1024 * 1024),
    },
  },
};

export function ensureDataDirs() {
  for (const dir of [config.dataDir, config.dirs.tmp, config.dirs.accepted, config.dirs.quarantine]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
