import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { loadTs } from '../helpers/loadTs.mjs';

function fixture(
  pages,
  addresses = () => [{ address: '93.184.215.14', family: 4 }],
) {
  const connections = [];
  const dns = { lookup: async (host) => addresses(host) };
  const transport = {
    get(url, options, onResponse) {
      const request = new EventEmitter();
      const deliver = (error, resolved) => {
        if (error) {
          request.emit('error', error);
          return;
        }
        connections.push({ url: url.href, resolved, options });
        const page = pages.shift();
        if (!page) {
          request.emit('error', new Error('Unexpected request'));
          return;
        }
        const response = Readable.from(
          page.chunks || [Buffer.from(page.body || '')],
        );
        response.headers = page.headers || { 'content-type': 'text/html' };
        response.statusCode = page.status || 200;
        onResponse(response);
      };
      queueMicrotask(() =>
        options.lookup(url.hostname, { all: true }, deliver),
      );
      return request;
    },
  };
  const api = loadTs('src/lib/web/safeFetch.ts', {
    'node:http': transport,
    'node:https': transport,
    'node:dns/promises': dns,
  });
  return { ...api, connections };
}

test('socket lookup validates DNS and supplies only the checked address', async () => {
  const f = fixture([{ body: 'Public content' }]);
  const { response } = await f.safeFetch('https://example.com');
  assert.equal(await response.text(), 'Public content');
  assert.deepEqual(f.connections[0].resolved, [
    { address: '93.184.215.14', family: 4 },
  ]);
  assert.equal(f.connections[0].options.agent, false);
});

test('a hostname that rebinds on the next connection is rejected', async () => {
  let resolutions = 0;
  const f = fixture([{ status: 302, headers: { location: '/next' } }], () => [
    { address: ++resolutions === 1 ? '93.184.215.14' : '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(f.safeFetch('https://example.com'), /private/);
  assert.equal(f.connections.length, 1);
});

test('a mixed public/private DNS answer is rejected before connection', async () => {
  const f = fixture([], () => [
    { address: '93.184.215.14', family: 4 },
    { address: '::ffff:7f00:1', family: 6 },
  ]);
  await assert.rejects(f.safeFetch('https://example.com'), /private/);
  assert.equal(f.connections.length, 0);
});

test('redirects to mapped metadata IPs are blocked', async () => {
  const f = fixture([
    { status: 302, headers: { location: 'http://[::ffff:169.254.169.254]/' } },
  ]);
  await assert.rejects(f.safeFetch('https://example.com'), /Private/);
  assert.equal(f.connections.length, 1);
});

test('public redirects resolve relative paths and retain the final source URL', async () => {
  const f = fixture([
    { status: 302, headers: { location: '/article' } },
    { body: 'Article' },
  ]);
  const result = await f.safeFetch('https://example.com/');
  assert.equal(result.url, 'https://example.com/article');
  assert.equal(await result.response.text(), 'Article');
});

test('downloads without content-length stop at the byte limit', async () => {
  const f = fixture([
    { chunks: [Buffer.alloc(5_000_000), Buffer.alloc(5_000_001)] },
  ]);
  await assert.rejects(f.safeFetch('https://example.com'), /size limit/);
});

test('compressed responses have a decompressed size limit', async () => {
  const f = fixture([
    {
      headers: { 'content-encoding': 'gzip' },
      chunks: [gzipSync(Buffer.alloc(10_000_001))],
    },
  ]);
  await assert.rejects(f.safeFetch('https://example.com'), /size limit/);
});

test('pre-aborted requests never open a connection', async () => {
  const f = fixture([]);
  await assert.rejects(
    f.safeFetch('https://example.com', AbortSignal.abort()),
    { name: 'AbortError' },
  );
  assert.equal(f.connections.length, 0);
});
