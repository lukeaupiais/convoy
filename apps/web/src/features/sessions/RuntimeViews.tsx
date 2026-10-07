import { useState, type ReactNode } from 'react';
import { command, owns, useRuntime, type RuntimeAction } from '../../shared/api/runtime';
import type { RuntimeState, Session } from '../../shared/api/runtime';
import './runtime.css';
import './session-monitor.css';
import { liveModel, sessionProjectId, sessionStatus } from './sessionMonitor';
import { SessionCapabilities } from '../library';
import {
  WorkflowActivityHistory,
  WorkflowRunDetails,
  WorkflowRunInteraction,
  requiredGateActivityTarget,
  workflowHumanTaskActions,
} from '../workflows';

export function SessionControls({
  session: s,
  state,
  inlineChat = false,
  interactionOnly = false,
  settingsOnly = false,
  advancedContent,
  showWorkflowInteraction = true,
  runtimeAvailable = true,
  openRecovery = false,
  onOpenTicketMessages,
  onOpenWorkflowRun,
  onManageAgents,
}: {
  session: Session;
  state: RuntimeState;
  inlineChat?: boolean;
  interactionOnly?: boolean;
  settingsOnly?: boolean;
  advancedContent?: ReactNode;
  showWorkflowInteraction?: boolean;
  runtimeAvailable?: boolean;
  openRecovery?: boolean;
  onOpenTicketMessages?: () => void;
  onOpenWorkflowRun?: (runId: string) => void;
  onManageAgents?: () => void;
}) {
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [runnerId, setRunnerId] = useState(s.runnerId ?? '');
  const [workingDirectory, setWorkingDirectory] = useState(s.workingDirectory ?? '');
  const [workflow, setWorkflow] = useState(s.workflow?.id ?? '');
  const [answer, setAnswer] = useState('');
  const busy = ['running', 'waiting_approval', 'waiting_question'].includes(s.status);
  const owned = owns(s);
  const compact = interactionOnly || settingsOnly;
  const canAct = owned || compact;
  const activeNodeId = s.flow?.nodeId;
  const approvalTargetNodeId = requiredGateActivityTarget(s, state.workflowActivities);
  const preparedActivityReservation =
    s.flow &&
    state.workflowRuns
      ?.find((run) => run.id === s.flow?.id)
      ?.activityReservations?.find(
        (value) =>
          value.gateNodeId === s.flow?.nodeId &&
          value.gateInstance === s.flow?.instance &&
          value.targetNodeId === approvalTargetNodeId &&
          !value.consumedAt,
      );
  async function ensureControl() {
    if (compact && !owned) await command('claim', { sessionId: s.id, label: 'Web chat' });
  }
  async function withControl<T>(action: () => Promise<T>) {
    await ensureControl();
    return action();
  }
  const humanActions = workflowHumanTaskActions(s);
  const controlledHumanActions = {
    ...humanActions,
    submitHumanResponse: humanActions.submitHumanResponse
      ? (values: Record<string, unknown>) =>
          withControl(() => humanActions.submitHumanResponse!(values))
      : undefined,
    captureHumanDocument: humanActions.captureHumanDocument
      ? (file: File) => withControl(() => humanActions.captureHumanDocument!(file))
      : undefined,
    prepareHumanReview: humanActions.prepareHumanReview
      ? (input: Parameters<NonNullable<typeof humanActions.prepareHumanReview>>[0]) =>
          withControl(() => humanActions.prepareHumanReview!(input))
      : undefined,
    decideHumanOutcome: humanActions.decideHumanOutcome
      ? (input: Parameters<NonNullable<typeof humanActions.decideHumanOutcome>>[0]) =>
          withControl(() => humanActions.decideHumanOutcome!(input))
      : undefined,
  };
  async function act(action: RuntimeAction, extra = {}) {
    setWorking(true);
    setError('');
    try {
      await ensureControl();
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
    (effect) =>
      effect.effectKey === effectKey && ['pending', 'uncertain', 'blocked'].includes(effect.status),
  );
  const triggerFailures = (state.automationDecisions ?? []).filter(
    (decision) =>
      String(decision.ticketId) === String(s.activeTicketId ?? s.id) &&
      ['failed', 'blocked_active'].includes(decision.status),
  );
  const [recoveryTicketId, setRecoveryTicketId] = useState('');
  async function reconcileEffect(resolution: 'applied' | 'not_applied') {
    if (
      !pendingEffect ||
      !s.flow ||
      !canAct ||
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
  const configuration = (
    <div className={`session-configuration${settingsOnly ? '' : ' runtime-toolbar'}`}>
      <label>
        Runner
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
      </label>
      <label>
        Workflow
        <select
          aria-label="Session workflow"
          disabled={settingsOnly && !!s.flow && !['completed', 'cancelled'].includes(s.flow.status)}
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
      </label>
      {(runnerId || s.assignment?.runnerId || s.workspace) && (
        <details className="session-working-directory">
          <summary>Working directory</summary>
          <label>
            Directory
            <input
              aria-label="Session working directory"
              placeholder="Repository root"
              value={workingDirectory}
              disabled={
                busy || working || (!!s.flow && !['completed', 'cancelled'].includes(s.flow.status))
              }
              onChange={(event) => setWorkingDirectory(event.target.value)}
            />
          </label>
          <p className="muted">Relative to the workspace. Applies when starting new work.</p>
        </details>
      )}
      <button
        className="secondary"
        disabled={
          !canAct ||
          busy ||
          working ||
          !runtimeAvailable ||
          (!!s.flow && !['completed', 'cancelled'].includes(s.flow.status))
        }
        title={
          settingsOnly && s.flow && !['completed', 'cancelled'].includes(s.flow.status)
            ? 'Configuration is locked while this workflow is active'
            : undefined
        }
        onClick={() => act('configure', { runnerId, workflow, workingDirectory })}
      >
        {settingsOnly ? 'Apply' : 'Apply configuration'}
      </button>
    </div>
  );
  const inspection = (
    <>
      <SessionCapabilities
        state={state}
        session={s}
        acquireControl={compact ? ensureControl : undefined}
        onManageAgents={onManageAgents}
      />
      <details className="runtime-details">
        <summary>
          {settingsOnly ? 'Effective instructions' : 'Workspace, workflow & effective instructions'}
        </summary>
        <p>
          {s.workspace
            ? `${s.workspace.path} · ${s.workspace.branch}`
            : 'Text-only until you provision a task worktree.'}
        </p>
        {!settingsOnly && configuration}
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
      {!s.flow && s.workspace && (
        <details className="runtime-details">
          <summary>Review changes & verification evidence</summary>
          <button
            className="secondary"
            disabled={!canAct || busy || working || !runtimeAvailable}
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
    </>
  );
  return (
    <div className="session-controls">
      {!compact && (
        <div className="runtime-toolbar">
          {!compact && (
            <span className={`run-status ${s.status}`}>{s.status.replaceAll('_', ' ')}</span>
          )}
          {!compact && (
            <span className="muted">
              {s.lease && s.lease.expiresAt > Date.now()
                ? `Control: ${s.lease.label}`
                : 'No controller'}
            </span>
          )}
          <button
            className="secondary"
            disabled={working || !runtimeAvailable}
            onClick={() => act(owned ? 'release' : 'claim', { label: 'Web chat' })}
          >
            {owned ? 'Release control' : 'Claim control'}
          </button>
          {busy && (
            <button
              className="secondary"
              disabled={!canAct || working || !runtimeAvailable}
              onClick={() => act('stop')}
            >
              Stop run
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="chat-error">
          {error}
        </p>
      )}
      {s.queueReason && <p role="status">Queued: {s.queueReason}</p>}
      {!compact && s.assignment && (
        <p className="muted">
          Execution: {state.runners.find((r) => r.id === s.assignment!.runnerId)?.name} ·{' '}
          {state.environments?.find((e) => e.id === s.assignment!.environmentId)?.name} ·{' '}
          {s.assignment.state}
        </p>
      )}
      {s.assignment?.state === 'uncertain' && (
        <details className="approval-card" open={openRecovery}>
          <summary>Remote outcome needs reconciliation</summary>
          <p>{s.assignment.message}</p>
          <p>
            Inspect the original environment and confirm that no previous process is still running
            before clearing this hold. This does not reroute or retry the work.
          </p>
          <button
            className="secondary"
            disabled={!canAct || working || busy || !runtimeAvailable}
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
        <details className="runtime-details workflow-recovery" open={openRecovery}>
          <summary>Workflow recovery required</summary>
          {pendingEffect &&
            (pendingEffect.status === 'blocked' ? (
              <div className="approval-card" role="status">
                <strong>Blocked workflow effect · {pendingEffect.operation}</strong>
                <p>
                  {pendingEffect.message ??
                    'A previous ticket reply must be reconciled before this workflow can continue.'}
                </p>
                {pendingEffect.blockingReplyRequestId && (
                  <p>Blocking reply request · {pendingEffect.blockingReplyRequestId}</p>
                )}
                <p>
                  Reconcile the existing reply in the ticket Messages, then return here and continue
                  the workflow. This reply was not sent by this attempt.
                </p>
                {onOpenTicketMessages && (
                  <button className="secondary" onClick={onOpenTicketMessages}>
                    Open ticket Messages
                  </button>
                )}
              </div>
            ) : (
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
                      !canAct ||
                      working ||
                      !runtimeAvailable ||
                      (pendingEffect.operation === 'create_ticket' && !recoveryTicketId)
                    }
                    onClick={() => void reconcileEffect('applied')}
                  >
                    Confirm applied
                  </button>
                  <button
                    className="secondary"
                    disabled={!canAct || working || !runtimeAvailable}
                    onClick={() => void reconcileEffect('not_applied')}
                  >
                    Confirm not applied
                  </button>
                </div>
              </div>
            ))}
          {triggerFailures.map((failure) => (
            <div className="approval-card" key={failure.triggerKey}>
              <strong>
                {failure.status === 'blocked_active' ? 'Held automation' : 'Failed automation'} · v
                {failure.workflowVersion}
              </strong>
              <p>
                {failure.message ??
                  (failure.status === 'blocked_active'
                    ? 'Another run was active.'
                    : 'Could not start.')}
              </p>
              <small>{failure.triggerKey}</small>
              <button
                className="secondary"
                disabled={!canAct || working || busy || !runtimeAvailable}
                onClick={() => {
                  if (window.confirm('Retry this automation using its pinned workflow version?'))
                    void act('retryAutomationDecision', {
                      taskId: failure.ticketId,
                      triggerKey: failure.triggerKey,
                    });
                }}
              >
                Retry
              </button>
            </div>
          ))}
        </details>
      )}{' '}
      {!inlineChat && !s.flow && s.pendingQuestion && (
        <div className="approval-card">
          <strong>Agent question</strong>
          <p>{s.pendingQuestion.question}</p>
          <label>
            Your answer
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={!canAct || working || !answer.trim()}
            onClick={() => act('answerQuestion', { questionId: s.pendingQuestion!.id, answer })}
          >
            Send answer
          </button>
        </div>
      )}
      {showWorkflowInteraction && s.flow ? (
        <WorkflowRunInteraction
          session={s}
          activityReservation={preparedActivityReservation}
          working={working || !canAct || !runtimeAvailable}
          onOpenWorkflowRun={onOpenWorkflowRun}
          actions={{
            ...controlledHumanActions,
            requiresActivityReservation: !!approvalTargetNodeId,
            canPrepareActivityApproval: canAct && runtimeAvailable,
            canShowPreparedActivityApproval: owned && runtimeAvailable,
            approvalControlKey: owned ? s.lease?.id : undefined,
            approvalContextKey: JSON.stringify([
              state.currentUser?.id,
              state.activeContext?.id,
              state.activeContext?.projectId,
              state.activeContext?.principal,
            ]),
            prepareActivityApproval: approvalTargetNodeId
              ? async () =>
                  withControl(
                    async () =>
                      (
                        await command('prepareWorkflowActivity', {
                          workflowRunId: s.flow!.id,
                          gateInstance: s.flow!.instance,
                          targetNodeId: approvalTargetNodeId,
                        })
                      ).result,
                  )
              : undefined,
            approveGate: (reservation) =>
              void act('approveGate', {
                instance: s.flow!.instance,
                ...(reservation
                  ? {
                      activityReservationId: reservation.id,
                      activityReservationDigest: reservation.digest,
                    }
                  : {}),
              }),
            requestChanges: (revisionFeedback) =>
              void act('requestChanges', {
                instance: s.flow!.instance,
                feedback: revisionFeedback,
              }),
            continueRun: () => void act('continueWorkflow', { instance: s.flow!.instance }),
            pause: () => void act('pauseWorkflow'),
            cancel: () => void act('cancelWorkflow'),
            answerQuestion: (questionId, value) =>
              void act('answerQuestion', { questionId, answer: value }),
            decideTool: (approvalId, allow) =>
              void act('decide', { approvalId, decision: allow ? 'allow_once' : 'deny' }),
            allowAlwaysTool: (approvalId) =>
              void act('decide', { approvalId, decision: 'allow_always' }),
            refreshDiff: () => void act('diff'),
            rework: () => void act('reviseSubmission', { instance: s.flow!.instance }),
            startRun: () => void act('startWorkflow'),
          }}
        />
      ) : showWorkflowInteraction && s.workflow ? (
        <div className="runtime-details">
          <strong>
            {s.workflow.name} · {s.workflow.steps[s.step]?.name ?? 'Ready'}
          </strong>
          <p>{s.workflow.steps[s.step]?.prompt}</p>
          <button
            className="primary"
            disabled={!canAct || working || busy || !runtimeAvailable}
            onClick={() => act('startWorkflow')}
          >
            Start workflow
          </button>
        </div>
      ) : null}
      {!interactionOnly && showWorkflowInteraction && s.flow && (
        <WorkflowActivityHistory session={s} />
      )}
      {!interactionOnly && showWorkflowInteraction && s.flow && (
        <details className="runtime-details" open={openRecovery}>
          <summary>Execution details</summary>
          {s.flow.instance &&
            ['paused', 'interrupted', 'failed', 'awaiting_submission'].includes(s.flow.status) && (
              <button
                className="primary"
                disabled={!canAct || working || !runtimeAvailable}
                onClick={() => void act('continueWorkflow', { instance: s.flow!.instance })}
              >
                Continue workflow
              </button>
            )}
          <WorkflowRunDetails
            session={s}
            working={working || !canAct || !runtimeAvailable}
            onRefreshDiff={() => void act('diff')}
          />
        </details>
      )}
      {!interactionOnly &&
        (settingsOnly ? (
          <>
            {configuration}
            <details className="session-settings-advanced">
              <summary>Advanced</summary>
              {inspection}
              {advancedContent}
            </details>
          </>
        ) : (
          inspection
        ))}
    </div>
  );
}

export function RuntimeSessions({
  openChat,
  openTicket,
  openWorkflows,
}: {
  openChat: (id: string) => void;
  openTicket: (id: number) => void;
  openWorkflows: () => void;
}) {
  const { state, error } = useRuntime();
  const [projectFilter, setProjectFilter] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const model = state ? liveModel(state, projectFilter) : null;
  const projectName = (id?: string) =>
    state?.projects.find((project) => project.id === id)?.name ?? 'Project';
  const sessionRow = (s: Session, historical = false) => {
    const ticket = state?.tickets.find((value) => value.id === s.activeTicketId);
    const label = historical ? 'Completed' : sessionStatus(s, model?.uncertainEffectFor(s));
    return (
      <button
        className="live-row"
        key={s.id}
        onClick={() => openChat(s.conversationId ?? s.id)}
        title={s.title}
      >
        <span className="live-row-main">
          <strong>{ticket?.title ?? s.title}</strong>
          <small>
            {projectName(state ? sessionProjectId(s, state) : undefined)}
            {s.activeTicketId ? ` · CVY-${s.activeTicketId}` : ''}
          </small>
        </span>
        <span className="live-row-state">{label}</span>
        <span className="live-row-arrow" aria-hidden="true">
          →
        </span>
      </button>
    );
  };
  return (
    <section className="runtime-page execution-monitor">
      <h1 className="sr-only">Live execution</h1>
      <div className="live-toolbar">
        {(state?.projects.length ?? 0) > 1 && (
          <select
            aria-label="Filter Live by project"
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
        <button aria-pressed={showHistory} onClick={() => setShowHistory((value) => !value)}>
          {showHistory ? 'Current work' : 'History'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!state && !error && <p className="muted">Loading execution state…</p>}
      {state &&
        model &&
        (showHistory ? (
          <>
            {model.history.length ? (
              model.history.map((s) => sessionRow(s, true))
            ) : (
              <p className="live-empty">No completed work</p>
            )}
          </>
        ) : (
          <>
            {model.attentionCount > 0 && (
              <div className="live-section-label">
                Needs action <span>{model.attentionCount}</span>
              </div>
            )}
            {model.triggerFailures.map((failure) => {
              const ticket = state.tickets.find((value) => value.id === failure.ticketId);
              return (
                <details className="live-alert" key={`trigger:${failure.triggerKey}`}>
                  <summary className="live-row">
                    <span className="live-row-main">
                      <strong>{ticket?.title ?? `CVY-${failure.ticketId}`}</strong>
                      <small>
                        {projectName(ticket?.projectId)} · CVY-{failure.ticketId}
                      </small>
                    </span>
                    <span className="live-row-state">Workflow start failed</span>
                  </summary>
                  <div className="live-alert-details">
                    <p>{failure.message ?? 'The pinned workflow could not start.'}</p>
                    <button onClick={() => openTicket(failure.ticketId)}>Open ticket</button>
                  </div>
                </details>
              );
            })}
            {model.orphanEffects.map((effect) => (
              <details className="live-alert" key={`effect:${effect.effectKey}`}>
                <summary className="live-row">
                  <span className="live-row-main">
                    <strong>Workflow effect</strong>
                    <small>{effect.operation}</small>
                  </span>
                  <span className="live-row-state">Outcome uncertain</span>
                </summary>
                <div className="live-alert-details">
                  <p>{effect.message ?? 'Inspect the effect before attempting recovery.'}</p>
                  <small>{effect.effectKey}</small>
                  <button onClick={openWorkflows}>Open workflows</button>
                </div>
              </details>
            ))}
            {model.attention.map((s) => sessionRow(s))}
            {model.active.length > 0 && (
              <div className="live-section-label">
                In progress <span>{model.active.length}</span>
              </div>
            )}
            {model.active.map((s) => sessionRow(s))}
            {model.paused.length > 0 && (
              <details className="live-paused">
                <summary>
                  Paused <span>{model.paused.length}</span>
                </summary>
                {model.paused.map((s) => sessionRow(s))}
              </details>
            )}
            {!model.attentionCount && !model.active.length && !model.paused.length && (
              <p className="live-empty">No work in progress</p>
            )}
          </>
        ))}
    </section>
  );
}
