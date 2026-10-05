import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from '../helpers/loadTs.mjs';

const auth = loadTs('src/lib/chatgpt/auth.ts');
const {
  default: ChatGPTPlanLLM,
  toResponsesInput,
  TOOL_NAMESPACE,
} = loadTs('src/lib/models/providers/chatgpt/chatgptLLM.ts', {
  '@/lib/chatgpt/auth': {
    ...auth,
    getAccessToken: async () => 'plan-access-token',
  },
});

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'test-key',
  alg: 'RS256',
};

const signIdToken = (claims) => {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
};

const withDataDir = async (fn) => {
  const previous = process.env.DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-plan-'));
  process.env.DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** Mocks OpenAI's token, JWKS and revoke endpoints. */
const mockOpenAI = (handlers) => {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const form =
      typeof init.body === 'string' ? new URLSearchParams(init.body) : null;
    requests.push({ href, form, init });
    if (href === auth.JWKS_URL) return Response.json({ keys: [jwk] });
    const handler = handlers[href];
    if (!handler) throw new Error(`Unexpected request to ${href}`);
    return handler(form, init);
  };
  return { requests, restore: () => (globalThis.fetch = previous) };
};

const tokenResponse = (nonce, clientId, overrides = {}) =>
  Response.json({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    id_token: signIdToken({
      iss: auth.ISSUER,
      aud: clientId,
      sub: 'user-123',
      email: 'dorian@example.com',
      nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: auth.SCOPES,
    ...overrides,
  });

const signIn = async (callbackExtras = {}) => {
  const { authorizeUrl } = auth.startSignIn();
  const authorize = new URL(authorizeUrl);
  const state = authorize.searchParams.get('state');
  const callback = new URL(auth.REDIRECT_URI);
  callback.searchParams.set('code', 'auth-code');
  callback.searchParams.set('state', state);
  callback.searchParams.set('client_id', 'oaiapp_test');
  for (const [key, value] of Object.entries(callbackExtras))
    callback.searchParams.set(key, value);
  return { authorize, callback: callback.toString() };
};

test('first sign-in registers a client with PKCE and saves an owner-only credential file', () =>
  withDataDir(async (dir) => {
    const { authorize, callback } = await signIn();
    const params = authorize.searchParams;
    assert.equal(authorize.origin + authorize.pathname, auth.AUTHORIZE_URL);
    assert.equal(params.get('client_id'), 'dynamic_agent_client');
    assert.equal(params.get('agent_name_hint'), 'Perplexica');
    assert.match(params.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(
      params.get('redirect_uri'),
      'http://127.0.0.1:1459/auth/callback',
    );
    assert.equal(params.get('scope'), auth.SCOPES);
    assert.equal(params.get('resource'), 'https://api.openai.com/v1');
    assert.equal(params.get('code_challenge_method'), 'S256');

    const mock = mockOpenAI({
      [auth.TOKEN_URL]: (form) =>
        tokenResponse(params.get('nonce'), form.get('client_id')),
    });
    try {
      const status = await auth.completeSignIn(callback);
      assert.equal(status.signedIn, true);
      assert.equal(status.planEnabled, true);
      assert.equal(status.email, 'dorian@example.com');

      const exchange = mock.requests.find(
        (r) => r.href === auth.TOKEN_URL,
      ).form;
      assert.equal(exchange.get('grant_type'), 'authorization_code');
      assert.equal(exchange.get('client_id'), 'oaiapp_test');
      assert.equal(exchange.get('redirect_uri'), auth.REDIRECT_URI);
      assert.equal(exchange.get('resource'), auth.RESOURCE);
      assert.equal(
        crypto
          .createHash('sha256')
          .update(exchange.get('code_verifier'))
          .digest('base64url'),
        params.get('code_challenge'),
      );

      const file = path.join(dir, 'data', 'chatgpt-plan.json');
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.clientId, 'oaiapp_test');
      assert.equal(saved.hostId, params.get('ext_agent_host_id'));
      assert.equal(saved.refreshToken, 'refresh-1');

      // A second use of the same callback cannot replay the code.
      await assert.rejects(auth.completeSignIn(callback), {
        code: 'unknown_state',
      });

      // Later sign-ins reuse the issued client and the same host ID.
      const again = new URL(auth.startSignIn().authorizeUrl).searchParams;
      assert.equal(again.get('client_id'), 'oaiapp_test');
      assert.equal(again.get('agent_name_hint'), null);
      assert.equal(again.get('ext_agent_host_id'), saved.hostId);
      assert.equal(again.get('login_hint'), 'dorian@example.com');
    } finally {
      mock.restore();
    }
  }));

test('sign-in rejects a wrong nonce, a cancelled consent and a missing client ID', () =>
  withDataDir(async () => {
    const mock = mockOpenAI({
      [auth.TOKEN_URL]: (form) =>
        tokenResponse('wrong-nonce', form.get('client_id')),
    });
    try {
      const { callback } = await signIn();
      await assert.rejects(auth.completeSignIn(callback), {
        code: 'invalid_id_token',
      });
      assert.equal(auth.getStatus().signedIn, false);

      const denied = await signIn({ error: 'access_denied' });
      await assert.rejects(auth.completeSignIn(denied.callback), {
        code: 'access_denied',
      });

      const { authorize } = await signIn();
      const noClient = new URL(auth.REDIRECT_URI);
      noClient.searchParams.set('code', 'c');
      noClient.searchParams.set('state', authorize.searchParams.get('state'));
      await assert.rejects(auth.completeSignIn(noClient.toString()), {
        code: 'registration_incomplete',
      });
    } finally {
      mock.restore();
    }
  }));

test('a grant without plan scope signs in but keeps plan models unavailable', () =>
  withDataDir(async () => {
    const { authorize, callback } = await signIn();
    const mock = mockOpenAI({
      [auth.TOKEN_URL]: (form) =>
        tokenResponse(
          authorize.searchParams.get('nonce'),
          form.get('client_id'),
          {
            scope: 'openid profile email offline_access',
          },
        ),
    });
    try {
      const status = await auth.completeSignIn(callback);
      assert.equal(status.signedIn, true);
      assert.equal(status.planEnabled, false);
      await assert.rejects(auth.getAccessToken(), { code: 'plan_not_enabled' });
    } finally {
      mock.restore();
    }
  }));

test('tokens refresh near expiry, rotate, and clear when the refresh token is rejected', () =>
  withDataDir(async (dir) => {
    const { authorize, callback } = await signIn();
    let refreshes = 0;
    let rejectRefresh = false;
    const mock = mockOpenAI({
      [auth.TOKEN_URL]: (form) => {
        if (form.get('grant_type') === 'refresh_token') {
          refreshes++;
          assert.equal(form.get('client_id'), 'oaiapp_test');
          assert.equal(form.get('resource'), auth.RESOURCE);
          if (rejectRefresh)
            return Response.json({ error: 'invalid_grant' }, { status: 400 });
          return Response.json({
            access_token: `access-${refreshes + 1}`,
            refresh_token: `refresh-${refreshes + 1}`,
            expires_in: 3600,
            scope: auth.SCOPES,
          });
        }
        return tokenResponse(
          authorize.searchParams.get('nonce'),
          form.get('client_id'),
        );
      },
    });
    try {
      await auth.completeSignIn(callback);
      assert.equal(await auth.getAccessToken(), 'access-1');
      assert.equal(refreshes, 0);

      const file = path.join(dir, 'data', 'chatgpt-plan.json');
      const expire = () => {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        saved.expiresAt = Date.now() + 60_000;
        fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
      };
      expire();
      const [first, second] = await Promise.all([
        auth.getAccessToken(),
        auth.getAccessToken(),
      ]);
      assert.equal(first, 'access-2');
      assert.equal(second, 'access-2');
      assert.equal(refreshes, 1, 'concurrent callers share one refresh');
      assert.equal(
        JSON.parse(fs.readFileSync(file, 'utf8')).refreshToken,
        'refresh-2',
      );

      expire();
      rejectRefresh = true;
      await assert.rejects(auth.getAccessToken(), {
        code: 'invalid_grant',
        signInRequired: true,
      });
      const cleared = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(cleared.accessToken, undefined);
      assert.equal(cleared.clientId, 'oaiapp_test');
    } finally {
      mock.restore();
    }
  }));

test('sign-out revokes the refresh token and keeps the registration', () =>
  withDataDir(async (dir) => {
    const { authorize, callback } = await signIn();
    const mock = mockOpenAI({
      [auth.TOKEN_URL]: (form) =>
        tokenResponse(
          authorize.searchParams.get('nonce'),
          form.get('client_id'),
        ),
      [auth.REVOKE_URL]: () => new Response('', { status: 200 }),
    });
    try {
      await auth.completeSignIn(callback);
      const result = await auth.signOut();
      assert.equal(result.revoked, true);
      const revoke = mock.requests.find((r) => r.href === auth.REVOKE_URL).form;
      assert.equal(revoke.get('token'), 'refresh-1');
      assert.equal(revoke.get('token_type_hint'), 'refresh_token');
      assert.equal(revoke.get('client_id'), 'oaiapp_test');
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, 'data', 'chatgpt-plan.json'), 'utf8'),
      );
      assert.equal(saved.refreshToken, undefined);
      assert.equal(saved.idToken, undefined);
      assert.equal(saved.clientId, 'oaiapp_test');
      assert.equal(auth.getStatus().signedIn, false);
    } finally {
      mock.restore();
    }
  }));

test('chat history maps to Responses input with system text as instructions', () => {
  const { instructions, input } = toResponsesInput([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'Question' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-1', name: 'web_search', arguments: { queries: ['q'] } },
      ],
    },
    { role: 'tool', id: 'call-1', name: 'web_search', content: '{"ok":true}' },
  ]);
  assert.equal(instructions, 'Be brief.');
  assert.deepEqual(input, [
    { role: 'user', content: 'Question' },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'web_search',
      namespace: TOOL_NAMESPACE,
      arguments: '{"queries":["q"]}',
    },
    { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' },
  ]);
});

const sse = (events) =>
  new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );

const withResponses = async (events, fn) => {
  const previous = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(
      new Headers(init.headers).get('authorization'),
      'Bearer plan-access-token',
    );
    bodies.push(JSON.parse(init.body));
    return sse(events);
  };
  try {
    return await fn(bodies);
  } finally {
    globalThis.fetch = previous;
  }
};

test('plan requests stream tool calls from a namespace and omit unsupported fields', async () => {
  const z = (await import('zod')).default;
  const events = [
    { type: 'response.created', response: { id: 'r1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'web_search',
        namespace: TOOL_NAMESPACE,
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 0,
      delta: '{"queries":["cor',
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 0,
      delta: 'aline"]}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'web_search',
        arguments: '{"queries":["coraline"]}',
      },
    },
    { type: 'response.completed', response: { id: 'r1' } },
  ];
  await withResponses(events, async (bodies) => {
    const llm = new ChatGPTPlanLLM({ model: 'gpt-plan-model' });
    const output = await llm.generateText({
      messages: [
        { role: 'system', content: 'Research carefully.' },
        { role: 'user', content: 'Coraline facts' },
      ],
      tools: [
        {
          name: 'web_search',
          description: 'Search the web',
          schema: z.object({ queries: z.array(z.string()) }),
        },
      ],
      options: { temperature: 0.2, maxTokens: 100 },
    });
    assert.deepEqual(output.toolCalls, [
      {
        id: 'call_1',
        name: 'web_search',
        arguments: { queries: ['coraline'] },
      },
    ]);
    const body = bodies[0];
    assert.equal(body.model, 'gpt-plan-model');
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.equal(body.instructions, 'Research carefully.');
    assert.equal(
      body.input.some((item) => item.role === 'system'),
      false,
    );
    for (const field of ['temperature', 'top_p', 'max_output_tokens'])
      assert.equal(Object.hasOwn(body, field), false, field);
    assert.equal(body.tools[0].type, 'namespace');
    assert.equal(body.tools[0].name, TOOL_NAMESPACE);
    assert.equal(body.tools[0].tools[0].name, 'web_search');
    assert.equal(
      Object.hasOwn(body.tools[0].tools[0].parameters, '$schema'),
      false,
    );
  });
});

test('a usage-limit failure after streaming starts becomes an actionable error', async () => {
  const events = [
    {
      type: 'response.output_text.delta',
      item_id: 'm1',
      output_index: 0,
      content_index: 0,
      delta: 'Partial',
    },
    {
      type: 'response.failed',
      response: {
        error: {
          code: 'subscription_sharing_usage_limit_exceeded',
          message: 'limit',
        },
      },
    },
  ];
  await withResponses(events, async () => {
    const llm = new ChatGPTPlanLLM({ model: 'gpt-plan-model' });
    const chunks = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of llm.streamText({
          messages: [{ role: 'user', content: 'hi' }],
        }))
          chunks.push(chunk.contentChunk);
      })(),
      /usage limit .*chatgpt\.com\/settings\/usage/,
    );
    assert.deepEqual(chunks, ['Partial']);
  });
});

test('a stream that ends without response.completed is treated as a failure', async () => {
  await withResponses(
    [
      {
        type: 'response.output_text.delta',
        item_id: 'm1',
        output_index: 0,
        content_index: 0,
        delta: 'Hi',
      },
    ],
    async () => {
      const llm = new ChatGPTPlanLLM({ model: 'gpt-plan-model' });
      await assert.rejects(
        llm.generateText({ messages: [{ role: 'user', content: 'hi' }] }),
        /ended before it completed/,
      );
    },
  );
});
