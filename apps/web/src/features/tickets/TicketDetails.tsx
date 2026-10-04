import { useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import {
  command,
  owns,
  type ContextFile,
  type RuntimeState,
  type RuntimeAction,
  type Ticket,
  type TicketScalar,
} from '../../shared/api/runtime';
import { Select } from '../../shared/ui/Select';
import { ExecutionProfileEditor, PlacementEditor } from '../projects';
import { WorkflowArtifactContent as MarkdownDocument } from '../workflows';
import { WorkflowActivityHistory, WorkflowRunInteraction, requiredGateActivityTarget, workflowHumanTaskActions } from '../workflows';
import { ticketWorkflowActions } from './workflow-actions';
import {
  clearSubmittedTicketReplyDraft,
  forgetTicketReplyRequestId,
  getTicketThreadConnectionSelection,
  selectTicketReplies,
  selectTicketThread,
  setTicketReplyDraft,
  setTicketThreadConnectionSelection,
  ticketReplyDraftKey,
  ticketReplyRequestId,
  ticketThreadScopeKey,
  useTicketReplyDraft,
} from './ticket-thread-state';
import './ticket-details.css';

const fileUrl = (ticketId: number, file: ContextFile) =>
  `/api/tickets/${ticketId}/attachments/${file.id}`;
const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function TicketFiles({
  ticket,
  editing,
  revisionChanged,
}: {
  ticket: Ticket;
  editing: boolean;
  revisionChanged: (revision: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ContextFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(ticket.revision);
  useEffect(() => setRevision(ticket.revision), [ticket.revision]);
  const files = ticket.attachments ?? [];
  async function upload(selected: FileList | null) {
    if (!selected?.length || busy) return;
    setBusy(true);
    setError('');
    let nextRevision = revision;
    try {
      for (const file of Array.from(selected)) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]);
          reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
          reader.readAsDataURL(file);
        });
        const response = await command('attachTicketFile', {
          taskId: ticket.id,
          revision: nextRevision,
          name: file.name,
          mime: file.type || 'text/plain',
          data,
        });
        nextRevision = response.result.revision;
      }
      setRevision(nextRevision);
      revisionChanged(nextRevision);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  async function remove(file: ContextFile) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await command('removeTicketFile', {
        taskId: ticket.id,
        revision,
        attachmentId: file.id,
      });
      setRevision(response.result.revision);
      revisionChanged(response.result.revision);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!editing && !files.length) return null;
  return (
    <section className="ticket-files" aria-label="Attachments">
      <div className="ticket-file-list">
        {files.map((file) => (
          <div className="ticket-file" key={file.id}>
            <button type="button" onClick={() => setPreview(file)}>
              {file.mime.startsWith('image/') ? (
                <img src={fileUrl(ticket.id, file)} alt="" />
              ) : (
                <FileText size={16} />
              )}
              <span>
                <strong>{file.name}</strong>
                <small>{fileSize(file.size)}</small>
              </span>
            </button>
            {editing && (
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                disabled={busy}
                onClick={() => void remove(file)}
              >
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <>
          <input
            ref={input}
            hidden
            type="file"
            multiple
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className="ticket-attach"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <Paperclip size={14} /> {busy ? 'Adding…' : 'Add files'}
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div
          className="ticket-file-preview"
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          onClick={(event) => {
            if (event.target === event.currentTarget) setPreview(null);
          }}
        >
          <section>
            <header>
              <strong>{preview.name}</strong>
              <a href={fileUrl(ticket.id, preview)} download={preview.name}>
                Download
              </a>
              <button aria-label="Close preview" onClick={() => setPreview(null)}>
                <X size={15} />
              </button>
            </header>
            {preview.mime.startsWith('image/') ? (
              <img src={fileUrl(ticket.id, preview)} alt={preview.name} />
            ) : (
              <iframe title={preview.name} src={fileUrl(ticket.id, preview)} />
            )}
          </section>
        </div>
      )}
    </section>
  );
}

export function TicketDetails({
  state,
  ticket,
  runLabel,
  onRun,
  runtimeAvailable = true,
  onSelectTicket,
  onOpenWorkflowRun,
}: {
  state: RuntimeState;
  ticket: Ticket;
  runLabel: string;
  onRun: () => void;
  runtimeAvailable?: boolean;
  onSelectTicket: (id: number) => void;
  onOpenWorkflowRun?: (runId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [description, setDescription] = useState(ticket.description);
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(ticket.revision);
  const [customFields, setCustomFields] = useState<Record<string, TicketScalar>>(() => ({
    ...(ticket.customFields ?? {}),
  }));
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [remoteIssueId, setRemoteIssueId] = useState('');
  const [relatedTicketId, setRelatedTicketId] = useState('');
  const [relatedTitle, setRelatedTitle] = useState('');
  const [relatedBoardId, setRelatedBoardId] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [replyBusyScopes, setReplyBusyScopes] = useState<Set<string>>(() => new Set());
  const replyAttempts = useRef(new Map<string, number>());
  const [showReplyComposer, setShowReplyComposer] = useState(false);
  const initialThreadConnectionId =
    ticket.externalLinks?.find((link) => {
      const connection = state.ticketConnections?.find((source) => source.id === link.connectionId);
      return (
        connection?.enabled &&
        (connection.capabilities?.threadRead || connection.capabilities?.reply)
      );
    })?.connectionId ?? '';
  const ticketScopeKey = ticketThreadScopeKey(state.deployment?.id, state.activeContext, ticket.id);
  const [, forceThreadSelectionRender] = useState(0);
  const selectedThreadConnectionId = getTicketThreadConnectionSelection(
    ticketScopeKey,
    initialThreadConnectionId,
  );
  const chooseThreadConnection = (connectionId: string) => {
    setTicketThreadConnectionSelection(ticketScopeKey, connectionId);
    forceThreadSelectionRender((version) => version + 1);
  };
  const ticketScopeRef = useRef(ticketScopeKey);
  ticketScopeRef.current = ticketScopeKey;
  const [workflowWorking, setWorkflowWorking] = useState(false);
  const related = (state.ticketRelations ?? []).flatMap((relation) => {
    const otherId =
      relation.sourceTicketId === ticket.id
        ? relation.targetTicketId
        : relation.targetTicketId === ticket.id
          ? relation.sourceTicketId
          : null;
    const other = state.tickets.find((value) => value.id === otherId);
    return other ? [{ relation, other }] : [];
  });
  const availableRelatedTickets = state.tickets.filter(
    (value) =>
      value.id !== ticket.id &&
      value.projectId === ticket.projectId &&
      !related.some((item) => item.other.id === value.id),
  );
  const projectBoards = state.boards.filter(
    (board) =>
      board.projectIds.includes(ticket.projectId) &&
      !board.filters.importBindingIds?.length &&
      (!board.filters.origins?.length || board.filters.origins.includes('convoy')) &&
      (!board.filters.workTypes?.length ||
        board.filters.workTypes.includes(board.creationWorkType ?? 'task')),
  );
  const threadSources = (ticket.externalLinks ?? []).flatMap((link) => {
    const connection = state.ticketConnections?.find((source) => source.id === link.connectionId);
    return connection?.enabled &&
      (connection.capabilities?.threadRead || connection.capabilities?.reply)
      ? [{ link, connection }]
      : [];
  });
  const selectedThreadConnectionIdForView = selectedThreadConnectionId;
  const selectedThreadSource = (ticket.externalLinks ?? []).find(
    (link) => link.connectionId === selectedThreadConnectionIdForView,
  );
  const selectedThreadConnection = state.ticketConnections?.find(
    (source) => source.id === selectedThreadConnectionIdForView,
  );
  const thread = selectedThreadConnectionIdForView
    ? selectTicketThread(state.ticketThreads ?? [], ticket.id, selectedThreadConnectionIdForView)
    : undefined;
  const replies = selectedThreadConnectionIdForView
    ? selectTicketReplies(state.ticketReplies ?? [], ticket.id, selectedThreadConnectionIdForView)
    : [];
  const uncertainReply = replies.find((value) =>
    ['pending', 'outcome-unknown'].includes(value.status),
  );
  const canReadThread = Boolean(
    selectedThreadSource &&
    selectedThreadConnection?.enabled &&
    selectedThreadConnection.capabilities?.threadRead,
  );
  const canReply = Boolean(
    selectedThreadSource &&
    selectedThreadConnection?.enabled &&
    selectedThreadConnection.capabilities?.reply,
  );
  const sourceLink = ticket.externalLinks?.[0];
  const sourceName = sourceLink
    ? (state.ticketConnections?.find((source) => source.id === sourceLink.connectionId)?.name ??
      sourceLink.provider)
    : undefined;
  const hasActivity = Boolean(
    threadSources.length ||
    selectedThreadConnectionIdForView ||
    thread?.messages.length ||
    replies.length,
  );
  const draftKey = ticketReplyDraftKey(
    state.deployment?.id,
    state.activeContext,
    ticket.id,
    selectedThreadConnectionIdForView,
  );
  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const replyDraft = useTicketReplyDraft(draftKey);
  const replyBusy = replyBusyScopes.has(draftKey);
  const descriptionIsLong =
    ticket.description.length > 480 || ticket.description.split(/\r?\n/).length > 8;
  const statusBoards = state.boards.filter(
    (board) =>
      board.tickets.some((placement) => placement.ticketId === ticket.id) &&
      board.grouping.mode === 'field' &&
      board.grouping.field === 'status',
  );
  const statusChoices = [
    ...new Set([
      ...statusBoards.flatMap((board) =>
        board.columns.map((column) => column.value ?? column.name),
      ),
      ticket.status,
    ]),
  ];
  const sourceOwnsStatus = ticket.externalLinks?.some(
    (link) => link.fieldOwnership?.status === 'external',
  );
  const availableConnections = (state.ticketConnections ?? []).filter(
    (connection) =>
      connection.enabled &&
      connection.organizationId ===
        state.projects.find((project) => project.id === ticket.projectId)?.organizationId &&
      state.boards.some(
        (board) =>
          board.projectIds.includes(ticket.projectId) &&
          board.destinationConnectionIds?.includes(connection.id),
      ),
  );
  const hasDetails = Boolean(
    ticket.externalLinks?.length ||
    ticket.externalPublish ||
    availableConnections.length ||
    ticket.label ||
    Object.keys(ticket.customFields ?? {}).length,
  );
  const session = state.sessions.find(
    (value) => value.id === ticket.executionSessionId && value.activeTicketId === ticket.id,
  );
  const approvalTargetNodeId = session ? requiredGateActivityTarget(session, state.workflowActivities) : undefined;
  const preparedActivityReservation = session?.flow && state.workflowRuns?.find(run => run.id === session.flow?.id)?.activityReservations?.find(value =>
    value.gateNodeId === session.flow?.nodeId && value.gateInstance === session.flow?.instance && value.targetNodeId === approvalTargetNodeId && !value.consumedAt);
  const project = state.projects.find((value) => value.id === ticket.projectId);
  const syncNeedsReview = Boolean(
    ticket.externalPublish || ticket.externalLinks?.some((link) => link.syncState === 'error'),
  );
  useEffect(() => {
    if (!editing) {
      setRevision(ticket.revision);
      setDescription(ticket.description);
    }
  }, [ticket.revision, ticket.description, editing]);
  useEffect(() => setDescriptionExpanded(false), [ticket.id, ticket.description]);
  useEffect(() => {
    if (!getTicketThreadConnectionSelection(ticketScopeKey) && threadSources.length)
      setTicketThreadConnectionSelection(
        ticketScopeKey,
        selectedThreadConnectionId || threadSources[0].link.connectionId,
      );
  }, [
    ticketScopeKey,
    selectedThreadConnectionId,
    threadSources.map(({ link }) => link.connectionId).join('|'),
  ]);
  useEffect(() => {
    if (!session || !owns(session)) return;
    const timer = setInterval(
      () => void command('heartbeat', { sessionId: session.id }).catch(() => {}),
      25000,
    );
    return () => clearInterval(timer);
  }, [session?.id, session?.lease?.client]);
  async function actWorkflow(action: RuntimeAction, input: object = {}) {
    if (!session || workflowWorking) return;
    setWorkflowWorking(true);
    try {
      if (!owns(session))
        await command('claim', { sessionId: session.id, label: 'Ticket workflow' });
      await command(action, { sessionId: session.id, ...input });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorkflowWorking(false);
    }
  }
  async function reconcileReply(
    input: { requestId: string; remoteId?: string; confirmNotPosted?: true },
    successMessage: string,
  ) {
    const scopedKey = draftKey;
    const attempt = (replyAttempts.current.get(scopedKey) ?? 0) + 1;
    replyAttempts.current.set(scopedKey, attempt);
    setReplyBusyScopes((scopes) => new Set(scopes).add(scopedKey));
    try {
      await command('reconcileExternalTicketReply', input);
      if (draftKeyRef.current === scopedKey) setMessage(successMessage);
    } catch (error) {
      if (draftKeyRef.current === scopedKey) setMessage((error as Error).message);
    } finally {
      if (replyAttempts.current.get(scopedKey) === attempt) {
        replyAttempts.current.delete(scopedKey);
        setReplyBusyScopes((scopes) => {
          const next = new Set(scopes);
          next.delete(scopedKey);
          return next;
        });
      }
    }
  }
  const patchField = (key: string, value: TicketScalar) =>
    setCustomFields((fields) => ({ ...fields, [key]: value }));
  function removeField(key: string) {
    setCustomFields((fields) => {
      const next = { ...fields };
      delete next[key];
      return next;
    });
  }
  function addField() {
    const key = newFieldName.trim();
    if (!key || !/^[\w-]{1,80}$/.test(key) || Object.hasOwn(customFields, key)) {
      setFieldError(
        !key
          ? 'Enter a field name.'
          : 'Use a unique name with letters, numbers, hyphens or underscores.',
      );
      return;
    }
    patchField(key, newFieldValue);
    setNewFieldName('');
    setNewFieldValue('');
    setFieldError('');
  }
  if (!editing)
    return (
      <section className="ticket-summary ticket-workspace">
        <header className="ticket-workspace-heading">
          <div>
            <h2>{ticket.title}</h2>
            <span className="ticket-status">{ticket.status}</span>
          </div>
          <button className="secondary" onClick={() => setEditing(true)}>
            Edit
          </button>
        </header>
        {message && (
          <p className="ticket-feedback" role="status">
            {message}
          </p>
        )}
        <div className="ticket-workspace-grid">
          <div className="ticket-workspace-main">
            <section className="ticket-record-content" aria-label="Ticket description">
              <h3>Description</h3>
              {ticket.description ? (
                <>
                  <div
                    id={`ticket-description-${ticket.id}`}
                    className={
                      descriptionIsLong && !descriptionExpanded
                        ? 'ticket-description-collapsed'
                        : undefined
                    }
                  >
                    <MarkdownDocument text={ticket.description} />
                  </div>
                  {descriptionIsLong && (
                    <button
                      type="button"
                      className="ticket-description-toggle"
                      aria-controls={`ticket-description-${ticket.id}`}
                      aria-expanded={descriptionExpanded}
                      onClick={() => setDescriptionExpanded((value) => !value)}
                    >
                      {descriptionExpanded ? 'Show less' : 'Show more'}
                    </button>
                  )}
                </>
              ) : (
                <p className="ticket-empty">No description.</p>
              )}
            </section>
            {session?.flow && (
              <section className="ticket-agent-activity" aria-label="Agent work">
                <WorkflowRunInteraction
                  key={session.id}
                  session={session}
                  activityReservation={preparedActivityReservation}
                  working={workflowWorking || !runtimeAvailable}
                  onRecovery={onRun}
                  onOpenWorkflowRun={onOpenWorkflowRun}
                  actions={{
                    ...ticketWorkflowActions(session, (action, input) => void actWorkflow(action, input)),
                    ...workflowHumanTaskActions(session),
                    requiresActivityReservation: !!approvalTargetNodeId,
                    canPrepareActivityApproval: !!session && runtimeAvailable,
                    canShowPreparedActivityApproval: !!session && owns(session) && runtimeAvailable,
                    approvalControlKey: session && owns(session) ? session.lease?.id : undefined,
                    approvalContextKey: JSON.stringify([state.currentUser?.id, state.activeContext?.id, state.activeContext?.projectId, state.activeContext?.principal]),
                    prepareActivityApproval: approvalTargetNodeId ? async () => {
                      if (!session) throw new Error('Workflow session is unavailable.');
                      if (!owns(session)) await command('claim', { sessionId: session.id, label: 'Ticket workflow' });
                      return (await command('prepareWorkflowActivity', { workflowRunId: session.flow!.id,
                        gateInstance: session.flow!.instance, targetNodeId: approvalTargetNodeId })).result;
                    } : undefined,
                    approveGate: (reservation) => void actWorkflow('approveGate', { instance: session.flow!.instance,
                      ...(reservation ? { activityReservationId: reservation.id, activityReservationDigest: reservation.digest } : {}) }),
                  }}
                />
              </section>
            )}
            {hasActivity && (
              <section
                id={`ticket-messages-${ticket.id}`}
                className="ticket-activity"
                aria-label="Ticket messages"
                tabIndex={-1}
              >
                <div className="ticket-section-heading">
                  <h3>Messages</h3>
                  <div className="ticket-activity-actions">
                    {(threadSources.length > 1 ||
                      (selectedThreadConnectionIdForView &&
                        !threadSources.some(
                          ({ link }) => link.connectionId === selectedThreadConnectionIdForView,
                        ))) && (
                      <label className="ticket-thread-selector">
                        <span>Connection</span>
                        <Select
                          value={selectedThreadConnectionIdForView}
                          onChange={(event) => chooseThreadConnection(event.target.value)}
                        >
                          {selectedThreadConnectionIdForView &&
                            !threadSources.some(
                              ({ link }) => link.connectionId === selectedThreadConnectionIdForView,
                            ) && (
                              <option value={selectedThreadConnectionIdForView}>
                                {selectedThreadConnection?.name ??
                                  selectedThreadSource?.provider ??
                                  selectedThreadConnectionIdForView}{' '}
                                · unavailable
                              </option>
                            )}
                          {threadSources.map(({ link, connection }) => (
                            <option key={link.connectionId} value={link.connectionId}>
                              {connection.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    {canReadThread && (
                      <button
                        className="secondary"
                        disabled={replyBusy || !runtimeAvailable}
                        onClick={async () => {
                          try {
                            await command('syncExternalTicketThread', {
                              ticketId: ticket.id,
                              connectionId: selectedThreadConnectionIdForView,
                            });
                            setMessage('Messages refreshed.');
                          } catch (error) {
                            setMessage((error as Error).message);
                          }
                        }}
                      >
                        Refresh
                      </button>
                    )}
                    {canReply && (
                      <button
                        className="secondary"
                        disabled={!runtimeAvailable}
                        onClick={() => setShowReplyComposer((value) => !value)}
                      >
                        {showReplyComposer ? 'Cancel' : 'Reply'}
                      </button>
                    )}
                  </div>
                </div>
                {!canReadThread && thread?.messages.length ? (
                  <p role="status">Connection unavailable. Showing saved messages.</p>
                ) : null}
                {thread?.messages.map((entry) => (
                  <article className="ticket-message" key={entry.remoteId}>
                    <div>
                      <strong>{entry.authorRole}</strong>
                      <time dateTime={entry.createdAt}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </time>
                      {entry.deliveryStatus && (
                        <span>
                          {entry.deliveryStatus[0].toUpperCase() + entry.deliveryStatus.slice(1)}
                        </span>
                      )}
                    </div>
                    <p>{entry.body}</p>
                  </article>
                ))}
                {replies
                  .filter(
                    (reply) => !thread?.messages.some((entry) => entry.remoteId === reply.remoteId),
                  )
                  .map((reply) => (
                    <article className="ticket-message" key={reply.id}>
                      <div>
                        <strong>Reply</strong>
                        {reply.createdAt && (
                          <time dateTime={reply.createdAt}>
                            {new Date(reply.createdAt).toLocaleString()}
                          </time>
                        )}
                        <span>{reply.deliveryStatus ?? reply.status}</span>
                      </div>
                      <p>{reply.body}</p>
                    </article>
                  ))}
                {!thread?.messages.length && !replies.length && (
                  <p className="ticket-empty">
                    {thread ? 'No messages yet.' : 'Messages not loaded.'}
                  </p>
                )}
                {selectedThreadConnectionIdForView &&
                  (canReply || replyDraft.text) &&
                  (showReplyComposer || replyDraft.text) && (
                    <div className="ticket-reply-composer">
                      <p className="ticket-reply-destination">
                        {canReply
                          ? `Sending through ${selectedThreadConnection?.name ?? selectedThreadConnectionIdForView}${(selectedThreadSource?.remoteKey ?? selectedThreadSource?.remoteId) ? ` · ${selectedThreadSource?.remoteKey ?? selectedThreadSource?.remoteId}` : ''}`
                          : `Connection unavailable · ${selectedThreadConnection?.name ?? selectedThreadSource?.remoteKey ?? selectedThreadSource?.remoteId ?? selectedThreadConnectionIdForView}`}
                      </p>
                      <textarea
                        aria-label="Reply"
                        placeholder="Write a reply…"
                        value={replyDraft.text}
                        disabled={!canReply}
                        onChange={(event) => setTicketReplyDraft(draftKey, event.target.value)}
                        maxLength={12000}
                        rows={4}
                      />
                      <button
                        className="secondary"
                        disabled={
                          !runtimeAvailable ||
                          !canReply ||
                          replyBusy ||
                          !replyDraft.text.trim() ||
                          Boolean(uncertainReply)
                        }
                        onClick={async () => {
                          const submitted = replyDraft;
                          const submittedText = submitted.text.trim();
                          const submittedKey = draftKey;
                          const connectionId = selectedThreadConnectionIdForView;
                          const attempt = (replyAttempts.current.get(submittedKey) ?? 0) + 1;
                          replyAttempts.current.set(submittedKey, attempt);
                          setReplyBusyScopes((scopes) => new Set(scopes).add(submittedKey));
                          try {
                            await command('postExternalTicketReply', {
                              requestId: ticketReplyRequestId(submittedKey, submitted.version),
                              ticketId: ticket.id,
                              connectionId,
                              body: submittedText,
                            });
                            forgetTicketReplyRequestId(submittedKey, submitted.version);
                            clearSubmittedTicketReplyDraft(submittedKey, submitted.version);
                            if (
                              ticketScopeRef.current === ticketScopeKey &&
                              draftKeyRef.current === submittedKey
                            )
                              setMessage('Reply queued. Check delivery status in the source.');
                          } catch (error) {
                            if (
                              ticketScopeRef.current === ticketScopeKey &&
                              draftKeyRef.current === submittedKey
                            )
                              setMessage((error as Error).message);
                          } finally {
                            if (replyAttempts.current.get(submittedKey) === attempt) {
                              replyAttempts.current.delete(submittedKey);
                              setReplyBusyScopes((scopes) => {
                                const next = new Set(scopes);
                                next.delete(submittedKey);
                                return next;
                              });
                            }
                          }
                        }}
                      >
                        Send reply
                      </button>
                    </div>
                  )}
                {uncertainReply && (
                  <div role="alert">
                    <p>Reply outcome needs review in the source before another send.</p>
                    <p>{uncertainReply.body}</p>
                    {thread?.messages
                      .filter(
                        (entry) =>
                          entry.body === uncertainReply.body &&
                          entry.direction === 'outbound',
                      )
                      .map((entry) => (
                        <button
                          key={entry.remoteId}
                          className="secondary"
                          disabled={replyBusy || !runtimeAvailable}
                          onClick={() =>
                            void reconcileReply(
                              { requestId: uncertainReply.id, remoteId: entry.remoteId },
                              'Reply matched to the source conversation.',
                            )
                          }
                        >
                          Confirm source message {entry.remoteId}
                        </button>
                      ))}
                    <button
                      className="secondary"
                      disabled={replyBusy || !runtimeAvailable}
                      onClick={() =>
                        void reconcileReply(
                          { requestId: uncertainReply.id, confirmNotPosted: true },
                          'Marked not posted after review.',
                        )
                      }
                    >
                      Confirm no reply was posted
                    </button>
                  </div>
                )}
              </section>
            )}
            <TicketFiles ticket={ticket} editing={false} revisionChanged={setRevision} />
            {session?.flow && <WorkflowActivityHistory session={session} />}
          </div>
          <aside className="ticket-context" aria-label="Ticket context">
            <section className="ticket-context-group">
              <dl className="ticket-context-facts">
                <div>
                  <dt>Project</dt>
                  <dd>{project?.name ?? ticket.projectId}</dd>
                </div>
                {ticket.agent && ticket.agent !== 'Unassigned' && (
                  <div>
                    <dt>Agent</dt>
                    <dd>{ticket.agent}</dd>
                  </div>
                )}
                <div>
                  <dt>Priority</dt>
                  <dd>{ticket.priority}</dd>
                </div>
              </dl>
            </section>
            <details className="ticket-context-more ticket-context-related">
              <summary>Related tickets{related.length > 0 ? ` · ${related.length}` : ''}</summary>
              <div className="ticket-related-content">
                {related.map(({ relation, other }) => (
                  <div className="ticket-related-row" key={relation.id}>
                    <button className="ticket-record-link" onClick={() => onSelectTicket(other.id)}>
                      <strong>CVY-{other.id}</strong>
                      <span>{other.title}</span>
                      <small>{other.status}</small>
                    </button>
                    <details className="ticket-link-management">
                      <summary>Manage link</summary>
                      <button
                        className="secondary"
                        disabled={linkBusy}
                        onClick={async () => {
                          setLinkBusy(true);
                          try {
                            const source = state.tickets.find(
                              (value) => value.id === relation.sourceTicketId,
                            );
                            if (!source) throw new Error('Source ticket no longer exists.');
                            await command('unlinkTickets', {
                              relationId: relation.id,
                              sourceRevision: source.revision,
                            });
                            setMessage('Ticket unlinked.');
                          } catch (error) {
                            setMessage((error as Error).message);
                          } finally {
                            setLinkBusy(false);
                          }
                        }}
                      >
                        Unlink
                      </button>
                    </details>
                  </div>
                ))}
                <details className="ticket-related-add">
                  <summary>{related.length ? 'Add another' : 'Add related ticket'}</summary>
                  {availableRelatedTickets.length > 0 && (
                    <>
                      <label>
                        Existing ticket
                        <Select
                          value={relatedTicketId}
                          onChange={(event) => setRelatedTicketId(event.target.value)}
                        >
                          <option value="">Choose ticket…</option>
                          {availableRelatedTickets.map((value) => (
                            <option key={value.id} value={value.id}>
                              #{value.id} {value.title}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <button
                        className="secondary"
                        disabled={linkBusy || !relatedTicketId}
                        onClick={async () => {
                          setLinkBusy(true);
                          try {
                            const target = state.tickets.find(
                              (value) => value.id === Number(relatedTicketId),
                            );
                            if (!target) throw new Error('Ticket no longer exists.');
                            await command('linkTickets', {
                              sourceTicketId: ticket.id,
                              sourceRevision: revision,
                              targetTicketId: target.id,
                              targetRevision: target.revision,
                            });
                            setRelatedTicketId('');
                            setMessage('Ticket linked.');
                          } catch (error) {
                            setMessage((error as Error).message);
                          } finally {
                            setLinkBusy(false);
                          }
                        }}
                      >
                        Link ticket
                      </button>
                    </>
                  )}
                  <label>
                    New ticket title
                    <input
                      value={relatedTitle}
                      onChange={(event) => setRelatedTitle(event.target.value)}
                      placeholder={ticket.title}
                    />
                  </label>
                  {projectBoards.length > 0 && (
                    <label>
                      Board
                      <Select
                        value={relatedBoardId}
                        onChange={(event) => setRelatedBoardId(event.target.value)}
                      >
                        <option value="">Project default</option>
                        {projectBoards.map((board) => (
                          <option key={board.id} value={board.id}>
                            {board.name}
                          </option>
                        ))}
                      </Select>
                    </label>
                  )}
                  <button
                    className="secondary"
                    disabled={linkBusy}
                    onClick={async () => {
                      setLinkBusy(true);
                      try {
                        const result = await command('createRelatedTicket', {
                          requestId: crypto.randomUUID(),
                          sourceTicketId: ticket.id,
                          sourceRevision: revision,
                          title: relatedTitle.trim() || ticket.title,
                          ...(relatedBoardId ? { boardId: relatedBoardId } : {}),
                        });
                        setRelatedTitle('');
                        setMessage(`Ticket #${result.result.id} created and linked.`);
                      } catch (error) {
                        setMessage((error as Error).message);
                      } finally {
                        setLinkBusy(false);
                      }
                    }}
                  >
                    Create ticket
                  </button>
                </details>
              </div>
            </details>
            {!session?.flow && (
              <section className="ticket-context-group">
                <h3>Agent work</h3>
                <button className="ticket-context-action" onClick={onRun}>
                  {runLabel} →
                </button>
              </section>
            )}
            {(sourceLink || hasDetails) && (
              <details className="ticket-context-more" open={syncNeedsReview || undefined}>
                <summary>Source and details</summary>
                {sourceLink && (
                  <a href={sourceLink.url} target="_blank" rel="noopener noreferrer">
                    Open in {sourceName} ↗
                  </a>
                )}
                {hasDetails && (
                  <section className="ticket-source-details" aria-label="Ticket details">
                    <dl className="ticket-facts">
                      {(ticket.externalLinks ?? []).map((link) => (
                        <div key={`${link.connectionId}:${link.remoteId}`}>
                          <dt>
                            {ticket.externalLinks?.length === 1
                              ? 'Source ID'
                              : (state.ticketConnections?.find(
                                  (source) => source.id === link.connectionId,
                                )?.name ?? link.provider)}
                          </dt>
                          <dd>{link.remoteKey}</dd>
                        </div>
                      ))}
                      {ticket.label && (
                        <div>
                          <dt>Category</dt>
                          <dd>{ticket.label}</dd>
                        </div>
                      )}
                      {Object.entries(ticket.customFields ?? {}).map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                    {ticket.externalPublish && (
                      <p role="alert">
                        External creation needs review:{' '}
                        {ticket.externalPublish.message ?? 'The result is unknown.'}
                      </p>
                    )}
                    {ticket.externalPublish && (
                      <div className="ticket-publish-recovery">
                        <label>
                          {sourceName ?? 'Source'} issue ID, if created
                          <input
                            value={remoteIssueId}
                            onChange={(event) => setRemoteIssueId(event.target.value)}
                          />
                        </label>
                        <button
                          className="secondary"
                          disabled={publishing || !remoteIssueId.trim()}
                          onClick={async () => {
                            setPublishing(true);
                            try {
                              await command('reconcileTicketPublish', {
                                ticketId: ticket.id,
                                revision: ticket.revision,
                                remoteId: remoteIssueId.trim(),
                              });
                              setMessage('Source issue linked.');
                            } catch (error) {
                              setMessage((error as Error).message);
                            } finally {
                              setPublishing(false);
                            }
                          }}
                        >
                          Link issue
                        </button>
                        <button
                          className="secondary"
                          disabled={publishing}
                          onClick={async () => {
                            if (
                              !window.confirm(
                                'Confirm you checked the source and no issue was created?',
                              )
                            )
                              return;
                            setPublishing(true);
                            try {
                              await command('reconcileTicketPublish', {
                                ticketId: ticket.id,
                                revision: ticket.revision,
                                confirmNotCreated: true,
                              });
                              setMessage('Creation cleared. You can publish again.');
                            } catch (error) {
                              setMessage((error as Error).message);
                            } finally {
                              setPublishing(false);
                            }
                          }}
                        >
                          No issue was created
                        </button>
                      </div>
                    )}
                    {ticket.externalLinks
                      ?.filter((link) => link.syncState === 'error')
                      .map((link) => {
                        const connection = state.ticketConnections?.find(
                          (item) => item.id === link.connectionId,
                        );
                        const sourceName = connection?.name ?? 'external source';
                        return (
                          <div key={link.connectionId} className="ticket-sync-issue" role="alert">
                            <p>{link.message ?? 'Sync needs review.'}</p>
                            <details>
                              <summary>Compare content</summary>
                              <dl>
                                <dt>Title in Convoy</dt>
                                <dd>{ticket.title}</dd>
                                <dt>Last observed title in {sourceName}</dt>
                                <dd>{link.remoteTitle ?? 'Unknown'}</dd>
                                <dt>Description in Convoy</dt>
                                <dd>{ticket.description || 'Empty'}</dd>
                                <dt>Last observed description in {sourceName}</dt>
                                <dd>{link.remoteDescription || 'Empty'}</dd>
                                {link.remoteStatus !== undefined && (
                                  <>
                                    <dt>Status in Convoy</dt>
                                    <dd>{ticket.status}</dd>
                                    <dt>Last observed status in {sourceName}</dt>
                                    <dd>{link.remoteStatus}</dd>
                                  </>
                                )}
                                {link.remotePriority !== undefined && (
                                  <>
                                    <dt>Priority in Convoy</dt>
                                    <dd>{ticket.priority}</dd>
                                    <dt>Last observed priority in {sourceName}</dt>
                                    <dd>{link.remotePriority}</dd>
                                  </>
                                )}
                              </dl>
                            </details>
                            {connection?.capabilities?.update && (
                              <button
                                className="secondary"
                                disabled={publishing}
                                onClick={async () => {
                                  setPublishing(true);
                                  try {
                                    const result = await command('syncExternalTicket', {
                                      ticketId: ticket.id,
                                      revision: ticket.revision,
                                      connectionId: link.connectionId,
                                      resolution: 'local',
                                    });
                                    setMessage(
                                      result.result.externalLinks?.[0]?.syncState === 'linked'
                                        ? `${sourceName} updated.`
                                        : 'Sync still needs review.',
                                    );
                                  } catch (error) {
                                    setMessage((error as Error).message);
                                  } finally {
                                    setPublishing(false);
                                  }
                                }}
                              >
                                Use Convoy values
                              </button>
                            )}
                            <button
                              className="secondary"
                              disabled={publishing}
                              onClick={async () => {
                                setPublishing(true);
                                try {
                                  await command('syncExternalTicket', {
                                    ticketId: ticket.id,
                                    revision: ticket.revision,
                                    connectionId: link.connectionId,
                                    resolution: 'remote',
                                  });
                                  setMessage(`${sourceName} values applied.`);
                                } catch (error) {
                                  setMessage((error as Error).message);
                                } finally {
                                  setPublishing(false);
                                }
                              }}
                            >
                              Use {sourceName} values
                            </button>
                          </div>
                        );
                      })}
                    {!ticket.externalLinks?.length &&
                      !ticket.externalPublish &&
                      availableConnections.length > 0 && (
                        <label>
                          Publish to
                          <Select
                            defaultValue=""
                            disabled={publishing}
                            onChange={async (event) => {
                              if (!event.target.value) return;
                              setPublishing(true);
                              try {
                                const result = await command('publishTicket', {
                                  requestId: crypto.randomUUID(),
                                  ticketId: ticket.id,
                                  revision: ticket.revision,
                                  connectionId: event.target.value,
                                });
                                setMessage(
                                  result.result.externalPublish
                                    ? 'External creation needs review.'
                                    : 'Ticket published.',
                                );
                              } catch (error) {
                                setMessage((error as Error).message);
                              } finally {
                                setPublishing(false);
                              }
                            }}
                          >
                            <option value="">Choose destination…</option>
                            {availableConnections.map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.name}
                              </option>
                            ))}
                          </Select>
                        </label>
                      )}
                  </section>
                )}
              </details>
            )}
          </aside>
        </div>
      </section>
    );
  return (
    <form
      className="runtime-form ticket-edit-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setMessage('');
        const form = new FormData(event.currentTarget);
        try {
          const response = await command('updateTicket', {
            taskId: ticket.id,
            revision,
            patch: {
              title: String(form.get('title') ?? ''),
              description,
              label: String(form.get('label') ?? ''),
              priority: String(form.get('priority') ?? '') as Ticket['priority'],
              status: String(form.get('status') ?? ''),
              agent: String(form.get('agent') ?? ''),
              customFields,
            },
          });
          setRevision(response.result.revision);
          setEditing(false);
        } catch (reason) {
          setMessage((reason as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="ticket-title-field">
        <span>Title</span>
        <textarea name="title" aria-label="Title" defaultValue={ticket.title} required rows={2} />
      </label>
      <div className="ticket-description-editor">
        <div>
          <button
            type="button"
            className={!preview ? 'selected' : ''}
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            className={preview ? 'selected' : ''}
            onClick={() => setPreview(true)}
          >
            Preview
          </button>
        </div>
        {preview ? (
          <MarkdownDocument text={description} />
        ) : (
          <textarea
            aria-label="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </div>
      <TicketFiles ticket={ticket} editing revisionChanged={setRevision} />
      <details className="ticket-properties">
        <summary>Properties</summary>
        <div className="ticket-property-grid">
          <label>
            Status
            {sourceOwnsStatus && <input type="hidden" name="status" value={ticket.status} />}
            {statusBoards.length ? (
              <Select
                name={sourceOwnsStatus ? undefined : 'status'}
                disabled={sourceOwnsStatus}
                defaultValue={ticket.status}
              >
                {statusChoices.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </Select>
            ) : (
              <input
                name={sourceOwnsStatus ? undefined : 'status'}
                disabled={sourceOwnsStatus}
                defaultValue={ticket.status}
              />
            )}
          </label>
          <label>
            Assigned agent
            <Select name="agent" defaultValue={ticket.agent}>
              {[
                ...new Set(['Unassigned', 'Claude Code', 'Codex', 'OpenCode', 'Pi', ticket.agent]),
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </Select>
          </label>
          <label>
            Label
            <input name="label" defaultValue={ticket.label} />
          </label>
          <label>
            Priority
            {ticket.externalLinks?.some((link) => link.fieldOwnership?.priority === 'external') && (
              <input type="hidden" name="priority" value={ticket.priority} />
            )}
            <Select
              name={
                ticket.externalLinks?.some((link) => link.fieldOwnership?.priority === 'external')
                  ? undefined
                  : 'priority'
              }
              disabled={ticket.externalLinks?.some(
                (link) => link.fieldOwnership?.priority === 'external',
              )}
              defaultValue={ticket.priority}
            >
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </Select>
          </label>
        </div>
        <details className="ticket-extra-fields">
          <summary>Custom fields</summary>
          <fieldset className="ticket-custom-fields">
            <legend>Custom fields</legend>
            {Object.entries(customFields).map(([key, value]) => (
              <div className="ticket-custom-field" key={key}>
                <input aria-label={`Custom field ${key} name`} value={key} readOnly />
                <input
                  aria-label={`Custom field ${key} value`}
                  value={String(value ?? '')}
                  onChange={(event) => patchField(key, event.target.value)}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove custom field ${key}`}
                  onClick={() => removeField(key)}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="ticket-custom-field-add">
              <input
                aria-label="New custom field name"
                placeholder="Field name"
                value={newFieldName}
                onChange={(event) => {
                  setNewFieldName(event.target.value);
                  setFieldError('');
                }}
              />
              <input
                aria-label="New custom field value"
                placeholder="Value"
                value={newFieldValue}
                onChange={(event) => setNewFieldValue(event.target.value)}
              />
              <button type="button" className="secondary" onClick={addField}>
                Add
              </button>
            </div>
            {fieldError && <p role="alert">{fieldError}</p>}
          </fieldset>
        </details>
        <details className="runtime-details">
          <summary>Execution environment</summary>
          <ExecutionProfileEditor state={state} target={ticket} ticket />
          <PlacementEditor state={state} target={ticket} ticket />
        </details>
      </details>
      {message && <p role="alert">{message}</p>}
      <div className="ticket-edit-actions">
        <button type="button" className="secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
        <button className="primary ticket-save" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
