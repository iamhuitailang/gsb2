/* 项目数据模型、意见 CRUD、本地持久化。
 * 完整项目通过「保存项目」下载为 .vrs.json；
 * 工作过程中自动把不含缩略图的精简快照写入 localStorage，防止刷新丢失。 */
'use strict';

const SCHEMA_VERSION = 1;
const AUTOSAVE_KEY = 'videoReviewStation.autosave.v1';

function createComment(partial) {
  const now = Date.now();
  return {
    id: uid('cmt'),
    startFrame: 0,
    endFrame: null,                 // null = 点意见；数字 = 时间段意见
    rect: null,                     // {x,y,w,h} 归一化坐标 0..1
    text: '',
    author: '审阅人',
    status: 'open',                 // open | done | needs-confirm
    createdAt: now,
    updatedAt: now,
    thumbnail: null,                // { dataUrl, capturedAtFrame }
    history: [],                    // 历次修订迁移记录
    ...partial,
  };
}

class Store extends EventTarget {
  constructor() {
    super();
    this.state = this._blankState();
  }

  _blankState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: uid('prj'),
      name: '未命名审片项目',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      media: null,                  // 当前素材信息
      fps: 30,
      comments: [],
      revisions: [],
    };
  }

  reset() {
    this.state = this._blankState();
    this.emit();
  }

  emit() {
    this.state.updatedAt = Date.now();
    this.dispatchEvent(new CustomEvent('change'));
    this.autosave();
  }

  /* ---------- 素材 ---------- */

  setMedia(media) {
    this.state.media = media;
    if (media.fps) this.state.fps = media.fps;
    this.emit();
  }

  setFps(fps) {
    this.state.fps = fps;
    this.emit();
  }

  /* ---------- 意见 ---------- */

  getComment(id) {
    return this.state.comments.find((c) => c.id === id);
  }

  addComment(partial) {
    const c = createComment(partial);
    this.state.comments.push(c);
    this.emit();
    return c;
  }

  updateComment(id, patch) {
    const c = this.getComment(id);
    if (!c) return;
    Object.assign(c, patch, { updatedAt: Date.now() });
    this.emit();
  }

  removeComment(id) {
    this.state.comments = this.state.comments.filter((c) => c.id !== id);
    this.emit();
  }

  sortedComments() {
    return [...this.state.comments].sort((a, b) => {
      if (a.startFrame !== b.startFrame) return a.startFrame - b.startFrame;
      if ((a.endFrame ?? a.startFrame) !== (b.endFrame ?? b.startFrame)) {
        return (a.endFrame ?? a.startFrame) - (b.endFrame ?? b.startFrame);
      }
      return a.createdAt - b.createdAt;
    });
  }

  /** 当前帧可见（点意见命中该帧；时间段覆盖该帧） */
  visibleAtFrame(frame) {
    return this.state.comments.filter(
      (c) => frame >= c.startFrame && frame <= (c.endFrame ?? c.startFrame),
    );
  }

  /* ---------- 修订记录 ---------- */

  addRevision(record) {
    this.state.revisions.push(record);
    this.emit();
  }

  /** 替换素材并应用帧映射；mappings: [{commentId, newStart, newEnd, confidence, method}] */
  applyRevision({ newMedia, mappings, methodInfo }) {
    const oldMedia = this.state.media
      ? { name: this.state.media.name, hash: this.state.media.hash, frameCount: this.state.media.frameCount }
      : null;
    const revisionId = uid('rev');
    const now = Date.now();

    for (const m of mappings) {
      const c = this.getComment(m.commentId);
      if (!c) continue;
      c.history.push({
        revisionId,
        oldStartFrame: c.startFrame,
        oldEndFrame: c.endFrame,
        newStartFrame: m.newStart,
        newEndFrame: m.newEnd,
        confidence: m.confidence,
        method: m.method,
        confirmed: false,
        createdAt: now,
      });
      c.startFrame = m.newStart;
      c.endFrame = m.newEnd;
      // 匹配不可靠或帧落在新增/删除区间 → 待人工确认（已完成的也回到确认态）
      c.status = m.confidence >= 0.85 ? (c.status === 'done' ? 'done' : 'open') : 'needs-confirm';
      // 时间点变了，旧缩略图只作历史参考，标记需要重新截图
      c.thumbnail = c.thumbnail ? { ...c.thumbnail, stale: true } : null;
      c.updatedAt = now;
    }

    this.state.revisions.push({
      id: revisionId,
      createdAt: now,
      method: methodInfo,
      from: oldMedia,
      to: { name: newMedia.name, hash: newMedia.hash, frameCount: newMedia.frameCount, size: newMedia.size },
    });
    this.setMedia(newMedia);
  }

  confirmMapping(commentId) {
    const c = this.getComment(commentId);
    if (!c || !c.history.length) return;
    c.history[c.history.length - 1].confirmed = true;
    if (c.status === 'needs-confirm') c.status = 'open';
    this.emit();
  }

  /* ---------- 序列化 ---------- */

  toJSON(includeThumbnails = true) {
    const data = structuredClone(this.state);
    if (!includeThumbnails) {
      for (const c of data.comments) c.thumbnail = null;
    }
    return data;
  }

  loadJSON(data) {
    if (!data || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.comments)) {
      throw new Error('项目文件格式不正确（schema 版本不匹配或缺少 comments）');
    }
    this.state = {
      ...this._blankState(),
      ...data,
      // 防御性补齐字段
      comments: data.comments.map((c) => createComment(c)),
      revisions: Array.isArray(data.revisions) ? data.revisions : [],
    };
    this.emit();
  }

  autosave() {
    try {
      const slim = this.toJSON(false);
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(slim));
    } catch (err) {
      console.warn('自动保存失败（localStorage 配额？）', err);
    }
  }

  loadAutosave() {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    try {
      this.loadJSON(JSON.parse(raw));
      return true;
    } catch (err) {
      console.warn('自动保存快照损坏，已忽略', err);
      return false;
    }
  }

  clearAutosave() {
    localStorage.removeItem(AUTOSAVE_KEY);
  }
}
