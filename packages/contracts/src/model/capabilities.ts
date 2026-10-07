export type ProfileRef = { id: string; version: number };

export type CapabilityTool = {
  id: string;
  name: string;
  description: string;
  group: string;
  approval: string;
  executor: string;
  inputSchema: unknown;
  available?: boolean;
  reason?: string;
};

export type SkillRevision = {
  sourceId?: string;
  snapshotId?: string;
  runnerId?: string;
  workspaceId?: string;
  organizationId?: string;
  name: string;
  description: string;
  version: number;
  hash: string;
  source: string;
  resources: string[];
  warnings: string[];
};

export type ExtensionTool = {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
  approval: 'none' | 'ask';
};

/** A reviewed, declarative runner-side integration; never daemon-loaded code. */
export type ExtensionManifest = {
  id: string;
  kind: 'mcp' | 'executor';
  revision: string;
  hash: string;
  execution: { location: 'runner'; adapter: string };
  tools: ExtensionTool[];
  audit?: { publishedBy: string; correlationId: string };
};

export type CapabilityProfile = ProfileRef & {
  skillSelections?: SkillSelection[];
  knowledge?: import('./knowledge').KnowledgeSelection;
  loadWorkspaceAgentsMd?: boolean;
  name: string;
  hash: string;
  tools: { id: string; hash: string }[];
  skills: { name: string; version: number; hash: string }[];
  extensions: { id: string; revision: string; hash: string }[];
};

export type CapabilityState = {
  skillCatalogue?: SkillCatalogue;
  skillSnapshots?: Omit<SkillSnapshot, 'files' | 'body'>[];
  tools: CapabilityTool[];
  skills: SkillRevision[];
  extensions: ExtensionManifest[];
  profiles: CapabilityProfile[];
  projectProfiles: Record<string, ProfileRef | null>;
  disabledTools: string[];
};

export type EffectiveCapabilities = {
  profile: CapabilityProfile | null;
  tools: CapabilityTool[];
  skills: (SkillRevision & { active: boolean })[];
};

export type SkillScope = 'personal' | 'project' | 'organization';
export type SkillFile = { path: string; encoding: 'utf8' | 'base64'; content: string };
export type SkillSelection =
  | { mode: 'source-current'; sourceId: string }
  | { mode: 'snapshot-pinned'; snapshotId: string; digest: string };
export type SkillRoot = {
  id: string;
  revision: number;
  organizationId: string;
  scope: SkillScope;
  ownerUserId?: string;
  projectId?: string;
  repositoryId?: string;
  runnerId: string;
  executionIdentity: string;
  path: string;
  approvedCanonicalPath?: string;
  approvedRepositoryPath?: string;
  relevancePath?: string;
  provenance: 'user' | 'project' | 'managed' | 'plugin';
  readable: boolean;
  writable: boolean;
  manageable?: boolean;
  trusted: boolean;
  allowSymlinks: boolean;
  diagnostics?: {
    runnerId: string;
    workspaceId: string;
    state: string;
    message?: string;
    observedAt: string;
  }[];
};
export type SkillSourceInstance = {
  id: string;
  sourceId: string;
  runnerId: string;
  workspaceId: string;
  name?: string;
  description?: string;
  repositoryRevision?: string;
  path: string;
  digest?: string;
  state: 'current' | 'invalid' | 'missing' | 'disconnected' | 'unreadable' | 'unstable' | 'denied';
  diagnostic?: string;
  warnings?: string[];
  observedAt: string;
  generation: number;
};
export type SkillSource = {
  provisionedFrom?: { snapshotId: string; digest: string; sourceId: string; runnerId: string };
  id: string;
  rootId: string;
  organizationId: string;
  scope: SkillScope;
  ownerUserId?: string;
  projectId?: string;
  relativeDirectory: string;
  name: string;
  description: string;
  instances: SkillSourceInstance[];
};
export type SkillSnapshot = {
  id: string;
  sourceId: string;
  rootId: string;
  organizationId: string;
  scope: SkillScope;
  ownerUserId?: string;
  projectId?: string;
  digest: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  warnings: string[];
  trusted: boolean;
  runnerId: string;
  workspaceId: string;
  instanceId: string;
  path: string;
  repositoryRevision?: string;
  capturedAt: string;
};
export type SkillCatalogue = { roots: SkillRoot[]; sources: SkillSource[] };
