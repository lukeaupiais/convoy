import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FileText, X } from 'lucide-react';
import type { WorkflowSubmission, WorkflowSubmissionArtifact } from '../../shared/api/runtime';
import { artifactMarkdownBlocks } from './artifact-markdown';

function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

export function MarkdownDocument({ text }: { text: string }) {
  return (
    <article className="artifact-markdown">
      {artifactMarkdownBlocks(text).map((block, index) => {
        if (block.kind === 'heading') {
          const Heading = (block.level <= 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4') as
            | 'h2'
            | 'h3'
            | 'h4';
          return <Heading key={index}>{inline(block.text)}</Heading>;
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
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        if (block.kind === 'table') {
          return (
            <div className="artifact-table" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((cell, cellIndex) => (
                      <th key={cellIndex}>{inline(cell)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{inline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return <p key={index}>{inline(block.text)}</p>;
      })}
    </article>
  );
}

export function ArtifactReview({
  sessionId,
  submission,
  waitingForDecision,
  canRevise,
  focused = false,
  working,
  onApprove,
  onRequestChanges,
}: {
  sessionId: string;
  submission: WorkflowSubmission;
  waitingForDecision: boolean;
  canRevise: boolean;
  focused?: boolean;
  working: boolean;
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
}) {
  const artifacts = useMemo(
    () =>
      submission.artifacts.filter(
        (artifact): artifact is WorkflowSubmissionArtifact => typeof artifact !== 'string',
      ),
    [submission.artifacts],
  );
  const primary =
    artifacts.find((artifact) => artifact.id === submission.primaryArtifactId) ?? artifacts[0];
  const [open, setOpen] = useState(focused);
  const [selectedId, setSelectedId] = useState(primary?.id ?? '');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [raw, setRaw] = useState(false);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [feedback, setFeedback] = useState('');
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? primary;

  useEffect(() => {
    if (focused) setOpen(true);
  }, [focused]);

  useEffect(() => {
    if (!open || !selected) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetch(`/api/context/${encodeURIComponent(sessionId)}/${selected.id}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Artifact snapshot is unavailable.');
        return response.text();
      })
      .then(setContent)
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, selected?.id, sessionId]);

  if (!primary) return null;
  const supporting = artifacts.filter((artifact) => artifact.id !== primary.id);
  if (!open) {
    return (
      <section className="artifact-review-summary" aria-label="Submission ready for review">
        <div>
          <strong>{submission.step} ready for review</strong>
          <p>{submission.summary}</p>
          {supporting.length > 0 && (
            <small>
              {supporting.length} supporting {supporting.length === 1 ? 'document' : 'documents'}
            </small>
          )}
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          Review {primary.name}
        </button>
      </section>
    );
  }

  return (
    <section className={`artifact-review${focused ? ' focused' : ''}`} aria-label="Artifact review">
      {!focused && (
        <header>
          <div>
            <strong>{submission.step}</strong>
            <span>Submission v{submission.revision ?? 1}</span>
          </div>
          <button
            className="icon-button"
            aria-label="Close artifact review"
            onClick={() => setOpen(false)}
          >
            <X size={17} />
          </button>
        </header>
      )}
      {!focused && (
        <details className="artifact-review-summary-text">
          <summary>Agent summary</summary>
          <p>{submission.summary}</p>
        </details>
      )}
      {focused && (
        <nav className="artifact-file-switcher" aria-label="Plan documents">
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              className={selected?.id === artifact.id ? 'selected' : ''}
              onClick={() => setSelectedId(artifact.id)}
            >
              {artifact.name}
            </button>
          ))}
        </nav>
      )}
      {!focused && (
        <div className="artifact-document-heading">
          <span>
            <FileText size={15} /> {selected?.path}
          </span>
          <button className="quiet-button" onClick={() => setRaw((value) => !value)}>
            {raw ? 'Rendered' : 'Raw'}
          </button>
        </div>
      )}
      <div className="artifact-document" aria-live="polite">
        {loading ? (
          <p>Loading document…</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : raw && !focused ? (
          <pre>{content}</pre>
        ) : (
          <MarkdownDocument text={content} />
        )}
      </div>
      {!focused && supporting.length > 0 && (
        <details className="artifact-supporting">
          <summary>
            <ChevronDown size={14} /> Supporting files ({supporting.length})
          </summary>
          <div>
            {supporting.map((artifact) => (
              <button
                key={artifact.id}
                className={selected?.id === artifact.id ? 'selected' : ''}
                onClick={() => setSelectedId(artifact.id)}
              >
                <FileText size={14} /> {artifact.path}
              </button>
            ))}
          </div>
        </details>
      )}
      {!focused && (
        <details className="artifact-provenance">
          <summary>Document details</summary>
          <code>{selected?.hash}</code>
        </details>
      )}
      {waitingForDecision && (
        <footer className="artifact-review-actions">
          {requestingChanges ? (
            <>
              <textarea
                aria-label="Revision feedback"
                placeholder="What should change?"
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
              />
              <div>
                <button className="secondary" onClick={() => setRequestingChanges(false)}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={working || !feedback.trim()}
                  onClick={() => onRequestChanges(feedback)}
                >
                  Send request
                </button>
              </div>
            </>
          ) : (
            <>
              {canRevise && (
                <button
                  className="secondary"
                  disabled={working}
                  onClick={() => setRequestingChanges(true)}
                >
                  Request changes
                </button>
              )}
              <button className="primary" disabled={working} onClick={onApprove}>
                {focused ? 'Approve' : 'Approve submission'}
              </button>
            </>
          )}
        </footer>
      )}
    </section>
  );
}
