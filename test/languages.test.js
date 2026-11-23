import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGUAGES,
  guessLanguageFromFileName,
  languageFromTag,
  languageInfo,
  languageTag,
  normalizeLanguage,
} from '../public/shared/languages.js';

test('常见写法都归一为同一个内部代码', () => {
  for (const value of ['zh', 'zho', 'chi', 'Chinese', '中文', 'zh-CN', '简体']) {
    assert.equal(normalizeLanguage(value), 'zh', value);
  }
  for (const value of ['en', 'eng', 'English', '英语', 'en-US']) {
    assert.equal(normalizeLanguage(value), 'en', value);
  }
});

test('未知值回落到 und，也可指定 fallback', () => {
  assert.equal(normalizeLanguage('klingon'), 'und');
  assert.equal(normalizeLanguage(null), 'und');
  assert.equal(normalizeLanguage('klingon', 'en'), 'en');
});

test('语言代码与 ISO 639-2 标签互转', () => {
  assert.equal(languageTag('zh'), 'zho');
  assert.equal(languageTag('en'), 'eng');
  assert.equal(languageTag('yue'), 'yue');
  assert.equal(languageFromTag('zho'), 'zh');
  assert.equal(languageFromTag('eng'), 'en');
  assert.equal(languageFromTag('und'), 'und');
});

test('languageInfo 对未知代码返回未指定', () => {
  assert.equal(languageInfo('xx').code, 'und');
  assert.equal(languageInfo('zh').label, '中文');
});

test('LANGUAGES 每项都有 code / tag / label', () => {
  for (const lang of LANGUAGES) {
    assert.match(lang.code, /^[a-z]{2,3}$/);
    assert.match(lang.tag, /^[a-z]{3}$/);
    assert.ok(lang.label);
  }
});

test('从文件名猜测语言', () => {
  assert.equal(guessLanguageFromFileName('lesson.zh.srt'), 'zh');
  assert.equal(guessLanguageFromFileName('音轨-粤语.wav'), 'yue');
  assert.equal(guessLanguageFromFileName('English track.m4a'), 'en');
  assert.equal(guessLanguageFromFileName('subtitles.vtt'), 'und');
});
