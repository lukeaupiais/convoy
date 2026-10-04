import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';
import { createPersistence } from '../../apps/daemon/src/adapters/persistence/index.mjs';
import { createRuntime as createControlPlaneRuntime } from '../../apps/daemon/src/control-plane/runtime.mjs';
import { initialControlPlaneState } from '../../apps/daemon/src/control-plane/state-schema.mjs';
import { defaultWorkflowDefinition } from '../../apps/daemon/src/modules/workflows/index.mjs';

async function waitFor(read, predicate, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${message}: ${JSON.stringify(await read())}`);
}

async function fixture(t, { persistence, initial } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-workflow-generic-defaults-'));
  const calls = { provider: 0, runner: 0 };
  const options = {
    directory,
    models: [{ id: 'generic-defaults-fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* () {
      calls.provider += 1;
      yield {
        type: 'result',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Plain conversation completed.' }],
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      };
    },
    runners: {
      execute: async () => {
        calls.runner += 1;
        assert.fail('A workflow without a declared runner resource must not call a runner.');
      },
      close: async () => {},
    },
  };
  let runtime;
  let activePersistence = persistence;
  const open = async () => {
    runtime = activePersistence
      ? await createControlPlaneRuntime({ persistence: activePersistence, ...options })
      : await createRuntime(options);
    return runtime;
  };
  if (initial) {
    activePersistence = await createPersistence({ directory, initialState: initial });
    await activePersistence.store.save();
  }
  await open();
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const client = 'workflow-generic-defaults-acceptance';
  const act = (action, fields = {}) => runtime.command({ action, client, ...fields });
  return {
    directory,
    options,
    calls,
    act,
    async snapshot() {
      return runtime.snapshot(undefined, client);
    },
    async readState() {
      return JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    },
    async restart() {
      await runtime.close();
      runtime = await createRuntime(options);
      activePersistence = undefined;
    },
  };
}

async function createProjects(f) {
  const organization = await f.act('createOrganization', {
    slug: `generic-defaults-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    displayName: 'Generic defaults acceptance',
    kind: 'team',
  });
  const inventory = await f.act('saveProject', {
    organizationId: organization.id,
    name: 'Inventory operations',
  });
  const publication = await f.act('saveProject', {
    organizationId: organization.id,
    name: 'Publication operations',
  });
  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: inventory.id },
  });
  return { organization, inventory, publication };
}

test('fresh deployment does not seed the coding workflow or its default reference', async (t) => {
  const f = await fixture(t);
  const freshState = await f.readState();
  const freshSnapshot = await f.snapshot();
  assert.deepEqual(freshState.workflows, [], 'a fresh deployment has no seeded coding graph');
  assert.equal(freshState.defaultWorkflowId, undefined);
  assert.deepEqual(freshState.defaultWorkflowIds, { organizations: {}, projects: {} });
  assert.deepEqual(freshSnapshot.defaultWorkflowIds, { organizations: {}, projects: {} });
  assert.equal(freshSnapshot.defaultWorkflowId, undefined);
  assert.equal(freshSnapshot.sessions.length, 0);
  assert.equal(freshSnapshot.runners.length, 0);
});

test('fresh inventory and publication projects have no implicit workflow and plain conversations remain optional', async (t) => {
  const f = await fixture(t);
  const { organization, inventory, publication } = await createProjects(f);
  const snapshot = await f.snapshot();

  assert.equal(snapshot.defaultWorkflowIds.organizations[organization.id], undefined);
  assert.equal(snapshot.defaultWorkflowIds.projects[inventory.id], undefined);
  assert.equal(snapshot.defaultWorkflowIds.projects[publication.id], undefined);
  assert.equal(snapshot.defaultWorkflowId, undefined);
  assert.equal(
    snapshot.workflows.some(
      (workflow) => workflow.projectId === inventory.id || workflow.projectId === publication.id,
    ),
    false,
    'fresh projects do not receive a seeded workflow definition',
  );

  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: inventory.id },
  });
  const inventoryChat = await f.act('createConversation', {
    requestId: 'fresh-inventory-conversation',
    projectId: inventory.id,
  });
  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: publication.id },
  });
  const publicationChat = await f.act('createConversation', {
    requestId: 'fresh-publication-conversation',
    projectId: publication.id,
  });
  for (const sessionId of [inventoryChat.sessionId, publicationChat.sessionId]) {
    const projectId = sessionId === inventoryChat.sessionId ? inventory.id : publication.id;
    await f.act('selectActiveContext', { context: { organizationId: organization.id, projectId } });
    await f.act('claim', { sessionId });
    await f.act('configure', { sessionId, workflow: true });
    const session = (await f.snapshot()).sessions.find((value) => value.id === sessionId);
    assert.equal(session.workflow ?? null, null);
    assert.equal(session.flow ?? null, null);
    assert.equal(session.runnerId ?? null, null);
    assert.equal(session.workspace ?? null, null);
  }

  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: inventory.id },
  });
  await assert.rejects(
    f.act('startWorkflow', { sessionId: inventoryChat.sessionId }),
    /select and apply a workflow|workflow.*(?:not configured|not active)|active workflow/i,
    'starting an absent workflow fails only when the session explicitly requests it',
  );
  await assert.rejects(
    f.act('startWorkflowRun', {
      projectId: inventory.id,
      workflowId: 'delivery',
      workflowVersion: 1,
    }),
    /not available|not found/i,
    'an explicit request for an unconfigured workflow fails closed',
  );
  await assert.rejects(
    f.act('saveWorkflow', {
      projectId: inventory.id,
      workflow: {
        id: 'check-without-command',
        name: 'Check without a configured command',
        nodes: [
          {
            id: 'verify',
            name: 'Verify inventory change',
            kind: 'agent',
            prompt: 'Verify the change.',
            requiresCheck: true,
          },
        ],
        edges: [],
      },
    }),
    /exact check command|check command/i,
    'a required check cannot receive an invented default command',
  );
  assert.equal(
    (await f.snapshot()).workflows.some((workflow) => workflow.id === 'check-without-command'),
    false,
  );
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.runner, 0);
  const plainSessions = await f.snapshot();
  const publicationSession = plainSessions.sessions.find(
    (value) => value.id === publicationChat.sessionId,
  );
  assert.equal(publicationSession.status, 'idle');
  assert.equal(publicationSession.workflow ?? null, null);
  assert.equal(publicationSession.flow ?? null, null);
  assert.equal(publicationSession.assignment ?? null, null);
  assert.equal(publicationSession.runnerId ?? null, null);
  assert.equal(f.calls.provider, 0, 'creating a plain conversation must not start a provider turn');
  assert.equal(f.calls.runner, 0);
  assert.equal(plainSessions.workflowRuns.length, 0);
});

test('explicit project default selects the configured workflow and preserves its active pin on restart', async (t) => {
  const f = await fixture(t);
  const { organization, publication } = await createProjects(f);
  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: publication.id },
  });
  const workflow = {
    id: 'publication-review-template',
    name: 'Publication review',
    nodes: [
      {
        id: 'review',
        name: 'Review publication',
        kind: 'human',
        prompt: 'Review the submitted publication.',
        humanTask: {
          outcomes: [
            { id: 'approved', label: 'Approve publication' },
            { id: 'changes_requested', label: 'Request changes' },
          ],
        },
      },
    ],
    edges: [],
  };
  const published = await f.act('saveWorkflow', {
    projectId: publication.id,
    workflow,
    makeDefault: true,
  });
  const configured = await f.snapshot();
  assert.equal(configured.defaultWorkflowIds.projects[publication.id], published.id);
  assert.equal(configured.defaultWorkflowId, published.id);

  const conversation = await f.act('createConversation', {
    requestId: 'configured-publication-conversation',
    projectId: publication.id,
  });
  await f.act('claim', { sessionId: conversation.sessionId });
  await f.act('configure', { sessionId: conversation.sessionId, workflow: true });
  const configuredSession = (await f.snapshot()).sessions.find(
    (session) => session.id === conversation.sessionId,
  );
  assert.equal(configuredSession.workflow.id, published.id);
  assert.equal(configuredSession.workflow.version, published.version);
  await f.act('startWorkflow', { sessionId: conversation.sessionId });
  const waiting = await waitFor(
    () => f.snapshot(),
    (value) =>
      value.sessions.find((session) => session.id === conversation.sessionId)?.flow?.status ===
      'waiting_gate',
    'the explicitly configured human workflow did not start',
  );
  const waitingSession = waiting.sessions.find((session) => session.id === conversation.sessionId);
  const flowIdentity = {
    id: waitingSession.flow.id,
    instance: waitingSession.flow.instance,
    nodeId: waitingSession.flow.nodeId,
    status: waitingSession.flow.status,
  };
  const rawBeforeRestart = structuredClone(
    (await f.readState()).workflowRuns[flowIdentity.id].workflow,
  );
  assert.equal(rawBeforeRestart.id, published.id);
  assert.equal(rawBeforeRestart.version, published.version);
  assert.equal(rawBeforeRestart.nodes[0].humanTask.outcomes[0].id, 'approved');
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.runner, 0);

  const revised = await f.act('saveWorkflow', {
    projectId: publication.id,
    workflow: {
      ...workflow,
      nodes: [
        {
          ...workflow.nodes[0],
          prompt: 'Review the revised publication.',
        },
      ],
    },
    baseVersion: published.version,
    makeDefault: true,
  });
  assert.equal(revised.version, published.version + 1);
  assert.equal(
    (await f.readState()).workflowRuns[flowIdentity.id].workflow.version,
    published.version,
  );

  await f.restart();
  await f.act('selectActiveContext', {
    context: { organizationId: organization.id, projectId: publication.id },
  });
  const afterRestart = await f.snapshot();
  assert.equal(afterRestart.defaultWorkflowIds.organizations[organization.id], undefined);
  assert.equal(afterRestart.defaultWorkflowIds.projects[publication.id], published.id);
  const resumed = afterRestart.sessions.find((session) => session.id === conversation.sessionId);
  assert.deepEqual(
    {
      id: resumed.flow.id,
      instance: resumed.flow.instance,
      nodeId: resumed.flow.nodeId,
      status: resumed.flow.status,
    },
    flowIdentity,
  );
  assert.deepEqual((await f.readState()).workflowRuns[flowIdentity.id].workflow, rawBeforeRestart);
  assert.equal(resumed.workflow.version, published.version);
  assert.ok(
    afterRestart.workflows.some(
      (value) => value.id === published.id && value.version === revised.version,
    ),
  );
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.runner, 0);
});

test('legacy default graphs and check commands retain exact stored bytes across migration and restart', async (t) => {
  const legacyWorkflow = {
    id: 'legacy-delivery-default',
    name: 'Legacy delivery graph',
    steps: [
      { id: 'review', name: 'Review', kind: 'human', prompt: 'Approve the plan.' },
      {
        id: 'verify',
        name: 'Verify',
        kind: 'agent',
        prompt: 'Run the existing project check.',
        requiresCheck: true,
        checkCommand: 'npm test',
      },
    ],
    edges: [{ from: 'review', to: 'verify', outcome: 'approved' }],
    entryNode: 'review',
  };
  const initial = initialControlPlaneState(defaultWorkflowDefinition);
  initial.workflows = [structuredClone(legacyWorkflow)];
  initial.defaultWorkflowId = legacyWorkflow.id;
  const f = await fixture(t, { initial });
  const project = await f.act('saveProject', {
    organizationId: 'personal',
    name: 'Legacy workflow migration',
  });
  await f.act('selectActiveContext', {
    context: { organizationId: 'personal', projectId: project.id },
  });
  const before = await f.snapshot();
  assert.equal(before.defaultWorkflowIds.organizations.personal, legacyWorkflow.id);
  assert.deepEqual(
    (await f.readState()).workflows.find((workflow) => workflow.id === legacyWorkflow.id),
    legacyWorkflow,
  );
  const conversation = await f.act('createConversation', {
    requestId: 'legacy-default-conversation',
    projectId: project.id,
  });
  await f.act('claim', { sessionId: conversation.sessionId });
  await f.act('configure', { sessionId: conversation.sessionId, workflow: true });
  await f.act('startWorkflow', { sessionId: conversation.sessionId });
  const waiting = await waitFor(
    () => f.snapshot(),
    (value) =>
      value.sessions.find((session) => session.id === conversation.sessionId)?.flow?.status ===
      'waiting_gate',
    'the active legacy graph did not remain at its human gate',
  );
  const active = waiting.sessions.find((session) => session.id === conversation.sessionId);
  const legacyBytes = structuredClone((await f.readState()).workflowRuns[active.flow.id].workflow);
  const storedLegacyDefinition = structuredClone(
    (await f.readState()).workflows.find((workflow) => workflow.id === legacyWorkflow.id),
  );
  const identity = {
    id: active.flow.id,
    instance: active.flow.instance,
    nodeId: active.flow.nodeId,
    status: active.flow.status,
  };
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.runner, 0);

  await f.restart();
  const restarted = await f.snapshot();
  assert.equal(restarted.defaultWorkflowIds.organizations.personal, legacyWorkflow.id);
  assert.deepEqual(
    (await f.readState()).workflows.find((workflow) => workflow.id === legacyWorkflow.id),
    storedLegacyDefinition,
  );
  const pinned = restarted.sessions.find((session) => session.id === conversation.sessionId);
  assert.deepEqual(
    {
      id: pinned.flow.id,
      instance: pinned.flow.instance,
      nodeId: pinned.flow.nodeId,
      status: pinned.flow.status,
    },
    identity,
  );
  assert.deepEqual((await f.readState()).workflowRuns[active.flow.id].workflow, legacyBytes);
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.runner, 0);
});
