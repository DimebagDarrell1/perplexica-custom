import assert from 'node:assert/strict';
import test from 'node:test';
import { checkFirecrawlHealth } from '../../src/lib/firecrawl.ts';
import { loadTs } from '../helpers/loadTs.mjs';

const { checkSearxngHealth } = loadTs('src/lib/searxng.ts', {
  './config/serverRegistry': { getSearxngURL: () => 'http://search.test' },
});

for (const service of ['firecrawl', 'searxng']) {
  test(`${service} health rejects errors, HTML, redirects, and malformed JSON`, async (t) => {
    const previous = { ...process.env };
    process.env.FIRECRAWL_ENABLED = 'true';
    process.env.FIRECRAWL_API_URL = 'http://firecrawl.test/';
    const check =
      service === 'firecrawl' ? checkFirecrawlHealth : checkSearxngHealth;
    let reply;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      if (service === 'firecrawl') {
        assert.equal(url, 'http://firecrawl.test/v0/health/liveness');
      } else {
        assert.equal(new URL(url).pathname, '/search');
        assert.equal(new URL(url).searchParams.get('format'), 'json');
      }
      if (reply instanceof Error) throw reply;
      return reply;
    });
    try {
      for (const status of [401, 404, 429, 500]) {
        reply = new Response('unavailable', { status });
        const health = await check();
        assert.equal(health.reachable, false);
        assert.equal(health.status, status);
      }
      for (const invalid of [null, {}, { results: 'wrong', status: 'error' }]) {
        reply = Response.json(invalid);
        assert.equal((await check()).reachable, false);
      }
      reply = new Response('<html>Login</html>');
      assert.equal((await check()).reachable, false);
      reply = new TypeError('redirect rejected');
      assert.equal((await check()).reachable, false);
      reply = Response.json(
        service === 'firecrawl' ? { status: 'ok' } : { results: [] },
      );
      assert.equal((await check()).reachable, true);
    } finally {
      for (const key of ['FIRECRAWL_ENABLED', 'FIRECRAWL_API_URL']) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });
}
