/* 极简游戏运行时：读取编辑器导出的 .runtime.json，驱动骨骼动画播放 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const norm = (r) => {
    let a = r % TAU;
    if (a >= Math.PI) a -= TAU;
    if (a < -Math.PI) a += TAU;
    return a;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAngle = (a, b, t) => a + norm(b - a) * t;
  const Easings = {
    linear: (t) => t,
    easeIn: (t) => t * t,
    easeOut: (t) => t * (2 - t),
    easeInOut: (t) => (t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
    hold: (t) => (t >= 1 ? 1 : 0),
  };

  function matCompose(x, y, rot, sx, sy) {
    const c = Math.cos(rot), s = Math.sin(rot);
    return [c * sx, s * sx, -s * sy, c * sy, x, y];
  }
  function matMul(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }

  function sampleChannel(keys, frame, frameCount, loop, rest, ch, isAngle) {
    if (!keys || !keys.length) return rest;
    if (keys.length === 1) {
      const v = keys[0][ch];
      return v === undefined ? rest : v;
    }
    let k0 = null, k1 = null;
    for (let i = 0; i < keys.length - 1; i++) {
      if (frame >= keys[i].frame && frame <= keys[i + 1].frame) { k0 = keys[i]; k1 = keys[i + 1]; break; }
    }
    if (!k0) {
      if (frame < keys[0].frame) return keys[0][ch] ?? rest;
      if (loop) { k0 = keys[keys.length - 1]; k1 = { ...keys[0], frame: keys[0].frame + frameCount }; }
      else return keys[keys.length - 1][ch] ?? rest;
    }
    const v0 = k0[ch], v1 = k1[ch];
    if (v0 === undefined) return rest;
    if (v1 === undefined) return v0;
    const t = (k1.frame - k0.frame) <= 0 ? 0 : (Easings[k0.easing] || Easings.linear)((frame - k0.frame) / (k1.frame - k0.frame));
    return isAngle ? lerpAngle(v0, v1, t) : lerp(v0, v1, t);
  }

  /** 两段 IK，与编辑器同算法（余弦定理，骨长严格保持）；输出段世界方向角与受限状态 */
  function solveIK(p0, p1, p2, target, bend) {
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const maxReach = l1 + l2;
    const targetDist = Math.hypot(target.x - p0.x, target.y - p0.y);
    const eps = 3;
    const state = targetDist > maxReach - eps ? 'limited' : 'ok';
    let d = Math.min(targetDist, maxReach - eps);
    if (d < 1e-6) d = 1e-6;
    const base = Math.atan2(target.y - p0.y, target.x - p0.x);
    const cosR = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const cosM = clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
    const rootWorldAngle = base + bend * Math.acos(cosR);
    const midWorldAngle = rootWorldAngle - bend * (Math.PI - Math.acos(cosM));
    return { rootWorldAngle, midWorldAngle, state, reach: maxReach };
  }

  class SkeletonPlayer {
    constructor(data) {
      this.data = data;
      this.bones = new Map(data.bones.map((b) => [b.id, b]));
      this.parts = data.parts;
      this.ik = data.ik;
      this.anims = new Map(data.animations.map((a) => [a.id, a]));
      this.imageEls = new Map();
      for (const img of data.images || []) {
        const el = new Image();
        el.src = img.src;
        this.imageEls.set(img.id, el);
      }
      this.anim = data.animations[0];
      this.time = 0;
      this.playing = true;
    }

    play(name) {
      const a = this.data.animations.find((x) => x.name === name);
      if (a) { this.anim = a; this.time = 0; this.playing = true; }
    }

    update(dt) {
      if (!this.playing || !this.anim) return;
      this.time += dt * this.anim.frameRate;
      if (this.anim.loop) this.time %= this.anim.frameCount;
      else this.time = Math.min(this.time, this.anim.frameCount - 1);
    }

    /** 返回每根骨骼的世界矩阵与世界坐标，供宿主引擎使用 */
    evaluate() {
      const a = this.anim;
      const f = this.time;
      const locals = new Map();
      for (const b of this.data.bones) {
        const keys = a.keys[b.id];
        locals.set(b.id, {
          x: sampleChannel(keys, f, a.frameCount, a.loop, b.rest.x, 'x', false),
          y: sampleChannel(keys, f, a.frameCount, a.loop, b.rest.y, 'y', false),
          rotation: sampleChannel(keys, f, a.frameCount, a.loop, b.rest.rotation, 'rotation', true),
          scaleX: sampleChannel(keys, f, a.frameCount, a.loop, b.rest.scaleX, 'scaleX', false),
          scaleY: sampleChannel(keys, f, a.frameCount, a.loop, b.rest.scaleY, 'scaleY', false),
        });
      }

      // 两级节点 FK：joint = 父rotNode·T(平移)，rotNode = joint·R(旋转)·S(缩放)
      const world = new Map(), pos = new Map();
      const fk = () => {
        for (const b of this.data.bones) {
          const l = locals.get(b.id);
          const parentRot = b.parentId ? world.get(b.parentId) : [1, 0, 0, 1, 0, 0];
          const c = Math.cos(l.rotation), s = Math.sin(l.rotation);
          const joint = matMul(parentRot, [1, 0, 0, 1, l.x, l.y]);
          const rotNode = matMul(joint, [c * l.scaleX, s * l.scaleX, -s * l.scaleY, c * l.scaleY, 0, 0]);
          world.set(b.id, rotNode);
          pos.set(b.id, { x: joint[4], y: joint[5] });
        }
      };
      fk();

      for (let pass = 0; pass < 2; pass++) {
        for (const c of this.ik) {
          if (!c.enabled) continue;
          const tKeys = a.ikKeys[c.id];
          const target = {
            x: sampleChannel(tKeys, f, a.frameCount, a.loop, c.target.x, 'x', false),
            y: sampleChannel(tKeys, f, a.frameCount, a.loop, c.target.y, 'y', false),
          };
          const root = this.bones.get(c.rootBoneId), mid = this.bones.get(c.midBoneId),
            eff = this.bones.get(c.effBoneId);
          // 世界空间解析求解；两级节点 rig（笛卡尔平移），段方向含静止平移方向角补偿
          const r = solveIK(
            pos.get(c.rootBoneId), pos.get(c.midBoneId), pos.get(c.effBoneId), target, c.bend
          );
          const rootParentAngle = root.parentId
            ? Math.atan2(world.get(root.parentId)[1], world.get(root.parentId)[0]) : 0;
          // root 段（root→mid）平移存在 mid.rest；mid 段（mid→eff）平移存在 eff.rest
          const rootSegDir = Math.atan2(mid.rest.y, mid.rest.x);
          const midSegDir = Math.atan2(eff.rest.y, eff.rest.x);
          locals.get(root.id).rotation = norm(r.rootWorldAngle - rootParentAngle - rootSegDir);
          fk();
          const rootRotWorldAfter = Math.atan2(world.get(root.id)[1], world.get(root.id)[0]);
          locals.get(mid.id).rotation = norm(r.midWorldAngle - rootRotWorldAfter - midSegDir);
          fk();
        }
      }

      const partWorld = new Map();
      for (const p of this.parts) {
        const parent = p.boneId ? world.get(p.boneId) : [1, 0, 0, 1, 0, 0];
        partWorld.set(p.id, matMul(parent, matCompose(p.offset.x, p.offset.y, p.offset.rotation, p.offset.scaleX, p.offset.scaleY)));
      }
      return { world, pos, partWorld };
    }

    /** 直接画到 Canvas2D（演示/参考实现，游戏引擎可只用 evaluate() 的矩阵） */
    draw(ctx) {
      const { partWorld } = this.evaluate();
      const boneIndex = new Map(this.data.bones.map((b, i) => [b.id, i]));
      this.parts.slice()
        .sort((x, y) => (boneIndex.get(x.boneId) ?? -1) - (boneIndex.get(y.boneId) ?? -1))
        .forEach((p) => {
          const m = partWorld.get(p.id);
          ctx.save();
          ctx.globalAlpha = p.opacity ?? 1;
          ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
          this._drawShape(ctx, p);
          ctx.restore();
        });
    }

    _drawShape(ctx, p) {
      const s = p.shape;
      ctx.beginPath();
      if (s.type === 'rect') ctx.rect(-s.width / 2, -s.height / 2, s.width, s.height);
      else if (s.type === 'circle') ctx.arc(0, 0, s.radius, 0, TAU);
      else if (s.type === 'polygon' && s.points.length) {
        s.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.closePath();
      } else if (s.type === 'image') {
        const el = this.imageEls.get(s.imageId);
        const w = s.width, h = s.height;
        if (el && el.complete) ctx.drawImage(el, -w / 2, -h / 2, w, h);
        else ctx.rect(-w / 2, -h / 2, w, h);
        return;
      }
      ctx.fillStyle = p.fill; ctx.fill();
      ctx.strokeStyle = p.stroke; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  global.SkeletonPlayer = SkeletonPlayer;
})(window);
