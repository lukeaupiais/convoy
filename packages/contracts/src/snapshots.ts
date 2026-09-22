import type { CapabilityState } from './model/capabilities';
import type {
  Environment,
  EnvironmentAccessBinding,
  CapacityRequest,
  CapacityStatus,
  ChannelGrant,
  ExecutionProfile,
  Runner,
  RunnerEnrollment,
  RunnerPool,
} from './model/execution';
import type {
  ActiveContext,
  Deployment,
  Membership,
  Organization,
  OrganizationPolicy,
  Team,
  User,
  EnterpriseIdentityProvider,
} from './model/access';
import type {
  ModelOffering,
  ModelRoute,
  ProviderConnection,
  ProviderOutcome,
} from './model/providers';
import type { ApprovalRule, Instruction, Session } from './model/session';
import type { Board, BoardTemplate, Conversation, Project, Ticket, TicketConnection } from './model/work';
import type {
  WorkflowDefinition,
  WorkflowStartRule,
  WorkflowEffect,
  WorkflowTrigger,
  WorkflowTriggerFailure,
} from './model/workflows';
export type ModelCheck = { available: boolean; checkedAt: string; message?: string };
export type RuntimeSnapshot = {
  deployment?: Deployment;
  currentUser?: User;
  activeContext?: ActiveContext;
  availableContexts?: import('./model/access').ContextSummary[];
  organizations?: Organization[];
  teams?: Team[];
  memberships?: Membership[];
  policies?: OrganizationPolicy[];
  identityProviders?: EnterpriseIdentityProvider[];
  providerConnections?: ProviderConnection[];
  modelOfferings?: ModelOffering[];
  modelRoutes?: ModelRoute[];
  providerOutcomes?: ProviderOutcome[];
  approvalRules: ApprovalRule[];
  capabilities?: CapabilityState;
  instructionOwners?: { organizationId: string; userId: string };
  conversations: Conversation[];
  projects: Project[];
  tickets: Ticket[];
  ticketConnections?: TicketConnection[];
  environments: Environment[];
  environmentAccessBindings?: EnvironmentAccessBinding[];
  runnerEnrollments?: RunnerEnrollment[];
  channelGrants?: ChannelGrant[];
  capacityRequests?: CapacityRequest[];
  capacityStatuses?: CapacityStatus[];
  executionProfiles: ExecutionProfile[];
  boards: Board[];
  boardTemplates: BoardTemplate[];
  runnerPools: RunnerPool[];
  scheduler: { maxConcurrent: number };
  workflowDrafts?: Record<string, { workflow: WorkflowDefinition; revision: number }>;
  workflowStartRules?: WorkflowStartRule[];
  defaultWorkflowIds?: { organizations: Record<string, string>; projects: Record<string, string> };
  defaultWorkflowId?: string;
  modelChecks: Record<string, ModelCheck>;
  sessions: Session[];
  models: { id: string }[];
  runners: Runner[];
  workflows: WorkflowDefinition[];
  workflowEffects?: WorkflowEffect[];
  workflowTriggerFailures?: WorkflowTriggerFailure[];
  workflowTriggers?: WorkflowTrigger[];
  instructions: Instruction[];
  auth: {
    source: string;
    connected: boolean;
    device: { state: string; userCode?: string; verificationUri?: string; message?: string };
  };
  adapters: { id: string; kind: string; available: boolean; capabilities: string[] }[];
};
export type RuntimeState = RuntimeSnapshot;
