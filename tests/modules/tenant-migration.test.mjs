import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';

test('legacy single-user state migrates idempotently to a personal organization tenant spine', () => {
  const state = {
    version: 1,
    projects: [{ id: 'project_1', name: 'Convoy', description: '' }],
  };
  migrateControlPlaneState(state, { deploymentId: 'dep_local' });
  const once = structuredClone(state);
  migrateControlPlaneState(state, { deploymentId: 'dep_local' });

  assert.deepEqual(state, once);
  assert.equal(state.version, 2);
  assert.equal(state.identity.users[0].id, 'local');
  assert.equal(state.organizations.organizations[0].id, 'personal');
  assert.equal(state.organizations.memberships[0].roles[0], 'owner');
  assert.equal(state.projects[0].organizationId, 'personal');
  assert.deepEqual(state.providerConnections, []);
  assert.deepEqual(state.environmentAccessBindings, []);
});

test('tenant migration refuses to silently retarget state to another deployment identity', () => {
  const state = {};
  migrateControlPlaneState(state, { deploymentId: 'dep_first' });
  assert.throws(
    () => migrateControlPlaneState(state, { deploymentId: 'dep_other' }),
    /deployment identity changed/i,
  );
});
