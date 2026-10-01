import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiverseCandidatePool,
  dedupeEvidenceChunks,
  dedupeSearchResults,
  groupEvidenceBySource,
  limitChunksForMode,
} from '../../src/lib/agents/search/resultUtils.ts';

const chunk = (url, content, searchQuery = 'query', searchRank = 1) => ({
  content,
  metadata: {
    title: url,
    url,
    searchQuery,
    searchRank,
  },
});

test('discovery dedupe collapses a URL while evidence dedupe preserves excerpts', () => {
  const chunks = [
    chunk('file_id://report', 'first relevant excerpt'),
    chunk('file_id://report', 'second relevant excerpt'),
  ];

  assert.equal(dedupeSearchResults(chunks).length, 1);
  assert.equal(dedupeEvidenceChunks(chunks).length, 2);
});

test('grouped evidence retains multiple selected excerpts under one citation', () => {
  const first = 'A'.repeat(1_800);
  const second = 'B'.repeat(1_800);
  const [grouped] = groupEvidenceBySource([
    chunk('https://example.com/report', first),
    chunk('https://example.com/report', second),
  ]);

  assert.equal(grouped.metadata.evidenceChunkCount, 2);
  assert.match(grouped.content, /A{100}/);
  assert.match(grouped.content, /B{100}/);
  assert.ok(grouped.content.length > 3_500);
});

test('candidate selection covers queries and limits domain concentration', () => {
  const selected = buildDiverseCandidatePool(
    [
      chunk('https://a.example/1', 'a1', 'first query', 1),
      chunk('https://a.example/2', 'a2', 'first query', 2),
      chunk('https://b.example/1', 'b1', 'second query', 1),
      chunk('https://c.example/1', 'c1', 'second query', 2),
    ],
    3,
    1,
  );

  assert.deepEqual(
    new Set(selected.map((item) => item.metadata.searchQuery)),
    new Set(['first query', 'second query']),
  );
  assert.equal(
    new Set(selected.map((item) => new URL(item.metadata.url).hostname)).size,
    3,
  );
});

test('mode limiting preserves several upload excerpts from the same file', () => {
  const selected = limitChunksForMode(
    [
      chunk('file_id://report', 'first upload excerpt'),
      chunk('file_id://report', 'second upload excerpt'),
      chunk('https://example.com', 'web result'),
    ],
    'speed',
  );

  assert.equal(
    selected.filter((item) => item.metadata.url === 'file_id://report').length,
    2,
  );
});

test('same-title sources cannot exchange content or citation URLs', () => {
  const results = dedupeSearchResults([
    {
      ...chunk('https://a.example/A', 'short'),
      metadata: { title: 'A shared page title', url: 'https://a.example/A' },
    },
    {
      ...chunk('https://b.example/B', 'longer and different'),
      metadata: { title: 'A shared page title', url: 'https://b.example/B' },
    },
  ]);
  assert.deepEqual(
    results.map((r) => [r.metadata.url, r.content]),
    [
      ['https://a.example/A', 'short'],
      ['https://b.example/B', 'longer and different'],
    ],
  );
});

test('case-sensitive paths and query values remain distinct', () => {
  assert.equal(
    dedupeSearchResults([
      chunk('https://example.com/A?key=X', 'one'),
      chunk('https://example.com/a?key=X', 'two'),
      chunk('https://example.com/A?key=x', 'three'),
    ]).length,
    3,
  );
  assert.equal(
    dedupeSearchResults([
      chunk('https://EXAMPLE.com/A?utm_source=x#one', 'one'),
      chunk('https://example.com/A', 'longer'),
    ]).length,
    1,
  );
});

test('evidence deduplication preserves case-sensitive facts', () => {
  assert.equal(
    dedupeEvidenceChunks([
      chunk('file_id://report', 'constant A'),
      chunk('file_id://report', 'constant a'),
    ]).length,
    2,
  );
});
