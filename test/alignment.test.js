import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFSET_MARKER_RE,
  offsetFromTitle,
  trackTitle,
} from '../public/shared/alignment.js';

test('轨道标题携带可读回的偏移标记', () => {
  const title = trackTitle({ name: '中文音轨', offset: 0.6 });
  assert.equal(title, '中文音轨 [tw-offset=+0.600s]');
  assert.equal(offsetFromTitle(title), 0.6);
});

test('负偏移与零偏移的标记格式', () => {
  assert.equal(trackTitle({ name: 'A', offset: -1.25 }), 'A [tw-offset=-1.250s]');
  assert.equal(trackTitle({ name: 'B', offset: 0 }), 'B [tw-offset=+0.000s]');
  assert.equal(offsetFromTitle(trackTitle({ name: 'B', offset: 0 })), 0);
});

test('正则只匹配合法偏移标记', () => {
  assert.equal(offsetFromTitle('没有标记'), null);
  assert.equal(offsetFromTitle('tw-offset=+1.0s'), null);
  const match = '[tw-offset=-0.125s]'.match(OFFSET_MARKER_RE);
  assert.equal(Number(match[1]), -0.125);
});

test('标题里的换行被压平，避免破坏容器元数据', () => {
  const title = trackTitle({ name: 'line1\nline2', offset: 0.5 });
  assert.ok(!title.includes('\n'));
  assert.match(title, /line1 line2/);
});
