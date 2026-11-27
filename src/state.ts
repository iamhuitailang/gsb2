import type { Deck } from './types';
import { cloneDefaultDecks } from './defaultDecks';
import { cloneDeck } from './deckUtils';

const STORAGE_KEY = 'diamond-deck-lab-state-v1';

interface PersistShape {
  decks: Deck[];
  selectedDeckId: string;
}

interface Listener {
  (): void;
}

function load(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.decks) && parsed.decks.length > 0) {
        return { decks: parsed.decks, selectedDeckId: parsed.selectedDeckId ?? parsed.decks[0].id };
      }
    }
  } catch {
    // file:// 或隐私模式下 localStorage 可能不可用，退回内存态
  }
  const decks = cloneDefaultDecks();
  return { decks, selectedDeckId: decks[0].id };
}

class Store {
  decks: Deck[];
  selectedDeckId: string;
  private listeners = new Set<Listener>();

  constructor() {
    const s = load();
    this.decks = s.decks;
    this.selectedDeckId = s.selectedDeckId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.persist();
    this.listeners.forEach((fn) => fn());
  }

  private persist() {
    try {
      const data: PersistShape = { decks: this.decks, selectedDeckId: this.selectedDeckId };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 忽略写入失败 */
    }
  }

  get selectedDeck(): Deck {
    return this.decks.find((d) => d.id === this.selectedDeckId) ?? this.decks[0];
  }

  select(id: string) {
    this.selectedDeckId = id;
    this.emit();
  }

  /** 在选中牌组的可变克隆上修改并提交 */
  updateSelected(mutator: (d: Deck) => void) {
    const idx = this.decks.findIndex((d) => d.id === this.selectedDeckId);
    if (idx < 0) return;
    const copy = cloneDeck(this.decks[idx]);
    mutator(copy);
    this.decks[idx] = copy;
    this.emit();
  }

  replaceDeck(id: string, next: Deck) {
    const idx = this.decks.findIndex((d) => d.id === id);
    if (idx >= 0) this.decks[idx] = next;
    else this.decks.push(next);
    this.selectedDeckId = next.id;
    this.emit();
  }

  addDeck(deck: Deck, select = true) {
    this.decks.push(deck);
    if (select) this.selectedDeckId = deck.id;
    this.emit();
  }

  deleteDeck(id: string) {
    if (this.decks.length <= 1) return;
    const idx = this.decks.findIndex((d) => d.id === id);
    if (idx < 0) return;
    this.decks.splice(idx, 1);
    if (this.selectedDeckId === id) this.selectedDeckId = this.decks[0].id;
    this.emit();
  }

  resetAll() {
    this.decks = cloneDefaultDecks();
    this.selectedDeckId = this.decks[1]?.id ?? this.decks[0].id; // 默认落在交换示例牌组
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
    this.emit();
  }
}

export const store = new Store();
