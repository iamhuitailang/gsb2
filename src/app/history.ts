export interface HistoryEntry<T> {
  label: string;
  snapshot: T;
}

/**
 * Snapshot-based undo/redo. Snapshots are plain JSON so state is fully
 * reproducible and cannot alias live editor objects.
 */
export class History<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];
  private readonly limit: number;
  private readonly serialize: (value: T) => T;

  constructor(limit = 80, serialize: (value: T) => T = (v) => JSON.parse(JSON.stringify(v)) as T) {
    this.limit = limit;
    this.serialize = serialize;
  }

  push(label: string, snapshot: T): void {
    this.undoStack.push({ label, snapshot: this.serialize(snapshot) });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: T): HistoryEntry<T> | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push({ label: entry.label, snapshot: this.serialize(current) });
    return entry;
  }

  redo(current: T): HistoryEntry<T> | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push({ label: entry.label, snapshot: this.serialize(current) });
    return entry;
  }

  /** Drops the last undo entry without touching redo (used when a mutation
   * turns out to be a no-op). */
  discardLast(): void {
    this.undoStack.pop();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }

  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  /** Snapshot equality helper so callers can skip no-op history entries. */
  static same<T>(a: T, b: T): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
