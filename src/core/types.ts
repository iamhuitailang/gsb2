export type PortType = 'color' | 'mask';

export type ParamKind = 'number' | 'seed' | 'color' | 'select' | 'boolean';

export type ParamValue = number | string | boolean;

export interface PortDef {
  key: string;
  label: string;
  type: PortType;
  required?: boolean;
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  default: ParamValue;
  min?: number;
  max?: number;
  step?: number;
  options?: SelectOption[];
  help?: string;
  /** Hide a param when it does not apply to the current settings. */
  visible?: (params: Record<string, ParamValue>) => boolean;
}

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA channels in [0, 1], row major. */
  data: Float32Array;
}

export interface EvalContext {
  width: number;
  height: number;
  params: Record<string, ParamValue>;
  inputs: Record<string, RasterImage | undefined>;
}

/** Every port a node produces. */
export interface NodeOutput {
  color: RasterImage;
  mask?: RasterImage;
}

export interface NodeDef {
  type: string;
  title: string;
  category: '生成器' | '处理' | '合成' | '输出';
  description: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  evaluate: (ctx: EvalContext) => NodeOutput;
}

export interface NodeInstance {
  id: string;
  type: string;
  label: string;
  x: number;
  y: number;
  params: Record<string, ParamValue>;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface Edge {
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

/** 0 means "fit the available space"; positive values are explicit scales. */
export interface PreviewSettings {
  resolution: number;
  zoom: number;
}

export interface Project {
  version: 1;
  name: string;
  nodes: NodeInstance[];
  edges: Edge[];
  view: ViewState;
  /** Preview resolution and display zoom persist with the project. */
  preview: PreviewSettings;
  activeOutputId: string | null;
}

export interface ConnectionResult {
  ok: boolean;
  reason?: string;
  edge?: Edge;
  replaced?: Edge;
}
