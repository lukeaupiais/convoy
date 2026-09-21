import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityAudit } from '../../apps/daemon/src/modules/audit/index.mjs';

function fixture() {
  let sequence = 0;
  const state = { securityAuditRecords: [] };
  const audit = createSecurityAudit({
    state,
    deploymentId: 'deployment_test',
    now: () => '2026-09-20T12:00:00.000Z',
    createId: () => `audit_${++sequence}`,
    save: async () => {},
  });
  return { state, audit };
}

test('audit records form an append-only digest chain and redact secret-shaped input', async () => {
  const { state, audit } = fixture();
  const first = await audit.record({
    organizationId: 'org_acme',
    actor: { kind: 'user', userId: 'user_1' },
    context: { teamId: 'team_platform', projectId: 'project_api' },
    action: 'provider.dispatch',
    resource: { kind: 'provider-grant', id: 'grant_1' },
    decision: 'allow',
    outcome: 'completed',
    revisions: {
      policyRevision: 'policy_7',
      routeRevision: 'route_4',
      providerGrantDigest: 'sha256:grant',
    },
    provider: {
      providerId: 'openai-compatible',
      connectionId: 'connection_1',
      modelOfferingId: 'offering_1',
      requestId: 'request_1',
      apiKey: 'sk-must-never-appear',
    },
    observations: {
      usage: { inputTokens: 12, outputTokens: 4, costUsd: 0.01 },
      authorization: 'Bearer must-never-appear',
      nested: { accessToken: 'must-never-appear' },
    },
    traceId: 'trace_1',
  });
  const second = await audit.record({
    organizationId: 'org_acme',
    actor: { kind: 'user', userId: 'user_1' },
    action: 'runner.dispatch',
    resource: { kind: 'assignment', id: 'assignment_1' },
    decision: 'allow',
    outcome: 'started',
  });

  const serialized = JSON.stringify(state.securityAuditRecords);
  assert.equal(serialized.includes('must-never-appear'), false);
  assert.equal(first.redaction.removedFields >= 3, true);
  assert.equal(second.previousDigest, first.digest);
  assert.match(first.digest, /^sha256:/);
  assert.match(second.digest, /^sha256:/);
  assert.equal(Object.isFrozen(first), true);
});

test('audit query and export are tenant scoped, bounded, and secret free', async () => {
  const { audit } = fixture();
  await audit.record({
    organizationId: 'org_acme',
    actor: { kind: 'user', userId: 'user_1' },
    action: 'runtime.command',
    resource: { kind: 'command', id: 'createTicket' },
    decision: 'allow',
    outcome: 'completed',
    correlationId: 'request_acme',
  });
  await audit.record({
    organizationId: 'org_other',
    actor: { kind: 'user', userId: 'user_2' },
    action: 'runtime.command',
    resource: { kind: 'command', id: 'createTicket' },
    decision: 'deny',
    outcome: 'denied',
    correlationId: 'request_other',
  });

  const page = audit.query({ organizationId: 'org_acme', limit: 500 });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].correlationId, 'request_acme');
  assert.throws(() => audit.query({ organizationId: 'org_acme', limit: 501 }), /limit/i);

  const exported = audit.export({ organizationId: 'org_acme', format: 'jsonl' });
  assert.equal(exported.content.includes('request_acme'), true);
  assert.equal(exported.content.includes('request_other'), false);
  assert.equal(exported.content.includes('secret'), false);
});
