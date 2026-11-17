/**
 * 账号 / 来源双层滑动窗口限流。
 *
 * 两层各自维护“失败时间戳”列表，互不覆盖：
 *   - 账号窗口按账号聚合，忽略来源；换来源不会清空账号计数。
 *   - 来源窗口按来源聚合，忽略账号；换账号不会清空来源计数。
 * 成功登录只会清空该账号的窗口，不会动来源窗口。
 *
 * 所有判定都在 Mutex 内串行执行，读计数、校验、写计数之间不会被其他请求插入。
 */
export class LoginLimiter {
  constructor({ state, store, clock, log, config, verifier }) {
    this.state = state;
    this.store = store;
    this.clock = clock;
    this.log = log;
    this.config = config;
    this.verifier = verifier;
  }

  /**
   * @param {{ username: string, password: string, source: string }} attempt
   * @returns {{ ok: boolean, limited: boolean, layer: 'account'|'source'|null,
   *             retryAfterMs: number, retryAt: number|null }}
   */
  attempt({ username, password, source, viaDemo = false }) {
    const account = String(username ?? '').trim().toLowerCase();
    const now = this.clock.now();
    const accountFailures = this.#prune('accounts', account, now);
    const sourceFailures = this.#prune('sources', source, now);

    const accountBlocked = accountFailures.length >= this.config.accountLimit;
    const sourceBlocked = sourceFailures.length >= this.config.sourceLimit;

    if (accountBlocked || sourceBlocked) {
      // layer 表示首个生效的层（账号层优先，视为更严格）；
      // layers 列出本次所有处于上限的层，便于管理员判断要等哪一个窗口。
      const layers = [
        ...(accountBlocked ? ['account'] : []),
        ...(sourceBlocked ? ['source'] : []),
      ];
      const layer = layers[0];

      // 要等所有生效的层都过期才能真正再试，因此取各层截止时间的最大值。
      const deadlines = [];
      if (accountBlocked) {
        deadlines.push(earliestRetry(accountFailures, this.config.accountLimit, this.config.accountWindowMs));
      }
      if (sourceBlocked) {
        deadlines.push(earliestRetry(sourceFailures, this.config.sourceLimit, this.config.sourceWindowMs));
      }
      const retryAt = deadlines.length === 0 ? null : Math.max(...deadlines);

      this.log.write({
        event: 'login_blocked',
        layer,
        layers,
        account,
        source,
        accountFailures: accountFailures.length,
        sourceFailures: sourceFailures.length,
        retryAt: retryAt === null ? null : new Date(retryAt).toISOString(),
      });
      this.#persist();
      return {
        ok: false,
        limited: true,
        layer,
        layers,
        retryAfterMs: retryAt === null ? 0 : Math.max(0, retryAt - now),
        retryAt,
      };
    }

    if (this.verifier.verify(account, password)) {
      // 成功登录只清本账号窗口，来源窗口保持原样。
      delete this.state.accounts[account];
      this.log.write({
        event: 'login_success',
        account,
        source,
        sourceFailures: sourceFailures.length,
      });
      this.#persist();
      return { ok: true, limited: false, layer: null, retryAfterMs: 0, retryAt: null };
    }

    accountFailures.push(now);
    sourceFailures.push(now);
    this.state.accounts[account] = { failures: accountFailures };
    this.state.sources[source] = { failures: sourceFailures };
    this.log.write({
      event: 'login_failed',
      account,
      source,
      viaDemo,
      accountFailures: accountFailures.length,
      sourceFailures: sourceFailures.length,
      accountBlocked: accountFailures.length >= this.config.accountLimit,
      sourceBlocked: sourceFailures.length >= this.config.sourceLimit,
    });
    this.#persist();
    return { ok: false, limited: false, layer: null, retryAfterMs: 0, retryAt: null };
  }

  /** 只读快照，供本地演示页判断“什么时候能再试”。 */
  describe(account, source, now = this.clock.now()) {
    const key = String(account ?? '').trim().toLowerCase();
    const accountFailures = activeFailures(this.state.accounts[key]?.failures, now, this.config.accountWindowMs);
    const sourceFailures = activeFailures(this.state.sources[source]?.failures, now, this.config.sourceWindowMs);

    const accountWindow = {
      used: accountFailures.length,
      limit: this.config.accountLimit,
      windowMs: this.config.accountWindowMs,
      blocked: accountFailures.length >= this.config.accountLimit,
      retryAt: earliestRetry(accountFailures, this.config.accountLimit, this.config.accountWindowMs),
    };
    const sourceWindow = {
      used: sourceFailures.length,
      limit: this.config.sourceLimit,
      windowMs: this.config.sourceWindowMs,
      blocked: sourceFailures.length >= this.config.sourceLimit,
      retryAt: earliestRetry(sourceFailures, this.config.sourceLimit, this.config.sourceWindowMs),
    };

    // 真正能再次尝试登录，要等所有生效的层都到期，因此取各层截止时间的最大值。
    const blockedBy = [
      ...(accountWindow.blocked ? ['account'] : []),
      ...(sourceWindow.blocked ? ['source'] : []),
    ];
    const deadlines = [
      ...(accountWindow.blocked && accountWindow.retryAt !== null ? [accountWindow.retryAt] : []),
      ...(sourceWindow.blocked && sourceWindow.retryAt !== null ? [sourceWindow.retryAt] : []),
    ];

    return {
      accountName: key,
      sourceId: source,
      blockedBy,
      nextRetryAt: deadlines.length === 0 ? null : Math.max(...deadlines),
      accountWindow,
      sourceWindow,
    };
  }

  clearAll() {
    this.state.accounts = Object.create(null);
    this.state.sources = Object.create(null);
    this.#persist();
  }

  /** 演示时钟变化后持久化偏移量，重启后仍使用同一时钟。 */
  persistClock() {
    this.#persist();
  }

  #prune(bucket, key, now) {
    const windowMs = bucket === 'accounts' ? this.config.accountWindowMs : this.config.sourceWindowMs;
    const failures = activeFailures(this.state[bucket][key]?.failures, now, windowMs);
    if (failures.length === 0) {
      delete this.state[bucket][key];
    } else {
      this.state[bucket][key] = { failures };
    }
    return failures;
  }

  #persist() {
    this.state.clockOffsetMs = this.clock.offsetMs;
    this.#trimKeys('accounts', this.config.accountWindowMs);
    this.#trimKeys('sources', this.config.sourceWindowMs);
    this.store.save(this.state);
  }

  /**
   * 状态里每个键的失败条数上限就是该层的 limit（达到上限后请求会被拦截、
   * 不再写入），因此总量由键数决定。这里给键数封顶，避免用大量不同账号名
   * 或来源把状态撑大。淘汰仍在窗口内的键会削弱对应限制，所以写进管理员日志。
   */
  #trimKeys(bucket, windowMs) {
    const keys = Object.keys(this.state[bucket]);
    if (keys.length <= MAX_KEYS) return;

    const now = this.clock.now();
    const live = [];
    for (const key of keys) {
      const failures = this.state[bucket][key].failures;
      const latest = failures[failures.length - 1] ?? 0;
      if (now - latest >= windowMs) {
        delete this.state[bucket][key];
      } else {
        live.push({ key, latest });
      }
    }

    if (live.length <= MAX_KEYS) return;
    live.sort((a, b) => a.latest - b.latest);
    const evicted = live.slice(0, live.length - MAX_KEYS);
    for (const { key } of evicted) delete this.state[bucket][key];
    this.log.write({
      event: 'state_evicted',
      bucket,
      evictedKeys: evicted.length,
      reason: 'key_capacity_exceeded',
    });
  }
}

const MAX_KEYS = 10_000;

function activeFailures(failures, now, windowMs) {
  if (!Array.isArray(failures)) return [];
  return failures.filter((ts) => now - ts < windowMs).sort((a, b) => a - b);
}

/**
 * 计数降到上限以下所需的最早时刻。
 * 窗口里满了 limit 条时，还要等第 (count - limit + 1) 条最早的记录过期。
 */
function earliestRetry(failures, limit, windowMs) {
  if (failures.length < limit) return null;
  const index = failures.length - limit;
  return failures[index] + windowMs;
}
