import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/index.mjs';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
async function until(read, predicate) {
    for (let i = 0; i < 100; i++) {
        const value = await read();
        if (predicate(value))
            return value;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Timed out waiting for workflow recovery.');
}
test('uncertain workflow board effects are not replayed on restart and require explicit recovery', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-recovery-'));
    const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () { } };
    let runtime;
    const closeRuntime = async () => { if (runtime) { const current = runtime; runtime = null; await current.close(); } };
    t.after(async () => { await closeRuntime(); await rm(directory, { recursive: true, force: true }); });
    runtime = await createRuntime(options);
    const act = (action, input = {}) => runtime.command({ action, client: 'recovery-client', ...input });
    const chat = await act('createConversation', { requestId: 'recovery-chat' });
    const scope = { sessionId: chat.sessionId };
    await act('claim', scope);
    const board = await act('saveBoard', { name: 'Recovery WIP', projectIds: ['agent-platform'], columns: [{ id: 'backlog', name: 'Backlog', wipLimit: 1 }, { id: 'done', name: 'Done' }] });
    await act('createTicket', { requestId: 'recovery-wip-holder', projectId: 'agent-platform', boardId: board.id, title: 'Uses the only slot' });
    await act('saveWorkflow', { workflow: { id: 'effect', name: 'Effect', nodes: [{ id: 'create', kind: 'action', name: 'Create ticket', operation: 'create_ticket', input: { title: 'Recovered', projectId: 'agent-platform', boardId: board.id } }] } });
    await act('configure', { ...scope, workflow: 'effect' });
    await act('startWorkflow', scope);
    let snapshot = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'failed');
    const failed = snapshot.sessions[0];
    const effectKey = `${failed.flow.id}:${failed.flow.instance}:create`;
    assert.equal(snapshot.workflowEffects.find(effect => effect.effectKey === effectKey).status, 'uncertain');
    assert.equal(snapshot.tickets.filter(ticket => ticket.title === 'Recovered').length, 0);
    await closeRuntime();
    runtime = await createRuntime(options);
    snapshot = await runtime.snapshot();
    const resumed = snapshot.sessions[0];
    await runtime.command({ action: 'claim', sessionId: resumed.id, client: 'recovery-client' });
    await assert.rejects(runtime.command({ action: 'reconcileWorkflowEffect', sessionId: resumed.id, client: 'recovery-client', instance: 'stale', effectKey, resolution: 'not_applied' }), /changed|instance/i);
    const savedBoard = snapshot.boards.find(value => value.id === board.id);
    await runtime.command({ action: 'saveBoard', client: 'recovery-client', id: savedBoard.id, revision: savedBoard.revision,
        name: savedBoard.name, projectIds: savedBoard.projectIds, columns: savedBoard.columns.map(column => ({ id: column.id, name: column.name })) });
    await runtime.command({ action: 'reconcileWorkflowEffect', sessionId: resumed.id, client: 'recovery-client', instance: resumed.flow.instance, effectKey, resolution: 'not_applied' });
    await runtime.command({ action: 'heartbeat', sessionId: resumed.id, client: 'recovery-client' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await runtime.snapshot()).sessions[0].flow.status, 'paused');
    await closeRuntime();
    runtime = await createRuntime(options);
    const paused = (await runtime.snapshot()).sessions[0];
    assert.equal(paused.flow.status, 'paused');
    await runtime.command({ action: 'claim', sessionId: paused.id, client: 'recovery-client' });
    await runtime.command({ action: 'continueWorkflow', sessionId: paused.id, client: 'recovery-client', instance: paused.flow.instance });
    const completed = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'completed');
    assert.equal(completed.tickets.filter(ticket => ticket.title === 'Recovered').length, 1);
    await closeRuntime();
});
test('applied reconciliation accepts only an existing ticket result and never replays the effect', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-applied-'));
    let loseCanonicalResponse = false;
    let runtime;
    const closeRuntime = async () => { if (runtime) { const current = runtime; runtime = null; await current.close(); } };
    t.after(async () => { await closeRuntime(); await rm(directory, { recursive: true, force: true }); });
    async function openRuntime() {
        const persistence = await createPersistence({ directory, initialState: initialControlPlaneState(defaultWorkflowDefinition) });
        const store = persistence.store;
        const save = store.save.bind(store);
        let injected = false;
        store.save = async () => {
            const pendingCreate = Object.values(store.data.workflowEffectLedger ?? {}).find(effect =>
                effect.status === 'pending' && effect.command?.action === 'createTicket' &&
                store.data.ticketRequests?.[effect.command.requestId] !== undefined);
            if (loseCanonicalResponse && !injected && pendingCreate) {
                await save(); // The canonical Work ticket and request mapping are durable.
                injected = true;
                throw new Error('Persistence acknowledgement was lost after the canonical Work write.');
            }
            return save();
        };
        return createControlPlaneRuntime({ persistence, models: [{ id: 'fixture' }],
            auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () { } });
    }
    runtime = await openRuntime();
    const act = (action, input = {}) => runtime.command({ action, client: 'applied-client', ...input });
    const chat = await act('createConversation', { requestId: 'applied-chat' });
    const scope = { sessionId: chat.sessionId };
    await act('claim', scope);
    await act('saveWorkflow', { workflow: { id: 'applied-effect', name: 'Applied effect', nodes: [{ id: 'create', kind: 'action', name: 'Create ticket', operation: 'create_ticket', input: { title: 'Persisted result', projectId: 'agent-platform' } }] } });
    await act('configure', { ...scope, workflow: 'applied-effect' });
    loseCanonicalResponse = true;
    await act('startWorkflow', scope);
    const failed = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'failed');
    const sessionId = failed.sessions[0].id;
    const instance = failed.sessions[0].flow.instance;
    const effectKey = `${failed.sessions[0].flow.id}:${instance}:create`;
    const persistedTicket = failed.tickets.find(ticket => ticket.title === 'Persisted result');
    assert.ok(persistedTicket, 'the canonical Work write must be persisted before its acknowledgement is lost');
    assert.equal(failed.workflowEffects.find(effect => effect.effectKey === effectKey).status, 'uncertain');
    await closeRuntime();
    const persistedState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    const requestId = `${failed.sessions[0].flow.id}-${instance}`;
    assert.equal(persistedState.ticketRequests[requestId], persistedTicket.id);
    loseCanonicalResponse = false;
    runtime = await openRuntime();
    const afterRestart = await runtime.snapshot();
    const recovered = afterRestart.sessions.find(session => session.id === sessionId);
    assert.ok(['failed', 'interrupted'].includes(recovered.flow.status));
    assert.equal(afterRestart.workflowEffects.find(effect => effect.effectKey === effectKey).status, 'uncertain');
    assert.equal(afterRestart.tickets.filter(ticket => ticket.title === 'Persisted result').length, 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    const idleAfterRestart = await runtime.snapshot();
    assert.equal(idleAfterRestart.sessions.find(session => session.id === sessionId).flow.status, recovered.flow.status);
    assert.equal(idleAfterRestart.tickets.filter(ticket => ticket.title === 'Persisted result').length, 1);
    await runtime.command({ action: 'claim', sessionId, client: 'applied-client' });
    await assert.rejects(runtime.command({ action: 'reconcileWorkflowEffect', sessionId, client: 'applied-client', instance, effectKey, resolution: 'applied', result: { id: 100 } }), /existing ticket/i);
    await runtime.command({ action: 'reconcileWorkflowEffect', sessionId, client: 'applied-client', instance, effectKey, resolution: 'applied', result: { id: persistedTicket.id, title: persistedTicket.title } });
    const completed = await until(() => runtime.snapshot(), value => value.sessions[0]?.flow?.status === 'completed');
    assert.equal(completed.tickets.filter(ticket => ticket.title === 'Persisted result').length, 1);
    assert.equal(completed.tickets.find(ticket => ticket.id === persistedTicket.id).title, 'Persisted result');
    await closeRuntime();
});
test('a conflicted board event decision retries its reserved run against the pinned workflow version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-trigger-retry-'));
    const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () { } };
    let runtime = await createRuntime(options);
    const act = (action, input = {}) => runtime.command({ action, client: 'trigger-retry-client', ...input });
    const ticket = await act('createTicket', { requestId: 'retry-ticket', projectId: 'agent-platform', title: 'Retry trigger' });
    const board = await act('saveBoard', { name: 'Retry board', projectIds: ['agent-platform'], columns: [{ id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' }] });
    const workflow = { id: 'retry-workflow', name: 'Inspect v1', nodes: [{ id: 'inspect', kind: 'action', name: 'Inspect v1', operation: 'inspect_changes' }] };
    await act('saveWorkflow', { workflow });
    const firstRule = await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Inspect review', projectId: 'agent-platform', enabled: true,
            when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' },
            if: [],
            then: { action: "start_workflow", workflowId: workflow.id, workflowVersion: 1 }
        } });
    const secondRule = await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Conflicting inspect review', projectId: 'agent-platform', enabled: true,
            when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' },
            if: [],
            then: { action: "start_workflow", workflowId: workflow.id, workflowVersion: 1 }
        } });
    let snapshot = await act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision, placement: { columnId: 'review' } }).then(() => runtime.snapshot());
    const decision = snapshot.workflowEventDecisions.items.find(trigger => trigger.ruleId === firstRule.id);
    assert.equal(decision.status, 'conflict');
    assert.equal(decision.workflowVersion, 1);
    const moveRevision = snapshot.tickets.find(value => value.id === ticket.id).revision;
    await act('saveWorkflow', { workflow: { ...workflow, name: 'Inspect v2', nodes: [{ ...workflow.nodes[0], name: 'Inspect v2' }] }, baseVersion: 1 });
    await act('saveAutomation', { organizationId: 'personal', revision: secondRule.revision, rule: {
        id: secondRule.id, name: secondRule.name, projectId: secondRule.projectId, enabled: false,
        when: secondRule.when, if: secondRule.if, then: secondRule.then,
    } });
    await act('retryWorkflowEventDecision', { decisionKey: decision.key });
    const retryState = await runtime.snapshot();
    const retriedDecision = retryState.workflowEventDecisions.items.find(value => value.key === decision.key);
    assert.equal(retriedDecision.status, 'started');
    assert.equal(retriedDecision.runId, decision.runId);
    assert.equal((await act('getWorkflowRun', { workflowRunId: decision.runId })).workflowVersion, 1);
    await runtime.close();
    runtime = await createRuntime(options);
    assert.equal((await act('getWorkflowRun', { workflowRunId: decision.runId })).workflowVersion, 1);
    assert.equal((await runtime.snapshot()).tickets.find(value => value.id === ticket.id).revision, moveRevision);
    await runtime.close();
});

test('a no-runner event run resumes the same pinned version after placement is added and daemon restarts', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-runner-event-recovery-'));
    const runnerCalls = [];
    const options = { directory, models: [{ id: 'fixture' }],
        auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
        generate: async function* () { assert.fail('A runner-only workflow must not call a provider.'); },
        runners: { async execute(_runner, command) {
            runnerCalls.push(command.action);
            if (command.action === 'probe') return { repository: '/fixture', tools: ['read_file'], shell: false };
            if (command.action === 'provision') return { path: '/fixture/event-workspace', branch: 'event-recovery' };
            if (command.action === 'diff') return { digest: 'event-recovery-diff', changedFiles: ['inventory.json'] };
            if (command.action === 'remove') return {};
            assert.fail(`Unexpected runner operation ${command.action}`);
        }, async close() {} },
    };
    let runtime = await createRuntime(options);
    const close = async () => { if (runtime) { const current = runtime; runtime = null; await current.close(); } };
    t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
    const act = (action, input = {}) => runtime.command({ action, client: 'runner-event-recovery', ...input });
    const project = await act('saveProject', { name: 'Inventory recovery' });
    await act('selectActiveContext', { context: { organizationId: 'personal', projectId: project.id } });
    const ticket = await act('createTicket', { requestId: 'inventory-recovery-ticket', projectId: project.id, title: 'Reconcile stock' });
    const board = await act('saveBoard', { name: 'Inventory recovery board', projectIds: [project.id], columns: [
        { id: 'inbox', name: 'Inbox' }, { id: 'review', name: 'Review' },
    ] });
    const workflow = { id: 'inventory-runner-recovery', name: 'Inspect v1', nodes: [
        { id: 'inspect', kind: 'action', name: 'Inspect inventory v1', operation: 'inspect_changes' },
    ] };
    await act('saveWorkflow', { projectId: project.id, workflow });
    await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
        name: 'Inspect moved inventory', projectId: project.id, enabled: true,
        when: { event: 'ticket_moved', boardId: board.id, columnId: 'review' }, if: [],
        then: { action: 'start_workflow', workflowId: workflow.id, workflowVersion: 1 },
        concurrency: { policy: 'independent', maxActiveRuns: 2 },
    } });
    const moved = await act('setBoardPlacement', { boardId: board.id, ticketId: ticket.id, revision: ticket.revision,
        placement: { columnId: 'review' } });
    const initial = await until(() => runtime.snapshot(), value => value.workflowRuns?.find(run => run.workflowId === workflow.id && ['paused', 'ready'].includes(run.status)));
    const runSummary = initial.workflowRuns.find(run => run.workflowId === workflow.id);
    const runId = runSummary.id;
    const held = await act('getWorkflowRun', { workflowRunId: runId });
    assert.equal(held.workflowVersion, 1);
    assert.ok(['paused', 'ready'].includes(held.status), JSON.stringify(held));
    assert.equal('sessionId' in held, false);
    assert.equal(initial.sessions.length, 0);
    assert.equal(runnerCalls.filter(value => value === 'provision').length, 0);

    await act('saveWorkflow', { projectId: project.id, baseVersion: 1, workflow: {
        ...workflow, name: 'Inspect v2', nodes: [{ ...workflow.nodes[0], name: 'Inspect inventory v2' }],
    } });
    await act('registerRunner', { name: 'Inventory recovery runner', kind: 'local', repository: '/fixture' });
    const runner = (await runtime.snapshot()).runners[0];
    const currentProject = (await runtime.snapshot()).projects.find(value => value.id === project.id);
    await act('setPlacement', { projectId: project.id, revision: currentProject.revision,
        placement: { mode: 'pinned', runnerId: runner.id } });
    await close();
    runtime = await createRuntime(options);
    const afterRestart = await act('getWorkflowRun', { workflowRunId: runId });
    assert.equal(afterRestart.workflowVersion, 1);
    await act('claimWorkflowRun', { workflowRunId: runId });
    await act('continueWorkflowRun', { workflowRunId: runId, instance: afterRestart.instance });
    const completed = await until(() => act('getWorkflowRun', { workflowRunId: runId }), value => ['completed', 'failed', 'paused'].includes(value.status));
    const finalState = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(completed.status, 'completed', JSON.stringify({ completed, flow: finalState.workflowRuns[runId]?.flow,
        run: finalState.workflowRuns[runId], project: finalState.projects.find(value => value.id === project.id), runnerCalls }));
    assert.equal(completed.workflowVersion, 1);
    assert.ok(completed.activityAttempts.some(attempt => attempt.nodeId === 'inspect' && attempt.status === 'completed'));
    const final = await runtime.snapshot();
    assert.equal(final.workflowRuns.filter(run => run.provenance?.eventId === held.provenance?.eventId).length, 1);
    assert.equal(final.workflowRuns.length, 1);
    assert.equal(final.sessions.length, 0);
    assert.equal(final.tickets.find(value => value.id === ticket.id).revision, moved.revision,
        'resuming the original event run does not repeat the ticket move');
});
test('agent-created tickets use the board trigger seam, while denied creation has no side effect', async () => {
    let turn = 0;
    const options = { directory: await mkdtemp(join(tmpdir(), 'convoy-agent-trigger-')), models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
        generate: async function* () {
            if (turn++ === 0)
                yield { type: 'result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'create-ticket', name: 'create_ticket', arguments: { requestKey: 'agent-ticket', projectId: 'agent-platform', title: 'Agent-created', description: 'Trigger me' } }], stopReason: 'tool', timestamp: Date.now() } };
            else
                yield { type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'No operation.' }], stopReason: 'stop', timestamp: Date.now() } };
        } };
    const runtime = await createRuntime(options);
    const act = (action, input = {}) => runtime.command({ action, client: 'agent-trigger-client', ...input });
    const chat = await act('createConversation', { requestId: 'agent-trigger-chat' });
    await act('claim', { sessionId: chat.sessionId });
    await act('saveWorkflow', { workflow: { id: 'created-trigger', name: 'Created ticket gate', nodes: [{ id: 'gate', kind: 'human', name: 'Gate', prompt: 'Review created ticket' }] } });
    await act('saveAutomation', { organizationId: 'personal', revision: 0, rule: {
            name: 'Created ticket gate', projectId: 'agent-platform', enabled: true,
            when: { event: 'ticket_created' },
            if: [],
            then: { action: "start_workflow", workflowId: 'created-trigger', workflowVersion: 1 }
        } });
    await act('start', { sessionId: chat.sessionId, model: 'fixture', text: 'Record this work', requestId: 'agent-create-run' });
    const pending = await until(() => runtime.snapshot(chat.sessionId), value => value.sessions[0]?.pending);
    await act('decide', { sessionId: chat.sessionId, approvalId: pending.sessions[0].pending.id, allow: true });
    const createdSnapshot = await until(() => runtime.snapshot(), value => value.tickets.find(ticket => ticket.title === 'Agent-created'));
    const created = createdSnapshot.tickets.find(ticket => ticket.title === 'Agent-created');
    const snapshot = await until(() => runtime.snapshot(), value => value.workflowEventDecisions.items
        .some(item => item.workflowId === 'created-trigger' && item.status === 'started'));
    const triggeredDecision = snapshot.workflowEventDecisions.items.find(item => item.workflowId === 'created-trigger');
    const triggeredRun = await act('getWorkflowRun', { workflowRunId: triggeredDecision.runId });
    assert.equal(triggeredRun.status, 'waiting_gate');
    assert.equal('sessionId' in triggeredRun, false, 'a human-only Work automation remains session-free');
    assert.equal(snapshot.workflowEventDecisions.items.filter(value => value.workflowId === 'created-trigger').length, 1);
    await runtime.close();
    const deniedOptions = { ...options, directory: await mkdtemp(join(tmpdir(), 'convoy-agent-denied-')), generate: async function* () { yield { type: 'result', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'denied-ticket', name: 'create_ticket', arguments: { requestKey: 'denied', projectId: 'agent-platform', title: 'Should not exist', description: 'Denied' } }], stopReason: 'tool', timestamp: Date.now() } }; } };
    const deniedRuntime = await createRuntime(deniedOptions);
    const denied = (action, input = {}) => deniedRuntime.command({ action, client: 'denied-client', ...input });
    const deniedChat = await denied('createConversation', { requestId: 'denied-chat' });
    await denied('claim', { sessionId: deniedChat.sessionId });
    await denied('start', { sessionId: deniedChat.sessionId, model: 'fixture', text: 'Do not record', requestId: 'denied-run' });
    const deniedPending = await until(() => deniedRuntime.snapshot(deniedChat.sessionId), value => value.sessions[0]?.pending);
    await denied('decide', { sessionId: deniedChat.sessionId, approvalId: deniedPending.sessions[0].pending.id, allow: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await deniedRuntime.snapshot()).tickets.some(ticket => ticket.title === 'Should not exist'), false);
    await deniedRuntime.close();
});
test('non-zero check results follow the failed graph outcome and consume a bounded revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'convoy-check-failure-'));
    const runners = { execute: async (_runner, command) => command.action === 'probe' ? { repository: '/fixture', tools: ['shell'], shell: true } : command.action === 'provision' ? { path: '/fixture/check', branch: 'check' } : command.action === 'diff' ? { digest: 'check-digest' } : { code: 1, output: 'failed', stopped: false } };
    const options = { directory, models: [{ id: 'fixture' }], auth: { token: async () => 'fixture', status: async () => ({ connected: true }) }, generate: async function* () { }, runners };
    const runtime = await createRuntime(options);
    const act = (action, input = {}) => runtime.command({ action, taskId: '1', client: 'check-client', ...input });
    await act('ensure', { title: 'Check failure' });
    await act('claim', { label: 'Check' });
    await act('saveWorkflow', { workflow: { id: 'check-revision', name: 'Check revision', maxRevisions: 2, nodes: [{ id: 'check', kind: 'check', name: 'Verify', prompt: 'Run verification', checkCommand: 'npm test' }, { id: 'repair', kind: 'human', name: 'Repair review', prompt: 'Review the failed check' }], edges: [{ from: 'check', to: 'repair', outcome: 'failed' }] } });
    await act('registerRunner', { name: 'Check runner', kind: 'local', repository: '/fixture' });
    const runnerId = (await runtime.snapshot()).runners[0].id;
    await act('configure', { runnerId, workflow: 'check-revision' });
    await act('startWorkflow');
    const pending = await until(() => runtime.snapshot('1'), value => value.sessions[0]?.pending);
    await act('decide', { approvalId: pending.sessions[0].pending.id, allow: true });
    const waiting = await until(() => runtime.snapshot('1'), value => value.sessions[0]?.flow?.status === 'waiting_gate');
    const flow = waiting.sessions[0].flow;
    assert.equal(flow.history[0].outcome, 'failed');
    assert.equal(flow.revision, 1);
    assert.equal(waiting.sessions[0].status, 'waiting_gate');
    await runtime.close();
});
