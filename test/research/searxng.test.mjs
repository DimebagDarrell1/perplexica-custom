import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../helpers/loadTs.mjs';

const { selectSearchResults, searchSearxng } = loadTs('src/lib/searxng.ts', {
  './config/serverRegistry': { getSearxngURL: () => 'http://search.test' },
});
const result = (title, engine = 'yandex', content = '') => ({
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
  content,
  engine,
  engines: [engine],
});

test('discovery checks beyond the result cap and preserves engine provenance', () => {
  const unrelated = Array.from({ length: 8 }, (_, i) =>
    result(`Mail account ${i}`, 'bing'),
  );
  const topical = Array.from({ length: 8 }, (_, i) =>
    result(`Coraline production ${i}`),
  );
  const selected = selectSearchResults(
    'What are some unique facts about Coraline?',
    [...unrelated, ...topical],
    8,
  );
  assert.deepEqual(selected, topical);
  assert.deepEqual(selected[0].engines, ['yandex']);
});

test('question filler cannot promote unrelated pages ahead of a named subject', () => {
  const generic = result('Interesting facts about what you can find');
  const topical = result('Coraline at LAIKA');
  assert.deepEqual(
    selectSearchResults(
      'What are some interesting facts about Coraline?',
      [generic, topical],
      1,
    ),
    [topical],
  );
});

test('unmatched semantic results fill spare slots and keep their original order', () => {
  const semantic = result('The artistry of a stop-motion studio');
  const other = result('A conversation with the director');
  const topical = result('Coraline production design');
  assert.deepEqual(
    selectSearchResults('Coraline', [semantic, other, topical], 3),
    [topical, semantic, other],
  );
  assert.deepEqual(
    selectSearchResults('animation craftsmanship', [semantic, other], 2),
    [semantic, other],
  );
});

test('coding identifiers and CJK words remain searchable', () => {
  const junk = result('Mail and calendars');
  const cpp = result('C++ std::vector reference');
  const csharp = result('C# async examples');
  assert.deepEqual(selectSearchResults('C++ vector', [junk, cpp], 1), [cpp]);
  assert.deepEqual(selectSearchResults('C#', [cpp, csharp], 1), [csharp]);
  const japanese = result('京都観光の案内');
  assert.deepEqual(selectSearchResults('京都旅行', [junk, japanese], 1), [
    japanese,
  ]);
  const accented = result('Café culture');
  assert.deepEqual(selectSearchResults('cafe', [junk, accented], 1), [
    accented,
  ]);
});

test('lexical overlap matches complete words instead of substrings', () => {
  const unrelated = result('Concatenate strings');
  const topical = result('A cat sleeping');
  assert.deepEqual(selectSearchResults('cat', [unrelated, topical], 1), [
    topical,
  ]);
});

test('media calls preserve the search engine order and return failure provenance', async () => {
  const originalFetch = global.fetch;
  const first = result('Studio interview');
  const second = result('Coraline interview');
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      results: [first, second],
      unresponsive_engines: [
        ['brave', 'Too many requests'],
        ['mojeek', 'Access denied'],
      ],
    }),
  });
  try {
    for (const opts of [
      { engines: ['youtube'] },
      { engines: ['bing images'] },
      { categories: ['videos'] },
    ]) {
      const response = await searchSearxng('Coraline', {
        ...opts,
        maxResults: 1,
      });
      assert.deepEqual(response.results, [first]);
      assert.deepEqual(response.unresponsiveEngines, ['brave', 'mojeek']);
    }
    const response = await searchSearxng('Coraline', { maxResults: 1 });
    assert.deepEqual(response.results, [second]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('malformed optional fields cannot discard valid sibling search results', async () => {
  const originalFetch = global.fetch;
  const malformed = {
    title: 'Coraline title remains usable',
    url: 'https://example.com/partial',
    content: { toString: 1 },
    engine: { name: 'bing' },
    engines: [null, { name: 'bing' }, 'yandex', 'yandex', '', 1],
    img_src: ['https://example.com/image.jpg'],
  };
  const nullFields = {
    title: 'Coraline second title',
    url: 'https://example.com/null',
    content: null,
    engine: 'bing',
    engines: null,
  };
  const valid = result(
    'Coraline production',
    'wikipedia',
    'Useful production facts.',
  );
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      results: [
        null,
        [],
        42,
        { title: {}, url: 'https://example.com' },
        malformed,
        nullFields,
        valid,
      ],
      suggestions: [null, {}, 'Coraline production'],
      unresponsive_engines: [null, {}, [null, 'error'], ['brave', 'error']],
    }),
  });
  try {
    const response = await searchSearxng('Coraline');
    assert.deepEqual(response.results, [
      { title: malformed.title, url: malformed.url, engines: ['yandex'] },
      { title: nullFields.title, url: nullFields.url, engine: 'bing' },
      valid,
    ]);
    assert.deepEqual(response.suggestions, ['Coraline production']);
    assert.deepEqual(response.unresponsiveEngines, ['brave']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('invalid top-level search payloads fail clearly while an empty results array is valid', async () => {
  const originalFetch = global.fetch;
  try {
    for (const payload of [
      null,
      [],
      'not an object',
      {},
      { results: null },
      { results: {} },
    ]) {
      global.fetch = async () => ({ ok: true, json: async () => payload });
      await assert.rejects(searchSearxng('query'), /invalid search response/);
    }
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        results: [],
        suggestions: {},
        unresponsive_engines: {},
      }),
    });
    assert.deepEqual(await searchSearxng('query'), {
      results: [],
      suggestions: [],
      unresponsiveEngines: [],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('hyphenated compounds match ordinary words without conflating C++ and C#', () => {
  const relevant = result('Stop-motion filmmaking');
  const unrelated = result('Stop junk mail');
  assert.deepEqual(
    selectSearchResults('stop motion', [relevant, unrelated], 1),
    [relevant],
  );
  const spaced = result('Stop motion filmmaking');
  assert.deepEqual(selectSearchResults('stop-motion', [spaced, unrelated], 1), [
    spaced,
  ]);
  const cpp = result('C++ reference');
  const csharp = result('C# reference');
  assert.deepEqual(selectSearchResults('C++', [csharp, cpp], 1), [cpp]);
  assert.deepEqual(selectSearchResults('C#', [cpp, csharp], 1), [csharp]);
});
