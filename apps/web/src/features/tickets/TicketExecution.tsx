import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import {
  command,
  owns,
  type RuntimeState,
  type Ticket,
  type Placement,
  type RuntimeAction,
} from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';
import { Select } from '../../shared/ui/Select';
import { SessionControls } from '../sessions';
import './ticket-execution.css';
import { ProfilePicker, profileRef } from '../library';
import { WorkflowRunDetails } from '../workflows';

export function TicketExecution({
  state,
  ticket,
  runtimeAvailable = true,
  focusRecovery = false,
  onOpenTicketMessages,
  onOpenWorkflowRun,
}: {
  state: RuntimeState;
  ticket: Ticket;
  runtimeAvailable?: boolean;
  focusRecovery?: boolean;
  onOpenTicketMessages?: () => void;
  onOpenWorkflowRun?: (runId: string) => void;
}) {
  const session = state.sessions.find(
    (s) => s.id === ticket.executionSessionId && s.activeTicketId === ticket.id,
  );
  const project = state.projects.find((value) => value.id === ticket.projectId);
  const versions = [
    ...new Map(
      state.workflows
        .filter(
          (w) =>
            w.organizationId === project?.organizationId &&
            (!w.projectId || w.projectId === ticket.projectId) &&
            (!w.teamId || w.teamId === project?.teamId),
        )
        .map((w) => [w.id, w]),
    ).values(),
  ];
  const defaultWorkflowId =
    state.defaultWorkflowIds?.projects[ticket.projectId] ??
    state.defaultWorkflowIds?.organizations[project?.organizationId ?? ''];
  const initialWorkflow =
    versions.find((w) => w.id === ticket.workflow?.id) ??
    versions.find((w) => w.id === defaultWorkflowId) ??
    versions[0];
  const [workflow, setWorkflow] = useState(
    initialWorkflow ? `${initialWorkflow.id}@${initialWorkflow.version}` : '',
  );
  const [target, setTarget] = useState(session?.id ?? 'new');
  const [environment, setEnvironment] = useState('inherit');
  const [model, setModel] = useState(session?.model ?? state.models[0]?.id ?? '');
  const [profile, setProfile] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const request = useRef('');
  const [pendingRequest, setPendingRequest] = useState(false);
  const active = !!session?.flow && !['completed', 'cancelled'].includes(session.flow.status);
  const busy =
    !!session &&
    ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(session.status);
  const selectedSession = state.sessions.find((s) => s.id === target);
  const fixed = !!selectedSession?.workspace;
  const chosenWorkflow = versions.find((w) => `${w.id}@${w.version}` === workflow);
  const inheritedProfile =
    chosenWorkflow?.capabilityProfile ??
    selectedSession?.capabilityProfile ??
    state.capabilities?.projectProfiles[ticket.projectId];
  const effectiveRef = profile ? profileRef(state, profile) : inheritedProfile;
  const effectiveProfile = state.capabilities?.profiles.find(
    (p) => p.id === effectiveRef?.id && p.version === effectiveRef?.version,
  );
  const missingSkills = [
    ...new Set((chosenWorkflow?.nodes ?? []).flatMap((node) => node.skills ?? [])),
  ].filter((name) => !effectiveProfile?.skills.some((skill) => skill.name === name));
  const profileError =
    effectiveRef && !effectiveProfile
      ? 'Profile revision is unavailable.'
      : (effectiveProfile || chosenWorkflow?.capabilityProfile) && missingSkills.length
        ? `Missing skills: ${missingSkills.join(', ')}`
        : '';

  const eligible = state.sessions.filter(
    (s) =>
      (!s.projectId || s.projectId === ticket.projectId) &&
      (!s.activeTicketId || s.activeTicketId === ticket.id),
  );
  useEffect(() => {
    if (!session || !owns(session)) return;
    const timer = setInterval(
      () => void command('heartbeat', { sessionId: session.id }).catch(() => {}),
      25000,
    );
    return () => clearInterval(timer);
  }, [session?.id, session?.lease?.client]);
  async function act(action: RuntimeAction, input: object = {}) {
    if (!session || working) return;
    setWorking(true);
    setError('');
    try {
      if (!owns(session))
        await command('claim', { sessionId: session.id, label: 'Ticket execution' });
      await command(action, { sessionId: session.id, ...input });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  async function launch() {
    if (working) return;
    const chosen = versions.find((w) => `${w.id}@${w.version}` === workflow);
    if (!chosen) {
      setError('Choose a published workflow.');
      return;
    }
    const placement: Placement = environment.startsWith('runner:')
      ? { mode: 'pinned', runnerId: environment.slice(7) }
      : environment.startsWith('pool:')
        ? { mode: 'pool', poolId: environment.slice(5) }
        : { mode: environment as 'inherit' | 'none' };
    setWorking(true);
    setError('');
    request.current ||= newId();
    setPendingRequest(true);
    try {
      await command('runTicket', {
        ticketId: ticket.id,
        revision: ticket.revision,
        requestId: request.current,
        ...(profile ? { profile: profileRef(state, profile) } : {}),
        mode: target === 'new' ? 'new' : 'continue',
        sessionId: target === 'new' ? undefined : target,
        workflowId: chosen.id,
        workflowVersion: chosen.version ?? 1,
        placement: fixed ? { mode: 'inherit' } : placement,
        model,
      });
      request.current = '';
      setPendingRequest(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="ticket-execution" aria-label="Ticket execution">
      {error && (
        <p role="alert" className="execution-error">
          {error}
        </p>
      )}
      {session && (
        <>
          {session.verificationRuntime && (
            <details>
              <summary>Verification runtime · {session.verificationRuntime.state}</summary>
              {session.verificationRuntime.setupError && (
                <p>{session.verificationRuntime.setupError}</p>
              )}
              {session.verificationResetRequested ? (
                <p>Reset requested. Continue to prepare a new generation.</p>
              ) : (
                ['awaiting_submission', 'paused', 'interrupted', 'failed'].includes(
                  session.status,
                ) && (
                  <button
                    disabled={working || busy}
                    onClick={() =>
                      void act('resetVerificationRuntime', {
                        runtimeId: session.verificationRuntime!.id,
                        generation: session.verificationRuntime!.generation,
                      })
                    }
                  >
                    Reset runtime
                  </button>
                )
              )}
            </details>
          )}
          <details className="execution-evidence" open={focusRecovery}>
            <summary>Execution details</summary>
            <WorkflowRunDetails
              session={session}
              working={working || !runtimeAvailable}
              onRefreshDiff={() => void act('diff')}
            />
            {session.flow?.instance &&
              ['paused', 'interrupted', 'failed', 'awaiting_submission'].includes(
                session.flow.status,
              ) && (
                <button
                  className="primary"
                  disabled={working || !runtimeAvailable}
                  onClick={() => void act('continueWorkflow', { instance: session.flow!.instance })}
                >
                  Continue workflow
                </button>
              )}
            <p className="execution-note">
              {session.workspace
                ? `${state.runners.find((r) => r.id === session.runnerId)?.name ?? 'Runner'} · ${session.workspace.branch}`
                : (session.queueReason ?? 'No worktree provisioned')}
              {session.assignment && ` · ${session.assignment.state}`}
            </p>
            {runtimeAvailable ? (
              <SessionControls
                session={session}
                state={state}
                showWorkflowInteraction={false}
                runtimeAvailable={runtimeAvailable}
                openRecovery={focusRecovery}
                onOpenTicketMessages={onOpenTicketMessages}
                onOpenWorkflowRun={onOpenWorkflowRun}
              />
            ) : (
              <p role="status">Reconnect to refresh before changing this session.</p>
            )}
          </details>
        </>
      )}
      {!active && !busy && (
        <details className="execution-setup" open={!session?.flow}>
          <summary>{session?.flow ? 'Run again' : 'Run this ticket'}</summary>
          <div className="execution-fields">
            <label>
              Profile
              <ProfilePicker
                state={state}
                value={profile}
                emptyLabel="Workflow / session / project default"
                onChange={setProfile}
                disabled={working || pendingRequest}
              />
            </label>
            <label>
              Workflow
              <Select
                aria-label="Run workflow"
                value={workflow}
                disabled={working || pendingRequest}
                onChange={(e) => setWorkflow(e.target.value)}
              >
                <option value="" disabled>
                  Choose workflow
                </option>
                {versions.map((w) => (
                  <option key={w.id} value={`${w.id}@${w.version}`}>
                    {w.name} · v{w.version}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Agent session
              <Select
                aria-label="Execution session"
                value={target}
                disabled={working || pendingRequest}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setEnvironment('inherit');
                }}
              >
                <option value="new">New session · fresh context</option>
                {eligible.map((s) => (
                  <option key={s.id} value={s.id}>
                    Continue · {s.title}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Environment
              <Select
                aria-label="Execution environment"
                value={fixed ? 'inherit' : environment}
                disabled={fixed || working || pendingRequest}
                onChange={(e) => setEnvironment(e.target.value)}
              >
                <option value="inherit">
                  {fixed ? 'Keep existing worktree' : 'Ticket / project default'}
                </option>
                <option value="none">Text only · no filesystem</option>
                {state.runnerPools.map((p) => (
                  <option key={p.id} value={`pool:${p.id}`}>
                    Pool · {p.name}
                  </option>
                ))}
                {state.runners
                  .filter((r) => r.enabled && r.projectIds.includes(ticket.projectId))
                  .map((r) => (
                    <option key={r.id} value={`runner:${r.id}`}>
                      {r.name} ·{' '}
                      {state.environments.find((e) => e.id === r.environmentId)?.name ?? r.kind}
                      {!r.online ? ' · offline' : ''}
                    </option>
                  ))}
              </Select>
            </label>
            <label>
              Model
              <Select
                aria-label="Execution model"
                value={model}
                disabled={working || pendingRequest}
                onChange={(e) => setModel(e.target.value)}
              >
                {state.models.map((m) => (
                  <option key={m.id}>{m.id}</option>
                ))}
              </Select>
            </label>
          </div>
          <details className="execution-evidence">
            <summary>
              Capabilities ·{' '}
              {effectiveProfile
                ? `${effectiveProfile.name} v${effectiveProfile.version}`
                : 'Legacy defaults'}
            </summary>
            {profileError && <p role="alert">{profileError}</p>}
            {!!missingSkills.length && !profileError && (
              <p>Skills unavailable with legacy defaults: {missingSkills.join(', ')}</p>
            )}
            {effectiveProfile && (
              <>
                <p>
                  Tools:{' '}
                  {effectiveProfile.tools
                    .map(
                      (ref) =>
                        state.capabilities?.tools.find((tool) => tool.id === ref.id)?.name ??
                        ref.id,
                    )
                    .join(', ') || 'None'}
                </p>
                <p>
                  Skills:{' '}
                  {effectiveProfile.skills
                    .map((skill) => `${skill.name} v${skill.version}`)
                    .join(', ') || 'None'}
                </p>
              </>
            )}
          </details>
          <p className="execution-note">
            {target === 'new'
              ? 'Uses the ticket description as context. Prior conversation history and worktrees are not copied.'
              : 'Keeps this conversation’s context and existing worktree.'}
          </p>
          {!state.auth.connected && (
            <p role="status">Connect your provider account in Chat before starting.</p>
          )}
          <button
            className="primary"
            disabled={
              working || !runtimeAvailable || !workflow || !!profileError || !state.auth.connected
            }
            onClick={() => void launch()}
          >
            <Play size={14} />
            {working ? 'Starting…' : pendingRequest ? 'Retry same run request' : 'Run ticket'}
          </button>
          {pendingRequest && !working && (
            <button
              className="secondary"
              onClick={() => {
                request.current = '';
                setPendingRequest(false);
              }}
            >
              Change launch settings
            </button>
          )}
        </details>
      )}
    </section>
  );
}
