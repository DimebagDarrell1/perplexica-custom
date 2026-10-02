import test from 'node:test';
import assert from 'node:assert/strict';
import { getEncoding } from 'js-tiktoken';
import { loadTs } from '../helpers/loadTs.mjs';
const embedding = { embedText: async (texts) => texts.map(() => [1, 0]) };
const file = {
  content: 'File evidence',
  metadata: { title: 'File', url: 'file_id://one' },
};
const web = {
  content: 'Web snippet evidence',
  metadata: { title: 'Web', url: 'https://example.com/article' },
};

test('failed deep reads retain web snippets alongside uploaded evidence', async () => {
  const { buildFilteredContext } = loadTs(
    'src/lib/agents/search/contextFilter.ts',
    {
      '@/lib/config': {
        __esModule: true,
        default: { getConfig: (_key, fallback) => fallback },
      },
      '@/lib/scraper': {
        __esModule: true,
        default: {
          scrape: async () => {
            throw new Error('unavailable');
          },
        },
      },
    },
  );
  const result = await buildFilteredContext(
    'question',
    undefined,
    [file, web],
    embedding,
  );
  assert.equal(result.length, 2);
  assert.ok(result.some((chunk) => chunk.content.includes(web.content)));
  assert.ok(result.some((chunk) => chunk.content.includes(file.content)));
});

test('pipeline failure reserves fallback space for web results and bounds evidence tokens', async () => {
  const { prepareWriterContext } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': {
        buildFilteredContext: async () => {
          throw new Error('offline');
        },
      },
      '@/lib/uploads/store': {},
    },
  );
  const findings = Array.from({ length: 30 }, (_, i) => ({
    content: `Evidence ${i} ` + 'detail '.repeat(3000),
    metadata: { title: `File ${i}`, url: `file_id://${i}` },
  }));
  const result = await prepareWriterContext(
    [...findings, web],
    'question',
    undefined,
    embedding,
    'speed',
  );
  assert.ok(result.some((chunk) => chunk.metadata.url === web.metadata.url));
  const enc = getEncoding('cl100k_base');
  assert.ok(
    result.reduce((sum, chunk) => sum + enc.encode(chunk.content).length, 0) <=
      8000,
  );
});

test('cancelled context filtering throws instead of starting writer fallback', async () => {
  const controller = new AbortController();
  const { prepareWriterContext } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': {
        buildFilteredContext: async () => {
          controller.abort();
          throw controller.signal.reason;
        },
      },
      '@/lib/uploads/store': {},
    },
  );
  await assert.rejects(
    prepareWriterContext(
      [web],
      'q',
      undefined,
      embedding,
      'speed',
      controller.signal,
    ),
    { name: 'AbortError' },
  );
});

test('retrieved files are not repeated as initial excerpts or user-message content', () => {
  const requested = [];
  const { formatWriterContext, buildWriterUserMessage } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': {},
      '@/lib/uploads/store': {
        __esModule: true,
        default: {
          getFileData(ids) {
            requested.push(ids);
            return ids.map((id) => ({
              fileName: id,
              initialContent: 'initial excerpt',
            }));
          },
        },
      },
    },
  );
  const context = formatWriterContext([file], [], ['one', 'two']);
  assert.deepEqual(requested[0], ['two']);
  assert.equal(context.match(/File evidence/g).length, 1);
  assert.ok(
    !buildWriterUserMessage('question', ['one']).includes('initial excerpt'),
  );
});
