import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/loadTs.mjs';

const fileChunks = [
  { content: 'first passage', embedding: [1, 0] },
  { content: 'second passage', embedding: [0, 1] },
];
const { default: Store } = loadTs('src/lib/uploads/store.ts', {
  './manager': {
    getFile: (id) => ({ id, name: id }),
    getFileChunks: () => fileChunks,
  },
});

test('equal similarity scores do not collapse distinct file passages', async () => {
  const store = new Store({
    fileIds: ['file-a'],
    embeddingModel: { embedText: async () => [[1, 1]] },
  });
  assert.deepEqual(
    (await store.query(['query'], 10)).map((r) => r.content),
    ['first passage', 'second passage'],
  );
});

test('different query scores fuse into one result per passage', async () => {
  const store = new Store({
    fileIds: ['file-a', 'file-a'],
    embeddingModel: {
      embedText: async () => [
        [1, 0],
        [0, 1],
      ],
    },
  });
  const results = await store.query(['first', 'second'], 10);
  assert.equal(results.length, 2);
  assert.equal(new Set(results.map((r) => r.content)).size, 2);
});

test('identical excerpts in different files keep both file identities', async () => {
  const store = new Store({
    fileIds: ['file-a', 'file-b'],
    embeddingModel: { embedText: async () => [[1, 1]] },
  });
  const results = await store.query(['query'], 10);
  assert.equal(results.length, 4);
  assert.deepEqual(
    new Set(results.map((r) => r.metadata.url)),
    new Set(['file_id://file-a', 'file_id://file-b']),
  );
  assert.deepEqual(
    new Set(results.map((r) => r.metadata.fileId)),
    new Set(['file-a', 'file-b']),
  );
});
