import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../helpers/loadTs.mjs';

const evidence = (url, content, title = 'Coraline') => ({
  content,
  metadata: { url, title },
});
const relevant = evidence(
  'https://laika.example/coraline',
  'Coraline production facts',
);
const irrelevant = evidence(
  'https://unrelated.example/category',
  'Unrelated behind-the-scenes videos',
  'Video category',
);
const embedding = { embedText: async (texts) => texts.map(() => [1, 0]) };

const pipeline = (scrape, mocks = {}) =>
  loadTs('src/lib/agents/search/contextFilter.ts', {
    '@/lib/config': {
      __esModule: true,
      default: { getConfig: (_key, fallback) => fallback },
    },
    '@/lib/scraper': { __esModule: true, default: { scrape } },
    ...mocks,
  });
const writer = (buildFilteredContext) =>
  loadTs('src/lib/agents/search/writerContext.ts', {
    './contextFilter': { buildFilteredContext },
    '@/lib/uploads/store': {},
  });

test('successful deep reads retain discovery engines and query across redirects', async () => {
  const { buildFilteredContext } = pipeline(async () => ({
    url: 'https://laika.example/final',
    title: 'Official film page',
    content: 'Coraline had nine different outfits for the film.',
    provider: 'fetch',
  }));
  const source = {
    ...relevant,
    metadata: {
      ...relevant.metadata,
      searchQueries: ['Coraline production'],
      searchEngines: ['yandex'],
    },
  };
  const result = await buildFilteredContext(
    'Coraline',
    undefined,
    [source],
    embedding,
  );
  assert.equal(result[0].metadata.url, 'https://laika.example/final');
  assert.deepEqual(result[0].metadata.searchEngines, ['yandex']);
  assert.deepEqual(result[0].metadata.searchQueries, ['Coraline production']);
});

test('unranked recovery excludes zero-overlap snippets when topic matches exist', async () => {
  const { prepareWriterContext } = writer(async () => {
    throw new Error('offline');
  });
  const output = await prepareWriterContext(
    [irrelevant, relevant],
    'what are some cool facts about the coraline movie',
    undefined,
    embedding,
    'speed',
  );
  assert.deepEqual(
    output.map((chunk) => chunk.metadata.url),
    [relevant.metadata.url],
  );
  assert.equal(output[0].metadata.contextRecovery, 'unranked');
});

test('lexical recovery preserves evidence for synonym-only and non-English queries', () => {
  const { selectFallbackSnippets } = loadTs(
    'src/lib/agents/search/fallbackEvidence.ts',
  );
  const medical = [
    evidence(
      'https://example.com',
      'Myocardial infarction',
      'Medical reference',
    ),
  ];
  assert.deepEqual(selectFallbackSnippets('heart attack', medical), medical);
  const japanese = evidence(
    'https://example.jp',
    'コラライン 制作',
    'コラライン',
  );
  assert.deepEqual(
    selectFallbackSnippets('コラライン', [irrelevant, japanese]),
    [japanese],
  );
});

for (const useJev of [false, true]) {
  test(`completed ${useJev ? 'Jev' : 'semantic'} ranking preserves synonyms beside literal distractors when page reads fail`, async () => {
    const medical = evidence(
      'https://medical.example/infarction',
      'Myocardial infarction: acute coronary occlusion and care',
      'Medical reference',
    );
    const police = evidence(
      'https://police.example/report',
      'Police report an attack near a bus stop',
      'Police report',
    );
    const checkpoints = [];
    const { buildFilteredContext } = pipeline(
      async () => {
        throw new Error('page unavailable');
      },
      {
        '@/lib/jev': {
          getJevConfig: () => ({
            enabled: true,
            configured: true,
            maxCandidates: 2,
          }),
          rerankWithJev: async (_query, results) => ({
            results: [...results].reverse(),
            status: 'applied',
          }),
        },
      },
    );
    const output = await buildFilteredContext(
      'heart attack',
      undefined,
      [police, medical],
      {
        embedText: async (texts) =>
          texts.map((text) => {
            if (text === 'heart attack') return [1, 0];
            const medicalMatch = text.includes('Myocardial infarction');
            return medicalMatch !== useJev ? [1, 0] : [0, 1];
          }),
      },
      {
        topKUrls: 2,
        useJev,
        onProgress: (progress) => checkpoints.push(progress),
      },
    );
    const expected = [medical.metadata.url, police.metadata.url];
    assert.deepEqual(
      output.map((chunk) => chunk.metadata.url),
      expected,
    );
    for (const checkpoint of checkpoints.filter((progress) =>
      useJev ? progress.jevUsed : true,
    )) {
      assert.deepEqual(
        checkpoint.chunks.map((chunk) => chunk.metadata.url),
        expected,
      );
    }
    assert.equal(checkpoints.at(-1).jevUsed, useJev);
  });
}

test('follow-up ranking embeds the resolved topic rather than a vague pronoun query', async () => {
  const embedded = [];
  const { buildFilteredContext } = pipeline(async () => {
    throw new Error('offline');
  });
  const output = await buildFilteredContext(
    'what is the meaning of the movie',
    'Coraline movie meaning and symbolism',
    [relevant],
    {
      embedText: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => [1, 0]);
      },
    },
  );
  assert.equal(embedded[0], 'Coraline movie meaning and symbolism');
  assert.equal(output[0].metadata.url, relevant.metadata.url);
});

test('completed deep reads survive failure in passage embeddings', async () => {
  const { buildFilteredContext } = pipeline(async (url) => ({
    url,
    title: 'Coraline production',
    content:
      'Site navigation and page menus. '.repeat(1000) +
      'Coraline handmade puppets from a completed page read',
    provider: 'fetch',
  }));
  const { prepareWriterContext } = writer(buildFilteredContext);
  let calls = 0;
  const output = await prepareWriterContext(
    [relevant],
    'Coraline facts',
    undefined,
    {
      embedText: async (texts) => {
        if (++calls === 3) throw new Error('embedding provider unavailable');
        return texts.map(() => [1, 0]);
      },
    },
    'speed',
  );
  assert.match(output[0].content, /handmade puppets/);
  assert.equal(output[0].metadata.extractionProvider, 'fetch');
  assert.equal(output[0].metadata.contextMode, 'partial');
  assert.equal(output[0].metadata.contextRecovery, 'scraped');
});

test('a context deadline keeps one completed page while cancelling a stalled sibling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let saved;
  const completed = new Promise((resolve) => {
    saved = resolve;
  });
  let stalledCancelled = false;
  const { buildFilteredContext } = pipeline(async (url, { signal }) => {
    if (url.includes('stalled')) {
      signal.addEventListener(
        'abort',
        () => {
          stalledCancelled = true;
        },
        { once: true },
      );
      return new Promise(() => {});
    }
    return {
      url,
      title: 'Coraline',
      content: 'Completed Coraline page evidence',
      provider: 'fetch',
    };
  });
  const { prepareWriterContext } = writer((q, s, findings, e, config, signal) =>
    buildFilteredContext(
      q,
      s,
      findings,
      e,
      {
        ...config,
        onProgress: (checkpoint) => {
          config.onProgress(checkpoint);
          if (checkpoint.stage === 'scraped') saved();
        },
      },
      signal,
    ),
  );
  const pending = prepareWriterContext(
    [
      relevant,
      evidence('https://stalled.example/coraline', 'Coraline stalled snippet'),
    ],
    'Coraline facts',
    undefined,
    embedding,
    'speed',
  );
  await completed;
  t.mock.timers.tick(15_000);
  const output = await pending;
  assert.match(
    output.find((chunk) => chunk.metadata.url === relevant.metadata.url)
      .content,
    /Completed Coraline page evidence/,
  );
  assert.equal(output[0].metadata.contextMode, 'partial');
  assert.equal(stalledCancelled, true);
});

test('Jev ordering remains marked as used when its saved evidence survives a later failure', async () => {
  const { prepareWriterContext } = writer(
    async (_q, _s, findings, _e, config) => {
      config.onJevResult({
        status: 'applied',
        candidateCount: 2,
        durationMs: 100,
      });
      config.onProgress({
        chunks: [findings[1]],
        contextMode: 'snippets',
        jevUsed: true,
        stage: 'reranked',
      });
      throw new Error('later extraction failure');
    },
  );
  const second = evidence(
    'https://second.example/coraline',
    'Coraline ranked second candidate',
  );
  const output = await prepareWriterContext(
    [relevant, second],
    'Coraline',
    undefined,
    embedding,
    'balanced',
  );
  assert.equal(output[0].metadata.url, second.metadata.url);
  assert.equal(output[0].metadata.jev.used, true);
  assert.equal(output[0].metadata.contextRecovery, 'reranked');
});

test('passage embedding budget retains relevant text near the end of long pages', async () => {
  const { selectRelevantChunks } = pipeline(async () => {});
  const embedded = [];
  const output = await selectRelevantChunks(
    'Coraline puppet design',
    undefined,
    [
      {
        url: relevant.metadata.url,
        title: 'Coraline',
        provider: 'fetch',
        cached: false,
        content:
          Array.from({ length: 80 }, (_, i) =>
            `Navigation item ${i}. `.repeat(20),
          ).join('\n\n') +
          '\n\nCoraline puppet design uses handmade faces and armatures.',
      },
    ],
    {
      embedText: async (texts) => {
        embedded.push(...texts);
        return texts.map((text) =>
          text.includes('handmade faces') ? [1, 0] : [0, 1],
        );
      },
    },
    { topKChunks: 3, chunkMaxTokens: 64, chunkOverlapTokens: 0 },
    [1, 0],
  );
  assert.ok(embedded.length <= 6);
  assert.ok(embedded.some((text) => text.includes('handmade faces')));
  assert.ok(output.some((chunk) => chunk.content.includes('handmade faces')));
});

test('redirected page evidence has one final citation without repeating its original snippet', async () => {
  const { buildFilteredContext } = pipeline(async () => ({
    url: 'https://laika.example/new-coraline',
    title: 'Coraline',
    content: 'Coraline final redirected page text',
    provider: 'fetch',
  }));
  const output = await buildFilteredContext(
    'Coraline',
    undefined,
    [relevant],
    embedding,
  );
  assert.equal(output.length, 1);
  assert.equal(output[0].metadata.url, 'https://laika.example/new-coraline');
});
