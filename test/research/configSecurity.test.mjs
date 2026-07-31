import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preserveRedactedSecrets,
  REDACTED_SECRET,
} from '../../src/lib/config/security.ts';

test('masked provider secrets survive unrelated connection edits', () => {
  assert.deepEqual(
    preserveRedactedSecrets(
      { apiKey: 'real-secret', baseUrl: 'https://api.example.com' },
      { apiKey: REDACTED_SECRET, baseUrl: 'https://new.example.com' },
    ),
    { apiKey: 'real-secret', baseUrl: 'https://new.example.com' },
  );
});
