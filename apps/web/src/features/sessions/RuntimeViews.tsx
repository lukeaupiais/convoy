import { useState } from 'react';
import { command, owns, useRuntime, type RuntimeAction } from '../../shared/api/runtime';
import type { RuntimeState, Session } from '../../shared/api/runtime';
import './runtime.css';
import './session-monitor.css';
import { sessionBucket, sessionReason } from './sessionMonitor';
import { AgentMark } from '../../shared/ui/AgentMark';
import { SessionCapabilities } from '../library';

export function SessionControls({
  session: s,
  state,
  inlineChat = false,
}: {
  session: Session;
  state: RuntimeState;
  inlineChat?: boolean;
}) {
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [runnerId, setRunnerId] = useState(s.runnerId ?? '');
  const [workflow, setWorkflow] = useState(s.workflow?.id ?? '');
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');
  const busy = ['running', 'waiting_approval', 'waiting_question'].includes(s.status);
  const owned = owns(s);
  const activeNodeId = s.flow?.nodeId;
  const activeStep =
    s.workflow?.steps?.find((step) => step.id === activeNodeId) ?? s.workflow?.steps?.[s.step];
  const hasChangesRoute =
    !!activeStep &&
    (
      (s.workflow as Session['workflow'] & { edges?: { from?: string; outcome: string }[] })
        ?.edges ?? []
    ).some((edge) => edge.from === activeStep.id && edge.outcome === 'changes_requested');
  async function act(action: RuntimeAction, extra = {}) {
    setWorking(true);
    setError('');
    try {
      await command(action, { sessionId: s.id, ...extra });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const visitedNodeIds = new Set(s.flow?.history?.map((entry) => entry.nodeId) ?? []);
  const effectKey =
    s.flow?.id && s.flow.instance && s.flow.nodeId
      ? `${s.flow.id}:${s.flow.instance}:${s.flow.nodeId}`
      : '';
  const pendingEffect = state.workflowEffects?.find(
    (effect) => effect.effectKey === effectKey && ['pending', 'uncertain'].includes(effect.status),
  );
  const triggerFailures = [
    ...new Map(
      (state.workflowTriggerFailures ?? [])
        .filter((failure) => String(failure.ticketId) === String(s.activeTicketId ?? s.id))
        .filter((failure) => {
          const current = state.workflowTriggers?.find(
            (trigger) => trigger.triggerKey === failure.triggerKey,
          );
          return !current || current.status === 'failed';
        })
        .map((failure) => [failure.triggerKey, failure]),
    ).values(),
  ];
  const [recoveryTicketId, setRecoveryTicketId] = useState('');
  async function reconcileEffect(resolution: 'applied' | 'not_applied') {
    if (
      !pendingEffect ||
      !s.flow ||
      !owned ||
      !window.confirm(
        resolution === 'applied' && pendingEffect.operation === 'create_ticket'
          ? 'Confirm that the effect was applied and select the existing created ticket.'
          : resolution === 'applied'
            ? 'Confirm that the effect was applied.'
            : 'Confirm that the effect was not applied. The workflow will be ready to continue; it will not retry automatically.',
      )
    )
      return;
    if (
      resolution === 'applied' &&
      pendingEffect.operation === 'create_ticket' &&
      !recoveryTicketId
    ) {
      setError('Select the existing ticket created by this effect.');
      return;
    }
    await act('reconcileWorkflowEffect', {
      instance: s.flow.instance,
      effectKey,
      resolution,
      ...(resolution === 'applied' && pendingEffect.operation === 'create_ticket'
        ? { result: { id: Number(recoveryTicketId) } }
        : {}),
    });
    if (resolution === 'applied') setRecoveryTicketId('');
  }
  return (
    <div className="session-controls">
      <div className="runtime-toolbar">
        <span className={`run-status ${s.status}`}>{s.status.replaceAll('_', ' ')}</span>
        <span className="muted">
          {s.lease && s.lease.expiresAt > Date.now()
            ? `Control: ${s.lease.label}`
            : 'No controller'}
        </span>
        <button
          className="secondary"
          disabled={working}
          onClick={() => act(owned ? 'release' : 'claim', { label: 'Web chat' })}
        >
          {owned ? 'Release control' : 'Claim control'}
        </button>
        {busy && (
          <button className="secondary" disabled={!owned || working} onClick={() => act('stop')}>
            Stop run
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {s.queueReason && <p role="status">Queued: {s.queueReason}</p>}
      {s.assignment && (
        <p className="muted">
          Execution: {state.runners.find((r) => r.id === s.assignment!.runnerId)?.name} ·{' '}
          {state.environments?.find((e) => e.id === s.assignment!.environmentId)?.name} ·{' '}
          {s.assignment.state}
        </p>
      )}
      {s.assignment?.state === 'uncertain' && (
        <details className="approval-card">
          <summary>Remote outcome needs reconciliation</summary>
          <p>{s.assignment.message}</p>
          <p>
            Inspect the original environment and confirm that no previous process is still running
            before clearing this hold. This does not reroute or retry the work.
          </p>
          <button
            className="secondary"
            disabled={!owned || working || busy}
            onClick={() => {
              if (
                window.confirm(
                  'Have you verified on the original environment that the previous work has stopped and inspected its outcome?',
                )
              )
                void act('reconcileAssignment', {
                  token: s.assignment!.token,
                  confirmStopped: true,
                });
            }}
          >
            Confirm previous execution stopped
          </button>
        </details>
      )}
      {(pendingEffect || triggerFailures.length > 0) && (
        <details className="runtime-details workflow-recovery">
          <summary>Workflow recovery required</summary>
          {pendingEffect && (
            <div className="approval-card">
              <strong>Uncertain workflow effect · {pendingEffect.operation}</strong>
              <p>
                {pendingEffect.message ??
                  'The daemon could not confirm whether this effect completed. Choose the observed outcome before continuing.'}
              </p>
              {pendingEffect.operation === 'create_ticket' && (
                <label>
                  Existing created ticket
                  <select
                    aria-label="Existing ticket result"
                    value={recoveryTicketId}
                    onChange={(e) => setRecoveryTicketId(e.target.value)}
                  >
                    <option value="">Select existing ticket…</option>
                    {state.tickets.map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>
                        CVY-{ticket.id} · {ticket.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="runtime-toolbar">
                <button
                  className="primary"
                  disabled={
                    !owned ||
                    working ||
                    (pendingEffect.operation === 'create_ticket' && !recoveryTicketId)
                  }
                  onClick={() => void reconcileEffect('applied')}
                >
                  Confirm applied
                </button>
                <button
                  className="secondary"
                  disabled={!owned || working}
                  onClick={() => void reconcileEffect('not_applied')}
                >
                  Confirm not applied
                </button>
              </div>
            </div>
          )}
          {triggerFailures.map((failure) => (
            <div className="approval-card" key={failure.triggerKey}>
              <strong>Failed workflow trigger · pinned v{failure.workflowVersion}</strong>
              <p>{failure.message ?? 'The configured trigger could not start.'}</p>
              <small>{failure.triggerKey}</small>
              <button
                className="secondary"
                disabled={!owned || working || busy}
                onClick={() => {
                  if (
                    window.confirm('Retry this failed trigger using its pinned workflow version?')
                  )
                    void act('retryWorkflowTrigger', {
                      taskId: failure.ticketId,
                      triggerKey: failure.triggerKey,
                    });
                }}
              >
                Retry pinned trigger
              </button>
            </div>
          ))}
        </details>
      )}{' '}
      {s.flow?.status === 'awaiting_continue' && (
        <button
          className="secondary"
          disabled={!owned || working || busy}
          onClick={() => act('reviseSubmission', { instance: s.flow!.instance })}
        >
          Rework this step / refresh evidence
        </button>
      )}
      {!inlineChat && s.pendingQuestion && (
        <div className="approval-card">
          <strong>Agent question</strong>
          <p>{s.pendingQuestion.question}</p>
          <label>
            Your answer
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!owned || working || !answer.trim()}
            onClick={() => act('answerQuestion', { questionId: s.pendingQuestion!.id, answer })}
          >
            Send answer
          </button>
          <p>Answering does not approve tools or advance a workflow gate.</p>
        </div>
      )}
      {s.workflow && (
        <div className="runtime-details">
          <strong>
            {s.workflow.name} · {s.workflow.steps[s.step]?.name ?? 'Complete'}
          </strong>
          <p>{s.workflow.steps[s.step]?.prompt}</p>
          <div className="runtime-toolbar">
            {(!s.flow || ['completed', 'cancelled'].includes(s.flow.status)) && (
              <button
                className="primary"
                disabled={!owned || working || busy}
                onClick={() => act('startWorkflow')}
              >
                Start workflow
              </button>
            )}
            {s.flow && !['completed', 'cancelled'].includes(s.flow.status) && (
              <>
                <button
                  className="secondary"
                  disabled={!owned || working}
                  onClick={() => act('pauseWorkflow')}
                >
                  Pause workflow
                </button>
                <button
                  className="secondary"
                  disabled={!owned || working}
                  onClick={() => act('cancelWorkflow')}
                >
                  Cancel workflow
                </button>
                {[
                  'ready',
                  'paused',
                  'interrupted',
                  'failed',
                  'awaiting_submission',
                  'awaiting_continue',
                ].includes(s.flow.status) && (
                  <button
                    className="primary"
                    disabled={!owned || working || busy}
                    onClick={() => act('continueWorkflow', { instance: s.flow!.instance })}
                  >
                    Continue workflow
                  </button>
                )}
                {s.flow.status === 'waiting_gate' && (
                  <button
                    className="primary"
                    disabled={!owned || working || busy}
                    onClick={() => act('approveGate', { instance: s.flow!.instance })}
                  >
                    Approve workflow gate
                  </button>
                )}
              </>
            )}
          </div>
          {s.flow?.status === 'waiting_gate' && hasChangesRoute && (
            <label>
              Revision feedback
              <textarea rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
              <button
                className="secondary"
                disabled={!owned || working || !feedback.trim()}
                onClick={() => act('requestChanges', { instance: s.flow!.instance, feedback })}
              >
                Request changes
              </button>
            </label>
          )}
          <small>
            {s.agentSessions
              ?.map(
                (a) =>
                  `${a.id === s.currentAgentSessionId ? '● ' : ''}${a.name} (${a.messageCount} messages)`,
              )
              .join(' · ')}
          </small>
        </div>
      )}
      {!inlineChat && s.pending && (
        <div className="approval-card">
          <strong>Approval required · {s.pending.tool}</strong>
          <pre>{JSON.stringify(s.pending.args, null, 2)}</pre>
          <p>
            Allow once approves only the operation shown. Always allow saves the exact scoped rule
            shown below.
          </p>
          {s.pending.rule && (
            <small>
              {s.pending.rule.label} · {s.pending.rule.scope.kind}
            </small>
          )}
          <div className="runtime-toolbar">
            <button
              className="primary"
              disabled={!owned || working}
              onClick={() => act('decide', { approvalId: s.pending!.id, decision: 'allow_once' })}
            >
              Allow once
            </button>
            {s.pending.rule && (
              <button
                className="secondary"
                disabled={!owned || working}
                onClick={() =>
                  act('decide', { approvalId: s.pending!.id, decision: 'allow_always' })
                }
              >
                Always allow
              </button>
            )}
            <button
              className="secondary"
              disabled={!owned || working}
              onClick={() => act('decide', { approvalId: s.pending!.id, decision: 'deny' })}
            >
              Deny
            </button>
          </div>
        </div>
      )}
      <SessionCapabilities state={state} session={s} />
      <details className="runtime-details">
        <summary>Workspace, workflow & effective instructions</summary>
        <p>
          {s.workspace
            ? `${s.workspace.path} · ${s.workspace.branch}`
            : 'Text-only until you provision a task worktree.'}
        </p>
        <div className="runtime-toolbar">
          <select
            aria-label="Session runner"
            value={runnerId}
            disabled={busy || !!s.workspace}
            onChange={(e) => setRunnerId(e.target.value)}
          >
            <option value="">Use ticket / project placement</option>
            {state.runners.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.kind}
              </option>
            ))}
          </select>
          <select
            aria-label="Session workflow"
            value={workflow}
            onChange={(e) => setWorkflow(e.target.value)}
          >
            <option value="">No workflow</option>
            {[...new Map(state.workflows.map((w) => [w.id, w])).values()].map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} v{w.version}
              </option>
            ))}
          </select>
          <button
            className="secondary"
            disabled={
              !owned ||
              busy ||
              working ||
              (!!s.flow && !['completed', 'cancelled'].includes(s.flow.status))
            }
            onClick={() => act('configure', { runnerId, workflow })}
          >
            Apply configuration
          </button>
        </div>
        <p>
          Publishing instructions does not silently change a run. Apply a fresh snapshot here.
          Layers: organization → user → project → skills → environment → task.
        </p>
        {s.instructions.map((i) => (
          <details key={i.id}>
            <summary>
              {i.scope} · {i.name} v{i.version}
            </summary>
            <pre>{i.content}</pre>
            <small>sha256:{i.hash}</small>
          </details>
        ))}
        {s.provenance && (
          <details>
            <summary>
              Context {s.provenance.contextEpoch?.id ?? 'legacy'} · {s.provenance.hash.slice(0, 12)}
            </summary>
            <p>
              Stable prefix {s.provenance.contextEpoch?.baselineHash.slice(0, 12) ?? 'not recorded'}
              {s.provenance.contextUpdates?.length
                ? ` · updates: ${s.provenance.contextUpdates.map((update) => update.kind).join(', ')}`
                : ''}
            </p>
            <pre>{s.provenance.systemPrompt}</pre>
          </details>
        )}
        <p>
          Native terminal:{' '}
          <code>npm run attach -- {s.id.startsWith('chat-') ? s.id : `CVY-${s.id}`}</code> ·{' '}
          <code>--read-only</code> for observation.
        </p>
      </details>
      {s.workflow && (
        <details className="runtime-details">
          <summary>Workflow steps · pinned v{s.workflow.version}</summary>
          <ol>
            {s.workflow.steps.map((step, index) => (
              <li key={step.id ?? `step-${index}`}>
                {visitedNodeIds.has(step.id ?? '') ? '✓ ' : step.id === activeNodeId ? '→ ' : ''}
                {step.name} · {step.kind}
                {step.artifact && ' · ' + step.artifact.path}
              </li>
            ))}
          </ol>
        </details>
      )}
      {s.workspace && (
        <details className="runtime-details">
          <summary>Review changes & verification evidence</summary>
          <button
            className="secondary"
            disabled={!owned || busy || working}
            onClick={() => act('diff')}
          >
            Refresh diff
          </button>
          {s.review && (
            <>
              <pre>
                {s.review.status || 'No changes'}
                {`\n${s.review.diff}`}
              </pre>
              <p>
                Untracked files appear in status; inspect their content through an approved file
                read. {s.review.truncated && 'Output truncated.'}
              </p>
            </>
          )}
          {s.checks.map((c, i) => (
            <details key={i}>
              <summary>
                {c.code === 0 ? 'Passed' : 'Failed'} · {c.command}
              </summary>
              <pre>{c.output}</pre>
            </details>
          ))}
        </details>
      )}
    </div>
  );
}

export function RuntimeSessions({ openChat }: { openChat: (id: string) => void }) {
  const { state, error } = useRuntime();
  const [view, setView] = useState<'live' | 'attention' | 'history'>('live');
  const [projectFilter, setProjectFilter] = useState('');
  const sessionProjectId = (session: Session) =>
    session.projectId ??
    state?.tickets.find((ticket) => ticket.id === session.activeTicketId)?.projectId;
  const all = (state?.sessions ?? []).filter(
    (session) => !projectFilter || sessionProjectId(session) === projectFilter,
  );
  const attention = all.filter((s) => sessionBucket(s) === 'attention');
  const active = all.filter((s) => sessionBucket(s) === 'active');
  const history = all.filter((s) => sessionBucket(s) === 'history');
  const sessions = (
    view === 'history' ? history : view === 'attention' ? attention : [...attention, ...active]
  )
    .slice()
    .sort((a, b) => {
      if (view === 'live' && sessionBucket(a) !== sessionBucket(b))
        return sessionBucket(a) === 'attention' ? -1 : 1;
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
  return (
    <section className="runtime-page execution-monitor">
      <h1 className="sr-only">Execution monitor</h1>
      <div className="monitor-filters" role="group" aria-label="Session scope">
        <button aria-pressed={view === 'live'} onClick={() => setView('live')}>
          Live <span>{active.length + attention.length}</span>
        </button>
        <button aria-pressed={view === 'attention'} onClick={() => setView('attention')}>
          Needs attention <span>{attention.length}</span>
        </button>
        <button aria-pressed={view === 'history'} onClick={() => setView('history')}>
          History <span>{history.length}</span>
        </button>
        {(state?.projects.length ?? 0) > 1 && (
          <select
            aria-label="Filter sessions by project"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">All projects</option>
            {state?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!state && !error && <p className="muted">Loading execution state…</p>}
      {state && !sessions.length && (
        <div className="monitor-empty">
          <h2>
            {view === 'history'
              ? 'No past activity yet'
              : view === 'attention'
                ? 'Nothing needs your attention'
                : 'No active execution'}
          </h2>
          <p>
            {view === 'history'
              ? 'Finished agent sessions appear here. Empty conversations stay in Chat.'
              : 'Your conversations are still in Chat. This monitor fills when agents run or need a decision.'}
          </p>
        </div>
      )}
      {sessions.map((s) => {
        const ticket = state?.tickets.find((t) => t.id === s.activeTicketId);
        const runner = state?.runners.find((r) => r.id === (s.assignment?.runnerId ?? s.runnerId));
        const environment = state?.environments.find((e) => e.id === runner?.environmentId);
        const label =
          sessionBucket(s) === 'history' && s.status === 'awaiting_review'
            ? 'Completed turn'
            : s.status.replaceAll('_', ' ');
        return (
          <article className="monitor-session" key={s.id}>
            <div className="monitor-session-heading">
              <div>
                <strong className="agent-title">
                  <AgentMark id={s.currentAgentSessionId ?? s.id} active={s.status === 'running'} />
                  {ticket?.title ?? s.title}
                </strong>
                <p>
                  {state?.projects.find((project) => project.id === sessionProjectId(s))?.name ??
                    'Project'}{' '}
                  · {s.activeTicketId ? `CVY-${s.activeTicketId}` : 'Conversation agent'} ·{' '}
                  {s.model}
                  {s.workflow && ` · ${s.workflow.name}`}
                </p>
              </div>
              <span
                className={`run-status ${sessionBucket(s) === 'history' ? 'historical' : s.status}`}
              >
                {label}
              </span>
            </div>
            <p className="monitor-reason">{sessionReason(s)}</p>
            <div className="monitor-location">
              <span>
                {runner
                  ? `${runner.name} · ${environment?.name ?? runner.kind}`
                  : s.status === 'queued'
                    ? 'Environment awaiting placement'
                    : 'Text-only · no workspace'}
              </span>
              <time dateTime={s.updatedAt}>Updated {new Date(s.updatedAt).toLocaleString()}</time>
            </div>
            {s.status === 'running' && Date.now() - Date.parse(s.updatedAt) > 60000 && (
              <p className="chat-error">
                No new output for over a minute. Inspect before restarting.
              </p>
            )}
            <div className="monitor-actions">
              <button className="secondary" onClick={() => openChat(s.conversationId ?? s.id)}>
                Open chat
              </button>
            </div>
            <details className="monitor-inspector">
              <summary>Inspect session</summary>
              <SessionControls session={s} state={state!} />
            </details>
          </article>
        );
      })}
    </section>
  );
}
