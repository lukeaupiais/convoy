import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepThoughtExtensionManifest } from '../../packages/runner/src/index.mjs';
import { createCapabilities } from '../../apps/daemon/src/modules/library/capabilities.mjs';
import { createSessionExecution } from '../../apps/daemon/src/modules/execution/index.mjs';

test('DeepThought tools require a reviewed pinned manifest and an installed assigned runner adapter', () => {
  const state = { sessions: {}, projects: [{ id: 'project' }], runners: [] };
  const capabilities = createCapabilities({ state });
  assert.throws(
    () =>
      capabilities.command({ action: 'publishExtension', manifest: deepThoughtExtensionManifest }),
    /trust/,
  );
  const extension = capabilities.command({
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
    extensions: [{ id: extension.id, revision: extension.revision, hash: extension.hash }],
  });
  const session = { workspace: { path: '/workspace' }, runnerId: 'runner' };
  capabilities.pin(session, profile);
  state.runners.push({ id: 'runner', capabilities: { tools: [], extensionAdapters: [] } });
  assert.equal(
    capabilities.preview(session).tools.find((t) => t.name === 'code_intelligence').available,
    false,
  );
  state.runners[0].capabilities.extensionAdapters.push('deepthought');
  assert.equal(
    capabilities.preview(session).tools.find((t) => t.name === 'code_intelligence').available,
    true,
  );
  assert.throws(
    () =>
      capabilities.validate(session, null, 'code_intelligence', {
        operation: 'shell',
        command: 'pwd',
      }),
    /Invalid extension/,
  );
  assert.throws(
    () =>
      capabilities.validate(session, null, 'code_intelligence', {
        operation: 'definitions',
        limit: 101,
      }),
    /Invalid extension/,
  );
});

test('session extensions retain the same immutable execution descriptor as built-in runner tools', async () => {
  let request;
  const grant = {
    runnerId: 'runner',
    digest: 'policy',
    profileId: 'inspect',
    envelope: { isolation: 'workspace' },
  };
  const session = {
    workspace: { path: '/workspace' },
    executionGrant: grant,
    assignment: { token: 'assignment', policyDigest: 'policy' },
  };
  const execution = createSessionExecution({
    runners: {
      execute: async (_runner, r) => {
        request = r;
        return {};
      },
    },
    runnerFor: () => ({ id: 'runner', kind: 'local' }),
    extensionTool: () => ({
      id: 'query',
      extension: { id: 'deepthought', adapter: 'deepthought', revision: '1', hash: 'x' },
    }),
    executionPolicy: { toolRestriction: () => '', supports: () => true },
  });
  await execution.tool(session, 'code_intelligence', { operation: 'definitions' });
  assert.equal(request.executionProfile, 'inspect');
  assert.equal(request.execution.assignmentToken, 'assignment');
  assert.equal(request.execution.grant, grant);
});
