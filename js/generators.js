/* 程序化素材生成器：所有图像素材均由代码生成，无需外部图片。
 * 每个生成器输入 (w, h)，输出 canvas。结果按 id+尺寸 缓存。 */
window.App = window.App || {};

App.generators = (function () {
  const cache = new Map();

  /* 确定性伪随机数，保证重开项目后素材一致 */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const registry = {
    sky: {
      name: '天空渐变',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#0b1d51');
        g.addColorStop(0.55, '#2a4d9b');
        g.addColorStop(0.8, '#e08e45');
        g.addColorStop(1, '#f7c873');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        // 太阳光晕
        const sun = ctx.createRadialGradient(w * 0.7, h * 0.72, 0, w * 0.7, h * 0.72, w * 0.28);
        sun.addColorStop(0, 'rgba(255,240,200,0.95)');
        sun.addColorStop(0.2, 'rgba(255,200,120,0.5)');
        sun.addColorStop(1, 'rgba(255,180,100,0)');
        ctx.fillStyle = sun;
        ctx.fillRect(0, 0, w, h);
        return c;
      }
    },

    checker: {
      name: '棋盘格',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        const n = 12;
        const sw = w / n, sh = h / n;
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            ctx.fillStyle = (x + y) % 2 ? '#c9c9c9' : '#5a5a5a';
            ctx.fillRect(x * sw, y * sh, sw + 1, sh + 1);
          }
        }
        return c;
      }
    },

    bokeh: {
      name: '散景圆点',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        const rnd = mulberry32(20240101);
        const colors = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#f78c6b', '#c77dff'];
        for (let i = 0; i < 46; i++) {
          const x = rnd() * w, y = rnd() * h;
          const r = 20 + rnd() * 90;
          const col = colors[Math.floor(rnd() * colors.length)];
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, col + 'cc');
          g.addColorStop(0.7, col + '55');
          g.addColorStop(1, col + '00');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        return c;
      }
    },

    stripes: {
      name: '斜条纹',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.translate(w / 2, h / 2);
        ctx.rotate(-Math.PI / 6);
        const diag = Math.sqrt(w * w + h * h);
        const period = 90;
        const cols = ['#ff5d8f', '#ffd166', '#3ec1d3', '#f6f6f6'];
        let i = 0;
        for (let x = -diag / 2; x < diag / 2; x += period) {
          ctx.fillStyle = cols[i++ % cols.length];
          ctx.fillRect(x, -diag / 2, period * 0.55, diag);
        }
        return c;
      }
    },

    noise: {
      name: '噪点纹理',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const rnd = mulberry32(987654);
        for (let i = 0; i < img.data.length; i += 4) {
          const v = Math.floor(rnd() * 255);
          img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return c;
      }
    },

    radial: {
      name: '径向光晕',
      generate(w, h) {
        const c = App.util.makeCanvas(w, h);
        const ctx = c.getContext('2d');
        const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.45);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.35, 'rgba(255,230,160,0.6)');
        g.addColorStop(1, 'rgba(255,220,150,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        return c;
      }
    }
  };

  return {
    list() {
      return Object.keys(registry).map(id => ({ id, name: registry[id].name }));
    },
    nameOf(id) {
      return registry[id] ? registry[id].name : id;
    },
    generate(id, w, h) {
      const key = id + ':' + w + 'x' + h;
      if (!cache.has(key)) {
        if (!registry[id]) return null;
        cache.set(key, registry[id].generate(w, h));
      }
      return cache.get(key);
    }
  };
})();
