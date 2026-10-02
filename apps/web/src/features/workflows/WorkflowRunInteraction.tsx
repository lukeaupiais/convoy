import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Session,
  WorkflowActivityReservation,
  WorkflowSubmission,
  WorkflowSubmissionArtifact,
} from '../../shared/api/runtime';
import { artifactMarkdownBlocks } from './artifact-markdown';
import {
  workflowActivityHistory,
  approvalControlInvalidated,
  workflowDecisionLabel,
  workflowDecisionCapabilities,
  workflowNeedsRecovery,
  workflowRunOutput,
  workflowStatusLabel,
} from './workflow-interaction';
import './workflow-run-interaction.css';

export type WorkflowInteractionActions = {
  approveGate?: (reservation?: WorkflowActivityReservation) => void;
  prepareActivityApproval?: () => Promise<WorkflowActivityReservation>;
  requiresActivityReservation?: boolean;
  canPrepareActivityApproval?: boolean;
  canShowPreparedActivityApproval?: boolean;
  approvalControlKey?: string;
  approvalContextKey?: string;
  requestChanges?: (feedback: string) => void;
  continueRun?: () => void;
  pause?: () => void | Promise<void>;
  cancel?: () => void | Promise<void> | boolean;
  answerQuestion?: (questionId: string, answer: string) => void;
  decideTool?: (approvalId: string, allow: boolean) => void;
  allowAlwaysTool?: (approvalId: string) => void;
  refreshDiff?: () => void;
  startRun?: () => void;
  rework?: () => void;
};

function InlineMarkdown({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`'))
          return <code key={index}>{part.slice(1, -1)}</code>;
        if (part.startsWith('**') && part.endsWith('**'))
          return <strong key={index}>{part.slice(2, -2)}</strong>;
        return part;
      })}
    </>
  );
}

export function WorkflowArtifactContent({ text }: { text: string }) {
  return (
    <article className="workflow-markdown artifact-markdown">
      {artifactMarkdownBlocks(text).map((block, index) => {
        if (block.kind === 'heading') {
          const Heading = block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
          return (
            <Heading key={index}>
              <InlineMarkdown text={block.text} />
            </Heading>
          );
        }
        if (block.kind === 'code')
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index}>
              {block.items.map((item, i) => (
                <li key={i}>
                  <InlineMarkdown text={item} />
                </li>
              ))}
            </List>
          );
        }
        if (block.kind === 'table')
          return (
            <div className="workflow-artifact-table" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((cell, i) => (
                      <th key={i}>
                        <InlineMarkdown text={cell} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>
                          <InlineMarkdown text={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return (
          <p key={index}>
            <InlineMarkdown text={block.text} />
          </p>
        );
      })}
    </article>
  );
}

function submissionIdentity(submission: WorkflowSubmission) {
  return `${submission.nodeId ?? ''}:${submission.instance ?? ''}:${submission.revision ?? ''}`;
}

function ArtifactViewer({
  sessionId,
  submission,
  label,
  primaryArtifactId,
}: {
  sessionId: string;
  submission?: WorkflowSubmission;
  label?: string;
  primaryArtifactId?: string;
}) {
  const [inspectedSubmission, setInspectedSubmission] = useState<WorkflowSubmission>();
  const [inspectedSessionId, setInspectedSessionId] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sourceSessionId = inspectedSessionId || sessionId;
  const sessionIdentity = useRef(sessionId);
  const inspectedArtifacts = useMemo(
    () =>
      inspectedSubmission?.artifacts.filter(
        (item): item is WorkflowSubmissionArtifact => typeof item !== 'string',
      ) ?? [],
    [inspectedSubmission],
  );
  const currentArtifacts = useMemo(
    () =>
      submission?.artifacts.filter(
        (item): item is WorkflowSubmissionArtifact => typeof item !== 'string',
      ) ?? [],
    [submission],
  );
  const inspectedPrimary =
    inspectedArtifacts.find((item) => item.id === primaryArtifactId) ?? inspectedArtifacts[0];
  const currentPrimary =
    currentArtifacts.find((item) => item.id === primaryArtifactId) ?? currentArtifacts[0];
  const rowArtifacts = currentArtifacts.length ? currentArtifacts : inspectedArtifacts;
  const selected = inspectedArtifacts.find((item) => item.id === selectedId) ?? inspectedPrimary;
  const stale =
    !!inspectedSubmission &&
    (!submission || submissionIdentity(inspectedSubmission) !== submissionIdentity(submission));
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const mime = (selected?.mime ?? '').split(';')[0].trim().toLowerCase();
  const markdown =
    mime === 'text/markdown' || (!mime && /\.md(?:own)?$/i.test(selected?.path ?? ''));
  const plain = mime === 'text/plain';
  const json = mime === 'application/json' || mime.endsWith('+json');
  const supportedText = markdown || plain || json;
  async function downloadSelected() {
    if (!selected) return;
    setDownloadError('');
    try {
      const response = await fetch(
        `/api/context/${encodeURIComponent(sourceSessionId)}/${encodeURIComponent(selected.id)}`,
      );
      if (!response.ok) throw new Error('Captured material could not be downloaded.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = selected.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setDownloadError((reason as Error).message);
    }
  }
  useEffect(() => {
    if (sessionIdentity.current === sessionId) return;
    sessionIdentity.current = sessionId;
    dialogRef.current?.close();
    setInspectedSubmission(undefined);
    setInspectedSessionId('');
  }, [sessionId]);
  useEffect(() => {
    if (!inspectedSubmission) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, [inspectedSubmission]);
  useEffect(() => {
    setError('');
    setDownloadError('');
    if (!selected || !supportedText) {
      setContent('');
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setContent('');
    setLoading(true);
    setError('');
    void fetch(
      `/api/context/${encodeURIComponent(sourceSessionId)}/${encodeURIComponent(selected.id)}`,
      {
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Captured material is unavailable.');
        return response.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) setContent(text);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted && reason.name !== 'AbortError') setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    selected?.id,
    sourceSessionId,
    supportedText,
    inspectedSubmission && submissionIdentity(inspectedSubmission),
  ]);
  if (!currentArtifacts.length && !inspectedArtifacts.length) return null;
  let rendered = content;
  if (json && content) {
    try {
      rendered = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      /* Show malformed captured JSON verbatim. */
    }
  }
  return (
    <>
      <div className="workflow-files-row" aria-label="Captured files">
        <span>
          {label ? `${label} · ` : ''}
          {rowArtifacts.length} {rowArtifacts.length === 1 ? 'file' : 'files'}
          {rowArtifacts.length > 0 && ` · ${rowArtifacts.map((item) => item.name).join(', ')}`}
        </span>
      <button
        type="button"
        className="workflow-inspector-open secondary"
        ref={opener}
        aria-label={`Open captured files: ${rowArtifacts.map((item) => item.name).join(', ')}`}
        onClick={() => {
          setSelectedId((inspectedPrimary ?? currentPrimary)?.id ?? '');
          setInspectedSessionId(sessionId);
          setInspectedSubmission(submission);
        }}
      >
        Inspect
      </button>
      </div>
      {inspectedSubmission && (
        <dialog
          ref={dialogRef}
          className="workflow-inspector"
          aria-labelledby="workflow-inspector-title"
          onClose={() => {
            setInspectedSubmission(undefined);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        >
          <header>
            <div>
              <small>Captured output · revision {inspectedSubmission.revision ?? 'unknown'}</small>
              <h2 id="workflow-inspector-title">{label ?? 'Captured materials'}</h2>
            </div>
            <button type="button" className="secondary" onClick={() => dialogRef.current?.close()}>
              Close
            </button>
          </header>
          {stale && (
            <p className="workflow-inspector-stale" role="status">
              This captured revision has been superseded. You are still inspecting the reviewed
              content.
              {currentArtifacts.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(currentPrimary?.id ?? '');
                    setInspectedSessionId(sessionId);
                    if (submission) setInspectedSubmission(submission);
                  }}
                >
                  Open current revision
                </button>
              ) : (
                <span>Current activity has no captured files.</span>
              )}
            </p>
          )}
          <div className="workflow-inspector-content">
            <nav aria-label="Captured files">
              {inspectedArtifacts.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  aria-current={item.id === selected?.id ? 'true' : undefined}
                  onClick={() => setSelectedId(item.id)}
                >
                  {item.name}
                </button>
              ))}
            </nav>
            <section aria-label="Selected captured file">
              {selected && (
                <>
                  <div className="workflow-material-meta">
                    <span>{selected.name}</span>
                    <button type="button" onClick={() => void downloadSelected()}>
                      Download
                    </button>
                  </div>
                  <div className="workflow-material-body" aria-live="polite">
                    {loading ? (
                      <p>Loading captured material…</p>
                    ) : error ? (
                      <div role="status">
                        <p>{error}</p>
                        <button type="button" onClick={() => void downloadSelected()}>
                          Download captured material
                        </button>
                      </div>
                    ) : markdown ? (
                      <WorkflowArtifactContent text={content} />
                    ) : plain || json ? (
                      <pre>{rendered}</pre>
                    ) : (
                      <p>
                        Preview is unavailable for this content type. Download the captured file to
                        inspect it.
                      </p>
                    )}
                  </div>
                  {downloadError && <p role="alert">{downloadError}</p>}
                  <details className="workflow-inspector-metadata">
                    <summary>File details</summary>
                    <dl>
                      <div>
                        <dt>Path</dt>
                        <dd>{selected.path}</dd>
                      </div>
                      <div>
                        <dt>Type</dt>
                        <dd>{selected.mime || 'Unknown'}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd>{selected.size ?? 0} bytes</dd>
                      </div>
                      {selected.hash && (
                        <div>
                          <dt>Hash</dt>
                          <dd>
                            <code>{selected.hash}</code>
                          </dd>
                        </div>
                      )}
                    </dl>
                  </details>
                </>
              )}
            </section>
          </div>
        </dialog>
      )}
    </>
  );
}

export function WorkflowRunInteraction({
  session,
  working = false,
  actions = {},
  activityReservation,
  onRecovery,
}: {
  session: Session;
  working?: boolean;
  actions?: WorkflowInteractionActions;
  activityReservation?: WorkflowActivityReservation;
  onRecovery?: () => void;
}) {
  const flow = session.flow;
  const nodes = session.workflow?.nodes ?? session.workflow?.steps ?? [];
  const node = flow ? nodes.find((item) => item.id === flow.nodeId) : undefined;
  const { submission, sourceNodeId, bindings } = workflowRunOutput(session);
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [preparedReservation, setPreparedReservation] = useState<WorkflowActivityReservation>();
  const [preparedReservationGate, setPreparedReservationGate] = useState('');
  const [preparedReservationContext, setPreparedReservationContext] = useState('');
  const [reservationError, setReservationError] = useState('');
  const reservationRequest = useRef(0);
  const details = submission?.details ?? {};
  const detailBindings = bindings.filter(
    (binding) =>
      binding.source === 'detail' && binding.field && Object.hasOwn(details, binding.field),
  );
  const artifactBinding = bindings.find((binding) => binding.source === 'artifact');
  const outgoingEdges = flow
    ? (session.workflow?.edges ?? []).filter((edge) => edge.from === flow.nodeId)
    : [];
  const replyEdge =
    flow?.status === 'waiting_gate'
      ? (outgoingEdges.find((edge) => edge.outcome === 'approved') ??
        outgoingEdges.find((edge) => edge.outcome === '*') ??
        outgoingEdges.find((edge) => edge.outcome === 'default'))
      : undefined;
  const replyAction = session.workflow?.nodes.find(
    (candidate) => candidate.id === replyEdge?.to && candidate.operation === 'send_external_reply',
  );
  const replyField =
    typeof replyAction?.input?.field === 'string' ? replyAction.input.field : undefined;
  const replyText =
    flow?.status === 'waiting_gate' &&
    replyField &&
    sourceNodeId === replyAction?.input?.sourceNodeId
      ? submission?.details?.[replyField]
      : undefined;
  const visibleDetailBindings = [
    ...detailBindings,
    ...(replyField &&
    typeof details[replyField] === 'string' &&
    details[replyField].trim() &&
    !detailBindings.some((binding) => binding.field === replyField)
      ? [{ source: 'detail' as const, field: replyField }]
      : []),
  ];
  const primaryDetail = visibleDetailBindings.find((binding) => binding.primary);
  const decisions = flow
    ? workflowDecisionCapabilities(flow.nodeId ?? '', session.workflow?.edges ?? [], {
        required: !!flow.decisionSubmissionRef,
        available: !!submission,
      })
    : { approve: false, requestChanges: false };
  const canRevise = decisions.requestChanges;
  const approvalMaterialRequired = !!flow?.decisionSubmissionRef;
  const approvalReady = decisions.approve && (!approvalMaterialRequired || !!submission);
  const otherDetailEntries = Object.entries(details).filter(
    ([key]) => !visibleDetailBindings.some((binding) => binding.field === key),
  );
  const statusText = flow ? workflowStatusLabel(flow.status) : undefined;
  const summaryLabel = bindings.find((binding) => binding.source === 'summary')?.label;
  const summaryIsLong =
    (submission?.summary.length ?? 0) > 420 || (submission?.summary.split('\n').length ?? 0) > 6;
  const deliveryStatus = String(flow?.actionResult?.deliveryStatus ?? '');
  const deliveryNeedsAttention =
    flow?.actionResult?.awaitingDelivery === true ||
    ['pending', 'unknown', 'uncertain'].includes(deliveryStatus);
  const recoveryNeeded = workflowNeedsRecovery(session);
  const hasBlockingState =
    ['failed', 'interrupted', 'awaiting_submission'].includes(flow?.status ?? '') ||
    session.assignment?.state === 'uncertain';
  const failureEvent = session.events
    .filter((event) => /failed|rejected|interrupted/.test(event.type))
    .slice(-1)[0];
  useEffect(() => setSummaryExpanded(false), [submission && submissionIdentity(submission)]);
  const approvalGateKey = `${session.id}:${flow?.id ?? ''}:${flow?.nodeId ?? ''}:${flow?.instance ?? ''}`;
  const canPrepareApproval = Boolean(actions.requiresActivityReservation && actions.prepareActivityApproval && actions.approveGate &&
    (actions.canPrepareActivityApproval ?? true));
  const canShowPreparedApproval = actions.canShowPreparedActivityApproval ?? canPrepareApproval;
  const currentApprovalGate = useRef(approvalGateKey);
  const currentCanPrepareApproval = useRef(canPrepareApproval);
  const currentApprovalContext = useRef(actions.approvalContextKey ?? '');
  const approvalControlState = useRef({
    gateKey: approvalGateKey,
    canPrepare: canPrepareApproval,
    canShow: canShowPreparedApproval,
    controlKey: actions.approvalControlKey,
    contextKey: actions.approvalContextKey,
  });
  const nextApprovalControlState = {
    gateKey: approvalGateKey,
    canPrepare: canPrepareApproval,
    canShow: canShowPreparedApproval,
    controlKey: actions.approvalControlKey,
    contextKey: actions.approvalContextKey,
  };
  const approvalControlWasInvalidated = approvalControlInvalidated(
    approvalControlState.current,
    nextApprovalControlState,
  );
  if (approvalControlWasInvalidated) reservationRequest.current += 1;
  currentApprovalGate.current = approvalGateKey;
  currentCanPrepareApproval.current = canPrepareApproval;
  currentApprovalContext.current = actions.approvalContextKey ?? '';
  useEffect(() => {
    if (approvalControlWasInvalidated) {
      setPreparedReservation(undefined);
      setPreparedReservationGate('');
      setPreparedReservationContext('');
      setReservationError('');
    }
    approvalControlState.current = nextApprovalControlState;
  }, [approvalGateKey, canPrepareApproval, canShowPreparedApproval, actions.approvalControlKey, actions.approvalContextKey]);
  const activeReservation = canShowPreparedApproval && !approvalControlWasInvalidated
    ? (preparedReservationGate === approvalGateKey && preparedReservationContext === (actions.approvalContextKey ?? '') ? preparedReservation : undefined) ??
      (canShowPreparedApproval && activityReservation?.preview ? activityReservation : undefined)
    : undefined;
  async function prepareActivityApproval() {
    if (!actions.prepareActivityApproval) return;
    const request = ++reservationRequest.current;
    const gateKey = approvalGateKey;
    const contextKey = actions.approvalContextKey ?? '';
    setReservationError('');
    try {
      const reservation = await actions.prepareActivityApproval();
      if (request === reservationRequest.current && gateKey === currentApprovalGate.current && contextKey === currentApprovalContext.current && currentCanPrepareApproval.current) {
        setPreparedReservationGate(gateKey);
        setPreparedReservationContext(contextKey);
        setPreparedReservation(reservation);
      }
    } catch (error) {
      if (request === reservationRequest.current && gateKey === currentApprovalGate.current && contextKey === currentApprovalContext.current && currentCanPrepareApproval.current)
        setReservationError((error as Error).message);
    }
  }
  if (!flow)
    return null;
  return (
    <section className="workflow-run-interaction" aria-label="Current activity">
      <header className="workflow-run-heading">
        <h2>Current activity</h2>
        <span role="status">{statusText}</span>
        <strong>{node?.name ?? session.workflow?.name ?? 'Workflow activity'}</strong>
      </header>
      {submission && (
        <div className="workflow-submission" aria-label="Activity output">
          {summaryLabel && summaryLabel !== 'Summary' && (
            <strong className="workflow-output-label">{summaryLabel}</strong>
          )}
          {!(replyText?.trim() && submission.summary === replyText) && (
            <p
              id={`workflow-submission-summary-${session.id}`}
              className={`workflow-submission-summary${summaryIsLong && !summaryExpanded ? ' is-collapsed' : ''}`}
            >
              {submission.summary}
            </p>
          )}
          {summaryIsLong && !(replyText?.trim() && submission.summary === replyText) && (
            <button
              type="button"
              className="workflow-summary-toggle"
              aria-controls={`workflow-submission-summary-${session.id}`}
              aria-expanded={summaryExpanded}
              onClick={() => setSummaryExpanded((value) => !value)}
            >
              {summaryExpanded ? 'Show less' : 'Show more'}
            </button>
          )}
          {primaryDetail && (
            <div className="workflow-primary-detail">
              {primaryDetail.label && <strong>{primaryDetail.label}</strong>}
              <p>{details[primaryDetail.field!]}</p>
            </div>
          )}
          {visibleDetailBindings.filter((binding) => binding !== primaryDetail).length > 0 && (
            <dl>
              {visibleDetailBindings
                .filter((binding) => binding !== primaryDetail)
                .map((binding) => (
                  <div key={binding.field}>
                    {binding.label && <dt>{binding.label}</dt>}
                    <dd>{details[binding.field!]}</dd>
                  </div>
                ))}
            </dl>
          )}
          {otherDetailEntries.length > 0 || submission.references?.length ? (
            <details className="workflow-supporting-output">
              <summary>Supporting output</summary>
              {otherDetailEntries.length > 0 && (
                <dl>
                  {otherDetailEntries.map(([, value], index) => (
                    <div key={index}>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {submission.references?.length ? (
                <ul>
                  {submission.references.map((ref) => (
                    <li key={`${ref.path}:${ref.startLine}:${ref.endLine}`}>
                      <strong>{ref.path}:{ref.startLine}–{ref.endLine}</strong>
                      <pre>{ref.text}</pre>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}
        </div>
      )}
      <ArtifactViewer
        key={session.id}
        sessionId={session.id}
        submission={submission}
        label={artifactBinding?.label}
        primaryArtifactId={submission?.primaryArtifactId}
      />
      {deliveryNeedsAttention && (
        <p role="status" className="workflow-delivery-state">
          {flow.actionResult?.message ?? 'Delivery outcome needs attention.'}
          {onRecovery && recoveryNeeded && !hasBlockingState && (
            <button type="button" className="secondary" onClick={onRecovery}>
              Open recovery
            </button>
          )}
        </p>
      )}
      {(session.pendingQuestion || session.pending) && (
        <section className="workflow-interaction-slot" aria-label="Required interaction">
          {session.pendingQuestion && (
            <section className="workflow-required-interaction">
              <strong>Question</strong>
              <p>{session.pendingQuestion.question}</p>
              <label>
                Answer
                <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} />
              </label>
              <button
                className="primary"
                disabled={working || !answer.trim() || !actions.answerQuestion}
                onClick={() => actions.answerQuestion?.(session.pendingQuestion!.id, answer)}
              >
                Send answer
              </button>
            </section>
          )}
          {session.pending && (
            <section className="workflow-required-interaction">
              <strong>Tool permission · {session.pending.tool}</strong>
              <pre>{JSON.stringify(session.pending.args, null, 2)}</pre>
              <div className="workflow-tool-actions">
                <button
                  className="primary"
                  disabled={working || !actions.decideTool}
                  onClick={() => actions.decideTool?.(session.pending!.id, true)}
                >
                  Allow once
                </button>
                {session.pending.rule && actions.allowAlwaysTool && (
                  <button
                    className="secondary"
                    disabled={working}
                    onClick={() => actions.allowAlwaysTool?.(session.pending!.id)}
                  >
                    Always allow · {session.pending.rule.label}
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={working || !actions.decideTool}
                  onClick={() => actions.decideTool?.(session.pending!.id, false)}
                >
                  Deny
                </button>
              </div>
              {session.pending.rule && (
                <small>
                  {session.pending.rule.label} · {session.pending.rule.scope.kind}
                </small>
              )}
            </section>
          )}
        </section>
      )}
      {hasBlockingState && (
        <section className="workflow-blocking-state" role="alert">
          <p>
            {session.assignment?.state === 'uncertain'
              ? session.assignment.message ?? 'Execution outcome needs reconciliation.'
              : failureEvent?.message ??
                failureEvent?.text ??
                (flow.status === 'awaiting_submission'
                  ? 'Required output is unavailable.'
                  : 'This activity needs recovery.')}
          </p>
          {onRecovery && recoveryNeeded && (
            <button type="button" className="secondary" onClick={onRecovery}>
              Open recovery
            </button>
          )}
        </section>
      )}
      {(flow.status === 'waiting_gate' ||
        (flow.status === 'awaiting_continue' && (actions.continueRun || actions.rework))) && (
        <footer className="workflow-interaction-footer">
          {flow.status === 'waiting_gate' && (
            <>
              {actions.requiresActivityReservation && !activeReservation && canPrepareApproval && (
                <button className="secondary" disabled={working} onClick={() => void prepareActivityApproval()}>
                  Prepare approval
                </button>
              )}
              {activeReservation?.preview && (
                <div className="workflow-approval-preview" aria-label="Prepared activity approval">
                  <strong>{activeReservation.preview.activity}</strong>
                  {activeReservation.preview.action && <small>{activeReservation.preview.action}</small>}
                  {activeReservation.preview.summary && <p>{activeReservation.preview.summary}</p>}
                  {activeReservation.preview.body && <blockquote>{activeReservation.preview.body}</blockquote>}
                  <details>
                    <summary>Prepared values</summary>
                    <pre>{JSON.stringify({ input: activeReservation.preview.input, intent: activeReservation.preview.intent }, null, 2)}</pre>
                  </details>
                </div>
              )}
              {reservationError && <p role="alert">{reservationError}</p>}
              {approvalReady && actions.approveGate && (!actions.requiresActivityReservation || !!activeReservation) ? (
                <button className="primary" disabled={working} onClick={() => actions.approveGate?.(activeReservation)}>
                  {workflowDecisionLabel(node, 'approved')}
                </button>
              ) : actions.requiresActivityReservation && !activeReservation ? (
                null
              ) : approvalMaterialRequired && !submission ? (
                <p role="alert">Reviewed material is unavailable. Refresh before deciding.</p>
              ) : (
                <p role="alert">No supported approval outcome is configured.</p>
              )}
              {canRevise && actions.requestChanges && (
                <button
                  type="button"
                  className="secondary"
                  aria-expanded={showFeedback}
                  onClick={() => setShowFeedback((value) => !value)}
                >
                  {showFeedback ? 'Cancel' : workflowDecisionLabel(node, 'changes_requested')}
                </button>
              )}
            </>
          )}
          {flow.status === 'awaiting_continue' && actions.continueRun && (
            <button className="primary" disabled={working} onClick={actions.continueRun}>
              Continue
            </button>
          )}
          {flow.status === 'awaiting_continue' && actions.rework && (
            <button className="secondary" disabled={working} onClick={actions.rework}>
              Rework this step
            </button>
          )}
        </footer>
      )}
      {showFeedback && flow.status === 'waiting_gate' && canRevise && actions.requestChanges && (
        <label className="workflow-feedback">
          <textarea
            aria-label="Change request"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button
            className="secondary"
            disabled={working || !feedback.trim()}
            onClick={() => actions.requestChanges?.(feedback)}
          >
            Send request
          </button>
        </label>
      )}
    </section>
  );
}

function formatRecordedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WorkflowActivityHistory({ session }: { session: Session }) {
  const history = workflowActivityHistory(session);
  if (history.length === 0) return null;
  return (
    <details className="workflow-activity-history">
      <summary>Activity history</summary>
      <ol>
        {history.map((item, index) => (
          <li key={`${item.nodeName}:${index}`}>
            <span>{item.nodeName}</span>
            <span>{item.outcome}</span>
            {item.at && <time dateTime={item.at}>{formatRecordedAt(item.at)}</time>}
          </li>
        ))}
      </ol>
    </details>
  );
}

export function WorkflowRunDetails({
  session,
  working = false,
  onRefreshDiff,
}: {
  session: Session;
  working?: boolean;
  onRefreshDiff?: () => void;
}) {
  const flow = session.flow;
  const nodes = session.workflow?.nodes ?? session.workflow?.steps ?? [];
  const node = flow ? nodes.find((item) => item.id === flow.nodeId) : undefined;
  const { submission } = workflowRunOutput(session);
  const uncapturedPaths =
    submission?.artifacts.filter((artifact): artifact is string => typeof artifact === 'string') ??
    [];
  if (!flow) return null;
  return (
    <section className="workflow-run-details" aria-label="Execution details">
      {node?.prompt && (
        <section>
          <h3>Activity instructions</h3>
          <p>{node.prompt}</p>
        </section>
      )}
      <p>Session {session.id} · instance {flow.instance}</p>
      {submission?.revision != null && <p>Captured revision {submission.revision}</p>}
      {uncapturedPaths.length > 0 && (
        <section>
          <h3>Uncaptured material paths</h3>
          <p>
            These paths are retained from a legacy submission. Their contents were not captured for
            this run.
          </p>
          <ul>
            {uncapturedPaths.map((path, index) => (
              <li key={`${path}:${index}`}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {session.review && (
        <section className="workflow-live-changes" aria-label="Current working changes">
          <header>
            <strong>Current working changes</strong>
            <span>Mutable workspace · not part of the captured submission</span>
          </header>
          {onRefreshDiff && (
            <button className="secondary" disabled={working} onClick={onRefreshDiff}>
              Refresh changes
            </button>
          )}
          <pre>
            {session.review.status || 'No tracked changes'}
            {'\n'}
            {session.review.diff}
          </pre>
          {session.review.truncated && <p>The current diff is truncated.</p>}
          {session.checks.map((check, index) => (
            <details key={`${check.command}:${index}`}>
              <summary>
                {check.code === 0 ? 'Passed' : 'Failed'} · {check.command}
              </summary>
              <pre>{check.output}</pre>
            </details>
          ))}
        </section>
      )}
      {session.partial && (
        <details className="workflow-partial-output">
          <summary>Current response</summary>
          <pre>{session.partial}</pre>
        </details>
      )}
      {submission?.verification && (
        <section>
          <h3>Verification</h3>
          <p>
            Generation {submission.verification.generation} · source{' '}
            {submission.verification.sourceCommit}
          </p>
          {submission.verification.availability === 'unavailable' && (
            <p>Runtime unavailable. The captured material contains source inspection only.</p>
          )}
          {submission.verification.receipts.map((receipt) => (
            <details key={receipt.commandId}>
              <summary>
                {receipt.command} · exit {receipt.code ?? 'unknown'}
              </summary>
              {receipt.outputTruncated && (
                <p>Output truncated · retained output hash {receipt.outputDigest}</p>
              )}
              <pre>{receipt.output}</pre>
            </details>
          ))}
        </section>
      )}
      {submission?.investigation && (
        <section>
          <h3>Investigation</h3>
          {submission.investigation.questions.map((question, index) => (
            <div key={index}>
              <strong>{question.question}</strong>
              <p>
                {question.status} · {question.material ? 'Material' : 'Nonmaterial'} ·{' '}
                {question.internallyAnswerable ? 'Internally answerable' : 'External input needed'}
              </p>
              <p>{question.resolution || question.nextAction}</p>
              {question.evidence && (
                <>
                  <p>{question.evidence.establishes}</p>
                  <p>Unverified: {question.evidence.unverified}</p>
                </>
              )}
            </div>
          ))}
        </section>
      )}
      <section>
        <h3>Recent execution events</h3>
        {session.events.slice(-20).reverse().map((event) => (
          <div key={event.seq}>
            <small>{event.type.replaceAll('_', ' ')}</small>
            <p>{event.message ?? event.summary ?? event.text}</p>
          </div>
        ))}
      </section>
    </section>
  );
}
