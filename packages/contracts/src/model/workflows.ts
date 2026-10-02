export type WorkflowNodeKind = 'agent' | 'human' | 'check' | 'action' | 'branch' | 'wait';

export type WorkflowReference = {
  workflowId: string;
  workflowVersion: number;
  ruleId?: string;
  ruleRevision?: number;
  nodeId?: string;
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
  status: 'pending' | 'started' | 'failed' | 'conflict' | 'blocked_active' | 'coalesced';
  ruleId?: string;
  ruleRevision?: number;
  activeSessionId?: string;
  activeRunId?: string;
  coalescedInto?: string;
  attempts?: number;
  lastRetryAt?: string;
};
