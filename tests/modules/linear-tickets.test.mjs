import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinearTickets } from '../../apps/daemon/src/adapters/linear-tickets.mjs';

test('Linear adapter uses only the configured credential and checks GraphQL errors', async () => {
  const env = 'CONVOY_LINEAR_TOKEN_ADAPTER_TEST';
  const previous = process.env[env];
  process.env[env] = 'fixture-secret';
  try {
    const calls = [];
    const connection = { teamId: 'team-1', credentialEnv: env };
    const adapter = createLinearTickets({ fetcher: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ data: { issueCreate: { success: true, issue: { id: 'remote-1', identifier: 'LIN-1', url: 'https://linear.app/acme/issue/LIN-1' } } } }) };
    } });
    const created = await adapter.createIssue(connection, { title: 'Title', description: 'Body' });
    assert.equal(created.remoteKey, 'LIN-1');
    assert.equal(calls[0].url, 'https://api.linear.app/graphql');
    assert.equal(calls[0].init.headers.Authorization, 'fixture-secret');
    assert.equal(JSON.parse(calls[0].init.body).variables.input.teamId, 'team-1');
    const rejected = createLinearTickets({ fetcher: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'Denied' }] }) }) });
    await assert.rejects(rejected.createIssue(connection, { title: 'No', description: '' }), /Linear rejected/);
  } finally {
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  }
});
