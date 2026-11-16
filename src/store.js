import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONTRACTS_SEED = [
  {
    id: 'contract-a',
    number: 'HT-A-2026-001',
    title: '劳动合同（甲）',
    party: '张明',
    file: 'contract-a.txt',
    published: true,
  },
  {
    id: 'contract-b',
    number: 'HT-B-2026-002',
    title: '保密与竞业限制协议（乙）',
    party: '李华',
    file: 'contract-b.txt',
    published: true,
  },
];

const STATE_VERSION = 1;

/** 过期会话在状态文件里多保留一段时间，便于管理员回看领取记录。 */
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 会话令牌只把摘要写进状态文件，泄露状态文件也拿不到可用 cookie。 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

function emptyState() {
  return {
    version: STATE_VERSION,
    secret: randomToken(32),
    contracts: Object.fromEntries(
      CONTRACTS_SEED.map((c) => [c.id, { ...c }]),
    ),
    links: Object.create(null),
    sessions: Object.create(null),
  };
}

/** 只认自己创建的对象键，避免 __proto__ / constructor 之类的原型链读取。 */
function own(map, key) {
  return typeof key === 'string' && Object.hasOwn(map, key) ? map[key] : undefined;
}

const contractById = (state, id) => own(state.contracts, id);
const linkById = (state, id) => own(state.links, id);
const sessionByHash = (state, id) => own(state.sessions, id);

/**
 * 单一进程内的状态存储。所有写操作都串行执行（transact），
 * 因此“两个浏览器同时领取同一链接”只可能有一个拿到会话。
 * 状态持久化到磁盘，写入采用临时文件 + rename，避免半截文件。
 */
export class Store {
  constructor({ statePath, sessionTtlMs, clock }) {
    this.statePath = statePath;
    this.sessionTtlMs = sessionTtlMs;
    this.clock = clock ?? Date.now;
    this.state = null;
    this.tail = Promise.resolve();
  }

  static async open({ statePath, sessionTtlMs, clock }) {
    const store = new Store({ statePath, sessionTtlMs, clock });
    await store.#load();
    return store;
  }

  async #load() {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.version !== STATE_VERSION) {
        throw new Error(`不支持的状态文件版本: ${parsed.version}`);
      }
      parsed.contracts ??= {};
      parsed.links ??= {};
      parsed.sessions ??= {};
      // 启动时补齐缺失的种子合同，已有合同保持管理员设置的上/下架状态。
      for (const seed of CONTRACTS_SEED) {
        if (!parsed.contracts[seed.id]) {
          parsed.contracts[seed.id] = { ...seed };
        }
      }
      this.state = parsed;
      // 旧状态文件里可能是普通对象，统一成无原型字典。
      this.state.links = Object.assign(Object.create(null), parsed.links);
      this.state.sessions = Object.assign(Object.create(null), parsed.sessions);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = emptyState();
      await this.#persist();
    }
  }

  async #persist() {
    const dir = path.dirname(this.statePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await fs.rename(tmp, this.statePath);
  }

  /** 串行执行一次写事务，成功后落盘。 */
  transact(fn) {
    const run = this.tail.then(async () => {
      const now = this.clock();
      // 每次写事务顺手清理超过留存期的会话，状态文件不会无限增长。
      this.#prune(this.state, now);
      const result = fn(this.state, now);
      await this.#persist();
      return result;
    });
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读：等待排队中的写事务完成后再读，避免读到旧状态。 */
  read(fn) {
    const run = this.tail.then(() => fn(this.state, this.clock()));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #prune(state, now) {
    for (const [id, s] of Object.entries(state.sessions)) {
      // 过期会话多留一段时间，便于管理员回看领取记录；
      // 已撤销的按撤销时间清理，避免状态文件无限增长。
      const agedOut = s.revoked
        ? now >= (s.revokedAt ?? 0) + SESSION_RETENTION_MS
        : now >= s.expiresAt + SESSION_RETENTION_MS;
      if (agedOut) delete state.sessions[id];
    }
  }

  createLink({ contractId, ttlMs, allowDownload }) {
    return this.transact((state, now) => {
      const contract = contractById(state, contractId);
      if (!contract) return { ok: false, reason: 'contract_not_found' };
      if (!contract.published) return { ok: false, reason: 'unpublished' };
      const link = {
        id: randomToken(24),
        contractId,
        allowDownload: Boolean(allowDownload),
        createdAt: now,
        expiresAt: now + ttlMs,
        revoked: false,
        claimed: false,
        claimedAt: null,
        sessionId: null,
      };
      state.links[link.id] = link;
      return { ok: true, link, contract };
    });
  }

  revokeLink(linkId) {
    return this.transact((state, now) => {
      const link = linkById(state, linkId);
      if (!link) return { ok: false, reason: 'not_found' };
      link.revoked = true;
      link.revokedAt = now;
      for (const s of Object.values(state.sessions)) {
        if (s.linkId === link.id && !s.revoked) {
          s.revoked = true;
          s.revokedAt = now;
        }
      }
      return { ok: true, link };
    });
  }

  setPublished(contractId, published) {
    return this.transact((state, now) => {
      const contract = contractById(state, contractId);
      if (!contract) return { ok: false, reason: 'not_found' };
      contract.published = Boolean(published);
      if (!contract.published) {
        for (const s of Object.values(state.sessions)) {
          // 已因撤销失效的会话保留原失效原因。
          if (s.contractId === contract.id && !s.revoked) {
            s.revoked = true;
            s.revokedAt = now;
            s.revokedReason = 'unpublished';
          }
        }
      }
      return { ok: true, contract };
    });
  }

  /**
   * 领取链接。校验与置位在同一事务里完成，天然互斥：
   * 同一链接并发领取时，后到者会看到 claimed=true 并失败。
   */
  claim(linkId) {
    return this.transact((state, now) => {
      const link = linkById(state, linkId);
      if (!link) return { ok: false, reason: 'not_found' };
      if (link.revoked) return { ok: false, reason: 'revoked' };
      if (now >= link.expiresAt) return { ok: false, reason: 'expired' };
      const contract = contractById(state, link.contractId);
      if (!contract || !contract.published) {
        return { ok: false, reason: 'unpublished' };
      }
      if (link.claimed) return { ok: false, reason: 'claimed' };

      link.claimed = true;
      link.claimedAt = now;
      const token = randomToken(32);
      const session = {
        id: hashToken(token),
        linkId: link.id,
        contractId: link.contractId,
        allowDownload: link.allowDownload,
        createdAt: now,
        // 短期会话：从领取时刻起算，且绝不超过链接自身的失效时间。
        expiresAt: Math.min(now + this.sessionTtlMs, link.expiresAt),
        revoked: false,
      };
      state.sessions[session.id] = session;
      link.sessionId = session.id;
      return { ok: true, token, session, contract };
    });
  }

  /** 链接当前是否可领取（只读，不消耗机会）。 */
  inspectLink(linkId) {
    return this.read((state, now) => {
      const link = linkById(state, linkId);
      if (!link) return { ok: false, reason: 'not_found' };
      const contract = contractById(state, link.contractId) ?? null;
      if (link.revoked) return { ok: false, reason: 'revoked', link, contract };
      if (now >= link.expiresAt) {
        return { ok: false, reason: 'expired', link, contract };
      }
      if (!contract || !contract.published) {
        return { ok: false, reason: 'unpublished', link, contract };
      }
      if (link.claimed) return { ok: false, reason: 'claimed', link, contract };
      return { ok: true, link, contract };
    });
  }

  /** 会话校验：撤销、过期、链接失效、合同下架，任一成立即拒绝。 */
  inspectSession(token) {
    return this.read((state, now) => {
      if (!token) return { ok: false, reason: 'not_found' };
      const session = sessionByHash(state, hashToken(token));
      if (!session) return { ok: false, reason: 'not_found' };
      if (session.revoked) {
        return {
          ok: false,
          reason: session.revokedReason ?? 'revoked',
          session,
        };
      }
      if (now >= session.expiresAt) {
        return { ok: false, reason: 'expired', session };
      }
      const link = linkById(state, session.linkId);
      // 撤销是管理员的明确动作，连带作废已领取的会话；
      // 链接自然过期同样不允许继续看（会话本身已按链接失效时间封顶）。
      if (!link || link.revoked) {
        return { ok: false, reason: 'revoked', session };
      }
      if (now >= link.expiresAt) {
        return { ok: false, reason: 'expired', session };
      }
      const contract = contractById(state, session.contractId);
      if (!contract || !contract.published) {
        return { ok: false, reason: 'unpublished', session };
      }
      return { ok: true, session, contract, link };
    });
  }

  /** 管理员视图快照。 */
  snapshot() {
    return this.read((state, now) => ({
      contracts: Object.values(state.contracts),
      links: Object.values(state.links)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((link) => {
          const session = link.sessionId
            ? sessionByHash(state, link.sessionId)
            : null;
          let status = 'active';
          if (link.revoked) status = 'revoked';
          else if (now >= link.expiresAt) status = 'expired';
          else if (link.claimed) status = 'claimed';
          return {
            ...link,
            status,
            contract: contractById(state, link.contractId) ?? null,
            session: session
              ? {
                  expiresAt: session.expiresAt,
                  revoked: session.revoked,
                  live:
                    !session.revoked &&
                    now < session.expiresAt &&
                    !link.revoked &&
                    now < link.expiresAt &&
                    Boolean(
                      contractById(state, session.contractId)?.published,
                    ),
                }
              : null,
          };
        }),
    }));
  }
}
