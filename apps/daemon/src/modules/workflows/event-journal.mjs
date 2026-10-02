import { createHash, randomUUID } from 'node:crypto';

const idPattern = /^[a-z][a-z0-9._-]{1,100}$/;
const pathPattern = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*){0,7}$/;
const safeObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : safeObject(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function valueAt(value, path) {
  return path.split('.').reduce((current, part) => safeObject(current) ? current[part] : undefined, value);
}

function plainBounded(value, depth = 0) {
  if (depth > 8) throw new Error('Event payload is too deeply nested.');
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Event payload contains an invalid number.');
    if (typeof value === 'string' && value.length > 4000) throw new Error('Event payload text is too large.');
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error('Event payload must contain plain JSON arrays.');
    if (value.length > 100) throw new Error('Event payload array is too large.');
    for (const item of value) plainBounded(item, depth + 1);
    return;
  }
  if (!safeObject(value)) throw new Error('Event payload must contain only JSON values.');
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Event payload must contain plain JSON objects.');
  const keys = Object.keys(value);
  if (keys.length > 100) throw new Error('Event payload object has too many fields.');
  for (const key of keys) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Event payload contains an unsafe field.');
    plainBounded(value[key], depth + 1);
  }
}

function normalizeDescriptor(input) {
  plainBounded(input);
  if (!input || typeof input !== 'object' || !idPattern.test(input.id) || !Number.isInteger(input.revision) || input.revision < 1 ||
      typeof input.label !== 'string' || !input.label.trim() || input.label.length > 120 ||
      !['organization', 'project', 'resource'].includes(input.tenantScope) || !Array.isArray(input.payload) || input.payload.length > 100 ||
      !input.source || typeof input.source.owner !== 'string' || input.source.owner.length > 80 ||
      !Number.isInteger(input.maxPayloadBytes) || input.maxPayloadBytes < 1 || input.maxPayloadBytes > 256_000)
    throw new Error('Workflow event descriptor is invalid.');
  const paths = new Set();
  const payload = input.payload.map(field => {
    if (!field || !pathPattern.test(field.path) || paths.has(field.path) ||
        !['string', 'number', 'boolean', 'enum'].includes(field.type) || field.required !== undefined && typeof field.required !== 'boolean' ||
        field.type === 'enum' && (!Array.isArray(field.values) || !field.values.length || field.values.length > 100 ||
          field.values.some(value => typeof value !== 'string' || value.length > 120)) ||
        field.type !== 'enum' && field.values !== undefined)
      throw new Error('Workflow event payload declaration is invalid.');
    paths.add(field.path);
    return { path: field.path, type: field.type, ...(field.values ? { values: [...new Set(field.values)] } : {}), ...(field.required ? { required: true } : {}) };
  });
  const correlationPaths = [...new Set(input.correlationPaths ?? [])];
  if (correlationPaths.length > 8 || correlationPaths.some(path => !paths.has(path)))
    throw new Error('Workflow event correlation fields must be declared payload paths.');
  const aliases = [...new Set(input.aliases ?? [])];
  if (aliases.length > 16 || aliases.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]{1,80}$/.test(value)))
    throw new Error('Workflow event aliases are invalid.');
  return {
    id: input.id, revision: input.revision, label: input.label.trim(), source: structuredClone(input.source),
    tenantScope: input.tenantScope, payload, correlationPaths,
    maxPayloadBytes: input.maxPayloadBytes, aliases,
    ...(input.manual === true ? { manual: true } : {}),
  };
}

export function createWorkflowEventJournal({ state, descriptors = [], save = async () => {}, now = () => new Date().toISOString(),
  maxEvents = 5000, maxBytes = 16_000_000, retentionMs = 7 * 24 * 60 * 60_000 } = {}) {
  const byRevision = new Map();
  const aliasToRef = new Map();
  for (const raw of descriptors) {
    const descriptor = normalizeDescriptor(raw);
    const key = `${descriptor.id}@${descriptor.revision}`;
    if (byRevision.has(key)) throw new Error(`Duplicate workflow event descriptor ${key}.`);
    byRevision.set(key, descriptor);
    for (const alias of descriptor.aliases) {
      const prior = aliasToRef.get(alias);
      if (prior && prior !== key) throw new Error(`Duplicate workflow event alias ${alias}.`);
      aliasToRef.set(alias, key);
    }
  }
  state.workflowEventJournal ??= [];
  state.workflowEventDedupe ??= {};
  state.workflowEventSequence ??= 0;
  state.workflowEventCursorFloor ??= 0;

  function descriptor(ref) {
    if (typeof ref === 'string') {
      const mapped = aliasToRef.get(ref);
      if (mapped) return byRevision.get(mapped) ?? null;
      const latest = [...byRevision.values()].filter(value => value.id === ref)
        .sort((left, right) => right.revision - left.revision)[0];
      return latest ?? null;
    }
    return byRevision.get(`${ref?.id}@${ref?.revision}`) ?? null;
  }

  function validatePayload(eventDescriptor, payload) {
    if (!safeObject(payload)) throw new Error('Event payload must be an object.');
    plainBounded(payload);
    const declared = new Set(eventDescriptor.payload.map(field => field.path));
    function assertDeclared(value, prefix = '') {
      if (!safeObject(value)) throw new Error('Event payload contains an undeclared field.');
      for (const [key, child] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        const nested = [...declared].some(field => field.startsWith(`${path}.`));
        if (declared.has(path)) {
          if (safeObject(child) || Array.isArray(child)) throw new Error(`Event payload field ${path} must be a registered scalar.`);
        } else if (nested) assertDeclared(child, path);
        else throw new Error(`Event payload field ${path} is not registered.`);
      }
    }
    assertDeclared(payload);
    if (Buffer.byteLength(JSON.stringify(payload)) > eventDescriptor.maxPayloadBytes)
      throw new Error('Event payload exceeds the registered size limit.');
    for (const field of eventDescriptor.payload) {
      const value = valueAt(payload, field.path);
      if (value === undefined && field.required) throw new Error(`Event payload is missing ${field.path}.`);
      if (value === undefined) continue;
      const matches = field.type === 'enum' ? typeof value === 'string' && field.values.includes(value) : typeof value === field.type;
      if (!matches || typeof value === 'string' && value.length > 4000)
        throw new Error(`Event payload field ${field.path} does not match its registered type.`);
    }
    return structuredClone(payload);
  }

  function validateCorrelation(eventDescriptor, correlation, payload) {
    if (correlation === undefined) return undefined;
    if (!correlation || typeof correlation !== 'object' || Array.isArray(correlation) ||
        Object.keys(correlation).some(key => !['key', 'value'].includes(key)) ||
        typeof correlation.key !== 'string' || correlation.key.length > 100 ||
        typeof correlation.value !== 'string' || !correlation.value || correlation.value.length > 300 ||
        !eventDescriptor.correlationPaths.includes(correlation.key))
      throw new Error('Event correlation must use a registered payload path and bounded scalar value.');
    const advertised = valueAt(payload, correlation.key);
    if (advertised === undefined || String(advertised) !== correlation.value)
      throw new Error('Event correlation does not match its advertised payload value.');
    return { key: correlation.key, value: correlation.value };
  }

  function trimJournal() {
    const cutoff = Date.parse(now()) - retentionMs;
    const retained = [];
    for (const event of state.workflowEventJournal) {
      if (Date.parse(event.receivedAt) >= cutoff) retained.push(event);
      else state.workflowEventCursorFloor = Math.max(state.workflowEventCursorFloor, event.sequence);
    }
    state.workflowEventJournal = retained;
    let bytes = state.workflowEventJournal.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
    while (state.workflowEventJournal.length > maxEvents || bytes > maxBytes) {
      const removed = state.workflowEventJournal.shift();
      if (!removed) break;
      bytes -= Buffer.byteLength(JSON.stringify(removed));
      state.workflowEventCursorFloor = Math.max(state.workflowEventCursorFloor, removed.sequence);
    }
    const oldest = state.workflowEventJournal[0]?.sequence;
    if (oldest !== undefined) state.workflowEventCursorFloor = Math.max(state.workflowEventCursorFloor, oldest - 1);
  }

  return {
    descriptor,
    descriptors() { return [...byRevision.values()].map(value => structuredClone(value)); },
    aliases() { return Object.fromEntries(aliasToRef); },
    cursor() { return state.workflowEventSequence; },
    cursorFloor() { return state.workflowEventCursorFloor; },
    byId(id) { return structuredClone(state.workflowEventJournal.find(value => value.id === id) ?? null); },
    since(sequence, { limit = 500 } = {}) {
      if (!Number.isInteger(sequence) || sequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new Error('Invalid workflow event cursor.');
      if (sequence < state.workflowEventCursorFloor) throw new Error('Workflow event cursor has expired.');
      return state.workflowEventJournal.filter(value => value.sequence > sequence).slice(0, limit).map(value => structuredClone(value));
    },
    async accept(input, { beforeSave } = {}) {
      trimJournal();
      if (!safeObject(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key =>
        !['descriptor', 'source', 'organizationId', 'projectId', 'resourceRef', 'origin', 'occurredAt', 'payload', 'correlation', 'causation'].includes(key)))
        throw new Error('Workflow event envelope contains unsupported fields.');
      if (!safeObject(input.descriptor) || Object.getPrototypeOf(input.descriptor) !== Object.prototype ||
          Object.keys(input.descriptor).some(key => !['id', 'revision'].includes(key)))
        throw new Error('Workflow event descriptor reference is invalid.');
      const eventDescriptor = descriptor({ id: input?.descriptor?.id, revision: input?.descriptor?.revision });
      if (!eventDescriptor) throw new Error('Workflow event descriptor revision is unavailable.');
      if (!input.source || Object.getPrototypeOf(input.source) !== Object.prototype || Object.keys(input.source).some(key => !['id', 'eventId'].includes(key)) ||
          typeof input.source.id !== 'string' || !/^[\w.:-]{1,120}$/.test(input.source.id) ||
          typeof input.source.eventId !== 'string' || !/^[\w.:-]{1,240}$/.test(input.source.eventId))
        throw new Error('Workflow event source identity is invalid.');
      if (typeof input.organizationId !== 'string' || !input.organizationId || input.organizationId.length > 100)
        throw new Error('Workflow event organization scope is required.');
      if (eventDescriptor.tenantScope !== 'organization' &&
          (typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 100))
        throw new Error('Workflow event project scope is required.');
      if (eventDescriptor.tenantScope === 'resource' &&
          (!input.resourceRef || typeof input.resourceRef.kind !== 'string' || typeof input.resourceRef.id !== 'string' ||
            input.resourceRef.kind.length > 80 || input.resourceRef.id.length > 160))
        throw new Error('Workflow event resource scope is required.');
      if (input.origin && (!['user', 'workload', 'service-principal'].includes(input.origin.kind) ||
          Object.getPrototypeOf(input.origin) !== Object.prototype || Object.keys(input.origin).some(key => !['kind', 'id'].includes(key)) ||
          typeof input.origin.id !== 'string' || !input.origin.id || input.origin.id.length > 120))
        throw new Error('Workflow event origin is invalid.');
      if (input.resourceRef && (Object.getPrototypeOf(input.resourceRef) !== Object.prototype ||
          Object.keys(input.resourceRef).some(key => !['kind', 'id'].includes(key)) ||
          typeof input.resourceRef.kind !== 'string' || typeof input.resourceRef.id !== 'string' ||
          !input.resourceRef.kind || !input.resourceRef.id || input.resourceRef.kind.length > 80 || input.resourceRef.id.length > 160))
        throw new Error('Workflow event resource identity is invalid.');
      if (input.causation && (Object.getPrototypeOf(input.causation) !== Object.prototype ||
          Object.keys(input.causation).some(key => !['eventId', 'runId', 'depth', 'rootEventId'].includes(key)) ||
          typeof input.causation.eventId !== 'string' || !input.causation.eventId || input.causation.eventId.length > 160 ||
          typeof input.causation.rootEventId !== 'string' || !input.causation.rootEventId || input.causation.rootEventId.length > 160 ||
          input.causation.runId !== undefined && (typeof input.causation.runId !== 'string' || input.causation.runId.length > 160) ||
          !Number.isInteger(input.causation.depth) || input.causation.depth < 1 || input.causation.depth > 16))
        throw new Error('Workflow event causation is invalid or exceeds the cascade bound.');
      const payload = validatePayload(eventDescriptor, input.payload);
      const correlation = validateCorrelation(eventDescriptor, input.correlation, payload);
      const identityKey = JSON.stringify([input.source.id, input.source.eventId]);
      const sourceDigest = digest({ descriptor: { id: eventDescriptor.id, revision: eventDescriptor.revision }, organizationId: input.organizationId,
        projectId: input.projectId, resourceRef: input.resourceRef, origin: input.origin,
        causation: input.causation, correlation, payload });
      const previousId = state.workflowEventDedupe[identityKey];
      if (previousId) {
        if (previousId === 'expired') throw new Error('Workflow event identity is outside the retained dedupe window.');
        const previous = state.workflowEventJournal.find(value => value.id === previousId);
        if (!previous) throw new Error('Workflow event identity is outside the retained dedupe window.');
        if (previous.sourceDigest !== sourceDigest) throw new Error('Workflow event source identity conflicts with an earlier payload.');
        return { event: structuredClone(previous), duplicate: true };
      }
      const at = now();
      const event = {
        id: randomUUID(), sequence: ++state.workflowEventSequence,
        descriptor: { id: eventDescriptor.id, revision: eventDescriptor.revision },
        source: { id: input.source.id, eventId: input.source.eventId }, organizationId: input.organizationId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.resourceRef ? { resourceRef: structuredClone(input.resourceRef) } : {}),
        ...(input.origin ? { origin: structuredClone(input.origin) } : {}),
        ...(input.occurredAt && Number.isFinite(Date.parse(input.occurredAt)) ? { occurredAt: new Date(input.occurredAt).toISOString() } : {}),
        receivedAt: at, payload, ...(correlation ? { correlation } : {}),
        ...(input.causation ? { causation: structuredClone(input.causation) } : {}), sourceDigest,
      };
      state.workflowEventJournal.push(event);
      state.workflowEventDedupe[identityKey] = event.id;
      const derived = beforeSave ? await beforeSave(structuredClone(event)) : undefined;
      trimJournal();
      await save();
      return { event: structuredClone(event), duplicate: false, ...(derived !== undefined ? { derived: structuredClone(derived) } : {}) };
    },
  };
}

export function workflowEventPath(value, path) { return valueAt(value, path); }
