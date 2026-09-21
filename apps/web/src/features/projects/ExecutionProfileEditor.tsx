import { useState } from 'react';
import { command } from '../../shared/api/runtime';
import type { ExecutionProfileId, Project, RuntimeState, Ticket } from '../../shared/api/runtime';

export function ExecutionProfileEditor({
  state,
  target,
  ticket = false,
}: {
  state: RuntimeState;
  target: Project | Ticket;
  ticket?: boolean;
}) {
  const initial = target.executionProfile ?? (ticket ? 'inherit' : 'ask');
  const [profile, setProfile] = useState<ExecutionProfileId | 'inherit'>(initial);
  const [revision, setRevision] = useState(target.revision);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const selected = state.executionProfiles.find((entry) => entry.id === profile);

  async function save() {
    setWorking(true);
    setMessage('');
    try {
      const result = await command(
        'setExecutionProfile',
        ticket
          ? { taskId: Number(target.id), revision, profile }
          : { projectId: String(target.id), revision, profile: profile as ExecutionProfileId },
      );
      setRevision(result.result.revision);
      setMessage('Execution profile saved. Existing assignments keep their pinned grant.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="placement-editor">
      <div className="runtime-form">
        <label>
          Agent execution profile
          <select
            value={profile}
            onChange={(event) => setProfile(event.target.value as ExecutionProfileId | 'inherit')}
          >
            {ticket && <option value="inherit">Project default</option>}
            {state.executionProfiles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {selected && (
        <p className="muted">
          {selected.envelope.isolation === 'host'
            ? 'Runs with the operating-system user authority of a trusted runner.'
            : selected.envelope.isolation === 'none'
              ? 'Runner execution is disabled.'
              : `Workspace ${selected.envelope.filesystem.workspace}; network ${selected.envelope.network.mode}.`}{' '}
          Reviewer: {selected.approval.reviewer}.
        </p>
      )}
      <button className="secondary" disabled={working} onClick={save}>
        {working ? 'Saving…' : 'Save execution profile'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
