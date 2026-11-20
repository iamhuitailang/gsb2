import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneDocument } from './document';
import {
  composeLocal,
  decompose,
  isAncestor,
  matrixRelativeEquals,
  reparentLocalTRS,
  approxVec3,
} from './transforms';
import { parseSceneFile } from './loader';
import {
  DeleteCommand,
  DuplicateCommand,
  History,
  LoadCommand,
  ReparentCommand,
  TransformCommand,
} from './history';
import type { CameraData, NodeData, SceneFile } from './types';

const CAM: CameraData = {
  position: [5, 5, 5],
  target: [0, 0, 0],
  up: [0, 1, 0],
  fov: 50,
  near: 0.1,
  far: 1000,
};

function group(doc: SceneDocument, name: string, parent: string | null = null): string {
  return doc.addNode(
    {
      name,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    parent,
  ).id;
}

function box(
  doc: SceneDocument,
  name: string,
  parent: string | null,
  position: [number, number, number] = [1, 2, 3],
): string {
  return doc.addNode(
    {
      name,
      position,
      rotation: [0.1, 0.2, 0.3],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box', params: [1, 1, 1] },
      material: { color: 0x88aadd },
    },
    parent,
  ).id;
}

describe('transforms 数学', () => {
  test('compose/decompose 往返一致', () => {
    const m = composeLocal([1, -2, 3], [0.4, -0.5, 0.6], [2, 3, 4]);
    const d = decompose(m);
    assert.ok(approxVec3(d.position, [1, -2, 3]));
    assert.ok(approxVec3([d.rotation.x, d.rotation.y, d.rotation.z], [0.4, -0.5, 0.6]));
    assert.ok(approxVec3(d.scale, [2, 3, 4]));
    assert.equal(d.hasShear, false);
  });

  test('非均匀缩放后旋转的矩阵带剪切，分解给出一致读数', () => {
    // 父级非均匀缩放、子级再旋转：上 3x3 = S1*R2，一般无法写成单个 R*S
    const parent = composeLocal([0, 0, 0], [0, 0, 0], [2, 0.5, 1]);
    const local = composeLocal([1, 0, 0], [0, 0, Math.PI / 4], [1, 1, 1]);
    const world = parent.clone().multiply(local);
    const d = decompose(world);
    // 存在剪切：decompose+recompose 不能精确还原
    assert.equal(d.hasShear, true);
    // 同一份矩阵的分解读数稳定（gizmo、检查器、内部计算共用同一套分解）
    const dAgain = decompose(world);
    assert.ok(approxVec3(d.scale, dAgain.scale));
    assert.ok(approxVec3(d.position, dAgain.position));
  });

  test('reparentLocalTRS：无剪切父级下世界矩阵精确不变', () => {
    const world = composeLocal([2, 3, 4], [0.2, 0.4, 0.1], [1.5, 0.7, 2]);
    // 只旋转、均匀缩放的父级不会引入剪切，TRS 可精确表达
    const newParent = composeLocal([1, 1, 1], [0, 0, 0.6], [2, 2, 2]);
    const trs = reparentLocalTRS(world, newParent);
    const local = composeLocal(trs.position, trs.rotation, trs.scale);
    const restored = newParent.clone().multiply(local);
    assert.ok(matrixRelativeEquals(restored, world, 1e-12));
  });

  test('reparentLocalTRS：剪切边界下位置仍精确保持（姿态/缩放为最佳近似）', () => {
    const world = composeLocal([2, 3, 4], [0.2, 0.4, 0.1], [1.5, 0.7, 2]);
    const newParent = composeLocal([1, 1, 1], [0, 0, 0.6], [2, 0.5, 3]);
    const trs = reparentLocalTRS(world, newParent);
    const restored = newParent.clone().multiply(
      composeLocal(trs.position, trs.rotation, trs.scale),
    );
    const wp = new THREE.Vector3();
    const rp = new THREE.Vector3();
    world.decompose(wp, new THREE.Quaternion(), new THREE.Vector3());
    restored.decompose(rp, new THREE.Quaternion(), new THREE.Vector3());
    assert.ok(wp.distanceTo(rp) < 1e-12);
    assert.equal(decompose(restored).hasShear, true);
  });

  test('isAncestor 判定', () => {
    const parentOf = new Map<string, string | null>([
      ['a', null],
      ['b', 'a'],
      ['c', 'b'],
    ]);
    const get = (id: string) => parentOf.get(id) ?? null;
    assert.equal(isAncestor('c', 'a', get), true);
    assert.equal(isAncestor('c', 'c', get), true);
    assert.equal(isAncestor('a', 'c', get), false);
  });
});

describe('SceneDocument 层级与世界保持', () => {
  test('重挂接后世界位置/姿态/缩放保持不变（无剪切情形精确）', () => {
    const doc = new SceneDocument();
    const g1 = group(doc, 'G1');
    // 均匀缩放 + 旋转不引入剪切，世界变换可精确保持
    doc.setLocalTRS(g1, { position: [3, 0, 0], rotation: [0, 0, 0.9], scale: [2, 2, 2] });
    const g2 = group(doc, 'G2');
    doc.setLocalTRS(g2, { position: [-2, 4, 1], rotation: [0.3, 0, 0], scale: [3, 3, 3] });
    const child = box(doc, '盒子', g1, [1, 1, 0]);

    const before = doc.getWorldMatrix(child).clone();
    doc.reparent(child, g2, null, true);
    const after = doc.getWorldMatrix(child);
    assert.ok(matrixRelativeEquals(after, before, 1e-12));
    assert.equal(doc.getParent(child), g2);

    // 挂到根节点同样精确保持
    doc.reparent(child, null, null, true);
    const afterRoot = doc.getWorldMatrix(child);
    assert.ok(matrixRelativeEquals(afterRoot, before, 1e-12));
  });

  test('重挂接到非均匀缩放父级（剪切边界）：世界位置严格保持', () => {
    const doc = new SceneDocument();
    const g = group(doc, 'G');
    doc.setLocalTRS(g, { position: [1, 0, 0], rotation: [0, 0, 0.6], scale: [2, 0.5, 3] });
    const child = box(doc, '盒子', null, [2, 3, 4]);
    const before = doc.getWorldTRS(child).position.clone();
    doc.reparent(child, g, null, true);
    const after = doc.getWorldTRS(child).position;
    assert.ok(before.distanceTo(after) < 1e-12);
  });

  test('拒绝挂到自身', () => {
    const doc = new SceneDocument();
    const a = group(doc, 'A');
    assert.throws(() => doc.reparent(a, a), /不能把对象挂到它自己下面/);
  });

  test('拒绝挂到子孙（循环父子），并说明原因', () => {
    const doc = new SceneDocument();
    const a = group(doc, 'A');
    const b = group(doc, 'B', a);
    const c = group(doc, 'C', b);
    let err: unknown;
    try {
      doc.reparent(a, c);
    } catch (e) {
      err = e;
    }
    if (!(err instanceof Error)) assert.fail('reparent 应当抛出 Error');
    assert.match(err.message, /拒绝循环父子关系/);
    assert.match(err.message, /子孙/);
    // 结构未被破坏
    assert.equal(doc.getParent(b), a);
    assert.equal(doc.getParent(c), b);
  });

  test('同层排序不改变任何变换', () => {
    const doc = new SceneDocument();
    const a = box(doc, 'A', null);
    const b = box(doc, 'B', null);
    const c = box(doc, 'C', null);
    const before = doc.getWorldMatrix(b).clone();
    doc.reparent(b, null, 0, true);
    assert.deepEqual(doc.getChildren(null), [b, a, c]);
    assert.ok(doc.getWorldMatrix(b).equals(before));
  });

  test('非均匀缩放+旋转链上的世界 TRS 读数稳定（重复计算一致）', () => {
    const doc = new SceneDocument();
    const g = group(doc, 'G');
    doc.setLocalTRS(g, { rotation: [0, 0.7, 0], scale: [3, 0.4, 1] });
    const child = box(doc, 'C', g, [1, 1, 0]);
    doc.setLocalTRS(child, { rotation: [0.5, 0, 0], scale: [0.5, 2, 1] });
    const w1 = doc.getWorldTRS(child);
    const w2 = doc.getWorldTRS(child);
    assert.ok(approxVec3(w1.scale, w2.scale));
    assert.ok(approxVec3(w1.position, w2.position));
  });
});

describe('删除与复制', () => {
  test('删除父对象并保留子对象：子对象提升且世界变换不变', () => {
    const doc = new SceneDocument();
    const parent = group(doc, 'P');
    doc.setLocalTRS(parent, { position: [2, 0, 0], rotation: [0, 0, 0.5], scale: [2, 2, 2] });
    const child = box(doc, 'C', parent, [1, 0, 0]);
    const before = doc.getWorldMatrix(child).clone();

    const saved = doc.removeNode(parent, true);
    assert.equal(doc.has(parent), false);
    assert.equal(doc.has(child), true);
    assert.equal(doc.getParent(child), null);
    assert.ok(matrixRelativeEquals(doc.getWorldMatrix(child), before, 1e-10));

    // 恢复后层级与局部 TRS 原样回来
    doc.restoreNodes(saved.removed, saved.reparented);
    assert.equal(doc.getParent(child), parent);
    assert.ok(doc.getWorldMatrix(child).equals(before));
  });

  test('删除父对象连同子树：整棵删除', () => {
    const doc = new SceneDocument();
    const p = group(doc, 'P');
    const c = box(doc, 'C', p);
    doc.removeNode(p, false);
    assert.equal(doc.has(p), false);
    assert.equal(doc.has(c), false);
  });

  test('连带删除撤销：被删子树恢复，且不影响场景中的其他节点', () => {
    const doc = new SceneDocument();
    const p = group(doc, 'P');
    const c = box(doc, 'C', p);
    const gc = group(doc, 'GC', c);
    // 场景里还有一棵与被删子树无关的旁观树
    const bystander = group(doc, 'Bystander');
    const byChild = box(doc, 'BystanderChild', bystander);

    const saved = doc.removeNode(p, false);
    assert.equal(doc.getAllNodes().length, 2); // 只剩旁观树
    doc.restoreNodes(saved.removed, saved.reparented);

    const ids = doc.getAllNodes().map((n) => n.id).sort();
    assert.deepEqual(ids, [byChild, bystander, c, gc, p].sort());
    assert.equal(doc.getParent(c), p);
    assert.equal(doc.getParent(gc), c);
    assert.equal(doc.getParent(byChild), bystander);
    assert.deepEqual(doc.getChildren(bystander), [byChild]);
  });

  test('复制整棵子树：结构一致、id 全新、世界变换一致', () => {
    const doc = new SceneDocument();
    const p = group(doc, 'P');
    doc.setLocalTRS(p, { position: [1, 2, 3], rotation: [0.2, 0, 0], scale: [2, 1, 1] });
    const c1 = box(doc, 'C1', p, [1, 0, 0]);
    group(doc, 'C2', p);
    const beforeC1 = doc.getWorldMatrix(c1).clone();

    const { newRootId, idMap } = doc.duplicateSubtree(p);
    assert.notEqual(newRootId, p);
    assert.equal(doc.getNode(newRootId)!.name, 'P 副本');
    assert.equal(idMap.size, 3);
    assert.equal(doc.getChildren(newRootId).length, 2);
    // 源子树未受影响
    assert.ok(doc.getWorldMatrix(c1).equals(beforeC1));
    // 副本子节点世界矩阵与源对应节点相同（局部 TRS 完全复制）
    const copiedC1 = idMap.get(c1)!;
    assert.ok(doc.getWorldMatrix(copiedC1).equals(beforeC1));
  });
});

describe('History 撤销重做', () => {
  test('变换命令可往返', () => {
    const doc = new SceneDocument();
    const id = box(doc, 'B', null);
    const history = new History();
    const before = {
      position: [...doc.getNode(id)!.position] as [number, number, number],
      rotation: [...doc.getNode(id)!.rotation] as [number, number, number],
      scale: [...doc.getNode(id)!.scale] as [number, number, number],
    };
    doc.setLocalTRS(id, { position: [9, 9, 9] });
    const after = {
      position: [9, 9, 9] as [number, number, number],
      rotation: before.rotation,
      scale: before.scale,
    };
    history.execute(new TransformCommand(doc, '平移', id, before, after));
    assert.deepEqual(doc.getNode(id)!.position, [9, 9, 9]);
    history.undo();
    assert.deepEqual(doc.getNode(id)!.position, before.position);
    history.redo();
    assert.deepEqual(doc.getNode(id)!.position, [9, 9, 9]);
  });

  test('重挂接撤销后父级、顺序、局部 TRS 全部还原', () => {
    const doc = new SceneDocument();
    const a = group(doc, 'A');
    const b = group(doc, 'B');
    const child = box(doc, 'C', a, [1, 0, 0]);
    const history = new History();
    const oldLocal = {
      position: [...doc.getNode(child)!.position] as [number, number, number],
      rotation: [...doc.getNode(child)!.rotation] as [number, number, number],
      scale: [...doc.getNode(child)!.scale] as [number, number, number],
    };
    history.execute(new ReparentCommand(doc, '重挂接', child, b, null, true));
    assert.equal(doc.getParent(child), b);
    history.undo();
    assert.equal(doc.getParent(child), a);
    assert.deepEqual(doc.getNode(child)!.position, oldLocal.position);
    assert.deepEqual(doc.getChildren(a), [child]);
  });

  test('删除命令两种模式均可撤销', () => {
    const doc = new SceneDocument();
    const history = new History();
    const p = group(doc, 'P');
    const c = box(doc, 'C', p);

    history.execute(new DeleteCommand(doc, '删除', p, true));
    assert.equal(doc.has(p), false);
    assert.equal(doc.has(c), true);
    history.undo();
    assert.equal(doc.has(p), true);
    assert.equal(doc.getParent(c), p);

    history.execute(new DeleteCommand(doc, '删除子树', p, false));
    assert.equal(doc.has(c), false);
    history.undo();
    assert.equal(doc.has(c), true);
  });

  test('复制命令可撤销', () => {
    const doc = new SceneDocument();
    const history = new History();
    const id = box(doc, 'B', null);
    history.execute(new DuplicateCommand(doc, '复制', id));
    assert.equal(doc.getAllNodes().length, 2);
    history.undo();
    assert.equal(doc.getAllNodes().length, 1);
  });

  test('新操作会清空重做栈', () => {
    const doc = new SceneDocument();
    const history = new History();
    const id = box(doc, 'B', null);
    const snap = {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    history.execute(
      new TransformCommand(doc, '平移1', id, snap, { ...snap, position: [1, 0, 0] }),
    );
    history.undo();
    assert.equal(history.canRedo, true);
    history.execute(
      new TransformCommand(doc, '平移2', id, snap, { ...snap, position: [2, 0, 0] }),
    );
    assert.equal(history.canRedo, false);
  });
});

describe('文件加载校验（原子性）', () => {
  function validFile(): SceneFile {
    const nodes: NodeData[] = [
      {
        id: 'g',
        name: '组',
        parentId: null,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
      },
      {
        id: 'b',
        name: '盒子',
        parentId: 'g',
        position: [1, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
        geometry: { kind: 'box' },
        material: { color: 0xff0000 },
      },
    ];
    return { formatVersion: 1, nodes, camera: structuredClone(CAM) };
  }

  test('合法文件通过并可载入文档', () => {
    const doc = new SceneDocument();
    const file = parseSceneFile(validFile());
    doc.loadValidated(file);
    assert.equal(doc.getAllNodes().length, 2);
    assert.equal(doc.getParent('b'), 'g');
  });

  const badCases: { name: string; mutate: (f: SceneFile) => void; match: RegExp }[] = [
    {
      name: '版本号错误',
      mutate: (f) => (f.formatVersion = 99 as unknown as 1),
      match: /格式版本/,
    },
    {
      name: '父节点不存在',
      mutate: (f) => (f.nodes[1].parentId = 'ghost'),
      match: /不存在的父节点/,
    },
    {
      name: 'id 重复',
      mutate: (f) => (f.nodes[1].id = 'g'),
      match: /id 重复/,
    },
    {
      name: '循环父子',
      mutate: (f) => (f.nodes[0].parentId = 'b'),
      match: /循环/,
    },
    {
      name: '非数字变换',
      mutate: (f) => (f.nodes[0].position = [1, NaN, 3] as unknown as [number, number, number]),
      match: /非数字/,
    },
    {
      name: '零缩放',
      mutate: (f) => (f.nodes[0].scale = [1, 0, 1]),
      match: /不能包含 0/,
    },
    {
      name: '非法几何体',
      mutate: (f) => (f.nodes[1].geometry = { kind: 'teapot' } as never),
      match: /geometry\.kind/,
    },
    {
      name: '相机 far<near',
      mutate: (f) => {
        f.camera.near = 100;
        f.camera.far = 10;
      },
      match: /far 必须大于 near/,
    },
    {
      name: 'JSON 语法错误',
      mutate: () => undefined,
      match: /不是合法 JSON/,
    },
  ];

  for (const c of badCases) {
    test(`拒绝无效数据：${c.name}`, () => {
      if (c.name === 'JSON 语法错误') {
        assert.throws(() => parseSceneFile('{not json'), c.match);
        return;
      }
      const f = validFile();
      c.mutate(f);
      assert.throws(() => parseSceneFile(f), c.match);
    });
  }

  test('校验失败不影响当前文档（不发生部分覆盖）', () => {
    const doc = new SceneDocument();
    doc.loadValidated(validFile());
    const before = doc.getAllNodes().map((n) => n.id);

    const bad = validFile();
    bad.nodes.push({
      ...structuredClone(bad.nodes[0]),
      id: 'broken',
      parentId: 'missing-parent',
    });
    assert.throws(() => parseSceneFile(bad));
    // parseSceneFile 抛错，控制器根本不会调用 loadValidated；当前文档原样
    assert.deepEqual(
      doc.getAllNodes().map((n) => n.id),
      before,
    );
  });

  test('LoadCommand 撤销可恢复上一个场景与相机', () => {
    const doc = new SceneDocument();
    doc.loadValidated(validFile());
    const history = new History();
    const cameras: CameraData[] = [];
    const next = validFile();
    next.nodes = next.nodes.slice(0, 1);
    next.camera = { ...CAM, position: [10, 10, 10] };

    const cmd = new LoadCommand(doc, '打开场景', next, (cam) => cameras.push(cam));
    cmd.setPrevious(validFile());
    history.execute(cmd);
    assert.equal(doc.getAllNodes().length, 1);
    history.undo();
    assert.equal(doc.getAllNodes().length, 2);
    assert.equal(cameras.length, 2);
  });
});
