// 确定性场景:任意帧号 N 的全部状态都是纯函数 evaluate(N) 的结果。
// 画面要素:
//   - 静止细线墙(程序化竖/横线,含亚像素级细线,考察静止边缘稳定性)
//   - 栅栏 A/B:不同速度、不同深度的板条组(考察移动边缘重影)
//   - 遮挡物:按帧号滑入滑出,挪开瞬间制造刚显露区域(考察历史剔除)
//   - 相机:缓慢漂移 + 计划内瞬移(考察相机跳变重开规则)
import {
  mat4Compose, mat4LookAt, pingPong, smoothstep,
} from './math.js';
import { mulberry32, hashSeed } from './prng.js';
import { FIXED_DT } from './clock.js';

export const JUMP_FRAME = 300; // 计划内相机瞬移帧(锁定路径的一部分)

// 单个立方体板条的局部参数(组内静态,逐帧只更新组矩阵)。
// 两端各加一根横梁(rail),让栅栏有完整轮廓与更长的水平移动边缘。
function slatGroup(count, spacing, slatW, slatH, slatD) {
  const slats = [];
  for (let i = 0; i < count; i++) {
    slats.push({
      offset: [(i - (count - 1) / 2) * spacing, 0, 0],
      scale: [slatW, slatH, slatD],
    });
  }
  const span = (count - 1) * spacing + slatW;
  const railH = slatW * 1.4;
  slats.push({ offset: [0, slatH / 2 - railH / 2, 0], scale: [span, railH, slatD] });
  slats.push({ offset: [0, -slatH / 2 + railH / 2, 0], scale: [span, railH, slatD] });
  return slats;
}

export function createScene(seedStr = 'fence-0001') {
  const rng = mulberry32(hashSeed(seedStr));
  // 路径参数随 seed 变化,但对同一 seed 恒定 —— 换镜头可复现
  const params = {
    seed: seedStr,
    cameraDrift: 0.22 + rng() * 0.08,
    fenceAPeriod: 8.4 + rng() * 1.2,
    fenceBPeriod: 5.8 + rng() * 1.0,
    occluderIn0: 90 + Math.floor(rng() * 20),
    occluderIn1: 120 + Math.floor(rng() * 20),
    occluderOut0: 200 + Math.floor(rng() * 20),
    occluderOut1: 235 + Math.floor(rng() * 20),
  };

  // 静态几何定义(模型矩阵逐帧给出,实例数据不变)
  // 深度布局(相机在 z≈2.35 看向 -z):墙最远 -> 遮挡物 -> 栅栏 A -> 栅栏 B -> 漂浮方块
  const defs = {
    wall: { kind: 'wall', z: -1.7, halfW: 1.55, halfH: 0.95 },
    fenceA: {
      kind: 'fence', color: [0.95, 0.32, 0.1],
      slats: slatGroup(8, 0.17, 0.075, 0.78, 0.07),
      base: [-0.62, 0.0, -0.85],
    },
    fenceB: {
      kind: 'fence', color: [0.16, 0.5, 0.98],
      slats: slatGroup(6, 0.2, 0.085, 0.62, 0.08),
      base: [0.66, -0.08, -0.45],
    },
    occluder: {
      kind: 'box', color: [0.38, 0.36, 0.44],
      scale: [0.34, 1.3, 0.14],
    },
    floatBox: {
      kind: 'box', color: [0.1, 0.62, 0.44],
      scale: [0.18, 0.18, 0.18],
    },
  };

  // manualJump:UI 手动制造的相机瞬移;记录生效帧,seek 重放时保持同一断点
  function evaluate(frame, manualJump = { frame: -1, offset: 0 }) {
    const t = frame * FIXED_DT;

    // ---- 相机:缓慢横移 + 轻微起伏,帧 300 计划内瞬移 ----
    // eye 与 center 同步加上漂移/跳变基线,保证视线始终对准场景中心,
    // 不会因为跳变把视锥推出画面。
    const driftX = Math.sin((2 * Math.PI * t) / 24) * params.cameraDrift;
    const bobY = Math.sin((2 * Math.PI * t) / 7) * 0.03;
    const plannedJump = frame >= JUMP_FRAME ? 0.45 : 0;
    const manual = frame >= manualJump.frame && manualJump.frame >= 0
      ? manualJump.offset : 0;
    const baseX = plannedJump + manual;
    const eye = [baseX + driftX, bobY, 2.35];
    const center = [baseX, 0, -0.4];
    const view = mat4LookAt(eye, center);
    const cameraJump = frame === JUMP_FRAME
      || frame === manualJump.frame;

    // ---- 栅栏 A/B:不同周期、不同相位的往复平移,B 带小幅摆头 ----
    // 行程不越过各自基准侧太多,保证两条栅栏大部分时间可区分、不重叠
    const xA = pingPong(t + params.fenceAPeriod * 0.15, params.fenceAPeriod, -0.28, 0.28);
    const xB = pingPong(t + params.fenceBPeriod * 0.6, params.fenceBPeriod, -0.22, 0.22);
    const fenceAModel = mat4Compose(
      [defs.fenceA.base[0] + xA, defs.fenceA.base[1], defs.fenceA.base[2]], 0, [1, 1, 1],
    );
    const fenceBModel = mat4Compose(
      [defs.fenceB.base[0] + xB, defs.fenceB.base[1], defs.fenceB.base[2]],
      Math.sin(t * 0.9) * 0.12, [1, 1, 1],
    );

    // ---- 遮挡物:滑入 -> 停留 -> 滑出,停留时盖住右半区细线与栅栏 ----
    const inK = smoothstep(params.occluderIn0, params.occluderIn1, frame);
    const outK = 1 - smoothstep(params.occluderOut0, params.occluderOut1, frame);
    const coverK = Math.min(inK, outK); // 0=画面外,1=完全盖住
    const occX = 2.2 + (0.45 - 2.2) * coverK;
    const occluderModel = mat4Compose([occX, 0, -1.25], 0, defs.occluder.scale);
    // 完全离开画面后不再参与遮挡,供统计与调试标记使用
    const occluderVisible = coverK > 0.001;
    const revealFrame = params.occluderOut0; // 开始挪开的帧

    // ---- 漂浮小方块:中等速度,补一组不同尺寸的移动边缘 ----
    const fbx = pingPong(t, 4.6, -1.1, 1.1);
    const fby = 0.62 + Math.sin(t * 2.1) * 0.14;
    const floatBoxModel = mat4Compose([fbx, fby, 0.1], t * 0.7, defs.floatBox.scale);

    return {
      frame,
      t,
      params,
      camera: { eye, center, view, jump: cameraJump },
      models: {
        fenceA: fenceAModel,
        fenceB: fenceBModel,
        occluder: occluderModel,
        floatBox: floatBoxModel,
      },
      occluder: { visible: occluderVisible, coverK, revealFrame },
    };
  }

  return { params, defs, evaluate };
}
