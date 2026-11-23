import { InstanceStore } from './store';
import type { Vec3 } from './math';

interface Spec {
  position: Vec3;
  rotationDeg: Vec3;
  scale: Vec3;
  color: Vec3;
}

// HSL -> RGB，颜色按稳定编号稳定生成
function hsl(h: number, s: number, l: number): Vec3 {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const colorFor = (id: number, salt: number): Vec3 =>
  hsl((id * 47 + salt * 131) % 360, 0.62, 0.6);

/**
 * 稀疏场景：3 个逻辑批次，刻意制造遮挡、旋转、非均匀缩放与镜像，
 * 方便肉眼核对“点到的最前面实例”与编号是否一致。
 */
export function buildSparseScene(store: InstanceStore): void {
  const specsA: Spec[] = [
    { position: [-4, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1], color: [0, 0, 0] },
    { position: [-2, 0, 0.6], rotationDeg: [20, 35, 0], scale: [1, 1, 1], color: [0, 0, 0] },
    { position: [0, 0, 1.2], rotationDeg: [0, 0, 0], scale: [1, 1, 1], color: [0, 0, 0] },
    { position: [2, 0, 1.8], rotationDeg: [0, 0, 0], scale: [1, 1, 1], color: [0, 0, 0] },
  ];
  const specsB: Spec[] = [
    // 非均匀缩放：压扁、拉长
    { position: [-3, 2.2, -1], rotationDeg: [0, 0, 15], scale: [0.5, 1.6, 0.5], color: [0, 0, 0] },
    { position: [0, 2.4, -1], rotationDeg: [30, 0, 0], scale: [1.8, 0.45, 0.8], color: [0, 0, 0] },
    { position: [3, 2.2, -1], rotationDeg: [0, 25, 0], scale: [0.7, 0.7, 1.8], color: [0, 0, 0] },
  ];
  const specsC: Spec[] = [
    // 镜像：负缩放，且两个盒子互相穿透
    { position: [-1.2, -2.2, 0.5], rotationDeg: [0, 20, 10], scale: [-1.2, 0.8, 0.8], color: [0, 0, 0] },
    { position: [0.2, -2.2, 0.9], rotationDeg: [0, -20, -10], scale: [1.2, 0.8, 0.8], color: [0, 0, 0] },
    { position: [2.6, -2.2, 0], rotationDeg: [15, 0, 25], scale: [1, -1, 1], color: [0, 0, 0] },
    // 靠近裁切边界：放在视野边缘附近
    { position: [6.8, 0, -2], rotationDeg: [0, 45, 0], scale: [0.8, 0.8, 0.8], color: [0, 0, 0] },
  ];

  const add = (specs: Spec[], salt: number) => {
    store.createBatch(
      specs.map((s, i) => ({
        ...s,
        color: colorFor(i + 1, salt),
      })),
    );
  };
  add(specsA, 1);
  add(specsB, 2);
  add(specsC, 3);
}

/** 密集场景：5 个批次共 125 个实例，网格排布 + 少量随机旋转/镜像 */
export function buildDenseScene(store: InstanceStore): void {
  const grid = 5;
  const gap = 1.55;
  const span = (grid - 1) * gap;
  let salt = 10;
  for (let batch = 0; batch < 5; batch++) {
    const specs: Spec[] = [];
    for (let gz = 0; gz < grid; gz++) {
      for (let gx = 0; gx < grid; gx++) {
        const idx = gz * grid + gx;
        const x = gx * gap - span / 2 + (batch - 2) * 0.18;
        const z = gz * gap - span / 2 + (batch % 2) * 0.25;
        const y = (batch - 2) * 1.7;
        // 每批随机挑几个做旋转/非均匀/镜像，其余保持规整
        const roll = (idx * 7 + batch * 13) % 11;
        const rot: Vec3 =
          roll === 0 ? [18, 24, 0] : roll === 1 ? [0, 35, 12] : [0, 0, 0];
        const scl: Vec3 =
          roll === 2
            ? [0.55, 1.35, 0.55]
            : roll === 3
              ? [-1, 0.9, 0.9]
              : roll === 4
                ? [1.1, -1.1, 0.8]
                : [0.92, 0.92, 0.92];
        specs.push({
          position: [x, y, z],
          rotationDeg: rot,
          scale: scl,
          color: [0, 0, 0],
        });
      }
    }
    store.createBatch(
      specs.map((s, i) => ({ ...s, color: colorFor(i + 1, salt++) })),
    );
  }
}

/** 在当前场景上再追加一批规则排列的实例 */
export function buildExtraBatch(store: InstanceStore, batchOrdinal: number): void {
  const count = 8;
  const specs: Spec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      position: [
        (i - count / 2) * 1.5,
        4.2 + (batchOrdinal % 2) * 1.2,
        -3 - batchOrdinal,
      ],
      rotationDeg: i % 3 === 0 ? [0, 25, 0] : [0, 0, 0],
      scale: i % 4 === 0 ? [-1, 1, 1] : [0.9, 0.9, 0.9],
      color: [0, 0, 0],
    });
  }
  store.createBatch(
    specs.map((s, i) => ({ ...s, color: colorFor(i + 1, 20 + batchOrdinal) })),
  );
}
