/**
 * 纯逻辑自检：npm run test:logic
 * 不依赖浏览器 / three 渲染，验证：
 *  1. 路线时间轴端点、循环 / 往返映射
 *  2. 区域包含与滞回
 *  3. 参数混合器中途反向切换不产生跳变
 */
import { createDefaultProject } from '../src/core/defaults';
import { ParamBlender, selectZone } from '../src/camera/zones';
import { RouteTimeline } from '../src/route/RouteTimeline';
import type { CameraZone } from '../src/core/types';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}
function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

const project = createDefaultProject();

console.log('\n[1] RouteTimeline');
{
  const tl = new RouteTimeline(project.route.waypoints);
  assert(tl.duration > 10, `总时长合理（${tl.duration.toFixed(2)}s）`);
  const s0 = tl.sample(0, 'once');
  assert(approx(s0.position.x, -15) && approx(s0.position.z, 6), 't=0 在第一个路径点');
  const sEnd = tl.sample(tl.duration, 'once');
  const last = project.route.waypoints.at(-1)!;
  assert(approx(sEnd.position.x, last.x) && approx(sEnd.position.z, last.z, 1e-5), 't=duration 在最后路径点');
  assert(sEnd.finished === true, 'once 模式结尾标记 finished');

  const loop = tl.mapTime(tl.duration + 0.5, 'loop');
  assert(approx(loop.time, 0.5), 'loop 超出后取模');
  const pp = tl.mapTime(tl.duration + 1.2, 'pingpong');
  assert(approx(pp.time, tl.duration - 1.2) && pp.forward === false, 'pingpong 折返段时间与方向正确');
}

console.log('\n[2] selectZone / 滞回');
{
  const plaza = project.zones.find((z) => z.id === 'zone_plaza')!;
  const inside = selectZone(project.zones, { x: -9, y: 1, z: 3 }, null);
  assert(inside.active?.id === 'zone_plaza', '广场中心选中 zone_plaza');

  // 从广场内部开始，移动到「西侧」盒子外侧 0.2m（hysteresis=0.35），该侧没有重叠区域
  const edgeWest = plaza.center[0] - plaza.size[0] / 2; // -17
  const kept = selectZone(project.zones, { x: edgeWest - 0.2, y: 1, z: 3 }, 'zone_plaza');
  assert(kept.active?.id === 'zone_plaza' && kept.hysteresisKept, '越界 0.2m < hysteresis 时保留旧区域');

  const gone = selectZone(project.zones, { x: edgeWest - 1.5, y: 1, z: 3 }, 'zone_plaza');
  assert(gone.active?.id !== 'zone_plaza', '超出 hysteresis 后不再保留');

  const door = selectZone(project.zones, { x: 0.8, y: 1, z: 0 }, null);
  assert(door.active?.id === 'zone_door', '门洞中心选中 zone_door');
  const alley = selectZone(project.zones, { x: 7.4, y: 1, z: 0 }, null);
  assert(alley.active?.id === 'zone_alley', '窄路中心选中 zone_alley');
}

console.log('\n[3] ParamBlender 反向穿界不跳变');
{
  const blender = new ParamBlender();
  const zoneTarget = (z: CameraZone | undefined) =>
    z
      ? { params: z.params, bounds: z.bounds, transitionTime: z.transitionTime, easing: z.easing, zoneName: z.name }
      : {
          params: project.defaultParams,
          bounds: { enabled: false, min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] },
          transitionTime: 0.6,
          easing: 'easeInOutCubic' as const,
          zoneName: null,
        };

  const a = project.zones.find((z) => z.id === 'zone_plaza')!;
  const b = project.zones.find((z) => z.id === 'zone_door')!;

  blender.snap(zoneTarget(a));
  const before = blender.currentParams.distance;
  blender.retarget(zoneTarget(b));
  assert(approx(blender.currentParams.distance, before), 'retarget 瞬间当前值不变（从当前混合值起步）');

  // 模拟沿 x 轴在 广场<->门洞 边界附近来回快速穿越
  let currentId: string | null = 'zone_plaza';
  blender.snap(zoneTarget(a));
  let maxJump = 0;
  let prev = blender.currentParams.distance;
  const dt = 1 / 60;
  let x = -4.2;
  let vx = 2.2; // m/s，约 8 秒内多次往返
  for (let frame = 0; frame < 60 * 12; frame++) {
    x += vx * dt;
    if (x > 2.5) vx = -Math.abs(vx);
    if (x < -4.5) vx = Math.abs(vx);
    const sel = selectZone(project.zones, { x, y: 1, z: 0 }, currentId);
    const id = sel.active?.id ?? null;
    if (id !== currentId) {
      currentId = id;
      blender.retarget(zoneTarget(id ? project.zones.find((z) => z.id === id) : undefined));
    }
    blender.update(dt);
    const jump = Math.abs(blender.currentParams.distance - prev);
    maxJump = Math.max(maxJump, jump);
    prev = blender.currentParams.distance;
  }
  console.log(`    往返穿界最大单帧 distance 跳变 = ${maxJump.toFixed(4)} m`);
  assert(maxJump < 0.9, '任何一帧参数跳变 < 0.9m（无突然跳回）');

  // 极端：过渡时间为 0 时，retarget 立即完成，但快照语义仍明确
  const instant = new ParamBlender();
  instant.snap(zoneTarget(a));
  const zero = { ...zoneTarget(b), transitionTime: 0 };
  instant.retarget(zero);
  assert(approx(instant.currentParams.distance, b.params.distance), '0s 过渡立即到位（随后由机位平滑兜底）');
}

console.log(failures === 0 ? '\n全部逻辑检查通过 ✅\n' : `\n${failures} 项失败 ❌\n`);
process.exit(failures === 0 ? 0 : 1);
