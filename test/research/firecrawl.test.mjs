import assert from 'node:assert/strict';
import test from 'node:test';
import { scrapeWithFirecrawl } from '../../src/lib/firecrawl.ts';

test('Firecrawl requests main-content markdown and caches successful results', async () => {
  const previousEnv = {
    enabled: process.env.FIRECRAWL_ENABLED,
    url: process.env.FIRECRAWL_API_URL,
    key: process.env.FIRECRAWL_API_KEY,
  };
  const previousFetch = globalThis.fetch;
  let calls = 0;
  let requestBody;

  process.env.FIRECRAWL_ENABLED = 'true';
  process.env.FIRECRAWL_API_URL = 'http://firecrawl.test:3002';
  process.env.FIRECRAWL_API_KEY = 'test-key';

  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'http://firecrawl.test:3002/v2/scrape');
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    requestBody = JSON.parse(init.body);

    return Response.json({
      success: true,
      data: {
        markdown: '# Useful article\n\nEvidence',
        metadata: {
          title: 'Useful article',
          sourceURL: 'https://example.com/article',
        },
      },
    });
  };

  try {
    const first = await scrapeWithFirecrawl(
      'https://example.com/firecrawl-cache-test',
    );
    const second = await scrapeWithFirecrawl(
      'https://example.com/firecrawl-cache-test',
    );

    assert.equal(first.provider, 'firecrawl');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.deepEqual(requestBody.formats, ['markdown']);
    assert.equal(requestBody.onlyMainContent, true);
    assert.deepEqual(requestBody.parsers, ['pdf']);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of [
      ['FIRECRAWL_ENABLED', previousEnv.enabled],
      ['FIRECRAWL_API_URL', previousEnv.url],
      ['FIRECRAWL_API_KEY', previousEnv.key],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Firecrawl bounds responses and cached content and respects pre-aborted requests', async (t) => {
  const previous = { ...process.env };
  process.env.FIRECRAWL_ENABLED = 'true';
  process.env.FIRECRAWL_API_URL = 'http://firecrawl.test:3002';
  let calls = 0;
  let response;
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    return response;
  });
  try {
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      scrapeWithFirecrawl('https://example.com/aborted', aborted.signal),
      { name: 'AbortError' },
    );
    assert.equal(calls, 0);
    response = Response.json({
      success: true,
      data: { markdown: 'x'.repeat(100_000) },
    });
    const result = await scrapeWithFirecrawl(
      'https://example.com/bounded-content',
    );
    assert.equal(result.content.length, 50_000);
    await assert.rejects(
      scrapeWithFirecrawl(
        'https://example.com/bounded-content',
        aborted.signal,
      ),
      { name: 'AbortError' },
    );
    assert.equal(calls, 1);
    response = new Response('x', { headers: { 'Content-Length': '2000001' } });
    await assert.rejects(
      scrapeWithFirecrawl('https://example.com/oversize-header'),
      /size limit/,
    );
    let cancelled = false;
    response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(2_000_001));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await assert.rejects(
      scrapeWithFirecrawl('https://example.com/oversize-stream'),
      /size limit/,
    );
    assert.equal(cancelled, true);
    response = Response.json(null);
    await assert.rejects(
      scrapeWithFirecrawl('https://example.com/null'),
      /no markdown/,
    );
  } finally {
    for (const key of ['FIRECRAWL_ENABLED', 'FIRECRAWL_API_URL']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
