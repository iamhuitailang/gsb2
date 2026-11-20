import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, parseHeaderText } from '../src/core/parser.js';

test('解析合法策略并保留原文与规范化结果', () => {
  const text = "default-src 'self'; script-src 'self' https://cdn.example.com";
  const p = parsePolicy(text);
  assert.equal(p.hasErrors, false);
  assert.equal(p.raw, text);
  assert.equal(p.directives.length, 2);
  assert.equal(p.directiveMap.get('script-src').sources.length, 2);
  // 规范化：指令按字典序，来源稳定排序
  assert.ok(p.canonical.startsWith("default-src 'self'"));
  assert.ok(p.canonical.includes("script-src 'self' https://cdn.example.com"));
});

test('未知指令报 error 并给出拼写建议和行列位置', () => {
  const p = parsePolicy("default-src 'self'; stlye-src 'self'");
  const unknown = p.issues.find((i) => i.code === 'UNKNOWN_DIRECTIVE');
  assert.ok(unknown);
  assert.equal(unknown.severity, 'error');
  assert.equal(unknown.loc.line, 1);
  assert.equal(unknown.loc.column, 21); // 第二个指令名起始列（含分号与空格）
  assert.match(unknown.hint, /style-src/);
});

test('重复指令报 error 且第二条标记 duplicate', () => {
  const p = parsePolicy("default-src 'self'; default-src 'none'");
  const dup = p.issues.find((i) => i.code === 'DUPLICATE_DIRECTIVE');
  assert.ok(dup);
  assert.equal(p.directives[1].duplicate, true);
  // 规范化只保留第一条
  assert.match(p.canonical, /default-src 'self'/);
  assert.doesNotMatch(p.canonical, /none/);
});

test('未加引号的 self 给出精确修复提示', () => {
  const p = parsePolicy("script-src self");
  const err = p.issues.find((i) => i.code === 'INVALID_SOURCE');
  assert.ok(err);
  assert.match(err.message, /必须带单引号/);
  assert.match(err.hint, /'self'/);
});

test('错误哈希长度被识别并指出期望长度', () => {
  const p = parsePolicy("script-src 'sha256-short'");
  const err = p.issues.find((i) => i.code === 'INVALID_SOURCE');
  assert.ok(err);
  assert.match(err.message, /44/);
});

test('非法端口报错', () => {
  const p = parsePolicy("img-src https://img.example.com:99999");
  const err = p.issues.find((i) => i.code === 'INVALID_SOURCE');
  assert.ok(err);
  assert.match(err.message, /65535/);
});

test('空指令与空值分别报告', () => {
  const p = parsePolicy("default-src 'self';; img-src");
  const emptyDirective = p.issues.find((i) => i.code === 'EMPTY_DIRECTIVE');
  const emptyValue = p.issues.find((i) => i.code === 'EMPTY_VALUE');
  assert.ok(emptyDirective);
  assert.ok(emptyValue);
  assert.equal(emptyValue.severity, 'warning');
});

test('布尔指令带值报错', () => {
  const p = parsePolicy('upgrade-insecure-requests yes');
  const err = p.issues.find((i) => i.code === 'UNEXPECTED_VALUE');
  assert.ok(err);
});

test("'none' 与其他来源共存可被解析（语义问题交给 linter）", () => {
  const p = parsePolicy("img-src 'none' 'self'");
  assert.equal(p.hasErrors, false);
  assert.equal(p.directiveMap.get('img-src').sources.length, 2);
});

test('frame-ancestors 拒绝 unsafe-inline', () => {
  const p = parsePolicy("frame-ancestors 'self' 'unsafe-inline'");
  const err = p.issues.find((i) => i.code === 'SOURCE_NOT_ALLOWED_HERE');
  assert.ok(err);
});

test('多策略头按逗号拆分且位置基于整段文本', () => {
  const text = "default-src 'self', script-src 'sha256-short'";
  const header = parseHeaderText(text);
  assert.equal(header.policies.length, 2);
  assert.ok(header.issues.some((i) => i.code === 'INVALID_SOURCE'));
  // 第二条策略的偏移在逗号之后
  assert.ok(header.policies[1].baseOffset > 0);
  const badIssue = header.issues.find((i) => i.code === 'INVALID_SOURCE');
  assert.ok(badIssue.loc.offset >= header.policies[1].baseOffset);
});

test('多行列文本的行列定位正确', () => {
  const p = parsePolicy("default-src 'self';\nscript-src 'sha256-short'");
  const err = p.issues.find((i) => i.code === 'INVALID_SOURCE');
  assert.equal(err.loc.line, 2);
  assert.equal(err.loc.column, 12);
  assert.equal(err.loc.lineText, "script-src 'sha256-short'");
});

test('nonce 与 hash 解析为对应类型', () => {
  const valid = parsePolicy(
    `script-src 'nonce-abcDEF123' 'sha256-${'A'.repeat(43)}='`
  );
  assert.equal(valid.hasErrors, false);
  const srcs = valid.directiveMap.get('script-src').sources;
  assert.equal(srcs[0].kind, 'nonce');
  assert.equal(srcs[1].kind, 'hash');
  assert.equal(srcs[1].algo, 'sha256');
});

test('nonce 缺少引号时给出修复提示', () => {
  const p = parsePolicy("script-src 'nonce-abc123");
  assert.ok(p.issues.some((i) => i.code === 'INVALID_SOURCE'));
});

test('report-uri 含空白的非法 token 报错', () => {
  const p = parsePolicy('report-uri /a /b/c');
  // /a 与 /b/c 均为合法相对 URI，不应报错
  assert.equal(p.issues.some((i) => i.code === 'INVALID_URI'), false);
  // token 内不允许出现非法字符（引号会破坏 token 结构）
  const bad = parsePolicy("report-uri /path'with'quote");
  assert.ok(bad.issues.some((i) => i.code === 'INVALID_URI' || i.code === 'INVALID_SOURCE'));
});
