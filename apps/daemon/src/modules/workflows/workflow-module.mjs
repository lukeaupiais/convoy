import { createWorkflowRegistry } from './workflow-registry.mjs';
import { activityDigest, validateActivityValue, resolveActivityBindings, activitySchemaAtPath } from './activity-data.mjs';
import { legacyActivityRef } from './activity-catalog.mjs';
import { createWorkflowEventJournal, workflowEventPath } from './event-journal.mjs';
import { randomUUID } from 'node:crypto';

const commands = ['saveWorkflow', 'saveWorkflowDraft', 'saveAutomation'];
const sessionCommands = [
  'retryAutomationDecision',
  'reconcileWorkflowEffect',
  'startWorkflow',
  'pauseWorkflow',
  'cancelWorkflow',
  'continueWorkflow',
  'approveGate',
  'requestChanges',
  'reviseSubmission',
];
const activityIntentSchema = { type: 'object', properties: {}, additionalProperties: true };
function checkedActivityIntent(value) {
  const intent = validateActivityValue(value ?? {}, activityIntentSchema);
  if (Buffer.byteLength(JSON.stringify(intent)) > 16_000) throw new Error('Activity intent is too large.');
  return intent;
}

export function migrateWorkflowState(state, { defaultWorkflow, normalize }) {
  state.workflowRuns ??= {};
  state.workflowEffectLedger ??= {};
  state.workflowEventRejections ??= {};
  for (const run of Object.values(state.workflowRuns)) {
    if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
      if (['waiting_gate', 'waiting_event', 'awaiting_continue', 'awaiting_submission', 'paused'].includes(run.flow.status))
        run.attempt.status = 'waiting';
      else if (run.flow.status === 'ready') run.attempt.status = 'ready';
      else {
        const safelyRecomputable = ['pure', 'observation'].includes(run.attempt.effect);
        const mayHaveDispatched = run.attempt.dispatchStarted === true || run.attempt.dispatchStarted === undefined;
        run.attempt.status = !safelyRecomputable && mayHaveDispatched ? 'uncertain' : 'ready';
        run.flow.resumeStatus = run.flow.status;
        run.flow.status = 'interrupted';
        run.status = 'interrupted';
      }
    }
  }
  state.workflows ??= [];
  if (!state.workflows.length) state.workflows.push(structuredClone(defaultWorkflow));
  // Templates are additive: upgrading Convoy must never rewrite an operator's
  // published graph or active-run pin, but every workspace should receive the
  // current proven delivery starting point exactly once.
  if (!state.workflows.some((workflow) => workflow.id === defaultWorkflow.id))
    state.workflows.push(structuredClone(defaultWorkflow));
  state.workflowDrafts ??= {};
  state.defaultWorkflowIds ??= { organizations: {}, projects: {} };
  state.defaultWorkflowIds.organizations ??= {};
  state.defaultWorkflowIds.projects ??= {};
  if (state.defaultWorkflowId && !state.defaultWorkflowIds.organizations.personal) {
    state.defaultWorkflowIds.organizations.personal = state.defaultWorkflowId;
  }
  // Published definitions are immutable approval material. Interpret legacy
  // operation nodes at read/dispatch boundaries; never rewrite their bytes here.
  for (const draft of Object.values(state.workflowDrafts)) {
    draft.workflow.organizationId ??= 'personal';
  }
  const latest = state.workflows.at(-1);
  const latestNodes = latest?.nodes ?? latest?.steps ?? [];
  if (latestNodes.some((step) => step.requiresCheck && !step.checkCommand)) {
    const upgraded = structuredClone(latest);
    upgraded.version = state.workflows.length + 1;
    for (const step of upgraded.nodes ?? upgraded.steps)
      if (step.requiresCheck && !step.checkCommand) step.checkCommand = 'npm test';
    state.workflows.push(upgraded);
  }
}

function localDateTime(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const result = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${result.year}-${result.month}-${result.day}T${result.hour}:${result.minute}`;
}

function resolveLocalTime(date, time, timeZone) {
  const target = `${date}T${time}`;
  const center = Date.parse(`${date}T${time}:00Z`);
  for (let instant = center - 15 * 60 * 60_000; instant <= center + 15 * 60 * 60_000; instant += 60_000)
    if (localDateTime(instant, timeZone) === target) return new Date(instant).toISOString();
  return null;
}

function nextCalendarOccurrence(schedule, after) {
  const timeZone = schedule.timeZone;
  const local = localDateTime(after, timeZone);
  const start = new Date(`${local.slice(0, 10)}T00:00:00Z`);
  for (let offset = 0; offset <= 370; offset++) {
    const date = new Date(start.getTime() + offset * 86_400_000);
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (schedule.frequency === 'weekly' && weekday !== schedule.weekday) continue;
    if (schedule.frequency === 'monthly' && day !== schedule.dayOfMonth) continue;
    const localDate = date.toISOString().slice(0, 10);
    const instant = resolveLocalTime(localDate, schedule.localTime, timeZone);
    if (instant && Date.parse(instant) > Date.parse(after)) return instant;
  }
  throw new Error('No valid schedule occurrence was found in the next year.');
}

function nextScheduleOccurrence(schedule, after) {
  return schedule.kind === 'interval'
    ? new Date(Date.parse(schedule.anchorAt) + Math.max(0, Math.floor((Date.parse(after) - Date.parse(schedule.anchorAt)) / (schedule.everySeconds * 1000)) + 1) * schedule.everySeconds * 1000).toISOString()
    : nextCalendarOccurrence(schedule, after);
}

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) throw new Error('Workflow schedule is invalid.');
  if (schedule.kind === 'interval') {
    if (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds < 60 || schedule.everySeconds > 31_536_000 ||
        typeof schedule.anchorAt !== 'string' || !/(?:Z|\+00:00)$/.test(schedule.anchorAt) || !Number.isFinite(Date.parse(schedule.anchorAt)))
      throw new Error('Interval schedules need a bounded interval and UTC anchor.');
    return { kind: 'interval', everySeconds: schedule.everySeconds, anchorAt: new Date(schedule.anchorAt).toISOString() };
  }
  if (schedule.kind !== 'calendar' || !['daily', 'weekly', 'monthly'].includes(schedule.frequency) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime) || typeof schedule.timeZone !== 'string')
    throw new Error('Calendar schedule is invalid.');
  try { new Intl.DateTimeFormat('en', { timeZone: schedule.timeZone }); } catch { throw new Error('Choose a valid IANA time zone.'); }
  if (schedule.frequency === 'weekly' && (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) ||
      schedule.frequency === 'monthly' && (!Number.isInteger(schedule.dayOfMonth) || schedule.dayOfMonth < 1 || schedule.dayOfMonth > 28) ||
      schedule.frequency === 'daily' && (schedule.weekday !== undefined || schedule.dayOfMonth !== undefined))
    throw new Error('Calendar schedule fields do not match its frequency.');
  return structuredClone(schedule);
}

/** Immutable workflow definitions and lease-authorized workflow-run decisions. */
export function createWorkflows({
  state,
  save,
  defaultWorkflow,
  normalize,
  validateBindings,
  engine,
  effects,
  requestStop,
  automations,
  defaultPrincipal = null,
  activityCatalog,
  activityAvailable = () => true,
  prepareActivityIntent = async () => { throw new Error('Activity intent preparation is unavailable.'); },
  eventDescriptors = [],
  validateEventWait = () => {},
  matchEventWaitSource = () => undefined,
  now = () => new Date().toISOString(),
}) {
  migrateWorkflowState(state, { defaultWorkflow, normalize });
  const eventJournal = createWorkflowEventJournal({ state, descriptors: eventDescriptors, save, now });
  function validateEventWaitBindings(workflow) {
    const nodes = workflow.nodes ?? workflow.steps ?? [];
    const edges = workflow.edges ?? [];
    const byId = new Map(nodes.map(node => [node.id, node]));
    const isUpstream = (sourceId, targetId) => {
      const pending = [sourceId];
      const visited = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (current === targetId) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const edge of edges) if (edge.from === current) pending.push(edge.to);
      }
      return false;
    };
    const compatibleCorrelation = (source, target) => {
      const sourceType = source.type === 'enum' ? 'string' : source.type;
      const targetType = target.type === 'enum' ? 'string' : target.type;
      if (!(sourceType === targetType || sourceType === 'integer' && targetType === 'number')) return false;
      if (target.type === 'enum') return source.type === 'enum' && source.enum.every(value => target.values.includes(value));
      return true;
    };
    for (const node of nodes) {
      if (node.kind !== 'wait') continue;
      const wait = node.waitFor;
      const descriptor = eventJournal.descriptor(wait.eventRevision === undefined
        ? wait.event : { id: wait.event, revision: wait.eventRevision });
      if (!descriptor) throw new Error(`${node.name}: workflow event descriptor is unavailable.`);
      validateEventWait({ descriptor, wait, workflow, node });
      if (wait.scope !== undefined && wait.scope !== descriptor.tenantScope)
        throw new Error(`${node.name}: wait scope does not match the registered event descriptor.`);
      if (descriptor.tenantScope === 'resource' && !wait.resourceRef ||
          descriptor.tenantScope !== 'resource' && wait.resourceRef)
        throw new Error(`${node.name}: wait resource identity does not match the registered event descriptor.`);

      const fields = new Map(descriptor.payload.map(field => [field.path, field]));
      for (const condition of wait.if ?? []) {
        const field = fields.get(condition.path);
        if (!field) throw new Error(`${node.name}: predicate path ${condition.path} is not declared by the event.`);
        if (condition.operator === 'exists') continue;
        const compatible = field.type === 'enum' ? typeof condition.value === 'string' && field.values.includes(condition.value)
          : typeof condition.value === field.type;
        if (!compatible || ['greaterThan', 'lessThan'].includes(condition.operator) && field.type !== 'number')
          throw new Error(`${node.name}: predicate value does not match event field ${condition.path}.`);
      }
      if (wait.correlation && !descriptor.correlationPaths.includes(wait.correlation.key))
        throw new Error(`${node.name}: correlation key is not declared by the event.`);
      if (wait.correlation) {
        const target = descriptor.payload.find(field => field.path === wait.correlation.key);
        const source = wait.correlation.from;
        let sourceSchema;
        const activeTicketSource = source === 'activeTicketId';
        if (activeTicketSource && !['string', 'number', 'integer'].includes(target?.type))
          throw new Error(`${node.name}: active ticket identity requires a scalar event correlation field.`);
        else if (source.startsWith('runInput.')) {
          try { sourceSchema = activitySchemaAtPath(workflow.runInputSchema, source.slice(9).split('.')); }
          catch { throw new Error(`${node.name}: correlation source is not declared by the workflow input schema.`); }
        } else if (source.startsWith('output.')) {
          const [, sourceId, ...path] = source.split('.');
          const producer = byId.get(sourceId);
          const producerDescriptor = producer?.kind === 'action' && producer.activity ? activityCatalog?.get(producer.activity) : null;
          if (!producer || !producerDescriptor || !isUpstream(sourceId, node.id))
            throw new Error(`${node.name}: correlation output must come from an upstream registered activity.`);
          try { sourceSchema = activitySchemaAtPath(producerDescriptor.outputSchema, path); }
          catch { throw new Error(`${node.name}: correlation output path is not declared by its activity.`); }
        }
        if (!target || !activeTicketSource && (!sourceSchema || !compatibleCorrelation(sourceSchema, target)))
          throw new Error(`${node.name}: correlation source does not match event field ${wait.correlation.key}.`);
      }
      if (!descriptor.aliases.includes(wait.event)) wait.event = descriptor.id;
      wait.eventRevision = descriptor.revision;
      wait.scope = descriptor.tenantScope;
    }
    validateBindings(workflow);
  }
  const registry = createWorkflowRegistry({ state, save, normalize, validateBindings: validateEventWaitBindings });
  state.workflowWaits ??= {};
  state.workflowDeadlines ??= {};
  state.workflowWaitScanCursor ??= '';
  state.automationDecisionLedger ??= {};
  state.automationFailures ??= [];
  state.workflowSchedules ??= [];
  state.workflowScheduleFirings ??= {};
  state.workflowWebhookBindings ??= [];
  const readDefinition = workflow => {
    try {
      return {
        ...normalize(workflow), organizationId: workflow.organizationId ?? 'personal',
        ...(workflow.teamId ? { teamId: workflow.teamId } : {}),
        ...(workflow.projectId ? { projectId: workflow.projectId } : {}), version: workflow.version ?? 1,
      };
    } catch { return structuredClone(workflow); }
  };
  const visibleWorkflow = (workflow, scope) =>
    (!scope?.organizationId || (workflow.organizationId ?? 'personal') === scope.organizationId) &&
    (!workflow.projectId || !scope?.projectIds || scope.projectIds.includes(workflow.projectId)) &&
      (!workflow.teamId || state.projects.some(project =>
        project.teamId === workflow.teamId && project.organizationId === (workflow.organizationId ?? 'personal') &&
        (!scope?.projectIds || scope.projectIds.includes(project.id))));
  const decisionMatches = (rule, accepted) => {
    if (!rule.enabled || rule.projectId !== accepted.event.projectId) return false;
    const descriptor = eventJournal.descriptor(accepted.event.descriptor);
    if (!descriptor || (rule.when.event !== descriptor.id && !descriptor.aliases.includes(rule.when.event))) return false;
    if (rule.when.eventRevision !== undefined && rule.when.eventRevision !== accepted.event.descriptor.revision) return false;
    if (rule.when.resourceRef && (rule.when.resourceRef.kind !== accepted.event.resourceRef?.kind ||
        rule.when.resourceRef.id !== accepted.event.resourceRef?.id)) return false;
    const payload = accepted.event.payload;
    const ticketId = payload.ticketId;
    const fact = { ...payload, event: rule.when.event, projectId: accepted.event.projectId,
      sourceKey: accepted.event.source.eventId, ...(accepted.event.resourceRef ? { resourceRef: accepted.event.resourceRef } : {}) };
    if (rule.when.bindingId && rule.when.bindingId !== payload.bindingId) return false;
    if (rule.when.boardId && rule.when.boardId !== payload.boardId) return false;
    if (rule.when.columnId && !(payload.toColumnId === rule.when.columnId && payload.fromColumnId !== rule.when.columnId)) return false;
    if (ticketId !== undefined) fact.ticketId = ticketId;
    return (rule.if ?? []).every(condition => {
      const path = condition.path ?? condition.field;
      const value = workflowEventPath(payload, path);
      switch (condition.operator) {
        case 'exists': return condition.value === undefined ? value !== undefined : (value !== undefined) === Boolean(condition.value);
        case 'notEquals': return value !== undefined && value !== condition.value;
        case 'greaterThan': return typeof value === 'number' && typeof condition.value === 'number' && value > condition.value;
        case 'lessThan': return typeof value === 'number' && typeof condition.value === 'number' && value < condition.value;
        case 'equals': return value === condition.value;
        default: return false;
      }
    });
  };
  function matchedEventRules(accepted) {
    return (state.automations ?? []).filter(rule => decisionMatches(rule, accepted));
  }
  function resolveEventRunInput(rule, event) {
    const workflow = state.workflows.find(value => value.id === rule.then.workflowId && (value.version ?? 1) === rule.then.workflowVersion);
    if (!workflow) throw new Error('The automation’s pinned workflow version is unavailable.');
    const schema = normalize(workflow).runInputSchema ?? { type: 'object', properties: {}, additionalProperties: false };
    const values = {};
    for (const [key, binding] of Object.entries(rule.then.inputBindings ?? {})) {
      if (Object.hasOwn(binding, 'value')) values[key] = structuredClone(binding.value);
      else {
        const value = workflowEventPath(event.payload, binding.from.path.join('.'));
        if (value !== undefined) values[key] = structuredClone(value);
      }
    }
    return validateActivityValue(values, schema);
  }
  const eventDecisionKey = (rule, event) => JSON.stringify([rule.id, rule.revision, event.source.id, event.source.eventId]);
  function reserveEventDecisions(event) {
    const accepted = { event };
    const decisions = [];
    const matched = matchedEventRules(accepted);
    for (const rule of matched) {
      const triggerKey = eventDecisionKey(rule, event);
      const existing = state.automationDecisionLedger[triggerKey];
      if (existing) { decisions.push(triggerKey); continue; }
      const concurrency = rule.concurrency ?? { policy: 'hold', maxActiveRuns: 1 };
      const activeRuns = Object.values(state.workflowRuns ?? {}).filter(run => run.provenance?.subscriptionId === rule.id &&
        !['completed', 'cancelled'].includes(run.flow?.status ?? run.status)).length;
      const pendingReservations = Object.values(state.automationDecisionLedger).filter(decision =>
        decision.subscriptionId === rule.id && decision.subscriptionRevision === rule.revision &&
        ['reserved', 'started'].includes(decision.status) && !state.workflowRuns?.[decision.runId]).length;
      const overCapacity = activeRuns + pendingReservations >= (concurrency.maxActiveRuns ?? 1);
      const overflowPolicy = concurrency.policy === 'independent' ? concurrency.overflowPolicy ?? 'hold' : concurrency.policy;
      const conflictingMatches = matched.length > 1;
      const status = conflictingMatches || overCapacity && overflowPolicy === 'reject' ? 'conflict' : overCapacity ? 'held' : 'reserved';
      const workflow = state.workflows.find(value => value.id === rule.then.workflowId && (value.version ?? 1) === rule.then.workflowVersion);
      const project = state.projects.find(value => value.id === rule.projectId);
      const runInput = resolveEventRunInput(rule, event);
      const runId = randomUUID();
      const record = {
        at: now(), status, ruleId: rule.id, ruleRevision: rule.revision, subscriptionId: rule.id,
        subscriptionRevision: rule.revision, workflowId: rule.then.workflowId, workflowVersion: rule.then.workflowVersion,
        projectId: rule.projectId, organizationId: project?.organizationId ?? event.organizationId,
        principal: structuredClone(rule.principal), ticketId: event.payload?.ticketId,
        trigger: rule.when.event, sourceEvent: structuredClone(event), eventId: event.id, runId,
        decisionKey: triggerKey, attempts: 0,
        runInput, runInputDigest: activityDigest(runInput),
        concurrencyPolicy: concurrency.policy, overflowPolicy: concurrency.policy === 'independent' ? overflowPolicy : undefined,
        maxActiveRuns: concurrency.maxActiveRuns ?? 1,
        ...(conflictingMatches ? { message: 'Multiple enabled subscriptions matched this event; no workflow was started.' } : {}),
        ...(workflow ? { workflowDigest: activityDigest(workflow) } : {}),
      };
      state.automationDecisionLedger[triggerKey] = record;
      decisions.push(triggerKey);
    }
    return decisions;
  }
  function workflowForSchedule(workflowId, workflowVersion, projectId) {
    const value = state.workflows.find(item => item.id === workflowId && (item.version ?? 1) === workflowVersion);
    const project = state.projects.find(item => item.id === projectId);
    if (!value || !project || (value.organizationId ?? 'personal') !== project.organizationId ||
        value.projectId && value.projectId !== projectId || value.teamId && value.teamId !== project.teamId)
      throw new Error('Workflow is not available for this schedule project.');
    return value;
  }
  function pinnedDecisionRunInput(decision) {
    const runInput = decision.runInput ?? {};
    const runInputDigest = activityDigest(runInput);
    if (decision.runInputDigest !== undefined && decision.runInputDigest !== runInputDigest)
      throw new Error('The decision’s pinned workflow input changed.');
    return runInput;
  }
  function setPayloadPath(target, path, value) {
    const parts = path.split('.'); let current = target;
    for (const part of parts.slice(0, -1)) current = current[part] ??= {};
    current[parts.at(-1)] = value;
  }
  function eventWaitMatches(run, node, accepted, registeredWait) {
    const wait = node.waitFor;
    const descriptor = eventJournal.descriptor(registeredWait?.descriptor ?? accepted.descriptor);
    const tenantScope = registeredWait?.tenantScope ?? wait.scope ?? descriptor?.tenantScope;
    const resourceRef = registeredWait?.resourceRef ?? wait.resourceRef;
    if (!descriptor || (wait.event !== descriptor.id && !descriptor.aliases.includes(wait.event)) ||
        registeredWait?.descriptor && (registeredWait.descriptor.id !== accepted.descriptor.id ||
          registeredWait.descriptor.revision !== accepted.descriptor.revision) ||
        !registeredWait?.descriptor && wait.eventRevision !== undefined && wait.eventRevision !== accepted.descriptor.revision ||
        tenantScope !== descriptor.tenantScope ||
        accepted.organizationId !== run.organizationId ||
        ['project', 'resource'].includes(descriptor.tenantScope) && accepted.projectId !== run.projectId ||
        descriptor.tenantScope === 'resource' && (!resourceRef ||
          resourceRef.kind !== accepted.resourceRef?.kind || resourceRef.id !== accepted.resourceRef?.id)) return false;
    if (matchEventWaitSource({ descriptor, wait, run, accepted }) === false) return false;
    const expected = wait.correlation?.from?.startsWith('runInput.')
      ? workflowEventPath(run.runInput, wait.correlation.from.slice(9))
      : wait.correlation?.from?.startsWith('output.')
        ? workflowEventPath(run.activityOutputs?.[wait.correlation.from.slice(7).split('.')[0]]?.value, wait.correlation.from.slice(7).split('.').slice(1).join('.'))
        : wait.correlation?.from === 'activeTicketId' ? run.activeTicketId : undefined;
    if (wait.correlation && (expected === undefined || accepted.correlation?.key !== wait.correlation.key || accepted.correlation.value !== String(expected))) return false;
    if ((wait.if ?? []).some(condition => {
      const value = workflowEventPath(accepted.payload, condition.path);
      if (condition.operator === 'exists') return condition.value === undefined ? value === undefined : Boolean(value !== undefined) !== condition.value;
      if (condition.operator === 'equals') return value !== condition.value;
      if (condition.operator === 'notEquals') return value === condition.value;
      if (condition.operator === 'greaterThan') return typeof value !== 'number' || value <= condition.value;
      if (condition.operator === 'lessThan') return typeof value !== 'number' || value >= condition.value;
      return true;
    })) return false;
    return true;
  }
  function registerWait(runContext, node, instance) {
    const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
    if (!run || run.flow?.instance !== instance || run.flow?.nodeId !== node.id) return;
    const descriptor = eventJournal.descriptor(node.waitFor.eventRevision === undefined
      ? node.waitFor.event : { id: node.waitFor.event, revision: node.waitFor.eventRevision });
    if (!descriptor)
      throw new Error(`${node.name}: pinned workflow event descriptor is unavailable.`);
    const tenantScope = node.waitFor.scope ?? descriptor.tenantScope;
    if (tenantScope !== descriptor.tenantScope || tenantScope === 'resource' && !node.waitFor.resourceRef ||
        tenantScope !== 'resource' && node.waitFor.resourceRef)
      throw new Error(`${node.name}: wait scope does not match its registered event descriptor.`);
    const key = `${run.id}:${run.workflow.version}:${node.id}:${instance}`;
    state.workflowWaits[key] ??= { key, runId: run.id, workflowId: run.workflow.id, workflowVersion: run.workflow.version,
      nodeId: node.id, instance, projectId: run.projectId, cursor: run.eventEligibilityCursor ?? eventJournal.cursor(),
      organizationId: run.organizationId, descriptor: { id: descriptor.id, revision: descriptor.revision }, tenantScope,
      ...(node.waitFor.resourceRef ? { resourceRef: structuredClone(node.waitFor.resourceRef) } : {}),
      status: 'waiting', registeredAt: now(), waitFor: structuredClone(node.waitFor) };
    if (node.waitFor.timeoutSeconds) {
      const deadlineKey = `${key}:timeout`;
      state.workflowDeadlines[deadlineKey] ??= { key: deadlineKey, runId: run.id, workflowVersion: run.workflow.version,
        nodeId: node.id, instance, dueAt: new Date(Date.parse(now()) + node.waitFor.timeoutSeconds * 1000).toISOString(),
        outcome: node.waitFor.timeoutOutcome ?? 'timeout', status: 'pending' };
    }
  }
  async function deliverPendingWaitEvents() {
    let delivered = 0;
    const waiting = Object.values(state.workflowWaits).filter(value => value.status === 'waiting').sort((a, b) => a.key.localeCompare(b.key));
    const startAt = waiting.findIndex(value => value.key > state.workflowWaitScanCursor);
    const ordered = startAt < 0 ? waiting : [...waiting.slice(startAt), ...waiting.slice(0, startAt)];
    const page = ordered.slice(0, 500);
    for (const wait of page) {
      state.workflowWaitScanCursor = wait.key;
      const run = state.workflowRuns?.[wait.runId];
      if (!run?.flow || run.workflow.version !== wait.workflowVersion || run.flow.nodeId !== wait.nodeId ||
          run.flow.instance !== wait.instance || run.flow.status !== 'waiting_event') { wait.status = 'stale'; continue; }
      const node = (run.workflow.nodes ?? run.workflow.steps).find(value => value.id === wait.nodeId);
      if (!node) { wait.status = 'stale'; continue; }
      const cursor = wait.scanCursor ?? wait.cursor;
      let candidates;
      try { candidates = eventJournal.since(cursor, { limit: 500 }); }
      catch (error) {
        wait.status = 'unavailable'; wait.message = String(error.message).slice(0, 300);
        run.flow.resumeStatus = 'waiting_event'; run.flow.status = 'paused'; run.status = 'paused';
        await save(); continue;
      }
      if (candidates.length) wait.scanCursor = candidates.at(-1).sequence;
      else wait.scanCursor = eventJournal.cursor();
      const deadline = Object.values(state.workflowDeadlines).find(value => value.runId === run.id &&
        value.instance === wait.instance && value.status === 'pending');
      for (const accepted of candidates) {
        if (!eventWaitMatches(run, node, accepted, wait)) continue;
        if (deadline && Date.parse(accepted.receivedAt) > Date.parse(deadline.dueAt)) continue;
        const context = run.sessionId && state.sessions[run.sessionId] || run;
        const acceptedWait = await engine.signal(context, wait.instance, {
          event: wait.waitFor.event, eventId: accepted.id, payload: accepted.payload,
          ticketId: accepted.payload.ticketId, messageId: accepted.payload.messageId,
        });
        if (acceptedWait) {
          wait.status = 'delivered'; wait.eventId = accepted.id; wait.deliveredAt = now();
          for (const deadline of Object.values(state.workflowDeadlines)) if (deadline.runId === run.id && deadline.instance === wait.instance && deadline.status === 'pending') deadline.status = 'cancelled';
          await save(); delivered++; break;
        }
      }
      await save();
    }
    return { delivered };
  }
  async function processDueDeadlines(at = now(), { limit = 100 } = {}) {
    let processed = 0;
    for (const deadline of Object.values(state.workflowDeadlines).filter(value => value.status === 'pending' && Date.parse(value.dueAt) <= Date.parse(at)).slice(0, limit)) {
      const run = state.workflowRuns?.[deadline.runId];
      if (!run?.flow || run.workflow.version !== deadline.workflowVersion || run.flow.nodeId !== deadline.nodeId ||
          run.flow.instance !== deadline.instance || run.flow.status !== 'waiting_event') { deadline.status = 'stale'; continue; }
      const context = run.sessionId && state.sessions[run.sessionId] || run;
      await engine.signal(context, deadline.instance, { event: 'timeout', outcome: deadline.outcome });
      deadline.status = 'fired'; deadline.firedAt = now();
      const wait = Object.values(state.workflowWaits).find(value => value.runId === run.id && value.instance === deadline.instance);
      if (wait?.status === 'waiting') wait.status = 'timed_out';
      await save(); processed++;
    }
    return { processed };
  }
  function scheduleFireKey(schedule, scheduledFor) { return `${schedule.id}:${schedule.revision}:${scheduledFor}`; }
  async function persistScheduleFire(schedule, scheduledFor, coveredThrough = scheduledFor) {
    const key = scheduleFireKey(schedule, scheduledFor);
    if (state.workflowScheduleFirings[key]) return state.workflowScheduleFirings[key];
    const eventId = `${schedule.id}.${schedule.revision}.${Date.parse(scheduledFor)}`;
    const fire = { key, scheduleId: schedule.id, revision: schedule.revision, scheduledFor, coveredThrough,
      eventId, status: 'reserved', reservedAt: now() };
    state.workflowScheduleFirings[key] = fire;
    schedule.nextFireAt = nextScheduleOccurrence(schedule.schedule, coveredThrough);
    await save();
    return fire;
  }
  function validateMissedFirePolicy(policy) {
    if (policy === 'skip' || policy === 'coalesce_once') return structuredClone(policy);
    if (policy?.catchUp && Number.isInteger(policy.catchUp.maxFirings) && policy.catchUp.maxFirings >= 1 && policy.catchUp.maxFirings <= 100 && Object.keys(policy).length === 1)
      return { catchUp: { maxFirings: policy.catchUp.maxFirings } };
    throw new Error('Choose an explicit missed-fire policy.');
  }
  function recentDueOccurrences(schedule, at) {
    if (schedule.kind === 'interval') {
      const interval = schedule.everySeconds * 1000;
      const latestIndex = Math.floor((Date.parse(at) - Date.parse(schedule.anchorAt)) / interval);
      if (latestIndex < 0) return [];
      return [latestIndex - 1, latestIndex].filter(index => index >= 0)
        .map(index => new Date(Date.parse(schedule.anchorAt) + index * interval).toISOString());
    }
    const lookbackDays = schedule.frequency === 'daily' ? 8 : schedule.frequency === 'weekly' ? 22 : 75;
    let cursor = nextScheduleOccurrence(schedule, new Date(Date.parse(at) - lookbackDays * 86_400_000).toISOString());
    const due = [];
    for (let count = 0; count < 64 && Date.parse(cursor) <= Date.parse(at); count++) {
      due.push(cursor);
      cursor = nextScheduleOccurrence(schedule, cursor);
    }
    return due.slice(-2);
  }
  function skipScheduleRange(schedule, first, last, count) {
    if (Date.parse(first) > Date.parse(last)) return;
    const key = scheduleFireKey(schedule, first);
    state.workflowScheduleFirings[key] ??= { key, scheduleId: schedule.id, revision: schedule.revision,
      scheduledFor: first, coveredThrough: last, status: 'skipped', ...(count !== undefined ? { skippedCount: count } : {}), decidedAt: now() };
  }
  async function deliverScheduleFire(fire) {
    if (fire.status === 'accepted') return;
    const schedule = state.workflowSchedules.find(value => value.id === fire.scheduleId && value.revision === fire.revision);
    if (!schedule) { fire.status = 'held'; fire.message = 'Pinned schedule revision is unavailable.'; await save(); return; }
    await eventJournal.accept({ descriptor: { id: 'workflow.schedule_fired', revision: 1 },
      source: { id: `workflow-schedule.${schedule.id}`, eventId: fire.eventId }, organizationId: schedule.organizationId,
      projectId: schedule.projectId, payload: { scheduleId: schedule.id, scheduledFor: fire.scheduledFor, coveredThrough: fire.coveredThrough } },
    { beforeSave: accepted => [...reserveEventDecisions(accepted), reserveScheduleDecision(accepted, schedule)] });
    fire.status = 'accepted'; fire.acceptedAt = now(); await save();
  }
  function resolveScheduleRunInput(input, workflow) {
    const schema = normalize(workflow).runInputSchema ?? { type: 'object', properties: {}, additionalProperties: false };
    return validateActivityValue(input ?? {}, schema);
  }
  function reserveScheduleDecision(event, schedule) {
    const decisionKey = `schedule:${schedule.id}:${schedule.revision}:${event.source.eventId}`;
    if (!state.automationDecisionLedger[decisionKey]) {
      state.automationDecisionLedger[decisionKey] = { kind: 'schedule', at: now(), status: 'reserved',
        ruleId: null, ruleRevision: schedule.revision, subscriptionId: schedule.id,
        subscriptionRevision: schedule.revision, workflowId: schedule.workflowId, workflowVersion: schedule.workflowVersion,
        projectId: schedule.projectId, organizationId: schedule.organizationId, principal: structuredClone(schedule.principal),
        sourceEvent: structuredClone(event), eventId: event.id, runId: randomUUID(), decisionKey, attempts: 0,
        runInput: structuredClone(schedule.runInput ?? {}), runInputDigest: schedule.runInputDigest ?? activityDigest(schedule.runInput ?? {}),
        concurrencyPolicy: 'independent', maxActiveRuns: 100, workflowDigest: schedule.workflowDigest };
    }
    return decisionKey;
  }
  async function processDueSchedules(at = now(), { limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid workflow scheduler page size.');
    const instant = Date.parse(at);
    if (!Number.isFinite(instant)) throw new Error('Invalid workflow scheduler time.');
    let processed = 0;
    for (const fire of Object.values(state.workflowScheduleFirings).filter(value => value.status === 'reserved').slice(0, limit)) {
      await deliverScheduleFire(fire); processed++;
    }
    const currentSchedules = state.workflowSchedules.filter(value => value.enabled &&
      !state.workflowSchedules.some(other => other.id === value.id && other.revision > value.revision));
    for (const schedule of currentSchedules) {
      if (processed >= limit) break;
      if (Date.parse(schedule.nextFireAt) > instant) continue;
      const first = schedule.nextFireAt;
      const tail = recentDueOccurrences(schedule.schedule, at);
      const last = tail.at(-1);
      if (!last || Date.parse(last) < Date.parse(first)) continue;
      const nextAfterLast = nextScheduleOccurrence(schedule.schedule, last);
      if (schedule.missedFirePolicy === 'coalesce_once') {
        const fire = await persistScheduleFire(schedule, first, last);
        await deliverScheduleFire(fire); processed++;
      } else if (schedule.missedFirePolicy === 'skip') {
        const previous = tail.length > 1 ? tail.at(-2) : null;
        if (previous && Date.parse(previous) >= Date.parse(first)) {
          const skippedCount = schedule.schedule.kind === 'interval'
            ? Math.max(0, Math.round((Date.parse(previous) - Date.parse(first)) / (schedule.schedule.everySeconds * 1000)) + 1)
            : undefined;
          skipScheduleRange(schedule, first, previous, skippedCount);
        }
        const fire = await persistScheduleFire(schedule, last, last);
        await deliverScheduleFire(fire); processed++;
      } else {
        let scheduledFor = first;
        let fired = 0;
        const maximum = Math.min(schedule.missedFirePolicy.catchUp.maxFirings, limit - processed);
        while (fired < maximum && Date.parse(scheduledFor) <= Date.parse(last)) {
          const fire = await persistScheduleFire(schedule, scheduledFor);
          await deliverScheduleFire(fire); processed++; fired++;
          scheduledFor = nextScheduleOccurrence(schedule.schedule, scheduledFor);
        }
        // Catch-up is bounded per pass; remaining due slots stay queued for a later pass.
        if (Date.parse(schedule.nextFireAt) > Date.parse(last)) schedule.nextFireAt = nextAfterLast;
        await save();
      }
    }
    return { processed };
  }
  async function startRunInternal({ projectId, organizationId, principal, workflow, activeTicketId = null, runInput = {},
    reservedRunId, provenance }) {
    if (!principal) throw new Error('A governed principal is required to start a workflow run.');
    state.workflowRuns ??= {};
    const id = reservedRunId ?? randomUUID();
    if (state.workflowRuns[id]) throw new Error('Reserved workflow run identity is already in use.');
    const pinnedWorkflow = structuredClone(workflow);
    const workflowExecution = normalize(workflow);
    const checkedRunInput = validateActivityValue(runInput, workflowExecution.runInputSchema);
    const run = {
      id, projectId, organizationId, principal: structuredClone(principal), executionPrincipal: structuredClone(principal),
      workflow: pinnedWorkflow, independentRun: true,
      runInput: checkedRunInput, runInputDigest: activityDigest(checkedRunInput), activityOutputs: {},
      activeTicketId, title: workflow.name, status: 'ready', sequence: 0, events: [],
      checks: [], messages: [], lease: null, startedAt: now(), eventEligibilityCursor: eventJournal.cursor(),
      ...(provenance ? { provenance: structuredClone(provenance) } : {}),
    };
    if (provenance?.eventCursor !== undefined) run.eventEligibilityCursor = provenance.eventCursor;
    state.workflowRuns[id] = run;
    try { await engine.start(run); }
    catch (error) { delete state.workflowRuns[id]; throw error; }
    await save();
    return structuredClone(run);
  }
  const activityDescriptors = scope => {
    const descriptors = new Map((activityCatalog?.all() ?? []).map(descriptor => [activityCatalog.key(descriptor.ref), {
      ...descriptor, digest: activityDigest(descriptor), available: Boolean(activityAvailable(descriptor.ref)),
    }]));
    const unavailableRefs = new Set();
    let unavailableTruncated = false;
    let unavailableAdded = 0;
    let projectionBytes = Buffer.byteLength(JSON.stringify([...descriptors.values()]));
    const visibleDefinitions = (state.workflows ?? []).filter(workflow => visibleWorkflow(workflow, scope));
    for (const workflow of visibleDefinitions) for (const node of workflow.nodes ?? workflow.steps ?? []) {
      const ref = node.activity ?? legacyActivityRef(node.operation);
      if (!ref || descriptors.has(`${ref.id}@${ref.revision}`)) continue;
      const key = `${ref.id}@${ref.revision}`;
      if (unavailableRefs.has(key)) continue;
      if (unavailableRefs.size >= 512) { unavailableTruncated = true; continue; }
      unavailableRefs.add(key);
      const placeholder = {
        ref: structuredClone(ref), inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        resources: { location: 'daemon' }, effect: 'durable-effect', approval: { required: true, policy: 'workflow-gate' },
        cancellation: 'reconcile-after-dispatch', confirmation: 'human-reconciled', reconciliation: 'adapter',
        presentation: { label: 'Unavailable activity' }, available: false,
      };
      const bytes = Buffer.byteLength(JSON.stringify(placeholder));
      if (descriptors.size < 224 && projectionBytes + bytes <= 1_000_000) {
        descriptors.set(key, placeholder);
        projectionBytes += bytes;
        unavailableAdded += 1;
      } else unavailableTruncated = true;
    }
    return { descriptors: [...descriptors.values()].map(value => structuredClone(value)), unavailableTotal: unavailableRefs.size,
      unavailableTruncated: unavailableTruncated || unavailableAdded < unavailableRefs.size };
  };
  return {
    id: 'workflows',
    commands,
    sessionCommands,
    snapshot({ scope } = {}) {
      const organizationId = scope?.organizationId;
      const visible = (workflow) => visibleWorkflow(workflow, scope);
      const visibleRuns = Object.values(state.workflowRuns ?? {}).filter((run) =>
        (!organizationId || run.organizationId === organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(run.projectId)));
      const scopedDecisions = Object.entries(state.automationDecisionLedger).filter(([, decision]) =>
        (!organizationId || decision.organizationId === organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(decision.projectId)));
      const terminal = (run) => ['completed', 'cancelled'].includes(run.flow?.status ?? run.status);
      visibleRuns.sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || String(b.updatedAt ?? b.startedAt ?? '').localeCompare(String(a.updatedAt ?? a.startedAt ?? '')));
      return {
        workflowRunsTotal: visibleRuns.length,
        workflowRunsTruncated: visibleRuns.length > 200,
        workflowRuns: visibleRuns.slice(0, 200).map(publicRun),
        workflows: state.workflows.filter(workflow => visible({ ...workflow, organizationId: workflow.organizationId ?? 'personal' })).map(readDefinition),
        workflowDrafts: Object.fromEntries(
          Object.entries(state.workflowDrafts).filter(
            ([, draft]) => visible(draft.workflow),
          ),
        ),
        automations: automations.snapshot(scope),
        workflowEventDescriptors: eventJournal.descriptors().map(({ id, revision, label, tenantScope, payload, correlationPaths, aliases, manual }) => ({
          id, revision, label, tenantScope, payload: structuredClone(payload), correlationPaths: [...correlationPaths],
          aliases: [...aliases], ...(manual ? { manual: true } : {}),
        })),
        workflowSchedules: (() => {
          const schedules = this.scheduleSnapshot(scope);
          return { items: schedules.slice(0, 100).map(({ principal, runInput, ...schedule }) => schedule), total: schedules.length,
            truncated: schedules.length > 100 };
        })(),
        workflowWebhookBindings: (() => {
          const bindings = state.workflowWebhookBindings.filter(value =>
          (!organizationId || value.organizationId === organizationId) &&
          (!scope?.projectIds || scope.projectIds.includes(value.projectId)));
          return { items: bindings.slice(-100).map(value => structuredClone(value)), total: bindings.length,
            truncated: bindings.length > 100 };
        })(),
        workflowEventDecisions: { items: scopedDecisions.slice(-100).map(([key, decision]) => ({
          key, status: decision.status, projectId: decision.projectId, organizationId: decision.organizationId,
          subscriptionId: decision.subscriptionId, subscriptionRevision: decision.subscriptionRevision,
          ruleId: decision.ruleId, ruleRevision: decision.ruleRevision, workflowId: decision.workflowId,
          workflowVersion: decision.workflowVersion, runId: decision.runId, ticketId: decision.ticketId,
          sourceEventId: decision.sourceEvent?.source?.eventId, at: decision.at,
          ...(decision.runInputDigest ? { runInputDigest: decision.runInputDigest } : {}),
          ...(decision.message ? { message: String(decision.message).slice(0, 300) } : {}),
        })), total: scopedDecisions.length, truncated: scopedDecisions.length > 100 },
        workflowEventRejections: (() => {
          const rejected = Object.values(state.workflowEventRejections ?? {}).filter(value =>
            (!organizationId || value.organizationId === organizationId) &&
            (!scope?.projectIds || scope.projectIds.includes(value.projectId)));
          return { items: rejected.slice(-100).map(({ key, reason, source, descriptor, projectId, receivedAt }) =>
            ({ key, reason, source: structuredClone(source), descriptor: structuredClone(descriptor), projectId, receivedAt })),
            total: rejected.length, truncated: rejected.length > 100 };
        })(),
        automationDecisions: scopedDecisions.filter(([, decision]) => decision.ticketId !== undefined).slice(-100).map(([triggerKey, decision]) => ({
          triggerKey, workflowId: decision.workflowId, workflowVersion: decision.workflowVersion, ticketId: decision.ticketId,
          ...(decision.trigger ? { trigger: decision.trigger } : {}), at: decision.at,
          status: decision.status, ...(decision.message ? { message: String(decision.message).slice(0, 1000) } : {}),
          ...(decision.ruleId ? { ruleId: decision.ruleId, ruleRevision: decision.ruleRevision } : {}),
          ...(decision.activeSessionId ? { activeSessionId: decision.activeSessionId } : {}),
          ...(decision.activeRunId ? { activeRunId: decision.activeRunId } : {}), attempts: decision.attempts ?? 0,
        })),
        automationFailures: state.automationFailures.filter(failure => {
          const decision = state.automationDecisionLedger[failure.triggerKey];
          return decision && (!organizationId || decision.organizationId === organizationId) &&
            (!scope?.projectIds || scope.projectIds.includes(decision.projectId));
        }).slice(-100).map(value => structuredClone(value)),
        defaultWorkflowIds: {
          organizations: organizationId && state.defaultWorkflowIds.organizations[organizationId]
            ? { [organizationId]: state.defaultWorkflowIds.organizations[organizationId] } : {},
          projects: Object.fromEntries((scope?.projectIds ?? state.projects.map((project) => project.id)).filter((id) => state.defaultWorkflowIds.projects[id])
            .map((id) => [id, state.defaultWorkflowIds.projects[id]])),
        },
        defaultWorkflowId:
          (scope?.projectIds ?? [])
            .map((id) => state.defaultWorkflowIds.projects[id])
            .find(Boolean) ?? state.defaultWorkflowIds.organizations[organizationId],
        ...(() => {
          const projection = activityDescriptors(scope);
          return { workflowActivities: projection.descriptors, workflowActivitiesUnavailableTotal: projection.unavailableTotal,
            workflowActivitiesTruncated: projection.unavailableTruncated };
        })(),
      };
    },
    registry,
    selection(value, session) {
      const project = state.projects.find((candidate) => candidate.id === session?.projectId);
      const organizationId = project?.organizationId ?? 'personal';
      const id =
        typeof value === 'string'
          ? value
          : (state.defaultWorkflowIds.projects[project?.id] ??
            state.defaultWorkflowIds.organizations[organizationId]);
      if (!id) return null;
      const chosen = state.workflows
        .filter(
          (workflow) =>
            workflow.id === id &&
            (workflow.organizationId ?? 'personal') === organizationId &&
            (!workflow.projectId || workflow.projectId === project?.id) &&
            (!workflow.teamId || workflow.teamId === project?.teamId),
        )
        .at(-1);
      if (!chosen) throw new Error('Workflow not found.');
      return {
        ...normalize(chosen),
        // Older published definitions omit owner/version fields. Interpret
        // them at selection time so fresh runtimes preserve the personal v1
        // pin without rewriting the immutable stored definition.
        organizationId: chosen.organizationId ?? 'personal',
        ...(chosen.teamId ? { teamId: chosen.teamId } : {}),
        ...(chosen.projectId ? { projectId: chosen.projectId } : {}),
        version: chosen.version ?? 1,
      };
    },
    command(command, { validateClient, principal }) {
      validateClient(command.client);
      if (command.action === 'saveAutomation')
        return automations.save(command, principal);
      return command.action === 'saveWorkflow'
        ? registry.publish(command)
        : registry.saveDraft(command);
    },
    async sessionCommand(session, command) {
      if (command.action === 'retryAutomationDecision') return effects.retryTrigger(session, command);
      if (command.action === 'reconcileWorkflowEffect') return effects.reconcile(session, command);
      if (command.action === 'startWorkflow') return engine.start(session);
      if (command.action === 'pauseWorkflow' || command.action === 'cancelWorkflow') {
        await requestStop(session);
        if (command.action === 'cancelWorkflow') await engine.pause(session, true);
        return;
      }
      return engine.decide(session, command);
    },
    startRun: startRunInternal,
    registerWait,
    deliverPendingWaitEvents,
    processDueDeadlines,
    eventDescriptors() { return eventJournal.descriptors(); },
    eventJournal,
    async acceptEvent(envelope) {
      return eventJournal.accept(envelope, { beforeSave: event => reserveEventDecisions(event) });
    },
    async acceptOutboxEvent(envelope) {
      if (envelope?.causation?.depth > 16)
        return { rejected: await this.recordCausalLimitRejection(envelope) };
      return { accepted: await this.acceptEvent(envelope) };
    },
    async recordCausalLimitRejection(envelope) {
      const causation = envelope?.causation;
      if (!causation || !Number.isInteger(causation.depth) || causation.depth <= 16 ||
          typeof causation.eventId !== 'string' || !causation.eventId || causation.eventId.length > 160 ||
          typeof causation.rootEventId !== 'string' || !causation.rootEventId || causation.rootEventId.length > 160 ||
          typeof envelope?.source?.id !== 'string' || !envelope.source.id || envelope.source.id.length > 120 ||
          typeof envelope.source.eventId !== 'string' || !envelope.source.eventId || envelope.source.eventId.length > 160 ||
          typeof envelope.organizationId !== 'string' || !envelope.organizationId || envelope.organizationId.length > 100 ||
          typeof envelope.projectId !== 'string' || !envelope.projectId || envelope.projectId.length > 100)
        throw new Error('Workflow event cascade rejection is invalid.');
      const descriptor = eventJournal.descriptor(envelope.descriptor);
      if (!descriptor || descriptor.tenantScope === 'organization' || descriptor.tenantScope === 'resource' && !envelope.resourceRef ||
          descriptor.tenantScope !== 'resource' && envelope.resourceRef)
        throw new Error('Workflow event cascade rejection does not match a registered project event.');
      const key = JSON.stringify([envelope.source.id, envelope.source.eventId]);
      const current = state.workflowEventRejections[key];
      if (current) {
        if (current.organizationId !== envelope.organizationId || current.projectId !== envelope.projectId ||
            current.descriptor.id !== descriptor.id || current.descriptor.revision !== descriptor.revision ||
            current.causation.runId !== causation.runId || current.causation.rootEventId !== causation.rootEventId)
          throw new Error('Workflow event rejection identity conflicts with an earlier disposition.');
        return structuredClone(current);
      }
      const rejection = { key, reason: 'causation_limit', source: { id: envelope.source.id, eventId: envelope.source.eventId },
        descriptor: { id: descriptor.id, revision: descriptor.revision }, organizationId: envelope.organizationId,
        projectId: envelope.projectId, causation: { eventId: causation.eventId, runId: causation.runId,
          depth: causation.depth, rootEventId: causation.rootEventId }, receivedAt: now() };
      state.workflowEventRejections[key] = rejection;
      await save();
      return structuredClone(rejection);
    },
    async saveSchedule(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workflow schedule is required.');
      const id = input.id ?? randomUUID();
      if (!/^[A-Za-z0-9][\w.-]{0,99}$/.test(id)) throw new Error('Workflow schedule identity is invalid.');
      const previous = state.workflowSchedules.filter(value => value.id === id).sort((a, b) => b.revision - a.revision)[0];
      if (previous && previous.revision !== input.revision) throw new Error('Workflow schedule changed. Reload before saving.');
      const project = state.projects.find(value => value.id === input.projectId);
      const workflow = workflowForSchedule(input.workflowId, input.workflowVersion, input.projectId);
      if (!project || project.organizationId !== input.organizationId) throw new Error('Workflow schedule project is unavailable.');
      if (previous && (previous.organizationId !== project.organizationId || previous.projectId !== project.id))
        throw new Error('Workflow schedule identity cannot move to another project.');
      const schedule = normalizeSchedule(input.schedule);
      const runInput = resolveScheduleRunInput(input.runInput, workflow);
      const missedFirePolicy = validateMissedFirePolicy(input.missedFirePolicy);
      const principal = input.principal;
      if (!principal || !['user', 'workload'].includes(principal.kind)) throw new Error('Workflow schedule needs a governed principal.');
      const nextFireAt = previous?.enabled && input.enabled && activityDigest(previous.schedule) === activityDigest(schedule)
        ? previous.nextFireAt : nextScheduleOccurrence(schedule, now());
      const value = { id, name: String(input.name ?? '').trim().slice(0, 120), organizationId: project.organizationId,
        projectId: project.id, workflowId: workflow.id, workflowVersion: workflow.version ?? 1, workflowDigest: activityDigest(workflow),
        principal: structuredClone(principal), runInput, runInputDigest: activityDigest(runInput), schedule, missedFirePolicy, enabled: Boolean(input.enabled),
        revision: (previous?.revision ?? 0) + 1, nextFireAt, updatedAt: now() };
      if (!value.name) throw new Error('Name the workflow schedule.');
      if (previous) previous.enabled = false;
      state.workflowSchedules.push(value);
      await save(); return structuredClone(value);
    },
    scheduleSnapshot(scope) { return state.workflowSchedules.filter(value => !state.workflowSchedules.some(other => other.id === value.id && other.revision > value.revision) && (!scope?.organizationId || value.organizationId === scope.organizationId) &&
      (!scope?.projectIds || scope.projectIds.includes(value.projectId))).map(value => structuredClone(value)); },
    schedule(id, revision) { const value = state.workflowSchedules.find(item => item.id === id && item.revision === revision); return value ? structuredClone(value) : null; },
    processDueSchedules,
    async processDue(at = now(), options = {}) {
      const schedules = await processDueSchedules(at, options);
      // An event accepted before a deadline wins the serialized race; an event
      // received after the deadline is left for the timeout transition below.
      const waits = await deliverPendingWaitEvents();
      const deadlines = await processDueDeadlines(at, options);
      return { schedulesProcessed: schedules.processed, deadlinesProcessed: deadlines.processed,
        waitsDelivered: waits.delivered };
    },
    async saveWebhookBinding(input) {
      const descriptor = eventJournal.descriptor({ id: input?.descriptorId, revision: input?.descriptorRevision });
      if (!descriptor || descriptor.tenantScope !== 'project' || !input.projectId || !input.organizationId ||
          !Array.isArray(input.fieldMap) || input.fieldMap.length > descriptor.payload.length ||
          typeof input.servicePrincipalId !== 'string' || !input.servicePrincipalId)
        throw new Error('Workflow webhook binding is invalid.');
      const project = state.projects.find(value => value.id === input.projectId);
      if (!project || project.organizationId !== input.organizationId) throw new Error('Workflow webhook project is unavailable.');
      const id = input.id ?? randomUUID();
      if (!/^[A-Za-z0-9][\w.-]{0,99}$/.test(id)) throw new Error('Workflow webhook binding identity is invalid.');
      const previous = state.workflowWebhookBindings.find(value => value.id === id);
      if (previous && previous.revision !== input.revision) throw new Error('Workflow webhook binding changed. Reload before saving.');
      if (previous && (previous.organizationId !== project.organizationId || previous.projectId !== project.id))
        throw new Error('Workflow webhook binding identity cannot move to another project.');
      const seenTargets = new Set();
      const fieldMap = input.fieldMap.map(mapping => {
        if (!mapping || !descriptor.payload.some(field => field.path === mapping.targetPath) ||
            typeof mapping.sourcePath !== 'string' || !/^[A-Za-z][\w.-]{0,100}$/.test(mapping.sourcePath) || seenTargets.has(mapping.targetPath))
          throw new Error('Workflow webhook field mapping is invalid.');
        seenTargets.add(mapping.targetPath); return { targetPath: mapping.targetPath, sourcePath: mapping.sourcePath };
      });
      const eventIdPath = input.eventIdPath;
      if (typeof eventIdPath !== 'string' || !/^[A-Za-z][\w.-]{0,100}$/.test(eventIdPath)) throw new Error('Workflow webhook event identity path is required.');
      const value = { id, name: String(input.name ?? '').trim().slice(0, 120), descriptorId: descriptor.id,
        descriptorRevision: descriptor.revision, organizationId: project.organizationId, projectId: project.id,
        servicePrincipalId: input.servicePrincipalId, eventIdPath, fieldMap, enabled: Boolean(input.enabled),
        revision: (previous?.revision ?? 0) + 1, updatedAt: now() };
      if (!value.name) throw new Error('Name the workflow webhook binding.');
      if (previous) Object.assign(previous, value); else state.workflowWebhookBindings.push(value);
      await save(); return structuredClone(value);
    },
    webhookBinding(id) { const value = state.workflowWebhookBindings.find(binding => binding.id === id && binding.enabled); return value ? structuredClone(value) : null; },
    async revokeWebhookBinding(id) {
      const value = state.workflowWebhookBindings.find(binding => binding.id === id);
      if (!value) throw new Error('Workflow webhook binding was not found.');
      value.enabled = false; value.revision++; value.updatedAt = now(); await save();
    },
    async acceptBoundWebhook(binding, rawPayload, principal) {
      const active = state.workflowWebhookBindings.find(value => value.id === binding?.id && value.enabled && value.revision === binding.revision);
      if (!active || principal?.kind !== 'service-principal' || principal.servicePrincipalId !== active.servicePrincipalId)
        throw new Error('Workflow webhook binding is not available to this principal.');
      const sourceEventId = workflowEventPath(rawPayload, active.eventIdPath);
      if (typeof sourceEventId !== 'string' && typeof sourceEventId !== 'number') throw new Error('Workflow webhook payload is missing its event identity.');
      const payload = {};
      for (const mapping of active.fieldMap) {
        const value = workflowEventPath(rawPayload, mapping.sourcePath);
        if (value !== undefined) setPayloadPath(payload, mapping.targetPath, structuredClone(value));
      }
      const descriptor = eventJournal.descriptor({ id: active.descriptorId, revision: active.descriptorRevision });
      const correlationPath = descriptor?.correlationPaths[0];
      const correlationValue = correlationPath && workflowEventPath(payload, correlationPath);
      return this.acceptEvent({ descriptor: { id: active.descriptorId, revision: active.descriptorRevision },
        source: { id: `workflow-webhook.${active.id}`, eventId: String(sourceEventId) }, organizationId: active.organizationId,
        projectId: active.projectId, payload, ...(correlationValue !== undefined ? { correlation: { key: correlationPath, value: String(correlationValue) } } : {}),
        origin: { kind: 'service-principal', id: active.servicePrincipalId } });
    },
    pendingEventDecisions({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid workflow decision page size.');
      return Object.entries(state.automationDecisionLedger).filter(([, decision]) => ['reserved', 'started'].includes(decision.status) &&
        (decision.status === 'reserved' || !state.workflowRuns?.[decision.runId]))
        .slice(0, limit).map(([triggerKey, decision]) => ({ triggerKey, ...structuredClone(decision) }));
    },
    validateEventDecision(triggerKey) {
      const decision = state.automationDecisionLedger?.[triggerKey];
      if (!decision) throw new Error('Workflow event decision is not available.');
      if (decision.kind === 'schedule') {
        const schedule = state.workflowSchedules.find(value => value.id === decision.subscriptionId &&
          value.revision === decision.subscriptionRevision);
        if (!schedule || activityDigest(schedule.principal) !== activityDigest(decision.principal) ||
            schedule.workflowId !== decision.workflowId || schedule.workflowVersion !== decision.workflowVersion ||
            schedule.workflowDigest !== decision.workflowDigest ||
            (schedule.runInputDigest ?? activityDigest(schedule.runInput ?? {})) !== (decision.runInputDigest ?? activityDigest(decision.runInput ?? {})))
          throw new Error('The pinned schedule revision is unavailable or changed.');
      } else {
        const rule = state.automations?.find(value => value.id === decision.ruleId && value.revision === decision.ruleRevision);
        if (!rule?.enabled || activityDigest(rule.principal) !== activityDigest(decision.principal))
          throw new Error('The pinned automation is unavailable or its principal changed.');
        automations.validate(rule);
      }
      return structuredClone(decision);
    },
    eventDecision(triggerKey) {
      const decision = state.automationDecisionLedger?.[triggerKey];
      return decision ? structuredClone(decision) : null;
    },
    async ensureRunForDecision(triggerKey) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || decision.decisionKey !== triggerKey || !decision.runId || !decision.projectId || !decision.principal)
        throw new Error('Workflow event decision is not available.');
      const existing = state.workflowRuns?.[decision.runId];
      if (existing) {
        if (existing.provenance?.decisionKey !== triggerKey || existing.provenance?.eventId !== decision.eventId ||
            existing.projectId !== decision.projectId || activityDigest(existing.principal) !== activityDigest(decision.principal) ||
            existing.provenance?.workflowDigest !== decision.workflowDigest ||
            existing.runInputDigest !== activityDigest(pinnedDecisionRunInput(decision)))
          throw new Error('Reserved workflow run identity conflicts with its event decision.');
        if (decision.status !== 'started') { decision.status = 'started'; decision.startedAt ??= now(); await save(); }
        return structuredClone(existing);
      }
      if (decision.status !== 'reserved') throw new Error('Workflow event decision is not ready to start.');
      const workflow = state.workflows.find(value => value.id === decision.workflowId && (value.version ?? 1) === decision.workflowVersion);
      if (!workflow || activityDigest(workflow) !== decision.workflowDigest)
        throw new Error('The decision’s pinned workflow revision is unavailable or changed.');
      const runInput = pinnedDecisionRunInput(decision);
      const activeRuns = Object.values(state.workflowRuns ?? {}).filter(run => run.provenance?.subscriptionId === decision.subscriptionId &&
        !['completed', 'cancelled'].includes(run.flow?.status ?? run.status)).length;
      const waiting = Object.entries(state.automationDecisionLedger).filter(([key, value]) => key !== triggerKey &&
        value.subscriptionId === decision.subscriptionId && value.subscriptionRevision === decision.subscriptionRevision &&
        ['reserved', 'started'].includes(value.status) && !state.workflowRuns?.[value.runId]);
      const entries = Object.keys(state.automationDecisionLedger);
      const priorWaiting = waiting.filter(([key]) => entries.indexOf(key) < entries.indexOf(triggerKey)).length;
      if (activeRuns + priorWaiting >= decision.maxActiveRuns) {
        const overflowPolicy = decision.concurrencyPolicy === 'independent' ? decision.overflowPolicy ?? 'hold' : decision.concurrencyPolicy;
        decision.status = overflowPolicy === 'reject' ? 'conflict' : 'held';
        decision.message = 'Workflow subscription reached its active-run limit before this decision could start.';
        decision.updatedAt = now();
        await save();
        return null;
      }
      try {
        const run = await startRunInternal({ projectId: decision.projectId, organizationId: decision.organizationId,
          principal: decision.principal, workflow, activeTicketId: decision.ticketId ?? null, runInput, reservedRunId: decision.runId,
          provenance: { eventId: decision.eventId, sourceEventId: decision.sourceEvent.source.eventId,
            subscriptionId: decision.subscriptionId, subscriptionRevision: decision.subscriptionRevision,
            decisionKey: triggerKey, workflowDigest: decision.workflowDigest, eventCursor: decision.sourceEvent.sequence,
            ...(decision.sourceEvent.causation ? { causation: structuredClone(decision.sourceEvent.causation) } : {}) } });
        decision.status = 'started'; decision.startedAt = now(); decision.attempts = (decision.attempts ?? 0) + 1;
        await save();
        return run;
      } catch (error) {
        decision.status = 'failed'; decision.message = String(error?.message ?? error).slice(0, 1000);
        decision.attempts = (decision.attempts ?? 0) + 1;
        await save();
        throw error;
      }
    },
    async retryEventDecision(triggerKey) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || !['held', 'failed', 'conflict'].includes(decision.status)) throw new Error('Workflow event decision is not available for explicit retry.');
      const existing = state.workflowRuns?.[decision.runId];
      if (existing) {
        if (existing.provenance?.decisionKey !== triggerKey || existing.provenance?.eventId !== decision.eventId ||
            existing.projectId !== decision.projectId || activityDigest(existing.principal) !== activityDigest(decision.principal) ||
            existing.provenance?.workflowDigest !== decision.workflowDigest ||
            existing.runInputDigest !== activityDigest(pinnedDecisionRunInput(decision)))
          throw new Error('Reserved workflow run identity conflicts with its event decision.');
        // A run can be durably created before the decision acknowledgement is
        // saved. Reconcile that owner record in place; never allocate or
        // dispatch a second run for the same accepted event.
        decision.status = 'started';
        decision.startedAt ??= now();
        decision.reconciledAt = now();
        delete decision.message;
        await save();
        return structuredClone(existing);
      }
      const active = Object.values(state.workflowRuns ?? {}).filter(run => run.provenance?.subscriptionId === decision.subscriptionId &&
        !['completed', 'cancelled'].includes(run.flow?.status ?? run.status)).length;
      const pending = Object.values(state.automationDecisionLedger).filter(value => value !== decision &&
        value.subscriptionId === decision.subscriptionId && value.subscriptionRevision === decision.subscriptionRevision &&
        ['reserved', 'started'].includes(value.status) && !state.workflowRuns?.[value.runId]).length;
      if (active + pending >= (decision.maxActiveRuns ?? 1)) throw new Error('Workflow subscription is still at its active-run limit.');
      decision.status = 'reserved'; delete decision.message; decision.retryRequestedAt = now();
      await save();
      return structuredClone(decision);
    },
    legacyDecisionForRetry(triggerKey) {
      const decision = state.automationDecisionLedger?.[triggerKey];
      if (!decision || !['failed', 'blocked_active'].includes(decision.status))
        throw new Error('Workflow trigger is not failed or has already started.');
      const rule = state.automations?.find(value => value.id === decision.ruleId && value.revision === decision.ruleRevision);
      if (decision.ruleId && (!rule || !rule.enabled)) throw new Error('Start automation changed. Review it before retrying.');
      if (rule) automations.validate(rule);
      const workflow = state.workflows.find(value => value.id === decision.workflowId && (value.version ?? 1) === decision.workflowVersion);
      if (!workflow) throw new Error('The pinned workflow version for this trigger is unavailable.');
      return {
        decision: structuredClone(decision),
        ...(rule ? { rule: structuredClone(rule) } : {}),
        workflow: { ...normalize(structuredClone(workflow)), version: decision.workflowVersion },
      };
    },
    async markLegacyDecisionPending(triggerKey) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || !['failed', 'blocked_active'].includes(decision.status))
        throw new Error('Workflow trigger is not failed or has already started.');
      decision.status = 'pending'; decision.attempts = (decision.attempts ?? 0) + 1; decision.lastRetryAt = now();
      await save(); return structuredClone(decision);
    },
    async markLegacyDecisionStarted(triggerKey) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || decision.status !== 'pending') throw new Error('Workflow trigger retry is no longer current.');
      decision.status = 'started'; await save(); return true;
    },
    async failLegacyDecision(triggerKey, error) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || !['pending', 'started'].includes(decision.status)) return false;
      decision.status = 'failed'; decision.message = String(error?.message ?? error ?? 'Workflow trigger failed.').slice(0, 1000);
      state.automationFailures.push({ at: now(), triggerKey, workflowId: decision.workflowId,
        workflowVersion: decision.workflowVersion, ticketId: decision.ticketId, trigger: decision.trigger, message: decision.message });
      state.automationFailures = state.automationFailures.slice(-100);
      await save(); return true;
    },
    async failEventDecision(triggerKey, error) {
      const decision = state.automationDecisionLedger[triggerKey];
      if (!decision || decision.status === 'started') return false;
      decision.status = 'failed'; decision.message = String(error?.message ?? error ?? 'Event decision failed.').slice(0, 1000);
      decision.updatedAt = now(); await save(); return true;
    },
    eventDecisions(scope, { limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid workflow decision page size.');
      return Object.entries(state.automationDecisionLedger).filter(([, decision]) =>
        (!scope?.organizationId || decision.organizationId === scope.organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(decision.projectId)))
        .slice(-limit).map(([key, value]) => ({ key, id: value.eventId, status: value.status,
          subscriptionId: value.subscriptionId, revision: value.subscriptionRevision, runId: value.runId,
          projectId: value.projectId, workflowId: value.workflowId, workflowVersion: value.workflowVersion,
          at: value.at, ...(value.message ? { message: value.message } : {}) }));
    },
    async decideRun(run, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run)
        throw new Error('Workflow run is not available.');
      if (run.flow?.instance !== command.instance)
        throw new Error('This workflow step has changed. Refresh before acting.');
      const action = command.decision === 'approve' ? 'approveGate' : 'requestChanges';
      const context = state.sessions[run.sessionId] ?? run;
      await engine.decide(context, { action, instance: command.instance, feedback: command.feedback, actor: command.actor, principal: command.principal,
        activityReservationId: command.activityReservationId, activityReservationDigest: command.activityReservationDigest });
      run.decisions ??= [];
      run.decisions.push({ instance: command.instance, decision: command.decision, actor: command.actor, principal: structuredClone(command.principal), at: new Date().toISOString() });
      return structuredClone(run);
    },
    claimRun(run, { client, label, actorKey }) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.lease && run.lease.expiresAt > Date.now() && (run.lease.client !== client || run.lease.principalKey !== actorKey))
        throw new Error('Workflow run is controlled by another client.');
      run.lease = { id: randomUUID(), client, principalKey: actorKey, label, expiresAt: Date.now() + 90000 };
      return run.lease;
    },
    requireRunLease(run, { client, actorKey }) {
      if (!run?.lease || run.lease.expiresAt < Date.now() || run.lease.client !== client || run.lease.principalKey !== actorKey)
        throw new Error('Claim workflow run control first.');
      run.lease.expiresAt = Date.now() + 90000;
      return run.lease;
    },
    releaseRun(run, identity) {
      this.requireRunLease(run, identity);
      run.lease = null;
    },
    async cancelRun(run, context) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      await requestStop(context, false, { awaitWork: false });
      await engine.pause(context, true);
      const unresolved = run.attempt?.effect !== 'pure' && run.attempt?.effect !== 'observation' &&
        run.attempt?.dispatchStarted !== false &&
        ['pending', 'uncertain'].includes(this.effectRecord(run.attempt.effectKey)?.status);
      if (run.attempt && unresolved) run.attempt.status = 'uncertain';
      else if (run.attempt && !['completed', 'uncertain'].includes(run.attempt.status)) run.attempt.status = 'cancelled';
      const completedEffect = run.attempt && state.workflowEffectLedger?.[`${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`];
      if (completedEffect?.status === 'succeeded') {
        run.attempt.status = 'completed';
        run.attempt.outcome = 'success';
        run.attempt.effectKey = `${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`;
        run.attempt.effectResult = structuredClone(completedEffect.result);
        run.attempt.completedAt ??= completedEffect.reconciledAt ?? completedEffect.at;
      }
    },
    async reconcileRun(run, context, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      await effects.reconcile(context, command);
      const unresolved = Object.entries(state.workflowEffectLedger ?? {}).some(([key, effect]) =>
        key.startsWith(`${run.id}:`) && ['pending', 'uncertain'].includes(effect.status));
      if (!unresolved && context.flow.status === 'cancelled' && run.attempt?.instance === command.instance)
        run.attempt.status = 'cancelled';
      if (run.attempt?.instance === command.instance && run.attempt.status === 'uncertain' && !['failed', 'interrupted'].includes(context.flow.status))
        run.attempt.status = 'ready';
      const effectKey = run.attempt?.instance === command.instance
        ? `${run.id}:${command.instance}:${run.attempt.nodeId}` : null;
      const effect = effectKey && state.workflowEffectLedger?.[effectKey];
      if (effect?.status === 'succeeded') {
        run.attempt.status = 'completed';
        run.attempt.outcome = 'success';
        run.attempt.effectKey = effectKey;
        run.attempt.effectResult = structuredClone(effect.result);
        run.attempt.completedAt ??= effect.reconciledAt ?? effect.at;
      }
    },
    async continueRun(run, context, command) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.attempt?.status === 'uncertain' || context.assignment?.state === 'uncertain' || context.interruption?.needsReview)
        throw new Error('Inspect and reconcile the interrupted agent activity before continuing the workflow.');
      if (run.flow?.instance !== command.instance) throw new Error('This workflow step has changed. Refresh before acting.');
      await engine.decide(context, { action: 'continueWorkflow', instance: command.instance });
    },
    run(id) { return state.workflowRuns?.[id] ?? null; },
    placementAssignments() {
      return Object.values(state.workflowRuns ?? {}).filter(run => run.independentRun && !run.sessionId && run.assignment)
        .map(run => ({ id: run.id, projectId: run.projectId, organizationId: run.organizationId,
          runnerId: run.runnerId, assignment: structuredClone(run.assignment) }));
    },
    effectRecord(key) { return structuredClone(state.workflowEffectLedger?.[key] ?? null); },
    effectForAttempt(runId, instance, nodeId) {
      if (![runId, instance, nodeId].every(value => typeof value === 'string')) return null;
      return this.effectRecord(`${runId}:${instance}:${nodeId}`);
    },
    effectSummaries(projectIds) {
      const allowed = projectIds ? new Set(projectIds) : null;
      return Object.entries(state.workflowEffectLedger ?? {}).filter(([, effect]) => !allowed || allowed.has(effect.projectId))
        .map(([effectKey, effect]) => ({ effectKey, status: effect.status, operation: effect.operation, at: effect.at,
          ...(effect.reconciledAt ? { reconciledAt: effect.reconciledAt } : {}), ...(effect.message ? { message: effect.message } : {}),
          ...(effect.blockingReplyRequestId ? { blockingReplyRequestId: effect.blockingReplyRequestId } : {}) }));
    },
    resolveWorkflowResult(context) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const workflow = normalize(run.workflow);
      if (!workflow.resultSchema) return null;
      const result = resolveActivityBindings(workflow.resultBindings, workflow.resultSchema, {
        runInputSchema: workflow.runInputSchema, runInput: run.runInput, activityOutputs: run.activityOutputs,
      });
      const resultDigest = activityDigest(result);
      if (run.resultDigest && run.resultDigest !== resultDigest)
        throw new Error('Workflow result is immutable once recorded.');
      return { result, resultDigest };
    },
    recordWorkflowResult(context, resolved) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const value = resolved ?? this.resolveWorkflowResult(context);
      if (!value) return null;
      if (run.resultDigest && run.resultDigest !== value.resultDigest) throw new Error('Workflow result is immutable once recorded.');
      run.result = structuredClone(value.result);
      run.resultDigest = value.resultDigest;
      return { result: structuredClone(run.result), resultDigest: run.resultDigest };
    },
    saveEffectRecord(key, value) {
      if (typeof key !== 'string' || key.length > 500 || !value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Workflow effect record is invalid.');
      state.workflowEffectLedger ??= {};
      state.workflowEffectLedger[key] = structuredClone(value);
      return structuredClone(state.workflowEffectLedger[key]);
    },
    deleteEffectRecord(key) { delete state.workflowEffectLedger?.[key]; },
    getActivityRef(node) { return node?.activity ? structuredClone(node.activity) : legacyActivityRef(node?.operation); },
    activityDescriptor(ref) { return activityCatalog?.get(ref) ?? null; },
    activityApprovalSatisfied(run, nodeId) {
      if (!run || state.workflowRuns?.[run.id] !== run) return false;
      const workflow = normalize(run.workflow);
      const history = run.flow?.history?.at(-1);
      return Boolean(history && history.to === nodeId && history.outcome === 'approved' &&
        workflow.nodes.some(node => node.id === history.nodeId && node.kind === 'human') &&
        workflow.edges.some(edge => edge.from === history.nodeId && edge.to === nodeId && edge.outcome === 'approved'));
    },
    async reserveActivityIntent({ runId, gateNodeId, gateInstance, targetNodeId }) {
      const run = state.workflowRuns?.[runId];
      if (!run || run.flow?.status !== 'waiting_gate' || run.flow?.nodeId !== gateNodeId ||
          run.flow?.instance !== gateInstance || run.attempt?.instance !== gateInstance || run.attempt?.status !== 'waiting')
        throw new Error('The human gate is no longer the active workflow step.');
      const workflow = normalize(run.workflow);
      const gate = workflow.nodes.find(node => node.id === gateNodeId);
      const route = workflow.edges.find(edge => edge.from === gateNodeId && edge.to === targetNodeId && edge.outcome === 'approved');
      const target = workflow.nodes.find(node => node.id === targetNodeId);
      if (gate?.kind !== 'human' || !route || !target?.activity)
        throw new Error('The reservation target must be the configured approved activity route.');
      const descriptor = activityCatalog?.get(target.activity);
      if (!descriptor?.approval.required || descriptor.approval.policy !== 'workflow-gate')
        throw new Error('The target activity does not require a workflow approval reservation.');
      run.activityReservations = (run.activityReservations ?? []).filter(item =>
        !item.consumedAt && !item.invalidatedAt || item.id === run.attempt?.reservationId &&
          ['ready', 'running', 'waiting', 'uncertain'].includes(run.attempt?.status));
      const existing = run.activityReservations.find(item => item.gateInstance === gateInstance && item.targetNodeId === targetNodeId && !item.consumedAt && !item.invalidatedAt);
      if (existing) return structuredClone({ id: existing.id, digest: existing.digest, preview: existing.preview });
      if (run.activityReservations.filter(item => !item.consumedAt && !item.invalidatedAt).length >= 32)
        throw new Error('Workflow has too many outstanding activity reservations.');
      const targetInstance = randomUUID();
      const prepared = await prepareActivityIntent(run, target, targetInstance, { gateNodeId, gateInstance });
      const intent = checkedActivityIntent(prepared.intent);
      const resourcePins = checkedActivityIntent(prepared.resourcePins ?? {});
      const intentDigest = activityDigest(intent);
      if (prepared.intentDigest !== intentDigest) throw new Error('Prepared activity intent digest is invalid.');
      const preview = validateActivityValue(prepared.preview, activityIntentSchema);
      if (Buffer.byteLength(JSON.stringify(preview)) > 24_000 || activityDigest(preview.intent) !== intentDigest)
        throw new Error('Prepared activity approval material is invalid or too large.');
      if (activityDigest(prepared.ref) !== activityDigest(target.activity)) throw new Error('Prepared activity revision changed.');
      const reservation = {
        id: randomUUID(), runId, gateNodeId, gateInstance, targetNodeId, targetInstance,
        activityRef: structuredClone(prepared.ref), inputDigest: prepared.inputDigest,
        activityDescriptorDigest: target.activityDescriptorDigest ?? activityDigest(descriptor),
        intentDigest, idempotencyKey: prepared.idempotencyKey, resourcePins,
        intent, preview,
        digest: activityDigest({ runId, gateNodeId, gateInstance, targetNodeId, targetInstance,
          activityRef: prepared.ref, activityDescriptorDigest: target.activityDescriptorDigest ?? activityDigest(descriptor),
          inputDigest: prepared.inputDigest, intentDigest, resourcePins }),
        createdAt: new Date().toISOString(),
      };
      run.activityReservations.push(reservation);
      await save();
      return structuredClone({ id: reservation.id, digest: reservation.digest, preview: reservation.preview });
    },
    activityReservationForActivation(runContext, nodeId) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      const history = run?.flow?.history?.at(-1);
      if (!run || !history || history.outcome !== 'approved') return null;
      const reservation = (run.activityReservations ?? []).find(item => item.gateNodeId === history.nodeId &&
        item.gateInstance === history.instance && item.targetNodeId === nodeId && item.id === history.activityReservationId &&
        item.digest === history.activityReservationDigest && !item.consumedAt && !item.invalidatedAt);
      return reservation ? structuredClone(reservation) : null;
    },
    verifyActivityReservationDecision(runContext, { gateNodeId, gateInstance, targetNodeId, reservationId, reservationDigest }) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const reservation = (run.activityReservations ?? []).find(item => item.gateNodeId === gateNodeId && item.gateInstance === gateInstance &&
        item.targetNodeId === targetNodeId && !item.consumedAt && !item.invalidatedAt);
      const target = normalize(run.workflow).nodes.find(node => node.id === targetNodeId);
      const descriptor = target?.activity && activityCatalog?.get(target.activity);
      if (target?.activity && !descriptor) throw new Error('The pinned target activity revision is unavailable.');
      if (!reservation) {
        if (target?.activity && descriptor?.approval.required)
          throw new Error('Prepare and review the exact activity intent before approving this gate.');
        return null;
      }
      if (reservation.id !== reservationId || reservation.digest !== reservationDigest)
        throw new Error('Approve against the exact prepared activity reservation shown for this gate.');
      if (target?.activityDescriptorDigest && target.activityDescriptorDigest !== reservation.activityDescriptorDigest)
        throw new Error('The pinned activity metadata changed after this intent was prepared.');
      return { id: reservation.id, digest: reservation.digest, targetNodeId,
        activityRef: structuredClone(reservation.activityRef), inputDigest: reservation.inputDigest,
        intentDigest: reservation.intentDigest, preview: structuredClone(reservation.preview) };
    },
    activityReservationForAttempt(runContext, nodeId, instance) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      const attempt = run?.attempt;
      if (!run || attempt?.nodeId !== nodeId || attempt?.instance !== instance || !attempt.reservationId) return null;
      const reservation = (run.activityReservations ?? []).find(item => item.id === attempt.reservationId &&
        item.targetNodeId === nodeId && item.targetInstance === instance);
      const approved = (run.flow?.history ?? []).some(item => item.outcome === 'approved' &&
        item.activityReservationId === reservation?.id && item.activityReservationDigest === reservation?.digest);
      return reservation && approved ? structuredClone(reservation) : null;
    },
    invalidateActivityReservations(runContext, { gateNodeId, gateInstance }) {
      const run = runContext?.independentRun ? runContext : state.workflowRuns?.[runContext?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run) return;
      for (const reservation of run.activityReservations ?? [])
        if (reservation.gateNodeId === gateNodeId && reservation.gateInstance === gateInstance && !reservation.consumedAt)
          reservation.invalidatedAt = new Date().toISOString();
    },
    resolveActivityInput(run, node) {
      if (!run || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      const ref = this.getActivityRef(node);
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error(`${node.name}: pinned activity revision is unavailable.`);
      if (node.activity) return resolveActivityBindings(node.bindings ?? {}, descriptor.inputSchema, {
        runInputSchema: normalize(run.workflow).runInputSchema,
        runInput: run.runInput ?? {},
        activityOutputs: run.activityOutputs ?? {},
      });
      return structuredClone(node.input ?? {});
    },
    async recordActivityIntent(context, { instance, nodeId, ref, input, intent, idempotencyKey, reservationId, legacy = false, legacyCommand }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.flow?.instance !== instance || run.flow?.nodeId !== nodeId || run.attempt?.instance !== instance)
        throw new Error('Workflow activity changed before its intent was persisted.');
      const workflow = normalize(run.workflow);
      const pinnedNode = workflow.nodes.find(node => node.id === nodeId);
      if (!['ready', 'running'].includes(run.attempt.status) || run.flow?.status === 'cancelled')
        throw new Error('Workflow activity cannot persist an intent after the run was stopped.');
      const expectedRef = this.getActivityRef(pinnedNode);
      if (!pinnedNode || activityDigest(expectedRef) !== activityDigest(ref))
        throw new Error('Workflow activity reference does not match its pinned node.');
      if (idempotencyKey !== `${run.id}:${instance}`) throw new Error('Workflow activity idempotency identity is invalid.');
      const resolvedInput = this.resolveActivityInput(run, pinnedNode);
      if (activityDigest(resolvedInput) !== activityDigest(input)) throw new Error('Workflow activity input does not match its pinned bindings.');
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error('Pinned activity revision is unavailable.');
      const descriptorDigest = activityDigest(descriptor);
      if (pinnedNode.activityDescriptorDigest && pinnedNode.activityDescriptorDigest !== descriptorDigest ||
          run.attempt.activityRef && run.attempt.activityDescriptorDigest && run.attempt.activityDescriptorDigest !== descriptorDigest)
        throw new Error('Pinned activity metadata changed; execution is blocked.');
      const checkedInput = legacy ? structuredClone(input) : validateActivityValue(input, descriptor.inputSchema);
      const intentValue = checkedActivityIntent(intent);
      const inputDigest = activityDigest(checkedInput);
      const intentDigest = activityDigest(intentValue);
      const effectKey = `${run.id}:${instance}:${nodeId}`;
      const existing = run.attempt.intent;
      if (existing && (run.attempt.inputDigest !== inputDigest || run.attempt.intentDigest !== intentDigest ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref) || run.attempt.idempotencyKey !== idempotencyKey))
        throw new Error('Workflow activity already has a different persisted intent.');
      if (existing && ['completed', 'failed', 'uncertain', 'waiting', 'cancelled'].includes(run.attempt.status))
        throw new Error('Workflow activity attempt is not eligible to persist another dispatch intent.');
      const evidence = state.workflowEffectLedger?.[effectKey];
      const reservation = reservationId && (run.activityReservations ?? []).find(value => value.id === reservationId);
      if (reservationId && run.attempt.reservationId !== reservationId)
        throw new Error('Workflow activity reservation identity changed.');
      if (run.attempt.reservationId && (!reservation || reservation.id !== run.attempt.reservationId || reservation.targetInstance !== instance ||
          reservation.targetNodeId !== nodeId || activityDigest(reservation.activityRef) !== activityDigest(ref) ||
          reservation.activityDescriptorDigest !== activityDigest(descriptor) ||
          reservation.inputDigest !== inputDigest || reservation.intentDigest !== intentDigest || reservation.idempotencyKey !== idempotencyKey))
        throw new Error('Workflow activity does not match its prepared approval reservation.');
      if (reservation && reservation.consumedAt && (!existing || run.attempt.reservationId !== reservation.id))
        throw new Error('Workflow activity reservation has already been consumed.');
      if (evidence && ((evidence.inputDigest && evidence.inputDigest !== inputDigest) ||
          (evidence.activityRef && activityDigest(evidence.activityRef) !== activityDigest(ref)) ||
          (evidence.intentDigest && evidence.intentDigest !== intentDigest) ||
          (evidence.idempotencyKey && evidence.idempotencyKey !== idempotencyKey)))
        throw new Error('Workflow effect identity does not match its persisted attempt.');
      run.attempt.activityRef = structuredClone(ref);
      run.attempt.activityDescriptorDigest = descriptorDigest;
      run.attempt.inputDigest = inputDigest;
      run.attempt.intentDigest = intentDigest;
      run.attempt.intent = intentValue;
      run.attempt.idempotencyKey = idempotencyKey;
      run.attempt.effectKey = effectKey;
      run.attempt.effect = descriptor.effect;
      if (legacy) run.attempt.legacyAction = true;
      if (reservation) reservation.consumedAt = new Date().toISOString();
      run.attempt.status = 'ready';
      run.attempt.dispatchStarted = false;
      state.workflowEffectLedger ??= {};
      if (descriptor.effect === 'durable-effect' && !evidence) state.workflowEffectLedger[effectKey] = {
        at: new Date().toISOString(), status: 'prepared', operation: legacyCommand?.operation ?? ref.id,
        sessionId: run.sessionId, projectId: run.projectId, organizationId: run.organizationId,
        ...((intentValue?.command || legacyCommand) ? { command: structuredClone(intentValue?.command ?? legacyCommand) } : {}), activityRef: structuredClone(ref),
        inputDigest, intentDigest: run.attempt.intentDigest, idempotencyKey,
      };
      else if (descriptor.effect === 'durable-effect' && evidence && ['prepared', 'pending'].includes(evidence.status)) {
        Object.assign(evidence, { intentDigest, idempotencyKey, status: 'prepared' });
        delete evidence.message;
        delete evidence.blockingReplyRequestId;
        delete evidence.blockingReplyStatus;
      }
      await save();
      return effectKey;
    },
    async markActivityDispatchStarted(context, { instance, nodeId, ref }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref) || !run.attempt.intent)
        throw new Error('Workflow activity changed before dispatch started.');
      if (run.attempt.status !== 'ready') throw new Error('Workflow activity is not ready to dispatch.');
      const eventCursor = eventJournal.cursor();
      run.eventEligibilityCursor = eventCursor;
      run.attempt.eventEligibilityCursor = eventCursor;
      run.attempt.dispatchStarted = true;
      run.attempt.status = 'running';
      const effect = state.workflowEffectLedger?.[run.attempt.effectKey];
      if (effect?.status === 'prepared') effect.status = 'pending';
      await save();
    },
    async markActivityResourceWait(context, { instance, nodeId, status = 'waiting' }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          !['ready', 'running'].includes(run.attempt.status) || run.attempt.dispatchStarted === true)
        throw new Error('Workflow activity cannot wait for resources after dispatch may have started.');
      if (!['ready', 'waiting'].includes(status)) throw new Error('Unsupported workflow resource-wait status.');
      run.attempt.status = status;
      await save();
    },
    async resetActivityBeforeDispatch(context, { instance, nodeId, ref, message }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref))
        throw new Error('Workflow activity cannot be reset after dispatch may have started.');
      run.attempt.dispatchStarted = false;
      run.attempt.status = 'failed';
      run.attempt.message = String(message ?? 'Activity was cancelled before dispatch.').slice(0, 1000);
      const effect = state.workflowEffectLedger?.[run.attempt.effectKey];
      if (effect?.status === 'pending') effect.status = 'prepared';
      await save();
    },
    async recordActivityResult(context, { instance, nodeId, ref, output, status = 'completed', message, evidence, expectedWaitingOutputDigest, reconciliation = false, dispatchReceipt = false }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId)
        throw new Error('Workflow activity changed before its result was recorded.');
      const descriptor = activityCatalog?.get(ref);
      if (!descriptor) throw new Error('Pinned activity revision is unavailable.');
      if (activityDigest(run.attempt.activityRef) !== activityDigest(ref)) throw new Error('Activity result revision does not match the persisted intent.');
      if (!['completed', 'waiting', 'failed', 'uncertain'].includes(status)) throw new Error('Unsupported activity result state.');
      if (run.attempt.outputDigest) {
        if (status !== 'completed') throw new Error('A completed activity receipt cannot change state.');
        const duplicate = validateActivityValue(output, descriptor.outputSchema);
        if (run.attempt.outputDigest !== activityDigest(duplicate))
          throw new Error('Activity result is immutable once recorded.');
        return;
      }
      const priorStatus = run.attempt.status;
      if (run.attempt.status === 'failed' && status !== 'failed' ||
          run.attempt.status === 'cancelled' && !(status === 'completed' && dispatchReceipt || status === 'waiting' && reconciliation) ||
          run.attempt.status === 'uncertain' && status !== 'uncertain' && !reconciliation && !dispatchReceipt)
        throw new Error('A terminal activity attempt cannot be changed by a late callback.');
      if (run.attempt.status === 'failed' && status === 'failed') {
        const safeMessage = message ? String(message).slice(0, 1000) : undefined;
        if (run.attempt.message !== safeMessage) throw new Error('A failed activity receipt is immutable once recorded.');
        return;
      }
      if (status === 'completed') {
        const checked = validateActivityValue(output, descriptor.outputSchema);
        const outputDigest = activityDigest(checked);
        run.attempt.outputDigest = outputDigest;
        run.attempt.output = checked;
        run.attempt.status = 'completed';
        run.activityOutputs ??= {};
        run.activityOutputs[nodeId] = { status: 'completed', activityRef: structuredClone(ref), schema: structuredClone(descriptor.outputSchema), value: checked, digest: outputDigest, instance };
        const key = run.attempt.effectKey;
        if (key && state.workflowEffectLedger?.[key]) Object.assign(state.workflowEffectLedger[key], { status: 'succeeded', result: structuredClone(checked), outputDigest });
      } else if (status === 'waiting') {
        const checked = validateActivityValue(output, descriptor.outputSchema);
        const outputDigest = activityDigest(checked);
        if (run.attempt.waitingOutputDigest && (expectedWaitingOutputDigest !== run.attempt.waitingOutputDigest ||
            run.attempt.waitingOutputDigest !== activityDigest(run.attempt.waitingOutput)))
          throw new Error('Waiting activity observation changed before confirmation.');
        if (!run.attempt.waitingOutputDigest && expectedWaitingOutputDigest !== undefined)
          throw new Error('Waiting activity observation is no longer current.');
        if (run.attempt.waitingOutputDigest && run.attempt.waitingOutputDigest !== outputDigest) {
          run.attempt.waitingHistory ??= [];
          if (run.attempt.waitingHistory.length < 8) run.attempt.waitingHistory.push({ digest: run.attempt.waitingOutputDigest, at: new Date().toISOString() });
        }
        run.attempt.waitingOutput = checked;
        run.attempt.waitingOutputDigest = outputDigest;
        if (evidence?.workPreDispatch === true) {
          run.attempt.dispatchStarted = false;
          run.attempt.waitingEvidence = { workPreDispatch: true,
            ...(typeof evidence.blockingReplyRequestId === 'string' ? { blockingReplyRequestId: evidence.blockingReplyRequestId.slice(0, 300) } : {}),
            ...(typeof evidence.blockingReplyStatus === 'string' ? { blockingReplyStatus: evidence.blockingReplyStatus.slice(0, 80) } : {}) };
        }
        run.attempt.status = priorStatus === 'cancelled' ? 'cancelled' : 'waiting';
        const key = run.attempt.effectKey;
        if (key && state.workflowEffectLedger?.[key]) {
          state.workflowEffectLedger[key].status = evidence?.workPreDispatch === true ? 'blocked' : 'pending';
          state.workflowEffectLedger[key].result = structuredClone(checked);
          state.workflowEffectLedger[key].outputDigest = outputDigest;
          if (evidence && typeof evidence === 'object') {
            for (const field of ['blockingReplyRequestId', 'blockingReplyStatus'])
              if (typeof evidence[field] === 'string') state.workflowEffectLedger[key][field] = evidence[field].slice(0, 300);
          }
        }
      } else {
        run.attempt.status = status;
        if (message) run.attempt.message = String(message).slice(0, 1000);
        const key = run.attempt.effectKey;
        if (status === 'failed' && evidence?.workPreDispatch === true && output !== undefined) {
          const checked = validateActivityValue(output, descriptor.outputSchema);
          run.attempt.dispatchStarted = false;
          run.attempt.waitingOutput = checked;
          run.attempt.waitingOutputDigest = activityDigest(checked);
          run.attempt.waitingEvidence = { workPreDispatch: true,
            ...(typeof evidence.blockingReplyRequestId === 'string' ? { blockingReplyRequestId: evidence.blockingReplyRequestId.slice(0, 300) } : {}),
            ...(typeof evidence.blockingReplyStatus === 'string' ? { blockingReplyStatus: evidence.blockingReplyStatus.slice(0, 80) } : {}) };
        }
        if (key && state.workflowEffectLedger?.[key]) {
          state.workflowEffectLedger[key].status = status === 'uncertain' ? 'uncertain' : status === 'failed' ? 'blocked' : 'pending';
          if (run.attempt.waitingEvidence?.workPreDispatch && key)
            Object.assign(state.workflowEffectLedger[key], run.attempt.waitingEvidence);
          if (run.attempt.waitingOutputDigest) {
            state.workflowEffectLedger[key].result = structuredClone(run.attempt.waitingOutput);
            state.workflowEffectLedger[key].outputDigest = run.attempt.waitingOutputDigest;
          }
          if (message) state.workflowEffectLedger[key].message = String(message).slice(0, 1000);
        }
      }
      await save();
    },
    async reconcileActivityAttempt(context, { instance, nodeId, ref, state: resolution, output, message }) {
      const run = context?.independentRun ? context : state.workflowRuns?.[context?.workflowRunId];
      if (!run || state.workflowRuns?.[run.id] !== run || run.attempt?.instance !== instance || run.attempt?.nodeId !== nodeId ||
          activityDigest(run.attempt.activityRef) !== activityDigest(ref))
        throw new Error('Workflow activity changed before reconciliation was recorded.');
      if (!['applied', 'not_applied', 'unknown', 'waiting'].includes(resolution)) throw new Error('Unsupported adapter reconciliation state.');
      const key = run.attempt.effectKey;
      if (run.attempt.outputDigest && resolution !== 'applied') throw new Error('A completed activity receipt cannot be reconciled away.');
      if (run.attempt.status === 'failed' && run.attempt.dispatchStarted === false && resolution !== 'not_applied')
        throw new Error('A proven not-dispatched failure cannot be reconciled as applied.');
      if (resolution === 'applied') {
        await this.recordActivityResult(context, { instance, nodeId, ref, output, status: 'completed', reconciliation: true });
      } else if (resolution === 'waiting') {
        await this.recordActivityResult(context, { instance, nodeId, ref, output, status: 'waiting', message, reconciliation: true,
          ...(run.attempt.waitingOutputDigest ? { expectedWaitingOutputDigest: run.attempt.waitingOutputDigest } : {}) });
      } else {
        if (run.attempt.outputDigest) throw new Error('A completed activity receipt cannot be reconciled away.');
        run.attempt.status = resolution === 'not_applied' ? 'ready' : 'uncertain';
        if (resolution === 'not_applied') {
          run.attempt.dispatchStarted = false;
          delete run.attempt.waitingOutput;
          delete run.attempt.waitingOutputDigest;
          delete run.attempt.waitingHistory;
        }
        if (message) run.attempt.message = String(message).slice(0, 1000);
        const evidence = key && state.workflowEffectLedger?.[key];
        if (evidence) {
          evidence.status = resolution === 'not_applied' ? 'prepared' : 'uncertain';
          evidence.reconciledAt = new Date().toISOString();
          evidence.resolution = resolution;
          if (message) evidence.message = String(message).slice(0, 1000);
        }
        await save();
      }
    },
    readRun(id) {
      const run = state.workflowRuns?.[id];
      if (!run) return null;
      return structuredClone(publicRun(run));
    },
    bindSessionRun(session, flow, migrationPrincipal = defaultPrincipal) {
      if (session.independentRun) return;
      state.workflowRuns ??= {};
      const previous = session.workflowRunId && state.workflowRuns[session.workflowRunId];
      if (previous && previous.id !== flow.id && previous.sessionId === session.id) {
        previous.archivedAt ??= new Date().toISOString();
        delete session.workflowRunId;
      }
      const id = flow.id;
      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      let owner = state.workflowRuns[id];
      if (owner && owner.sessionId !== session.id) throw new Error('Workflow run identity is already bound.');
      if (!owner) owner = state.workflowRuns[id] = {
        id, independentRun: false, sessionId: session.id,
        projectId: session.projectId, organizationId: project?.organizationId ?? 'personal',
        principal: session.executionPrincipal ? structuredClone(session.executionPrincipal) : structuredClone(migrationPrincipal),
        ...(session.activeTicketId !== undefined ? { activeTicketId: session.activeTicketId } : {}),
        workflow: structuredClone(session.workflow), flow,
      };
      if (!owner.principal) throw new Error('Workflow run has no resolvable execution principal.');
      else if (flow) {
        if (session.activeTicketId !== undefined) {
          if (owner.activeTicketId !== undefined && String(owner.activeTicketId) !== String(session.activeTicketId))
            throw new Error('Session workflow run ticket identity changed.');
          owner.activeTicketId ??= session.activeTicketId;
        }
        owner.workflow = structuredClone(session.workflow);
        owner.flow = flow;
      }
      session.workflowRunId = id;
      installSessionFlowProjection(session, state);
    },
    archiveSessionRun(session, details = {}) {
      const id = session.workflowRunId;
      const owner = id && state.workflowRuns?.[id];
      if (owner && owner.sessionId === session.id) {
        if (details.ticketId) owner.ticketId = details.ticketId;
        owner.archivedAt ??= new Date().toISOString();
        delete session.workflowRunId;
        installSessionFlowProjection(session, state);
        return owner.id;
      }
      return null;
    },
    recoverRuns() {
      for (const run of Object.values(state.workflowRuns ?? {})) {
        // Actor identity is audit evidence; a persisted lease is not authority
        // after daemon restart. Reclaim must be explicit, matching sessions.
        run.lease = null;
        if (run.attempt?.instance && run.attempt?.nodeId) {
          const key = `${run.id}:${run.attempt.instance}:${run.attempt.nodeId}`;
          const effect = state.workflowEffectLedger?.[key];
          if (effect) {
            run.attempt.effectKey ??= key;
            if (!run.attempt.activityRef && effect.result && run.attempt.effectResult === undefined)
              run.attempt.effectResult = structuredClone(effect.result);
          }
        }
        if (run.independentRun && ['reserved', 'running'].includes(run.assignment?.state)) {
          run.assignment.state = 'uncertain';
          run.assignment.message = 'Daemon restarted while this workflow run held runner resources. Inspect the original runner before reuse.';
        }
        if (run.independentRun && run.flow?.status === 'running' && run.attempt?.status === 'completed' && run.attempt.outputDigest) {
          // The immutable receipt survived, but its graph transition did not.
          // Explicit continue re-enters the cached-output path without dispatch.
          run.flow.resumeStatus = 'ready';
          run.flow.status = 'interrupted';
          run.status = 'interrupted';
        }
        if (run.independentRun && run.attempt?.status === 'running' && run.flow) {
          const safelyRecomputable = ['pure', 'observation'].includes(run.attempt.effect);
          const mayHaveDispatched = run.attempt.dispatchStarted === true || run.attempt.dispatchStarted === undefined;
          run.attempt.status = !safelyRecomputable && mayHaveDispatched ? 'uncertain' : 'ready';
          run.flow.resumeStatus = run.flow.status;
          run.flow.status = 'interrupted';
          run.status = 'interrupted';
        }
      }
    },
    attachAgentSession(run, session) {
      if (!run?.independentRun || state.workflowRuns?.[run.id] !== run) throw new Error('Workflow run is not available.');
      if (run.sessionId && run.sessionId !== session.id) throw new Error('Workflow run already has an agent session.');
      run.sessionId = session.id;
      run.agentSessionId = session.id;
      session.workflowRunId = run.id;
      session.workflow = normalize(run.workflow);
      session.projectId = run.projectId;
      session.activeTicketId = run.activeTicketId;
      session.executionPrincipal = structuredClone(run.principal);
      run.flow.model ??= session.model;
      if (!run.flow.aliases) run.flow.aliases = {};
      if (!run.flow.bindings) run.flow.bindings = {};
      if (session.currentAgentSessionId) {
        run.flow.aliases.main ??= session.currentAgentSessionId;
        run.flow.lastAgent ??= session.currentAgentSessionId;
      }
      installSessionFlowProjection(session, state);
    },
    adoptSessionRun(session, migrationPrincipal = defaultPrincipal) {
      for (const old of session.pastRuns ?? []) {
        if (!old?.id || state.workflowRuns[old.id]) continue;
        const project = state.projects.find((candidate) => candidate.id === session.projectId);
        state.workflowRuns[old.id] = {
          id: old.id, independentRun: false, sessionId: session.id,
          projectId: session.projectId, organizationId: project?.organizationId ?? 'personal',
          principal: session.executionPrincipal ? structuredClone(session.executionPrincipal) : structuredClone(migrationPrincipal),
          workflow: structuredClone(old.workflow ?? state.workflows.filter((definition) => definition.id === (old.workflowId ?? session.workflow?.id) && definition.version === (old.workflowVersion ?? session.workflow?.version)).at(-1) ?? null), flow: structuredClone(old),
          ...(old.ticketId ? { ticketId: old.ticketId } : {}), archivedAt: old.endedAt ?? old.startedAt ?? new Date().toISOString(),
        };
      }
      delete session.pastRuns;
      if (session.workflowRunId && state.workflowRuns?.[session.workflowRunId]?.sessionId === session.id) {
        installSessionFlowProjection(session, state);
        return;
      }
      if (!session.workflow || !session.flow) { installSessionHistoryProjection(session, state); return; }
      const flow = session.flow;
      if (session.workflowRunId && state.workflowRuns?.[session.workflowRunId]?.sessionId === session.id) {
        const owner = state.workflowRuns[session.workflowRunId];
        if (owner.flow) session.flow = owner.flow;
        session.workflowRunId = owner.id;
        installSessionFlowProjection(session, state);
        return;
      }
      this.bindSessionRun(session, flow, migrationPrincipal);
      installSessionHistoryProjection(session, state);
    },
  };
}

function publicRun(run) {
  const safeAttempt = attempt => attempt && ({
    instance: attempt.instance, nodeId: attempt.nodeId, status: attempt.status,
    startedAt: attempt.startedAt, completedAt: attempt.completedAt, outcome: attempt.outcome,
    ...(attempt.activityRef ? { activityRef: structuredClone(attempt.activityRef) } : {}),
    ...(attempt.effect ? { effect: attempt.effect } : {}),
    ...(attempt.idempotencyKey ? { idempotencyKey: attempt.idempotencyKey } : {}),
    ...(attempt.inputDigest ? { inputDigest: attempt.inputDigest } : {}),
    ...(attempt.outputDigest ? { outputDigest: attempt.outputDigest } : {}),
    ...(attempt.message ? { message: attempt.message } : {}),
    ...(attempt.effectKey ? { effectKey: attempt.effectKey } : {}),
    ...((attempt.legacyAction || !attempt.activityRef) && attempt.effectResult ? { effectResult: structuredClone(attempt.effectResult) } : {}),
  });
  return {
    id: run.id, organizationId: run.organizationId, projectId: run.projectId,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}), independent: Boolean(run.independentRun),
    workflowId: run.flow?.workflowId, workflowVersion: run.flow?.workflowVersion,
    status: run.flow?.status ?? run.status, nodeId: run.flow?.nodeId,
    instance: run.flow?.instance, activeTicketId: run.activeTicketId ?? run.ticketId,
    startedAt: run.flow?.startedAt ?? run.startedAt, updatedAt: run.updatedAt ?? run.flow?.history?.at(-1)?.at ?? run.flow?.startedAt ?? run.startedAt,
    ...(run.runInputDigest ? { runInputDigest: run.runInputDigest } : {}),
    ...(run.resultDigest ? { resultDigest: run.resultDigest } : {}),
    ...(() => {
      const reservation = [...(run.activityReservations ?? [])].reverse().find(value =>
        value.gateNodeId === run.flow?.nodeId && value.gateInstance === run.flow?.instance && !value.consumedAt && !value.invalidatedAt);
      return reservation ? { activityReservations: [{ id: reservation.id, gateNodeId: reservation.gateNodeId,
        gateInstance: reservation.gateInstance, targetNodeId: reservation.targetNodeId, targetInstance: reservation.targetInstance,
        activityRef: structuredClone(reservation.activityRef), inputDigest: reservation.inputDigest, intentDigest: reservation.intentDigest,
        digest: reservation.digest }] } : {};
    })(),
    attempt: safeAttempt(run.attempt), activityAttempts: [...(run.activityAttempts ?? []).slice(-50).map(safeAttempt), ...(run.attempt ? [safeAttempt(run.attempt)] : [])],
    history: (run.flow?.history ?? []).slice(-200).map(({ nodeId, instance, outcome, at, to, submission }) => ({ nodeId, instance, outcome, at, to, ...(typeof submission?.summary === 'string' ? { summary: submission.summary.slice(0, 500) } : {}) })),
    historyTotal: (run.flow?.history ?? []).length,
    historyTruncated: (run.flow?.history ?? []).length > 200,
    lease: run.lease ? { id: run.lease.id, client: run.lease.client, label: run.lease.label, expiresAt: run.lease.expiresAt } : null,
    decisions: (run.decisions ?? []).slice(-50),
    decisionsTotal: (run.decisions ?? []).length,
    decisionsTruncated: (run.decisions ?? []).length > 50,
  };
}

function installSessionFlowProjection(session, state) {
  if (Object.getOwnPropertyDescriptor(session, 'flow')?.get) return;
  delete session.flow;
  Object.defineProperty(session, 'flow', {
    configurable: true,
    enumerable: false,
    get() { return state.workflowRuns?.[this.workflowRunId]?.flow ?? null; },
    set(value) {
      if (value == null) { delete this.workflowRunId; return; }
      const owner = state.workflowRuns?.[this.workflowRunId]; if (owner) owner.flow = value;
    },
  });
  installSessionHistoryProjection(session, state);
}

function installSessionHistoryProjection(session, state) {
  if (Object.getOwnPropertyDescriptor(session, 'pastRuns')?.get) return;
  delete session.pastRuns;
  Object.defineProperty(session, 'pastRuns', {
    configurable: true,
    enumerable: false,
    get() { return Object.values(state.workflowRuns ?? {}).filter((run) => run.sessionId === this.id && run.id !== this.workflowRunId).sort((a, b) => String(a.flow?.startedAt ?? '').localeCompare(String(b.flow?.startedAt ?? ''))).map((run) => ({ ...structuredClone(run.flow), workflow: structuredClone(run.workflow), ...(run.ticketId ? { ticketId: run.ticketId } : {}) })); },
  });
}
