import { useEffect, useState } from 'react';
import {
  command,
  RuntimeApiError,
  type RuntimeState,
  type RuntimeCommandInputMap,
} from '../../shared/api/runtime';
import type { SkillCatalogue, SkillScope, SkillRoot } from '../../../../../packages/contracts/src';
import './skill-directories.css';
import { SkillSaveRecovery } from '../library';

export function SkillDirectories({ state }: { state: RuntimeState }) {
  const [catalogue, setCatalogue] = useState<SkillCatalogue>({ roots: [], sources: [] });
  const [scope, setScope] = useState<SkillScope>('personal');
  const [runnerId, setRunnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionId, setProvisionId] = useState(() => crypto.randomUUID());
  const [recoveryTarget, setRecoveryTarget] = useState<
    RuntimeCommandInputMap['inspectSkillMutation'] | null
  >(null);
  const organizationId = state.activeContext?.organizationId;
  const canManage = state.memberships?.some(
    (membership) =>
      membership.organizationId === organizationId &&
      membership.scope.kind === 'organization' &&
      membership.state === 'active' &&
      membership.principal.kind === 'user' &&
      membership.principal.userId === state.currentUser?.id &&
      membership.roles.some((role) => ['owner', 'admin'].includes(role)),
  );
  async function refresh() {
    const { result } = await command('catalogueSkills', {});
    setCatalogue(result);
  }
  async function updatePolicy(
    root: SkillRoot,
    change: Pick<RuntimeCommandInputMap['updateSkillRoot'], 'readable' | 'writable' | 'trusted'>,
  ) {
    setBusy(true);
    setError('');
    try {
      await command('updateSkillRoot', {
        rootId: root.id,
        expectedRevision: root.revision,
        ...change,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setCatalogue({ roots: [], sources: [] });
    void refresh().catch((e) => setError(e.message));
  }, [organizationId, state.activeContext?.userId]);
  return (
    <section className="skill-directories" aria-label="Skill directories">
      <h2>Skill directories</h2>
      {error && <p role="alert">{error}</p>}
      <div className="skill-directory-actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => setAdding(!adding)}
        >
          {adding ? 'Cancel' : 'Register directory'}
        </button>
        {catalogue.roots.some((root) => root.writable) &&
          !!state.capabilities?.skillSnapshots?.length && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => {
                setProvisioning(!provisioning);
                setProvisionId(crypto.randomUUID());
                setRecoveryTarget(null);
              }}
            >
              Copy snapshot to runner
            </button>
          )}
      </div>
      {adding && (
        <form
          className="runtime-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError('');
            try {
              await command('registerSkillRoot', {
                scope,
                runnerId,
                path: String(form.get('path')),
                executionIdentity: String(form.get('executionIdentity')),
                projectId: scope === 'project' ? String(form.get('projectId')) : undefined,
                writable: form.get('writable') === 'on',
                relevancePath: String(form.get('relevanceDirectory') || '') || undefined,
                trusted: form.get('trusted') === 'on',
              });
              setAdding(false);
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Scope
            <select
              aria-label="Directory scope"
              value={scope}
              disabled={busy}
              onChange={(event) => setScope(event.target.value as SkillScope)}
            >
              <option value="personal">Personal</option>
              <option value="project">Project</option>
              {canManage && <option value="organization">Organization</option>}
            </select>
          </label>
          <label>
            Runner
            <select
              aria-label="Directory runner"
              required
              value={runnerId}
              disabled={busy}
              onChange={(event) => setRunnerId(event.target.value)}
            >
              <option value="">Choose a runner</option>
              {state.runners.map((runner) => (
                <option key={runner.id} value={runner.id}>
                  {runner.name}
                </option>
              ))}
            </select>
          </label>
          {scope === 'project' && (
            <label>
              Project
              <select name="projectId" required disabled={busy}>
                <option value="">Choose a project</option>
                {state.projects
                  .filter((project) =>
                    state.runners
                      .find((runner) => runner.id === runnerId)
                      ?.projectIds.includes(project.id),
                  )
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Directory
            <input
              name="path"
              aria-label="Skill directory path"
              placeholder={
                scope === 'project' ? '/repository/.agents/skills' : '/home/user/.agents/skills'
              }
              required
              disabled={busy}
            />
          </label>
          <label>
            Execution identity
            <input name="executionIdentity" required disabled={busy} />
          </label>
          <p className="muted">
            The runner must authorize this identity and directory. Personal directories belong to
            your signed-in Convoy user.
          </p>
          <label className="skill-directory-check">
            <input name="writable" type="checkbox" disabled={busy} />
            Allow editing
          </label>
          <label className="skill-directory-check">
            <input name="trusted" type="checkbox" required disabled={busy} />I trust skills in this
            directory for this execution identity.
          </label>
          {scope === 'project' && (
            <details>
              <summary>Directory relevance</summary>
              <label>
                Applies below
                <input name="relevanceDirectory" placeholder="Repository root" disabled={busy} />
              </label>
            </details>
          )}
          <button className="primary" disabled={busy}>
            Register directory
          </button>
        </form>
      )}
      <div className="skill-directory-list">
        {catalogue.roots.map((root) => (
          <details key={root.id}>
            <summary>
              {root.scope[0].toUpperCase() + root.scope.slice(1)} · {root.path}
            </summary>
            <dl>
              <div>
                <dt>Runner</dt>
                <dd>
                  {state.runners.find((runner) => runner.id === root.runnerId)?.name ??
                    root.runnerId}
                </dd>
              </div>
              <div>
                <dt>Execution identity</dt>
                <dd>{root.executionIdentity}</dd>
              </div>
              <div>
                <dt>Access</dt>
                <dd>
                  {!root.readable
                    ? 'Reads disabled'
                    : root.writable
                      ? 'Read and write'
                      : 'Read only'}
                </dd>
              </div>
              {root.projectId && (
                <div>
                  <dt>Project</dt>
                  <dd>
                    {state.projects.find((project) => project.id === root.projectId)?.name ??
                      root.projectId}
                  </dd>
                </div>
              )}
            </dl>
            {root.manageable && (
              <details className="skill-directory-policy">
                <summary>Access policy</summary>
                <div className="skill-directory-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        root.trusted ||
                        confirm(
                          `Trust the reviewed instructions and resources in ${root.path} for ${root.executionIdentity}?`,
                        )
                      )
                        void updatePolicy(root, { trusted: !root.trusted });
                    }}
                  >
                    {root.trusted ? 'Revoke trust' : 'Review and trust'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (
                        !root.readable ||
                        confirm(
                          'Disable reads from this directory? New captures and use of its existing snapshots will be blocked.',
                        )
                      )
                        void updatePolicy(root, { readable: !root.readable });
                    }}
                  >
                    {root.readable ? 'Disable reads' : 'Enable reads'}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void updatePolicy(root, { writable: !root.writable })}
                  >
                    {root.writable ? 'Make read-only' : 'Allow editing'}
                  </button>
                </div>
              </details>
            )}
            {root.manageable && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={async () => {
                  if (
                    !confirm(
                      'Unregister this skill directory? Files and captured snapshots are preserved.',
                    )
                  )
                    return;
                  setBusy(true);
                  setError('');
                  try {
                    await command('unregisterSkillRoot', {
                      rootId: root.id,
                      expectedRevision: root.revision,
                    });
                    await refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Unregister directory
              </button>
            )}
          </details>
        ))}
      </div>
      {recoveryTarget && (
        <SkillSaveRecovery
          target={recoveryTarget}
          disabled={busy}
          onError={setError}
          onResolved={() => {
            setRecoveryTarget(null);
            setProvisionId(crypto.randomUUID());
            setError('Copy reconciled. Inspect the destination before another copy.');
            void refresh().catch((e) => setError(e.message));
          }}
        />
      )}
      {provisioning && (
        <form
          className="runtime-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError('');
            try {
              await command('provisionSkillSnapshot', {
                snapshotId: String(form.get('snapshotId')),
                targetRootId: String(form.get('rootId')),
                relativeDirectory: String(form.get('directory')),
                trusted: true,
                requestId: provisionId,
              });
              setProvisioning(false);
              await refresh();
            } catch (e) {
              if (
                (e instanceof RuntimeApiError && e.code === 'UNCERTAIN') ||
                /uncertain|inspection required/i.test((e as Error).message)
              )
                setRecoveryTarget({
                  rootId: String(form.get('rootId')),
                  relativeDirectory: String(form.get('directory')),
                });
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Snapshot
            <select name="snapshotId" required disabled={busy || !!recoveryTarget}>
              {state.capabilities?.skillSnapshots?.map((snapshot) => (
                <option key={snapshot.id} value={snapshot.id}>
                  {snapshot.name} · {snapshot.digest.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination
            <select name="rootId" required disabled={busy || !!recoveryTarget}>
              {catalogue.roots
                .filter((root) => root.writable)
                .map((root) => (
                  <option key={root.id} value={root.id}>
                    {state.runners.find((runner) => runner.id === root.runnerId)?.name ??
                      root.runnerId}{' '}
                    · {root.path}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Folder
            <input
              name="directory"
              required
              pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*"
              disabled={busy || !!recoveryTarget}
            />
          </label>
          <label className="skill-directory-check">
            <input type="checkbox" required disabled={busy || !!recoveryTarget} />I reviewed this
            snapshot and its destination.
          </label>
          <p className="muted">
            Creates an independent folder on the destination runner. Later source edits are not
            copied automatically.
          </p>
          <button className="primary" disabled={busy || !!recoveryTarget}>
            Copy snapshot
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy || !!recoveryTarget}
            onClick={() => setProvisioning(false)}
          >
            Cancel
          </button>
        </form>
      )}
    </section>
  );
}
