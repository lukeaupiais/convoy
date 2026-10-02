import { useEffect, useMemo, useRef, useState } from 'react';
import { command, type RuntimeState, type WorkflowRun } from '../../shared/api/runtime';
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
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const detailRef = useRef<WorkflowRun | null>(null);
  detailRef.current = detail;

  useEffect(() => {
    setSelectedProjectId(projectId ?? '');
    setSelectedWorkflow('');
    setSelectedRunId('');
    setDetail(null);
    setActionError('');
    setRefreshError('');
  }, [projectId]);

  useEffect(() => {
    if (selectedProjectId && !state.projects.some((value) => value.id === selectedProjectId)) {
      setSelectedProjectId('');
      setSelectedWorkflow('');
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
  const canAct = Boolean(currentDetail && control?.ownsControl && !busy);
  const error = actionError || refreshError;

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
