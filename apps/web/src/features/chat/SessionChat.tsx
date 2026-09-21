import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Copy, X, SlidersHorizontal } from 'lucide-react';
import { Select } from '../../shared/ui/Select';
import { MessageText } from './MessageText';
import {
  command,
  owns,
  useRuntime,
  type ContextFile,
  type RuntimeAction,
} from '../../shared/api/runtime';
import { AttachmentComposer, AttachmentList } from './ChatAttachments';
import { AuthControls } from '../providers';
import { SessionControls } from '../sessions';
import './chat.css';
import { copyText, newId } from '../../shared/lib/browser';
import { AgentMark } from '../../shared/ui/AgentMark';
import { useSessionStream } from './useSessionStream';
import { ChatWorkspaceContext } from './ChatWorkspaceContext';
import { buildTimeline } from './activity';
import { ToolGroup, InlineQuestion } from './ToolActivity';
import { AgentRunBar } from './AgentRunBar';
import { ChangeReview } from './ChangeReview';
type Note = { id: string; text: string; createdAt: string };
function load(key: string): { messages: Note[]; draft: string; attachments: ContextFile[] } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && Array.isArray(value.messages) && typeof value.draft === 'string')
      return { ...value, attachments: Array.isArray(value.attachments) ? value.attachments : [] };
  } catch {}
  return { messages: [], draft: '', attachments: [] };
}
export function SessionChat({
  sessionId: taskId,
  openTicket,
  openConversation,
}: {
  sessionId: string;
  openTicket: (id: number) => void;
  openConversation: (id: string) => void;
}) {
  const key = `convoy.chat.v1.${taskId}`;
  const [local, setLocal] = useState(() => load(key));
  const { state, error: connectionError } = useRuntime();
  const { session, connection } = useSessionStream(
    taskId,
    state?.sessions.find((s) => s.id === String(taskId)),
  );
  const [model, setModel] = useState('gpt-5.6-sol');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const retry = useRef({ text: '', mode: '', id: '' });
  const owned = owns(session);
  const [attaching, setAttaching] = useState(false);
  const hasInput = !!local.draft.trim() || !!local.attachments.length;
  const resumeId = useRef('');
  const [reviewed, setReviewed] = useState(false);
  const busy =
    session &&
    ['queued', 'running', 'waiting_approval', 'waiting_question'].includes(session.status);
  const workflowManaged =
    !!session?.workflow && !['completed', 'cancelled'].includes(session.flow?.status ?? '');
  const running = !!session?.control?.busy || !!busy;
  const stopping = !!session?.control?.stopping;
  const canMessage = session?.control?.canMessage ?? !workflowManaged;
  const stopped =
    !!session &&
    (['interrupted', 'failed', 'paused', 'awaiting_submission'].includes(session.status) ||
      (!!session.pendingMessages?.some((m) => m.held) && !running));
  const canResume = stopped && !running && !stopping && session?.assignment?.state !== 'uncertain';
  const status = stopping
    ? 'Stopping…'
    : session?.assignment?.state === 'uncertain'
      ? 'Needs inspection'
      : session?.pending
        ? 'Waiting for approval'
        : session?.pendingQuestion
          ? 'Waiting for your answer'
          : session?.flow?.status === 'waiting_gate'
            ? 'Waiting for review'
            : session?.status === 'queued'
              ? 'Queued for a runner'
              : running
                ? 'Working'
                : stopped
                  ? session?.status === 'failed'
                    ? 'Failed'
                    : 'Stopped'
                  : session?.events.some((e) => e.type === 'assistant')
                    ? 'Finished'
                    : 'Ready';
  const [viewSession, setViewSession] = useState('all');
  const [controlsOpen, setControlsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const optionsDialog = useRef<HTMLDialogElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (controlsOpen) optionsDialog.current?.showModal();
    else optionsDialog.current?.close();
  }, [controlsOpen]);
  useEffect(() => {
    const input = composerInput.current;
    if (input) {
      input.style.height = '0px';
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    }
  }, [local.draft]);
  const follow = useRef(true);
  const [newActivity, setNewActivity] = useState(false);
  const visibleActive = viewSession === 'all' || viewSession === session?.currentAgentSessionId;
  const timeline = session
    ? buildTimeline(
        session.events.filter(
          (e) => viewSession === 'all' || !e.agentSessionId || e.agentSessionId === viewSession,
        ),
        visibleActive ? session : { ...session, pending: null },
      )
    : [];
  const timelineTools = timeline.flatMap((item) => (item.kind === 'tools' ? item.tools : []));
  useEffect(() => {
    if (session?.model) setModel(session.model);
  }, [session?.id, session?.model]);
  useEffect(() => setReviewed(false), [session?.interruption?.at]);
  useEffect(() => {
    if (
      [
        'waiting_gate',
        'awaiting_continue',
        'awaiting_submission',
        'failed',
        'interrupted',
      ].includes(session?.flow?.status ?? '')
    )
      setControlsOpen(true);
  }, [session?.flow?.status]);

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(local));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [key, local]);
  useEffect(() => {
    if (!owned) return;
    const timer = setInterval(() => {
      void command('heartbeat', { sessionId: taskId }).catch(() => {});
    }, 25000);
    return () => clearInterval(timer);
  }, [owned, taskId]);
  useEffect(() => {
    const pane = scroll.current;
    if (!pane) return;
    if (follow.current) pane.scrollTop = pane.scrollHeight;
    else setNewActivity(true);
  }, [session?.events.length, session?.partial]);
  async function send(mode: 'queue' | 'interrupt' = 'queue') {
    const text = local.draft.trim();
    if (!hasInput || attaching || !canMessage || stopping || submitting || !state?.auth.connected)
      return;
    setSubmitting(true);
    setError('');
    follow.current = true;
    setNewActivity(false);
    const attachmentIds = local.attachments.map((f) => f.id);
    const fingerprint = JSON.stringify([text, model, attachmentIds]);
    if (retry.current.text !== fingerprint || retry.current.mode !== mode)
      retry.current = { text: fingerprint, mode, id: newId() };
    try {
      if (!owned) await command('claim', { sessionId: taskId, label: 'Web chat' });
      await command('sendMessage', {
        sessionId: taskId,
        model,
        text,
        mode,
        attachmentIds,
        requestId: retry.current.id,
      });
      setLocal((s) => ({
        ...s,
        draft: s.draft.trim() === text ? '' : s.draft,
        attachments: s.attachments.filter((f) => !attachmentIds.includes(f.id)),
      }));
      retry.current = { text: '', mode: '', id: '' };
      if (window.matchMedia('(max-width:800px)').matches) setControlsOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function control(action: RuntimeAction, input: object = {}) {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      if (!owned) await command('claim', { sessionId: taskId, label: 'Web chat' });
      await command(action, { sessionId: taskId, ...input });
      if (action === 'resumeSession') resumeId.current = '';
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }
  async function reviewChanges() {
    if (!session?.workspace || reviewing || running) return;
    setReviewOpen(true);
    setReviewing(true);
    setError('');
    try {
      if (!owned) await command('claim', { sessionId: taskId, label: 'Web chat' });
      await command('diff', { sessionId: taskId });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewing(false);
    }
  }
  return (
    <section className="session-chat" aria-label={`Conversation ${taskId}`}>
      {session && state && (
        <AgentRunBar
          session={session}
          state={state}
          tools={timelineTools}
          status={status}
          running={running}
          stopping={stopping}
          working={submitting}
          onStop={() => void control('stop')}
          onReview={() => void reviewChanges()}
        />
      )}
      <div className="chat-context-bar">
        {session && state && <ChatWorkspaceContext session={session} state={state} />}
        <button
          type="button"
          className="chat-options-toggle"
          aria-label="Chat settings"
          title="Chat settings"
          onClick={() => setControlsOpen(true)}
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>
      <dialog
        ref={optionsDialog}
        className="chat-options-dialog"
        role="dialog"
        aria-label="Chat settings"
        onClose={() => setControlsOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setControlsOpen(false);
        }}
      >
        <header>
          <h2>Chat settings</h2>
          <button
            type="button"
            aria-label="Close chat settings"
            onClick={() => setControlsOpen(false)}
          >
            <X size={18} />
          </button>
        </header>
        {state && <AuthControls state={state} />}
        {state && (
          <div className="runtime-toolbar runtime-info">
            <button
              className="secondary"
              disabled={submitting || !!busy || !state.auth.connected}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await command('probeModel', { model });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              Test model access
            </button>
            <span>
              {state.modelChecks?.[model]
                ? `${state.modelChecks[model].available ? 'Available at last check' : 'Last check failed'} · ${new Date(state.modelChecks[model].checkedAt).toLocaleTimeString()}`
                : 'A model test uses a small amount of subscription quota.'}
            </span>
          </div>
        )}
        {session && state && <SessionControls session={session} state={state} inlineChat />}
        {!!session?.agentSessions?.length && (
          <label className="runtime-toolbar">
            Inspect session
            <Select
              aria-label="Inspect agent session"
              value={viewSession}
              onChange={(e) => setViewSession(e.target.value)}
            >
              <option value="all">All sessions</option>
              {session.agentSessions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.id === session.currentAgentSessionId ? ' · active' : ''}
                </option>
              ))}
            </Select>
          </label>
        )}
        {!!session?.events.length && (
          <details className="chat-activity">
            <summary>Diagnostics</summary>
            {session.events
              .filter(
                (e) =>
                  viewSession === 'all' || !e.agentSessionId || e.agentSessionId === viewSession,
              )
              .map((e) => (
                <details className="runtime-event" key={e.seq}>
                  <summary>
                    {e.type.replaceAll('_', ' ')} {e.tool ?? ''}
                  </summary>
                  <pre>{JSON.stringify(e.output ?? e, null, 2)}</pre>
                </details>
              ))}
          </details>
        )}
      </dialog>
      {session && (
        <ChangeReview
          open={reviewOpen}
          session={session}
          refreshing={reviewing}
          onRefresh={() => void reviewChanges()}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {viewSession !== 'all' && (
        <div className="chat-history-filter">
          Viewing{' '}
          {session?.agentSessions?.find((a) => a.id === viewSession)?.name ?? 'another agent'}
          <button onClick={() => setViewSession('all')}>Show all</button>
        </div>
      )}
      <div
        className="chat-transcript"
        ref={scroll}
        role="log"
        aria-label="Conversation messages"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={(e) => {
          const p = e.currentTarget;
          follow.current = p.scrollHeight - p.scrollTop - p.clientHeight < 80;
          if (follow.current) setNewActivity(false);
        }}
      >
        {local.messages.length > 0 && (
          <details className="chat-context">
            <summary>{local.messages.length} earlier local notes · never sent</summary>
            {local.messages.map((m) => (
              <p key={m.id}>{m.text}</p>
            ))}
          </details>
        )}
        {!session?.events.some((e) => e.type === 'user') && (
          <div className="chat-empty">
            <AgentMark id={taskId} />
            <h3>What’s on your mind?</h3>
            {state && !state.auth.connected && (
              <button className="secondary" onClick={() => setControlsOpen(true)}>
                Connect account
              </button>
            )}
          </div>
        )}
        {timeline.map((item) => {
          if (item.kind === 'tools')
            return (
              <ToolGroup
                key={item.key}
                tools={item.tools}
                session={session!}
                working={submitting}
                act={control}
              />
            );
          const e = item.event;
          return ['user', 'assistant', 'assistant_interrupted'].includes(e.type) ? (
            <article className={`chat-message message-${e.type}`} key={e.seq}>
              <div className="chat-message-avatar">{e.type === 'user' ? 'You' : 'A'}</div>
              <div className="chat-message-body">
                <div className="chat-message-meta">
                  {e.type === 'assistant' && <AgentMark id={e.agentSessionId ?? taskId} />}
                  <strong>{e.type === 'user' ? 'You' : 'Convoy'}</strong>
                </div>
                {e.type === 'assistant_interrupted' && <small>Interrupted response</small>}
                {e.text && (e.type === 'user' ? <p>{e.text}</p> : <MessageText text={e.text} />)}
                {!!e.attachments?.length && (
                  <AttachmentList sessionId={taskId} files={e.attachments} />
                )}
                <button
                  className="copy-message"
                  aria-label="Copy message"
                  title="Copy message"
                  onClick={() =>
                    copyText(e.text ?? '').catch(() => setError('Clipboard unavailable.'))
                  }
                >
                  <Copy size={14} />
                </button>
              </div>
            </article>
          ) : e.type === 'ticket_linked' && e.ticketId ? (
            <div className="inline-ticket" key={e.seq}>
              <button onClick={() => openTicket(e.ticketId!)}>
                CVY-{e.ticketId} ·{' '}
                {state?.tickets.find((t) => t.id === e.ticketId)?.title ?? e.title}
              </button>
            </div>
          ) : e.type === 'delegation_result' ? (
            <div className="inline-ticket agent-update" key={e.seq}>
              <small>Agent completed delegated work</small>
              <button onClick={() => e.conversationId && openConversation(e.conversationId)}>
                CVY-{e.ticketId} · Agent update
              </button>
              <p>{e.summary}</p>
            </div>
          ) : (
            <p className="chat-execution-error" role="status" key={e.seq}>
              {e.message}
            </p>
          );
        })}
        {visibleActive && session && (
          <InlineQuestion session={session} working={submitting} act={control} />
        )}
        {visibleActive && busy && !session?.pending && !session?.pendingQuestion && (
          <article className="chat-message streaming-message" aria-label="Agent response streaming">
            <div className="chat-message-body">
              <div className="chat-message-meta">
                <AgentMark
                  id={session?.currentAgentSessionId ?? taskId}
                  active={session?.status === 'running'}
                />
                <strong>Convoy</strong>
              </div>
              {session?.partial ? (
                <MessageText text={session.partial} />
              ) : (
                <p>{stopping ? 'Stopping…' : 'Working…'}</p>
              )}
            </div>
          </article>
        )}
      </div>
      <div className="chat-composer-area">
        {newActivity && (
          <button
            type="button"
            className="chat-latest"
            onClick={() => {
              follow.current = true;
              setNewActivity(false);
              if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
            }}
          >
            ↓ Latest activity
          </button>
        )}
        {connection === 'reconnecting' && (
          <small className="chat-stream-state" role="status">
            Reconnecting live feed · showing saved state
          </small>
        )}
        {(running || stopped || workflowManaged || session?.assignment?.state === 'uncertain') && (
          <div className="chat-run-status">
            <span role="status">
              <i className={running ? 'working' : ''} />
              {status}
            </span>
            {(running || (workflowManaged && !stopped)) && (
              <button
                type="button"
                className="secondary"
                disabled={submitting || stopping}
                onClick={() => void control('stop')}
              >
                Stop
              </button>
            )}
            {canResume && (
              <button
                type="button"
                className="secondary"
                disabled={submitting || (!!session?.interruption?.needsReview && !reviewed)}
                onClick={() => {
                  resumeId.current ||= newId();
                  void control('resumeSession', {
                    requestId: resumeId.current,
                    acknowledge: reviewed,
                  });
                }}
              >
                Resume
              </button>
            )}
          </div>
        )}
        {stopped && session?.interruption && (
          <div className="chat-interruption" role="status">
            <p>{session.interruption.reason}</p>
            {session.interruption.lastCompletedTool && (
              <small>Last completed tool: {session.interruption.lastCompletedTool}</small>
            )}
            {session.interruption.needsReview && (
              <label>
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => {
                    setReviewed(e.target.checked);
                    resumeId.current = '';
                  }}
                />
                I inspected the {session.interruption.tool ?? 'interrupted'} operation and any
                partial effects.
              </label>
            )}
            {session.assignment?.state === 'uncertain' && (
              <p>Reconcile the original runner in Session controls before resuming.</p>
            )}
          </div>
        )}
        {!!session?.pendingMessages?.length && (
          <div className="chat-pending" aria-label="Queued messages">
            {session.pendingMessages.map((m) => (
              <div key={m.id}>
                <div>
                  <small>{m.held ? 'Held · resume to send' : 'Queued · next turn'}</small>
                  <p>{m.text}</p>
                  {!!m.attachments?.length && (
                    <AttachmentList sessionId={taskId} files={m.attachments} />
                  )}{' '}
                  {m.reason && m.held && <small>{m.reason}</small>}
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove queued message: ${m.text.slice(0, 40) || m.attachments?.[0]?.name}`}
                  disabled={submitting}
                  onClick={() => void control('discardMessage', { requestId: m.id })}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {(error || connectionError) && (
          <div className="chat-error" role="alert">
            {error || connectionError}
          </div>
        )}
        <AttachmentComposer
          sessionId={taskId}
          files={local.attachments}
          onChange={(attachments) => setLocal((s) => ({ ...s, attachments }))}
          onError={setError}
          onBusy={setAttaching}
          disabled={submitting || stopping || !canMessage}
          workspace={!!session?.workspace}
        >
          {(toolbar) => (
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={composerInput}
                aria-label="Message"
                placeholder={
                  !canMessage
                    ? 'Review the workflow in Chat settings.'
                    : running
                      ? 'Add direction for the next turn…'
                      : 'Message Convoy…'
                }
                value={local.draft}
                maxLength={12000}
                rows={1}
                onChange={(e) => setLocal((s) => ({ ...s, draft: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-bottom">
                {toolbar}
                <Select
                  className="chat-model-picker"
                  aria-label="Chat model"
                  value={model}
                  disabled={running || stopping}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {state?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  )) ?? <option>{model}</option>}
                </Select>
                {running && hasInput && canMessage && (
                  <button
                    type="button"
                    className="interrupt-send"
                    disabled={submitting || attaching || stopping || !state?.auth.connected}
                    onClick={() => void send('interrupt')}
                  >
                    Steer now
                  </button>
                )}
                {running && <small className="composer-send-mode">Enter queues next</small>}
                <button
                  type="submit"
                  className="chat-send"
                  disabled={
                    !canMessage ||
                    !hasInput ||
                    attaching ||
                    stopping ||
                    submitting ||
                    !state?.auth.connected
                  }
                  aria-label={running ? 'Queue message' : 'Send message'}
                  title={running ? 'Queue for the next turn' : 'Send message'}
                >
                  <ArrowUp size={17} />
                </button>
              </div>
            </form>
          )}
        </AttachmentComposer>
        {storageError && (
          <div className="chat-disclaimer" role="status">
            Browser storage unavailable; drafts may not persist.
          </div>
        )}
      </div>
    </section>
  );
}
