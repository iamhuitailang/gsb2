/* io.js — 文本点云解析与导出。全部在本机内存中完成，不发生任何网络传输。 */
"use strict";

const PCIO = (() => {

  /**
   * 解析文本点云。支持 .xyz / .txt / .csv / .pts / .asc：
   *   每行: x y z [r g b]   （空格、制表符或逗号分隔）
   *   颜色可取 0–1 浮点或 0–255 整数，自动识别。
   *   以 # 或 // 开头的行为注释；.pts 首行的点数声明行会被跳过。
   * 返回 { positions: Float32Array, colors: Uint8Array|null,
   *        badLines: [行号...], totalLines, skippedHeader }
   */
  function parsePointText(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pos = [];
    const col = [];
    const badLines = [];
    let sawColor = false;
    let colorMax = 0;
    let headerSkipped = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;

      const parts = line.split(/[,\s]+/).filter(s => s.length > 0);

      // .pts 格式首行可能为单独一个整数（点数声明）
      if (!headerSkipped && parts.length === 1 && /^\d+$/.test(parts[0])) {
        headerSkipped = true;
        continue;
      }
      headerSkipped = true;

      if (parts.length !== 3 && parts.length < 6) {
        badLines.push(i + 1);
        continue;
      }
      const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
        badLines.push(i + 1);
        continue;
      }
      pos.push(x, y, z);

      if (parts.length >= 6) {
        const r = Number(parts[3]), g = Number(parts[4]), b = Number(parts[5]);
        if (!isFinite(r) || !isFinite(g) || !isFinite(b)) {
          badLines.push(i + 1);
          pos.length -= 3; // 回退本行坐标
          continue;
        }
        sawColor = true;
        colorMax = Math.max(colorMax, r, g, b);
        col.push(r, g, b);
      } else if (sawColor) {
        col.push(1, 1, 1); // 前文有颜色而本行缺失，补白色
      }
    }

    const n = pos.length / 3;
    const positions = new Float32Array(pos);

    let colors = null;
    if (sawColor) {
      const scale = colorMax <= 1.0 ? 255 : 1; // 0–1 浮点 or 0–255 整数
      colors = new Uint8Array(n * 3);
      for (let i = 0; i < col.length; i++) {
        colors[i] = Math.max(0, Math.min(255, Math.round(col[i] * scale)));
      }
    }

    return { positions, colors, badLines, totalLines: lines.length };
  }

  /** 将点云（可选应用 4x4 世界变换）导出为 "x y z r g b" 文本。 */
  function exportPointText(positions, colors, matrix /* THREE.Matrix4 或 null */) {
    const n = positions.length / 3;
    const out = new Array(n);
    const m = matrix ? matrix.elements : null;
    for (let i = 0; i < n; i++) {
      let x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
      if (m) {
        const nx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const ny = m[1] * x + m[5] * y + m[9] * z + m[13];
        const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
        x = nx; y = ny; z = nz;
      }
      let line = x.toFixed(6) + " " + y.toFixed(6) + " " + z.toFixed(6);
      if (colors) line += " " + colors[i * 3] + " " + colors[i * 3 + 1] + " " + colors[i * 3 + 2];
      out[i] = line;
    }
    return "# point cloud exported by Point Cloud Inspector\n" + out.join("\n") + "\n";
  }

  /** 触发浏览器下载（本地生成 Blob，不上传）。 */
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { parsePointText, exportPointText, download };
})();
