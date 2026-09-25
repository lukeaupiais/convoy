import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { normalizeWorkflow, createWorkflowEngine } from '../../apps/daemon/src/modules/workflows/workflows.mjs';
import { createCustomTicketSource } from '../../apps/daemon/src/adapters/custom-ticket-source.mjs';
import { createTicketSources } from '../../apps/daemon/src/adapters/ticket-sources.mjs';
async function until(read) {
    for (let i = 0; i < 300; i++) {
        const result = await read();
        if (result)
            return result;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Acceptance condition did not become true');
}
async function fixture(t, injected = {}) {
    const options = {
        directory: await mkdtemp(join(tmpdir(), 'convoy-independent-acceptance-')),
        models: [{ id: 'fixture' }],
        auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
        generate: async function* () { throw new Error('Acceptance fixture must not invoke an agent'); },
        ...injected,
    };
    let runtime = await createRuntime(options);
    t.after(() => runtime.close());
    return {
        act: (action, input = {}) => runtime.command({ action, client: 'acceptance-client', ...input }),
        snapshot: () => runtime.snapshot(),
        restart: async () => { await runtime.close(); runtime = await createRuntime(options); },
        restartLegacy: async (mutate) => {
            await runtime.close();
            const path = join(options.directory, 'state.json');
            const state = JSON.parse(await readFile(path, 'utf8'));
            mutate(state);
            await writeFile(path, JSON.stringify(state));
            runtime = await createRuntime(options);
        },
    };
}
test('acceptance: a board can mix local and Linear tickets without publishing local creation', async (t) => {
    let creates = 0;
    const f = await fixture(t, { externalTickets: {
            createIssue: async () => { creates++; return { remoteId: 'linear-1', remoteKey: 'LIN-1', url: 'https://linear.app/acme/issue/LIN-1' }; },
            listIssues: async () => [{ id: 'linear-2', identifier: 'LIN-2', url: 'https://linear.app/acme/issue/LIN-2', title: 'Imported', description: '' }],
            probe: async () => ({ teamName: 'Product' }),
        } });
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'linear', name: 'Product', teamId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', credentialEnv: 'CONVOY_LINEAR_TOKEN_TEST' });
    assert.equal((await f.act('probeTicketConnection', { id: source.id })).teamName, 'Product');
    const board = await f.act('saveBoard', { name: 'Mixed', projectIds: ['agent-platform'], columns: [{ id: 'todo', name: 'Todo' }], destinationConnectionIds: [source.id], creationPolicy: { mode: 'convoy' } });
    await f.act('importExternalTickets', { connectionId: source.id, projectId: 'agent-platform' });
    const local = await f.act('createTicket', { requestId: 'local-mixed', boardId: board.id, projectId: 'agent-platform', title: 'Local' });
    assert.equal(creates, 0);
    await f.restart();
    const state = await f.snapshot();
    assert.equal(state.ticketConnections.length, 1);
    assert.equal(state.tickets.find(value => value.id === local.id).externalLinks, undefined);
    assert.equal(state.tickets.find(value => value.title === 'Imported').externalLinks[0].remoteKey, 'LIN-2');
    assert.equal(state.boards.find(value => value.id === board.id).tickets.length, 2);
    const disabled = await f.act('saveTicketConnection', { ...source, revision: source.revision, enabled: false });
    assert.equal(disabled.enabled, false);
    await assert.rejects(f.act('deleteTicketConnection', { id: source.id, revision: disabled.revision }), /Remove this connection from boards/);
});
test('acceptance: one project has independent imported and development boards across restart', async (t) => {
    const issue = { id: 'case-1', identifier: 'CASE-1', url: 'https://linear.app/issue/CASE-1', title: 'Reported problem' };
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: { listIssuesPage: async () => ({ items: [issue] }) } });
    const project = await f.act('saveProject', { name: 'Product' });
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'linear', name: 'Cases', teamId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', credentialEnv: 'CONVOY_LINEAR_TOKEN_TEST' });
    const binding = await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Cases', workType: 'support' });
    const support = await f.act('saveBoard', { name: 'Support', projectIds: [project.id], filters: { workTypes: ['support'], importBindingIds: [binding.id] }, columns: [{ id: 'open', name: 'Open' }] });
    const development = await f.act('saveBoard', { name: 'Development', projectIds: [project.id], filters: { workTypes: ['development'] }, creationWorkType: 'development', columns: [{ id: 'backlog', name: 'Backlog' }] });
    assert.equal((await f.snapshot()).boards.find(value => value.id === support.id).tickets.length, 0);
    assert.deepEqual(await f.act('syncTicketImportBinding', { id: binding.id }), { imported: 1, updated: 0, complete: true, pages: 1 });
    let snapshot = await f.snapshot();
    const report = snapshot.tickets.find(value => value.projectId === project.id);
    await f.act('createRelatedTicket', { requestId: 'case-1-dev', sourceTicketId: report.id, sourceRevision: report.revision, boardId: development.id, title: 'Fix problem' });
    await f.restart();
    snapshot = await f.snapshot();
    assert.equal(snapshot.ticketImportBindings.length, 1);
    assert.equal(snapshot.ticketImportMemberships.length, 1);
    assert.equal(snapshot.boards.find(value => value.id === support.id).tickets.length, 1);
    assert.equal(snapshot.boards.find(value => value.id === development.id).tickets.length, 1);
    assert.equal(snapshot.ticketRelations.length, 1);
    assert.equal(snapshot.tickets.filter(value => value.projectId === project.id).length, 2);
});
test('acceptance: project-defined boards and ticket relations survive restart', async (t) => {
    const f = await fixture(t, { persistenceBackend: 'sqlite' });
    const project = await f.act('saveProject', { name: 'Editorial' });
    const incoming = await f.act('saveBoard', {
        name: 'Incoming', projectIds: [project.id], filters: { workTypes: ['request'] },
        creationWorkType: 'request', grouping: { mode: 'field', field: 'status' },
        columns: [{ id: 'requested', name: 'Requested', value: 'Requested' }],
    });
    const production = await f.act('saveBoard', {
        name: 'Production', projectIds: [project.id], filters: { workTypes: ['article'] },
        creationWorkType: 'article', grouping: { mode: 'field', field: 'status' },
        columns: [{ id: 'drafting', name: 'Drafting', value: 'Drafting' }, { id: 'published', name: 'Published', value: 'Published' }],
    });
    const request = await f.act('createTicket', { requestId: 'editorial-request', projectId: project.id, boardId: incoming.id, title: 'Profile a researcher', status: 'Requested' });
    await assert.rejects(f.act('createRelatedTicket', { requestId: 'invalid-relation', sourceTicketId: request.id, sourceRevision: request.revision, title: 'Invalid', kind: 'bad kind' }), /Relation kind/);
    assert.equal((await f.snapshot()).tickets.filter(value => value.projectId === project.id).length, 1);
    const article = await f.act('createRelatedTicket', { requestId: 'editorial-article', sourceTicketId: request.id, sourceRevision: request.revision, title: 'Researcher profile', boardId: production.id, kind: 'fulfills' });
    assert.equal(article.workType, 'article');
    assert.equal(article.status, 'Drafting');
    await assert.rejects(f.act('createRelatedTicket', { requestId: 'editorial-cross-project', sourceTicketId: request.id, sourceRevision: request.revision + 1, title: 'Wrong board', boardId: 'default-board' }), /Not authorized|Project is not available/);
    await f.restart();
    const state = await f.snapshot();
    assert.equal(state.boards.find(value => value.id === incoming.id).tickets.length, 1);
    assert.equal(state.boards.find(value => value.id === production.id).tickets.length, 1);
    assert.deepEqual(state.ticketRelations.map(value => ({ source: value.sourceTicketId, target: value.targetTicketId, kind: value.kind })), [{ source: request.id, target: article.id, kind: 'fulfills' }]);
    const relation = state.ticketRelations[0];
    await f.act('unlinkTickets', { relationId: relation.id, sourceRevision: state.tickets.find(value => value.id === request.id).revision });
    assert.equal((await f.snapshot()).ticketRelations.length, 0);
});
test('acceptance: a workflow creates project-defined related work', async (t) => {
    const f = await fixture(t, { persistenceBackend: 'sqlite' });
    const project = await f.act('saveProject', { name: 'Editorial workflow' });
    const board = await f.act('saveBoard', {
        name: 'Production', projectIds: [project.id], filters: { workTypes: ['article'] },
        creationWorkType: 'article', grouping: { mode: 'field', field: 'status' },
        columns: [{ id: 'drafting', name: 'Drafting', value: 'Drafting' }, { id: 'published', name: 'Published', value: 'Published' }],
    });
    const request = await f.act('createTicket', { requestId: 'editorial-flow-request', projectId: project.id, title: 'Write a profile' });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    await f.act('saveWorkflow', { projectId: project.id, workflow: { id: 'editorial-review', name: 'Editorial review', nodes: [
                { id: 'approve', kind: 'human', name: 'Approve profile', prompt: 'Review the request.' },
                { id: 'create', kind: 'action', name: 'Create article', operation: 'create_related_ticket', input: { title: 'Researcher profile', boardId: board.id, kind: 'fulfills' } },
                { id: 'wait', kind: 'wait', name: 'Wait for publication', prompt: 'Wait for the article.', waitFor: { event: 'ticket_updated', ticketSource: 'related_ticket', relationKind: 'fulfills', status: 'Published' } },
                { id: 'release', kind: 'human', name: 'Review publication', prompt: 'Review the published article.' },
            ], edges: [{ from: 'approve', to: 'create', outcome: 'approved' }, { from: 'create', to: 'wait', outcome: 'success' }, { from: 'wait', to: 'release', outcome: 'success' }] } });
    await f.act('runTicket', { requestId: 'editorial-flow-run', ticketId: request.id, revision: request.revision, workflowId: 'editorial-review', workflowVersion: 1, model: 'fixture', mode: 'new' });
    let state = await f.snapshot();
    const session = state.sessions.find(value => value.activeTicketId === request.id);
    assert.equal(session.flow.status, 'waiting_gate');
    await f.act('claim', { sessionId: session.id });
    await f.act('approveGate', { sessionId: session.id, instance: session.flow.instance });
    state = await until(async () => { const snapshot = await f.snapshot(); return snapshot.ticketRelations?.length === 1 ? snapshot : null; });
    assert.equal(state.ticketRelations[0].kind, 'fulfills');
    const article = state.tickets.find(value => value.id === state.ticketRelations[0].targetTicketId);
    assert.equal(article.status, 'Drafting');
    assert.equal(state.sessions.find(value => value.id === session.id).flow.status, 'waiting_event');
    await f.act('updateTicket', { taskId: article.id, revision: article.revision, patch: { status: 'Published' } });
    state = await f.snapshot();
    assert.equal(state.sessions.find(value => value.id === session.id).flow.nodeId, 'release');
    assert.equal(state.sessions.find(value => value.id === session.id).flow.status, 'waiting_gate');
    await f.restart();
    assert.equal((await f.snapshot()).ticketRelations.length, 1);
});
test('acceptance: an enabled import binding polls without an operator command', async (t) => {
    let calls = 0;
    const f = await fixture(t, { externalTickets: {
            listIssuesPage: async () => { calls++; return { items: [{ id: 'case-poll', identifier: 'CASE-POLL', title: 'Polled report' }] }; },
        } });
    const project = await f.act('saveProject', { name: 'Polling project' });
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'linear', name: 'Polling source', teamId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', credentialEnv: 'CONVOY_LINEAR_TOKEN_TEST' });
    await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Polling', workType: 'support', pollIntervalMinutes: 1 });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !(await f.snapshot()).tickets.some(ticket => ticket.title === 'Polled report'))
        await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await f.snapshot()).tickets.some(ticket => ticket.title === 'Polled report'), true);
    assert.equal(calls, 1);
});
test('acceptance: imported support starts once and approved escalation starts linked development work', async (t) => {
    const issue = { id: 'case-2', identifier: 'CASE-2', url: 'https://linear.app/issue/CASE-2', title: 'Customer report', description: 'Observed failure', updatedAt: '2026-09-23T00:00:00Z' };
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: { listIssuesPage: async () => ({ items: [issue] }) } });
    const project = await f.act('saveProject', { name: 'Another product' });
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'linear', name: 'Cases', teamId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', credentialEnv: 'CONVOY_LINEAR_TOKEN_TEST' });
    const binding = await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Cases', workType: 'support' });
    await f.act('saveBoard', { name: 'Support', projectIds: [project.id], filters: { workTypes: ['support'], importBindingIds: [binding.id] }, columns: [{ id: 'open', name: 'Open' }] });
    const developmentBoard = await f.act('saveBoard', { name: 'Development', projectIds: [project.id], filters: { workTypes: ['development'] }, creationWorkType: 'development', columns: [{ id: 'backlog', name: 'Backlog' }] });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    await f.act('saveWorkflow', { workflow: { id: 'support-review', name: 'Support review', nodes: [
                { id: 'approve', name: 'Approve escalation', kind: 'human', prompt: 'Review evidence.' },
                { id: 'escalate', name: 'Create development work', kind: 'action', operation: 'create_related_ticket', input: { title: 'Follow-up', description: 'Observed failure', boardId: developmentBoard.id, kind: 'escalation' } },
            ], edges: [{ from: 'approve', to: 'escalate', outcome: 'approved' }] } });
    await f.act('saveWorkflow', { workflow: { id: 'development-review', name: 'Development review', nodes: [{ id: 'review', name: 'Review development', kind: 'human', prompt: 'Review scope.' }] } });
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Imported cases', projectId: project.id, enabled: true,
            when: { event: 'ticket_imported', bindingId: binding.id },
            if: [],
            then: { action: "start_workflow", workflowId: 'support-review', workflowVersion: 1 }
        } });
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'New development', projectId: project.id, enabled: true,
            when: { event: 'ticket_created' },
            if: [],
            then: { action: "start_workflow", workflowId: 'development-review', workflowVersion: 1 }
        } });
    await f.act('syncTicketImportBinding', { id: binding.id });
    let state = await until(async () => { const snapshot = await f.snapshot(); return snapshot.sessions && Object.values(snapshot.sessions).some(value => value.flow?.workflowId === 'support-review') ? snapshot : null; });
    const support = state.tickets.find(value => value.projectId === project.id && value.workType === 'support');
    const session = Object.values(state.sessions).find(value => value.flow?.workflowId === 'support-review');
    assert.equal(session.flow.status, 'waiting_gate');
    await f.act('claim', { sessionId: session.id });
    await f.act('approveGate', { sessionId: session.id, instance: session.flow.instance });
    state = await until(async () => { const snapshot = await f.snapshot(); return snapshot.ticketRelations?.length === 1 ? snapshot : null; });
    const development = state.tickets.find(value => value.workType === 'development' && value.projectId === project.id);
    assert.equal(state.ticketRelations[0].sourceTicketId, support.id);
    assert.equal(state.ticketRelations[0].targetTicketId, development.id);
    assert.equal(development.description.includes('Observed failure'), true);
    assert.equal(Object.values(state.sessions).some(value => value.activeTicketId === development.id && value.flow?.workflowId === 'development-review'), true);
    await f.act('syncTicketImportBinding', { id: binding.id });
    await f.restart();
    state = await f.snapshot();
    assert.equal(state.ticketRelations.length, 1);
    assert.equal(state.tickets.filter(value => value.projectId === project.id).length, 2);
    assert.equal(Object.values(state.sessions).filter(value => value.activeTicketId === support.id).length, 1);
});
test('acceptance: a new customer message resumes the matching support wait after a restart', async (t) => {
    const issue = { remoteId: 'report-3', remoteKey: 'R-3', title: 'Request', description: 'Initial report', remoteVersion: '1' };
    let comments = [{ remoteId: '1', body: 'Initial report', authorRole: 'user', createdAt: '2026-09-23T12:00:00Z' }];
    let threadUnavailable = true;
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: {
            listIssuesPage: async () => ({ items: [issue] }),
            listComments: async () => { if (threadUnavailable)
                throw new Error('thread unavailable'); return comments; },
        } });
    const project = await f.act('saveProject', { name: 'Service project' });
    const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
        connection: { baseUrl: 'https://tickets.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TEST' } },
        operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } },
            thread: { method: 'GET', path: 'tickets/${remoteId}/comments', response: { items: '$.items' } } },
        mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.title', remoteVersion: '$.version' },
        threadMapping: { id: '$.id', body: '$.body', authorRole: '$.role', createdAt: '$.createdAt' } };
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'custom-http', name: 'Service', manifest });
    const binding = await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Reports', workType: 'support' });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    await f.act('saveWorkflow', { workflow: { id: 'reply-wait', name: 'Reply wait', nodes: [
                { id: 'wait', name: 'Wait for customer', kind: 'wait', waitFor: { event: 'ticket_message_received' } },
                { id: 'review', name: 'Review new information', kind: 'human', prompt: 'Review the new message.' },
            ], edges: [{ from: 'wait', to: 'review', outcome: 'success' }] } });
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'New reports', projectId: project.id, enabled: true,
            when: { event: 'ticket_imported', bindingId: binding.id },
            if: [],
            then: { action: "start_workflow", workflowId: 'reply-wait', workflowVersion: 1 }
        } });
    await assert.rejects(f.act('syncTicketImportBinding', { id: binding.id }), /thread unavailable/);
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(Object.values((await f.snapshot()).sessions ?? {}).some(value => value.flow?.workflowId === 'reply-wait'), false);
    threadUnavailable = false;
    await f.act('syncTicketImportBinding', { id: binding.id });
    let state = await f.snapshot();
    const support = state.tickets.find(value => value.projectId === project.id);
    assert.equal(state.ticketThreads.find(value => value.ticketId === support.id).messages.length, 1);
    assert.equal(Object.values(state.sessions).find(value => value.activeTicketId === support.id).flow.status, 'waiting_event');
    await f.restart();
    comments = [...comments, { remoteId: '2', body: 'More details', authorRole: 'user', createdAt: '2026-09-23T13:00:00Z' }];
    await f.act('syncTicketImportBinding', { id: binding.id });
    state = await f.snapshot();
    const session = Object.values(state.sessions).find(value => value.activeTicketId === support.id);
    assert.equal(session.flow.nodeId, 'review');
    assert.equal(session.flow.status, 'waiting_gate');
    assert.equal(state.ticketThreads.find(value => value.ticketId === support.id).messages.length, 2);
    await f.act('syncTicketImportBinding', { id: binding.id });
    assert.equal(Object.values((await f.snapshot()).sessions).filter(value => value.activeTicketId === support.id).length, 1);
});
test('acceptance: customer messages blocked by an active review remain held until explicit retry', async (t) => {
    const issue = { remoteId: 'request-7', remoteKey: 'R-7', title: 'Request', description: 'Initial report', remoteVersion: '1' };
    const comments = [{ remoteId: '1', body: 'Initial report', authorRole: 'user', createdAt: '2026-09-23T12:00:00Z' }];
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: {
            listIssuesPage: async () => ({ items: [issue] }),
            listComments: async () => comments,
        } });
    const project = await f.act('saveProject', { name: 'Editorial intake' });
    const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
        connection: { baseUrl: 'https://reports.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TEST' } },
        operations: { list: { method: 'GET', path: 'requests', response: { items: '$.items' } },
            thread: { method: 'GET', path: 'requests/${remoteId}/comments', response: { items: '$.items' } } },
        mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.title', remoteVersion: '$.version' },
        threadMapping: { id: '$.id', body: '$.body', authorRole: '$.role', createdAt: '$.createdAt' } };
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'custom-http', name: 'Reports', manifest });
    const binding = await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Requests', workType: 'request' });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    await f.act('saveWorkflow', { workflow: { id: 'review-request', name: 'Review request', nodes: [
                { id: 'review', name: 'Review new message', kind: 'human', prompt: 'Review the request.' },
            ] } });
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'New requester messages', projectId: project.id,
            enabled: true,
            when: { event: 'ticket_message_received', bindingId: binding.id },
            if: [],
            then: { action: "start_workflow", workflowId: 'review-request', workflowVersion: 1 }
        } });
    await f.act('syncTicketImportBinding', { id: binding.id });
    const ticket = (await f.snapshot()).tickets.find(value => value.projectId === project.id);
    comments.push({ remoteId: '2', body: 'First update', authorRole: 'user', createdAt: '2026-09-23T13:00:00Z' });
    await f.act('syncTicketImportBinding', { id: binding.id });
    let state = await until(async () => {
        const snapshot = await f.snapshot();
        return snapshot.automationDecisions.some(value => value.ticketId === ticket.id && value.status === 'started') ? snapshot : null;
    });
    const session = state.sessions.find(value => value.activeTicketId === ticket.id);
    const firstRun = session.flow.id;
    assert.equal(session.flow.status, 'waiting_gate');
    comments.push({ remoteId: '3', body: 'Another update', authorRole: 'user', createdAt: '2026-09-23T14:00:00Z' });
    await f.act('syncTicketImportBinding', { id: binding.id });
    state = await f.snapshot();
    assert.equal(state.automationDecisions.some(value => value.ticketId === ticket.id && value.status === 'blocked_active'), true);
    await f.act('claim', { sessionId: session.id });
    await f.act('approveGate', { sessionId: session.id, instance: session.flow.instance });
    await f.restart();
    state = await f.snapshot();
    assert.equal(state.sessions.find(value => value.activeTicketId === ticket.id).flow.id, firstRun);
    const held = state.automationDecisions.find(value => value.ticketId === ticket.id && value.status === 'blocked_active');
    await f.act('claim', { sessionId: session.id });
    await f.act('retryAutomationDecision', { sessionId: session.id, triggerKey: held.triggerKey });
    state = await f.snapshot();
    assert.equal(state.sessions.find(value => value.activeTicketId === ticket.id).flow.status, 'waiting_gate');
    assert.equal(state.automationDecisions.filter(value => value.ticketId === ticket.id && value.status === 'started').length, 2);
    await f.act('syncTicketImportBinding', { id: binding.id });
    assert.equal((await f.snapshot()).automationDecisions.filter(value => value.ticketId === ticket.id && value.status === 'started').length, 2);
});
test('acceptance: approved delivered clarification advances a source-owned board status', async (t) => {
    let writes = 0;
    let sourceStatus = 'Open';
    let remoteRevision = '3';
    const comments = [];
    const issue = () => ({ remoteId: 'request-7', remoteKey: 'REQ-7', title: 'Clarify request',
        status: sourceStatus, rawStatus: sourceStatus === 'Waiting' ? 'waiting' : 'open',
        remoteVersion: remoteRevision, fieldOwnership: { status: 'external' } });
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: {
            listIssuesPage: async () => ({ items: [issue()] }),
            postReply: async () => {
                comments.push({ remoteId: 'message-7', body: 'Which edition?', authorRole: 'team',
                    createdAt: '2026-09-24T13:00:00Z', deliveryStatus: 'delivered' });
                return { remoteId: 'message-7', deliveryStatus: 'pending' };
            },
            listComments: async () => comments,
            setStatus: async (_source, _remoteId, input) => {
                writes++;
                assert.equal(input.status, 'waiting');
                assert.equal(input.remoteVersion, '3');
                assert.equal(input.evidenceMessageId, 'message-7');
                sourceStatus = 'Waiting';
                remoteRevision = '4';
                return { remoteId: 'request-7', rawStatus: 'waiting', status: 'Waiting', remoteVersion: '4' };
            },
        } });
    const project = await f.act('saveProject', { name: 'Editorial desk' });
    const manifest = { apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
        connection: { baseUrl: 'https://desk.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_READ_TEST' },
            writeAuthentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_WRITE_TEST' } },
        operations: { list: { method: 'GET', path: 'requests', response: { items: '$.items' } },
            thread: { method: 'GET', path: 'requests/${remoteId}/messages', response: { items: '$.items' } },
            reply: { method: 'POST', path: 'requests/${remoteId}/messages', response: { commentId: '$.id' } },
            status: { method: 'PATCH', path: 'requests/${remoteId}/status', request: { status: 'status', remoteVersion: 'expectedVersion', evidenceMessageId: 'messageId' }, response: { item: '$.item' } } },
        mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.title', status: '$.status', remoteVersion: '$.version' },
        threadMapping: { id: '$.id', body: '$.body', authorRole: '$.role', createdAt: '$.createdAt', deliveryStatus: '$.delivery' } };
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'custom-http', name: 'Desk', manifest });
    const binding = await f.act('saveTicketImportBinding', { connectionId: source.id, projectId: project.id, name: 'Requests', workType: 'request' });
    const board = await f.act('saveBoard', { name: 'Requests', projectIds: [project.id], grouping: { mode: 'field', field: 'status' },
        columns: [{ id: 'open', name: 'Open', value: 'Open' }, { id: 'waiting', name: 'Waiting', value: 'Waiting' }] });
    await f.act('syncTicketImportBinding', { id: binding.id });
    const ticket = (await f.snapshot()).tickets.find(value => value.projectId === project.id);
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    await f.act('saveWorkflow', { workflow: { id: 'clarify', name: 'Clarify', nodes: [
                { id: 'review', name: 'Review reply', kind: 'human', prompt: 'Send and confirm the reply.' },
                { id: 'wait', name: 'Wait for requester', kind: 'action', operation: 'set_external_status',
                    input: { connectionId: source.id, status: 'waiting', evidenceReply: 'latest_delivered' } },
            ], edges: [{ from: 'review', to: 'wait', outcome: 'approved' }] } });
    await f.act('ensure', { taskId: String(ticket.id), title: ticket.title });
    await f.act('claim', { taskId: String(ticket.id) });
    await f.act('configure', { taskId: String(ticket.id), workflow: 'clarify' });
    await f.act('startWorkflow', { taskId: String(ticket.id) });
    const session = (await f.snapshot()).sessions.find(value => value.id === String(ticket.id));
    assert.equal(session.flow.status, 'waiting_gate');
    await f.act('postExternalTicketReply', { requestId: 'clarification-7', ticketId: ticket.id,
        connectionId: source.id, body: 'Which edition?' });
    await f.act('approveGate', { sessionId: session.id, instance: session.flow.instance });
    const afterApproval = await f.snapshot();
    assert.notEqual(afterApproval.sessions.find(value => value.id === session.id)?.flow?.status, 'failed', JSON.stringify({ flow: afterApproval.sessions.find(value => value.id === session.id)?.flow,
        effects: afterApproval.workflowEffects, events: afterApproval.sessions.find(value => value.id === session.id)?.events }));
    const state = await until(async () => {
        const snapshot = await f.snapshot();
        return snapshot.tickets.find(value => value.id === ticket.id)?.status === 'Waiting' ? snapshot : null;
    });
    assert.equal(state.boards.find(value => value.id === board.id).tickets.find(value => value.ticketId === ticket.id).columnId, 'waiting');
    assert.equal(writes, 1);
    await f.restart();
    assert.equal((await f.snapshot()).tickets.find(value => value.id === ticket.id).status, 'Waiting');
    assert.equal(writes, 1);
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Requester response', projectId: project.id,
            enabled: true,
            when: { bindingId: binding.id, event: 'ticket_message_received' },
            if: [],
            then: { action: "start_workflow", workflowId: 'clarify', workflowVersion: 1 }
        } });
    sourceStatus = 'Open';
    remoteRevision = '5';
    comments.push({ remoteId: 'message-8', body: 'The current edition', authorRole: 'user',
        createdAt: '2026-09-24T14:00:00Z' });
    await f.act('syncTicketImportBinding', { id: binding.id });
    const resumed = await until(async () => {
        const snapshot = await f.snapshot();
        const current = snapshot.sessions.find(value => value.id === session.id);
        return current?.flow?.id !== session.flow.id ? snapshot : null;
    });
    assert.equal(resumed.tickets.find(value => value.id === ticket.id).status, 'Open');
    assert.equal(resumed.sessions.find(value => value.id === session.id).flow.status, 'waiting_gate');
    assert.equal(resumed.boards.find(value => value.id === board.id).tickets.find(value => value.ticketId === ticket.id).columnId, 'open');
});
test('acceptance: a mapped HTTP source previews, imports once, and survives restart', async (t) => {
    const previous = process.env.CONVOY_TICKET_SOURCE_TOKEN_ACCEPTANCE;
    process.env.CONVOY_TICKET_SOURCE_TOKEN_ACCEPTANCE = 'fixture-secret';
    t.after(() => { if (previous === undefined)
        delete process.env.CONVOY_TICKET_SOURCE_TOKEN_ACCEPTANCE;
    else
        process.env.CONVOY_TICKET_SOURCE_TOKEN_ACCEPTANCE = previous; });
    let requests = 0;
    const custom = createCustomTicketSource({
        resolver: async () => [{ address: '8.8.4.4', family: 4 }],
        fetcher: async (_url, options) => {
            requests++;
            assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
            return new Response(JSON.stringify({ items: [{ id: 'case-9', number: 'CASE-9', subject: 'Mapped ticket', details: 'Remote details', state: 'open', severity: 'urgent', revision: 'r1', url: 'https://support.example.com/tickets/9' }] }), { headers: { 'content-type': 'application/json' } });
        },
    });
    const f = await fixture(t, { externalTickets: createTicketSources({ 'custom-http': custom }) });
    const manifest = {
        apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
        connection: { baseUrl: 'https://support.example.com/api', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_TOKEN_ACCEPTANCE' } },
        operations: { list: { method: 'GET', path: 'tickets', response: { items: '$.items' } } },
        mapping: { remoteId: '$.id', remoteKey: '$.number', title: '$.subject', description: '$.details', status: '$.state', priority: '$.severity', remoteVersion: '$.revision', url: '$.url' },
        values: { status: { open: 'Backlog' }, priority: { urgent: 'High' } },
    };
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'custom-http', name: 'Mapped support', manifest });
    const preview = await f.act('previewExternalTickets', { connectionId: source.id, projectId: 'agent-platform' });
    assert.equal(preview.wouldImport, 1);
    assert.equal((await f.snapshot()).tickets.length, 0);
    assert.deepEqual(await f.act('importExternalTickets', { connectionId: source.id, projectId: 'agent-platform' }), { imported: 1, updated: 0 });
    assert.deepEqual(await f.act('importExternalTickets', { connectionId: source.id, projectId: 'agent-platform' }), { imported: 0, updated: 0 });
    await f.restart();
    const state = await f.snapshot();
    const imported = state.tickets.find(ticket => ticket.externalLinks?.[0]?.remoteId === 'case-9');
    assert.equal(imported.title, 'Mapped ticket');
    assert.equal(imported.priority, 'High');
    assert.equal(imported.externalLinks[0].provider, 'custom-http');
    assert.equal(state.ticketConnections.find(connection => connection.id === source.id).manifest.mapping.remoteId, '$.id');
    assert.equal(requests, 3);
});
test('acceptance: AFIO support status projects to its board while linked development stays independent', async (t) => {
    const previous = process.env.CONVOY_TICKET_SOURCE_AFIO_ACCEPTANCE;
    process.env.CONVOY_TICKET_SOURCE_AFIO_ACCEPTANCE = 'fixture-secret';
    t.after(() => { if (previous === undefined)
        delete process.env.CONVOY_TICKET_SOURCE_AFIO_ACCEPTANCE;
    else
        process.env.CONVOY_TICKET_SOURCE_AFIO_ACCEPTANCE = previous; });
    const statuses = ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'];
    const priorities = ['low', 'normal', 'high', 'urgent', 'normal'];
    const custom = createCustomTicketSource({
        resolver: async () => [{ address: '8.8.4.4', family: 4 }],
        fetcher: async () => new Response(JSON.stringify({ items: statuses.map((status, index) => ({
                id: String(index + 1), subject: `Report ${index + 1}`, description: 'Reproduce this issue',
                status, priority: priorities[index], updatedAt: `r${index + 1}`,
            })) }), { headers: { 'content-type': 'application/json' } }),
    });
    const f = await fixture(t, { persistenceBackend: 'sqlite', externalTickets: createTicketSources({ 'custom-http': custom }) });
    const supportProject = await f.act('saveProject', { name: 'AFIO Support' });
    const manifest = {
        apiVersion: 'convoy.dev/v1alpha1', kind: 'TicketSource',
        connection: { baseUrl: 'https://admin.afio.io/api/v1/integrations/', authentication: { type: 'bearer', credential: 'CONVOY_TICKET_SOURCE_AFIO_ACCEPTANCE' } },
        operations: { list: { method: 'GET', path: 'support-tickets', response: { items: '$.items' } } },
        mapping: { remoteId: '$.id', remoteKey: '$.id', title: '$.subject', description: '$.description', status: '$.status', priority: '$.priority', remoteVersion: '$.updatedAt' },
        values: { status: { open: 'Open', in_progress: 'In progress', waiting_user: 'Waiting on user', resolved: 'Resolved', closed: 'Closed' }, priority: { low: 'Low', normal: 'Medium', high: 'High', urgent: 'High' } },
    };
    const source = await f.act('saveTicketConnection', { organizationId: 'personal', provider: 'custom-http', name: 'AFIO Support', manifest });
    const board = await f.act('saveBoard', { name: 'AFIO Support', projectIds: [supportProject.id], filters: { origins: ['external'] }, grouping: { mode: 'field', field: 'status' }, columns: statuses.map((status, index) => ({ id: `column-${status.replaceAll('_', '-')}`, name: manifest.values.status[status], value: manifest.values.status[status] })) });
    const developmentBoard = await f.act('saveBoard', { name: 'AFIO Development', projectIds: [supportProject.id], filters: { origins: ['convoy'] }, grouping: { mode: 'field', field: 'status' }, columns: ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((status, index) => ({ id: `development-${index}`, name: status, value: status })) });
    assert.deepEqual(await f.act('importExternalTickets', { connectionId: source.id, projectId: supportProject.id }), { imported: 5, updated: 0 });
    let state = await f.snapshot();
    const reports = state.tickets.filter(ticket => ticket.projectId === supportProject.id);
    assert.deepEqual(reports.map(ticket => ticket.status), ['Open', 'In progress', 'Waiting on user', 'Resolved', 'Closed']);
    assert.deepEqual(reports.map(ticket => ticket.externalLinks[0].remoteStatus), statuses);
    assert.deepEqual(state.boards.find(value => value.id === board.id).tickets.map(value => value.columnId), board.columns.map(value => value.id));
    assert.equal(state.boards.find(value => value.id === developmentBoard.id).tickets.length, 0);
    const changedManifest = structuredClone(manifest);
    changedManifest.values.priority.urgent = 'Medium';
    await f.act('saveTicketConnection', { id: source.id, revision: source.revision, organizationId: 'personal', provider: 'custom-http', name: source.name, manifest: changedManifest });
    assert.deepEqual(await f.act('importExternalTickets', { connectionId: source.id, projectId: supportProject.id }), { imported: 0, updated: 1 });
    state = await f.snapshot();
    assert.equal(state.tickets.find(ticket => ticket.id === reports[3].id).priority, 'Medium');
    assert.equal(state.tickets.find(ticket => ticket.id === reports[3].id).externalLinks[0].remotePriority, 'urgent');
    await assert.rejects(f.act('setBoardPlacement', { boardId: board.id, ticketId: reports[0].id, revision: reports[0].revision, placement: { columnId: board.columns[1].id } }), /owned by the external source/);
    await assert.rejects(f.act('updateTicket', { taskId: reports[0].id, revision: reports[0].revision, patch: { status: 'Closed' } }), /owned by the external source/);
    await assert.rejects(f.act('createTicket', { requestId: 'wrong-board', boardId: board.id, projectId: supportProject.id, title: 'Local ticket on support board' }), /excluded by this board/);
    const development = await f.act('createRelatedTicket', { requestId: 'afiod-1', sourceTicketId: reports[0].id, sourceRevision: reports[0].revision, boardId: developmentBoard.id, title: 'Fix reported issue' });
    assert.equal((await f.act('createRelatedTicket', { requestId: 'afiod-1', sourceTicketId: reports[0].id, sourceRevision: reports[0].revision, boardId: developmentBoard.id, title: 'Fix reported issue' })).id, development.id);
    assert.equal(development.projectId, supportProject.id);
    state = await f.snapshot();
    assert.equal(state.boards.find(value => value.id === board.id).tickets.length, 5);
    assert.deepEqual(state.boards.find(value => value.id === developmentBoard.id).tickets.map(value => value.ticketId), [development.id]);
    await f.act('linkTickets', { sourceTicketId: reports[1].id, sourceRevision: reports[1].revision, targetTicketId: development.id, targetRevision: development.revision });
    await f.act('updateTicket', { taskId: development.id, revision: development.revision, patch: { status: 'Done' } });
    await f.restart();
    state = await f.snapshot();
    assert.equal(state.ticketRelations.length, 2);
    assert.equal(state.tickets.find(ticket => ticket.id === reports[0].id).status, 'Open');
    assert.equal(state.tickets.find(ticket => ticket.id === development.id).status, 'Done');
    assert.equal(state.boards.find(value => value.id === developmentBoard.id).tickets[0].columnId, developmentBoard.columns[4].id);
    assert.equal(state.ticketConnections.find(value => value.id === source.id).capabilities.update, false);
});
test('acceptance: a conversation can execute and approve a workflow without creating a ticket', async (t) => {
    const f = await fixture(t);
    const chat = await f.act('createConversation', { requestId: 'ticketless' });
    const scope = { sessionId: chat.sessionId };
    await f.act('claim', scope);
    await f.act('saveWorkflow', { workflow: { id: 'ticketless', name: 'Independent decision', steps: [{ id: 'decision', kind: 'human', name: 'Decide', prompt: 'Review the proposal' }] } });
    await f.act('configure', { ...scope, workflow: 'ticketless' });
    await f.act('startWorkflow', scope);
    let state = await f.snapshot();
    let session = state.sessions.find(s => s.id === chat.sessionId);
    assert.equal(state.tickets.length, 0);
    assert.equal(session.flow.status, 'waiting_gate');
    const identity = session.currentAgentSessionId;
    await f.act('approveGate', { ...scope, instance: session.flow.instance });
    await f.restart();
    state = await f.snapshot();
    session = state.sessions.find(s => s.id === chat.sessionId);
    assert.equal(session.flow.status, 'completed');
    assert.equal(session.currentAgentSessionId, identity);
    assert.equal(state.tickets.length, 0);
});
test('acceptance: board-local placement, renamed columns and active approvals remain independent across restart', async (t) => {
    const f = await fixture(t);
    const ticket = await f.act('createTicket', { requestId: 'shared-ticket', title: 'One ticket, two boards', projectId: 'agent-platform' });
    const make = name => f.act('saveBoard', { name, projectIds: ['agent-platform'], columns: [{ id: 'todo', name: 'To do' }, { id: 'review', name: 'Review' }], grouping: { mode: 'local' } });
    const one = await make('One');
    const two = await make('Two');
    await f.act('ensure', { taskId: String(ticket.id), title: ticket.title });
    await f.act('claim', { taskId: String(ticket.id) });
    await f.act('saveWorkflow', { workflow: { id: 'approval', name: 'Approval', steps: [{ id: 'wait', kind: 'human', name: 'Wait', prompt: 'Approve' }] } });
    await f.act('configure', { taskId: String(ticket.id), workflow: 'approval' });
    await f.act('startWorkflow', { taskId: String(ticket.id) });
    let state = await f.snapshot();
    const before = state.sessions.find(s => s.id === String(ticket.id));
    await f.act('setBoardPlacement', { boardId: one.id, ticketId: ticket.id, revision: state.tickets[0].revision, placement: { columnId: 'review' } });
    await f.act('saveBoard', { ...one, columns: [{ id: 'todo', name: 'Ideas' }, { id: 'review', name: 'Quality review' }] });
    await f.restart();
    state = await f.snapshot();
    assert.equal(state.tickets.length, 1);
    assert.equal(state.tickets[0].status, 'Backlog');
    assert.equal(state.boards.find(b => b.id === one.id).tickets.find(p => p.ticketId === ticket.id).columnId, 'review');
    assert.equal(state.boards.find(b => b.id === two.id).tickets.find(p => p.ticketId === ticket.id).columnId, 'todo');
    const after = state.sessions.find(s => s.id === String(ticket.id));
    assert.equal(after.flow.status, 'waiting_gate');
    assert.equal(after.flow.instance, before.flow.instance);
    assert.equal(after.currentAgentSessionId, before.currentAgentSessionId);
});
test('acceptance: explicit graph routes cannot silently acquire array-order connections', () => {
    const workflow = normalizeWorkflow({ id: 'reverse-order', name: 'Explicit graph', entryNode: 'start', nodes: [
            { id: 'end', kind: 'human', name: 'Final approval', prompt: 'Approve' },
            { id: 'start', kind: 'human', name: 'Initial approval', prompt: 'Approve' },
        ], edges: [{ id: 'route', from: 'start', to: 'end', outcome: 'approved' }] });
    assert.deepEqual(workflow.edges.map(({ from, to, outcome }) => ({ from, to, outcome })), [{ from: 'start', to: 'end', outcome: 'approved' }]);
    assert.throws(() => normalizeWorkflow({ id: 'disconnected', name: 'Disconnected', nodes: [
            { id: 'one', kind: 'human', name: 'One', prompt: 'Approve' },
            { id: 'two', kind: 'human', name: 'Two', prompt: 'Approve' },
        ], edges: [] }), /reachable|connect/i);
});
test('acceptance: ambiguous outcome edges are rejected at publication', () => {
    assert.throws(() => normalizeWorkflow({ id: 'ambiguous', name: 'Ambiguous', nodes: [
            { id: 'one', kind: 'agent', name: 'One', prompt: 'Produce a result' },
            { id: 'two', kind: 'human', name: 'Two', prompt: 'Approve' },
            { id: 'three', kind: 'human', name: 'Three', prompt: 'Approve' },
        ], edges: [
            { id: 'a', from: 'one', to: 'two', outcome: 'success' },
            { id: 'b', from: 'one', to: 'three', outcome: 'success' },
        ] }), /ambiguous|outcome|duplicate/i);
});
test('acceptance: a revision edge cannot disguise an unbounded alternate cycle', () => {
    assert.throws(() => normalizeWorkflow({ id: 'alternate-loop', name: 'Alternate loop', nodes: [
            { id: 'a', kind: 'human', name: 'A', prompt: 'Decide' },
            { id: 'b', kind: 'agent', name: 'B', prompt: 'Revise' },
            { id: 'c', kind: 'agent', name: 'C', prompt: 'Implement' },
        ], edges: [
            { from: 'a', to: 'b', outcome: 'changes_requested' },
            { from: 'b', to: 'c', outcome: 'success' },
            { from: 'c', to: 'a', outcome: 'success' },
            { from: 'a', to: 'c', outcome: 'approved' },
        ] }), /loop|cycle|bounded/i);
});
test('acceptance: a persisted legacy approval migrates without replacing its pending instance or session', async (t) => {
    const f = await fixture(t);
    const chat = await f.act('createConversation', { requestId: 'legacy-run' });
    const scope = { sessionId: chat.sessionId };
    await f.act('claim', scope);
    await f.act('saveWorkflow', { workflow: { id: 'legacy-review', name: 'Legacy review', steps: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Approve' }] } });
    await f.act('configure', { ...scope, workflow: 'legacy-review' });
    await f.act('startWorkflow', scope);
    const before = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
    await f.restartLegacy(state => {
        const session = state.sessions[chat.sessionId];
        session.workflow = { id: 'legacy-review', name: 'Legacy review', schemaVersion: 2, version: 1, steps: [{ id: 'review', kind: 'human', name: 'Review', prompt: 'Approve', phase: 'In review' }] };
        delete session.flow.nodeId;
        delete session.flow.history;
    });
    const migrated = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
    assert.equal(migrated.flow.instance, before.flow.instance);
    assert.equal(migrated.currentAgentSessionId, before.currentAgentSessionId);
    await f.act('claim', scope);
    await f.act('approveGate', { ...scope, instance: before.flow.instance });
    assert.equal((await f.snapshot()).sessions.find(s => s.id === chat.sessionId).flow.status, 'completed');
});
test('acceptance: approval rejects changed submission evidence even across an intervening branch', async () => {
    let hash = 'original';
    const session = { id: 'acceptance', messages: [], events: [], checks: [], workspace: { path: '/fixture' }, workflow: normalizeWorkflow({
            id: 'evidence', name: 'Evidence gate', nodes: [
                { id: 'work', kind: 'agent', name: 'Write brief', prompt: 'Write the brief', artifact: { path: 'brief.md', headings: ['Scope'] } },
                { id: 'route', kind: 'branch', name: 'Route review', condition: { source: 'submission', field: 'summary', exists: true } },
                { id: 'review', kind: 'human', name: 'Review', prompt: 'Approve the submitted brief' },
            ], edges: [{ from: 'work', to: 'route', outcome: 'success' }, { from: 'route', to: 'review', outcome: 'true' }, { from: 'route', to: 'review', outcome: 'false' }],
        }) };
    const engine = createWorkflowEngine({ state: { sessions: { acceptance: session } }, save: async () => { }, event: () => { }, launch: () => true,
        inspectArtifact: async () => ({ text: '# Scope\nWork', sha256: hash }), inspectChanges: async () => ({ digest: 'workspace' }),
    });
    await engine.start(session);
    await engine.pump();
    await engine.submit(session, session.flow.instance, { summary: 'Ready for review', artifacts: ['brief.md'] });
    await engine.pump();
    await engine.finishAutomated(session, session.flow.instance, 'true');
    const instance = session.flow.instance;
    hash = 'changed';
    await assert.rejects(engine.decide(session, { action: 'approveGate', instance }), /changed|evidence|submission/i);
    assert.equal(session.flow.status, 'waiting_gate');
    hash = 'original';
    await engine.decide(session, { action: 'approveGate', instance });
    assert.equal(session.flow.status, 'completed');
});
test('acceptance: shared-field WIP limits cannot be bypassed through ticket editing', async (t) => {
    const f = await fixture(t);
    const first = await f.act('createTicket', { requestId: 'wip-one', title: 'First', projectId: 'agent-platform', priority: 'Low' });
    const second = await f.act('createTicket', { requestId: 'wip-two', title: 'Second', projectId: 'agent-platform', priority: 'Low' });
    const board = await f.act('saveBoard', { name: 'Priority board', projectIds: ['agent-platform'], grouping: { mode: 'field', field: 'priority' }, columns: [
            { id: 'low', name: 'Low', value: 'Low' }, { id: 'high', name: 'Urgent', value: 'High', wipLimit: 1 },
        ] });
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: first.id, revision: first.revision, placement: { columnId: 'high' } });
    await assert.rejects(f.act('updateTicket', { taskId: second.id, revision: second.revision, patch: { priority: 'High' } }), /WIP|limit/i);
    const saved = (await f.snapshot()).tickets.find(t => t.id === second.id);
    assert.equal(saved.priority, 'Low');
    assert.equal(saved.revision, second.revision);
});
test('acceptance: a board move starts only the workflow version pinned by its project rule', async (t) => {
    const f = await fixture(t);
    const ticket = await f.act('createTicket', { requestId: 'trigger-ticket', title: 'Unassigned work', projectId: 'agent-platform' });
    const board = await f.act('saveBoard', { name: 'Trigger board', projectIds: ['agent-platform'], columns: [{ id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' }] });
    const workflow = { id: 'on-review', name: 'Review arrival', nodes: [{ id: 'gate', kind: 'human', name: 'Old review', prompt: 'Approve' }], edges: [] };
    await f.act('saveWorkflow', { workflow, baseVersion: 0 });
    await f.act('saveWorkflow', { workflow: { ...workflow, nodes: [{ ...workflow.nodes[0], name: 'Current review' }] }, baseVersion: 1 });
    await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Enter review', projectId: 'agent-platform', enabled: true,
            when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' },
            if: [],
            then: { action: "start_workflow", workflowId: workflow.id, workflowVersion: 2 }
        } });
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } });
    const state = await f.snapshot();
    const triggered = state.sessions.filter(s => s.workflow?.id === workflow.id);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].workflow.version, 2);
    assert.equal(triggered[0].flow.status, 'waiting_gate');
    assert.equal(state.tickets.length, 1);
    await f.restart();
    assert.equal((await f.snapshot()).sessions.filter(s => s.workflow?.id === workflow.id).length, 1);
});
test('acceptance: conflicting start rules and an active run produce durable blocked decisions', async (t) => {
    const f = await fixture(t);
    const ticket = await f.act('createTicket', { requestId: 'conflict-ticket', title: 'Conflict', projectId: 'agent-platform' });
    const board = await f.act('saveBoard', { name: 'Conflict board', projectIds: ['agent-platform'], columns: [{ id: 'todo', name: 'To do' }, { id: 'review', name: 'Review' }] });
    await f.act('saveWorkflow', { workflow: { id: 'conflict-review', name: 'Review', nodes: [{ id: 'gate', kind: 'human', name: 'Approve', prompt: 'Review' }] } });
    const input = {
        projectId: 'agent-platform', enabled: true,
        when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' },
        if: [],
        then: { action: "start_workflow", workflowId: 'conflict-review', workflowVersion: 1 }
    };
    const first = await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: { ...input, name: 'First review' } });
    const second = await f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: { ...input, name: 'Second review' } });
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } });
    let state = await f.snapshot();
    assert.deepEqual(state.automationDecisions.map(value => value.status), ['conflict', 'conflict']);
    assert.equal(state.sessions.some(value => value.activeTicketId === ticket.id), false);
    await f.restart();
    state = await f.snapshot();
    assert.equal(state.automationDecisions.filter(value => value.status === 'conflict').length, 2);
    await f.act('saveAutomation', { organizationId: 'personal', revision: second.revision, rule: { ...input, id: second.id, name: second.name, enabled: false } });
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'todo' } });
    state = await f.snapshot();
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'review' } });
    state = await f.snapshot();
    assert.equal(state.automationDecisions.findLast(value => value.ruleId === first.id).status, 'started');
    assert.equal(state.sessions.find(value => value.activeTicketId === ticket.id).flow.status, 'waiting_gate');
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'todo' } });
    state = await f.snapshot();
    await f.act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: state.tickets.find(value => value.id === ticket.id).revision, placement: { columnId: 'review' } });
    assert.equal((await f.snapshot()).automationDecisions.findLast(value => value.ruleId === first.id).status, 'blocked_active');
});
test('acceptance: ticket launch and rules reject a workflow scoped to another project', async (t) => {
    const f = await fixture(t);
    const other = await f.act('saveProject', { name: 'Second project', organizationId: 'personal' });
    const ticket = await f.act('createTicket', { requestId: 'scoped-ticket', title: 'Scoped', projectId: 'agent-platform' });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: other.id } });
    await f.act('saveWorkflow', { projectId: other.id, workflow: { id: 'second-only', name: 'Second only', nodes: [{ id: 'gate', kind: 'human', name: 'Approve', prompt: 'Review' }] } });
    await f.act('selectActiveContext', { context: { organizationId: 'personal', projectId: 'agent-platform' } });
    await assert.rejects(f.act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Wrong project', projectId: ticket.projectId, enabled: true,
            when: { event: 'ticket_created' },
            if: [],
            then: { action: "start_workflow", workflowId: 'second-only', workflowVersion: 1 }
        } }), /not available/i);
    await assert.rejects(f.act('runTicket', { requestId: 'wrong-workflow', ticketId: ticket.id, revision: ticket.revision, workflowId: 'second-only', workflowVersion: 1, model: 'fixture', mode: 'new' }), /not available/i);
});
test('acceptance: ticketless graph actions create work and route from structured results without inference', async (t) => {
    const f = await fixture(t);
    const chat = await f.act('createConversation', { requestId: 'action-chat' });
    const scope = { sessionId: chat.sessionId };
    await f.act('claim', scope);
    await f.act('saveWorkflow', { workflow: { id: 'record-work', name: 'Record and review', nodes: [
                { id: 'create', kind: 'action', name: 'Record work', operation: 'create_ticket', input: { title: 'Recorded by workflow', projectId: 'agent-platform' } },
                { id: 'branch', kind: 'branch', name: 'Recorded?', condition: { source: 'actionResult', field: 'id', exists: true } },
                { id: 'review', kind: 'human', name: 'Review result', prompt: 'Approve' },
                { id: 'missing', kind: 'human', name: 'Investigate missing result', prompt: 'Investigate' },
            ], edges: [
                { from: 'create', to: 'branch', outcome: 'success' }, { from: 'branch', to: 'review', outcome: 'true' }, { from: 'branch', to: 'missing', outcome: 'false' },
            ] } });
    await f.act('configure', { ...scope, workflow: 'record-work' });
    await f.act('startWorkflow', scope);
    const session = await until(async () => {
        const s = (await f.snapshot()).sessions.find(s => s.id === chat.sessionId);
        if (s.flow.status === 'failed')
            throw new Error(JSON.stringify(s.events.slice(-3)));
        return s.flow.status === 'waiting_gate' && s;
    });
    assert.equal(session.flow.nodeId, 'review');
    assert.equal((await f.snapshot()).tickets.length, 1);
    assert.equal(session.activeTicketId, null);
    await f.restart();
    assert.equal((await f.snapshot()).tickets.length, 1);
});
