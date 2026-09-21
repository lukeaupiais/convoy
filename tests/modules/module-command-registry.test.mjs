import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createModuleCommandRegistry,
  createSessionCommandRegistry,
} from '../../apps/daemon/src/control-plane/module-command-registry.mjs';

test('module command registry assigns every action to exactly one module', async () => {
  const calls = [];
  const registry = createModuleCommandRegistry([
    {
      id: 'library',
      commands: ['publishSkill'],
      async command(command, context) {
        calls.push({ command, context });
        return { published: true };
      },
    },
  ]);

  assert.equal(registry.owner('publishSkill'), 'library');
  assert.equal(registry.handles('publishSkill'), true);
  assert.equal(registry.handles('createTicket'), false);
  assert.deepEqual(
    await registry.execute({ action: 'publishSkill' }, { client: 'operator' }),
    { published: true },
  );
  assert.deepEqual(calls, [{ command: { action: 'publishSkill' }, context: { client: 'operator' } }]);
});

test('module command registry rejects ambiguous or malformed registrations at startup', () => {
  const command = () => undefined;
  assert.throws(
    () => createModuleCommandRegistry([{ id: 'library', commands: [], command }]),
    /at least one command/,
  );
  assert.throws(
    () =>
      createModuleCommandRegistry([
        { id: 'library', commands: ['publishSkill'], command },
        { id: 'other', commands: ['publishSkill'], command },
      ]),
    /already owned by library/,
  );
});

test('module command registry requires every public command to name one owner', () => {
  const module = { id: 'library', commands: ['publishSkill'], command: () => undefined };
  assert.throws(
    () => createModuleCommandRegistry([module], { expectedActions: ['publishSkill', 'saveWorkflow'] }),
    /saveWorkflow/,
  );
  assert.throws(
    () =>
      createModuleCommandRegistry([module], {
        expectedActions: ['publishSkill'],
        orchestrationActions: ['publishSkill'],
      }),
    /both module-owned and orchestration-owned/,
  );
  assert.doesNotThrow(() =>
    createModuleCommandRegistry([module], {
      expectedActions: ['publishSkill', 'saveWorkflow'],
      orchestrationActions: ['saveWorkflow'],
    }),
  );
});

test('session command registry dispatches only after runtime supplies the session context', async () => {
  const registry = createSessionCommandRegistry([
    {
      id: 'conversations',
      sessionCommands: ['linkTicket'],
      sessionCommand(session, command, context) {
        return { sessionId: session.id, ticketId: command.ticketId, lease: context.lease };
      },
    },
  ]);
  assert.equal(registry.owner('linkTicket'), 'conversations');
  assert.deepEqual(
    registry.execute({ id: 'chat-1' }, { action: 'linkTicket', ticketId: 7 }, { lease: 'verified' }),
    { sessionId: 'chat-1', ticketId: 7, lease: 'verified' },
  );
  assert.throws(() => registry.execute({}, { action: 'missing' }), /No module owns/);
});
