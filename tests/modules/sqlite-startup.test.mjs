import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../../apps/daemon/src/adapters/persistence/sqlite-store.mjs';

test('reopening SQLite loads payload rows once while preserving stored state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-sqlite-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const initial = { notes: [{ id: 'one', text: 'First result' }, { id: 'two', text: 'Second result' }] };
  const seeded = await createSqliteStore(directory, initial, 'startup-store');
  await seeded.close();

  // Observe the native database boundary; do not replace the adapter's loading code.
  let payloadScans = 0;
  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = Reflect.apply(originalPrepare, this, args);
    if (/^\s*SELECT\b/i.test(args[0]) && /\bpayload\b/i.test(args[0])) {
      const all = statement.all;
      statement.all = (...bindings) => {
        payloadScans++;
        return Reflect.apply(all, statement, bindings);
      };
    }
    return statement;
  };
  t.after(() => { DatabaseSync.prototype.prepare = originalPrepare; });
  const reopened = await createSqliteStore(directory, {}, 'startup-store', true);
  try {
    assert.deepEqual(reopened.data, initial);
    assert.equal(payloadScans, 1, 'The empty-state check must not scan every payload before loading.');
  } finally {
    await reopened.close();
  }
});
