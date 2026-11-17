import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PASSWORD_KEYLEN = 64;
const SESSION_TOKEN_BYTES = 32;

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, PASSWORD_KEYLEN).toString('hex');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function makeSalt() {
  return randomBytes(16).toString('hex');
}

function makeSessionId() {
  return `s_${randomBytes(9).toString('hex')}`;
}

function seedData() {
  const passwordSalt = makeSalt();
  const base = Date.now();
  return {
    version: 1,
    users: [
      {
        id: 'u_demo',
        username: 'demo',
        displayName: '演示账号',
        passwordSalt,
        passwordHash: hashPassword('demo1234', passwordSalt),
      },
    ],
    drafts: [
      {
        id: 'draft-launch',
        userId: 'u_demo',
        title: '秋季产品发布计划',
        content: [
          '秋季产品发布计划',
          '',
          '一、目标',
          '在 11 月 20 日前完成「轻协作」内测版本发布，邀请 30 位真实用户参与，收集至少 20 份可用反馈。',
          '',
          '二、关键节点',
          '11 月 12 日　完成登录与权限模块联调',
          '11 月 16 日　冻结功能，进入回归测试',
          '11 月 18 日　开放内测邀请码',
          '11 月 20 日　发布说明与使用指南上线',
          '',
          '三、风险与应对',
          '1. 多端同步延迟：优先保证保存请求的服务端校验，冲突时保留本地副本。',
          '2. 内测名额不足：从等待名单中补选 10 位活跃用户。',
          '',
          '四、责任人',
          '产品：林舟',
          '设计：周宁',
          '研发：陈默、许川',
        ].join('\n'),
        version: 1,
        updatedAt: new Date(base - 42 * 60 * 1000).toISOString(),
      },
      {
        id: 'draft-retro',
        userId: 'u_demo',
        title: '十月团队复盘',
        content: [
          '十月团队复盘',
          '',
          '做得好的地方',
          '· 发布节奏稳定，两次迭代都按计划上线。',
          '· 新同学在两周内独立负责了一个完整模块。',
          '· 线上问题平均响应时间从 42 分钟降到 18 分钟。',
          '',
          '需要改进的地方',
          '· 需求评审停留在口头结论，缺少可追溯的记录。',
          '· 联调阶段才发现接口字段不一致，返工成本偏高。',
          '· 文档更新滞后，值班同学需要反复在群里确认。',
          '',
          '下个迭代的三个动作',
          '1. 每次评审结束当天补齐决议与负责人。',
          '2. 接口约定先行，字段变更必须同步到文档。',
          '3. 每周五整理一次常见问题，减少重复沟通。',
        ].join('\n'),
        version: 3,
        updatedAt: new Date(base - 26 * 60 * 60 * 1000).toISOString(),
      },
    ],
    sessions: [],
  };
}

function sanitizeDeviceName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.writeChain = Promise.resolve();
    this.activityTimer = null;
  }

  static async open(filePath) {
    const store = new Store(filePath);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.drafts)) {
        throw new Error(`数据文件结构不正确：${filePath}`);
      }
      store.data = {
        version: parsed.version ?? 1,
        users: parsed.users,
        drafts: parsed.drafts,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      store.data = seedData();
      await store.saveNow();
    }
    return store;
  }

  async saveNow() {
    const payload = `${JSON.stringify(this.data, null, 2)}\n`;
    const dir = path.dirname(this.filePath);
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    // 串行写入，避免并发覆盖；一次失败不应让后续写入全部失败。
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  queueSave() {
    this.saveNow().catch((error) => {
      console.error('[store] 写入数据文件失败：', error);
    });
  }

  scheduleActivitySave() {
    if (this.activityTimer) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.queueSave();
    }, 1500);
    this.activityTimer.unref?.();
  }

  async close() {
    if (this.activityTimer) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
    await this.saveNow();
    await this.writeChain;
  }

  getUserById(id) {
    return this.data.users.find((user) => user.id === id) ?? null;
  }

  verifyCredentials(username, password) {
    const normalized = String(username ?? '').trim().toLowerCase();
    const user = this.data.users.find((item) => item.username.toLowerCase() === normalized);
    if (!user) return null;
    const expected = Buffer.from(user.passwordHash, 'hex');
    const actual = Buffer.from(hashPassword(String(password ?? ''), user.passwordSalt), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return user;
  }

  createSession({ userId, deviceName, deviceNameSource = 'auto', kind, userAgent, ip }) {
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
    const timestamp = nowIso();
    const session = {
      id: makeSessionId(),
      userId,
      tokenHash: hashToken(token),
      deviceName: sanitizeDeviceName(deviceName) || '未知设备',
      deviceNameSource: deviceNameSource === 'user' ? 'user' : 'auto',
      kind: ['desktop', 'mobile', 'tablet'].includes(kind) ? kind : 'desktop',
      userAgent: String(userAgent ?? '').slice(0, 500),
      ip: String(ip ?? '').slice(0, 80),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      revokedAt: null,
      revokedReason: null,
      revokedByDeviceName: null,
    };
    this.data.sessions.push(session);
    this.queueSave();
    return { token, session };
  }

  // 同一台设备的判定键：用户起过名字的按名字聚合（重新登录后新旧会话归在一起）；
  // 自动命名的则再加上 User-Agent，避免把不同浏览器误认成同一台设备。
  deviceKeyFor(session) {
    return session.deviceNameSource === 'user'
      ? `name:${session.deviceName}`
      : `auto:${session.deviceName}::${session.userAgent}`;
  }

  findSessionByToken(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    return this.data.sessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }

  findSessionById(id) {
    return this.data.sessions.find((session) => session.id === id) ?? null;
  }

  sessionsForUser(userId) {
    return this.data.sessions.filter((session) => session.userId === userId);
  }

  markActivity(session) {
    if (!session || session.revokedAt) return;
    const previous = Date.parse(session.lastSeenAt);
    if (Number.isFinite(previous) && Date.now() - previous < 5000) return;
    session.lastSeenAt = nowIso();
    this.scheduleActivitySave();
  }

  revokeSession(session, reason, { bySession = null } = {}) {
    if (!session || session.revokedAt) return false;
    session.revokedAt = nowIso();
    session.revokedReason = reason;
    session.revokedByDeviceName = bySession ? bySession.deviceName : null;
    this.queueSave();
    return true;
  }

  revokeOtherSessions(userId, currentSessionId, bySession) {
    let count = 0;
    for (const session of this.sessionsForUser(userId)) {
      if (session.id === currentSessionId || session.revokedAt) continue;
      session.revokedAt = nowIso();
      session.revokedReason = 'revoked_by_device';
      session.revokedByDeviceName = bySession?.deviceName ?? null;
      count += 1;
    }
    if (count > 0) this.queueSave();
    return count;
  }

  listDrafts(userId) {
    return this.data.drafts
      .filter((draft) => draft.userId === userId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  getDraft(userId, draftId) {
    return this.data.drafts.find((draft) => draft.userId === userId && draft.id === draftId) ?? null;
  }

  updateDraft(userId, draftId, content) {
    const draft = this.getDraft(userId, draftId);
    if (!draft) return null;
    draft.content = content;
    draft.version += 1;
    draft.updatedAt = nowIso();
    this.queueSave();
    return draft;
  }
}
