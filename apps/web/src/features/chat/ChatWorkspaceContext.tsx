import { useEffect, useRef, useState } from 'react';
import { Folder, GitBranch, Terminal, X, ChevronDown } from 'lucide-react';
import { Select } from '../../shared/ui/Select';
import { command, type Placement, type RuntimeState, type Session } from '../../shared/api/runtime';
import { copyText, newId } from '../../shared/lib/browser';
import './chat-workspace-context.css';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';

export function NewChatDialog({
  state,
  close,
  created,
}: {
  state: RuntimeState;
  close: () => void;
  created: (id: string) => void;
}) {
  const [projectId, setProjectId] = useState('');
  const [workspace, setWorkspace] = useState('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef({ key: '', id: '' });
  const dialog = useRef<HTMLFormElement>(null);
  const project = state.projects.find((p) => p.id === projectId);
  const repositories = state.runners.filter(
    (r) =>
      r.enabled &&
      r.projectIds.includes(projectId) &&
      state.environments.some((e) => e.id === r.environmentId && e.enabled),
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  async function submit() {
    if (busy) return;
    const placement: Placement =
      workspace === 'none' || workspace === 'inherit'
        ? { mode: workspace }
        : { mode: 'pinned', runnerId: workspace };
    const payload = { projectId: projectId || undefined, placement };
    const key = JSON.stringify(payload);
    if (request.current.key !== key) request.current = { key, id: newId() };
    setBusy(true);
    setError('');
    try {
      const response = await command('createConversation', {
        ...payload,
        requestId: request.current.id,
      });
      created(response.result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (!busy && e.target === e.currentTarget) close();
      }}
    >
      <form
        ref={dialog}
        className="new-chat-dialog dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New chat"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            if (!busy) close();
          }
          if (e.key !== 'Tab') return;
          const nodes = Array.from(
            dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
            ) ?? [],
          ).filter((n) => n.getClientRects().length);
          if (e.shiftKey && document.activeElement === nodes[0]) {
            e.preventDefault();
            nodes.at(-1)?.focus();
          } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
            e.preventDefault();
            nodes[0]?.focus();
          }
        }}
      >
        <header>
          <h2>New chat</h2>
          <button type="button" aria-label="Close new chat" disabled={busy} onClick={close}>
            <X size={18} />
          </button>
        </header>
        <label>
          Project
          <Select
            aria-label="Chat project"
            disabled={busy}
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setWorkspace(e.target.value ? 'inherit' : 'none');
            }}
          >
            <option value="">No project</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        {project && (
          <label>
            Workspace
            <Select
              aria-label="Chat workspace"
              disabled={busy}
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
            >
              <option value="inherit">
                Project default{project.placement.mode === 'none' ? ' · discussion only' : ''}
              </option>
              <option value="none">Discussion only</option>
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {state.environments.find((e) => e.id === r.environmentId)?.name} · {r.name}
                  {!r.online ? ' · offline' : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        <p className="muted">
          {workspace === 'none' || (workspace === 'inherit' && project?.placement.mode === 'none')
            ? 'Just a conversation. No ticket required.'
            : 'An isolated workspace is prepared with your first message.'}
        </p>
        {project && !repositories.length && (
          <p className="muted">
            Add a repository in Environments to give this project a workspace.
          </p>
        )}
        {workspace !== 'none' && workspace !== 'inherit' && (
          <code className="chat-repository-path">
            {repositories.find((r) => r.id === workspace)?.repository}
          </code>
        )}
        {error && (
          <p role="alert" className="chat-error">
            {error}
          </p>
        )}
        <footer>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Start chat'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function ChatWorkspaceContext({
  session,
  state,
}: {
  session: Session;
  state: RuntimeState;
}) {
  const popover = useDetailsPopover();
  const [copied, setCopied] = useState('');
  const [terminalBusy, setTerminalBusy] = useState(false);
  const project = state.projects.find((p) => p.id === session.projectId);
  const policy = session.placement?.mode === 'inherit' ? project?.placement : session.placement;
  const runner = state.runners.find(
    (r) => r.id === (session.runnerId ?? session.assignment?.runnerId ?? policy?.runnerId),
  );
  const environment = state.environments.find((e) => e.id === runner?.environmentId);
  const preparing = session.assignment?.state === 'reserved';
  const uncertain = session.assignment?.state === 'uncertain';
  const status = uncertain
    ? 'Workspace needs inspection'
    : preparing
      ? 'Preparing workspace…'
      : session.status === 'queued'
        ? 'Queued · waiting for capacity'
        : session.workspace
          ? session.workspace.branch
          : session.status === 'failed'
            ? 'Execution failed · inspect details'
            : policy && policy.mode !== 'none'
              ? 'Workspace on first message'
              : 'Discussion only';
  const attach = `npm run attach -- ${session.id}`;
  const terminal = `npm run terminal -- ${session.id}`;
  const liveTerminal = session.terminals?.find((item) => item.state === 'running');
  return (
    <details ref={popover} className="chat-workspace-context">
      <summary>
        <Folder size={13} />
        <span>{project?.name ?? 'No project'}</span>
        {environment && <span>{environment.kind === 'local' ? 'Local' : environment.name}</span>}
        <span className="workspace-status">
          {session.workspace && <GitBranch size={12} />} {status}
        </span>
        <ChevronDown size={12} />
      </summary>
      <div className="workspace-context-body">
        {runner && (
          <p>
            {environment?.name} · {runner.name}
            <code>{runner.repository}</code>
          </p>
        )}
        {policy?.mode === 'pool' && !runner && (
          <p>Pool · {state.runnerPools.find((p) => p.id === policy.poolId)?.name}</p>
        )}
        {session.workspace && <code>{session.workspace.path}</code>}
        {(uncertain || session.status === 'queued') && (
          <p role="status">
            {uncertain ? session.assignment?.message : session.queueReason}{' '}
            {uncertain
              ? 'Inspect the original environment, then reconcile in Session controls.'
              : 'Queued work retries automatically. Check repository health in Environments, or stop the queued message.'}
          </p>
        )}
        {session.status === 'failed' && !session.workspace && !uncertain && (
          <p>
            Workspace or execution failed. Inspect the error below; use Resume after resolving it.
          </p>
        )}
        <div className="workspace-terminal">
          <Terminal size={14} />
          <span>Chat REPL</span>
          <code>{attach}</code>
          <button
            type="button"
            onClick={async () => {
              try {
                await copyText(attach);
                setCopied('Copied');
              } catch {
                setCopied('Select the command to copy');
              }
            }}
          >
            Copy
          </button>
        </div>
        {session.workspace && runner?.capabilities.terminal && (
          <div className="workspace-terminal">
            <Terminal size={14} />
            <span>{liveTerminal ? 'Reconnect terminal' : 'Native terminal'}</span>
            <code>{terminal}</code>
            <button
              type="button"
              onClick={async () => {
                try {
                  await copyText(terminal);
                  setCopied('Copied');
                } catch {
                  setCopied('Select the command to copy');
                }
              }}
            >
              Copy
            </button>
            {liveTerminal && (
              <button
                type="button"
                disabled={terminalBusy}
                onClick={async () => {
                  setTerminalBusy(true);
                  setCopied('');
                  try {
                    await command('claim', { sessionId: session.id, label: 'Web chat' });
                    await command('stopTerminal', {
                      sessionId: session.id,
                      terminalId: liveTerminal.terminalId,
                    });
                  } catch (error) {
                    setCopied(error instanceof Error ? error.message : 'Could not stop terminal.');
                  } finally {
                    setTerminalBusy(false);
                  }
                }}
              >
                {terminalBusy ? 'Stopping…' : 'Stop'}
              </button>
            )}
          </div>
        )}
        {session.workspace && runner && !runner.capabilities.terminal && (
          <small>Native terminal unavailable on this runner.</small>
        )}
        <small>Run from the Convoy directory. Terminal detach leaves the process running.</small>
        <span role="status">{copied}</span>
      </div>
    </details>
  );
}
