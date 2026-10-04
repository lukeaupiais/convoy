import type { ChangeEvent } from 'react';
import type {
  WorkflowEvidenceRef,
  WorkflowHumanReview,
  WorkflowHumanResponse,
  WorkflowStep,
} from '../../shared/api/runtime';
import './workflow-human-task.css';

export type WorkflowHumanTaskPanelProps = {
  node: WorkflowStep;
  values: Record<string, unknown>;
  onValuesChange: (values: Record<string, unknown>) => void;
  onMaterialChange: () => void;
  response?: WorkflowHumanResponse;
  evidence: WorkflowEvidenceRef[];
  review?: WorkflowHumanReview;
  selectedOutcomeId?: string;
  onOutcomeChange: (outcomeId: string) => void;
  disabled?: boolean;
  onSubmit: () => void;
  onCaptureDocument: (file?: File) => void;
  onReadEvidence: (evidenceId: string, name: string) => void;
  onPrepareOutcome: (outcomeId: string) => void;
  onDecide: () => void;
};

export function WorkflowHumanTaskPanel({
  node,
  values,
  onValuesChange,
  onMaterialChange,
  response,
  evidence,
  review,
  selectedOutcomeId,
  disabled = false,
  onOutcomeChange,
  onSubmit,
  onCaptureDocument,
  onReadEvidence,
  onPrepareOutcome,
  onDecide,
}: WorkflowHumanTaskPanelProps) {
  if (!node.humanTask || node.legacyHumanTask) return null;
  const fields = node.humanTask.form?.fields ?? [];
  function patchValue(fieldId: string, value: unknown, empty = false) {
    const next = { ...values };
    if (empty) delete next[fieldId];
    else next[fieldId] = value;
    onMaterialChange();
    onValuesChange(next);
  }
  function capture(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (file) onMaterialChange();
    onCaptureDocument(file);
  }
  return (
    <section className="workflow-human-task" aria-label="Human task">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {fields.map((field) => (
          <label key={field.id}>
            {field.label}
            {field.type === 'choice' ? (
              <select
                required={field.required}
                value={String(values[field.id] ?? '')}
                disabled={disabled}
                onChange={(event) =>
                  patchValue(field.id, event.target.value, event.target.value === '')
                }
              >
                <option value="">Select</option>
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : field.type === 'boolean' ? (
              <select
                required={field.required}
                value={
                  values[field.id] === true ? 'true' : values[field.id] === false ? 'false' : ''
                }
                disabled={disabled}
                onChange={(event) =>
                  patchValue(
                    field.id,
                    event.target.value === '' ? undefined : event.target.value === 'true',
                    event.target.value === '',
                  )
                }
              >
                <option value="">Select</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                required={field.required}
                disabled={disabled}
                step={field.type === 'number' ? 'any' : undefined}
                minLength={field.type === 'text' ? field.minLength : undefined}
                maxLength={field.type === 'text' ? field.maxLength : undefined}
                min={field.type === 'number' ? field.minimum : undefined}
                max={field.type === 'number' ? field.maximum : undefined}
                value={String(values[field.id] ?? '')}
                onChange={(event) => {
                  const empty =
                    event.target.value === '' && (field.type === 'number' || field.type === 'date');
                  patchValue(
                    field.id,
                    field.type === 'number' ? Number(event.target.value) : event.target.value,
                    empty,
                  );
                }}
              />
            )}
          </label>
        ))}
        <label>
          Document
          <input
            type="file"
            accept="application/pdf,text/plain,text/markdown,application/json"
            disabled={disabled}
            onChange={capture}
          />
        </label>
        <button type="submit" className="primary" disabled={disabled}>
          Save response
        </button>
      </form>
      {evidence.map((item) => (
        <button
          type="button"
          key={item.id}
          className="secondary"
          onClick={() => onReadEvidence(item.id, item.name)}
        >
          {item.name}
        </button>
      ))}
      {response && (
        <div className="workflow-human-outcomes">
          <label>
            Outcome
            <select
              value={selectedOutcomeId ?? ''}
              disabled={disabled}
              onChange={(event) => onOutcomeChange(event.target.value)}
            >
              <option value="">Select</option>
              {node.humanTask.outcomes.map((outcome) => (
                <option key={outcome.id} value={outcome.id}>
                  {outcome.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={disabled || !selectedOutcomeId}
            onClick={() => selectedOutcomeId && onPrepareOutcome(selectedOutcomeId)}
          >
            Review
          </button>
        </div>
      )}
      {review && (
        <div className="workflow-human-review">
          <dl className="workflow-human-review-values">
            {fields.map((field) =>
              review.response.values[field.id] !== undefined ? (
                <div key={field.id}>
                  <dt>{field.label}</dt>
                  <dd>{displayValue(review.response.values[field.id])}</dd>
                </div>
              ) : null,
            )}
          </dl>
          {review.evidence.length > 0 && (
            <ul aria-label="Reviewed evidence">
              {review.evidence.map((item) => (
                <li key={item.id}>{item.name}</li>
              ))}
            </ul>
          )}
          {review.reservation?.preview && (
            <div className="workflow-human-prepared">
              <strong>Prepared effect · {review.reservation.preview.activity}</strong>
              {review.reservation.preview.input !== undefined && (
                <>
                  <strong>Prepared values</strong>
                  <dl>
                    {Object.entries(asRecord(review.reservation.preview.input)).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{humanize(key)}</dt>
                          <dd>{displayValue(value)}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                </>
              )}
            </div>
          )}
          <details>
            <summary>Review details</summary>
            <pre>
              {JSON.stringify(
                {
                  response: review.response,
                  evidence: review.evidence,
                  materialDigest: review.materialDigest,
                  reservation: review.reservation,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <button type="button" className="primary" disabled={disabled} onClick={onDecide}>
            {node.humanTask.outcomes.find((outcome) => outcome.id === selectedOutcomeId)?.label ??
              'Decide'}
          </button>
        </div>
      )}
    </section>
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function displayValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function humanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (first) => first.toUpperCase());
}
