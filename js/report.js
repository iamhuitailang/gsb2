/**
 * report.js — 快照对比与报告导出（JSON / PNG / 自包含 HTML）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Report = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob(b => downloadBlob(b, filename), 'image/png');
  }

  function round(v, n) {
    if (v == null || Number.isNaN(v)) return null;
    const p = Math.pow(10, n == null ? 2 : n);
    return Math.round(v * p) / p;
  }

  function compactSummary(s) {
    if (!s) return null;
    return {
      count: s.count,
      mean: round(s.mean), min: round(s.min),
      p5: round(s.p5), p10: round(s.p10), p50: round(s.p50),
    };
  }

  /**
   * 生成完整数据报告
   * @param payload {meta, scene, modes:[{mode, iconResults, pairResults}], scans, snapshots}
   */
  function buildJSON(payload) {
    const report = {
      tool: '游戏提示可辨认性检查工具',
      exportedAt: new Date().toISOString(),
      meta: payload.meta,
      scene: {
        canvas: { width: payload.scene.W, height: payload.scene.H },
        background: payload.scene.backgroundName,
        icons: payload.scene.icons.map(ic => ({
          id: ic.id, name: ic.name,
          x: ic.x, y: ic.y, width: ic.w, height: ic.h,
          tintHue: ic.tintHue, tintSat: ic.tintSat,
          symbol: ic.symbol, border: ic.border,
        })),
      },
      viewModes: payload.modes.map(m => ({
        mode: m.mode,
        iconVsBackground: m.iconResults.map(r => ({
          iconId: r.iconId, metric: r.metric,
          opaque: compactSummary(r.summary.full),
          semiTransparentEdge: compactSummary(r.summary.edge),
          fullyTransparentPixels: r.summary.transparentCount,
          wcagContrastOnOpaque: compactSummary(r.summary.contrastFull),
          shareBelowThreshold: Object.fromEntries(
            Object.entries(r.thresholds).map(([k, v]) => [k.replace('lt', 'dE_lt_'), round(v, 3)])),
          worstPixels: r.worst.slice(0, 8).map(w => ({
            x: w.x, y: w.y, dE: round(w.dE), class: w.cls,
            nearestBg: { x: w.bgX, y: w.bgY, distancePx: round(w.bgDist, 1) },
            fgRgb: w.fgRgb, bgRgb: w.bgRgb,
          })),
        })),
        iconPairs: (m.pairResults || []).map(r => ({
          iconA: r.iconA, iconB: r.iconB,
          overlapPixels: r.overlapCount,
          nearestEdgeGapPx: r.minGap == null ? null : round(r.minGap, 1),
          opaque: compactSummary(r.full),
          semiTransparentEdge: compactSummary(r.edge),
          shareBelowThreshold: Object.fromEntries(
            Object.entries(r.thresholds).map(([k, v]) => [k.replace('lt', 'dE_lt_'), round(v, 3)])),
          worstPixels: r.worst.slice(0, 8).map(w => ({
            x: w.x, y: w.y, dE: round(w.dE), class: w.cls, rgbA: w.rgbA, rgbB: w.rgbB,
          })),
        })),
      })),
      worstPositionScans: (payload.scans || []).map(s => ({
        iconId: s.iconId, mode: s.mode, metric: s.metric, stepPx: s.step,
        hardest: { x: s.hardest.x, y: s.hardest.y, meanDE: round(s.hardest.score) },
        easiest: { x: s.easiest.x, y: s.easiest.y, meanDE: round(s.easiest.score) },
      })),
      snapshots: (payload.snapshots || []).map(sp => ({
        label: sp.label, createdAt: sp.createdAt,
        icons: sp.icons.map(ic => ({
          name: ic.name, x: ic.x, y: ic.y, width: ic.w, height: ic.h,
          tintHue: ic.tintHue, symbol: ic.symbol, border: ic.border,
        })),
        headline: sp.headline,
      })),
    };
    return JSON.stringify(report, null, 2);
  }

  function exportJSON(payload, filename) {
    downloadBlob(new Blob([buildJSON(payload)], { type: 'application/json' }),
      filename || 'legibility-report.json');
  }

  /** 自包含 HTML 报告：内嵌对比截图（dataURL）与关键数值表 */
  function exportHTML(payload, images, filename) {
    const esc = (s) => String(s).replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const parts = [];
    parts.push(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>提示可辨认性报告</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:32px;color:#1f2937;background:#fafafa}
h1{font-size:22px} h2{font-size:17px;margin-top:28px;border-left:4px solid #2f80ed;padding-left:8px}
table{border-collapse:collapse;background:#fff;margin:8px 0;font-size:13px}
th,td{border:1px solid #d8dee6;padding:6px 10px;text-align:right}
th:first-child,td:first-child{text-align:left}
th{background:#eef3fb}
img{max-width:520px;border:1px solid #d8dee6;border-radius:6px;margin:6px 14px 6px 0;background:#fff}
.shots{display:flex;flex-wrap:wrap}.shot{margin-right:18px}.shot figcaption{font-size:12px;color:#555}
.bad{color:#c0392b;font-weight:600}.ok{color:#1e8449;font-weight:600}
code{background:#eef0f3;padding:1px 5px;border-radius:4px}
</style></head><body>`);
    parts.push(`<h1>游戏提示可辨认性检查报告</h1>
<p>导出时间：${esc(new Date().toLocaleString())}　画面尺寸：${payload.scene.W}×${payload.scene.H}　背景：${esc(payload.scene.backgroundName || '-')}</p>`);

    if (images && images.length) {
      parts.push('<h2>画面对比（含位置）</h2><div class="shots">');
      for (const im of images) {
        parts.push(`<figure class="shot"><img src="${im.dataUrl}" alt="${esc(im.caption)}">
<figcaption>${esc(im.caption)}</figcaption></figure>`);
      }
      parts.push('</div>');
    }

    for (const m of payload.modes) {
      parts.push(`<h2>视图模式：${esc(m.label || m.mode)}</h2>`);
      parts.push('<table><tr><th>提示</th><th>类别</th><th>样本数</th><th>均值ΔE</th><th>P5</th><th>最小ΔE</th><th>WCAG对比(不透明)</th><th>ΔE&lt;5占比</th></tr>');
      for (const r of m.iconResults) {
        const name = payload.scene.icons.find(i => i.id === r.iconId)?.name || r.iconId;
        for (const cls of [['full', '不透明'], ['edge', '半透明边缘']]) {
          const s = r.summary[cls[0]];
          if (!s || !s.count) continue;
          const rate = r.thresholds.lt5;
          parts.push(`<tr><td>${esc(name)}</td><td>${cls[1]}</td><td>${s.count}</td>
<td class="${s.mean < 5 ? 'bad' : 'ok'}">${round(s.mean)}</td>
<td>${round(s.p5)}</td><td>${round(s.min)}</td>
<td>${cls[0] === 'full' ? round(r.summary.contrastFull.min) : '—'}</td>
<td class="${rate > 0.1 ? 'bad' : ''}">${round(rate * 100, 1)}%</td></tr>`);
        }
      }
      parts.push('</table>');
      if (m.pairResults && m.pairResults.length) {
        parts.push('<table><tr><th>提示对</th><th>重叠像素</th><th>边缘间距px</th><th>均值ΔE</th><th>最小ΔE</th><th>ΔE&lt;5占比</th></tr>');
        for (const r of m.pairResults) {
          const nm = (id) => payload.scene.icons.find(i => i.id === id)?.name || id;
          const s = r.full.count ? r.full : r.edge;
          parts.push(`<tr><td>${esc(nm(r.iconA))} × ${esc(nm(r.iconB))}</td>
<td>${r.overlapCount}</td><td>${r.minGap == null ? '重叠' : round(r.minGap, 1)}</td>
<td class="${s.mean < 5 ? 'bad' : 'ok'}">${round(s.mean)}</td><td>${round(s.min)}</td>
<td class="${r.thresholds.lt5 > 0.1 ? 'bad' : ''}">${round(r.thresholds.lt5 * 100, 1)}%</td></tr>`);
        }
        parts.push('</table>');
      }
    }

    if (payload.scans && payload.scans.length) {
      parts.push('<h2>最难分辨位置扫描</h2><table><tr><th>提示</th><th>模式</th><th>最难位置(x,y)</th><th>该处均值ΔE</th><th>最易位置(x,y)</th><th>该处均值ΔE</th></tr>');
      for (const s of payload.scans) {
        const name = payload.scene.icons.find(i => i.id === s.iconId)?.name || s.iconId;
        parts.push(`<tr><td>${esc(name)}</td><td>${esc(s.mode)}</td>
<td class="bad">(${s.hardest.x}, ${s.hardest.y})</td><td class="bad">${round(s.hardest.score)}</td>
<td class="ok">(${s.easiest.x}, ${s.easiest.y})</td><td class="ok">${round(s.easiest.score)}</td></tr>`);
      }
      parts.push('</table>');
    }

    if (payload.snapshots && payload.snapshots.length) {
      parts.push('<h2>改色 / 加符号前后记录</h2>');
      for (const sp of payload.snapshots) {
        parts.push(`<p><b>${esc(sp.label)}</b>（${esc(sp.createdAt)}）：${esc(sp.headline || '')}</p>`);
      }
    }
    parts.push('<p style="color:#777;font-size:12px;margin-top:32px">ΔE 为 CIEDE2000 色差（扫描默认 ΔE76 快速指标）；ΔE&lt;5 通常难以辨认，&gt;10 一般可清晰分辨。</p>');
    parts.push('</body></html>');
    downloadBlob(new Blob([parts.join('')], { type: 'text/html' }),
      filename || 'legibility-report.html');
  }

  return { downloadBlob, downloadCanvas, buildJSON, exportJSON, exportHTML, round };
});
