import { randomUUID } from 'node:crypto';

const idPattern = /^[A-Za-z0-9][\w-]{0,79}$/;
export function workflowForProject(state, id, version, projectId) {
  const project = state.projects?.find(item => item.id === projectId);
  const workflow = state.workflows?.find(item => item.id === id && item.version === version);
  if (!project || !workflow || workflow.organizationId !== project.organizationId ||
      workflow.projectId && workflow.projectId !== projectId || workflow.teamId && workflow.teamId !== project.teamId)
    throw new Error('Workflow is not available for this project.');
  return workflow;
}

export function initializeAutomations(state) {
  if (state.workflowStartRules || state.workflowTriggerLedger || state.workflows?.some(w => w.triggers?.length))
    throw new Error('Automation schema requires offline migration. Run scripts/migrate-automations.mjs.');
  if (state.automationSchemaVersion !== undefined && state.automationSchemaVersion !== 1)
    throw new Error('Unsupported automation schema version.');
  state.automationSchemaVersion = 1;
  state.automations ??= [];
}

export function createAutomations({ state, save, capabilities, authorizeRule = async () => {} }) {
  initializeAutomations(state);
  function validate(rule) {
    if (!rule.when || !rule.then || !Array.isArray(rule.if) || rule.then.action !== 'start_workflow')
      throw new Error('Automation requires When, If and Then.');
    if (['event','boardId','columnId','bindingId','workType','workflowId','workflowVersion','migratedFrom'].some(key => Object.hasOwn(rule,key)))
      throw new Error('Legacy automation fields are not supported.');
    if (Object.keys(rule.when).some(key => !['event','boardId','columnId','bindingId'].includes(key)) || Object.keys(rule.then).some(key => !['action','workflowId','workflowVersion'].includes(key))) throw new Error('Unsupported automation fields.');
    const event = capabilities.events.find(value => value.id === rule.when.event);
    if (!event) throw new Error('Unsupported automation event.');
    if (rule.if.length > 20 || rule.if.some(condition => !event.fields.includes(condition.field) || condition.operator !== 'equals' || typeof condition.value !== 'string' || Object.keys(condition).some(key => !['field','operator','value'].includes(key))))
      throw new Error('Unsupported automation condition.');
    workflowForProject(state, rule.then.workflowId, rule.then.workflowVersion, rule.projectId);
    if (!Number.isInteger(rule.then.workflowVersion) || rule.then.workflowVersion < 1) throw new Error('Choose a published workflow version.');
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
      const rule = { id, name: input.name.trim(), organizationId: project.organizationId, projectId: project.id,
        when: structuredClone(input.when), if: structuredClone(input.if), then: structuredClone(input.then),
        enabled: Boolean(input.enabled), principal: actor, revision: (previous?.revision ?? 0) + 1 };
      if (previous) Object.assign(previous, rule); else state.automations.push(rule);
      await save(); return structuredClone(rule);
    },
    matches(rule, fact) {
      if (!rule.enabled || rule.projectId !== fact.projectId || rule.when.event !== fact.event) return false;
      if (rule.when.bindingId && rule.when.bindingId !== fact.bindingId) return false;
      if (rule.when.boardId && rule.when.boardId !== fact.boardId) return false;
      if (rule.when.columnId && !(fact.toColumnId === rule.when.columnId && fact.fromColumnId !== rule.when.columnId)) return false;
      return rule.if.every(condition => fact[condition.field] === condition.value);
    },
  };
}
