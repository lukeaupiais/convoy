import { useState } from 'react';
import { command, type RuntimeState } from '../../shared/api/runtime';
import { profileRef } from './CapabilityLibrary';
import './capabilities.css';
export function ProjectAgentProfile({
  state,
  projectId,
  onManage,
}: {
  state: RuntimeState;
  projectId: string;
  onManage?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = state.capabilities?.projectProfiles[projectId];
  return (
    <section className="capability-library" aria-label="Default agent profile">
      <header className="library-toolbar">
        <h2>Agent profile</h2>
        {onManage && (
          <button className="secondary" type="button" onClick={onManage}>
            Manage profiles
          </button>
        )}
      </header>
      <label>
        Default for new sessions
        <select
          aria-label="Project capability profile"
          value={current ? `${current.id}@${current.version}` : ''}
          disabled={busy}
          onChange={async (event) => {
            const value = event.target.value;
            setBusy(true);
            setMessage('');
            try {
              await command('setProjectProfile', {
                projectId,
                profile: profileRef(state, value),
                expected: current ?? null,
              });
              setMessage('Default updated for new sessions.');
            } catch (error) {
              setMessage((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="">Legacy defaults</option>
          {state.capabilities?.profiles.map((profile) => (
            <option
              key={`${profile.id}@${profile.version}`}
              value={`${profile.id}@${profile.version}`}
            >
              {profile.name} · v{profile.version}
            </option>
          ))}
        </select>
      </label>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
