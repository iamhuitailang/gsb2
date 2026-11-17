const CSS = `
:root {
  color-scheme: light;
  --bg: #f6f8fa;
  --panel: #ffffff;
  --border: #d0d7de;
  --border-strong: #afb8c1;
  --text: #1f2328;
  --muted: #59636e;
  --accent: #0969da;
  --accent-soft: #ddf4ff;
  --ok: #1a7f37;
  --warn: #9a6700;
  --warn-soft: #fff8c5;
  --bad: #cf222e;
  --bad-soft: #ffebe9;
  --radius: 8px;
}
* { box-sizing: border-box; }
/* 作者样式里的 display 会盖掉 [hidden] 的 UA 规则，这里统一兜住。 */
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
  margin: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
}
h1, h2, h3, h4 { margin: 0; font-weight: 600; }
p { margin: 0; }
code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.bad { color: var(--bad); }
.ok { color: var(--ok); }

.topbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 20px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.brand .logo {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
}
.brand .sep { color: var(--border-strong); }
.brand .crumb { font-weight: 500; color: var(--muted); }
.account { display: flex; align-items: center; gap: 10px; }
.avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: #0a3069;
  font-weight: 600;
}
.account-name { font-weight: 600; font-size: 13px; }
.account-role { font-size: 12px; color: var(--muted); }

.layout {
  flex: 1;
  display: flex;
  min-height: 0;
}
.sidebar {
  width: 330px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  overflow: auto;
  background: var(--panel);
  border-right: 1px solid var(--border);
}
.sidebar-head h1 { font-size: 17px; }
.session-card,
.import-card {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: #fbfcfd;
}
.session-card h2 { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.session-card dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 12px;
}
.session-card dt { color: var(--muted); }
.session-card dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.session-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.import-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.import-card p { margin-top: 8px; }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #f6f8fa;
  color: var(--text);
  font: inherit;
  text-decoration: none;
  cursor: pointer;
  white-space: nowrap;
}
.btn:hover { background: #eef1f4; }
.btn.primary { background: #1f883d; border-color: #1a7f37; color: #fff; }
.btn.primary:hover { background: #1a7f37; }
.btn.small { padding: 3px 9px; font-size: 12px; }

.report-list { display: flex; flex-direction: column; gap: 6px; }
.report-list .empty { padding: 20px 4px; text-align: center; }
.report-item {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.report-item:hover { border-color: var(--border-strong); background: #fbfcfd; }
.report-item.active { border-color: var(--accent); background: var(--accent-soft); }
.report-title { font-weight: 600; overflow-wrap: anywhere; }
.report-meta { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.badge {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 11px;
}
.badge.ok { background: #dafbe1; border-color: #4ac26b55; }
.badge.warn { background: var(--warn-soft); border-color: #d4a72c66; color: var(--warn); }
.badge.bad { background: var(--bad-soft); border-color: #ff818266; }

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  gap: 12px;
}
.error-banner {
  padding: 8px 12px;
  border: 1px solid #ff818266;
  border-radius: var(--radius);
  background: var(--bad-soft);
  color: #a40e26;
}
.preview-empty {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 32px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  background: var(--panel);
  text-align: center;
}
.preview-empty > div { max-width: 60ch; display: grid; gap: 12px; }
.rules { margin: 0; padding-left: 20px; text-align: left; color: var(--muted); font-size: 13px; }
.rules li { margin: 4px 0; }

.preview-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.preview-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-bottom: 0;
  border-radius: var(--radius) var(--radius) 0 0;
  background: var(--panel);
}
.preview-heading { display: flex; flex-direction: column; min-width: 0; }
.preview-heading strong { overflow-wrap: anywhere; }
.preview-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.preview-body {
  flex: 1;
  display: flex;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 0 0 var(--radius) var(--radius);
  overflow: hidden;
  background: var(--panel);
}
.preview-host { flex: 1; min-width: 0; background: #fff; }
.preview-frame { display: block; width: 100%; height: 100%; border: 0; }
.check-panel {
  width: 320px;
  flex: none;
  overflow: auto;
  padding: 12px 14px 20px;
  border-left: 1px solid var(--border);
  background: #fbfcfd;
}
.check-panel h3 { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.check-panel section { margin-top: 12px; }
.check-panel h4 { font-size: 12px; margin-bottom: 4px; }
.check-panel ul { margin: 0; padding-left: 16px; }
.check-panel li { margin: 3px 0; word-break: break-all; font-size: 12px; }
.check-panel code { font-size: 11.5px; }

dialog {
  border: 0;
  border-radius: 12px;
  padding: 0;
  width: min(560px, calc(100vw - 32px));
  box-shadow: 0 12px 40px #1f232826;
}
dialog::backdrop { background: #1f23284d; }
dialog form { display: grid; gap: 12px; padding: 20px; }
dialog h2 { font-size: 16px; }
.field { display: grid; gap: 4px; font-size: 13px; }
.field input[type="text"] {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.footnote {
  flex: none;
  padding: 6px 20px 10px;
  font-size: 11.5px;
  color: var(--muted);
  background: var(--bg);
}

@media (max-width: 900px) {
  .layout { flex-direction: column; }
  .sidebar { width: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .preview-body { flex-direction: column; }
  .check-panel { width: auto; border-left: 0; border-top: 1px solid var(--border); }
}
`;

export const APP_CSS = CSS.trim();
