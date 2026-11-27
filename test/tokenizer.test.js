import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/sanitizer/tokenizer.js';

function tokenTypes(html) {
  return tokenize(html).map((t) => t.type);
}

test('标签名与属性名统一小写化', () => {
  const [tag] = tokenize('<DIV OnClIcK="x" CLASS="y">');
  assert.equal(tag.type, 'startTag');
  assert.equal(tag.name, 'div');
  assert.deepEqual(tag.attrs.map((a) => a.name), ['onclick', 'class']);
});

test('三种引号形式与无引号属性', () => {
  const [tag] = tokenize('<a href="x" title=\'y\' id=z>');
  assert.equal(tag.attrs[0].value, 'x');
  assert.equal(tag.attrs[1].value, 'y');
  assert.equal(tag.attrs[2].value, 'z');
  assert.equal(tag.attrs[2].quoted, false);
});

test('属性值中的实体原样保留(解码在后续阶段处理)', () => {
  const [tag] = tokenize('<a href="&#106;avascript:x">');
  assert.equal(tag.attrs[0].value, '&#106;avascript:x');
});

test('未闭合引号容错并记录错误', () => {
  const errors = [];
  const tags = tokenize('<img src="x onerror=alert(1)>', errors);
  assert.ok(errors.some((e) => e.type === 'unterminated-attribute-value'));
  assert.equal(tags[0].type, 'startTag');
  assert.equal(tags[0].name, 'img');
});

test('重复属性保留第一个并记录', () => {
  const errors = [];
  const [tag] = tokenize('<div class="a" class="b">', errors);
  assert.deepEqual(tag.attrs.map((a) => a.value), ['a']);
  assert.ok(errors.some((e) => e.type === 'duplicate-attribute'));
});

test('script/style 内容作为 rawtext,内部标签不解析', () => {
  const tokens = tokenize('<script>var a = "<div>not a tag</div>";</script><p>x</p>');
  assert.equal(tokens[0].type, 'startTag');
  assert.equal(tokens[0].name, 'script');
  assert.equal(tokens[1].type, 'rawtext');
  assert.match(tokens[1].text, /not a tag/);
  // 结束标签正常产出,树构建器才能闭合 script 元素
  assert.equal(tokens[2].type, 'endTag');
  assert.equal(tokens[2].name, 'script');
  assert.equal(tokens[3].type, 'startTag');
  assert.equal(tokens[3].name, 'p');
});

test('rawtext 结束标签大小写不敏感且容忍空白', () => {
  const tokens = tokenize("<script>x</ScRiPt ><p>y</p>");
  const p = tokens.find((t) => t.type === 'startTag' && t.name === 'p');
  assert.ok(p);
});

test('未闭合的 script 到 EOF 也能容错', () => {
  const errors = [];
  const tokens = tokenize('<script>alert(1)', errors);
  assert.equal(tokens[tokens.length - 1].type, 'rawtext');
  assert.ok(errors.some((e) => e.type === 'unclosed-rawtext'));
});

test('注释与 DOCTYPE 识别为注释类 token', () => {
  const tokens = tokenize('<!DOCTYPE html><!-- c --><?xml version="1.0"?>');
  assert.equal(tokens[0].type, 'bogusComment');
  assert.equal(tokens[1].type, 'comment');
  assert.equal(tokens[2].type, 'bogusComment');
});

test('未闭合注释到 EOF 容错', () => {
  const errors = [];
  const tokens = tokenize('<!-- never closed', errors);
  assert.equal(tokens[0].type, 'comment');
  assert.ok(errors.some((e) => e.type === 'unterminated-comment'));
});

test('畸形结束标签容错', () => {
  const errors = [];
  const tokens = tokenize('<p>a</ b><p>c', errors);
  const endTags = tokens.filter((t) => t.type === 'endTag');
  assert.equal(endTags.length, 0); // "</ b" 名字为空,按畸形处理而非结束标签
  assert.ok(errors.some((e) => e.type === 'malformed-end-tag'));
});

test('单独的 < 按文本处理', () => {
  const tokens = tokenize('a < b');
  assert.deepEqual(tokenTypes('a < b'), ['text', 'text', 'text']);
});

test('自闭合斜杠被识别', () => {
  const [tag] = tokenize('<br/>');
  assert.equal(tag.selfClosing, true);
  const [div] = tokenize('<div />');
  assert.equal(div.selfClosing, true);
});

test('结束标签上的属性被忽略并记录', () => {
  const errors = [];
  tokenize('<p>a</p class="x">', errors);
  assert.ok(errors.some((e) => e.type === 'attributes-on-end-tag'));
});

test('空白字符(制表/换行/回车)分隔属性', () => {
  const [tag] = tokenize('<input\n\ttype="text"\rdisabled>');
  assert.deepEqual(tag.attrs.map((a) => a.name), ['type', 'disabled']);
});

test('嵌套结构按顺序产出 token', () => {
  const tokens = tokenize('<div><span>x</span></div>');
  assert.deepEqual(
    tokens.map((t) => `${t.type}:${t.name || ''}`),
    ['startTag:div', 'startTag:span', 'text:', 'endTag:span', 'endTag:div']
  );
});
