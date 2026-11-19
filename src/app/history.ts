import type { Project } from '../core/types.ts';

interface Snapshot {
  project: Project;
  label: string;
}

const LIMIT = 40;

/** 简单的工程级撤销栈：每次「提交型」修改压入一个快照。 */
export class History {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private current: Snapshot;

  constructor(project: Project) {
    this.current = { project: structuredClone(project), label: '初始状态' };
  }

  push(project: Project, label: string) {
    this.past.push(this.current);
    if (this.past.length > LIMIT) this.past.shift();
    this.current = { project: structuredClone(project), label };
    this.future = [];
  }

  undo(): Project | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(this.current);
    this.current = previous;
    return structuredClone(previous.project);
  }

  redo(): Project | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.current);
    this.current = next;
    return structuredClone(next.project);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  reset(project: Project) {
    this.past = [];
    this.future = [];
    this.current = { project: structuredClone(project), label: '重载' };
  }

  get label(): string {
    return this.current.label;
  }
}
