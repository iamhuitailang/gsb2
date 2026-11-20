import type { Project, SceneObjectData } from '../core/types.js';

export function findTargetObject(project: Project): SceneObjectData | undefined {
  return project.objects.find((o) => o.role === 'target') ?? project.objects[0];
}

/** Objects offered in the "follow target" picker: named/target objects first. */
export function targetCandidates(project: Project): SceneObjectData[] {
  const named = project.objects.filter(
    (o) => o.role === 'target' || o.id.startsWith('hero') || o.id.startsWith('colonnade') || o.id.startsWith('beacon'),
  );
  const pool = named.length > 0 ? named : project.objects;
  return [...pool].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'target' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function projectSummary(project: Project): string {
  const keys = project.timeline.keys.length;
  const points = project.path.points.length;
  const closed = project.path.closed ? '闭合' : '开放';
  return `${points} 控制点 · ${closed} · ${keys} 关键点 · ${project.timeline.fps}fps`;
}
