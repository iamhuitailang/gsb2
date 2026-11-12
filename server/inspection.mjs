/**
 * 检查流水线：对已完整落盘的临时文件执行服务端独立判定。
 * 信任链只基于文件字节与服务端配置；文件名/扩展名/客户端 MIME 仅记录、不参与判定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { sniffType, verifyImage } from './lib/sniffer.mjs';
import { inspectAndExtract } from './lib/zip-inspect.mjs';
import { ensureInside, safeDisplayName } from './lib/paths.mjs';
import { addAudit, createTask, getTask, updateTask } from './db.mjs';

const { allowed, maxUploadBytes } = config.limits;

/**
 * 执行检查。tmpPath 为 busboy 写入的临时文件（位于 data/tmp）。
 * @returns 任务记录（已持久化）
 */
export async function inspectFile({ tmpPath, originalName, clientMime, declaredSize }) {
  const id = randomUUID();
  const displayName = safeDisplayName(originalName);
  const clientExt = path.extname(displayName).slice(1).toLowerCase();
  const createdAt = new Date().toISOString();

  const task = {
    id,
    created_at: createdAt,
    updated_at: createdAt,
    original_name: displayName,
    client_mime: clientMime || null,
    client_ext: clientExt || null,
    declared_size: declaredSize,
    detected_type: null,
    status: 'inspecting',
    reasons: [],
    storage_name: null,
    stored_size: null,
    width: null,
    height: null,
    zip_meta: null,
  };
  createTask(task);
  addAudit(id, 'upload.received', `客户端声明 MIME=${clientMime || '未知'}，扩展名=${clientExt || '无'}，字节数=${declaredSize}`);

  try {
    const buf = fs.readFileSync(tmpPath);

    // 1) 大小检查（busboy 已做流式硬截断，这里是服务端二次确认）
    if (buf.length === 0) {
      return reject(id, tmpPath, buf, ['文件内容为空（0 字节）']);
    }
    if (buf.length > maxUploadBytes) {
      return reject(id, tmpPath, buf, [`文件大小 ${buf.length} 字节超过上限 ${maxUploadBytes} 字节`]);
    }

    // 2) 基于字节的类型嗅探
    const detected = sniffType(buf.subarray(0, Math.min(512, buf.length)));
    if (!detected || !allowed[detected]) {
      return reject(id, tmpPath, buf, [
        `实际内容不在允许的格式列表内（允许: ${Object.keys(allowed).join(', ')}），客户端 MIME 与扩展名不被信任`,
      ]);
    }
    updateTask(id, { detected_type: detected });

    // 3) 记录声明与实际不符（作为提示，不单独作为拒收理由——真正的判定以实际内容为准）
    const hints = [];
    if (clientExt && allowed[detected].ext !== clientExt) {
      hints.push(`扩展名 .${clientExt} 与实际内容 ${detected.toUpperCase()} 不一致，已按实际内容处理`);
    }
    if (clientMime && clientMime.toLowerCase() !== allowed[detected].mime) {
      hints.push(`浏览器声明 MIME ${clientMime} 与实际内容 ${allowed[detected].mime} 不一致，已忽略`);
    }

    // 4) 按类型深度检查
    if (detected === 'zip') {
      return await handleZip(id, tmpPath, buf, hints);
    }
    return handleImage(id, tmpPath, buf, detected, hints);
  } catch (err) {
    return reject(id, tmpPath, null, [`检查过程发生内部错误: ${err.message}`]);
  }
}

function handleImage(id, tmpPath, buf, detected, hints) {
  const structural = verifyImage(detected, buf);
  if (!structural.ok) {
    return reject(id, tmpPath, buf, [`内容虽含 ${detected.toUpperCase()} 特征但结构不合法: ${structural.reason}`]);
  }

  const storageName = `${randomUUID()}.${allowed[detected].ext}`;
  const target = ensureInside(config.dirs.accepted, path.join(config.dirs.accepted, storageName));
  fs.renameSync(tmpPath, target);
  fs.chmodSync(target, 0o400);

  updateTask(id, {
    status: 'accepted',
    storage_name: storageName,
    stored_size: buf.length,
    width: structural.width ?? null,
    height: structural.height ?? null,
    reasons: hints,
  });
  addAudit(id, 'inspect.accepted', `类型=${detected}，尺寸=${structural.width}x${structural.height}，存储名=${storageName}`);
  hints.forEach((h) => addAudit(id, 'inspect.warning', h));
  return getTask(id);
}

async function handleZip(id, tmpPath, buf, hints) {
  // 每个任务使用独立的一次性解压目录，目录名同样由服务端随机生成
  const extractId = randomUUID();
  const extractDir = ensureInside(
    config.dirs.tmp,
    path.join(config.dirs.tmp, `extract_${extractId}`),
  );
  fs.mkdirSync(extractDir, { recursive: true, mode: 0o700 });

  const result = await inspectAndExtract(tmpPath, extractDir);
  if (!result.ok) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    return reject(id, tmpPath, buf, [result.reason]);
  }

  // 解压通过后，原始 ZIP 以随机名收入 accepted；解压目录清点后删除，不保留解包树
  const storageName = `${randomUUID()}.zip`;
  const target = ensureInside(config.dirs.accepted, path.join(config.dirs.accepted, storageName));
  fs.renameSync(tmpPath, target);
  fs.chmodSync(target, 0o400);
  fs.rmSync(extractDir, { recursive: true, force: true });

  const zipMeta = {
    entries: result.entries,
    totalUncompressedBytes: result.totalBytes,
    files: result.files,
  };
  updateTask(id, {
    status: 'accepted',
    storage_name: storageName,
    stored_size: buf.length,
    zip_meta: zipMeta,
    reasons: hints,
  });
  addAudit(
    id,
    'inspect.accepted',
    `ZIP 检查通过：条目=${result.entries}，解压总量=${result.totalBytes}B，存储名=${storageName}`,
  );
  return getTask(id);
}

/**
 * 拒收：把临时文件移入隔离区并赋予随机隔离名，更新任务状态。
 * 隔离文件与已通过文件分属不同目录，且只通过数据库中该任务的 storage_name 可寻址。
 */
function reject(id, tmpPath, buf, reasons) {
  let quarantineName = null;
  let storedSize = null;
  if (tmpPath && fs.existsSync(tmpPath)) {
    quarantineName = `q_${randomUUID()}.bin`;
    const qTarget = ensureInside(
      config.dirs.quarantine,
      path.join(config.dirs.quarantine, quarantineName),
    );
    fs.renameSync(tmpPath, qTarget);
    fs.chmodSync(qTarget, 0o400);
    storedSize = fs.statSync(qTarget).size;
  }
  updateTask(id, {
    status: 'quarantined',
    storage_name: quarantineName,
    stored_size: storedSize ?? (buf ? buf.length : null),
    reasons,
  });
  for (const reason of reasons) {
    addAudit(id, 'inspect.rejected', reason);
  }
  addAudit(id, 'quarantine.moved', quarantineName ? `隔离存储名=${quarantineName}` : '临时文件不存在，无文件可隔离');
  return getTask(id);
}
