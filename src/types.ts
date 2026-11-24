namespace SamplerLab {
  // ---------- 基础类型 ----------

  export interface Vec2 {
    x: number;
    y: number;
  }

  /** 颜色一律以 0..1 浮点线性无关的存储值(sRGB 编码值)保存，混合时再决定是否转线性 */
  export interface RGB {
    r: number;
    g: number;
    b: number;
  }

  export interface Triangle {
    id: string;
    name: string;
    /** 三个顶点，坐标单位为「像素」，允许小数；y 轴向下（屏幕坐标） */
    v: [Vec2, Vec2, Vec2];
    /** 深度，约定越小越靠前，范围 0..1 */
    depth: number;
    color: RGB;
    enabled: boolean;
  }

  export type SampleMode = 'center' | 'msaa4';
  export type BlendMode = 'stored' | 'linear';

  export interface SceneConfig {
    width: number;
    height: number;
    sampleMode: SampleMode;
    blendMode: BlendMode;
    background: RGB;
    triangles: Triangle[];
    /** 平移重放轨迹；手动改顶点后会被清空 */
    track: ReplayTrack;
  }

  // ---------- 采样 ----------

  export interface SamplePoint {
    /** 像素内偏移，0..1；像素中心为 (0.5, 0.5) */
    ox: number;
    oy: number;
    /** 固定标签，例如 C / S0..S3 */
    label: string;
  }

  /** 单个采样点被某个三角形覆盖的判定记录 */
  export interface SampleCoverage {
    triId: string;
    /** 三条有向边的边函数原始值（未归一化），<=0 即落在该边外侧或开放边上 */
    edgeValues: [number, number, number];
  }

  export interface SampleResult {
    index: number;
    point: SamplePoint;
    /** 所有覆盖该点的面（含深度输掉的候选） */
    candidates: SampleCoverage[];
    /** 深度测试后胜出的面 id；null 表示背景 */
    winnerId: string | null;
    /** 该点最终参与混合的存储色（胜出面颜色或背景色） */
    color: RGB;
  }

  // ---------- 像素结果 ----------

  export interface PixelResult {
    px: number;
    py: number;
    samples: SampleResult[];
    /** 直接混合存储值得到的像素色（0..1，未取整） */
    blendedStored: RGB;
    /** 转线性后按亮度混合、再编码回来的像素色 */
    blendedLinear: RGB;
    /** 当前场景 blendMode 对应的最终色 */
    final: RGB;
    /** 覆盖统计：有多少采样点命中了非背景面 */
    coveredCount: number;
  }

  // ---------- 几何诊断 ----------

  export type TriIssueKind = 'degenerate-area' | 'duplicate-vertex' | 'reversed-winding' | 'ok';

  export interface TriDiagnosis {
    triId: string;
    kind: TriIssueKind;
    /** 两倍有符号面积（屏幕坐标，y 向下） */
    signedArea2: number;
    /** 归一化后的实际用于光栅化的顶点顺序（逆时针 CCW），退化时为 null */
    normalized: [Vec2, Vec2, Vec2] | null;
    duplicatePairs: number[][];
    messages: string[];
  }

  export interface SharedEdgeInfo {
    triA: string;
    triB: string;
    /** 共用边端点（浮点，来自 A） */
    a: Vec2;
    b: Vec2;
    /** 两条边的遍历方向是否相反：相反则半开规则能保证不重不漏 */
    oppositeDirection: boolean;
    /** 端点是否分别重合（浮点全等判断） */
    exact: boolean;
    note: string;
  }

  // ---------- 重放 ----------

  export interface ReplayStep {
    triId: string;
    dx: number;
    dy: number;
  }

  export interface ReplayTrack {
    /** 录制开始时的三角形基底快照 */
    base: { triId: string; v: [Vec2, Vec2, Vec2] }[];
    steps: ReplayStep[];
  }

  // ---------- 保存/读取 ----------

  export interface PixelRecord {
    format: 'sampling-lab-pixel';
    version: 1;
    savedAt: string;
    scene: SceneConfig;
    selectedPixel: { px: number; py: number };
    pixel: SerializedPixel;
  }

  export interface SerializedPixel {
    px: number;
    py: number;
    candidates: {
      triId: string;
      name: string;
      depth: number;
      color: RGB;
      coveredSamples: number[];
    }[];
    samples: {
      label: string;
      ox: number;
      oy: number;
      winnerId: string | null;
      winnerDepth: number | null;
      color: RGB;
      coveredBy: string[];
    }[];
    blendedStored: RGB;
    blendedLinear: RGB;
    final: RGB;
  }
}
