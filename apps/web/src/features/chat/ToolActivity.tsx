import { useEffect, useState } from 'react';
import {
  Check,
  ChevronRight,
  FileSearch,
  FileText,
  GitBranch,
  LoaderCircle,
  PencilLine,
  Search,
  ShieldQuestion,
  Terminal,
  Ticket,
  X,
} from 'lucide-react';
import type { Session } from '../../shared/api/runtime';
import { command, owns, type RuntimeAction } from '../../shared/api/runtime';
import { lineDiff, toolGroupLabel, toolLabel, type ToolActivity } from './activity';
import './tool-activity.css';

const readable = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function patchPreview(before: string | undefined, value: unknown) {
  if (before === undefined || !Array.isArray(value)) return undefined;
  let next = before;
  for (const edit of value) {
    if (
      !edit ||
      typeof edit !== 'object' ||
      typeof (edit as { oldText?: unknown }).oldText !== 'string' ||
      typeof (edit as { newText?: unknown }).newText !== 'string'
    )
      return undefined;
    const { oldText, newText } = edit as { oldText: string; newText: string };
    const at = next.indexOf(oldText);
    if (at < 0 || next.indexOf(oldText, at + 1) >= 0) return undefined;
    next = next.slice(0, at) + newText + next.slice(at + oldText.length);
  }
  return next;
}
export function ToolGroup({
  tools,
  session,
  working,
  act,
}: {
  tools: ToolActivity[];
  session: Session;
  working: boolean;
  act: (action: RuntimeAction, input: object) => Promise<void>;
}) {
  const live = tools.some(
    (t) =>
      ['queued', 'running', 'approval', 'approved'].includes(t.status) ||
      session.commands?.some(
        (c) =>
          c.callId === t.callId &&
          c.agentSessionId === t.agentSessionId &&
          ['running', 'stopping'].includes(c.state),
      ),
  );
  const failed = tools.some((t) => ['failed', 'denied', 'stopped'].includes(t.status));
  const [expanded, setExpanded] = useState<boolean | undefined>(undefined);
  const open = live || (expanded ?? failed);
  return (
    <section className={`tool-group${live ? ' is-live' : ''}`} aria-label="Agent activity">
      {!live && (
        <button
          type="button"
          className="tool-group-toggle"
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          <ChevronRight size={14} className={open ? 'expanded' : ''} />
          {toolGroupLabel(tools)}
        </button>
      )}
      {open &&
        tools.map((t) => (
          <ToolCard key={t.key} activity={t} session={session} working={working} act={act} />
        ))}
    </section>
  );
}
function ToolIcon({ tool }: { tool: string }) {
  if (tool === 'read_file') return <FileText size={15} />;
  if (['list_files', 'search_files', 'inspect_repository'].includes(tool))
    return <Search size={15} />;
  if (['write_file', 'apply_patch'].includes(tool)) return <PencilLine size={15} />;
  if (['create_ticket', 'update_ticket', 'link_ticket'].includes(tool)) return <Ticket size={15} />;
  if (['request_execution', 'release_assignment'].includes(tool)) return <GitBranch size={15} />;
  if (tool === 'read_skill_resource' || tool === 'load_skill') return <FileSearch size={15} />;
  return <Terminal size={15} />;
}

function resultSummary(output: Record<string, unknown> | undefined) {
  if (!output) return '';
  if (typeof output.code === 'number') return `Exit ${output.code}`;
  if (typeof output.replacements === 'number')
    return `${output.replacements} ${output.replacements === 1 ? 'edit' : 'edits'}`;
  if (Array.isArray(output.hits)) return `${output.hits.length} matches`;
  if (typeof output.text === 'string') return `${output.text.length.toLocaleString()} characters`;
  if (typeof output.path === 'string') return 'Saved';
  return '';
}
function ToolCard({
  activity: t,
  session,
  working,
  act,
}: {
  activity: ToolActivity;
  session: Session;
  working: boolean;
  act: (action: RuntimeAction, input: object) => Promise<void>;
}) {
  const pending = t.approvalId === session.pending?.id ? session.pending : null;
  const [expanded, setExpanded] = useState(false);
  const label = toolLabel(t);
  const execution = t.callId
    ? session.commands?.find((c) => c.callId === t.callId && c.agentSessionId === t.agentSessionId)
    : undefined;
  const running = execution && ['running', 'stopping'].includes(execution.state);
  const effectiveStatus = running
    ? 'running'
    : execution?.state === 'lost'
      ? 'failed'
      : execution?.state === 'exited'
        ? execution.code === 0 && !execution.reason
          ? 'succeeded'
          : 'stopped'
        : t.status;
  const canControl = !session.lease || session.lease.expiresAt <= Date.now() || owns(session);
  const output = (execution ?? t.output) as Record<string, unknown> | undefined;
  const [clock, setClock] = useState(Date.now());
  const [log, setLog] = useState('');
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [logError, setLogError] = useState('');
  const proposedPatch = t.tool === 'apply_patch' ? patchPreview(t.before, t.args.edits) : undefined;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  async function readLog() {
    if (!execution) return;
    setLoading(true);
    setLogError('');
    try {
      await command('claim', { sessionId: session.id, label: 'Web chat' });
      const { result } = await command('readCommandOutput', {
        sessionId: session.id,
        commandId: execution.commandId,
        cursor,
      });
      setLog(result.text);
      setCursor(result.cursor);
      setMore(result.hasMore);
    } catch (error) {
      setLogError(error instanceof Error ? error.message : 'Could not read output.');
    } finally {
      setLoading(false);
    }
  }
  const status = pending
    ? 'Approval needed'
    : {
        queued: 'Preparing',
        running: 'Running',
        approval: 'Awaiting approval',
        approved: 'Approved',
        succeeded: 'Done',
        failed: 'Failed',
        denied: 'Denied',
        stopped: 'Stopped',
      }[effectiveStatus];
  return (
    <article className={`tool-card tool-${effectiveStatus}`}>
      <button
        type="button"
        className="tool-card-title"
        aria-expanded={!!pending || expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {pending ? (
          <ShieldQuestion size={16} />
        ) : effectiveStatus === 'running' ? (
          <LoaderCircle size={16} className="tool-spinner" />
        ) : effectiveStatus === 'succeeded' ? (
          <Check size={15} />
        ) : ['failed', 'denied', 'stopped'].includes(effectiveStatus) ? (
          <X size={15} />
        ) : (
          <ToolIcon tool={t.tool} />
        )}
        <span>
          <strong>{label.name}</strong>
          {label.detail && <small title={label.detail}>{label.detail}</small>}
        </span>
        <small className="tool-status">
          {effectiveStatus === 'succeeded' ? resultSummary(output) || status : status}
        </small>
      </button>
      {running && (
        <div className="command-live">
          <div>
            <small>
              {execution.lifetime === 'session' ? 'Session · ' : ''}
              {Math.max(0, Math.floor((clock - execution.startedAt) / 1000))}s
              {execution.state === 'stopping' ? ' · stopping…' : ''}
            </small>
            <button
              type="button"
              disabled={!canControl || working || execution.state === 'stopping'}
              onClick={() => void act('stopCommand', { commandId: execution.commandId })}
            >
              Stop command
            </button>
          </div>
          {execution.output && (
            <pre aria-label="Live command output">{execution.output.slice(-3000)}</pre>
          )}
        </div>
      )}
      {(pending || expanded) && (
        <div className="tool-card-content">
          {t.tool === 'write_file' && typeof t.args.content === 'string' ? (
            <>
              <p className="tool-file-path">{String(t.args.path ?? '')}</p>
              <p>
                {t.before !== undefined
                  ? 'Proposed diff'
                  : t.args.expectedHash === ''
                    ? 'New file contents'
                    : 'Proposed replacement contents'}
              </p>
              {t.before !== undefined ? (
                <pre className="tool-diff">
                  {lineDiff(t.before, t.args.content).map((line, i) => (
                    <span key={i} className={`diff-${line.kind}`}>
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} {line.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              ) : (
                <pre>{t.args.content}</pre>
              )}
              <small>
                {t.args.expectedHash === ''
                  ? 'Creates a new file.'
                  : `Only writes if the current file matches SHA-256 ${t.args.expectedHash}.`}
              </small>
            </>
          ) : t.tool === 'apply_patch' && Array.isArray(t.args.edits) ? (
            <>
              <p className="tool-file-path">{String(t.args.path ?? '')}</p>
              <p>{proposedPatch === undefined ? 'Proposed exact edits' : 'Proposed diff'}</p>
              {proposedPatch === undefined ? (
                <pre>{readable(t.args.edits)}</pre>
              ) : (
                <pre className="tool-diff">
                  {lineDiff(t.before ?? '', proposedPatch).map((line, i) => (
                    <span key={i} className={`diff-${line.kind}`}>
                      {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '} {line.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              )}
              <small>
                Applies atomically only if the file still matches SHA-256{' '}
                {String(t.args.expectedHash)}.
              </small>
            </>
          ) : (
            <dl className="tool-arguments">
              {Object.entries(t.args).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll('_', ' ')}</dt>
                  <dd>
                    {key === 'command' || (typeof value === 'string' && value.includes('\n')) ? (
                      <pre>{readable(value)}</pre>
                    ) : (
                      readable(value)
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {output !== undefined && !running && (
            <div className="tool-output">
              <small>
                {effectiveStatus === 'failed' ? 'Error' : 'Result'}
                {typeof output?.code === 'number' ? ` · exit ${output.code}` : ''}
                {typeof output?.reason === 'string'
                  ? ` · ${output.reason.replaceAll('_', ' ')}`
                  : ''}
              </small>
              <pre>
                {typeof output?.error === 'string'
                  ? output.error
                  : typeof output?.output === 'string'
                    ? output.output
                    : typeof output?.text === 'string'
                      ? output.text
                      : readable(output)}
              </pre>
              {output?.truncated === true && <small>Showing the output tail.</small>}
            </div>
          )}
          {execution && (
            <div className="command-log">
              <button
                type="button"
                disabled={
                  loading ||
                  !canControl ||
                  (!more && !running && cursor >= (execution.retainedBytes ?? 0))
                }
                onClick={() => void readLog()}
              >
                {loading ? 'Loading…' : cursor ? 'Next output page' : 'Read retained output'}
              </button>
              {cursor > 0 && (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setCursor(0);
                    setMore(true);
                    setLog('');
                  }}
                >
                  Back to start
                </button>
              )}
              {log && <pre aria-label="Retained command output">{log}</pre>}
              {logError && <p role="alert">{logError}</p>}
            </div>
          )}
          {pending && (
            <div className="tool-approval-actions">
              <button
                type="button"
                className="primary"
                disabled={working || session.control?.stopping}
                onClick={() =>
                  void act('decide', { approvalId: pending.id, decision: 'allow_once' })
                }
              >
                Allow once
              </button>
              {pending.rule && (
                <button
                  type="button"
                  className="secondary"
                  disabled={working || session.control?.stopping}
                  onClick={() =>
                    void act('decide', { approvalId: pending.id, decision: 'allow_always' })
                  }
                >
                  Always allow
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled={working || session.control?.stopping}
                onClick={() => void act('decide', { approvalId: pending.id, decision: 'deny' })}
              >
                Deny
              </button>
              <small>
                {pending.rule
                  ? `Always allow saves this exact rule in the ${pending.rule.scope.kind}: ${pending.rule.label}.`
                  : 'Allow once applies only to this exact operation.'}
              </small>
            </div>
          )}
          <details className="tool-raw">
            <summary>Raw details</summary>
            <pre>
              {JSON.stringify(
                { tool: t.tool, callId: t.callId, arguments: t.args, result: t.output },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
    </article>
  );
}
export function InlineQuestion({
  session,
  working,
  act,
}: {
  session: Session;
  working: boolean;
  act: (action: RuntimeAction, input: object) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  useEffect(() => setAnswer(''), [session.pendingQuestion?.id]);
  const question = session.pendingQuestion;
  if (!question) return null;
  return (
    <form
      className="inline-question"
      onSubmit={(e) => {
        e.preventDefault();
        void act('answerQuestion', { questionId: question.id, answer });
      }}
    >
      <p>{question.question}</p>
      <textarea
        aria-label="Answer agent question"
        value={answer}
        maxLength={12000}
        onChange={(e) => setAnswer(e.target.value)}
        rows={2}
      />
      <button className="primary" disabled={working || !answer.trim()}>
        Send answer
      </button>
    </form>
  );
}
