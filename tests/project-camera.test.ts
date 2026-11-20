import { describe, expect, it } from 'vitest';
import { bbox } from '../src/core/math';
import { OrbitCamera } from '../src/core/orbit-camera';
import {
  buildProjectFile,
  parseProject,
  projectToSources,
  reconcileMaterialOverrides,
  reconcileNodeOverrides,
} from '../src/core/project';
import { buildScene } from '../src/core/build-scene';
import { parseObj } from '../src/core/obj-parser';
import type { LoadedSource } from '../src/core/types';

describe('OrbitCamera', () => {
  it('frame 后目标点为包围盒中心且距离为正', () => {
    const cam = new OrbitCamera();
    cam.aspect = 1;
    cam.frame({ min: [-1, -1, -1], max: [1, 1, 1] });
    expect(cam.target).toEqual([0, 0, 0]);
    expect(cam.distance).toBeGreaterThan(0);
  });

  it('状态序列化再恢复保持一致', () => {
    const cam = new OrbitCamera();
    cam.target = [1, 2, 3];
    cam.distance = 7.5;
    cam.yaw = 1.2;
    cam.pitch = 0.4;
    const state = cam.getState();
    const cam2 = new OrbitCamera();
    cam2.setState(state);
    expect(cam2.getState()).toEqual(state);
  });

  it('空包围盒不改变相机', () => {
    const cam = new OrbitCamera();
    const before = cam.getState();
    cam.frame(bbox.empty());
    expect(cam.getState()).toEqual(before);
  });
});

describe('项目文件往返', () => {
  const sources: LoadedSource[] = [
    { name: 'm.obj', text: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3', dataUrl: null, kind: 'obj' },
    { name: 'm.mtl', text: 'newmtl Red\nKd 1 0 0', dataUrl: null, kind: 'mtl' },
    { name: 'i.png', text: null, dataUrl: 'data:image/png;base64,AAAA', kind: 'texture' },
  ];

  function sampleModel() {
    const parsed = parseObj(sources[0].text!, 'm.obj');
    return buildScene({ parsed, mtls: [], availableTextures: new Set(['i.png']), objFileName: 'm.obj' });
  }

  it('保存再解析为合法 ProjectFile 且源数据完整', () => {
    const model = sampleModel();
    const project = buildProjectFile({
      sources,
      model,
      camera: { target: [0, 0, 0], distance: 5, yaw: 1, pitch: 0.3 },
      displayMode: 'wireframe',
      environment: 'night',
      nodeOverrides: new Map([['o:0', { hidden: true, colorOverride: '#ff0000' }]]),
      materialOverrides: new Map([['Red', { diffuse: '#00ff00' }]]),
      selectedNodeId: 'o:0',
    });
    const text = JSON.stringify(project);
    const restored = parseProject(text);
    expect(restored.format).toBe('webgl-model-viewer-project');
    expect(restored.displayMode).toBe('wireframe');
    expect(restored.environment).toBe('night');
    const loaded = projectToSources(restored);
    expect(loaded.map((s) => s.name)).toEqual(['m.obj', 'm.mtl', 'i.png']);
    expect(loaded[2].dataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('非法格式抛出明确错误', () => {
    expect(() => parseProject(JSON.stringify({ format: 'nope' }))).toThrow(/格式|版本/);
    expect(() => parseProject('{bad json')).toThrow(/JSON/);
  });

  it('覆盖项按稳定 ID 与材质名校验，失效条目被丢弃', () => {
    const model = sampleModel();
    const nodeOverrides = reconcileNodeOverrides(
      { 'o:0': { hidden: true }, 'o:99': { hidden: true } },
      model.root,
    );
    expect(nodeOverrides.has('o:0')).toBe(true);
    expect(nodeOverrides.has('o:99')).toBe(false);

    const matOverrides = reconcileMaterialOverrides(
      { Red: { diffuse: '#fff' }, Gone: { opacity: 0.5 } },
      model,
    );
    expect(matOverrides.size).toBe(0); // 该模型没有 mtl，Red 不存在
  });
});
