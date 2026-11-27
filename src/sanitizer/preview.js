// 隔离预览文档构建:把已清理的 HTML 包进带严格 CSP 的文档。
// 实际隔离由宿主页面的 <iframe sandbox="">(无任何令牌)提供,
// 这里的 CSP 是纵深防御:即便隔离配置被误改,帧内也无法执行脚本或外联。

// default-src 'none' 阻断一切外部请求(脚本/样式/图片/字体/XHR/WS 等);
// style-src 'unsafe-inline' 仅用于元素 style 属性与内置排版样式;
// 不声明 script-src 时回退 default-src,脚本同样被禁。
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "form-action 'none'",
  "navigate-to 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "sandbox"
].join('; ');

const FRAME_STYLES = `
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
       margin: 16px; line-height: 1.6; color: #1f2933; word-wrap: break-word; }
table { border-collapse: collapse; }
table, th, td { border: 1px solid #9aa5b1; padding: 4px 8px; }
img { max-width: 100%; }
pre { background: #f5f7fa; padding: 12px; overflow:auto; }
code { background: #f5f7fa; padding: 1px 4px; border-radius: 3px; }
blockquote { border-left: 4px solid #cbd2d9; margin: 8px 0; padding: 4px 12px; color: #52606d; }
a { color: #2b6cb0; text-decoration: underline; }
`.trim();

export function buildPreviewDocument(safeHtml) {
  // 文档自身的静态文本不含用户输入;safeHtml 已是规范编码后的白名单输出
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${FRAME_STYLES}</style>`,
    '</head>',
    '<body>',
    safeHtml,
    '</body>',
    '</html>'
  ].join('\n');
}

export const PREVIEW_CSP = CSP;
