import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTs } from '../helpers/loadTs.mjs';

test('settings use an atomic replacement and preserve malformed files', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'perplexica-config-test-'),
  );
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  fs.mkdirSync(path.join(directory, 'data'));
  const filename = path.join(directory, 'data/config.json');
  const mocks = {
    '../models/providers': { getModelProvidersUIConfigSection: () => [] },
    '../serverUtils': { hashObj: () => '' },
  };
  try {
    const { default: manager } = loadTs('src/lib/config/index.ts', mocks);
    const before = fs.statSync(filename);
    manager.currentConfig.setupComplete = true;
    manager.saveConfig();
    assert.equal(
      JSON.parse(fs.readFileSync(filename, 'utf8')).setupComplete,
      true,
    );
    assert.notEqual(fs.statSync(filename).ino, before.ino);
    assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['config.json']);
    fs.writeFileSync(filename, '{broken settings');
    assert.throws(
      () => loadTs('src/lib/config/index.ts', mocks),
      /existing file was preserved/,
    );
    assert.equal(fs.readFileSync(filename, 'utf8'), '{broken settings');
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true });
  }
});
