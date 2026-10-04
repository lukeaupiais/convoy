export type WorkflowNodeKind = 'agent' | 'human' | 'check' | 'action' | 'branch' | 'wait' | 'child' | 'parallel' | 'map';

export type WorkflowHumanOutcome = { id: string; label: string; effect?: 'approve_activity' };
export type WorkflowHumanTask = {
  outcomes: WorkflowHumanOutcome[];
  form?: { fields: Array<{
    id: string; label: string; type: 'text' | 'number' | 'boolean' | 'choice' | 'date';
    required?: boolean; options?: Array<{ value: string; label: string }>;
    minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  }> };
  reviewerPolicy?: { userIds?: string[]; permission?: 'project.execute' | 'project.write' };
  dueAfterSeconds?: number;
};
export type WorkflowHumanResponse = {
  id: string; runId: string; workflowId: string; workflowVersion: number;
  nodeId: string; instance: string; values: Record<string, unknown>;
  digest: string; at: string; evidenceIds?: string[];
};
export type WorkflowEvidenceRef = {
  id: string; digest: string; mediaType: string; byteLength: number;
  name: string; source: { nodeId: string; attemptInstance: string; producer: 'document' | 'api_snapshot' | 'activity_receipt' | 'legacy_artifact' };
};
export type WorkflowHumanReview = {
  response: WorkflowHumanResponse;
  evidence: WorkflowEvidenceRef[];
  materialDigest: string;
  reservation?: WorkflowActivityReservation;
};

export type WorkflowReference = {
  workflowId: string;
  workflowVersion: number;
  ruleId?: string;
  ruleRevision?: number;
  nodeId?: string;
};
export type WorkflowActivityAttempt = {
  instance: string;
  nodeId: string;
  status: 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  activityRef?: WorkflowActivityRef;
  effect?: 'pure' | 'observation' | 'durable-effect';
  inputDigest?: string;
  outputDigest?: string;
  startedAt?: string;
  completedAt?: string;
  outcome?: string;
  /** Compatibility evidence retained for already published Work operation graphs. */
  effectKey?: string;
  idempotencyKey?: string;
  effectResult?: Record<string, unknown>;
};
export type WorkflowCompositionLimits = {
  maxDescendantRuns: number;
  maxMapItems: number;
  maxConcurrentChildren: number;
  maxDeadlineMs: number;
  maxActiveDescendantRuns: number;
  maxActiveDescendantsPerRoot: number;
};
export type WorkflowCompositionPolicySnapshot = {
  defaults: WorkflowCompositionLimits;
  organizations: Record<string, { revision: number; limits: WorkflowCompositionLimits }>;
  projects: Record<string, { organizationId: string; revision: number; limits: WorkflowCompositionLimits }>;
};
export type WorkflowCompositionSlot = {
  slotId: string;
  runId: string;
  index?: number;
  status: string;
  childRunCreated?: boolean;
  workflowId: string;
  workflowVersion: number;
  inputDigest: string;
  outputDigest?: string;
  effectKey?: string;
  instance?: string;
  message?: string;
};
export type WorkflowCompositionAttempt = {
  nodeId: string;
  instance: string;
  kind: 'child' | 'parallel' | 'map';
  status: string;
  join?: 'all' | 'first_success';
  deadlineAt?: string;
  winnerSlotId?: string;
  forwardOutcome?: { trigger: 'failure' | 'cancelled'; status: 'failed' | 'cancelled'; at: string; message?: string };
  compensationStatus?: string;
  policy: { organizationRevision: number; projectRevision: number; limits: WorkflowCompositionLimits };
  slots: WorkflowCompositionSlot[];
  compensations?: (WorkflowCompositionSlot & { id: string; trigger: 'failure' | 'cancelled' })[];
  slotsTruncated?: boolean;
  outputDigest?: string;
};
export type WorkflowActivityReservation = {
  id: string;
  digest: string;
  preview?: { activity: string; input: unknown; intent: unknown; resources?: { model?: string }; action?: string; summary?: string; body?: string };
};
export type WorkflowRun = {
  id: string;
  organizationId: string;
  projectId: string;
  sessionId?: string;
  independent: boolean;
  workflowId: string;
  workflowVersion: number;
  status: string;
  nodeId?: string | null;
  instance?: string | null;
  activeTicketId?: number | null;
  startedAt: string;
  updatedAt?: string;
  runInputDigest?: string;
  resultDigest?: string;
  workflowRunResultEligible?: boolean;
  humanResponses?: WorkflowHumanResponse[];
  humanResponsesTotal?: number;
  evidence?: WorkflowEvidenceRef[];
  evidenceTotal?: number;
  humanTaskDueAt?: string;
  humanTaskDue?: boolean;
  humanTaskReviewerEligible?: boolean;
  activityReservations?: (WorkflowActivityReservation & { gateNodeId: string; gateInstance: string; targetNodeId: string; targetInstance: string; activityRef: WorkflowActivityRef; inputDigest: string; intentDigest: string; consumedAt?: string })[];
  attempt?: WorkflowActivityAttempt;
  activityAttempts?: WorkflowActivityAttempt[];
  compositions?: WorkflowCompositionAttempt[];
  compositionAttemptsTotal?: number;
  compositionAttemptsOffset?: number;
  compositionAttemptsHasMore?: boolean;
  history: {
    nodeId: string;
    instance?: string;
    outcome: string;
    at?: string;
    to?: string | null;
    summary?: string;
    humanResponseId?: string;
    humanMaterialDigest?: string;
  }[];
  historyTotal?: number;
  historyTruncated?: boolean;
  decisions?: { instance: string; decision: string; outcomeId?: string; responseId?: string; materialDigest?: string; actor: string; principal: Record<string, unknown>; at: string }[];
  decisionsTotal?: number;
  decisionsTruncated?: boolean;
  lease: null | {
    id: string;
    client: string;
    label: string;
    expiresAt: number;
    /** Read-only projection on getWorkflowRun; it does not grant control. */
    ownedByCurrentCaller?: boolean;
  };
};
type BoardAutomationReference = WorkflowReference & {
  scope: 'column' | 'board' | 'project';
  workflowName?: string;
  available: boolean;
  olderVersion: boolean;
  projectId?: string;
  boardId?: string;
  columnId?: string;
  name: string;
  label: string;
  unresolved?: boolean;
  indirect?: boolean;
  detail?: string;
};
export type BoardAutomationRelationship = BoardAutomationReference &
  (
    | {
        kind: 'start_rule';
        ruleId: string;
        ruleRevision: number;
        event: import('./automations').AutomationEvent;
        enabled: boolean;
        decision?: {
          triggerKey: string;
          status: AutomationDecision['status'];
          ruleRevision?: number;
          workflowId: string;
          workflowVersion?: number;
          ticketId: number;
          at?: string;
        };
      }
    | {
        kind: 'effect';
        nodeId: string;
        operation: WorkflowActionOperation;
        referencedBy?: {
          ruleId: string;
          name: string;
          projectId: string;
          boardId?: string;
          columnId?: string;
        }[];
      }
  );
export type BoardAutomationView = {
  boardId: string;
  boardRevision: number;
  relationships: BoardAutomationRelationship[];
};
export type WorkflowAdvance = 'automatic' | 'manual';
export type WorkflowPermission = 'none' | 'read' | 'read-write' | 'full';
export type WorkflowSessionRule = {
  mode: 'continue' | 'new' | 'reuse';
  name?: string;
  target?: string;
};
export type WorkflowArtifact = { path: string; headings: string[] };
export type WorkflowActivityRef = { id: string; revision: number };
export type WorkflowJsonSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, WorkflowJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: WorkflowJsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};
export type WorkflowActivityBinding =
  | { literal: unknown }
  | { from: { kind: 'run_input'; path: string[] } }
  | { from: { kind: 'activity_output'; nodeId: string; path: string[] } }
  | { from: { kind: 'human_response'; nodeId: string; path: string[] } }
  | { from: { kind: 'agent_submission'; nodeId: string; path: string[] } };
export type WorkflowCompositionWorkflowRef = { id: string; version: number };
export type WorkflowCompositionOutputBinding = { from: string[]; to?: string[] };
export type WorkflowCompositionBranch = {
  id: string;
  workflow: WorkflowCompositionWorkflowRef;
  workflowDigest?: string;
  inputSchemaDigest?: string;
  resultSchemaDigest?: string;
  inputBindings: Record<string, WorkflowActivityBinding>;
  outputBindings: Record<string, WorkflowCompositionOutputBinding>;
};
export type WorkflowCompositionCompensation = {
  id: string;
  trigger: 'failure' | 'cancelled';
  workflow: WorkflowCompositionWorkflowRef;
  workflowDigest?: string;
  inputSchemaDigest?: string;
  resultSchemaDigest?: string;
  inputBindings: Record<string, WorkflowActivityBinding>;
};
export type WorkflowActivityDescriptor = {
  ref: WorkflowActivityRef;
  /** Canonical digest of the registered descriptor metadata at this revision. */
  digest?: string;
  inputSchema: WorkflowJsonSchema;
  outputSchema: WorkflowJsonSchema;
  resources:
    | { location: 'daemon' }
    | { location: 'agent'; provider: 'required'; tools?: string[]; workspace?: boolean }
    | { location: 'runner'; runner: 'required'; workspace?: boolean }
    | { location: 'integration'; adapterId: string };
  effect: 'pure' | 'observation' | 'durable-effect';
  approval: { required: boolean; policy?: 'workflow-gate' | 'command-policy' };
  cancellation: 'immediate' | 'cooperative' | 'reconcile-after-dispatch';
  confirmation: 'result' | 'adapter-confirmed' | 'human-reconciled';
  reconciliation: 'none' | 'adapter';
  presentation: { label: string; description?: string; group?: string };
  available?: boolean;
};
export type WorkflowDecisionOutcome = 'approved' | 'changes_requested';
export type WorkflowDecisionLabels = Partial<Record<WorkflowDecisionOutcome, string>>;
export type WorkflowActionOperation =
  'inspect_changes' | 'create_ticket' | 'create_related_ticket' | 'update_ticket' | 'move_ticket' | 'set_external_status' | 'send_external_reply';
export type WorkflowConditionSource = 'ticket' | 'submission' | 'actionResult' | 'context';
export type WorkflowCondition = {
  source: WorkflowConditionSource;
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  exists?: boolean;
  trueOutcome: string;
  falseOutcome: string;
};
export type WorkflowWaitPredicate = {
  path: string;
  operator: 'exists' | 'equals' | 'notEquals' | 'greaterThan' | 'lessThan';
  value?: string | number | boolean;
};
export type WorkflowWaitFor = {
  /** Event IDs are registered by an event owner; the contract stays owner-neutral. */
  event: string;
  eventRevision?: number;
  scope?: 'organization' | 'project' | 'resource';
  resourceRef?: { kind: string; id: string };
  correlation?: { key: string; from: string };
  if?: WorkflowWaitPredicate[];
  timeoutSeconds?: number;
  timeoutOutcome?: string;
  /** Work-owned compatibility filters for the historical ticket wait aliases. */
  ticketSource?: 'active_ticket' | 'related_ticket';
  relationKind?: string;
  status?: string;
};
export type WorkflowStep = {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  prompt?: string;
  advance: WorkflowAdvance;
  /** Optional human-facing labels for canonical decision outcomes; no route or authority effect. */
  decisionLabels?: WorkflowDecisionLabels;
  humanTask?: WorkflowHumanTask;
  /** Owner-derived compatibility marker for pre-configuration gates. */
  legacyHumanTask?: boolean;
  artifact?: WorkflowArtifact;
  requiresCheck?: boolean;
  checkCommand?: string;
  operation?: WorkflowActionOperation;
  input?: Record<string, unknown>;
  activity?: WorkflowActivityRef;
  activityDescriptorDigest?: string;
  bindings?: Record<string, WorkflowActivityBinding>;
  session?: WorkflowSessionRule;
  permissions?: WorkflowPermission;
  maxRounds?: number;
  finalizationRounds?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  summaryHeadings?: string[];
  /** Optional display metadata for this node's submitted output; it never changes workflow policy. */
  presentationBindings?: {
    source: 'summary' | 'detail' | 'artifact';
    field?: string;
    label?: string;
    primary?: boolean;
  }[];
  submissionRequirements?: Record<
    string,
    {
      fields: string[];
      minReferences: number;
      requireInvestigationAssessment?: boolean;
      requireClaimEvidence?: boolean;
    }
  >;
  skills?: string[];
  model?: string;
  condition?: WorkflowCondition;
  waitFor?: WorkflowWaitFor;
  workflow?: WorkflowCompositionWorkflowRef;
  inputBindings?: Record<string, WorkflowActivityBinding>;
  outputSchema?: WorkflowJsonSchema;
  outputBindings?: Record<string, WorkflowCompositionOutputBinding>;
  join?: 'all' | 'first_success';
  branches?: WorkflowCompositionBranch[];
  compensations?: WorkflowCompositionCompensation[];
  maxItems?: number;
  maxConcurrent?: number;
  deadlineMs?: number;
  failurePolicy?: 'fail_fast' | 'collect_errors';
  itemsBinding?: WorkflowActivityBinding;
  itemField?: string;
  indexField?: string;
  x?: number;
  y?: number;
};
export type WorkflowEdge = { id: string; from: string; to: string; outcome: string };
export type WorkflowDefinition = {
  runtime?: import('./execution').RuntimeSelection;
  capabilityProfile?: import('./capabilities').ProfileRef;
  id: string;
  organizationId?: string;
  teamId?: string;
  projectId?: string;
  schemaVersion: 3;
  name: string;
  version?: number;
  nodes: WorkflowStep[];
  edges: WorkflowEdge[];
  entryNode: string;
  maxRevisions: number;
  runInputSchema?: WorkflowJsonSchema;
  resultSchema?: WorkflowJsonSchema;
  resultBindings?: Record<string, WorkflowActivityBinding>;
  resultBindingsByTerminal?: Record<string, Record<string, WorkflowActivityBinding>>;
  /** Compatibility projection for older clients. New code must use nodes. */
  steps: WorkflowStep[];
};
export type { AutomationRule } from './automations';
export type WorkflowEffect = {
  effectKey: string;
  status: 'pending' | 'uncertain' | 'blocked' | 'succeeded';
  operation: string;
  at?: string;
  reconciledAt?: string;
  message?: string;
  blockingReplyRequestId?: string;
};
export type WorkflowRunInput = { runInputDigest?: string; resultDigest?: string };
export type AutomationDecisionFailure = {
  triggerKey: string;
  workflowId: string;
  workflowVersion: number;
  ticketId: number;
  trigger?: string;
  message?: string;
  at?: string;
};
export type AutomationDecision = AutomationDecisionFailure & {
  status: 'pending' | 'reserved' | 'started' | 'failed' | 'held' | 'conflict' | 'blocked_active' | 'coalesced';
  ruleId?: string;
  ruleRevision?: number;
  activeSessionId?: string;
  activeRunId?: string;
  coalescedInto?: string;
  attempts?: number;
  lastRetryAt?: string;
};
