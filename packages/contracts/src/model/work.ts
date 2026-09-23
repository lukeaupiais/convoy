import type { ContextFile } from './files';
import type { ExecutionProfileId } from './execution';

export type Placement = {
  mode: 'inherit' | 'none' | 'pinned' | 'pool';
  runnerId?: string;
  poolId?: string;
  requiredTools?: string[];
  requiredTags?: string[];
  preferEnvironmentIds?: string[];
  strategy?: string;
};

export type Project = {
  id: string;
  organizationId: string;
  teamId?: string;
  name: string;
  description: string;
  revision: number;
  placement: Placement;
  executionProfile: ExecutionProfileId;
};
export type TicketScalar = string | number | boolean | null;
export type ExternalTicketLink = {
  connectionId: string;
  provider: string;
  remoteId: string;
  remoteKey: string;
  url: string;
  syncState: 'linked' | 'error' | 'outcome-unknown';
  message?: string;
  remoteTitle?: string;
  remoteDescription?: string;
  remoteStatus?: string;
  mappedStatus?: string;
  remotePriority?: string;
  mappedPriority?: 'Low' | 'Medium' | 'High';
  remoteVersion?: string;
  fieldOwnership?: {
    title: 'convoy' | 'external';
    description: 'convoy' | 'external';
    status?: 'convoy' | 'external';
    priority?: 'convoy' | 'external';
  };
};
export type TicketSourceManifest = {
  apiVersion: 'convoy.dev/v1alpha1';
  kind: 'TicketSource';
  metadata?: { name: string };
  connection: {
    baseUrl: string;
    authentication:
      | { type: 'bearer'; credential: string }
      | { type: 'header'; credential: string; header: string };
  };
  operations: {
    list: {
      method: 'GET';
      path: string;
      query?: Record<string, string>;
      response: { items: string; nextCursor?: string };
    };
    get?: {
      method: 'GET';
      path: string;
      query?: Record<string, string>;
      response: { item: string };
    };
  };
  mapping: {
    remoteId: string;
    remoteKey: string;
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    remoteVersion: string;
    updatedAt?: string;
    url?: string;
    urlTemplate?: string;
  };
  values?: {
    status?: Record<string, string>;
    priority?: Record<string, string>;
  };
  ownership?: {
    title?: 'convoy' | 'external';
    description?: 'convoy' | 'external';
    status?: 'convoy' | 'external';
    priority?: 'convoy' | 'external';
  };
};
type TicketConnectionBase = {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  capabilities?: { import: true; create: boolean; update: boolean };
  revision: number;
};
export type TicketConnection = TicketConnectionBase &
  (
    | { provider: 'linear'; teamId: string; credentialEnv: string; manifest?: never }
    | {
        provider: 'custom-http';
        manifest: TicketSourceManifest;
        teamId?: never;
        credentialEnv?: never;
      }
  );
export type Ticket = {
  id: number;
  executionSessionId?: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  label: string;
  agent: string;
  priority: string;
  customFields?: Record<string, TicketScalar>;
  origin?: 'convoy' | 'external' | 'browser-import' | 'session-migration';
  externalLinks?: ExternalTicketLink[];
  externalPublish?: {
    connectionId: string;
    requestId: string;
    state: 'pending' | 'outcome-unknown';
    message?: string;
  };
  attachments?: ContextFile[];
  revision: number;
  placement: Placement;
  executionProfile: ExecutionProfileId | 'inherit';
  runnerId?: string;
  workflow?: { id: string; name: string; version: number } | null;
  executionStatus?: string;
};
export type TicketDevelopmentLink = {
  id: string;
  supportTicketId: number;
  developmentTicketId: number;
  createdAt: string;
};
export type Conversation = {
  id: string;
  sessionId: string;
  title: string;
  projectId?: string | null;
  linkedTicketIds: number[];
  activeTicketId?: number | null;
  updatedAt?: string;
};

export type BoardColumn = {
  id: string;
  name: string;
  color: string;
  value?: string;
  wipLimit?: number | null;
};

export type BoardPlacement = {
  ticketId: number;
  columnId: string;
  swimlaneKey?: string | null;
  revision?: number;
  source?: 'local' | 'field';
};

export type BoardFilters = {
  projectIds?: string[];
  origins?: NonNullable<Ticket['origin']>[];
  statuses?: string[];
  labels?: string[];
  agents?: string[];
  priorities?: string[];
  query?: string;
};

export type BoardSwimlanes = {
  mode: 'none' | 'project' | 'agent' | 'priority' | 'field';
  field?: string;
  values?: string[];
};

export type BoardGrouping = {
  mode: 'local' | 'field';
  field?: string;
};

export type Board = {
  id: string;
  name: string;
  description: string;
  projectIds: string[];
  columns: BoardColumn[];
  swimlanes: BoardSwimlanes;
  filters: BoardFilters;
  cardFields: string[];
  grouping: BoardGrouping;
  creationPolicy?: { mode: 'convoy' | 'ask' | 'connection'; connectionId?: string };
  destinationConnectionIds?: string[];
  density: 'compact' | 'comfortable' | 'spacious';
  revision: number;
  tickets: BoardPlacement[];
};

export type BoardTemplate = Omit<Board, 'projectIds' | 'tickets'>;
