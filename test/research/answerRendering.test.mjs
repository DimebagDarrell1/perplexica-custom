import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAnswer } from '../helpers/renderAnswer.mjs';
import { safeLink } from '../../src/lib/web/safeLinks.ts';

test('raw HTML is shown literally without active iframe, script, form, or image elements', () => {
  const html = renderAnswer(
    '<iframe src="https://example.com"></iframe>\n\n<script>alert(1)</script>\n\n<form action="https://example.com">content</form>\n\n<img src="https://example.com/a" onerror="alert(1)" />',
  );
  assert.doesNotMatch(html, /<(iframe|script|form|img)\b/);
  assert.match(html, /&lt;iframe/);
  assert.match(html, /content/);
});

test('citations resolve only to the numbered search source', () => {
  const html = renderAnswer(
    'Supported claim <citation index="1">forged label</citation>.',
  );
  assert.match(html, /href="https:\/\/example.com\/source"/);
  assert.doesNotMatch(html, /forged label/);
  assert.match(html, /rel="noopener noreferrer"/);
  const forged = renderAnswer(
    '<citation href="https://attacker.example">1</citation>',
  );
  assert.doesNotMatch(forged, /href="https:\/\/attacker.example"/);
});

test('unsafe source URLs and markdown links cannot execute JavaScript', () => {
  const html = renderAnswer(
    '<citation index="1">1</citation> [open](javascript:alert%281%29)',
    'javascript:alert(1)',
  );
  assert.doesNotMatch(html, /href="javascript:/);
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'java\nscript:alert(1)',
  ]) {
    assert.equal(safeLink(url), undefined);
  }
});

test('ordinary markdown, code, reasoning blocks, and file citations remain readable', () => {
  const html = renderAnswer(
    '**Bold**\n\n```html\n<iframe>code sample</iframe>\n```\n\n<think>Reasoning text</think>\n\n<citation index="1">1</citation>',
    'file_id://report',
  );
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(
    html,
    /<pre>&lt;iframe&gt;code sample&lt;\/iframe&gt;\s*<\/pre>/,
  );
  assert.match(html, /<aside>Reasoning text<\/aside>/);
  assert.match(html, /Uploaded file/);
  assert.doesNotMatch(html, /href="file_id:/);
});
