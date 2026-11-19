/* Canvas 渲染：世界/屏幕坐标变换、网格、部件、骨骼 Gizmo、IK 目标、洋葱皮影子 */
(function (global) {
  'use strict';

  const { M } = global.Math2D;

  /** 视图：平移 + 缩放，世界坐标 -> 屏幕坐标 */
  const View = {
    panX: 0, panY: 0, scale: 1,
    toScreen(p) {
      return { x: p.x * this.scale + this.panX, y: p.y * this.scale + this.panY };
    },
    toWorld(p) {
      return { x: (p.x - this.panX) / this.scale, y: (p.y - this.panY) / this.scale };
    },
    reset(canvas) {
      this.scale = 1;
      this.panX = canvas.width / 2;
      this.panY = canvas.height / 2 + 60;
    },
  };

  const imageCache = new Map();
  function getImage(img) {
    if (!img) return null;
    if (!imageCache.has(img.id)) {
      const el = new Image();
      el.src = img.src;
      imageCache.set(img.id, el);
    }
    const el = imageCache.get(img.id);
    return el.complete && el.naturalWidth ? el : null;
  }
  function invalidateImage(id) { imageCache.delete(id); }

  function drawGrid(ctx, canvas) {
    const step = 40 * View.scale;
    const ox = View.panX % step;
    const oy = View.panY % step;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1e2c42';
    ctx.beginPath();
    for (let x = ox; x < canvas.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); }
    for (let y = oy; y < canvas.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); }
    ctx.stroke();
    // 世界原点轴线
    ctx.strokeStyle = '#33507a';
    ctx.beginPath();
    const o = View.toScreen({ x: 0, y: 0 });
    ctx.moveTo(0, o.y); ctx.lineTo(canvas.width, o.y);
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  function drawPartShape(ctx, project, part) {
    const s = part.shape;
    ctx.beginPath();
    if (s.type === 'rect') {
      ctx.rect(-s.width / 2, -s.height / 2, s.width, s.height);
    } else if (s.type === 'circle') {
      ctx.arc(0, 0, s.radius, 0, Math.PI * 2);
    } else if (s.type === 'polygon') {
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
    } else if (s.type === 'image') {
      const img = getImage(project.images.find((im) => im.id === s.imageId));
      const w = s.width || (img ? img.naturalWidth : 60);
      const h = s.height || (img ? img.naturalHeight : 60);
      if (img) ctx.drawImage(img, -w / 2, -h / 2, w, h);
      else ctx.rect(-w / 2, -h / 2, w, h);
      return;
    }
    ctx.fillStyle = part.fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = part.stroke;
    ctx.stroke();
  }

  function drawParts(ctx, project, pose, alpha) {
    // 按绑定骨骼在 project.bones 中的顺序绘制，保证层级/显示顺序随骨骼层级更新
    const boneOrder = new Map(project.bones.map((b, i) => [b.id, i]));
    const ordered = project.parts
      .filter((p) => p.visible)
      .slice()
      .sort((a, b) => (boneOrder.get(a.boneId) ?? -1) - (boneOrder.get(b.boneId) ?? -1));
    for (const part of ordered) {
      const m = pose.partWorld[part.id];
      if (!m) continue;
      ctx.save();
      ctx.globalAlpha = alpha * part.opacity;
      ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
      drawPartShape(ctx, project, part);
      ctx.restore();
    }
  }

  function drawBones(ctx, project, pose, selection, options) {
    const showBones = options.showBones !== false;
    if (!showBones) return;
    ctx.save();
    ctx.lineWidth = 2;
    for (const bone of project.bones) {
      const p = View.toScreen(pose.worldPos[bone.id]);
      const selected = selection && selection.kind === 'bone' && selection.id === bone.id;
      if (bone.parentId && pose.worldPos[bone.parentId]) {
        const pp = View.toScreen(pose.worldPos[bone.parentId]);
        ctx.strokeStyle = selected ? '#ffd166' : 'rgba(120,200,255,0.75)';
        ctx.beginPath();
        ctx.moveTo(pp.x, pp.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      // 关节点
      ctx.beginPath();
      ctx.arc(p.x, p.y, bone.jointRadius, 0, Math.PI * 2);
      ctx.fillStyle = selected ? '#ffd166' : '#9fd6ff';
      ctx.fill();
      ctx.strokeStyle = '#0b1626';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 名称
      if (options.showLabels) {
        ctx.fillStyle = 'rgba(220,234,255,0.85)';
        ctx.font = '11px sans-serif';
        ctx.fillText(bone.name, p.x + 9, p.y - 8);
      }
    }
    ctx.restore();
  }

  function drawIK(ctx, project, pose, selected) {
    for (const c of project.ik) {
      const eff = pose.worldPos[c.effBoneId];
      if (!eff) continue;
      const target = pose.ikTarget ? pose.ikTarget[c.id] : c.target;
      const s = View.toScreen(target);
      const e = View.toScreen(eff);
      const limited = pose.ikStates && pose.ikStates[c.id] === 'limited';
      const isSel = selected && selected.kind === 'ik' && selected.id === c.id;
      ctx.save();
      // 目标到末端的连线
      ctx.strokeStyle = limited ? 'rgba(255,90,90,0.9)' : 'rgba(255,209,102,0.5)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(e.x, e.y); ctx.lineTo(s.x, s.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 目标点：菱形，超限红色
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 9);
      ctx.lineTo(s.x + 9, s.y);
      ctx.lineTo(s.x, s.y + 9);
      ctx.lineTo(s.x - 9, s.y);
      ctx.closePath();
      ctx.fillStyle = limited ? '#ff5a5a' : (isSel ? '#ffd166' : '#ffb84d');
      ctx.fill();
      ctx.strokeStyle = '#1a1206';
      ctx.stroke();
      if (limited) {
        ctx.fillStyle = '#ff8080';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('受限', s.x + 12, s.y + 4);
      }
      if (!c.enabled) {
        ctx.globalAlpha = 0.35;
      }
      ctx.restore();
    }
  }

  /** 洋葱皮：相邻帧半透明影子 */
  function drawOnion(ctx, project, anim, frame, range, behind) {
    if (!anim || range <= 0) return;
    for (let i = 1; i <= range; i += 1) {
      const f = behind ? frame - i : frame + i;
      const wrapped = global.Pose.wrapFrame(f, anim.frameCount, anim.loop);
      if (!anim.loop && (wrapped < 0 || wrapped > anim.frameCount - 1)) continue;
      const ghost = global.Pose.evaluatePose(project, anim, wrapped);
      const alpha = (behind ? 0.16 : 0.13) * (1 - (i - 1) / (range + 1));
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.filter = behind ? 'hue-rotate(190deg)' : 'hue-rotate(-40deg)';
      drawParts(ctx, project, ghost, 1);
      ctx.restore();
    }
  }

  /** 主绘制入口 */
  function render(canvas, project, pose, opts) {
    const ctx = canvas.getContext('2d');
    const o = Object.assign({
      selection: null, showBones: true, showLabels: true,
      onionBefore: 0, onionAfter: 0, anim: null, frame: 0,
    }, opts || {});

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawGrid(ctx, canvas);

    ctx.setTransform(View.scale, 0, 0, View.scale, View.panX, View.panY);

    if (o.onionBefore || o.onionAfter) {
      drawOnion(ctx, project, o.anim, o.frame, o.onionBefore, true);
      drawOnion(ctx, project, o.anim, o.frame, o.onionAfter, false);
    }

    drawParts(ctx, project, pose, 1);
    drawBones(ctx, project, pose, o.selection, { showBones: o.showBones, showLabels: o.showLabels });
    drawIK(ctx, project, pose, o.selection);

    // 选中部件的高亮框
    if (o.selection && o.selection.kind === 'part') {
      const part = global.Model.getPart(project, o.selection.id);
      const m = part && pose.partWorld[part.id];
      if (m) {
        ctx.save();
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const s = part.shape;
        const w = s.type === 'circle' ? s.radius * 2 : (s.width || 60);
        const h = s.type === 'circle' ? s.radius * 2 : (s.height || 60);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2 / View.scale;
        ctx.setLineDash([6 / View.scale, 4 / View.scale]);
        ctx.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8);
        ctx.restore();
      }
    }
  }

  /** 命中测试：优先关节/IK 目标，其次部件 */
  function hitTest(project, pose, screenPoint) {
    const world = View.toWorld(screenPoint);
    // IK 目标
    for (let i = project.ik.length - 1; i >= 0; i -= 1) {
      const c = project.ik[i];
      const target = pose.ikTarget ? pose.ikTarget[c.id] : c.target;
      if (Math.hypot(target.x - world.x, target.y - world.y) <= 12 / View.scale) {
        return { kind: 'ik', id: c.id };
      }
    }
    // 关节
    for (let i = project.bones.length - 1; i >= 0; i -= 1) {
      const b = project.bones[i];
      const p = pose.worldPos[b.id];
      const r = Math.max(b.jointRadius, 9) / View.scale;
      if (Math.hypot(p.x - world.x, p.y - world.y) <= r) {
        return { kind: 'bone', id: b.id };
      }
    }
    // 部件（逆变换到局部点做形状测试）
    const boneOrder = new Map(project.bones.map((bb, idx) => [bb.id, idx]));
    const ordered = project.parts
      .filter((p) => p.visible)
      .sort((a, b) => (boneOrder.get(b.boneId) ?? -1) - (boneOrder.get(a.boneId) ?? -1));
    for (const part of ordered) {
      const m = pose.partWorld[part.id];
      if (!m) continue;
      const local = M.apply(M.invert(m), world);
      const s = part.shape;
      let inside = false;
      if (s.type === 'rect') {
        inside = Math.abs(local.x) <= s.width / 2 && Math.abs(local.y) <= s.height / 2;
      } else if (s.type === 'circle') {
        inside = Math.hypot(local.x, local.y) <= s.radius;
      } else if (s.type === 'polygon' && s.points.length) {
        inside = pointInPolygon(local, s.points);
      } else if (s.type === 'image') {
        inside = Math.abs(local.x) <= (s.width || 60) / 2 && Math.abs(local.y) <= (s.height || 60) / 2;
      }
      if (inside) return { kind: 'part', id: part.id };
    }
    return null;
  }

  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      const intersect = ((yi > p.y) !== (yj > p.y)) &&
        (p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  global.Renderer = { View, render, hitTest, invalidateImage };
})(window);
