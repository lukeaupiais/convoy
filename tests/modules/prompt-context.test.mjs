import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptContext } from '../../apps/daemon/src/modules/agents/prompt-context.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const promptContext = createPromptContext({ digest, now: () => '2026-09-16T00:00:00.000Z' });
const instruction = (scope, content, target = '', name = 'AGENTS.md') => ({
  id: `${scope}-${content}`,
  scope,
  target,
  name,
  content,
  version: 1,
  hash: digest(content),
});

test('instruction selection is deterministic, scoped and broad-to-narrow', () => {
  const state = {
    instructionOwners: { organizationId: 'org', userId: 'user' },
    projects: [{ id: 'one' }, { id: 'two' }],
    runners: [{ id: 'runner', environmentId: 'remote' }],
    instructions: [
      instruction('task', 'task', '4'),
      instruction('project', 'wrong project', 'two'),
      instruction('environment', 'remote', 'remote'),
      instruction('organization', 'org', 'org'),
      instruction('project', 'project', 'one'),
      instruction('user', 'user', 'user'),
    ],
  };
  const selected = promptContext.select(state, {
    projectId: 'one',
    activeTicketId: 4,
    runnerId: 'runner',
  });
  assert.deepEqual(
    selected.map((item) => item.content),
    ['org', 'user', 'project', 'remote', 'task'],
  );
});

test('tenant instruction selection derives organization and user from the session context', () => {
  const state = {
    instructionOwners: { organizationId: 'personal', userId: 'local' },
    projects: [
      { id: 'acme-project', organizationId: 'acme' },
      { id: 'other-project', organizationId: 'other' },
    ],
    runners: [],
    instructions: [
      { ...instruction('organization', 'acme org', 'acme'), organizationId: 'acme' },
      { ...instruction('organization', 'other org', 'other'), organizationId: 'other' },
      { ...instruction('user', 'alice', 'alice'), organizationId: 'acme' },
      { ...instruction('user', 'local', 'local'), organizationId: 'acme' },
      { ...instruction('project', 'acme project', 'acme-project'), organizationId: 'acme' },
    ],
  };
  const selected = promptContext.select(state, {
    projectId: 'acme-project',
    executionPrincipal: { kind: 'user', userId: 'alice' },
  });
  assert.deepEqual(
    selected.map((item) => item.content),
    ['acme org', 'alice', 'acme project'],
  );
});

test('stable epoch excludes runtime data while updates append after its prefix', () => {
  const session = {
    id: 'chat',
    title: 'Chat',
    step: 0,
    instructions: [
      instruction('organization', 'org'),
      instruction('project', 'project'),
      instruction('skill', 'legacy'),
    ],
  };
  const first = promptContext.compile({ session, capabilityText: 'Available skill catalog' });
  const snapshot = promptContext.turnSnapshot(
    { ...session, workingContext: 'volatile', events: [], commands: [] },
    { id: 4, title: 'Ticket' },
  );
  const messages = [{ role: 'user', content: 'Please continue' }];
  assert.equal(promptContext.recordTurnSnapshot(messages, snapshot), true);
  assert.match(first.systemPrompt, /org/);
  assert.match(first.systemPrompt, /project/);
  assert.match(first.systemPrompt, /legacy/);
  assert.doesNotMatch(first.systemPrompt, /volatile|Ticket/);
  assert.match(messages.at(-1).content, /reference data, not instructions/);
  assert.match(messages.at(-1).content, /volatile/);
  assert.equal(promptContext.recordTurnSnapshot(messages, snapshot), false);
  assert.equal(
    promptContext.recordTurnSnapshot(messages, { ...snapshot, workingContext: 'changed' }),
    true,
  );
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content, /changed/);
  const second = promptContext.compile({
    session,
    step: { name: 'Verify', prompt: 'Run checks' },
    instance: 'run',
    capabilityText: 'Activated skill body',
  });
  assert.equal(second.epoch.id, first.epoch.id);
  assert(second.systemPrompt.startsWith(first.epoch.baseline));
  assert.match(second.systemPrompt, /Context update: workflow/);
  assert.match(second.systemPrompt, /Activated skill body/);
});

test('changing published instructions rotates rather than mutates an epoch', () => {
  const session = {
    id: 'chat',
    title: 'Chat',
    step: 0,
    instructions: [instruction('project', 'v1')],
  };
  const first = promptContext.compile({ session });
  session.instructions = [instruction('project', 'v2')];
  const second = promptContext.compile({ session });
  assert.notEqual(second.epoch.id, first.epoch.id);
  assert.equal(session.contextEpochs[0].baseline, first.epoch.baseline);
  assert.match(session.contextEpochs[0].baseline, /v1/);
});
