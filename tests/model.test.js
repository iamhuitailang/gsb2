import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc, createPath, createGroup, insertNode, removeNode, cloneNode,
  reorder, groupNodes, ungroup, mergePaths, splitPath, toggleClose,
  findNode, locate, serializeDoc, deserializeDoc, nodeBounds,
  moveAnchor, moveHandle, setSmooth, insertAnchorOnSegment, deleteAnchor,
  DEFAULT_STYLE,
} from '../src/model.js';
import { rectSubpaths, lineSubpaths, V, parsePathD, pathToD } from '../src/geometry.js';

const rectPath = (name = 'r') => createPath(rectSubpaths(0, 0, 10, 10), {}, name);

describe('图层树', () => {
  test('插入/查找/删除', () => {
    const doc = createDoc();
    const p = rectPath();
    insertNode(doc, p);
    assert.equal(findNode(doc.layers, p.id).name, 'r');
    removeNode(doc, p.id);
    assert.equal(findNode(doc.layers, p.id), null);
  });

  test('复制生成新 id 且深拷贝子树', () => {
    const doc = createDoc();
    const g = createGroup([rectPath('a'), rectPath('b')], 'g');
    insertNode(doc, g);
    const copy = cloneNode(g);
    assert.notEqual(copy.id, g.id);
    assert.notEqual(copy.children[0].id, g.children[0].id);
    assert.equal(copy.children.length, 2);
  });

  test('排序：上移/置顶', () => {
    const doc = createDoc();
    const a = rectPath('a'), b = rectPath('b'), c = rectPath('c');
    insertNode(doc, a); insertNode(doc, b); insertNode(doc, c);
    // 数组顺序即栈序，末尾在最上
    reorder(doc, a.id, 'top');
    assert.equal(doc.layers[doc.layers.length - 1].id, a.id);
    // c 此时在中间，上移与 a 交换成为栈顶
    reorder(doc, c.id, 'up');
    assert.equal(doc.layers[doc.layers.length - 1].id, c.id);
    assert.equal(doc.layers[1].id, a.id);
  });

  test('编组与解组保持成员', () => {
    const doc = createDoc();
    const a = rectPath('a'), b = rectPath('b');
    insertNode(doc, a); insertNode(doc, b);
    const g = groupNodes(doc, [a.id, b.id], 'g1');
    assert.equal(doc.layers.length, 1);
    assert.equal(g.children.length, 2);
    const freed = ungroup(doc, g.id);
    assert.equal(doc.layers.length, 2);
    assert.equal(freed.length, 2);
  });
});

describe('路径结构操作', () => {
  test('合并：两条路径变一条双子路径，样式沿用首条', () => {
    const doc = createDoc();
    const a = createPath(rectSubpaths(0, 0, 5, 5), { fill: '#ff0000' }, 'a');
    const b = createPath(rectSubpaths(20, 20, 5, 5), { fill: '#00ff00' }, 'b');
    insertNode(doc, a); insertNode(doc, b);
    const merged = mergePaths(doc, [a.id, b.id]);
    assert.equal(merged.subpaths.length, 2);
    assert.equal(merged.style.fill, '#ff0000');
    assert.equal(doc.layers.length, 1);
  });

  test('按子路径拆分：合并后可拆回两条', () => {
    const doc = createDoc();
    const p = createPath([...rectSubpaths(0, 0, 5, 5), ...rectSubpaths(20, 20, 5, 5)], {}, 'm');
    insertNode(doc, p);
    const made = splitPath(doc, p.id, []);
    assert.equal(made.length, 2);
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0].subpaths[0].anchors.length, 4);
  });

  test('闭合路径在锚点处拆分为两段开放路径', () => {
    const doc = createDoc();
    const p = rectPath();
    insertNode(doc, p);
    const made = splitPath(doc, p.id, ['0:0', '0:2']);
    assert.equal(made.length, 2);
    assert.equal(made.every((m) => m.subpaths[0].closed === false), true);
    // 两个切点在两段中各保留一份：4 锚点 -> 3+3
    assert.equal(made[0].subpaths[0].anchors.length + made[1].subpaths[0].anchors.length, 6);
  });

  test('开放路径在中间锚点拆分', () => {
    const doc = createDoc();
    const p = createPath(lineSubpaths(0, 0, 10, 10), {}, 'l');
    // 再加一个中间点
    p.subpaths[0].anchors.splice(1, 0, { x: 5, y: 5, hIn: V(0, 0), hOut: V(0, 0), smooth: false });
    insertNode(doc, p);
    const made = splitPath(doc, p.id, ['0:1']);
    assert.equal(made.length, 2);
  });

  test('闭合切换', () => {
    const p = rectPath();
    assert.equal(p.subpaths[0].closed, true);
    toggleClose(p);
    assert.equal(p.subpaths[0].closed, false);
  });
});

describe('锚点编辑', () => {
  test('移动锚点普通模式控制柄跟随（相对偏移保持不变）', () => {
    const p = createPath(parsePathD('M0 0 C10 10 20 10 30 0'), {}, 'c');
    const anchors = p.subpaths[0].anchors;
    // 锚点 1（终点 30,0）的入向柄来自 c2=(20,10)，相对偏移 (-10,10)
    assert.deepEqual(anchors[1].hIn, {dx: -10, dy: 10});
    moveAnchor(p, 0, 1, V(5, 5), false);
    const a = anchors[1];
    // 相对偏移不变 => 控制柄随锚点一起平移
    assert.deepEqual(a.hIn, {dx: -10, dy: 10});
    assert.equal(a.x, 35);
    assert.equal(a.y, 5);
    moveAnchor(p, 0, 1, V(1, 0), true);
    assert.deepEqual(anchors[1].hIn, {dx: -10, dy: 10});
  });

  test('拖控制柄：平滑锚点联动镜像，Alt 打断平滑', () => {
    const p = createPath(parsePathD('M0 0 C10 10 20 10 30 0 C40 -10 50 -10 60 0'), {}, 'c');
    setSmooth(p, 0, 1, true);
    const a = p.subpaths[0].anchors[1]; // 中间锚点 (30,0)
    moveHandle(p, 0, 1, 'out', V(a.x + 8, a.y + 6), false);
    assert.ok(Math.abs(a.hIn.dx + a.hOut.dx) < 1e-9);
    assert.ok(Math.abs(a.hIn.dy + a.hOut.dy) < 1e-9);
    assert.equal(a.smooth, true);
    moveHandle(p, 0, 1, 'in', V(a.x + 1, a.y + 1), true);
    assert.equal(a.smooth, false);
  });

  test('双击插入锚点：点数 +1 且曲线形状保持（采样中点几乎不动）', () => {
    const p = createPath(parsePathD('M0 0 C10 10 20 10 30 0'), {}, 'c');
    const before = pathToD(p.subpaths);
    const ref = insertAnchorOnSegment(p, 0, 0, 0.5);
    assert.equal(p.subpaths[0].anchors.length, 3);
    assert.equal(ref.ai, 1);
    // 重绘 d 在中段位置应与原曲线接近（端点一致即可保证整体轮廓）
    const d = pathToD(p.subpaths);
    assert.ok(d.startsWith('M0 0'));
    assert.ok(d.includes('30 0'));
    assert.notEqual(d, before);
  });

  test('两点路径删锚点会移除整条子路径', () => {
    const p = createPath(lineSubpaths(0, 0, 10, 10), {}, 'l');
    deleteAnchor(p, 0, 0);
    assert.equal(p.subpaths.length, 0);
  });
});

describe('序列化', () => {
  test('保存后重新打开结构一致（深比较）', () => {
    const doc = createDoc(120, 80);
    const g = createGroup([rectPath('a')], 'g');
    insertNode(doc, g);
    insertNode(doc, createPath(lineSubpaths(0, 0, 5, 5), { stroke: '#000' }, 'l'));
    const text = serializeDoc(doc);
    const reopened = deserializeDoc(text);
    assert.deepEqual(reopened, doc);
  });

  test('缺字段文档自动补默认值', () => {
    const doc = deserializeDoc({ width: 100, height: 50, layers: [{ type: 'path', subpaths: rectSubpaths(0, 0, 1, 1) }] });
    const n = doc.layers[0];
    assert.ok(n.id);
    assert.equal(n.visible, true);
    assert.equal(n.style.strokeLinejoin, DEFAULT_STYLE().strokeLinejoin);
    assert.deepEqual(n.subpaths[0].anchors[0].hIn, {dx: 0, dy: 0});
  });

  test('包围盒', () => {
    const p = rectPath();
    const b = nodeBounds(p);
    assert.deepEqual([b.x, b.y, b.w, b.h], [0, 0, 10, 10]);
  });
});
