/**
 * 简单的串行互斥队列。
 *
 * 登录判定包含“读取计数 → 校验密码 → 写回计数”三步。即使密码校验将来
 * 变成异步实现，同一时刻也只允许一个请求走完整个判定，保证同时到达的
 * 请求不会一起越过上限。
 */
export class Mutex {
  #tail = Promise.resolve();

  run(task) {
    const result = this.#tail.then(() => task());
    // 无论成功失败都让队列继续，避免一次异常卡死后续请求。
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
