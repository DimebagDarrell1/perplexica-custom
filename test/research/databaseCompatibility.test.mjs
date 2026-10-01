import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('SQLite driver preserves legacy chats, supports Drizzle writes, and exits after garbage collection', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'perplexica-db-test-'),
  );
  fs.mkdirSync(path.join(directory, 'data'));
  fs.cpSync('drizzle', path.join(directory, 'drizzle'), { recursive: true });
  try {
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DATA_DIR: directory },
        input: `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import Database from 'better-sqlite3';
        import { eq } from 'drizzle-orm';
        import { loadTs } from './test/helpers/loadTs.mjs';

        const filename = path.join(process.env.DATA_DIR, 'data/db.sqlite');
        const legacy = new Database(filename);
        legacy.exec(fs.readFileSync('drizzle/0000_fuzzy_randall.sql', 'utf8'));
        const createdAt = '2026-01-01T00:00:00.000Z';
        legacy.prepare('INSERT INTO chats (id,title,createdAt,focusMode,files) VALUES (?,?,?,?,?)')
          .run('saved-chat', 'Café notes', createdAt, 'webSearch', '[]');
        const insert = legacy.prepare('INSERT INTO messages (content,chatId,messageId,type,metadata) VALUES (?,?,?,?,?)');
        insert.run('Saved question', 'saved-chat', 'saved-message', 'user', JSON.stringify({ createdAt }));
        legacy.prepare('INSERT INTO chats (id,title,createdAt,focusMode,files) VALUES (?,?,?,?,?)')
          .run('other-chat', 'Other notes', createdAt, 'webSearch', '[]');
        insert.run('Other question', 'other-chat', 'other-message', 'user', JSON.stringify({ createdAt }));
        insert.run('Saved answer', 'saved-chat', 'saved-message', 'assistant', JSON.stringify({ createdAt, sources: [{ content: 'Evidence', metadata: { url: 'https://example.com' } }] }));
        insert.run('Other answer', 'other-chat', 'other-message', 'assistant', JSON.stringify({ createdAt }));
        insert.run('Unanswered first', 'saved-chat', 'pending-first', 'user', JSON.stringify({ createdAt }));
        insert.run('Unanswered final', 'saved-chat', 'pending-final', 'user', JSON.stringify({ createdAt }));
        legacy.close();

        loadTs('src/lib/db/migrate.ts');
        const { default: db } = loadTs('src/lib/db/index.ts');
        const { chats, messages } = loadTs('src/lib/db/schema.ts');
        assert.equal(db.select().from(chats).all()[0].title, 'Café notes');
        const saved = db.select().from(messages).where(eq(messages.messageId, 'saved-message')).get();
        assert.equal(saved.query, 'Saved question');
        assert.equal(saved.responseBlocks[0].data, 'Saved answer');
        assert.equal(saved.status, 'completed');
        assert.equal(saved.responseBlocks[1].data[0].metadata.url, 'https://example.com');
        assert.equal(db.select().from(messages).all().length, 4);
        assert.equal(db.select().from(messages).where(eq(messages.messageId, 'pending-final')).get().query, 'Unanswered final');
        assert.equal(db.select().from(messages).where(eq(messages.messageId, 'other-message')).get().responseBlocks[0].data, 'Other answer');
        const blocks = [{ id: 'text', type: 'text', data: 'Partial answer with café and quotes: "ok"' }];
        db.insert(chats).values({ id: 'new-chat', title: 'New chat', createdAt, sources: ['web'], files: [] }).run();
        db.insert(messages).values({ messageId: 'new-message', chatId: 'new-chat', backendId: 'backend', query: 'New question', createdAt, responseBlocks: blocks, status: 'answering' }).run();
        db.update(messages).set({ status: 'cancelled' }).where(eq(messages.messageId, 'new-message')).run();
        const stored = db.select().from(messages).where(eq(messages.messageId, 'new-message')).get();
        assert.deepEqual(stored.responseBlocks, blocks);
        assert.equal(stored.status, 'cancelled');
        db.delete(messages).where(eq(messages.messageId, 'new-message')).run();
        db.delete(chats).where(eq(chats.id, 'new-chat')).run();
        assert.equal(db.select().from(chats).all().length, 2);

        const verify = new Database(filename);
        assert.equal(verify.pragma('integrity_check', { simple: true }), 'ok');
        assert.equal(verify.prepare('SELECT count(*) AS count FROM ran_migrations').get().count, 3);
        for (let i = 0; i < 2000; i++) {
          assert.equal(verify.prepare('SELECT ? AS value').get(i).value, i);
          if (i % 100 === 0) global.gc();
        }
        verify.close();
        global.gc();
      `,
      },
    );
    assert.ifError(result.error);
    assert.equal(
      result.signal,
      null,
      `Database process aborted: ${result.stderr}`,
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed migration rolls back schema and data and can be retried', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'perplexica-migration-test-'),
  );
  fs.mkdirSync(path.join(directory, 'data'));
  fs.cpSync('drizzle', path.join(directory, 'drizzle'), { recursive: true });
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: directory },
      input: `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import Database from 'better-sqlite3';
        import { loadTs } from './test/helpers/loadTs.mjs';
        loadTs('src/lib/db/migrate.ts');
        const filename = path.join(process.env.DATA_DIR, 'data/db.sqlite');
        const db = new Database(filename);
        db.prepare('INSERT INTO chats (id,title,createdAt) VALUES (?,?,?)').run('keep', 'Saved title', '2026-01-01');
        const migration = path.join(process.env.DATA_DIR, 'drizzle/0003_failure.sql');
        fs.writeFileSync(migration, "UPDATE chats SET title='changed'; --> statement-breakpoint\\n ALTER TABLE chats RENAME TO chats_old; --> statement-breakpoint\\n SELECT * FROM missing_table;");
        assert.throws(() => loadTs('src/lib/db/migrate.ts'), /missing_table/);
        assert.equal(db.prepare('SELECT title FROM chats WHERE id=?').get('keep').title, 'Saved title');
        assert.equal(db.prepare('SELECT count(*) AS count FROM ran_migrations').get().count, 3);
        assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='chats_old'").get().count, 0);
        fs.writeFileSync(migration, "UPDATE chats SET title='upgraded';");
        loadTs('src/lib/db/migrate.ts');
        assert.equal(db.prepare('SELECT title FROM chats WHERE id=?').get('keep').title, 'upgraded');
        assert.equal(db.prepare('SELECT count(*) AS count FROM ran_migrations').get().count, 4);
        assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
        db.close();
      `,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
