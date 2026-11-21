/* Canvas 渲染：关卡实体、角色、可达性落点、轨迹、逐步播放帧。 */
(function () {
  const JR = (window.JR = window.JR || {});
  const C = JR.C;

  function drawGrid(ctx, w, h) {
    ctx.fillStyle = '#10141c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += C.GRID) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += C.GRID) {
      ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
    }
  }

  function drawEntity(ctx, e, selectedId) {
    const T = JR.ENTITY_TYPES[e.type];
    ctx.save();
    if (e.type === 'start') {
      ctx.fillStyle = 'rgba(87,178,107,0.18)';
      ctx.strokeStyle = T.color;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(e.x, e.y, e.w, e.h);
      ctx.strokeRect(e.x, e.y, e.w, e.h);
      ctx.setLineDash([]);
      ctx.fillStyle = T.color;
      ctx.font = '11px sans-serif';
      ctx.fillText('起跳区域', e.x + 4, e.y + 14);
    } else {
      ctx.fillStyle = T.color + (e.oneWay ? 'cc' : '');
      ctx.fillRect(e.x, e.y, e.w, e.h);
      ctx.strokeStyle = selectedId === e.id ? '#ffd34d' : 'rgba(0,0,0,0.45)';
      ctx.lineWidth = selectedId === e.id ? 2 : 1;
      ctx.strokeRect(e.x + 0.5, e.y + 0.5, e.w - 1, e.h - 1);
      if (e.oneWay) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(e.x + 2, e.y + 0.5);
        ctx.lineTo(e.x + e.w - 2, e.y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (e.type === 'overhead') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.font = '10px sans-serif';
        ctx.fillText('障碍', e.x + 3, e.y + e.h - 3);
      }
    }
    ctx.restore();
  }

  function drawTargetMark(ctx, e) {
    if (!e) return;
    ctx.save();
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 2;
    const cx = e.x + e.w / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, e.y - 12); ctx.lineTo(cx + 10, e.y - 12);
    ctx.moveTo(cx, e.y - 18); ctx.lineTo(cx, e.y - 6);
    ctx.stroke();
    ctx.fillStyle = '#ffd34d';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('目标', cx, e.y - 22);
    ctx.restore();
  }

  function drawLandingMarkers(ctx, level, result) {
    for (const agg of result.platforms) {
      const e = level.entities.find((x) => x.id === agg.entityId);
      if (!e) continue;
      ctx.save();
      if (agg.bonkBlocked) {
        // 距离够但撞头：红叉 + 橙边
        ctx.strokeStyle = '#ff6b5e';
        ctx.lineWidth = 2;
        ctx.strokeRect(e.x + 1, e.y - 6, e.w - 2, 6);
        const cx = e.x + e.w / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 7, e.y - 22); ctx.lineTo(cx + 7, e.y - 8);
        ctx.moveTo(cx + 7, e.y - 22); ctx.lineTo(cx - 7, e.y - 8);
        ctx.stroke();
        ctx.fillStyle = '#ff6b5e';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('撞头不可达', cx, e.y - 26);
      } else if (agg.reachable) {
        ctx.fillStyle = '#57d07a';
        ctx.fillRect(e.x + 2, e.y - 5, Math.min(18, e.w - 4), 4);
        ctx.fillStyle = '#57d07a';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('可落脚', e.x + 2, e.y - 9);
      }
      if (agg.edgeSlips > 0 && !agg.reachable) {
        ctx.fillStyle = '#e0a44d';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`贴边滑落×${agg.edgeSlips}`, e.x + e.w - 2, e.y - 9);
      }
      ctx.restore();
    }
  }

  function drawTrajectory(ctx, frames, opts = {}) {
    if (!frames || frames.length < 2) return;
    ctx.save();
    ctx.strokeStyle = opts.color || 'rgba(120,190,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(opts.ghost ? [4, 4] : []);
    ctx.beginPath();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const cx = f.x + f.w / 2;
      const cy = f.y + f.h / 2;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // 采样点
    ctx.fillStyle = opts.ghost ? 'rgba(255,150,120,0.7)' : 'rgba(120,190,255,0.9)';
    const step = Math.max(1, Math.floor(frames.length / 40));
    for (let i = 0; i < frames.length; i += step) {
      const f = frames[i];
      ctx.fillRect(f.x + f.w / 2 - 1.5, f.y + f.h / 2 - 1.5, 3, 3);
    }
    ctx.restore();
  }

  function drawCharacter(ctx, frame, color = '#f2e36b') {
    ctx.save();
    ctx.fillStyle = color;
    ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
    // 朝向眼睛
    ctx.fillStyle = '#222';
    const ex = frame.facing < 0 ? frame.x + 4 : frame.x + frame.w - 7;
    ctx.fillRect(ex, frame.y + 6, 3, 3);
    ctx.restore();
  }

  function drawAll(ctx, view) {
    const { w, h, level, selectedId, result, preview, playFrame, mode } = view;
    drawGrid(ctx, w, h);
    for (const e of level.entities) drawEntity(ctx, e, selectedId);
    if (level.targetId) drawTargetMark(ctx, level.entities.find((e) => e.id === level.targetId));
    if (result && mode !== 'play') drawLandingMarkers(ctx, level, result);
    if (preview && preview.frames) drawTrajectory(ctx, preview.frames);
    if (preview && preview.ghostFrames) drawTrajectory(ctx, preview.ghostFrames, { ghost: true, color: 'rgba(255,140,110,0.75)' });
    if (playFrame) drawCharacter(ctx, playFrame);
  }

  JR.render = { drawAll, drawTrajectory, drawCharacter, drawGrid, drawEntity };
})();
