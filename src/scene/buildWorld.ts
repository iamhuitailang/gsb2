import * as THREE from 'three';

export interface BuiltWorld {
  group: THREE.Group;
  colliders: THREE.Mesh[];
  ground: THREE.Mesh;
  /** 地标文字 Sprite，游戏视角下可整体隐藏 */
  labels: THREE.Group;
}

export interface FakeCharacter {
  group: THREE.Group;
  /** moving 时播放走路摆腿；walkClock 由外部累计 */
  setWalk: (moving: boolean, dt: number) => void;
}

function standard(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.06, ...opts });
}

function addEdges(mesh: THREE.Mesh, color = 0x0f172a, opacity = 0.35) {
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
  );
  mesh.add(edges);
}

interface BoxOpts {
  name?: string;
  occluder?: boolean;
  color?: number;
  edge?: boolean;
  castShadow?: boolean;
}

function makeBox(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  opts: BoxOpts = {},
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), standard(opts.color ?? 0x64748b));
  mesh.position.set(x, y, z);
  mesh.castShadow = opts.castShadow ?? true;
  mesh.receiveShadow = true;
  mesh.name = opts.name ?? '';
  if (opts.occluder) {
    mesh.userData.occluder = true;
    mesh.userData.displayName = opts.name ?? '障碍物';
  }
  if (opts.edge !== false) addEdges(mesh);
  return mesh;
}

/** 用 Canvas 生成中文文字 Sprite，作为场景地标 */
export function makeTextSprite(text: string, bg = 'rgba(15,23,42,0.72)', fg = '#e2e8f0'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const fontSize = 44;
  ctx.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  const padX = 24;
  const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const h = fontSize + 28;
  canvas.width = w;
  canvas.height = h;
  const c2 = canvas.getContext('2d')!;
  c2.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  c2.fillStyle = bg;
  const r = 18;
  c2.beginPath();
  c2.roundRect(2, 2, w - 4, h - 4, r);
  c2.fill();
  c2.strokeStyle = 'rgba(148,163,184,0.5)';
  c2.lineWidth = 3;
  c2.stroke();
  c2.fillStyle = fg;
  c2.textBaseline = 'middle';
  c2.fillText(text, padX, h / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }),
  );
  const scale = 0.012;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.renderOrder = 20;
  return sprite;
}

export function buildWorld(): BuiltWorld {
  const group = new THREE.Group();
  group.name = 'procedural-world';
  const labels = new THREE.Group();
  labels.name = 'world-labels';
  group.add(labels);
  const colliders: THREE.Mesh[] = [];
  const addCollider = (m: THREE.Mesh) => {
    colliders.push(m);
    group.add(m);
    return m;
  };

  // ---------- 地面 ----------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 64),
    standard(0x2b3242, { roughness: 0.96, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = '地面';
  group.add(ground);

  const grid = new THREE.GridHelper(90, 90, 0x475569, 0x334155);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  grid.position.y = 0.012;
  group.add(grid);

  // 广场铺装
  const plazaPad = new THREE.Mesh(
    new THREE.BoxGeometry(15, 0.04, 12),
    standard(0x35405a, { roughness: 0.95 }),
  );
  plazaPad.position.set(-9.5, 0.02, 3);
  plazaPad.receiveShadow = true;
  group.add(plazaPad);

  // 主路铺装（门洞 + 窄路轴向）
  const road = new THREE.Mesh(new THREE.BoxGeometry(27, 0.05, 3.4), standard(0x3d465c));
  road.position.set(-1.5, 0.025, 0);
  road.receiveShadow = true;
  group.add(road);

  // ---------- 门洞：两片墙 + 门楣 + 门框 ----------
  const wallMat = 0x8b93a7;
  addCollider(
    makeBox(0.6, 3.1, 4.9, 0, 1.55, 3.55, {
      name: '门洞右侧墙',
      color: wallMat,
      occluder: true,
    }),
  );
  addCollider(
    makeBox(0.6, 3.1, 4.9, 0, 1.55, -3.55, {
      name: '门洞左侧墙',
      color: wallMat,
      occluder: true,
    }),
  );
  addCollider(
    makeBox(0.7, 1.0, 2.9, 0, 2.75, 0, { name: '门洞门楣', color: 0x7c859c, occluder: true }),
  );
  // 门框立柱（略微突出，强调门洞宽度）
  addCollider(
    makeBox(0.85, 2.35, 0.35, 0, 1.175, 1.28, { name: '门框右柱', color: 0xc79a5b, occluder: true }),
  );
  addCollider(
    makeBox(0.85, 2.35, 0.35, 0, 1.175, -1.28, { name: '门框左柱', color: 0xc79a5b, occluder: true }),
  );

  const doorLabel = makeTextSprite('门洞（近距离 + 边界夹制）');
  doorLabel.position.set(0, 4.1, 0);
  labels.add(doorLabel);

  // ---------- 窄路：两道长墙 ----------
  addCollider(
    makeBox(9.2, 2.7, 0.5, 7.5, 1.35, 1.95, {
      name: '窄路右侧墙',
      color: 0x7d8aa3,
      occluder: true,
    }),
  );
  addCollider(
    makeBox(9.2, 2.7, 0.5, 7.5, 1.35, -1.95, {
      name: '窄路左侧墙',
      color: 0x7d8aa3,
      occluder: true,
    }),
  );
  // 墙顶压边（装饰，不参与遮挡，避免干扰候选）
  group.add(makeBox(9.4, 0.18, 0.68, 7.5, 2.78, 1.95, { color: 0x5b6b86, occluder: false }));
  group.add(makeBox(9.4, 0.18, 0.68, 7.5, 2.78, -1.95, { color: 0x5b6b86, occluder: false }));

  const alleyLabel = makeTextSprite('窄路（俯视 / 镜头边界）');
  alleyLabel.position.set(7.5, 3.6, 0);
  labels.add(alleyLabel);

  // ---------- 广场上的遮挡物：货箱群 + 立柱 + 测试墙 ----------
  addCollider(
    makeBox(1.7, 1.7, 1.7, -9.4, 0.85, 5.6, { name: '货箱 A', color: 0xc08447, occluder: true }),
  );
  addCollider(
    makeBox(1.2, 1.2, 1.2, -8.1, 0.6, 6.3, { name: '货箱 B', color: 0xa9713c, occluder: true }),
  );
  addCollider(
    makeBox(0.9, 3.2, 0.9, -5.0, 1.6, -2.8, { name: '广场立柱', color: 0x94a3b8, occluder: true }),
  );
  addCollider(
    makeBox(2.8, 2.9, 0.5, -7.4, 1.45, 3.4, {
      name: '遮挡测试墙',
      color: 0xb45309,
      occluder: true,
    }),
  );
  // 测试墙标识条
  const wallTag = makeTextSprite('遮挡测试墙', 'rgba(180,83,9,0.85)');
  wallTag.position.set(-7.4, 3.35, 3.4);
  wallTag.scale.multiplyScalar(0.8);
  labels.add(wallTag);

  // 确定性遮挡墙：恰好横在起点停留点(wp0)的期望相机射线上，
  // 大尺寸保证不同帧率 / 轻微切线误差下都能复现「遮挡 → 避让原因」。
  addCollider(
    makeBox(1.6, 4.8, 6.2, -19.0, 2.4, 6.9, {
      name: '开场遮挡墙',
      color: 0x9f1239,
      occluder: true,
    }),
  );
  const startWallTag = makeTextSprite('开场遮挡（射线必中）', 'rgba(159,18,57,0.9)');
  startWallTag.position.set(-19, 5.2, 6.9);
  startWallTag.scale.multiplyScalar(0.75);
  labels.add(startWallTag);

  // ---------- 转角观景区域：圆台 + 矮柱 + 长椅 ----------
  const platform = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.6, 0.28, 40),
    standard(0x46536e, { roughness: 0.9 }),
  );
  platform.position.set(12.8, 0.14, -6.2);
  platform.receiveShadow = true;
  platform.castShadow = true;
  group.add(platform);

  addCollider(
    makeBox(2.2, 0.5, 0.7, 13.6, 0.53, -7.6, { name: '观景长椅', color: 0x92600f, occluder: true }),
  );
  // 装饰灯柱（细高，也可遮挡）
  addCollider(
    makeBox(0.22, 3.4, 0.22, 10.4, 1.7, -8.4, { name: '灯柱', color: 0x475569, occluder: true }),
  );
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xfde68a, emissive: 0xf59e0b, emissiveIntensity: 0.9 }),
  );
  lamp.position.set(10.4, 3.5, -8.4);
  group.add(lamp);

  const viewLabel = makeTextSprite('转角观景（大距离 / 左肩偏移）');
  viewLabel.position.set(12.8, 4.4, -5.2);
  labels.add(viewLabel);

  // ---------- 散落小箱，增加层次 ----------
  const scatter: Array<[number, number, number, number]> = [
    [-13.2, 0.5, 1.2, 1.0],
    [-12.4, 0.4, -1.6, 0.8],
    [-2.6, 0.55, 3.0, 1.1],
    [3.4, 0.45, -3.2, 0.9],
    [11.8, 0.5, 2.9, 1.0],
  ];
  scatter.forEach(([x, y, z, s], i) => {
    addCollider(
      makeBox(s, s, s, x, y, z, { name: `杂物箱 ${i + 1}`, color: 0x6b7a90, occluder: true }),
    );
  });

  return { group, colliders, ground, labels };
}

/** 程序生成的低多边形假角色，默认面向 +Z（与 yaw 约定一致） */
export function createFakeCharacter(): FakeCharacter {
  const group = new THREE.Group();
  group.name = 'fake-character';

  const bodyMat = standard(0x06b6d4, { roughness: 0.55, metalness: 0.15 });
  const darkMat = standard(0x0f172a, { roughness: 0.7 });
  const accentMat = standard(0xf97316, { roughness: 0.6 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.62, 6, 14), bodyMat);
  torso.position.y = 1.05;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 16), standard(0xf1f5f9));
  head.position.y = 1.68;
  head.castShadow = true;
  group.add(head);

  // 面罩朝 +Z
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.12), darkMat);
  visor.position.set(0, 1.7, 0.22);
  group.add(visor);

  // 胸前方向标
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 3), accentMat);
  arrow.rotation.x = Math.PI / 2;
  arrow.position.set(0, 1.12, 0.32);
  group.add(arrow);

  const makeLimb = (w: number, h: number, mat: THREE.Material) => {
    const pivot = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mat);
    mesh.position.y = -h / 2;
    mesh.castShadow = true;
    pivot.add(mesh);
    return pivot;
  };

  const legL = makeLimb(0.2, 0.72, darkMat);
  legL.position.set(-0.17, 0.78, 0);
  const legR = makeLimb(0.2, 0.72, darkMat);
  legR.position.set(0.17, 0.78, 0);
  group.add(legL, legR);

  const armL = makeLimb(0.16, 0.6, bodyMat);
  armL.position.set(-0.42, 1.36, 0);
  const armR = makeLimb(0.16, 0.6, bodyMat);
  armR.position.set(0.42, 1.36, 0);
  group.add(armL, armR);

  // 脚下选中环
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.72, 40),
    new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(ring);

  let phase = 0;
  let blend = 0;

  return {
    group,
    setWalk(moving: boolean, dt: number) {
      blend += ((moving ? 1 : 0) - blend) * Math.min(1, dt * 10);
      if (moving) phase += dt * 9;
      const swing = Math.sin(phase) * 0.65 * blend;
      legL.rotation.x = swing;
      legR.rotation.x = -swing;
      armL.rotation.x = -swing * 0.8;
      armR.rotation.x = swing * 0.8;
      torso.position.y = 1.05 + Math.abs(Math.sin(phase)) * 0.05 * blend;
      ring.scale.setScalar(1 + Math.sin(phase * 2) * 0.04 * blend);
    },
  };
}
