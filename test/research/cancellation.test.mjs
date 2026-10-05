import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from '../helpers/loadTs.mjs';
const { default: Session } = loadTs('src/lib/session.ts');
const { sessionResponse } = loadTs('src/lib/sessionResponse.ts');
const { readJsonLines } = loadTs('src/lib/utils/readJsonLines.ts');
const { CancellableLLM, CancellableEmbedding } = loadTs(
  'src/lib/models/cancellable.ts',
);

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('reconnect replays current block snapshots and closes a completed stream', async () => {
  const session = new Session();
  session.emitBlock({ id: 'a', type: 'text', data: 'first' });
  session.updateBlock('a', [
    { op: 'replace', path: '/data', value: 'first second' },
  ]);
  session.emit('end', { status: 'completed' });
  const events = [];
  await readJsonLines(
    sessionResponse(session, new AbortController().signal).body,
    (data) => {
      events.push(data);
    },
  );
  assert.equal(events[1].block.data, 'first second');
  assert.equal(events[2].status, 'completed');
  assert.equal(events.length, 3);
  events[1].block.data = 'modified client copy';
  assert.equal(session.getBlock('a').data, 'first second');
  assert.equal(session.emitter.listenerCount('data'), 0);
  session.cancel();
  assert.equal(session.signal.aborted, false);
});

test('disconnect preserves research; explicit Stop aborts and suppresses late blocks', async () => {
  const session = new Session();
  const response = sessionResponse(session, new AbortController().signal);
  await response.body.cancel();
  assert.equal(session.signal.aborted, false);
  session.emitBlock({ id: 'a', type: 'text', data: 'partial' });
  session.cancel();
  session.emitBlock({ id: 'b', type: 'text', data: 'late' });
  session.emit('end', { status: 'cancelled' });
  assert.deepEqual(
    session.getAllBlocks().map((block) => block.data),
    ['partial'],
  );
  assert.equal(session.signal.aborted, true);
});

test('orphaned errors can be replayed without EventEmitter throwing', async () => {
  const session = new Session();
  session.emit('error', { data: 'provider failed' });
  const response = await sessionResponse(
    session,
    new AbortController().signal,
  ).text();
  assert.match(response, /provider failed/);
});

test('JSON lines handle split UTF-8, partial lines and a final line without replay', async () => {
  const bytes = new TextEncoder().encode('{"text":"café"}\n{"n":2}\n{"n":3}');
  const body = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const messages = [];
  await readJsonLines(body, (message) => {
    messages.push(message);
  });
  assert.deepEqual(messages, [{ text: 'café' }, { n: 2 }, { n: 3 }]);
});

test('cancellation interrupts a stalled model and propagates its request signal', async () => {
  const controller = new AbortController();
  let received;
  const model = new CancellableLLM(
    {
      generateText(input) {
        received = input.signal;
        return new Promise(() => {});
      },
    },
    controller.signal,
  );
  const result = model.generateText({ messages: [] });
  await nextTick();
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(received, controller.signal);
});

test('stalled writer stream and local embedding wait both cancel promptly', async () => {
  const controller = new AbortController();
  const llm = new CancellableLLM(
    {
      async *streamText() {
        yield { contentChunk: 'partial', toolCallChunk: [] };
        await new Promise(() => {});
      },
    },
    controller.signal,
  );
  const embedding = new CancellableEmbedding(
    {
      embedText() {
        return new Promise(() => {});
      },
    },
    controller.signal,
  );
  const stream = llm.streamText({ messages: [] });
  assert.equal((await stream.next()).value.contentChunk, 'partial');
  const next = stream.next();
  const vector = embedding.embedText(['example']);
  await nextTick();
  controller.abort();
  await Promise.all([
    assert.rejects(next, { name: 'AbortError' }),
    assert.rejects(vector, { name: 'AbortError' }),
  ]);
});

test('search saves its partial answer as cancelled before sending messageEnd', async () => {
  const saved = [];
  let currentStatus;
  const db = {
    query: { messages: { findFirst: async () => null } },
    insert: () => ({ values: async () => {} }),
    update: () => ({
      set: (value) => ({
        where: () => ({
          execute: async () => {
            saved.push(value);
            currentStatus = value.status;
          },
        }),
      }),
    }),
  };
  const { default: SearchAgent } = loadTs('src/lib/agents/search/index.ts', {
    '@/lib/db': { __esModule: true, default: db },
    '@/lib/db/schema': { messages: {} },
    'drizzle-orm': { eq: () => {}, and: () => {} },
    './classifier': {
      classify: async () => ({ classification: { skipSearch: true } }),
    },
    './researcher': {
      __esModule: true,
      default: class {
        async research() {
          return { searchFindings: [] };
        }
      },
    },
    './widgets': { WidgetExecutor: { executeAll: async () => [] } },
    './writerContext': {
      prepareWriterContext: async () => [],
      formatWriterContext: () => '',
      truncateChatHistory: (h) => h,
      buildWriterUserMessage: (q) => q,
    },
    '@/lib/prompts/search/writer': { getWriterPrompt: () => '' },
  });
  const session = new Session();
  let terminalStatus;
  session.subscribe((event) => {
    if (
      event === 'data' &&
      session.getAllBlocks().some((block) => block.type === 'text')
    )
      queueMicrotask(() => session.cancel());
    if (event === 'end') terminalStatus = currentStatus;
  });
  await new SearchAgent().searchAsync(session, {
    chatId: 'test',
    messageId: 'test',
    followUp: 'test',
    chatHistory: [],
    config: {
      llm: {
        async *streamText() {
          yield { contentChunk: 'partial answer', toolCallChunk: [] };
          await new Promise(() => {});
        },
      },
      embedding: {},
      sources: [],
      fileIds: [],
      mode: 'speed',
    },
  });
  assert.equal(terminalStatus, 'cancelled');
  assert.equal(saved.at(-1).responseBlocks[0].data, 'partial answer');
});

test('OpenAI-compatible streaming accepts whitespace tool arguments and sparse indexes', async () => {
  const { default: OpenAILLM } = loadTs(
    'src/lib/models/providers/openai/openaiLLM.ts',
  );
  const llm = new OpenAILLM({ apiKey: 'test-only', model: 'test' });
  const controller = new AbortController();
  let signal;
  llm.openAIClient = {
    chat: {
      completions: {
        create: async (_body, options) => {
          signal = options.signal;
          return (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 2,
                        id: 't',
                        function: { name: 'done', arguments: '  ' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 2, function: { arguments: '{}' } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
          })();
        },
      },
    },
  };
  const output = [];
  for await (const chunk of llm.streamText({
    messages: [],
    signal: controller.signal,
  }))
    output.push(chunk);
  assert.equal(signal, controller.signal);
  assert.deepEqual(
    output.map((chunk) => chunk.toolCallChunk[0].arguments),
    [{}, {}],
  );
  assert.equal(output[1].toolCallChunk[0].id, 't');
});

test('SearXNG cancellation aborts fetch without serializing the signal into the URL', async () => {
  const { searchSearxng } = loadTs('src/lib/searxng.ts', {
    './config/serverRegistry': { getSearxngURL: () => 'http://search.test' },
  });
  const originalFetch = global.fetch;
  const controller = new AbortController();
  let requestedUrl;
  global.fetch = (url, options) => {
    requestedUrl = url;
    return new Promise((_resolve, reject) =>
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason),
        { once: true },
      ),
    );
  };
  try {
    const request = searchSearxng('test', { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal(requestedUrl.searchParams.has('signal'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a done tool in a batch does not discard the search beside it', async () => {
  let executed;
  const { default: Researcher } = loadTs(
    'src/lib/agents/search/researcher/index.ts',
    {
      './actions': {
        ActionRegistry: {
          getAvailableActionTools: () => [],
          getAvailableActionsDescriptions: () => '',
          execute: async () => ({ type: 'search_results', results: [] }),
          executeAll: async (calls) => {
            executed = calls.map((call) => call.name);
            return [
              {
                type: 'search_results',
                results: [
                  {
                    content: 'evidence',
                    metadata: { title: 'Source', url: 'https://example.com' },
                  },
                ],
              },
              { type: 'done' },
            ];
          },
        },
      },
      '@/lib/prompts/search/researcher': { getResearcherPrompt: () => '' },
    },
  );
  const result = await new Researcher().research(new Session(), {
    followUp: 'question',
    chatHistory: [],
    classification: {},
    config: {
      mode: 'speed',
      sources: ['web'],
      fileIds: [],
      llm: {
        async *streamText() {
          yield {
            contentChunk: '',
            toolCallChunk: [
              { id: 'a', name: 'web_search', arguments: {} },
              { id: 'b', name: 'done', arguments: {} },
            ],
          };
        },
      },
    },
  });
  assert.deepEqual(executed, ['web_search', 'done']);
  assert.equal(result.searchFindings[0].content, 'evidence');
});

test('context timeout propagates through an embedding already scoped to the session', async () => {
  const sessionController = new AbortController();
  const pipelineController = new AbortController();
  let upstreamSignal;
  const provider = {
    embedText(_texts, signal) {
      upstreamSignal = signal;
      return new Promise(() => {});
    },
  };
  const sessionEmbedding = new CancellableEmbedding(
    provider,
    sessionController.signal,
  );
  const pipelineEmbedding = new CancellableEmbedding(
    sessionEmbedding,
    pipelineController.signal,
  );
  const result = pipelineEmbedding.embedText(['test']);
  await nextTick();
  pipelineController.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(sessionController.signal.aborted, false);
});

test('long streamed answers retain one block instead of every growing patch', () => {
  const session = new Session();
  const updates = [];
  const disconnect = session.subscribe((event, data) => {
    if (event === 'data' && data.type === 'updateBlock')
      updates.push(data.patch[0].value.length);
  });
  session.emitBlock({ id: 'answer', type: 'text', data: '' });
  for (let i = 1; i <= 1000; i++) {
    session.updateBlock('answer', [
      { op: 'replace', path: '/data', value: 'x'.repeat(i * 100) },
    ]);
  }
  assert.equal(updates.length, 1000);
  assert.equal(session.getBlock('answer').data.length, 100_000);
  assert.equal(session.events.length, 0);
  disconnect();
  let replay;
  const unsubscribe = session.subscribe((_event, data) => {
    replay = data;
  });
  assert.equal(replay.block.data.length, 100_000);
  unsubscribe();
});

test('a quiet stream sends keepAlive lines and stops them when it closes', async () => {
  const session = new Session();
  const response = sessionResponse(session, new AbortController().signal, 20);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const events = [];
  const reading = readJsonLines(response.body, (data) => {
    events.push(data);
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  session.emit('end', { status: 'completed' });
  await reading;
  const types = events.map((event) => event.type);
  assert.equal(types[0], 'session');
  assert.ok(types.filter((type) => type === 'keepAlive').length >= 1);
  assert.equal(types.at(-1), 'messageEnd');
});
