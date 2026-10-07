import { useEffect, useRef, useState } from 'react';
import { command, RuntimeApiError, type RuntimeState } from '../../shared/api/runtime';
import type {
  SkillFile,
  SkillRevision,
  SkillScope,
  SkillSource,
  SkillSourceInstance,
} from '../../../../../packages/contracts/src';
import { scopeLabel, sourceInstance, sourceQualifier } from './skill-model';
import { useSkillCatalogue } from './useSkillCatalogue';
import { SkillSaveRecovery } from './SkillSaveRecovery';

const example =
  '---\nname: implementation-review\ndescription: Review an implementation against its acceptance criteria.\n---\n\nCheck the requested scope, inspect the changes, and report verification evidence and unresolved risks.\n';
type Draft = {
  files: SkillFile[];
  initial: string;
  source?: SkillSource;
  instance?: SkillSourceInstance;
  stored?: SkillRevision;
  digest?: string;
  writable: boolean;
  rootId: string;
  directory: string;
  imported: boolean;
  requestId: string;
};
function download(name: string, data: BlobPart, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function SkillSettings({ state }: { state: RuntimeState }) {
  const [scope, setScope] = useState<SkillScope | ''>('');
  const [runnerId, setRunnerId] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [filePath, setFilePath] = useState('SKILL.md');
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [comparison, setComparison] = useState<SkillFile[] | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [choosing, setChoosing] = useState<SkillSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const organizationId =
    state.activeContext?.organizationId ?? state.instructionOwners?.organizationId ?? 'personal';
  const {
    catalogue,
    error: catalogueError,
    loading,
    refresh,
  } = useSkillCatalogue({
    scope: scope || undefined,
    runnerId: runnerId || undefined,
    projectId: state.activeContext?.projectId ?? undefined,
    organizationId,
    userId: state.currentUser?.id,
  });
  const roots = catalogue.roots.filter((root) => root.writable);
  const stored = [
    ...new Map(
      [...(state.capabilities?.skills ?? [])]
        .sort((a, b) => a.version - b.version)
        .map((skill) => [`${skill.organizationId ?? organizationId}:${skill.name}`, skill]),
    ).values(),
  ];
  useEffect(() => {
    setDraft(null);
    setChoosing(null);
    setComparison(null);
    setError('');
    setUncertain(false);
  }, [organizationId, state.currentUser?.id, state.activeContext?.projectId]);
  const dirty =
    !!draft &&
    JSON.stringify({ files: draft.files, rootId: draft.rootId, directory: draft.directory }) !==
      draft.initial;
  const file = draft?.files.find((value) => value.path === filePath);
  const root = catalogue.roots.find(
    (value) => value.id === (draft?.source?.rootId ?? draft?.rootId),
  );
  const observed = draft?.source
    ? catalogue.sources
        .find((source) => source.id === draft.source?.id)
        ?.instances.find((instance) => instance.id === draft.instance?.id)
    : undefined;
  const changed = !!draft?.digest && !!observed?.digest && observed.digest !== draft.digest;
  const mayDiscard = () => !dirty || confirm('Discard unsaved skill changes?');
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: Event) => {
      if (busy || !confirm('Discard unsaved skill changes?')) event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('convoy-agents-leave', leave);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('convoy-agents-leave', leave);
      window.removeEventListener('beforeunload', unload);
    };
  }, [dirty, busy]);
  function begin(files: SkillFile[], extra: Partial<Draft> = {}) {
    const value: Draft = {
      files,
      initial: '',
      writable: true,
      rootId: roots[0]?.id ?? '',
      directory: '',
      imported: false,
      requestId: crypto.randomUUID(),
      ...extra,
    };
    value.initial =
      extra.initial ??
      JSON.stringify({ files: value.files, rootId: value.rootId, directory: value.directory });
    setDraft(value);
    setFilePath('SKILL.md');
    setTrusted(false);
    setError('');
    setComparison(null);
    setUncertain(false);
    setChoosing(null);
  }
  async function openSource(source: SkillSource, instance?: SkillSourceInstance) {
    if (busy || !mayDiscard()) return;
    const selected = instance ?? sourceInstance(source, runnerId || undefined);
    if (!selected) {
      setChoosing(source);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { result } = await command('readSkillSource', {
        sourceId: source.id,
        runnerId: selected.runnerId,
        workspaceId: selected.workspaceId,
      });
      begin(result.files, {
        source: result.source,
        instance: result.instance,
        digest: result.digest,
        writable: result.writable,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function openStored(skill: SkillRevision) {
    if (busy || !mayDiscard()) return;
    setBusy(true);
    setError('');
    try {
      const { result } = await command('exportSkill', {
        name: skill.name,
        version: skill.version,
        organizationId: skill.organizationId ?? organizationId,
      });
      begin(
        Object.entries(result.files).map(([path, content]) => ({
          path,
          encoding: 'utf8',
          content,
        })),
        { stored: skill, writable: false },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length || busy || !mayDiscard()) return;
    setBusy(true);
    setError('');
    try {
      const selected = Array.from(list);
      if (selected.length > 50 || selected.reduce((size, item) => size + item.size, 0) > 200000)
        throw new Error('Choose at most 50 files and 200 KB.');
      let files: SkillFile[] = [];
      if (selected.length === 1 && selected[0].name.endsWith('.json')) {
        const bundle = JSON.parse(await selected[0].text());
        files = Array.isArray(bundle.files)
          ? bundle.files
          : Object.entries(bundle.files ?? {}).map(([path, content]) => ({
              path,
              encoding: 'utf8',
              content: String(content),
            }));
      } else {
        for (const item of selected) {
          const bytes = new Uint8Array(await item.arrayBuffer());
          const path = item.webkitRelativePath
            ? item.webkitRelativePath.split('/').slice(1).join('/')
            : item.name;
          let content: string;
          let encoding: SkillFile['encoding'];
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (content.includes('\0')) throw new Error();
            encoding = 'utf8';
          } catch {
            content = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
            encoding = 'base64';
          }
          files.push({ path, encoding, content });
        }
      }
      if (!files.some((value) => value.path === 'SKILL.md' && value.encoding === 'utf8'))
        throw new Error('Choose a skill folder containing SKILL.md.');
      begin(files, {
        imported: true,
        initial: '',
        directory: selected[0].webkitRelativePath?.split('/')[0] ?? '',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!draft || busy || uncertain) return;
    setBusy(true);
    setError('');
    try {
      if (draft.source && draft.instance) {
        await command('saveSkillSource', {
          sourceId: draft.source.id,
          runnerId: draft.instance.runnerId,
          workspaceId: draft.instance.workspaceId,
          expectedDigest: draft.digest!,
          files: draft.files,
          requestId: draft.requestId,
        });
      } else if (draft.stored) {
        await command('saveStoredSkillToFolder', {
          name: draft.stored.name,
          version: draft.stored.version,
          rootId: draft.rootId,
          relativeDirectory: draft.directory,
          trusted: true,
          requestId: draft.requestId,
        });
      } else {
        await command('createSkillSource', {
          rootId: draft.rootId,
          relativeDirectory: draft.directory,
          files: draft.files,
          trusted: true,
          requestId: draft.requestId,
        });
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      if (
        (e instanceof RuntimeApiError && e.code === 'UNCERTAIN') ||
        /uncertain|inspection required/i.test((e as Error).message)
      )
        setUncertain(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const matches = (name: string, description: string) =>
    `${name} ${description}`.toLowerCase().includes(query.toLowerCase());
  const canInstall = !!draft?.rootId && !!draft.directory && trusted;
  return (
    <section className="skill-settings" aria-label="Skills">
      {(error || catalogueError) && <p role="alert">{error || catalogueError}</p>}
      <input
        ref={fileInput}
        aria-label="Import skill files"
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void importFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        aria-label="Import skill folder"
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(event) => {
          void importFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {!draft ? (
        <>
          <div className="library-toolbar">
            <input
              className="capability-search"
              aria-label="Find skills"
              placeholder="Find skills…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Skill scope"
              value={scope}
              onChange={(event) => setScope(event.target.value as SkillScope | '')}
            >
              <option value="">All scopes</option>
              {(['personal', 'project', 'organization'] as const).map((value) => (
                <option key={value} value={value}>
                  {scopeLabel(value)}
                </option>
              ))}
            </select>
            <select
              aria-label="Skill runner"
              value={runnerId}
              onChange={(event) => setRunnerId(event.target.value)}
            >
              <option value="">All runners</option>
              {state.runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                </option>
              ))}
            </select>
            <div className="skill-create-actions">
              <button
                className="primary"
                disabled={busy || !roots.length}
                onClick={() => begin([{ path: 'SKILL.md', encoding: 'utf8', content: example }])}
              >
                New skill
              </button>
              <details className="skill-actions">
                <summary aria-label="More skill actions">•••</summary>
                <div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !roots.length}
                    onClick={() => fileInput.current?.click()}
                  >
                    Import files
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !roots.length}
                    onClick={() => folderInput.current?.click()}
                  >
                    Import folder
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void refresh().catch((e) => setError(e.message))}
                  >
                    Refresh
                  </button>
                </div>
              </details>
            </div>
          </div>
          {choosing && (
            <div
              className="skill-instance-picker"
              role="group"
              aria-label={`Workspace for ${choosing.name}`}
            >
              <strong>Choose a workspace</strong>
              {choosing.instances.map((instance) => (
                <button
                  type="button"
                  className="secondary"
                  key={instance.id}
                  onClick={() => void openSource(choosing, instance)}
                >
                  {state.runners.find((value) => value.id === instance.runnerId)?.name ??
                    instance.runnerId}{' '}
                  · {instance.path}
                  {instance.repositoryRevision && ` · ${instance.repositoryRevision.slice(0, 8)}`}
                </button>
              ))}
              <button type="button" className="secondary" onClick={() => setChoosing(null)}>
                Cancel
              </button>
            </div>
          )}
          {catalogue.roots
            .filter((root) => !catalogue.sources.some((source) => source.rootId === root.id))
            .flatMap((root) =>
              (root.diagnostics ?? [])
                .filter((diagnostic) => diagnostic.state !== 'current')
                .map((diagnostic) => (
                  <p
                    role="status"
                    className="skill-root-diagnostic"
                    key={`${root.id}:${diagnostic.runnerId}:${diagnostic.workspaceId}`}
                  >
                    {scopeLabel(root.scope)} · {root.path}: {diagnostic.message ?? diagnostic.state}
                  </p>
                )),
            )}
          <div className="skill-rows">
            {catalogue.sources
              .filter((source) => matches(source.name, source.description))
              .map((source) => {
                const instance = sourceInstance(source, runnerId || undefined);
                const duplicate =
                  catalogue.sources.filter((value) => value.name === source.name).length > 1;
                return (
                  <article className="skill-row" key={source.id}>
                    <button
                      type="button"
                      className="skill-row-open"
                      disabled={busy}
                      onClick={() => void openSource(source)}
                    >
                      <span>
                        <strong>{source.name}</strong>
                        <span className="library-description">{source.description}</span>
                        {duplicate && (
                          <small className="skill-origin">
                            {sourceQualifier(source, catalogue)}
                          </small>
                        )}
                        {instance && instance.state !== 'current' && (
                          <small role="status">
                            {instance.diagnostic ?? scopeLabel(instance.state)}
                          </small>
                        )}
                      </span>
                      <span className="skill-scope">{scopeLabel(source.scope)}</span>
                    </button>
                    <details className="skill-actions">
                      <summary aria-label={`Source for ${source.name}`}>•••</summary>
                      <div>
                        {source.instances.map((value) => (
                          <p key={value.id}>
                            {value.path} · {value.state}
                            {value.diagnostic && ` · ${value.diagnostic}`}
                          </p>
                        ))}
                      </div>
                    </details>
                  </article>
                );
              })}
            {(!scope || scope === 'organization') &&
              !runnerId &&
              stored
                .filter((skill) => matches(skill.name, skill.description))
                .map((skill) => (
                  <article
                    className="skill-row"
                    key={`stored:${skill.organizationId}:${skill.name}`}
                  >
                    <button
                      type="button"
                      className="skill-row-open"
                      disabled={busy}
                      onClick={() => void openStored(skill)}
                    >
                      <span>
                        <strong>{skill.name}</strong>
                        <span className="library-description">{skill.description}</span>
                        <small className="skill-origin">Stored bundle</small>
                      </span>
                      <span className="skill-scope">Organization</span>
                    </button>
                  </article>
                ))}
          </div>
          {loading && <p role="status">Loading skills…</p>}
          {!loading && !catalogue.sources.length && !stored.length && <p>No skills yet.</p>}
          {!roots.length && !loading && (
            <p className="muted">
              Register a writable skill directory in Environments to create or import skills.
            </p>
          )}
        </>
      ) : (
        <form
          className="capability-editor skill-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <header className="library-editor-heading">
            <strong>{draft.source?.name ?? draft.stored?.name ?? 'New skill'}</strong>
            <span className="skill-scope">
              {scopeLabel(
                draft.source?.scope ??
                  (draft.stored ? 'organization' : (root?.scope ?? 'personal')),
              )}
            </span>
            <span className="profile-draft-status" role="status">
              {dirty ? 'Unsaved changes' : ''}
            </span>
          </header>
          {!draft.source && (
            <div className="skill-destination">
              <label>
                Save to
                <select
                  aria-label="Skill destination"
                  required
                  value={draft.rootId}
                  disabled={busy || uncertain}
                  onChange={(event) => setDraft({ ...draft, rootId: event.target.value })}
                >
                  <option value="">Choose a directory</option>
                  {roots.map((value) => (
                    <option key={value.id} value={value.id}>
                      {scopeLabel(value.scope)} · {value.path} ·{' '}
                      {state.runners.find((runner) => runner.id === value.runnerId)?.name ??
                        value.runnerId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Folder
                <input
                  aria-label="Skill folder name"
                  required
                  pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
                  value={draft.directory}
                  disabled={busy || uncertain}
                  onChange={(event) => setDraft({ ...draft, directory: event.target.value })}
                />
              </label>
            </div>
          )}
          {uncertain && (
            <SkillSaveRecovery
              target={{
                ...(draft.source
                  ? { sourceId: draft.source.id }
                  : { rootId: draft.rootId, relativeDirectory: draft.directory }),
                runnerId: draft.instance?.runnerId,
                workspaceId: draft.instance?.workspaceId,
              }}
              disabled={busy}
              onError={setError}
              onResolved={() => {
                setUncertain(false);
                setDraft({ ...draft, requestId: crypto.randomUUID() });
                setError('Save reconciled. Reload the source before saving again.');
                void refresh().catch((e) => setError(e.message));
              }}
            />
          )}
          {(changed || (observed?.state && observed.state !== 'current')) && (
            <div className="skill-revision-notice" role="status">
              <span>
                {observed?.state !== 'current'
                  ? (observed?.diagnostic ?? 'Source unavailable.')
                  : 'Source files changed.'}
              </span>
              <button
                type="button"
                className="secondary"
                disabled={busy || uncertain}
                onClick={() => draft.source && void openSource(draft.source, draft.instance)}
              >
                Reload latest
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  if (!draft.source || !draft.instance) return;
                  setBusy(true);
                  try {
                    const { result } = await command('readSkillSource', {
                      sourceId: draft.source.id,
                      runnerId: draft.instance.runnerId,
                      workspaceId: draft.instance.workspaceId,
                    });
                    setComparison(result.files);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Compare
              </button>
            </div>
          )}
          {file?.encoding === 'utf8' ? (
            <label>
              {filePath}
              <textarea
                aria-label={filePath === 'SKILL.md' ? 'Skill source' : `File ${filePath}`}
                rows={16}
                value={file.content}
                readOnly={!draft.writable || !!draft.stored}
                disabled={busy}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    files: draft.files.map((value) =>
                      value.path === filePath ? { ...value, content: event.target.value } : value,
                    ),
                    requestId: uncertain ? draft.requestId : crypto.randomUUID(),
                  });
                  setError('');
                }}
              />
            </label>
          ) : (
            <div>
              <p>{filePath} · Binary resource</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (!file) return;
                  const bytes = Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0));
                  download(file.path.split('/').at(-1)!, bytes, 'application/octet-stream');
                }}
              >
                Download resource
              </button>
            </div>
          )}
          {comparison && (
            <details open className="profile-section">
              <summary>Current source files</summary>
              <textarea
                aria-label="Current source comparison"
                rows={12}
                readOnly
                value={
                  comparison.find((value) => value.path === filePath && value.encoding === 'utf8')
                    ?.content ?? 'Resource removed or binary.'
                }
              />
            </details>
          )}
          <details className="profile-section">
            <summary>
              Files <span>{draft.files.length}</span>
            </summary>
            <div className="skill-file-list">
              {draft.files.map((value) => (
                <button
                  type="button"
                  key={value.path}
                  className="secondary"
                  aria-pressed={value.path === filePath}
                  disabled={busy}
                  onClick={() => setFilePath(value.path)}
                >
                  {value.path}
                  {value.encoding === 'base64' ? ' · Binary' : ''}
                </button>
              ))}
            </div>
            {draft.writable && !draft.stored && (
              <div className="skill-file-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || uncertain}
                  onClick={() => {
                    const path = prompt(
                      'New text file path, relative to this skill folder:',
                    )?.trim();
                    if (!path) return;
                    if (
                      path.startsWith('/') ||
                      path.split('/').some((part) => !part || part === '..' || part === '.') ||
                      path.includes('\\') ||
                      draft.files.some((value) => value.path === path)
                    ) {
                      setError('Choose a new relative file path inside this skill folder.');
                      return;
                    }
                    setDraft({
                      ...draft,
                      files: [...draft.files, { path, encoding: 'utf8', content: '' }],
                      requestId: crypto.randomUUID(),
                    });
                    setFilePath(path);
                    setError('');
                  }}
                >
                  Add file
                </button>
                {filePath !== 'SKILL.md' && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || uncertain}
                    onClick={() => {
                      if (!confirm(`Remove ${filePath} from this skill when you save?`)) return;
                      setDraft({
                        ...draft,
                        files: draft.files.filter((value) => value.path !== filePath),
                        requestId: crypto.randomUUID(),
                      });
                      setFilePath('SKILL.md');
                    }}
                  >
                    Remove file
                  </button>
                )}
              </div>
            )}
          </details>
          <details className="profile-section">
            <summary>Source</summary>
            <div>
              {root && !root.trusted && (
                <p role="alert">This directory requires trust review before skills can be used.</p>
              )}
              {(observed?.warnings ?? draft.instance?.warnings ?? []).map((warning) => (
                <p role="alert" key={warning}>
                  {warning}
                </p>
              ))}
              <dl className="skill-source-facts">
                <div>
                  <dt>Origin</dt>
                  <dd>{draft.stored ? 'Stored bundle' : (root?.provenance ?? 'Filesystem')}</dd>
                </div>
                {draft.source?.provisionedFrom && (
                  <>
                    <div>
                      <dt>Installed from snapshot</dt>
                      <dd>{draft.source.provisionedFrom.snapshotId}</dd>
                    </div>
                    <div>
                      <dt>Origin runner</dt>
                      <dd>
                        {state.runners.find(
                          (value) => value.id === draft.source?.provisionedFrom?.runnerId,
                        )?.name ?? draft.source.provisionedFrom.runnerId}
                      </dd>
                    </div>
                  </>
                )}
                {draft.instance && (
                  <>
                    <div>
                      <dt>Runner</dt>
                      <dd>
                        {state.runners.find((value) => value.id === draft.instance?.runnerId)
                          ?.name ?? draft.instance.runnerId}
                      </dd>
                    </div>
                    <div>
                      <dt>Path</dt>
                      <dd>{draft.instance.path}</dd>
                    </div>
                    {draft.instance.repositoryRevision && (
                      <div>
                        <dt>Repository revision</dt>
                        <dd>{draft.instance.repositoryRevision}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Availability</dt>
                      <dd>
                        {observed?.state ?? draft.instance.state}
                        {observed?.diagnostic && ` · ${observed.diagnostic}`}
                      </dd>
                    </div>
                  </>
                )}
                {draft.stored && (
                  <div>
                    <dt>Imported from</dt>
                    <dd>{draft.stored.source}</dd>
                  </div>
                )}
              </dl>
              {draft.source?.provisionedFrom && (
                <details>
                  <summary>Installed snapshot fingerprint</summary>
                  <code>{draft.source.provisionedFrom.digest}</code>
                </details>
              )}
              {draft.source?.provisionedFrom && (
                <p className="muted">
                  Independent copy. Changes to the original source are not synchronized.
                </p>
              )}
              {!draft.writable && !draft.stored && (
                <p>Read-only source. Copy to a writable directory to edit.</p>
              )}
              {draft.stored && (
                <p>
                  Saving to a folder preserves the stored revision and existing profile selections.
                </p>
              )}
              <details>
                <summary>Fingerprint</summary>
                <code>{draft.digest ?? draft.stored?.hash ?? 'Not saved'}</code>
              </details>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  download(
                    `${draft.source?.name ?? draft.stored?.name ?? 'skill'}.json`,
                    JSON.stringify({ files: draft.files }, null, 2),
                  )
                }
              >
                Export bundle
              </button>
              {draft.source && !draft.writable && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!roots.length || busy}
                  onClick={() =>
                    begin(draft.files, {
                      imported: true,
                      initial: '',
                      directory: draft.source!.relativeDirectory,
                    })
                  }
                >
                  Copy to folder
                </button>
              )}
            </div>
          </details>
          {!draft.source && (
            <label className="capability-check">
              <input
                type="checkbox"
                checked={trusted}
                disabled={busy}
                onChange={(event) => setTrusted(event.target.checked)}
              />
              I reviewed these instructions and files.
            </label>
          )}
          <footer className="profile-save-bar">
            <button
              className="primary"
              disabled={
                busy ||
                uncertain ||
                (draft.source
                  ? !draft.writable || !dirty || (!!observed && observed.state !== 'current')
                  : !canInstall)
              }
            >
              {draft.stored ? 'Save to folder' : 'Save skill'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (mayDiscard()) {
                  setDraft(null);
                  setError('');
                }
              }}
            >
              {draft.writable ? 'Cancel' : 'Close'}
            </button>
          </footer>
        </form>
      )}
    </section>
  );
}
