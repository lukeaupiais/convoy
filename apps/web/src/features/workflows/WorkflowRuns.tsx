import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import {
  command,
  type RuntimeState,
  type WorkflowRun,
  type WorkflowHumanReview,
} from '../../shared/api/runtime';
import { WorkflowHumanTaskPanel } from './WorkflowHumanTaskPanel';
import { WorkflowRunComposition, WorkflowRunResultPanel } from './WorkflowRunComposition';
import {
  independentWorkflowRuns,
  acquireWorkflowRunControl,
  currentWorkflowRunDetail,
  runAllowsContinue,
  runControlEligibility,
  runIsTerminal,
  workflowForRun,
  workflowRunCommandTarget,
  publishedWorkflowsForProject,
  workflowRunLabel,
} from './workflow-runs';
import './workflow-runs.css';

function recordedAt(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

type LoadedWorkflowResult = {
  contextKey: string;
  result: Record<string, unknown>;
  resultDigest: string;
};

export function WorkflowRuns({
  state,
  projectId,
  initialRunId,
  workflowId,
  onOpenConversation,
  onOpenRun,
  startOpen,
  closeStart,
}: {
  state: RuntimeState;
  projectId?: string;
  initialRunId?: string;
  workflowId?: string;
  onOpenConversation?: (id: string) => void;
  onOpenRun?: (id: string) => void;
  startOpen: boolean;
  closeStart: () => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? '');
  const [selectedWorkflow, setSelectedWorkflow] = useState('');
  const [runInputValues, setRunInputValues] = useState<Record<string, unknown>>({});
  const [selectedRunId, setSelectedRunId] = useState('');
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [compositionOffset, setCompositionOffset] = useState<number>();
  const [humanValues, setHumanValues] = useState<Record<string, unknown>>({});
  const [humanValuesContext, setHumanValuesContext] = useState('');
  const [humanResponseId, setHumanResponseId] = useState('');
  const [humanResponseContext, setHumanResponseContext] = useState('');
  const [humanOutcomeId, setHumanOutcomeId] = useState('');
  const [humanOutcomeContext, setHumanOutcomeContext] = useState('');
  const [humanReview, setHumanReview] = useState<WorkflowHumanReview | null>(null);
  const [humanReviewContext, setHumanReviewContext] = useState('');
  const [terminalResult, setTerminalResult] = useState<LoadedWorkflowResult | null>(null);
  const [terminalResultBusy, setTerminalResultBusy] = useState(false);
  const [terminalResultError, setTerminalResultError] = useState('');
  const detailRef = useRef<WorkflowRun | null>(null);
  const lastHumanTaskIdentity = useRef<
    | {
        runId: string;
        nodeId?: string;
        instance?: string;
      }
    | undefined
  >(undefined);
  const humanMaterialGeneration = useRef(0);
  const terminalResultGeneration = useRef(0);
  const compositionPageGeneration = useRef(0);
  const humanContextRef = useRef('');
  const committedHumanContext = useRef('');
  const canReviewTaskRef = useRef(false);
  detailRef.current = detail;

  useEffect(() => {
    setSelectedProjectId(projectId ?? '');
    setSelectedWorkflow('');
    setRunInputValues({});
    setSelectedRunId('');
    compositionPageGeneration.current += 1;
    setCompositionOffset(undefined);
    setDetail(null);
    setActionError('');
    setRefreshError('');
    setHumanValues({});
    setHumanValuesContext('');
    setHumanResponseId('');
    setHumanResponseContext('');
    setHumanOutcomeId('');
    setHumanOutcomeContext('');
    setHumanReview(null);
    setHumanReviewContext('');
    humanMaterialGeneration.current += 1;
    terminalResultGeneration.current += 1;
    setTerminalResult(null);
    setTerminalResultError('');
  }, [projectId]);

  useEffect(() => {
    if (initialRunId) void selectRun(initialRunId);
  }, [initialRunId]);

  useEffect(() => {
    if (selectedProjectId && !state.projects.some((value) => value.id === selectedProjectId)) {
      setSelectedProjectId('');
      setSelectedWorkflow('');
      setRunInputValues({});
      setSelectedRunId('');
      compositionPageGeneration.current += 1;
      setCompositionOffset(undefined);
      setDetail(null);
      terminalResultGeneration.current += 1;
      setTerminalResult(null);
      setTerminalResultError('');
    }
    if (detail && !state.projects.some((value) => value.id === detail.projectId)) {
      setSelectedRunId('');
      setDetail(null);
      compositionPageGeneration.current += 1;
      setCompositionOffset(undefined);
      setActionError('');
      setRefreshError('');
      terminalResultGeneration.current += 1;
      setTerminalResult(null);
      setTerminalResultError('');
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
    () => (project ? publishedWorkflowsForProject(state, project.id) : []),
    [project, state],
  );
  const availableRuns = useMemo(
    () =>
      (workflowId
        ? (state.workflowRuns ?? []).filter(
            (run) => run.workflowId === workflowId && (!projectId || run.projectId === projectId),
          )
        : independentWorkflowRuns(state, projectId)
      )
        .slice()
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [projectId, workflowId, state.workflowRuns],
  );
  const selectedDefinition = workflows.find((workflow) =>
    workflowId
      ? workflow.id === workflowId
      : JSON.stringify([workflow.id, workflow.version]) === selectedWorkflow,
  );

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }
    let current = true;
    const pageGeneration = compositionPageGeneration.current;
    const refresh = async () => {
      try {
        const response = await command('getWorkflowRun', {
          workflowRunId: selectedRunId,
          ...(compositionOffset !== undefined ? { compositionOffset } : {}),
        });
        if (current && pageGeneration === compositionPageGeneration.current) {
          if (!state.projects.some((project) => project.id === response.result.projectId)) {
            setDetail(null);
            setRefreshError('');
            setSelectedRunId('');
            return;
          }
          setDetail(response.result);
          if (
            Number.isInteger(response.result.compositionAttemptsOffset) &&
            response.result.compositionAttemptsOffset !== compositionOffset
          ) {
            setCompositionOffset(response.result.compositionAttemptsOffset);
          }
          setRefreshError('');
        }
      } catch (caught) {
        if (current && pageGeneration === compositionPageGeneration.current) {
          detailRef.current = null;
          setDetail(null);
          terminalResultGeneration.current += 1;
          setTerminalResult(null);
          setTerminalResultError('');
          setTerminalResultBusy(false);
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
  }, [selectedRunId, refreshKey, state.projects, compositionOffset]);

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
      closeStart();
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand(action: 'continueWorkflowRun' | 'cancelWorkflowRun') {
    const target = workflowRunCommandTarget(
      selectedRunId,
      detailRef.current,
      state.projects.map((value) => value.id),
    );
    if (busy || !target) return;
    terminalResultGeneration.current += 1;
    setTerminalResult(null);
    setTerminalResultError('');
    setBusy(true);
    setActionError('');
    try {
      await ensureControl();
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
    terminalResultGeneration.current += 1;
    setTerminalResult(null);
    setTerminalResultError('');
    compositionPageGeneration.current += 1;
    setCompositionOffset(undefined);
    setHumanValues({});
    setHumanValuesContext('');
    humanMaterialGeneration.current += 1;
    setHumanResponseId('');
    setHumanResponseContext('');
    setHumanOutcomeId('');
    setHumanOutcomeContext('');
    setHumanReview(null);
    setHumanReviewContext('');
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
  if (currentDetail) {
    lastHumanTaskIdentity.current = {
      runId: currentDetail.id,
      nodeId: currentDetail.nodeId ?? undefined,
      instance: currentDetail.instance ?? undefined,
    };
  }
  const humanTaskIdentity =
    currentDetail ??
    (lastHumanTaskIdentity.current?.runId === selectedRunId
      ? lastHumanTaskIdentity.current
      : undefined);
  const workflow = currentDetail ? workflowForRun(currentDetail, state.workflows) : undefined;
  const currentNode = workflow?.nodes.find((node) => node.id === currentDetail?.nodeId);
  const control = currentDetail ? runControlEligibility(currentDetail) : null;
  const ownsRunControl = Boolean(
    currentDetail && control?.ownsControl && (currentDetail.lease?.expiresAt ?? 0) > Date.now(),
  );
  const canAct = Boolean(currentDetail && control?.canClaim && !busy);
  const canReviewTask = Boolean(canAct && currentDetail?.humanTaskReviewerEligible === true);
  const canViewHumanDraft = Boolean(
    control?.canClaim && currentDetail?.humanTaskReviewerEligible === true,
  );
  canReviewTaskRef.current = Boolean(
    currentDetail && control?.canClaim && currentDetail.humanTaskReviewerEligible === true,
  );
  const humanContextKey = JSON.stringify([
    selectedRunId,
    humanTaskIdentity?.nodeId,
    humanTaskIdentity?.instance,
    state.currentUser?.id,
    state.activeContext?.id,
    state.activeContext?.projectId,
    state.activeContext?.principal,
  ]);
  humanContextRef.current = humanContextKey;
  async function ensureControl() {
    if (!currentDetail) throw new Error('Select a workflow run.');
    const contextKey = humanContextKey;
    const fresh = await acquireWorkflowRunControl(
      currentDetail,
      () => (humanContextRef.current === contextKey ? detailRef.current : null),
      (id) => command('claimWorkflowRun', { workflowRunId: id, label: 'Web workflows' }),
      async (id) => (await command('getWorkflowRun', { workflowRunId: id })).result,
    );
    detailRef.current = fresh;
    setDetail(fresh);
    return fresh;
  }
  async function ensureReviewer() {
    const fresh = await ensureControl();
    if (fresh.humanTaskReviewerEligible !== true)
      throw new Error('You are not eligible to review this workflow activity.');
  }
  const error = actionError || refreshError;
  const currentResponse = currentDetail?.humanResponses
    ?.slice()
    .reverse()
    .find((response) => response.instance === currentDetail.instance);

  useEffect(() => {
    if (
      !currentDetail ||
      currentDetail.status !== 'completed' ||
      !currentDetail.resultDigest ||
      !control?.canClaim ||
      currentDetail.workflowRunResultEligible !== true
    ) {
      terminalResultGeneration.current += 1;
      setTerminalResult(null);
      setTerminalResultError('');
      setTerminalResultBusy(false);
      return;
    }
    if (terminalResult && terminalResult.contextKey !== humanContextKey) {
      terminalResultGeneration.current += 1;
      setTerminalResult(null);
    }
  }, [
    currentDetail?.id,
    currentDetail?.status,
    currentDetail?.resultDigest,
    currentDetail?.workflowRunResultEligible,
    control?.canClaim,
    humanContextKey,
    terminalResult?.contextKey,
  ]);

  async function loadTerminalResult() {
    if (
      !currentDetail ||
      currentDetail.status !== 'completed' ||
      !currentDetail.resultDigest ||
      !control?.canClaim ||
      (ownsRunControl && currentDetail.workflowRunResultEligible !== true)
    )
      return;
    const runId = currentDetail.id;
    const digest = currentDetail.resultDigest;
    const contextKey = humanContextKey;
    const generation = ++terminalResultGeneration.current;
    setTerminalResultBusy(true);
    setTerminalResultError('');
    try {
      const fresh = await ensureControl();
      if (fresh.workflowRunResultEligible !== true)
        throw new Error('You cannot view this workflow result.');
      const response = await command('getWorkflowRunResult', { workflowRunId: runId });
      const latest = detailRef.current;
      if (
        generation === terminalResultGeneration.current &&
        humanContextRef.current === contextKey &&
        latest?.id === runId &&
        latest.status === 'completed' &&
        latest.resultDigest === digest &&
        runControlEligibility(latest).ownsControl &&
        (latest.lease?.expiresAt ?? 0) > Date.now() &&
        response.result.resultDigest === digest
      ) {
        setTerminalResult({ contextKey, result: response.result.result, resultDigest: digest });
      }
    } catch (caught) {
      if (
        generation === terminalResultGeneration.current &&
        humanContextRef.current === contextKey &&
        detailRef.current?.id === runId
      ) {
        setTerminalResultError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (generation === terminalResultGeneration.current) setTerminalResultBusy(false);
    }
  }

  useEffect(() => {
    const contextChanged = committedHumanContext.current !== humanContextKey;
    committedHumanContext.current = humanContextKey;
    const reviewerCanOperate = Boolean(
      control?.canClaim && currentDetail?.humanTaskReviewerEligible === true,
    );
    if (!contextChanged && reviewerCanOperate) return;
    humanMaterialGeneration.current += 1;
    if (contextChanged) {
      setHumanValues({});
      setHumanValuesContext(humanContextKey);
    }
    setHumanResponseId('');
    setHumanResponseContext('');
    setHumanOutcomeId('');
    setHumanOutcomeContext('');
    setHumanReview(null);
    setHumanReviewContext('');
  }, [humanContextKey, canViewHumanDraft]);

  function invalidateHumanMaterial() {
    humanMaterialGeneration.current += 1;
    setHumanResponseId('');
    setHumanResponseContext('');
    setHumanOutcomeId('');
    setHumanOutcomeContext('');
    setHumanReview(null);
    setHumanReviewContext('');
  }

  async function submitHumanResponse() {
    if (!currentDetail?.instance || !canAct) return;
    const generation = humanMaterialGeneration.current;
    const contextKey = humanContextKey;
    const instance = currentDetail.instance;
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    setHumanReviewContext('');
    try {
      await ensureReviewer();
      const result = await command('submitWorkflowHumanResponse', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        values: humanValues,
      });
      if (
        generation === humanMaterialGeneration.current &&
        canReviewTaskRef.current &&
        contextKey === humanContextRef.current &&
        instance === detailRef.current?.instance
      ) {
        setHumanResponseId(result.result.id);
        setHumanResponseContext(contextKey);
      }
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function captureHumanDocument(file?: File) {
    if (!file || !currentDetail?.instance || !canAct) return;
    const generation = humanMaterialGeneration.current;
    const contextKey = humanContextKey;
    const instance = currentDetail.instance;
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    setHumanReviewContext('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Unable to read this document.'));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsDataURL(file);
      });
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await ensureReviewer();
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
      if (
        generation === humanMaterialGeneration.current &&
        canReviewTaskRef.current &&
        contextKey === humanContextRef.current &&
        instance === detailRef.current?.instance
      ) {
        setHumanResponseId('');
        setHumanResponseContext('');
        setHumanReview(null);
        setHumanReviewContext('');
      }
      setRefreshKey((value) => value + 1);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function prepareHumanReview(outcomeId: string) {
    if (!currentDetail?.instance || !currentNode || !humanResponseId || !canAct) return;
    const generation = humanMaterialGeneration.current;
    const contextKey = humanContextKey;
    const responseId = humanResponseId;
    const instance = currentDetail.instance;
    const route =
      workflow?.edges.find((edge) => edge.from === currentNode.id && edge.outcome === outcomeId) ??
      workflow?.edges.find(
        (edge) => edge.from === currentNode.id && ['*', 'default'].includes(edge.outcome),
      );
    setBusy(true);
    setActionError('');
    setHumanReview(null);
    try {
      await ensureReviewer();
      const response = await command('prepareWorkflowHumanReview', {
        workflowRunId: currentDetail.id,
        instance: currentDetail.instance,
        responseId,
        outcomeId,
        ...(route ? { targetNodeId: route.to } : {}),
      });
      if (
        generation === humanMaterialGeneration.current &&
        canReviewTaskRef.current &&
        contextKey === humanContextRef.current &&
        instance === detailRef.current?.instance &&
        responseId === humanResponseId &&
        outcomeId === humanOutcomeId &&
        contextKey === humanOutcomeContext
      ) {
        setHumanReview(response.result);
        setHumanReviewContext(contextKey);
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function decideHumanOutcome() {
    if (
      !currentDetail?.instance ||
      !humanReview ||
      humanReviewContext !== humanContextKey ||
      !humanOutcomeId ||
      !canAct
    )
      return;
    setBusy(true);
    setActionError('');
    try {
      await ensureReviewer();
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
      setHumanReviewContext('');
      setHumanResponseId('');
      setHumanResponseContext('');
      setHumanOutcomeId('');
      setHumanOutcomeContext('');
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
      await ensureReviewer();
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
      {state.workflowRunsTruncated && (
        <p className="workflow-run-count">Older runs may be omitted.</p>
      )}
      {startOpen && (
        <form
          id="workflow-run-start"
          className="workflow-run-start"
          onSubmit={(event) => void startRun(event)}
        >
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
          {!workflowId && (
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
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
          )}
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
                      type={
                        schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'
                      }
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
          <button type="button" onClick={closeStart}>
            Cancel
          </button>
        </form>
      )}
      {startOpen && project && workflows.length === 0 && (
        <p role="status">No published workflows are available for this project.</p>
      )}

      <div className={`workflow-runs-layout ${currentDetail ? 'has-detail' : 'is-list'}`}>
        <nav className="workflow-run-list" aria-label="Workflow runs">
          {availableRuns.length === 0 ? (
            <p>No runs yet.</p>
          ) : (
            availableRuns.map((run) => {
              const definition = workflowForRun(run, state.workflows);
              return (
                <button
                  type="button"
                  key={run.id}
                  className={run.id === selectedRunId ? 'is-selected' : ''}
                  aria-pressed={run.id === selectedRunId}
                  onClick={() => {
                    if (run.independent) void selectRun(run.id);
                    else {
                      const session = state.sessions.find((value) => value.id === run.sessionId);
                      if (session) onOpenConversation?.(session.conversationId ?? session.id);
                    }
                  }}
                  disabled={
                    !run.independent &&
                    (!onOpenConversation ||
                      !state.sessions.some((value) => value.id === run.sessionId))
                  }
                  aria-label={`${run.independent ? 'Open run' : 'Open chat'} from ${recordedAt(run.startedAt)}`}
                >
                  <strong>
                    {workflowId ? recordedAt(run.startedAt) : (definition?.name ?? 'Workflow run')}
                  </strong>
                  {run.id !== selectedRunId && (
                    <span className={`workflow-run-state is-${run.status}`}>
                      {workflowRunLabel(run.status)}
                    </span>
                  )}
                  <small className="workflow-run-destination">
                    {run.independent ? 'View run' : 'Open chat'}
                    <ArrowRight size={14} aria-hidden="true" />
                  </small>
                  {!projectId && (
                    <small>
                      {state.projects.find((value) => value.id === run.projectId)?.name ??
                        run.projectId}
                    </small>
                  )}
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
                  {workflowId
                    ? (currentNode?.name ?? 'Result')
                    : (workflow?.name ?? 'Workflow run')}
                </h3>
                <span role="status">{workflowRunLabel(currentDetail.status)}</span>
                {!workflowId && currentNode && (
                  <p className="workflow-current-step">{currentNode.name}</p>
                )}
              </div>
              <div className="workflow-run-controls">
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
            <WorkflowRunResultPanel
              run={currentDetail}
              canRead={
                Boolean(control?.canClaim) &&
                (!ownsRunControl || currentDetail.workflowRunResultEligible === true)
              }
              contextKey={humanContextKey}
              loaded={ownsRunControl ? terminalResult : null}
              busy={terminalResultBusy}
              error={terminalResultError}
              onRead={() => void loadTerminalResult()}
            />
            {currentDetail.status === 'waiting_gate' && currentNode?.kind === 'human' && (
              <section className="workflow-human-task" aria-label="Human task">
                {currentDetail.humanTaskDueAt &&
                  Date.parse(currentDetail.humanTaskDueAt) <= Date.now() && (
                    <span role="status">Overdue · {recordedAt(currentDetail.humanTaskDueAt)}</span>
                  )}
                {!currentNode.legacyHumanTask ? (
                  <WorkflowHumanTaskPanel
                    node={currentNode}
                    values={
                      canViewHumanDraft && humanValuesContext === humanContextKey ? humanValues : {}
                    }
                    onValuesChange={(values) => {
                      setHumanValues(values);
                      setHumanValuesContext(humanContextKey);
                    }}
                    onMaterialChange={invalidateHumanMaterial}
                    response={
                      canReviewTask &&
                      humanResponseContext === humanContextKey &&
                      currentResponse?.id === humanResponseId
                        ? currentResponse
                        : undefined
                    }
                    evidence={(currentDetail.evidence ?? []).filter(
                      (item) => item.source.attemptInstance === currentDetail.instance,
                    )}
                    review={
                      ownsRunControl && canReviewTask && humanReviewContext === humanContextKey
                        ? (humanReview ?? undefined)
                        : undefined
                    }
                    selectedOutcomeId={
                      canReviewTask && humanOutcomeContext === humanContextKey ? humanOutcomeId : ''
                    }
                    disabled={!canReviewTask || busy}
                    onOutcomeChange={(id) => {
                      humanMaterialGeneration.current += 1;
                      setHumanOutcomeId(id);
                      setHumanOutcomeContext(humanContextKey);
                      setHumanReview(null);
                      setHumanReviewContext('');
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
                      disabled={!canReviewTask || busy}
                      onClick={async () => {
                        if (!currentDetail.instance) return;
                        setBusy(true);
                        setActionError('');
                        try {
                          await ensureReviewer();
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
                      disabled={!canReviewTask || busy}
                      onClick={async () => {
                        if (!currentDetail.instance) return;
                        setBusy(true);
                        setActionError('');
                        try {
                          await ensureReviewer();
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
            <details className="workflow-run-history">
              <summary>Diagnostics</summary>
              <dl className="workflow-run-facts">
                <div>
                  <dt>Project</dt>
                  <dd>
                    {state.projects.find((value) => value.id === currentDetail.projectId)?.name ??
                      currentDetail.projectId}
                  </dd>
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
              <WorkflowRunComposition
                run={currentDetail}
                selectedRunId={selectedRunId}
                onOpenRun={(runId) => (onOpenRun ? onOpenRun(runId) : void selectRun(runId))}
                nodeLabel={(nodeId) =>
                  workflow?.nodes.find((node) => node.id === nodeId)?.name ?? 'Activity'
                }
                onPage={(offset) => {
                  compositionPageGeneration.current += 1;
                  setCompositionOffset(offset);
                }}
              />
            </details>
            <details className="workflow-run-history">
              <summary>Activity history</summary>
              <ol>
                {currentDetail.history.map((entry, index) => (
                  <li key={`${entry.instance ?? ''}:${entry.nodeId}:${index}`}>
                    <div>
                      <span>
                        {workflow?.nodes.find((node) => node.id === entry.nodeId)?.name ??
                          'Activity'}
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
