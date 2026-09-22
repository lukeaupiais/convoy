import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog } from '../../apps/daemon/src/modules/work/catalog.mjs';

function fixture(externalTickets) {
  const state = {
    projects: [{ id: 'alpha', organizationId: 'org', name: 'Alpha', description: '', revision: 1 }],
    tickets: [], sessions: {},
  };
  let saved = 0;
  const execution = {
    legacyTicketSeeds: () => [], reservedTicketIds: () => [], migratedStatus: () => undefined,
    assertEditable: () => {}, isBusy: () => false, syncTicket: () => {}, projection: () => ({}),
  };
  const catalog = createCatalog({ state, externalTickets, execution, save: async () => { saved++; } });
  return { state, catalog, get saved() { return saved; } };
}

async function setup(catalog) {
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'linear', name: 'Product', teamId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', credentialEnv: 'CONVOY_LINEAR_TOKEN_TEST' });
  const board = await catalog.command({ action: 'saveBoard', name: 'Mixed', projectIds: ['alpha'], columns: [{ id: 'todo', name: 'Todo' }], destinationConnectionIds: [source.id], creationPolicy: { mode: 'convoy' } });
  return { source, board };
}

test('a mixed board creates a local ticket without calling Linear', async () => {
  let calls = 0;
  const { catalog } = fixture({ createIssue: async () => { calls++; } });
  const { board } = await setup(catalog);
  const ticket = await catalog.command({ action: 'createTicket', requestId: 'local-1', boardId: board.id, projectId: 'alpha', title: 'Local' });
  assert.equal(ticket.origin, 'convoy');
  assert.equal(ticket.externalLinks, undefined);
  assert.equal(calls, 0);
});

test('a board must enable a connection before making it a creation destination', async () => {
  const { catalog } = fixture({ createIssue: async () => { throw new Error('should not publish'); } });
  const { source } = await setup(catalog);
  const board = await catalog.command({ action: 'saveBoard', name: 'Not enabled', projectIds: ['alpha'], columns: [{ id: 'todo', name: 'Todo' }] });
  await assert.rejects(catalog.command({ action: 'saveBoard', ...board, revision: board.revision, creationPolicy: { mode: 'connection', connectionId: source.id } }), /enabled as a destination/);
  await assert.rejects(catalog.command({ action: 'createTicket', requestId: 'not-enabled', boardId: board.id, projectId: 'alpha', title: 'No', destination: source.id }), /not enabled/);
});

test('configured creation publishes once and persists identity before returning', async () => {
  let calls = 0;
  const observed = [];
  const externalTickets = { createIssue: async (_source, ticket) => {
    calls++; observed.push(ticket.externalPublish?.state);
    return { remoteId: 'remote-1', remoteKey: 'LIN-1', url: 'https://linear.app/acme/issue/LIN-1' };
  } };
  const { catalog, state } = fixture(externalTickets);
  const { source, board } = await setup(catalog);
  await catalog.command({ action: 'saveBoard', ...board, revision: board.revision, destinationConnectionIds: [source.id], creationPolicy: { mode: 'connection', connectionId: source.id } });
  const input = { action: 'createTicket', requestId: 'published-1', boardId: board.id, projectId: 'alpha', title: 'Published' };
  const first = await catalog.command(input);
  const repeat = await catalog.command(input);
  assert.equal(first.id, repeat.id);
  assert.equal(calls, 1);
  assert.deepEqual(observed, ['pending']);
  assert.equal(state.tickets[0].externalLinks[0].remoteKey, 'LIN-1');
  assert.equal(state.tickets[0].origin, 'convoy');
});

test('uncertain publish is retained and cannot be retried until reconciled', async () => {
  let calls = 0;
  const { catalog } = fixture({ createIssue: async () => { calls++; throw new Error('timeout'); } });
  const { source, board } = await setup(catalog);
  const ticket = await catalog.command({ action: 'createTicket', requestId: 'local-2', boardId: board.id, projectId: 'alpha', title: 'Local' });
  const pending = await catalog.command({ action: 'publishTicket', requestId: 'publish-2', ticketId: ticket.id, revision: ticket.revision, connectionId: source.id });
  assert.equal(pending.externalPublish.state, 'outcome-unknown');
  await assert.rejects(catalog.command({ action: 'publishTicket', requestId: 'retry-2', ticketId: ticket.id, revision: pending.revision, connectionId: source.id }), /reconciliation/);
  assert.equal(calls, 1);
  await catalog.command({ action: 'reconcileTicketPublish', ticketId: ticket.id, revision: pending.revision, confirmNotCreated: true });
  assert.equal(ticket.externalPublish, undefined);
});

test('import preserves remote identity and does not duplicate on repeat', async () => {
  const item = { id: 'remote-3', identifier: 'LIN-3', url: 'https://linear.app/acme/issue/LIN-3', title: 'Remote', description: 'Details' };
  const { catalog, state } = fixture({ listIssues: async () => [item] });
  const { source } = await setup(catalog);
  const first = await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const second = await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  assert.deepEqual(first, { imported: 1, updated: 0 });
  assert.deepEqual(second, { imported: 0, updated: 0 });
  assert.equal(state.tickets.length, 1);
  assert.equal(state.tickets[0].origin, 'external');
  assert.equal(state.tickets[0].externalLinks[0].remoteId, 'remote-3');
});

test('Convoy-owned edits update Linear while imported content remains remote-owned', async () => {
  const updates = [];
  const item = { id: 'remote-4', identifier: 'LIN-4', url: 'https://linear.app/acme/issue/LIN-4', title: 'Remote', description: 'Details' };
  const externalTickets = {
    createIssue: async () => ({ remoteId: 'remote-5', remoteKey: 'LIN-5', url: 'https://linear.app/acme/issue/LIN-5' }),
    updateIssue: async (_source, id, fields) => { updates.push({ id, fields }); return { id, ...fields }; },
    listIssues: async () => [item],
  };
  const { catalog, state } = fixture(externalTickets);
  const { source, board } = await setup(catalog);
  const local = await catalog.command({ action: 'createTicket', requestId: 'local-5', boardId: board.id, projectId: 'alpha', title: 'Local' });
  const published = await catalog.command({ action: 'publishTicket', requestId: 'publish-5', ticketId: local.id, revision: local.revision, connectionId: source.id });
  const changed = await catalog.command({ action: 'updateTicket', taskId: local.id, revision: published.revision, patch: { title: 'Updated' } });
  assert.equal(changed.externalLinks[0].syncState, 'linked');
  assert.deepEqual(updates, [{ id: 'remote-5', fields: { title: 'Updated', description: '' } }]);
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const imported = state.tickets.find(value => value.externalLinks?.[0]?.remoteId === 'remote-4');
  await assert.rejects(catalog.command({ action: 'updateTicket', taskId: imported.id, revision: imported.revision, patch: { title: 'Local edit' } }), /owned by the external source/);
});

test('remote creation identity is checked before linking after an uncertain outcome', async () => {
  const { catalog } = fixture({
    createIssue: async () => { throw new Error('timeout'); },
    getIssue: async () => ({ id: 'remote-6', identifier: 'LIN-6', url: 'https://linear.app/acme/issue/LIN-6', title: 'Local', description: '', team: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } }),
  });
  const { source, board } = await setup(catalog);
  const local = await catalog.command({ action: 'createTicket', requestId: 'local-6', boardId: board.id, projectId: 'alpha', title: 'Local' });
  const uncertain = await catalog.command({ action: 'publishTicket', requestId: 'publish-6', ticketId: local.id, revision: local.revision, connectionId: source.id });
  const linked = await catalog.command({ action: 'reconcileTicketPublish', ticketId: local.id, revision: uncertain.revision, remoteId: 'remote-6' });
  assert.equal(linked.externalPublish, undefined);
  assert.equal(linked.externalLinks[0].remoteKey, 'LIN-6');
});

test('connections can be tested, disabled, and deleted only when unused', async () => {
  const { catalog } = fixture({ probe: async () => ({ teamName: 'Product' }) });
  const { source, board } = await setup(catalog);
  assert.deepEqual(await catalog.command({ action: 'probeTicketConnection', id: source.id }), { teamName: 'Product' });
  const disabled = await catalog.command({ action: 'saveTicketConnection', ...source, enabled: false, revision: source.revision });
  await assert.rejects(catalog.command({ action: 'createTicket', requestId: 'disabled-create', boardId: board.id, projectId: 'alpha', title: 'No', destination: source.id }), /disabled/);
  await assert.rejects(catalog.command({ action: 'deleteTicketConnection', id: source.id, revision: disabled.revision }), /Remove this connection from boards/);
  await catalog.command({ action: 'saveBoard', ...board, revision: board.revision, destinationConnectionIds: [] });
  assert.deepEqual(await catalog.command({ action: 'deleteTicketConnection', id: source.id, revision: disabled.revision }), { id: source.id, deleted: true });
});

test('custom HTTP connections remain provider-neutral and preview without mutation', async () => {
  const remote = [{ remoteId: 'support-1', remoteKey: 'SUP-1', url: 'https://support.example.com/tickets/1', title: 'Customer report', description: 'Details', status: 'Ready', priority: 'High', remoteVersion: 'v1', fieldOwnership: { title: 'external', description: 'external', status: 'external', priority: 'external' } }];
  const { catalog, state } = fixture({ probe: async source => ({ sourceName: source.name, sample: remote[0] }), listIssues: async () => remote });
  const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource', connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TOKEN_TEST' } }, operations: { list: { method: 'GET', path: '/tickets', response: { items: '$.items' } } }, mapping: { remoteId: '$.id', remoteKey: '$.key', title: '$.title', description: '$.description', remoteVersion: '$.updatedAt', url: '$.url' } };
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'custom-http', name: 'Customer support', manifest });
  assert.equal(source.provider, 'custom-http');
  assert.deepEqual(source.capabilities, { import: true, create: false, update: false });
  assert.equal(source.manifest.connection.baseUrl, 'https://support.example.com/api');
  assert.equal((await catalog.command({ action: 'probeTicketConnection', id: source.id })).sample.remoteKey, 'SUP-1');
  const preview = await catalog.command({ action: 'previewExternalTickets', connectionId: source.id, projectId: 'alpha' });
  assert.deepEqual(preview, { wouldImport: 1, wouldUpdate: 0, unchanged: 0, sample: { remoteId: 'support-1', remoteKey: 'SUP-1', title: 'Customer report', description: 'Details' } });
  assert.equal(state.tickets.length, 0);
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  assert.equal(state.tickets[0].title, 'Customer report');
  assert.equal(state.tickets[0].status, 'Ready');
  assert.equal(state.tickets[0].priority, 'High');
  assert.equal(state.tickets[0].externalLinks[0].provider, 'custom-http');
  const board = await catalog.command({ action: 'saveBoard', name: 'Support', projectIds: ['alpha'], columns: [{ id: 'todo', name: 'Todo' }], destinationConnectionIds: [source.id] });
  const local = await catalog.command({ action: 'createTicket', requestId: 'custom-local', boardId: board.id, projectId: 'alpha', title: 'Local' });
  await assert.rejects(catalog.command({ action: 'publishTicket', requestId: 'custom-publish', ticketId: local.id, revision: local.revision, connectionId: source.id }), /read-only/);
  assert.equal(local.externalPublish, undefined);
});
