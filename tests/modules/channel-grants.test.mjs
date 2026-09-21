import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChannelGrants,
  createRunnerChannelAuthorization,
} from '../../apps/daemon/src/modules/execution/index.mjs';

function fixture() {
  let clock = new Date('2026-09-20T12:00:00.000Z');
  const session = {
    id: 'chat-11111111-1111-1111-1111-111111111111',
    projectId: 'project-a',
    runnerId: 'runner-a',
    workspace: { path: '/work/a', branch: 'work' },
    lease: { id: 'lease-a', client: 'cli', label: 'CLI', expiresAt: clock.getTime() + 90_000 },
    executionGrant: { digest: 'grant-digest-a' },
    assignment: { environmentId: 'environment-a', policyDigest: 'grant-digest-a' },
  };
  const state = {
    sessions: { [session.id]: session },
    runners: [
      {
        id: 'runner-a',
        organizationId: 'org-a',
        environmentId: 'environment-a',
        projectIds: ['project-a'],
      },
    ],
  };
  const grants = createChannelGrants({
    state,
    catalog: {
      project(id) {
        if (id !== 'project-a') throw new Error('Project not found.');
        return { id, organizationId: 'org-a' };
      },
    },
    save: async () => {},
    now: () => clock,
  });
  return {
    grants,
    session,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const actor = { kind: 'user', userId: 'user-a' };

test('terminal grant is secret-once and validates every bound channel field', async () => {
  const { grants, session } = fixture();
  const issued = await grants.issue({
    actor,
    session,
    audience: 'terminal',
    terminalId: 'terminal-a',
    permissions: ['attach', 'input', 'resize'],
  });
  assert.match(issued.token, /^chn_/);
  assert.equal('tokenDigest' in issued.grant, false);
  assert.equal(JSON.stringify(grants.list('org-a')).includes(issued.token), false);

  const expected = {
    audience: 'terminal',
    organizationId: 'org-a',
    projectId: 'project-a',
    sessionId: session.id,
    runnerId: 'runner-a',
    environmentId: 'environment-a',
    workspace: '/work/a',
    leaseId: 'lease-a',
    executionGrantDigest: 'grant-digest-a',
    terminalId: 'terminal-a',
  };
  assert.equal(grants.validate(issued.token, expected).id, issued.grant.id);
  assert.throws(
    () => grants.validate(issued.token, { ...expected, organizationId: 'org-b' }),
    /invalid/i,
  );
  assert.throws(
    () => grants.validate(issued.token, { ...expected, workspace: '/work/substitute' }),
    /invalid/i,
  );
});

test('runner channel authorization requires matching machine and channel identities', () => {
  const authorized = createRunnerChannelAuthorization({
    enrollment: {
      authenticate(_credential, expected) {
        return {
          principal: {
            runnerId: 'runner-a',
            organizationId: 'org-a',
            environmentId: 'environment-a',
          },
        };
      },
    },
    channelGrants: {
      validate(_token, expected) {
        return {
          id: 'grant-a',
          organizationId: 'org-a',
          environmentId: 'environment-a',
          ...expected,
        };
      },
    },
  });
  assert.equal(
    authorized.validate({
      machineCredential: 'rnr_machine',
      channelToken: 'chn_channel',
      expected: {
        audience: 'direct-channel',
        runnerId: 'runner-a',
        organizationId: 'org-a',
        environmentId: 'environment-a',
      },
    }).grant.id,
    'grant-a',
  );
  assert.throws(
    () =>
      authorized.validate({
        machineCredential: 'rnr_machine',
        channelToken: 'chn_channel',
        expected: { audience: 'direct-channel', runnerId: 'runner-b' },
      }),
    /invalid/i,
  );
});

test('channel grant expiry, renewal and revocation fail closed', async () => {
  const { grants, session, advance } = fixture();
  const first = await grants.issue({
    actor,
    session,
    audience: 'direct-channel',
    expiresInSeconds: 30,
  });
  const renewed = await grants.renew({
    id: first.grant.id,
    revision: first.grant.revision,
    actor,
    session,
    expiresInSeconds: 60,
  });
  assert.notEqual(renewed.token, first.token);
  assert.throws(() => grants.validate(first.token, { audience: 'direct-channel' }), /invalid/i);
  assert.equal(grants.validate(renewed.token, { audience: 'direct-channel' }).revision, 2);

  await grants.revoke(renewed.grant.id, 'org-a', renewed.grant.revision, actor);
  assert.throws(() => grants.validate(renewed.token, { audience: 'direct-channel' }), /invalid/i);

  const expiring = await grants.issue({
    actor,
    session,
    audience: 'terminal',
    terminalId: 'terminal-b',
    expiresInSeconds: 30,
  });
  advance(31_000);
  assert.throws(() => grants.validate(expiring.token, { audience: 'terminal' }), /expired/i);
});
