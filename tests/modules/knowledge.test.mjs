import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledge } from '../../apps/daemon/src/modules/knowledge/index.mjs';
import { createCapabilities } from '../../apps/daemon/src/modules/library/index.mjs';
import { sections, links } from '../../apps/daemon/src/modules/knowledge/text.mjs';

function fixture() {
  const state = {
    projects: [
      { id: 'support', organizationId: 'personal' },
      { id: 'workshop', organizationId: 'personal' },
      { id: 'foreign', organizationId: 'other' },
    ],
    sessions: {},
    runners: [],
  };
  const knowledge = createKnowledge({ state, save: async () => {} });
  const act = (action, fields = {}) =>
    knowledge.command({ action, client: 'operator', ...fields }, { validateClient() {} });
  async function publish(collectionId, title, body, aliases = []) {
    const p = await act('saveKnowledgeDraft', {
      collectionId,
      expectedRevision: 0,
      title,
      body,
      aliases,
    });
    return act('publishKnowledgePage', { pageId: p.id, expectedRevision: p.revision });
  }
  return { state, knowledge, act, publish };
}

test('link and section projection ignores code examples and distinguishes duplicate headings', () => {
  const body =
    '# Step\n[Related](wiki:real-page)\n```md\n# Fake\n[Example](wiki:fake-page)\n```\n# Step\nInline `[Example](wiki:inline-page)`';
  assert.deepEqual(links(body), ['real-page']);
  assert.deepEqual(
    sections(body).map((s) => s.anchor),
    ['step', 'step-1'],
  );
});

test('entry pages are bounded and references keep exact revisions when a newer page is published', async () => {
  const f = fixture();
  const c = await f.act('createKnowledgeCollection', { projectId: 'support', name: 'Reference' });
  const p = await f.publish(c.id, 'Entry', 'Original entry');
  const session = {
    projectId: 'support',
    capabilityProfile: {
      knowledge: { collectionIds: [c.id], entryPage: { pageId: p.id, version: 1 } },
    },
  };
  let next = await f.act('saveKnowledgeDraft', {
    collectionId: c.id,
    pageId: p.id,
    expectedRevision: p.revision,
    title: 'Updated',
    body: 'Changed entry',
  });
  await f.act('publishKnowledgePage', { pageId: p.id, expectedRevision: next.revision });
  assert.match(f.knowledge.orientation(session), /Original entry/);
  const large = await f.publish(c.id, 'Long manual', 'x'.repeat(6001));
  assert.throws(
    () =>
      f.knowledge.validateSelection(
        { collectionIds: [c.id], entryPage: { pageId: large.id, version: 1 } },
        'personal',
      ),
    /6000/,
  );
  const linked = await f.publish(c.id, 'Related', `[Entry](wiki:${p.id})`);
  const read = await f.act('readKnowledgePage', { pageId: p.id, version: 1 });
  assert.equal(read.backlinks[0].pageId, linked.id);
  assert.equal(read.backlinks[0].title, 'Related');
  const foreign = await f.act('createKnowledgeCollection', {
    projectId: 'foreign',
    name: 'Restricted',
  });
  assert.throws(
    () => f.knowledge.validateSelection({ collectionIds: [foreign.id] }, 'personal'),
    /unavailable/,
  );
});

test('published revisions survive edits; search excludes drafts, archives and other projects', async () => {
  const f = fixture();
  const c = await f.act('createKnowledgeCollection', {
    projectId: 'support',
    name: 'Product support',
  });
  const other = await f.act('createKnowledgeCollection', {
    projectId: 'workshop',
    name: 'Equipment maintenance',
  });
  const p = await f.publish(
    c.id,
    'Confirmação',
    '# Preconditions\nA missing field differs from an explicit none value.\n# Action\nConfirm only after checking the actual field.',
    ['confirmacao'],
  );
  await f.publish(other.id, 'Pump inspection', 'Disconnect power before inspection.');
  let changed = await f.act('saveKnowledgeDraft', {
    collectionId: c.id,
    pageId: p.id,
    expectedRevision: p.revision,
    title: 'Unpublished secret',
    body: 'Changed behavior',
  });
  assert.equal(
    (await f.act('searchKnowledge', { projectId: 'support', query: 'confirmacao' })).results[0]
      .version,
    1,
  );
  assert.equal(
    (await f.act('searchKnowledge', { projectId: 'support', query: 'Unpublished secret' })).results
      .length,
    0,
  );
  assert.equal(
    (await f.act('searchKnowledge', { projectId: 'support', query: 'Pump' })).results.length,
    0,
  );
  const list = await f.act('listKnowledgePages', { projectId: 'support' });
  assert.equal(list.pages[0].title, 'Confirmação');
  await assert.rejects(
    f.act('publishKnowledgePage', { pageId: p.id, expectedRevision: p.revision }),
    /changed/,
  );
  changed = await f.act('publishKnowledgePage', {
    pageId: p.id,
    expectedRevision: changed.revision,
  });
  const old = await f.act('readKnowledgePage', {
    pageId: p.id,
    version: 1,
    anchor: 'preconditions',
  });
  assert.match(old.content, /missing field/);
  assert.equal(old.version, 1);
  assert.equal(old.hash.length, 64);
  assert.equal((await f.act('readKnowledgePage', { pageId: p.id })).version, 2);
  await f.act('setKnowledgePageState', {
    pageId: p.id,
    expectedRevision: changed.revision,
    state: 'archived',
  });
  await assert.rejects(f.act('readKnowledgePage', { pageId: p.id, version: 1 }), /unavailable/);
  assert.equal(
    (await f.act('searchKnowledge', { projectId: 'support', query: 'Changed' })).results.length,
    0,
  );
});

test('selected collections, immutable entry revisions, link visibility, bounds and current revocation', async () => {
  const f = fixture();
  const c = await f.act('createKnowledgeCollection', {
    projectId: 'workshop',
    name: 'Maintenance',
  });
  const extra = await f.act('createKnowledgeCollection', {
    projectId: 'workshop',
    name: 'Other procedures',
  });
  const target = await f.publish(extra.id, 'Calibration', '# Calibration\nUse the approved gauge.');
  const p = await f.publish(
    c.id,
    'Start',
    `# Inspection\nCheck the pressure.\n[Calibration](wiki:${target.id})`,
  );
  const selected = f.knowledge.validateSelection(
    { collectionIds: [c.id], entryPage: { pageId: p.id, version: 1 } },
    'personal',
  );
  assert.throws(() => f.knowledge.validateSelection(selected, 'other'), /unavailable/);
  const session = { projectId: 'workshop', capabilityProfile: { knowledge: selected } };
  assert.match(f.knowledge.orientation(session), /Check the pressure/);
  const read = f.knowledge.agent(session, 'read_knowledge', { pageId: p.id, version: 1, limit: 8 });
  assert.equal(read.content.length, 8);
  assert.equal(read.nextOffset, 8);
  assert.deepEqual(read.links, []);
  assert.throws(
    () => f.knowledge.agent(session, 'read_knowledge', { pageId: target.id, version: 1 }),
    /unavailable/,
  );
  assert.throws(
    () => f.knowledge.agent(session, 'read_knowledge', { pageId: p.id, version: 1, offset: -1 }),
    /offset/,
  );
  assert.throws(
    () =>
      f.knowledge.agent({ ...session, projectId: 'support' }, 'search_knowledge', {
        query: 'pressure',
      }),
    /unavailable/,
  );
  await f.act('setKnowledgeCollectionState', {
    collectionId: c.id,
    expectedRevision: c.revision,
    state: 'archived',
  });
  assert.equal(f.knowledge.orientation(session), '');
  assert.throws(
    () => f.knowledge.agent(session, 'read_knowledge', { pageId: p.id, version: 1 }),
    /unavailable/,
  );
});

test('profile selection pins knowledge and requires explicit tool selection', async () => {
  const f = fixture();
  const c = await f.act('createKnowledgeCollection', { projectId: 'support', name: 'Reference' });
  const p = await f.publish(c.id, 'Start', 'Use the UI to verify reported behavior.');
  const caps = createCapabilities({
    state: f.state,
    validateKnowledge: f.knowledge.validateSelection,
  });
  const profile = caps.command({
    action: 'publishProfile',
    id: 'support',
    name: 'Support',
    tools: ['convoy.search_knowledge', 'convoy.read_knowledge'],
    skills: [],
    knowledge: { collectionIds: [c.id], entryPage: { pageId: p.id, version: 1 } },
  });
  const session = { projectId: 'support' };
  caps.pin(session, profile);
  assert.ok(caps.modelTools(session).some((t) => t.name === 'read_knowledge'));
  caps.command({
    action: 'publishProfile',
    id: 'support',
    name: 'Support',
    baseVersion: 1,
    tools: [],
    skills: [],
    knowledge: { collectionIds: [] },
  });
  assert.equal(session.capabilityProfile.knowledge.entryPage.version, 1);
  assert.equal(
    caps
      .modelTools({ projectId: 'support', capabilityProfile: null })
      .some((t) => t.name === 'read_knowledge'),
    false,
  );
  assert.throws(
    () =>
      caps.validate(session, null, 'read_knowledge', {
        pageId: p.id,
        version: 1,
        projectId: 'foreign',
      }),
    /Invalid arguments/,
  );
});

test('collection navigation is ordered, scoped and revision guarded for unrelated projects', async () => {
  const f = fixture();
  for (const [projectId, name] of [['support', 'Support handbook'], ['workshop', 'Equipment maintenance']]) {
    const c = await f.act('createKnowledgeCollection', { projectId, name });
    const alpha = await f.publish(c.id, 'Alpha', '# Start\nFirst');
    const beta = await f.publish(c.id, 'Beta', '# Start\nSecond');
    const draft = await f.act('saveKnowledgeDraft', { collectionId: c.id, expectedRevision: 0, title: 'Unpublished', body: 'Private draft' });
    const changes = { collectionId: c.id, expectedRevision: 1, name, description: 'An introduction', startPageIds: [beta.id], pageOrder: [beta.id, alpha.id] };
    const updated = await f.act('updateKnowledgeCollection', changes);
    assert.equal(updated.revision, 2);
    assert.equal(updated.description, 'An introduction');
    assert.deepEqual((await f.act('listKnowledgePages', { projectId, collectionId: c.id })).pages.map(p => p.id), [beta.id, alpha.id]);
    await assert.rejects(f.act('updateKnowledgeCollection', changes), /changed/);
    await assert.rejects(f.act('updateKnowledgeCollection', { ...changes, expectedRevision: 2, startPageIds: [draft.id] }), /published and active/);
    const other = await f.act('createKnowledgeCollection', { projectId: projectId === 'support' ? 'workshop' : 'support', name: 'Other' });
    const outsider = await f.publish(other.id, 'Other page', 'External');
    await assert.rejects(f.act('updateKnowledgeCollection', { ...changes, expectedRevision: 2, pageOrder: [outsider.id] }), /belong/);
    assert.equal(f.state.knowledgeCollections.find(x => x.id === c.id).revision, 2);
    await f.act('setKnowledgePageState', { pageId: beta.id, expectedRevision: beta.revision, state: 'archived' });
    assert.deepEqual((await f.act('listKnowledgePages', { projectId, collectionId: c.id })).pages.map(p => p.id), [alpha.id]);
  }
});
