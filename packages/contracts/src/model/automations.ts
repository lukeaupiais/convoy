export type AutomationEvent = string;
export type AutomationCondition = {
  field: string;
  operator: 'equals' | 'notEquals' | 'exists' | 'greaterThan' | 'lessThan';
  value?: string | number | boolean;
};
export type AutomationRule = {
  id: string;
  name: string;
  organizationId: string;
  projectId: string;
  when: { event: AutomationEvent; eventRevision?: number; boardId?: string; columnId?: string; bindingId?: string };
  if: AutomationCondition[];
  then: { action: 'start_workflow'; workflowId: string; workflowVersion: number };
  enabled: boolean;
  concurrency?: { policy: 'reject' | 'hold' | 'independent'; maxActiveRuns: number; overflowPolicy?: 'reject' | 'hold' };
  principal:
    { kind: 'user'; userId: string } | { kind: 'workload'; workloadIdentityId: string } | null;
  revision: number;
};
export type AutomationCapabilities = {
  events: {
    id: AutomationEvent;
    label: string;
    descriptorId?: string;
    revision?: number;
    scope: 'organization' | 'project' | 'resource' | 'board' | 'binding';
    fields: string[];
    payload?: { path: string; type: 'string' | 'number' | 'boolean' | 'enum'; values?: string[]; required?: boolean }[];
    manual?: boolean;
  }[];
  actions: { id: string; label: string }[];
  ruleActions: { id: 'start_workflow'; label: string }[];
};
