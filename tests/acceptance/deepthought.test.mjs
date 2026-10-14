import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCapabilities } from '../../apps/daemon/src/modules/library/index.mjs';
import {
  createExecutionPolicy,
  createSessionExecution,
} from '../../apps/daemon/src/modules/execution/index.mjs';
import { createRunners } from '../../apps/daemon/src/adapters/runners/runners.mjs';
import {
  createDeepThoughtAdapter,
  deepThoughtExtensionManifest,
  executeRunner,
  processRun,
} from '../../packages/runner/src/index.mjs';

test(
  'reviewed capability profile executes real definitions and SCIP references through a granted Convoy session',
  { skip: !process.env.CONVOY_TEST_DEEPTHOUGHT_PYTHON },
  async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), 'convoy-deepthought-acceptance-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    await processRun('git', ['init', '-q', workspace]);
    await writeFile(join(workspace, 'source.py'), 'class Widget:\n    def execute(self): pass\n');
    await copyFile('tests/support/deepthought/typescript.scip', join(workspace, 'index.scip'));
    const adapter = await createDeepThoughtAdapter({
      python: process.env.CONVOY_TEST_DEEPTHOUGHT_PYTHON,
    });
    const runners = createRunners({ extensionAdapters: { deepthought: adapter } });
    t.after(() => runners.close());
    const runner = {
      id: 'runner',
      kind: 'local',
      environmentId: 'environment',
      capabilities: {
        inspection: true,
        executionDescriptorVersion: 1,
        tools: [],
        extensionAdapters: ['deepthought'],
      },
    };
    const state = { projects: [{ id: 'project' }], sessions: {}, runners: [runner] };
    const capabilities = createCapabilities({ state });
    const published = capabilities.command({
      action: 'publishExtension',
      manifest: deepThoughtExtensionManifest,
      trusted: true,
    });
    const profile = capabilities.command({
      action: 'publishProfile',
      id: 'intelligence',
      name: 'Intelligence',
      tools: [],
      skills: [],
      extensions: [{ id: published.id, revision: published.revision, hash: published.hash }],
    });
    const session = {
      id: 'session',
      projectId: 'project',
      executionProfile: 'inspect',
      runnerId: 'runner',
      workspace: { path: workspace },
    };
    capabilities.pin(session, profile);
    const policy = createExecutionPolicy({
      state,
      catalog: { ticket: () => undefined, project: () => ({ executionProfile: 'inspect' }) },
    });
    const grant = policy.resolve(session, runner);
    session.executionGrant = grant;
    session.assignment = { token: randomUUID(), policyDigest: grant.digest };
    await executeRunner({
      action: 'bind_execution',
      workspace,
      binding: {
        version: 1,
        profileId: 'inspect',
        assignmentToken: session.assignment.token,
        policyDigest: grant.digest,
      },
    });
    const execution = createSessionExecution({
      runners,
      runnerFor: () => runner,
      executionPolicy: policy,
      extensionTool: (s, name) => capabilities.extensionTool(s, null, name),
    });
    const definitions = { operation: 'definitions', symbol: 'Widget.execute' };
    capabilities.validate(session, null, 'code_intelligence', definitions);
    const result = await execution.tool(session, 'code_intelligence', definitions);
    assert.equal(result.matches[0].symbol, 'Widget.execute');
    assert.equal(result.status, 'succeeded');
    const references = {
      operation: 'references',
      index: 'index.scip',
      symbol:
        'scip-typescript npm deepthought-typescript-fixture 0.0.0 other/`helpers.ts`/helper().',
    };
    capabilities.validate(session, null, 'code_intelligence', references);
    const referenced = await execution.tool(session, 'code_intelligence', references);
    assert.equal(referenced.total_matches, 3);
    assert.equal(referenced.status, 'partial');
  },
);
