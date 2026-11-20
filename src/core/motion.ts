import type { Project, SceneObjectData, Vec3 } from './types.js';

export type SampleVec3 = Vec3;

export function captureObjectState(obj: SceneObjectData, time: number): SceneObjectData {
  if (!obj.motion) return obj;
  const { center, radiusX, radiusZ, height, speed, phase, bob } = obj.motion;
  const angle = phase + time * speed;
  const position: Vec3 = [
    center[0] + Math.cos(angle) * radiusX,
    height + Math.sin(angle * 0.7 + phase) * bob,
    center[2] + Math.sin(angle) * radiusZ,
  ];
  const tangent: Vec3 = [-Math.sin(angle) * radiusX, 0, Math.cos(angle) * radiusZ];
  const heading = Math.atan2(tangent[0], tangent[2]);
  return {
    ...obj,
    position,
    rotation: [0, (heading * 180) / Math.PI, 0],
  };
}

export function captureSceneState(project: Project, time: number): SceneObjectData[] {
  return project.objects.map((o) => captureObjectState(o, time));
}

export function findTarget(project: Project, time: number): Vec3 | null {
  const aim = project.camera.aim;
  if (aim.targetObjectId) {
    const obj = project.objects.find((o) => o.id === aim.targetObjectId);
    if (obj) {
      const live = captureObjectState(obj, time);
      return [
        live.position[0] + aim.targetOffset[0],
        live.position[1] + aim.targetOffset[1],
        live.position[2] + aim.targetOffset[2],
      ];
    }
  }
  return [aim.targetPoint[0], aim.targetPoint[1], aim.targetPoint[2]];
}
