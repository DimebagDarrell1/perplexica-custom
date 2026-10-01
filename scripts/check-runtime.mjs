import assert from 'node:assert/strict';

// Run against a disposable instance with a fresh data directory and no credentials.
const base = process.argv[2];
assert.ok(
  base,
  'Usage: node scripts/check-runtime.mjs http://127.0.0.1:3000 [--bundled-search]',
);
const origin = new URL(base);
assert.ok(
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname),
  'Runtime checks require a local disposable instance',
);

async function request(path) {
  return fetch(new URL(path, origin), {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
}

const deadline = Date.now() + 90_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await request('/api/chats');
    if (response.ok) {
      assert.deepEqual((await response.json()).chats, []);
      ready = true;
      break;
    }
    await response.body?.cancel();
  } catch {
    // Startup may still be applying migrations or loading the server.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.ok(
  ready,
  'App did not start with a readable, empty chats database within 90 seconds',
);

const page = await request('/');
assert.equal(page.status, 200, 'Home page must render');
const html = await page.text();
const assets = [
  ...new Set(
    [...html.matchAll(/(?:src|href)="([^"<>]*\/_next\/static\/[^"<>]+)"/g)].map(
      (match) => match[1],
    ),
  ),
];
assert.ok(
  assets.some((asset) => asset.endsWith('.js')),
  'Home page must reference JavaScript',
);
assert.ok(
  assets.some((asset) => asset.endsWith('.css')),
  'Home page must reference styles',
);
for (const asset of assets) {
  const url = new URL(asset, origin);
  assert.equal(url.origin, origin.origin);
  const response = await request(url.pathname + url.search);
  assert.equal(response.status, 200, `Missing packaged asset: ${url.pathname}`);
  assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
  await response.body?.cancel();
}

const response = await request('/api/health/research');
const health = await response.json();
assert.ok(['healthy', 'degraded', 'unhealthy'].includes(health.status));
assert.equal(response.status, health.status === 'unhealthy' ? 503 : 200);
assert.equal(health.services.jev.enabled, false);
assert.equal(health.services.jev.networkChecked, false);
assert.equal(health.services.firecrawl.enabled, false);
assert.equal(health.services.nativeExtraction.enabled, true);

if (process.argv.includes('--bundled-search')) {
  const response = await fetch('http://127.0.0.1:8080/config', {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  assert.equal(response.status, 200, 'Bundled SearXNG must start');
  const config = await response.json();
  assert.ok(Array.isArray(config.engines) && config.engines.length > 0);
  const search = await fetch(
    'http://127.0.0.1:8080/search?format=json&q=perplexica-smoke&engines=wikipedia',
    { signal: AbortSignal.timeout(15_000), redirect: 'error' },
  );
  assert.equal(search.status, 200, 'Bundled SearXNG must allow JSON searches');
  assert.ok(Array.isArray((await search.json()).results));
}
console.log(
  JSON.stringify({
    runtime: 'passed',
    assets: assets.length,
    database: 'readable-empty',
    researchHealth: health.status,
    bundledSearch: process.argv.includes('--bundled-search'),
  }),
);
