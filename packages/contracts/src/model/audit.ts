import type { PrincipalRef } from './access';

export type SecurityAuditRecord = {
  id: string;
  sequence: number;
  occurredAt: string;
  deploymentId: string;
  organizationId: string;
  actor: PrincipalRef;
  authenticatedIdentity?: {
    userId?: string;
    deviceId?: string;
    deviceSessionId?: string;
    workloadIdentityId?: string;
    servicePrincipalId?: string;
  };
  context?: { teamId?: string; projectId?: string; sessionId?: string; turnId?: string };
  action: string;
  resource?: { kind: string; id?: string };
  decision: string;
  outcome: string;
  revisions?: {
    membershipRevision?: string;
    policyRevision?: string;
    routeRevision?: string;
    connectionRevision?: string;
    profileRevision?: string;
    providerGrantDigest?: string;
    executionGrantDigest?: string;
  };
  provider?: {
    providerId?: string;
    connectionId?: string;
    modelOfferingId?: string;
    routeId?: string;
    grantId?: string;
    requestId?: string;
    outcomeClass?: string;
  };
  execution?: {
    environmentId?: string;
    runnerId?: string;
    poolId?: string;
    workspaceId?: string;
    assignmentId?: string;
    profileId?: string;
  };
  approval?: { approvalId?: string; decision?: string; reviewerId?: string };
  traceId?: string;
  correlationId?: string;
  observations?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
      costUsd?: number;
      durationMs?: number;
    };
    failureClass?: string;
    retryable?: boolean;
    reconciliationRequired?: boolean;
  };
  redaction: { removedFields: number; policy: 'allowlist-v1' };
  previousDigest?: string;
  digest: string;
};

export type SecurityAuditQuery = {
  organizationId: string;
  cursor?: number;
  limit?: number;
  eventAction?: string;
  outcome?: string;
  projectId?: string;
};
