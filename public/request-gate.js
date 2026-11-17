// 与 DOM 无关的“按组织作用域读取 + 丢弃过期结果”工具。
// 浏览器页面和 Node 测试共用同一份实现，保证测的就是实际跑的代码。

/**
 * 每次 load 都带一个递增序号。只有「最后一次发起、且尚未被取代」的请求结果才会被返回为 ok/error，
 * 更早的请求即使后到，也返回 stale —— 调用方据此不渲染，避免旧标签/旧组织的慢结果覆盖新页面。
 *
 * @param {{
 *   buildUrl: (input: {orgId: string}) => string,
 *   isExpectedOrg?: (body: any, orgId: string) => boolean,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createScopedReader({ buildUrl, isExpectedOrg, fetchImpl } = {}) {
  if (typeof buildUrl !== 'function') throw new TypeError('buildUrl 必填');
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));
  const checkOrg = isExpectedOrg || ((body, orgId) => body?.org?.id === orgId);
  let sequence = 0;

  async function load(input) {
    if (!input || typeof input.orgId !== 'string' || !input.orgId) {
      throw new TypeError('load 需要 orgId');
    }
    const ticket = ++sequence;
    const url = buildUrl(input);
    let response;
    let body = null;
    try {
      response = await doFetch(url, {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      if (ticket !== sequence) return { outcome: 'stale', request: input };
      return { outcome: 'network-error', request: input, error };
    }

    if (ticket !== sequence) return { outcome: 'stale', request: input };

    if (!response.ok) {
      return { outcome: 'error', request: input, status: response.status, body };
    }
    // 防御：即使序号检查被绕过，也拒绝把「甲组织的响应」渲染进「乙组织的页面」。
    // 只在成功响应上比对组织；错误响应体里没有 org 字段。
    if (!checkOrg(body, input.orgId)) {
      return { outcome: 'mismatch', request: input, status: response.status, body };
    }
    return { outcome: 'ok', request: input, status: response.status, body };
  }

  return {
    load,
    /** 主动作废所有在途请求（例如组件卸载时）。 */
    reset() {
      sequence += 1;
    },
    get sequence() {
      return sequence;
    },
  };
}

/** 判断响应体是否属于请求的组织；缺省实现兜底用。 */
export function belongsToOrg(body, orgId) {
  return body?.org?.id === orgId;
}
