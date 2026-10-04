import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowEventJournal } from '../../apps/daemon/src/modules/workflows/index.mjs';

const descriptor = {
  id: 'inventory.snapshot', revision: 1, label: 'Inventory snapshot',
  source: { owner: 'inventory-adapter' }, tenantScope: 'project',
  payload: [
    { path: 'snapshotId', type: 'string', required: true },
    { path: 'status', type: 'enum', values: ['complete', 'partial'], required: true },
    { path: 'count', type: 'number' },
  ],
  correlationPaths: ['snapshotId'], maxPayloadBytes: 2048, manual: true,
};

function input(overrides = {}) {
  return {
    descriptor: { id: descriptor.id, revision: descriptor.revision },
    source: { id: 'inventory.source-a', eventId: 'snapshot-1' },
    organizationId: 'org-a', projectId: 'project-a',
    payload: { snapshotId: 'snap-1', status: 'complete', count: 12 },
    correlation: { key: 'snapshotId', value: 'snap-1' },
    ...overrides,
  };
}

test('workflow event journal validates typed fields and deduplicates immutable source identity', async () => {
  const state = {};
  let saves = 0;
  const journal = createWorkflowEventJournal({ state, descriptors: [descriptor], save: async () => { saves++; } });
  const accepted = await journal.accept(input());
  const duplicate = await journal.accept(input({ payload: { count: 12, status: 'complete', snapshotId: 'snap-1' } }));
  assert.equal(accepted.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, accepted.event.id);
  assert.equal(accepted.event.sequence, 1);
  assert.equal(journal.cursor(), 1);
  assert.equal(saves, 1, 'idempotent redelivery must not append or rewrite the journal');
  assert.equal('principal' in accepted.event, false);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'snap-1', status: 'complete', projectId: 'foreign' } })), /not registered/i);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'snap-1', status: 'failed' } })), /registered type/i);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'different', status: 'complete' } })), /correlation/i);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'snap-1', status: 'partial' } })), /conflicts/i);
  assert.equal(state.workflowEventJournal.length, 1);
});

test('workflow event journal rejects unknown revisions, unadvertised correlation and oversized payloads', async () => {
  const journal = createWorkflowEventJournal({ state: {}, descriptors: [descriptor] });
  await assert.rejects(journal.accept(input({ descriptor: { id: descriptor.id, revision: 2 } })), /unavailable/i);
  await assert.rejects(journal.accept(input({ correlation: { key: 'status', value: 'complete' } })), /registered payload path/i);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'x'.repeat(3000), status: 'complete' } })), /size|large/i);
  await assert.rejects(journal.accept(input({ payload: { snapshotId: 'snap-1', status: 'complete', extra: { nested: { deep: { beyond: { depth: { limit: { here: { too: { far: true } } } } } } } } } })), /deeply nested/i);
  assert.equal(journal.cursor(), 0);
});

test('workflow event journal expires old entries with an explicit cursor floor', async () => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const state = {};
  const journal = createWorkflowEventJournal({ state, descriptors: [descriptor], now: () => new Date(current).toISOString(),
    retentionMs: 1000, maxEvents: 2, maxBytes: 4096 });
  await journal.accept(input({ source: { id: 'inventory.source-a', eventId: 'one' } }));
  current += 2000;
  await journal.accept(input({ source: { id: 'inventory.source-a', eventId: 'two' } }));
  assert.equal(journal.cursorFloor(), 1);
  assert.throws(() => journal.since(0), /expired/i);
  assert.equal(journal.since(1)[0].source.eventId, 'two');
  await assert.rejects(journal.accept(input({ source: { id: 'inventory.source-a', eventId: 'one' } })), /outside the retained dedupe window/i);
});

test('workflow event identities use an unambiguous tuple and reject non-plain JSON', async () => {
  const journal = createWorkflowEventJournal({ state: {}, descriptors: [descriptor] });
  const one = await journal.accept(input({ source: { id: 'source:a', eventId: 'b' } }));
  const two = await journal.accept(input({ source: { id: 'source', eventId: 'a:b' } }));
  assert.notEqual(one.event.id, two.event.id);
  class CustomPayload { constructor() { this.snapshotId = 'snap-1'; this.status = 'complete'; } }
  await assert.rejects(journal.accept(input({ source: { id: 'source', eventId: 'custom' }, payload: new CustomPayload() })), /plain JSON/i);
  await assert.rejects(journal.accept(input({ source: { id: 'source', eventId: 'origin' }, origin: new CustomPayload() })), /origin/i);
  assert.equal(journal.cursor(), 2);
});
