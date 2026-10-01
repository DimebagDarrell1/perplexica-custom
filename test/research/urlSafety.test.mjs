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

test('IPv4-mapped and expanded private IPv6 cannot bypass URL normalization', () => {
  for (const host of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '0:0:0:0:0:ffff:a9fe:a9fe',
    '::ffff:192.168.1.1',
    '0:0:0:0:0:0:0:1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ])
    assert.throws(
      () => parsePublicHttpUrl(`http://[${host}]/`),
      undefined,
      host,
    );
});

test('public IPv6 and mapped public IPv4 still work', () => {
  for (const host of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.doesNotThrow(() => parsePublicHttpUrl(`https://[${host}]/`));
  }
});

test('trailing-dot local names are rejected', () => {
  for (const host of [
    'localhost.',
    'metadata.google.internal.',
    'printer.local.',
  ]) {
    assert.throws(() => parsePublicHttpUrl(`http://${host}/`));
  }
});
