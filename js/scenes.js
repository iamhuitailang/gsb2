/* scenes.js — 内置测试场景：薄墙、斜坡、重叠形状、角色示例
 * 与 scenes/*.json 内容一致（导出格式相同）。 */
'use strict';

const Scenes = (() => {

  function base(name) {
    const d = Model.createDoc();
    d.name = name;
    return d;
  }
  function obj(name, x, y, opts) {
    return Object.assign(Model.createObject(name, x, y), opts || {});
  }
  function circle(cat, r, ox, oy) {
    const c = Model.createCollider('circle');
    c.category = cat; c.r = r; c.ox = ox || 0; c.oy = oy || 0;
    return c;
  }
  function rect(cat, w, h, ox, oy) {
    const c = Model.createCollider('rect');
    c.category = cat; c.w = w; c.h = h; c.ox = ox || 0; c.oy = oy || 0;
    return c;
  }
  function poly(cat, pts, ox, oy) {
    const c = Model.createCollider('poly');
    c.category = cat; c.pts = pts; c.ox = ox || 0; c.oy = oy || 0;
    return c;
  }
  // 类别：0默认 1玩家 2敌人 3地形 4道具 5传感器

  // 1) 薄墙：高速小球射向薄墙，检验穿透（离散检测的边界情况）
  function thinWall() {
    const d = base('薄墙测试');
    const wall = obj('薄墙', 620, 270, { dynamic: false });
    wall.colliders = [rect(3, 8, 400)];
    const floor = obj('地面', 480, 510, { dynamic: false });
    floor.colliders = [rect(3, 960, 60)];
    const ball = obj('高速球', 120, 270, { vx: 4000, restitution: 0.2 }); // 离散检测会隧穿，见 README
    ball.colliders = [circle(1, 16)];
    const slow = obj('慢速球', 120, 150, { vx: 200, restitution: 0.2 });
    slow.colliders = [circle(1, 16)];
    d.objects = [floor, wall, ball, slow];
    return d;
  }

  // 2) 斜坡：箱体沿斜坡下滑，检验卡边与摩擦
  function slope() {
    const d = base('斜坡测试');
    const floor = obj('地面', 480, 510, { dynamic: false });
    floor.colliders = [rect(3, 960, 60)];
    const ramp = obj('斜坡', 480, 400, { dynamic: false, friction: 0.3 });
    ramp.colliders = [poly(3, [{ x: -200, y: 60 }, { x: 200, y: 60 }, { x: 200, y: -60 }])];
    const box = obj('滑块', 300, 280, { friction: 0.2, restitution: 0 });
    box.colliders = [rect(1, 40, 40)];
    const ball = obj('滚球', 340, 200, { friction: 0.1, restitution: 0.1 });
    ball.colliders = [circle(1, 18)];
    d.objects = [floor, ramp, box, ball];
    return d;
  }

  // 3) 重叠形状：初始即互相穿透的多个碰撞体，检验分离与接触对显示
  function overlap() {
    const d = base('重叠形状测试');
    const a = obj('重叠体A', 420, 260, { restitution: 0 });
    a.colliders = [circle(0, 50), rect(0, 60, 60, 40, 0)];
    const b = obj('重叠体B', 470, 270, { restitution: 0 });
    b.colliders = [circle(0, 50), poly(0, [{ x: -40, y: 30 }, { x: 40, y: 30 }, { x: 0, y: -40 }], -40, 0)];
    const floor = obj('地面', 480, 510, { dynamic: false });
    floor.colliders = [rect(3, 960, 60)];
    d.objects = [floor, a, b];
    return d;
  }

  // 4) 角色示例：多碰撞体（身体+头部传感器），演示类别与规则
  function character() {
    const d = base('角色碰撞示例');
    const hero = obj('角色', 200, 380, { friction: 0.3 });
    hero.colliders = [
      Object.assign(rect(1, 36, 60, 0, 10), { name: '身体' }),
      Object.assign(circle(1, 16, 0, -32), { name: '头部' }),
      Object.assign(circle(5, 46, 0, 10), { name: '感应圈' })
    ];
    const enemy = obj('敌人', 560, 390, { vx: -60 });
    enemy.colliders = [Object.assign(rect(2, 44, 44), { name: '身体' })];
    const item = obj('道具', 400, 420, { dynamic: false });
    item.colliders = [Object.assign(circle(4, 14), { name: '拾取区' })];
    const floor = obj('地面', 480, 510, { dynamic: false });
    floor.colliders = [rect(3, 960, 60)];
    const box = obj('箱子', 760, 450, { dynamic: false });
    box.colliders = [rect(3, 80, 60)];
    d.objects = [floor, box, hero, enemy, item];
    // 规则示例：传感器(5) 只与 玩家/敌人/道具 交互，不与地形碰撞
    d.rules['3,5'] = false; // 传感器 vs 地形 关
    d.rules['5,5'] = false; // 传感器 vs 传感器 关
    return d;
  }

  const ALL = { '角色碰撞示例': character, '薄墙测试': thinWall, '斜坡测试': slope, '重叠形状测试': overlap };

  return { ALL, create: (name) => (ALL[name] || character)() };
})();
