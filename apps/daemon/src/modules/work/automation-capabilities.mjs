/** Work owns completed ticket facts and descriptions of its command effects. */
export const workAutomationCapabilities = {
  events: [
    ['ticket_created','Ticket created','project'], ['ticket_updated','Ticket updated','project'],
    ['ticket_moved','Column entered','board'], ['board_placement_changed','Placement changed','board'],
    ['ticket_imported','Ticket imported','binding'], ['ticket_source_updated','Source updated','binding'],
    ['ticket_message_received','Message received','binding'],
  ].map(([id,label,scope]) => ({id,label,scope,fields:['workType','status']})),
  actions: [
    ['create_ticket','Create ticket'], ['update_ticket','Update ticket'], ['move_ticket','Move ticket'],
    ['create_related_ticket','Create related ticket'], ['set_external_status','Set external status'],
  ].map(([id,label]) => ({id,label})),
};

/** Resolve declared command effects against authorized Work configuration only. */
export function resolveBoardEffect({ operation, input, board, connections = [], bindings = [], tickets = [], projectId }) {
  if (input.boardId && input.boardId !== board.id) return null;
  if (projectId && !board.projectIds.includes(projectId)) return null;
  if (input.projectId && !board.projectIds.includes(input.projectId)) return null;
  const targetId = input.ticketId ?? input.taskId;
  if (targetId !== undefined) {
    const target = tickets.find(ticket => String(ticket.id) === String(targetId));
    if (!target || !board.projectIds.includes(target.projectId)) return null;
  }
  if (input.ticketSource === 'last_created') return { label: 'Affects previously created ticket', unresolved: true };
  if (operation === 'move_ticket') {
    if (input.boardId !== board.id) return null;
    const column = board.columns.find(c => c.id === input.placement?.columnId);
    return column ? { columnId: column.id, label: `Move → ${column.name}`, indirect: false } : { label: 'Move ticket', unresolved: true };
  }
  if (!['update_ticket','set_external_status','create_ticket','create_related_ticket'].includes(operation)) return null;
  const creation = operation === 'create_ticket' || operation === 'create_related_ticket';
  if (creation && input.boardId !== board.id) return null;
  let field = board.grouping?.field;
  const fields = operation === 'update_ticket' ? input.patch ?? {} : input;
  let value = field?.startsWith('custom.') ? fields.customFields?.[field.slice(7)] : fields[field];
  let indirect = false;
  let binding;
  if (operation === 'set_external_status') {
    const connection = connections.find(c => c.id === input.connectionId);
    if (!connection) return null; // No visibility into this connection.
    const eligible = bindings.filter(b => b.connectionId === connection.id && board.projectIds.includes(b.projectId) && (!projectId || b.projectId === projectId));
    if (!eligible.length) return null;
    const scoped = eligible.filter(b => !board.filters?.importBindingIds?.length || board.filters.importBindingIds.includes(b.id));
    if (!scoped.length) return null;
    binding = scoped[0];
    if (board.filters?.workTypes?.length && !scoped.some(b => board.filters.workTypes.includes(b.workType))) return null;
    if (field !== 'status') return null;
    value = connection.manifest?.values?.status?.[input.status];
    if (!connection.manifest?.operations?.status || value === undefined)
      return { label: 'Set external status', unresolved: true, indirect: true };
    indirect = true;
  }
  if (board.grouping?.mode !== 'field') return creation ? { label: 'Create related work', unresolved: true } : null;
  if (value === undefined) return operation === 'update_ticket' ? null : { label: 'Create related work', unresolved: true };
  const filters = board.filters ?? {};
  // Arbitrary query or fields whose eventual values are unknown cannot prove placement.
  if (filters.query || ['labels','agents','priorities'].some(key => filters[key]?.length) ||
      (!binding && !creation && (filters.workTypes?.length || filters.importBindingIds?.length || filters.origins?.length)))
    return { label: `Sets ${field}`, unresolved: true, indirect };
  if (filters.statuses?.length && field === 'status' && !filters.statuses.includes(value)) return null;
  if (filters.origins?.length && !filters.origins.includes(binding ? 'external' : 'convoy')) return null;
  const column = board.columns.find(c => c.value === value);
  if (!column) return { label: `Sets ${field}`, unresolved: true, indirect };
  return { columnId: column.id, label: `${creation ? 'Creates in' : 'Sets'} ${column.name}`, indirect,
    ...(binding ? { bindingId: binding.id, detail: `Source status ${input.status} → ${field}: ${String(value)}` } : {}), field, value };
}
