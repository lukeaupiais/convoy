import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Play } from 'lucide-react';
import {
  command,
  owns,
  type RuntimeState,
  type Ticket,
  type Placement,
  type RuntimeAction,
} from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';
import { Select } from '../../shared/ui/Select';
import { SessionControls } from '../sessions';
import './ticket-execution.css';
import { ProfilePicker, profileRef } from '../library';
import { ArtifactReview } from './ArtifactReview';

export function TicketExecution({
  state,
  ticket,
  openChat,
}: {
  state: RuntimeState;
  ticket: Ticket;
  openChat: (id: string) => void;
}) {
  const session = state.sessions.find(
    (s) => s.id === ticket.executionSessionId && s.activeTicketId === ticket.id,
  );
  const project = state.projects.find((value) => value.id === ticket.projectId);
  const versions = [
    ...new Map(
      state.workflows
        .filter(
          (w) =>
            w.organizationId === project?.organizationId &&
            (!w.projectId || w.projectId === ticket.projectId) &&
            (!w.teamId || w.teamId === project?.teamId),
        )
        .map((w) => [w.id, w]),
    ).values(),
  ];
  const defaultWorkflowId =
    state.defaultWorkflowIds?.projects[ticket.projectId] ??
    state.defaultWorkflowIds?.organizations[project?.organizationId ?? ''];
  const initialWorkflow =
    versions.find((w) => w.id === ticket.workflow?.id) ??
    versions.find((w) => w.id === defaultWorkflowId) ??
    versions[0];
  const [workflow, setWorkflow] = useState(
    initialWorkflow ? `${initialWorkflow.id}@${initialWorkflow.version}` : '',
  );
  const [target, setTarget] = useState(session?.id ?? 'new');
  const [environment, setEnvironment] = useState('inherit');
  const [model, setModel] = useState(session?.model ?? state.models[0]?.id ?? '');
  const defaultProfile =
    session?.capabilityProfile ?? state.capabilities?.projectProfiles[ticket.projectId];
  const [profile, setProfile] = useState(
    defaultProfile ? `${defaultProfile.id}@${defaultProfile.version}` : '',
  );
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');
  const request = useRef('');
  const [pendingRequest, setPendingRequest] = useState(false);
  const active = !!session?.flow && !['completed', 'cancelled'].includes(session.flow.status);
  const busy =
    !!session &&
    ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(session.status);
  const selectedSession = state.sessions.find((s) => s.id === target);
  const fixed = !!selectedSession?.workspace;
  const eligible = state.sessions.filter(
    (s) =>
      (!s.projectId || s.projectId === ticket.projectId) &&
      (!s.activeTicketId || s.activeTicketId === ticket.id),
  );
  const flow = session?.flow;
  const nodes = session?.workflow?.nodes ?? session?.workflow?.steps ?? [];
  const node = nodes.find((n) => n.id === flow?.nodeId);
  const visited = new Set(flow?.history?.map((h) => h.nodeId));
  const canRevise = session?.workflow?.edges?.some(
    (e) => e.from === flow?.nodeId && e.outcome === 'changes_requested',
  );
  const capturedSubmission = flow?.lastSubmission?.artifacts?.some(
    (artifact) => typeof artifact !== 'string',
  );
  const focusedArtifactReview = flow?.status === 'waiting_gate' && capturedSubmission;
  const failure = session?.events.filter((e) => /failed|rejected|interrupted/.test(e.type)).at(-1);
  useEffect(() => {
    if (!session || !owns(session)) return;
    const timer = setInterval(
      () => void command('heartbeat', { sessionId: session.id }).catch(() => {}),
      25000,
    );
    return () => clearInterval(timer);
  }, [session?.id, session?.lease?.client]);
  async function act(action: RuntimeAction, input: object = {}) {
    if (!session || working) return;
    setWorking(true);
    setError('');
    try {
      if (!owns(session))
        await command('claim', { sessionId: session.id, label: 'Ticket execution' });
      await command(action, { sessionId: session.id, ...input });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function launch() {
    if (working) return;
    const chosen = versions.find((w) => `${w.id}@${w.version}` === workflow);
    if (!chosen) {
      setError('Choose a published workflow.');
      return;
    }
    const placement: Placement = environment.startsWith('runner:')
      ? { mode: 'pinned', runnerId: environment.slice(7) }
      : environment.startsWith('pool:')
        ? { mode: 'pool', poolId: environment.slice(5) }
        : { mode: environment as 'inherit' | 'none' };
    setWorking(true);
    setError('');
    request.current ||= newId();
    setPendingRequest(true);
    try {
      await command('runTicket', {
        ticketId: ticket.id,
        revision: ticket.revision,
        requestId: request.current,
        profile: profileRef(state, profile),
        mode: target === 'new' ? 'new' : 'continue',
        sessionId: target === 'new' ? undefined : target,
        workflowId: chosen.id,
        workflowVersion: chosen.version ?? 1,
        placement: fixed ? { mode: 'inherit' } : placement,
        model,
      });
      request.current = '';
      setPendingRequest(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="ticket-execution" aria-label="Ticket execution">
      {error && (
        <p role="alert" className="execution-error">
          {error}
        </p>
      )}
      {!active && !busy && (
        <details className="execution-setup" open={!session?.flow}>
          <summary>{session?.flow ? 'Run again' : 'Run this ticket'}</summary>
          <div className="execution-fields">
            <label>
              Profile
              <ProfilePicker
                state={state}
                value={profile}
                onChange={setProfile}
                disabled={working || pendingRequest}
              />
            </label>
            <label>
              Workflow
              <Select
                aria-label="Run workflow"
                value={workflow}
                disabled={working || pendingRequest}
                onChange={(e) => setWorkflow(e.target.value)}
              >
                <option value="" disabled>
                  Choose workflow
                </option>
                {versions.map((w) => (
                  <option key={w.id} value={`${w.id}@${w.version}`}>
                    {w.name} · v{w.version}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Agent session
              <Select
                aria-label="Execution session"
                value={target}
                disabled={working || pendingRequest}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setEnvironment('inherit');
                }}
              >
                <option value="new">New session · fresh context</option>
                {eligible.map((s) => (
                  <option key={s.id} value={s.id}>
                    Continue · {s.title}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Environment
              <Select
                aria-label="Execution environment"
                value={fixed ? 'inherit' : environment}
                disabled={fixed || working || pendingRequest}
                onChange={(e) => setEnvironment(e.target.value)}
              >
                <option value="inherit">
                  {fixed ? 'Keep existing worktree' : 'Ticket / project default'}
                </option>
                <option value="none">Text only · no filesystem</option>
                {state.runnerPools.map((p) => (
                  <option key={p.id} value={`pool:${p.id}`}>
                    Pool · {p.name}
                  </option>
                ))}
                {state.runners
                  .filter((r) => r.enabled && r.projectIds.includes(ticket.projectId))
                  .map((r) => (
                    <option key={r.id} value={`runner:${r.id}`}>
                      {r.name} ·{' '}
                      {state.environments.find((e) => e.id === r.environmentId)?.name ?? r.kind}
                      {!r.online ? ' · offline' : ''}
                    </option>
                  ))}
              </Select>
            </label>
            <label>
              Model
              <Select
                aria-label="Execution model"
                value={model}
                disabled={working || pendingRequest}
                onChange={(e) => setModel(e.target.value)}
              >
                {state.models.map((m) => (
                  <option key={m.id}>{m.id}</option>
                ))}
              </Select>
            </label>
          </div>
          <p className="execution-note">
            {target === 'new'
              ? 'Uses the ticket description as context. Prior conversation history and worktrees are not copied.'
              : 'Keeps this conversation’s context and existing worktree.'}{' '}
            Board columns change only through configured actions.
          </p>
          {!state.auth.connected && (
            <p role="status">Connect your provider account in Chat before starting.</p>
          )}
          {ticket.status === 'Done' && (
            <p role="status">Reopen this ticket before starting another run.</p>
          )}
          <button
            className="primary"
            disabled={working || !workflow || !state.auth.connected || ticket.status === 'Done'}
            onClick={() => void launch()}
          >
            <Play size={14} />
            {working ? 'Starting…' : pendingRequest ? 'Retry same run request' : 'Run ticket'}
          </button>
          {pendingRequest && !working && (
            <button
              className="secondary"
              onClick={() => {
                request.current = '';
                setPendingRequest(false);
              }}
            >
              Change launch settings
            </button>
          )}
        </details>
      )}
      {session && (
        <>
          {!focusedArtifactReview && (
            <header className="execution-heading">
              <div>
                <strong>
                  {session.workflow?.name ?? 'Agent session'}
                  {session.workflow && ` · v${session.workflow.version}`}
                </strong>
                <span>
                  {flow?.status.replaceAll('_', ' ') ?? session.status.replaceAll('_', ' ')}
                </span>
              </div>
              <button
                className="secondary"
                onClick={() => openChat(session.conversationId ?? session.id)}
              >
                Open conversation
                <ArrowUpRight size={14} />
              </button>
            </header>
          )}
          {!focusedArtifactReview && (
            <p className="execution-note">
              {session.workspace
                ? `${state.runners.find((r) => r.id === session.runnerId)?.name ?? 'Runner'} · ${session.workspace.branch}`
                : (session.queueReason ?? 'No worktree provisioned')}
              {session.assignment && ` · ${session.assignment.state}`}
            </p>
          )}
          {!focusedArtifactReview && !!nodes.length && (
            <ol className="execution-steps" aria-label="Workflow progress">
              {nodes.map((n) => (
                <li
                  key={n.id}
                  className={
                    active && n.id === flow?.nodeId
                      ? 'current'
                      : visited.has(n.id ?? '')
                        ? 'visited'
                        : ''
                  }
                >
                  {visited.has(n.id ?? '') ? (
                    <Check size={13} />
                  ) : (
                    <span className="execution-dot" />
                  )}
                  <span>{n.name}</span>
                  {active && n.id === flow?.nodeId && <small>Current</small>}
                </li>
              ))}
            </ol>
          )}
          {!focusedArtifactReview && node && active && (
            <div className="execution-objective">
              <strong>{node.name}</strong>
              <p>{node.prompt}</p>
            </div>
          )}
          {!focusedArtifactReview && session.partial && (
            <p className="execution-output">{session.partial}</p>
          )}
          {failure &&
            ['failed', 'interrupted', 'awaiting_submission'].includes(
              flow?.status ?? session.status,
            ) && (
              <p role="status" className="execution-error">
                {failure.message ?? failure.text ?? failure.type.replaceAll('_', ' ')}
              </p>
            )}
          {session.pending && (
            <div className="execution-decision">
              <strong>Approve operation · {session.pending.tool}</strong>
              <pre>{JSON.stringify(session.pending.args, null, 2)}</pre>
              <div className="execution-actions">
                <button
                  className="primary"
                  disabled={working}
                  onClick={() =>
                    void act('decide', { approvalId: session.pending!.id, allow: true })
                  }
                >
                  Approve once
                </button>
                <button
                  className="secondary"
                  disabled={working}
                  onClick={() =>
                    void act('decide', { approvalId: session.pending!.id, allow: false })
                  }
                >
                  Deny
                </button>
              </div>
            </div>
          )}
          {session.pendingQuestion && (
            <div className="execution-decision">
              <strong>{session.pendingQuestion.question}</strong>
              <textarea
                aria-label="Answer agent"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <button
                className="primary"
                disabled={working || !answer.trim()}
                onClick={() =>
                  void act('answerQuestion', { questionId: session.pendingQuestion!.id, answer })
                }
              >
                Send answer
              </button>
            </div>
          )}
          {flow?.lastSubmission && capturedSubmission && (
            <ArtifactReview
              sessionId={session.id}
              submission={flow.lastSubmission}
              waitingForDecision={flow.status === 'waiting_gate'}
              canRevise={!!canRevise}
              focused={focusedArtifactReview}
              working={working}
              onApprove={() => void act('approveGate', { instance: flow.instance })}
              onRequestChanges={(revisionFeedback) =>
                void act('requestChanges', {
                  instance: flow.instance,
                  feedback: revisionFeedback,
                })
              }
            />
          )}
          {flow?.lastSubmission && !capturedSubmission && (
            <div className="execution-evidence">
              <strong>Latest submission · {flow.lastSubmission.step}</strong>
              <p>{flow.lastSubmission.summary}</p>
              {flow.lastSubmission.artifacts?.map((path) => (
                <code key={String(path)}>{String(path)}</code>
              ))}
            </div>
          )}
          {!focusedArtifactReview && session.workspace && (
            <details className="execution-evidence">
              <summary>Changes & verification</summary>
              <button
                className="secondary"
                disabled={working || busy}
                onClick={() => void act('diff')}
              >
                Refresh changes
              </button>
              {session.review && (
                <pre>
                  {session.review.status || 'No tracked changes'}
                  {'\n'}
                  {session.review.diff}
                </pre>
              )}
              {session.review?.truncated && (
                <p>Diff truncated. Inspect the full worktree before accepting.</p>
              )}
              {session.checks.map((c, i) => (
                <details key={i}>
                  <summary>
                    {c.code === 0 ? 'Passed' : 'Failed'} · {c.command}
                  </summary>
                  <pre>{c.output}</pre>
                </details>
              ))}
            </details>
          )}
          {flow?.status === 'waiting_gate' && !capturedSubmission && (
            <div className="execution-decision">
              <strong>Review required</strong>
              <button
                className="primary"
                disabled={working}
                onClick={() => void act('approveGate', { instance: flow.instance })}
              >
                Approve step
              </button>
              {canRevise ? (
                <>
                  <textarea
                    aria-label="Revision feedback"
                    placeholder="What should change?"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                  />
                  <button
                    className="secondary"
                    disabled={working || !feedback.trim()}
                    onClick={() =>
                      void act('requestChanges', { instance: flow.instance, feedback })
                    }
                  >
                    Request changes
                  </button>
                </>
              ) : (
                <p className="execution-note">This gate has no revision route configured.</p>
              )}
            </div>
          )}
          {!focusedArtifactReview && (
            <div className="execution-actions">
              {active && (
                <>
                  <button
                    className="secondary"
                    disabled={working}
                    onClick={() => void act('pauseWorkflow')}
                  >
                    Pause
                  </button>
                  <button
                    className="secondary"
                    disabled={working}
                    onClick={() => {
                      if (
                        confirm(
                          'Cancel this workflow? Its worktree and conversation will be preserved.',
                        )
                      )
                        void act('cancelWorkflow');
                    }}
                  >
                    Cancel run
                  </button>
                  {[
                    'ready',
                    'paused',
                    'interrupted',
                    'failed',
                    'awaiting_submission',
                    'awaiting_continue',
                  ].includes(flow?.status ?? '') && (
                    <button
                      className="primary"
                      disabled={working || busy}
                      onClick={() => void act('continueWorkflow', { instance: flow!.instance })}
                    >
                      Continue
                    </button>
                  )}
                </>
              )}
              {flow?.status === 'completed' && ticket.status !== 'Done' && (
                <button
                  className="primary"
                  disabled={working}
                  onClick={async () => {
                    setWorking(true);
                    try {
                      await command('updateTicket', {
                        taskId: ticket.id,
                        revision: ticket.revision,
                        patch: { status: 'Done' },
                      });
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setWorking(false);
                    }
                  }}
                >
                  Mark ticket done
                </button>
              )}
            </div>
          )}
          {!focusedArtifactReview && flow?.status === 'completed' && (
            <p className="execution-note">
              Workflow complete. Ticket status and board-local columns remain separate.
            </p>
          )}
          {!focusedArtifactReview && (
            <details className="execution-evidence">
              <summary>Activity</summary>
              {session.events
                .slice(-30)
                .reverse()
                .map((e) => (
                  <div key={e.seq}>
                    <small>
                      {new Date(e.at).toLocaleTimeString()} · {e.type.replaceAll('_', ' ')}
                    </small>
                    <p>{e.message ?? e.summary ?? e.text}</p>
                  </div>
                ))}
            </details>
          )}
          {!focusedArtifactReview && (
            <details className="execution-evidence">
              <summary>Session controls & recovery</summary>
              <SessionControls session={session} state={state} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
