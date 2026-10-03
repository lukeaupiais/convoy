import { useEffect, useMemo, useRef, useState } from 'react';
import {
  command,
  type RuntimeState,
  type WorkflowRun,
  type WorkflowHumanReview,
} from '../../shared/api/runtime';
import { WorkflowHumanTaskPanel } from './WorkflowHumanTaskPanel';
import {
  independentWorkflowRuns,
  currentWorkflowRunDetail,
  runAllowsContinue,
  runControlEligibility,
  runIsTerminal,
  workflowForRun,
  workflowRunCommandTarget,
  workflowsForProject,
} from './workflow-runs';
import './workflow-runs.css';

function recordedAt(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WorkflowRuns({ state, projectId }: { state: RuntimeState; projectId?: string }) {
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? '');
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [runInputValues, setRunInputValues] = useState<Record<string, unknown>>({});
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [humanValues, setHumanValues] = useState<Record<string, unknown>>({});
  const [humanResponseId, setHumanResponseId] = useState('');
  const [humanOutcomeId, setHumanOutcomeId] = useState('');
  const [humanReview, setHumanReview] = useState<WorkflowHumanReview | null>(null);
  const detailRef = useRef<WorkflowRun | null>(null);
  detailRef.current = detail;

  useEffect(() => {
    setSelectedProjectId(projectId ?? '');
    setSelectedWorkflow('');
    setRunInputValues({});
    setSelectedRunId('');
    setDetail(null);
    setActionError('');
    setRefreshError('');
    setHumanValues({});
    setHumanResponseId('');
    setHumanOutcomeId('');
    setHumanReview(null);
  }, [projectId]);

  useEffect(() => {
    if (selectedProjectId && !state.projects.some((value) => value.id === selectedProjectId)) {
      setSelectedProjectId('');
      setSelectedWorkflow('');
      setRunInputValues({});
      setSelectedRunId('');
      setDetail(null);
    }
    if (detail && !state.projects.some((value) => value.id === detail.projectId)) {
      setSelectedRunId('');
      setDetail(null);
      setActionError('');
      setRefreshError('');
    }
  }, [detail, selectedProjectId, state.projects]);

  useEffect(
    () => () => {
      const run = detailRef.current;
      if (run?.lease?.ownedByCurrentCaller && run.lease.expiresAt > Date.now()) {
        void command('releaseWorkflowRun', { workflowRunId: run.id }).catch(() => {});
      }
    },
    [],
  );

  const project = state.projects.find((value) => value.id === selectedProjectId);
  const workflows = useMemo(
    () => (project ? workflowsForProject(state, project.id) : []),
    [project, state],
  );
  const availableRuns = useMemo(
    () => independentWorkflowRuns(state, projectId),
    [projectId, state.workflowRuns],
  );
  const selectedDefinition = workflows.find(
    (workflow) => JSON.stringify([workflow.id, workflow.version]) === selectedWorkflow,
  );

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let current = true;
    const refresh = async () => {
      try {
        const response = await command('getWorkflowRun', { workflowRunId: selectedRunId });
        if (current) {
          if (!state.projects.some((project) => project.id === response.result.projectId)) {
            setDetail(null);
            setRefreshError('');
            setSelectedRunId('');
            return;
          }
          setDetail(response.result);
          setRefreshError('');
        }
      } catch (caught) {
        if (current) {
          setDetail(null);
          setRefreshError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [selectedRunId, refreshKey, state.projects]);

  async function startRun(event: React.FormEvent) {
    event.preventDefault();
    if (!project || !selectedDefinition) return;
    setBusy(true);
    setActionError('');
    try {
      const response = await command('startWorkflowRun', {
        projectId: project.id,
        workflowId: selectedDefinition.id,
        workflowVersion: selectedDefinition.version ?? 1,
        runInput: runInputValues,
      });
      await selectRun(response.result.workflowRunId);
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(
    action: 'claimWorkflowRun' | 'releaseWorkflowRun' | 'continueWorkflowRun' | 'cancelWorkflowRun',
  ) {
    const target = workflowRunCommandTarget(
      selectedRunId,
      detailRef.current,
      state.projects.map((value) => value.id),
    );
    if (busy || !target) return;
    setBusy(true);
    setActionError('');
    try {
      if (action === 'continueWorkflowRun') {
        if (!target.instance)
          throw new Error('This workflow run has no current activity instance.');
        await command(action, {
          workflowRunId: target.workflowRunId,
          instance: target.instance,
        });
      } else {
        await command(action, { workflowRunId: target.workflowRunId });
      }
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function selectRun(runId: string) {
    const previous = detailRef.current;
    setActionError('');
    setRefreshError('');
    detailRef.current = null;
    setDetail(null);
    setSelectedRunId(runId);
    setHumanValues({});
    setHumanResponseId('');
    setHumanOutcomeId('');
    setHumanReview(null);
    if (
      previous?.id !== runId &&
      previous?.lease?.ownedByCurrentCaller &&
      previous.lease.expiresAt > Date.now()
    ) {
      try {
        await command('releaseWorkflowRun', { workflowRunId: previous.id });
      } catch (caught) {
        setActionError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  useEffect(() => {
    if (!detail || detail.id !== selectedRunId || !detail.lease?.ownedByCurrentCaller) return;
    const timer = window.setInterval(() => {
      const run = detailRef.current;
      if (
        !run ||
        run.id !== selectedRunId ||
        !run.lease?.ownedByCurrentCaller ||
        run.lease.expiresAt <= Date.now()
      )
        return;
      void command('claimWorkflowRun', { workflowRunId: run.id, label: run.lease.label }).catch(
        (caught) => {
          setActionError(caught instanceof Error ? caught.message : String(caught));
        },
      );
    }, 45000);
    return () => window.clearInterval(timer);
  }, [detail?.id, detail?.lease?.ownedByCurrentCaller, selectedRunId]);

  const currentDetail = currentWorkflowRunDetail(
    selectedRunId,
    detail,
    state.projects.map((value) => value.id),
  );
  const workflow = currentDetail ? workflowForRun(currentDetail, state.workflows) : undefined;
  const currentNode = workflow?.nodes.find((node) => node.id === currentDetail?.nodeId);
  const control = currentDetail ? runControlEligibility(currentDetail) : null;
  const ownsRunControl = Boolean(
    currentDetail && control?.ownsControl && (currentDetail.lease?.expiresAt ?? 0) > Date.now(),
  );
  const canAct = Boolean(
    currentDetail &&
    control?.ownsControl &&
    (currentDetail.lease?.expiresAt ?? 0) > Date.now() &&
    !busy,
  );
  const canReviewTask = Boolean(canAct && currentDetail?.humanTaskReviewerEligible === true);
  const humanContextKey = JSON.stringify([
    selectedRunId,
    currentDetail?.nodeId,
    currentDetail?.instance,
    state.currentUser?.id,
    state.activeContext?.id,
    state.activeContext?.projectId,
    state.activeContext?.principal,
  ]);
  const error = actionError || refreshError;
  const currentResponse = currentDetail?.humanResponses
    ?.slice()
    .reverse()
    .find((response) => response.instance === currentDetail.instance);

  useEffect(() => {
    if (ownsRunControl) return;
    setHumanValues({});
    setHumanResponseId('');
    setHumanOutcomeId('');
    setHumanReview(null);
  }, [humanContextKey, ownsRunControl]);

  async function submitHumanResponse() {
    if (!currentDetail?.instance || !canAct) return;
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    try {
      const result = await command('submitWorkflowHumanResponse', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        values: humanValues,
      });
      setHumanResponseId(result.result.id);
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function captureHumanDocument(file?: File) {
    if (!file || !currentDetail?.instance || !canAct) return;
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Unable to read this document.'));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsDataURL(file);
      });
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await command('captureWorkflowEvidence', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        producer: 'document',
        name: file.name,
        mime:
          file.type ||
          (/\.pdf$/i.test(file.name)
            ? 'application/pdf'
            : /\.json$/i.test(file.name)
              ? 'application/json'
              : /\.md$/i.test(file.name)
                ? 'text/markdown'
                : 'text/plain'),
        data,
      });
      setHumanResponseId('');
      setHumanReview(null);
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function prepareHumanReview(outcomeId: string) {
    if (!currentDetail?.instance || !currentNode || !humanResponseId || !canAct) return;
    const route =
      workflow?.edges.find((edge) => edge.from === currentNode.id && edge.outcome === outcomeId) ??
      workflow?.edges.find(
        (edge) => edge.from === currentNode.id && ['*', 'default'].includes(edge.outcome),
      );
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    try {
      const response = await command('prepareWorkflowHumanReview', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        responseId: humanResponseId,
        outcomeId,
        ...(route ? { targetNodeId: route.to } : {}),
      });
      setHumanOutcomeId(outcomeId);
      setHumanReview(response.result);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function decideHumanOutcome() {
    if (!currentDetail?.instance || !humanReview || !humanOutcomeId || !canAct) return;
    setBusy(true);
    setActionError('');
    try {
      await command('decideWorkflowRun', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        outcomeId: humanOutcomeId,
        responseId: humanReview.response.id,
        reviewedMaterialDigest: humanReview.materialDigest,
        ...(humanReview.reservation
          ? {
              activityReservationId: humanReview.reservation.id,
              activityReservationDigest: humanReview.reservation.digest,
            }
          : {}),
      });
      setHumanReview(null);
      setHumanResponseId('');
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function downloadEvidence(evidenceId: string, name: string) {
    if (!currentDetail) return;
    setBusy(true);
    setActionError('');
    try {
      const response = await command('readWorkflowEvidence', {
        workflowRunId: currentDetail.id,
        evidenceId,
      });
      const raw = atob(response.result.data);
      const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: response.result.evidence.mediaType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="workflow-runs" aria-label="Workflow runs">
      <header className="workflow-runs-header">
        <h2>Runs</h2>
        {state.workflowRunsTruncated && (
          <span role="status">
            Showing {state.workflowRuns?.length ?? 0} of {state.workflowRunsTotal ?? 0} workflow
            runs ({availableRuns.length} independent).
          </span>
        )}
      </header>

      <form className="workflow-run-start" onSubmit={(event) => void startRun(event)}>
        {!projectId && (
          <label>
            Project
            <select
              value={selectedProjectId}
              onChange={(event) => {
                setSelectedProjectId(event.target.value);
                setSelectedWorkflow('');
              }}
            >
              <option value="">Select project</option>
              {state.projects.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Workflow
          <select
            value={selectedWorkflow}
            disabled={!project || workflows.length === 0}
            onChange={(event) => setSelectedWorkflow(event.target.value)}
          >
            <option value="">Select workflow</option>
            {workflows.map((value) => (
              <option
                key={`${value.id}:${value.version}`}
                value={JSON.stringify([value.id, value.version])}
              >
                {value.name} · v{value.version}
              </option>
            ))}
          </select>
        </label>
        {selectedDefinition?.runInputSchema?.type === 'object' &&
          Object.entries(selectedDefinition.runInputSchema.properties ?? {}).map(
            ([field, schema]) => (
              <label key={field}>
                {field}
                {selectedDefinition.runInputSchema?.required?.includes(field) ? ' *' : ''}
                {schema.enum ? (
                  <select
                    value={String(runInputValues[field] ?? '')}
                    onChange={(event) =>
                      setRunInputValues((value) => ({
                        ...value,
                        [field]: schema.enum?.find((item) => String(item) === event.target.value),
                      }))
                    }
                  >
                    <option value="">Select</option>
                    {schema.enum.map((item) => (
                      <option key={JSON.stringify(item)} value={String(item)}>
                        {String(item)}
                      </option>
                    ))}
                  </select>
                ) : schema.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    checked={Boolean(runInputValues[field])}
                    onChange={(event) =>
                      setRunInputValues((value) => ({ ...value, [field]: event.target.checked }))
                    }
                  />
                ) : (
                  <input
                    type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'}
                    required={selectedDefinition.runInputSchema?.required?.includes(field)}
                    value={String(runInputValues[field] ?? '')}
                    onChange={(event) =>
                      setRunInputValues((value) => ({
                        ...value,
                        [field]:
                          event.target.value === ''
                            ? ''
                            : schema.type === 'number' || schema.type === 'integer'
                              ? Number(event.target.value)
                              : event.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ),
          )}
        <button className="primary" disabled={!project || !selectedDefinition || busy}>
          Start run
        </button>
      </form>
      {project && workflows.length === 0 && (
        <p role="status">No published workflows are available for this project.</p>
      )}

      <div className="workflow-runs-layout">
        <nav className="workflow-run-list" aria-label="Independent workflow runs">
          {availableRuns.length === 0 ? (
            <p>No independent runs.</p>
          ) : (
            availableRuns.map((run) => {
              const definition = workflowForRun(run, state.workflows);
              return (
                <button
                  type="button"
                  key={run.id}
                  className={run.id === selectedRunId ? 'is-selected' : ''}
                  aria-pressed={run.id === selectedRunId}
                  onClick={() => void selectRun(run.id)}
                >
                  <strong>
                    {definition?.name ?? run.workflowId} · v{run.workflowVersion}
                  </strong>
                  <span>{run.status.replaceAll('_', ' ')}</span>
                  <small>
                    {state.projects.find((value) => value.id === run.projectId)?.name ??
                      run.projectId}
                  </small>
                </button>
              );
            })
          )}
        </nav>

        {currentDetail && currentDetail.independent === true && (
          <article className="workflow-run-detail" aria-label="Workflow run detail">
            <header>
              <div>
                <h3>
                  {workflow?.name ?? currentDetail.workflowId} · v{currentDetail.workflowVersion}
                </h3>
                <span role="status">{currentDetail.status.replaceAll('_', ' ')}</span>
              </div>
              <div className="workflow-run-controls">
                {control?.ownsControl ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void runCommand('releaseWorkflowRun')}
                  >
                    Release control
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !control?.canClaim}
                    onClick={() => void runCommand('claimWorkflowRun')}
                  >
                    Claim control
                  </button>
                )}
                {runAllowsContinue(currentDetail.status) && currentDetail.instance && (
                  <button
                    type="button"
                    className="primary"
                    disabled={!canAct}
                    onClick={() => void runCommand('continueWorkflowRun')}
                  >
                    Continue
                  </button>
                )}
                {!runIsTerminal(currentDetail) && currentDetail.instance && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!canAct}
                    onClick={() => void runCommand('cancelWorkflowRun')}
                  >
                    Cancel run
                  </button>
                )}
              </div>
            </header>

            {control?.controlledElsewhere && currentDetail.lease && (
              <p role="status">Controlled by {currentDetail.lease.label}</p>
            )}
            <dl className="workflow-run-facts">
              <div>
                <dt>Project</dt>
                <dd>
                  {state.projects.find((value) => value.id === currentDetail.projectId)?.name ??
                    currentDetail.projectId}
                </dd>
              </div>
              <div>
                <dt>Current activity</dt>
                <dd>{currentNode?.name ?? currentDetail.nodeId ?? 'Complete'}</dd>
              </div>
              {currentDetail.attempt && (
                <div>
                  <dt>Attempt</dt>
                  <dd>
                    {currentDetail.attempt.status} · {currentDetail.attempt.instance}
                  </dd>
                </div>
              )}
              <div>
                <dt>Started</dt>
                <dd>{recordedAt(currentDetail.startedAt)}</dd>
              </div>
              {currentDetail.lease && (
                <div>
                  <dt>Control lease</dt>
                  <dd>
                    {currentDetail.lease.label} · expires{' '}
                    {recordedAt(new Date(currentDetail.lease.expiresAt).toISOString())}
                  </dd>
                </div>
              )}
            </dl>
            {currentDetail.status === 'waiting_gate' && currentNode?.kind === 'human' && (
              <section className="workflow-human-task" aria-label="Human task">
                {currentDetail.humanTaskDueAt &&
                  Date.parse(currentDetail.humanTaskDueAt) <= Date.now() && (
                    <span role="status">Overdue · {recordedAt(currentDetail.humanTaskDueAt)}</span>
                  )}
                {!currentNode.legacyHumanTask ? (
                  <WorkflowHumanTaskPanel
                    node={currentNode}
                    values={humanValues}
                    onValuesChange={setHumanValues}
                    response={
                      canReviewTask && currentResponse?.id === humanResponseId
                        ? currentResponse
                        : undefined
                    }
                    evidence={(currentDetail.evidence ?? []).filter(
                      (item) => item.source.attemptInstance === currentDetail.instance,
                    )}
                    review={
                      ownsRunControl && canReviewTask ? (humanReview ?? undefined) : undefined
                    }
                    selectedOutcomeId={humanOutcomeId}
                    disabled={!canReviewTask || busy}
                    onOutcomeChange={(id) => {
                      setHumanOutcomeId(id);
                      setHumanReview(null);
                    }}
                    onSubmit={() => void submitHumanResponse()}
                    onCaptureDocument={(file) => void captureHumanDocument(file)}
                    onReadEvidence={(id, name) => void downloadEvidence(id, name)}
                    onPrepareOutcome={(id) => void prepareHumanReview(id)}
                    onDecide={() => void decideHumanOutcome()}
                  />
                ) : (
                  <div className="workflow-human-outcomes">
                    <button
                      type="button"
                      className="primary"
                      disabled={!canAct || busy}
                      onClick={async () => {
                        if (!currentDetail.instance) return;
                        setBusy(true);
                        setActionError('');
                        try {
                          await command('decideWorkflowRun', {
                            workflowRunId: currentDetail.id,
                            instance: currentDetail.instance,
                            decision: 'approve',
                          });
                          setRefreshKey((value) => value + 1);
                        } catch (caught) {
                          setActionError(caught instanceof Error ? caught.message : String(caught));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {currentNode.humanTask?.outcomes.find((outcome) => outcome.id === 'approved')
                        ?.label ?? 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!canAct || busy}
                      onClick={async () => {
                        if (!currentDetail.instance) return;
                        setBusy(true);
                        setActionError('');
                        try {
                          await command('decideWorkflowRun', {
                            workflowRunId: currentDetail.id,
                            instance: currentDetail.instance,
                            decision: 'requestChanges',
                            feedback: 'Changes requested',
                          });
                          setRefreshKey((value) => value + 1);
                        } catch (caught) {
                          setActionError(caught instanceof Error ? caught.message : String(caught));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {currentNode.humanTask?.outcomes.find(
                        (outcome) => outcome.id === 'changes_requested',
                      )?.label ?? 'Request changes'}
                    </button>
                  </div>
                )}
              </section>
            )}
            <details className="workflow-run-history" open>
              <summary>Activity history</summary>
              <ol>
                {currentDetail.history.map((entry, index) => (
                  <li key={`${entry.instance ?? ''}:${entry.nodeId}:${index}`}>
                    <div>
                      <span>
                        {workflow?.nodes.find((node) => node.id === entry.nodeId)?.name ??
                          entry.nodeId}
                      </span>
                      <span> · {entry.outcome}</span>
                      {entry.summary && <p>{entry.summary}</p>}
                    </div>
                    {entry.at && <time dateTime={entry.at}>{recordedAt(entry.at)}</time>}
                  </li>
                ))}
              </ol>
              {currentDetail.historyTruncated && (
                <p role="status">
                  Showing {currentDetail.history.length} of {currentDetail.historyTotal ?? 0}{' '}
                  activities.
                </p>
              )}
            </details>
            {currentDetail.decisions?.length ? (
              <details className="workflow-run-history">
                <summary>Decision history</summary>
                <ol>
                  {currentDetail.decisions.map((decision, index) => (
                    <li key={`${decision.instance}:${index}`}>
                      <span>{decision.decision}</span>
                      <span>{decision.actor}</span>
                      <time dateTime={decision.at}>{recordedAt(decision.at)}</time>
                    </li>
                  ))}
                </ol>
                {currentDetail.decisionsTruncated && (
                  <p role="status">
                    Showing {currentDetail.decisions?.length ?? 0} of{' '}
                    {currentDetail.decisionsTotal ?? 0} decisions.
                  </p>
                )}
              </details>
            ) : null}
          </article>
        )}
      </div>
      {error && (
        <p className="workflow-run-error" role="alert">
          {error}
        </p>
      )}
      {selectedRunId && !currentDetail && !error && <p role="status">Loading run…</p>}
    </section>
  );
}
