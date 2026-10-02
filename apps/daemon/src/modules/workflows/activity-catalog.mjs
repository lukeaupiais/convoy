import { activityDigest, validateActivitySchema } from './activity-data.mjs';

const object = (properties, required = [], additionalProperties = false) => ({
  type: 'object', properties, required, additionalProperties,
});
const text = (maxLength = 4000) => ({ type: 'string', maxLength });
const ticketOutput = object({
  id: { type: 'integer', minimum: 1 },
  ticketId: { type: 'integer', minimum: 1 },
  title: text(500),
  status: text(120),
  projectId: text(128),
  revision: { type: 'integer', minimum: 0 },
}, [], true);

export const builtinActivityDescriptors = [
  {
    ref: { id: 'work.create-ticket', revision: 1 },
    inputSchema: object({ title: text(500), description: text(), status: text(120), projectId: text(128), boardId: text(128), destination: text(128), label: text(120), agent: text(120), priority: text(80), customFields: object({}, [], true), requestKey: text(100), requestId: text(100) }, ['title']),
    outputSchema: ticketOutput,
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false, policy: 'command-policy' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'result', reconciliation: 'adapter',
    presentation: { label: 'Create ticket', group: 'Work' },
  },
  {
    ref: { id: 'work.create-related-ticket', revision: 1 },
    inputSchema: object({ title: text(500), description: text(), kind: text(80), sourceTicketId: { type: 'integer', minimum: 1 }, sourceRevision: { type: 'integer', minimum: 0 }, ticketId: { type: 'integer', minimum: 1 }, boardId: text(128), status: text(120), requestKey: text(100), requestId: text(100) }, ['title']),
    outputSchema: ticketOutput,
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false, policy: 'command-policy' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'result', reconciliation: 'adapter',
    presentation: { label: 'Create related ticket', group: 'Work' },
  },
  {
    ref: { id: 'work.update-ticket', revision: 1 },
    inputSchema: object({ ticketId: { type: 'integer', minimum: 1 }, taskId: { type: 'integer', minimum: 1 }, patch: object({ title: text(500), description: text(), status: text(120), label: text(120), agent: text(120), priority: text(80), customFields: object({}, [], true) }, [], true), requestKey: text(100), requestId: text(100) }),
    outputSchema: ticketOutput,
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false, policy: 'command-policy' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'result', reconciliation: 'adapter',
    presentation: { label: 'Update ticket', group: 'Work' },
  },
  {
    ref: { id: 'work.set-board-placement', revision: 1 },
    inputSchema: object({ ticketId: { type: 'integer', minimum: 1 }, taskId: { type: 'integer', minimum: 1 }, boardId: text(128), placement: object({ columnId: text(128) }, ['columnId']), requestKey: text(100), requestId: text(100) }, ['boardId', 'placement']),
    outputSchema: ticketOutput,
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false, policy: 'command-policy' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'result', reconciliation: 'adapter',
    presentation: { label: 'Set board placement', group: 'Work' },
  },
  {
    ref: { id: 'work.set-external-status', revision: 1 },
    inputSchema: object({ ticketId: { type: 'integer', minimum: 1 }, connectionId: text(128), status: text(120), evidenceReply: { type: 'string', enum: ['latest_delivered'] }, requestKey: text(100), requestId: text(100) }, ['connectionId', 'status']),
    outputSchema: object({ ticketId: { type: 'integer', minimum: 1 }, status: text(120), requestId: text(300) }, [], true),
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: false, policy: 'command-policy' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Set external status', group: 'Work' },
  },
  {
    ref: { id: 'work.post-external-reply', revision: 1 },
    inputSchema: object({ ticketId: { type: 'integer', minimum: 1 }, connectionId: text(128), body: text(8000), sourceNodeId: text(80), field: text(64), requestId: text(100) }, ['connectionId', 'sourceNodeId', 'field']),
    outputSchema: object({ id: text(300), ticketId: { type: 'integer', minimum: 1 }, status: text(80), deliveryStatus: text(80), awaitingDelivery: { type: 'boolean' }, replyRequestId: text(300), message: text(500) }, [], true),
    resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
    cancellation: 'reconcile-after-dispatch', confirmation: 'adapter-confirmed', reconciliation: 'adapter',
    presentation: { label: 'Send approved reply', group: 'Work' },
  },
  {
    ref: { id: 'runner.inspect-changes', revision: 1 },
    inputSchema: object({ ignoreArtifact: text(200) }),
    outputSchema: object({ digest: text(128), changedFiles: { type: 'array', items: text(1000), maxItems: 256 } }, [], true),
    resources: { location: 'runner', runner: 'required', workspace: true }, effect: 'observation', approval: { required: false },
    cancellation: 'cooperative', confirmation: 'result', reconciliation: 'adapter',
    presentation: { label: 'Inspect changes', group: 'Repository' },
  },
  {
    ref: { id: 'data.multiply', revision: 1 },
    inputSchema: object({ amount: { type: 'number', minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000 }, factor: { type: 'number', minimum: -1_000_000, maximum: 1_000_000 } }, ['amount', 'factor']),
    outputSchema: object({ amount: { type: 'number', minimum: -1_000_000_000_000_000, maximum: 1_000_000_000_000_000 } }, ['amount']),
    resources: { location: 'daemon' }, effect: 'pure', approval: { required: false },
    cancellation: 'immediate', confirmation: 'result', reconciliation: 'none',
    presentation: { label: 'Multiply values', group: 'Data' },
  },
];

export function createActivityCatalog(descriptors = builtinActivityDescriptors) {
  const maxDescriptors = 96;
  const maxRegistryBytes = 750_000;
  if (!Array.isArray(descriptors) || descriptors.length > maxDescriptors)
    throw new Error(`Activity registry is limited to ${maxDescriptors} descriptors.`);
  const byKey = new Map();
  let registryBytes = 0;
  for (const descriptor of descriptors) {
    if (!descriptor?.ref || typeof descriptor.ref.id !== 'string' || !/^[a-z][\w.-]{1,100}$/.test(descriptor.ref.id) ||
        !Number.isInteger(descriptor.ref.revision) || descriptor.ref.revision < 1)
      throw new Error('Activity descriptor needs a stable id and positive revision.');
    const key = `${descriptor.ref.id}@${descriptor.ref.revision}`;
    if (byKey.has(key)) throw new Error(`Activity ${key} is registered more than once.`);
    validateDescriptorMetadata(descriptor, key);
    validateActivitySchema(descriptor.inputSchema);
    validateActivitySchema(descriptor.outputSchema);
    const projected = projectDescriptor(descriptor);
    registryBytes += Buffer.byteLength(JSON.stringify(projected));
    if (registryBytes > maxRegistryBytes) throw new Error(`Activity registry exceeds ${maxRegistryBytes} bytes.`);
    byKey.set(key, projected);
  }
  return {
    all() { return [...byKey.values()].map(value => structuredClone(value)); },
    get(ref) {
      if (typeof ref === 'string') {
        const descriptor = byKey.get(ref);
        return descriptor ? structuredClone(descriptor) : null;
      }
      if (!ref || typeof ref.id !== 'string' || !Number.isInteger(ref.revision)) return null;
      const descriptor = byKey.get(`${ref.id}@${ref.revision}`);
      return descriptor ? structuredClone(descriptor) : null;
    },
    digest(ref) {
      const descriptor = typeof ref === 'string' ? byKey.get(ref) : byKey.get(`${ref?.id}@${ref?.revision}`);
      return descriptor ? activityDigest(descriptor) : null;
    },
    key(ref) { return ref && `${ref.id}@${ref.revision}`; },
  };
}

function projectDescriptor(descriptor) {
  return structuredClone({
    ref: { id: descriptor.ref.id, revision: descriptor.ref.revision },
    inputSchema: descriptor.inputSchema,
    outputSchema: descriptor.outputSchema,
    resources: descriptor.resources,
    effect: descriptor.effect,
    approval: descriptor.approval,
    cancellation: descriptor.cancellation,
    confirmation: descriptor.confirmation,
    reconciliation: descriptor.reconciliation,
    presentation: descriptor.presentation,
  });
}

function validateDescriptorMetadata(descriptor, key) {
  const resources = descriptor.resources;
  if (!resources || !['daemon', 'agent', 'runner', 'integration'].includes(resources.location))
    throw new Error(`Activity ${key} has invalid resource requirements.`);
  const expected = {
    daemon: ['location'], agent: ['location', 'provider', 'tools', 'workspace'],
    runner: ['location', 'runner', 'workspace'], integration: ['location', 'adapterId'],
  }[resources.location];
  if (Object.keys(resources).some(field => !expected.includes(field))) throw new Error(`Activity ${key} has unsupported resource metadata.`);
  if (resources.location === 'agent' && resources.provider !== 'required' || resources.location === 'runner' && resources.runner !== 'required' ||
      resources.location === 'integration' && (typeof resources.adapterId !== 'string' || !/^[a-z][\w.-]{1,100}$/.test(resources.adapterId)))
    throw new Error(`Activity ${key} has incomplete resource requirements.`);
  if (resources.workspace !== undefined && typeof resources.workspace !== 'boolean' ||
      resources.tools !== undefined && (!Array.isArray(resources.tools) || resources.tools.length > 64 || resources.tools.some(tool => typeof tool !== 'string' || !/^[a-z][\w.-]{0,100}$/.test(tool))))
    throw new Error(`Activity ${key} has invalid resource requirements.`);
  if (!['pure', 'observation', 'durable-effect'].includes(descriptor.effect)) throw new Error(`Activity ${key} has an invalid effect policy.`);
  const approval = descriptor.approval;
  if (!approval || typeof approval.required !== 'boolean' || Object.keys(approval).some(field => !['required', 'policy'].includes(field)) ||
      approval.policy !== undefined && !['workflow-gate', 'command-policy'].includes(approval.policy) ||
      approval.required && approval.policy !== 'workflow-gate')
    throw new Error(`Activity ${key} has invalid approval metadata.`);
  if (!['immediate', 'cooperative', 'reconcile-after-dispatch'].includes(descriptor.cancellation) ||
      !['result', 'adapter-confirmed', 'human-reconciled'].includes(descriptor.confirmation) ||
      !['none', 'adapter'].includes(descriptor.reconciliation))
    throw new Error(`Activity ${key} has invalid lifecycle metadata.`);
  if (!descriptor.presentation || typeof descriptor.presentation.label !== 'string' || !descriptor.presentation.label.trim() ||
      descriptor.presentation.label.length > 100 || Object.keys(descriptor.presentation).some(field => !['label', 'description', 'group'].includes(field)) ||
      descriptor.presentation.description !== undefined && (typeof descriptor.presentation.description !== 'string' || descriptor.presentation.description.length > 500) ||
      descriptor.presentation.group !== undefined && (typeof descriptor.presentation.group !== 'string' || descriptor.presentation.group.length > 80))
    throw new Error(`Activity ${key} has invalid presentation metadata.`);
  if (descriptor.effect === 'pure' && (descriptor.reconciliation !== 'none' || descriptor.cancellation !== 'immediate'))
    throw new Error(`Pure activity ${key} cannot declare effect reconciliation or delayed cancellation.`);
  if (descriptor.effect !== 'pure' && descriptor.reconciliation === 'none' && descriptor.cancellation === 'reconcile-after-dispatch')
    throw new Error(`Activity ${key} needs a reconciliation policy after dispatch.`);
}

export function legacyActivityRef(operation) {
  const id = {
    create_ticket: 'work.create-ticket',
    create_related_ticket: 'work.create-related-ticket',
    update_ticket: 'work.update-ticket',
    move_ticket: 'work.set-board-placement',
    set_external_status: 'work.set-external-status',
    send_external_reply: 'work.post-external-reply',
    inspect_changes: 'runner.inspect-changes',
  }[operation];
  return id ? { id, revision: 1 } : null;
}
