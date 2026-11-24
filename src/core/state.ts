import type { GreenConvention, HalfSide } from './tangent.ts';
import type { MeshPresetId } from './geometry.ts';
import type { TextureKind, ChannelView } from './textures.ts';

export interface CameraState {
  yawDeg: number;
  pitchDeg: number;
  distance: number;
}

export interface ModelState {
  rotationDeg: [number, number, number];
  /** 缩放绝对值（始终为正），翻转由 flips 表达 */
  scaleAbs: [number, number, number];
  flips: [boolean, boolean, boolean];
}

export interface LightState {
  yawDeg: number;
  pitchDeg: number;
}

export interface Selection {
  faceId: number | null;
  /** 命中点处的重心 UV（用于精确采样纹理） */
  u: number;
  v: number;
  half: HalfSide | null;
}

export interface AppState {
  preset: MeshPresetId;
  textureKind: TextureKind;
  convention: GreenConvention;
  camera: CameraState;
  model: ModelState;
  light: LightState;
  selection: Selection;
  channelView: ChannelView;
  showGizmo: boolean;
  highlightSeams: boolean;
  wireframe: boolean;
  diffuseIntensity: number;
  specularIntensity: number;
  shininess: number;
}

export const STORAGE_KEY = 'normal-debug-bench/state/v1';

export function defaultState(): AppState {
  return {
    preset: 'correct',
    textureKind: 'directional',
    convention: 'opengl',
    camera: { yawDeg: 25, pitchDeg: 22, distance: 9 },
    model: {
      rotationDeg: [0, 0, 0],
      scaleAbs: [1, 1, 1],
      flips: [false, false, false],
    },
    light: { yawDeg: 35, pitchDeg: 30 },
    selection: { faceId: null, u: 0, v: 0, half: null },
    channelView: 'rgb',
    showGizmo: true,
    highlightSeams: true,
    wireframe: true,
    diffuseIntensity: 0.85,
    specularIntensity: 0.6,
    shininess: 24,
  };
}

export function signedScale(model: ModelState): [number, number, number] {
  return model.scaleAbs.map((s, i) => (model.flips[i] ? -s : s)) as [number, number, number];
}
