import { useEffect, useState } from 'react';
import {
  command,
  type RuntimeState,
  type KnowledgeSelection,
  type KnowledgePageSummary,
} from '../../shared/api/runtime';

export function KnowledgePicker({
  state,
  value,
  onChange,
}: {
  state: RuntimeState;
  value: KnowledgeSelection;
  onChange: (value: KnowledgeSelection) => void;
}) {
  const [pages, setPages] = useState<KnowledgePageSummary[]>([]);
  const [error, setError] = useState('');
  const collections = state.knowledgeCollections ?? [];
  useEffect(() => {
    let active = true;
    setError('');
    setPages([]);
    const selected = collections.filter((c) => value.collectionIds.includes(c.id));
    void Promise.all(
      selected.map((c) =>
        command('listKnowledgePages', { projectId: c.projectId, collectionId: c.id, limit: 100 }),
      ),
    )
      .then((results) => {
        if (active) {
          setPages(
            results
              .flatMap((r) => r.result.pages)
              .filter((p) => p.publishedVersion && p.state === 'active'),
          );
          if (results.some((r) => r.result.hasMore))
            setError('Entry picker shows the first 100 pages per collection.');
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [value.collectionIds.join(','), collections.map((c) => c.id + c.revision).join(',')]);
  return (
    <fieldset>
      <legend>Knowledge</legend>
      {collections
        .filter((c) => c.state === 'active')
        .map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={value.collectionIds.includes(c.id)}
              onChange={(e) =>
                onChange({
                  collectionIds: e.target.checked
                    ? [...value.collectionIds, c.id]
                    : value.collectionIds.filter((id) => id !== c.id),
                })
              }
            />{' '}
            {c.name}
          </label>
        ))}
      <label>
        Entry page
        <select
          value={value.entryPage ? `${value.entryPage.pageId}@${value.entryPage.version}` : ''}
          onChange={(e) => {
            const [pageId, version] = e.target.value.split('@');
            onChange({
              ...value,
              ...(pageId
                ? { entryPage: { pageId, version: Number(version) } }
                : { entryPage: undefined }),
            });
          }}
        >
          <option value="">None</option>
          {value.entryPage &&
            !pages.some(
              (p) =>
                p.id === value.entryPage?.pageId && p.publishedVersion === value.entryPage.version,
            ) && (
              <option value={`${value.entryPage.pageId}@${value.entryPage.version}`}>
                Pinned v{value.entryPage.version} · {value.entryPage.pageId}
              </option>
            )}
          {pages.map((p) => (
            <option key={p.id} value={`${p.id}@${p.publishedVersion}`}>
              {p.title} · v{p.publishedVersion}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
