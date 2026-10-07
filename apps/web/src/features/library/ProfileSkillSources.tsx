import { useState } from 'react';
import type {
  RuntimeState,
  SkillSelection,
  SkillSnapshot,
} from '../../../../../packages/contracts/src';
import { command } from '../../shared/api/runtime';
import {
  sourceInstance,
  sourceQualifier,
  selectionKey,
  replaceSourceSelection,
} from './skill-model';
import { useSkillCatalogue } from './useSkillCatalogue';

export function ProfileSkillSources({
  state,
  selections,
  onChange,
  browsing,
  disabled,
}: {
  state: RuntimeState;
  selections: SkillSelection[];
  onChange: (value: SkillSelection[]) => void;
  browsing: boolean;
  disabled: boolean;
}) {
  const [runnerId, setRunnerId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [pins, setPins] = useState<SkillSnapshot[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { catalogue, error: catalogueError } = useSkillCatalogue({
    runnerId: runnerId || undefined,
    workspaceId: workspaceId || undefined,
    workingDirectory: workingDirectory || undefined,
    projectId: state.activeContext?.projectId ?? undefined,
    organizationId: state.activeContext?.organizationId,
    userId: state.currentUser?.id,
  });
  const snapshots = [...(state.capabilities?.skillSnapshots ?? []), ...pins];
  const selectedFor = (sourceId: string) =>
    selections.find((selection) =>
      selection.mode === 'source-current'
        ? selection.sourceId === sourceId
        : snapshots.some(
            (snapshot) => snapshot.id === selection.snapshotId && snapshot.sourceId === sourceId,
          ),
    );
  return (
    <div className="profile-skill-sources">
      {(error || catalogueError) && <p role="alert">{error || catalogueError}</p>}
      {browsing && (
        <label>
          Runner
          <select
            aria-label="Profile skill runner"
            value={runnerId}
            disabled={disabled || busy}
            onChange={(event) => {
              setRunnerId(event.target.value);
              setWorkspaceId('');
            }}
          >
            <option value="">All runners</option>
            {state.runners.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {browsing &&
        new Set(
          catalogue.sources.flatMap((source) =>
            source.instances.map((instance) => instance.workspaceId),
          ),
        ).size > 1 && (
          <label>
            Workspace
            <select
              aria-label="Profile skill workspace"
              disabled={disabled || busy}
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
            >
              <option value="">Choose a workspace</option>
              {[
                ...new Map(
                  catalogue.sources
                    .flatMap((source) => source.instances)
                    .map((instance) => [instance.workspaceId, instance]),
                ).values(),
              ].map((instance) => (
                <option key={instance.workspaceId} value={instance.workspaceId}>
                  {instance.path} {instance.repositoryRevision?.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
      {browsing && (
        <details className="profile-tool-details">
          <summary>Source context</summary>
          <label>
            Working directory
            <input
              aria-label="Profile skill working directory"
              placeholder="Repository root"
              value={workingDirectory}
              disabled={disabled || busy}
              onChange={(event) => setWorkingDirectory(event.target.value)}
            />
          </label>
          <p className="muted">
            Relative to the repository. Nested skills apply within their directory.
          </p>
        </details>
      )}
      {catalogue.sources
        .filter((source) => browsing || !!selectedFor(source.id))
        .sort((a, b) => Number(!!selectedFor(b.id)) - Number(!!selectedFor(a.id)))
        .map((source) => {
          const selected = selectedFor(source.id);
          const instance = sourceInstance(source, runnerId || undefined, workspaceId || undefined);
          const sourceRoot = catalogue.roots.find((root) => root.id === source.rootId);
          return (
            <div className="profile-choice" key={source.id}>
              <label className="capability-check">
                <input
                  type="checkbox"
                  disabled={
                    disabled ||
                    busy ||
                    (!selected && (instance?.state !== 'current' || !sourceRoot?.trusted))
                  }
                  checked={!!selected}
                  onChange={(event) =>
                    onChange(
                      replaceSourceSelection(
                        selections,
                        source.id,
                        selected,
                        event.target.checked
                          ? { mode: 'source-current', sourceId: source.id }
                          : undefined,
                      ),
                    )
                  }
                />
                {source.name}
              </label>
              <small className="skill-origin">{sourceQualifier(source, catalogue)}</small>
              {sourceRoot && !sourceRoot.trusted && (
                <small role="status">Trust review required</small>
              )}
              {instance?.state !== 'current' && (
                <small role="status">
                  {instance?.diagnostic ??
                    (instance ? instance.state : 'Choose a runner and workspace')}
                </small>
              )}
              <details>
                <summary>
                  Revision ·{' '}
                  {selected?.mode === 'snapshot-pinned' ? 'Pinned snapshot' : 'Current source'}
                </summary>
                <select
                  aria-label={`Selection mode for ${source.name} ${source.id}`}
                  value={selected?.mode ?? 'source-current'}
                  disabled={!selected || disabled || busy}
                  onChange={async (event) => {
                    if (event.target.value === 'source-current') {
                      onChange(
                        replaceSourceSelection(selections, source.id, selected, {
                          mode: 'source-current',
                          sourceId: source.id,
                        }),
                      );
                      return;
                    }
                    if (!instance) {
                      setError('Choose an unambiguous runner and workspace before pinning.');
                      return;
                    }
                    setBusy(true);
                    setError('');
                    try {
                      const { result } = await command('captureSkillSelections', {
                        selections: [{ mode: 'source-current', sourceId: source.id }],
                        runnerId: instance.runnerId,
                        workspaceId: instance.workspaceId,
                        workingDirectory: workingDirectory || undefined,
                      });
                      const snapshot = result[0];
                      if (!snapshot) throw new Error('No snapshot captured.');
                      setPins((current) => [...current, snapshot]);
                      onChange(
                        replaceSourceSelection(selections, source.id, selected, {
                          mode: 'snapshot-pinned',
                          snapshotId: snapshot.id,
                          digest: snapshot.digest,
                        }),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <option value="source-current">Current at session start</option>
                  <option value="snapshot-pinned">Pin captured snapshot</option>
                </select>
                {selected?.mode === 'snapshot-pinned' && <code>{selected.digest}</code>}
              </details>
            </div>
          );
        })}
      {selections
        .filter((selection) =>
          selection.mode === 'source-current'
            ? !catalogue.sources.some((source) => source.id === selection.sourceId)
            : !catalogue.sources.some((source) => selectedFor(source.id) === selection),
        )
        .map((selection) => (
          <div className="profile-choice" key={selectionKey(selection)}>
            <label className="capability-check">
              <input
                type="checkbox"
                checked
                disabled={disabled || busy}
                onChange={() => onChange(selections.filter((value) => value !== selection))}
              />
              {selection.mode === 'source-current'
                ? selection.sourceId
                : (snapshots.find((snapshot) => snapshot.id === selection.snapshotId)?.name ??
                  selection.snapshotId)}
            </label>
            <small>
              {selection.mode === 'source-current' ? 'Source unavailable' : 'Pinned snapshot'}
            </small>
          </div>
        ))}
    </div>
  );
}
