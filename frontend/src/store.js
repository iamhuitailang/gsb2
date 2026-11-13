import { computed, reactive } from "vue";
import * as api from "./api";

const state = reactive({
  loading: true,
  backendError: "",
  meta: null,
  samples: [],
  tab: "sign",
  form: {
    method: "POST",
    path: "/api/demo/echo",
    query: "source=console",
    timestamp: "",
    nonce: "",
    keyId: "",
    body: '{\n  "note": "local interface smoke test"\n}',
  },
  signResult: null,
  signError: "",
  sendResult: null,
  sending: false,
  lastRequest: null,
  audit: { events: [], stats: null },
  auditFilter: "",
  auditLoading: false,
  notice: "",
});

const activeKeyId = computed(() => state.meta?.active_key_id || "");

function resetNonce() {
  state.form.nonce = api.randomNonce();
}

function useServerTime() {
  state.form.timestamp = String(Math.floor(Date.now() / 1000));
}

function setNotice(text) {
  state.notice = text;
  if (text) {
    window.setTimeout(() => {
      if (state.notice === text) state.notice = "";
    }, 4000);
  }
}

async function loadMeta() {
  const res = await api.fetchMeta();
  if (!res.ok) {
    state.backendError = res.data?.detail || "无法读取本地后端配置";
    state.loading = false;
    return;
  }
  state.backendError = "";
  state.meta = res.data;
  if (!state.form.keyId) {
    state.form.keyId = res.data.active_key_id || "";
  }
  state.loading = false;
}

async function loadSamples() {
  const res = await api.fetchSamples();
  if (res.ok) state.samples = res.data.samples || [];
}

async function loadAudit() {
  state.auditLoading = true;
  const res = await api.fetchAudit({ limit: 50, decision: state.auditFilter });
  if (res.ok) {
    state.audit = { events: res.data.events || [], stats: res.data.stats || null };
  } else {
    state.backendError = res.data?.detail || "读取审计记录失败";
  }
  state.auditLoading = false;
}

function loadMoreAudit() {
  const events = state.audit.events || [];
  if (!events.length) return;
  const params = new URLSearchParams({ limit: "50" });
  params.set("before_id", String(events[events.length - 1].id));
  if (state.auditFilter) params.set("decision", state.auditFilter);
  fetch(`/api/audit?${params.toString()}`)
    .then((r) => r.json())
    .then((data) => {
      state.audit = {
        events: [...events, ...(data.events || [])],
        stats: data.stats || state.audit.stats,
      };
    })
    .catch(() => {});
}

function signPayload() {
  // fetch() cannot send a body with GET, so a typed body is only signed for
  // methods that actually carry one.  This keeps the signature aligned with
  // what is really sent.
  const body = state.form.method === "GET" ? "" : state.form.body || "";
  const payload = {
    method: state.form.method,
    path: state.form.path,
    query: state.form.query,
    key_id: state.form.keyId || undefined,
    nonce: state.form.nonce || undefined,
    body,
  };
  const ts = state.form.timestamp.trim();
  // Only forward a well-formed integer; otherwise let the backend default to
  // its own clock instead of signing with a silently converted value.
  if (/^\d+$/.test(ts)) payload.timestamp = Number(ts);
  return payload;
}

async function doSign() {
  state.signError = "";
  state.sendResult = null;
  state.lastRequest = null;
  if (!state.form.nonce) resetNonce();
  const res = await api.sign(signPayload());
  if (res.ok && res.data?.ok) {
    state.signResult = res.data;
  } else {
    state.signResult = null;
    state.signError = res.data?.detail || "生成签名失败";
  }
  return res;
}

function absoluteUrl() {
  // Build the request URL from the *raw* path and query (only the optional
  // leading "?" is dropped).  Trimming here would make the sent URL differ
  // from what was signed, since canonicalisation keeps spaces inside values.
  let path = state.form.path;
  if (!path.startsWith("/")) path = `/${path}`;
  const query = state.form.query.startsWith("?")
    ? state.form.query.slice(1)
    : state.form.query;
  return query ? `${path}?${query}` : path;
}

async function doSend() {
  state.sendResult = null;
  const signed = await doSign();
  if (!signed.ok || !signed.data?.ok) {
    state.sendResult = {
      status: 0,
      ok: false,
      data: { detail: state.signError || "签名未生成，未发送请求", code: "not_signed" },
    };
    return;
  }
  await sendWithHeaders(signed.data.headers, {
    url: absoluteUrl(),
    method: state.form.method,
    body: state.form.method === "GET" ? "" : state.form.body,
  });
}

async function sendWithHeaders(headers, target) {
  const request = target || {
    url: absoluteUrl(),
    method: state.form.method,
    body: state.form.method === "GET" ? "" : state.form.body,
  };
  state.sending = true;
  const res = await api.sendSignedRequest({ ...request, headers });
  // Keep the exact request (not just headers) so a replay goes to the same
  // URL/method even if the form was edited afterwards.
  state.lastRequest = { ...request, headers: { ...headers } };
  state.sendResult = res;
  state.sending = false;
  if (res.ok) {
    setNotice("本地演示接口已接受该请求（签名、时间窗口与 nonce 均通过）");
    // Rotate the nonce/timestamp for the next send so a second click is a
    // fresh request instead of an accidental replay.
    resetNonce();
    useServerTime();
  }
  await loadAudit();
}

// Re-send the exact previous request: repeats the nonce on purpose to show the
// replay rejection path.  This is a local demo only.
async function replayLast() {
  if (!state.lastRequest) return;
  await sendWithHeaders(state.lastRequest.headers, state.lastRequest);
  setNotice("已用同一 nonce 重发，预期被拒绝（nonce_replayed）");
}

function loadSample(sample) {
  state.form.method = sample.method;
  state.form.path = sample.path;
  state.form.query = sample.query;
  state.form.body = sample.body;
  state.form.timestamp = String(sample.signing?.timestamp || "");
  state.form.nonce = sample.signing?.nonce || api.randomNonce();
  state.form.keyId = sample.signing?.key_id || activeKeyId.value;
  state.signResult = sample.signing
    ? {
        ok: true,
        scheme: state.meta?.scheme,
        canonical_string: sample.signing.canonical_string || "",
        headers: sample.signing.headers,
        key_status: sample.signing.key_status,
      }
    : null;
  state.sendResult = null;
  state.lastRequest = null;
  state.tab = "sign";
}

async function sendSample(sample) {
  state.form.method = sample.method;
  state.form.path = sample.path;
  state.form.query = sample.query;
  state.form.body = sample.body;
  state.form.keyId = sample.signing.key_id;
  state.form.nonce = sample.signing.nonce;
  state.form.timestamp = String(sample.signing.timestamp);
  state.signResult = {
    ok: true,
    scheme: state.meta?.scheme,
    canonical_string: sample.signing.canonical_string || "",
    headers: sample.signing.headers,
    key_status: sample.signing.key_status,
  };
  const url = sample.query
    ? `${sample.path}?${sample.query}`
    : sample.path;
  await sendWithHeaders(sample.signing.headers, {
    url,
    method: sample.method,
    body: sample.method === "GET" ? "" : sample.body,
  });
  state.tab = "sign";
}

async function copy(text, label = "已复制") {
  try {
    await navigator.clipboard.writeText(text);
    setNotice(label);
  } catch {
    setNotice("浏览器拒绝了剪贴板访问，请手动选择复制");
  }
}

async function bootstrap() {
  state.loading = true;
  await loadMeta();
  if (!state.backendError) {
    resetNonce();
    useServerTime();
    await Promise.all([loadSamples(), loadAudit()]);
  }
  state.loading = false;
}

export const store = {
  state,
  activeKeyId,
  bootstrap,
  loadMeta,
  loadSamples,
  loadAudit,
  loadMoreAudit,
  doSign,
  doSend,
  replayLast,
  loadSample,
  sendSample,
  resetNonce,
  useServerTime,
  copy,
  absoluteUrl,
  setNotice,
};
