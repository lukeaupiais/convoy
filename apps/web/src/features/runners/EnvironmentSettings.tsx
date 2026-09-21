import { useState } from 'react';
import { command, type RuntimeAction } from '../../shared/api/runtime';
import type { Environment, RuntimeState } from '../../shared/api/runtime';
const split = (v: FormDataEntryValue | null) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export function EnvironmentSettings({ state }: { state: RuntimeState }) {
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  async function act(action: RuntimeAction, input: object) {
    setWorking(true);
    setMessage('');
    try {
      await command(action, input);
      setMessage('Configuration saved.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="environment-settings">
      <p className="muted">
        Run agents locally or on your SSH hosts. Provider credentials stay here.
      </p>
      {message && <p role="status">{message}</p>}
      <details className="runtime-details">
        <summary>Connect a remote workspace</summary>
        <form
          className="runtime-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act('connectRemote', {
              host: f.get('host'),
              repository: f.get('repository'),
              projectIds: f.getAll('projectId'),
            });
          }}
        >
          <label>
            SSH host
            <input name="host" placeholder="build-server" required />
          </label>
          <label>
            Repository
            <input name="repository" placeholder="/srv/projects/my-project" required />
          </label>
          <fieldset>
            <legend>Projects</legend>
            {state.projects.map((p) => (
              <label key={p.id}>
                <input name="projectId" type="checkbox" value={p.id} />
                {p.name}
              </label>
            ))}
          </fieldset>
          <p className="muted">
            Copies a self-contained worker to your user directory. No Node, npm or root access
            needed. Linux x64 / ARM64; contained shell tools require Bubblewrap. You can opt a
            registered runner into trusted host execution afterward.
          </p>
          <button className="primary" disabled={working}>
            {working ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </details>
      <h2>Environments</h2>
      <details className="runtime-details">
        <summary>Add environment</summary>
        <EnvironmentForm act={act} working={working} />
      </details>
      {state.environments.map((e) => (
        <details key={e.id} className="runtime-details">
          <summary>
            {e.name} · {e.kind} · {e.load}/{e.maxConcurrent} occupied{!e.enabled && ' · disabled'}
          </summary>
          <EnvironmentForm key={e.revision} value={e} act={act} working={working} />
          <small>Environment ID: {e.id}</small>
        </details>
      ))}
      <h2>Repository runners</h2>
      <details className="runtime-details">
        <summary>Register runner</summary>
        <form
          className="runtime-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act('registerRunner', {
              name: f.get('name'),
              environmentId: f.get('environmentId'),
              repository: f.get('repository'),
              projectIds: f.getAll('projectId'),
              accessMode: f.get('accessMode'),
            });
          }}
        >
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Environment
            <select name="environmentId" required>
              <option value="">Select environment</option>
              {state.environments.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repository absolute path
            <input name="repository" required placeholder="/srv/projects/my-project" />
          </label>
          <label>
            Execution access
            <select name="accessMode" defaultValue="contained">
              <option value="contained">Contained workspace</option>
              <option value="trusted">Trusted host execution</option>
            </select>
          </label>
          <p className="muted">
            This is the runner's maximum authority. A trusted runner can still enforce sandboxed
            project profiles; host profiles are eligible only on trusted runners.
          </p>
          <fieldset>
            <legend>Allowed projects</legend>
            {state.projects.map((p) => (
              <label key={p.id}>
                <input type="checkbox" name="projectId" value={p.id} />
                {p.name}
              </label>
            ))}
          </fieldset>
          <button className="primary" disabled={working}>
            Probe & register
          </button>
        </form>
      </details>
      {state.runners.map((r) => (
        <details key={r.id} className="runtime-details">
          <summary>
            {r.name} · {state.environments.find((e) => e.id === r.environmentId)?.name} · {r.load}/
            {r.maxConcurrent} occupied · {r.online ? 'last probe OK' : 'offline'}
          </summary>
          <p>
            {r.repository} · {r.accessMode} maximum authority · {r.capabilities.tools.join(', ')}
          </p>
          <p>Last probe: {new Date(r.checkedAt).toLocaleString()}</p>
          <button
            className="secondary"
            disabled={working}
            onClick={() => act('probeRunner', { runnerId: r.id })}
          >
            Refresh health
          </button>
          <form
            className="runtime-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act('updateRunner', {
                runnerId: r.id,
                revision: r.revision,
                name: f.get('name'),
                maxConcurrent: Number(f.get('capacity')),
                tags: split(f.get('tags')),
                projectIds: f.getAll('projectId'),
                accessMode: f.get('accessMode'),
                enabled: f.get('enabled') === 'on',
              });
            }}
          >
            <label>
              Name
              <input name="name" defaultValue={r.name} required />
            </label>
            <label>
              Concurrent executions
              <input
                name="capacity"
                type="number"
                min={1}
                max={32}
                defaultValue={r.maxConcurrent}
              />
            </label>
            <label>
              Labels
              <input name="tags" defaultValue={r.tags.join(',')} />
            </label>
            <label>
              Execution access
              <select name="accessMode" defaultValue={r.accessMode ?? 'contained'}>
                <option value="contained">Contained workspace</option>
                <option value="trusted">Trusted host execution</option>
              </select>
            </label>
            {r.accessMode === 'trusted' && (
              <p className="muted">
                Host-access profiles may use this runner's filesystem and network. Sandboxed
                profiles continue to use containment.
              </p>
            )}
            <label>
              <input name="enabled" type="checkbox" defaultChecked={r.enabled} />
              Allow new assignments
            </label>
            <fieldset>
              <legend>Allowed projects</legend>
              {state.projects.map((p) => (
                <label key={p.id}>
                  <input
                    name="projectId"
                    type="checkbox"
                    value={p.id}
                    defaultChecked={r.projectIds.includes(p.id)}
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
            <button className="secondary" disabled={working}>
              Save runner
            </button>
          </form>
          <small>Runner ID: {r.id}</small>
        </details>
      ))}
      <h2>Runner pools</h2>
      {[undefined, ...state.runnerPools].map((p) => (
        <details key={p?.id ?? 'new'} className="runtime-details">
          <summary>{p ? `${p.name} · ${p.runnerIds.length} runners` : 'Create pool'}</summary>
          <form
            className="runtime-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act('saveRunnerPool', {
                id: p?.id,
                revision: p?.revision,
                name: f.get('name'),
                runnerIds: f.getAll('runnerId'),
              });
            }}
          >
            <label>
              Pool name
              <input name="name" required defaultValue={p?.name} />
            </label>
            <fieldset>
              <legend>Eligible runners (listed in priority order)</legend>
              {state.runners.map((r) => (
                <label key={r.id}>
                  <input
                    name="runnerId"
                    type="checkbox"
                    value={r.id}
                    defaultChecked={p?.runnerIds.includes(r.id)}
                  />
                  {r.name} · {state.environments.find((e) => e.id === r.environmentId)?.name}
                </label>
              ))}
            </fieldset>
            <button className="primary" disabled={working}>
              Save pool
            </button>
          </form>
        </details>
      ))}
      <h2>Global capacity</h2>
      <form
        className="runtime-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('setScheduler', {
            maxConcurrent: Number(new FormData(e.currentTarget).get('capacity')),
          });
        }}
      >
        <label>
          Maximum parallel executions
          <input
            name="capacity"
            type="number"
            min={1}
            max={32}
            defaultValue={state.scheduler.maxConcurrent}
          />
        </label>
        <button className="secondary" disabled={working}>
          Save capacity
        </button>
      </form>
      <p className="muted">
        Load means assigned executions, including approval waits and unresolved remote attempts—not
        host CPU usage. Labels are operator-declared; tool availability is probed. Automatic routing
        only occurs before a workspace is bound. Capacity providers are currently static; the
        environment contract is ready for future provisioned fleets, but Convoy does not create or
        destroy runners automatically.
      </p>
    </div>
  );
}
function EnvironmentForm({
  value,
  act,
  working,
}: {
  value?: Environment;
  act: (action: RuntimeAction, input: object) => Promise<void>;
  working: boolean;
}) {
  const [kind, setKind] = useState(value?.kind ?? 'ssh');
  return (
    <form
      className="runtime-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void act('saveEnvironment', {
          id: value?.id,
          revision: value?.revision,
          name: f.get('name'),
          kind,
          host: f.get('host'),
          maxConcurrent: Number(f.get('capacity')),
          tags: split(f.get('tags')),
          enabled: f.get('enabled') === 'on',
        });
      }}
    >
      <label>
        Name
        <input name="name" required defaultValue={value?.name} />
      </label>
      <label>
        Transport
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="ssh">SSH</option>
          <option value="local">Local</option>
        </select>
      </label>
      {kind === 'ssh' && (
        <label>
          SSH config alias
          <input name="host" required defaultValue={value?.host} placeholder="dev-eu-1" />
        </label>
      )}
      <label>
        Concurrent executions
        <input
          name="capacity"
          type="number"
          min={1}
          max={32}
          defaultValue={value?.maxConcurrent ?? 4}
        />
      </label>
      <label>
        Labels
        <input name="tags" defaultValue={value?.tags.join(',')} placeholder="linux, isolated" />
      </label>
      <label>
        <input name="enabled" type="checkbox" defaultChecked={value?.enabled ?? true} />
        Allow new assignments
      </label>
      <button className="primary" disabled={working}>
        {value ? 'Save environment' : 'Create environment'}
      </button>
    </form>
  );
}
