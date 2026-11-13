// All calls are same-origin (Vite proxies to 127.0.0.1:8000).  Nothing here
// ever receives or transmits a demo secret: signing happens on the backend.

async function requestJson(url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: { detail: `无法连接本地后端：${String(error)}`, code: "network_error" },
    };
  }
}

export function fetchMeta() {
  return requestJson("/api/meta");
}

export function fetchSamples() {
  return requestJson("/api/samples");
}

export function sign(payload) {
  return requestJson("/api/sign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function previewCanonical(payload) {
  return requestJson("/api/canonical", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchAudit({ limit = 50, decision = "" } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (decision) params.set("decision", decision);
  return requestJson(`/api/audit?${params.toString()}`);
}

export async function sendSignedRequest({ url, method, headers, body }) {
  const init = { method, headers: { ...headers } };
  if (body) {
    init.body = body;
    init.headers["Content-Type"] = "application/json";
  }
  try {
    const response = await fetch(url, init);
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }
    return { status: response.status, ok: response.ok, data };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      data: { detail: `本地请求发送失败：${String(error)}`, code: "network_error" },
    };
  }
}

export function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
