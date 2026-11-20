import { h } from './dom';

/**
 * 零依赖的代码编辑器：
 * - 透明 textarea 叠加在等宽高亮层上（本项目只做错误行高亮，够用且稳定）
 * - 左侧行号槽，编译错误的行号标红并可点击跳转
 * - 支持 Tab 缩进、Cmd/Ctrl+S 拦截
 */
export class CodeEditor {
  readonly element: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private gutter: HTMLElement;
  private errorLines = new Set<number>();
  private saveHandler: (() => void) | null = null;
  private changeHandler: ((value: string) => void) | null = null;

  constructor() {
    this.gutter = h('div', { className: 'editor-gutter', 'aria-hidden': 'true' });
    this.textarea = h('textarea', {
      className: 'editor-textarea',
      spellcheck: 'false',
      wrap: 'off',
    }) as HTMLTextAreaElement;
    this.element = h('div', { className: 'editor' }, [this.gutter, this.textarea]);

    this.textarea.addEventListener('input', () => {
      this.renderGutter();
      this.changeHandler?.(this.textarea.value);
    });
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (e) => this.onKeyDown(e as KeyboardEvent));
  }

  get value(): string {
    return this.textarea.value;
  }

  setValue(value: string) {
    this.textarea.value = value;
    this.renderGutter();
  }

  onChange(fn: (value: string) => void) {
    this.changeHandler = fn;
  }

  onSave(fn: () => void) {
    this.saveHandler = fn;
  }

  /** 标记错误行（1 起始行号）；传空集合清除标记 */
  setErrorLines(lines: number[]) {
    this.errorLines = new Set(lines);
    this.renderGutter();
  }

  /** 滚动并聚焦到指定行 */
  goToLine(line: number) {
    const lines = this.textarea.value.split('\n');
    const before = lines.slice(0, Math.max(0, line - 1)).join('\n');
    const lineHeight = parseFloat(getComputedStyle(this.textarea).lineHeight) || 16;
    this.textarea.focus();
    this.textarea.setSelectionRange(before.length, before.length);
    this.textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
    this.syncScroll();
  }

  focus() {
    this.textarea.focus();
  }

  private onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.saveHandler?.();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: start, selectionEnd: end } = this.textarea;
      const value = this.textarea.value;
      this.textarea.value = value.slice(0, start) + '  ' + value.slice(end);
      this.textarea.selectionStart = this.textarea.selectionEnd = start + 2;
      this.renderGutter();
      this.changeHandler?.(this.textarea.value);
    }
  }

  private syncScroll() {
    this.gutter.scrollTop = this.textarea.scrollTop;
  }

  private renderGutter() {
    const lineCount = this.textarea.value.split('\n').length;
    this.gutter.replaceChildren();
    for (let i = 1; i <= lineCount; i++) {
      const cls = this.errorLines.has(i) ? 'gutter-line gutter-line-error' : 'gutter-line';
      const line = h('div', { className: cls, textContent: String(i) });
      if (this.errorLines.has(i)) {
        line.addEventListener('click', () => this.goToLine(i));
        line.title = '点击跳转到错误行';
      }
      this.gutter.append(line);
    }
    this.syncScroll();
  }
}
