/* 本地安全策略管理台 — 前端（Vue 3 全局构建，无外部资源） */

if (!window.Vue) {
  // index.html 已经给出提示；这里避免二次 ReferenceError。
  console.error("Vue 运行时缺失：请先执行 npm install 生成 web/vendor/vue.global.prod.js");
} else {
  boot();
}

function boot() {
const { createApp, ref, computed, onMounted, watch } = Vue;

const SEVERITY_LABELS = { error: "错误", warning: "警告" };

function shortDigest(value) {
  return value ? value.slice(0, 12) : "—";
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

const OUTCOME_LABELS = { applied: "已生效", rejected: "已拒绝" };
const ACTION_LABELS = {
  apply: "导入应用",
  restore: "版本恢复",
  preview: "预览",
};

const app = createApp({
  setup() {
    const tab = ref("workspace");
    const state = ref(null);
    const history = ref({ versions: [], audit: [] });
    const samples = ref([]);
    const sampleMeta = ref(null);

    const editorText = ref("");
    const sourceNote = ref("");
    const localParseError = ref("");
    const editorRules = ref([]);
    const editorPackage = ref(null);

    const busy = ref("");
    const notice = ref(null);
    const preview = ref(null);
    const previewSnapshot = ref("");
    const previewFailure = ref(null);
    const applyResult = ref(null);
    const showNormalized = ref(false);

    const restorePreview = ref(null);
    const restoreNote = ref("");
    const restoreFailure = ref(null);
    const restoreResult = ref(null);
    const expandedAudit = ref(null);

    const activeVersionLabel = computed(() => {
      if (!state.value || !state.value.active_version) return "尚未激活任何策略";
      const v = state.value.active_version;
      return `v${v.version_no} · ${v.package_name}`;
    });

    const previewStale = computed(
      () => preview.value !== null && editorText.value !== previewSnapshot.value
    );

    const canApply = computed(
      () =>
        !!preview.value &&
        !previewStale.value &&
        !busy.value &&
        (preview.value.summary.error_count || 0) === 0
    );

    async function callApi(url, options = {}) {
      const response = await fetch(url, options);
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok) {
        const error = new Error(
          (payload && payload.message) || `请求失败（HTTP ${response.status}）`
        );
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    function showNotice(type, text) {
      notice.value = { type, text };
      window.clearTimeout(showNotice.timer);
      showNotice.timer = window.setTimeout(() => {
        notice.value = null;
      }, 6000);
    }

    function handleError(error, fallback) {
      const payload = error.payload || {};
      const message = payload.message || error.message || fallback;
      showNotice("error", message);
      return payload;
    }

    async function loadState() {
      try {
        state.value = await callApi("/api/state");
      } catch (error) {
        handleError(error, "读取当前状态失败");
      }
    }

    async function loadHistory() {
      try {
        history.value = await callApi("/api/history?limit=200");
      } catch (error) {
        handleError(error, "读取历史失败");
      }
    }

    async function loadSamples() {
      try {
        const payload = await callApi("/api/samples");
        samples.value = payload.samples;
        // 首次进入且还没有预览时，用基线样例填充编辑器，页面开箱即用。
        if (!editorText.value.trim() && payload.samples.length) {
          const baseline = payload.samples.find((item) => item.kind === "valid");
          if (baseline) {
            const detail = await callApi(
              `/api/samples/${encodeURIComponent(baseline.filename)}`
            );
            editorText.value = detail.text;
            sampleMeta.value = detail;
          }
        }
      } catch (error) {
        handleError(error, "读取样例失败");
      }
    }

    function refreshAll() {
      loadState();
      loadHistory();
    }

    function parseEditorLocally() {
      localParseError.value = "";
      editorRules.value = [];
      editorPackage.value = null;
      if (!editorText.value.trim()) return;
      try {
        const document = JSON.parse(editorText.value);
        editorPackage.value = document.package || null;
        if (Array.isArray(document.rules)) {
          editorRules.value = document.rules.map((rule, index) => ({
            index,
            id: rule && rule.id,
            name: rule && rule.name,
            priority: rule && rule.priority,
            action: rule && rule.action,
            direction: rule && rule.direction,
            protocols: rule && rule.protocols,
            ports: rule && rule.destination_ports,
            enabled: rule && rule.enabled !== false,
          }));
        }
      } catch (error) {
        localParseError.value = `本地解析提示：${error.message}（最终以服务端校验为准）`;
      }
    }

    watch(editorText, parseEditorLocally);

    function useActiveDocument() {
      if (!state.value || !state.value.document) {
        showNotice("info", "当前还没有生效版本，请先导入基线样例。");
        return;
      }
      editorText.value = pretty(state.value.document) + "\n";
      sampleMeta.value = null;
      applyResult.value = null;
      preview.value = null;
      previewFailure.value = null;
      showNotice("info", "已把当前生效版本载入编辑器；修改后请先预览。");
    }

    function clearEditor() {
      editorText.value = "";
      sourceNote.value = "";
      preview.value = null;
      previewFailure.value = null;
      applyResult.value = null;
      sampleMeta.value = null;
    }

    function formatLocally() {
      try {
        editorText.value = pretty(JSON.parse(editorText.value)) + "\n";
        showNotice("info", "已本地格式化；重复字段等结构问题仍由服务端判定。");
      } catch (error) {
        localParseError.value = `本地解析提示：${error.message}`;
      }
    }

    async function loadSampleIntoEditor(sample) {
      try {
        const payload = await callApi(`/api/samples/${encodeURIComponent(sample.filename)}`);
        editorText.value = payload.text;
        sampleMeta.value = payload;
        preview.value = null;
        previewFailure.value = null;
        applyResult.value = null;
        tab.value = "workspace";
        showNotice("info", `已载入样例「${payload.title}」，可先预览再决定是否应用。`);
      } catch (error) {
        handleError(error, "载入样例失败");
      }
    }

    async function previewSample(sample) {
      await loadSampleIntoEditor(sample);
      await runPreview();
    }

    async function runPreview() {
      if (!editorText.value.trim()) {
        showNotice("error", "编辑器内容为空，无法预览。");
        return;
      }
      busy.value = "preview";
      previewFailure.value = null;
      applyResult.value = null;
      restorePreview.value = null;
      try {
        const payload = await callApi("/api/import/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_text: editorText.value,
            source_note: sourceNote.value,
            base_generation: state.value ? state.value.generation : null,
          }),
        });
        preview.value = payload;
        previewSnapshot.value = editorText.value;
        if (payload.issues && payload.issues.some((item) => item.severity === "error")) {
          showNotice("error", "预览发现错误，未应用任何变更。");
        } else if (payload.issues && payload.issues.length) {
          showNotice("warn", "预览通过，但有警告；正式应用前请确认。");
        } else {
          showNotice("ok", "预览通过：尚未生效，确认后才会替换当前版本。");
        }
      } catch (error) {
        const payload = handleError(error, "预览失败");
        preview.value = null;
        previewFailure.value = {
          status: error.status,
          stage: "preview",
          code: payload.code,
          message: payload.message,
          details: payload.details,
          issues: payload.issues || [],
        };
      } finally {
        busy.value = "";
      }
    }

    async function applyPreview() {
      if (!preview.value) return;
      if (previewStale.value) {
        showNotice("error", "编辑器内容在预览后已修改，请重新预览。");
        return;
      }
      if (sourceNote.value.trim().length < 2) {
        showNotice("error", "正式应用前请填写来源说明（至少 2 个字符）。");
        return;
      }
      const packageName =
        (preview.value.summary && preview.value.summary.package_name) || "该策略包";
      const confirmed = window.confirm(
        `确认把「${packageName}」整包应用为新的生效版本？\n\n` +
          "这将原子替换当前生效规则；若写入失败，现有版本保持不变。"
      );
      if (!confirmed) return;

      busy.value = "apply";
      try {
        const payload = await callApi("/api/import/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document_text: editorText.value,
            source_note: sourceNote.value,
            base_generation: preview.value.base_generation,
            confirm_digest: preview.value.digest,
          }),
        });
        applyResult.value = payload;
        preview.value = null;
        previewFailure.value = null;
        showNotice(
          "ok",
          `已原子应用：版本 v${payload.version.version_no}（generation ${payload.generation}）。`
        );
        refreshAll();
      } catch (error) {
        const payload = handleError(error, "正式应用失败，当前生效版本未改变");
        // 应用失败后旧预览的 generation 已不可靠，清掉它，避免误点。
        preview.value = null;
        if (payload.code === "stale_generation") {
          showNotice(
            "error",
            "检测到并发修改：当前生效版本未被改写，请刷新状态后重新预览。"
          );
        }
        previewFailure.value = {
          status: error.status,
          stage: "apply",
          code: payload.code,
          message: payload.message,
          details: payload.details,
          issues: payload.issues || [],
        };
        refreshAll();
      } finally {
        busy.value = "";
      }
    }

    function dismissPreview() {
      preview.value = null;
      previewFailure.value = null;
      applyResult.value = null;
    }

    async function openRestorePreview(version) {
      restoreResult.value = null;
      restoreFailure.value = null;
      restorePreview.value = null;
      restoreNote.value = "";
      try {
        const previewPayload = await callApi(
          `/api/versions/${version.id}/restore-preview`
        );
        restorePreview.value = previewPayload;
        restoreNote.value = `恢复自 v${version.version_no}`;
      } catch (error) {
        const payload = handleError(error, "读取恢复预览失败");
        restoreFailure.value = {
          code: payload.code,
          message: payload.message,
          issues: payload.issues || [],
        };
      }
    }

    async function confirmRestore() {
      if (!restorePreview.value) return;
      if (restoreNote.value.trim().length < 2) {
        showNotice("error", "恢复操作同样需要来源说明（至少 2 个字符）。");
        return;
      }
      const version = restorePreview.value.version;
      const confirmed = window.confirm(
        `确认恢复版本 v${version.version_no}？\n\n` +
          "恢复会生成一个新的版本记录，并把激活指针原子切回该内容。"
      );
      if (!confirmed) return;
      busy.value = "restore";
      try {
        const payload = await callApi(`/api/versions/${version.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_note: restoreNote.value,
            base_generation: restorePreview.value.base_generation,
            confirm_digest: restorePreview.value.digest,
          }),
        });
        restoreResult.value = payload;
        restoreFailure.value = null;
        showNotice(
          "ok",
          `已恢复为版本 v${payload.version.version_no}（新记录 generation ${payload.generation}）。`
        );
        refreshAll();
        tab.value = "history";
        restorePreview.value = null;
      } catch (error) {
        const payload = handleError(error, "恢复失败，当前生效版本未改变");
        restoreFailure.value = {
          code: payload.code,
          message: payload.message,
          issues: payload.issues || [],
          details: payload.details,
        };
        refreshAll();
      } finally {
        busy.value = "";
      }
    }

    function toggleAudit(id) {
      expandedAudit.value = expandedAudit.value === id ? null : id;
    }

    function diffFieldLabel(field) {
      const labels = {
        default_action: "默认动作",
        schema_version: "策略版本",
        enabled: "是否启用",
        priority: "优先级",
        action: "动作",
        direction: "方向",
        protocols: "协议",
        source_cidrs: "源地址",
        destination_cidrs: "目标地址",
        destination_ports: "目标端口",
        name: "名称",
        description: "描述",
        id: "标识",
        revision: "修订号",
      };
      return labels[field] || field;
    }

    function describeValue(value) {
      if (value === null || value === undefined) return "（无）";
      if (Array.isArray(value)) {
        if (!value.length) return "（空列表）";
        return value.map((item) => String(item)).join(", ");
      }
      return String(value);
    }

    function usingLocalFile(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) {
        showNotice("error", "文件超过 2 MiB，请先精简后再导入。");
        event.target.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        editorText.value = String(reader.result || "");
        sampleMeta.value = {
          title: file.name,
          kind: "valid",
          expectation: "本地文件已载入，仍需服务端校验后才可应用",
        };
        preview.value = null;
        previewFailure.value = null;
        applyResult.value = null;
        showNotice("info", `已载入本地文件 ${file.name}，请先预览差异。`);
      };
      reader.onerror = () => showNotice("error", "读取本地文件失败。");
      reader.readAsText(file, "utf-8");
      event.target.value = "";
    }

    onMounted(() => {
      refreshAll();
      loadSamples();
      parseEditorLocally();
    });

    return {
      tab,
      state,
      history,
      samples,
      sampleMeta,
      editorText,
      sourceNote,
      localParseError,
      editorRules,
      editorPackage,
      busy,
      notice,
      preview,
      previewStale,
      previewFailure,
      applyResult,
      showNormalized,
      restorePreview,
      restoreNote,
      restoreFailure,
      restoreResult,
      expandedAudit,
      activeVersionLabel,
      canApply,
      SEVERITY_LABELS,
      OUTCOME_LABELS,
      ACTION_LABELS,
      shortDigest,
      pretty,
      formatTime,
      loadState,
      loadHistory,
      loadSamples,
      refreshAll,
      useActiveDocument,
      usingLocalFile,
      clearEditor,
      formatLocally,
      loadSampleIntoEditor,
      previewSample,
      runPreview,
      applyPreview,
      dismissPreview,
      openRestorePreview,
      confirmRestore,
      toggleAudit,
      diffFieldLabel,
      describeValue,
    };
  },
  template: `
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">SP</div>
        <div>
          <h1>本地安全策略管理台</h1>
          <p>仅本机运行 · 服务端强制校验 · 整包原子切换</p>
        </div>
      </div>
      <div class="active-chip">
        <span class="dot" :class="{ live: state && state.active_version }"></span>
        <div>
          <strong>{{ activeVersionLabel }}</strong>
          <small v-if="state && state.active_version">
            generation {{ state.generation }} · {{ state.rule_count }} 条规则 · {{ formatTime(state.updated_at) }}
          </small>
          <small v-else>导入基线样例后开始</small>
        </div>
      </div>
    </header>

    <nav class="tabs">
      <button :class="{ active: tab === 'workspace' }" @click="tab = 'workspace'">工作台</button>
      <button :class="{ active: tab === 'history' }" @click="tab = 'history'; loadHistory()">
        历史与恢复
        <span class="count" v-if="history.versions.length">{{ history.versions.length }}</span>
      </button>
      <button :class="{ active: tab === 'samples' }" @click="tab = 'samples'">样例库</button>
      <div class="spacer"></div>
      <button class="ghost" @click="refreshAll">刷新状态</button>
    </nav>

    <transition name="toast">
      <div v-if="notice" class="notice" :class="notice.type">{{ notice.text }}</div>
    </transition>

    <!-- ------------------------------------------------------ 工作台 -->
    <main v-show="tab === 'workspace'" class="workspace">
      <section class="panel editor-panel">
        <div class="panel-head">
          <div>
            <h2>策略包编辑器</h2>
            <p>查看和编辑 JSON 策略包；浏览器只做本地提示，校验以服务端为准。</p>
          </div>
          <div class="head-actions">
            <button class="ghost" @click="useActiveDocument">载入当前生效版本</button>
            <label class="ghost file-button">
              导入本地 JSON
              <input type="file" accept="application/json,.json" @change="usingLocalFile" />
            </label>
            <button class="ghost" @click="formatLocally">本地格式化</button>
            <button class="ghost" @click="clearEditor">清空</button>
          </div>
        </div>

        <div v-if="sampleMeta" class="sample-banner">
          <span class="badge" :class="sampleMeta.kind === 'valid' ? 'ok' : 'danger'">
            {{ sampleMeta.kind === 'valid' ? '正常样例' : '异常样例' }}
          </span>
          <div>
            <strong>{{ sampleMeta.title }}</strong>
            <span>{{ sampleMeta.expectation }}</span>
          </div>
        </div>

        <textarea
          class="editor"
          v-model="editorText"
          spellcheck="false"
          placeholder="在此粘贴或编辑策略包 JSON，也可以从『样例库』载入。"
        ></textarea>

        <p v-if="localParseError" class="inline-hint warn">{{ localParseError }}</p>

        <div class="editor-footer">
          <label class="field">
            <span>来源说明（正式应用必填，写入审计）</span>
            <input
              v-model="sourceNote"
              maxlength="200"
              placeholder="例如：来自运维组 2026-11 变更单 #118"
            />
          </label>
          <div class="editor-actions">
            <button class="primary" :disabled="busy === 'preview'" @click="runPreview">
              {{ busy === 'preview' ? '校验中…' : '预览差异（不生效）' }}
            </button>
          </div>
        </div>

        <div class="rule-view">
          <div class="rule-view-head">
            <h3>编辑器内容速览</h3>
            <span v-if="editorPackage" class="muted">
              {{ editorPackage.name || '未命名' }} · 本地 JSON.parse 结果
            </span>
          </div>
          <table v-if="editorRules.length" class="table compact">
            <thead>
              <tr>
                <th>#</th><th>标识</th><th>动作</th><th>方向</th>
                <th>协议</th><th>目标端口</th><th>优先级</th><th>启用</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="rule in editorRules" :key="rule.index">
                <td class="muted">{{ rule.index + 1 }}</td>
                <td class="mono">{{ rule.id }}</td>
                <td><span class="pill" :class="rule.action">{{ rule.action }}</span></td>
                <td>{{ rule.direction }}</td>
                <td class="mono">{{ describeValue(rule.protocols) }}</td>
                <td class="mono">{{ describeValue(rule.ports) }}</td>
                <td>{{ rule.priority }}</td>
                <td>{{ rule.enabled ? '是' : '否' }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="empty">暂无规则（或本地无法解析）。</p>
        </div>
      </section>

      <section class="panel result-panel">
        <div class="panel-head">
          <div>
            <h2>校验与差异</h2>
            <p>预览只读；只有确认后才写入新的生效版本。</p>
          </div>
          <button
            v-if="preview || previewFailure || applyResult"
            class="ghost"
            @click="dismissPreview"
          >清除结果</button>
        </div>

        <div v-if="applyResult" class="stage-card applied">
          <div class="stage-head">
            <span class="stage-tag">已正式生效</span>
            <span class="mono">v{{ applyResult.version.version_no }} · generation {{ applyResult.generation }}</span>
          </div>
          <p>
            策略包 <strong>{{ applyResult.version.package_name }}</strong> 已整包写入并原子切换；
            {{ applyResult.rule_count }} 条规则。
          </p>
          <p class="muted">摘要 {{ shortDigest(applyResult.digest) }} · {{ formatTime(applyResult.version.created_at) }}</p>
          <div v-if="applyResult.warnings && applyResult.warnings.length" class="warn-box">
            <strong>已接受的警告</strong>
            <ul>
              <li v-for="(issue, i) in applyResult.warnings" :key="i">
                <span class="mono">{{ issue.code }}</span> · {{ issue.path }} — {{ issue.message }}
              </li>
            </ul>
          </div>
        </div>

        <template v-if="preview">
          <div class="stage-card preview">
            <div class="stage-head">
              <span class="stage-tag">预览 · 未生效</span>
              <span class="mono">digest {{ shortDigest(preview.digest) }}</span>
            </div>
            <p>
              校验通过：{{ preview.summary.rule_count }} 条规则（启用
              {{ preview.summary.enabled_rule_count }} 条），
              错误 {{ preview.summary.error_count }}，警告 {{ preview.summary.warning_count }}。
            </p>
            <p v-if="previewStale" class="stale">
              编辑器内容在预览后已被修改，当前预览不再对应当前内容，请重新预览。
            </p>
            <div class="stage-actions">
              <button class="primary" :disabled="!canApply" @click="applyPreview">
                {{ busy === 'apply' ? '应用中…' : '确认并正式应用' }}
              </button>
              <span class="muted">应用会整包替换当前生效规则；失败时保持原版本。</span>
            </div>
          </div>

          <div v-if="preview.warnings && preview.warnings.length" class="warn-box">
            <strong>警告（不阻止应用）</strong>
            <ul>
              <li v-for="(issue, i) in preview.warnings" :key="i">
                <span class="mono">{{ issue.code }}</span> · {{ issue.path }} — {{ issue.message }}
              </li>
            </ul>
          </div>

          <div class="diff-block">
            <h3>与当前生效版本的差异</h3>
            <p v-if="!preview.diff.summary.has_changes" class="empty">
              新包与当前生效版本内容一致，应用后将生成一个内容相同的新版本记录。
            </p>
            <div v-else>
              <div class="diff-summary">
                <span class="chip add">新增 {{ preview.diff.summary.added }}</span>
                <span class="chip del">删除 {{ preview.diff.summary.removed }}</span>
                <span class="chip mod">修改 {{ preview.diff.summary.modified }}</span>
                <span class="chip same">未变 {{ preview.diff.summary.unchanged }}</span>
              </div>

              <div v-if="Object.keys(preview.diff.package).length" class="diff-section">
                <h4>策略包属性</h4>
                <table class="table compact">
                  <tbody>
                    <tr v-for="(change, field) in preview.diff.package" :key="field">
                      <td class="muted">{{ diffFieldLabel(field) }}</td>
                      <td class="before">{{ describeValue(change.before) }}</td>
                      <td class="arrow">→</td>
                      <td class="after">{{ describeValue(change.after) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div v-if="preview.diff.added.length" class="diff-section">
                <h4>新增规则</h4>
                <div v-for="item in preview.diff.added" :key="'a-' + item.id" class="diff-rule add">
                  <div class="diff-rule-head">
                    <span class="badge ok">新增</span>
                    <span class="mono">{{ item.id }}</span>
                    <span>{{ item.rule.name }}</span>
                  </div>
                  <div class="diff-rule-body">
                    <span class="pill" :class="item.rule.action">{{ item.rule.action }}</span>
                    <span>{{ item.rule.direction }}</span>
                    <span class="mono">{{ describeValue(item.rule.protocols) }}</span>
                    <span class="mono">端口 {{ describeValue(item.rule.destination_ports) }}</span>
                    <span>优先级 {{ item.rule.priority }}</span>
                  </div>
                </div>
              </div>

              <div v-if="preview.diff.removed.length" class="diff-section">
                <h4>删除规则</h4>
                <div v-for="item in preview.diff.removed" :key="'r-' + item.id" class="diff-rule del">
                  <div class="diff-rule-head">
                    <span class="badge danger">删除</span>
                    <span class="mono">{{ item.id }}</span>
                    <span>{{ item.rule.name }}</span>
                  </div>
                  <div class="diff-rule-body">
                    <span class="pill" :class="item.rule.action">{{ item.rule.action }}</span>
                    <span>{{ item.rule.direction }}</span>
                    <span class="mono">{{ describeValue(item.rule.protocols) }}</span>
                    <span class="mono">端口 {{ describeValue(item.rule.destination_ports) }}</span>
                  </div>
                </div>
              </div>

              <div v-if="preview.diff.modified.length" class="diff-section">
                <h4>修改规则</h4>
                <div v-for="item in preview.diff.modified" :key="'m-' + item.id" class="diff-rule mod">
                  <div class="diff-rule-head">
                    <span class="badge warn">修改</span>
                    <span class="mono">{{ item.id }}</span>
                    <span>{{ item.rule.name }}</span>
                  </div>
                  <table class="table compact change-table">
                    <tbody>
                      <tr v-for="(change, field) in item.changes" :key="field">
                        <td class="muted">{{ diffFieldLabel(field) }}</td>
                        <td class="before">{{ describeValue(change.before) }}</td>
                        <td class="arrow">→</td>
                        <td class="after">{{ describeValue(change.after) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          <details class="normalized" @toggle="showNormalized = $event.target.open">
            <summary>查看服务端规范化后的策略包</summary>
            <pre>{{ preview.document_text }}</pre>
          </details>
        </template>

        <div v-if="previewFailure" class="stage-card failed">
          <div class="stage-head">
            <span class="stage-tag">已拒绝 · 未生效</span>
            <span v-if="previewFailure.code" class="mono">{{ previewFailure.code }}</span>
          </div>
          <p>{{ previewFailure.message }}</p>
          <p v-if="previewFailure.details && previewFailure.details.path" class="mono muted">
            位置 {{ previewFailure.details.path }}
            <span v-if="previewFailure.details.line">
              · 第 {{ previewFailure.details.line }} 行第 {{ previewFailure.details.column }} 列
            </span>
          </p>
          <ul v-if="previewFailure.issues.length" class="issues">
            <li v-for="(issue, i) in previewFailure.issues" :key="i" :class="issue.severity">
              <span class="severity">{{ SEVERITY_LABELS[issue.severity] || issue.severity }}</span>
              <span class="mono">{{ issue.code }}</span>
              <span class="mono path">{{ issue.path }}</span>
              <span>{{ issue.message }}</span>
            </li>
          </ul>
          <p class="muted">
            当前生效版本未被修改。
            <span v-if="previewFailure.stage === 'apply'">这次失败的正式应用已记入审计。</span>
            <span v-else>预览是只读检查，不会写入审计；正式应用被拒绝时才留痕。</span>
          </p>
        </div>

        <div v-if="!preview && !previewFailure && !applyResult" class="placeholder">
          <div class="placeholder-icon">⌁</div>
          <h3>还没有预览结果</h3>
          <p>在左侧编辑或载入样例，然后点击「预览差异（不生效）」。</p>
          <p class="muted">预览与正式应用使用同一套服务端校验；预览不会改变生效规则。</p>
        </div>
      </section>
    </main>

    <!-- ------------------------------------------------------ 历史 -->
    <main v-show="tab === 'history'" class="history">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>策略版本</h2>
            <p>每次成功导入或恢复都会生成新的版本记录；激活指针始终指向完整版本。</p>
          </div>
          <button class="ghost" @click="loadHistory">刷新</button>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>版本</th><th>策略包</th><th>来源</th><th>说明</th>
              <th>时间</th><th>摘要</th><th>状态</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="version in history.versions" :key="version.id">
              <td class="mono">v{{ version.version_no }}</td>
              <td>{{ version.package_name }} <span class="muted mono">{{ version.package_id }}</span></td>
              <td><span class="badge" :class="version.source_kind === 'restore' ? 'warn' : 'ok'">
                {{ version.source_kind === 'restore' ? '恢复' : '导入' }}
              </span></td>
              <td class="wrap">{{ version.source_note || '—' }}</td>
              <td class="nowrap">{{ formatTime(version.created_at) }}</td>
              <td class="mono">{{ shortDigest(version.digest) }}</td>
              <td>
                <span v-if="version.is_active" class="badge active">生效中</span>
                <span v-else class="muted">历史</span>
              </td>
              <td>
                <button
                  class="ghost small"
                  :disabled="busy === 'restore'"
                  @click="openRestorePreview(version)"
                >预览恢复</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!history.versions.length" class="empty">还没有任何策略版本。</p>
      </section>

      <section v-if="restorePreview || restoreFailure || restoreResult" class="panel restore-panel">
        <div class="panel-head">
          <div>
            <h2>恢复预览</h2>
            <p>恢复同样会先展示差异，确认后生成新版本并留下审计记录。</p>
          </div>
          <button class="ghost" @click="restorePreview = null; restoreFailure = null; restoreResult = null">关闭</button>
        </div>

        <div v-if="restoreResult" class="stage-card applied">
          <div class="stage-head">
            <span class="stage-tag">已恢复并生效</span>
            <span class="mono">新版本 v{{ restoreResult.version.version_no }}</span>
          </div>
          <p>
            来源版本 v{{ restoreResult.restored_from_version_no }} 的内容已作为新版本
            v{{ restoreResult.version.version_no }} 激活，旧版本仍保留在历史中。
          </p>
        </div>

        <template v-if="restorePreview">
          <div class="stage-card preview">
            <div class="stage-head">
              <span class="stage-tag">恢复预览 · 未生效</span>
              <span class="mono">来源 v{{ restorePreview.version.version_no }}</span>
            </div>
            <p>
              将把 {{ restorePreview.version.package_name }}（{{ restorePreview.version.rule_count || '—' }} 条规则）恢复到当前。
              新增 {{ restorePreview.diff.summary.added }}、删除 {{ restorePreview.diff.summary.removed }}、修改
              {{ restorePreview.diff.summary.modified }}。
            </p>
            <p class="muted">来源说明：{{ restorePreview.version.source_note || '—' }} · {{ formatTime(restorePreview.version.created_at) }}</p>
          </div>

          <div v-if="restorePreview.warnings.length" class="warn-box">
            <strong>警告</strong>
            <ul>
              <li v-for="(issue, i) in restorePreview.warnings" :key="i">
                <span class="mono">{{ issue.code }}</span> · {{ issue.path }} — {{ issue.message }}
              </li>
            </ul>
          </div>

          <div class="diff-block">
            <h3>恢复后的差异</h3>
            <div class="diff-summary">
              <span class="chip add">新增 {{ restorePreview.diff.summary.added }}</span>
              <span class="chip del">删除 {{ restorePreview.diff.summary.removed }}</span>
              <span class="chip mod">修改 {{ restorePreview.diff.summary.modified }}</span>
              <span class="chip same">未变 {{ restorePreview.diff.summary.unchanged }}</span>
            </div>
            <div v-if="restorePreview.diff.added.length" class="diff-section">
              <h4>将新增</h4>
              <div v-for="item in restorePreview.diff.added" :key="'ra-' + item.id" class="diff-rule add">
                <div class="diff-rule-head">
                  <span class="badge ok">新增</span><span class="mono">{{ item.id }}</span><span>{{ item.rule.name }}</span>
                </div>
              </div>
            </div>
            <div v-if="restorePreview.diff.removed.length" class="diff-section">
              <h4>将删除</h4>
              <div v-for="item in restorePreview.diff.removed" :key="'rr-' + item.id" class="diff-rule del">
                <div class="diff-rule-head">
                  <span class="badge danger">删除</span><span class="mono">{{ item.id }}</span><span>{{ item.rule.name }}</span>
                </div>
              </div>
            </div>
            <div v-if="restorePreview.diff.modified.length" class="diff-section">
              <h4>将修改</h4>
              <div v-for="item in restorePreview.diff.modified" :key="'rm-' + item.id" class="diff-rule mod">
                <div class="diff-rule-head">
                  <span class="badge warn">修改</span><span class="mono">{{ item.id }}</span><span>{{ item.rule.name }}</span>
                </div>
                <table class="table compact change-table">
                  <tbody>
                    <tr v-for="(change, field) in item.changes" :key="field">
                      <td class="muted">{{ diffFieldLabel(field) }}</td>
                      <td class="before">{{ describeValue(change.before) }}</td>
                      <td class="arrow">→</td>
                      <td class="after">{{ describeValue(change.after) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div class="editor-footer">
            <label class="field">
              <span>恢复来源说明（必填，写入审计）</span>
              <input v-model="restoreNote" maxlength="200" placeholder="例如：回滚到 v2，排查 #221 故障" />
            </label>
            <button class="primary" :disabled="busy === 'restore'" @click="confirmRestore">
              {{ busy === 'restore' ? '恢复中…' : '确认恢复此版本' }}
            </button>
          </div>
        </template>

        <div v-if="restoreFailure" class="stage-card failed">
          <span class="stage-tag">恢复被拒绝</span>
          <p>{{ restoreFailure.message }}</p>
          <ul v-if="restoreFailure.issues && restoreFailure.issues.length" class="issues">
            <li v-for="(issue, i) in restoreFailure.issues" :key="i" :class="issue.severity">
              <span class="severity">{{ SEVERITY_LABELS[issue.severity] || issue.severity }}</span>
              <span class="mono">{{ issue.code }}</span>
              <span class="mono path">{{ issue.path }}</span>
              <span>{{ issue.message }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>审计记录</h2>
            <p>成功与失败的应用/恢复都会留痕；预览是只读检查，不写入审计。</p>
          </div>
        </div>
        <table class="table audit">
          <thead>
            <tr>
              <th>时间</th><th>动作</th><th>结果</th><th>来源说明</th>
              <th>版本</th><th>原因 / 详情</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="entry in history.audit" :key="entry.id">
              <tr @click="toggleAudit(entry.id)" class="clickable">
                <td class="nowrap">{{ formatTime(entry.at) }}</td>
                <td>{{ ACTION_LABELS[entry.action] || entry.action }}</td>
                <td>
                  <span class="badge" :class="entry.outcome === 'applied' ? 'ok' : 'danger'">
                    {{ OUTCOME_LABELS[entry.outcome] || entry.outcome }}
                  </span>
                </td>
                <td class="wrap">{{ entry.source_note || '—' }}</td>
                <td class="mono">{{ entry.version_no ? 'v' + entry.version_no : '—' }}</td>
                <td class="wrap">
                  <span v-if="entry.code" class="mono">{{ entry.code }}</span>
                  <span v-if="entry.message"> · {{ entry.message }}</span>
                  <span class="muted">（点击查看详情）</span>
                </td>
              </tr>
              <tr v-if="expandedAudit === entry.id" class="details-row">
                <td colspan="6">
                  <pre>{{ entry.details ? pretty(entry.details) : '无额外详情' }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <p v-if="!history.audit.length" class="empty">还没有审计记录。</p>
      </section>
    </main>

    <!-- ------------------------------------------------------ 样例 -->
    <main v-show="tab === 'samples'" class="samples">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>可直接操作的样例</h2>
            <p>正常样例用于演示预览差异与成功应用；异常样例用于演示服务端拒绝原因。</p>
          </div>
        </div>
        <div class="sample-grid">
          <article
            v-for="sample in samples"
            :key="sample.filename"
            class="sample-card"
            :class="sample.kind"
          >
            <div class="sample-card-head">
              <span class="badge" :class="sample.kind === 'valid' ? 'ok' : 'danger'">
                {{ sample.kind === 'valid' ? '正常' : '异常' }}
              </span>
              <h3>{{ sample.title }}</h3>
            </div>
            <p class="expect">{{ sample.expectation }}</p>
            <p class="focus">{{ sample.focus }}</p>
            <div class="sample-actions">
              <button class="ghost small" :disabled="!sample.available" @click="loadSampleIntoEditor(sample)">
                载入编辑器
              </button>
              <button class="primary small" :disabled="!sample.available || busy === 'preview'" @click="previewSample(sample)">
                立即预览
              </button>
            </div>
          </article>
        </div>
        <div class="tips">
          <h3>建议演示顺序</h3>
          <ol>
            <li>载入并应用「基线策略包」，得到 v1。</li>
            <li>预览「变更后的策略包」，查看新增/删除/修改差异，再确认应用为 v2。</li>
            <li>依次预览异常样例，观察路径、错误码和拒绝原因；确认生效版本未变。</li>
            <li>到「历史与恢复」预览并恢复 v1，确认恢复动作也生成新版本与审计。</li>
          </ol>
        </div>
      </section>
    </main>

    <footer class="foot">
      <span>仅本机 · 无外部服务 · SQLite 单文件存储</span>
      <span>服务端校验：结构 / 语义 / 并发 / 原子切换</span>
    </footer>
  </div>
  `,
});

app.mount("#app");
}
