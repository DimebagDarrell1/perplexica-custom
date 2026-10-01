import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTs } from '../helpers/loadTs.mjs';

async function setup(fetchPage) {
  let routeHandler, socketHandler;
  const context = {
    route: async (_pattern, handler) => {
      routeHandler = handler;
    },
    routeWebSocket: async (_pattern, handler) => {
      socketHandler = handler;
    },
  };
  const { secureBrowserContext } = loadTs('src/lib/web/browserNetwork.ts', {
    './safeFetch': { safeFetch: fetchPage },
  });
  const controller = new AbortController();
  const navigation = await secureBrowserContext(context, controller.signal);
  const request = async (options = {}) => {
    let aborted = false,
      fulfilled;
    await routeHandler({
      request: () => ({
        url: () => options.url || 'https://example.com/',
        method: () => options.method || 'GET',
        resourceType: () => options.type || 'document',
        isNavigationRequest: () => !options.subrequest,
        frame: () => ({ parentFrame: () => null }),
      }),
      abort: async () => {
        aborted = true;
      },
      fulfill: async (value) => {
        fulfilled = value;
      },
      continue: () =>
        assert.fail('Browser must never resolve and connect independently'),
    });
    return { aborted, fulfilled };
  };
  return { request, navigation, controller, socketHandler };
}

test('browser navigation and script requests both use the validated transport', async () => {
  const urls = [];
  const browser = await setup(async (url) => {
    urls.push(url);
    return { response: new Response('Public content'), url };
  });
  assert.equal(
    (await browser.request()).fulfilled.body.toString(),
    'Public content',
  );
  await browser.request({
    type: 'script',
    subrequest: true,
    url: 'https://example.com/main.js',
  });
  assert.deepEqual(urls, [
    'https://example.com/',
    'https://example.com/main.js',
  ]);
  assert.equal(browser.navigation.finalUrl, 'https://example.com/');
});

test('blocked subrequests and non-read requests cannot continue through Chromium', async () => {
  let calls = 0;
  const browser = await setup(async () => {
    calls++;
    throw new Error('Private IP rejected');
  });
  assert.equal(
    (
      await browser.request({
        subrequest: true,
        type: 'fetch',
        url: 'http://127.0.0.1/',
      })
    ).aborted,
    true,
  );
  assert.equal(calls, 1);
  for (const options of [
    { method: 'POST' },
    { type: 'image' },
    { type: 'media' },
    { type: 'font' },
  ]) {
    assert.equal((await browser.request(options)).aborted, true);
  }
  assert.equal(calls, 1);
  let closed = false;
  browser.socketHandler({
    close: () => {
      closed = true;
    },
  });
  assert.equal(closed, true);
  browser.controller.abort();
  assert.equal((await browser.request()).aborted, true);
  assert.equal(calls, 1);
});

test('browser redirects preserve final source URL and relative resource base', async () => {
  const browser = await setup(async () => ({
    response: new Response('<html><head></head><body>Article</body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
    url: 'https://example.org/articles/final',
  }));
  const result = await browser.request();
  assert.match(
    result.fulfilled.body.toString(),
    /<base href="https:\/\/example.org\/articles\/final">/,
  );
  assert.equal(
    browser.navigation.finalUrl,
    'https://example.org/articles/final',
  );
});

test('browser extraction has a finite request budget', async () => {
  let calls = 0;
  const browser = await setup(async (url) => {
    calls++;
    return { response: new Response('ok'), url };
  });
  for (let i = 0; i < 100; i++) assert.ok((await browser.request()).fulfilled);
  assert.equal((await browser.request()).aborted, true);
  assert.equal(calls, 100);
});
