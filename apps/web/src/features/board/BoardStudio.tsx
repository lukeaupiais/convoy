import { Select } from '../../shared/ui/Select';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Flag,
  UserRound,
  GripVertical,
  LayoutGrid,
  List,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { command } from '../../shared/api/runtime';
import type { Board, BoardColumn as Column, RuntimeState, Ticket } from '../../shared/api/runtime';
import './studio.css';
import './board-overrides.css';
import './board-theme.css';
import './tickets.css';

type Props = {
  state: RuntimeState;
  projectId: string;
  tickets: Ticket[];
  projectName: (id?: string) => string;
  onSelectTicket: (id: number) => void;
  onNewTicket: (boardId: string, columnId: string) => void;
  onManageIntegrations: () => void;
};
const starter: Board = {
  id: 'new-board',
  name: 'Untitled board',
  description: '',
  projectIds: [],
  columns: [
    { id: 'column-1', name: 'Inbox', color: '#648d7d' },
    { id: 'column-2', name: 'Doing', color: '#b18d63' },
    { id: 'column-3', name: 'Complete', color: '#8d91af' },
  ],
  revision: 0,
  swimlanes: { mode: 'none' },
  filters: {},
  cardFields: ['project', 'priority', 'agent'],
  grouping: { mode: 'local' },
  density: 'comfortable',
  tickets: [],
};
const boardData = (state: RuntimeState) => state.boards;
const templateData = (state: RuntimeState) => state.boardTemplates;
const valueFor = (ticket: Ticket, field: string, projects: RuntimeState['projects']) => {
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
function columnFor(board: Board, ticket: Ticket) {
  return (
    board.tickets?.find((p) => p.ticketId === ticket.id)?.columnId ?? board.columns[0]?.id ?? ''
  );
}

export function BoardStudio({
  state,
  projectId,
  tickets,
  projectName,
  onSelectTicket,
  onNewTicket,
  onManageIntegrations,
}: Props) {
  const boards = boardData(state).filter((value) => value.projectIds.includes(projectId));
  const templates = templateData(state);
  const available = boards.length ? boards : [{ ...starter, projectIds: [projectId] }];
  const [boardId, setBoardId] = useState(available[0].id);
  const board = available.find((b) => b.id === boardId) ?? available[0];
  const [boardQuery, setBoardQuery] = useState('');
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const boardMenu = useRef<HTMLDetailsElement>(null);
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null);
  useEffect(() => setHeaderTarget(document.getElementById('board-context-slot')), []);
  useEffect(() => {
    if (!boardMenuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!boardMenu.current?.contains(event.target as Node)) setBoardMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBoardMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [boardMenuOpen]);
  const [draft, setDraft] = useState<Board>(board);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const organizationId = state.projects.find((project) => project.id === projectId)?.organizationId;
  const connections = (state.ticketConnections ?? []).filter((value) => value.organizationId === organizationId);
  useEffect(() => {
    if (!editing) setDraft(board);
  }, [boardId, board, editing]);
  const boardTickets = useMemo(() => {
    const ids = new Set((board.tickets ?? []).map((p) => p.ticketId));
    const f = board.filters ?? {};
    return tickets.filter(
      (t) =>
        ids.has(t.id) &&
        (!f.query || `${t.title} ${t.description}`.toLowerCase().includes(f.query.toLowerCase())) &&
        (!f.projectIds?.length || f.projectIds.includes(t.projectId)) &&
        (!f.statuses?.length || f.statuses.includes(t.status)) &&
        (!f.labels?.length || f.labels.includes(t.label)) &&
        (!f.agents?.length || f.agents.includes(t.agent)) &&
        (!f.priorities?.length || f.priorities.includes(t.priority)) &&
        `${t.title} ${t.id} ${projectName(t.projectId)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  }, [tickets, board, query, projectName]);
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
  function patch(p: Partial<Board>) {
    setDraft((d) => ({ ...d, ...p }));
  }
  function patchColumn(id: string, p: Partial<Column>) {
    patch({ columns: draft.columns.map((c) => (c.id === id ? { ...c, ...p } : c)) });
  }
  function reorder(index: number, delta: number) {
    const columns = [...draft.columns];
    [columns[index], columns[index + delta]] = [columns[index + delta], columns[index]];
    patch({ columns });
  }
  async function save(asTemplate = false) {
    setSaving(true);
    setMessage('');
    try {
      await command(asTemplate ? 'saveBoardTemplate' : 'saveBoard', {
        ...draft,
        id: asTemplate ? undefined : draft.id,
        revision: asTemplate ? undefined : draft.revision,
        columns: draft.columns.map((c) => ({ ...c, wipLimit: c.wipLimit || undefined })),
      });
      setMessage(asTemplate ? 'Template saved.' : 'Board saved.');
      if (!asTemplate) setEditing(false);
    } catch (e) {
      setMessage(`${asTemplate ? 'Template' : 'Board'} was not saved: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  async function deleteBoard() {
    setSaving(true);
    try {
      await command('deleteBoard', { id: board.id, revision: board.revision });
      setMessage('Board deleted.');
    } catch (e) {
      setMessage(`Board was not deleted: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  async function deleteTemplate() {
    if (!templateId) return;
    const template = templates.find((value) => value.id === templateId);
    if (!template) {
      setMessage('Template was not found.');
      return;
    }
    setSaving(true);
    try {
      await command('deleteBoardTemplate', { id: templateId, revision: template.revision });
      setTemplateId('');
      setMessage('Template deleted.');
    } catch (e) {
      setMessage(`Template was not deleted: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  async function move(ticket: Ticket, columnId: string) {
    setMessage('');
    try {
      await command('setBoardPlacement', {
        boardId: board.id,
        ticketId: ticket.id,
        revision: ticket.revision,
        placement: { columnId },
      });
      setMessage('Placement saved.');
    } catch (e) {
      setMessage(`Placement was not saved: ${(e as Error).message}`);
    }
  }
  function newBoard() {
    const value = {
      ...starter,
      id: `board-${Date.now()}`,
      projectIds: [projectId],
      columns: starter.columns.map((c) => ({ ...c })),
    };
    setDraft(value);
    setBoardId(value.id);
    setEditing(true);
  }
  return (
    <section className="board-studio" aria-label="Custom board workspace">
      {headerTarget &&
        createPortal(
          <div className="board-picker">
            <details
              ref={boardMenu}
              className="board-switcher"
              open={boardMenuOpen}
              onToggle={(event) => setBoardMenuOpen(event.currentTarget.open)}
            >
              <summary aria-label="Choose board">
                {editing && draft.id === boardId ? draft.name : board.name}{' '}
                <span aria-hidden="true">⌄</span>
              </summary>
              {boardMenuOpen && (
                <div className="board-switcher-menu">
                  <input
                    autoFocus
                    aria-label="Search boards"
                    placeholder="Search boards…"
                    value={boardQuery}
                    onChange={(event) => setBoardQuery(event.target.value)}
                  />
                  <div className="board-switcher-options">
                    {boards
                      .filter((value) =>
                        value.name.toLowerCase().includes(boardQuery.toLowerCase()),
                      )
                      .map((value) => (
                        <button
                          type="button"
                          key={value.id}
                          onClick={() => {
                            setBoardId(value.id);
                            setBoardMenuOpen(false);
                            setBoardQuery('');
                            setEditing(false);
                          }}
                        >
                          {value.name}
                          {value.id === board.id && <span aria-hidden="true">✓</span>}
                        </button>
                      ))}
                    {!boards.some((value) =>
                      value.name.toLowerCase().includes(boardQuery.toLowerCase()),
                    ) && <span className="board-switcher-empty">No boards found</span>}
                  </div>
                  <button
                    type="button"
                    className="board-switcher-create"
                    onClick={() => {
                      newBoard();
                      setBoardMenuOpen(false);
                      setBoardQuery('');
                    }}
                  >
                    <Plus size={14} /> New board
                  </button>
                </div>
              )}
            </details>
            <button
              className="icon-button"
              aria-label="Configure board"
              disabled={editing && draft.id !== board.id}
              onClick={() => {
                setDraft(board);
                setEditing((value) => !value);
              }}
            >
              <Settings2 size={15} />
            </button>
          </div>,
          headerTarget,
        )}
      <div className="board-studio-header">
        <div className="board-studio-actions">
          <div className="view-toggle">
            <button
              aria-label="Board view"
              className={view === 'board' ? 'chosen' : ''}
              onClick={() => setView('board')}
            >
              <LayoutGrid size={15} />
            </button>
            <button
              aria-label="List view"
              className={view === 'list' ? 'chosen' : ''}
              onClick={() => setView('list')}
            >
              <List size={15} />
            </button>
          </div>
          <input
            className="board-search"
            aria-label="Filter board tickets"
            placeholder="Filter tickets…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {editing && (
        <div className="board-settings">
          <div className="board-settings-heading">
            <div>
              <strong>Configure board</strong>
              <span className="muted">Columns, membership, filters, grouping and cards</span>
            </div>
            <button
              className="icon-button"
              aria-label="Close board settings"
              onClick={() => setEditing(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="board-settings-grid">
            <fieldset className="board-integrations">
              <legend>Integrations</legend>
              <label>
                New tickets on this board
                <Select
                  value={draft.creationPolicy?.mode === 'connection' ? `connection:${draft.creationPolicy.connectionId}` : draft.creationPolicy?.mode ?? 'convoy'}
                  onChange={(event) => {
                    const value = event.target.value;
                    patch({ creationPolicy: value.startsWith('connection:')
                      ? { mode: 'connection', connectionId: value.slice(11) }
                      : { mode: value as 'convoy' | 'ask' } });
                  }}
                >
                  <option value="convoy">Convoy only</option>
                  {draft.creationPolicy?.mode === 'connection' && !connections.some((value) => value.enabled && value.id === draft.creationPolicy?.connectionId) &&
                    <option value={`connection:${draft.creationPolicy.connectionId}`} disabled>Connection unavailable</option>}
                  {(draft.destinationConnectionIds?.length ?? 0) > 0 && <option value="ask">Ask each time</option>}
                  {connections.filter((value) => value.enabled && value.capabilities?.create !== false && draft.destinationConnectionIds?.includes(value.id)).map((value) => <option key={value.id} value={`connection:${value.id}`}>Create in {value.name}</option>)}
                </Select>
              </label>
              {connections.map((value) => (
                <div key={value.id} className="board-integration-connection">
                  <label>
                    <input type="checkbox" checked={draft.destinationConnectionIds?.includes(value.id) ?? false} disabled={!value.enabled && !draft.destinationConnectionIds?.includes(value.id)} onChange={(event) => {
                      const ids = draft.destinationConnectionIds ?? [];
                      patch({ destinationConnectionIds: event.target.checked ? [...ids, value.id] : ids.filter((id) => id !== value.id),
                        creationPolicy: !event.target.checked && draft.creationPolicy?.connectionId === value.id ? { mode: 'convoy' } : draft.creationPolicy });
                    }} />
                    {value.name}{!value.enabled && ' · Disabled'}
                  </label>
                  <button className="secondary" type="button" disabled={saving || !value.enabled} onClick={async () => {
                    setSaving(true);
                    try {
                      const response = await command('previewExternalTickets', { connectionId: value.id, projectId, limit: 10 });
                      setMessage(`Preview: ${response.result.wouldImport} new, ${response.result.wouldUpdate} changed, ${response.result.unchanged} unchanged.`);
                    } catch (error) {
                      setMessage(`Preview failed: ${(error as Error).message}`);
                    } finally {
                      setSaving(false);
                    }
                  }}>Preview</button>
                  <button className="secondary" type="button" disabled={saving || !value.enabled} onClick={async () => {
                    setSaving(true);
                    try {
                      const response = await command('importExternalTickets', { connectionId: value.id, projectId, limit: 50 });
                      setMessage(`Imported ${response.result.imported} and updated ${response.result.updated} tickets.`);
                    } catch (error) {
                      setMessage(`Import failed: ${(error as Error).message}`);
                    } finally {
                      setSaving(false);
                    }
                  }}>Import tickets</button>
                </div>
              ))}
              <button className="secondary" type="button" onClick={onManageIntegrations}>Manage connections</button>
            </fieldset>
            <label>
              Board name
              <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
            </label>
            <label>
              Density
              <Select
                value={draft.density ?? 'comfortable'}
                onChange={(e) => patch({ density: e.target.value as Board['density'] })}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </Select>
            </label>
            <label>
              Swimlanes
              <Select
                value={draft.swimlanes.mode}
                onChange={(e) =>
                  patch({
                    swimlanes: {
                      mode: e.target.value as Board['swimlanes']['mode'],
                      field: e.target.value === 'field' ? 'label' : undefined,
                    },
                  })
                }
              >
                <option value="none">None</option>
                <option value="project">Project</option>
                <option value="agent">Agent</option>
                <option value="priority">Priority</option>
                <option value="field">Custom field</option>
              </Select>
            </label>
            {draft.swimlanes.mode === 'field' && (
              <label>
                Swimlane field
                <input
                  value={draft.swimlanes.field ?? ''}
                  placeholder="label or custom.team"
                  onChange={(e) =>
                    patch({ swimlanes: { ...draft.swimlanes, field: e.target.value } })
                  }
                />
              </label>
            )}
            <label>
              Grouping
              <Select
                value={draft.grouping.mode}
                onChange={(e) =>
                  patch({
                    grouping: {
                      mode: e.target.value as Board['grouping']['mode'],
                      field: e.target.value === 'field' ? 'status' : undefined,
                    },
                  })
                }
              >
                <option value="local">Board-local placement</option>
                <option value="field">Shared ticket field</option>
              </Select>
            </label>
            {draft.grouping.mode === 'field' && (
              <label>
                Grouping field
                <input
                  value={draft.grouping.field ?? ''}
                  placeholder="status or custom.team"
                  onChange={(e) =>
                    patch({ grouping: { ...draft.grouping, field: e.target.value } })
                  }
                />
              </label>
            )}
            <label>
              Search filter
              <input
                value={draft.filters.query ?? ''}
                onChange={(e) =>
                  patch({ filters: { ...draft.filters, query: e.target.value || undefined } })
                }
              />
            </label>
            <label>
              Status filter
              <input
                placeholder="Backlog, Ready"
                value={(draft.filters.statuses ?? []).join(', ')}
                onChange={(e) =>
                  patch({
                    filters: {
                      ...draft.filters,
                      statuses: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <label>
              Labels
              <input
                placeholder="comma-separated"
                value={(draft.filters.labels ?? []).join(', ')}
                onChange={(e) =>
                  patch({
                    filters: {
                      ...draft.filters,
                      labels: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <label>
              Agents
              <input
                placeholder="comma-separated"
                value={(draft.filters.agents ?? []).join(', ')}
                onChange={(e) =>
                  patch({
                    filters: {
                      ...draft.filters,
                      agents: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <label>
              Priorities
              <input
                placeholder="Low, Medium, High"
                value={(draft.filters.priorities ?? []).join(', ')}
                onChange={(e) =>
                  patch({
                    filters: {
                      ...draft.filters,
                      priorities: e.target.value
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
            </label>
            <fieldset className="board-columns">
              <legend>Columns</legend>
              {draft.columns.map((c, i) => (
                <div className="board-column-editor" key={c.id}>
                  <GripVertical size={14} />
                  <input
                    aria-label={`Column ${i + 1} name`}
                    value={c.name}
                    onChange={(e) => patchColumn(c.id, { name: e.target.value })}
                  />
                  <input
                    aria-label={`Column ${i + 1} color`}
                    type="color"
                    value={c.color.startsWith('#') ? c.color : '#648d7d'}
                    onChange={(e) => patchColumn(c.id, { color: e.target.value })}
                  />
                  <input
                    aria-label={`Column ${i + 1} field value`}
                    placeholder="value (optional)"
                    value={c.value ?? ''}
                    onChange={(e) => patchColumn(c.id, { value: e.target.value || undefined })}
                  />
                  <input
                    aria-label={`Column ${i + 1} WIP limit`}
                    type="number"
                    min="1"
                    placeholder="WIP"
                    value={c.wipLimit ?? ''}
                    onChange={(e) =>
                      patchColumn(c.id, {
                        wipLimit: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                  <button
                    className="icon-button"
                    aria-label={`Move ${c.name} left`}
                    disabled={i === 0}
                    onClick={() => reorder(i, -1)}
                  >
                    ←
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Move ${c.name} right`}
                    disabled={i === draft.columns.length - 1}
                    onClick={() => reorder(i, 1)}
                  >
                    →
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Delete ${c.name}`}
                    disabled={draft.columns.length <= 1}
                    onClick={() => patch({ columns: draft.columns.filter((x) => x.id !== c.id) })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  patch({
                    columns: [
                      ...draft.columns,
                      { id: `column-${Date.now()}`, name: 'New column', color: '#648d7d' },
                    ],
                  })
                }
              >
                <Plus size={14} />
                Add column
              </button>
            </fieldset>
            <fieldset className="card-field-picker">
              <legend>Card fields</legend>
              <div className="card-field-options">
                {['title', 'project', 'priority', 'agent', 'label'].map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={draft.cardFields.includes(field)}
                      onChange={(e) =>
                        patch({
                          cardFields: e.target.checked
                            ? [...draft.cardFields, field]
                            : draft.cardFields.filter((value) => value !== field),
                        })
                      }
                    />
                    {field === 'title' ? 'Title' : field[0].toUpperCase() + field.slice(1)}
                  </label>
                ))}
                {draft.cardFields
                  .filter((field) => field.startsWith('custom.'))
                  .map((field) => (
                    <span className="card-field-chip" key={field}>
                      <label>
                        <input
                          type="checkbox"
                          checked
                          onChange={(e) =>
                            patch({
                              cardFields: e.target.checked
                                ? [...draft.cardFields, field]
                                : draft.cardFields.filter((value) => value !== field),
                            })
                          }
                        />
                        {field.slice(7)}
                      </label>
                      <button
                        type="button"
                        aria-label={`Remove ${field.slice(7)} card field`}
                        onClick={() =>
                          patch({ cardFields: draft.cardFields.filter((value) => value !== field) })
                        }
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
              </div>
              <div className="add-card-field">
                <input
                  aria-label="Custom card field name"
                  placeholder="Add custom field, e.g. team"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                      e.preventDefault();
                      const raw = e.currentTarget.value.trim();
                      const field = raw.startsWith('custom.') ? raw : `custom.${raw}`;
                      if (!draft.cardFields.includes(field))
                        patch({ cardFields: [...draft.cardFields, field] });
                      e.currentTarget.value = '';
                    }
                  }}
                />
                <span className="muted">Enter to add</span>
              </div>
            </fieldset>
          </div>
          <div className="board-template-row">
            <label>
              Template
              <Select
                aria-label="Choose board template"
                value={templateId}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  const t = templates.find((x) => x.id === e.target.value);
                  if (t)
                    setDraft({
                      ...starter,
                      ...t,
                      id: draft.id,
                      projectIds: draft.projectIds,
                      revision: draft.revision,
                      columns: t.columns.map((c) => ({ ...c })),
                    });
                }}
              >
                <option value="">Choose template…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </label>
            <span />
            <button
              className="secondary"
              disabled={saving || !templateId}
              onClick={() => {
                if (window.confirm('Delete this board template?')) void deleteTemplate();
              }}
            >
              Delete template
            </button>
            <button className="secondary" disabled={saving} onClick={() => void save(true)}>
              Save as template
            </button>
            <button
              className="secondary"
              disabled={saving || draft.id !== board.id}
              onClick={() => {
                if (window.confirm('Delete this board?')) void deleteBoard();
              }}
            >
              Delete board
            </button>
            <button
              className="primary"
              disabled={saving || !draft.name.trim()}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save board'}
            </button>
          </div>
        </div>
      )}
      {view === 'list' ? (
        <div className="board-ticket-list">
          {boardTickets.map((t) => (
            <div className="board-list-row" key={t.id}>
              <button onClick={() => onSelectTicket(t.id)}>
                <span>CVY-{t.id}</span>
                <strong>{t.title}</strong>
                {t.externalPublish && <span aria-label="External creation needs review">⚠</span>}
              </button>
              {t.externalLinks?.[0] && <a className="board-external-link" href={t.externalLinks[0].url} target="_blank" rel="noopener noreferrer">{t.externalLinks[0].provider} ↗</a>}
              <Select
                aria-label={`Move CVY-${t.id}`}
                value={columnFor(board, t)}
                onChange={(e) => void move(t, e.target.value)}
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
                      key={column.id}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        const id = Number(e.dataTransfer.getData('text/plain'));
                        const t = tickets.find((x) => x.id === id);
                        if (t) void move(t, column.id);
                      }}
                    >
                      <header>
                        <span className="column-swatch" style={{ background: column.color }} />
                        <h2>{column.name}</h2>
                        <span>
                          {cards.length}
                          {column.wipLimit ? ` / ${column.wipLimit}` : ''}
                        </span>
                        <button
                          aria-label={`Add ticket to ${column.name}`}
                          onClick={() => onNewTicket(board.id, column.id)}
                        >
                          <Plus size={15} />
                        </button>
                      </header>
                      <div className="custom-column-cards">
                        {cards.map((t) => (
                          <article
                            className="custom-card"
                            draggable
                            key={t.id}
                            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(t.id))}
                          >
                            <button
                              className="custom-card-open"
                              onClick={() => onSelectTicket(t.id)}
                            >
                              <span className="ticket-card-heading">
                                <span className="task-id">CVY-{t.id}</span>
                                {t.externalPublish && <span className="task-id" aria-label="External creation needs review">⚠</span>}
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
                              <strong>{t.title}</strong>
                              <span className="ticket-card-tags">
                                {board.cardFields
                                  .filter(
                                    (f) => !['title', 'priority', 'agent', 'project'].includes(f),
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
                                {board.cardFields.includes('project') && (
                                  <span className="ticket-project">{projectName(t.projectId)}</span>
                                )}
                                {board.cardFields.includes('agent') && (
                                  <span className="ticket-assignee" title={t.agent || 'Unassigned'}>
                                    <UserRound size={12} />
                                    {t.agent || 'Unassigned'}
                                  </span>
                                )}
                              </span>
                            </button>
                            {t.externalLinks?.[0] && <a className="board-external-link" href={t.externalLinks[0].url} target="_blank" rel="noopener noreferrer">{t.externalLinks[0].provider} ↗</a>}
                            <Select
                              className="card-move"
                              aria-label={`Move CVY-${t.id}`}
                              value={columnFor(board, t)}
                              onChange={(e) => void move(t, e.target.value)}
                            >
                              {board.columns.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </Select>
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
      )}
      {message && (
        <p className="board-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
