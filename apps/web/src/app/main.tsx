import { Select } from '../shared/ui/Select';
import { TicketExecution } from '../features/tickets/TicketExecution';
import { TicketDetails } from '../features/tickets/TicketDetails';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, Check, Copy, Menu, MoreHorizontal, Plus, X } from 'lucide-react';
import '../shared/styles/styles.css';
import '../shared/styles/minimal.css';
import { ChatWorkspace } from '../features/chat/ChatWorkspace';
import { NewChatDialog } from '../features/chat/ChatWorkspaceContext';
import { RuntimeSessions } from '../features/sessions/RuntimeViews';
import { liveModel } from '../features/sessions/sessionMonitor';
import { SettingsPage } from './SettingsPage';
import { command, useRuntime, type ContextRef } from '../shared/api/runtime';
import { copyText, newId } from '../shared/lib/browser';
import { ProjectSettings } from '../features/projects/ProjectSettings';
import '../shared/styles/mobile.css';
import { Sidebar } from './Sidebar';
import '../shared/styles/navigation.css';
import { BoardStudio } from '../features/board/BoardStudio';
import '../shared/styles/readability.css';
import '../shared/styles/identity.css';
import { ActiveContext } from '../features/access';
import { ProjectSwitcher } from '../features/access/ProjectSwitcher';

type Status = 'Backlog' | 'Ready' | 'In progress' | 'In review' | 'Done';
type Task = {
  id: number;
  executionSessionId?: string;
  projectId?: string;
  title: string;
  description: string;
  status: string;
  label: string;
  agent: string;
  priority: string;
  remote: boolean;
};
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function App() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      document.documentElement.style.setProperty(
        '--viewport-height',
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.classList.toggle(
        'keyboard-open',
        (viewport?.height ?? window.innerHeight) < 500 &&
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? ''),
      );
    };
    update();
    viewport?.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
    };
  }, []);
  const { state: liveRuntime, error: runtimeError } = useRuntime();
  const [browserDrafts] = useState<Task[]>(() => read('convoy.tasks.v1', []));
  const [projectId, setProjectId] = useState('');
  const project =
    liveRuntime?.projects?.find((p) => p.id === projectId) ??
    liveRuntime?.projects?.find((p) => p.id === liveRuntime.activeContext?.projectId) ??
    liveRuntime?.projects?.[0];
  const tasks: Task[] = (liveRuntime?.tickets ?? []).map((t) => ({
    ...t,
    agent: t.agent,
    remote: liveRuntime?.runners.find((r) => r.id === t.runnerId)?.kind === 'ssh',
  }));
  const [collapsed, setCollapsed] = useState(() => read('convoy.sidebar.collapsed', false));
  const [pins, setPins] = useState<number[]>(() => {
    const value = read<unknown>('convoy.pins.v1', []);
    return Array.isArray(value) ? value.filter(Number.isSafeInteger) : [];
  });
  function togglePin(id: number) {
    setPins((ids) => {
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      try {
        localStorage.setItem('convoy.pins.v1', JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  const projectName = (id?: string) =>
    liveRuntime?.projects.find((p) => p.id === id)?.name ?? 'Project';
  const [saving, setSaving] = useState(false);
  const createRequest = useRef('');
  const [page, setPage] = useState('Project board');
  const [selected, setSelected] = useState<number | null>(null);
  const [newTask, setNewTask] = useState<Status | null>(null);
  const [newTaskDestination, setNewTaskDestination] = useState('');
  const [newTaskPlacement, setNewTaskPlacement] = useState<{
    boardId: string;
    columnId: string;
  } | null>(null);
  const [pendingPlacement, setPendingPlacement] = useState<{
    boardId: string;
    columnId: string;
    ticketId: number;
    revision: number;
  } | null>(null);
  const [toast, setToast] = useState('');
  async function selectContext(context: ContextRef) {
    try {
      await command('selectActiveContext', { context });
      setProjectId(context.projectId);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Context selection failed.');
    }
  }
  const [mobile, setMobile] = useState(false);
  const [ticketView, setTicketView] = useState<'details' | 'execution' | 'terminal'>('details');
  const [ticketMenuOpen, setTicketMenuOpen] = useState(false);
  const [chatConversationId, setChatConversationId] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  useEffect(() => {
    const ticket = liveRuntime?.tickets.find((value) => value.id === selected);
    const execution = liveRuntime?.sessions.find(
      (session) =>
        session.id === ticket?.executionSessionId && session.activeTicketId === ticket?.id,
    );
    setTicketView(execution?.flow?.status === 'waiting_gate' ? 'execution' : 'details');
    setTicketMenuOpen(false);
  }, [selected]);
  useEffect(() => {
    if (toast && !pendingPlacement) {
      const t = setTimeout(() => setToast(''), 3500);
      return () => clearTimeout(t);
    }
  }, [toast, pendingPlacement]);

  useEffect(() => {
    if (!pendingPlacement) return;
    const ticket = liveRuntime?.tickets.find((value) => value.id === pendingPlacement.ticketId);
    if (ticket && ticket.revision !== pendingPlacement.revision)
      setPendingPlacement((p) => (p ? { ...p, revision: ticket.revision } : p));
  }, [liveRuntime, pendingPlacement]);
  useEffect(() => {
    if (newTask === null) {
      setNewTaskPlacement(null);
      setNewTaskDestination('');
    }
  }, [newTask]);
  useEffect(() => {
    if (selected === null && newTask === null) return;
    const previous = document.activeElement as HTMLElement | null;
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.dialog button, .dialog input, .dialog select, .dialog textarea, .dialog summary',
        ),
      ).filter((n) => !n.hasAttribute('disabled') && n.getClientRects().length > 0);
      const first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', trap);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [selected, newTask]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(null);
        setNewTask(null);
        setMobile(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    const handler = (event: Event) => {
      const id = String((event as CustomEvent).detail ?? '');
      if (!id) return;
      setChatConversationId(id);
      setPage('Chat');
      setMobile(false);
    };
    window.addEventListener('convoy:open-chat', handler);
    return () => window.removeEventListener('convoy:open-chat', handler);
  }, []);
  const current = tasks.find((t) => t.id === selected);
  const currentTicket = liveRuntime?.tickets.find((ticket) => ticket.id === selected);
  const currentExecution = liveRuntime?.sessions.find(
    (session) =>
      session.id === currentTicket?.executionSessionId &&
      session.activeTicketId === currentTicket?.id,
  );
  const currentFlowStatus = currentExecution?.flow?.status;
  const runLabel = !currentExecution
    ? 'Run'
    : currentFlowStatus === 'waiting_gate'
      ? 'Review'
      : currentFlowStatus === 'completed'
        ? 'View result'
        : currentFlowStatus === 'failed' ||
            currentExecution.status === 'failed' ||
            currentExecution.status === 'interrupted'
          ? 'Inspect'
          : currentFlowStatus && currentFlowStatus !== 'cancelled'
            ? 'View run'
            : 'Run again';
  const linkedConversations =
    liveRuntime?.conversations?.filter((conversation) =>
      conversation.linkedTicketIds.includes(current?.id ?? -1),
    ) ?? [];
  async function importDrafts() {
    if (!project) return;
    setSaving(true);
    try {
      const value = await command('importTickets', {
        projectId: project.id,
        tickets: browserDrafts,
      });
      setToast(
        `Imported ${value.result.imported}; ${value.result.conflicts.length} existing IDs preserved. Browser originals are unchanged.`,
      );
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  function navigate(next: string) {
    setPage(next);
    setSelected(null);
    setMobile(false);
  }
  async function openChat(id: number) {
    try {
      const value = await command('openTicketConversation', { ticketId: id, requestId: newId() });
      setChatConversationId(value.result.id);
      navigate('Chat');
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  function newChat() {
    setNewChatOpen(true);
  }
  function inspectConversation(id: string) {
    setChatConversationId(id);
    navigate('Chat');
  }

  async function copyCommand() {
    try {
      await copyText(`npm run attach -- CVY-${selected} --read-only`);
      setToast('Native attach command copied · run from the Convoy directory');
    } catch {
      setToast('Clipboard unavailable.');
    }
  }
  const pageTitle =
    (
      {
        'Project board': 'Board',
        Sessions: 'Live',
        'Project settings': 'Projects',
        'Skills & instructions': 'Library',
        Runners: 'Environments',
      } as Record<string, string>
    )[page] ?? page;
  const placementBoard = newTaskPlacement
    ? liveRuntime?.boards.find((board) => board.id === newTaskPlacement.boardId)
    : undefined;
  const boardDefaultConnection = placementBoard?.creationPolicy?.mode === 'connection'
    ? liveRuntime?.ticketConnections?.find((connection) => connection.id === placementBoard.creationPolicy?.connectionId && connection.enabled)
    : undefined;
  const selectedDestination = newTaskDestination || boardDefaultConnection?.id || 'convoy';
  return (
    <div className={`app ${collapsed ? 'nav-collapsed' : ''}`}>
      {mobile && <div className="scrim" onClick={() => setMobile(false)} />}
      <Sidebar
        page={page}
        navigate={navigate}
        open={mobile}
        close={() => setMobile(false)}
        collapsed={collapsed}
        toggle={() =>
          setCollapsed((v) => {
            try {
              localStorage.setItem('convoy.sidebar.collapsed', JSON.stringify(!v));
            } catch {}
            return !v;
          })
        }
        pins={pins.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t)}
        inspect={(id) => {
          setMobile(false);
          setSelected(id);
        }}
        unpin={togglePin}
        attentionCount={liveRuntime ? liveModel(liveRuntime).attentionCount : 0}
      />
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobile}
              aria-controls="main-sidebar"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            {page === 'Project board' && liveRuntime && project ? (
              <>
                <ProjectSwitcher
                  state={liveRuntime}
                  projectId={project.id}
                  selectContext={(context) => void selectContext(context)}
                  createProject={() => {
                    navigate('Project settings');
                    requestAnimationFrame(() =>
                      document.querySelector<HTMLInputElement>('#new-project-name')?.focus(),
                    );
                  }}
                  manageProject={() => navigate('Project settings')}
                />
                <span className="board-context-divider" aria-hidden="true">
                  /
                </span>
                <span id="board-context-slot" />
              </>
            ) : (
              <strong>{pageTitle}</strong>
            )}
            {liveRuntime && page !== 'Project board' && page !== 'Sessions' && (
              <ActiveContext
                state={liveRuntime}
                projectId={project?.id}
                selectContext={(context) => void selectContext(context)}
                acceptInvitation={async (token) => {
                  await command('acceptInvitation', { token });
                }}
                createInvitation={async (input) => {
                  const result = await command('createInvitation', input);
                  return result.result;
                }}
                createTeam={async (input) => {
                  const result = await command('createTeam', input);
                  return result.result;
                }}
              />
            )}
          </div>
          <div className="top-actions">
            {page === 'Chat' ? (
              <button className="primary" disabled={saving} onClick={() => void newChat()}>
                <Plus size={15} />
                New chat
              </button>
            ) : page === 'Project board' ? (
              <button
                className="primary"
                disabled={!project}
                onClick={() => {
                  createRequest.current = newId();
                  setNewTask('Backlog');
                }}
              >
                <Plus size={15} />
                New ticket
              </button>
            ) : null}
          </div>
        </header>
        {runtimeError && (
          <p role="alert" className="chat-error">
            {runtimeError} Shared ticket edits are unavailable until reconnection.
          </p>
        )}

        {['Project settings', 'Skills & instructions'].includes(page) && (
          <label className="page-project-scope">
            Project
            <Select
              aria-label="Settings project"
              value={project?.id ?? ''}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {liveRuntime?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {page === 'Project settings' && project && liveRuntime && (
          <section className="runtime-page">
            <ProjectSettings key={project.id} project={project} state={liveRuntime} />
            <div>
              <h2>Create another project</h2>
              <form
                className="runtime-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  try {
                    const value = await command('saveProject', {
                      name: String(f.get('name') ?? ''),
                      description: '',
                    });
                    await selectContext({
                      organizationId: value.result.organizationId,
                      projectId: value.result.id,
                    });
                    setToast('Project created.');
                  } catch (e) {
                    setToast((e as Error).message);
                  }
                }}
              >
                <label>
                  Project name
                  <input id="new-project-name" name="name" required />
                </label>
                <button className="primary">Create project</button>
              </form>
              {browserDrafts.length > 0 && (
                <>
                  <h2>Import previous browser board</h2>
                  <p>
                    {browserDrafts.length} browser-local tickets remain preserved. Existing shared
                    IDs will not be overwritten unless they are matching legacy session
                    placeholders.
                  </p>
                  <button className="secondary" disabled={saving} onClick={importDrafts}>
                    Import browser tickets
                  </button>
                </>
              )}
            </div>
          </section>
        )}

        {page === 'Project board' && liveRuntime && project && (
          <BoardStudio
            key={project.id}
            state={liveRuntime}
            projectId={project.id}
            tickets={tasks as never}
            projectName={projectName}
            onSelectTicket={setSelected}
            onNewTicket={(boardId, columnId) => {
              createRequest.current = newId();
              setNewTaskPlacement({ boardId, columnId });
              setNewTask('Backlog');
            }}
            onManageIntegrations={() => navigate('Integrations')}
          />
        )}
        {page === 'Sessions' && (
          <RuntimeSessions
            openChat={inspectConversation}
            openTicket={setSelected}
            openWorkflows={() => navigate('Workflows')}
          />
        )}
        {page === 'Chat' && liveRuntime && (
          <ChatWorkspace
            state={liveRuntime}
            selectedId={chatConversationId}
            select={setChatConversationId}
            create={() => void newChat()}
            openTicket={setSelected}
          />
        )}
        {page === 'Workflows' && <SettingsPage key="workflow-settings" view="Workflows" />}
        {page === 'Runners' && <SettingsPage key="runner-settings" view="Runners" />}
        {page === 'Providers' && <SettingsPage key="provider-settings" view="Providers" />}
        {page === 'Integrations' && <SettingsPage key="integration-settings" view="Integrations" />}
        {page === 'Skills & instructions' && (
          <SettingsPage
            key={project?.id ?? 'instruction-settings'}
            view="Skills & instructions"
            projectId={project?.id}
          />
        )}
      </main>
      {newChatOpen && liveRuntime && (
        <NewChatDialog
          state={liveRuntime}
          close={() => setNewChatOpen(false)}
          created={(id) => {
            setNewChatOpen(false);
            setChatConversationId(id);
            navigate('Chat');
          }}
        />
      )}
      {current && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <section
            className="detail task-detail ticket-detail dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Ticket CVY-${current.id}`}
          >
            <div className="detail-top">
              <span className="task-id">
                CVY-{current.id} · {projectName(current.projectId)}
              </span>
              <span className="ticket-window-controls">
                <button
                  aria-label="Ticket options"
                  aria-expanded={ticketMenuOpen}
                  onClick={() => setTicketMenuOpen((value) => !value)}
                >
                  <MoreHorizontal size={16} />
                </button>
                <button autoFocus aria-label="Close ticket" onClick={() => setSelected(null)}>
                  <X size={16} />
                </button>
              </span>
            </div>
            {ticketMenuOpen && (
              <div className="ticket-options-menu" role="menu" aria-label="Ticket options">
                <button
                  onClick={() => {
                    togglePin(current.id);
                    setTicketMenuOpen(false);
                  }}
                >
                  {pins.includes(current.id) ? 'Unpin' : 'Pin to sidebar'}
                </button>
                {linkedConversations.length === 0 ? (
                  <button onClick={() => openChat(current.id)}>Open chat</button>
                ) : (
                  linkedConversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      onClick={() => inspectConversation(conversation.id)}
                    >
                      {linkedConversations.length === 1 ? 'Open chat' : conversation.title}
                    </button>
                  ))
                )}
                {currentExecution && (
                  <button
                    onClick={() => {
                      setTicketView('terminal');
                      setTicketMenuOpen(false);
                    }}
                  >
                    Terminal
                  </button>
                )}
              </div>
            )}
            <div className="inspector-pane">
              {ticketView === 'details' && liveRuntime && currentTicket && (
                <TicketDetails
                  key={current.id}
                  state={liveRuntime}
                  ticket={currentTicket}
                  runLabel={runLabel}
                  onRun={() => setTicketView('execution')}
                />
              )}
              {ticketView === 'execution' && liveRuntime && currentTicket && (
                <>
                  <button className="ticket-back" onClick={() => setTicketView('details')}>
                    <ArrowLeft size={13} />
                    Ticket
                  </button>
                  <TicketExecution
                    key={current.id}
                    state={liveRuntime}
                    ticket={currentTicket}
                    openChat={inspectConversation}
                  />
                </>
              )}
              {ticketView === 'terminal' && currentExecution && (
                <div className="terminal-preview">
                  <button className="ticket-back" onClick={() => setTicketView('details')}>
                    <ArrowLeft size={13} />
                    Ticket
                  </button>
                  <code>npm run attach -- CVY-{current.id} --read-only</code>
                  <button className="secondary" onClick={copyCommand}>
                    <Copy size={14} />
                    Copy
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
      {newTask && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setNewTask(null);
          }}
        >
          <form
            className="new-task dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Create ticket"
            onSubmit={async (e) => {
              e.preventDefault();
              if (saving || !project) return;
              const data = new FormData(e.currentTarget);
              setSaving(true);
              createRequest.current ||= newId();
              try {
                const createResult = await command('createTicket', {
                  projectId: String(data.get('projectId')),
                  requestId: createRequest.current,
                  title: String(data.get('title')).trim(),
                  boardId: newTaskPlacement?.boardId,
                  destination: String(data.get('destination') ?? 'convoy'),
                  description: String(data.get('description')),
                  status: newTask,
                  label: String(data.get('label')),
                  agent: String(data.get('agent')),
                  priority: 'Medium',
                });
                const createdTicket = createResult.result;
                if (newTaskPlacement) {
                  try {
                    await command('setBoardPlacement', {
                      boardId: newTaskPlacement.boardId,
                      ticketId: createdTicket.id,
                      revision: createdTicket.revision,
                      placement: { columnId: newTaskPlacement.columnId },
                    });
                    setNewTaskPlacement(null);
                  } catch (placementError) {
                    setPendingPlacement({
                      boardId: newTaskPlacement.boardId,
                      columnId: newTaskPlacement.columnId,
                      ticketId: createdTicket.id,
                      revision: createdTicket.revision,
                    });
                    createRequest.current = '';
                    setNewTask(null);
                    setToast(
                      `Ticket CVY-${createdTicket.id} was created, but placement failed: ${(placementError as Error).message}`,
                    );
                    return;
                  }
                }
                createRequest.current = '';
                setNewTask(null);
                setToast(createdTicket.externalPublish
                  ? `Ticket CVY-${createdTicket.id} was saved, but remote creation needs review.`
                  : 'Ticket saved for all clients.');
              } catch (e) {
                setToast((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="section-top">
              <h2>New ticket</h2>
              <button type="button" aria-label="Close new task" onClick={() => setNewTask(null)}>
                <X size={20} />
              </button>
            </div>
            <label>
              Project
              <Select name="projectId" required defaultValue={placementBoard?.projectIds[0] ?? ''}>
                <option value="" disabled>
                  Choose a project
                </option>
                {liveRuntime?.projects
                  .filter(
                    (project) =>
                      !newTaskPlacement || (placementBoard?.projectIds ?? []).includes(project.id),
                  )
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </Select>
            </label>
            <label>
              Title
              <input
                autoFocus
                name="title"
                placeholder="What needs to happen?"
                required
                maxLength={120}
              />
            </label>
            <label>
              Description
              <textarea
                name="description"
                placeholder="Context, expected outcome, and acceptance criteria…"
                rows={4}
              />
            </label>
            <div className="form-row">
              <label>
                Agent
                <Select name="agent">
                  {['Unassigned', 'Claude Code', 'Codex', 'OpenCode', 'Pi'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </label>
              <label>
                Label
                <Select name="label">
                  {['Core', 'Design', 'Workflow', 'Integration', 'Documentation'].map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
              </label>
            </div>
            {placementBoard && (
              <label>
                Create in
                <Select
                  name="destination"
                  required
                  onChange={(event) => setNewTaskDestination(event.target.value)}
                  defaultValue={placementBoard.creationPolicy?.mode === 'connection'
                    ? boardDefaultConnection?.id ?? 'convoy'
                    : placementBoard.creationPolicy?.mode === 'ask' ? '' : 'convoy'}
                >
                  {placementBoard.creationPolicy?.mode === 'ask' && <option value="" disabled>Choose destination</option>}
                  <option value="convoy">Convoy only</option>
                  {(liveRuntime?.ticketConnections ?? [])
                    .filter((connection) => connection.enabled && placementBoard.destinationConnectionIds?.includes(connection.id) && liveRuntime?.projects.some((project) =>
                      placementBoard.projectIds.includes(project.id) && project.organizationId === connection.organizationId))
                    .map((connection) => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
                </Select>
                {placementBoard.creationPolicy?.mode === 'connection' && !boardDefaultConnection &&
                  <small role="alert">The board’s external connection is unavailable. Choose an available destination.</small>}
              </label>
            )}
            <p className="muted">
              Uses project placement by default. Configure an override in ticket details.
            </p>
            <div className="workflow-actions">
              <span className="muted">
                {newTaskPlacement ? 'Adding to selected board column' : 'Create a new ticket'}
              </span>
              <button className="primary" type="submit" disabled={saving}>
                <Plus size={16} />
                {selectedDestination !== 'convoy'
                  ? `Create in ${(liveRuntime?.ticketConnections ?? []).find((value) => value.id === selectedDestination)?.name ?? 'external source'}`
                  : 'Create ticket'}
              </button>
            </div>
          </form>
        </div>
      )}
      {toast && (
        <div role="status" className="toast">
          <Check size={16} />
          {toast}
          {pendingPlacement && (
            <button
              className="secondary"
              onClick={() =>
                void command('setBoardPlacement', {
                  boardId: pendingPlacement.boardId,
                  ticketId: pendingPlacement.ticketId,
                  revision: pendingPlacement.revision,
                  placement: { columnId: pendingPlacement.columnId },
                })
                  .then(() => {
                    setPendingPlacement(null);
                    setToast('Placement saved.');
                  })
                  .catch((error) => setToast(`Placement retry failed: ${(error as Error).message}`))
              }
            >
              Retry placement
            </button>
          )}
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
