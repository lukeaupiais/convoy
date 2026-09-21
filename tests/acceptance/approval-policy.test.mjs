import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

const result = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp: Date.now(),
});
const call = (id, name, args) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
  stopReason: 'toolUse',
  timestamp: Date.now(),
});
const until = async (read) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out');
};

test('safe reads need no prompt and an always-allow decision creates a revocable exact rule', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-approval-policy-'));
  let sequence = 0;
  const runtime = await createRuntime({
    directory,
    models: [{ id: 'test' }],
    auth: { token: async () => 'fake', status: async () => ({ connected: true }) },
    runners: {
      execute: async (_runner, command) => {
        if (command.action === 'probe')
          return {
            repository: '/fixture',
            tools: ['read_file', 'shell'],
            shell: true,
          };
        if (command.action === 'provision')
          return { path: `/fixture/${command.workspaceId}`, branch: command.workspaceId };
        if (command.action === 'diff') return { digest: 'same' };
        if (command.name === 'read_file') return { text: 'fixture', sha256: 'hash' };
        return { code: 0, output: 'RULE_OK', stopped: false };
      },
    },
    generate: async function* () {
      sequence++;
      if (sequence % 2 === 0) yield { type: 'result', message: result('done') };
      else if (sequence === 1)
        yield {
          type: 'result',
          message: call('read-1', 'read_file', { path: 'README.md' }),
        };
      else
        yield {
          type: 'result',
          message: call(`shell-${sequence}`, 'shell', { command: 'printf RULE_OK' }),
        };
    },
  });
  t.after(() => runtime.close());
  const command = (action, input = {}) =>
    runtime.command({ action, client: 'approval-policy-test', ...input });
  const runner = await command('registerRunner', {
    name: 'Fixture',
    kind: 'local',
    repository: '/fixture',
    projectIds: ['agent-platform'],
  });
  const conversation = await command('createConversation', {
    requestId: 'approval-chat',
    projectId: 'agent-platform',
    placement: { mode: 'pinned', runnerId: runner.id },
  });
  const sessionId = conversation.sessionId;
  const session = async () => (await runtime.snapshot(sessionId)).sessions[0];
  await command('claim', { sessionId });

  await command('start', { sessionId, requestId: 'read', text: 'read', model: 'test' });
  await until(async () => !(await session()).control.busy);
  assert.equal(
    (await session()).events.some((event) => event.type === 'approval_requested'),
    false,
  );

  await command('start', { sessionId, requestId: 'shell-one', text: 'run', model: 'test' });
  const pending = await until(async () => (await session()).pending);
  assert.match(pending.rule.label, /shell/);
  await command('decide', { sessionId, approvalId: pending.id, decision: 'allow_always' });
  await until(async () => !(await session()).control.busy);
  let snapshot = await runtime.snapshot(sessionId);
  assert.equal(snapshot.approvalRules.length, 1);
  const audit = await command('querySecurityAudit', { organizationId: 'personal', limit: 500 });
  const reviewed = audit.records.find(
    (record) =>
      record.action === 'execution.approval' &&
      record.approval?.approvalId === pending.id &&
      record.outcome === 'reviewed',
  );
  assert.equal(reviewed.approval.decision, 'allow_always');
  assert.match(reviewed.revisions.executionGrantDigest, /^[a-f0-9]{64}$/);

  const approvalsBefore = snapshot.sessions[0].events.filter(
    (event) => event.type === 'approval_requested',
  ).length;
  await command('start', {
    sessionId,
    requestId: 'shell-two',
    text: 'run again',
    model: 'test',
  });
  await until(async () => !(await session()).control.busy);
  snapshot = await runtime.snapshot(sessionId);
  assert.equal(
    snapshot.sessions[0].events.filter((event) => event.type === 'approval_requested').length,
    approvalsBefore,
  );
  assert.ok(snapshot.sessions[0].events.some((event) => event.type === 'approval_rule_applied'));

  await command('removeApprovalRule', { ruleId: snapshot.approvalRules[0].id });
  assert.equal((await runtime.snapshot()).approvalRules.length, 0);

  const project = (await runtime.snapshot()).projects.find((item) => item.id === 'agent-platform');
  await command('setExecutionProfile', {
    projectId: project.id,
    revision: project.revision,
    profile: 'auto',
  });
  const automatic = await command('createConversation', {
    requestId: 'automatic-policy-chat',
    projectId: 'agent-platform',
    placement: { mode: 'pinned', runnerId: runner.id },
  });
  await command('claim', { sessionId: automatic.sessionId });
  await command('start', {
    sessionId: automatic.sessionId,
    requestId: 'automatic-shell',
    text: 'run automatically',
    model: 'test',
  });
  const automaticSession = async () => (await runtime.snapshot(automatic.sessionId)).sessions[0];
  await until(async () => !(await automaticSession()).control.busy);
  assert.equal((await automaticSession()).pending, null);
  assert.ok((await automaticSession()).events.some((event) => event.type === 'policy_reviewed'));
});
