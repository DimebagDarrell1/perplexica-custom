import test from 'node:test';
import assert from 'node:assert/strict';
import { getEncoding } from 'js-tiktoken';
import { loadTs } from '../helpers/loadTs.mjs';
const { rerankWithJev, getJevConfig, getJevStatus, buildJevRequest } =
  loadTs('src/lib/jev.ts');
const keys = [
  'JEV_ENABLED',
  'JEV_PROVIDER',
  'JEV_API_KEY',
  'JEV_MODEL',
  'JEV_MAX_CANDIDATES',
  'JEV_TIMEOUT_MS',
];
const result = (id, content = `Snippet ${id}`) => ({
  chunk: {
    content,
    metadata: {
      title: `Title ${id}`,
      sourceType: 'web',
      url: `https://example.com/${id}`,
      searchQueries: ['original query'],
      privateField: 'never-send-this',
    },
  },
  score: 1 / (id + 1),
});
const results = [result(0), result(1), result(2)];
const answer = (scores, extra = {}) =>
  Response.json({
    model: 'jev-1.13.0',
    answers: Object.fromEntries(
      scores.map((score, index) => [
        `candidate_${index}`,
        { type: 'noul', noul: score },
      ]),
    ),
    usage: { input_tokens: 100, output_tokens: 3 },
    ...extra,
  });
async function withConfig(config, fetchMock, run) {
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  const originalFetch = global.fetch;
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    JEV_ENABLED: 'true',
    JEV_API_KEY: 'test-only-secret',
    ...config,
  });
  global.fetch = fetchMock;
  try {
    return await run();
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const noFetch = () => {
  throw new Error('Unexpected network request');
};

test('an OpenRouter key without a saved provider uses OpenRouter, including automatic selection', async () => {
  await withConfig(
    { JEV_API_KEY: 'sk-or-fixture' },
    async (url) => {
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
      return answer([0.1, 0.9, 0.4]);
    },
    async () => {
      for (const saved of [{}, { jevProvider: 'auto' }]) {
        const config = getJevConfig(saved);
        assert.equal(config.provider, 'openrouter');
        assert.equal(config.configured, true);
        assert.equal(
          (await rerankWithJev('query', results, undefined, config)).status,
          'applied',
        );
      }
    },
  );
});

test('an explicit TypeSafe/OpenRouter key mismatch never sends the credential', async () => {
  await withConfig(
    { JEV_API_KEY: 'sk-or-fixture', JEV_PROVIDER: 'typesafe' },
    noFetch,
    async () => {
      assert.equal(getJevStatus().state, 'misconfigured');
      assert.equal(getJevStatus().configurationError, 'provider_key_mismatch');
      const output = await rerankWithJev('query', results);
      assert.equal(output.reason, 'provider_key_mismatch');
      assert.equal(output.results, results);
      assert.doesNotMatch(JSON.stringify(getJevStatus()), /sk-or-fixture/);
    },
  );
});

test('disabled, missing credentials and unsupported providers never call the API', async () => {
  for (const config of [
    { JEV_ENABLED: 'false' },
    { JEV_API_KEY: '' },
    { JEV_PROVIDER: 'unknown' },
  ]) {
    await withConfig(config, noFetch, async () => {
      const output = await rerankWithJev('query', results);
      assert.notEqual(output.status, 'applied');
      assert.equal(output.results, results);
    });
  }
});

test('TypeSafe and OpenRouter use their native Decisions contracts and dedicated credentials', async () => {
  for (const [provider, endpoint, model] of [
    ['typesafe', 'https://api.typesafe.ai/v1/systemone', 'jev-1.13.0'],
    [
      'openrouter',
      'https://openrouter.ai/api/alpha/decisions',
      'typesafe/jev-1.13',
    ],
  ]) {
    let calls = 0;
    await withConfig(
      { JEV_PROVIDER: provider },
      async (url, options) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(options.headers.Authorization, 'Bearer test-only-secret');
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        const body = JSON.parse(options.body);
        assert.equal(body.model, model);
        assert.equal(body.state.query, 'query');
        assert.equal(body.questions.candidate_0.type, 'noul');
        assert.ok(body.questions.candidate_0.criteria.true);
        assert.doesNotMatch(
          options.body,
          /never-send-this|https:\/\/example|original query/,
        );
        return answer([0.1, 0.9, 0.4]);
      },
      async () => {
        const output = await rerankWithJev('query', results);
        assert.equal(output.status, 'applied');
        assert.deepEqual(output.results, [results[1], results[2], results[0]]);
        assert.equal(output.results[0], results[1]);
        assert.equal(output.usage.input_tokens, 100);
        assert.equal(calls, 1);
      },
    );
  }
});

test('candidate IDs, not object response order, determine the reordered results; ties stay stable', async () => {
  await withConfig(
    {},
    async () =>
      answer([], {
        answers: {
          candidate_2: { type: 'noul', noul: 0.2 },
          candidate_1: { type: 'noul', noul: 0.8 },
          candidate_0: { type: 'noul', noul: 0.8 },
        },
      }),
    async () => {
      assert.deepEqual(
        (await rerankWithJev('query', results)).results,
        results,
      );
    },
  );
});

test('candidate and token limits bound payloads while unscored results retain their positions', async () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    result(i, '漢字 '.repeat(2000)),
  );
  await withConfig(
    { JEV_MAX_CANDIDATES: '100000', JEV_TIMEOUT_MS: '999999' },
    async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(Object.keys(body.questions).length, 32);
      const enc = getEncoding('cl100k_base');
      assert.ok(enc.encode(body.state.query).length <= 257);
      assert.ok(
        enc.encode(body.state.candidates.candidate_0.snippet).length <= 385,
      );
      assert.ok(Buffer.byteLength(options.body) < 128 * 1024);
      return answer(Array.from({ length: 32 }, (_, i) => i / 32));
    },
    async () => {
      assert.equal(getJevConfig().timeoutMs, 5000);
      const output = await rerankWithJev('question '.repeat(1000), many);
      assert.equal(output.status, 'applied');
      assert.equal(output.results[0], many[31]);
      assert.deepEqual(output.results.slice(32), many.slice(32));
    },
  );
});

test('uploaded content, file metadata and unsupported URL schemes never reach Jev', async () => {
  for (const chunk of [
    {
      content: 'secret',
      metadata: { url: 'file_id://private', title: 'Private' },
    },
    {
      content: 'secret',
      metadata: {
        fileId: 'private',
        url: 'https://example.com/private',
        title: 'Private',
      },
    },
  ]) {
    await withConfig({}, noFetch, async () => {
      const mixed = [...results, { chunk, score: 1 }];
      const output = await rerankWithJev('private query', mixed);
      assert.equal(output.status, 'skipped');
      assert.equal(output.reason, 'uploaded_files');
      assert.equal(output.results, mixed);
    });
  }
  await withConfig({}, noFetch, async () => {
    const invalid = [
      {
        chunk: { content: 'secret', metadata: { url: 'javascript:alert(1)' } },
        score: 1,
      },
      results[0],
    ];
    assert.equal((await rerankWithJev('query', invalid)).status, 'skipped');
  });
});

test('incomplete, unexpected, out-of-range and wrong-type answers preserve the entire original ranking', async () => {
  for (const answers of [
    { candidate_0: { type: 'noul', noul: 0.2 } },
    {
      candidate_0: { type: 'noul', noul: 0.2 },
      wrong_id: { type: 'noul', noul: 0.9 },
      candidate_2: { type: 'noul', noul: 0.8 },
    },
    {
      candidate_0: { type: 'noul', noul: 2 },
      candidate_1: { type: 'noul', noul: 0.2 },
      candidate_2: { type: 'noul', noul: 0.8 },
    },
    {
      candidate_0: { type: 'noul', noul: '0.2' },
      candidate_1: { type: 'noul', noul: 0.2 },
      candidate_2: { type: 'noul', noul: 0.8 },
    },
    {
      candidate_0: { type: 'choice', noul: 0.2 },
      candidate_1: { type: 'noul', noul: 0.2 },
      candidate_2: { type: 'noul', noul: 0.8 },
    },
  ]) {
    await withConfig(
      {},
      async () => answer([], { answers }),
      async () => {
        const output = await rerankWithJev('query', results);
        assert.equal(output.status, 'fallback');
        assert.equal(output.results, results);
      },
    );
  }
});

test('HTTP failures and malformed JSON fall back without retries or secret-bearing errors', async () => {
  for (const response of [
    new Response('test-only-secret', { status: 429 }),
    new Response('test-only-secret', { status: 401 }),
    new Response('not-json'),
  ]) {
    let calls = 0;
    await withConfig(
      {},
      async () => {
        calls++;
        return response;
      },
      async () => {
        const output = await rerankWithJev('query', results);
        assert.equal(output.status, 'fallback');
        assert.equal(output.results, results);
        assert.doesNotMatch(JSON.stringify(output), /test-only-secret/);
        assert.equal(calls, 1);
      },
    );
  }
});

test('oversized provider output is bounded and its stream is cancelled', async () => {
  let cancelled = false;
  await withConfig(
    {},
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(70 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    async () => {
      const output = await rerankWithJev('query', results);
      assert.equal(output.reason, 'response_too_large');
      assert.equal(output.results, results);
      assert.equal(cancelled, true);
    },
  );
});

test('timeout falls back and aborts the request, including a stalled response body', async () => {
  for (const bodyStalled of [false, true]) {
    let upstreamSignal;
    await withConfig(
      { JEV_TIMEOUT_MS: '100' },
      async (_url, options) => {
        upstreamSignal = options.signal;
        if (bodyStalled)
          return new Response(new ReadableStream({ start() {} }));
        return new Promise(() => {});
      },
      async () => {
        const output = await rerankWithJev('query', results);
        assert.equal(output.status, 'fallback');
        assert.equal(output.results, results);
        assert.equal(upstreamSignal.aborted, true);
        assert.ok(output.durationMs < 1500);
      },
    );
  }
});

test('user cancellation propagates instead of being mistaken for a fallback', async () => {
  const controller = new AbortController();
  await withConfig(
    {},
    async () => {
      controller.abort();
      return new Promise(() => {});
    },
    async () => {
      await assert.rejects(rerankWithJev('query', results, controller.signal), {
        name: 'AbortError',
      });
    },
  );
  await withConfig({}, noFetch, async () => {
    await assert.rejects(rerankWithJev('query', results, controller.signal), {
      name: 'AbortError',
    });
  });
});

test('health status shows configuration without exposing secrets or claiming live reachability', async () => {
  await withConfig({}, noFetch, async () => {
    const status = getJevStatus();
    assert.equal(status.state, 'ready-unverified');
    assert.equal(status.networkChecked, false);
    assert.equal(status.configured, true);
    assert.doesNotMatch(JSON.stringify(status), /test-only-secret|apiKey/);
    const request = buildJevRequest('query', results, 'jev-1.13.0');
    assert.equal(Object.keys(request.questions).length, 3);
  });
});

test('the actual context pipeline reranks before scraping and retains the same citation objects', async () => {
  let scraped;
  let calls = 0;
  await withConfig(
    {},
    async () => {
      calls++;
      return answer([0.1, 0.9]);
    },
    async () => {
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
              scrape: async (url) => {
                scraped = url;
                return {
                  url,
                  title: 'Selected',
                  content: 'Useful extracted text',
                  provider: 'native',
                };
              },
            },
          },
        },
      );
      const embedding = { embedText: async (texts) => texts.map(() => [1, 0]) };
      const output = await buildFilteredContext(
        'query',
        undefined,
        results.slice(0, 2).map((item) => item.chunk),
        embedding,
        { useJev: true, topKUrls: 1 },
      );
      assert.equal(calls, 1);
      assert.equal(scraped, results[1].chunk.metadata.url);
      assert.equal(output[0].metadata.url, scraped);
    },
  );
});

test('speed mode and conversations with attachments opt out; balanced and quality opt in', async () => {
  const configs = [];
  const { prepareWriterContext } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': {
        buildFilteredContext: async (
          _q,
          _followUp,
          chunks,
          _embedding,
          config,
        ) => {
          configs.push(config);
          return chunks;
        },
      },
      '@/lib/uploads/store': {},
    },
  );
  for (const [mode, attachments] of [
    ['speed', false],
    ['balanced', false],
    ['quality', false],
    ['balanced', true],
  ]) {
    await prepareWriterContext(
      [results[0].chunk],
      'query',
      undefined,
      {},
      mode,
      undefined,
      attachments,
    );
  }
  assert.deepEqual(
    configs.map((config) => config.useJev),
    [false, true, true, false],
  );
});

test('local URLs and already-extracted pages are excluded from the outbound shortlist', async () => {
  const excluded = [
    {
      ...result(3),
      chunk: {
        content: 'private local snippet',
        metadata: {
          sourceType: 'web',
          title: 'private',
          url: 'http://127.0.0.1/page',
        },
      },
    },
    {
      ...result(4),
      chunk: {
        content: 'already extracted content',
        metadata: {
          sourceType: 'web',
          extractionProvider: 'firecrawl',
          title: 'page',
          url: 'https://example.com/read',
        },
      },
    },
    {
      ...result(5),
      chunk: {
        content: 'private local hostname',
        metadata: {
          sourceType: 'web',
          title: 'private',
          url: 'http://homeserver/page',
        },
      },
    },
  ];
  await withConfig(
    {},
    async (_url, options) => {
      assert.doesNotMatch(options.body, /private local|already extracted/);
      assert.equal(Object.keys(JSON.parse(options.body).questions).length, 3);
      return answer([0.1, 0.9, 0.4]);
    },
    async () => {
      const mixed = [...results, ...excluded];
      const output = await rerankWithJev('query', mixed);
      assert.equal(output.status, 'applied');
      assert.deepEqual(output.results.slice(3), excluded);
    },
  );
});

test('health route exposes Jev configuration without adding an inference request', async () => {
  await withConfig({}, noFetch, async () => {
    const { GET } = loadTs('src/app/api/health/research/route.ts', {
      '@/lib/config': {
        __esModule: true,
        default: { getConfig: (_key, fallback) => fallback },
      },
      '@/lib/config/security': { requireAdminToken: () => undefined },
      '@/lib/firecrawl': {
        checkFirecrawlHealth: async () => ({ enabled: false }),
        getFirecrawlConfig: () => ({ enabled: false }),
      },
      '@/lib/searxng': {
        checkSearxngHealth: async () => ({ reachable: true }),
      },
    });
    const response = await GET(
      new Request('http://localhost/api/health/research'),
    );
    const body = await response.json();
    assert.equal(body.services.jev.state, 'ready-unverified');
    assert.equal(body.services.jev.networkChecked, false);
    assert.doesNotMatch(JSON.stringify(body), /test-only-secret/);
  });
});
