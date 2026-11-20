import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFilesToImages, fileRefSignature } from '../src/lib/file-store.js';

function record(id, name, size, lastModified) {
  return { record: { id, fileRef: { name, size, lastModified } }, needsRelink: true };
}

function picked(name, size, lastModified) {
  return { file: { name, size, lastModified }, handle: null };
}

test('exact name + size + mtime matches first', () => {
  const { matches, unmatchedFiles } = matchFilesToImages(
    [record('a', 'one.jpg', 100, 5), record('b', 'two.jpg', 200, 6)],
    [picked('two.jpg', 200, 6), picked('one.jpg', 100, 5)]
  );
  assert.equal(matches.get('a').file.name, 'one.jpg');
  assert.equal(matches.get('b').file.name, 'two.jpg');
  assert.equal(unmatchedFiles.length, 0);
});

test('falls back to name + size when the mtime changed (copied file)', () => {
  const { matches } = matchFilesToImages([record('a', 'one.jpg', 100, 5)], [picked('one.jpg', 100, 999)]);
  assert.equal(matches.get('a').file.lastModified, 999);
});

test('does not match a different size and leaves the file unattached', () => {
  const { matches, unmatchedFiles } = matchFilesToImages(
    [record('a', 'one.jpg', 100, 5)],
    [picked('one.jpg', 101, 5)]
  );
  assert.equal(matches.size, 0);
  assert.equal(unmatchedFiles.length, 1);
});

test('two images with the same name get two distinct files', () => {
  const { matches } = matchFilesToImages(
    [record('a', 'same.jpg', 10, 1), record('b', 'same.jpg', 10, 1)],
    [picked('same.jpg', 10, 1), picked('same.jpg', 10, 1)]
  );
  assert.equal(matches.size, 2);
  assert.notEqual(matches.get('a'), matches.get('b'));
});

test('images that do not need relinking are ignored', () => {
  const { matches } = matchFilesToImages(
    [{ record: { id: 'x', fileRef: { name: 'one.jpg', size: 1, lastModified: 1 } }, needsRelink: false }],
    [picked('one.jpg', 1, 1)]
  );
  assert.equal(matches.size, 0);
});

test('fileRefSignature is stable and distinguishes fields', () => {
  const a = fileRefSignature({ name: 'a.jpg', size: 1, lastModified: 2 });
  assert.equal(a, 'a.jpg|1|2');
  assert.notEqual(a, fileRefSignature({ name: 'a.jpg', size: 2, lastModified: 2 }));
});
