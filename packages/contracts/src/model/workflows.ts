export type WorkflowNodeKind = 'agent' | 'human' | 'check' | 'action' | 'branch' | 'wait';
export type WorkflowAdvance = 'automatic' | 'manual';
export type WorkflowPermission = 'none' | 'read' | 'read-write' | 'full';
export type WorkflowSessionRule = {
  mode: 'continue' | 'new' | 'reuse';
  name?: string;
  target?: string;
};
export type WorkflowArtifact = { path: string; headings: string[] };
export type WorkflowActionOperation =
  | 'inspect_changes'
  | 'create_ticket'
  | 'create_development_ticket'
  | 'create_related_ticket'
  | 'update_ticket'
  | 'move_ticket';
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
  artifact?: WorkflowArtifact;
  requiresCheck?: boolean;
  checkCommand?: string;
  operation?: WorkflowActionOperation;
  input?: Record<string, unknown>;
  session?: WorkflowSessionRule;
  permissions?: WorkflowPermission;
  maxRounds?: number;
  skills?: string[];
  model?: string;
  condition?: WorkflowCondition;
  waitFor?: { event: 'ticket_message_received' | 'ticket_source_updated' | 'ticket_updated'; ticketSource?: 'active_ticket' | 'related_ticket' | 'linked_development'; relationKind?: string; status?: string };
  x?: number;
  y?: number;
};
export type WorkflowEdge = { id: string; from: string; to: string; outcome: string };
export type WorkflowBoardTrigger = {
  event: 'ticket_created' | 'ticket_updated' | 'ticket_moved' | 'board_placement_changed' | 'ticket_imported' | 'ticket_source_updated' | 'ticket_message_received';
  boardId?: string;
  columnId?: string;
  bindingId?: string;
  workType?: string;
  projectId?: string;
};
export type WorkflowDefinition = {
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
  triggers: WorkflowBoardTrigger[];
  /** Compatibility projection for older clients. New code must use nodes. */
  steps: WorkflowStep[];
};
export type WorkflowStartRule = {
  id: string;
  name: string;
  organizationId: string;
  projectId: string;
  event: WorkflowBoardTrigger['event'];
  boardId?: string;
  columnId?: string;
  bindingId?: string;
  workType?: string;
  workflowId: string;
  workflowVersion: number;
  enabled: boolean;
  principal:
    | { kind: 'user'; userId: string }
    | { kind: 'workload'; workloadIdentityId: string }
    | null;
  revision: number;
  migratedFrom?: { workflowId: string; triggerIndex: number };
};
export type WorkflowEffect = {
  effectKey: string;
  status: 'pending' | 'uncertain' | 'succeeded';
  operation: string;
  at?: string;
  reconciledAt?: string;
  message?: string;
};
export type WorkflowTriggerFailure = {
  triggerKey: string;
  workflowId: string;
  workflowVersion: number;
  ticketId: number;
  trigger?: string;
  message?: string;
  at?: string;
};
export type WorkflowTrigger = WorkflowTriggerFailure & {
  status: 'pending' | 'started' | 'failed' | 'conflict' | 'blocked_active';
  ruleId?: string;
  ruleRevision?: number;
  activeSessionId?: string;
  activeRunId?: string;
  attempts?: number;
  lastRetryAt?: string;
};
