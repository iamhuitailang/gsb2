import { escapeHtml } from './util.js';

/**
 * 业务页骨架。账号信息由 JS 通过 /api/me 填入；
 * 页面本身只作为“容器”，报告内容永远不会进入这个文档。
 */
export function businessPage(config) {
  const reportOrigin = escapeHtml(config.origins.report);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>采购系统 · 供应商报告库</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="logo" aria-hidden="true">采</span>
    <span>采购系统</span>
    <span class="sep">/</span>
    <span class="crumb">供应商报告库</span>
  </div>
  <div class="account" id="account-box">
    <div class="avatar" id="sess-avatar" aria-hidden="true">林</div>
    <div>
      <div class="account-name" id="sess-name">加载中…</div>
      <div class="account-role" id="sess-role"></div>
    </div>
  </div>
</header>

<main class="layout">
  <section class="sidebar">
    <div class="sidebar-head">
      <div>
        <h1>报告库</h1>
        <p class="muted">供应商 HTML 报告 · 本地保存</p>
      </div>
    </div>

    <div class="session-card">
      <h2>业务会话</h2>
      <dl>
        <dt>会话</dt><dd id="sess-id">—</dd>
        <dt>请求数</dt><dd id="sess-requests">—</dd>
        <dt>操作数</dt><dd id="sess-actions">—</dd>
        <dt>最后活动</dt><dd id="sess-seen">—</dd>
      </dl>
      <div class="session-actions">
        <button type="button" id="session-ping" class="btn small">测试会话</button>
        <span id="session-note" class="muted small"></span>
      </div>
    </div>

    <div class="import-card">
      <div class="import-actions">
        <button type="button" id="open-import" class="btn primary">导入报告</button>
        <button type="button" id="import-sample" class="btn">生成样例报告</button>
      </div>
      <p id="import-status" class="muted small" role="status" aria-live="polite"></p>
    </div>

    <div id="report-list" class="report-list" aria-label="报告列表"></div>
  </section>

  <section class="main">
    <p id="boot-error" class="error-banner" hidden></p>

    <div id="preview-empty" class="preview-empty">
      <div>
        <h2>选择一份报告开始预览</h2>
        <p class="muted">
          报告内容在与业务系统隔离的区域中展示。报告里的脚本不会运行，
          外部资源不会自动加载，预览不会读取本页的账号信息，也不会替你发起操作。
        </p>
        <ul class="rules">
          <li>报告站点与业务站点是不同源，无法读取对方的 cookie 或页面内容。</li>
          <li>列表预览与独立预览地址使用同一套隔离响应头。</li>
          <li>需要的外部资源会列在检查结果里，预览时一律不自动联网。</li>
        </ul>
      </div>
    </div>

    <div id="preview-panel" class="preview-panel" hidden>
      <div class="preview-bar">
        <div class="preview-heading">
          <strong id="preview-title" title=""></strong>
          <span class="muted small" id="preview-file"></span>
        </div>
        <div class="preview-actions">
          <a id="preview-standalone" class="btn" href="#" target="_blank" rel="noopener noreferrer">在新标签页打开独立预览地址</a>
          <button type="button" id="close-preview" class="btn">关闭报告</button>
        </div>
      </div>
      <div class="preview-body">
        <div id="preview-host" class="preview-host"></div>
        <aside class="check-panel" aria-labelledby="check-title">
          <h3 id="check-title">资源检查</h3>
          <div id="check-body">
            <p class="muted">打开报告后显示。</p>
          </div>
        </aside>
      </div>
    </div>
  </section>
</main>

<dialog id="import-dialog">
  <form id="import-form" method="dialog">
    <h2>导入供应商报告</h2>
    <p class="muted small">
      标题与文件名只按文本展示。报告正文会在保存时被净化：脚本、表单、自动跳转会一并移除，
      外部资源只会被列出、不会下载。
    </p>
    <label class="field">
      <span>标题（可留空，使用文件名）</span>
      <input type="text" id="import-title" maxlength="200" autocomplete="off">
    </label>
    <label class="field">
      <span>报告 HTML 文件</span>
      <input type="file" id="import-file" accept="text/html,.html,.htm" required>
    </label>
    <label class="field">
      <span>随附的本地资源（可多选；若文件名在报告里唯一，可不必保留目录）</span>
      <input type="file" id="import-assets" multiple>
    </label>
    <p id="dialog-status" class="muted small" role="status" aria-live="polite"></p>
    <div class="dialog-actions">
      <button type="button" id="import-cancel" class="btn">取消</button>
      <button type="submit" class="btn primary">导入</button>
    </div>
  </form>
</dialog>

<p class="footnote">
  隔离报告站点：<code>${reportOrigin}</code> · 业务站点：
  <code>${escapeHtml(config.origins.business)}</code>
</p>

<script src="/app.js"></script>
</body>
</html>`;
}
