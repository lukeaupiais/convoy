import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowEventJournal } from '../../apps/daemon/src/modules/workflows/index.mjs';

const inventory = {
  id: 'inventory.snapshot', revision: 1, label: 'Inventory snapshot',
  source: { owner: 'inventory-adapter' }, tenantScope: 'resource',
  payload: [
    { path: 'snapshotId', type: 'string', required: true },
    { path: 'warehouse', type: 'string', required: true },
    { path: 'state', type: 'enum', values: ['complete', 'partial'], required: true },
    { path: 'count', type: 'number' },
  ],
  correlationPaths: ['snapshotId', 'warehouse'], maxPayloadBytes: 2048,
};

const procurement = {
  id: 'procurement.approval', revision: 1, label: 'Procurement approval',
  source: { owner: 'procurement-adapter' }, tenantScope: 'organization',
  payload: [
    { path: 'batchId', type: 'string', required: true },
    { path: 'decision', type: 'enum', values: ['approved', 'held'], required: true },
    { path: 'amount', type: 'number', required: true },
  ],
  correlationPaths: ['batchId'], maxPayloadBytes: 1024,
};

const descriptors = [inventory, procurement];

function inventoryEvent(overrides = {}) {
  return {
    descriptor: { id: inventory.id, revision: inventory.revision },
    source: { id: 'warehouse:west', eventId: 'snapshot:0042' },
    organizationId: 'org-west', projectId: 'inventory-west',
    resourceRef: { kind: 'warehouse', id: 'west-01' },
    origin: { kind: 'workload', id: 'inventory-sync' },
    payload: { snapshotId: 'snapshot-0042', warehouse: 'west-01', state: 'complete', count: 42 },
    correlation: { key: 'snapshotId', value: 'snapshot-0042' },
    ...overrides,
  };
}

function procurementEvent(overrides = {}) {
  return {
    descriptor: { id: procurement.id, revision: procurement.revision },
    source: { id: 'purchase:approval', eventId: 'batch:0042' },
    organizationId: 'org-central',
    origin: { kind: 'service-principal', id: 'approvals-service' },
    payload: { batchId: 'batch-0042', decision: 'approved', amount: 1850 },
    correlation: { key: 'batchId', value: 'batch-0042' },
    ...overrides,
  };
}

test('event identities preserve the complete source tuple across colon boundaries and descriptor scopes', async () => {
  const state = {};
  const journal = createWorkflowEventJournal({ state, descriptors });

  const tupleA = await journal.accept(inventoryEvent({
    source: { id: 'source:a', eventId: 'b' },
  }));
  const tupleB = await journal.accept(inventoryEvent({
    source: { id: 'source', eventId: 'a:b' },
  }));
  const purchase = await journal.accept(procurementEvent());

  assert.notEqual(tupleA.event.id, tupleB.event.id);
  assert.notEqual(tupleA.event.id, purchase.event.id);
  assert.notEqual(tupleB.event.id, purchase.event.id);
  assert.deepEqual(tupleA.event.resourceRef, { kind: 'warehouse', id: 'west-01' });
  assert.equal('projectId' in purchase.event, false, 'organization-scoped envelopes do not acquire a project scope');
  assert.equal(purchase.event.organizationId, 'org-central');
  assert.equal(journal.cursor(), 3);
  assert.equal(journal.since(0).length, 3);
});

test('duplicate source identity rejects changed tenant, project, resource, origin, or correlation before mutation', async () => {
  const state = {};
  let saves = 0;
  const journal = createWorkflowEventJournal({ state, descriptors, save: async () => { saves++; } });
  const initial = inventoryEvent();
  const accepted = await journal.accept(initial);
  const before = structuredClone(state);
  const rejected = [
    inventoryEvent({ organizationId: 'org-east' }),
    inventoryEvent({ projectId: 'inventory-east' }),
    inventoryEvent({ resourceRef: { kind: 'warehouse', id: 'east-02' } }),
    inventoryEvent({ origin: { kind: 'workload', id: 'other-sync' } }),
    inventoryEvent({ correlation: { key: 'warehouse', value: 'west-01' } }),
    inventoryEvent({ payload: { snapshotId: 'snapshot-0042', warehouse: 'west-01', state: 'partial', count: 42 } }),
    procurementEvent({ source: initial.source }),
  ];

  for (const candidate of rejected)
    await assert.rejects(journal.accept(candidate), /conflicts/i);

  assert.equal(journal.cursor(), accepted.event.sequence);
  assert.equal(journal.since(0).length, 1);
  assert.equal(saves, 1, 'conflicting redelivery must not save or advance the journal');
  assert.deepEqual(state.workflowEventJournal, before.workflowEventJournal);
  assert.deepEqual(state.workflowEventDedupe, before.workflowEventDedupe);
});

test('accepted envelopes and read projections are defensive copies', async () => {
  const state = {};
  const journal = createWorkflowEventJournal({ state, descriptors });
  const submitted = inventoryEvent();
  const accepted = await journal.accept(submitted);
  const id = accepted.event.id;

  accepted.event.payload.warehouse = 'rewritten';
  accepted.event.resourceRef.id = 'rewritten';
  submitted.payload.count = 999;
  const read = journal.byId(id);
  read.payload.snapshotId = 'rewritten';
  const page = journal.since(0);
  page[0].origin.id = 'rewritten';

  const duplicate = await journal.accept(inventoryEvent());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event.id, id);
  assert.equal(duplicate.event.payload.warehouse, 'west-01');
  assert.equal(duplicate.event.payload.snapshotId, 'snapshot-0042');
  assert.equal(duplicate.event.payload.count, 42);
  assert.equal(duplicate.event.resourceRef.id, 'west-01');
  assert.equal(duplicate.event.origin.id, 'inventory-sync');
  assert.equal(journal.cursor(), 1);
});

test('plain JSON validation rejects dates, custom prototypes, and unsafe keys before acceptance', async () => {
  const state = {};
  let saves = 0;
  const journal = createWorkflowEventJournal({ state, descriptors, save: async () => { saves++; } });
  class CustomPayload {
    constructor() { this.snapshotId = 'snapshot-0042'; this.warehouse = 'west-01'; this.state = 'complete'; }
  }
  const unsafePayload = JSON.parse('{"snapshotId":"snapshot-0042","warehouse":"west-01","state":"complete","constructor":{"polluted":true}}');
  const invalid = [
    inventoryEvent({ source: { id: 'warehouse:west', eventId: 'date' }, payload: { snapshotId: new Date(), warehouse: 'west-01', state: 'complete' } }),
    inventoryEvent({ source: { id: 'warehouse:west', eventId: 'custom' }, payload: new CustomPayload() }),
    inventoryEvent({ source: { id: 'warehouse:west', eventId: 'unsafe' }, payload: unsafePayload }),
    inventoryEvent({ source: { id: 'warehouse:west', eventId: 'custom-origin' }, origin: Object.assign(Object.create({ inherited: true }), { kind: 'workload', id: 'inventory-sync' }) }),
  ];

  for (const candidate of invalid)
    await assert.rejects(journal.accept(candidate));

  assert.equal(journal.cursor(), 0);
  assert.deepEqual(journal.since(0), []);
  assert.deepEqual(state.workflowEventDedupe, {});
  assert.equal(saves, 0, 'invalid envelopes must fail before journal persistence');
});

test('count retention and complete age expiry advance the cursor floor and reject expired identities', async () => {
  const countState = {};
  const countJournal = createWorkflowEventJournal({
    state: countState, descriptors, maxEvents: 2, maxBytes: 20_000,
  });
  for (const eventId of ['count-1', 'count-2', 'count-3'])
    await countJournal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId } }));
  assert.equal(countJournal.cursorFloor(), 1);
  assert.throws(() => countJournal.since(0), /expired/i);
  assert.deepEqual(countJournal.since(1).map(value => value.source.eventId), ['count-2', 'count-3']);

  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const ageState = {};
  const ageJournal = createWorkflowEventJournal({
    state: ageState, descriptors, now: () => new Date(current).toISOString(),
    retentionMs: 1000, maxEvents: 10, maxBytes: 20_000,
  });
  await ageJournal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'aged-1' } }));
  await ageJournal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'aged-2' } }));
  current += 2000;
  await ageJournal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'fresh-1' } }));

  assert.equal(ageJournal.cursorFloor(), 2, 'age expiry advances past every expired envelope');
  assert.deepEqual(ageJournal.since(2).map(value => value.source.eventId), ['fresh-1']);
  assert.throws(() => ageJournal.since(1), /expired/i);
  const cursor = ageJournal.cursor();
  await assert.rejects(ageJournal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'aged-1' } })), /outside the retained dedupe window/i);
  assert.equal(ageJournal.cursor(), cursor, 'an expired identity cannot append or reopen a discarded event');
});

test('byte retention advances the floor without exceeding the configured retained window', async () => {
  const fixedNow = '2026-01-01T00:00:00.000Z';
  const probe = createWorkflowEventJournal({ state: {}, descriptors, now: () => fixedNow });
  const sample = await probe.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'byte-0001' } }));
  const eventBytes = Buffer.byteLength(JSON.stringify(sample.event));
  const journal = createWorkflowEventJournal({
    state: {}, descriptors, now: () => fixedNow, maxEvents: 10, maxBytes: eventBytes * 2 - 1,
  });
  await journal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'byte-0001' } }));
  await journal.accept(inventoryEvent({ source: { id: 'warehouse:west', eventId: 'byte-0002' } }));

  assert.equal(journal.cursorFloor(), 1);
  assert.deepEqual(journal.since(1).map(value => value.source.eventId), ['byte-0002']);
});

test('expired identities fail closed while fresh identities continue beyond the old lifetime limit', async () => {
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const state = {};
  const journal = createWorkflowEventJournal({
    state, descriptors, now: () => new Date(current).toISOString(),
    retentionMs: 1, maxEvents: 1, maxBytes: 1024,
  });
  const total = 20_025;
  for (let index = 0; index < total; index++) {
    current += 2;
    const descriptor = index % 2 === 0 ? inventory : procurement;
    const envelope = descriptor === inventory
      ? inventoryEvent({ source: { id: 'inventory:source', eventId: `event-${index}` } })
      : procurementEvent({ source: { id: 'procurement:source', eventId: `event-${index}` } });
    await journal.accept(envelope);
  }

  assert.equal(journal.cursor(), total);
  assert.equal(journal.since(total - 1).length, 1, 'only the tiny retained window remains queryable');
  assert.equal(journal.cursorFloor(), total - 1);
  await assert.rejects(journal.accept(inventoryEvent({ source: { id: 'inventory:source', eventId: 'event-0' } })), /outside the retained dedupe window/i);
  const afterExpiredReplay = journal.cursor();
  current += 2;
  const fresh = await journal.accept(procurementEvent({ source: { id: 'procurement:source', eventId: 'after-20k' } }));
  assert.equal(fresh.duplicate, false);
  assert.equal(journal.cursor(), afterExpiredReplay + 1, 'new source identities remain acceptable after extensive retention expiry');
  assert.equal(journal.since(journal.cursor() - 1)[0].source.eventId, 'after-20k');
});
