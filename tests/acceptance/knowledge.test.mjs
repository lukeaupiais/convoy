import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../apps/daemon/src/bootstrap/runtime-factory.mjs';

test('wiki authoring, profile-selected model reads, authorization and SQLite restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'convoy-wiki-'));
  let runtime;
  t.after(async () => {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  });
  let round = 0;
  let page;
  const prompts = [];
  const options = {
    directory,
    persistenceBackend: 'sqlite',
    models: [{ id: 'fixture' }],
    auth: { token: async () => 'fixture', status: async () => ({ connected: true }) },
    generate: async function* (input) {
      round++;
      prompts.push(input.prompt);
      assert.ok(input.tools.some((t) => t.name === 'read_knowledge'));
      assert.match(input.prompt.turnInstructions, /Reference orientation/);
      const content =
        round === 1
          ? [
              {
                type: 'toolCall',
                id: 'search',
                name: 'search_knowledge',
                arguments: { query: 'pressure' },
              },
            ]
          : round === 2
            ? [
                {
                  type: 'toolCall',
                  id: 'read',
                  name: 'read_knowledge',
                  arguments: { pageId: page.id, version: 1 },
                },
              ]
            : [{ type: 'text', text: 'Verified reference, not application behavior.' }];
      yield {
        type: 'result',
        message: {
          role: 'assistant',
          content,
          stopReason: round < 3 ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        },
      };
    },
    runners: { close: async () => {}, execute: async () => ({}) },
  };
  runtime = await createRuntime(options);
  const act = (action, input = {}) => runtime.command({ action, client: 'wiki-test', ...input });
  const projectId = 'agent-platform';
  const collection = await act('createKnowledgeCollection', {
    projectId,
    name: 'Maintenance manual',
  });
  let entry = await act('saveKnowledgeDraft', {
    collectionId: collection.id,
    expectedRevision: 0,
    title: 'Start',
    body: 'Reference orientation: inspect the documented prerequisites before testing.',
  });
  entry = await act('publishKnowledgePage', { pageId: entry.id, expectedRevision: entry.revision });
  page = await act('saveKnowledgeDraft', {
    collectionId: collection.id,
    expectedRevision: 0,
    title: 'Pressure inspection',
    body: '# Preconditions\nSwitch off the pump before checking pressure.',
  });
  page = await act('publishKnowledgePage', { pageId: page.id, expectedRevision: page.revision });
  const profile = await act('publishProfile', {
    id: 'wiki-support',
    name: 'Wiki support',
    tools: ['convoy.search_knowledge', 'convoy.read_knowledge'],
    skills: [],
    knowledge: { collectionIds: [collection.id], entryPage: { pageId: entry.id, version: 1 } },
  });
  const conversation = await act('createConversation', {
    requestId: 'wiki-chat',
    projectId,
    placement: { mode: 'none' },
  });
  await act('claim', { sessionId: conversation.id });
  await act('setCapabilityProfile', {
    sessionId: conversation.id,
    profile: { id: profile.id, version: profile.version },
  });
  await act('start', {
    sessionId: conversation.id,
    text: 'Find pressure inspection prerequisites.',
    model: 'fixture',
    requestId: 'wiki-start',
  });
  let session;
  for (let i = 0; i < 300; i++) {
    session = (await runtime.snapshot(conversation.id)).sessions[0];
    if (!session.control.busy && ['awaiting_review', 'failed'].includes(session.status)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(session.status, 'awaiting_review', JSON.stringify(session.events.slice(-5)));
  assert.equal(round, 3);
  assert.match(JSON.stringify(prompts.at(-1).messages), /Switch off the pump/);
  assert.match(JSON.stringify(prompts.at(-1).messages), /reference_data_not_instructions/);
  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.knowledgeCollections.length, 1);
  assert.equal('knowledgePages' in snapshot, false);
  assert.equal('knowledgeRevisions' in snapshot, false);
  const workload = await act('createWorkloadIdentity', {
    organizationId: 'personal',
    displayName: 'Wiki reader',
  });
  const reader = { kind: 'workload', workloadIdentityId: workload.id };
  await act('createMembership', {
    organizationId: 'personal',
    principal: reader,
    scope: { kind: 'organization', organizationId: 'personal' },
    roles: ['member'],
  });
  const membership = await act('createMembership', {
    organizationId: 'personal',
    principal: reader,
    scope: { kind: 'project', projectId },
    roles: ['contributor'],
  });
  const readerAct = (action, input = {}) =>
    runtime.command({ action, client: 'wiki-reader', ...input }, reader);
  await readerAct('selectActiveContext', { context: { organizationId: 'personal', projectId } });
  assert.equal((await readerAct('readKnowledgePage', { pageId: page.id, version: 1 })).version, 1);
  assert.equal((await readerAct('listKnowledgePages', { projectId, collectionId: collection.id })).pages.length, 2);
  await assert.rejects(readerAct('listKnowledgePages', { projectId, draft: true }), /authorized|Context is not available/);
  await assert.rejects(readerAct('updateKnowledgeCollection', { collectionId: collection.id, expectedRevision: 1, name: 'Unauthorized', description: '', startPageIds: [], pageOrder: [] }), /authorized|Context is not available/);
  const arranged = await act('updateKnowledgeCollection', { collectionId: collection.id, expectedRevision: 1, name: collection.name, description: 'Published maintenance guidance', startPageIds: [entry.id], pageOrder: [entry.id, page.id] });
  assert.equal(arranged.revision, 2);

  await assert.rejects(
    readerAct('readKnowledgePage', { pageId: page.id, draft: true }),
    /authorized|Context is not available/,
  );
  await assert.rejects(
    readerAct('publishKnowledgePage', { pageId: page.id, expectedRevision: page.revision }),
    /authorized|Context is not available/,
  );
  const other = await act('saveProject', { name: 'Unrelated equipment inventory' });
  const secret = await act('createKnowledgeCollection', {
    projectId: other.id,
    name: 'Private reference',
  });
  await assert.rejects(
    readerAct('searchKnowledge', { projectId, collectionId: secret.id, query: 'private' }),
    /authorized|Context is not available/,
  );
  await act('updateMembership', {
    organizationId: 'personal',
    membershipId: membership.id,
    state: 'revoked',
  });
  await assert.rejects(
    readerAct('readKnowledgePage', { pageId: page.id, version: 1 }),
    /authorized|context|membership/i,
  );
  const old = await act('readKnowledgePage', { pageId: page.id, version: 1 });
  await runtime.close();
  runtime = await createRuntime(options);
  assert.deepEqual(await act('readKnowledgePage', { pageId: page.id, version: 1 }), old);
  assert.equal((await runtime.snapshot()).knowledgeCollections[0].description, 'Published maintenance guidance');
  const archived = await act('setKnowledgeCollectionState', {
    collectionId: collection.id,
    expectedRevision: 2,
    state: 'archived',
  });
  assert.equal(archived.state, 'archived');
  await assert.rejects(act('readKnowledgePage', { pageId: page.id, version: 1 }), /unavailable/);
});
