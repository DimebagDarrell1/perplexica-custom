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
