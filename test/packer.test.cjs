/* 排版核心测试：node test/packer.test.cjs（零依赖） */
const assert = require('assert');
const path = require('path');
const Packer = require(path.join(__dirname, '..', 'public', 'js', 'packer.js'));
const U = require(path.join(__dirname, '..', 'public', 'js', 'util.js'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e.message));
    process.exitCode = 1;
  }
}

function items(list) {
  return list.map(([id, w, h, allowRotate]) => ({
    id,
    name: id,
    w,
    h,
    allowRotate: allowRotate !== false,
  }));
}

function noOverlap(placements) {
  const arr = Array.from(placements.values());
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      assert.ok(
        !Packer.rectsOverlap(arr[i], arr[j]),
        `重叠: ${arr[i].id} 与 ${arr[j].id}`
      );
    }
  }
}

console.log('util: uniqueNames');
test('重名自动追加唯一后缀，且不与已有名字冲突', () => {
  // 语义：对原名追加 -N 后缀。第四个输入本身就叫 gem-1（已被占用），
  // 因此它在自己原名上追加后缀成为 gem-1-1，全部名字两两不同。
  const out = U.uniqueNames(['gem', 'hero', 'gem', 'gem-1', 'hero']);
  assert.deepStrictEqual(out, ['gem', 'hero', 'gem-1', 'gem-1-1', 'hero-1']);
  assert.strictEqual(new Set(out).size, out.length);
  assert.deepStrictEqual(U.uniqueNames([]), []);
  // 简单重复：从 -1 开始递增
  assert.deepStrictEqual(U.uniqueNames(['a', 'a', 'a']), ['a', 'a-1', 'a-2']);
});

test('baseName 去目录与扩展名', () => {
  assert.strictEqual(U.baseName('chars/hero.png'), 'hero');
  assert.strictEqual(U.baseName('a.b.gem'), 'a.b');
});

console.log('packer: 基础排版');
test('全部放入且无重叠，限制模式按内容收缩', () => {
  const r = Packer.pack(items([['a', 100, 80], ['b', 60, 60], ['c', 40, 200]]), {
    mode: 'limit',
    width: 512,
    height: 512,
  });
  assert.ok(r.ok);
  assert.strictEqual(r.placements.size, 3);
  noOverlap(r.placements);
  r.placements.forEach((p) => {
    assert.ok(p.x + p.w <= r.width && p.y + p.h <= r.height);
  });
  assert.ok(r.width <= 512 && r.height <= 512);
  // 收缩模式下画布不小于内容
  assert.strictEqual(r.width, r.stats.contentWidth);
});

test('2 的幂模式：画布尺寸向上取整为 2 的幂', () => {
  const r = Packer.pack(items([['a', 100, 100]]), {
    mode: 'limit',
    width: 1024,
    height: 1024,
    powerOfTwo: true,
  });
  assert.ok(r.ok);
  assert.ok(Number.isInteger(Math.log2(r.width)));
  assert.ok(Number.isInteger(Math.log2(r.height)));
  assert.ok(r.width >= 100 && r.height >= 100);
});

test('固定模式画布恒为指定尺寸', () => {
  const r = Packer.pack(items([['a', 50, 50]]), {
    mode: 'fixed',
    width: 300,
    height: 200,
  });
  assert.strictEqual(r.width, 300);
  assert.strictEqual(r.height, 200);
});

console.log('packer: 旋转');
test('开启旋转时窄条可旋转放入，标记 rotated 且宽高互换', () => {
  // 300x40 的条在 200x320 画布里：正向超出宽度，旋转后 40x300 可放入
  const r = Packer.pack(items([['bar', 300, 40]]), {
    mode: 'limit',
    width: 200,
    height: 320,
    allowRotate: true,
  });
  assert.ok(r.ok);
  const p = r.placements.get('bar');
  assert.strictEqual(p.rotated, true);
  assert.strictEqual(p.w, 40);
  assert.strictEqual(p.h, 300);
});

test('单项禁用旋转：本可旋转放入的条被拒绝并给出旋转提示', () => {
  const r = Packer.pack(items([['bar', 300, 40, false]]), {
    mode: 'limit',
    width: 200,
    height: 320,
    allowRotate: true,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.rejected[0].reason, 'too_large');
  assert.ok(r.rejected[0].detail.includes('旋转'));
});

test('全局关闭旋转时不出现 rotated 放置', () => {
  const r = Packer.pack(
    items([['a', 120, 30], ['b', 120, 30], ['c', 120, 30]]),
    { mode: 'limit', width: 200, height: 200, allowRotate: false }
  );
  r.placements.forEach((p) => assert.strictEqual(p.rotated, false));
});

console.log('packer: 拒绝原因');
test('超界精灵返回 too_large 与尺寸明细', () => {
  const r = Packer.pack(items([['big', 300, 300]]), {
    mode: 'fixed',
    width: 200,
    height: 200,
  });
  assert.strictEqual(r.rejected.length, 1);
  assert.strictEqual(r.rejected[0].id, 'big');
  assert.strictEqual(r.rejected[0].reason, 'too_large');
  assert.ok(r.rejected[0].detail.includes('300×300'));
});

test('空间不足返回 no_space，并指出最大空闲矩形与占用面积', () => {
  const r = Packer.pack(
    items([['a', 150, 150], ['b', 150, 150], ['c', 150, 150]]),
    { mode: 'fixed', width: 256, height: 256 }
  );
  assert.strictEqual(r.placements.size, 1);
  assert.strictEqual(r.rejected[0].reason, 'no_space');
  assert.ok(r.rejected[0].detail.includes('空闲矩形'));
  assert.ok(r.rejected[0].detail.includes('px²'));
});

test('确定性：相同输入两次排版结果一致', () => {
  const input = items([
    ['a', 70, 90],
    ['b', 120, 40],
    ['c', 60, 60],
    ['d', 200, 30],
  ]);
  const r1 = Packer.pack(input, { mode: 'limit', width: 256, height: 256 });
  const r2 = Packer.pack(input, { mode: 'limit', width: 256, height: 256 });
  const s1 = Array.from(r1.placements.values())
    .map((p) => `${p.id}:${p.x},${p.y},${p.w},${p.h},${p.rotated}`)
    .sort()
    .join('|');
  const s2 = Array.from(r2.placements.values())
    .map((p) => `${p.id}:${p.x},${p.y},${p.w},${p.h},${p.rotated}`)
    .sort()
    .join('|');
  assert.strictEqual(s1, s2);
});

console.log('packer: 稳定重排');
test('增删精灵后，未变化精灵保持原位置（locked）', () => {
  const first = Packer.pack(
    items([['a', 80, 80], ['b', 80, 80], ['c', 80, 80]]),
    { mode: 'limit', width: 256, height: 256 }
  );
  const before = Array.from(first.placements.values()).map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    rotated: p.rotated,
  }));

  const second = Packer.pack(
    items([['a', 80, 80], ['c', 80, 80], ['d', 80, 80]]),
    {
      mode: 'limit',
      width: 256,
      height: 256,
      previous: first.placements,
    }
  );
  assert.ok(second.ok);
  ['a', 'c'].forEach((id) => {
    const oldP = before.find((p) => p.id === id);
    const newP = second.placements.get(id);
    assert.strictEqual(newP.x, oldP.x, id + ' x 稳定');
    assert.strictEqual(newP.y, oldP.y, id + ' y 稳定');
    assert.strictEqual(newP.locked, true, id + ' 标记 locked');
  });
  assert.deepStrictEqual(second.changed.added.sort(), ['d']);
  assert.deepStrictEqual(second.changed.removed, ['b']);
});

test('精灵尺寸变化后标记 resized 且仍无重叠', () => {
  const first = Packer.pack(items([['a', 80, 80], ['b', 80, 80]]), {
    mode: 'limit',
    width: 256,
    height: 256,
  });
  const second = Packer.pack(items([['a', 120, 120], ['b', 80, 80]]), {
    mode: 'limit',
    width: 256,
    height: 256,
    previous: first.placements,
  });
  assert.deepStrictEqual(second.changed.resized, ['a']);
  noOverlap(second.placements);
});

test('历史位置互相冲突时放弃锁定，回退到正常排版', () => {
  const bogus = new Map([
    ['a', { id: 'a', x: 0, y: 0, w: 80, h: 80, rotated: false }],
    ['b', { id: 'b', x: 10, y: 10, w: 80, h: 80, rotated: false }],
  ]);
  const r = Packer.pack(items([['a', 80, 80], ['b', 80, 80]]), {
    mode: 'limit',
    width: 256,
    height: 256,
    previous: bogus,
  });
  noOverlap(r.placements);
  assert.strictEqual(r.placements.size, 2);
});

console.log('packer: nextPow2 与自由矩形分割');
test('nextPow2 边界值', () => {
  assert.strictEqual(Packer.nextPow2(1), 1);
  assert.strictEqual(Packer.nextPow2(2), 2);
  assert.strictEqual(Packer.nextPow2(33), 64);
  assert.strictEqual(Packer.nextPow2(256), 256);
});

test('splitFree + pruneFree：切出的自由矩形不侵入占用区，且覆盖全部剩余空间', () => {
  const f = { x: 0, y: 0, w: 100, h: 100 };
  const used = { x: 20, y: 30, w: 40, h: 50 };
  const parts = Packer.pruneFree(Packer.splitFree(f, used));
  parts.forEach((p) => assert.ok(!Packer.rectsOverlap(p, used)));
  // 网格采样：占用区外的每个单位格必须被至少一个自由矩形覆盖
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 100; x++) {
      const inUsed = x >= 20 && x < 60 && y >= 30 && y < 80;
      const covered = parts.some(
        (p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h
      );
      assert.strictEqual(covered, !inUsed, `格点 (${x},${y}) 覆盖错误`);
    }
  }
});

console.log(`\n${passed} 项测试全部通过`);
