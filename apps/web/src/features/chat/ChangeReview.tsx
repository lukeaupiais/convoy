import { CheckCircle2, FileDiff, RefreshCw, X, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { Session } from '../../shared/api/runtime';

function changedFiles(review: Session['review']) {
  if (!review) return [];
  const statusFiles = review.status
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const diffFiles = [...review.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]);
  return [...new Set([...statusFiles, ...diffFiles])];
}

export function ChangeReview({
  open,
  session,
  refreshing,
  onRefresh,
  onClose,
}: {
  open: boolean;
  session: Session;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const files = useMemo(() => changedFiles(session.review), [session.review]);
  const checks = [...session.checks].reverse();
  return (
    <dialog
      ref={dialog}
      className="change-review"
      aria-label="Review agent changes"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <FileDiff size={18} />
          <div>
            <h2>Review changes</h2>
            <small>
              {files.length
                ? `${files.length} changed ${files.length === 1 ? 'file' : 'files'}`
                : 'Workspace evidence'}
            </small>
          </div>
        </div>
        <div>
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'is-spinning' : ''} />
            Refresh
          </button>
          <button type="button" aria-label="Close review" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="review-body">
        <aside>
          <section>
            <h3>Files</h3>
            {files.length ? (
              files.map((file) => <code key={file}>{file}</code>)
            ) : (
              <p>No file changes detected.</p>
            )}
          </section>
          <section>
            <h3>Checks</h3>
            {checks.length ? (
              checks.map((check, index) => (
                <div className="review-check" key={`${check.at}-${index}`}>
                  {check.code === 0 && !check.concurrent ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <XCircle size={14} />
                  )}
                  <span>
                    <code>{check.command}</code>
                    <small>
                      {check.concurrent
                        ? 'Not valid evidence · concurrent activity'
                        : `Exit ${check.code}`}
                    </small>
                  </span>
                </div>
              ))
            ) : (
              <p>No checks recorded.</p>
            )}
          </section>
        </aside>
        <main>
          {refreshing && !session.review ? (
            <p className="review-empty">Inspecting workspace…</p>
          ) : session.review?.diff ? (
            <pre aria-label="Workspace diff">{session.review.diff}</pre>
          ) : (
            <p className="review-empty">The worktree currently has no tracked diff.</p>
          )}
          {session.review?.truncated && <small>Diff output was truncated by the runner.</small>}
        </main>
      </div>
    </dialog>
  );
}
