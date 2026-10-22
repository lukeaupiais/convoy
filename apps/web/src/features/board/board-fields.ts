import { writableTicketStatuses } from '../integrations';
import type { Board, RuntimeState, Ticket } from '../../shared/api/runtime';

export const valueFor = (ticket: Ticket, field: string, projects: RuntimeState['projects']) => {
  if (field === 'project')
    return projects.find((project) => project.id === ticket.projectId)?.name ?? 'Project';
  if (field.startsWith('custom.')) return String(ticket.customFields?.[field.slice(7)] ?? '');
  if (
    field === 'label' ||
    field === 'agent' ||
    field === 'priority' ||
    field === 'title' ||
    field === 'status'
  )
    return ticket[field];
  return '';
};
export function columnFor(board: Board, ticket: Ticket) {
  return (
    board.tickets?.find((p) => p.ticketId === ticket.id)?.columnId ?? board.columns[0]?.id ?? ''
  );
}
export const sourceOwnsBoardField = (board: Board, ticket: Ticket, state: RuntimeState) => {
  if (board.grouping.mode !== 'field') return false;
  if (board.grouping.field === 'status') {
    const writable = writableTicketStatuses(ticket, state.ticketConnections ?? []);
    return (
      writable !== null &&
      !board.columns.some((column) => writable.includes(String(column.value ?? column.name)))
    );
  }
  return (
    board.grouping.field === 'priority' &&
    ticket.externalLinks?.some((link) => link.fieldOwnership?.priority === 'external')
  );
};
