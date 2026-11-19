/* 通用工具 */
window.App = window.App || {};

App.util = {
  uid() {
    return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  },

  makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  },

  /* 复制画布内容，返回新画布 */
  cloneCanvas(src) {
    const c = App.util.makeCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  },

  download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    App.util.download(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  /* 把 dataURL 画到目标画布（异步），完成后回调 */
  drawDataURLToCanvas(dataURL, canvas, done) {
    const img = new Image();
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      if (done) done();
    };
    img.src = dataURL;
  }
};
