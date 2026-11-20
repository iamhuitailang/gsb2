import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultAdjustments,
  cloneAdjustments,
  normalizeAdjustments,
  setGroup,
  resetGroup,
  isDefaultGroup,
  adjustmentsAreDefault,
  describeAdjustments,
  validateGroup
} from '../src/lib/adjustments.js';
import {
  COPY_GROUPS,
  copyAdjustmentGroups,
  createImageRecord,
  createProject,
  fileRefFromFile,
  loadProject,
  parseProjectText,
  recordFineTune,
  saveProjectToStorage,
  readProjectFromStorage,
  serializeProject,
  PROJECT_STORAGE_KEY
} from '../src/lib/project.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    _map: map
  };
}

function makeImage(overrides = {}) {
  const image = createImageRecord({
    fileRef: {
      name: 'photo.jpg',
      size: 1024,
      type: 'image/jpeg',
      lastModified: 1700000000000,
      orientation: 6,
      width: 640,
      height: 480
    },
    contentType: 'image/jpeg',
    width: 480,
    height: 640,
    orientation: 6,
    adjustments: defaultAdjustments(),
    thumbnail: 'data:image/jpeg;base64,AAAA'
  });
  return Object.assign(image, overrides);
}

test('default adjustments report as untouched', () => {
  const adjustments = defaultAdjustments();
  assert.equal(adjustmentsAreDefault(adjustments), true);
  for (const group of ['exposure', 'whiteBalance', 'toneCurve', 'saturation']) {
    assert.equal(isDefaultGroup(adjustments, group), true, group);
  }
  assert.equal(describeAdjustments(adjustments), '未调整');
});

test('setGroup rejects invalid values without mutating the input', () => {
  const adjustments = defaultAdjustments();
  const before = JSON.stringify(adjustments);
  assert.throws(() => setGroup(adjustments, 'exposure', { ev: 12 }), /-5 至 5|−5/);
  assert.throws(() => setGroup(adjustments, 'whiteBalance', { temperature: 500, tint: 0 }), /色温/);
  assert.throws(() => setGroup(adjustments, 'saturation', { value: Number.NaN }), /数字/);
  assert.equal(JSON.stringify(adjustments), before);
});

test('resetGroup restores exactly one group', () => {
  let adjustments = defaultAdjustments();
  adjustments = setGroup(adjustments, 'exposure', { ev: 1.5 });
  adjustments = setGroup(adjustments, 'saturation', { value: 40 });
  const reset = resetGroup(adjustments, 'exposure');
  assert.equal(reset.exposure.ev, 0);
  assert.equal(reset.saturation.value, 40);
  assert.equal(isDefaultGroup(reset, 'exposure'), true);
  assert.equal(isDefaultGroup(reset, 'saturation'), false);
  assert.equal(isDefaultGroup(adjustments, 'exposure'), false, 'original untouched');
});

test('cloneAdjustments is a deep copy', () => {
  const adjustments = defaultAdjustments();
  const clone = cloneAdjustments(adjustments);
  clone.toneCurve.master[0][1] = 0.4;
  clone.exposure.ev = 2;
  assert.equal(adjustments.toneCurve.master[0][1], 0);
  assert.equal(adjustments.exposure.ev, 0);
});

test('describeAdjustments summarises every non-default group', () => {
  let adjustments = defaultAdjustments();
  adjustments = setGroup(adjustments, 'exposure', { ev: -0.5 });
  adjustments = setGroup(adjustments, 'whiteBalance', { temperature: 20, tint: -10 });
  adjustments = setGroup(adjustments, 'saturation', { value: 15 });
  const text = describeAdjustments(adjustments);
  assert.match(text, /曝光 -0\.50 EV/);
  assert.match(text, /白平衡 \+20\/-10/);
  assert.match(text, /饱和 \+15/);
});

test('copyAdjustmentGroups copies only the requested groups', () => {
  let source = defaultAdjustments();
  source = setGroup(source, 'exposure', { ev: 1 });
  source = setGroup(source, 'saturation', { value: 30 });
  let target = defaultAdjustments();
  target = setGroup(target, 'whiteBalance', { temperature: 10, tint: 0 });

  const merged = copyAdjustmentGroups(source, target, ['exposure']);
  assert.equal(merged.exposure.ev, 1);
  assert.equal(merged.saturation.value, 0, 'saturation not copied');
  assert.equal(merged.whiteBalance.temperature, 10, 'target WB preserved');
  assert.deepEqual(COPY_GROUPS.length, 4);
});

test('recordFineTune replaces an earlier overlay for the same group', () => {
  const image = makeImage();
  image.batchBase = cloneAdjustments(defaultAdjustments());
  image.fineTune = recordFineTune(image, 'exposure', defaultAdjustments());
  const updated = { ...defaultAdjustments(), exposure: { ev: 2 } };
  image.fineTune = recordFineTune(image, 'exposure', updated);
  assert.equal(image.fineTune.length, 1);
  assert.equal(image.fineTune[0].adjustments.exposure.ev, 2);
});

test('project round-trips through storage and reload', () => {
  const project = createProject({ name: '产品图批次' });
  const image = makeImage();
  image.adjustments = setGroup(image.adjustments, 'exposure', { ev: 0.75 });
  image.versions.push({
    id: 'ver_1',
    name: '暖调',
    createdAt: '2024-01-01T00:00:00.000Z',
    adjustments: setGroup(defaultAdjustments(), 'saturation', { value: 25 })
  });
  project.images.push(image);
  project.activeImageId = image.id;
  project.compareImageIds = [image.id];

  const storage = memoryStorage();
  const saved = saveProjectToStorage(project, storage);
  assert.equal(saved.ok, true);
  assert.ok(storage.getItem(PROJECT_STORAGE_KEY));

  const { project: loaded } = readProjectFromStorage(storage);
  assert.equal(loaded.name, '产品图批次');
  assert.equal(loaded.images.length, 1);
  assert.equal(loaded.images[0].adjustments.exposure.ev, 0.75);
  assert.equal(loaded.images[0].versions.length, 1);
  assert.equal(loaded.images[0].versions[0].name, '暖调');
  assert.equal(loaded.images[0].fileRef.name, 'photo.jpg');
  assert.equal(loaded.images[0].orientation, 6);
  assert.equal(loaded.images[0].thumbnail.startsWith('data:image/jpeg'), true);
  assert.equal(loaded.activeImageId, image.id);
});

test('storage quota failure reports an actionable error and keeps data', () => {
  const project = createProject();
  project.images.push(makeImage());
  const storage = {
    getItem: () => null,
    setItem: () => {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    },
    removeItem: () => {}
  };
  const result = saveProjectToStorage(project, storage);
  assert.equal(result.ok, false);
  assert.match(result.error, /空间不足/);
  assert.match(result.error, /原图/);
});

test('tolerant loader repairs damaged adjustments and reports why', () => {
  const raw = {
    schemaVersion: 1,
    name: '损坏项目',
    images: [
      {
        id: 'img_a',
        fileRef: { name: 'a.jpg', size: 10, orientation: 1, width: 100, height: 50 },
        adjustments: {
          exposure: { ev: 99 },
          whiteBalance: { temperature: 0, tint: 0 },
          toneCurve: {
            master: [[0, 0], [0.5, 0.4], [1, 1]],
            red: [[0.4, 0.2]], // unusable → linear fallback
            green: [[0, 0], [1, 1]],
            blue: 'nonsense'
          },
          saturation: { value: -30 }
        },
        versions: [{ name: '坏版本', adjustments: { exposure: { ev: 100 } } }]
      },
      'not-an-object'
    ]
  };
  const { project, messages } = loadProject(raw);
  assert.equal(project.images.length, 1);
  assert.equal(project.images[0].adjustments.exposure.ev, 0, 'invalid exposure reset');
  assert.equal(project.images[0].adjustments.saturation.value, -30, 'valid values survive');
  assert.equal(project.images[0].adjustments.toneCurve.red.length, 2, 'red curve fallback');
  assert.equal(project.images[0].adjustments.toneCurve.master.length, 3, 'valid curve preserved');
  assert.ok(messages.some((message) => /曝光/.test(message)));
  assert.ok(messages.some((message) => /跳过/.test(message)));
});

test('loader drops dangling compare/active references', () => {
  const raw = {
    schemaVersion: 1,
    images: [],
    activeImageId: 'ghost',
    compareImageIds: ['ghost', 'also-ghost']
  };
  const { project } = loadProject(raw);
  assert.equal(project.activeImageId, null);
  assert.deepEqual(project.compareImageIds, []);
});

test('serializeProject never includes the source file bytes', () => {
  const project = createProject();
  project.images.push(makeImage());
  const payload = serializeProject(project);
  const text = JSON.stringify(payload);
  assert.ok(!/data:[^"]{100,}/.test(text.replace(/"thumbnail":"[^"]*"/g, '"thumbnail":""')));
  assert.equal(payload.images[0].fileRef.name, 'photo.jpg');
  assert.ok(!('file' in payload.images[0]));
});

test('fileRefFromFile captures identity used for re-linking', () => {
  const file = { name: 'x.png', size: 321, type: 'image/png', lastModified: 42 };
  const ref = fileRefFromFile(file, { orientation: 8, width: 200, height: 100 });
  assert.deepEqual(ref, {
    name: 'x.png',
    size: 321,
    type: 'image/png',
    lastModified: 42,
    orientation: 8,
    width: 200,
    height: 100
  });
});

test('validateGroup rejects unknown groups', () => {
  assert.equal(validateGroup('nope', {}).ok, false);
});

test('normalizeAdjustments fills missing groups with defaults', () => {
  const { adjustments, warnings } = normalizeAdjustments({ exposure: { ev: 1 } });
  assert.equal(adjustments.exposure.ev, 1);
  assert.equal(adjustments.saturation.value, 0);
  assert.equal(adjustments.toneCurve.master.length, 2);
  assert.deepEqual(warnings, []);
});

test('parseProjectText handles empty, corrupt and valid text', () => {
  assert.deepEqual(parseProjectText(''), { project: null, messages: [] });
  assert.equal(parseProjectText(null).project, null);

  const corrupt = parseProjectText('{not json');
  assert.equal(corrupt.project, null);
  assert.ok(corrupt.messages.some((message) => /JSON/.test(message)));

  const project = createProject({ name: '示例' });
  project.images.push(makeImage());
  const text = JSON.stringify(serializeProject(project));
  const parsed = parseProjectText(text);
  assert.equal(parsed.project.name, '示例');
  assert.equal(parsed.project.images.length, 1);
  assert.equal(parsed.project.images[0].fileRef.name, 'photo.jpg');
});

test('loading a project keeps versions and per-group fine-tune records', () => {
  const project = createProject();
  const image = makeImage();
  image.versions.push({
    id: 'v1',
    name: '冷调',
    createdAt: '2024-02-02T00:00:00.000Z',
    adjustments: setGroup(defaultAdjustments(), 'whiteBalance', { temperature: -40, tint: 0 })
  });
  image.batchBase = cloneAdjustments(defaultAdjustments());
  image.preBatch = setGroup(defaultAdjustments(), 'saturation', { value: 5 });
  image.fineTune = recordFineTune(image, 'exposure', setGroup(defaultAdjustments(), 'exposure', { ev: 0.3 }));
  image.recipeSource = 'source.jpg';
  project.images.push(image);

  const parsed = parseProjectText(JSON.stringify(serializeProject(project)));
  const restored = parsed.project.images[0];
  assert.equal(restored.versions.length, 1);
  assert.equal(restored.versions[0].name, '冷调');
  assert.equal(restored.versions[0].adjustments.whiteBalance.temperature, -40);
  assert.ok(restored.batchBase);
  assert.equal(restored.preBatch.saturation.value, 5);
  assert.equal(restored.fineTune.length, 1);
  assert.equal(restored.fineTune[0].group, 'exposure');
  assert.equal(restored.recipeSource, 'source.jpg');
});

test('project with a truncated image list still opens with the valid entries', () => {
  const raw = {
    schemaVersion: 1,
    name: '部分损坏',
    images: [
      { id: 'ok', fileRef: { name: 'a.jpg', size: 1 }, adjustments: defaultAdjustments() },
      null,
      { fileRef: 'nope' }
    ],
    activeImageId: 'ok'
  };
  const { project, messages } = loadProject(raw);
  assert.equal(project.images.length, 1);
  assert.equal(project.activeImageId, 'ok');
  assert.ok(messages.filter((message) => /跳过/.test(message)).length >= 1);
});