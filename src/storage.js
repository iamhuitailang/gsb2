const STORAGE_KEY = 'wiring-signal-lab:project:v1';

export function loadStoredProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.graph || !Array.isArray(parsed.graph.components)) {
      return null;
    }
    parsed.runs ??= [];
    parsed.graph.connections ??= [];
    parsed.graph.notes ??= [];
    return parsed;
  } catch (error) {
    console.warn('无法读取本地工程', error);
    return null;
  }
}

export function saveStoredProject(project) {
  try {
    project.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    return { ok: true, savedAt: new Date(project.updatedAt) };
  } catch (error) {
    console.warn('保存工程失败', error);
    return { ok: false, error };
  }
}

export function clearStoredProject() {
  localStorage.removeItem(STORAGE_KEY);
}
