import type { WorkflowDefinition, WorkflowStep } from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';

export type NodeKind = 'agent' | 'check' | 'approval' | 'action' | 'branch' | 'wait';
export type SessionMode = 'continue' | 'new' | 'reuse';
export type ActionOperation =
  | 'inspect_changes'
  | 'create_ticket'
  | 'create_related_ticket'
  | 'set_external_status'
  | 'send_external_reply'
  | 'update_ticket'
  | 'move_ticket';
export type ConditionSource = 'ticket' | 'submission' | 'actionResult' | 'context';
export type ConditionOperator = 'equals' | 'notEquals' | 'exists';
export type ConditionValueType = 'text' | 'number' | 'boolean' | 'null';
export type Artifact = { path: string; headings: string[] };
export type PresentationBinding = NonNullable<WorkflowStep['presentationBindings']>[number];
export type DecisionLabels = NonNullable<WorkflowStep['decisionLabels']>;
export type Condition = {
  source: ConditionSource;
  field: string;
  operator: ConditionOperator;
  value: string;
  valueType: ConditionValueType;
  trueOutcome: string;
  falseOutcome: string;
};
export type ActionInput = Record<string, unknown>;
export type GraphNode = {
  id: string;
  type: NodeKind;
  name: string;
  prompt: string;
  x: number;
  y: number;
  advance?: 'automatic' | 'manual';
  decisionLabels?: DecisionLabels;
  artifact?: Artifact;
  presentationBindings?: PresentationBinding[];
  requiresCheck?: boolean;
  checkCommand?: string;
  operation?: ActionOperation;
  input?: ActionInput;
  condition?: Condition;
  waitFor?: {
    event: 'ticket_message_received' | 'ticket_source_updated' | 'ticket_updated';
    ticketSource: 'active_ticket' | 'related_ticket';
    relationKind?: string;
    status?: string;
  };
  session?: { mode: SessionMode; name?: string; target?: string };
  permissions?: string;
  maxRounds?: number;
  finalizationRounds?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  summaryHeadings?: string[];
  submissionRequirements?: WorkflowStep['submissionRequirements'];
  skills?: string[];
  model?: string;
  outcomes?: string[];
};
export type GraphEdge = { id: string; from: string; to: string; outcome: string };
export type BoardSummary = { id: string; name: string; columns?: { id: string; name: string }[] };
export type GraphWorkflow = {
  runtime?: WorkflowDefinition['runtime'];
  capabilityProfile?: WorkflowDefinition['capabilityProfile'];
  id: string;
  name: string;
  version?: number;
  schemaVersion?: number;
  steps?: WorkflowStep[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryNode?: string;
  maxRevisions: number;
};

export function canAddPresentationBinding(
  bindings: PresentationBinding[],
  availableDetailFields: string[],
): boolean {
  if (bindings.length >= 12) return false;
  return (
    !bindings.some((binding) => binding.source === 'summary') ||
    availableDetailFields.length > 0 ||
    !bindings.some((binding) => binding.source === 'artifact')
  );
}

export const kindLabels: Record<NodeKind, string> = {
  agent: 'Agent',
  check: 'Check',
  approval: 'Approval',
  action: 'Action',
  branch: 'Branch',
  wait: 'Wait for event',
};
export const outcomesFor = (node: GraphNode): string[] =>
  node.type === 'branch'
    ? node.condition
      ? [node.condition.trueOutcome || 'true', node.condition.falseOutcome || 'false']
      : node.outcomes?.length
        ? node.outcomes
        : ['yes', 'no']
    : node.type === 'approval'
      ? ['approved', 'changes_requested']
      : node.type === 'check'
        ? ['success', 'failed']
        : ['success'];

export function workflowStageOrder(workflow: GraphWorkflow): {
  mainPath: GraphNode[];
  otherRoutes: GraphNode[];
} {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const mainPath: GraphNode[] = [];
  const seen = new Set<string>();
  let next = workflow.entryNode;
  while (next && byId.has(next) && !seen.has(next)) {
    const node = byId.get(next)!;
    mainPath.push(node);
    seen.add(next);
    next =
      workflow.edges.find((edge) => edge.from === node.id && edge.outcome === outcomesFor(node)[0])
        ?.to ?? '';
  }
  return { mainPath, otherRoutes: workflow.nodes.filter((node) => !seen.has(node.id)) };
}

export function reorderWorkflowStages(
  workflow: GraphWorkflow,
  orderedIds: string[],
): GraphWorkflow {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  if (
    orderedIds.length !== workflow.nodes.length ||
    new Set(orderedIds).size !== workflow.nodes.length ||
    orderedIds.some((id) => !byId.has(id))
  )
    return workflow;
  const primary = new Map(
    workflow.nodes.map((node) => [node.id, outcomesFor(node)[0] ?? 'success']),
  );
  const preserved = workflow.edges.filter((edge) => edge.outcome !== primary.get(edge.from));
  const primaryEdges = orderedIds.slice(0, -1).map((from, index) => ({
    id: newId(),
    from,
    to: orderedIds[index + 1],
    outcome: primary.get(from) ?? 'success',
  }));
  return {
    ...workflow,
    entryNode: orderedIds[0] ?? workflow.entryNode,
    nodes: orderedIds.map((id) => byId.get(id)!),
    edges: [...preserved, ...primaryEdges],
  };
}

export function insertWorkflowStage(
  workflow: GraphWorkflow,
  afterId: string | null,
  node: GraphNode,
): GraphWorkflow {
  if (!afterId) {
    const oldEntry = workflow.entryNode;
    return {
      ...workflow,
      entryNode: node.id,
      nodes: [node, ...workflow.nodes],
      edges: oldEntry
        ? [
            ...workflow.edges,
            {
              id: newId(),
              from: node.id,
              to: oldEntry,
              outcome: outcomesFor(node)[0] ?? 'success',
            },
          ]
        : workflow.edges,
    };
  }
  const index = workflow.nodes.findIndex((candidate) => candidate.id === afterId);
  const source = workflow.nodes[index];
  if (!source || workflow.nodes.some((candidate) => candidate.id === node.id)) return workflow;
  const primaryOutcome = outcomesFor(source)[0] ?? 'success';
  const oldEdge = workflow.edges.find(
    (edge) => edge.from === source.id && edge.outcome === primaryOutcome,
  );
  const preserved = workflow.edges.filter((edge) => edge !== oldEdge);
  const edges: GraphEdge[] = [
    ...preserved,
    { id: newId(), from: source.id, to: node.id, outcome: primaryOutcome },
  ];
  if (oldEdge)
    edges.push({
      id: newId(),
      from: node.id,
      to: oldEdge.to,
      outcome: outcomesFor(node)[0] ?? 'success',
    });
  return {
    ...workflow,
    nodes: [...workflow.nodes.slice(0, index + 1), node, ...workflow.nodes.slice(index + 1)],
    edges,
  };
}

export function fresh(type: NodeKind = 'agent', index = 0): GraphNode {
  const common = {
    id: newId(),
    type,
    name: kindLabels[type],
    prompt: '',
    x: 80 + index * 340,
    y: 80,
    advance: 'automatic' as const,
  };
  if (type === 'agent')
    return {
      ...common,
      prompt: 'Describe the work this agent must complete.',
      session: { mode: 'continue' },
      permissions: 'read-write',
      maxRounds: 12,
      skills: [],
    };
  if (type === 'check')
    return {
      ...common,
      prompt: 'Verify the change against the acceptance criteria.',
      checkCommand: '',
      requiresCheck: true,
    };
  if (type === 'approval')
    return {
      ...common,
      prompt: 'Review the preceding result and choose whether to approve it.',
      advance: 'manual',
    };
  if (type === 'action')
    return {
      ...common,
      prompt: 'Perform this explicit board operation.',
      operation: 'inspect_changes',
      input: {},
    };
  if (type === 'wait')
    return {
      ...common,
      prompt: 'Wait for the selected ticket event.',
      waitFor: { event: 'ticket_message_received', ticketSource: 'active_ticket' },
    };
  return {
    ...common,
    prompt: '',
    condition: {
      source: 'ticket',
      field: 'status',
      operator: 'equals',
      value: 'Done',
      valueType: 'text',
      trueOutcome: 'yes',
      falseOutcome: 'no',
    },
    outcomes: ['yes', 'no'],
  };
}

function inferConditionValue(raw: unknown): Pick<Condition, 'value' | 'valueType'> {
  if (raw === null) return { value: '', valueType: 'null' };
  if (typeof raw === 'number' && Number.isFinite(raw))
    return { value: String(raw), valueType: 'number' };
  if (typeof raw === 'boolean') return { value: raw ? 'true' : 'false', valueType: 'boolean' };
  return { value: typeof raw === 'string' ? raw : '', valueType: 'text' };
}

function encodeConditionValue(condition: Condition): unknown {
  if (condition.operator === 'exists') return condition.value !== 'false';
  if (condition.valueType === 'null') return null;
  if (condition.valueType === 'boolean') return condition.value === 'true';
  if (condition.valueType === 'number') {
    const number = Number(condition.value);
    return Number.isFinite(number) ? number : condition.value;
  }
  return condition.value;
}

export function safeNode(raw: unknown, index: number): GraphNode {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const rawType = String(value.type ?? value.kind ?? 'agent');
  const type: NodeKind =
    rawType === 'human'
      ? 'approval'
      : ['agent', 'check', 'approval', 'action', 'branch', 'wait'].includes(rawType)
        ? (rawType as NodeKind)
        : 'agent';
  const node = fresh(type, index);
  const session =
    value.session && typeof value.session === 'object'
      ? (value.session as Record<string, unknown>)
      : undefined;
  const rawCondition =
    value.condition && typeof value.condition === 'object'
      ? (value.condition as Record<string, unknown>)
      : undefined;
  const rawWait =
    value.waitFor && typeof value.waitFor === 'object'
      ? (value.waitFor as Record<string, unknown>)
      : undefined;
  const artifact =
    value.artifact && typeof value.artifact === 'object'
      ? (value.artifact as Record<string, unknown>)
      : undefined;
  const presentationBindings = Array.isArray(value.presentationBindings)
    ? value.presentationBindings.flatMap((rawBinding): PresentationBinding[] => {
        if (!rawBinding || typeof rawBinding !== 'object') return [];
        const binding = rawBinding as Record<string, unknown>;
        if (!['summary', 'detail', 'artifact'].includes(String(binding.source))) return [];
        return [
          {
            source: binding.source as PresentationBinding['source'],
            ...(typeof binding.field === 'string' ? { field: binding.field } : {}),
            ...(typeof binding.label === 'string' ? { label: binding.label } : {}),
            ...(typeof binding.primary === 'boolean' ? { primary: binding.primary } : {}),
          },
        ];
      })
    : undefined;
  const decisionLabels =
    value.decisionLabels &&
    typeof value.decisionLabels === 'object' &&
    !Array.isArray(value.decisionLabels)
      ? (structuredClone(value.decisionLabels) as DecisionLabels)
      : undefined;
  const operation = String(value.operation ?? 'inspect_changes') as ActionOperation;
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes.map(String) : undefined;
  const conditionOutcomes =
    rawCondition?.outcomes && typeof rawCondition.outcomes === 'object'
      ? (rawCondition.outcomes as Record<string, unknown>)
      : {};
  const hasExists = Boolean(rawCondition && Object.hasOwn(rawCondition, 'exists'));
  const hasNotEquals = Boolean(rawCondition && Object.hasOwn(rawCondition, 'notEquals'));
  const hasEquals = Boolean(rawCondition && Object.hasOwn(rawCondition, 'equals'));
  const conditionOperator: ConditionOperator = hasExists
    ? 'exists'
    : hasNotEquals
      ? 'notEquals'
      : 'equals';
  const hasBackendValue = hasExists || hasNotEquals || hasEquals;
  const rawConditionValue = hasExists
    ? rawCondition?.exists
    : hasNotEquals
      ? rawCondition?.notEquals
      : hasEquals
        ? rawCondition?.equals
        : rawCondition?.value;
  const declaredValueType =
    rawCondition?.valueType &&
    ['text', 'number', 'boolean', 'null'].includes(String(rawCondition.valueType))
      ? (String(rawCondition.valueType) as ConditionValueType)
      : undefined;
  const conditionValue =
    declaredValueType && !hasBackendValue && rawCondition && Object.hasOwn(rawCondition, 'value')
      ? {
          value:
            declaredValueType === 'null'
              ? ''
              : declaredValueType === 'boolean'
                ? Boolean(rawCondition.value)
                  ? 'true'
                  : 'false'
                : String(rawCondition.value ?? ''),
          valueType: declaredValueType,
        }
      : inferConditionValue(rawConditionValue);
  const normalized: GraphNode = {
    ...node,
    id: String(value.id ?? node.id),
    type,
    name: String(value.name ?? node.name),
    prompt: String(value.prompt ?? node.prompt),
    x: Number.isFinite(Number(value.x)) ? Number(value.x) : node.x,
    y: Number.isFinite(Number(value.y)) ? Number(value.y) : node.y,
    advance: value.advance === 'manual' ? 'manual' : 'automatic',
    decisionLabels,
    artifact: artifact
      ? {
          path: String(artifact.path ?? ''),
          headings: Array.isArray(artifact.headings) ? artifact.headings.map(String) : [],
        }
      : undefined,
    presentationBindings,
    requiresCheck: Boolean(value.requiresCheck),
    checkCommand:
      type === 'check' || value.requiresCheck ? String(value.checkCommand ?? '') : undefined,
    operation: type === 'action' ? operation : undefined,
    input:
      type === 'action' && value.input && typeof value.input === 'object'
        ? (structuredClone(value.input) as ActionInput)
        : type === 'action'
          ? {}
          : undefined,
    session:
      type === 'agent'
        ? {
            mode: session?.mode === 'new' || session?.mode === 'reuse' ? session.mode : 'continue',
            name: session?.name ? String(session.name) : undefined,
            target: session?.target ? String(session.target) : undefined,
          }
        : undefined,
    permissions: type === 'agent' ? String(value.permissions ?? node.permissions) : undefined,
    maxRounds:
      type === 'agent' && Number.isFinite(Number(value.maxRounds))
        ? Number(value.maxRounds)
        : type === 'agent'
          ? 12
          : undefined,
    skills:
      type === 'agent' && Array.isArray(value.skills)
        ? value.skills.map(String)
        : type === 'agent'
          ? []
          : undefined,
    finalizationRounds:
      type === 'agent' ? (value.finalizationRounds as number | undefined) : undefined,
    reasoningEffort:
      type === 'agent' ? (value.reasoningEffort as GraphNode['reasoningEffort']) : undefined,
    submissionRequirements:
      type === 'agent'
        ? (value.submissionRequirements as WorkflowStep['submissionRequirements'])
        : undefined,
    summaryHeadings: type === 'agent' ? (value.summaryHeadings as string[] | undefined) : undefined,
    model: type === 'agent' && value.model ? String(value.model) : undefined,
    condition:
      type === 'branch'
        ? {
            source: (['ticket', 'submission', 'actionResult', 'context'].includes(
              String(rawCondition?.source),
            )
              ? rawCondition?.source
              : 'ticket') as ConditionSource,
            field: String(rawCondition?.field ?? rawCondition?.path ?? 'status'),
            operator: conditionOperator,
            value:
              conditionOperator === 'exists'
                ? rawCondition?.exists
                  ? 'true'
                  : 'false'
                : conditionValue.value,
            valueType: conditionOperator === 'exists' ? 'boolean' : conditionValue.valueType,
            trueOutcome: String(rawCondition?.trueOutcome ?? conditionOutcomes.true ?? 'yes'),
            falseOutcome: String(rawCondition?.falseOutcome ?? conditionOutcomes.false ?? 'no'),
          }
        : undefined,
    waitFor:
      type === 'wait'
        ? {
            event: ['ticket_message_received', 'ticket_source_updated', 'ticket_updated'].includes(
              String(rawWait?.event),
            )
              ? (rawWait?.event as
                  'ticket_message_received' | 'ticket_source_updated' | 'ticket_updated')
              : 'ticket_message_received',
            ticketSource:
              rawWait?.ticketSource === 'related_ticket' ? 'related_ticket' : 'active_ticket',
            ...(rawWait?.relationKind ? { relationKind: String(rawWait.relationKind) } : {}),
            ...(rawWait?.status ? { status: String(rawWait.status) } : {}),
          }
        : undefined,
    outcomes,
  };
  normalized.outcomes = outcomesFor(normalized);
  return normalized;
}

export function backendNode(node: GraphNode): WorkflowStep {
  const {
    type,
    outcomes: _outcomes,
    condition,
    waitFor,
    operation,
    input,
    session,
    artifact,
    presentationBindings,
    ...rest
  } = node;
  const result: Record<string, unknown> = {
    ...rest,
    kind: type === 'approval' ? 'human' : type,
    prompt: node.prompt,
  };
  if (type === 'branch' && !node.prompt) delete result.prompt;
  if (artifact && (artifact.path || artifact.headings.some((heading) => heading.trim())))
    result.artifact = {
      path: artifact.path,
      headings: artifact.headings.map((heading) => heading.trim()).filter(Boolean),
    };
  if (presentationBindings?.length)
    result.presentationBindings = presentationBindings.map((binding) => ({
      source: binding.source,
      ...(binding.source === 'detail' && binding.field ? { field: binding.field } : {}),
      ...(binding.label?.trim() ? { label: binding.label.trim() } : {}),
      ...(binding.primary ? { primary: true } : {}),
    }));
  if (type === 'agent') {
    result.session = session ?? { mode: 'continue' };
    result.permissions = node.permissions;
    result.maxRounds = node.maxRounds;
    if (node.finalizationRounds !== undefined) result.finalizationRounds = node.finalizationRounds;
    if (node.reasoningEffort) result.reasoningEffort = node.reasoningEffort;
    if (node.submissionRequirements) result.submissionRequirements = node.submissionRequirements;
    if (node.summaryHeadings) result.summaryHeadings = node.summaryHeadings;
    result.skills = node.skills ?? [];
    if (node.model) result.model = node.model;
  }
  if (type === 'check') {
    result.checkCommand = node.checkCommand ?? '';
    result.requiresCheck = true;
  }
  if (type === 'action') {
    result.operation = operation ?? 'inspect_changes';
    result.input = input ?? {};
  }
  if (type === 'wait')
    result.waitFor = waitFor ?? { event: 'ticket_message_received', ticketSource: 'active_ticket' };
  if (type === 'branch' && condition)
    result.condition = {
      source: condition.source,
      field: condition.field,
      [condition.operator]: encodeConditionValue(condition),
      trueOutcome: condition.trueOutcome || 'yes',
      falseOutcome: condition.falseOutcome || 'no',
    };
  return result as unknown as WorkflowStep;
}

export function fromWorkflow(
  workflow: Partial<GraphWorkflow> & { steps?: WorkflowStep[] },
): GraphWorkflow {
  const source = Array.isArray(workflow.nodes)
    ? workflow.nodes
    : Array.isArray(workflow.steps)
      ? workflow.steps
      : [];
  const nodes = source.map((node, index) => safeNode(node, index));
  let edges = Array.isArray(workflow.edges)
    ? workflow.edges.map((edge, index) => ({
        id: String(edge.id ?? `edge-${index + 1}`),
        from: String(edge.from ?? ''),
        to: String(edge.to ?? ''),
        outcome: String(edge.outcome ?? 'success'),
      }))
    : [];
  if (!edges.length && nodes.length > 1 && !Array.isArray(workflow.nodes))
    edges = nodes.slice(0, -1).map((node, index) => ({
      id: newId(),
      from: node.id,
      to: nodes[index + 1].id,
      outcome: outcomesFor(node)[0] ?? 'success',
    }));
  const graph: GraphWorkflow = {
    ...(structuredClone(workflow) as GraphWorkflow),
    id: String(workflow.id ?? newId()),
    name: String(workflow.name ?? ''),
    schemaVersion: 3,
    nodes,
    edges,
    entryNode: String(workflow.entryNode ?? nodes[0]?.id ?? ''),
    maxRevisions: Number.isInteger(workflow.maxRevisions) ? Number(workflow.maxRevisions) : 3,
  };
  graph.steps = nodes.map(backendNode);
  return graph;
}

export function toWorkflow(graph: GraphWorkflow): WorkflowDefinition {
  const nodes = graph.nodes.map(backendNode);
  return {
    id: graph.id,
    capabilityProfile: graph.capabilityProfile,
    runtime: graph.runtime,
    name: graph.name,
    version: graph.version,
    schemaVersion: 3,
    entryNode: graph.entryNode || nodes[0]?.id || '',
    maxRevisions: Number.isInteger(graph.maxRevisions) ? graph.maxRevisions : 3,
    nodes,
    edges: graph.edges,
    steps: nodes,
  };
}

export function starter(): GraphWorkflow {
  const nodes = [fresh('agent', 0), fresh('approval', 1), fresh('agent', 2), fresh('check', 3)];
  nodes[0].name = 'Define outcome';
  nodes[0].prompt = 'Clarify the objective, acceptance criteria, and evidence required.';
  nodes[1].name = 'Approve direction';
  nodes[1].prompt = 'Review the proposed direction before implementation.';
  nodes[2].name = 'Implement';
  nodes[2].permissions = 'full';
  nodes[3].name = 'Verify';
  nodes[3].checkCommand = 'npm test';
  return fromWorkflow({
    id: newId(),
    name: 'Outcome to verified change',
    version: 0,
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({
      id: newId(),
      from: node.id,
      to: nodes[index + 1].id,
      outcome: outcomesFor(node)[0],
    })),
  });
}

export function validateWorkflow(workflow: GraphWorkflow): string[] {
  const invalidNumbers = workflow.nodes.filter(
    (node) =>
      node.condition?.operator !== 'exists' &&
      node.condition?.valueType === 'number' &&
      (!node.condition.value.trim() || !Number.isFinite(Number(node.condition.value))),
  );
  if (invalidNumbers.length)
    return invalidNumbers.map((node) => `${node.name}: enter a valid number.`);
  const errors: string[] = [];
  const ids = new Set(workflow.nodes.map((node) => node.id));
  if (!workflow.name.trim()) errors.push('Name is required.');
  if (!workflow.nodes.length) errors.push('Add at least one node.');
  if (!workflow.entryNode || !ids.has(workflow.entryNode)) errors.push('Choose an entry node.');
  if (workflow.nodes.some((node) => !node.id || !node.name.trim()))
    errors.push('Every node needs an id and name.');
  const seen = new Set<string>();
  for (const edge of workflow.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) errors.push('Edges must connect existing nodes.');
    const key = `${edge.from}:${edge.outcome}`;
    if (seen.has(key)) errors.push(`Node ${edge.from} has duplicate outcome ${edge.outcome}.`);
    seen.add(key);
    if (!edge.outcome.trim()) errors.push('Every edge needs an outcome.');
  }
  if (workflow.entryNode && ids.has(workflow.entryNode)) {
    const reached = new Set([workflow.entryNode]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of workflow.edges)
        if (reached.has(edge.from) && !reached.has(edge.to)) {
          reached.add(edge.to);
          changed = true;
        }
    }
    if (reached.size !== workflow.nodes.length)
      errors.push('Every node must be reachable from the entry node.');
  }
  for (const node of workflow.nodes) {
    if (!node.name.trim()) continue;
    if (node.type !== 'branch' && !node.prompt.trim())
      errors.push(`${node.name}: objective is required.`);
    if (node.type === 'branch') {
      const condition = node.condition;
      if (!condition?.field.trim()) errors.push(`${node.name}: branch field is required.`);
      if (!condition?.trueOutcome.trim() || !condition?.falseOutcome.trim())
        errors.push(`${node.name}: branch outcomes are required.`);
      for (const outcome of outcomesFor(node))
        if (!workflow.edges.some((edge) => edge.from === node.id && edge.outcome === outcome))
          errors.push(`${node.name}: add a route for ${outcome}.`);
    }
    if (node.type === 'check' && !node.checkCommand?.trim())
      errors.push(`${node.name}: check command is required.`);
    if (node.type === 'wait' && !node.waitFor) errors.push(`${node.name}: wait event is required.`);
    const bindings = node.presentationBindings ?? [];
    if (bindings.length && node.type !== 'agent')
      errors.push(`${node.name}: material bindings require an agent submission.`);
    if (bindings.length > 12) errors.push(`${node.name}: use at most 12 material bindings.`);
    if (bindings.some((binding) => binding.source === 'detail' && !binding.field?.trim()))
      errors.push(`${node.name}: choose a field for each detail binding.`);
    if (
      bindings.some(
        (binding) =>
          binding.source === 'detail' &&
          binding.field &&
          !Object.values(node.submissionRequirements ?? {}).some((rule) =>
            rule.fields.includes(binding.field!),
          ),
      )
    )
      errors.push(`${node.name}: each detail binding must use a declared submission field.`);
    if (bindings.filter((binding) => binding.primary).length > 1)
      errors.push(`${node.name}: choose at most one primary material binding.`);
    if (
      bindings.filter((binding) => binding.source === 'summary').length > 1 ||
      bindings.filter((binding) => binding.source === 'artifact').length > 1
    )
      errors.push(`${node.name}: summary and artifact material can each be bound once.`);
    const detailFields = bindings
      .filter((binding) => binding.source === 'detail')
      .map((binding) => binding.field);
    if (new Set(detailFields).size !== detailFields.length)
      errors.push(`${node.name}: bind each detail field once.`);
    if (
      node.type === 'approval' &&
      workflow.edges.some(
        (edge) =>
          edge.from === node.id &&
          !['approved', 'changes_requested', '*', 'default'].includes(edge.outcome),
      )
    )
      errors.push(`${node.name}: human outcomes support approved and changes_requested only.`);
    if (node.decisionLabels !== undefined) {
      const labels = node.decisionLabels as Record<string, unknown>;
      if (
        node.type !== 'approval' ||
        !labels ||
        typeof labels !== 'object' ||
        Array.isArray(labels) ||
        Object.keys(labels).some((outcome) => !['approved', 'changes_requested'].includes(outcome))
      )
        errors.push(`${node.name}: decision labels must use supported human outcomes.`);
      else if (
        Object.values(labels).some(
          (label) =>
            typeof label !== 'string' ||
            !label.trim() ||
            label.length > 80 ||
            /[\u0000-\u001f\u007f]/.test(label),
        )
      )
        errors.push(`${node.name}: decision labels must be plain text up to 80 characters.`);
    }
  }
  return [...new Set(errors)];
}

export function layout(nodes: GraphNode[], edges: GraphEdge[], entryNode?: string): GraphNode[] {
  if (!nodes.length) return nodes;
  const root = entryNode && nodes.some((node) => node.id === entryNode) ? entryNode : nodes[0].id;
  const depth = new Map<string, number>([[root, 0]]);
  const queue = [root];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges.filter((edge) => edge.from === id))
      if (!depth.has(edge.to)) {
        depth.set(edge.to, (depth.get(id) ?? 0) + 1);
        queue.push(edge.to);
      }
  }
  const groups = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? nodes.indexOf(node);
    const group = groups.get(level) ?? [];
    group.push(node);
    groups.set(level, group);
  }
  return nodes.map((node) => {
    const level = depth.get(node.id) ?? nodes.indexOf(node);
    return { ...node, x: 70 + level * 340, y: 70 + groups.get(level)!.indexOf(node) * 165 };
  });
}
export function actionInputDefaults(operation: ActionOperation): ActionInput {
  if (operation === 'create_ticket')
    return {
      projectId: '',
      title: '',
      description: '',
      status: 'Backlog',
      label: '',
      agent: 'Unassigned',
      priority: 'Medium',
    };
  if (operation === 'create_related_ticket') return { title: '', description: '', kind: 'related' };
  if (operation === 'send_external_reply') return { connectionId: '', sourceNodeId: '', field: '' };
  if (operation === 'update_ticket') return { ticketSource: 'active_ticket', patch: {} };
  if (operation === 'move_ticket')
    return { ticketSource: 'active_ticket', boardId: '', placement: { columnId: '' } };
  return {};
}
export function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}
