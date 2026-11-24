/**
 * 两八度屏幕键盘（C3–B4 + 最高到 C5/E5 选样可见），
 * 同时支持鼠标/触摸与电脑键盘。
 */
import { midiToName } from '../audio/notes.ts';
import { h } from './dom.ts';

const WHITE_PATTERN = [0, 2, 4, 5, 7, 9, 11];

/** 电脑键盘 -> MIDI，白键下排、黑键上排，覆盖 C3–E5 */
const KEY_MAP: Record<string, number> = {
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59,
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71,
  i: 72, '9': 73, o: 74, '0': 75, p: 76,
};
const LABEL_BY_NOTE = new Map<number, string>();
for (const [label, note] of Object.entries(KEY_MAP)) LABEL_BY_NOTE.set(note, label.toUpperCase());

export interface KeyboardHandlers {
  onNoteOn: (note: number) => void;
  onNoteOff: (note: number) => void;
}

export class KeyboardView {
  readonly el: HTMLElement;
  private readonly keys = new Map<number, HTMLElement>();
  private readonly pointerNotes = new Map<number, number>();
  private readonly handlers: KeyboardHandlers;
  private active = new Set<number>();

  constructor(lowMidi: number, highMidi: number, handlers: KeyboardHandlers) {
    this.handlers = handlers;
    this.el = h('div', { class: 'keyboard-inner' });
    const whiteWrap = h('div', { class: 'white-row' });
    const blackWrap = h('div', { class: 'black-row' });

    let whiteIndex = 0;
    for (let note = lowMidi; note <= highMidi; note++) {
      const pc = note % 12;
      const isBlack = !WHITE_PATTERN.includes(pc);
      const key = h(
        'div',
        { class: `key ${isBlack ? 'black-key' : 'white-key'}`, dataset: { note: String(note) } },
        [
          h('span', { class: 'key-label' }, [LABEL_BY_NOTE.get(note) ?? '']),
          h('span', { class: 'key-name' }, [midiToName(note)]),
        ],
      );
      this.keys.set(note, key);
      if (isBlack) {
        // 黑键压在前一个白键右侧
        const left = ((whiteIndex - 0.65) / this.whiteCount(lowMidi, highMidi)) * 100;
        key.style.left = `${left}%`;
        blackWrap.append(key);
      } else {
        whiteWrap.append(key);
        whiteIndex++;
      }
    }
    this.el.append(whiteWrap, blackWrap);
    this.bindPointer();
    this.bindComputerKeyboard();
  }

  private whiteCount(low: number, high: number): number {
    let n = 0;
    for (let note = low; note <= high; note++) {
      if (WHITE_PATTERN.includes(note % 12)) n++;
    }
    return n;
  }

  private bindPointer(): void {
    this.el.addEventListener('pointerdown', (ev) => {
      const keyEl = (ev.target as HTMLElement).closest('[data-note]') as HTMLElement | null;
      if (!keyEl) return;
      const note = Number(keyEl.dataset.note);
      ev.preventDefault();
      keyEl.setPointerCapture(ev.pointerId);
      this.pointerNotes.set(ev.pointerId, note);
      this.handlers.onNoteOn(note);
    });
    this.el.addEventListener('pointerup', (ev) => {
      const note = this.pointerNotes.get(ev.pointerId);
      if (note !== undefined) {
        this.pointerNotes.delete(ev.pointerId);
        this.handlers.onNoteOff(note);
      }
    });
    this.el.addEventListener('pointercancel', (ev) => {
      const note = this.pointerNotes.get(ev.pointerId);
      if (note !== undefined) {
        this.pointerNotes.delete(ev.pointerId);
        this.handlers.onNoteOff(note);
      }
    });
  }

  private bindComputerKeyboard(): void {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      if (el.isContentEditable) return true;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
      if (el.tagName === 'INPUT') {
        // range/button/checkbox 等不接收字符输入，不应吞掉琴键
        const textTypes = ['text', 'search', 'email', 'password', 'url', 'tel', 'number'];
        return textTypes.includes((el as HTMLInputElement).type);
      }
      return false;
    };
    window.addEventListener('keydown', (ev) => {
      if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      const note = KEY_MAP[ev.key.toLowerCase()];
      if (note === undefined || !this.keys.has(note)) return;
      ev.preventDefault();
      this.handlers.onNoteOn(note);
    });
    window.addEventListener('keyup', (ev) => {
      const note = KEY_MAP[ev.key.toLowerCase()];
      if (note === undefined) return;
      this.handlers.onNoteOff(note);
    });
    // 窗口失焦时抬起所有键，避免“键卡住”
    window.addEventListener('blur', () => {
      for (const note of this.active) this.handlers.onNoteOff(note);
    });
  }

  setActive(note: number, on: boolean): void {
    const key = this.keys.get(note);
    if (!key) return;
    key.classList.toggle('pressed', on);
    if (on) this.active.add(note);
    else this.active.delete(note);
  }

  /** 在琴键上短暂显示实际命中的样本根音 */
  flashUsedSample(note: number, label: string): void {
    const key = this.keys.get(note);
    if (!key) return;
    const tag = key.querySelector('.key-used') ?? h('span', { class: 'key-used' });
    tag.textContent = label;
    key.append(tag);
    setTimeout(() => tag.remove(), 2200);
  }

  markFault(note: number): void {
    const key = this.keys.get(note);
    key?.classList.add('fault');
  }
}
