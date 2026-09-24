import type {
  CapabilityProfile,
  ExtensionManifest,
  ProfileRef,
  SkillRevision,
} from './model/capabilities';
import type {
  Environment,
  EnvironmentAccessBinding,
  ExecutionProfileId,
  Runner,
  RunnerPool,
} from './model/execution';
import type {
  ContextRef,
  Membership,
  MembershipScope,
  OrganizationInvitation,
  PolicyEffect,
  PrincipalRef,
  ServicePrincipal,
  Team,
  WorkloadIdentity,
} from './model/access';
import type { SecurityAuditQuery } from './model/audit';
import type {
  ModelRouteCandidate,
  ProviderConnectionOwner,
  SecretReference,
} from './model/providers';
import type { ContextFile } from './model/session';
import type {
  Board,
  BoardPlacement,
  BoardTemplate,
  Conversation,
  Placement,
  Project,
  Ticket,
  TicketConnection,
} from './model/work';
import type { WorkflowDefinition, WorkflowStartRule } from './model/workflows';

type SessionTarget = { sessionId?: string; taskId?: string | number };
type RequestIdentity = { requestId: string };
type Revision = { revision: number };
type ProfileReference = ProfileRef;
type BoardDefinition = Pick<Board, 'name' | 'columns'> &
  Partial<
    Pick<
      Board,
      | 'id'
      | 'description'
      | 'revision'
      | 'projectIds'
      | 'swimlanes'
      | 'filters'
      | 'cardFields'
      | 'grouping'
      | 'creationPolicy'
      | 'destinationConnectionIds'
      | 'density'
    >
  >;
type BoardTemplateDefinition = Pick<BoardTemplate, 'name' | 'columns'> &
  Partial<
    Pick<
      BoardTemplate,
      | 'id'
      | 'description'
      | 'revision'
      | 'swimlanes'
      | 'filters'
      | 'cardFields'
      | 'grouping'
      | 'creationPolicy'
      | 'destinationConnectionIds'
      | 'density'
    >
  >;

export type RuntimeCommandInputMap = {
  querySecurityAudit: SecurityAuditQuery;
  exportSecurityAudit: SecurityAuditQuery & { format?: 'jsonl' };
  advance: SessionTarget;
  answerQuestion: SessionTarget & { questionId: string; answer: string };
  approveGate: SessionTarget & { instance: string };
  attachContext: SessionTarget & ({ path: string } | { name: string; mime: string; data: string });
  attachTicketFile: {
    taskId: number;
    revision: number;
    name: string;
    mime: string;
    data: string;
  };
  cancelWorkflow: SessionTarget;
  claim: SessionTarget & { label?: string };
  clearBoardPlacement: { boardId: string; ticketId: number; revision: number };
  selectActiveContext: { context: ContextRef };
  createOrganization: {
    slug: string;
    displayName: string;
    kind: 'personal' | 'team' | 'enterprise';
  };
  createTeam: { organizationId: string; slug: string; displayName: string };
  createMembership: {
    organizationId: string;
    principal: PrincipalRef;
    scope: MembershipScope;
    roles: string[];
  };
  updateMembership: {
    organizationId: string;
    membershipId: string;
    roles?: string[];
    state?: 'active' | 'suspended' | 'revoked';
  };
  saveOrganizationPolicy: {
    organizationId: string;
    scope: MembershipScope;
    rules: {
      permissions?: Record<string, PolicyEffect>;
      personalProviders?: PolicyEffect;
      fullSystemAccess?: PolicyEffect;
    };
    baseRevision: number;
  };
  createInvitation: {
    organizationId: string;
    scope: MembershipScope;
    roles: string[];
    email?: string;
    domain?: string;
    ttlMs: number;
  };
  acceptInvitation: { token: string };
  beginOrganizationDomainVerification: {
    organizationId: string;
    domain: string;
    ttlMs?: number;
  };
  completeOrganizationDomainVerification: {
    organizationId: string;
    domainVerificationId: string;
  };
  configureEnterpriseIdentityProvider: {
    organizationId: string;
    protocol: 'oidc' | 'saml';
    issuer: string;
    displayName: string;
    verifiedDomains: string[];
    jit: { enabled: boolean; defaultRoles: string[] };
    scimEnabled: boolean;
    requiredAuthenticationStrength?: string;
    requireMfa?: boolean;
  };
  saveIdentityProviderGroupMapping: {
    organizationId: string;
    identityProviderId: string;
    externalGroupId: string;
    scope: MembershipScope;
    roles: string[];
  };
  provisionExternalIdentity: {
    organizationId: string;
    identityProviderId: string;
    request: Record<string, unknown>;
  };
  deprovisionExternalIdentity: {
    organizationId: string;
    identityProviderId: string;
    request: Record<string, unknown>;
  };
  createWorkloadIdentity: { organizationId: string; displayName: string };
  revokeWorkloadIdentity: {
    organizationId: string;
    workloadIdentityId: string;
    expectedRevision: number;
  };
  createServicePrincipal: { organizationId: string; displayName: string; ttlMs?: number };
  rotateServicePrincipalCredential: {
    organizationId: string;
    servicePrincipalId: string;
    expectedRevision: number;
    ttlMs?: number;
  };
  revokeServicePrincipal: {
    organizationId: string;
    servicePrincipalId: string;
    expectedRevision: number;
  };
  createProviderConnection: {
    organizationId: string;
    providerId: string;
    displayName: string;
    owner: ProviderConnectionOwner;
    endpoint?: { origin: string; region?: string };
    credentialRef?: SecretReference;
    /** One-time input consumed by the daemon credential broker; never persisted or projected. */
    credentialValue?: string;
    governance?: Record<string, unknown>;
  };
  probeProviderConnection: {
    organizationId: string;
    connectionId: string;
    expectedRevision: string;
  };
  rotateProviderCredential: {
    organizationId: string;
    connectionId: string;
    expectedRevision: string;
    credentialValue: string;
  };
  revokeProviderCredential: {
    organizationId: string;
    connectionId: string;
    expectedRevision: string;
  };
  createModelRoute: {
    organizationId: string;
    name: string;
    purposes?: string[];
    selectors?: Array<Record<string, unknown>>;
    candidates: ModelRouteCandidate[];
    policy?: Record<string, unknown>;
  };
  revokeProviderConnection: {
    organizationId: string;
    connectionId: string;
    expectedRevision: string;
    reason?: string;
  };
  saveEnvironmentAccessBinding: Omit<EnvironmentAccessBinding, 'id' | 'revision'> & {
    id?: string;
    revision?: number;
  };
  issueRunnerEnrollment: {
    organizationId: string;
    environmentId: string;
    poolIds?: string[];
    projectIds?: string[];
    authorityCeiling?: 'contained' | 'trusted';
    expectedPlatform?: { platform: string; architecture: string };
    expiresInSeconds?: number;
  };
  redeemRunnerEnrollment: {
    token: string;
    organizationId: string;
    environmentId: string;
    name: string;
    repository: string;
    accessMode?: 'contained' | 'trusted';
    attestation: {
      platform: string;
      architecture: string;
      tools: string[];
      tags?: string[];
      maxConcurrent?: number;
    };
  };
  revokeRunnerEnrollment: { id: string; organizationId: string; revision: number };
  rotateRunnerIdentity: { runnerId: string; organizationId: string; revision: number };
  revokeRunnerIdentity: { runnerId: string; organizationId: string; revision: number };
  configure: SessionTarget & { runnerId?: string; workflow?: string | true };
  connectRemote: { host: string; repository: string; projectIds: string[] };
  continueWorkflow: SessionTarget & { instance: string };
  createBoardFromTemplate: { templateId: string; name: string; projectIds: string[] };
  createConversation: RequestIdentity & {
    title?: string;
    projectId?: string;
    placement?: Placement;
  };
  createTicket: RequestIdentity & {
    projectId: string;
    title: string;
    boardId?: string;
    destination?: string;
    description?: string;
    status?: string;
    label?: string;
    agent?: string;
    priority?: 'Low' | 'Medium' | 'High';
    customFields?: Record<string, string | number | boolean | null>;
  };
  createDevelopmentTicket: RequestIdentity & {
    supportTicketId: number;
    supportRevision: number;
    projectId: string;
    title: string;
    description?: string;
  };
  createRelatedTicket: RequestIdentity & {
    sourceTicketId: number;
    sourceRevision: number;
    title: string;
    description?: string;
    boardId?: string;
    status?: string;
    kind?: string;
  };
  linkTickets: {
    sourceTicketId: number;
    sourceRevision: number;
    targetTicketId: number;
    targetRevision: number;
    kind?: string;
  };
  unlinkTickets: { relationId: string; sourceRevision: number };
  linkDevelopmentTicket: {
    supportTicketId: number;
    supportRevision: number;
    developmentTicketId: number;
    developmentRevision: number;
  };
  unlinkDevelopmentTicket: {
    supportTicketId: number;
    supportRevision: number;
    developmentTicketId: number;
  };
  saveTicketConnection: Partial<Pick<TicketConnection, 'id' | 'revision' | 'enabled'>> &
    Pick<TicketConnection, 'organizationId' | 'name'> &
    (
      | { provider: 'linear'; teamId: string; credentialEnv: string }
      | { provider: 'custom-http'; manifest: import('./model/work').TicketSourceManifest }
    );
  deleteTicketConnection: { id: string; revision: number };
  probeTicketConnection: { id: string };
  previewExternalTickets: { connectionId: string; projectId: string; limit?: number };
  publishTicket: RequestIdentity & { ticketId: number; revision: number; connectionId: string };
  reconcileTicketPublish: {
    ticketId: number;
    revision: number;
    remoteId?: string;
    confirmNotCreated?: true;
  };
  syncExternalTicket: {
    ticketId: number;
    revision: number;
    connectionId: string;
    resolution?: 'local' | 'remote';
  };
  syncExternalTicketThread: { ticketId: number; connectionId: string };
  postExternalTicketReply: RequestIdentity & { ticketId: number; connectionId: string; body: string };
  reconcileExternalTicketReply: { requestId: string; remoteId?: string; confirmNotPosted?: true };
  importExternalTickets: { connectionId: string; projectId: string; limit?: number };
  saveTicketImportBinding: {
    id?: string;
    revision?: number;
    connectionId: string;
    projectId: string;
    name: string;
    workType: string;
    enabled?: boolean;
    pollIntervalMinutes?: number;
  };
  syncTicketImportBinding: { id: string; limit?: number };
  decide: SessionTarget & {
    approvalId: string;
    decision?: 'allow_once' | 'allow_always' | 'deny';
    allow?: boolean;
  };
  deleteBoard: { id: string; revision: number };
  deleteBoardTemplate: { id: string; revision: number };
  diff: SessionTarget;
  discardMessage: SessionTarget & RequestIdentity;
  ensure: { taskId: string | number; title?: string; description?: string };
  exportSkill: { name: string; version?: number; organizationId?: string };
  heartbeat: SessionTarget;
  importTickets: {
    projectId: string;
    tickets: Array<Partial<Ticket> & Pick<Ticket, 'id' | 'title'>>;
  };
  linkTicket: SessionTarget & { ticketId: number };
  openTerminal: SessionTarget & {
    command?: string;
    cols?: number;
    rows?: number;
    timeoutMs?: number;
  };
  openTicketConversation: RequestIdentity & { ticketId: number };
  pauseWorkflow: SessionTarget;
  probeModel: { model: string };
  probeRunner: { runnerId: string };
  publishInstruction: {
    organizationId?: string;
    scope: 'organization' | 'user' | 'project' | 'skill' | 'environment' | 'task';
    target?: string;
    projectId?: string;
    name: string;
    content: string;
  };
  publishProfile: {
    organizationId?: string;
    projectId?: string;
    id?: string;
    name: string;
    tools: string[];
    skills: Array<{ name: string; version: number }>;
    extensions?: Array<{ id: string; revision: string; hash?: string }>;
    baseVersion?: number;
  };
  publishExtension: {
    organizationId?: string;
    projectId?: string;
    manifest: Omit<ExtensionManifest, 'hash' | 'audit'>;
    trusted: boolean;
  };
  publishSkill: {
    organizationId?: string;
    projectId?: string;
    files: Record<string, string>;
    trusted: boolean;
    baseVersion?: number;
    source?: string;
  };
  removeApprovalRule: { ruleId: string };
  removeTicketFile: { taskId: number; revision: number; attachmentId: string };
  readCommandOutput: SessionTarget & { commandId: string; cursor?: number };
  readTerminalOutput: SessionTarget & { terminalId: string; cursor?: number };
  renewChannelGrant: SessionTarget & {
    id: string;
    revision: number;
    expiresInSeconds?: number;
  };
  revokeChannelGrant: SessionTarget & { id: string; revision: number };
  reconcileAssignment: SessionTarget & { token: string; confirmStopped: true };
  reconcileWorkflowEffect: SessionTarget & {
    instance: string;
    effectKey: string;
    resolution: 'applied' | 'not_applied';
    result?: unknown;
  };
  registerRunner: {
    organizationId?: string;
    environmentId?: string;
    kind?: 'local' | 'ssh';
    host?: string;
    name: string;
    repository: string;
    projectIds?: string[];
    accessMode?: Runner['accessMode'];
  };
  release: SessionTarget;
  releaseTicket: SessionTarget;
  rememberContext: SessionTarget & { summary: string };
  requestChanges: SessionTarget & { instance: string; feedback: string };
  requestExecution: SessionTarget & {
    ticketId: number;
    mode: 'continue' | 'delegate' | 'queue';
    brief?: string;
    requestId?: string;
  };
  resumeSession: SessionTarget & RequestIdentity & { acknowledge?: boolean };
  retryWorkflowTrigger: SessionTarget & { triggerKey: string };
  reviseSubmission: SessionTarget & { instance: string; feedback: string };
  runTicket: RequestIdentity & {
    ticketId: number;
    revision: number;
    workflowId: string;
    workflowVersion: number;
    model: string;
    mode: 'new' | 'continue';
    sessionId?: string;
    placement?: Placement;
    profile?: ProfileReference | null;
  };
  saveBoard: BoardDefinition;
  saveBoardTemplate: BoardTemplateDefinition;
  saveEnvironment: Partial<
    Pick<Environment, 'id' | 'organizationId' | 'revision' | 'enabled' | 'maxConcurrent' | 'tags'>
  > &
    Pick<Environment, 'name' | 'kind'> & { host?: string };
  saveProject: Partial<
    Pick<Project, 'id' | 'organizationId' | 'teamId' | 'revision' | 'description'>
  > &
    Pick<Project, 'name'>;
  saveRunnerPool: Partial<Pick<RunnerPool, 'id' | 'revision'>> &
    Pick<RunnerPool, 'name' | 'runnerIds'> & { organizationId?: string };
  saveWorkflow: {
    workflow: WorkflowDefinition;
    organizationId?: string;
    teamId?: string;
    projectId?: string;
    baseVersion?: number;
    makeDefault?: boolean;
  };
  saveWorkflowDraft: {
    workflow: WorkflowDefinition;
    organizationId?: string;
    teamId?: string;
    projectId?: string;
    revision: number;
  };
  saveWorkflowStartRule: {
    organizationId: string;
    rule: Omit<
      WorkflowStartRule,
      'id' | 'organizationId' | 'principal' | 'revision' | 'migratedFrom'
    > & { id?: string };
    revision: number;
  };
  sendMessage: SessionTarget &
    RequestIdentity & {
      text: string;
      model: string;
      mode?: 'queue' | 'interrupt';
      attachmentIds?: string[];
    };
  setBoardPlacement: {
    boardId: string;
    ticketId: number;
    revision: number;
    placement: Pick<BoardPlacement, 'columnId' | 'swimlaneKey'>;
  };
  setCapabilityProfile: SessionTarget & { profile: ProfileReference | null };
  setPlacement: ({ taskId: number } | { projectId: string }) & Revision & { placement: Placement };
  setExecutionProfile: ({ taskId: number } | { projectId: string }) &
    Revision & {
      profile: ExecutionProfileId | 'inherit';
    };
  setProjectProfile: {
    projectId: string;
    profile: ProfileReference | null;
    expected?: ProfileReference | null;
  };
  setScheduler: { organizationId?: string; maxConcurrent: number };
  setToolEnabled: {
    organizationId?: string;
    projectId?: string;
    id: string;
    enabled: boolean;
  };
  start: SessionTarget & RequestIdentity & { text: string; model: string };
  startWorkflow: SessionTarget;
  stop: SessionTarget;
  stopCommand: SessionTarget & { commandId: string };
  stopTerminal: SessionTarget & { terminalId: string };
  terminalConnection: SessionTarget & { terminalId: string };
  terminalStatus: SessionTarget & { terminalId: string };
  updateRunner: Pick<
    Runner,
    'revision' | 'name' | 'maxConcurrent' | 'enabled' | 'tags' | 'projectIds'
  > &
    Partial<Pick<Runner, 'accessMode' | 'organizationId' | 'draining'>> & {
      runnerId: string;
      id?: string;
    };
  updateTicket: {
    taskId: number;
    revision: number;
    patch: Partial<
      Pick<
        Ticket,
        'title' | 'description' | 'status' | 'label' | 'agent' | 'priority' | 'customFields'
      >
    >;
  };
  validateSkill: { files: Record<string, string> };
};

export type RuntimeAction = keyof RuntimeCommandInputMap;
export type RuntimeCommand<Action extends RuntimeAction = RuntimeAction> =
  Action extends RuntimeAction
    ? { action: Action; client: string } & SessionTarget & RuntimeCommandInputMap[Action]
    : never;

type RuntimeCommandKnownResults = {
  acceptInvitation: Membership;
  attachContext: ContextFile;
  attachTicketFile: Ticket;
  connectRemote: { runnerId: string; existing?: boolean };
  createInvitation: { invitation: OrganizationInvitation; token: string };
  createTeam: Team;
  createBoardFromTemplate: Board;
  createConversation: Conversation;
  createWorkloadIdentity: WorkloadIdentity;
  revokeWorkloadIdentity: WorkloadIdentity;
  createServicePrincipal: { servicePrincipal: ServicePrincipal; credential: string };
  rotateServicePrincipalCredential: {
    servicePrincipal: ServicePrincipal;
    credential: string;
  };
  revokeServicePrincipal: ServicePrincipal;
  createTicket: Ticket;
  createDevelopmentTicket: Ticket;
  createRelatedTicket: Ticket;
  linkTickets: import('./model/work').TicketRelation;
  unlinkTickets: { relationId: string };
  linkDevelopmentTicket: import('./model/work').TicketDevelopmentLink;
  unlinkDevelopmentTicket: { supportTicketId: number; developmentTicketId: number };
  saveTicketConnection: TicketConnection;
  deleteTicketConnection: { id: string; deleted: true };
  probeTicketConnection: {
    sourceName: string;
    itemCount?: number;
    sample?: { remoteId: string; remoteKey: string; title: string; description: string };
  };
  previewExternalTickets: {
    wouldImport: number;
    wouldUpdate: number;
    unchanged: number;
    sample?: { remoteId: string; remoteKey: string; title: string; description: string };
  };
  publishTicket: Ticket;
  reconcileTicketPublish: Ticket;
  syncExternalTicket: Ticket;
  importExternalTickets: { imported: number; updated: number };
  saveTicketImportBinding: import('./model/work').TicketImportBinding;
  syncTicketImportBinding: { imported: number; updated: number; complete: boolean; pages: number };
  exportSkill: { files: Record<string, string>; source: string };
  importTickets: { imported: number; conflicts: number[] };
  openTicketConversation: Conversation;
  publishProfile: CapabilityProfile;
  publishSkill: SkillRevision;
  readCommandOutput: { text: string; cursor: number; hasMore: boolean };
  readTerminalOutput: { text: string; cursor: number; hasMore: boolean };
  registerRunner: Runner;
  removeTicketFile: Ticket;
  saveBoard: Board;
  saveBoardTemplate: BoardTemplate;
  saveEnvironment: Environment;
  saveProject: Project;
  saveRunnerPool: RunnerPool;
  saveWorkflow: WorkflowDefinition;
  saveWorkflowDraft: { workflow: WorkflowDefinition; revision: number };
  saveWorkflowStartRule: WorkflowStartRule;
  setPlacement: Project | Ticket;
  setExecutionProfile: Project | Ticket;
  updateRunner: Runner;
  updateTicket: Ticket;
  validateSkill: SkillRevision;
};

export type RuntimeCommandResultMap = {
  [Action in RuntimeAction]: Action extends keyof RuntimeCommandKnownResults
    ? RuntimeCommandKnownResults[Action]
    : void;
};
export type CommandEnvelope<TResult = unknown> = { ok: true; result: TResult };
