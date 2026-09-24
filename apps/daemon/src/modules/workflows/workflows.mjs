import { randomUUID } from 'node:crypto';

const required = (value, label, limit = 6000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`${label} is required (up to ${limit} characters).`);
  return value.trim();
};
const kinds = new Set(['agent', 'human', 'check', 'action', 'branch', 'wait']);
const sessionModes = new Set(['continue', 'new', 'reuse']);
const safeId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);

function normalizeNode(original, index, ids, sessions, seenNewSessions) {
  if (!original || typeof original !== 'object') throw new Error(`Step ${index + 1} is required.`);
  const node = { ...original, id: original.id || `step-${index + 1}`, name: required(original.name, `Step ${index + 1} name`, 120) };
  if (!safeId(node.id) || ids.has(node.id)) throw new Error('Every workflow node needs a unique identifier.');
  if (!kinds.has(node.kind)) throw new Error(`${node.name}: choose agent, human, check, action, branch or wait.`);
  if (node.kind === 'wait') {
    const waitFor = node.waitFor;
    if (!waitFor || !['ticket_message_received', 'ticket_source_updated', 'ticket_updated'].includes(waitFor.event) ||
        !['active_ticket', 'related_ticket', 'linked_development'].includes(waitFor.ticketSource ?? 'active_ticket') ||
        waitFor.relationKind !== undefined && !safeId(waitFor.relationKind) ||
        waitFor.status !== undefined && (typeof waitFor.status !== 'string' || !waitFor.status.trim() || waitFor.status.length > 80))
      throw new Error(`${node.name}: choose a supported ticket event to wait for.`);
    node.waitFor = { event: waitFor.event, ticketSource: waitFor.ticketSource ?? 'active_ticket', ...(waitFor.relationKind ? { relationKind: waitFor.relationKind } : {}), ...(waitFor.status ? { status: waitFor.status } : {}) };
  }
  if (node.kind !== 'branch') node.prompt = required(original.prompt ?? `${node.name} completed by the workflow.`, `Objective for ${node.name}`);
  else if (node.prompt !== undefined) {
    // Branch nodes are evaluated data-only and do not need an objective. The
    // graph editor may serialize that empty field; normalize it away.
    if (node.prompt === '') delete node.prompt;
    else node.prompt = required(node.prompt, `Objective for ${node.name}`);
  }
  node.advance = original.advance ?? 'automatic';
  if (!['automatic', 'manual'].includes(node.advance)) throw new Error(`${node.name}: choose automatic or manual advancement.`);
  delete node.phase;
  if (node.artifact) {
    required(node.artifact.path, 'Artifact path', 200);
    if (/^[\/\\]|\0/.test(node.artifact.path) || node.artifact.path.split(/[\/\\]/).some(x => ['..', '.git', '.convoy', '.codex', '.ssh'].includes(x) || x.startsWith('.env'))) throw new Error(`${node.name}: use a safe relative artifact path.`);
    if (!Array.isArray(node.artifact.headings) || node.artifact.headings.length > 20) throw new Error(`${node.name}: required sections must be a list.`);
    node.artifact.headings.forEach(h => required(h, 'Section heading', 120));
  }
  if (node.kind === 'check' || node.requiresCheck) node.checkCommand = required(node.checkCommand, `${node.name}: exact check command`, 4000);
  if (node.kind === 'action') {
    const operation = node.operation ?? node.action ?? node.boardAction?.type ?? 'inspect_changes';
    if (!['inspect_changes', 'create_ticket', 'create_related_ticket', 'create_development_ticket', 'update_ticket', 'move_ticket', 'set_external_status'].includes(operation)) throw new Error(`${node.name}: unsupported workflow action.`);
    node.operation = operation; if (!node.input && node.boardAction && typeof node.boardAction === 'object') node.input = { boardId: node.boardAction.boardId, columnId: node.boardAction.columnId };
    const input = node.input ?? node.args ?? node.payload;
    if (operation !== 'inspect_changes' && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error(`${node.name}: board action input is required.`);
    if (operation === 'create_ticket' && (typeof input.title !== 'string' || !input.title.trim() || typeof input.projectId !== 'string' || !input.projectId.trim())) throw new Error(`${node.name}: create_ticket needs title and projectId.`);
    if (operation === 'create_development_ticket' && input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim())) throw new Error(`${node.name}: create_development_ticket title must be non-empty text.`);
    if (operation === 'create_related_ticket' && (typeof input.title !== 'string' || !input.title.trim() || input.kind !== undefined && !safeId(input.kind))) throw new Error(`${node.name}: create_related_ticket needs a title and an optional safe relation kind.`);
    if (operation === 'update_ticket' && input.ticketSource !== 'active_ticket' && input.ticketSource !== 'last_created' && input.ticketId === undefined && input.taskId === undefined) throw new Error(`${node.name}: update_ticket needs a ticket target.`);
    if (operation === 'move_ticket' && (typeof input.boardId !== 'string' || (!input.columnId && !input.placement?.columnId))) throw new Error(`${node.name}: move_ticket needs boardId and columnId.`);
    if (operation === 'set_external_status' && (typeof input.connectionId !== 'string' || !input.connectionId || typeof input.status !== 'string' || !input.status || input.evidenceReply !== undefined && input.evidenceReply !== 'latest_delivered'))
      throw new Error(`${node.name}: set_external_status needs a connection, source status, and optional latest_delivered reply evidence.`);
    delete node.action;
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
    if (!Number.isInteger(node.maxRounds) || node.maxRounds < 1 || node.maxRounds > 20) throw new Error(`${node.name}: choose 1–20 agent rounds.`);
    node.skills ??= [];
    if (!Array.isArray(node.skills) || node.skills.length > 30 || node.skills.some(id => typeof id !== 'string')) throw new Error(`${node.name}: invalid skill selection.`);
    if (node.model && (typeof node.model !== 'string' || node.model.length > 100)) throw new Error(`${node.name}: invalid model.`);
  }
  ids.add(node.id); return node;
}

/** Normalize graph definitions and the historical ordered-step input. */
export function normalizeWorkflow(input) {
  if (!input || typeof input !== 'object') throw new Error('Workflow is required.');
  const isLegacy = !Array.isArray(input.nodes); const sourceNodes = isLegacy ? input.steps : input.nodes;
  if (!Array.isArray(sourceNodes) || !sourceNodes.length || sourceNodes.length > 100) throw new Error('Add between 1 and 100 workflow nodes.');
  const value = { id: input.id || randomUUID(), name: required(input.name, 'Workflow name', 120), schemaVersion: 3, nodes: [], edges: [], entryNode: input.entryNode ?? input.startNode, maxRevisions: input.maxRevisions ?? 3 };
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
  const supplied = Array.isArray(input.edges) ? input.edges : [];
  if (supplied.length > 300) throw new Error('A workflow may have at most 300 edges.');
  const edges = supplied.length ? supplied : isLegacy ? value.nodes.slice(0, -1).map((node, index) => ({ from: node.id, to: value.nodes[index + 1].id, outcome: 'success' })) : [];
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
  value.triggers = Array.isArray(input.triggers) ? input.triggers.map((trigger, index) => {
    const event = trigger?.event ?? trigger?.type;
    if (!trigger || typeof trigger !== 'object' || !['ticket_created', 'ticket_updated', 'ticket_moved', 'board_placement_changed', 'ticket_imported', 'ticket_source_updated', 'ticket_message_received'].includes(event)) throw new Error(`Trigger ${index + 1} is invalid.`);
    const value = { ...trigger, event }; delete value.type;
    for (const key of ['boardId', 'columnId', 'bindingId', 'workType', 'projectId']) if (value[key] !== undefined && !safeId(value[key])) throw new Error(`Trigger ${index + 1} has an invalid ${key}.`);
    return value;
  }) : [];
  if (value.triggers.length > 20) throw new Error('A workflow may have at most 20 board triggers.');
  return value;
}

export function ensureAgentSessions(s) {
  s.agentSessions ??= {};
  if (!Object.keys(s.agentSessions).length) { const id = randomUUID(); s.agentSessions[id] = { id, name: 'main', messages: s.messages ?? [], createdAt: new Date().toISOString() }; s.currentAgentSessionId = id; }
  if (!s.currentAgentSessionId || !s.agentSessions[s.currentAgentSessionId]) s.currentAgentSessionId = Object.keys(s.agentSessions)[0];
  return s.agentSessions[s.currentAgentSessionId];
}

export function createWorkflowEngine({ state, save, event, inspectArtifact = async () => ({ text: '', sha256: '' }), captureArtifacts = async (_s, paths) => paths, inspectChanges = async () => null, busy = () => false, launch, abort = () => {}, canProvision = () => false, actionExecutor = null }) {
  let pumping = false; let pumpAgain = false;
  const nodes = s => s.workflow.nodes ?? s.workflow.steps;
  const current = s => { const list = nodes(s); return list.find(n => n.id === s.flow?.nodeId) ?? list[s.step]; };
  function requireInstance(s, instance) { if (!s.flow || s.flow.instance !== instance) throw new Error('This workflow step has changed. Refresh before acting.'); }
  function active(s) { return s.flow && !['completed', 'cancelled'].includes(s.flow.status); }
  function edgeFor(s, outcome) { const node = current(s); const edges = s.workflow.edges.filter(e => e.from === node.id); return edges.find(e => e.outcome === outcome) ?? edges.find(e => e.outcome === '*') ?? edges.find(e => e.outcome === 'default') ?? null; }
  function activate(s, nodeId, outcome = 'success') {
    const list = nodes(s); const index = list.findIndex(n => n.id === nodeId); if (index < 0) throw new Error('Workflow transition references an unknown node.');
    s.step = index; s.flow.nodeId = nodeId; s.flow.instance = randomUUID(); s.flow.validation = null; s.flow.submission = null; s.flow.agentSessionId = null; s.flow.lastOutcome = outcome;
    const node = list[index]; s.flow.status = node.kind === 'human' ? 'waiting_gate' : node.kind === 'wait' ? 'waiting_event' : 'ready'; s.status = s.flow.status;
    event(s, 'step_activated', { runId: s.flow.id, nodeId: node.id, stepId: node.id, instance: s.flow.instance, name: node.name, outcome });
  }
  function transition(s, outcome) {
    const node = current(s); const edge = edgeFor(s, outcome); const latestEvidence = s.flow.evidenceTrail?.at(-1)?.evidence;
    if (latestEvidence) s.flow.previousEvidence = latestEvidence;
    s.flow.previousNodeId = node.id; s.flow.history.push({ nodeId: node.id, instance: s.flow.instance, outcome, at: new Date().toISOString(), to: edge?.to ?? null });
    if (!edge) { if (outcome !== 'success' && outcome !== 'approved') throw new Error(`No workflow edge handles outcome ${outcome} from ${node.name}.`); s.flow.status = 'completed'; s.status = 'accepted'; event(s, 'workflow_completed', { runId: s.flow.id }); return; }
    activate(s, edge.to, outcome);
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
  async function finish(s, summary, artifacts, outcome = 'success') {
    const instance = s.flow.instance; const status = s.flow.status; const node = current(s); if (node.artifact && !artifacts.includes(node.artifact.path)) throw new Error(`Include ${node.artifact.path} in the submission.`);
    // Success/approved may intentionally terminate a graph even when the node
    // only exposes a non-success branch (for example changes_requested).
    if (!edgeFor(s, outcome) && outcome !== 'success' && outcome !== 'approved') throw new Error(`No workflow edge handles outcome ${outcome} from ${node.name}.`);
    if (['changes_requested', 'failed'].includes(outcome) && s.flow.revision >= s.workflow.maxRevisions) throw new Error('Workflow revision limit reached.');
    const evidence = await validate(s, outcome); if (s.flow.instance !== instance || s.flow.status !== status) throw new Error('Workflow changed during validation. Submission was not accepted.');
    const capturedArtifacts = await captureArtifacts(s, artifacts);
    if (s.flow.instance !== instance || s.flow.status !== status) throw new Error('Workflow changed while capturing artifacts. Submission was not accepted.');
    const primaryArtifact = capturedArtifacts.find(artifact => artifact?.path === node.artifact?.path) ?? capturedArtifacts.find(artifact => artifact?.id);
    s.flow.validation = evidence; s.flow.submission = { summary, artifacts }; s.flow.lastSubmission = {
      nodeId: node.id,
      step: node.name,
      summary,
      revision: s.flow.revision + 1,
      ...(primaryArtifact?.id ? { primaryArtifactId: primaryArtifact.id } : {}),
      artifacts: capturedArtifacts,
    };
    if (evidence.artifact || evidence.digest) { s.flow.evidenceTrail ??= []; s.flow.evidenceTrail.push({ nodeId: node.id, instance, evidence }); s.flow.evidenceTrail = s.flow.evidenceTrail.slice(-50); }
    event(s, 'step_submitted', { runId: s.flow.id, nodeId: node.id, stepId: node.id, instance, summary, evidence, outcome });
    if (['changes_requested', 'failed'].includes(outcome)) { s.flow.revision++; s.flow.evidenceTrail = []; event(s, 'evidence_invalidated', { fromNode: node.id, revision: s.flow.revision, outcome }); }
    if (node.advance === 'manual' && outcome === 'success') { s.flow.status = 'awaiting_continue'; s.status = 'awaiting_continue'; }
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
      if (node.waitFor.event !== fact.event) return false;
      s.flow.actionResult = { event: fact.event, ticketId: fact.ticketId, ...(fact.messageId ? { messageId: fact.messageId } : {}) };
      event(s, 'workflow_event_received', { runId: s.flow.id, nodeId: node.id, instance, ...s.flow.actionResult });
      transition(s, 'success');
      await save();
      return true;
    },
    async start(s) {
      if (active(s) || busy(s)) throw new Error('A workflow is already active.'); if (!s.workflow) throw new Error('Select and apply a workflow first.');
      s.workflow = { ...normalizeWorkflow(s.workflow), version: s.workflow.version }; if (s.workflow.nodes.some(node => node.artifact || node.kind === 'check' || node.kind === 'action' && node.operation === 'inspect_changes' || node.requiresCheck) && !s.workspace && !canProvision(s)) throw new Error('This workflow requires a worktree. Select a runner or placement pool first.');
      const main = ensureAgentSessions(s); if (s.flow) { s.pastRuns ??= []; s.pastRuns.push(structuredClone(s.flow)); }
      delete s.boardPhase;
      s.flow = { id: randomUUID(), workflowId: s.workflow.id, workflowVersion: s.workflow.version, model: s.model, status: 'ready', nodeId: null, instance: null, aliases: { main: main.id }, bindings: {}, lastAgent: main.id, agentSessionId: null, revision: 0, history: [], startedAt: new Date().toISOString() };
      event(s, 'workflow_started', { runId: s.flow.id, workflowId: s.workflow.id, version: s.workflow.version }); activate(s, s.workflow.entryNode); await save();
    },
    async pump() {
      if (pumping) { pumpAgain = true; return; } pumping = true;
      try { do { pumpAgain = false; for (const s of Object.values(state.sessions)) { if (s.flow?.status !== 'ready' || busy(s)) continue; const node = current(s); try { if (node.kind === 'agent') resolveSession(s); s.flow.status = 'running'; s.status = 'running'; await save(); if (s.flow.status !== 'running') continue; if (!launch(s, node, s.flow.instance)) { s.flow.status = 'ready'; s.status = 'queued'; await save(); } } catch (e) { s.flow.status = 'failed'; s.status = 'failed'; event(s, 'workflow_failed', { message: e.message }); await save(); } } } while (pumpAgain); } finally { pumping = false; }
    },
    async submit(s, instance, args) {
      requireInstance(s, instance); const node = current(s); if (s.flow.status !== 'running' || node.kind !== 'agent') throw new Error('This agent cannot submit the current step.'); const summary = required(args.summary, 'Completion summary', 4000);
      if (!Array.isArray(args.artifacts) || args.artifacts.length > 20 || args.artifacts.some(x => typeof x !== 'string' || x.length > 200)) throw new Error('Submit artifact paths as a list.'); const outcome = args.outcome ?? 'success'; if (!/^[\w.*:-]{1,80}$/.test(outcome)) throw new Error('Invalid workflow outcome.');
      try { return await finish(s, summary, args.artifacts, outcome); } catch (e) { event(s, 'submission_rejected', { instance, message: e.message }); await save(); throw e; }
    },
    async finishAutomated(s, instance, outcome = 'success', result = null) { requireInstance(s, instance); if (s.flow.status !== 'running') throw new Error('Workflow is no longer running.'); const node = current(s); if (result) s.flow.actionResult = result; return finish(s, `${node.name} completed`, node.artifact ? [node.artifact.path] : [], outcome); },
    async decide(s, command) {
      requireInstance(s, command.instance);
      // A submitted agent has already yielded control when the gate/evidence is
      // published; its runner promise may still be unwinding persistence. Do not
      // make the human race that cleanup job, but keep active agent turns fenced.
      if (busy(s) && !['waiting_gate', 'awaiting_continue', 'awaiting_submission'].includes(s.flow.status)) throw new Error('Wait for the current agent turn to finish.');
      const node = current(s);
      if (command.action === 'reviseSubmission' && s.flow.status === 'awaiting_continue') { event(s, 'evidence_invalidated', { instance: s.flow.instance }); activate(s, node.id, 'revision'); await save(); return; }
      if (s.flow.status === 'waiting_gate') {
        if (command.action === 'requestChanges') { const feedback = required(command.feedback, 'Review feedback'); if (!edgeFor(s, 'changes_requested')) throw new Error('This gate has no revision path. Configure an outcome edge for changes_requested.'); s.flow.feedback = feedback; await finish(s, `Changes requested: ${feedback}`, [], 'changes_requested'); return; }
        if (command.action !== 'approveGate') throw new Error('This step needs a human workflow decision.');
        if (s.flow.previousEvidence?.artifact?.hash) {
          const file = await inspectArtifact(s, s.flow.previousEvidence.artifact.path);
          if (!file || file.sha256 !== s.flow.previousEvidence.artifact.hash) throw new Error('Submitted evidence changed. Request a fresh submission before approving.');
        }
        if (s.flow.previousEvidence?.digest && s.workspace) {
          const review = await inspectChanges(s, s.flow.previousEvidence.artifact?.path);
          if (!review || review.digest !== s.flow.previousEvidence.digest) throw new Error('Submitted evidence changed. Request a fresh submission before approving.');
        }
        await finish(s, 'Human approved', [], 'approved'); event(s, 'gate_approved', { instance: command.instance, actor: command.actor ?? s.lease?.label }); await save(); return;
      }
      if (command.action !== 'continueWorkflow') throw new Error('There is no pending workflow gate.');
      if (s.flow.status === 'awaiting_continue') { const instance = s.flow.instance; const expectedStatus = s.flow.status; const evidence = await validate(s); requireInstance(s, instance); if (s.flow.status !== expectedStatus || JSON.stringify(evidence.artifact) !== JSON.stringify(s.flow.validation?.artifact) || evidence.digest !== s.flow.validation?.digest) throw new Error('Submitted evidence changed. Request a fresh submission before advancing.'); event(s, 'step_completed', { instance, actor: s.lease?.label, evidence, outcome: 'success' }); transition(s, 'success'); }
      else if (['paused', 'interrupted', 'failed', 'awaiting_submission'].includes(s.flow.status)) { const resume = s.flow.resumeStatus; s.flow.status = ['awaiting_continue', 'waiting_gate', 'waiting_event'].includes(resume) ? resume : 'ready'; s.flow.resumeStatus = null; s.status = s.flow.status; }
      else throw new Error('This workflow is not waiting to continue.'); await save();
    },
    async pause(s, cancel = false) { if (!active(s)) throw new Error('No active workflow.'); if (s.flow.status === 'paused' && !cancel) return; s.flow.resumeStatus = s.flow.status; s.flow.status = cancel ? 'cancelled' : 'paused'; s.status = s.flow.status; event(s, cancel ? 'workflow_cancelled' : 'workflow_paused', { instance: s.flow.instance }); abort(s); await save(); },
    async ordinaryResponse(s, instance) { requireInstance(s, instance); s.flow.status = 'awaiting_submission'; s.status = 'awaiting_submission'; event(s, 'submission_required', { message: 'Agent replied without submit_step. The workflow has not advanced.' }); await save(); },
    async fail(s, instance) { if (s.flow?.instance === instance && !['paused', 'cancelled', 'completed'].includes(s.flow.status)) { s.flow.status = s.status === 'interrupted' ? 'interrupted' : 'failed'; await save(); } },
    async executeAction(s, instance, result = null) { requireInstance(s, instance); if (actionExecutor) return actionExecutor(s, current(s), instance, result); return null; },
  };
}
