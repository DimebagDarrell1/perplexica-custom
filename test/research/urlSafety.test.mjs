import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPrivateIpAddress,
  parsePublicHttpUrl,
} from '../../src/lib/web/urlSafety.ts';

test('private and metadata IP ranges are rejected', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
});

test('public HTTP URLs are accepted', () => {
  assert.equal(
    parsePublicHttpUrl('https://example.com/article').hostname,
    'example.com',
  );
});

test('local hosts, credentials, and non-HTTP schemes are rejected', () => {
  for (const url of [
    'http://localhost/admin',
    'http://127.0.0.1/admin',
    'http://2130706433/admin',
    'http://0x7f000001/admin',
    'http://user:pass@example.com',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => parsePublicHttpUrl(url), undefined, url);
  }
});
