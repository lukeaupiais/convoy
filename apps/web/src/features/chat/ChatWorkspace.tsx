import { useState } from 'react';
import { Search, Link2, MoreHorizontal, Settings } from 'lucide-react';
import { Select } from '../../shared/ui/Select';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';
import type { RuntimeState } from '../../shared/api/runtime';
import { SessionChat } from './SessionChat';
import './chat-experience.css';

export function ChatWorkspace({
  state,
  selectedId,
  select,
  create,
  openTicket,
  openWorkflowRun,
  openProviders,
}: {
  state: RuntimeState;
  selectedId: string;
  select: (id: string) => void;
  create: () => void;
  openTicket: (id: number) => void;
  openWorkflowRun?: (runId: string) => void;
  openProviders: () => void;
}) {
  const [query, setQuery] = useState('');
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const ticketPopover = useDetailsPopover();
  const conversationMenu = useDetailsPopover();
  const [settingsRequest, setSettingsRequest] = useState({ sessionId: '', sequence: 0 });
  const conversations = state.conversations ?? [];
  const current =
    conversations.find((c) => c.id === selectedId) ?? (!selectedId ? conversations[0] : undefined);
  const tickets = state.tickets.filter((t) => current?.linkedTicketIds.includes(t.id));
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
                onClick={() => select(c.id)}
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
              </div>
              <div className="mobile-conversation-select">
                <Select
                  aria-label="Select conversation"
                  value={current.id}
                  onChange={(e) => select(e.target.value)}
                >
                  {conversations.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="conversation-run-controls" ref={setHeaderTarget} />
              <details className="conversation-menu" ref={conversationMenu}>
                <summary aria-label="Conversation menu" title="Conversation menu">
                  <MoreHorizontal size={18} />
                </summary>
                <div className="conversation-menu-content">
                  <button
                    type="button"
                    onClick={() => {
                      conversationMenu.current?.removeAttribute('open');
                      conversationMenu.current?.querySelector<HTMLElement>('summary')?.focus();
                      setSettingsRequest((previous) => ({
                        sessionId: current.sessionId,
                        sequence: previous.sequence + 1,
                      }));
                    }}
                  >
                    <Settings size={15} /> Settings
                  </button>
                  {tickets.length > 0 && (
                    <details ref={ticketPopover} className="linked-work">
                      <summary title="Related tickets">
                        <Link2 size={15} /> Related tickets
                      </summary>
                      <div className="linked-work-content">
                        {tickets.map((ticket) => (
                          <button
                            type="button"
                            className="related-ticket-link"
                            key={ticket.id}
                            title={`CVY-${ticket.id} · ${ticket.title}`}
                            onClick={() => {
                              if (ticketPopover.current) ticketPopover.current.open = false;
                              if (conversationMenu.current) conversationMenu.current.open = false;
                              conversationMenu.current
                                ?.querySelector<HTMLElement>('summary')
                                ?.focus();
                              openTicket(ticket.id);
                            }}
                          >
                            CVY-{ticket.id} · {ticket.title}
                          </button>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </details>
            </header>
            <SessionChat
              key={current.sessionId}
              sessionId={current.sessionId}
              headerTarget={headerTarget}
              settingsRequest={
                settingsRequest.sessionId === current.sessionId ? settingsRequest.sequence : 0
              }
              openTicket={openTicket}
              openConversation={select}
              openWorkflowRun={openWorkflowRun}
              openProviders={openProviders}
            />
          </>
        )}
      </div>
    </section>
  );
}
