import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export const DEMO_PASSWORD = 'demo1234';

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function makeUser({ id, username, name, password }) {
  const { salt, hash } = hashPassword(password);
  return { id, username, name, passwordSalt: salt, passwordHash: hash };
}

export function verifyPassword(user, password) {
  const candidate = Buffer.from(scryptSync(password, user.passwordSalt, 64).toString('hex'));
  const expected = Buffer.from(user.passwordHash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function seed() {
  const now = Date.now();
  const orgs = [
    { id: 'org-a', name: '甲机构' },
    { id: 'org-b', name: '乙机构' },
  ];

  const users = [
    makeUser({ id: 'u-li', username: 'li', name: '李强（主管）', password: DEMO_PASSWORD }),
    makeUser({ id: 'u-wang', username: 'wang', name: '王敏（员工）', password: DEMO_PASSWORD }),
    makeUser({ id: 'u-zhao', username: 'zhao', name: '赵磊（员工）', password: DEMO_PASSWORD }),
  ];

  // 权限按 (用户, 机构) 独立存储：撤销甲机构不会写到乙机构的记录上。
  const memberships = [
    { id: 'm-1', userId: 'u-li', orgId: 'org-a', role: 'supervisor', active: true, grantedAt: now, revokedAt: null, revokedBy: null },
    { id: 'm-2', userId: 'u-li', orgId: 'org-b', role: 'supervisor', active: true, grantedAt: now, revokedAt: null, revokedBy: null },
    { id: 'm-3', userId: 'u-wang', orgId: 'org-a', role: 'employee', active: true, grantedAt: now, revokedAt: null, revokedBy: null },
    { id: 'm-4', userId: 'u-wang', orgId: 'org-b', role: 'employee', active: true, grantedAt: now, revokedAt: null, revokedBy: null },
    { id: 'm-5', userId: 'u-zhao', orgId: 'org-a', role: 'employee', active: true, grantedAt: now, revokedAt: null, revokedBy: null },
  ];

  const tickets = [
    {
      id: 'TKT-A-001', orgId: 'org-a', title: '三楼打印机卡纸并有异响', status: '待处理',
      assigneeId: 'u-wang', description: '打印任务卡在三楼东侧打印机，面板提示 E-04。',
      createdAt: now - 36 * 3600e3, updatedAt: now - 2 * 3600e3,
    },
    {
      id: 'TKT-A-002', orgId: 'org-a', title: '会议室投影仪无法开机', status: '处理中',
      assigneeId: 'u-zhao', description: '2 号会议室投影仪指示灯不亮，已更换电源线仍未恢复。',
      createdAt: now - 24 * 3600e3, updatedAt: now - 5 * 3600e3,
    },
    {
      id: 'TKT-A-003', orgId: 'org-a', title: '门禁卡补办申请', status: '已完成',
      assigneeId: 'u-wang', description: '员工门禁卡遗失，补办新卡并注销旧卡。',
      createdAt: now - 120 * 3600e3, updatedAt: now - 72 * 3600e3,
    },
    {
      id: 'TKT-B-001', orgId: 'org-b', title: '数据节点磁盘使用率告警', status: '待处理',
      assigneeId: 'u-wang', description: '/data 分区使用率 91%，需要清理历史日志。',
      createdAt: now - 8 * 3600e3, updatedAt: now - 1 * 3600e3,
    },
    {
      id: 'TKT-B-002', orgId: 'org-b', title: '新同事 VPN 账号开通', status: '处理中',
      assigneeId: 'u-wang', description: '为运维组新同事开通 VPN 并配置双因素认证。',
      createdAt: now - 30 * 3600e3, updatedAt: now - 3 * 3600e3,
    },
    {
      id: 'TKT-B-003', orgId: 'org-b', title: '报表导出脚本偶发超时', status: '待处理',
      assigneeId: null, description: '每日 02:00 的报表任务偶发超过 10 分钟，需要排查。',
      createdAt: now - 12 * 3600e3, updatedAt: now - 6 * 3600e3,
    },
  ];

  const attachments = [
    { id: 'ATT-A-001-1', ticketId: 'TKT-A-001', filename: '打印机错误码.txt', contentType: 'text/plain; charset=utf-8', content: 'E-04 定影单元温度异常\n时间：2026-11-16 09:12\n设备：PRN-3F-EAST\n' },
    { id: 'ATT-A-001-2', ticketId: 'TKT-A-001', filename: '现场照片说明.txt', contentType: 'text/plain; charset=utf-8', content: '现场：三楼东侧打印机，纸张卡在出纸口。\n' },
    { id: 'ATT-A-002-1', ticketId: 'TKT-A-002', filename: '投影仪点检记录.txt', contentType: 'text/plain; charset=utf-8', content: '电源模块无输出，建议更换整机。\n' },
    { id: 'ATT-A-003-1', ticketId: 'TKT-A-003', filename: '门禁补办回执.txt', contentType: 'text/plain; charset=utf-8', content: '新卡号：A-88213，旧卡已注销。\n' },
    { id: 'ATT-B-001-1', ticketId: 'TKT-B-001', filename: '磁盘使用率.txt', contentType: 'text/plain; charset=utf-8', content: '/data 使用率 91%\n/var 使用率 47%\n' },
    { id: 'ATT-B-002-1', ticketId: 'TKT-B-002', filename: 'VPN开通清单.txt', contentType: 'text/plain; charset=utf-8', content: '账号：ops-new-01，已绑定 MFA。\n' },
    { id: 'ATT-B-003-1', ticketId: 'TKT-B-003', filename: '任务耗时日志.txt', contentType: 'text/plain; charset=utf-8', content: '2026-11-15 02:00 耗时 12m31s\n2026-11-16 02:00 耗时 3m04s\n' },
  ];

  return { version: 1, createdAt: now, orgs, users, memberships, tickets, attachments, exports: [], audit: [] };
}

export function createStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  mkdirSync(dataDir, { recursive: true });

  let data;
  if (existsSync(file)) {
    data = JSON.parse(readFileSync(file, 'utf8'));
    data.exports ??= [];
    data.audit ??= [];
  } else {
    data = seed();
    persist();
  }

  function persist() {
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  }

  return {
    data,
    save: persist,
    audit(actorId, action, fields = {}) {
      data.audit.push({ at: Date.now(), actorId, action, ...fields });
      persist();
    },
  };
}

export { hashPassword };
