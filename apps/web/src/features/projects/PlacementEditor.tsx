import { useState } from 'react';
import { command } from '../../shared/api/runtime';
import type { Placement, Project, RuntimeState, Ticket } from '../../shared/api/runtime';
export function PlacementEditor({
  state,
  target,
  ticket = false,
}: {
  state: RuntimeState;
  target: Project | Ticket;
  ticket?: boolean;
}) {
  const [value, setValue] = useState<Placement>(() => structuredClone(target.placement));
  const [revision, setRevision] = useState(target.revision);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const patch = (p: Partial<Placement>) => setValue((v) => ({ ...v, ...p }));
  async function save() {
    setWorking(true);
    try {
      const input = ticket
        ? { taskId: Number(target.id), revision, placement: value }
        : { projectId: String(target.id), revision, placement: value };
      const response = await command('setPlacement', input);
      setRevision(response.result.revision);
      setMessage('Placement saved. Existing workspaces stay pinned.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="placement-editor">
      <div className="runtime-form">
        <label>
          Execution placement
          <select
            value={value.mode}
            onChange={(e) => patch({ mode: e.target.value as Placement['mode'] })}
          >
            {ticket && <option value="inherit">Project default</option>}
            <option value="none">Text-only · no workspace</option>
            <option value="pinned">Pin to a runner</option>
            <option value="pool">Automatically select from pool</option>
          </select>
        </label>
        {value.mode === 'pinned' && (
          <label>
            Runner
            <select
              value={value.runnerId ?? ''}
              onChange={(e) => patch({ runnerId: e.target.value })}
            >
              <option value="">Select runner</option>
              {state.runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {state.environments.find((e) => e.id === r.environmentId)?.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {value.mode === 'pool' && (
          <>
            <label>
              Runner pool
              <select
                value={value.poolId ?? ''}
                onChange={(e) => patch({ poolId: e.target.value })}
              >
                <option value="">Select pool</option>
                {state.runnerPools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Selection strategy
              <select
                value={value.strategy ?? 'least-loaded'}
                onChange={(e) => patch({ strategy: e.target.value })}
              >
                <option value="least-loaded">Least loaded</option>
                <option value="priority">Pool member order</option>
              </select>
            </label>
          </>
        )}
        {['pinned', 'pool'].includes(value.mode) && (
          <>
            <label>
              Required labels (comma-separated)
              <input
                value={(value.requiredTags ?? []).join(',')}
                onChange={(e) =>
                  patch({
                    requiredTags: e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Required tools
              <select
                multiple
                value={value.requiredTools ?? []}
                onChange={(e) =>
                  patch({ requiredTools: [...e.target.selectedOptions].map((o) => o.value) })
                }
              >
                {[
                  'read_file',
                  'list_files',
                  'search_files',
                  'inspect_repository',
                  'write_file',
                  'apply_patch',
                  'shell',
                  'start_command',
                  'command_status',
                  'read_command_output',
                  'send_command_input',
                  'stop_command',
                ].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              Preferred environment
              <select
                value={value.preferEnvironmentIds?.[0] ?? ''}
                onChange={(e) =>
                  patch({ preferEnvironmentIds: e.target.value ? [e.target.value] : [] })
                }
              >
                <option value="">No preference</option>
                {state.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <div className="runtime-toolbar">
        <button className="secondary" disabled={working} onClick={save}>
          Save placement
        </button>
        <button
          className="secondary"
          onClick={() => {
            setValue(structuredClone(target.placement));
            setRevision(target.revision);
            setMessage('Reloaded saved placement.');
          }}
        >
          Reload placement
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      <p className="muted">
        Only eligible runners with free capacity can receive work. Uncertain remote attempts require
        reconciliation; existing worktrees are never moved automatically.
      </p>
    </div>
  );
}
