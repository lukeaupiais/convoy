export type TicketView = 'details' | 'execution' | 'terminal';

export type TicketNavigationEvent =
  { type: 'ticket-selected' } | { type: 'show'; view: TicketView };

export function ticketNavigationReducer(
  _current: TicketView,
  event: TicketNavigationEvent,
): TicketView {
  return event.type === 'ticket-selected' ? 'details' : event.view;
}
