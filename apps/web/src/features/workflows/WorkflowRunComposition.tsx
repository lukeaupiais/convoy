import type { WorkflowRun } from '../../shared/api/runtime';
import './workflow-runs.css';

function recordedAt(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WorkflowRunComposition({
  run,
  selectedRunId,
  onOpenRun,
  onPage,
  nodeLabel,
}: {
  run: WorkflowRun;
  selectedRunId?: string;
  onOpenRun?: (runId: string) => void;
  onPage?: (offset: number) => void;
  nodeLabel?: (nodeId: string) => string;
}) {
  const compositions = run.compositions ?? [];
  const total = run.compositionAttemptsTotal ?? compositions.length;
  if (!compositions.length) return null;
  const start = run.compositionAttemptsOffset ?? Math.max(0, total - compositions.length);
  const end = start + compositions.length;
  return (
    <section className="workflow-composition-history" aria-label="Child workflows">
      <header>
        <h4>
          Child workflows · {start + 1}–{end} of {total}
        </h4>
        {onPage && total > 50 && (
          <nav aria-label="Composition history pages">
            <button
              type="button"
              className="secondary"
              disabled={start <= 0}
              onClick={() => onPage(Math.max(0, start - 50))}
            >
              Older
            </button>
            <button
              type="button"
              className="secondary"
              disabled={end >= total}
              onClick={() => onPage(Math.min(total - 50, start + 50))}
            >
              Newer
            </button>
          </nav>
        )}
      </header>
      {compositions.map((composition) => (
        <article key={`${composition.nodeId}:${composition.instance}`}>
          <header>
            <strong>{nodeLabel?.(composition.nodeId) ?? composition.nodeId}</strong>
            <span>
              {composition.kind} · {composition.status.replaceAll('_', ' ')}
            </span>
          </header>
          {composition.deadlineAt && (
            <time dateTime={composition.deadlineAt}>
              Deadline {recordedAt(composition.deadlineAt)}
            </time>
          )}
          {composition.winnerSlotId && <span>Winner · {composition.winnerSlotId}</span>}
          {composition.forwardOutcome && (
            <span>
              Forward {composition.forwardOutcome.status.replaceAll('_', ' ')}
              {composition.forwardOutcome.message ? ` · ${composition.forwardOutcome.message}` : ''}
            </span>
          )}
          {composition.compensationStatus && (
            <span>Compensation · {composition.compensationStatus.replaceAll('_', ' ')}</span>
          )}
          <ul>
            {composition.slots.map((slot) => (
              <li key={slot.runId}>
                <div>
                  <strong>
                    {slot.workflowId} · v{slot.workflowVersion}
                  </strong>
                  <span>
                    {slot.status.replaceAll('_', ' ')}
                    {slot.message ? ` · ${slot.message}` : ''}
                  </span>
                </div>
                {slot.childRunCreated && onOpenRun ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={slot.runId === selectedRunId}
                    onClick={() => onOpenRun(slot.runId)}
                  >
                    Open run
                  </button>
                ) : !slot.childRunCreated ? (
                  <span role="status">Run not created</span>
                ) : null}
                {(slot.inputDigest || slot.outputDigest || slot.effectKey) && (
                  <details>
                    <summary>Run details</summary>
                    {slot.inputDigest && <div>Input {slot.inputDigest}</div>}
                    {slot.outputDigest && <div>Output {slot.outputDigest}</div>}
                    {slot.effectKey && <div>Effect {slot.effectKey}</div>}
                  </details>
                )}
              </li>
            ))}
          </ul>
          {(composition.compensations?.length ?? 0) > 0 && (
            <ul aria-label="Compensation runs">
              {composition.compensations?.map((slot) => (
                <li key={`${slot.id}:${slot.runId}`}>
                  <div>
                    <strong>
                      {slot.id} · {slot.workflowId} · v{slot.workflowVersion}
                    </strong>
                    <span>
                      {slot.trigger} · {slot.status.replaceAll('_', ' ')}
                      {slot.message ? ` · ${slot.message}` : ''}
                    </span>
                  </div>
                  {slot.childRunCreated && onOpenRun ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={slot.runId === selectedRunId}
                      onClick={() => onOpenRun(slot.runId)}
                    >
                      Open run
                    </button>
                  ) : !slot.childRunCreated ? (
                    <span role="status">Run not created</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {composition.slotsTruncated && (
            <span role="status">Some child runs are omitted from this view.</span>
          )}
        </article>
      ))}
    </section>
  );
}

export function WorkflowRunResultPanel({
  run,
  canRead,
  contextKey,
  loaded,
  busy,
  error,
  onRead,
}: {
  run: WorkflowRun;
  canRead: boolean;
  contextKey: string;
  loaded?: { contextKey: string; result: Record<string, unknown>; resultDigest: string } | null;
  busy: boolean;
  error?: string;
  onRead: () => void;
}) {
  if (run.status !== 'completed' || !run.resultDigest) return null;
  return (
    <section className="workflow-terminal-result" aria-label="Workflow result">
      <header>
        <h4>Result</h4>
        <button type="button" className="secondary" disabled={!canRead || busy} onClick={onRead}>
          {busy ? 'Loading' : loaded ? 'Refresh result' : 'View result'}
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {canRead && loaded?.contextKey === contextKey && (
        <>
          <dl>
            {Object.entries(loaded.result).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{resultValueSummary(value)}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary>Result details</summary>
            <pre>{JSON.stringify(loaded.result, null, 2)}</pre>
            <small>{loaded.resultDigest}</small>
          </details>
        </>
      )}
    </section>
  );
}

function resultValueSummary(value: unknown) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && typeof value === 'object') return `${Object.keys(value).length} fields`;
  return '—';
}
