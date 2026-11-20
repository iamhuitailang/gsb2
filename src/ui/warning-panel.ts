// 读取警告列表：按级别着色，展示具体文件、行号与原始内容

import type { ParseWarning } from '../core/types';
import { clear, h } from './dom';

export interface WarningCallbacks {
  onLocate?: (warning: ParseWarning) => void;
}

export class WarningPanel {
  constructor(
    private container: HTMLElement,
    private summary: HTMLElement,
    private callbacks: WarningCallbacks = {},
  ) {}

  update(warnings: ParseWarning[]): void {
    clear(this.container);
    const errors = warnings.filter((w) => w.level === 'error').length;
    this.summary.textContent = warnings.length === 0
      ? '无警告'
      : `${warnings.length} 条${errors > 0 ? `（${errors} 错误）` : ''}`;

    if (warnings.length === 0) {
      this.container.append(
        h('div', { className: 'empty-hint', textContent: '模型读取完成，未发现问题。' }),
      );
      return;
    }

    for (const w of warnings) {
      const location = `${w.file}${w.line !== null ? `:${w.line}` : ''}`;
      const row = h('div', {
        className: `warning-row warning-${w.level}`,
        title: w.raw ? `原始内容：${w.raw}` : '点击查看详情',
      });
      row.append(
        h('div', { className: 'warning-head' },
          h('span', { className: 'warning-code', textContent: w.code }),
          h('span', { className: 'warning-loc', textContent: location }),
        ),
        h('div', { className: 'warning-message', textContent: w.message }),
      );
      if (w.raw) {
        row.append(h('div', { className: 'warning-raw', textContent: w.raw }));
      }
      if (this.callbacks.onLocate) {
        row.addEventListener('click', () => this.callbacks.onLocate!(w));
      }
      this.container.append(row);
    }
  }
}
