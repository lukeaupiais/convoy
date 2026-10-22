import type { Board, Ticket } from '../../shared/api/runtime';

type Move = {
  boardId: string;
  ticketId: number;
  columnId: string;
  expectedRevision: number;
  field?: string;
  value?: string;
  revision?: number;
  rollback?: Move;
};

/** Immediate presentation with at most one save in flight per ticket. */
export class BoardMoves {
  private moves = new Map<number, Move>();
  private requests = new Map<number, Move>();
  private revisions = new Map<number, number>();

  isBusy(ticketId: number) {
    return this.requests.has(ticketId);
  }

  canSend(move: Move) {
    return this.requests.get(move.ticketId) === move;
  }

  cancelQueued() {
    let changed = false;
    for (const [ticketId, request] of this.requests) {
      if (this.moves.get(ticketId) !== request) {
        this.moves.set(ticketId, request);
        changed = true;
      }
    }
    return changed;
  }

  start(board: Board, ticket: Ticket, columnId: string) {
    const column = board.columns.find((value) => value.id === columnId);
    const previous = this.moves.get(ticket.id);
    const current =
      previous?.boardId === board.id
        ? previous.columnId
        : board.tickets.find((value) => value.ticketId === ticket.id)?.columnId;
    if (!column || current === columnId) return;
    const field = board.grouping.mode === 'field' ? board.grouping.field : undefined;
    const move: Move = {
      boardId: board.id,
      ticketId: ticket.id,
      columnId,
      expectedRevision: previous?.revision ?? previous?.rollback?.revision ?? ticket.revision,
      field,
      value: field ? String(column.value ?? column.name) : undefined,
      rollback: previous?.revision !== undefined ? previous : previous?.rollback,
    };
    this.moves.set(ticket.id, move);
    if (!this.requests.has(ticket.id)) this.requests.set(ticket.id, move);
    return move;
  }

  accept(move: Move, revision: number): Move | undefined {
    if (!this.canSend(move)) return;
    move.revision = revision;
    delete move.rollback;
    this.requests.delete(move.ticketId);
    const desired = this.moves.get(move.ticketId);
    if (
      desired &&
      desired !== move &&
      (desired.boardId !== move.boardId || desired.columnId !== move.columnId)
    ) {
      desired.expectedRevision = revision;
      desired.rollback = move;
      this.requests.set(move.ticketId, desired);
      return desired;
    }
    if ((this.revisions.get(move.ticketId) ?? -1) >= revision) this.moves.delete(move.ticketId);
    else this.moves.set(move.ticketId, move);
  }

  reject(move: Move) {
    if (!this.canSend(move)) return;
    this.requests.delete(move.ticketId);
    if (
      move.rollback?.revision !== undefined &&
      (this.revisions.get(move.ticketId) ?? -1) < move.rollback.revision
    )
      this.moves.set(move.ticketId, move.rollback);
    else this.moves.delete(move.ticketId);
  }

  reconcile(tickets: Ticket[]) {
    this.revisions = new Map(tickets.map((ticket) => [ticket.id, ticket.revision]));
    let changed = false;
    for (const move of this.moves.values()) {
      const revision = this.revisions.get(move.ticketId);
      if (revision === undefined || (move.revision !== undefined && revision >= move.revision)) {
        this.moves.delete(move.ticketId);
        this.requests.delete(move.ticketId);
        changed = true;
      }
    }
    return changed;
  }

  project(board: Board, tickets: Ticket[]) {
    if (!this.moves.size) return { board, tickets };
    const placements = new Map(
      [...this.moves.values()]
        .filter((move) => move.boardId === board.id)
        .map((move) => [move.ticketId, move.columnId]),
    );
    return {
      board: placements.size
        ? {
            ...board,
            tickets: board.tickets.map((placement) => ({
              ...placement,
              columnId: placements.get(placement.ticketId) ?? placement.columnId,
            })),
          }
        : board,
      tickets: tickets.map((ticket) => {
        const move = this.moves.get(ticket.id);
        if (!move) return ticket;
        const revision = move.revision ?? move.rollback?.revision;
        const projected =
          revision !== undefined && revision > ticket.revision ? { ...ticket, revision } : ticket;
        if (!move.field || move.value === undefined) return projected;
        return move.field.startsWith('custom.')
          ? {
              ...projected,
              customFields: { ...ticket.customFields, [move.field.slice(7)]: move.value },
            }
          : { ...projected, [move.field]: move.value };
      }),
    };
  }
}
