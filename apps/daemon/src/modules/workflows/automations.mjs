import { randomUUID } from 'node:crypto';
import { normalizeWorkflow } from './workflows.mjs';
import { validateActivityValue } from './activity-data.mjs';

const idPattern = /^[A-Za-z0-9][\w-]{0,79}$/;
const safePathPart = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) &&
  !['__proto__', 'prototype', 'constructor'].includes(value);

function validateEventInputBindings(bindings, descriptor, schema) {
  if (bindings === undefined) bindings = {};
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings) || Object.getPrototypeOf(bindings) !== Object.prototype || Object.keys(bindings).length > 128)
    throw new Error('Automation input bindings must be a bounded object.');
  const properties = schema?.properties ?? {};
  const fields = new Map((descriptor?.payload ?? []).map(field => [field.path, field]));
  for (const [key, binding] of Object.entries(bindings)) {
    if (!safePathPart(key) || !Object.hasOwn(properties, key) || !binding || typeof binding !== 'object' || Array.isArray(binding) ||
        Object.getPrototypeOf(binding) !== Object.prototype || Object.keys(binding).length !== 1)
      throw new Error(`Automation run input ${key} has an invalid binding.`);
    if (Object.hasOwn(binding, 'value')) {
      validateActivityValue(binding.value, properties[key], `automation.inputBindings.${key}`);
      continue;
    }
    const from = binding.from;
    if (!from || typeof from !== 'object' || Array.isArray(from) || Object.getPrototypeOf(from) !== Object.prototype ||
        Object.keys(from).some(name => !['kind', 'path'].includes(name)) || from.kind !== 'event_payload' ||
        !Array.isArray(from.path) || from.path.length < 1 || from.path.length > 8 || from.path.some(part => !safePathPart(part)))
      throw new Error(`Automation run input ${key} must reference a declared event payload path.`);
    const field = fields.get(from.path.join('.'));
    if (!field || !field.required && (schema.required ?? []).includes(key))
      throw new Error(`Automation run input ${key} is not guaranteed by the pinned event descriptor.`);
    const target = properties[key];
    const sourceType = field.type === 'enum' ? 'string' : field.type;
    const compatibleType = sourceType === target.type || sourceType === 'integer' && target.type === 'number';
    const compatibleBounds = field.type === 'enum'
      ? !target.enum || field.values.every(value => target.enum.includes(value))
      : target.enum ? false
      : target.type === 'string' ? target.minLength === undefined || target.minLength === 0
        ? target.maxLength === undefined : false
        : target.minimum === undefined && target.maximum === undefined;
    if (!compatibleType || !compatibleBounds)
      throw new Error(`Automation event payload ${field.path} is incompatible with run input ${key}.`);
  }
  for (const key of schema?.required ?? []) if (!Object.hasOwn(bindings, key))
    throw new Error(`Automation run input ${key} is required and needs a binding.`);
}
export function workflowForProject(state, id, version, projectId, { raw = false } = {}) {
  const project = state.projects?.find(item => item.id === projectId);
  const workflow = state.workflows?.find(item => item.id === id && (item.version ?? 1) === version);
  if (!project || !workflow || (workflow.organizationId ?? 'personal') !== project.organizationId ||
      workflow.projectId && workflow.projectId !== projectId || workflow.teamId && workflow.teamId !== project.teamId)
    throw new Error('Workflow is not available for this project.');
  return raw ? structuredClone(workflow) : { ...normalizeWorkflow(workflow), organizationId: workflow.organizationId ?? 'personal', ...(workflow.teamId ? { teamId: workflow.teamId } : {}), ...(workflow.projectId ? { projectId: workflow.projectId } : {}), version: workflow.version ?? 1 };
}

export function initializeAutomations(state) {
  if (state.workflowStartRules || state.workflowTriggerLedger || state.workflows?.some(w => w.triggers?.length))
    throw new Error('Automation schema requires offline migration. Run scripts/migrate-automations.mjs.');
  if (state.automationSchemaVersion !== undefined && state.automationSchemaVersion !== 1)
    throw new Error('Unsupported automation schema version.');
  state.automationSchemaVersion = 1;
  state.automations ??= [];
}

export function createAutomations({ state, save, capabilities, eventDescriptors = [], authorizeRule = async () => {} }) {
  initializeAutomations(state);
  const descriptorForEvent = (eventId, revision) => eventDescriptors
    .filter(value => value.id === eventId || value.aliases?.includes(eventId))
    .filter(value => revision === undefined || value.revision === revision)
    .sort((left, right) => right.revision - left.revision)[0] ?? null;
  function validate(rule) {
    if (!rule.when || !rule.then || !Array.isArray(rule.if) || rule.then.action !== 'start_workflow')
      throw new Error('Automation requires When, If and Then.');
    if (['event','boardId','columnId','bindingId','workType','workflowId','workflowVersion','migratedFrom'].some(key => Object.hasOwn(rule,key)))
      throw new Error('Legacy automation fields are not supported.');
    if (Object.keys(rule.when).some(key => !['event','eventRevision','boardId','columnId','bindingId','resourceRef'].includes(key)) ||
        Object.keys(rule.then).some(key => !['action','workflowId','workflowVersion','inputBindings'].includes(key)) ||
        rule.concurrency !== undefined && (!rule.concurrency || typeof rule.concurrency !== 'object' || Array.isArray(rule.concurrency) ||
          Object.keys(rule.concurrency).some(key => !['policy','maxActiveRuns','overflowPolicy'].includes(key))))
      throw new Error('Unsupported automation fields.');
    const event = capabilities.events.find(value => value.id === rule.when.event);
    if (!event) throw new Error('Unsupported automation event.');
    const resourceRef = rule.when.resourceRef;
    if (event.scope === 'resource' && (!resourceRef || typeof resourceRef !== 'object' || Array.isArray(resourceRef) ||
        Object.getPrototypeOf(resourceRef) !== Object.prototype || Object.keys(resourceRef).length !== 2 ||
        typeof resourceRef.kind !== 'string' || !/^[A-Za-z][\w.-]{0,79}$/.test(resourceRef.kind) ||
        typeof resourceRef.id !== 'string' || !/^[A-Za-z0-9][\w.-]{0,119}$/.test(resourceRef.id)) ||
        event.scope !== 'resource' && resourceRef !== undefined)
      throw new Error('Resource-scoped automation requires an exact resource reference.');
    const descriptor = descriptorForEvent(event.id, rule.when.eventRevision);
    if (rule.when.eventRevision !== undefined && (!Number.isInteger(rule.when.eventRevision) || rule.when.eventRevision < 1 || !descriptor))
      throw new Error('Choose an available workflow event revision.');
    if (rule.if.length > 20 || rule.if.some(condition => {
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return true;
      const path = condition?.path ?? condition?.field;
      const field = descriptor?.payload.find(value => value.path === path);
      const fieldDeclared = descriptor ? Boolean(field) : (event.fields ?? []).includes(path);
      if (!fieldDeclared) return true;
      const validValue = condition.operator === 'exists'
        ? condition.value === undefined || typeof condition.value === 'boolean'
        : ['equals', 'notEquals'].includes(condition.operator)
          ? field?.type === 'enum' ? typeof condition.value === 'string' && field.values.includes(condition.value)
            : field ? typeof condition.value === field.type && (field.type !== 'number' || Number.isFinite(condition.value))
              : !descriptor && ['string', 'number', 'boolean'].includes(typeof condition.value) && (typeof condition.value !== 'number' || Number.isFinite(condition.value))
          : ['greaterThan', 'lessThan'].includes(condition.operator) && field?.type === 'number' && Number.isFinite(condition.value);
      return !validValue || Object.keys(condition).some(key => !['field','path','operator','value'].includes(key));
    }))
      throw new Error('Unsupported automation condition.');
    const workflow = workflowForProject(state, rule.then.workflowId, rule.then.workflowVersion, rule.projectId);
    if (!Number.isInteger(rule.then.workflowVersion) || rule.then.workflowVersion < 1) throw new Error('Choose a published workflow version.');
    validateEventInputBindings(rule.then.inputBindings, descriptor, workflow.runInputSchema ?? { type: 'object', properties: {}, additionalProperties: false });
    const { boardId, columnId, bindingId } = rule.when;
    if (event.scope === 'binding' && !bindingId) throw new Error('Choose an import binding.');
    if (bindingId) {
      if (event.scope !== 'binding') throw new Error('This event cannot select an import binding.');
      const binding = state.ticketImportBindings?.find(value => value.id === bindingId);
      if (!binding || binding.projectId !== rule.projectId) throw new Error('Import binding is not available for this project.');
    }
    if (columnId && !boardId) throw new Error('Choose a board before a column.');
    if (boardId) {
      if (event.scope !== 'board') throw new Error('This event cannot select a board.');
      const board = state.boards?.find(value => value.id === boardId);
      if (!board || !board.projectIds.includes(rule.projectId) || columnId && !board.columns.some(value => value.id === columnId))
        throw new Error('Automation board binding is unavailable.');
    }
    if (rule.concurrency && (!['reject', 'hold', 'independent'].includes(rule.concurrency.policy) ||
        !Number.isInteger(rule.concurrency.maxActiveRuns ?? 1) || (rule.concurrency.maxActiveRuns ?? 1) < 1 ||
        (rule.concurrency.maxActiveRuns ?? 1) > 100 || rule.concurrency.overflowPolicy !== undefined &&
        (rule.concurrency.policy !== 'independent' || !['reject', 'hold'].includes(rule.concurrency.overflowPolicy))))
      throw new Error('Invalid automation concurrency policy.');
  }
  return {
    validate,
    snapshot(scope) {
      return state.automations.filter(rule => (!scope?.organizationId || rule.organizationId === scope.organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(rule.projectId)));
    },
    async save(command, principal) {
      const input = command.rule;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Automation is required.');
      const id = input.id ?? randomUUID();
      if (!idPattern.test(id)) throw new Error('Invalid automation ID.');
      const previous = state.automations.find(rule => rule.id === id);
      if (previous && previous.projectId !== input.projectId) throw new Error('Automation project cannot change.');
      if ((command.revision ?? 0) !== (previous?.revision ?? 0)) throw new Error('Automation changed. Reload before saving.');
      const project = state.projects.find(value => value.id === input.projectId);
      if (!project || project.organizationId !== command.organizationId) throw new Error('Automation project is unavailable.');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Name the automation.');
      validate(input);
      const actor = previous?.principal ?? principal;
      if (input.enabled && (!actor || !['user','workload'].includes(actor.kind))) throw new Error('Enabled automation needs a governed principal.');
      if (input.enabled) await authorizeRule(project.id, actor);
      const event = capabilities.events.find(value => value.id === input.when.event);
      const descriptor = event && descriptorForEvent(event.id, input.when.eventRevision);
      const when = { ...structuredClone(input.when), ...(descriptor && input.when.eventRevision === undefined ? { eventRevision: descriptor.revision } : {}) };
      const rule = { id, name: input.name.trim(), organizationId: project.organizationId, projectId: project.id,
        when, if: structuredClone(input.if), then: structuredClone(input.then),
        ...(input.concurrency ? { concurrency: structuredClone(input.concurrency) } : {}),
        enabled: Boolean(input.enabled), principal: actor, revision: (previous?.revision ?? 0) + 1 };
      if (previous) Object.assign(previous, rule); else state.automations.push(rule);
      await save(); return structuredClone(rule);
    },
    matches(rule, fact) {
      if (!rule.enabled || rule.projectId !== fact.projectId || rule.when.event !== fact.event) return false;
      if (rule.when.resourceRef && (rule.when.resourceRef.kind !== fact.resourceRef?.kind || rule.when.resourceRef.id !== fact.resourceRef?.id)) return false;
      if (rule.when.bindingId && rule.when.bindingId !== fact.bindingId) return false;
      if (rule.when.boardId && rule.when.boardId !== fact.boardId) return false;
      if (rule.when.columnId && !(fact.toColumnId === rule.when.columnId && fact.fromColumnId !== rule.when.columnId)) return false;
      return rule.if.every(condition => fact[condition.field] === condition.value);
    },
  };
}
