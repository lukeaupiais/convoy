import { useEffect, useState } from 'react';
import { Search, Link2, ArrowUpRight } from 'lucide-react';
import { Select } from '../../shared/ui/Select';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';
import { command, type RuntimeAction } from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';
import type { RuntimeState, Ticket } from '../../shared/api/runtime';
import { SessionChat } from './SessionChat';
import './chat-experience.css';

export function ChatWorkspace({
  state,
  selectedId,
  select,
  create,
  openTicket,
}: {
  state: RuntimeState;
  selectedId: string;
  select: (id: string) => void;
  create: () => void;
  openTicket: (id: number) => void;
}) {
  const [query, setQuery] = useState('');
  const ticketPopover = useDetailsPopover();
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [target, setTarget] = useState('');
  const [execution, setExecution] = useState<{ ticket: Ticket; mode: string } | null>(null);
  const [brief, setBrief] = useState('');
  const conversations = state.conversations ?? [];
  const current =
    conversations.find((c) => c.id === selectedId) ?? (!selectedId ? conversations[0] : undefined);
  useEffect(() => {
    setExecution(null);
    setError('');
    setTarget('');
  }, [current?.id]);
  const session = state.sessions.find((s) => s.id === current?.sessionId);
  const tickets = state.tickets.filter((t) => current?.linkedTicketIds.includes(t.id));
  const active = tickets.find((t) => t.id === session?.activeTicketId);
  const busy =
    working ||
    (!!session &&
      ['running', 'queued', 'waiting_approval', 'waiting_question'].includes(session.status));
  async function act(action: RuntimeAction, data: object) {
    if (!session) return;
    setWorking(true);
    setError('');
    try {
      await command('claim', { sessionId: session.id, label: 'Web chat' });
      await command(action, { sessionId: session.id, ...data });
      setExecution(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="chat-workspace" aria-label="Chat">
      <aside className="conversation-list">
        <div className="conversation-heading">Conversations</div>
        <div className="conversation-search">
          <Search size={14} />
          <input
            aria-label="Search conversations"
            placeholder="Search chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="conversation-items">
          {[...conversations]
            .sort((a, b) => {
              const attention = (id: string) => {
                const status = state.sessions.find((session) => session.id === id)?.status;
                return ['waiting_approval', 'waiting_question'].includes(status ?? '')
                  ? 0
                  : ['running', 'queued'].includes(status ?? '')
                    ? 1
                    : 2;
              };
              return (
                attention(a.sessionId) - attention(b.sessionId) ||
                (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
              );
            })
            .filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
            .map((c) => (
              <button
                key={c.id}
                className={c.id === current?.id ? 'selected' : ''}
                aria-label={c.title}
                aria-pressed={c.id === current?.id}
                onClick={() => {
                  select(c.id);
                  setExecution(null);
                  setError('');
                }}
              >
                {(() => {
                  const conversationSession = state.sessions.find(
                    (session) => session.id === c.sessionId,
                  );
                  const live = ['running', 'queued'].includes(conversationSession?.status ?? '');
                  const attention = ['waiting_approval', 'waiting_question'].includes(
                    conversationSession?.status ?? '',
                  );
                  return (
                    <span
                      className={`conversation-state${live ? ' is-live' : ''}${attention ? ' needs-attention' : ''}`}
                      aria-label={attention ? 'Needs attention' : live ? 'Working' : 'Idle'}
                    />
                  );
                })()}
                <strong>{c.title}</strong>
                <small>
                  {(() => {
                    const conversationSession = state.sessions.find(
                      (session) => session.id === c.sessionId,
                    );
                    if (conversationSession?.status === 'waiting_approval')
                      return 'Approval needed';
                    if (conversationSession?.status === 'waiting_question')
                      return 'Question waiting';
                    if (['running', 'queued'].includes(conversationSession?.status ?? ''))
                      return 'Working';
                    return (
                      state.projects.find((p) => p.id === c.projectId)?.name ?? 'Personal chat'
                    );
                  })()}
                </small>
              </button>
            ))}
          {query &&
            !conversations.some((c) => c.title.toLowerCase().includes(query.toLowerCase())) && (
              <p className="conversation-no-results">No conversations found.</p>
            )}
        </div>
      </aside>
      <div className="conversation-main">
        {!current ? (
          <div className="chat-empty">
            <h3>{selectedId ? 'Opening conversation…' : 'What shall we work on?'}</h3>
            {!selectedId && (
              <>
                <button className="secondary" onClick={create}>
                  New chat
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <header className="conversation-header">
              <div className="conversation-title">
                <h1 title={current.title}>{current.title}</h1>
                {active && (
                  <button className="assignment-chip" onClick={() => openTicket(active.id)}>
                    CVY-{active.id}
                    <ArrowUpRight size={12} />
                  </button>
                )}
              </div>
              <div className="mobile-conversation-select">
                <Select
                  aria-label="Select conversation"
                  value={current.id}
                  onChange={(e) => {
                    select(e.target.value);
                    setExecution(null);
                    setError('');
                  }}
                >
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </div>
              <details ref={ticketPopover} className="linked-work">
                <summary title="Linked tickets">
                  <Link2 size={15} />
                  <span>Tickets{tickets.length ? ` · ${tickets.length}` : ''}</span>
                </summary>
                <div className="linked-work-content">
                  {error && (
                    <p role="alert" className="chat-error">
                      {error}
                    </p>
                  )}
                  {tickets.map((t) => {
                    const owner = state.sessions.find((s) => s.activeTicketId === t.id);
                    return (
                      <div className="linked-ticket" key={t.id}>
                        <button onClick={() => openTicket(t.id)}>
                          CVY-{t.id} · {t.title}
                        </button>
                        <span>
                          {t.status}
                          {owner && ' · assigned'}
                        </span>
                        <div>
                          {t.id === session?.activeTicketId ? (
                            <button disabled={busy} onClick={() => void act('releaseTicket', {})}>
                              Release assignment
                            </button>
                          ) : owner ? (
                            <button
                              onClick={() => owner.conversationId && select(owner.conversationId)}
                            >
                              Open assigned agent
                            </button>
                          ) : (
                            <>
                              <button
                                disabled={busy || !!session?.activeTicketId || t.status === 'Done'}
                                onClick={() => {
                                  setExecution({ ticket: t, mode: 'continue' });
                                  setBrief(t.description || t.title);
                                }}
                              >
                                Continue here
                              </button>
                              <button
                                disabled={working || t.status === 'Done'}
                                onClick={() => {
                                  setExecution({ ticket: t, mode: 'delegate' });
                                  setBrief(t.description || t.title);
                                }}
                              >
                                Delegate
                              </button>
                              <button
                                disabled={working}
                                onClick={() =>
                                  void act('requestExecution', { ticketId: t.id, mode: 'queue' })
                                }
                              >
                                Leave queued
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act('linkTicket', { ticketId: Number(target) });
                    }}
                  >
                    <Select
                      aria-label="Ticket to link"
                      required
                      value={target}
                      onChange={(e) => setTarget(e.target.value)}
                    >
                      <option value="">Choose a ticket</option>
                      {state.tickets
                        .filter((t) => !current.linkedTicketIds.includes(t.id))
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            CVY-{t.id} · {t.title}
                          </option>
                        ))}
                    </Select>
                    <button className="secondary" disabled={working || !target}>
                      Link
                    </button>
                  </form>
                  {execution && (
                    <form
                      className="execution-request"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act('requestExecution', {
                          ticketId: execution.ticket.id,
                          mode: execution.mode,
                          brief,
                          requestId: newId(),
                        });
                      }}
                    >
                      <label>
                        {execution.mode === 'delegate'
                          ? 'Handoff brief for another agent'
                          : 'Objective for this agent'}
                        <textarea
                          aria-label="Execution brief"
                          value={brief}
                          onChange={(e) => setBrief(e.target.value)}
                          required
                          maxLength={12000}
                          rows={4}
                        />
                      </label>
                      <p>
                        {execution.mode === 'delegate'
                          ? 'Starts a separate session using ticket placement. Files are not copied from this session.'
                          : 'Keeps this agent, conversation and existing workspace. Conflicting ticket requirements must be delegated.'}
                      </p>
                      <button className="primary" disabled={working || !brief.trim()}>
                        {execution.mode === 'delegate'
                          ? 'Delegate and start'
                          : 'Continue here and start'}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setExecution(null)}
                      >
                        Cancel
                      </button>
                    </form>
                  )}
                </div>
              </details>
            </header>
            <SessionChat
              key={current.sessionId}
              sessionId={current.sessionId}
              openTicket={openTicket}
              openConversation={select}
            />
          </>
        )}
      </div>
    </section>
  );
}
