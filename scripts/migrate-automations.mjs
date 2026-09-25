import { isDeepStrictEqual } from 'node:util';
import { readFile, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSqliteStore } from '../apps/daemon/src/adapters/persistence/sqlite-store.mjs';
import { normalizeWorkflow, createAutomations } from '../apps/daemon/src/modules/workflows/index.mjs';
import { workAutomationCapabilities } from '../apps/daemon/src/modules/work/index.mjs';

/** One-time offline conversion. Runtime never imports this module. */
export function migrateAutomationState(original, { relatedDestinations = {}, supportWorkflowId, diagnostics = [] } = {}) {
  if (original.automationSchemaVersion === 1) throw new Error('State is already migrated.');
  const state = structuredClone(original);
  const rules = state.workflowStartRules ?? [];
  for (const workflow of state.workflows ?? []) {
    if (workflow.triggers?.length && !state.workflowStartRulesMigrated)
      throw new Error(`Unmaterialized embedded triggers in ${workflow.id}; provide explicit automation rules before migration.`);
  }
  state.automations = rules.map(rule => ({
    id: rule.id, name: rule.name, organizationId: rule.organizationId, projectId: rule.projectId,
    when: { event: rule.event, ...Object.fromEntries(['boardId','columnId','bindingId'].filter(k => rule[k] !== undefined).map(k => [k,rule[k]])) },
    if: rule.workType ? [{ field: 'workType', operator: 'equals', value: rule.workType }] : [],
    then: { action: 'start_workflow', workflowId: rule.workflowId, workflowVersion: rule.workflowVersion },
    enabled: rule.enabled, principal: rule.principal, revision: rule.revision,
  }));
  state.automationDecisionLedger = state.workflowTriggerLedger ?? {};
  state.automationFailures = state.workflowTriggerFailures ?? [];
  delete state.workflowStartRules; delete state.workflowStartRulesMigrated;
  delete state.workflowTriggerLedger; delete state.workflowTriggerFailures;
  const required = new Set(state.automations.map(rule => `${rule.then.workflowId}@${rule.then.workflowVersion}`));
  for (const session of Object.values(state.sessions ?? {})) if (session.flow && !['completed','cancelled'].includes(session.flow.status)) required.add(`${session.workflow?.id}@${session.workflow?.version}`);
  for (const workflow of state.workflows ?? []) if (!state.workflows.some(other => other.id === workflow.id && other.version > workflow.version)) required.add(`${workflow.id}@${workflow.version}`);
  function convert(workflow) {
    if (!workflow) return;
    const ordered = !Array.isArray(workflow.nodes);
    workflow.nodes ??= workflow.steps;
    delete workflow.triggers;
    for (const node of workflow.nodes ?? []) {
      if (node.waitFor?.ticketSource === 'linked_development') node.waitFor = { ...node.waitFor, ticketSource: 'related_ticket', relationKind: 'escalation' };
      if (node.kind !== 'action') continue;
      node.operation ??= node.action ?? node.boardAction?.type ?? 'inspect_changes';
      node.input ??= node.args ?? node.payload ?? (node.boardAction ? { boardId: node.boardAction.boardId, columnId: node.boardAction.columnId } : {});
      delete node.args; delete node.payload; delete node.boardAction; delete node.action;
      if (node.operation === 'move_ticket' && !node.input.placement && node.input.columnId)
        node.input.placement = { columnId: node.input.columnId, ...(node.input.swimlaneKey ? { swimlaneKey: node.input.swimlaneKey } : {}) };
      if (node.operation === 'move_ticket') { delete node.input.columnId; delete node.input.swimlaneKey; }
      if (node.operation === 'create_development_ticket') {
        const destination = relatedDestinations[workflow.id];
        if (!destination) throw new Error(`Explicit related-ticket destination required for ${workflow.id}.`);
        node.operation = 'create_related_ticket';
        node.input = { ...destination, ...node.input };
      }
    }
    workflow.steps = workflow.nodes;
    try { const input = { ...workflow }; if (ordered) delete input.nodes; Object.assign(workflow, normalizeWorkflow(input)); } catch (error) { if (required.has(`${workflow.id}@${workflow.version}`)) throw new Error(`${workflow.id} v${workflow.version}: ${error.message}`); diagnostics.push(`${workflow.id} v${workflow.version}: retained historical validation error: ${error.message}`); }
  }
  for (const workflow of state.workflows ?? []) convert(workflow);
  for (const draft of Object.values(state.workflowDrafts ?? {})) convert(draft.workflow);
  for (const session of Object.values(state.sessions ?? {})) convert(session.workflow);
  if (supportWorkflowId) {
    const versions = state.workflows.filter(w => w.id === supportWorkflowId);
    const latest = versions.sort((a,b) => b.version-a.version)[0];
    if (!latest) throw new Error('Support workflow not found.');
    const next = structuredClone(latest); next.version++;
    for (const node of next.nodes) if (node.operation === 'set_external_status') node.name = 'Set Waiting on user';
    next.steps = next.nodes;
    state.workflows.push(next);
    for (const rule of state.automations) if (rule.then.workflowId === supportWorkflowId) {
      rule.then.workflowVersion = next.version; rule.revision++;
    }
  }
  state.ticketRelations ??= [];
  for (const link of state.ticketDevelopmentLinks ?? []) {
    if (!state.ticketRelations.some(r => r.sourceTicketId === link.supportTicketId && r.targetTicketId === link.developmentTicketId))
      state.ticketRelations.push({ id: link.id, sourceTicketId: link.supportTicketId, targetTicketId: link.developmentTicketId, kind: 'escalation', createdAt: link.createdAt });
  }
  for (const relation of state.ticketRelations) if (relation.kind === 'legacy-development') relation.kind = 'escalation';
  delete state.ticketDevelopmentLinks; delete state.ticketRelationsMigrated;
  state.automationSchemaVersion = 1;
  const automations = createAutomations({ state, save: async () => {}, capabilities: workAutomationCapabilities });
  for (const rule of state.automations) automations.validate(rule);
  return state;
}

async function main() {
  const args = process.argv.slice(2);
  const directory = resolve(args[0] ?? '.convoy');
  const apply = args.includes('--apply');
  const configIndex = args.indexOf('--config');
  const config = configIndex >= 0 ? JSON.parse(await readFile(args[configIndex+1],'utf8')) : {};
  // Stale locks also require an explicit operator resolution; never guess liveness.
  try { await stat(join(directory,'daemon.lock')); throw new Error('Stop the daemon and resolve its lock before migration.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runtime = join(directory,'runtime');
  const marker = JSON.parse(await readFile(join(runtime,'storage.json'),'utf8'));
  if (marker.backend !== 'sqlite') throw new Error('This offline local migration requires SQLite.');
  const store = await createSqliteStore(runtime, {}, marker.storeId, true);
  let closed = false;
  try {
    const diagnostics = [];
    const next = migrateAutomationState(store.data, { ...config, diagnostics });
    console.log(JSON.stringify({ dryRun: !apply, diagnostics, automations: next.automations.length, workflows: next.workflows.length, sessions: Object.keys(next.sessions ?? {}).length }));
    if (!apply) return;
    // Caller must take a full deployment backup; this is an additional exact-state checkpoint.
    const backup = join(runtime, `state.pre-automations-${Date.now()}.sqlite`);
    await store.close(); closed = true;
    await copyFile(join(runtime,'state.sqlite'),backup);
    const writer = await createSqliteStore(runtime, {}, marker.storeId, true);
    try {
      for (const key of Object.keys(writer.data)) delete writer.data[key];
      Object.assign(writer.data,next); await writer.save();
    } finally { await writer.close(); }
    const verify = await createSqliteStore(runtime, {}, marker.storeId, true);
    try { if (!isDeepStrictEqual(verify.data,next)) throw new Error('Migration read-back mismatch.'); }
    finally { await verify.close(); }
    console.log(`Migrated. Backup: ${backup}`);
  } finally { if (!closed) await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
