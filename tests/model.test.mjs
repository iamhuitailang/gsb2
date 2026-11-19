import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addAnnotation,
  addImage,
  addLabel,
  buildExport,
  createProject,
  deleteAnnotation,
  deleteLabel,
  labelUsage,
  mergeProject,
  moveLabel,
  parseDraft,
  renameLabel,
  serializeDraft,
  setAnnotationFlag,
  updateAnnotationGeometry,
} from '../src/model.js';

function projectWithLabels() {
  let project = createProject();
  for (const name of ['道路', '车辆', '行人']) {
    project = addLabel(project, name).project;
  }
  project = addImage(project, { id: 'img1', name: 'a.png', width: 400, height: 300 });
  project = addImage(project, { id: 'img2', name: 'b.png', width: 200, height: 200 });
  return project;
}

function labelIdByName(project, name) {
  return project.labels.find((label) => label.name === name).id;
}

test('标签可以新建、改名、排序；改名后所有标注同步', () => {
  let project = projectWithLabels();
  const [road, car] = project.labels;
  assert.equal(project.labels.length, 3);

  const dup = addLabel(project, '车辆');
  assert.equal(dup.label, null);
  assert.match(dup.error, /已存在/);

  let added = addAnnotation(project, 'img1', {
    type: 'rect',
    labelId: car.id,
    rect: { x: 10, y: 10, width: 50, height: 40 },
  });
  project = added.project;
  added = addAnnotation(project, 'img2', {
    type: 'polygon',
    labelId: car.id,
    points: [[0, 0], [100, 0], [100, 100]],
  });
  project = added.project;

  const renamed = renameLabel(project, car.id, '汽车');
  assert.equal(renamed.error, null);
  project = renamed.project;
  const exported = buildExport(project);
  assert.deepEqual(exported.images[0].annotations[0].category, '汽车');
  assert.deepEqual(exported.images[1].annotations[0].category, '汽车');
  assert.equal(exported.images[0].annotations[0].categoryId, car.id);

  const moved = moveLabel(project, car.id, -1);
  assert.deepEqual(moved.labels.map((label) => label.name), ['汽车', '道路', '行人']);
  assert.equal(buildExport(moved).labelMap['汽车'], 1);
  assert.equal(buildExport(moved).labelMap['道路'], 2);

  const clash = renameLabel(moved, road.id, '行人');
  assert.match(clash.error, /已存在/);
});

test('删除正在使用的标签会给出影响范围并能转移标注', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  const road = labelIdByName(project, '道路');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 0, y: 0, width: 20, height: 20 },
  }).project;
  project = addAnnotation(project, 'img2', {
    type: 'rect', labelId: car, rect: { x: 5, y: 5, width: 30, height: 30 },
  }).project;

  const usage = labelUsage(project, car);
  assert.equal(usage.annotations, 2);
  assert.equal(usage.images, 2);

  const reassigned = deleteLabel(project, car, { mode: 'reassign', targetLabelId: road });
  assert.equal(reassigned.error, null);
  assert.equal(reassigned.project.labels.length, 2);
  assert.ok(reassigned.project.images
    .flatMap((image) => image.annotations)
    .every((annotation) => annotation.labelId === road));

  const deleted = deleteLabel(project, car, { mode: 'delete' });
  assert.equal(deleted.project.images.flatMap((image) => image.annotations).length, 0);
});

test('重叠标注：后添加的在上层，导出时保留顺序', () => {
  let project = projectWithLabels();
  const road = labelIdByName(project, '道路');
  const car = labelIdByName(project, '车辆');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: road, rect: { x: 0, y: 0, width: 200, height: 200 },
  }).project;
  project = addAnnotation(project, 'img1', {
    type: 'polygon', labelId: car, points: [[20, 20], [120, 20], [120, 120], [20, 120]],
  }).project;
  const annotations = project.images[0].annotations;
  assert.equal(annotations.length, 2);
  assert.equal(annotations[0].labelId, road);
  assert.equal(annotations[1].labelId, car);
  assert.equal(buildExport(project).images[0].annotations.length, 2);
});

test('隐藏与锁定互不影响：隐藏不导出，锁定仍导出', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 0, y: 0, width: 20, height: 20 },
  }).project;
  const id = project.images[0].annotations[0].id;
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 30, y: 0, width: 20, height: 20 },
  }).project;
  const id2 = project.images[0].annotations[1].id;

  project = setAnnotationFlag(project, 'img1', id, 'hidden', true);
  project = setAnnotationFlag(project, 'img1', id2, 'locked', true);
  const exported = buildExport(project).images[0];
  assert.equal(exported.annotations.length, 1);
  assert.equal(exported.annotations[0].id, id2);
  // 其他标注仍然可编辑
  project = updateAnnotationGeometry(project, 'img1', id2, {
    rect: { x: 40, y: 5, width: 20, height: 20 },
  });
  assert.deepEqual(project.images[0].annotations[1].rect, { x: 40, y: 5, width: 20, height: 20 });
});

test('保存草稿再打开：坐标、标签、隐藏/锁定状态保持一致', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  const road = labelIdByName(project, '道路');
  project = addAnnotation(project, 'img1', {
    type: 'polygon',
    labelId: car,
    points: [[10.123, 20.456], [200.987, 30], [150, 180.5]],
  }).project;
  project = addAnnotation(project, 'img1', {
    type: 'rect',
    labelId: road,
    rect: { x: 1.005, y: 2.994, width: 30.55, height: 40.25 },
  }).project;
  project = setAnnotationFlag(project, 'img1', project.images[0].annotations[1].id, 'locked', true);
  project = setAnnotationFlag(project, 'img1', project.images[0].annotations[0].id, 'hidden', true);
  project = { ...project, activeImageId: 'img2' };

  const draft = JSON.parse(JSON.stringify(serializeDraft(project)));
  const restored = parseDraft(draft);
  assert.equal(restored.activeImageId, 'img2');
  assert.deepEqual(
    restored.labels.map((label) => label.name),
    project.labels.map((label) => label.name),
  );
  const before = project.images[0].annotations;
  const after = restored.images[0].annotations;
  assert.equal(after.length, 2);
  assert.deepEqual(after[0].points, before[0].points.map(([x, y]) => [
    Math.round(x * 100) / 100,
    Math.round(y * 100) / 100,
  ]));
  assert.equal(after[0].hidden, true);
  assert.equal(after[1].locked, true);
  // 草稿保存时坐标统一保留两位小数，重新打开后保持一致
  assert.deepEqual(after[1].rect, { x: 1, y: 2.99, width: 30.55, height: 40.25 });
});

test('打开草稿会丢弃越界坐标、悬空标签和退化图形', () => {
  const draft = {
    labels: [
      { id: 'l1', name: '甲', color: '#e5484d' },
      { id: 'l1-dup', name: '甲', color: '#e5484d' },
    ],
    images: [{
      id: 'i1',
      name: 'x.png',
      width: 100,
      height: 80,
      annotations: [
        { id: 'a1', type: 'rect', labelId: 'l1', rect: { x: -50, y: -50, width: 200, height: 200 } },
        { id: 'a2', type: 'polygon', labelId: 'l1', points: [[0, 0], [10, 10]] },
        { id: 'a3', type: 'rect', labelId: 'missing', rect: { x: 0, y: 0, width: 20, height: 20 } },
        { id: 'a4', type: 'polygon', labelId: 'l1', points: [[-20, -20], [500, 0], [40, 400]] },
      ],
    }],
    activeImageId: 'i1',
  };
  const project = parseDraft(draft);
  assert.equal(project.labels.length, 1);
  const annotations = project.images[0].annotations;
  assert.deepEqual(annotations.map((item) => item.id), ['a1', 'a4']);
  assert.deepEqual(annotations[0].rect, { x: 0, y: 0, width: 100, height: 80 });
  for (const [x, y] of annotations[1].points) {
    assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 80);
  }
});

test('合并草稿按图片名去重，不会重复叠加标注', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 0, y: 0, width: 20, height: 20 },
  }).project;

  const incoming = parseDraft(serializeDraft(project));
  const merged = mergeProject(project, incoming).project;
  assert.equal(merged.images.length, 2);
  assert.equal(merged.images[0].annotations.length, 1);
  assert.equal(merged.labels.length, 3);
});

test('删除标注只影响目标项', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 0, y: 0, width: 20, height: 20 },
  }).project;
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 30, y: 0, width: 20, height: 20 },
  }).project;
  const [first, second] = project.images[0].annotations;
  project = deleteAnnotation(project, 'img1', first.id);
  assert.deepEqual(project.images[0].annotations.map((a) => a.id), [second.id]);
});

test('导出的 annotations.json 也能作为草稿重新打开', () => {
  let project = projectWithLabels();
  const car = labelIdByName(project, '车辆');
  const road = labelIdByName(project, '道路');
  project = addAnnotation(project, 'img1', {
    type: 'rect', labelId: car, rect: { x: 1, y: 2, width: 30, height: 40 },
  }).project;
  project = addAnnotation(project, 'img1', {
    type: 'polygon', labelId: road, points: [[5, 5], [80, 5], [80, 60], [5, 60]],
  }).project;
  const exported = buildExport(project);
  const restored = parseDraft(JSON.parse(JSON.stringify(exported)));
  assert.equal(restored.images.length, 2);
  assert.equal(restored.labels.length, 3);
  const annotations = restored.images[0].annotations;
  assert.equal(annotations.length, 2);
  const names = annotations.map((annotation) => (
    restored.labels.find((label) => label.id === annotation.labelId)?.name
  ));
  assert.deepEqual(names, ['车辆', '道路']);
  assert.deepEqual(annotations[0].rect, { x: 1, y: 2, width: 30, height: 40 });
  assert.deepEqual(annotations[1].points, [[5, 5], [80, 5], [80, 60], [5, 60]]);
});

test('非法颜色回退到默认色，不会写入任意字符串', () => {
  let project = createProject();
  project = addLabel(project, '甲', '#e5484d').project;
  project = addLabel(project, '乙', 'url(javascript:alert(1))').project;
  assert.equal(project.labels[0].color, '#e5484d');
  assert.match(project.labels[1].color, /^#[0-9a-f]{6}$/i);
  const draft = parseDraft({
    labels: [{ id: 'x', name: '丙', color: 'red;background:url(x)' }],
    images: [],
  });
  assert.match(draft.labels[0].color, /^#[0-9a-f]{6}$/i);
});

test('退化多边形（共线/零面积）会被拒绝', () => {
  let project = projectWithLabels();
  const road = labelIdByName(project, '道路');
  const result = addAnnotation(project, 'img1', {
    type: 'polygon', labelId: road, points: [[0, 0], [10, 0], [20, 0]],
  });
  assert.equal(result.annotation, null);
  assert.match(result.error, /多边形/);
  const draft = parseDraft({
    labels: [{ id: 'l1', name: '甲', color: '#e5484d' }],
    images: [{
      id: 'i1', name: 'a.png', width: 100, height: 100,
      annotations: [
        { id: 'a1', type: 'polygon', labelId: 'l1', points: [[0, 0], [50, 0], [100, 0]] },
        { id: 'a2', type: 'polygon', labelId: 'l1', points: [[0, 0], [50, 50], [100, 0]] },
      ],
    }],
  });
  assert.deepEqual(draft.images[0].annotations.map((a) => a.id), ['a2']);
});
