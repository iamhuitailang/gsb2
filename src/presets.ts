namespace SamplerLab {
  // ---------- 三组内置例子（画布统一 10x10，故意低分辨率） ----------

  export interface Preset {
    id: string;
    label: string;
    description: string;
    build: () => SceneConfig;
  }

  const SIZE = 10;

  function baseScene(triangles: Triangle[], blendMode: BlendMode = 'linear'): SceneConfig {
    return {
      width: SIZE,
      height: SIZE,
      sampleMode: 'msaa4',
      blendMode,
      background: rgb(0.06, 0.07, 0.11),
      triangles,
      track: emptyTrack(),
    };
  }

  let counter = 0;
  function makeTri(name: string, v: [Vec2, Vec2, Vec2], depth: number, color: RGB): Triangle {
    counter += 1;
    return { id: `t${counter}`, name, v, depth, color, enabled: true };
  }

  /** 例子一：薄三角。宽度不足一个像素的斜条，开关 MSAA 时边缘会「多出一圈/少一圈」 */
  function thinSliver(): SceneConfig {
    const sliver = makeTri(
      '薄斜条',
      [v2(1.2, 8.4), v2(8.6, 1.6), v2(8.95, 1.95)],
      0.35,
      rgb(0.95, 0.35, 0.2),
    );
    const wide = makeTri(
      '衬底三角',
      [v2(0.3, 9.6), v2(9.7, 9.6), v2(5.2, 4.2)],
      0.8,
      rgb(0.2, 0.55, 0.95),
    );
    return baseScene([sliver, wide], 'linear');
  }

  /** 例子二：共享边。两个三角形拼满画布，共用 x=5.5 的竖边，同深度，验证不重不漏 */
  function sharedEdge(): SceneConfig {
    const left = makeTri(
      '左半红',
      [v2(0.2, 0.4), v2(5.5, 0.4), v2(5.5, 9.6)],
      0.5,
      rgb(0.9, 0.25, 0.25),
    );
    const right = makeTri(
      '右半蓝',
      [v2(5.5, 0.4), v2(9.8, 0.4), v2(5.5, 9.6)],
      0.5,
      rgb(0.25, 0.45, 0.95),
    );
    const scene = baseScene([left, right], 'linear');
    scene.background = rgb(0.02, 0.02, 0.03);
    return scene;
  }

  /** 例子三：交叠斜边。两个三角形沿斜边大面积交叠，深度决定每个采样点归谁 */
  function overlappingDiagonal(): SceneConfig {
    const front = makeTri(
      '红三角(靠前)',
      [v2(0.5, 0.6), v2(9.4, 2.2), v2(4.1, 9.3)],
      0.25,
      rgb(0.95, 0.3, 0.25),
    );
    const back = makeTri(
      '青三角(靠后)',
      [v2(0.8, 8.9), v2(9.2, 8.2), v2(6.6, 0.8)],
      0.65,
      rgb(0.2, 0.85, 0.75),
    );
    const scene = baseScene([front, back], 'linear');
    scene.background = rgb(0.05, 0.05, 0.08);
    return scene;
  }

  export const PRESETS: Preset[] = [
    {
      id: 'thin',
      label: '薄三角',
      description:
        '宽度不足一个像素的斜条压在衬底三角上。中心采样会整条漏掉或只留几个点，MSAA 4x 让边缘像素出现部分覆盖；再切换「存储值/线性」混合看深背景上的边缘色差。',
      build: thinSliver,
    },
    {
      id: 'shared',
      label: '共享边',
      description:
        '两个同深度三角形共用 x=5.5 的竖边。左上填充规则保证边界采样点只被一侧收下。把任一三角形顶点顺序改成反向（CW）可观察共享边分析面板的告警变化。',
      build: sharedEdge,
    },
    {
      id: 'overlap',
      label: '交叠斜边',
      description:
        '两个三角形沿斜边互相盖住，逐采样点比较覆盖列表与深度胜者。交换两者深度后，斜边像素的颜色归属应整体翻转且无空洞。',
      build: overlappingDiagonal,
    },
  ];

  export function defaultScene(): SceneConfig {
    return thinSliver();
  }
}
