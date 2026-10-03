import { useState } from 'react';
import {
  command,
  type KnowledgeCollection,
  type KnowledgePageSummary,
} from '../../shared/api/runtime';
export function CollectionSettings({
  collection,
  pages,
  projectId,
  onDone,
}: {
  collection?: KnowledgeCollection;
  pages: KnowledgePageSummary[];
  projectId: string;
  onDone: (id?: string) => void;
}) {
  const [created, setCreated] = useState(collection);
  const [name, setName] = useState(collection?.name ?? ''),
    [description, setDescription] = useState(collection?.description ?? '');
  const [order, setOrder] = useState(pages.map((p) => p.id));
  const [starts, setStarts] = useState(
    (collection?.startPageIds ?? []).filter((id) =>
      pages.some((p) => p.id === id && p.state === 'active' && p.publishedVersion),
    ),
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError('');
    try {
      const c = created ?? (await command('createKnowledgeCollection', { projectId, name })).result;
      setCreated(c);
      await command('updateKnowledgeCollection', {
        collectionId: c.id,
        expectedRevision: c.revision,
        name,
        description,
        startPageIds: starts,
        pageOrder: order,
      });
      onDone(c.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="wiki-settings" aria-label="Collection settings">
      <header className="wiki-editbar">
        <h1>{collection ? 'Collection settings' : 'New collection'}</h1>
        <button disabled={busy} onClick={() => onDone()}>
          Cancel
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Introduction
          <textarea
            rows={4}
            maxLength={4000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {!!pages.length && (
          <>
            <h2>Pages</h2>
            <ol className="wiki-order">
              {order.map((id, index) => {
                const p = pages.find((p) => p.id === id)!;
                return (
                  <li key={id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Start with ${p.title}`}
                        checked={starts.includes(id)}
                        disabled={
                          !p.publishedVersion ||
                          p.state !== 'active' ||
                          (!starts.includes(id) && starts.length >= 20)
                        }
                        onChange={(e) =>
                          setStarts(
                            e.target.checked ? [...starts, id] : starts.filter((x) => x !== id),
                          )
                        }
                      />
                      {p.title}
                    </label>
                    <button
                      type="button"
                      aria-label={`Move ${p.title} up`}
                      disabled={index === 0}
                      onClick={() =>
                        setOrder((prev) => {
                          const next = [...prev];
                          [next[index - 1], next[index]] = [next[index], next[index - 1]];
                          return next;
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${p.title} down`}
                      disabled={index === order.length - 1}
                      onClick={() =>
                        setOrder((prev) => {
                          const next = [...prev];
                          [next[index + 1], next[index]] = [next[index], next[index + 1]];
                          return next;
                        })
                      }
                    >
                      ↓
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        <button className="wiki-primary" disabled={busy}>
          Save collection
        </button>
      </form>
      {collection && (
        <details className="wiki-metadata">
          <summary>Archive</summary>
          <button
            disabled={busy}
            onClick={async () => {
              if (
                collection.state === 'active' &&
                !window.confirm(
                  'Archive this collection? Its pages will no longer be available to readers or agents.',
                )
              )
                return;
              setBusy(true);
              try {
                await command('setKnowledgeCollectionState', {
                  collectionId: collection.id,
                  expectedRevision: collection.revision,
                  state: collection.state === 'active' ? 'archived' : 'active',
                });
                onDone();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {collection.state === 'active' ? 'Archive collection' : 'Restore collection'}
          </button>
        </details>
      )}
    </section>
  );
}
