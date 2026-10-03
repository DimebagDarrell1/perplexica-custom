import assert from 'node:assert/strict';
import test from 'node:test';
import z from 'zod';
import { loadTs } from '../helpers/loadTs.mjs';

const { default: Session } = loadTs('src/lib/session.ts');
const classification = (standaloneFollowUp = 'Coraline movie meaning') => ({
  standaloneFollowUp,
  classification: {
    skipSearch: true,
    personalSearch: false,
    academicSearch: true,
    discussionSearch: true,
    showWeatherWidget: true,
    showStockWidget: false,
    showCalculationWidget: false,
  },
});
const webResult = {
  title: 'Coraline film meaning',
  url: 'https://example.com/coraline',
  content:
    'Coraline explores courage, family, and accepting imperfect reality.',
};

function fixture({ search, decision = 'done' } = {}) {
  const calls = [];
  const toolConfigs = [];
  const saved = [];
  let writerCalls = 0;
  let researcherCalls = 0;
  const { default: Registry } = loadTs(
    'src/lib/agents/search/researcher/actions/registry.ts',
  );
  const { default: webAction } = loadTs(
    'src/lib/agents/search/researcher/actions/webSearch.ts',
    {
      '@/lib/searxng': {
        searchSearxng: async (query, options) => {
          calls.push({ query, options });
          return search ? search(query, options) : { results: [webResult] };
        },
      },
    },
  );
  const { default: doneAction } = loadTs(
    'src/lib/agents/search/researcher/actions/done.ts',
  );
  Registry.register(webAction);
  Registry.register(doneAction);
  for (const [name, source] of [
    ['academic_search', 'academic'],
    ['discussion_search', 'discussions'],
  ]) {
    Registry.register({
      name,
      schema: z.object({}),
      enabled: (config) => config.sources.includes(source),
      getToolDescription: () => name,
      getDescription: () => name,
      execute: async () => ({ type: 'search_results', results: [] }),
    });
  }
  const uploads = [];
  Registry.register({
    name: 'uploads_search',
    schema: z.object({ queries: z.array(z.string()) }),
    enabled: (config) => config.fileIds.length > 0,
    getToolDescription: () => 'Search uploaded files',
    getDescription: () => 'Search uploaded files',
    execute: async (params, config) => {
      uploads.push({ params, fileIds: config.fileIds });
      return {
        type: 'search_results',
        results: [
          {
            content: 'An uploaded analysis discusses Coraline and family.',
            metadata: { title: 'Analysis', url: 'file_id://document-1' },
          },
        ],
      };
    },
  });
  const { default: Researcher } = loadTs(
    'src/lib/agents/search/researcher/index.ts',
    {
      './actions': {
        ActionRegistry: {
          getAvailableActionTools: (config) => {
            toolConfigs.push(config);
            return Registry.getAvailableActionTools(config);
          },
          getAvailableActionsDescriptions:
            Registry.getAvailableActionsDescriptions.bind(Registry),
          execute: Registry.execute.bind(Registry),
          executeAll: Registry.executeAll.bind(Registry),
        },
      },
      '@/lib/prompts/search/researcher': {
        getResearcherPrompt: () => 'Research fixture',
      },
    },
  );
  const database = {
    query: { messages: { findFirst: async () => null } },
    insert: () => ({ values: async () => {} }),
    update: () => ({
      set: (value) => ({
        where: () => ({ execute: async () => saved.push(value) }),
      }),
    }),
  };
  const llm = {
    async *streamText({ tools }) {
      if (tools) {
        researcherCalls++;
        assert.ok(
          calls.length > 0,
          'Web search must precede any model decision',
        );
        if (decision === 'empty') return;
        yield {
          contentChunk: '',
          toolCallChunk: [
            {
              id: crypto.randomUUID(),
              name: decision,
              arguments:
                decision === 'web_search'
                  ? { queries: ['Coraline film interpretation'] }
                  : {},
            },
          ],
        };
      } else {
        writerCalls++;
        yield { contentChunk: 'A cited answer[1].', toolCallChunk: [] };
      }
    },
  };
  function agent(path, answerClassification) {
    return loadTs(path, {
      './classifier': { classify: async () => answerClassification },
      './researcher': { __esModule: true, default: Researcher },
      './widgets': {
        WidgetExecutor: {
          executeAll: async () => [
            {
              type: 'weather',
              data: { city: 'Toronto' },
              llmContext: 'Weather',
            },
          ],
        },
      },
      './writerContext': {
        prepareWriterContext: async (findings) => findings || [],
        formatWriterContext: () => 'Evidence fixture',
        truncateChatHistory: (history) => history,
        buildWriterUserMessage: (query) => query,
      },
      '@/lib/prompts/search/writer': {
        getWriterPrompt: () => 'Writer fixture',
      },
      '@/lib/db': { __esModule: true, default: database },
      '@/lib/db/schema': { messages: {} },
      'drizzle-orm': { eq: () => {}, and: () => {} },
    }).default;
  }
  return {
    calls,
    toolConfigs,
    saved,
    uploads,
    Researcher,
    llm,
    agent,
    writerCalls: () => writerCalls,
    researcherCalls: () => researcherCalls,
  };
}

function input(mode, query, answerClassification, history = []) {
  return {
    chatId: 'fixture-chat',
    messageId: 'fixture-message',
    followUp: query,
    chatHistory: history,
    classification: answerClassification,
    config: {
      mode,
      sources: ['academic', 'discussions'],
      fileIds: [],
      embedding: {},
      systemInstructions: 'None',
    },
  };
}

const scenarios = [
  ['first query', 'Tell me about Coraline', 'Coraline movie facts', []],
  [
    'follow-up',
    'what is the meaning of the movie',
    'Coraline movie meaning',
    [
      {
        role: 'user',
        content: 'what are some cool facts about the coraline movie',
      },
      { role: 'assistant', content: 'Coraline is a stop-motion film[1].' },
    ],
  ],
  ['general knowledge', 'What is 2 + 2?', '2 plus 2 arithmetic', []],
  ['greeting', 'hello', 'hello greeting', []],
  [
    'rewrite',
    'Rephrase that answer',
    'Rephrase Coraline film summary',
    [{ role: 'assistant', content: 'Coraline explores bravery.' }],
  ],
  ['widget request', 'Show weather in Toronto', 'Toronto current weather', []],
];

for (const [path, name] of [
  ['src/lib/agents/search/index.ts', 'chat'],
  ['src/lib/agents/search/api.ts', 'API'],
]) {
  for (const mode of ['speed', 'balanced', 'quality']) {
    test(`${name} ${mode} searches every query type even if classification skips or model immediately finishes`, async () => {
      for (const [kind, query, standalone, history] of scenarios) {
        const f = fixture();
        const answerClassification = classification(standalone);
        const Agent = f.agent(path, answerClassification);
        const request = input(mode, query, answerClassification, history);
        request.config.llm = f.llm;
        const session = new Session();
        const events = [];
        session.emitter.on('data', (event) => events.push(event));
        await new Agent().searchAsync(session, request);
        assert.deepEqual(
          f.calls.map((call) => call.query),
          [standalone],
          kind,
        );
        assert.equal(f.calls[0].options.signal, session.signal, kind);
        assert.deepEqual(
          f.toolConfigs[0].sources,
          ['academic', 'discussions', 'web'],
          kind,
        );
        assert.equal(
          f.toolConfigs[0].classification.classification.skipSearch,
          false,
          kind,
        );
        assert.deepEqual(request.config.sources, ['academic', 'discussions']);
        const blocks = session.getAllBlocks();
        const finalSources =
          name === 'chat'
            ? blocks.find((block) => block.type === 'source').data
            : events.find((event) => event.type === 'searchResults').data;
        assert.equal(finalSources[0].metadata.research.mode, mode);
        assert.ok(
          blocks.some((block) => block.type === 'research'),
          kind,
        );
        assert.equal(
          blocks.find((block) => block.type === 'source').data.length,
          1,
          kind,
        );
        assert.equal(f.writerCalls(), 1, kind);
        if (name === 'chat') assert.equal(f.saved.at(-1).status, 'completed');
        else
          assert.equal(
            events.find((event) => event.type === 'searchResults').data.length,
            1,
            kind,
          );
      }
    });
  }
}

test('classifier never skips web research and preserves widget/source classification', async () => {
  const { classify } = loadTs('src/lib/agents/search/classifier.ts');
  const raw = classification('Coraline film meaning');
  const result = await classify({
    query: 'what is the meaning of the movie',
    chatHistory: [{ role: 'user', content: 'Tell me about Coraline' }],
    enabledSources: ['web'],
    llm: { generateObject: async () => raw },
  });
  assert.equal(result.classification.skipSearch, false);
  assert.equal(result.classification.showWeatherWidget, true);
  assert.equal(result.classification.academicSearch, true);
  assert.equal(result.standaloneFollowUp, 'Coraline film meaning');
  assert.equal(raw.classification.skipSearch, true);
});

test('blank reformulation uses the submitted query and empty model output cannot prevent search', async () => {
  const f = fixture({ decision: 'empty' });
  const request = input(
    'speed',
    'Coraline film meaning',
    classification('   '),
  );
  request.config.llm = f.llm;
  const result = await new f.Researcher().research(new Session(), request);
  assert.equal(f.calls[0].query, request.followUp);
  assert.equal(result.searchFindings.length, 1);
});

test('mandatory web search preserves uploaded-file research and other selected sources', async () => {
  const f = fixture();
  const request = input('balanced', 'Coraline analysis', classification());
  request.config.fileIds = ['document-1'];
  request.config.llm = f.llm;
  const result = await new f.Researcher().research(new Session(), request);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.uploads[0].fileIds, ['document-1']);
  assert.deepEqual(f.toolConfigs[0].sources, [
    'academic',
    'discussions',
    'web',
  ]);
  assert.deepEqual(
    new Set(result.searchFindings.map((chunk) => chunk.metadata.url)),
    new Set(['https://example.com/coraline', 'file_id://document-1']),
  );
});

for (const [mode, limit] of [
  ['speed', 2],
  ['balanced', 6],
  ['quality', 25],
]) {
  test(`mandatory first search stays within the ${mode} research iteration budget`, async () => {
    const f = fixture({ decision: 'web_search' });
    const request = input(mode, 'Coraline analysis', classification());
    request.config.llm = f.llm;
    await new f.Researcher().research(new Session(), request);
    assert.equal(f.calls.length, limit);
    assert.equal(f.researcherCalls(), limit - 1);
  });
}

for (const path of [
  'src/lib/agents/search/index.ts',
  'src/lib/agents/search/api.ts',
]) {
  test(`${path} cancellation stops the mandatory search before writing`, async () => {
    let started;
    const gate = new Promise((resolve) => {
      started = resolve;
    });
    const f = fixture({
      search: async (_query, { signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const answerClassification = classification();
    const Agent = f.agent(path, answerClassification);
    const request = input('speed', 'Coraline analysis', answerClassification);
    request.config.llm = f.llm;
    const session = new Session();
    const pending = new Agent().searchAsync(session, request);
    await gate;
    session.cancel();
    await pending;
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.signal.aborted, true);
    assert.equal(f.researcherCalls(), 0);
    assert.equal(f.writerCalls(), 0);
    if (path.endsWith('/index.ts'))
      assert.equal(f.saved.at(-1).status, 'cancelled');
  });
}

test('an already-cancelled request never starts a mandatory web search', async () => {
  const f = fixture();
  const request = input('speed', 'Coraline analysis', classification());
  request.config.llm = f.llm;
  const session = new Session();
  session.cancel();
  await assert.rejects(new f.Researcher().research(session, request), {
    name: 'AbortError',
  });
  assert.equal(f.calls.length, 0);
});

test('no backend results still records the attempted mandatory search without invented sources', async () => {
  const f = fixture({ search: async () => ({ results: [] }) });
  const request = input('speed', 'Coraline analysis', classification());
  request.config.llm = f.llm;
  const session = new Session();
  const result = await new f.Researcher().research(session, request);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(result.searchFindings, []);
  const research = session
    .getAllBlocks()
    .find((block) => block.type === 'research');
  assert.equal(research.data.subSteps[0].type, 'searching');
  assert.deepEqual(
    research.data.subSteps.find((step) => step.type === 'search_results')
      .reading,
    [],
  );
});

for (const path of [
  'src/lib/agents/search/index.ts',
  'src/lib/agents/search/api.ts',
]) {
  test(`${path} a failed required web search reports an error before generating an unsupported answer`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const f = fixture({
      search: async () => {
        throw new Error('Backend unavailable');
      },
    });
    const answerClassification = classification();
    const Agent = f.agent(path, answerClassification);
    const request = input('speed', 'Coraline analysis', answerClassification);
    request.config.llm = f.llm;
    const session = new Session();
    let reportedError;
    let completed = false;
    session.subscribe((event, data) => {
      if (event === 'error') reportedError = data.data;
      if (event === 'end') completed = data.status === 'completed';
    });
    await new Agent().searchAsync(session, request);
    assert.match(reportedError, /required web search failed/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.writerCalls(), 0);
    assert.equal(f.researcherCalls(), 0);
    assert.equal(completed, false);
    assert.equal(
      session.getAllBlocks().some((block) => block.type === 'text'),
      false,
    );
    if (path.endsWith('/index.ts'))
      assert.equal(f.saved.at(-1).status, 'error');
  });
}
