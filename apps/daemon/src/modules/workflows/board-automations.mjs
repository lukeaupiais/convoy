import { workflowActionInput } from './action-input.mjs';

const key = value => JSON.stringify([value.id, value.version]);

/** Derive semantic references from authorized owner snapshots, never board names. */
export function boardAutomationRelationships({ boards, projects, workflows, rules, decisions = [], resolveEffect, eventLabels = {} }) {
  const definitions = new Map(workflows.map(value => [key(value), value]));
  const latest = new Map();
  for (const value of workflows) {
    if (!latest.has(value.id) || latest.get(value.id).version < value.version) latest.set(value.id, value);
  }
  const eligible = (workflow, projectId) => {
    const project = projects.find(value => value.id === projectId);
    return project && workflow.organizationId === project.organizationId &&
      (!workflow.projectId || workflow.projectId === project.id) &&
      (!workflow.teamId || workflow.teamId === project.teamId);
  };
  const allowedRules = rules.filter(rule => projects.some(project =>
    project.id === rule.projectId && project.organizationId === rule.organizationId));
  const pinned = new Set(allowedRules.map(rule => key({ id: rule.then.workflowId, version: rule.then.workflowVersion })));
  const candidates = workflows.filter(workflow =>
    projects.some(project => eligible(workflow, project.id)) &&
    (latest.get(workflow.id) === workflow || pinned.has(key(workflow))));
  return Object.fromEntries(boards.map(board => {
    const relationships = [];
    for (const rule of allowedRules) {
      if (!board.projectIds.includes(rule.projectId) || rule.when.boardId && rule.when.boardId !== board.id) continue;
      const workflow = definitions.get(key({ id: rule.then.workflowId, version: rule.then.workflowVersion }));
      if (workflow && !eligible(workflow, rule.projectId)) continue;
      const decision = decisions.filter(value => value.ruleId === rule.id &&
        definitions.has(key({ id: value.workflowId, version: value.workflowVersion })))
        .sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
      relationships.push({
        kind: 'start_rule', scope: rule.when.columnId ? 'column' : rule.when.boardId ? 'board' : 'project',
        workflowId: rule.then.workflowId, workflowVersion: rule.then.workflowVersion,
        ...(workflow ? { workflowName: workflow.name } : {}),
        available: Boolean(workflow), olderVersion: Boolean(workflow && latest.get(workflow.id)?.version !== workflow.version),
        projectId: rule.projectId, boardId: rule.when.boardId, columnId: rule.when.columnId,
        ruleId: rule.id, ruleRevision: rule.revision, name: rule.name, label: rule.when.columnId ? `Enters ${board.columns.find(c => c.id === rule.when.columnId)?.name ?? 'unavailable column'}` : eventLabels[rule.when.event] ?? 'Unsupported event', event: rule.when.event, enabled: rule.enabled,
        ...(decision ? { decision: {
          triggerKey: decision.triggerKey, status: decision.status, ruleRevision: decision.ruleRevision,
          workflowId: decision.workflowId, workflowVersion: decision.workflowVersion,
          ticketId: decision.ticketId, at: decision.at,
        } } : {}),
      });
    }
    for (const workflow of candidates) {
      if (!board.projectIds.some(projectId => eligible(workflow, projectId))) continue;
      for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
        if (node.kind !== 'action') continue;
        const destination = resolveEffect?.({ operation: node.operation, input: workflowActionInput(node), board, projectId: workflow.projectId });
        if (!destination) continue;
        relationships.push({
          kind: 'effect', scope: destination.columnId ? 'column' : 'board', workflowId: workflow.id, workflowVersion: workflow.version,
          workflowName: workflow.name, available: true,
          olderVersion: latest.get(workflow.id)?.version !== workflow.version,
          projectId: workflow.projectId, ...destination, nodeId: node.id, name: node.name,
          operation: node.operation,
          referencedBy: allowedRules.filter(rule => rule.then.workflowId === workflow.id && rule.then.workflowVersion === workflow.version)
            .map(rule => ({ ruleId: rule.id, name: rule.name, projectId: rule.projectId,
              ...(boards.some(value => value.id === rule.when.boardId) ? { boardId: rule.when.boardId, columnId: rule.when.columnId } : {}) })),
        });
      }
    }
    return [board.id, { boardId: board.id, boardRevision: board.revision, relationships }];
  }));
}
