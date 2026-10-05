import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../helpers/loadTs.mjs';
import { getFirecrawlConfig } from '../../src/lib/firecrawl.ts';

const ranked = (...urls) =>
  urls.map((url, index) => ({
    chunk: { content: `snippet ${index}`, metadata: { url, title: url } },
    score: 1 - index / 10,
  }));

const contextFilter = (scrape) =>
  loadTs('src/lib/agents/search/contextFilter.ts', {
    '@/lib/config': {
      __esModule: true,
      default: { getConfig: (_key, fallback) => fallback },
    },
    '@/lib/scraper': { __esModule: true, default: { scrape } },
  });

const page = (url) => ({
  url,
  title: url,
  content: `content for ${url}`,
  provider: 'fetch',
});

test('a slow page does not hold back the next read, and order stays ranked', async () => {
  const started = {};
  let t0 = 0;
  const { scrapeRelevantUrls } = contextFilter(async (url) => {
    started[url] = Date.now() - t0;
    if (url.endsWith('/slow')) await new Promise((r) => setTimeout(r, 300));
    return page(url);
  });

  t0 = Date.now();
  const pages = await scrapeRelevantUrls(
    ranked('https://a.test/slow', 'https://b.test/fast', 'https://c.test/fast'),
    50_000,
    false,
    undefined,
    undefined,
    { concurrency: 2, pageTimeoutMs: 5_000 },
  );

  assert.deepEqual(
    pages.map((p) => p.sourceUrl),
    ['https://a.test/slow', 'https://b.test/fast', 'https://c.test/fast'],
  );
  // With fixed batches, c.test would wait for the slow page to finish.
  assert.ok(started['https://c.test/fast'] < 150, JSON.stringify(started));
});

test('a stalled page is dropped at its own deadline without cancelling the others', async () => {
  const seenSignals = [];
  const { scrapeRelevantUrls } = contextFilter(async (url, options) => {
    seenSignals.push(options.signal);
    if (url.includes('stall')) return new Promise(() => {});
    return page(url);
  });

  const t0 = Date.now();
  const pages = await scrapeRelevantUrls(
    ranked('https://stall.test/', 'https://ok.test/'),
    50_000,
    false,
    undefined,
    undefined,
    { concurrency: 2, pageTimeoutMs: 100 },
  );

  assert.deepEqual(
    pages.map((p) => p.sourceUrl),
    ['https://ok.test/'],
  );
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(seenSignals[0].aborted, true);
});

test('cancelling the search still stops page reading', async () => {
  const controller = new AbortController();
  const { scrapeRelevantUrls } = contextFilter(
    async () => new Promise(() => {}),
  );
  const pending = scrapeRelevantUrls(
    ranked('https://a.test/', 'https://b.test/'),
    50_000,
    false,
    controller.signal,
    undefined,
    { concurrency: 2, pageTimeoutMs: 10_000 },
  );
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('saved Firecrawl settings take precedence over environment variables', () => {
  const previous = {
    enabled: process.env.FIRECRAWL_ENABLED,
    url: process.env.FIRECRAWL_API_URL,
    key: process.env.FIRECRAWL_API_KEY,
  };
  process.env.FIRECRAWL_ENABLED = 'true';
  process.env.FIRECRAWL_API_URL = 'http://env-firecrawl.test:3002/';
  process.env.FIRECRAWL_API_KEY = 'env-key';
  try {
    const fromEnv = getFirecrawlConfig({});
    assert.equal(fromEnv.enabled, true);
    assert.equal(fromEnv.apiUrl, 'http://env-firecrawl.test:3002');
    assert.equal(fromEnv.apiKey, 'env-key');

    const saved = getFirecrawlConfig({
      firecrawlEnabled: true,
      firecrawlApiUrl: 'https://saved-firecrawl.test',
      firecrawlApiKey: 'saved-key',
    });
    assert.equal(saved.apiUrl, 'https://saved-firecrawl.test');
    assert.equal(saved.apiKey, 'saved-key');

    assert.equal(
      getFirecrawlConfig({ firecrawlEnabled: false }).enabled,
      false,
    );

    const invalid = getFirecrawlConfig({
      firecrawlEnabled: true,
      firecrawlApiUrl: 'ftp://firecrawl.test',
    });
    assert.equal(invalid.enabled, false);
    assert.equal(invalid.apiUrl, '');
  } finally {
    for (const [key, value] of [
      ['FIRECRAWL_ENABLED', previous.enabled],
      ['FIRECRAWL_API_URL', previous.url],
      ['FIRECRAWL_API_KEY', previous.key],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('discussion search queries Reddit through general engines and keeps only Reddit pages', async () => {
  const calls = [];
  const { default: socialSearch } = loadTs(
    'src/lib/agents/search/researcher/actions/socialSearch.ts',
    {
      '@/lib/searxng': {
        searchSearxng: async (query, options) => {
          calls.push({ query, options });
          return {
            results: [
              { title: 'Thread', url: 'https://www.reddit.com/r/movies/1' },
              { title: 'Elsewhere', url: 'https://example.com/coraline' },
              { title: 'Old', url: 'https://old.reddit.com/r/movies/2' },
              { title: 'Lookalike', url: 'https://notreddit.com/r/x' },
            ],
          };
        },
      },
    },
  );
  const session = {
    signal: new AbortController().signal,
    getBlock: () => undefined,
    updateBlock: () => {},
  };
  const output = await socialSearch.execute(
    { queries: ['coraline meaning'] },
    { session, mode: 'balanced', researchBlockId: 'research' },
  );

  assert.equal(calls[0].query, 'site:reddit.com coraline meaning');
  assert.equal(calls[0].options.engines, undefined);
  assert.deepEqual(
    output.results.map((r) => r.metadata.url),
    ['https://www.reddit.com/r/movies/1', 'https://old.reddit.com/r/movies/2'],
  );
});
