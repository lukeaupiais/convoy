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
  name: string;
  hash: string;
  tools: { id: string; hash: string }[];
  skills: { name: string; version: number; hash: string }[];
  extensions: { id: string; revision: string; hash: string }[];
};

export type CapabilityState = {
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
