import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../helpers/loadTs.mjs';
const { getJevConfig } = loadTs('src/lib/jev.ts');
const { redactConfigSecrets } = loadTs('src/lib/config/security.ts');
const fields = [
  { key: 'jevEnabled', type: 'switch', scope: 'server' },
  {
    key: 'jevProvider',
    type: 'select',
    scope: 'server',
    options: [{ value: 'openrouter' }, { value: 'typesafe' }],
  },
  { key: 'jevApiKey', type: 'password', scope: 'server' },
];
const sections = {
  search: fields,
  preferences: [],
  personalization: [],
  modelProviders: [],
};

test('saved Jev settings use a dedicated key, override defaults and redact secrets', () => {
  const saved = {
    jevEnabled: false,
    jevProvider: 'openrouter',
    jevApiKey: 'fixture-key',
  };
  const previousEnabled = process.env.JEV_ENABLED;
  process.env.JEV_ENABLED = 'true';
  let config;
  try {
    config = getJevConfig(saved);
  } finally {
    if (previousEnabled === undefined) delete process.env.JEV_ENABLED;
    else process.env.JEV_ENABLED = previousEnabled;
  }
  assert.equal(config.enabled, false);
  assert.equal(config.configured, true);
  assert.equal(config.endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(config.apiKey, saved.jevApiKey);
  const safe = redactConfigSecrets(
    { search: saved, preferences: {}, personalization: {}, modelProviders: [] },
    sections,
  );
  assert.equal(safe.search.jevApiKey, '********');
  assert.doesNotMatch(JSON.stringify(safe), /fixture-key/);
  assert.equal(saved.jevApiKey, 'fixture-key');
});

test('Jev settings reject invalid values, preserve masked keys and allow explicit removal', async () => {
  const writes = [];
  const { POST } = loadTs('src/app/api/config/route.ts', {
    '@/lib/config': {
      __esModule: true,
      default: {
        getUIConfigSections: () => sections,
        updateConfig: (...args) => writes.push(args),
      },
    },
    '@/lib/models/registry': { __esModule: true, default: class {} },
    'next/server': {},
  });
  const save = (key, value) =>
    POST(
      new Request('http://localhost/api/config', {
        method: 'POST',
        body: JSON.stringify({ key, value }),
      }),
    );
  assert.equal((await save('search.jevEnabled', 'false')).status, 400);
  assert.equal((await save('search.jevProvider', 'unsupported')).status, 400);
  assert.equal((await save('search.jevApiKey', {})).status, 400);
  assert.equal((await save('search.jevApiKey', '********')).status, 200);
  assert.equal(writes.length, 0);
  assert.equal((await save('search.jevEnabled', true)).status, 200);
  assert.equal((await save('search.jevApiKey', '')).status, 200);
  assert.deepEqual(writes, [
    ['search.jevEnabled', true],
    ['search.jevApiKey', ''],
  ]);
});

test('Jev status is read-only, contains no key and respects the admin guard', async () => {
  const mock = {
    '@/lib/config': {
      __esModule: true,
      default: {
        getConfig: () => ({
          jevEnabled: true,
          jevProvider: 'openrouter',
          jevApiKey: 'fixture-key',
        }),
      },
    },
  };
  const { GET } = loadTs('src/app/api/jev/route.ts', mock);
  const response = await GET(new Request('http://localhost/api/jev'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.networkChecked, false);
  assert.doesNotMatch(JSON.stringify(status), /fixture-key|apiKey/);
  const guarded = loadTs('src/app/api/jev/route.ts', {
    ...mock,
    '@/lib/config/security': {
      requireAdminToken: () => new Response(null, { status: 401 }),
    },
  });
  assert.equal(
    (await guarded.GET(new Request('http://localhost/api/jev'))).status,
    401,
  );
});

test('the per-search opt-out reaches the context pipeline and saved source labels', async () => {
  let received;
  const { prepareWriterContext } = loadTs(
    'src/lib/agents/search/writerContext.ts',
    {
      './contextFilter': {
        buildFilteredContext: async (_q, _s, chunks, _e, config) => {
          received = config.useJev;
          return chunks;
        },
      },
      '@/lib/uploads/store': {},
    },
  );
  const chunks = [
    {
      content: 'Evidence',
      metadata: { url: 'https://example.com', title: 'Evidence' },
    },
  ];
  const output = await prepareWriterContext(
    chunks,
    'question',
    undefined,
    {},
    'balanced',
    undefined,
    false,
    false,
  );
  assert.equal(received, false);
  assert.equal(output[0].metadata.jev.status, 'off');
  assert.equal(output[0].metadata.jev.used, false);
});

for (const failed of [false, true]) {
  test(`saved sources report Jev ${failed ? 'discarded on context fallback' : 'applied'} truthfully`, async () => {
    const { prepareWriterContext } = loadTs(
      'src/lib/agents/search/writerContext.ts',
      {
        './contextFilter': {
          buildFilteredContext: async (_q, _s, chunks, _e, config) => {
            config.onJevResult({
              status: 'applied',
              candidateCount: 2,
              durationMs: 120,
              results: [],
            });
            if (failed) throw new Error('fixture context timeout');
            return chunks;
          },
        },
        '@/lib/uploads/store': {},
      },
    );
    const output = await prepareWriterContext(
      [{ content: 'Evidence', metadata: { url: 'https://example.com' } }],
      'question',
      undefined,
      {},
      'balanced',
    );
    assert.equal(output[0].metadata.jev.status, 'applied');
    assert.equal(output[0].metadata.jev.used, !failed);
    assert.equal(
      output[0].metadata.contextMode,
      failed ? 'snippets' : 'filtered',
    );
  });
}
