import { createHash, randomUUID } from 'node:crypto';

const MAX_RECORDS_PER_QUERY = 500;
const MAX_TEXT = 500;
const SECRET_VALUE =
  /(?:\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,})/i;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const digest = (value) => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Audit ${label} is invalid.`);
  return SECRET_VALUE.test(value) ? '[REDACTED]' : value;
}

function pickStrings(input, keys, redaction) {
  if (!input || typeof input !== 'object') return undefined;
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!keys.includes(key)) {
      redaction.removedFields += 1;
      continue;
    }
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) {
      redaction.removedFields += 1;
      continue;
    }
    if (SECRET_VALUE.test(value)) {
      redaction.removedFields += 1;
      continue;
    }
    output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

function usage(input, redaction) {
  if (!input || typeof input !== 'object') return undefined;
  const output = {};
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'durationMs']) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      redaction.removedFields += 1;
      continue;
    }
    output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

function observations(input, redaction) {
  if (!input || typeof input !== 'object') return undefined;
  const output = {};
  for (const key of Object.keys(input)) {
    if (!['usage', 'failureClass', 'retryable', 'reconciliationRequired'].includes(key))
      redaction.removedFields += 1;
  }
  const boundedUsage = usage(input.usage, redaction);
  if (boundedUsage) output.usage = boundedUsage;
  if (typeof input.failureClass === 'string' && !SECRET_VALUE.test(input.failureClass))
    output.failureClass = input.failureClass.slice(0, 100);
  if (typeof input.retryable === 'boolean') output.retryable = input.retryable;
  if (typeof input.reconciliationRequired === 'boolean')
    output.reconciliationRequired = input.reconciliationRequired;
  return Object.keys(output).length ? output : undefined;
}

function normalize(input, deploymentId) {
  if (!input || typeof input !== 'object') throw new Error('Audit evidence is required.');
  const redaction = { removedFields: 0, policy: 'allowlist-v1' };
  const actor = pickStrings(
    input.actor,
    ['kind', 'userId', 'workloadIdentityId', 'servicePrincipalId'],
    redaction,
  );
  if (!actor?.kind) throw new Error('Audit actor is required.');
  const record = {
    deploymentId,
    organizationId: text(input.organizationId, 'organizationId'),
    action: text(input.action, 'action', { max: 120 }),
    actor,
    resource: pickStrings(input.resource, ['kind', 'id'], redaction),
    context: pickStrings(input.context, ['teamId', 'projectId', 'sessionId', 'turnId'], redaction),
    authenticatedIdentity: pickStrings(
      input.authenticatedIdentity,
      ['userId', 'deviceId', 'deviceSessionId', 'workloadIdentityId', 'servicePrincipalId'],
      redaction,
    ),
    revisions: pickStrings(
      input.revisions,
      [
        'membershipRevision',
        'policyRevision',
        'routeRevision',
        'connectionRevision',
        'profileRevision',
        'providerGrantDigest',
        'executionGrantDigest',
      ],
      redaction,
    ),
    provider: pickStrings(
      input.provider,
      [
        'providerId',
        'connectionId',
        'modelOfferingId',
        'routeId',
        'grantId',
        'requestId',
        'outcomeClass',
      ],
      redaction,
    ),
    execution: pickStrings(
      input.execution,
      ['environmentId', 'runnerId', 'poolId', 'workspaceId', 'assignmentId', 'profileId'],
      redaction,
    ),
    approval: pickStrings(input.approval, ['approvalId', 'decision', 'reviewerId'], redaction),
    decision: text(input.decision, 'decision', { max: 80 }),
    outcome: text(input.outcome, 'outcome', { max: 80 }),
    traceId: text(input.traceId, 'traceId', { optional: true, max: 200 }),
    correlationId: text(input.correlationId, 'correlationId', { optional: true, max: 200 }),
    observations: observations(input.observations, redaction),
    redaction,
  };
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function immutable(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

function clone(value) {
  return immutable(structuredClone(value));
}

export function createSecurityAudit({
  state,
  deploymentId,
  save = async () => {},
  now = () => new Date().toISOString(),
  createId = () => `audit_${randomUUID()}`,
} = {}) {
  if (!state || typeof state !== 'object') throw new Error('Security audit state is required.');
  text(deploymentId, 'deploymentId');
  state.securityAuditRecords ??= [];

  function verifyChain() {
    let previousDigest;
    for (let index = 0; index < state.securityAuditRecords.length; index += 1) {
      const record = state.securityAuditRecords[index];
      const { digest: recordedDigest, ...unsigned } = record;
      if (
        record.sequence !== index + 1 ||
        record.previousDigest !== previousDigest ||
        digest(unsigned) !== recordedDigest
      )
        throw new Error('Security audit history failed integrity verification.');
      previousDigest = record.digest;
    }
  }

  async function record(input) {
    verifyChain();
    const previous = state.securityAuditRecords.at(-1);
    const value = {
      id: createId(),
      sequence: state.securityAuditRecords.length + 1,
      occurredAt: now(),
      ...normalize(input, deploymentId),
      ...(previous ? { previousDigest: previous.digest } : {}),
    };
    value.digest = digest(value);
    state.securityAuditRecords.push(value);
    await save();
    return clone(value);
  }

  function query(input) {
    verifyChain();
    const organizationId = text(input?.organizationId, 'organizationId');
    const limit = input?.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECORDS_PER_QUERY)
      throw new Error(`Audit query limit must be 1-${MAX_RECORDS_PER_QUERY}.`);
    const after = input?.cursor === undefined ? 0 : Number(input.cursor);
    if (!Number.isInteger(after) || after < 0) throw new Error('Audit query cursor is invalid.');
    const filtered = state.securityAuditRecords.filter(
      (value) =>
        value.organizationId === organizationId &&
        value.sequence > after &&
        (!input.eventAction || value.action === input.eventAction) &&
        (!input.outcome || value.outcome === input.outcome) &&
        (!input.projectId || value.context?.projectId === input.projectId),
    );
    const records = filtered.slice(0, limit).map(clone);
    return immutable({
      records,
      nextCursor: filtered.length > records.length ? records.at(-1)?.sequence : undefined,
    });
  }

  function exportRecords(input) {
    const page = query({ ...input, limit: input?.limit ?? MAX_RECORDS_PER_QUERY });
    if ((input?.format ?? 'jsonl') !== 'jsonl') throw new Error('Unsupported audit export format.');
    return immutable({
      organizationId: input.organizationId,
      format: 'jsonl',
      content: page.records.map((value) => JSON.stringify(value)).join('\n'),
      nextCursor: page.nextCursor,
    });
  }

  return Object.freeze({ record, query, export: exportRecords, verify: verifyChain });
}
