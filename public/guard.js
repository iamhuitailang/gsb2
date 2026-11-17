// 一个“代数闸门”：每次发起新请求都会推进代号。旧请求可以照常返回，
// 但结果到达时因代号过期被判为 stale，调用方必须丢弃。
// 另提供 cancel()：真的中止在途请求（离开页面、登录失效等场景）。
// 纯逻辑、无 DOM 依赖，浏览器和 Node 测试都能直接 import。
export class LatestRequestGate {
  #generation = 0;
  #controllers = new Set();

  /** 开始新一轮请求：返回本轮代号与专属中止信号。 */
  begin() {
    // 注意：这里刻意不中止上一轮，这样才能让“晚到的旧结果”真的到达并被丢弃。
    const controller = new AbortController();
    this.#controllers.add(controller);
    return { generation: ++this.#generation, signal: controller.signal, controller };
  }

  isCurrent(generation) {
    return generation === this.#generation;
  }

  /** 作废在途请求：不中止网络，只让结果在到达时被判为过期。 */
  invalidate() {
    this.#generation += 1;
  }

  /** 硬作废：中止所有在途请求并推进代号。 */
  cancel() {
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#generation += 1;
  }

  /**
   * 执行一次异步请求。只有仍是“最新一轮”时才返回 ok；
   * 被硬中止返回 aborted；晚到的旧结果返回 stale，调用方必须忽略。
   */
  async run(task, { onStale } = {}) {
    const { generation, signal, controller } = this.begin();
    try {
      const value = await task({ signal, generation });
      if (!this.isCurrent(generation)) {
        onStale?.(value);
        return { status: 'stale' };
      }
      return { status: 'ok', value };
    } catch (error) {
      if (error?.name === 'AbortError') return { status: 'aborted' };
      if (!this.isCurrent(generation)) return { status: 'stale' };
      throw error;
    } finally {
      this.#controllers.delete(controller);
    }
  }
}
