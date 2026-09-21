import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  command,
  type ProviderConnection,
  type RuntimeCommandInputMap,
  type RuntimeState,
} from '../../shared/api/runtime';
import { AuthControls } from './AuthControls';
import {
  modelRouteCandidateOptions,
  parseProviderOwner,
  providerAdministrationModel,
} from './provider-admin';
import { modelRouteRows, providerConnectionRows } from './provider-inventory';
import './providers.css';

type Notice = { kind: 'status' | 'alert'; text: string } | undefined;

function publicError(caught: unknown) {
  return caught instanceof Error ? caught.message : 'The provider operation failed.';
}

function ConnectionActions({
  connection,
  organizationId,
  disabled,
  run,
}: {
  connection: ProviderConnection;
  organizationId: string;
  disabled: boolean;
  run: <
    Action extends
      | 'probeProviderConnection'
      | 'rotateProviderCredential'
      | 'revokeProviderCredential'
      | 'revokeProviderConnection',
  >(
    action: Action,
    input: RuntimeCommandInputMap[Action],
    success: string,
  ) => Promise<void>;
}) {
  const secret = useRef<HTMLInputElement>(null);
  const identity = {
    organizationId,
    connectionId: connection.id,
    expectedRevision: connection.revision,
  };
  return (
    <div className="provider-actions">
      <button
        type="button"
        disabled={disabled || connection.state === 'revoked'}
        onClick={() => void run('probeProviderConnection', identity, 'Connection probe completed.')}
      >
        Probe
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const credentialValue = secret.current?.value ?? '';
          if (secret.current) secret.current.value = '';
          if (credentialValue)
            void run(
              'rotateProviderCredential',
              { ...identity, credentialValue },
              'Credential rotated. The submitted value was cleared from this browser.',
            );
        }}
      >
        <label className="sr-only" htmlFor={`rotate-${connection.id}`}>
          Replacement credential for {connection.displayName}
        </label>
        <input
          id={`rotate-${connection.id}`}
          ref={secret}
          type="password"
          autoComplete="new-password"
          placeholder="Replacement credential"
          disabled={disabled || connection.state === 'revoked'}
        />
        <button disabled={disabled || connection.state === 'revoked'}>Rotate</button>
      </form>
      <button
        type="button"
        disabled={disabled || connection.credentialRef.kind === 'none'}
        onClick={() =>
          void run('revokeProviderCredential', identity, 'Credential revoked from the broker.')
        }
      >
        Revoke credential
      </button>
      <button
        type="button"
        disabled={disabled || connection.state === 'revoked'}
        onClick={() =>
          void run(
            'revokeProviderConnection',
            { ...identity, reason: 'Revoked by an organization administrator in the web client.' },
            'Provider connection revoked.',
          )
        }
      >
        Revoke connection
      </button>
    </div>
  );
}

export function ProviderSettings({ state }: { state: RuntimeState }) {
  const connections = providerConnectionRows(
    state.providerConnections ?? [],
    state.modelOfferings ?? [],
  );
  const routes = modelRouteRows(state.modelRoutes ?? [], state.modelOfferings ?? []);
  const administration = providerAdministrationModel(state);
  const candidateOptions = useMemo(
    () => modelRouteCandidateOptions(state.providerConnections ?? [], state.modelOfferings ?? []),
    [state.providerConnections, state.modelOfferings],
  );
  const credential = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  async function run<Action extends keyof RuntimeCommandInputMap>(
    action: Action,
    input: RuntimeCommandInputMap[Action],
    success: string,
  ) {
    setBusy(true);
    setNotice(undefined);
    try {
      await command(action, input);
      setNotice({ kind: 'status', text: success });
    } catch (caught) {
      setNotice({ kind: 'alert', text: publicError(caught) });
    } finally {
      setBusy(false);
    }
  }

  function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const secret = credential.current?.value ?? '';
    if (credential.current) credential.current.value = '';
    if (!administration.organizationId) {
      setNotice({ kind: 'alert', text: 'Select an organization context first.' });
      return;
    }
    const monthlyBudgetUsd = Number(data.get('monthlyBudgetUsd') || 0);
    const maximumConcurrency = Number(data.get('maximumConcurrency') || 0);
    void run(
      'createProviderConnection',
      {
        organizationId: administration.organizationId,
        providerId: 'openai-compatible',
        displayName: String(data.get('displayName') ?? '').trim(),
        owner: parseProviderOwner(String(data.get('owner') ?? '')),
        endpoint: { origin: String(data.get('endpoint') ?? '').trim() },
        ...(secret ? { credentialValue: secret } : { credentialRef: { kind: 'none' } }),
        governance: {
          ...(monthlyBudgetUsd > 0 ? { monthlyBudgetUsd } : {}),
          ...(maximumConcurrency > 0 ? { maximumConcurrency } : {}),
        },
      },
      'Provider connection created. Probe it to publish verified model offerings.',
    );
  }

  function createRoute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!administration.organizationId) {
      setNotice({ kind: 'alert', text: 'Select an organization context first.' });
      return;
    }
    const selected = [String(data.get('primary') ?? ''), String(data.get('fallback') ?? '')]
      .filter(Boolean)
      .map((value) => candidateOptions.find((candidate) => candidate.value === value))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const unique = selected.filter(
      (candidate, index) => selected.findIndex((item) => item.value === candidate.value) === index,
    );
    if (!unique.length) {
      setNotice({ kind: 'alert', text: 'Choose at least one verified model offering.' });
      return;
    }
    const costLimit = Number(data.get('costLimit') || 0);
    void run(
      'createModelRoute',
      {
        organizationId: administration.organizationId,
        name: String(data.get('routeName') ?? '').trim(),
        purposes: String(data.get('purposes') ?? '')
          .split(',')
          .map((purpose) => purpose.trim())
          .filter(Boolean),
        candidates: unique.map(({ connectionId, offeringId }) => ({ connectionId, offeringId })),
        policy: {
          fallback: unique.length > 1 ? 'not-sent-or-rejected' : 'never',
          ...(costLimit > 0 ? { maximumEstimatedCostUsdPerTurn: costLimit } : {}),
        },
      },
      'Model route created.',
    );
  }

  return (
    <div className="provider-settings">
      {notice && <p role={notice.kind}>{notice.text}</p>}
      <h2>Provider connections</h2>
      <p className="muted">
        Governed accounts and inference endpoints available to this context. Credentials remain in
        the daemon credential broker and are never shown here.
      </p>
      {connections.length ? (
        connections.map((connection) => {
          const record = state.providerConnections?.find((item) => item.id === connection.id);
          return (
            <article className="runtime-row provider-row" key={connection.id}>
              <div>
                <strong>{connection.name}</strong>
                <small>
                  {connection.providerId} · {connection.owner} · {connection.endpoint}
                </small>
                <small>
                  {connection.offeringSummary} · {connection.governance}
                </small>
                {connection.lastProbeAt && <small>Last verified {connection.lastProbeAt}</small>}
              </div>
              <span className={`run-status ${connection.state}`}>{connection.state}</span>
              {administration.canManage && record && administration.organizationId && (
                <ConnectionActions
                  connection={record}
                  organizationId={administration.organizationId}
                  disabled={busy}
                  run={run}
                />
              )}
            </article>
          );
        })
      ) : (
        <p>No provider connection inventory has been published for this context.</p>
      )}

      {administration.canManage ? (
        <details className="provider-admin" open={!connections.length}>
          <summary>Add an API, gateway, local, or self-hosted connection</summary>
          <form className="runtime-form" onSubmit={createConnection}>
            <label>
              Display name
              <input name="displayName" required placeholder="Team inference" />
            </label>
            <label>
              Owner
              <select name="owner" required defaultValue={administration.owners[0]?.value}>
                {administration.owners.map((owner) => (
                  <option key={owner.value} value={owner.value}>
                    {owner.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              OpenAI-compatible endpoint
              <input name="endpoint" type="url" required placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              Credential
              <input
                ref={credential}
                name="credential"
                type="password"
                autoComplete="new-password"
                placeholder="Optional for local endpoints"
              />
              <small>Submitted once, cleared immediately, and never returned by Convoy.</small>
            </label>
            <label>
              Monthly budget (USD)
              <input name="monthlyBudgetUsd" type="number" min="0" step="0.01" />
            </label>
            <label>
              Maximum concurrency
              <input name="maximumConcurrency" type="number" min="1" step="1" />
            </label>
            <button className="primary" disabled={busy}>
              Create connection
            </button>
          </form>
        </details>
      ) : (
        <p className="permission-note">{administration.permissionMessage}</p>
      )}

      <h2>Model routes</h2>
      <p className="muted">
        Logical model targets are resolved by policy at turn start. Candidate order is shown from
        primary to final fallback.
      </p>
      {routes.length ? (
        routes.map((route) => (
          <article className="runtime-row" key={route.id}>
            <div>
              <strong>{route.name}</strong>
              <small>{route.purposes}</small>
              <small>{route.candidates}</small>
              <small>
                Fallback: {route.fallback} · {route.limit}
              </small>
            </div>
            <span className={`run-status ${route.state}`}>{route.state}</span>
          </article>
        ))
      ) : (
        <p>No model routes have been published for this context.</p>
      )}

      {administration.canManage && (
        <details className="provider-admin" open={!routes.length && candidateOptions.length > 0}>
          <summary>Create a governed model route</summary>
          {candidateOptions.length ? (
            <form className="runtime-form" onSubmit={createRoute}>
              <label>
                Route name
                <input name="routeName" required placeholder="Coding" />
              </label>
              <label>
                Purposes
                <input name="purposes" placeholder="coding, review" />
              </label>
              <label className="wide">
                Primary model
                <select name="primary" required defaultValue="">
                  <option value="" disabled>
                    Choose a verified offering
                  </option>
                  {candidateOptions.map((candidate) => (
                    <option key={candidate.value} value={candidate.value}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wide">
                Safe fallback (optional)
                <select name="fallback" defaultValue="">
                  <option value="">No fallback</option>
                  {candidateOptions.map((candidate) => (
                    <option key={candidate.value} value={candidate.value}>
                      {candidate.label}
                    </option>
                  ))}
                </select>
                <small>Fallback is limited to requests known not sent or rejected.</small>
              </label>
              <label>
                Maximum estimated cost per turn (USD)
                <input name="costLimit" type="number" min="0" step="0.0001" />
              </label>
              <button className="primary" disabled={busy}>
                Create route
              </button>
            </form>
          ) : (
            <p>Probe a provider connection before creating a route.</p>
          )}
        </details>
      )}

      <h2>Personal subscription</h2>
      <AuthControls state={state} />
    </div>
  );
}
