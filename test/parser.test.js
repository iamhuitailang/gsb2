import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from '../src/sanitizer/parser.js';

function tagNames(node) {
  const out = [];
  for (const child of node.children) {
    if (child.type === 'element') {
      out.push(child.name);
      out.push(...tagNames(child));
    }
  }
  return out;
}

test('基本嵌套结构', () => {
  const tree = parseFragment('<div><p>x</p></div>');
  const div = tree.children[0];
  assert.equal(div.name, 'div');
  assert.equal(div.children[0].name, 'p');
});

test('未闭合元素在 EOF 自动闭合并记录', () => {
  const errors = [];
  const tree = parseFragment('<div><p>x', errors);
  assert.ok(errors.some((e) => e.type === 'unclosed-elements'));
  assert.deepEqual(tagNames(tree), ['div', 'p']);
});

test('li 的隐式闭合', () => {
  const tree = parseFragment('<ul><li>a<li>b</ul>');
  const ul = tree.children[0];
  assert.equal(ul.children.length, 2);
  assert.deepEqual(ul.children.map((n) => n.name), ['li', 'li']);
});

test('表格单元格的隐式闭合', () => {
  const tree = parseFragment('<table><tr><td>a<td>b</tr></table>');
  const tr = tree.children[0].children[0];
  assert.deepEqual(tr.children.map((n) => n.name), ['td', 'td']);
});

test('p 被块级元素隐式闭合', () => {
  const tree = parseFragment('<p>a<div>b</div>');
  assert.deepEqual(tree.children.map((n) => n.name), ['p', 'div']);
});

test('void 元素没有子节点', () => {
  const tree = parseFragment('<p>a<br>b<img src="x"></p>');
  const p = tree.children[0];
  assert.deepEqual(p.children.map((n) => n.type),
    ['text', 'element', 'text', 'element']);
  const br = p.children[1];
  assert.equal(br.name, 'br');
  assert.equal(br.children.length, 0);
});

test('多余的结束标签被忽略并记录', () => {
  const errors = [];
  const tree = parseFragment('</span><p>x</p>', errors);
  assert.ok(errors.some((e) => e.type === 'stray-end-tag'));
  assert.equal(tree.children.length, 1);
});

test('script 内容挂为文本节点且不解析内部标签', () => {
  const tree = parseFragment('<script>var s = "<div>x</div>";</script>');
  const script = tree.children[0];
  assert.equal(script.name, 'script');
  assert.equal(script.children.length, 1);
  assert.equal(script.children[0].type, 'text');
  assert.match(script.children[0].value, /<div>x<\/div>/);
});

test('注释/DOCTYPE 不进入树', () => {
  const errors = [];
  const tree = parseFragment('<!-- c --><!DOCTYPE html><p>x</p>', errors);
  assert.deepEqual(tagNames(tree), ['p']);
  assert.ok(errors.some((e) => e.type === 'comment-or-declaration-removed'));
});

test('交叉嵌套容错不抛异常', () => {
  assert.doesNotThrow(() => parseFragment('<div><span>x</div></span>'));
  assert.doesNotThrow(() => parseFragment('<b><i>x</b></i>'));
});

test('空输入返回空树根', () => {
  const tree = parseFragment('');
  assert.equal(tree.type, 'root');
  assert.equal(tree.children.length, 0);
});
