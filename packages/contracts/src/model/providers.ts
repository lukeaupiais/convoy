export type ProviderConnectionOwner =
  | { kind: 'user'; userId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'organization'; organizationId: string };

export type ProviderProtocol =
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-language'
  | 'vertex-ai'
  | 'openai-compatible'
  | 'aws-bedrock'
  | 'chatgpt-subscription'
  | 'test';

export type ModelProvider = {
  id: string;
  adapterKind: string;
  displayName: string;
  protocol: ProviderProtocol;
  adapterCapabilities: string[];
};

export type SecretReference = {
  kind: 'encrypted' | 'external' | 'workload-identity' | 'subscription' | 'none';
  reference?: string;
  version?: string;
};

export type ProviderConnection = {
  id: string;
  organizationId: string;
  providerId: string;
  displayName: string;
  owner: ProviderConnectionOwner;
  endpoint?: { origin: string; region?: string };
  credentialRef: SecretReference;
  state: 'pending' | 'ready' | 'degraded' | 'revoked';
  governance: {
    allowedProjectIds?: string[];
    dataResidencies?: string[];
    personalUse?: 'allowed' | 'restricted' | 'forbidden';
    maximumConcurrency?: number;
    monthlyBudgetUsd?: number;
  };
  revision: string;
  createdAt: string;
  lastProbeAt?: string;
  catalogRevision?: string;
  revokedAt?: string;
  revocationReason?: string;
};

export type ModelCapabilities = {
  inputModalities: Array<'text' | 'image' | 'audio' | 'file'>;
  outputModalities: Array<'text' | 'image' | 'audio'>;
  toolCalls: 'none' | 'single' | 'parallel';
  structuredOutput: boolean;
  reasoning: boolean;
  contextWindow?: number;
  maximumOutputTokens?: number;
  streaming: boolean;
  promptCaching?: 'none' | 'automatic' | 'explicit';
  dataResidencies?: string[];
};

export type ModelOffering = {
  id: string;
  organizationId: string;
  providerConnectionId: string;
  upstreamModelId: string;
  displayName: string;
  verifiedCapabilities: ModelCapabilities;
  capabilityEvidence: { source: string; observedAt: string };
  availability: 'unverified' | 'available' | 'unavailable' | 'degraded';
  observedAt?: string;
  catalogRevision: string;
  estimatedCostUsd?: number;
};

export type ModelRouteCandidate = {
  connectionId: string;
  offeringId: string;
  requiredCapabilities?: Partial<ModelCapabilities>;
  allowedResidencies?: string[];
};

export type ModelRoute = {
  id: string;
  organizationId: string;
  name: string;
  purposes: string[];
  selectors: Array<Record<string, unknown>>;
  candidates: ModelRouteCandidate[];
  policy: {
    fallback?: 'never' | 'not-sent' | 'not-sent-or-rejected';
    allowDegraded?: boolean;
    allowedProviderIds?: string[];
    allowedConnectionIds?: string[];
    allowedModelIds?: string[];
    allowedResidencies?: string[];
    maximumEstimatedCostUsdPerTurn?: number;
    grantTtlMs?: number;
    budget?: {
      organizationUsd?: number;
      teamUsd?: number;
      projectUsd?: number;
      userUsd?: number;
    };
  };
  state: 'active' | 'disabled';
  revision: string;
  createdAt: string;
};

export type ProviderGrant = {
  id: string;
  organizationId: string;
  sessionId: string;
  turnId: string;
  providerConnectionId: string;
  modelOfferingId: string;
  routeId: string;
  routeRevision: string;
  connectionRevision: string;
  catalogRevision: string;
  policyRevision: string;
  userId?: string;
  teamId?: string;
  projectId: string;
  purpose: string;
  estimatedCostUsd: number;
  issuedAt: string;
  expiresAt: string;
  digest: string;
};

export type ProviderOutcomeState =
  | 'not-sent'
  | 'rejected'
  | 'interrupted-known'
  | 'uncertain'
  | 'completed';

export type ProviderOutcome = {
  id: string;
  organizationId: string;
  grantId: string;
  classification: ProviderOutcomeState;
  providerRequestId?: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    upstreamCostUsd?: number;
    gatewayCostUsd?: number;
    costUsd?: number;
  };
  evidence: Record<string, unknown>;
  observedAt: string;
  fallbackAllowed: boolean;
  reconciliationRequired: boolean;
  digest: string;
};
