import type { CapabilityProfile, EffectiveCapabilities } from './capabilities';
import type { ContextFile } from './files';
import type { Placement } from './work';
import type { ExecutionProfileId, ResolvedExecutionGrant } from './execution';
import type { WorkflowDefinition } from './workflows';

export type { ContextFile } from './files';
export type WorkflowSubmissionArtifact = Pick<
  ContextFile,
  'id' | 'name' | 'mime' | 'size' | 'hash' | 'at'
> & { path: string };
export type WorkflowSubmission = {
  nodeId?: string;
  step: string;
  summary: string;
  revision?: number;
  primaryArtifactId?: string;
  /** String paths are retained only for snapshots created before artifact capture. */
  artifacts: (WorkflowSubmissionArtifact | string)[];
};
export type InstructionScope =
  | 'organization'
  | 'user'
  | 'project'
  | 'skill'
  | 'environment'
  | 'task';
export type Instruction = {
  id: string;
  scope: InstructionScope;
  target: string;
  name: string;
  content: string;
  version: number;
  hash: string;
  source?: string;
};
export type ContextEpoch = {
  id: string;
  createdAt: string;
  baselineHash: string;
  baseline: string;
  instructions: {
    id: string;
    scope: string;
    target: string;
    name: string;
    version: number;
    hash: string;
  }[];
};
export type SessionEvent = {
  seq: number;
  callId?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  approval?: { id: string; callId?: string; tool: string; args: Record<string, unknown> };
  approvalId?: string;
  allow?: boolean;
  question?: { id: string; question: string };
  attachments?: ContextFile[];
  ticketId?: number;
  conversationId?: string;
  sessionId?: string;
  title?: string;
  type: string;
  text?: string;
  message?: string;
  output?: unknown;
  tool?: string;
  model?: string;
  at: string;
  agentSessionId?: string;
  summary?: string;
  name?: string;
  profileId?: string;
  policyDigest?: string;
  category?: string;
  reason?: string;
};
export type Session = {
  commands?: {
    commandId: string;
    callId?: string;
    agentSessionId?: string;
    command: string;
    lifetime?: 'turn' | 'session';
    state: string;
    output: string;
    startedAt: number;
    endedAt?: number;
    reason?: string;
    error?: string;
    code?: number | null;
    signal?: string | null;
    truncated?: boolean;
    retainedBytes?: number;
    cursor?: number;
  }[];
  terminals?: {
    terminalId: string;
    command?: string;
    state: string;
    startedAt: number;
    endedAt?: number;
    reason?: string;
    code?: number | null;
    signal?: string | null;
    attached?: number;
    retainedBytes?: number;
  }[];
  streamVersion?: number;
  control?: { busy: boolean; stopping: boolean; canMessage: boolean };
  pendingMessages?: {
    id: string;
    text: string;
    held: boolean;
    reason?: string;
    attachments?: ContextFile[];
  }[];
  interruption?: {
    at: string;
    reason: string;
    needsReview: boolean;
    tool?: string;
    lastCompletedTool?: string;
  };
  capabilityProfile?: CapabilityProfile | null;
  effectiveCapabilities?: EffectiveCapabilities;
  id: string;
  projectId?: string;
  conversationId?: string;
  activeTicketId?: number | null;
  workingContext?: string;
  title: string;
  status: string;
  model: string;
  partial: string;
  updatedAt: string;
  lease: null | { id: string; client: string; label: string; expiresAt: number };
  events: SessionEvent[];
  pending: null | {
    id: string;
    callId?: string;
    tool: string;
    args: unknown;
    rule?: ApprovalRule;
  };
  pendingQuestion?: { id: string; question: string } | null;
  workspace: null | { path: string; branch: string };
  runnerId?: string;
  placement?: Placement;
  executionProfile?: ExecutionProfileId | 'inherit';
  executionGrant?: ResolvedExecutionGrant;
  workspaceRequest?: string;
  workflow: WorkflowDefinition | null;
  step: number;
  boardPhase?: string;
  queueReason?: string;
  assignment?: {
    token: string;
    runnerId: string;
    environmentId: string;
    state: string;
    message?: string;
    policyDigest?: string;
  };
  flow?: {
    id: string;
    status: string;
    instance: string;
    revision: number;
    nodeId?: string | null;
    lastSubmission?: WorkflowSubmission;
    history?: {
      nodeId: string;
      instance?: string;
      outcome: string;
      at?: string;
      to?: string | null;
    }[];
  };
  agentSessions?: { id: string; name: string; messageCount: number }[];
  currentAgentSessionId?: string;
  instructions: Instruction[];
  contextEpoch?: ContextEpoch;
  contextEpochs?: ContextEpoch[];
  provenance?: {
    systemPrompt: string;
    hash: string;
    contextEpoch?: Pick<ContextEpoch, 'id' | 'baselineHash' | 'createdAt'>;
    contextUpdates?: { kind: string; hash: string }[];
  };
  review?: { status: string; diff: string; truncated: boolean };
  checks: { command: string; code: number; output: string; at: string; concurrent?: boolean }[];
};

export type ApprovalRule = {
  id: string;
  tool: string;
  label: string;
  scope: { kind: 'workspace' | 'project' | 'conversation'; value: string; runnerId?: string };
  resource: { kind: 'path' | 'command' | 'tool'; value: string };
  createdAt: string;
  createdBy: string;
};
