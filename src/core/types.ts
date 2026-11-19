/**
 * 粒子工坊 —— 数据模型
 *
 * 坐标约定：世界坐标使用屏幕风格的 x 向右、y 向下，单位为像素。
 * 舞台设计尺寸固定为 1000 × 640，渲染时等比缩放到当前画布。
 */

export const PROJECT_VERSION = 1;
export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 640;

export interface Vec2 {
  x: number;
  y: number;
}

export type SpaceMode = 'local' | 'world';
export type BlendMode = 'normal' | 'additive';
export type TextureKind = 'soft' | 'smoke' | 'spark';
export type MotionType = 'static' | 'orbit' | 'pingpong';
export type BackgroundMode = 'preview' | 'dark' | 'transparent';
export type EmissionMode = 'rate' | 'burst';
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'smoothstep';
export type Interpolation = Easing;

export interface CurvePoint {
  /** 归一化寿命时间，0..1 */
  t: number;
  /** 曲线值 */
  v: number;
}

export interface Curve {
  points: CurvePoint[];
  interpolation: Easing;
}

export interface ColorStop {
  /** 归一化寿命时间，0..1 */
  t: number;
  /** #rrggbb */
  color: string;
}

export interface Gradient {
  stops: ColorStop[];
}

export interface MotionConfig {
  type: MotionType;
  /** 角速度，弧度/秒 */
  speed: number;
  /** 水平/环绕半径，像素 */
  radius: number;
  /** 纵向半径（orbit / pingpong 时使用），像素 */
  radiusY: number;
  /** 初始相位，度 */
  phase: number;
}

export interface EmissionConfig {
  mode: EmissionMode;
  /** 持续发射：每秒发射数量 */
  rate: number;
  /** 持续发射窗口 / 循环周期时长，秒 */
  duration: number;
  /** 是否循环发射窗口 */
  loop: boolean;
  /** 第一次发射前的延迟，秒 */
  startDelay: number;
  /** 爆发：一次喷出的数量 */
  burstCount: number;
  /** 爆发：在一个发射周期内的触发时间，秒 */
  burstTime: number;
}

export interface RangeConfig {
  min: number;
  max: number;
}

export interface DirectionConfig {
  /** 角度，度；0° 向右，90° 向下，270° 向上 */
  angle: number;
  /** 方向扩散范围，度 */
  spread: number;
}

export interface EmitterConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** 发射器基准位置（世界坐标） */
  position: Vec2;
  motion: MotionConfig;
  space: SpaceMode;
  texture: TextureKind;
  blend: BlendMode;
  emission: EmissionConfig;
  speed: RangeConfig;
  direction: DirectionConfig;
  /** 出生点圆盘半径，像素 */
  spawnRadius: number;
  /** 粒子寿命范围，秒 */
  lifetime: RangeConfig;
  /** 大小随归一化寿命变化的曲线，像素 */
  sizeCurve: Curve;
  /** 不透明度随归一化寿命变化的曲线，0..1 */
  alphaCurve: Curve;
  /** 颜色随归一化寿命变化的渐变 */
  gradient: Gradient;
  /** 全局不透明度倍率，0..1 */
  alpha: number;
  /** 重力倍率；最终重力 = 场景重力 × 该倍率 */
  gravityScale: number;
}

export interface SceneConfig {
  /** 随机种子；相同参数 + 相同种子得到完全一致的结果 */
  seed: number;
  /** 时间轴长度，秒 */
  duration: number;
  /** 时间轴帧率 */
  fps: number;
  /** 重力，像素/秒² */
  gravity: Vec2;
  /** 粒子总预算上限；超过后截断并提示 */
  maxParticles: number;
  /** 预览背景 */
  background: BackgroundMode;
}

export interface Project {
  version: number;
  name: string;
  scene: SceneConfig;
  emitters: EmitterConfig[];
}

export interface Particle {
  x: number;
  y: number;
  /** 当前速度，供火花这类需要朝向的贴图使用 */
  vx: number;
  vy: number;
  size: number;
  alpha: number;
  color: [number, number, number];
  /** 出生时间（秒） */
  spawnTime: number;
  /** 已存活时间（秒） */
  age: number;
  life: number;
  /** 归一化寿命，0..1 */
  u: number;
  /** 程序化贴图变体序号 */
  variant: number;
}

export interface EmitterSimResult {
  emitterId: string;
  particles: Particle[];
  /** 出生窗口内的候选粒子总量 */
  candidateCount: number;
  /** 本轮实际检查的候选数 */
  scannedCount: number;
  /** 存活粒子数（抽样扫描时为估计值） */
  aliveCount: number;
  /** 因预算被裁剪的粒子数 */
  omitted: number;
  /** 分配给该发射器的渲染预算 */
  budget: number;
  /** 是否因预算被裁剪 */
  truncated: boolean;
  /** 候选过多导致的扫描抽样 */
  scanReduced: boolean;
  /** 该发射器的仿真耗时（毫秒） */
  simMs: number;
}

export interface SimulationResult {
  emitters: EmitterSimResult[];
  /** 实际渲染的粒子总数 */
  total: number;
  /** 候选出生总数 */
  candidateTotal: number;
  /** 存活总数（裁剪前） */
  aliveTotal: number;
  /** 被裁剪总数 */
  omittedTotal: number;
  /** 生效的预算上限 */
  cap: number;
  /** 是否发生裁剪 */
  capped: boolean;
  /** 存活数是否超出预算 */
  overBudget: boolean;
  /** 是否发生扫描抽样 */
  scanReduced: boolean;
}
