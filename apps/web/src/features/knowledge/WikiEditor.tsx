import { useEffect, useRef, useState } from 'react';
import { command, type KnowledgePage, type KnowledgePageSummary } from '../../shared/api/runtime';
import { WikiMarkdown } from './WikiMarkdown';

export function WikiEditor({
  initial,
  collectionId,
  projectId,
  pages,
  onSaved,
  onClose,
}: {
  initial: KnowledgePage | null;
  collectionId: string;
  projectId: string;
  pages: KnowledgePageSummary[];
  onSaved: (page: KnowledgePage, published: boolean) => void;
  onClose: () => void;
}) {
  const [page, setPage] = useState(initial);
  const [draft, setDraft] = useState(
    initial?.draft ?? { title: '', body: '', aliases: [], language: 'und', applicability: '' },
  );
  const [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(JSON.stringify(draft));
  const dirty = JSON.stringify(draft) !== saved.current;
  const canLeave = () => {
    if (JSON.stringify(draft) === saved.current) return true;
    if (!window.confirm('Discard unsaved changes?')) return false;
    saved.current = JSON.stringify(draft);
    return true;
  };
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const leave = (e: Event) => {
      if (!canLeave()) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    window.addEventListener('convoy-wiki-leave', leave);
    return () => {
      window.removeEventListener('beforeunload', before);
      window.removeEventListener('convoy-wiki-leave', leave);
    };
  }, [dirty]);
  async function save(publish: boolean) {
    setBusy(true);
    setError('');
    try {
      let result = page;
      if (!result || dirty)
        result = (
          await command('saveKnowledgeDraft', {
            collectionId,
            pageId: result?.id,
            expectedRevision: result?.revision ?? 0,
            ...draft,
          })
        ).result;
      saved.current = JSON.stringify(draft);
      setPage(result);
      if (publish) {
        result = (
          await command('publishKnowledgePage', {
            pageId: result.id,
            expectedRevision: result.revision,
          })
        ).result;
        setPage(result);
      }
      onSaved(result, publish);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function insertLink(p: KnowledgePageSummary) {
    const input = editor.current,
      start = input?.selectionStart ?? draft.body.length,
      end = input?.selectionEnd ?? start;
    const link = `[${p.title.replace(/([\\\[\]])/g, '\\$1')}](wiki:${p.id})`;
    setDraft({ ...draft, body: draft.body.slice(0, start) + link + draft.body.slice(end) });
    setLinkQuery('');
    setPreview(false);
    requestAnimationFrame(() => {
      editor.current?.focus();
      editor.current?.setSelectionRange(start + link.length, start + link.length);
    });
  }
  return (
    <section className="wiki-editor" aria-label="Page editor">
      <header className="wiki-editbar">
        <h1>{page ? 'Edit page' : 'New page'}</h1>
        <span role="status">{dirty ? 'Unsaved changes' : page ? 'Draft saved' : ''}</span>
        <button
          disabled={busy}
          onClick={() => {
            if (canLeave()) onClose();
          }}
        >
          Cancel
        </button>
        <button
          disabled={busy || !draft.title.trim() || (!dirty && !!page)}
          onClick={() => void save(false)}
        >
          Save draft
        </button>
        <button
          className="wiki-primary"
          disabled={busy || !draft.title.trim() || !draft.body.trim()}
          onClick={() => void save(true)}
        >
          Publish
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {page?.state === 'archived' && (
        <p className="wiki-notice">
          This page is archived.{' '}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const p = (
                  await command('setKnowledgePageState', {
                    pageId: page.id,
                    expectedRevision: page.revision,
                    state: 'active',
                  })
                ).result;
                setPage(p);
                onSaved(p, false);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore page
          </button>
        </p>
      )}
      <label>
        Title
        <input
          maxLength={200}
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </label>
      <div className="wiki-edit-tools">
        <button aria-pressed={!preview} onClick={() => setPreview(false)}>
          Write
        </button>
        <button aria-pressed={preview} onClick={() => setPreview(true)}>
          Preview
        </button>
        <details>
          <summary>Insert page link</summary>
          <input
            aria-label="Find page to link"
            placeholder="Find a page…"
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
          />
          <div className="wiki-link-options">
            {pages
              .filter(
                (p) =>
                  p.state === 'active' &&
                  p.publishedVersion &&
                  p.title.toLowerCase().includes(linkQuery.toLowerCase()),
              )
              .map((p) => (
                <button key={p.id} onClick={() => insertLink(p)}>
                  {p.title}
                </button>
              ))}
          </div>
        </details>
      </div>
      {preview ? (
        <WikiMarkdown text={draft.body} location={{ projectId }} />
      ) : (
        <label className="wiki-body-label">
          Markdown
          <textarea
            ref={editor}
            aria-label="Page Markdown"
            rows={22}
            maxLength={64000}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </label>
      )}
      <details className="wiki-metadata">
        <summary>Page details</summary>
        <label>
          Aliases
          <input
            value={draft.aliases.join(', ')}
            onChange={(e) =>
              setDraft({ ...draft, aliases: e.target.value.split(',').map((v) => v.trim()) })
            }
          />
        </label>
        <label>
          Language
          <input
            maxLength={30}
            value={draft.language}
            onChange={(e) => setDraft({ ...draft, language: e.target.value })}
          />
        </label>
        <label>
          Applies to
          <input
            maxLength={1000}
            value={draft.applicability}
            onChange={(e) => setDraft({ ...draft, applicability: e.target.value })}
          />
        </label>
      </details>
    </section>
  );
}
