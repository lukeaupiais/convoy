import { memo, useMemo, type CSSProperties } from 'react';
import { Flag, UserRound, Plus } from 'lucide-react';
import { Select } from '../../shared/ui/Select';
import { BoardAutomationInspector } from '../workflows/index';
import type { Board, RuntimeState, Ticket, WorkflowReference } from '../../shared/api/runtime';
import type { BoardMoves } from './board-moves';
import { valueFor, columnFor, sourceOwnsBoardField } from './board-fields';

export type BoardViewProps = {
  board: Board;
  tickets: Ticket[];
  state: RuntimeState;
  query: string;
  view: 'board' | 'list';
  runtimeAvailable: boolean;
  runtimeError?: string;
  moves: BoardMoves;
  moveRevision: number;
  projectName: (id?: string) => string;
  onMove: (board: Board, ticket: Ticket, columnId: string) => Promise<void>;
  onSelectTicket: (id: number) => void;
  onNewTicket: (boardId: string, columnId: string) => void;
  onOpenWorkflow: (reference: WorkflowReference) => void;
};

/** Snapshot polling recreates objects; compare only data this view presents. */
export function sameBoardView(previous: BoardViewProps, next: BoardViewProps) {
  if (
    previous.query !== next.query ||
    previous.view !== next.view ||
    previous.runtimeAvailable !== next.runtimeAvailable ||
    previous.runtimeError !== next.runtimeError ||
    previous.moves !== next.moves ||
    previous.moveRevision !== next.moveRevision ||
    previous.projectName !== next.projectName ||
    previous.onMove !== next.onMove ||
    previous.onSelectTicket !== next.onSelectTicket ||
    previous.onNewTicket !== next.onNewTicket ||
    previous.onOpenWorkflow !== next.onOpenWorkflow
  )
    return false;
  const presented = (value: BoardViewProps) => [
    value.board,
    value.tickets,
    value.state.projects,
    value.state.ticketConnections,
    value.state.ticketImportMemberships,
    value.state.boardAutomations?.[value.board.id],
  ];
  return JSON.stringify(presented(previous)) === JSON.stringify(presented(next));
}

export const BoardView = memo(function BoardView({
  board,
  tickets,
  state,
  query,
  view,
  runtimeAvailable,
  runtimeError,
  moves,
  projectName,
  onMove,
  onSelectTicket,
  onNewTicket,
  onOpenWorkflow,
}: BoardViewProps) {
  const boardTickets = useMemo(() => {
    const ids = new Set((board.tickets ?? []).map((p) => p.ticketId));
    const f = board.filters ?? {};
    return tickets.filter(
      (t) =>
        ids.has(t.id) &&
        (!f.query || `${t.title} ${t.description}`.toLowerCase().includes(f.query.toLowerCase())) &&
        (!f.projectIds?.length || f.projectIds.includes(t.projectId)) &&
        (!f.origins?.length || f.origins.includes(t.origin ?? 'convoy')) &&
        (!f.workTypes?.length || f.workTypes.includes(t.workType ?? 'task')) &&
        (!f.importBindingIds?.length ||
          (state.ticketImportMemberships ?? []).some(
            (m) => m.ticketId === t.id && f.importBindingIds?.includes(m.bindingId),
          )) &&
        (!f.statuses?.length || f.statuses.includes(t.status)) &&
        (!f.labels?.length || f.labels.includes(t.label)) &&
        (!f.agents?.length || f.agents.includes(t.agent)) &&
        (!f.priorities?.length || f.priorities.includes(t.priority)) &&
        `${t.title} ${t.id} ${projectName(t.projectId)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  }, [tickets, board, query, projectName, state.ticketImportMemberships]);
  const lanes = useMemo(() => {
    const mode = board.swimlanes?.mode ?? 'none';
    if (mode === 'none') return [{ name: '', tickets: boardTickets }];
    const field = mode === 'field' ? (board.swimlanes.field ?? 'label') : mode;
    const groups = new Map<string, Ticket[]>();
    boardTickets.forEach((t) => {
      const value = valueFor(t, field, state.projects) || 'Unassigned';
      groups.set(value, [...(groups.get(value) ?? []), t]);
    });
    return [...groups].map(([name, laneTickets]) => ({ name, tickets: laneTickets }));
  }, [board, boardTickets, state.projects]);
  return view === 'list' ? (
    <div className="board-ticket-list" data-board-id={board.id}>
      {boardTickets.map((t) => (
        <div className="board-list-row" key={t.id}>
          <button onClick={() => onSelectTicket(t.id)}>
            <span>CVY-{t.id}</span>
            <strong title={t.title}>{t.title}</strong>
            {t.externalPublish && <span aria-label="External creation needs review">⚠</span>}
          </button>
          {t.externalLinks?.[0] && (
            <a
              className="board-external-link"
              href={t.externalLinks[0].url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t.externalLinks[0].provider} ↗
            </a>
          )}
          <Select
            aria-label={`Move CVY-${t.id}`}
            disabled={!runtimeAvailable || Boolean(sourceOwnsBoardField(board, t, state))}
            title={
              !runtimeAvailable
                ? 'Reconnect to refresh before moving tickets.'
                : sourceOwnsBoardField(board, t, state)
                  ? 'This external field does not support writes from Convoy.'
                  : undefined
            }
            value={columnFor(board, t)}
            onChange={(e) => void onMove(board, t, e.target.value)}
          >
            {board.columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </div>
      ))}
    </div>
  ) : (
    <div
      data-board-id={board.id}
      className={`custom-board ${board.density ?? 'comfortable'}`}
      style={{ '--column-count': board.columns.length } as CSSProperties}
    >
      {lanes.map((lane) => (
        <div className="board-lane" key={lane.name || 'all'}>
          {lane.name && (
            <div className="board-lane-title">
              {lane.name}
              <span>{lane.tickets.length}</span>
            </div>
          )}
          <div className="board-columns">
            {board.columns.map((column) => {
              const cards = lane.tickets.filter((t) => columnFor(board, t) === column.id);
              return (
                <section
                  className="custom-column"
                  style={
                    {
                      '--column-color':
                        column.color && CSS.supports('color', column.color)
                          ? column.color
                          : '#87d5cb',
                    } as CSSProperties
                  }
                  key={column.id}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const id = Number(e.dataTransfer.getData('text/plain'));
                    const t = tickets.find((x) => x.id === id);
                    if (runtimeAvailable && t) void onMove(board, t, column.id);
                  }}
                >
                  <header>
                    <span className="column-swatch" style={{ background: 'var(--column-color)' }} />
                    <h2>{column.name}</h2>
                    <BoardAutomationInspector
                      key={`${board.id}:${column.id}`}
                      board={board}
                      columnId={column.id}
                      view={state.boardAutomations?.[board.id]}
                      projects={state.projects}
                      error={runtimeError}
                      onOpen={onOpenWorkflow}
                    />
                    <span>
                      {cards.length}
                      {column.wipLimit ? ` / ${column.wipLimit}` : ''}
                    </span>
                    {runtimeAvailable &&
                      (!board.filters.origins?.length ||
                        board.filters.origins.includes('convoy')) &&
                      !board.filters.importBindingIds?.length && (
                        <button
                          aria-label={`Add ticket to ${column.name}`}
                          onClick={() => onNewTicket(board.id, column.id)}
                        >
                          <Plus size={15} />
                        </button>
                      )}
                  </header>
                  <div className="custom-column-cards">
                    {cards.map((t) => (
                      <article
                        className="custom-card"
                        draggable={runtimeAvailable && !sourceOwnsBoardField(board, t, state)}
                        aria-busy={moves.isBusy(t.id)}
                        key={t.id}
                        onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.id))}
                      >
                        <button className="custom-card-open" onClick={() => onSelectTicket(t.id)}>
                          <span className="ticket-card-heading">
                            <span className="task-id">CVY-{t.id}</span>
                            {t.externalPublish && (
                              <span className="task-id" aria-label="External creation needs review">
                                ⚠
                              </span>
                            )}
                            {board.cardFields.includes('priority') && (
                              <span
                                className={`ticket-priority priority-${t.priority.toLowerCase()}`}
                                title={`${t.priority} priority`}
                              >
                                <Flag size={12} />
                                {t.priority}
                              </span>
                            )}
                          </span>
                          <strong title={t.title}>{t.title}</strong>
                          <span className="ticket-card-tags">
                            {board.cardFields
                              .filter(
                                (f) =>
                                  !['title', 'priority', 'agent', 'project', 'label'].includes(f),
                              )
                              .map((f) => {
                                const value = valueFor(
                                  t as Ticket & { customFields?: Record<string, string> },
                                  f,
                                  state.projects,
                                );
                                return value !== '' ? (
                                  <span className="ticket-label" key={f}>
                                    {f.startsWith('custom.') ? f.slice(7) + ': ' : ''}
                                    {String(value)}
                                  </span>
                                ) : null;
                              })}
                          </span>
                          <span className="ticket-card-footer">
                            {board.cardFields.includes('agent') && (
                              <span className="ticket-assignee" title={t.agent || 'Unassigned'}>
                                <UserRound size={12} />
                                {t.agent || 'Unassigned'}
                              </span>
                            )}
                          </span>
                        </button>
                        {t.externalLinks?.[0] && (
                          <a
                            className="board-external-link"
                            href={t.externalLinks[0].url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {t.externalLinks[0].provider} ↗
                          </a>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}, sameBoardView);
