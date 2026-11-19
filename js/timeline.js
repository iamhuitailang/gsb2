/* 时间线：帧标尺、关键帧轨道、播放控制、帧率/循环设置 */
(function (global) {
  'use strict';

  const FRAME_PX = 14;
  let app = null;
  let els = {};
  let dragState = null; // {kind:'playhead'|'key', boneId, startFrame}

  function init(context) {
    app = context;
    els = {
      ruler: document.getElementById('ruler'),
      tracks: document.getElementById('tracks'),
      trackHead: document.getElementById('trackHead'),
      btnPlay: document.getElementById('btnPlay'),
      btnPrev: document.getElementById('btnPrevFrame'),
      btnNext: document.getElementById('btnNextFrame'),
      btnFirst: document.getElementById('btnFirstFrame'),
      btnLast: document.getElementById('btnLastFrame'),
      btnAddKey: document.getElementById('btnAddKey'),
      btnDelKey: document.getElementById('btnDelKey'),
      frameInput: document.getElementById('frameInput'),
      fpsInput: document.getElementById('fpsInput'),
      frameCountInput: document.getElementById('frameCountInput'),
      loopCheck: document.getElementById('loopCheck'),
      easingSelect: document.getElementById('easingSelect'),
      onionBefore: document.getElementById('onionBefore'),
      onionAfter: document.getElementById('onionAfter'),
    };

    els.ruler.addEventListener('pointerdown', onRulerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    els.btnPlay.addEventListener('click', () => app.togglePlay());
    els.btnPrev.addEventListener('click', () => app.seek(app.state.frame - 1));
    els.btnNext.addEventListener('click', () => app.seek(app.state.frame + 1));
    els.btnFirst.addEventListener('click', () => app.seek(0));
    els.btnLast.addEventListener('click', () => {
      const a = app.activeAnim();
      if (a) app.seek(a.frameCount - 1);
    });
    els.btnAddKey.addEventListener('click', () => app.addKeyAtCurrent());
    els.btnDelKey.addEventListener('click', () => app.deleteKeyAtCurrent());

    els.frameInput.addEventListener('change', () => app.seek(parseInt(els.frameInput.value, 10) - 1 || 0));
    els.fpsInput.addEventListener('change', () => {
      const a = app.activeAnim();
      if (!a) return;
      const v = global.Math2D.clamp(parseInt(els.fpsInput.value, 10) || 24, 1, 120);
      app.updateAnimSettings({ frameRate: v });
    });
    els.frameCountInput.addEventListener('change', () => {
      const a = app.activeAnim();
      if (!a) return;
      const v = global.Math2D.clamp(parseInt(els.frameCountInput.value, 10) || 24, 1, 600);
      app.updateAnimSettings({ frameCount: v });
    });
    els.loopCheck.addEventListener('change', () => app.updateAnimSettings({ loop: els.loopCheck.checked }));
    els.easingSelect.addEventListener('change', () => app.setCurrentKeyEasing(els.easingSelect.value));
    els.onionBefore.addEventListener('change', () => { app.state.onionBefore = parseInt(els.onionBefore.value, 10) || 0; app.refresh(); });
    els.onionAfter.addEventListener('change', () => { app.state.onionAfter = parseInt(els.onionAfter.value, 10) || 0; app.refresh(); });
  }

  function frameFromEvent(e) {
    const rect = els.ruler.getBoundingClientRect();
    return Math.round((e.clientX - rect.left) / FRAME_PX);
  }

  function onRulerDown(e) {
    const anim = app.activeAnim();
    if (!anim) return;
    const frame = global.Math2D.clamp(frameFromEvent(e), 0, anim.frameCount - 1);
    // x 方向容差 1 帧内存在任意关键帧，则进入关键帧拖动
    const hit = findAnyKeyNear(anim, frame);
    if (hit) {
      dragState = { kind: 'key', constraintId: hit.constraintId, boneId: hit.boneId, startFrame: frame };
      app.beginKeyMove();
      app.seek(frame);
    } else {
      dragState = { kind: 'playhead' };
      app.seek(frame);
    }
  }

  function findAnyKeyNear(anim, frame) {
    const rows = collectKeyRows(anim);
    for (const row of rows) {
      if (row.keys.some((k) => k.frame === frame)) return row;
    }
    for (const row of rows) {
      if (row.keys.some((k) => Math.abs(k.frame - frame) <= 1)) return row;
    }
    return null;
  }

  function collectKeyRows(anim) {
    const rows = [];
    for (const bone of app.project.bones) {
      const keys = anim.keys[bone.id] || [];
      if (keys.length) rows.push({ boneId: bone.id, constraintId: null, keys });
    }
    for (const c of app.project.ik) {
      const keys = anim.ikKeys[c.id] || [];
      if (keys.length) rows.push({ boneId: null, constraintId: c.id, keys });
    }
    return rows;
  }

  function onPointerMove(e) {
    if (!dragState) return;
    const anim = app.activeAnim();
    if (!anim) return;
    const frame = global.Math2D.clamp(frameFromEvent(e), 0, anim.frameCount - 1);
    if (dragState.kind === 'playhead') {
      app.seek(frame);
    } else if (dragState.kind === 'key' && frame !== dragState.startFrame) {
      app.moveKey(dragState.boneId, dragState.constraintId, dragState.startFrame, frame);
      dragState.startFrame = frame;
    }
  }

  function onPointerUp() {
    if (dragState && dragState.kind === 'key') app.commitKeyMove();
    dragState = null;
  }

  /** 左侧轨道头 + 右侧关键帧整体重绘 */
  function render() {
    const anim = app.activeAnim();
    if (!anim) {
      els.trackHead.innerHTML = '<div class="track-empty">暂无动作</div>';
      els.tracks.innerHTML = '';
      drawRuler(null);
      syncControls(null);
      return;
    }
    syncControls(anim);
    renderTracks(anim);
    drawRuler(anim);
  }

  function syncControls(anim) {
    els.frameInput.value = anim ? app.state.frame + 1 : 0;
    els.fpsInput.value = anim ? anim.frameRate : 24;
    els.frameCountInput.value = anim ? anim.frameCount : 24;
    els.loopCheck.checked = anim ? anim.loop : true;
    // 当前帧选中骨骼关键帧的缓动
    const sel = app.state.selection;
    let easing = 'linear';
    if (anim && sel && sel.kind === 'bone') {
      const k = (anim.keys[sel.id] || []).find((kk) => kk.frame === app.state.frame);
      if (k) easing = k.easing || 'linear';
    }
    els.easingSelect.value = easing;
    els.btnPlay.textContent = app.state.playing ? '⏸ 暂停' : '▶ 播放';
  }

  function renderTracks(anim) {
    const rows = [];
    for (const bone of app.project.bones) {
      rows.push({
        id: bone.id, kind: 'bone', label: '🦴 ' + bone.name,
        keys: anim.keys[bone.id] || [],
      });
    }
    for (const c of app.project.ik) {
      rows.push({
        id: c.id, kind: 'ik', label: '🎯 ' + c.name + (c.enabled ? '' : '（停用）'),
        keys: anim.ikKeys[c.id] || [],
      });
    }

    els.trackHead.innerHTML = rows.map((r) => {
      const sel = app.state.selection && app.state.selection.id === r.id;
      return `<div class="track-row ${sel ? 'sel' : ''}" data-id="${r.id}" data-kind="${r.kind}">${r.label}</div>`;
    }).join('') || '<div class="track-empty">无骨骼</div>';

    els.tracks.innerHTML = rows.map((r) => {
      const diamonds = r.keys.map((k) => {
        const cur = k.frame === app.state.frame;
        return `<span class="key-diamond ${cur ? 'cur' : ''}" style="left:${k.frame * FRAME_PX + FRAME_PX / 2 - 6}px"
          data-frame="${k.frame}" data-id="${r.id}" data-kind="${r.kind}"></span>`;
      }).join('');
      return `<div class="track-line" data-id="${r.id}" data-kind="${r.kind}">${diamonds}</div>`;
    }).join('');

    els.trackHead.querySelectorAll('.track-row').forEach((node) => {
      node.addEventListener('click', () => {
        app.select({ kind: node.dataset.kind, id: node.dataset.id });
      });
    });
    els.tracks.querySelectorAll('.track-line').forEach((node) => {
      node.addEventListener('click', (e) => {
        app.select({ kind: node.dataset.kind, id: node.dataset.id });
        const rect = node.getBoundingClientRect();
        const frame = Math.round((e.clientX - rect.left) / FRAME_PX);
        app.seek(global.Math2D.clamp(frame, 0, anim.frameCount - 1));
      });
    });
    els.tracks.querySelectorAll('.key-diamond').forEach((node) => {
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        app.select({ kind: node.dataset.kind, id: node.dataset.id });
        app.seek(parseInt(node.dataset.frame, 10));
      });
    });

    els.tracks.style.width = anim.frameCount * FRAME_PX + 'px';
    els.ruler.style.width = anim.frameCount * FRAME_PX + 'px';
  }

  function drawRuler(anim) {
    const canvas = els.ruler;
    const dpr = window.devicePixelRatio || 1;
    const w = anim ? anim.frameCount * FRAME_PX : canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!anim) return;

    // 帧刻度
    ctx.strokeStyle = '#2c3e5a';
    ctx.fillStyle = '#8fa6c4';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let f = 0; f < anim.frameCount; f += 1) {
      const x = f * FRAME_PX;
      ctx.beginPath();
      ctx.moveTo(x, h - 6);
      ctx.lineTo(x, h - (f % 5 === 0 ? 14 : 9));
      ctx.stroke();
      if (f % 5 === 0) ctx.fillText(String(f + 1), x + FRAME_PX / 2, 11);
    }

    // 关键帧菱形（汇总所有轨道，ruler 上可拖）
    for (const row of collectKeyRows(anim)) {
      for (const k of row.keys) {
        const x = k.frame * FRAME_PX + FRAME_PX / 2;
        ctx.beginPath();
        ctx.moveTo(x, h - 18); ctx.lineTo(x + 5, h - 13);
        ctx.lineTo(x, h - 8); ctx.lineTo(x - 5, h - 13);
        ctx.closePath();
        ctx.fillStyle = '#ffd166';
        ctx.fill();
      }
    }

    // 播放头
    const px = app.state.frame * FRAME_PX;
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, h);
    ctx.stroke();
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
  }

  global.Timeline = { init, render, FRAME_PX };
})(window);
