window.__errors = [];
window.addEventListener('error', e => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', e => window.__errors.push('rej: ' + e.reason));
window.addEventListener('load', () => {
  (async () => {
    try {
      HTMLAnchorElement.prototype.click = function () {}; // 拦截下载
      document.querySelectorAll('#sampleButtons button')[0].click();
      document.getElementById('btnExport').click();
      for (let i = 0; i < 400; i++) {
        await new Promise(r => setTimeout(r, 50));
        const t = document.getElementById('exportStatus').textContent;
        if (t.includes('像素对照：') || t.includes('导出失败')) break;
      }
      const st = document.getElementById('exportStatus').textContent;
      const ok = st.includes('完全一致') && window.__errors.length === 0;
      document.title = ok ? 'SMOKE_OK' : 'SMOKE_FAIL: ' + st + ' | ' + window.__errors.join(';');
    } catch (e) {
      document.title = 'SMOKE_FAIL: ' + e.message;
    }
  })();
});
