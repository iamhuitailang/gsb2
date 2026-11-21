import test from 'node:test';
import assert from 'node:assert/strict';

// 在导入 store 之前提供 localStorage 桩，避免 Node 环境报错
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  clear: () => memory.clear(),
};
globalThis.confirm = () => true;

const { Store } = await import('../src/store.js');
const { mistyLighthouseStory } = await import('../src/sample.js');
const { getText } = await import('../src/story.js');

function freshStore() {
  const store = new Store();
  store.loadFromObject(mistyLighthouseStory());
  return store;
}

test('修改原文不会覆盖译文，只标记待复核', () => {
  const store = freshStore();
  const node = store.story.nodes.find((item) => item.id === 'node_prologue');
  const enBefore = getText(node.text, 'en');
  const jaBefore = getText(node.text, 'ja');
  const zhBefore = getText(node.text, 'zh-CN');

  store.setNodeText('node_prologue', 'zh-CN', `${zhBefore}（修订）`);

  assert.equal(getText(node.text, 'en'), enBefore, '英语译文必须原样保留');
  assert.equal(getText(node.text, 'ja'), jaBefore, '日语译文必须原样保留');
  assert.ok(node.staleLocales.includes('en'));
  assert.ok(node.staleLocales.includes('ja'));

  const en = store.report.translations.find((item) => item.locale === 'en');
  assert.ok(en.stale.some((entry) => entry.nodeId === 'node_prologue'));
});

test('编辑译文不会影响原文，并清除该语言的待复核标记', () => {
  const store = freshStore();
  const node = store.story.nodes.find((item) => item.id === 'node_prologue');
  store.setNodeText('node_prologue', 'zh-CN', '新的中文原文');
  assert.ok(node.staleLocales.includes('en'));

  const enBefore = getText(node.text, 'en');
  store.setNodeText('node_prologue', 'en', 'A brand new English line.');
  assert.equal(getText(node.text, 'zh-CN'), '新的中文原文');
  assert.notEqual(getText(node.text, 'en'), enBefore);
  assert.ok(!node.staleLocales.includes('en'), '编辑译文后应移除该语言的待复核标记');
  assert.ok(node.staleLocales.includes('ja'), '其他语言仍应待复核');
});

test('撤销恢复译文与原文', () => {
  const store = freshStore();
  const getNode = () => store.story.nodes.find((item) => item.id === 'node_prologue');
  const zhBefore = getText(getNode().text, 'zh-CN');
  const enBefore = getText(getNode().text, 'en');

  store.setNodeText('node_prologue', 'zh-CN', '被撤销的中文');
  store.setNodeText('node_prologue', 'en', 'Will be undone');
  assert.equal(getText(getNode().text, 'zh-CN'), '被撤销的中文');

  store.undo();
  // 撤销会替换整个 story，必须重新取节点
  assert.equal(getText(getNode().text, 'en'), enBefore);
  assert.equal(getText(getNode().text, 'zh-CN'), '被撤销的中文');

  store.undo();
  assert.equal(getText(getNode().text, 'zh-CN'), zhBefore);

  store.redo();
  assert.equal(getText(getNode().text, 'zh-CN'), '被撤销的中文');
});

test('项目保存后重新加载仍可编辑且结构一致', () => {
  const store = freshStore();
  store.setNodeText('node_door', 'zh-CN', '改过的门口描述');
  const saved = store.serialize();

  const reopened = new Store();
  reopened.loadFromObject(JSON.parse(saved));
  const node = reopened.story.nodes.find((item) => item.id === 'node_door');
  assert.equal(getText(node.text, 'zh-CN'), '改过的门口描述');
  assert.equal(reopened.story.nodes.length, store.story.nodes.length);
  // 继续编辑
  reopened.setNodeText('node_door', 'zh-CN', '再次编辑');
  const again = reopened.story.nodes.find((item) => item.id === 'node_door');
  assert.equal(getText(again.text, 'zh-CN'), '再次编辑');
});

test('删除节点会断开所有指向它的连线', () => {
  const store = freshStore();
  store.deleteNode('node_beach');
  assert.ok(!store.story.nodes.some((item) => item.id === 'node_beach'));
  for (const node of store.story.nodes) {
    assert.notEqual(node.next, 'node_beach');
    for (const choice of node.choices) assert.notEqual(choice.target, 'node_beach');
  }
  assert.equal(store.story.nodes.find((item) => item.id === 'node_prologue').choices[1].target, '');
});

test('变量重命名同步更新条件表达式', () => {
  const store = freshStore();
  const variable = store.story.variables.find((item) => item.name === '信任');
  const ok = store.updateVariable(variable.id, { name: 'trust' });
  assert.equal(ok, true);
  assert.equal(variable.name, 'trust');
  const anyCondition = store.story.nodes
    .flatMap((node) => node.choices)
    .some((choice) => choice.condition.includes('trust'));
  assert.ok(anyCondition);
  assert.ok(!store.story.nodes.flatMap((node) => node.choices).some((choice) => /信任\s*[<>=]/.test(choice.condition)));
});

test('非法变量名被拒绝且不产生撤销点', () => {
  const store = freshStore();
  const variable = store.story.variables.find((item) => item.name === '信任');
  const undoBefore = store.undoStack.length;
  assert.equal(store.updateVariable(variable.id, { name: '1bad' }), false);
  assert.equal(variable.name, '信任');
  assert.equal(store.undoStack.length, undoBefore);
});

test('移除语言会清理该语言的所有译文', () => {
  const store = freshStore();
  store.removeLocale('ja');
  assert.ok(!store.story.locales.some((item) => item.code === 'ja'));
  for (const node of store.story.nodes) {
    assert.equal('ja' in node.text, false);
    for (const choice of node.choices) assert.equal('ja' in choice.text, false);
  }
  // 原文语言不能被移除
  assert.equal(store.removeLocale('zh-CN'), false);
});

test('语言标记与编辑语言的联动', () => {
  const store = freshStore();
  assert.equal(store.editLocale, 'zh-CN');
  store.setEditLocale('en');
  assert.equal(store.editLocale, 'en');
  store.setEditLocale('不存在的语言');
  assert.equal(store.editLocale, 'en');
});
