import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  createDeepThoughtAdapter,
  createRpc,
  deepThoughtExtensionManifest,
} from '../../packages/runner/src/index.mjs';

const python = process.env.CONVOY_TEST_DEEPTHOUGHT_PYTHON;
const extension = {
  id: deepThoughtExtensionManifest.id,
  revision: deepThoughtExtensionManifest.revision,
  hash: createHash('sha256').update(JSON.stringify(deepThoughtExtensionManifest)).digest('hex'),
};

for (const worker of ['source', ...(process.env.CONVOY_TEST_COMPILED_WORKER ? ['compiled'] : [])]) {
  test(
    `${worker} worker retains consistency evidence through source changes and stale SCIP queries`,
    { skip: !python },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'convoy-consistency-worker-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(join(root, 'source.py'), 'class Before: pass\n');
      await copyFile('tests/support/deepthought/typescript.scip', join(root, 'index.scip'));
      const env = { ...process.env, CONVOY_DEEPTHOUGHT_PYTHON: python };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(
        worker === 'source' ? process.execPath : process.env.CONVOY_TEST_COMPILED_WORKER,
        worker === 'source' ? ['apps/worker/src/worker.mjs'] : [],
        { env, stdio: ['pipe', 'pipe', 'inherit'] },
      );
      const rpc = createRpc(child.stdout, child.stdin);
      t.after(() => {
        rpc.close();
        child.stdin.end();
        child.kill();
      });
      const query = (args = { operation: 'definitions' }) =>
        rpc.call('execute', {
          action: 'extension',
          operationId: randomUUID(),
          workspace: root,
          adapter: 'deepthought',
          extension,
          tool: 'extension.deepthought.query',
          args,
        });
      const before = await query();
      const indexed = await query({ operation: 'definitions', index: 'index.scip' });
      assert.equal(before.source_consistency.status, 'unchanged');
      await writeFile(join(root, 'source.py'), 'class After: pass\n');
      const edited = await query();
      assert.notEqual(edited.snapshot_id, before.snapshot_id);
      assert.equal(edited.matches[0].definition.symbol, 'After');
      assert.equal(edited.source_consistency.status, 'unchanged');
      await rename(join(root, 'source.py'), join(root, 'renamed.py'));
      const renamed = await query();
      assert.notEqual(renamed.snapshot_id, edited.snapshot_id);
      assert.equal(renamed.matches[0].definition.file, 'renamed.py');
      await rm(join(root, 'renamed.py'));
      const deleted = await query();
      assert.equal(deleted.total_matches, 0);
      assert.equal(deleted.source_consistency.status, 'unverified');
      const unchangedIndex = await query({ operation: 'definitions', index: 'index.scip' });
      assert.deepEqual(unchangedIndex, indexed);
      assert.equal(unchangedIndex.source_consistency.status, 'unverified');
      assert(
        unchangedIndex.source_consistency.checks.every(
          (check) => check.reason === 'no_source_digest',
        ),
      );
      for (const result of [before, edited, renamed, deleted, unchangedIndex]) {
        assert.equal(result.engine_version, '0.2.4a1');
        assert.equal(result.source_consistency.scope, 'recorded_files');
        assert.equal(result.source_consistency.repository_id, 'workspace');
        assert.equal(result.source_consistency.snapshot_id, result.snapshot_id);
        assert.equal(result.workspace_freshness, 'unverified');
        assert(Buffer.byteLength(JSON.stringify(result)) + 1 <= 32000);
      }
    },
  );
}

test(
  'retained capture reports changed source without rewriting historical facts',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-consistency-history-'));
    const runtime = await mkdtemp(join(tmpdir(), 'convoy-consistency-runtime-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(runtime, { recursive: true, force: true });
    });
    await writeFile(join(root, 'source.py'), 'class Historical: pass\n');
    const capture = spawnSync(
      python,
      [
        '-I',
        '-B',
        '-c',
        "import sys; from deepthought import analyze_repository; print(analyze_repository(sys.argv[1],repository_id='workspace',max_files=200,max_file_bytes=1000000,max_total_bytes=10000000).to_json())",
        root,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(capture.status, 0, capture.stderr);
    const captured = JSON.parse(capture.stdout);
    const prelude = `import base64, deepthought\nfrom deepthought import AnalysisResult\nsaved=AnalysisResult.from_json(base64.b64decode('${Buffer.from(capture.stdout).toString('base64')}'))\ndeepthought.analyze_repository=lambda *args, **kwargs: saved\n`;
    const wrapper = join(runtime, 'python');
    // Change only capture timing in a trusted fixture runtime; execute the actual CLI/checker.
    await writeFile(
      wrapper,
      `#!/usr/bin/python3
import os, sys
args=sys.argv[1:]
if '-c' in args:
    pos=args.index('-c')+1
    if "root=Path('/work')" in args[pos]:
        args[pos]=${JSON.stringify(prelude)}+args[pos]
    else:
        args[pos]=args[pos].replace("'prefixes':[sys.prefix,sys.base_prefix]", ${JSON.stringify("'prefixes':[sys.prefix,sys.base_prefix," + JSON.stringify(runtime) + ']')})
os.execv(${JSON.stringify(python)},[${JSON.stringify(python)},*args])
`,
      { mode: 0o700 },
    );
    const adapter = await createDeepThoughtAdapter({ python: wrapper });
    for (const step of ['edited', 'renamed', 'deleted']) {
      if (step === 'edited') await writeFile(join(root, 'source.py'), 'class Current: pass\n');
      if (step === 'renamed') await rename(join(root, 'source.py'), join(root, 'renamed.py'));
      if (step === 'deleted') await rm(join(root, 'renamed.py'));
      const result = await adapter({
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions' },
        workingDirectory: root,
      });
      assert.equal(result.snapshot_id, captured.snapshot_id);
      assert.equal(result.matches[0].definition.symbol, 'Historical');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.source_consistency.status, 'changed');
      assert.equal(
        result.source_consistency.checks[0].reason,
        step === 'edited' ? 'digest_mismatch' : 'missing',
      );
      assert.equal(result.workspace_freshness, 'unverified');
    }
  },
);

test(
  'excess consistency evidence fails without truncation and does not poison subsequent work',
  { skip: !python },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'convoy-consistency-budget-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = Array.from({ length: 30 }, (_, i) => join(root, `${i}-${'x'.repeat(180)}.py`));
    for (const file of files) await writeFile(file, 'class Item: pass\n');
    const adapter = await createDeepThoughtAdapter({ python, maxOutputBytes: 4096 });
    const invoke = () =>
      adapter({
        extension,
        tool: 'extension.deepthought.query',
        args: { operation: 'definitions' },
        workingDirectory: root,
      });
    await assert.rejects(invoke(), /process failed/);
    for (const file of files) await rm(file);
    await writeFile(join(root, 'source.py'), 'class Small: pass\n');
    const result = await invoke();
    assert.equal(result.matches[0].definition.symbol, 'Small');
    assert.equal(result.source_consistency.status, 'unchanged');
  },
);

test('the prior SDK version is rejected before source analysis', async (t) => {
  const runtime = await mkdtemp(join(tmpdir(), 'convoy-consistency-old-'));
  const root = await mkdtemp(join(tmpdir(), 'convoy-consistency-workspace-'));
  t.after(async () => {
    await rm(runtime, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const wrapper = join(runtime, 'python');
  await writeFile(
    wrapper,
    '#!/usr/bin/python3\nprint(\'{"version":"0.2.1a1","prefixes":["/usr"]}\')\n',
    { mode: 0o700 },
  );
  await assert.rejects(
    createDeepThoughtAdapter({ python: wrapper, workingDirectory: root }),
    /requires SDK 0.2.4a1/,
  );
});
