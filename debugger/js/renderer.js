/*
 * renderer.js — 用基础几何形状（圆/线段/关节点）绘制关键姿态的火柴人
 */
(function (root) {
  const P = root.ASDebug = root.ASDebug || {};

  function drawCharacter(canvas, pose, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // 地面
    ctx.strokeStyle = opts.groundColor || '#3a4250';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(12, H - 24);
    ctx.lineTo(W - 12, H - 24);
    ctx.stroke();

    const p = pose || {};
    const lean = (p.lean || 0) * Math.PI / 180;
    const legSpread = (p.legSpread || 0) * Math.PI / 180;
    const armSpread = (p.armSpread || 0) * Math.PI / 180;
    const crouch = p.crouch || 0;
    const tuck = p.tuck || 0;
    const airborne = p.airborne || 0;

    const hipX = W / 2;
    const groundY = H - 24;
    const hipY = groundY - 52 + crouch * 16 - airborne * 46;
    const torsoLen = 40 - crouch * 6;
    const neck = { x: hipX - Math.sin(lean) * torsoLen, y: hipY - Math.cos(lean) * torsoLen };
    const headR = 11;
    const head = { x: neck.x - Math.sin(lean) * (headR + 4), y: neck.y - Math.cos(lean) * (headR + 4) };
    const skin = opts.color || '#9fc4ff';
    const joint = opts.jointColor || '#ffd166';

    function limb(a, b, width) {
      ctx.strokeStyle = skin;
      ctx.lineWidth = width || 5;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    function dot(a, r) {
      ctx.fillStyle = joint;
      ctx.beginPath(); ctx.arc(a.x, a.y, r || 3.2, 0, Math.PI * 2); ctx.fill();
    }

    // 双腿（几何线段 + 关节圆）。tuck 时小腿收起
    const thighLen = 26 - crouch * 4;
    const shinLen = 26 - tuck * 12;
    for (const side of [-1, 1]) {
      const hipAng = side * legSpread + crouch * 0.5;
      const knee = {
        x: hipX + Math.sin(hipAng) * thighLen,
        y: hipY + Math.cos(hipAng) * thighLen,
      };
      const kneeAng = hipAng * (1 - tuck) + side * (tuck ? 1.9 : 0.15);
      const foot = {
        x: knee.x + Math.sin(kneeAng) * shinLen,
        y: knee.y + Math.cos(kneeAng) * shinLen,
      };
      limb({ x: hipX, y: hipY }, knee);
      limb(knee, foot);
      dot(knee, 2.6);
      // 脚：小三角
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.moveTo(foot.x, foot.y);
      ctx.lineTo(foot.x + 7 * side, foot.y);
      ctx.lineTo(foot.x, foot.y - 5);
      ctx.closePath(); ctx.fill();
    }

    // 躯干
    limb({ x: hipX, y: hipY }, neck, 6);
    dot({ x: hipX, y: hipY }, 3.4);

    // 双臂
    const armLen = 22;
    for (const side of [-1, 1]) {
      const ang = side * armSpread + lean;
      const hand = {
        x: neck.x + Math.sin(ang) * armLen,
        y: neck.y + Math.cos(ang) * armLen * 0.9,
      };
      limb(neck, hand, 4);
      dot(hand, 2.4);
    }

    // 头（圆）
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(head.x, head.y, headR, 0, Math.PI * 2); ctx.fill();
    // 朝向标记（小三角鼻子）
    ctx.fillStyle = opts.groundColor || '#3a4250';
    ctx.beginPath();
    ctx.moveTo(head.x + headR - 2, head.y - 2);
    ctx.lineTo(head.x + headR + 5, head.y + 1);
    ctx.lineTo(head.x + headR - 2, head.y + 4);
    ctx.closePath(); ctx.fill();
  }

  // 姿态小缩略图（配置面板用）
  function drawThumb(canvas, pose) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(0.55, 0.55);
    drawCharacter(canvas, pose);
    ctx.restore();
  }

  P.Renderer = { drawCharacter, drawThumb };
})(typeof self !== 'undefined' ? self : this);
