import { DEFAULT_DOOR_STATES } from './scene.js';

const yawTo = (from, x, z) => {
  const dx = x - from[0];
  const dz = z - from[2];
  // yaw=0 looks toward -Z; this inverse matches the camera forward formula.
  return Math.atan2(dx, -dz);
};

const allOpen = () => ({ ...DEFAULT_DOOR_STATES });

export const PRESETS = [
  {
    id: 'vista',
    name: '1. 两门洞远视',
    description: 'A 中央客厅 → AB → B 连廊 → BC → C 远景室，应保留金色方尖碑。',
    position: [0, 1.62, 2.7],
    yaw: 0,
    pitch: -0.035,
    doors: allOpen,
    expect: [
      { portalId: 'D_AB', status: 'continue' },
      { portalId: 'D_BC', status: 'continue' },
    ],
  },
  {
    id: 'offscreen',
    name: '2. 门在屏幕外',
    description: '仍看向北侧 AB，但东侧 AD 的水平夹角超出视锥，应记录为屏幕外。',
    position: [-3.35, 1.62, 2.55],
    yaw: 0,
    pitch: 0,
    doors: allOpen,
    expect: [
      { portalId: 'D_AB', status: 'continue' },
      { portalId: 'D_AD', status: 'offscreen' },
    ],
  },
  {
    id: 'occluded',
    name: '3. 被前一个门洞遮住',
    description: '相机右移并转向 AB；BC 虽在屏幕内，角度区间却落在 AB 孔径外。',
    position: [2.85, 1.62, 1.05],
    yaw: yawTo([2.85, 1.62, 1.05], 0, -4),
    pitch: 0,
    doors: allOpen,
    expect: [
      { portalId: 'D_AB', status: 'continue' },
      { portalId: 'D_BC', status: 'occluded' },
    ],
  },
  {
    id: 'edge',
    name: '4. 贴到门边',
    description: '相机贴着 AD 南侧门框并斜看向门洞；近平面截断不能把 D 误删。',
    position: [4.42, 1.62, 1.08],
    yaw: 0.78,
    pitch: 0,
    doors: allOpen,
    expect: [
      { portalId: 'D_AD', status: 'continue' },
    ],
  },
  {
    id: 'junction',
    name: '5. 房间交界',
    description: '站在 AD 门槛上，相机同时属于 A、D，两个房间都以完整视锥开始搜索。',
    position: [4.98, 1.62, 0],
    yaw: Math.PI - 0.18,
    pitch: 0,
    doors: allOpen,
    expect: [
      { roomId: 'A', status: 'root' },
      { roomId: 'D', status: 'root' },
      { portalId: 'D_DE', status: 'continue' },
    ],
  },
  {
    id: 'loop',
    name: '6. 回路的另一条路径',
    description: '斜穿 AE 到 E，再穿过 DE 到 D；A→D→DE 会被 AD 孔径遮住，而 E→DE 这条回路仍保留 D。',
    // This point lies on the center line through AE(-1.5,4) and DE(5,7.5).
    position: [-4.38, 1.62, 2.45],
    yaw: yawTo([-4.38, 1.62, 2.45], 5, 7.5),
    pitch: 0,
    doors: allOpen,
    expect: [
      { portalId: 'D_AE', status: 'continue' },
      { portalId: 'D_DE', status: 'continue' },
      { roomId: 'D', status: 'visible' },
    ],
  },
  {
    id: 'closed',
    name: '7. 关门对比',
    description: '与 1 号机同位置，但 AB 关闭；B、C 应略过，门板仍在实际绘制列表中。',
    position: [0, 1.62, 2.7],
    yaw: 0,
    pitch: -0.035,
    doors: () => ({ ...DEFAULT_DOOR_STATES, D_AB: false }),
    expect: [
      { portalId: 'D_AB', status: 'closed' },
      { roomId: 'B', status: 'hidden' },
      { roomId: 'C', status: 'hidden' },
    ],
  },
];

export function presetCamera(preset) {
  return {
    position: [...preset.position],
    yaw: preset.yaw,
    pitch: preset.pitch || 0,
    fovY: Math.PI / 180 * 70,
  };
}
