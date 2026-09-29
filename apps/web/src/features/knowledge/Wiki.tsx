import { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Search,
  Plus,
  Menu,
  X,
  FileText,
  ArrowUpRight,
  MoreHorizontal,
} from 'lucide-react';
import {
  command,
  type RuntimeState,
  type KnowledgePage,
  type KnowledgePageSummary,
  type KnowledgeRead,
  type KnowledgeHit,
} from '../../shared/api/runtime';
import { WikiMarkdown } from './WikiMarkdown';
import { WikiEditor } from './WikiEditor';
import { CollectionSettings } from './CollectionSettings';
import { parseWikiLocation, wikiHref, type WikiLocation } from './wiki-navigation';
import { copyText } from '../../shared/lib/browser';
import './wiki.css';

async function listPages(projectId: string, collectionId?: string, draft = false) {
  const pages: KnowledgePageSummary[] = [];
  for (let offset = 0; ; offset += 100) {
    const r = await command('listKnowledgePages', {
      projectId,
      ...(collectionId ? { collectionId } : {}),
      offset,
      limit: 100,
      ...(draft ? { draft: true } : {}),
    });
    pages.push(...r.result.pages);
    if (!r.result.hasMore) return pages;
    if (pages.length >= 1000)
      throw new Error('This view supports up to 1,000 pages. Use smaller collections.');
  }
}
export function Wiki({ state, projectId }: { state: RuntimeState; projectId?: string }) {
  const collections = (state.knowledgeCollections ?? []).filter((c) => c.projectId === projectId);
  const [route, setRoute] = useState<WikiLocation>(
    () => parseWikiLocation(window.location.hash) ?? {},
  );
  const [reading, setReading] = useState<KnowledgeRead | null>(null),
    [pages, setPages] = useState<KnowledgePageSummary[]>([]);
  const [mode, setMode] = useState<'read' | 'edit' | 'settings' | 'create-collection'>('read');
  const [draft, setDraft] = useState<KnowledgePage | null>(null),
    [linkPages, setLinkPages] = useState<KnowledgePageSummary[]>([]);
  const [query, setQuery] = useState(''),
    [searchCollection, setSearchCollection] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null),
    [moreHits, setMoreHits] = useState(false),
    [searchLimit, setSearchLimit] = useState(8);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(false),
    [manage, setManage] = useState(false),
    [showArchived, setShowArchived] = useState(false);
  const [refresh, setRefresh] = useState(0),
    [revision, setRevision] = useState(1);
  const generation = useRef(0);
  const collectionId =
    reading?.collectionId ??
    route.collectionId ??
    collections.find((c) => c.state === 'active')?.id ??
    '';
  const collection = collections.find((c) => c.id === collectionId);
  const project = state.projects.find((p) => p.id === projectId);
  const location = { projectId, collectionId, pageId: reading?.pageId, version: route.version };
  const latest = pages.find((p) => p.id === reading?.pageId)?.publishedVersion;
  const href = (values: WikiLocation = {}) => wikiHref({ projectId, collectionId, ...values });
  const navigate = (values: WikiLocation = {}) => {
    window.location.hash = href(values);
  };
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    const current = generation.current;
    try {
      await work();
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    const changed = () => {
      generation.current++;
      setBusy(false);
      setRoute(parseWikiLocation(window.location.hash) ?? {});
      setHits(null);
      setMode('read');
      setDrawer(false);
      setError('');
    };
    window.addEventListener('convoy-wiki-route', changed);
    return () => {
      generation.current++;
      window.removeEventListener('convoy-wiki-route', changed);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setReading(null);
    setError('');
    if (!route.pageId || (route.projectId && route.projectId !== projectId)) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const first = (
        await command('readKnowledgePage', {
          pageId: route.pageId!,
          version: route.version,
          limit: 12000,
        })
      ).result;
      if (!('content' in first)) throw new Error('Published page unavailable.');
      if (active && !collections.some((c) => c.id === first.collectionId))
        throw new Error('Page is outside this project.');
      let content = first.content,
        next = first.nextOffset;
      while (next !== null) {
        const r = (
          await command('readKnowledgePage', {
            pageId: first.pageId,
            version: first.version,
            offset: next,
            limit: 12000,
          })
        ).result;
        if (
          !('content' in r) ||
          r.hash !== first.hash ||
          r.offset !== next ||
          (r.nextOffset !== null && r.nextOffset <= next)
        )
          throw new Error('Page changed while reading. Reload it.');
        content += r.content;
        next = r.nextOffset;
      }
      if (active) {
        setReading({ ...first, content, nextOffset: null });
        setRevision(first.version);
      }
    })()
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, route.pageId, route.version, refresh]);
  useEffect(() => {
    let active = true;
    setPages([]);
    if (projectId && collectionId)
      void listPages(projectId, collectionId, manage)
        .then((p) => {
          if (active) setPages(p);
        })
        .catch((e) => {
          if (active) {
            setError(e.message);
            if (manage) setManage(false);
          }
        });
    return () => {
      active = false;
    };
  }, [projectId, collectionId, manage, refresh, collection?.revision]);
  useEffect(() => {
    if (!reading) return;
    const target = route.section
      ? document.getElementById(`wiki-section-${route.section}`)
      : document.getElementById('wiki-top');
    target?.scrollIntoView({ block: 'start' });
  }, [reading, route.section]);
  async function edit(pageId?: string) {
    await perform(async () => {
      const current = generation.current;
      const links = await listPages(projectId!);
      const p = pageId
        ? (await command('readKnowledgePage', { pageId, draft: true })).result
        : null;
      if (p && !('draft' in p)) throw new Error('Draft unavailable.');
      if (current !== generation.current) return;
      setDraft(p);
      setLinkPages(links);
      setHits(null);
      setMode('edit');
      setDrawer(false);
    });
  }
  async function search(limit = 8) {
    await perform(async () => {
      const current = generation.current;
      const r = await command('searchKnowledge', {
        projectId: projectId!,
        query,
        limit,
        ...(searchCollection ? { collectionId: searchCollection } : {}),
      });
      if (current !== generation.current) return;
      setHits(r.result.results);
      setMoreHits(r.result.hasMore);
      setSearchLimit(limit);
      setMode('read');
      setDrawer(false);
    });
  }
  if (!projectId)
    return (
      <section className="wiki">
        <p>Select a project to open its wiki.</p>
      </section>
    );
  const visiblePages = pages.filter((p) => showArchived || p.state !== 'archived');
  const startPages = (collection?.startPageIds ?? [])
    .map((id) => pages.find((p) => p.id === id && p.state === 'active' && p.publishedVersion))
    .filter((p): p is KnowledgePageSummary => !!p);
  return (
    <section className="wiki" aria-label="Project wiki">
      <header id="wiki-top" className="wiki-topbar">
        <button
          className="wiki-mobile-nav"
          aria-label={drawer ? 'Close wiki navigation' : 'Open wiki navigation'}
          aria-expanded={drawer}
          onClick={() => setDrawer(!drawer)}
        >
          {drawer ? <X size={18} /> : <Menu size={18} />}
        </button>
        <a className="wiki-brand" href={wikiHref({ projectId })}>
          <BookOpen size={20} />
          <span>
            {project?.name} <span className="wiki-muted">/ Wiki</span>
          </span>
        </a>
        <form
          className="wiki-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (window.dispatchEvent(new Event('convoy-wiki-leave', { cancelable: true })))
              void search();
          }}
        >
          <Search size={17} />
          <input
            aria-label="Search wiki"
            placeholder="Search knowledge…"
            required
            maxLength={300}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Search scope"
            value={searchCollection}
            onChange={(e) => setSearchCollection(e.target.value)}
          >
            <option value="">All collections</option>
            {collections
              .filter((c) => c.state === 'active')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <button disabled={busy}>Search</button>
        </form>
        {collection?.state === 'active' && (
          <button
            className="wiki-new"
            disabled={busy || mode === 'edit'}
            onClick={() => void edit()}
          >
            <Plus size={16} />
            New page
          </button>
        )}
      </header>
      {error && (
        <p className="wiki-error" role="alert">
          {error}
        </p>
      )}
      <div className="wiki-layout">
        <nav className={`wiki-navigation ${drawer ? 'is-open' : ''}`} aria-label="Wiki pages">
          <label className="wiki-collection-label">
            Collection
            <select
              aria-label="Wiki collection"
              value={collectionId}
              onChange={(e) => navigate({ collectionId: e.target.value })}
            >
              <option value="" disabled>
                Select collection
              </option>
              {collections
                .filter((c) => showArchived || c.state === 'active')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.state === 'archived' ? ' · archived' : ''}
                  </option>
                ))}
            </select>
          </label>
          {collection && (
            <>
              <a href={href()} className={!reading && !route.pageId ? 'is-active' : ''}>
                <BookOpen size={16} />
                Overview
              </a>
              <div className="wiki-nav-label">Pages</div>
              {visiblePages.map((p) =>
                p.publishedVersion && p.state === 'active' ? (
                  <a
                    key={p.id}
                    href={href({ pageId: p.id })}
                    aria-current={reading?.pageId === p.id ? 'page' : undefined}
                  >
                    <FileText size={15} />
                    <span>{p.title}</span>
                  </a>
                ) : (
                  <button key={p.id} onClick={() => void edit(p.id)}>
                    <FileText size={15} />
                    {p.title}
                    <small>{p.state === 'archived' ? 'Archived' : 'Draft'}</small>
                  </button>
                ),
              )}
              {!pages.length && <p className="wiki-muted">No published pages yet.</p>}
            </>
          )}
          <details className="wiki-nav-manage">
            <summary>Manage</summary>
            <label>
              <input
                type="checkbox"
                checked={manage}
                onChange={(e) => {
                  setManage(e.target.checked);
                  if (!e.target.checked) setShowArchived(false);
                }}
              />
              Show drafts
            </label>
            <label>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => {
                  setShowArchived(e.target.checked);
                  if (e.target.checked) setManage(true);
                }}
              />
              Show archived
            </label>
            <button
              onClick={() => {
                if (window.dispatchEvent(new Event('convoy-wiki-leave', { cancelable: true }))) {
                  setMode('create-collection');
                  setDrawer(false);
                }
              }}
            >
              New collection
            </button>
            {collection && (
              <button
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (!window.dispatchEvent(new Event('convoy-wiki-leave', { cancelable: true })))
                      return;
                    const p = await listPages(projectId, collectionId, true);
                    setLinkPages(p);
                    setMode('settings');
                    setDrawer(false);
                  })
                }
              >
                Collection settings
              </button>
            )}
          </details>
        </nav>
        <div className="wiki-main" aria-busy={busy || loading}>
          {mode === 'edit' ? (
            <WikiEditor
              key={draft?.id ?? 'new'}
              initial={draft}
              collectionId={draft?.collectionId ?? collectionId}
              projectId={projectId}
              pages={linkPages}
              onClose={() => setMode('read')}
              onSaved={(p, published) => {
                setRefresh((n) => n + 1);
                if (published) {
                  setMode('read');
                  navigate({ pageId: p.id });
                }
              }}
            />
          ) : mode === 'settings' || mode === 'create-collection' ? (
            <CollectionSettings
              key={mode + collectionId}
              collection={mode === 'settings' ? collection : undefined}
              pages={mode === 'settings' ? linkPages : []}
              projectId={projectId}
              onDone={(id) => {
                setMode('read');
                setRefresh((n) => n + 1);
                if (id) navigate({ collectionId: id });
              }}
            />
          ) : hits !== null ? (
            <section className="wiki-results">
              <header className="wiki-editbar">
                <h1>Search results</h1>
                <button onClick={() => setHits(null)}>Close search</button>
              </header>
              <p className="wiki-muted">
                {hits.length}
                {moreHits ? '+' : ''} matching sections
              </p>
              {hits.map((h) => (
                <a
                  key={`${h.pageId}:${h.startLine}`}
                  href={wikiHref({
                    projectId,
                    collectionId: h.collectionId,
                    pageId: h.pageId,
                    version: h.version,
                    section: h.anchor,
                  })}
                >
                  <h2>{h.title}</h2>
                  <small>
                    {h.heading || 'Introduction'} · Version {h.version}
                  </small>
                  <p>{h.excerpt}</p>
                </a>
              ))}
              {!hits.length && <p>No matches. Try a different term or search all collections.</p>}
              {moreHits && searchLimit < 20 && (
                <button disabled={busy} onClick={() => void search(20)}>
                  More results
                </button>
              )}
              {moreHits && searchLimit === 20 && (
                <p className="wiki-muted">
                  Showing 20 sections. Refine your search for more specific results.
                </p>
              )}
            </section>
          ) : loading ? (
            <p className="wiki-loading" role="status">
              Loading article…
            </p>
          ) : reading ? (
            <div className="wiki-article-layout">
              <article className="wiki-article">
                <div className="wiki-breadcrumb">
                  <a href={href()}>{collection?.name ?? 'Collection'}</a>
                  <span>/</span>
                  <span>{reading.title}</span>
                </div>
                <header className="wiki-article-header">
                  <h1 id="wiki-title">{reading.title}</h1>
                  <div className="wiki-article-meta">
                    <span>
                      Published{' '}
                      {new Date(reading.publishedAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                      })}
                    </span>
                    <button disabled={busy} onClick={() => void edit(reading.pageId)}>
                      Edit
                    </button>
                    <details className="wiki-page-menu">
                      <summary aria-label="Page actions">
                        <MoreHorizontal size={19} />
                      </summary>
                      <div>
                        <button
                          onClick={() =>
                            void perform(async () => {
                              await copyText(
                                new URL(
                                  href({
                                    pageId: reading.pageId,
                                    version: route.version,
                                    section: route.section,
                                  }),
                                  window.location.href,
                                ).href,
                              );
                            })
                          }
                        >
                          Copy link
                        </button>
                        <label>
                          Revision
                          <input
                            type="number"
                            min={1}
                            max={latest ?? reading.version}
                            value={revision}
                            onChange={(e) => setRevision(Number(e.target.value))}
                          />
                        </label>
                        <button
                          disabled={
                            !Number.isInteger(revision) ||
                            revision < 1 ||
                            revision > (latest ?? reading.version)
                          }
                          onClick={() => navigate({ pageId: reading.pageId, version: revision })}
                        >
                          Read revision
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () => {
                              if (
                                !window.confirm(
                                  'Archive this page? It will no longer be available to readers or agents.',
                                )
                              )
                                return;
                              const r = (
                                await command('readKnowledgePage', {
                                  pageId: reading.pageId,
                                  draft: true,
                                })
                              ).result;
                              if ('draft' in r)
                                await command('setKnowledgePageState', {
                                  pageId: r.id,
                                  expectedRevision: r.revision,
                                  state: 'archived',
                                });
                              setRefresh((n) => n + 1);
                              navigate();
                            })
                          }
                        >
                          Archive page
                        </button>
                      </div>
                    </details>
                  </div>
                </header>
                {!!latest && reading.version < latest && (
                  <p className="wiki-notice">
                    Viewing version {reading.version}.{' '}
                    <a href={href({ pageId: reading.pageId })}>Read the latest version</a>
                  </p>
                )}
                <details className="wiki-mobile-toc">
                  <summary>On this page</summary>
                  {reading.headings
                    .filter((h) => h.heading)
                    .map((h) => (
                      <a
                        key={h.anchor}
                        href={href({
                          pageId: reading.pageId,
                          version: route.version,
                          section: h.anchor,
                        })}
                      >
                        {h.heading}
                      </a>
                    ))}
                </details>
                <WikiMarkdown
                  text={reading.content}
                  location={location}
                  headings={reading.headings}
                />
                {(reading.links.length > 0 || reading.backlinks.length > 0) && (
                  <footer className="wiki-related">
                    {[
                      ['Related pages', reading.links],
                      ['Referenced by', reading.backlinks],
                    ].map(([label, refs]) => (
                      <section key={String(label)}>
                        <h2>{String(label)}</h2>
                        {(refs as KnowledgeRead['links']).map((p) => (
                          <a key={p.pageId} href={wikiHref({ projectId, pageId: p.pageId })}>
                            {p.title}
                            <ArrowUpRight size={14} />
                          </a>
                        ))}
                      </section>
                    ))}
                    {reading.hasMoreBacklinks && <small>Showing the first 20 references.</small>}
                  </footer>
                )}
                <details className="wiki-metadata">
                  <summary>Details</summary>
                  <dl>
                    <dt>Version</dt>
                    <dd>{reading.version}</dd>
                    <dt>Applies to</dt>
                    <dd>{reading.applicability || 'Not specified'}</dd>
                    <dt>Language</dt>
                    <dd>{reading.language}</dd>
                    <dt>Page ID</dt>
                    <dd>{reading.pageId}</dd>
                    <dt>Content hash</dt>
                    <dd>{reading.hash}</dd>
                  </dl>
                </details>
              </article>
              <aside className="wiki-toc" aria-label="On this page">
                <strong>On this page</strong>
                {reading.headings
                  .filter((h) => h.heading)
                  .map((h) => (
                    <a
                      key={h.anchor}
                      href={href({
                        pageId: reading.pageId,
                        version: route.version,
                        section: h.anchor,
                      })}
                    >
                      {h.heading}
                    </a>
                  ))}
              </aside>
            </div>
          ) : route.pageId ? (
            <p className="wiki-loading">
              This page could not be opened. <a href={href()}>Return to overview</a>
            </p>
          ) : (
            <section className="wiki-overview">
              <div className="wiki-eyebrow">
                <BookOpen size={18} />
                KNOWLEDGE BASE
              </div>
              <h1>{collection?.name ?? 'Your project wiki'}</h1>
              {collection?.state === 'archived' && (
                <p className="wiki-notice">This collection is archived.</p>
              )}
              {collection?.description && (
                <p className="wiki-introduction">{collection.description}</p>
              )}
              {startPages.length > 0 && (
                <>
                  <h2>Start here</h2>
                  <div className="wiki-cards">
                    {startPages.map((p) => (
                      <a key={p.id} href={href({ pageId: p.id })}>
                        <BookOpen size={20} />
                        <strong>{p.title}</strong>
                        <ArrowUpRight size={17} />
                      </a>
                    ))}
                  </div>
                </>
              )}
              <h2>{collection ? 'All pages' : 'Collections'}</h2>
              <div className="wiki-page-list">
                {collection
                  ? pages
                      .filter((p) => p.publishedVersion && p.state === 'active')
                      .map((p) => (
                        <a key={p.id} href={href({ pageId: p.id })}>
                          <FileText size={18} />
                          <span>{p.title}</span>
                          <ArrowUpRight size={16} />
                        </a>
                      ))
                  : collections
                      .filter((c) => c.state === 'active')
                      .map((c) => (
                        <a key={c.id} href={href({ collectionId: c.id })}>
                          {c.name}
                        </a>
                      ))}
              </div>
              {!collections.length && (
                <p className="wiki-muted">Create a collection to start your project wiki.</p>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
