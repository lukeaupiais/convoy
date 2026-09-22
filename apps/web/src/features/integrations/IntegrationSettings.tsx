import { useEffect, useState } from 'react';
import { command, type RuntimeState, type TicketConnection } from '../../shared/api/runtime';
import './integrations.css';

function ConnectionCard({ connection, state }: { connection: TicketConnection; state: RuntimeState }) {
  const [draft, setDraft] = useState(connection);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => setDraft(connection), [connection.revision]);
  const linked = state.tickets.filter((ticket) => ticket.externalLinks?.some((link) => link.connectionId === connection.id) || ticket.externalPublish?.connectionId === connection.id).length;
  const boards = state.boards.filter((board) => board.destinationConnectionIds?.includes(connection.id) || board.creationPolicy?.connectionId === connection.id).length;
  async function save(next = draft) {
    setWorking(true);
    setMessage('');
    try {
      await command('saveTicketConnection', {
        id: connection.id, revision: connection.revision,
        organizationId: connection.organizationId, provider: 'linear',
        name: next.name.trim(), teamId: next.teamId.trim(),
        credentialEnv: next.credentialEnv.trim(), enabled: next.enabled,
      });
      setEditing(false);
      setMessage('Connection saved.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setWorking(false); }
  }
  async function probe() {
    setWorking(true);
    setMessage('');
    try {
      const response = await command('probeTicketConnection', { id: connection.id });
      setMessage(`Connected to ${response.result.teamName}.`);
    } catch (error) { setMessage(`Connection check failed: ${(error as Error).message}`); }
    finally { setWorking(false); }
  }
  async function remove() {
    if (!window.confirm(`Delete ${connection.name}?`)) return;
    setWorking(true);
    setMessage('');
    try { await command('deleteTicketConnection', { id: connection.id, revision: connection.revision }); }
    catch (error) { setMessage((error as Error).message); }
    finally { setWorking(false); }
  }
  return (
    <article className="integration-card">
      <header>
        <div className="integration-card-title">
          <span className={`integration-status-light ${connection.enabled ? 'is-enabled' : ''}`} aria-hidden="true" />
          <strong>Linear · {connection.name}</strong>
        </div>
        <div className="integration-actions">
          <span className={`integration-status ${connection.enabled ? 'is-enabled' : ''}`}>{connection.enabled ? 'Connected' : 'Disabled'}</span>
          <button className="secondary" disabled={working} onClick={() => { setDraft(connection); setEditing((value) => !value); }}>{editing ? 'Close' : '•••'}</button>
        </div>
      </header>
      <div className="integration-card-body">
        <span>{linked} linked</span>
        <span>·</span>
        <span>{boards} {boards === 1 ? 'board' : 'boards'}</span>
        {!connection.enabled && <button className="integration-inline-action" disabled={working} onClick={() => void save({ ...connection, enabled: true })}>Enable</button>}
      </div>
      {editing && (
        <div className="integration-menu">
          <div className="integration-actions">
            <button className="secondary" disabled={working} onClick={() => void probe()}>Test</button>
            <button className="secondary" disabled={working} onClick={() => void save({ ...connection, enabled: !connection.enabled })}>{connection.enabled ? 'Disable' : 'Enable'}</button>
          </div>
          <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <label>Name<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label>Team ID<input required value={draft.teamId} onChange={(event) => setDraft({ ...draft, teamId: event.target.value })} /></label>
            <label>Token variable<input required value={draft.credentialEnv} onChange={(event) => setDraft({ ...draft, credentialEnv: event.target.value })} /></label>
            <div className="integration-actions">
              <button className="primary" disabled={working}>Save</button>
              <button className="secondary" type="button" disabled={working || linked > 0 || boards > 0} onClick={() => void remove()}>Delete</button>
            </div>
          </form>
        </div>
      )}
      {message && <p role="status" className="integration-card-message">{message}</p>}
    </article>
  );
}

export function IntegrationSettings({ state }: { state: RuntimeState }) {
  const organizationId = state.activeContext?.organizationId ?? state.projects[0]?.organizationId;
  const connections = (state.ticketConnections ?? []).filter((connection) => connection.organizationId === organizationId);
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [credentialEnv, setCredentialEnv] = useState('CONVOY_LINEAR_TOKEN_MAIN');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  async function add() {
    if (!organizationId) return;
    setWorking(true);
    setMessage('');
    try {
      await command('saveTicketConnection', { organizationId, provider: 'linear', name: name.trim(), teamId: teamId.trim(), credentialEnv: credentialEnv.trim() });
      setName(''); setTeamId('');
      setMessage('Linear connection saved. Enable it on a board to offer remote creation.');
    } catch (error) { setMessage((error as Error).message); }
    finally { setWorking(false); }
  }
  return (
    <div className="integration-settings">
      <div className="integration-heading">
        <h2>Integrations</h2>
      </div>
      <div className="integration-workspace">
        <div className="integration-list">
          {connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} state={state} />)}
        </div>
        <details className="integration-add" id="add-linear-connection">
          <summary>Add Linear</summary>
          <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
            <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Product team" /></label>
            <label>Team ID<input required value={teamId} onChange={(event) => setTeamId(event.target.value)} placeholder="Team UUID" /></label>
            <label>Token variable<input required value={credentialEnv} onChange={(event) => setCredentialEnv(event.target.value)} /></label>
            <button className="primary" disabled={working}>Add</button>
          </form>
        </details>
        {message && <p role="status" className="integration-message">{message}</p>}
      </div>
    </div>
  );
}
