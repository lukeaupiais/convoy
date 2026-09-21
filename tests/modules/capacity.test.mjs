import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCapacity,
  staticCapacityProvider,
} from '../../apps/daemon/src/modules/execution/capacity.mjs';
import { createDeterministicCapacityAdapter } from '../support/deterministic-capacity.mjs';

test('capacity records deterministic read-only demand with immutable ceilings', async () => {
  const state = {
    projects: [{ id: 'project-1', organizationId: 'org-1' }],
    runnerPools: [{ id: 'pool-1', organizationId: 'org-1' }],
    environments: [
      { id: 'env-a', organizationId: 'org-1' },
      { id: 'env-b', organizationId: 'org-1' },
    ],
  };
  let saves = 0;
  const adapter = createDeterministicCapacityAdapter({
    observations: [
      { availableCapacity: 0, drainState: 'draining' },
      { availableCapacity: 1, drainState: 'active' },
    ],
  });
  const capacity = createCapacity({
    state,
    save: async () => saves++,
    provider: adapter,
    now: () => '2026-09-20T12:00:00.000Z',
  });
  const configuration = staticCapacityProvider({
    adapterId: adapter.id,
    runtimeRevision: 'runner-v7',
    imageRevision: 'sha256:image',
    authorityCeiling: 'contained',
    budgetCeiling: { maxRunners: 3, maxConcurrent: 6, maxHourlyCost: 2, currency: 'USD' },
  });
  const request = await capacity.recordDemand({
    demandKey: 'session:42:assignment',
    organizationId: 'org-1',
    projectId: 'project-1',
    poolId: 'pool-1',
    environmentIds: ['env-b', 'env-a'],
    desiredCapacity: 1,
    availableCapacity: 0,
    drainState: 'active',
    configuration,
  });

  assert.equal(request.id, 'capacity-eda3116fb530bf004682bd14');
  assert.equal(request.state, 'open');
  assert.equal(request.drainState, 'draining');
  assert.equal(request.runtimeRevision, 'runner-v7');
  assert.equal(request.imageRevision, 'sha256:image');
  assert.equal(request.authorityCeiling, 'contained');
  assert.deepEqual(request.environmentIds, ['env-a', 'env-b']);
  assert.deepEqual(capacity.statuses(), [
    {
      organizationId: 'org-1',
      poolId: 'pool-1',
      desiredCapacity: 1,
      availableCapacity: 0,
      openRequests: 1,
      drainState: 'draining',
      observedAt: '2026-09-20T12:00:00.000Z',
    },
  ]);
  assert.equal(saves, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal('provision' in adapter, false);
  assert.equal('destroy' in adapter, false);

  const repeated = await capacity.recordDemand({
    demandKey: 'session:42:assignment',
    organizationId: 'org-1',
    projectId: 'project-1',
    poolId: 'pool-1',
    environmentIds: ['env-b', 'env-a'],
    desiredCapacity: 1,
    availableCapacity: 0,
    drainState: 'active',
    configuration,
  });
  assert.equal(repeated.revision, 1);
  assert.equal(capacity.requests().length, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(saves, 1);

  const satisfied = await capacity.satisfy('session:42:assignment');
  assert.equal(satisfied.state, 'satisfied');
  assert.equal(satisfied.reason, undefined);
  assert.equal('reason' in capacity.requests()[0], false);

  await assert.rejects(
    capacity.recordDemand({
      demandKey: 'session:42:assignment',
      organizationId: 'org-1',
      projectId: 'project-1',
      poolId: 'pool-1',
      environmentIds: ['env-a', 'env-b'],
      desiredCapacity: 1,
      availableCapacity: 0,
      configuration: { ...configuration, imageRevision: 'sha256:other' },
    }),
    /constraints changed/,
  );
});
