import { useMemo, useRef, useState, type FormEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  ContextRef,
  RuntimeCommandInputMap,
  RuntimeCommandResultMap,
  RuntimeState,
} from '../../shared/api/runtime';
import {
  buildContextModel,
  invitationAdministrationModel,
  invitationLink,
  invitationToken,
  parseInvitationScope,
} from './context-model';
import './access.css';

function InvitationAdministration({
  state,
  createInvitation,
  createTeam,
}: {
  state: RuntimeState;
  createInvitation: (
    input: RuntimeCommandInputMap['createInvitation'],
  ) => Promise<RuntimeCommandResultMap['createInvitation']>;
  createTeam: (
    input: RuntimeCommandInputMap['createTeam'],
  ) => Promise<RuntimeCommandResultMap['createTeam']>;
}) {
  const model = invitationAdministrationModel(state);
  const [scopeValue, setScopeValue] = useState(model.scopes[0]?.value ?? '');
  const [binding, setBinding] = useState<'email' | 'domain'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  const [issued, setIssued] = useState<{
    token: string;
    link: string;
    expiresAt: string;
  }>();
  const scope = model.scopes.find((candidate) => candidate.value === scopeValue) ?? model.scopes[0];

  if (!model.canInvite || !model.organizationId) {
    return <p className="permission-note">{model.permissionMessage}</p>;
  }

  async function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setMessage(undefined);
    setIssued(undefined);
    const data = new FormData(form);
    try {
      const result = await createInvitation({
        organizationId: model.organizationId!,
        scope: parseInvitationScope(String(data.get('scope') ?? '')),
        roles: [String(data.get('role') ?? '')],
        ...(binding === 'email'
          ? { email: String(data.get('email') ?? '').trim() }
          : { domain: String(data.get('domain') ?? '').trim() }),
        ttlMs: Number(data.get('ttlMs')),
      });
      setIssued({
        token: result.token,
        link: invitationLink(
          state.deployment?.publicOrigin ?? window.location.origin,
          result.token,
        ),
        expiresAt: result.invitation.expiresAt,
      });
      form.reset();
      setMessage({ error: false, text: 'Invitation created. Copy it before closing this panel.' });
    } catch (caught) {
      setMessage({
        error: true,
        text: caught instanceof Error ? caught.message : 'Invitation could not be created.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details
      className="invitation-admin"
      onToggle={(event) => {
        if (!event.currentTarget.open) setIssued(undefined);
      }}
    >
      <summary>Invite people</summary>
      <form onSubmit={(event) => void issue(event)}>
        <label>
          Scope
          <select
            name="scope"
            value={scope?.value ?? ''}
            onChange={(event) => setScopeValue(event.target.value)}
          >
            {model.scopes.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <select key={scope?.value} name="role" defaultValue={scope?.roles.at(-1)}>
            {scope?.roles.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Identity binding</legend>
          <label>
            <input
              type="radio"
              name="binding"
              checked={binding === 'email'}
              onChange={() => setBinding('email')}
            />
            Email
          </label>
          <label>
            <input
              type="radio"
              name="binding"
              checked={binding === 'domain'}
              disabled={!model.verifiedDomains.length}
              onChange={() => setBinding('domain')}
            />
            Verified domain
          </label>
        </fieldset>
        {binding === 'email' ? (
          <label>
            Email address
            <input name="email" type="email" required autoComplete="off" />
          </label>
        ) : (
          <label>
            Verified domain
            <select name="domain" required>
              {model.verifiedDomains.map((domain) => (
                <option key={domain}>{domain}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Expires
          <select name="ttlMs" defaultValue={String(24 * 60 * 60 * 1000)}>
            <option value={60 * 60 * 1000}>1 hour</option>
            <option value={24 * 60 * 60 * 1000}>24 hours</option>
            <option value={7 * 24 * 60 * 60 * 1000}>7 days</option>
            <option value={30 * 24 * 60 * 60 * 1000}>30 days</option>
          </select>
        </label>
        <button disabled={busy}>{busy ? 'Creating…' : 'Create invitation'}</button>
      </form>
      {message && <small role={message.error ? 'alert' : 'status'}>{message.text}</small>}
      {issued && (
        <div className="issued-invitation">
          <p>
            This token is shown once and expires <strong>{issued.expiresAt}</strong>.
          </p>
          <label>
            Invitation link
            <textarea
              readOnly
              rows={3}
              value={issued.link}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <label>
            Token
            <input
              readOnly
              value={issued.token}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button type="button" onClick={() => void navigator.clipboard.writeText(issued.link)}>
            Copy link
          </button>
          <button type="button" onClick={() => setIssued(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {model.canCreateTeam && (
        <details className="create-team">
          <summary>Create team</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              setBusy(true);
              setMessage(undefined);
              void createTeam({
                organizationId: model.organizationId!,
                displayName: String(data.get('teamName') ?? '').trim(),
                slug: String(data.get('teamSlug') ?? '').trim(),
              })
                .then(() => {
                  form.reset();
                  setMessage({ error: false, text: 'Team created. Context choices will refresh.' });
                })
                .catch((caught) =>
                  setMessage({
                    error: true,
                    text: caught instanceof Error ? caught.message : 'Team could not be created.',
                  }),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Team name
              <input name="teamName" required />
            </label>
            <label>
              Slug
              <input
                name="teamSlug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="platform"
              />
            </label>
            <button disabled={busy}>Create team</button>
          </form>
        </details>
      )}
    </details>
  );
}

export function ActiveContext({
  state,
  projectId,
  selectContext,
  acceptInvitation,
  createInvitation,
  createTeam,
}: {
  state: RuntimeState;
  projectId?: string;
  selectContext: (context: ContextRef) => void;
  acceptInvitation: (token: string) => Promise<void>;
  createInvitation: (
    input: RuntimeCommandInputMap['createInvitation'],
  ) => Promise<RuntimeCommandResultMap['createInvitation']>;
  createTeam: (
    input: RuntimeCommandInputMap['createTeam'],
  ) => Promise<RuntimeCommandResultMap['createTeam']>;
}) {
  const invitation = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinMessage, setJoinMessage] = useState<{ error: boolean; text: string }>();
  const source = useMemo(
    () => ({
      ...state,
      activeContext: state.activeContext
        ? { ...state.activeContext, projectId: projectId ?? state.activeContext.projectId }
        : undefined,
      projects: projectId
        ? [
            ...state.projects.filter((project) => project.id === projectId),
            ...state.projects.filter((project) => project.id !== projectId),
          ]
        : state.projects,
    }),
    [state, projectId],
  );
  const model = buildContextModel(source);

  return (
    <details className="active-context" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label={`Active context: ${model.authoritativeLabel}`}>
        <span>
          <small>{model.isManaged ? 'Active context' : 'Local workspace'}</small>
          <strong>{model.authoritativeLabel}</strong>
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {open && (
        <div className="active-context-popover">
          <div className="active-context-grid">
            <span>
              <small>Deployment</small>
              <strong>{model.deploymentName}</strong>
            </span>
            <span>
              <small>Organization</small>
              <strong>{model.organizationName ?? 'Personal'}</strong>
            </span>
            <span>
              <small>Team</small>
              <strong>{model.teamName ?? 'No team selected'}</strong>
            </span>
            <label>
              <small>Project</small>
              <select
                aria-label="Active context project"
                value={projectId ?? state.activeContext?.projectId ?? state.projects[0]?.id ?? ''}
                onChange={(event) => {
                  const available = model.availableContexts.find(
                    (context) => context.projectId === event.target.value,
                  );
                  selectContext(
                    available
                      ? {
                          organizationId: available.organizationId,
                          ...(available.teamId ? { teamId: available.teamId } : {}),
                          projectId: available.projectId,
                        }
                      : {
                          organizationId:
                            state.activeContext?.organizationId ??
                            state.projects.find((project) => project.id === event.target.value)
                              ?.organizationId ??
                            'personal',
                          projectId: event.target.value,
                        },
                  );
                }}
              >
                {model.availableContexts.length
                  ? model.availableContexts.map((context) => (
                      <option
                        key={`${context.organizationId}:${context.projectId}`}
                        value={context.projectId}
                      >
                        {context.label}
                      </option>
                    ))
                  : model.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
              </select>
            </label>
          </div>
          {model.roleLabels.length > 0 && (
            <p className="active-context-roles">
              Authority: <strong>{model.roleLabels.join(' · ')}</strong>
            </p>
          )}
          <p>
            Signed in as <strong>{model.userLabel}</strong>. Organization and team authority are
            controlled by the deployment; changing this selection resolves a fresh authorized
            context.
          </p>
          <form
            className="invitation-form"
            onSubmit={(event) => {
              event.preventDefault();
              const token = invitationToken(invitation.current?.value ?? '');
              if (invitation.current) invitation.current.value = '';
              if (!token) {
                setJoinMessage({ error: true, text: 'Enter a valid invitation token or link.' });
                return;
              }
              setJoining(true);
              setJoinMessage(undefined);
              void acceptInvitation(token)
                .then(() =>
                  setJoinMessage({
                    error: false,
                    text: 'Invitation accepted. Your authorized contexts will refresh.',
                  }),
                )
                .catch((caught) =>
                  setJoinMessage({
                    error: true,
                    text:
                      caught instanceof Error
                        ? caught.message
                        : 'Invitation could not be accepted.',
                  }),
                )
                .finally(() => setJoining(false));
            }}
          >
            <label htmlFor="convoy-invitation">Join an organization or team</label>
            <div>
              <input
                id="convoy-invitation"
                ref={invitation}
                autoComplete="off"
                placeholder="Invitation token or link"
              />
              <button disabled={joining}>{joining ? 'Joining…' : 'Accept'}</button>
            </div>
            {joinMessage && (
              <small role={joinMessage.error ? 'alert' : 'status'}>{joinMessage.text}</small>
            )}
          </form>
          <InvitationAdministration
            state={source}
            createInvitation={createInvitation}
            createTeam={createTeam}
          />
        </div>
      )}
    </details>
  );
}
