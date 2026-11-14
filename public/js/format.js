// 展示层格式化。分转元用字符串拼接，避免浮点显示误差。

export function fenToYuan(fen) {
  if (fen === null || fen === undefined) return '—';
  const n = Math.trunc(fen);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

export const CATEGORY_LABEL = {
  billed: '计费',
  cancelled: '已撤销',
  missing_rate: '缺费率',
  error: '数据异常',
};

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
