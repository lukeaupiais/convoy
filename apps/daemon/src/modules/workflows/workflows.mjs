import { submissionContract, validateSubmissionContract } from './submission-contract.mjs';
import { normalizeRuntimeSelection } from '../execution/index.mjs';
import { normalizeSubmissionRequirements, validateSubmissionRequirements } from './submission-requirements.mjs';
import { activityDigest, validateActivitySchema } from './activity-data.mjs';
import { randomUUID } from 'node:crypto';

const required = (value, label, limit = 6000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} is required (up to ${limit} characters).`);
  return value.trim();
};
const kinds = new Set(['agent', 'human', 'check', 'action', 'branch', 'wait']);
const sessionModes = new Set(['continue', 'new', 'reuse']);
const safeId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const safeFormFieldId = value => safeId(value) && !['__proto__', 'prototype', 'constructor'].includes(value);

function normalizeHumanTask(node, original) {
  delete node.legacyHumanTask;
  if (node.kind !== 'human') {
    if (original.humanTask !== undefined || original.legacyHumanTask !== undefined)
      throw new Error(`${node.name}: human-task configuration requires a human node.`);
    return;
  }
  const configured = original.humanTask;
  const legacyMarker = original.legacyHumanTask === true;
  if (original.legacyHumanTask !== undefined && !legacyMarker)
    throw new Error(`${node.name}: legacy human-task compatibility marker is invalid.`);
  if (legacyMarker) {
    const outcomes = configured?.outcomes;
    const compatibleLegacy = configured && typeof configured === 'object' && !Array.isArray(configured) &&
      Object.keys(configured).every(key => ['outcomes'].includes(key)) &&
      Object.keys(configured).length === 1 && Array.isArray(outcomes) && outcomes.length === 2 &&
      outcomes[0]?.id === 'approved' && outcomes[0]?.effect === 'approve_activity' &&
      outcomes[1]?.id === 'changes_requested' && outcomes[1]?.effect === undefined &&
      Object.keys(outcomes[0]).every(key => ['id', 'label', 'effect'].includes(key)) &&
      Object.keys(outcomes[1]).every(key => ['id', 'label'].includes(key));
    if (!compatibleLegacy) throw new Error(`${node.name}: legacy compatibility cannot be combined with configured human-task policy.`);
  }
  if (configured === undefined || legacyMarker) {
    node.legacyHumanTask = true;
    node.humanTask = { outcomes: [
      { id: 'approved', label: original.decisionLabels?.approved ?? 'Approved', effect: 'approve_activity' },
      { id: 'changes_requested', label: original.decisionLabels?.changes_requested ?? 'Request changes' },
    ] };
    return;
  }
  if (!configured || typeof configured !== 'object' || Array.isArray(configured) || !Array.isArray(configured.outcomes) ||
      configured.outcomes.length < 2 || configured.outcomes.length > 8)
    throw new Error(`${node.name}: configure between two and eight human outcomes.`);
  const outcomeIds = new Set();
  const outcomes = configured.outcomes.map(outcome => {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || !safeId(outcome.id) || outcomeIds.has(outcome.id) ||
        typeof outcome.label !== 'string' || !outcome.label.trim() || outcome.label.length > 80 || /[\u0000-\u001f\u007f]/.test(outcome.label) ||
        outcome.effect !== undefined && outcome.effect !== 'approve_activity')
      throw new Error(`${node.name}: human outcomes need unique safe IDs, plain labels, and a supported effect policy.`);
    outcomeIds.add(outcome.id);
    return { id: outcome.id, label: outcome.label.trim(), ...(outcome.effect ? { effect: outcome.effect } : {}) };
  });
  let form;
  if (configured.form !== undefined) {
    if (!configured.form || typeof configured.form !== 'object' || !Array.isArray(configured.form.fields) || configured.form.fields.length > 32)
      throw new Error(`${node.name}: human form must contain at most 32 fields.`);
    const fieldIds = new Set();
    form = { fields: configured.form.fields.map(field => {
      if (!field || typeof field !== 'object' || Array.isArray(field) || !safeFormFieldId(field.id) || fieldIds.has(field.id) ||
          typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100 ||
          !['text', 'number', 'boolean', 'choice', 'date'].includes(field.type) || typeof field.required !== 'undefined' && typeof field.required !== 'boolean')
        throw new Error(`${node.name}: human form fields require unique safe IDs, labels and supported types.`);
      fieldIds.add(field.id);
      const result = { id: field.id, label: field.label.trim(), type: field.type, ...(field.required ? { required: true } : {}) };
      if (field.type === 'text') {
        const minLength = field.minLength ?? 0, maxLength = field.maxLength ?? 2000;
        if (!Number.isInteger(minLength) || minLength < 0 || !Number.isInteger(maxLength) || maxLength < minLength || maxLength > 4000)
          throw new Error(`${node.name}: invalid text bounds for ${field.id}.`);
        result.minLength = minLength; result.maxLength = maxLength;
      } else if (field.type === 'number') {
        if (field.minimum !== undefined && !Number.isFinite(field.minimum) || field.maximum !== undefined && !Number.isFinite(field.maximum) ||
            field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum)
          throw new Error(`${node.name}: invalid numeric bounds for ${field.id}.`);
        if (field.minimum !== undefined) result.minimum = field.minimum;
        if (field.maximum !== undefined) result.maximum = field.maximum;
      } else if (field.type === 'choice') {
        if (!Array.isArray(field.options) || field.options.length < 1 || field.options.length > 32) throw new Error(`${node.name}: choice ${field.id} needs one to 32 options.`);
        const seen = new Set(); result.options = field.options.map(option => {
          if (!option || typeof option.value !== 'string' || !option.value || option.value.length > 120 || seen.has(option.value) ||
              typeof option.label !== 'string' || !option.label.trim() || option.label.length > 100)
            throw new Error(`${node.name}: invalid choice option for ${field.id}.`);
          seen.add(option.value); return { value: option.value, label: option.label.trim() };
        });
      } else if (field.options !== undefined || field.minLength !== undefined || field.maxLength !== undefined || field.minimum !== undefined || field.maximum !== undefined)
        throw new Error(`${node.name}: field ${field.id} has bounds that do not match its type.`);
      return result;
    }) };
  }
  let reviewerPolicy;
  if (configured.reviewerPolicy !== undefined) {
    const policy = configured.reviewerPolicy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
        policy.permission !== undefined && !['project.execute', 'project.write'].includes(policy.permission) ||
        policy.userIds !== undefined && (!Array.isArray(policy.userIds) || !policy.userIds.length || policy.userIds.length > 100 || policy.userIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 160)) ||
        policy.permission === undefined && policy.userIds === undefined)
      throw new Error(`${node.name}: reviewer policy must select project permission or user IDs.`);
    reviewerPolicy = { ...(policy.permission ? { permission: policy.permission } : {}), ...(policy.userIds ? { userIds: [...new Set(policy.userIds.map(id => id.trim()))] } : {}) };
  }
  if (configured.dueAfterSeconds !== undefined && (!Number.isInteger(configured.dueAfterSeconds) || configured.dueAfterSeconds < 60 || configured.dueAfterSeconds > 31_536_000))
    throw new Error(`${node.name}: deadline must be between one minute and one year.`);
  node.humanTask = { outcomes, ...(form ? { form } : {}), ...(reviewerPolicy ? { reviewerPolicy } : {}), ...(configured.dueAfterSeconds !== undefined ? { dueAfterSeconds: configured.dueAfterSeconds } : {}) };
  node.decisionLabels = Object.fromEntries(outcomes.filter(({ id }) => ['approved', 'changes_requested'].includes(id)).map(({ id, label }) => [id, label]));
  if (!Object.keys(node.decisionLabels).length) delete node.decisionLabels;
}

function normalizeNode(original, index, ids, sessions, seenNewSessions) {
  if (!original || typeof original !== 'object') throw new Error(`Step ${index + 1} is required.`);
  const node = { ...original, id: original.id || `step-${index + 1}`, name: required(original.name, `Step ${index + 1} name`, 120) };
  if (!safeId(node.id) || ids.has(node.id)) throw new Error('Every workflow node needs a unique identifier.');
  if (!kinds.has(node.kind)) throw new Error(`${node.name}: choose agent, human, check, action, branch or wait.`);
  if (node.kind === 'wait') {
    const waitFor = node.waitFor;
    if (!waitFor || typeof waitFor.event !== 'string' || !/^[A-Za-z][\w.-]{1,100}$/.test(waitFor.event) ||
        waitFor.ticketSource !== undefined && !['active_ticket', 'related_ticket'].includes(waitFor.ticketSource) ||
        waitFor.relationKind !== undefined && !safeId(waitFor.relationKind) ||
        waitFor.status !== undefined && (typeof waitFor.status !== 'string' || !waitFor.status.trim() || waitFor.status.length > 80) ||
        waitFor.scope !== undefined && !['organization', 'project', 'resource'].includes(waitFor.scope) ||
        waitFor.resourceRef !== undefined && (!waitFor.resourceRef || typeof waitFor.resourceRef !== 'object' || Array.isArray(waitFor.resourceRef) ||
          Object.getPrototypeOf(waitFor.resourceRef) !== Object.prototype || Object.keys(waitFor.resourceRef).length !== 2 ||
          Object.keys(waitFor.resourceRef).some(key => !['kind', 'id'].includes(key)) ||
          typeof waitFor.resourceRef.kind !== 'string' || !waitFor.resourceRef.kind.trim() || waitFor.resourceRef.kind.length > 80 || /[\u0000-\u001f\u007f]/.test(waitFor.resourceRef.kind) ||
          typeof waitFor.resourceRef.id !== 'string' || !waitFor.resourceRef.id.trim() || waitFor.resourceRef.id.length > 160 || /[\u0000-\u001f\u007f]/.test(waitFor.resourceRef.id)) ||
        waitFor.eventRevision !== undefined && (!Number.isInteger(waitFor.eventRevision) || waitFor.eventRevision < 1) ||
        waitFor.timeoutSeconds !== undefined && (!Number.isInteger(waitFor.timeoutSeconds) || waitFor.timeoutSeconds < 1 || waitFor.timeoutSeconds > 31_536_000) ||
        waitFor.timeoutOutcome !== undefined && !safeId(waitFor.timeoutOutcome) ||
        waitFor.correlation !== undefined && (!waitFor.correlation || typeof waitFor.correlation.key !== 'string' ||
          !/^[A-Za-z][\w.-]{0,100}$/.test(waitFor.correlation.key) || typeof waitFor.correlation.from !== 'string' ||
          !/^(activeTicketId|runInput\.[A-Za-z][\w.-]{0,100}|output\.[\w-]{1,80}\.[A-Za-z][\w.-]{0,100})$/.test(waitFor.correlation.from)) ||
        waitFor.if !== undefined && (!Array.isArray(waitFor.if) || waitFor.if.length > 20 || waitFor.if.some(condition =>
          !condition || typeof condition.path !== 'string' || !/^[A-Za-z][\w.-]{0,100}$/.test(condition.path) ||
          !['exists', 'equals', 'notEquals', 'greaterThan', 'lessThan'].includes(condition.operator) ||
          condition.operator !== 'exists' && !['string', 'number', 'boolean'].includes(typeof condition.value))))
      throw new Error(`${node.name}: configure a registered event wait with bounded correlation, predicates and timeout.`);
    node.waitFor = { event: waitFor.event, ...(waitFor.ticketSource ? { ticketSource: waitFor.ticketSource } : {}),
      ...(waitFor.eventRevision ? { eventRevision: waitFor.eventRevision } : {}),
      ...(waitFor.scope ? { scope: waitFor.scope } : {}),
      ...(waitFor.resourceRef ? { resourceRef: structuredClone(waitFor.resourceRef) } : {}),
      ...(waitFor.relationKind ? { relationKind: waitFor.relationKind } : {}), ...(waitFor.status ? { status: waitFor.status } : {}),
      ...(waitFor.correlation ? { correlation: structuredClone(waitFor.correlation) } : {}),
      ...(waitFor.if ? { if: structuredClone(waitFor.if) } : {}),
      ...(waitFor.timeoutSeconds ? { timeoutSeconds: waitFor.timeoutSeconds } : {}),
      ...(waitFor.timeoutOutcome ? { timeoutOutcome: waitFor.timeoutOutcome } : {}) };
  }
  if (node.kind === 'action') {
    // Actions are declared by their exact operation/input, not an implicit
    // agent objective. Preserve configured legacy prompt strings as metadata.
    if (original.prompt !== undefined && original.prompt !== '')
      node.prompt = required(original.prompt, `Objective for ${node.name}`);
    else delete node.prompt;
  } else if (node.kind !== 'branch') node.prompt = required(original.prompt ?? `${node.name} completed by the workflow.`, `Objective for ${node.name}`);
  else if (node.prompt !== undefined) {
    // Branch nodes are evaluated data-only and do not need an objective. The
    // graph editor may serialize that empty field; normalize it away.
    if (node.prompt === '') delete node.prompt;
    else node.prompt = required(node.prompt, `Objective for ${node.name}`);
  }
  node.advance = original.advance ?? 'automatic';
  if (!['automatic', 'manual'].includes(node.advance)) throw new Error(`${node.name}: choose automatic or manual advancement.`);
  if (node.decisionLabels !== undefined) {
    const labels = node.decisionLabels;
    const supported = ['approved', 'changes_requested'];
    if (node.kind !== 'human' || !labels || typeof labels !== 'object' || Array.isArray(labels) ||
        Object.keys(labels).some(outcome => !supported.includes(outcome)))
      throw new Error(`${node.name}: decision labels must use supported human outcomes.`);
    for (const outcome of supported) if (Object.hasOwn(labels, outcome) &&
        (typeof labels[outcome] !== 'string' || !labels[outcome].trim() || labels[outcome].length > 80 || /[\u0000-\u001f\u007f]/.test(labels[outcome])))
      throw new Error(`${node.name}: decision labels must be plain text up to 80 characters.`);
    node.decisionLabels = Object.fromEntries(supported.filter(outcome => Object.hasOwn(labels, outcome)).map(outcome => [outcome, labels[outcome].trim()]));
    if (!Object.keys(node.decisionLabels).length) delete node.decisionLabels;
  }
  normalizeHumanTask(node, original);
  delete node.phase;
  if (node.artifact) {
    required(node.artifact.path, 'Artifact path', 200);
    if (/^[\/\\]|\0/.test(node.artifact.path) || node.artifact.path.split(/[\/\\]/).some(x => ['..', '.git', '.convoy', '.codex', '.ssh'].includes(x) || x.startsWith('.env'))) throw new Error(`${node.name}: use a safe relative artifact path.`);
    if (!Array.isArray(node.artifact.headings) || node.artifact.headings.length > 20) throw new Error(`${node.name}: required sections must be a list.`);
    node.artifact.headings.forEach(h => required(h, 'Section heading', 120));
  }
  if (node.kind === 'check' || node.requiresCheck) node.checkCommand = required(node.checkCommand, `${node.name}: exact check command`, 4000);
  if (node.kind === 'action') {
    const operation = node.operation;
    if (node.activity !== undefined) {
      const ref = node.activity;
      if (operation !== undefined || !ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).some(key => !['id', 'revision'].includes(key)) ||
          typeof ref.id !== 'string' || !/^[a-z][\w.-]{1,100}$/.test(ref.id) || !Number.isInteger(ref.revision) || ref.revision < 1)
        throw new Error(`${node.name}: choose one registered activity revision.`);
      if (node.input !== undefined || node.args !== undefined || node.payload !== undefined || node.boardAction !== undefined || node.action !== undefined)
        throw new Error(`${node.name}: registered activities use typed bindings.`);
      if (node.bindings !== undefined && (!node.bindings || typeof node.bindings !== 'object' || Array.isArray(node.bindings) || Object.keys(node.bindings).length > 128))
        throw new Error(`${node.name}: activity bindings must be a bounded object.`);
    } else {
      if (!['inspect_changes', 'create_ticket', 'create_related_ticket', 'update_ticket', 'move_ticket', 'set_external_status', 'send_external_reply'].includes(operation)) throw new Error(`${node.name}: unsupported workflow action.`);
      node.operation = operation;
      if (node.args !== undefined || node.payload !== undefined || node.boardAction !== undefined || node.action !== undefined) throw new Error('Use canonical action input.');
      const input = node.input;
      if (operation !== 'inspect_changes' && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error(`${node.name}: board action input is required.`);
      if (operation === 'create_ticket' && (typeof input.title !== 'string' || !input.title.trim() || input.projectId !== undefined && (typeof input.projectId !== 'string' || !input.projectId.trim()))) throw new Error(`${node.name}: create_ticket needs a title and an optional projectId.`);
      if (operation === 'create_related_ticket' && (typeof input.title !== 'string' || !input.title.trim() || input.kind !== undefined && !safeId(input.kind))) throw new Error(`${node.name}: create_related_ticket needs a title and an optional safe relation kind.`);
      if (operation === 'update_ticket' && input.ticketSource !== 'active_ticket' && input.ticketSource !== 'last_created' && input.ticketId === undefined && input.taskId === undefined) throw new Error(`${node.name}: update_ticket needs a ticket target.`);
      if (operation === 'move_ticket' && (typeof input.boardId !== 'string' || !input.placement?.columnId || input.columnId !== undefined)) throw new Error(`${node.name}: move_ticket needs boardId and columnId.`);
      if (operation === 'set_external_status' && (typeof input.connectionId !== 'string' || !input.connectionId || typeof input.status !== 'string' || !input.status || input.evidenceReply !== undefined && input.evidenceReply !== 'latest_delivered'))
        throw new Error(`${node.name}: set_external_status needs a connection, source status, and optional latest_delivered reply evidence.`);
      if (operation === 'send_external_reply' && (typeof input.connectionId !== 'string' || !input.connectionId || !safeId(input.sourceNodeId) || typeof input.field !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(input.field) || ['__proto__', 'constructor', 'prototype'].includes(input.field) || Object.keys(input).some(key => !['connectionId', 'sourceNodeId', 'field'].includes(key))))
        throw new Error(`${node.name}: send_external_reply needs a connection, sourceNodeId and submitted detail field.`);
    }
  }
  if (node.kind === 'branch') {
    const condition = node.condition;
    if (condition === undefined) throw new Error(`${node.name}: branch condition is required.`);
    if (condition !== undefined) {
      if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error(`${node.name}: branch condition must be an object.`);
      const source = condition.source ?? 'ticket';
      if (!['ticket', 'submission', 'actionResult', 'context'].includes(source)) throw new Error(`${node.name}: unsupported branch condition source.`);
      const field = condition.field ?? condition.path;
      if (typeof field !== 'string' || !/^[\w.-]{1,120}$/.test(field)) throw new Error(`${node.name}: branch condition field is invalid.`);
      const operators = ['equals', 'notEquals', 'exists'].filter(key => Object.hasOwn(condition, key));
      if (operators.length !== 1) throw new Error(`${node.name}: branch condition needs exactly one of equals, notEquals or exists.`);
      const trueOutcome = condition.trueOutcome ?? condition.outcomes?.true ?? 'true'; const falseOutcome = condition.falseOutcome ?? condition.outcomes?.false ?? 'false';
      if (![trueOutcome, falseOutcome].every(x => typeof x === 'string' && /^[\w.*:-]{1,80}$/.test(x))) throw new Error(`${node.name}: branch outcomes are invalid.`);
      node.condition = { source, field, ...(Object.hasOwn(condition, 'equals') ? { equals: condition.equals } : {}), ...(Object.hasOwn(condition, 'notEquals') ? { notEquals: condition.notEquals } : {}), ...(Object.hasOwn(condition, 'exists') ? { exists: Boolean(condition.exists) } : {}), trueOutcome, falseOutcome };
    }
  }
  if (node.kind === 'agent') {
    node.session = { mode: 'continue', ...(node.session ?? {}) };
    if (!sessionModes.has(node.session.mode)) throw new Error(`${node.name}: invalid session rule.`);
    if (node.session.mode === 'new') {
      const name = required(node.session.name, `${node.name}: new session name`, 60);
      if (seenNewSessions.has(name) || name === 'main') throw new Error(`${node.name}: session name ${name} is already defined.`);
      seenNewSessions.add(name); sessions.add(name); node.session.name = name;
    }
    if (node.session.mode === 'reuse') {
      node.session.target = required(node.session.target, `${node.name}: reused session name`, 60);
      if (!sessions.has(node.session.target)) throw new Error(`${node.name}: the session to reuse has not been created yet.`);
    }
    node.permissions ??= node.requiresCheck ? 'full' : 'read-write';
    if (node.requiresCheck && node.permissions !== 'full') throw new Error(`${node.name}: a required shell check needs read, write and shell permission.`);
    if (!['none', 'read', 'read-write', 'full'].includes(node.permissions)) throw new Error(`${node.name}: invalid tool policy.`);
    node.maxRounds ??= 12;
    if (!Number.isInteger(node.maxRounds) || node.maxRounds < 1 || node.maxRounds > 100) throw new Error(`${node.name}: choose 1–100 agent rounds.`);
    if (node.finalizationRounds !== undefined && (!Number.isInteger(node.finalizationRounds) || node.finalizationRounds < 0 || node.finalizationRounds >= node.maxRounds)) throw new Error(`${node.name}: finalization rounds must be nonnegative and below max rounds.`);
    if (node.reasoningEffort !== undefined && !['low', 'medium', 'high'].includes(node.reasoningEffort)) throw new Error(`${node.name}: unsupported reasoning effort.`);
    if (node.summaryHeadings !== undefined && (!Array.isArray(node.summaryHeadings) || node.summaryHeadings.length > 12 || new Set(node.summaryHeadings).size !== node.summaryHeadings.length || node.summaryHeadings.some(h => typeof h !== 'string' || !h.trim() || h.length > 80 || /[\r\n]/.test(h)))) throw new Error(`${node.name}: invalid summary headings.`);
    if (node.submissionRequirements !== undefined) node.submissionRequirements = normalizeSubmissionRequirements(node.submissionRequirements);
    if (node.presentationBindings !== undefined) {
      const bindings = node.presentationBindings;
      const validField = value => typeof value === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
      if (!Array.isArray(bindings) || bindings.length > 12 || bindings.filter(binding => binding?.primary === true).length > 1)
        throw new Error(`${node.name}: presentation bindings must contain at most 12 items and one primary item.`);
      const bindingKeys = new Set();
      node.presentationBindings = bindings.map(binding => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
            Object.keys(binding).some(key => !['source', 'field', 'label', 'primary'].includes(key)) ||
            !['summary', 'detail', 'artifact'].includes(binding.source) ||
            binding.primary !== undefined && typeof binding.primary !== 'boolean' ||
            binding.label !== undefined && (typeof binding.label !== 'string' || !binding.label.trim() || binding.label.length > 80 || /[\r\n]/.test(binding.label)) ||
            (binding.source === 'detail' ? !validField(binding.field) : binding.field !== undefined))
          throw new Error(`${node.name}: invalid presentation binding.`);
        if (binding.source === 'detail' && !Object.values(node.submissionRequirements ?? {}).some(rule => rule.fields.includes(binding.field)))
          throw new Error(`${node.name}: presentation detail field must be declared in submission requirements.`);
        const key = binding.source === 'detail' ? `detail:${binding.field}` : binding.source;
        if (bindingKeys.has(key)) throw new Error(`${node.name}: duplicate presentation binding for ${key}.`);
        bindingKeys.add(key);
        return { source: binding.source, ...(binding.field ? { field: binding.field } : {}), ...(binding.label !== undefined ? { label: binding.label.trim() } : {}), ...(binding.primary ? { primary: true } : {}) };
      });
    }
    node.skills ??= [];
    if (!Array.isArray(node.skills) || node.skills.length > 30 || node.skills.some(id => typeof id !== 'string')) throw new Error(`${node.name}: invalid skill selection.`);
    if (node.model && (typeof node.model !== 'string' || node.model.length > 100)) throw new Error(`${node.name}: invalid model.`);
  } else if (node.presentationBindings !== undefined) throw new Error(`${node.name}: presentation bindings require an agent submission.`);
  if (node.kind === 'action' && node.activity !== undefined) {
    // Registered activities declare resource needs, not Library authority. An
    // agent-resource action must opt into the normal Library permission level;
    // the activity descriptor itself never widens that policy.
    node.permissions ??= 'none';
    if (!['none', 'read', 'read-write', 'full'].includes(node.permissions)) throw new Error(`${node.name}: invalid tool policy.`);
  }
  ids.add(node.id); return node;
}

/** Normalize graph definitions and the historical ordered-step input. */
export function normalizeWorkflow(input, { publishing = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Workflow is required.');
  const isLegacy = !Array.isArray(input.nodes); const sourceNodes = isLegacy ? input.steps : input.nodes;
  if (!Array.isArray(sourceNodes) || !sourceNodes.length || sourceNodes.length > 100) throw new Error('Add between 1 and 100 workflow nodes.');
  // This marker is an internal compatibility projection. Older clients may
  // still publish a bare human node, but cannot submit the marker itself as
  // caller-selectable publication policy.
  if (publishing && sourceNodes.some(node => node?.legacyHumanTask !== undefined))
    throw new Error('Legacy human-task markers are not accepted in published input.');
  const value = { id: input.id || randomUUID(), name: required(input.name, 'Workflow name', 120), schemaVersion: 3, nodes: [], edges: [], entryNode: input.entryNode ?? input.startNode, maxRevisions: input.maxRevisions ?? 3 };
  const runInputSchema = input.runInputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false };
  validateActivitySchema(runInputSchema);
  if (runInputSchema.type !== 'object') throw new Error('Workflow runInputSchema must describe an object.');
  value.runInputSchema = structuredClone(runInputSchema);
  if (input.resultSchema !== undefined) {
    validateActivitySchema(input.resultSchema);
    if (input.resultSchema.type !== 'object') throw new Error('Workflow resultSchema must describe an object.');
    value.resultSchema = structuredClone(input.resultSchema);
    if (!input.resultBindings || typeof input.resultBindings !== 'object' || Array.isArray(input.resultBindings)) throw new Error('Workflow result bindings are required when resultSchema is declared.');
    value.resultBindings = structuredClone(input.resultBindings);
  } else if (input.resultBindings !== undefined) throw new Error('Workflow result bindings require a resultSchema.');
  if (input.capabilityProfile != null) {
    const ref = input.capabilityProfile;
    if (typeof ref.id !== 'string' || !ref.id.trim() || ref.id.length > 120 || !Number.isInteger(ref.version) || ref.version < 1)
      throw new Error('Invalid workflow capability profile revision.');
    value.capabilityProfile = { id: ref.id, version: ref.version };
  }
  if (!safeId(value.id)) throw new Error('Invalid workflow ID.');
  if (!Number.isInteger(value.maxRevisions) || value.maxRevisions < 0 || value.maxRevisions > 20) throw new Error('maxRevisions must be an integer from 0 to 20.');
  const ids = new Set(); const sessions = new Set(['main']);
  const declaredNewSessions = sourceNodes.filter(node => node?.kind === 'agent' && node?.session?.mode === 'new').map(node => node.session.name);
  if (declaredNewSessions.some(name => typeof name !== 'string' || declaredNewSessions.filter(x => x === name).length > 1 || name === 'main')) throw new Error('Agent session names must be unique.');
  const seenNewSessions = new Set();
  // Names are declared globally so a graph may reuse a session on any reachable path.
  for (const name of declaredNewSessions) sessions.add(name);
  value.nodes = sourceNodes.map((node, index) => normalizeNode(node, index, ids, sessions, seenNewSessions));
  if (!value.entryNode) value.entryNode = value.nodes[0].id;
  if (!ids.has(value.entryNode)) throw new Error('Workflow entryNode must reference a node.');
  if (input.runtime !== undefined) { value.runtime = normalizeRuntimeSelection(input.runtime);
    if (value.runtime && value.nodes.some(n => n.kind === 'agent' && n.permissions !== 'full')) throw new Error('Verification workflows require explicitly full agent-node tool permissions.');
  }
  for (const node of value.nodes.filter(node => node.operation === 'send_external_reply')) {
    const source = value.nodes.find(source => source.id === node.input.sourceNodeId);
    if (source?.kind !== 'agent' || !Object.values(source.submissionRequirements ?? {}).some(rule => rule.fields.includes(node.input.field)))
      throw new Error(`${node.name}: reply field must be declared by the source agent's submission requirements.`);
  }
  const supplied = Array.isArray(input.edges) ? input.edges : [];
  if (supplied.length > 300) throw new Error('A workflow may have at most 300 edges.');
  const edges = supplied.length ? supplied : isLegacy ? value.nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: value.nodes[index + 1].id, outcome: node.kind === 'human' ? 'approved' : 'success' })) : [];
  const edgeIds = new Set();
  for (const [index, original] of edges.entries()) {
    if (!original || typeof original !== 'object') throw new Error(`Edge ${index + 1} is invalid.`);
    const from = original.from ?? original.source; const to = original.to ?? original.target; const outcome = original.outcome ?? original.on ?? original.when ?? 'success';
    if (!ids.has(from) || !ids.has(to)) throw new Error(`Edge ${index + 1} references an unknown node.`);
    if (typeof outcome !== 'string' || !/^[\w.*:-]{1,80}$/.test(outcome)) throw new Error(`Edge ${index + 1} has an invalid outcome.`);
    const id = original.id ?? `${from}:${outcome}:${to}`;
    if (edgeIds.has(id)) throw new Error('Every workflow edge needs a unique identifier.');
    if (value.edges.some(e => e.from === from && e.outcome === outcome)) throw new Error(`Node ${from} has more than one edge for outcome ${outcome}.`);
    edgeIds.add(id); value.edges.push({ ...original, id, from, to, outcome });
  }
  // Legacy revisionTarget becomes an explicit graph route; no board phase is inferred.
  for (const node of value.nodes) if (node.revisionTarget) {
    if (node.kind !== 'human' || !ids.has(node.revisionTarget)) throw new Error(`${node.name}: revision target must reference a node.`);
    if (!value.edges.some(e => e.from === node.id && e.outcome === 'changes_requested')) value.edges.push({ id: `${node.id}:changes_requested:${node.revisionTarget}`, from: node.id, to: node.revisionTarget, outcome: 'changes_requested' });
  }
  for (const node of value.nodes) if (isLegacy && node.kind === 'human' && !value.edges.some(e => e.from === node.id && e.outcome === 'approved')) {
    const next = value.nodes[value.nodes.findIndex(x => x.id === node.id) + 1];
    if (next) value.edges.push({ id: `${node.id}:approved:${next.id}`, from: node.id, to: next.id, outcome: 'approved' });
  }
  for (const node of value.nodes) if (node.kind === 'branch') {
    for (const outcome of [node.condition.trueOutcome, node.condition.falseOutcome]) if (!value.edges.some(edge => edge.from === node.id && (edge.outcome === outcome || edge.outcome === '*' || edge.outcome === 'default'))) throw new Error(`${node.name}: missing route for branch outcome ${outcome}.`);
  }
  for (const node of value.nodes.filter(node => node.kind === 'human')) {
    const outcomes = new Set(node.humanTask.outcomes.map(outcome => outcome.id));
    const unsupported = value.edges.find(edge => edge.from === node.id && !outcomes.has(edge.outcome) && !['*', 'default'].includes(edge.outcome));
    if (node.legacyHumanTask) {
      if (publishing && unsupported && !['success', 'approved', 'changes_requested', '*', 'default'].includes(unsupported.outcome))
        throw new Error(`${node.name}: unsupported human outcome ${unsupported.outcome}.`);
    } else if (unsupported) throw new Error(`${node.name}: outcome ${unsupported.outcome} is not configured for this human task.`);
  }
  for (const node of value.nodes.filter(node => node.operation === 'send_external_reply')) {
    const incoming = value.edges.filter(edge => edge.to === node.id);
    if (value.entryNode === node.id || !incoming.length || incoming.some(edge => edge.outcome !== 'approved' || value.nodes.find(source => source.id === edge.from)?.kind !== 'human'))
      throw new Error(`${node.name}: sending a reply requires an explicit human approval edge.`);
  }
  const reachable = new Set([value.entryNode]);
  for (let changed = true; changed;) { changed = false; for (const edge of value.edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } }
  if (reachable.size !== value.nodes.length) throw new Error('Every workflow node must be reachable from entryNode.');
  // Loops are intentional only when they are bounded revision loops. A
  // non-zero check is a revision outcome too, so a graph may use
  // check(failed) -> implement -> check(success) without creating an
  // unbounded execution cycle.
  const visiting = new Set(); const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Workflow contains an unbounded loop.');
    if (visited.has(id)) return; visiting.add(id);
    // Both review changes and failed checks are capped by maxRevisions.
    for (const edge of value.edges.filter(e => e.from === id && !['changes_requested', 'failed'].includes(e.outcome))) visit(edge.to);
    visiting.delete(id); visited.add(id);
  }
  for (const node of value.nodes) visit(node.id);
  value.steps = value.nodes;
  if (input.triggers?.length) throw new Error('Embedded triggers are not supported. Use automations.');
  return value;
}

export function ensureAgentSessions(s) {
  s.agentSessions ??= {};
  if (!Object.keys(s.agentSessions).length) { const id = randomUUID(); s.agentSessions[id] = { id, name: 'main', messages: s.messages ?? [], createdAt: new Date().toISOString() }; s.currentAgentSessionId = id; }
  if (!s.currentAgentSessionId || !s.agentSessions[s.currentAgentSessionId]) s.currentAgentSessionId = Object.keys(s.agentSessions)[0];
  return s.agentSessions[s.currentAgentSessionId];
}

export function createWorkflowEngine({ state, save, event, inspectArtifact = async () => ({ text: '', sha256: '' }), readReference = async () => { throw new Error('Source reference reader unavailable.'); }, captureArtifacts = async (_s, paths) => paths, sealEvidence = async () => null, inspectChanges = async () => null, busy = () => false, launch, abort = () => {}, canProvision = () => false, actionExecutor = null, prepareStart = () => {}, bindRun = () => {}, attachAgent = async () => { throw new Error('Agent activity requires an attached conversation.'); }, getWorkflowOwner = () => null }) {
  let pumping = false; let pumpAgain = false;
  const decodedRuns = new WeakMap();
  const runOwner = s => s.independentRun ? s : state.workflowRuns?.[s.workflowRunId];
  const attemptStatus = (s, status) => { const owner = runOwner(s); if (owner?.attempt && owner.attempt.instance === s.flow?.instance) { owner.attempt.status = status; owner.attempt.updatedAt = new Date().toISOString(); } };
  const definition = s => {
    const owner = runOwner(s);
    if (!owner) return s.workflow;
    if (!decodedRuns.has(owner)) {
      const decoded = normalizeWorkflow(owner.workflow);
      decoded.version = owner.workflow?.version;
      decodedRuns.set(owner, decoded);
    }
    return decodedRuns.get(owner);
  };
  const nodes = s => definition(s).nodes ?? definition(s).steps;
  const current = s => { const list = nodes(s); return list.find(n => n.id === s.flow?.nodeId) ?? list[s.step]; };
  function requireInstance(s, instance) { if (!s.flow || s.flow.instance !== instance) throw new Error('This workflow step has changed. Refresh before acting.'); }
  function active(s) { return s.flow && !['completed', 'cancelled'].includes(s.flow.status); }
  function edgeFor(s, outcome) { const node = current(s); const edges = definition(s).edges.filter(e => e.from === node.id); return edges.find(e => e.outcome === outcome) ?? edges.find(e => e.outcome === '*') ?? edges.find(e => e.outcome === 'default') ?? null; }
  function assertOutcome(s, outcome) {
    const node = current(s);
    if (node.kind === 'human' && node.humanTask?.outcomes?.some(item => item.id === outcome)) return;
    const {outcomes} = submissionContract(definition(s), node);
    if (outcomes === null || outcomes.includes(outcome)) return;
    throw new Error(`No workflow edge handles outcome ${outcome} from ${node.name}. Choose a configured outcome: ${outcomes.join(', ')}.`);
  }

  function activate(s, nodeId, outcome = 'success') {
    const list = nodes(s); const index = list.findIndex(n => n.id === nodeId); if (index < 0) throw new Error('Workflow transition references an unknown node.');
    const owner = runOwner(s);
    const reservation = getWorkflowOwner()?.activityReservationForActivation(s, nodeId);
    s.step = index; s.flow.nodeId = nodeId; s.flow.instance = reservation?.targetInstance ?? randomUUID(); s.flow.validation = null; s.flow.submission = null; s.flow.agentSessionId = null; s.flow.lastOutcome = outcome;
    delete s.flow.decisionSubmissionRef;
    if (list[index].operation !== 'send_external_reply') delete s.flow.approvedSubmission;
    const node = list[index]; s.flow.status = node.kind === 'human' ? 'waiting_gate' : node.kind === 'wait' ? 'waiting_event' : 'ready'; s.status = s.flow.status;
    if (node.kind === 'human' && node.humanTask?.dueAfterSeconds)
      s.flow.humanTaskDueAt = new Date(Date.now() + node.humanTask.dueAfterSeconds * 1000).toISOString();
    else delete s.flow.humanTaskDueAt;
    if (owner) {
      owner.activityAttempts ??= []; if (owner.attempt) owner.activityAttempts.push(structuredClone(owner.attempt));
      owner.attempt = { instance: s.flow.instance, nodeId: node.id, status: s.flow.status === 'waiting_gate' || s.flow.status === 'waiting_event' ? 'waiting' : 'ready', startedAt: new Date().toISOString(),
        ...(reservation ? { reservationId: reservation.id, activityRef: structuredClone(reservation.activityRef), intent: structuredClone(reservation.intent), intentDigest: reservation.intentDigest, inputDigest: reservation.inputDigest, idempotencyKey: reservation.idempotencyKey } : {}) };
    }
    if (node.kind === 'wait') getWorkflowOwner()?.registerWait(s, node, s.flow.instance);
    event(s, 'step_activated', { runId: s.flow.id, nodeId: node.id, stepId: node.id, instance: s.flow.instance, name: node.name, outcome });
  }
  function transition(s, outcome) {
    assertOutcome(s, outcome);
    const node = current(s); const edge = edgeFor(s, outcome); const latestEvidence = s.flow.evidenceTrail?.at(-1)?.evidence;
    const workflowOwner = getWorkflowOwner();
    const authorizedOutcome = node.kind === 'human' && (node.humanTask?.outcomes?.find(item => item.id === outcome)?.effect === 'approve_activity' || node.legacyHumanTask && outcome === 'approved');
    if (node.kind === 'human' && !authorizedOutcome)
      workflowOwner?.invalidateActivityReservations(s, { gateNodeId: node.id, gateInstance: s.flow.instance });
    const terminalResult = !edge ? workflowOwner?.resolveWorkflowResult(s) : null;
    if (!edge && terminalResult) workflowOwner.recordWorkflowResult(s, terminalResult);
    attemptStatus(s, ['failed', 'changes_requested'].includes(outcome) ? 'failed' : 'completed');
    if (latestEvidence) s.flow.previousEvidence = latestEvidence;
    const completedInstance = s.flow.instance;
    const submission = node.kind === 'agent' && s.flow.lastSubmission?.nodeId === node.id && s.flow.lastSubmission?.instance === completedInstance
      ? structuredClone(s.flow.lastSubmission) : undefined;
    const validation = node.kind === 'agent' ? s.flow.validation : null;
    const sourceEvidence = validation ? {
      sourceNodeId: node.id,
      sourceInstance: completedInstance,
      ...(validation.artifact ? { artifact: structuredClone(validation.artifact) } : {}),
      ...(validation.digest ? { digest: validation.digest } : {}),
      ...(validation.details ? { details: structuredClone(validation.details) } : {}),
      ...(validation.references ? { references: validation.references.map(({ path, startLine, endLine, sha256 }) => ({ path, startLine, endLine, sha256 })) } : {}),
    } : undefined;
    const reviewedSubmissionRef = node.kind === 'human' && s.flow.decisionSubmissionRef ? structuredClone(s.flow.decisionSubmissionRef) : undefined;
    const reviewedHumanResponseId = node.kind === 'human' ? s.flow.reviewedHumanResponseId : undefined;
    const reviewedHumanMaterialDigest = node.kind === 'human' ? s.flow.reviewedHumanMaterialDigest : undefined;
    delete s.flow.reviewedHumanResponseId; delete s.flow.reviewedHumanMaterialDigest;
    const reservationDecision = s.flow.activityReservationDecision;
    delete s.flow.activityReservationDecision;
    s.flow.previousNodeId = node.id; s.flow.history.push({ nodeId: node.id, instance: completedInstance, outcome, at: new Date().toISOString(), to: edge?.to ?? null, ...(submission ? { submission } : {}), ...(sourceEvidence ? { sourceEvidence } : {}), ...(reviewedSubmissionRef ? { decisionSubmissionRef: reviewedSubmissionRef } : {}),
      ...(reviewedHumanResponseId ? { humanResponseId: reviewedHumanResponseId } : {}), ...(reviewedHumanMaterialDigest ? { humanMaterialDigest: reviewedHumanMaterialDigest } : {}),
      ...(reservationDecision ? {
        activityReservationId: reservationDecision.id, activityReservationDigest: reservationDecision.digest,
        humanOutcomeId: outcome,
        activityReservation: { targetNodeId: reservationDecision.targetNodeId,
          activityRef: structuredClone(reservationDecision.activityRef), inputDigest: reservationDecision.inputDigest,
          intentDigest: reservationDecision.intentDigest, preview: structuredClone(reservationDecision.preview) },
      } : {}) });
    const owner = runOwner(s); if (owner?.attempt && owner.attempt.instance === completedInstance) { owner.attempt.status = 'completed'; owner.attempt.outcome = outcome; owner.attempt.completedAt = new Date().toISOString(); }
    if (!edge) {
      s.flow.status = 'completed'; s.status = 'accepted'; attemptStatus(s, 'completed');
      event(s, 'workflow_completed', { runId: s.flow.id, ...(terminalResult?.resultDigest ? { resultDigest: terminalResult.resultDigest } : {}) });
      return;
    }
    activate(s, edge.to, outcome);
    if (current(s).kind === 'human') {
      const source = [...s.flow.history].reverse().find(entry => entry.submission?.nodeId && entry.submission?.instance && entry.submission?.revision === s.flow.revision + 1);
      if (source) s.flow.decisionSubmissionRef = { nodeId: source.submission.nodeId, instance: source.submission.instance, revision: source.submission.revision ?? 0 };
    }
  }
  function resolveDecisionSubmission(s, gateNode) {
    const flow = s.flow;
    const matches = ref => {
      const entry = flow.history.find(item => item.nodeId === ref.nodeId && item.instance === ref.instance);
      if (!entry) return null;
      if (entry.submission?.revision !== undefined && entry.submission.revision !== ref.revision) return null;
      const submission = entry.submission ?? null;
      const trailEvidence = flow.evidenceTrail?.findLast(item => item.nodeId === ref.nodeId && item.instance === ref.instance);
      return submission ? { ref, entry, submission, evidenceEntry: entry.sourceEvidence ? { nodeId: ref.nodeId, instance: ref.instance, evidence: entry.sourceEvidence } : trailEvidence } : null;
    };
    if (flow.decisionSubmissionRef) return matches(flow.decisionSubmissionRef);

    // Older active gates persisted lastSubmission and evidence separately. Bind
    // only when both identify one exact direct source completion for this gate.
    const legacy = flow.lastSubmission;
    if (!legacy?.nodeId || flow.previousEvidence?.sourceNodeId && legacy.nodeId !== flow.previousEvidence.sourceNodeId) return null;
    const evidenceMatches = (left, right) => {
      if (!left || !right) return false;
      return JSON.stringify(left.details ?? null) === JSON.stringify(right.details ?? null) &&
        JSON.stringify(left.references ?? null) === JSON.stringify(right.references ?? null) &&
        JSON.stringify(left.artifact ?? null) === JSON.stringify(right.artifact ?? null) &&
        (left.digest ?? null) === (right.digest ?? null);
    };
    if (flow.previousEvidence && (JSON.stringify(legacy.details ?? null) !== JSON.stringify(flow.previousEvidence.details ?? null) ||
        JSON.stringify(legacy.references ?? null) !== JSON.stringify(flow.previousEvidence.references ?? null))) return null;
    const historyCandidates = flow.history.filter(history => history.nodeId === legacy.nodeId && history.to === gateNode.id);
    if (historyCandidates.length !== 1) return null;
    const history = historyCandidates[0];
    const evidenceCandidates = (flow.evidenceTrail ?? []).filter(item => item.nodeId === legacy.nodeId && item.instance === history.instance);
    if (flow.previousEvidence && (evidenceCandidates.length !== 1 || !evidenceMatches(evidenceCandidates[0].evidence, flow.previousEvidence))) return null;
    const source = evidenceCandidates[0] ?? null;
    if (legacy.revision !== undefined && legacy.revision !== flow.revision + 1) return null;
    const ref = { nodeId: legacy.nodeId, instance: history.instance, revision: legacy.revision ?? flow.revision + 1 };
    history.submission = { ...structuredClone(legacy), instance: ref.instance, revision: ref.revision };
    flow.decisionSubmissionRef = ref;
    if (flow.previousEvidence) { flow.previousEvidence.sourceNodeId = ref.nodeId; flow.previousEvidence.sourceInstance = ref.instance; }
    if (source?.evidence) { source.evidence.sourceNodeId = ref.nodeId; source.evidence.sourceInstance = ref.instance; }
    if (source?.evidence) history.sourceEvidence = {
      sourceNodeId: ref.nodeId, sourceInstance: ref.instance,
      ...(source.evidence.artifact ? { artifact: structuredClone(source.evidence.artifact) } : {}),
      ...(source.evidence.digest ? { digest: source.evidence.digest } : {}),
      ...(source.evidence.details ? { details: structuredClone(source.evidence.details) } : {}),
      ...(source.evidence.references ? { references: source.evidence.references.map(({ path, startLine, endLine, sha256 }) => ({ path, startLine, endLine, sha256 })) } : {}),
    };
    return { ref, entry: history, submission: history.submission, evidenceEntry: source };
  }
  async function validate(s, outcome = 'success') {
    const node = current(s); let artifact = null; let review = null;
    if (node.artifact) {
      if (!s.workspace) throw new Error('This step requires an assigned worktree.'); const file = await inspectArtifact(s, node.artifact.path);
      const headings = file.text.split('\n').filter(l => /^#{1,6} /.test(l)).map(l => l.replace(/^#{1,6} /, '').trim().toLowerCase()); const missing = node.artifact.headings.filter(h => !headings.includes(h.toLowerCase()));
      if (!file.text.trim() || missing.length) throw new Error(`Artifact ${node.artifact.path} is incomplete. Missing sections: ${missing.join(', ') || 'content'}.`); artifact = { path: node.artifact.path, hash: file.sha256 };
    }
    if (s.workspace && (node.kind === 'agent' || node.requiresCheck || node.kind === 'check' || node.kind === 'action' && node.operation === 'inspect_changes' || node.artifact)) review = await inspectChanges(s, node.artifact?.path);
    if (node.requiresCheck || node.kind === 'check') {
      const check = s.checks.find(c => c.instance === s.flow.instance && c.command === node.checkCommand && !c.stopped && !c.concurrent && c.digest === review?.digest && (outcome === 'failed' ? c.code !== 0 : c.code === 0));
      if (!review || !check) throw new Error(outcome === 'failed' ? 'The configured check failure evidence is stale or missing. Run it again against the current workspace.' : 'The configured check must pass against the current workspace. Run it again after code changes.');
      return { artifact, digest: review.digest, check: { command: check.command, code: check.code, digest: check.digest }, at: new Date().toISOString() };
    }
    return { artifact, digest: review?.digest, at: new Date().toISOString() };
  }
  async function finish(s, summary, artifacts, outcome = 'success', submissionEvidence = null) {
    const instance = s.flow.instance; const status = s.flow.status; const node = current(s); if (node.artifact && !artifacts.includes(node.artifact.path)) throw new Error(`Include ${node.artifact.path} in the submission.`);
    assertOutcome(s, outcome);
    if (['changes_requested', 'failed'].includes(outcome) && s.flow.revision >= definition(s).maxRevisions) throw new Error('Workflow revision limit reached.');
    const evidence = { ...await validate(s, outcome), ...(node.kind === 'agent' ? { ...(submissionEvidence ?? {}), sourceNodeId: node.id, sourceInstance: instance } : {}) }; if (s.flow.instance !== instance || s.flow.status !== status) throw new Error('Workflow changed during validation. Submission was not accepted.');
    const verification = node.kind === 'agent' ? await sealEvidence(s, submissionEvidence, artifacts) : null;
    if (s.flow.instance !== instance || s.flow.status !== status) throw new Error('Workflow changed while sealing evidence.');
    if (verification) { evidence.verification = verification; submissionEvidence = {...submissionEvidence, verification}; }
    const capturedArtifacts = await captureArtifacts(s, artifacts);
    if (s.flow.instance !== instance || s.flow.status !== status) throw new Error('Workflow changed while capturing artifacts. Submission was not accepted.');
    const primaryArtifact = capturedArtifacts.find(artifact => artifact?.path === node.artifact?.path) ?? capturedArtifacts.find(artifact => artifact?.id);
    s.flow.validation = evidence; s.flow.submission = { summary, artifacts, ...(submissionEvidence ?? {}) }; s.flow.lastSubmission = {
      nodeId: node.id,
      instance,
      step: node.name,
      summary,
      ...(submissionEvidence ?? {}),
      revision: s.flow.revision + 1,
      ...(primaryArtifact?.id ? { primaryArtifactId: primaryArtifact.id } : {}),
      artifacts: capturedArtifacts,
    };
    if (node.kind === 'agent' || evidence.artifact || evidence.digest || evidence.details) { s.flow.evidenceTrail ??= []; s.flow.evidenceTrail.push({ nodeId: node.id, instance, evidence }); s.flow.evidenceTrail = s.flow.evidenceTrail.slice(-50); }
    event(s, 'step_submitted', { runId: s.flow.id, nodeId: node.id, stepId: node.id, instance, summary, evidence, outcome });
    if (['changes_requested', 'failed'].includes(outcome)) { s.flow.revision++; s.flow.evidenceTrail = []; event(s, 'evidence_invalidated', { fromNode: node.id, revision: s.flow.revision, outcome }); }
    if (node.advance === 'manual' && outcome === 'success') { s.flow.status = 'awaiting_continue'; s.status = 'awaiting_continue'; attemptStatus(s, 'waiting'); }
    else { event(s, 'step_completed', { runId: s.flow.id, nodeId: node.id, stepId: node.id, instance, evidence, outcome }); transition(s, outcome); }
    await save(); return { accepted: true, next: s.flow.status, message: 'Submission validated. The orchestrator controls further execution; stop this turn.' };
  }
  function resolveSession(s) {
    const node = current(s); const flow = s.flow; if (flow.agentSessionId) return s.agentSessions[flow.agentSessionId]; let record;
    if (node.session.mode === 'new' && flow.bindings[node.id]) record = s.agentSessions[flow.bindings[node.id]];
    else if (node.session.mode === 'new') { const id = randomUUID(); record = { id, name: node.session.name, messages: [], createdAt: new Date().toISOString() }; s.agentSessions[id] = record; flow.aliases[node.session.name] = id; }
    else if (node.session.mode === 'reuse') record = s.agentSessions[flow.aliases[node.session.target]] ?? Object.values(s.agentSessions).find(x => x.name === node.session.target);
    else record = s.agentSessions[flow.bindings[node.id] ?? flow.lastAgent];
    if (!record) throw new Error('The designated agent session is unavailable.'); flow.agentSessionId = record.id; flow.bindings[node.id] = record.id; flow.lastAgent = record.id; s.currentAgentSessionId = record.id; s.messages = record.messages;
    event(s, 'session_routed', { nodeId: node.id, stepId: node.id, instance: flow.instance, agentSessionId: record.id, sessionName: record.name, rule: node.session.mode }); return record;
  }
  return {
    active, current,
    async signal(s, instance, fact) {
      requireInstance(s, instance);
      if (s.flow.status !== 'waiting_event' || current(s).kind !== 'wait') return false;
      const node = current(s);
      if (fact.event !== 'timeout' && node.waitFor.event !== fact.event) return false;
      s.flow.actionResult = { event: fact.event, ...(fact.eventId ? { eventId: fact.eventId } : {}),
        ...(fact.ticketId ? { ticketId: fact.ticketId } : {}), ...(fact.messageId ? { messageId: fact.messageId } : {}) };
      event(s, fact.event === 'timeout' ? 'workflow_wait_timed_out' : 'workflow_event_received', { runId: s.flow.id, nodeId: node.id, instance, ...s.flow.actionResult });
      transition(s, fact.outcome ?? 'success');
      await save();
      return true;
    },
    async start(s, options = {}) {
      if (active(s) || busy(s)) throw new Error('A workflow is already active.'); if (!definition(s)) throw new Error('Select and apply a workflow first.');
      if (!s.independentRun) s.workflow = { ...normalizeWorkflow(s.workflow), version: s.workflow.version };
      if (!s.independentRun) prepareStart(s, options);
      const main = s.independentRun ? null : ensureAgentSessions(s);
      delete s.boardPhase;
      const pinned = definition(s);
      const flow = { id: s.independentRun ? s.id : randomUUID(), workflowId: pinned.id, workflowVersion: pinned.version, ...(options.triggerKey ? { triggerKey: options.triggerKey } : {}), ...(s.model ? { model: s.model } : {}), status: 'ready', nodeId: null, instance: null, ...(!s.independentRun ? { aliases: { main: main.id }, bindings: {}, lastAgent: main.id, agentSessionId: null } : { aliases: {}, bindings: {}, lastAgent: null, agentSessionId: null }), revision: 0, history: [], startedAt: new Date().toISOString() };
      if (!s.independentRun) bindRun(s, flow);
      s.flow = flow;
      event(s, 'workflow_started', { runId: s.flow.id, workflowId: pinned.id, version: pinned.version }); activate(s, pinned.entryNode); await save();
    },
    async pump() {
      if (pumping) { pumpAgain = true; return; } pumping = true;
      try { do { pumpAgain = false; const contexts = [...Object.values(state.sessions), ...Object.values(state.workflowRuns ?? {}).filter(run => run.independentRun && !run.sessionId)]; for (let s of contexts) { if (s.flow?.status !== 'ready' || busy(s)) continue; let node = current(s); try {
        const owner = runOwner(s);
        const workflowOwner = getWorkflowOwner();
        const activityRef = node.activity ? workflowOwner?.getActivityRef(node) : null;
        const descriptor = activityRef ? workflowOwner?.activityDescriptor(activityRef) : null;
        if (activityRef && (!descriptor || node.activityDescriptorDigest && node.activityDescriptorDigest !== activityDigest(descriptor)))
          throw new Error('Pinned activity metadata is unavailable or changed; resource acquisition is blocked.');
        const needsProviderSession = node.kind === 'agent' || Boolean(s.independentRun && descriptor?.resources.location === 'agent');
        if (needsProviderSession) {
          if (s.independentRun) s = await attachAgent(s);
          if (node.kind === 'agent') resolveSession(s);
          node = current(s);
        }
        s.flow.status = 'running'; s.status = 'running'; const activeOwner = runOwner(s); if (activeOwner?.attempt && activeOwner.attempt.instance === s.flow.instance) { if (['ready', 'running'].includes(activeOwner.attempt.status)) { activeOwner.attempt.status = 'running'; activeOwner.attempt.startedAt = new Date().toISOString(); } } await save(); if (s.flow.status !== 'running') continue; if (!launch(s, node, s.flow.instance)) { s.flow.status = 'ready'; s.status = 'queued'; if (activeOwner?.attempt && activeOwner.attempt.instance === s.flow.instance && activeOwner.attempt.status === 'running') activeOwner.attempt.status = 'ready'; await save(); }
      } catch (e) { s.flow.status = 'failed'; s.status = 'failed'; const owner = runOwner(s); if (owner?.attempt && owner.attempt.instance === s.flow.instance && !['uncertain', 'completed', 'cancelled'].includes(owner.attempt.status)) owner.attempt.status = 'failed'; event(s, 'workflow_failed', { message: e.message }); await save(); } } } while (pumpAgain); } finally { pumping = false; }
    },
    async submit(s, instance, args) {
      requireInstance(s, instance); const node = current(s); if (s.flow.status !== 'running' || node.kind !== 'agent') throw new Error('This agent cannot submit the current step.'); const summary = required(args.summary, 'Completion summary', 4000);
      let outcome;
      try {
        outcome = validateSubmissionContract(submissionContract(definition(s), node), args);
        for (const heading of node.summaryHeadings ?? []) {
          const lines = summary.split('\n');
          const index = lines.findIndex(line => line.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === heading.toLowerCase() && /^#{1,6}\s+/.test(line));
          const body = index < 0 ? '' : lines.slice(index + 1).join('\n').split(/\n#{1,6}\s/)[0].trim();
          if (!body || /^#{1,6}\s/.test(body)) throw new Error(`Submission needs a nonempty Markdown section: ${heading}.`);
        }
      assertOutcome(s, outcome);
      let structured = null;
      if (node.submissionRequirements) structured = await validateSubmissionRequirements(node, args, ref => readReference(s, ref, node));
      else if (args.details !== undefined || args.references !== undefined || args.investigation !== undefined) throw new Error('Structured evidence is not configured for this step.');
      requireInstance(s, instance);
      if (s.flow.status !== 'running') throw new Error('Workflow changed during source validation.');
      return await finish(s, summary, args.artifacts, outcome, structured); } catch (e) { event(s, 'submission_rejected', { instance, message: e.message }); await save(); throw e; }
    },
    async finishAutomated(s, instance, outcome = 'success', result = null) { requireInstance(s, instance); if (s.flow.status !== 'running') throw new Error('Workflow is no longer running.'); const node = current(s); if (result) s.flow.actionResult = result; return finish(s, `${node.name} completed`, node.artifact ? [node.artifact.path] : [], outcome); },
    async holdAction(s, instance, result) {
      requireInstance(s, instance);
      if (current(s).kind !== 'action' || s.flow.status !== 'running') throw new Error('Only a running action can await delivery.');
      s.flow.resumeStatus = 'ready'; s.flow.status = 'paused'; s.status = 'paused'; attemptStatus(s, 'waiting'); s.flow.actionResult = result;
      event(s, 'workflow_action_waiting', { nodeId: current(s).id, instance, message: result.message });
      await save();
    },
    async decide(s, command) {
      requireInstance(s, command.instance);
      // A submitted agent has already yielded control when the gate/evidence is
      // published; its runner promise may still be unwinding persistence. Do not
      // make the human race that cleanup job, but keep active agent turns fenced.
      if (busy(s) && !['waiting_gate', 'awaiting_continue', 'awaiting_submission'].includes(s.flow.status)) throw new Error('Wait for the current agent turn to finish.');
      const node = current(s);
      if (command.action === 'reviseSubmission' && s.flow.status === 'awaiting_continue') { event(s, 'evidence_invalidated', { instance: s.flow.instance }); activate(s, node.id, 'revision'); await save(); return; }
      if (s.flow.status === 'waiting_gate') {
        if (node.humanTask?.outcomes?.length && !node.legacyHumanTask && command.action !== 'decideHumanTask')
          throw new Error('This configured human task requires a reviewed response and configured outcome.');
        if (command.action === 'decideHumanTask') {
          const outcome = command.outcomeId;
          const configured = node.humanTask?.outcomes?.find(item => item.id === outcome);
          if (!configured) throw new Error('This human outcome is no longer configured for the active gate.');
          if (configured.effect === 'approve_activity') {
            const target = nodes(s).find(candidate => candidate.id === edgeFor(s, outcome)?.to);
            const reservationDecision = target?.activity ? getWorkflowOwner()?.verifyActivityReservationDecision(s, {
              gateNodeId: node.id, gateInstance: command.instance, targetNodeId: target.id,
              reservationId: command.activityReservationId, reservationDigest: command.activityReservationDigest,
            }) : null;
            if (target?.activity && !reservationDecision) throw new Error('Prepare and review the exact activity intent before choosing this outcome.');
            if (reservationDecision) s.flow.activityReservationDecision = reservationDecision;
          }
          s.flow.reviewedHumanResponseId = command.responseId;
          s.flow.reviewedHumanMaterialDigest = command.reviewedMaterialDigest;
          try { await finish(s, `Human selected ${outcome}`, [], outcome); }
          catch (error) { delete s.flow.activityReservationDecision; throw error; }
          event(s, 'gate_decided', { instance: command.instance, outcome, actor: command.actor, principal: command.principal });
          await save(); return;
        }
        if (command.action === 'requestChanges') { delete s.flow.approvedSubmission; const feedback = required(command.feedback, 'Review feedback'); if (!edgeFor(s, 'changes_requested')) throw new Error('This gate has no revision path. Configure an outcome edge for changes_requested.'); event(s, 'gate_changes_requested', { instance: command.instance, actor: command.actor ?? s.lease?.label, principal: command.principal, feedback }); s.flow.feedback = feedback; await finish(s, `Changes requested: ${feedback}`, [], 'changes_requested'); return; }
        if (command.action !== 'approveGate') throw new Error('This step needs a human workflow decision.');
        const decisionSource = resolveDecisionSubmission(s, node);
        if (s.flow.decisionSubmissionRef && !decisionSource)
          throw new Error('The exact decision submission is unavailable. Request a fresh submission before approving.');
        if (decisionSource && !decisionSource.evidenceEntry && (decisionSource.submission.references?.length || decisionSource.submission.artifacts?.length))
          throw new Error('The decision source evidence is unavailable. Request a fresh submission before approving.');
        const validateEvidence = async (evidence, expectedRef) => {
          if (!evidence) return;
          if (expectedRef && (evidence.sourceNodeId !== expectedRef.nodeId || evidence.sourceInstance !== expectedRef.instance))
            throw new Error('The decision source no longer matches its captured submission. Request a fresh submission before approving.');
          if (evidence.artifact?.hash) {
            const file = await inspectArtifact(s, evidence.artifact.path);
            requireInstance(s, command.instance);
            if (s.flow.status !== 'waiting_gate' || !file || file.sha256 !== evidence.artifact.hash) throw new Error('Submitted evidence changed. Request a fresh submission before approving.');
          }
          for (const ref of evidence.references ?? []) {
            const origin = (definition(s).nodes ?? definition(s).steps).find(n => n.id === evidence.sourceNodeId);
            if (!origin || origin.kind !== 'agent') throw new Error('Source evidence has no originating agent step. Request a fresh submission.');
            const file = await readReference(s, ref, origin);
            requireInstance(s, command.instance);
            if (s.flow.status !== 'waiting_gate' || !file || file.sha256 !== ref.sha256) throw new Error('Submitted source evidence changed. Request a fresh submission before approving.');
          }
          if (evidence.digest && s.workspace) {
            const review = await inspectChanges(s, evidence.artifact?.path);
            requireInstance(s, command.instance);
            if (s.flow.status !== 'waiting_gate' || !review || review.digest !== evidence.digest) throw new Error('Submitted evidence changed. Request a fresh submission before approving.');
          }
        };
        await validateEvidence(s.flow.previousEvidence, null);
        const sourceEvidence = decisionSource?.evidenceEntry?.evidence;
        if (decisionSource && sourceEvidence !== s.flow.previousEvidence) await validateEvidence(sourceEvidence, decisionSource.ref);
        const next = nodes(s).find(candidate => candidate.id === edgeFor(s, 'approved')?.to);
        const reservationDecision = next?.activity ? getWorkflowOwner()?.verifyActivityReservationDecision(s, {
          gateNodeId: node.id, gateInstance: command.instance, targetNodeId: next.id,
          reservationId: command.activityReservationId, reservationDigest: command.activityReservationDigest,
        }) : null;
        if (reservationDecision) s.flow.activityReservationDecision = reservationDecision;
        if (next?.operation === 'send_external_reply') {
          const sourceRef = decisionSource?.ref;
          const submission = decisionSource?.submission;
          const body = submission?.details?.[next.input.field];
          if (submission?.nodeId !== next.input.sourceNodeId || s.flow.previousEvidence?.sourceNodeId !== sourceRef?.nodeId || s.flow.previousEvidence?.sourceInstance !== sourceRef?.instance || typeof body !== 'string' || !body.trim())
            throw new Error('The reply needs a captured draft from the configured source step. Request changes before approving.');
          s.flow.approvedSubmission = { reviewNodeId: node.id, reviewInstance: command.instance, sourceSubmissionRef: structuredClone(sourceRef), submission: structuredClone(submission) };
        }
        try { await finish(s, 'Human approved', [], 'approved'); }
        catch (error) { delete s.flow.activityReservationDecision; throw error; }
        event(s, 'gate_approved', { instance: command.instance, actor: command.actor ?? s.lease?.label, principal: command.principal }); await save(); return;
      }
      if (command.action !== 'continueWorkflow') throw new Error('There is no pending workflow gate.');
      if (s.flow.status === 'awaiting_continue') { const instance = s.flow.instance; const expectedStatus = s.flow.status; const evidence = await validate(s); requireInstance(s, instance); if (s.flow.status !== expectedStatus || JSON.stringify(evidence.artifact) !== JSON.stringify(s.flow.validation?.artifact) || evidence.digest !== s.flow.validation?.digest) throw new Error('Submitted evidence changed. Request a fresh submission before advancing.'); event(s, 'step_completed', { instance, actor: s.lease?.label, evidence, outcome: 'success' }); transition(s, 'success'); }
      else if (['paused', 'interrupted', 'failed', 'awaiting_submission'].includes(s.flow.status)) { const resume = s.flow.resumeStatus; s.flow.status = ['awaiting_continue', 'waiting_gate', 'waiting_event'].includes(resume) ? resume : 'ready'; s.flow.resumeStatus = null; s.status = s.flow.status; const owner = runOwner(s); const preDispatchBlocked = owner?.attempt?.waitingEvidence?.workPreDispatch === true; const durableUnresolved = owner?.attempt?.instance === s.flow.instance && owner.attempt.effect === 'durable-effect' && ['uncertain', 'failed'].includes(owner.attempt.status) && !preDispatchBlocked; if (!durableUnresolved) attemptStatus(s, ['ready', 'awaiting_continue', 'waiting_gate', 'waiting_event'].includes(s.flow.status) ? 'ready' : 'waiting'); }
      else throw new Error('This workflow is not waiting to continue.'); await save();
    },
    async pause(s, cancel = false) { if (!active(s) && !(cancel && s.flow?.status === 'cancelled')) throw new Error('No active workflow.'); if (cancel) { delete s.queuedInput; delete s.queueReason; } if (s.flow.status === 'paused' && !cancel) return; s.flow.resumeStatus = s.flow.status; s.flow.status = cancel ? 'cancelled' : 'paused'; s.status = s.flow.status; attemptStatus(s, cancel ? 'cancelled' : 'waiting'); event(s, cancel ? 'workflow_cancelled' : 'workflow_paused', { instance: s.flow.instance }); abort(s); await save(); },
    async finishIncomplete(s, instance, args, budget) {
      requireInstance(s, instance);
      if (s.flow.status !== 'running' || current(s).kind !== 'agent' || s.pending || s.pendingQuestion)
        throw new Error('This step cannot finish incomplete while inactive or waiting for a human answer.');
      if (!['budget', 'blocked'].includes(args.reason)) throw new Error('Choose budget or blocked.');
      if (args.reason === 'budget' && !budget?.finalizing && !(budget && budget.round + 1 >= budget.maxRounds))
        throw new Error('Investigation requests remain. Continue the next internal action; use budget only during finalization.');
      const report = {
        summary: required(args.summary, 'Established findings', 4000),
        missingEvidence: required(args.missingEvidence, 'Missing evidence or observed blocker', 4000),
        nextAction: required(args.nextAction, 'Next internal action', 2000),
        reason: args.reason,
      };
      s.flow.status = 'awaiting_submission'; s.status = 'awaiting_submission'; attemptStatus(s, 'waiting');
      event(s, 'workflow_incomplete', {instance, ...report});
      await save();
      return {accepted: true, complete: false, next: 'awaiting_submission', message: 'Incomplete work recorded. The workflow has not advanced and no continuation is scheduled. Stop this execution.'};
    },
    async ordinaryResponse(s, instance, { budget, corrections = 0 } = {}) {
      requireInstance(s, instance);
      // Never turn a pause, cancellation, or durable human wait back into work.
      if (s.flow.status !== 'running' || s.pending || s.pendingQuestion) return { stop: true };
      const exhausted = !budget || budget.round + 1 >= budget.maxRounds;
      const reason = exhausted ? 'budget_exhausted'
        : budget.finalizing ? 'finalization'
        : corrections >= 2 ? 'completion_correction_limit' : null;
      if (!reason) {
        const feedback = 'Convoy workflow control: no submit_step has been accepted. '
          + 'Continue the unfinished internal work now using the available tools; a plan for a next action does not schedule another execution. '
          + 'Submit only an evidence-supported configured outcome. If progress needs user input or approval, use the existing request mechanism. '
          + 'Do not invent a successful outcome or route unfinished investigation as customer clarification. '
          + 'This continuation uses the same execution and remaining request allowance.';
        event(s, 'completion_continued', { instance, correction: corrections + 1, message: feedback });
        await save();
        return { stop: false, feedback };
      }
      s.flow.status = 'awaiting_submission';
      s.status = 'awaiting_submission';
      attemptStatus(s, 'waiting');
      event(s, 'submission_required', {
        reason, message: 'Investigation incomplete: no submit_step was accepted. The workflow has not advanced.',
      });
      await save();
      return { stop: true };
    },
    async fail(s, instance) { if (s.flow?.instance === instance && !['paused', 'cancelled', 'completed'].includes(s.flow.status)) { s.flow.status = s.status === 'interrupted' ? 'interrupted' : 'failed'; const owner = runOwner(s); if (owner?.attempt?.instance !== instance || owner.attempt.status !== 'uncertain') attemptStatus(s, s.flow.status === 'interrupted' ? 'uncertain' : 'failed'); await save(); } },
    current: s => structuredClone(current(s)),
    async executeAction(s, instance, result = null, signal) { requireInstance(s, instance); if (actionExecutor) return actionExecutor(s, current(s), instance, result, signal); return null; },
  };
}
