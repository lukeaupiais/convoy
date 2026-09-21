import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork } from '../../apps/daemon/src/modules/work/index.mjs';

test('Work owns project and ticket commands while exposing completed mutations to its coordinator port', async () => {
  const observed = [];
  const state = { sessions: {}, projects: [], runners: [] };
  const execution = {
    legacyTicketSeeds: () => [],
    migratedStatus: () => undefined,
    reservedTicketIds: () => [],
    assertEditable: () => {},
    syncTicket: () => {},
    isBusy: () => false,
  };
  const bytes = new Map();
  const contextFiles = {
    async add(owner, input) {
      const id = 'a'.repeat(64);
      const content = Buffer.from(input.data, 'base64');
      const meta = {
        id,
        name: input.name,
        mime: 'text/plain',
        size: content.length,
        hash: 'hash',
        at: 'now',
      };
      owner.contextFiles[id] = meta;
      bytes.set(id, content);
      return meta;
    },
    async read(owner, id) {
      if (!owner.contextFiles[id]) throw new Error('Attachment not found.');
      return { meta: owner.contextFiles[id], bytes: bytes.get(id) };
    },
  };
  const work = createWork({
    state,
    execution,
    contextFiles,
    save: async () => {},
    referencedColumn: () => false,
    referencedBoard: () => false,
    afterCommand: async (command, result) => {
      observed.push(command.action);
      return result;
    },
  });

  const project = await work.command({ action: 'saveProject', name: 'Convoy' });
  const ticket = await work.command({
    action: 'createTicket',
    requestId: 'first-ticket',
    projectId: project.id,
    title: 'Modular command routing',
  });

  assert.equal(work.id, 'work');
  assert(work.commands.includes('createTicket'));
  assert.equal(work.catalog.ticket(ticket.id).title, 'Modular command routing');
  assert.deepEqual(observed, ['saveProject', 'createTicket']);

  const attached = await work.command({
    action: 'attachTicketFile',
    taskId: ticket.id,
    revision: ticket.revision,
    name: 'scope.md',
    mime: 'text/plain',
    data: Buffer.from('# Scope').toString('base64'),
  });
  assert.equal(attached.attachments[0].name, 'scope.md');
  assert.equal(
    (await work.catalog.readAttachment(ticket.id, attached.attachments[0].id)).bytes.toString(),
    '# Scope',
  );
  const removed = await work.command({
    action: 'removeTicketFile',
    taskId: ticket.id,
    revision: attached.revision,
    attachmentId: attached.attachments[0].id,
  });
  assert.deepEqual(removed.attachments, []);
  assert.deepEqual(observed, [
    'saveProject',
    'createTicket',
    'attachTicketFile',
    'removeTicketFile',
  ]);
});
