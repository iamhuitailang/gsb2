<script setup>
import { onMounted } from "vue";
import { store } from "./store";
import { describeCanonical, formatTime, visibleWhitespace } from "./format";

const { state } = store;

const REASON_TEXT = {
  accepted: "通过",
  missing_signature: "缺少签名头",
  malformed_request: "规范化失败",
  unknown_key_id: "未知密钥",
  retired_key: "密钥已退役",
  key_not_usable: "密钥不可用",
  timestamp_expired: "时间戳过期",
  timestamp_in_future: "时间戳超前",
  malformed_signature: "签名格式错误",
  signature_mismatch: "签名不匹配",
  nonce_replayed: "nonce 重放",
  body_too_large: "请求体过大",
};

function reasonText(code) {
  return REASON_TEXT[code] || state.meta?.reason_text?.[code] || code || "-";
}

function statusClass(status) {
  return {
    active: "badge ok",
    grace: "badge warn",
    retired: "badge bad",
  }[status] || "badge";
}

function statusText(status) {
  return { active: "活动", grace: "宽限期", retired: "已退役" }[status] || status;
}

function headerClass(name) {
  if (isSensitiveHeader(name)) return "badge warn";
  return "badge";
}

function isSensitiveHeader(name) {
  return /signature/i.test(name);
}

function openAudit() {
  state.tab = "audit";
  store.loadAudit();
}

onMounted(() => {
  store.bootstrap();
});
</script>
<template>
  <header>
    <h1>本地接口签名校验台</h1>
    <p class="subtitle">
      纯本地联调工具：Vue 3 + FastAPI + SQLite。只访问 127.0.0.1，不调用任何真实业务服务。
    </p>
  </header>

  <div v-if="state.notice" class="notice">{{ state.notice }}</div>

  <div v-if="state.backendError" class="panel">
    <h2>后端未就绪</h2>
    <p class="muted">{{ state.backendError }}</p>
    <pre class="code wrap">cd backend
python3 -m venv .venv &amp;&amp; source .venv/bin/activate
pip install -r requirements.txt
python -m app.keytool init
uvicorn app.main:app --reload --port 8000</pre>
  </div>

  <template v-else>
    <section class="panel" v-if="state.meta">
      <div class="panel-head">
        <h2>本地密钥状态</h2>
        <span class="badge" :class="state.meta.active_key_id ? 'ok' : 'bad'">
          活动密钥：{{ state.meta.active_key_id || "无" }}
        </span>
      </div>
      <p class="muted" style="margin-bottom: 10px">
        密钥原文只保存在本机 <code>backend/config.local.json</code> 中。本页面、接口响应与日志都不包含密钥原文。
        签名由本地后端生成，浏览器只拿到 key_id 与签名结果。
      </p>
      <div class="rotation-list">
        <div class="rotation-item" v-for="key in state.meta.keys" :key="key.key_id">
          <span class="mono">{{ key.key_id }}</span>
          <span :class="statusClass(key.status)">{{ statusText(key.status) }}</span>
          <span class="muted" v-if="key.grace_until">宽限至 {{ formatTime(key.grace_until) }}</span>
          <span class="muted" v-if="key.status === 'active'">用于生成与验签</span>
          <span class="muted" v-if="key.status === 'grace'">仅用于验签，到期后自动拒绝</span>
          <span class="muted" v-if="key.status === 'retired'">已拒绝所有请求</span>
        </div>
      </div>
      <p class="muted" style="margin-top: 10px">
        时间窗口：{{ state.meta.time_window_seconds }} 秒 ·
        允许超前：{{ state.meta.future_skew_seconds }} 秒 ·
        nonce 保留：{{ state.meta.nonce_retention_seconds }} 秒 ·
        协议：{{ state.meta.scheme }}
      </p>
    </section>

    <nav class="tabs">
      <button :class="{ active: state.tab === 'sign' }" @click="state.tab = 'sign'">签名与请求</button>
      <button :class="{ active: state.tab === 'samples' }" @click="state.tab = 'samples'">请求样例</button>
      <button :class="{ active: state.tab === 'audit' }" @click="openAudit()">
        审计记录
      </button>
      <button :class="{ active: state.tab === 'rules' }" @click="state.tab = 'rules'">签名规则</button>
    </nav>

    <!-- ---------------------------------------------------------------- -->
    <!-- Sign tab                                                          -->
    <!-- ---------------------------------------------------------------- -->
    <template v-if="state.tab === 'sign'">
      <section class="panel">
        <div class="panel-head">
          <h2>请求内容</h2>
          <span class="muted">规范化后即为签名输入，空请求体也参与计算</span>
        </div>

        <div class="grid">
          <div>
            <div class="field">
              <label for="method">请求方法</label>
              <select id="method" v-model="state.form.method">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </div>
            <div class="field">
              <label for="path">路径（只填 URL path，不含 ?）</label>
              <input id="path" v-model="state.form.path" spellcheck="false" />
            </div>
            <div class="field">
              <label for="query">查询串（可乱序、可重复参数，后端会规范化）</label>
              <input id="query" v-model="state.form.query" spellcheck="false" />
            </div>
          </div>
          <div>
            <div class="field">
              <label for="key">密钥 ID</label>
              <select id="key" v-model="state.form.keyId">
                <option v-for="key in state.meta?.keys || []" :key="key.key_id" :value="key.key_id">
                  {{ key.key_id }}（{{ statusText(key.status) }}）
                </option>
              </select>
            </div>
            <div class="field">
              <label for="timestamp">时间戳（Unix 秒）</label>
              <div class="row">
                <input id="timestamp" v-model="state.form.timestamp" spellcheck="false" />
                <button class="ghost small" @click="store.useServerTime()">用当前时间</button>
              </div>
            </div>
            <div class="field">
              <label for="nonce">nonce（8-64 个可见字符，每次请求唯一）</label>
              <div class="row">
                <input id="nonce" v-model="state.form.nonce" spellcheck="false" />
                <button class="ghost small" @click="store.resetNonce()">换一个新的</button>
              </div>
            </div>
          </div>
        </div>

        <div class="field">
          <label for="body">请求体（原样按 UTF-8 计算 SHA-256；GET 会忽略此处内容）</label>
          <textarea id="body" v-model="state.form.body" spellcheck="false"></textarea>
        </div>

        <div class="row">
          <button @click="store.doSign()">生成签名（不发送）</button>
          <button class="secondary" :disabled="state.sending" @click="store.doSend()">
            {{ state.sending ? "发送中…" : "生成签名并发送到本地演示接口" }}
          </button>
          <button class="ghost" v-if="state.lastRequest" @click="store.replayLast()">
            用同一 nonce 重发（验证重放拒绝）
          </button>
        </div>

        <p v-if="state.signError" class="result bad" style="margin-top: 12px">
          {{ state.signError }}
        </p>
      </section>

      <section class="panel" v-if="state.signResult">
        <div class="panel-head">
          <h2>签名结果</h2>
          <span class="badge ok">{{ state.signResult.key_status }} · {{ state.signResult.scheme }}</span>
        </div>

        <h3>规范化请求（签名输入）</h3>
        <table>
          <thead>
            <tr><th>行</th><th>字段</th><th>值</th></tr>
          </thead>
          <tbody>
            <tr v-for="field in describeCanonical(state.signResult.canonical_string)" :key="field.index">
              <td class="muted">{{ field.index + 1 }}</td>
              <td>{{ field.label }}</td>
              <td class="mono" style="word-break: break-all">
                <span v-if="field.value">{{ visibleWhitespace(field.value) }}</span>
                <span v-else class="muted">（空）</span>
              </td>
            </tr>
          </tbody>
        </table>
        <details>
          <summary>查看原始文本（含换行）</summary>
          <pre class="code wrap" style="margin-top: 6px">{{ state.signResult.canonical_string }}</pre>
        </details>

        <h3 style="margin-top: 14px">请求头</h3>
        <table>
          <thead>
            <tr><th>名称</th><th>值</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(value, name) in state.signResult.headers" :key="name">
              <td class="mono">{{ name }}</td>
              <td class="mono" style="word-break: break-all">{{ value }}</td>
              <td style="white-space: nowrap">
                <span :class="headerClass(name)">{{ isSensitiveHeader(name) ? "敏感" : "可复制" }}</span>
                <button class="ghost small" @click="store.copy(value, name + ' 已复制')">复制</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="muted" style="margin-top: 10px">
          签名值属于敏感材料：审计记录里只保存遮蔽后的片段，服务端日志也不会输出完整签名。
        </p>
      </section>

      <section class="panel" v-if="state.sendResult">
        <div class="panel-head">
          <h2>本地演示接口响应</h2>
          <span class="badge" :class="state.sendResult.ok ? 'ok' : 'bad'">
            HTTP {{ state.sendResult.status }}
          </span>
        </div>
        <div class="result" :class="state.sendResult.ok ? 'ok' : 'bad'">
          <template v-if="state.sendResult.ok">
            已通过验签。审计编号 #{{ state.sendResult.data.audit_id }}。
            <span class="muted">表单中的 nonce 与时间戳已自动更新，下一次发送是一条新请求。</span>
          </template>
          <template v-else>
            被拒绝：{{ reasonText(state.sendResult.data?.code) }} —
            {{ state.sendResult.data?.detail || "无详情" }}
            <span v-if="state.sendResult.data?.audit_id">（审计编号 #{{ state.sendResult.data.audit_id }}）</span>
          </template>
        </div>
        <details>
          <summary>原始响应 JSON</summary>
          <pre class="code wrap" style="margin-top: 6px">{{ JSON.stringify(state.sendResult.data, null, 2) }}</pre>
        </details>
      </section>
    </template>

    <!-- ---------------------------------------------------------------- -->
    <!-- Samples tab                                                       -->
    <!-- ---------------------------------------------------------------- -->
    <template v-if="state.tab === 'samples'">
      <section class="panel">
        <div class="panel-head">
          <h2>正常本地请求样例</h2>
          <div class="row">
            <button class="ghost small" @click="store.loadSamples()">重新生成（刷新时间戳与 nonce）</button>
          </div>
        </div>
        <p class="muted">
          每个样例都带一份由本地后端实时生成的签名。可以直接发送到本地演示接口，也可以复制 curl 命令自行联调。
        </p>

        <div class="samples" style="margin-top: 12px">
          <div class="sample" v-for="sample in state.samples" :key="sample.id">
            <div class="sample-head">
              <div>
                <h3>{{ sample.title }}</h3>
                <p class="desc">{{ sample.description }}</p>
              </div>
              <span class="badge mono">{{ sample.method }} {{ sample.path }}</span>
            </div>
            <dl class="kv">
              <dt>query</dt>
              <dd>{{ sample.query || "（空）" }}</dd>
              <dt>key_id</dt>
              <dd>{{ sample.signing.key_id }}（{{ sample.signing.key_status }}）</dd>
              <dt>timestamp</dt>
              <dd>{{ sample.signing.timestamp }}</dd>
              <dt>nonce</dt>
              <dd>{{ sample.signing.nonce }}</dd>
              <dt>signature</dt>
              <dd class="signature">{{ sample.signing.signature }}</dd>
            </dl>
            <div class="row" style="margin-top: 10px">
              <button class="small" @click="store.sendSample(sample)">直接发送</button>
              <button class="ghost small" @click="store.loadSample(sample)">载入到签名表单</button>
              <button class="ghost small" @click="store.copy(sample.signing.canonical_string, '规范化串已复制')">
                复制规范化串
              </button>
            </div>
            <details>
              <summary>规范化请求文本</summary>
              <pre class="code wrap" style="margin-top: 6px">{{ sample.signing.canonical_string }}</pre>
            </details>
            <details>
              <summary>curl 复现</summary>
              <pre class="code wrap" style="margin-top: 6px">{{ sample.curl }}</pre>
            </details>
          </div>
        </div>
      </section>
    </template>

    <!-- ---------------------------------------------------------------- -->
    <!-- Audit tab                                                         -->
    <!-- ---------------------------------------------------------------- -->
    <template v-if="state.tab === 'audit'">
      <section class="panel" v-if="state.audit.stats">
        <div class="panel-head">
          <h2>审计概览</h2>
          <div class="audit-actions">
            <select v-model="state.auditFilter" @change="store.loadAudit()">
              <option value="">全部</option>
              <option value="accepted">仅通过</option>
              <option value="rejected">仅拒绝</option>
            </select>
            <button class="ghost small" :disabled="state.auditLoading" @click="store.loadAudit()">刷新</button>
          </div>
        </div>
        <div class="grid-3">
          <div class="stat">
            <div class="value">{{ state.audit.stats.total }}</div>
            <div class="label">累计事件</div>
          </div>
          <div class="stat">
            <div class="value">{{ state.audit.stats.accepted }}</div>
            <div class="label">通过</div>
          </div>
          <div class="stat">
            <div class="value">{{ state.audit.stats.rejected }}</div>
            <div class="label">拒绝</div>
          </div>
        </div>
        <p class="muted" style="margin-top: 10px">
          最近事件时间：{{ formatTime(state.audit.stats.last_event_at) }}。
          拒绝原因分布：
          <span v-for="reason in state.audit.stats.reject_reasons" :key="reason.reason_code" class="badge" style="margin-right: 6px">
            {{ reasonText(reason.reason_code) }} × {{ reason.count }}
          </span>
          <span v-if="!state.audit.stats.reject_reasons.length" class="muted">暂无拒绝记录</span>
        </p>
        <p class="muted">
          日志承诺：不保存请求体原文、不保存完整签名；nonce 只保存掩码与哈希；拒绝原因按固定枚举落库。
        </p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>事件列表</h2>
          <span class="muted">{{ state.audit.events.length }} 条</span>
        </div>
        <div v-if="!state.audit.events.length" class="muted">暂无记录。先在“签名与请求”页发送一条请求。</div>
        <table v-else>
          <thead>
            <tr>
              <th>#</th>
              <th>时间</th>
              <th>结果</th>
              <th>原因</th>
              <th>方法 / 路径</th>
              <th>密钥</th>
              <th>nonce（掩码）</th>
              <th>签名（掩码）</th>
              <th>body SHA-256</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in state.audit.events" :key="event.id">
              <td class="muted mono">{{ event.id }}</td>
              <td class="mono" style="white-space: nowrap">{{ formatTime(event.created_at) }}</td>
              <td>
                <span class="badge" :class="event.decision === 'accepted' ? 'ok' : 'bad'">
                  {{ event.decision === "accepted" ? "通过" : "拒绝" }}
                </span>
              </td>
              <td>{{ reasonText(event.reason_code) }}</td>
              <td class="mono">{{ event.method }} {{ event.path }}<template v-if="event.query">?{{ event.query }}</template></td>
              <td class="mono">{{ event.key_id || "-" }}<span v-if="event.key_status" class="muted"> ({{ event.key_status }})</span></td>
              <td class="mono">{{ event.nonce_masked }}</td>
              <td class="mono">{{ event.signature_masked }}</td>
              <td class="mono" style="word-break: break-all">{{ event.body_sha256.slice(0, 16) }}…</td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="margin-top: 12px" v-if="state.audit.events.length">
          <button class="ghost small" @click="store.loadMoreAudit()">加载更多</button>
          <a class="muted" href="/api/audit/export?limit=200" download="audit-export.json">导出 JSON</a>
        </div>
      </section>
    </template>

    <!-- ---------------------------------------------------------------- -->
    <!-- Rules tab                                                         -->
    <!-- ---------------------------------------------------------------- -->
    <template v-if="state.tab === 'rules'">
      <section class="panel">
        <h2>签名规则（HMAC-SHA256-V1）</h2>
        <p>
          签名对象不是原始请求，而是一个确定性的<strong>规范化请求串</strong>。服务端与客户端都必须先规范化再计算 HMAC-SHA256。
        </p>
        <pre class="code">HMAC-SHA256-V1
METHOD:&lt;大写方法&gt;
PATH:&lt;百分号编码的路径&gt;
QUERY:&lt;按编码字节排序后的 a=b&amp;c=d&gt;
TIMESTAMP:&lt;Unix 秒&gt;
NONCE:&lt;唯一值&gt;
KEY-ID:&lt;密钥 ID&gt;
BODY-SHA256:&lt;请求体字节的 SHA-256 小写十六进制&gt;</pre>
        <ul>
          <li>共 8 行，使用 <code>\n</code> 连接，末尾不加换行；任何一行都不含裸换行。</li>
          <li>方法统一转为大写，首尾空白会被裁剪，内部空白直接拒绝。</li>
          <li>路径只接受 URL path：不含 <code>?</code>、<code>#</code>、完整域名；<code>%2F</code>、空路径段与末尾 <code>/</code>（根路径除外）都会被拒绝，避免同一路径有两种写法。服务端用线上原始路径参与规范化。</li>
          <li>查询串只按 <code>&amp;</code> 拆分；参数名和值重新百分号编码后按字节排序；完全空的参数段被丢弃，重复参数保留全部值，<code>+</code> 与 <code>%20</code> 视为同一空格。值里的 <code>&amp;</code>、<code>;</code>、<code>=</code> 需写成百分号编码，裸 <code>;</code> 会被拒绝。</li>
          <li><strong>请求体从不重排或重编码</strong>：即使内容是 JSON，也按发送的原始 UTF-8 字节哈希，字段顺序和空格都影响签名。</li>
          <li>空请求体同样计算哈希，SHA-256 为空为 <code>e3b0c442…b855</code>，不允许“没有 body 就不签”。</li>
          <li>签名必须是小写（或大写）64 位十六进制；比较使用常量时间比较。</li>
        </ul>
      </section>

      <section class="panel">
        <h2>校验顺序与拒绝原因</h2>
        <ol>
          <li>缺少签名头 → <code>missing_signature</code></li>
          <li>规范化失败 → <code>malformed_request</code>（400）</li>
          <li>密钥不存在 → <code>unknown_key_id</code></li>
          <li>密钥已退役 → <code>retired_key</code>（先于 HMAC 计算，旧密钥不会占用算力）</li>
          <li><code>now - timestamp &gt; {{ state.meta?.time_window_seconds }}</code> → <code>timestamp_expired</code></li>
          <li><code>timestamp - now &gt; {{ state.meta?.future_skew_seconds }}</code> → <code>timestamp_in_future</code></li>
          <li>签名格式非法 → <code>malformed_signature</code>（400）；HMAC 不一致 → <code>signature_mismatch</code></li>
          <li>签名有效但 nonce 已用过 → <code>nonce_replayed</code>（409）</li>
        </ol>
        <p class="muted">
          只有签名通过后才写入 nonce 表，未通过验签的请求无法消耗他人 nonce。nonce 全局唯一（跨密钥也不允许复用），保留时长不小于时间窗口，清理是惰性的。
        </p>
      </section>

      <section class="panel">
        <h2>密钥轮换与遮蔽</h2>
        <ul>
          <li>配置中必须恰好有一个 <code>active</code> 密钥；轮换由本地 CLI 原子写入配置文件。</li>
          <li>轮换后旧密钥进入 <code>grace</code>，在 <code>grace_until</code> 之前新旧密钥并行验签。</li>
          <li>过了 <code>grace_until</code> 自动按 <code>retired</code> 处理，无需重启服务也会立即拒绝旧密钥。</li>
          <li>审计只记录 key_id、状态、nonce 掩码与哈希、签名掩码、body 哈希；日志只记录 request_id、拒绝原因和路径。</li>
          <li>密钥原文只存在于本机 <code>backend/config.local.json</code>（建议 <code>chmod 600</code>），不会出现在页面、API 响应或日志中。</li>
        </ul>
      </section>
    </template>
  </template>

  <footer>
    本地联调工具 · 数据仅写入本机 SQLite · 页面与日志均不显示密钥原文
  </footer>
</template>
