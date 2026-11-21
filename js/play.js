/* 可玩试玩：键盘输入实时驱动 physics.step（与分析器同一个引擎函数）。
   操作：←/→ 或 A/D 移动，Space/W/↑ 跳跃（按住高度可变），S/↓ 下穿薄平台，R 重置。 */
(function () {
  const JR = (window.JR = window.JR || {});

  function createPlayer(canvas, getState, onFrame) {
    const keys = new Set();
    let prevJump = false;
    let raf = null;
    let acc = 0;
    let last = 0;
    let st = null;

    const keydown = (ev) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(ev.code)) ev.preventDefault();
      keys.add(ev.code);
      if (ev.code === 'KeyR') reset();
    };
    const keyup = (ev) => keys.delete(ev.code);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);

    function reset() {
      const s = getState();
      st = JR.physics.spawnState(s.level, s.activeParams());
      acc = 0;
      last = performance.now();
      onFrame(JR.physics.snapshot(st), null);
    }

    function readInput() {
      const jump = keys.has('Space') || keys.has('KeyW') || keys.has('ArrowUp');
      const input = {
        left: keys.has('ArrowLeft') || keys.has('KeyA'),
        right: keys.has('ArrowRight') || keys.has('KeyD'),
        jumpHeld: jump,
        jumpPressed: jump && !prevJump,
        drop: keys.has('ArrowDown') || keys.has('KeyS'),
      };
      prevJump = jump;
      return input;
    }

    function loop(now) {
      const s = getState();
      if (s.mode !== 'play') { raf = null; return; }
      acc += Math.min(0.05, (now - last) / 1000);
      last = now;
      // 固定步长消费累积时间：渲染帧率波动不改变物理结果
      let events = null;
      while (acc >= JR.C.DT) {
        events = JR.physics.step(s.level, s.activeParams(), st, readInput());
        acc -= JR.C.DT;
      }
      onFrame(JR.physics.snapshot(st), events);
      raf = requestAnimationFrame(loop);
    }

    function start() {
      reset();
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    }

    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      // 必须移除 window 监听，否则重复进入试玩会累积监听器，
      // 旧 player 置空后按键仍触发其 reset() 造成空引用
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      keys.clear();
      prevJump = false;
    }

    // 注意：不可命名为 getState，否则函数声明提升会遮蔽 createPlayer 的同名参数，
    // 导致 reset/loop 调到本函数而不是外部注入的状态读取器
    function getPlayerState() {
      return st;
    }

    return { start, stop, reset, getState: getPlayerState };
  }

  JR.player = { createPlayer };
})();
