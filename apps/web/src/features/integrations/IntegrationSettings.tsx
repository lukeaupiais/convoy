import { useEffect, useState } from 'react';
import {
  command,
  type RuntimeState,
  type TicketConnection,
  type TicketSourceManifest,
} from '../../shared/api/runtime';
import './integrations.css';

const starterManifest = `{
  "apiVersion": "convoy.dev/v1alpha1",
  "kind": "TicketSource",
  "connection": {
    "baseUrl": "https://support.example.com/api/v1",
    "authentication": { "type": "bearer", "credential": "CONVOY_TICKET_SOURCE_TOKEN_MAIN" }
  },
  "operations": {
    "list": {
      "method": "GET",
      "path": "tickets",
      "query": { "limit": "\${limit}" },
      "response": { "items": "$.items" }
    },
    "get": {
      "method": "GET",
      "path": "tickets/\${remoteId}",
      "response": { "item": "$.ticket" }
    }
  },
  "mapping": {
    "remoteId": "$.id",
    "remoteKey": "$.key",
    "title": "$.title",
    "description": "$.description",
    "status": "$.status",
    "priority": "$.priority",
    "remoteVersion": "$.updatedAt",
    "url": "$.url"
  },
  "values": {
    "priority": { "low": "Low", "normal": "Medium", "urgent": "High" }
  },
  "ownership": {
    "title": "external",
    "description": "external",
    "status": "external",
    "priority": "external"
  }
}`;

const label = (connection: TicketConnection) =>
  `${connection.provider === 'linear' ? 'Linear' : 'Custom HTTP'} · ${connection.name}`;

function ConnectionCard({
  connection,
  state,
}: {
  connection: TicketConnection;
  state: RuntimeState;
}) {
  const [name, setName] = useState(connection.name);
  const [manifestText, setManifestText] = useState(
    connection.provider === 'custom-http' ? JSON.stringify(connection.manifest, null, 2) : '',
  );
  const [teamId, setTeamId] = useState(connection.provider === 'linear' ? connection.teamId : '');
  const [credentialEnv, setCredentialEnv] = useState(
    connection.provider === 'linear' ? connection.credentialEnv : '',
  );
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const binding = state.ticketImportBindings?.find((value) => value.connectionId === connection.id);
  const projects = state.projects.filter(
    (value) => value.organizationId === connection.organizationId,
  );
  const [importProjectId, setImportProjectId] = useState(projects[0]?.id ?? '');
  const [importName, setImportName] = useState(connection.name);
  const [importWorkType, setImportWorkType] = useState('support');
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(binding?.pollIntervalMinutes ?? 0);
  useEffect(() => {
    setName(connection.name);
    if (connection.provider === 'linear') {
      setTeamId(connection.teamId);
      setCredentialEnv(connection.credentialEnv);
    } else setManifestText(JSON.stringify(connection.manifest, null, 2));
  }, [connection]);
  const linked = state.tickets.filter(
    (ticket) =>
      ticket.externalLinks?.some((link) => link.connectionId === connection.id) ||
      ticket.externalPublish?.connectionId === connection.id,
  ).length;
  const boards = state.boards.filter(
    (board) =>
      board.destinationConnectionIds?.includes(connection.id) ||
      board.creationPolicy?.connectionId === connection.id,
  ).length;
  async function save(enabled = connection.enabled) {
    setWorking(true);
    setMessage('');
    try {
      const common = {
        id: connection.id,
        revision: connection.revision,
        organizationId: connection.organizationId,
        name: name.trim(),
        enabled,
        pollIntervalMinutes,
      };
      if (connection.provider === 'linear')
        await command('saveTicketConnection', {
          ...common,
          provider: 'linear',
          teamId: teamId.trim(),
          credentialEnv: credentialEnv.trim(),
        });
      else
        await command('saveTicketConnection', {
          ...common,
          provider: 'custom-http',
          manifest: JSON.parse(manifestText) as TicketSourceManifest,
        });
      setEditing(false);
      setMessage('Connection saved.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function probe() {
    setWorking(true);
    setMessage('');
    try {
      const response = await command('probeTicketConnection', { id: connection.id });
      setMessage(
        response.result.sample
          ? `Connected to ${response.result.sourceName}. Sample: ${response.result.sample.remoteKey} · ${response.result.sample.title}`
          : `Connected to ${response.result.sourceName}.`,
      );
    } catch (error) {
      setMessage(`Connection check failed: ${(error as Error).message}`);
    } finally {
      setWorking(false);
    }
  }
  async function remove() {
    if (!window.confirm(`Delete ${connection.name}?`)) return;
    setWorking(true);
    setMessage('');
    try {
      await command('deleteTicketConnection', { id: connection.id, revision: connection.revision });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function saveBinding(enabled = binding?.enabled ?? true) {
    setWorking(true);
    setMessage('');
    try {
      await command('saveTicketImportBinding', {
        ...(binding ? { id: binding.id, revision: binding.revision } : {}),
        connectionId: connection.id,
        projectId: binding?.projectId ?? importProjectId,
        name: binding?.name ?? importName.trim(),
        workType: binding?.workType ?? importWorkType.trim(),
        enabled,
      });
      setMessage('Import binding saved.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function syncBinding() {
    if (!binding) return;
    setWorking(true);
    setMessage('');
    try {
      const response = await command('syncTicketImportBinding', { id: binding.id, limit: 100 });
      setMessage(
        `Synced ${response.result.imported} new and ${response.result.updated} updated tickets${response.result.complete ? '.' : '; more pages remain.'}`,
      );
    } catch (error) {
      setMessage(`Sync failed: ${(error as Error).message}`);
    } finally {
      setWorking(false);
    }
  }
  return (
    <article className="integration-card">
      <header>
        <div className="integration-card-title">
          <span
            className={`integration-status-light ${connection.enabled ? 'is-enabled' : ''}`}
            aria-hidden="true"
          />
          <strong>{label(connection)}</strong>
        </div>
        <div className="integration-actions">
          <span className={`integration-status ${connection.enabled ? 'is-enabled' : ''}`}>
            {connection.enabled ? 'Connected' : 'Disabled'}
          </span>
          <button
            className="secondary"
            disabled={working}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? 'Close' : '•••'}
          </button>
        </div>
      </header>
      <div className="integration-card-body">
        <span>{linked} linked</span>
        <span>·</span>
        <span>
          {boards} {boards === 1 ? 'board' : 'boards'}
        </span>
        {!connection.enabled && (
          <button
            className="integration-inline-action"
            disabled={working}
            onClick={() => void save(true)}
          >
            Enable
          </button>
        )}
      </div>
      <div className="integration-card-body">
        {binding ? (
          <>
            <span>
              Import to{' '}
              {projects.find((value) => value.id === binding.projectId)?.name ?? binding.projectId}{' '}
              · {binding.workType}
            </span>
            <label>
              Sync interval
              <select value={pollIntervalMinutes} onChange={(event) => setPollIntervalMinutes(Number(event.target.value))}>
                <option value={0}>Manual</option>
                <option value={5}>Every 5 minutes</option>
                <option value={15}>Every 15 minutes</option>
                <option value={60}>Hourly</option>
              </select>
            </label>
            {pollIntervalMinutes !== (binding.pollIntervalMinutes ?? 0) && <button className="secondary" disabled={working} onClick={() => void saveBinding()}>Save interval</button>}
            <button
              className="secondary"
              disabled={working || !binding.enabled || !connection.enabled}
              onClick={() => void syncBinding()}
            >
              Sync
            </button>
            <button
              className="secondary"
              disabled={working}
              onClick={() => void saveBinding(!binding.enabled)}
            >
              {binding.enabled ? 'Pause import' : 'Enable import'}
            </button>
            {binding.lastSyncedAt && (
              <span>Last synced {new Date(binding.lastSyncedAt).toLocaleString()}</span>
            )}
            {binding.lastError && <span role="alert">{binding.lastError}</span>}
          </>
        ) : (
          <>
            <label>
              Import project
              <select
                value={importProjectId}
                onChange={(event) => setImportProjectId(event.target.value)}
              >
                {projects.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Import name
              <input value={importName} onChange={(event) => setImportName(event.target.value)} />
            </label>
            <label>
              Work type
              <input
                value={importWorkType}
                onChange={(event) => setImportWorkType(event.target.value)}
              />
            </label>
            <label>
              Sync interval
              <select value={pollIntervalMinutes} onChange={(event) => setPollIntervalMinutes(Number(event.target.value))}>
                <option value={0}>Manual</option>
                <option value={5}>Every 5 minutes</option>
                <option value={15}>Every 15 minutes</option>
                <option value={60}>Hourly</option>
              </select>
            </label>
            <button
              className="secondary"
              disabled={working || !importProjectId}
              onClick={() => void saveBinding()}
            >
              Bind import
            </button>
          </>
        )}
      </div>
      {editing && (
        <div className="integration-menu">
          <div className="integration-actions">
            <button className="secondary" disabled={working} onClick={() => void probe()}>
              Test
            </button>
            <button
              className="secondary"
              disabled={working}
              onClick={() => void save(!connection.enabled)}
            >
              {connection.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label>
              Name
              <input required value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            {connection.provider === 'linear' ? (
              <>
                <label>
                  Team ID
                  <input
                    required
                    value={teamId}
                    onChange={(event) => setTeamId(event.target.value)}
                  />
                </label>
                <label>
                  Token variable
                  <input
                    required
                    value={credentialEnv}
                    onChange={(event) => setCredentialEnv(event.target.value)}
                  />
                </label>
              </>
            ) : (
              <label>
                Source manifest
                <textarea
                  required
                  rows={18}
                  value={manifestText}
                  onChange={(event) => setManifestText(event.target.value)}
                  spellCheck={false}
                />
              </label>
            )}
            <div className="integration-actions">
              <button className="primary" disabled={working}>
                Save
              </button>
              <button
                className="secondary"
                type="button"
                disabled={working || linked > 0 || boards > 0}
                onClick={() => void remove()}
              >
                Delete
              </button>
            </div>
          </form>
        </div>
      )}
      {message && (
        <p role="status" className="integration-card-message">
          {message}
        </p>
      )}
    </article>
  );
}

export function IntegrationSettings({ state }: { state: RuntimeState }) {
  const organizationId = state.activeContext?.organizationId ?? state.projects[0]?.organizationId;
  const connections = (state.ticketConnections ?? []).filter(
    (connection) => connection.organizationId === organizationId,
  );
  const [linearName, setLinearName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [credentialEnv, setCredentialEnv] = useState('CONVOY_LINEAR_TOKEN_MAIN');
  const [customName, setCustomName] = useState('');
  const [manifestText, setManifestText] = useState(starterManifest);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  async function addLinear() {
    if (!organizationId) return;
    setWorking(true);
    setMessage('');
    try {
      await command('saveTicketConnection', {
        organizationId,
        provider: 'linear',
        name: linearName.trim(),
        teamId: teamId.trim(),
        credentialEnv: credentialEnv.trim(),
      });
      setLinearName('');
      setTeamId('');
      setMessage('Linear connection saved.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function addCustom() {
    if (!organizationId) return;
    setWorking(true);
    setMessage('');
    try {
      await command('saveTicketConnection', {
        organizationId,
        provider: 'custom-http',
        name: customName.trim(),
        manifest: JSON.parse(manifestText) as TicketSourceManifest,
      });
      setCustomName('');
      setMessage('Custom ticket source saved. Test it before importing tickets.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <div className="integration-settings">
      <div className="integration-heading">
        <h2>Integrations</h2>
      </div>
      <div className="integration-workspace">
        <div className="integration-list">
          {connections.map((connection) => (
            <ConnectionCard key={connection.id} connection={connection} state={state} />
          ))}
        </div>
        <details className="integration-add" id="add-linear-connection">
          <summary>Add Linear</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void addLinear();
            }}
          >
            <label>
              Name
              <input
                required
                value={linearName}
                onChange={(event) => setLinearName(event.target.value)}
                placeholder="Product team"
              />
            </label>
            <label>
              Team ID
              <input
                required
                value={teamId}
                onChange={(event) => setTeamId(event.target.value)}
                placeholder="Team UUID"
              />
            </label>
            <label>
              Token variable
              <input
                required
                value={credentialEnv}
                onChange={(event) => setCredentialEnv(event.target.value)}
              />
            </label>
            <button className="primary" disabled={working}>
              Add
            </button>
          </form>
        </details>
        <details className="integration-add" id="add-custom-ticket-source">
          <summary>Add custom ticket source</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void addCustom();
            }}
          >
            <label>
              Name
              <input
                required
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="Internal support"
              />
            </label>
            <label>
              Source manifest
              <textarea
                required
                rows={20}
                value={manifestText}
                onChange={(event) => setManifestText(event.target.value)}
                spellCheck={false}
              />
            </label>
            <button className="primary" disabled={working}>
              Add
            </button>
          </form>
        </details>
        {message && (
          <p role="status" className="integration-message">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}
