import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVerificationRuntimes,
  normalizeRuntimeDefinition,
  normalizeRuntimeSelection,
} from '../../apps/daemon/src/modules/execution/verification-runtimes.mjs';
const definition = {
  id: 'document-preview',
  name: 'Document preview',
  image: 'sha256:' + 'a'.repeat(64),
  sourceCommit: 'b'.repeat(40),
  startup: [],
  readiness: ['/bin/true'],
  guidance: 'Run the converter against a fixture.',
  fixtureDigest: 'c'.repeat(64),
  limits: {
    memoryMb: 128,
    scratchMb: 32,
    cpus: 0.5,
    pids: 32,
    lifetimeSeconds: 120,
    startupSeconds: 10,
    commandSeconds: 30,
  },
};
test('immutable project-owned definitions and explicit selection do not depend on workflow vocabulary', async () => {
  const state = {};
  const domain = createVerificationRuntimes({
    state,
    catalog: { project: (id) => ({ id, organizationId: 'org' }) },
    save: async () => {},
  });
  const published = await domain.publish({ projectId: 'docs', definition, baseVersion: 0 });
  published.guidance = 'changed';
  const selected = domain.resolve('docs', { id: definition.id, version: 1, required: false });
  assert.equal(selected.definition.guidance, definition.guidance);
  assert.throws(
    () => domain.resolve('other', { id: definition.id, version: 1, required: true }),
    /not found/,
  );
  await assert.rejects(
    domain.publish({ projectId: 'docs', definition, baseVersion: 0 }),
    /changed/,
  );
  assert.equal(normalizeRuntimeSelection(null), null);
});
test('definition cannot request host authority, mutable images, arbitrary roots or unbounded resources', () => {
  for (const invalid of [
    { ...definition, image: 'node:latest' },
    { ...definition, mounts: ['/'] },
    { ...definition, limits: { ...definition.limits, memoryMb: 0 } },
    { ...definition, startup: ['sh', null] },
    { ...definition, limits: { ...definition.limits, lifetimeSeconds: 30 } },
  ])
    assert.throws(() => normalizeRuntimeDefinition(invalid));
  assert.throws(() =>
    normalizeRuntimeSelection({ id: definition.id, version: 1, required: true, host: true }),
  );
});
test('shared memory is optional and bounded by the declared memory envelope', () => {
  assert.equal(normalizeRuntimeDefinition(definition).limits.sharedMemoryMb, undefined);
  const value = { ...definition, limits: { ...definition.limits, sharedMemoryMb: 64 } };
  assert.equal(normalizeRuntimeDefinition(value).limits.sharedMemoryMb, 64);
  for (const sharedMemoryMb of [0, -1, 1.5, '64', null, 129, 1025]) {
    assert.throws(() =>
      normalizeRuntimeDefinition({
        ...definition,
        limits: { ...definition.limits, sharedMemoryMb },
      }),
    );
  }
});
