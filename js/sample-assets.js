/* 示例工程使用的本地素材（内联为 dataURL，工程保存时会一并打包；
   同名源文件也放在 assets/ 目录，可自由替换） */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});

  const badgeSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7ea0ff"/>
      <stop offset="0.55" stop-color="#6e6bff"/>
      <stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#d9e2ff"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="220" height="220" rx="58" fill="url(#bg)"/>
  <rect x="10" y="10" width="220" height="220" rx="58" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="3"/>
  <circle cx="182" cy="58" r="16" fill="#37d4e8" opacity="0.95"/>
  <path d="M78 168 L78 74 L104 74 L120 116 L136 74 L162 74 L162 168 L138 168 L138 112 L126 146 L114 146 L102 112 L102 168 Z" fill="url(#mark)"/>
  <path d="M60 60 l10 22 22 10 -22 10 -10 22 -10 -22 -22 -10 22 -10 z" fill="#ffce54"/>
</svg>`;

  const sparkSVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <defs>
    <radialGradient id="g" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#fff3c4"/>
      <stop offset="0.55" stop-color="#ffce54"/>
      <stop offset="1" stop-color="#ff8a3d"/>
    </radialGradient>
  </defs>
  <path d="M80 8 C88 52 108 72 152 80 C108 88 88 108 80 152 C72 108 52 88 8 80 C52 72 72 52 80 8 Z" fill="url(#g)"/>
</svg>`;

  function toDataURL(svg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  G.SampleAssets = {
    badge: toDataURL(badgeSVG),
    spark: toDataURL(sparkSVG),
    sources: { 'logo-badge.svg': badgeSVG, 'spark.svg': sparkSVG },
  };
})();
