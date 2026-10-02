export type WorkflowNodeKind = 'agent' | 'human' | 'check' | 'action' | 'branch' | 'wait';

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
  independent?: boolean;
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
  activityReservations?: (WorkflowActivityReservation & { gateNodeId: string; gateInstance: string; targetNodeId: string; targetInstance: string; activityRef: WorkflowActivityRef; inputDigest: string; intentDigest: string; consumedAt?: string })[];
  attempt?: WorkflowActivityAttempt;
  activityAttempts?: WorkflowActivityAttempt[];
  history: { nodeId: string; instance?: string; outcome: string; at?: string; to?: string | null }[];
  historyTotal?: number;
  historyTruncated?: boolean;
  decisions?: { instance: string; decision: 'approve' | 'requestChanges'; actor: string; principal: Record<string, unknown>; at: string }[];
  decisionsTotal?: number;
  decisionsTruncated?: boolean;
  lease: null | { id: string; client: string; label: string; expiresAt: number };
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
  | { from: { kind: 'activity_output'; nodeId: string; path: string[] } };
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
export type WorkflowStep = {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  prompt?: string;
  advance: WorkflowAdvance;
  /** Optional human-facing labels for canonical decision outcomes; no route or authority effect. */
  decisionLabels?: WorkflowDecisionLabels;
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
  waitFor?: {
    event: 'ticket_message_received' | 'ticket_source_updated' | 'ticket_updated';
    ticketSource?: 'active_ticket' | 'related_ticket';
    relationKind?: string;
    status?: string;
  };
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
