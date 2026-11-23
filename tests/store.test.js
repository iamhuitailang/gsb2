import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createDoc, createPath, insertNode, findNode, reorder, groupNodes, DEFAULT_STYLE } from '../src/model.js';
import { rectSubpaths } from '../src/geometry.js';

const docWithRect = () => {
  const doc = createDoc();
  insertNode(doc, createPath(rectSubpaths(0, 0, 10, 10), {}, 'r'));
  return doc;
};

describe('撤销重做', () => {
  test('离散操作进入 undo 栈并可回滚/重做', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    const id = store.doc.layers[0].id;
    store.run('改填充', () => {
      findNode(store.doc.layers, id).style.fill = '#ff0000';
    });
    assert.equal(findNode(store.doc.layers, id).style.fill, '#ff0000');
    assert.equal(store.canUndo, true);
    store.undo();
    assert.equal(findNode(store.doc.layers, id).style.fill, '#3b82f6');
    store.redo();
    assert.equal(findNode(store.doc.layers, id).style.fill, '#ff0000');
  });
  test('手势只在 commit 时产生一条历史', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    store.beginGesture('拖');
    for (let i = 0; i < 5; i++) {
      store.updateGesture(() => { store.doc.layers[0].subpaths[0].anchors[0].x += 1; });
    }
    assert.equal(store.canUndo, false);
    store.commitGesture();
    assert.equal(store.canUndo, true);
    assert.equal(store.doc.layers[0].subpaths[0].anchors[0].x, 5);
    store.undo();
    assert.equal(store.doc.layers[0].subpaths[0].anchors[0].x, 0);
  });

  test('取消手势恢复到起始快照', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    store.beginGesture('拖');
    store.updateGesture(() => { store.doc.layers[0].subpaths[0].anchors[0].x = 99; });
    store.cancelGesture();
    assert.equal(store.doc.layers[0].subpaths[0].anchors[0].x, 0);
    assert.equal(store.canUndo, false);
  });

  test('run 返回 false 时自动回滚且不入栈', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    const result = store.run('会失败的操作', () => false);
    assert.equal(result, false);
    assert.equal(store.canUndo, false);
  });

  test('删除节点后选择集自动剪枝', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    const id = store.doc.layers[0].id;
    store.select([id]);
    store.run('删除', () => {
      store.doc.layers.splice(0, 1);
    });
    assert.deepEqual(store.selection.paths, []);
  });

  test('历史上限 100 条', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    for (let i = 0; i < 110; i++) {
      store.run('n', () => { store.doc.width = i; });
    }
    assert.equal(store.undoStack.length, 100);
  });

  test('新操作清空 redo 栈', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    store.run('a', () => { store.doc.width = 10; });
    store.undo();
    assert.equal(store.canRedo, true);
    store.run('b', () => { store.doc.height = 20; });
    assert.equal(store.canRedo, false);
  });

  test('层级/分组/样式操作均可撤销', () => {
    const store = new Store();
    const doc = createDoc();
    const p1 = createPath(rectSubpaths(0, 0, 5, 5), {}, 'a');
    const p2 = createPath(rectSubpaths(10, 10, 5, 5), {}, 'b');
    insertNode(doc, p1); insertNode(doc, p2);
    store.loadDoc(doc);

    // 样式
    store.run('改填充', () => { p1.style.fill = '#0f0'; });
    // 排序
    store.run('置顶', () => reorder(store.doc, p1.id, 'top'));
    // 编组
    store.run('编组', () => groupNodes(store.doc, [p1.id, p2.id]));
    assert.equal(store.doc.layers.length, 1);
    assert.equal(store.doc.layers[0].type, 'group');

    store.undo(); // 撤销编组
    assert.equal(store.doc.layers.length, 2);
    store.undo(); // 撤销排序
    store.undo(); // 撤销样式
    assert.equal(findNode(store.doc.layers, p1.id).style.fill, DEFAULT_STYLE().fill);
    // 重做恢复
    store.redo(); store.redo(); store.redo();
    assert.equal(store.doc.layers.length, 1);
    assert.equal(findNode(store.doc.layers, p1.id).style.fill, '#0f0');
  });

  test('锚点拖动手势进入历史且可回滚到原始坐标', () => {
    const store = new Store();
    store.loadDoc(docWithRect());
    const node = store.doc.layers[0];
    const orig = JSON.parse(JSON.stringify(node.subpaths[0].anchors[0]));
    store.beginGesture('拖动锚点');
    store.updateGesture(() => { node.subpaths[0].anchors[0].x += 15; });
    store.updateGesture(() => { node.subpaths[0].anchors[0].y += 8; });
    store.commitGesture();
    assert.equal(node.subpaths[0].anchors[0].x, orig.x + 15);
    store.undo();
    assert.deepEqual(store.doc.layers[0].subpaths[0].anchors[0], orig);
  });
});
