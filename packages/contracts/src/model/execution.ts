export type ExecutionProfileId =
  | 'plan'
  | 'ask'
  | 'edit'
  | 'auto'
  | 'dont-ask'
  | 'full-access-ask'
  | 'full-access'
  | 'deny';
export type PolicyDecision = 'allow' | 'ask' | 'deny';
export type ExecutionEnvelope = {
  isolation: 'workspace' | 'host' | 'none';
  filesystem: {
    workspace: 'none' | 'read-only' | 'read-write' | 'host';
    extraRoots: Array<{ path: string; access: 'read-only' | 'read-write' }>;
    protectedPaths: string[];
  };
  network: { mode: 'none' | 'allowlist' | 'host'; allowedDomains: string[] };
  credentials: { mode: 'none' | 'brokered' | 'host' };
  process: { commands: boolean; background: boolean; terminal: boolean };
};
export type ExecutionProfile = {
  id: ExecutionProfileId;
  name: string;
  revision: number;
  envelope: ExecutionEnvelope;
  approval: {
    reviewer: 'user' | 'policy' | 'none';
    reads: PolicyDecision;
    edits: PolicyDecision;
    commands: PolicyDecision;
    otherMutations: PolicyDecision;
  };
};
export type ResolvedExecutionGrant = {
  version: number;
  profileId: ExecutionProfileId;
  profileRevision: number;
  runnerId?: string;
  environmentId?: string;
  envelope: ExecutionEnvelope;
  approval: ExecutionProfile['approval'];
  digest: string;
};

export type Environment = {
  id: string;
  organizationId?: string;
  name: string;
  kind: string;
  host: string;
  enabled: boolean;
  tags: string[];
  maxConcurrent: number;
  revision: number;
  load: number;
  backgroundLoad?: number;
  capacityProvider?: StaticCapacityProvider;
};

export type CapacityBudgetCeiling = {
  maxRunners: number;
  maxConcurrent: number;
  maxHourlyCost?: number;
  currency?: string;
};

/**
 * The only supported capacity provider. It describes fixed inventory and has no
 * lifecycle operations. Revisions are copied into demand records so a future
 * provisioned adapter cannot silently substitute a different runtime or image.
 */
export type StaticCapacityProvider = {
  kind: 'static';
  adapterId: string;
  runtimeRevision: string;
  imageRevision: string;
  authorityCeiling: 'contained' | 'trusted';
  budgetCeiling: CapacityBudgetCeiling;
  revision: number;
};

export type CapacityDrainState = 'active' | 'draining' | 'drained';

export type CapacityRequest = {
  id: string;
  demandKey: string;
  organizationId: string;
  projectId: string;
  poolId?: string;
  environmentIds: string[];
  providerKind: 'static';
  providerAdapterId: string;
  desiredCapacity: number;
  availableCapacity: number;
  drainState: CapacityDrainState;
  runtimeRevision: string;
  imageRevision: string;
  authorityCeiling: 'contained' | 'trusted';
  budgetCeiling: CapacityBudgetCeiling;
  state: 'open' | 'satisfied' | 'cancelled';
  reason?: 'exhausted';
  createdAt: string;
  observedAt: string;
  satisfiedAt?: string;
  revision: number;
};

export type CapacityStatus = {
  organizationId: string;
  poolId?: string;
  desiredCapacity: number;
  availableCapacity: number;
  openRequests: number;
  drainState: CapacityDrainState;
  observedAt: string;
};
export type Runner = {
  id: string;
  organizationId?: string;
  name: string;
  environmentId: string;
  kind: string;
  host: string;
  repository: string;
  online: boolean;
  checkedAt: string;
  accessMode: 'contained' | 'trusted';
  capabilities: {
    tools: string[];
    shell: boolean;
    terminal?: boolean;
    accessMode?: 'contained' | 'trusted';
    enforcement?: {
      isolation: Array<'workspace' | 'host'>;
      network: Array<'none' | 'host'>;
      failClosed: boolean;
      platform?: string;
      architecture?: string;
    };
  };
  enabled: boolean;
  tags: string[];
  projectIds: string[];
  maxConcurrent: number;
  revision: number;
  load: number;
  backgroundLoad?: number;
  lifecycle?: 'persistent' | 'ephemeral';
  registration?: 'managed' | 'outbound';
  enrollmentId?: string;
  machineIdentity?: {
    id: string;
    organizationId: string;
    state: 'active' | 'revoked';
    fingerprint: string;
    issuedAt: string;
    rotateAfter: string;
    revokedAt?: string;
    revision: number;
  };
  draining?: boolean;
};
export type RunnerPool = {
  id: string;
  organizationId?: string;
  name: string;
  runnerIds: string[];
  revision: number;
};

export type EnvironmentAccessBinding = {
  id: string;
  organizationId: string;
  subject:
    | { kind: 'user'; userId: string }
    | { kind: 'team'; teamId: string }
    | { kind: 'project'; projectId: string };
  resource:
    | { kind: 'environment'; environmentId: string }
    | { kind: 'runner-pool'; runnerPoolId: string };
  role: 'use' | 'administer';
  constraints?: {
    executionProfiles?: ExecutionProfileId[];
    repositoryPatterns?: string[];
    schedules?: string[];
  };
  revision: number;
};

export type RunnerEnrollment = {
  id: string;
  organizationId: string;
  environmentId: string;
  poolIds: string[];
  projectIds: string[];
  authorityCeiling: Runner['accessMode'];
  expectedPlatform?: { platform: string; architecture: string };
  state: 'pending' | 'consumed' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
  runnerId?: string;
  revision: number;
};

export type ChannelGrant = {
  id: string;
  organizationId: string;
  projectId: string;
  sessionId: string;
  runnerId: string;
  environmentId: string;
  workspace: string;
  leaseId: string;
  executionGrantDigest: string;
  terminalId?: string;
  audience: 'terminal' | 'direct-channel';
  actor:
    | { kind: 'user'; userId: string }
    | { kind: 'workload'; workloadIdentityId: string }
    | { kind: 'service-principal'; servicePrincipalId: string };
  permissions: string[];
  state: 'active' | 'revoked' | 'expired';
  createdAt: string;
  expiresAt: string;
  renewedAt?: string;
  revokedAt?: string;
  revision: number;
};
