import { Activity, CheckCircle2, FileDiff, GitBranch, Layers3, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RuntimeState, Session } from '../../shared/api/runtime';
import type { ToolActivity } from './activity';

function elapsedLabel(startedAt: string | undefined, now: number) {
  if (!startedAt) return '';
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function changedPaths(tools: ToolActivity[], sinceSeq: number) {
  return new Set(
    tools
      .filter(
        (tool) =>
          tool.seq > sinceSeq &&
          tool.status === 'succeeded' &&
          ['write_file', 'apply_patch'].includes(tool.tool),
      )
      .map((tool) => tool.args.path)
      .filter((path): path is string => typeof path === 'string'),
  ).size;
}

export function AgentRunBar({
  session,
  state,
  tools,
  status,
  running,
  stopping,
  working,
  onStop,
  onReview,
}: {
  session: Session;
  state: RuntimeState;
  tools: ToolActivity[];
  status: string;
  running: boolean;
  stopping: boolean;
  working: boolean;
  onStop: () => void;
  onReview: () => void;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const runner = state.runners.find((value) => value.id === session.runnerId);
  const environment = state.environments.find((value) => value.id === runner?.environmentId);
  const currentAgent = session.agentSessions?.find(
    (agent) => agent.id === session.currentAgentSessionId,
  );
  const startedAt = useMemo(
    () => [...session.events].reverse().find((event) => event.type === 'user')?.at,
    [session.events],
  );
  const startedAtMs = startedAt ? Date.parse(startedAt) : 0;
  const turnStartSeq =
    [...session.events].reverse().find((event) => event.type === 'user')?.seq ?? -1;
  const activeTool = [...tools]
    .reverse()
    .find((tool) => ['queued', 'running', 'approval', 'approved'].includes(tool.status));
  const successfulChecks = session.checks.filter(
    (check) =>
      check.code === 0 &&
      !check.concurrent &&
      (!startedAtMs || Date.parse(check.at) >= startedAtMs),
  ).length;
  const files = changedPaths(tools, turnStartSeq);
  return (
    <section className={`agent-run-bar${running ? ' is-running' : ''}`} aria-label="Agent run">
      <div className="run-primary">
        <span className="run-signal" aria-hidden="true" />
        <div>
          <strong>{status}</strong>
          <small>
            {currentAgent?.name && currentAgent.name !== 'main' ? currentAgent.name : 'Convoy'}
            {running && elapsedLabel(startedAt, clock)
              ? ` · ${elapsedLabel(startedAt, clock)}`
              : ''}
          </small>
        </div>
      </div>
      <div className="run-location" title={session.workspace?.path}>
        <Activity size={14} />
        <span>
          {environment?.name ??
            runner?.name ??
            (session.workspace ? 'Local workspace' : 'Discussion')}
        </span>
        {session.workspace?.branch && (
          <span className="run-branch">
            <GitBranch size={13} /> {session.workspace.branch.replace(/^convoy\//, '')}
          </span>
        )}
      </div>
      <div className="run-facts">
        {activeTool && (
          <span className="run-active-tool">{activeTool.tool.replaceAll('_', ' ')}</span>
        )}
        {files > 0 && (
          <span>
            <Layers3 size={13} /> {files} {files === 1 ? 'file' : 'files'}
          </span>
        )}
        {successfulChecks > 0 && (
          <span>
            <CheckCircle2 size={13} /> {successfulChecks} passed
          </span>
        )}
      </div>
      <div className="run-actions">
        {session.workspace && !running && (
          <button type="button" onClick={onReview} disabled={working}>
            <FileDiff size={13} /> Review
          </button>
        )}
        {running && (
          <button type="button" onClick={onStop} disabled={working || stopping}>
            <Square size={11} /> {stopping ? 'Stopping' : 'Stop'}
          </button>
        )}
      </div>
    </section>
  );
}
