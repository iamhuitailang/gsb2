/** 全部共享类型定义 */

/** 可以上传到 uniform 的标量/向量值；texture 类型存 dataURL 字符串 */
export type UniformValue = number | number[] | boolean | string;

/** 侧栏可编辑的 uniform 类型 */
export type UniformKind =
  | 'float'
  | 'int'
  | 'bool'
  | 'color'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'texture';

/** 从着色器源码解析出的 uniform 描述 */
export interface UniformMeta {
  /** 变量名 */
  name: string;
  /** GLSL 类型，如 float / vec3 / sampler2D */
  glslType: string;
  /** 控件类型 */
  kind: UniformKind;
  /** 组件个数：float=1, vec2=2 ... */
  size: number;
  /** 注解中的取值范围 */
  min?: number;
  max?: number;
  step?: number;
  /** 注解中声明的默认值 */
  default?: UniformValue;
}

/** 着色器编译诊断信息 */
export interface ShaderDiagnostic {
  /** 相对用户源码的行号（从 1 开始） */
  line: number;
  /** 原始行号（含引擎注入的前缀） */
  rawLine: number;
  message: string;
}

/** 一次编译的结果 */
export interface CompileResult {
  ok: boolean;
  diagnostics: ShaderDiagnostic[];
  /** 编译成功后得到的 uniform 元数据 */
  uniforms: UniformMeta[];
  /** 合并后的 uniform 值（同名同类型保留旧值，新增项取默认值） */
  values?: Record<string, UniformValue>;
}

export type PreviewMode = 'fullscreen' | 'mesh';

export interface PreviewSettings {
  mode: PreviewMode;
  /** 画布内部分辨率预设的 key，或数字表示自定义宽度 */
  resolutionKey: string;
  customWidth: number;
  customHeight: number;
  /** 后处理开关（post 源码为空时自动停用） */
  postEnabled: boolean;
}

export interface TimeState {
  playing: boolean;
  /** 当前时间（秒），暂停时可拖动修改 */
  time: number;
}

/** 工程文件格式：保存 / 重开都使用它 */
export interface ProjectData {
  format: 'shader-lab-project';
  version: 1;
  name: string;
  savedAt: string;
  source: {
    main: string;
    post: string;
  };
  /** name -> 值（纹理存 dataURL 字符串） */
  uniforms: Record<string, UniformValue>;
  preview: PreviewSettings;
  time: TimeState;
}

/** 运行时纹理条目 */
export interface TextureEntry {
  name: string;
  /** 浏览器内的 dataURL，可直接放进工程文件 */
  dataUrl: string;
  texture: WebGLTexture | null;
  width: number;
  height: number;
}
