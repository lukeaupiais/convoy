import type { Ticket, TicketConnection } from '../../shared/api/runtime';

// External ownership and write capability are independent. Only unambiguous
// configured mappings can translate an operator's status into a source value.
export function writableTicketStatuses(ticket: Ticket, connections: TicketConnection[]): string[] | null {
  const owners = ticket.externalLinks?.filter(link => link.fieldOwnership?.status === 'external') ?? [];
  if (!owners.length) return null;
  if (owners.length !== 1) return [];
  const source = connections.find(value => value.id === owners[0].connectionId && value.enabled);
  if (!source?.capabilities?.statusWrite) return [];
  const values = Object.values(source.manifest?.values?.status ?? {});
  return values.filter(value => values.filter(other => other === value).length === 1);
}
