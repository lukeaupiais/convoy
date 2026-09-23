import { createHash, randomUUID } from 'node:crypto';

const events = new Set(['ticket_created', 'ticket_updated', 'ticket_moved', 'board_placement_changed', 'ticket_imported', 'ticket_source_updated', 'ticket_message_received']);
const idPattern = /^[A-Za-z0-9][\w-]{0,79}$/;

export function workflowForProject(state, id, version, projectId) {
  const project = state.projects?.find((item) => item.id === projectId);
  const workflow = state.workflows?.find((item) => item.id === id && item.version === version);
  if (!project || !workflow || workflow.organizationId !== project.organizationId ||
      workflow.projectId && workflow.projectId !== projectId ||
      workflow.teamId && workflow.teamId !== project.teamId)
    throw new Error('Workflow is not available for this project.');
  return workflow;
}

export function migrateWorkflowStartRules(state) {
  state.workflowStartRules ??= [];
  if (state.workflowStartRulesMigrated) return;
  const latest = [...new Map((state.workflows ?? []).map((value) => [value.id, value])).values()];
  for (const workflow of latest) {
    for (const [index, trigger] of (workflow.triggers ?? []).entries()) {
      const board = state.boards?.find((value) => value.id === trigger.boardId);
      const projects = (state.projects ?? []).filter((project) =>
        project.organizationId === workflow.organizationId &&
        (!workflow.projectId || workflow.projectId === project.id) &&
        (!workflow.teamId || workflow.teamId === project.teamId) &&
        (!trigger.projectId || trigger.projectId === project.id) &&
        (!board || board.projectIds?.includes(project.id)));
      for (const project of projects) {
        const key = `${workflow.id}:${workflow.version}:${index}:${project.id}`;
        const id = `legacy-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
        if (state.workflowStartRules.some((rule) => rule.id === id)) continue;
        state.workflowStartRules.push({
          id, name: `${workflow.name} · ${trigger.event.replaceAll('_', ' ')}`,
          organizationId: project.organizationId, projectId: project.id,
          workflowId: workflow.id, workflowVersion: workflow.version,
          event: trigger.event, ...(trigger.boardId ? { boardId: trigger.boardId } : {}),
          ...(trigger.columnId ? { columnId: trigger.columnId } : {}),
          ...(trigger.bindingId ? { bindingId: trigger.bindingId } : {}),
          ...(trigger.workType ? { workType: trigger.workType } : {}),
          // Existing personal automations retain their authority. Other tenants
          // must choose a governed principal before automatic execution resumes.
          enabled: project.organizationId === 'personal',
          principal: project.organizationId === 'personal' ? { kind: 'user', userId: 'local' } : null,
          revision: 1, migratedFrom: { workflowId: workflow.id, triggerIndex: index },
        });
      }
    }
  }
  state.workflowStartRulesMigrated = true;
}

export function createWorkflowStartRules({ state, save, authorizeRule = async () => {} }) {
  migrateWorkflowStartRules(state);
  return {
    validate(rule) {
      workflowForProject(state, rule.workflowId, rule.workflowVersion, rule.projectId);
      if (rule.bindingId) {
        const binding = state.ticketImportBindings?.find((value) => value.id === rule.bindingId);
        if (!binding || binding.projectId !== rule.projectId) throw new Error('Start automation import binding is no longer available.');
      }
      if (!rule.boardId) return;
      const board = state.boards.find((value) => value.id === rule.boardId);
      if (!board || !board.projectIds.includes(rule.projectId) ||
          rule.columnId && !board.columns.some((column) => column.id === rule.columnId))
        throw new Error('Start automation board binding is no longer available.');
    },
    snapshot(scope) {
      return (state.workflowStartRules ?? []).filter((rule) =>
        (!scope?.organizationId || rule.organizationId === scope.organizationId) &&
        (!scope?.projectIds || scope.projectIds.includes(rule.projectId)));
    },
    async save(command, principal) {
      const input = command.rule;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Start automation is required.');
      const id = input.id ?? randomUUID();
      if (!idPattern.test(id)) throw new Error('Invalid start automation ID.');
      const previous = state.workflowStartRules.find((rule) => rule.id === id);
      if (previous && previous.projectId !== input.projectId) throw new Error('Start automation project cannot change.');
      if ((command.revision ?? 0) !== (previous?.revision ?? 0)) throw new Error('Start automation changed. Reload before saving.');
      const project = state.projects.find((value) => value.id === input.projectId);
      if (!project || project.organizationId !== command.organizationId) throw new Error('Start automation project is unavailable.');
      if (!events.has(input.event)) throw new Error('Choose a supported start event.');
      if (input.boardId && !['ticket_moved', 'board_placement_changed'].includes(input.event))
        throw new Error('Only board placement events can select a board.');
      if (input.bindingId && !['ticket_imported', 'ticket_source_updated', 'ticket_message_received'].includes(input.event))
        throw new Error('Only import events can select an import binding.');
      if (input.workType && !idPattern.test(input.workType)) throw new Error('Invalid start automation work type.');
      if (['ticket_imported', 'ticket_source_updated', 'ticket_message_received'].includes(input.event) && !input.bindingId)
        throw new Error('Choose an import binding for this start event.');
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Name the start automation.');
      if (!Number.isInteger(input.workflowVersion) || input.workflowVersion < 1) throw new Error('Choose a published workflow version.');
      workflowForProject(state, input.workflowId, input.workflowVersion, project.id);
      if (input.boardId) {
        const board = state.boards.find((value) => value.id === input.boardId);
        if (!board || !board.projectIds.includes(project.id)) throw new Error('Board is not available for this project.');
        if (input.columnId && !board.columns.some((column) => column.id === input.columnId)) throw new Error('Board column was not found.');
      } else if (input.columnId) throw new Error('Choose a board before a column.');
      if (input.bindingId) {
        const binding = state.ticketImportBindings?.find((value) => value.id === input.bindingId);
        if (!binding || binding.projectId !== project.id) throw new Error('Import binding is not available for this project.');
      }
      if (input.columnId && !['ticket_moved', 'board_placement_changed'].includes(input.event)) throw new Error('Column entry requires a board placement event.');
      const actor = previous?.principal ?? principal;
      if (input.enabled && (!actor || actor.kind !== 'user' && actor.kind !== 'workload')) throw new Error('Enabled automation needs a governed principal.');
      if (input.enabled) await authorizeRule(project.id, actor);
      const rule = {
        id, name: input.name.trim(), organizationId: project.organizationId,
        projectId: project.id, event: input.event,
        ...(input.boardId ? { boardId: input.boardId } : {}),
        ...(input.columnId ? { columnId: input.columnId } : {}),
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        ...(input.workType ? { workType: input.workType } : {}),
        workflowId: input.workflowId, workflowVersion: input.workflowVersion,
        enabled: Boolean(input.enabled), principal: actor,
        revision: (previous?.revision ?? 0) + 1,
        ...(previous?.migratedFrom ? { migratedFrom: previous.migratedFrom } : {}),
      };
      if (previous) Object.assign(previous, rule);
      else state.workflowStartRules.push(rule);
      await save();
      return structuredClone(rule);
    },
    matches(rule, fact) {
      if (!rule.enabled || rule.projectId !== fact.projectId || rule.event !== fact.event) return false;
      if (rule.boardId && rule.boardId !== fact.boardId) return false;
      if (rule.bindingId && rule.bindingId !== fact.bindingId) return false;
      if (rule.workType && rule.workType !== fact.workType) return false;
      if (rule.columnId && !(fact.toColumnId === rule.columnId && fact.fromColumnId !== rule.columnId)) return false;
      return true;
    },
  };
}
