export type AutomationEvent =
  | 'ticket_created'
  | 'ticket_updated'
  | 'ticket_moved'
  | 'board_placement_changed'
  | 'ticket_imported'
  | 'ticket_source_updated'
  | 'ticket_message_received';
export type AutomationCondition = {
  field: string;
  operator: 'equals';
  value: string | number | boolean;
};
export type AutomationRule = {
  id: string;
  name: string;
  organizationId: string;
  projectId: string;
  when: { event: AutomationEvent; boardId?: string; columnId?: string; bindingId?: string };
  if: AutomationCondition[];
  then: { action: 'start_workflow'; workflowId: string; workflowVersion: number };
  enabled: boolean;
  principal:
    { kind: 'user'; userId: string } | { kind: 'workload'; workloadIdentityId: string } | null;
  revision: number;
};
export type AutomationCapabilities = {
  events: {
    id: AutomationEvent;
    label: string;
    scope: 'project' | 'board' | 'binding';
    fields: string[];
  }[];
  actions: { id: string; label: string }[];
  ruleActions: { id: 'start_workflow'; label: string }[];
};
