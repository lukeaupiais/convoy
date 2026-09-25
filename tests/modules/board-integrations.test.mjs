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

test('an external reply has durable identity and uncertain outcomes require reconciliation', async () => {
  let sends = 0;
  const comments = [{ remoteId: 'reply-2', body: 'A second reply', authorRole: 'dev', createdAt: '2026-09-23T12:00:00Z' }];
  const { catalog, state } = fixture({
    listIssues: async () => [{ remoteId: 'case-9', remoteKey: 'CASE-9', title: 'Question', description: 'Need help', remoteVersion: 'v1' }],
    postReply: async (_source, _remoteId, body, requestId) => {
      sends++;
      if (requestId === 'uncertain') throw new Error('transport lost');
      assert.equal(body, 'We are checking.');
      comments.push({ remoteId: 'reply-1', body, authorRole: 'dev', createdAt: '2026-09-23T12:01:00Z', deliveryStatus: 'delivered' });
      return { remoteId: 'reply-1', deliveryStatus: 'pending' };
    },
    listComments: async () => comments,
  });
  const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
    connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_READ_TEST' }, writeAuthentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_WRITE_TEST' } },
    operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } },
      thread: { method: 'GET', path: 'tickets/${remoteId}/comments', response: { items: '$.items' } },
      reply: { method: 'POST', path: 'tickets/${remoteId}/comments', response: { commentId: '$.commentId' } } },
    mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.title', remoteVersion: '$.version' },
    threadMapping: { id: '$.id', body: '$.body', authorRole: '$.role', createdAt: '$.createdAt' } };
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'custom-http', name: 'Support', manifest });
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const ticketId = state.tickets[0].id;
  const send = (requestId, body) => catalog.command({ action: 'postExternalTicketReply', requestId, ticketId, connectionId: source.id, body });
  assert.equal((await send('reply-1', 'We are checking.')).remoteId, 'reply-1');
  assert.equal((await send('reply-1', 'We are checking.')).status, 'queued');
  assert.equal(state.ticketReplies.find(value => value.id === 'reply-1').deliveryStatus, 'pending');
  await catalog.command({ action: 'syncExternalTicketThread', ticketId, connectionId: source.id });
  assert.equal(state.ticketReplies.find(value => value.id === 'reply-1').deliveryStatus, 'delivered');
  assert.equal(sends, 1);
  await assert.rejects(send('reply-1', 'Changed text'), /different reply/);
  await assert.rejects(send('uncertain', 'A second reply'), /transport lost/);
  assert.equal(state.ticketReplies.find(value => value.id === 'uncertain').status, 'outcome-unknown');
  await assert.rejects(send('uncertain', 'A second reply'), /reconciliation/);
  assert.equal(sends, 2);
  const reconciled = await catalog.command({ action: 'reconcileExternalTicketReply', requestId: 'uncertain', remoteId: 'reply-2' });
  assert.equal(reconciled.status, 'queued');
  assert.equal(reconciled.remoteId, 'reply-2');
});

test('source status follows a delivered reply and is idempotent on the ticket projection', async () => {
  let writes = 0;
  let delivered = false;
  const { catalog, state } = fixture({
    listIssues: async () => [{ remoteId: '41', remoteKey: 'SUP-41', title: 'Question', status: 'Open', rawStatus: 'open', remoteVersion: '4' }],
    postReply: async () => ({ remoteId: '12', deliveryStatus: 'pending' }),
    listComments: async () => [{ remoteId: '12', body: 'Please clarify', authorRole: 'team', createdAt: '2026-09-24T12:00:00Z', deliveryStatus: delivered ? 'delivered' : 'pending' }],
    setStatus: async (_source, _remoteId, input) => {
      writes++;
      assert.deepEqual(input, { status: 'waiting', remoteVersion: '4', evidenceMessageId: '12', requestId: 'status-41' });
      return { remoteId: '41', rawStatus: 'waiting', status: 'Waiting', remoteVersion: '5' };
    },
  });
  const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
    connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_READ_TEST' },
      writeAuthentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_WRITE_TEST' } },
    operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } },
      thread: { method: 'GET', path: 'tickets/${remoteId}/comments', response: { items: '$.items' } },
      reply: { method: 'POST', path: 'tickets/${remoteId}/comments', response: { commentId: '$.commentId' } },
      status: { method: 'PATCH', path: 'tickets/${remoteId}/status', request: { status: 'status', remoteVersion: 'expectedRevision', evidenceMessageId: 'replyId' }, response: { item: '$.ticket' } } },
    mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.title', status: '$.status', remoteVersion: '$.revision' },
    threadMapping: { id: '$.id', body: '$.body', authorRole: '$.role', createdAt: '$.createdAt', deliveryStatus: '$.delivery' } };
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'custom-http', name: 'Support', manifest });
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const ticketId = state.tickets[0].id;
  await catalog.command({ action: 'postExternalTicketReply', requestId: 'reply-41', ticketId, connectionId: source.id, body: 'Please clarify' });
  const status = () => catalog.command({ action: 'setExternalTicketStatus', requestId: 'status-41', ticketId, connectionId: source.id, status: 'waiting', evidenceReplyRequestId: 'reply-41' });
  await assert.rejects(status(), /not confirmed delivered/);
  assert.equal(writes, 0);
  delivered = true;
  assert.equal((await status()).state, 'applied');
  assert.equal(state.tickets[0].status, 'Waiting');
  assert.equal(state.tickets[0].externalLinks[0].remoteVersion, '5');
  assert.equal((await status()).state, 'applied');
  assert.equal(writes, 1);
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

test('one project uses source membership and work type to feed separate boards', async () => {
  const page = [{ id: 'remote-10', identifier: 'SUP-10', url: 'https://linear.app/issue/SUP-10', title: 'Customer report' }];
  const { catalog, state } = fixture({ listIssuesPage: async () => ({ items: page }) });
  const { source } = await setup(catalog);
  const binding = await catalog.command({ action: 'saveTicketImportBinding', connectionId: source.id, projectId: 'alpha', name: 'Support queue', workType: 'support' });
  const support = await catalog.command({ action: 'saveBoard', name: 'Support', projectIds: ['alpha'], columns: [{ id: 'open', name: 'Open' }], filters: { workTypes: ['support'], importBindingIds: [binding.id] } });
  const triage = await catalog.command({ action: 'saveBoard', name: 'Triage', projectIds: ['alpha'], columns: [{ id: 'inbox', name: 'Inbox' }], filters: { workTypes: ['support'] } });
  const development = await catalog.command({ action: 'saveBoard', name: 'Development', projectIds: ['alpha'], columns: [{ id: 'backlog', name: 'Backlog' }], filters: { workTypes: ['development'] }, creationWorkType: 'development' });
  assert.equal(catalog.boards.visibleTickets(support).length, 0);
  assert.deepEqual(await catalog.command({ action: 'syncTicketImportBinding', id: binding.id }), { imported: 1, updated: 0, complete: true, pages: 1 });
  const imported = state.tickets[0];
  assert.equal(imported.workType, 'support');
  assert.equal(catalog.boards.visibleTickets(support).length, 1);
  assert.equal(catalog.boards.visibleTickets(triage)[0].id, imported.id);
  assert.equal(catalog.boards.visibleTickets(development).length, 0);
  const dev = await catalog.command({ action: 'createRelatedTicket', requestId: 'dev-10', sourceTicketId: imported.id, sourceRevision: imported.revision, boardId: development.id, title: 'Fix report' });
  assert.equal(dev.workType, 'development');
  assert.equal(catalog.boards.visibleTickets(development).length, 1);
  assert.equal(catalog.boards.visibleTickets(support).length, 1);
  assert.equal(state.ticketRelations[0].sourceTicketId, imported.id);
  assert.deepEqual(await catalog.command({ action: 'syncTicketImportBinding', id: binding.id }), { imported: 0, updated: 0, complete: true, pages: 1 });
  assert.equal(state.tickets.length, 2);
});

test('paged binding resumes after failure and prunes membership only after a complete scan', async () => {
  let fail = true;
  const issue = (id) => ({ id, identifier: id, url: `https://linear.app/issue/${id}`, title: id });
  const pages = { start: { items: [issue('SUP-1')], nextCursor: 'next' }, next: { items: [issue('SUP-2')] } };
  const { catalog, state } = fixture({ listIssuesPage: async (_source, _limit, cursor) => {
    if (cursor === 'next' && fail) throw new Error('temporary outage');
    return pages[cursor ?? 'start'];
  } });
  const { source } = await setup(catalog);
  const binding = await catalog.command({ action: 'saveTicketImportBinding', connectionId: source.id, projectId: 'alpha', name: 'Queue', workType: 'support' });
  await assert.rejects(catalog.command({ action: 'syncTicketImportBinding', id: binding.id }), /temporary outage/);
  assert.equal(state.ticketImportBindings[0].cursor, 'next');
  assert.equal(state.ticketImportMemberships.length, 1);
  fail = false;
  assert.deepEqual(await catalog.command({ action: 'syncTicketImportBinding', id: binding.id }), { imported: 1, updated: 0, complete: true, pages: 1 });
  assert.equal(state.ticketImportMemberships.length, 2);
  pages.start = { items: [issue('SUP-2')] };
  await catalog.command({ action: 'syncTicketImportBinding', id: binding.id });
  assert.equal(state.ticketImportMemberships.length, 1);
  assert.equal(state.tickets.length, 2);
});

test('binding refuses to move an already linked remote issue to another project', async () => {
  const item = { id: 'remote-20', identifier: 'SUP-20', url: 'https://linear.app/issue/SUP-20', title: 'Report' };
  const { catalog, state } = fixture({ listIssues: async () => [item] });
  const { source } = await setup(catalog);
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  state.projects.push({ id: 'beta', organizationId: 'org', name: 'Beta', revision: 1 });
  await assert.rejects(catalog.command({ action: 'saveTicketImportBinding', connectionId: source.id, projectId: 'beta', name: 'Wrong', workType: 'support' }), /another project/);
  assert.equal(state.tickets[0].projectId, 'alpha');
});

test('import binding respects a source-filtered board WIP limit atomically', async () => {
  const issue = (id) => ({ id, identifier: id, url: `https://linear.app/issue/${id}`, title: id });
  const { catalog, state } = fixture({ listIssuesPage: async () => ({ items: [issue('SUP-1'), issue('SUP-2')] }) });
  const { source } = await setup(catalog);
  const binding = await catalog.command({ action: 'saveTicketImportBinding', connectionId: source.id, projectId: 'alpha', name: 'Queue', workType: 'support' });
  await catalog.command({ action: 'saveBoard', name: 'Capped queue', projectIds: ['alpha'], filters: { importBindingIds: [binding.id] }, columns: [{ id: 'open', name: 'Open', wipLimit: 1 }] });
  await assert.rejects(catalog.command({ action: 'syncTicketImportBinding', id: binding.id }), /WIP limit/);
  assert.equal(state.tickets.length, 0);
  assert.equal(state.ticketImportMemberships.length, 0);
  assert.equal(state.ticketImportBindings[0].cursor, undefined);
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
  const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource', connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TOKEN_TEST' } }, operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } } }, mapping: { remoteId: '$.id', remoteKey: '$.key', title: '$.title', description: '$.description', remoteVersion: '$.updatedAt', url: '$.url' } };
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'custom-http', name: 'Customer support', manifest });
  assert.equal(source.provider, 'custom-http');
  assert.deepEqual(source.capabilities, { import: true, create: false, update: false, threadRead: false, reply: false, statusWrite: false });
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

test('an import rejects duplicate remote identities atomically', async () => {
  const duplicate = { remoteId: 'same', remoteKey: 'SUP-1', title: 'One', description: '', remoteVersion: 'v1' };
  const f = fixture({ listIssues: async () => [duplicate, { ...duplicate, title: 'Two' }] });
  const { source } = await setup(f.catalog);
  const savesBeforeImport = f.saved;
  await assert.rejects(
    f.catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' }),
    /duplicate remote identity: same/,
  );
  assert.equal(f.state.tickets.length, 0);
  assert.equal(f.saved, savesBeforeImport);
});

test('reconciliation preserves Convoy-owned status and priority while recording remote observations', async () => {
  let version = 1;
  const remote = () => [{
    remoteId: 'support-owned', remoteKey: 'SUP-OWNED', title: 'Remote', description: '',
    status: version === 1 ? 'Backlog' : 'Done', priority: version === 1 ? 'Low' : 'High',
    remoteVersion: `v${version}`,
    fieldOwnership: { title: 'external', description: 'external', status: 'convoy', priority: 'convoy' },
  }];
  const { catalog, state } = fixture({ listIssues: async () => remote() });
  const { source } = await setup(catalog);
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const ticket = state.tickets[0];
  ticket.status = 'In progress';
  ticket.priority = 'Medium';
  version = 2;
  assert.deepEqual(
    await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' }),
    { imported: 0, updated: 1 },
  );
  assert.equal(ticket.status, 'In progress');
  assert.equal(ticket.priority, 'Medium');
  assert.equal(ticket.externalLinks[0].remoteStatus, 'Done');
  assert.equal(ticket.externalLinks[0].remotePriority, 'High');
});

test('list-only conflict resolution applies every observed external-owned field and rejects local resolution', async () => {
  let current = {
    remoteId: 'support-conflict', remoteKey: 'SUP-CONFLICT', title: 'First', description: 'First details',
    status: 'Backlog', priority: 'Low', remoteVersion: 'v1',
    fieldOwnership: { title: 'external', description: 'external', status: 'external', priority: 'external' },
  };
  const { catalog, state } = fixture({ listIssues: async () => [current] });
  const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource', connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TOKEN_TEST' } }, operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } } }, mapping: { remoteId: '$.id', remoteKey: '$.key', title: '$.title', remoteVersion: '$.version' } };
  const source = await catalog.command({ action: 'saveTicketConnection', organizationId: 'org', provider: 'custom-http', name: 'Support source', manifest });
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  const ticket = state.tickets[0];
  ticket.title = 'Local edit';
  ticket.status = 'Ready';
  current = { ...current, title: 'Remote edit', description: 'Remote details', status: 'Done', priority: 'High', remoteVersion: 'v2' };
  await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' });
  assert.equal(ticket.externalLinks[0].syncState, 'error');
  await assert.rejects(
    catalog.command({ action: 'syncExternalTicket', ticketId: ticket.id, revision: ticket.revision, connectionId: source.id, resolution: 'local' }),
    /read-only/,
  );
  await catalog.command({ action: 'syncExternalTicket', ticketId: ticket.id, revision: ticket.revision, connectionId: source.id, resolution: 'remote' });
  assert.deepEqual(
    { title: ticket.title, description: ticket.description, status: ticket.status, priority: ticket.priority },
    { title: 'Remote edit', description: 'Remote details', status: 'Done', priority: 'High' },
  );
  assert.equal(ticket.externalLinks[0].remoteVersion, 'v2');
  assert.equal(ticket.externalLinks[0].syncState, 'linked');
});

test('first import after adding status observations establishes a baseline without overwriting legacy local values', async () => {
  const remote = { remoteId: 'legacy', remoteKey: 'LEG-1', title: 'Remote', description: '', status: 'Done', priority: 'High', remoteVersion: 'v1' };
  const { catalog, state } = fixture({ listIssues: async () => [remote] });
  const { source } = await setup(catalog);
  state.tickets.push({
    id: 1, projectId: 'alpha', title: 'Remote', description: '', status: 'In progress', priority: 'Low',
    label: 'Core', agent: 'Unassigned', revision: 1, origin: 'external', placement: { mode: 'inherit' }, executionProfile: 'inherit',
    externalLinks: [{ connectionId: source.id, provider: 'linear', remoteId: 'legacy', remoteKey: 'LEG-1', url: 'https://linear.app/issue/LEG-1', syncState: 'linked', remoteTitle: 'Remote', remoteDescription: '', remoteVersion: 'v1', fieldOwnership: { title: 'external', description: 'external' } }],
  });
  assert.deepEqual(await catalog.command({ action: 'importExternalTickets', connectionId: source.id, projectId: 'alpha' }), { imported: 0, updated: 0 });
  assert.equal(state.tickets[0].status, 'In progress');
  assert.equal(state.tickets[0].priority, 'Low');
  assert.equal(state.tickets[0].externalLinks[0].remoteStatus, 'Done');
  assert.equal(state.tickets[0].externalLinks[0].remotePriority, 'High');
});
