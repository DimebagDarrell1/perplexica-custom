import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/loadTs.mjs';
const { default: Session } = loadTs('src/lib/session.ts');

function routeWith(run) {
  let session;
  const { POST } = loadTs('src/app/api/search/route.ts', {
    '@/lib/models/registry': {
      __esModule: true,
      default: class {
        async loadChatModel() {
          return {};
        }
        async loadEmbeddingModel() {
          return {};
        }
      },
    },
    '@/lib/session': {
      __esModule: true,
      default: { createSession: () => (session = new Session()) },
    },
    '@/lib/agents/search/api': {
      __esModule: true,
      default: class {
        searchAsync(value) {
          run(value);
        }
      },
    },
  });
  const request = (stream, signal) =>
    new Request('http://localhost/api/search', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: ['web'],
        query: 'fixture',
        chatModel: { providerId: 'fixture', key: 'chat' },
        embeddingModel: { providerId: 'fixture', key: 'embedding' },
        stream,
      }),
    });
  return { POST, request, session: () => session };
}

for (const stream of [false, true]) {
  test(`API search ${stream ? 'streaming' : 'JSON'} completion removes listeners`, async () => {
    const route = routeWith((session) => {
      session.emit('data', { type: 'response', data: 'Saved answer' });
      session.emit('end', {});
    });
    const response = await route.POST(route.request(stream));
    assert.equal(response.status, 200);
    if (stream) {
      assert.match(response.headers.get('content-type'), /ndjson/);
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.deepEqual(
        events.map((e) => e.type),
        ['init', 'response', 'done'],
      );
    } else assert.equal((await response.json()).message, 'Saved answer');
    assert.equal(route.session().emitter.listenerCount('data'), 0);
  });
}

test('API stream cancellation aborts research and removes listeners', async () => {
  const route = routeWith(() => {});
  const response = await route.POST(route.request(true));
  await response.body.cancel();
  assert.equal(route.session().signal.aborted, true);
  assert.equal(route.session().emitter.listenerCount('data'), 0);
});

test('API JSON request abort resolves and provider errors return HTTP 500', async () => {
  const controller = new AbortController();
  const route = routeWith(() => {});
  const pending = route.POST(route.request(false, controller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).status, 499);
  assert.equal(route.session().signal.aborted, true);
  assert.equal(route.session().emitter.listenerCount('data'), 0);
  const failed = routeWith((session) =>
    session.emit('error', { data: 'provider unavailable' }),
  );
  assert.equal((await failed.POST(failed.request(false))).status, 500);
  assert.equal(failed.session().emitter.listenerCount('error'), 0);
});

test('API agent shares the cancellable session with research and context', async () => {
  const session = new Session();
  let receivedSignal;
  let contextSignal;
  const { default: Agent } = loadTs('src/lib/agents/search/api.ts', {
    './classifier': {
      classify: async () => ({ classification: { skipSearch: false } }),
    },
    './researcher': {
      __esModule: true,
      default: class {
        async research(value) {
          assert.equal(value, session);
          return {};
        }
      },
    },
    './widgets': {
      WidgetExecutor: {
        executeAll: async ({ signal }) => {
          assert.equal(signal, session.signal);
          return [];
        },
      },
    },
    './writerContext': {
      prepareWriterContext: async (...args) => {
        contextSignal = args[5];
        return [];
      },
      formatWriterContext: () => '',
      truncateChatHistory: (h) => h,
      buildWriterUserMessage: (q) => q,
    },
    '@/lib/prompts/search/writer': { getWriterPrompt: () => '' },
  });
  const result = new Agent().searchAsync(session, {
    chatHistory: [],
    followUp: 'fixture',
    config: {
      fileIds: [],
      sources: [],
      mode: 'speed',
      embedding: {},
      llm: {
        async *streamText({ signal }) {
          receivedSignal = signal;
          yield { contentChunk: 'partial' };
          await new Promise(() => {});
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  session.cancel();
  await result;
  assert.equal(receivedSignal, session.signal);
  assert.equal(contextSignal, session.signal);
});
