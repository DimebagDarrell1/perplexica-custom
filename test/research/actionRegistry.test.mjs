import assert from 'node:assert/strict';
import test from 'node:test';
import z from 'zod';
import Registry from '../../src/lib/agents/search/researcher/actions/registry.ts';

test('parallel tool results remain paired with their original call IDs', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  Registry.register({
    name: 'slow-test',
    schema: z.object({}),
    execute: async () => {
      await gate;
      return { value: 'slow' };
    },
  });
  Registry.register({
    name: 'fast-test',
    schema: z.object({}),
    execute: async () => {
      release();
      return { value: 'fast' };
    },
  });
  assert.deepEqual(
    await Registry.executeAll(
      [
        { name: 'slow-test', arguments: {} },
        { name: 'fast-test', arguments: {} },
      ],
      {},
    ),
    [{ value: 'slow' }, { value: 'fast' }],
  );
});

test('malformed tool arguments never reach the action', async () => {
  let executed = false;
  Registry.register({
    name: 'validated-test',
    schema: z.object({ queries: z.array(z.string()) }),
    execute: async () => {
      executed = true;
    },
  });
  await assert.rejects(
    Registry.execute('validated-test', { queries: 'wrong type' }, {}),
  );
  assert.equal(executed, false);
});
