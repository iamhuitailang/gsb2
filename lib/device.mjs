const BROWSER_RULES = [
  [/Edg\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Chrome\//, 'Chrome'],
  [/Firefox\//, 'Firefox'],
  [/Safari\//, 'Safari'],
];

export function detectBrowser(userAgent = '') {
  for (const [pattern, name] of BROWSER_RULES) {
    if (pattern.test(userAgent)) return name;
  }
  return '浏览器';
}

export function detectOs(userAgent = '') {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return '未知系统';
}

export function detectKind(userAgent = '') {
  if (/iPad|Tablet/.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|Android.*Mobile/.test(userAgent)) return 'mobile';
  return 'desktop';
}

export function defaultDeviceName(userAgent = '') {
  return `${detectOs(userAgent)} 上的 ${detectBrowser(userAgent)}`;
}

export function deviceSummary(session) {
  const browser = detectBrowser(session.userAgent);
  const os = detectOs(session.userAgent);
  return `${os} · ${browser}`;
}

export function kindLabel(kind) {
  return { desktop: '电脑', mobile: '手机', tablet: '平板' }[kind] ?? '设备';
}
