import type { Session } from '../../shared/api/runtime';
export type ActivityEvent = Session['events'][number];
export type ToolActivity = {
  key: string;
  seq: number;
  callId?: string;
  agentSessionId?: string;
  tool: string;
  args: Record<string, unknown>;
  approvalId?: string;
  status:
    | 'queued'
    | 'running'
    | 'approval'
    | 'approved'
    | 'succeeded'
    | 'failed'
    | 'denied'
    | 'stopped';
  output?: unknown;
  before?: string;
};
export type TimelineItem =
  | { kind: 'event'; event: ActivityEvent }
  | { kind: 'tools'; key: string; tools: ToolActivity[] };
export function buildTimeline(events: ActivityEvent[], session: Session): TimelineItem[] {
  const items: TimelineItem[] = [];
  const calls = new Map<string, ToolActivity>();
  const approvals = new Map<string, ToolActivity>();
  const reads = new Map<string, { text: string; hash: string }>();
  const key = (e: ActivityEvent, id?: string) => `${e.agentSessionId ?? 'main'}:${id}`;
  function add(e: ActivityEvent, tool: string, id?: string, args: Record<string, unknown> = {}) {
    const activity: ToolActivity = {
      key: `tool-${e.seq}`,
      seq: e.seq,
      callId: id,
      agentSessionId: e.agentSessionId,
      tool,
      args,
      status: 'queued',
    };
    const last = items.at(-1);
    if (last?.kind === 'tools') last.tools.push(activity);
    else items.push({ kind: 'tools', key: `tools-${e.seq}`, tools: [activity] });
    calls.set(key(e, id ?? activity.key), activity);
    return activity;
  }
  function find(e: ActivityEvent, id?: string) {
    const found = id ? calls.get(key(e, id)) : undefined;
    if (found) return found;
    const legacy = [...calls.values()]
      .reverse()
      .find(
        (t) =>
          (!id || !t.callId) &&
          t.tool === (e.tool ?? e.approval?.tool) &&
          t.agentSessionId === e.agentSessionId &&
          t.output === undefined,
      );
    if (legacy && id) {
      legacy.callId = id;
      calls.set(key(e, id), legacy);
    }
    return legacy;
  }
  for (const e of events) {
    if (e.type === 'tool_requested') {
      const t = add(e, e.tool ?? 'tool', e.callId, e.args);
      const read = reads.get(`${e.agentSessionId}:${t.args.path}`);
      if (
        ['write_file', 'apply_patch'].includes(t.tool) &&
        read &&
        read.hash === t.args.expectedHash
      )
        t.before = read.text;
    } else if (e.type === 'approval_requested' && e.approval) {
      const a = e.approval;
      const t = find(e, a.callId) ?? add(e, a.tool, a.callId, a.args);
      t.args = a.args;
      t.approvalId = a.id;
      t.status = 'approval';
      approvals.set(a.id, t);
    } else if (e.type === 'approval_decision') {
      const t = approvals.get(e.approvalId ?? '');
      if (t) t.status = e.allow ? 'approved' : 'denied';
    } else if (e.type === 'tool_started') {
      const t = find(e, e.callId) ?? add(e, e.tool ?? 'tool', e.callId, e.args);
      t.status = 'running';
    } else if (e.type === 'tool_result') {
      const t = find(e, e.callId) ?? add(e, e.tool ?? 'tool', e.callId);
      t.output = e.output;
      if (t.status !== 'denied') t.status = e.isError ? 'failed' : 'succeeded';
      const output = e.output as { text?: string; sha256?: string } | undefined;
      if (t.tool === 'read_file' && typeof output?.text === 'string' && output.sha256)
        reads.set(`${e.agentSessionId}:${t.args.path}`, { text: output.text, hash: output.sha256 });
    } else if (
      [
        'user',
        'assistant',
        'assistant_interrupted',
        'ticket_linked',
        'delegation_result',
        'failed',
        'interrupted',
        'placement_error',
        'resume_blocked',
        'workflow_error',
      ].includes(e.type)
    )
      items.push({ kind: 'event', event: e });
  }
  // Recovery also covers historical/truncated event windows without a matching request.
  if (session.pending && !approvals.has(session.pending.id)) {
    const p = session.pending;
    const e = {
      seq: -1,
      at: '',
      type: 'approval_requested',
      agentSessionId: session.currentAgentSessionId,
    };
    const t = add(e, p.tool, p.callId, p.args as Record<string, unknown>);
    t.approvalId = p.id;
    t.status = 'approval';
  }
  for (const t of calls.values())
    if (
      ['approval', 'approved', 'running', 'queued'].includes(t.status) &&
      t.approvalId !== session.pending?.id &&
      !session.control?.busy &&
      !['running', 'queued', 'waiting_question', 'waiting_approval'].includes(session.status) &&
      !session.commands?.some(
        (c) =>
          c.callId === t.callId &&
          c.agentSessionId === t.agentSessionId &&
          ['running', 'stopping'].includes(c.state),
      )
    )
      t.status = 'stopped';
  return items;
}
export function toolLabel(t: ToolActivity) {
  const names: Record<string, string> = {
    read_file: 'Read file',
    list_files: 'List files',
    write_file: 'Write file',
    apply_patch: 'Patch file',
    search_files: 'Search files',
    inspect_repository: 'Inspect repository',
    shell: 'Run command',
    start_command: 'Start background command',
    command_status: 'Inspect command',
    read_command_output: 'Read command output',
    send_command_input: 'Send command input',
    stop_command: 'Stop command',
    create_ticket: 'Create ticket',
    request_execution: 'Assign work',
    release_ticket: 'Release ticket',
    list_work: 'List work',
    ask_user: 'Ask a question',
    submit_step: 'Submit workflow step',
    load_skill: 'Load skill',
    read_skill_resource: 'Read skill resource',
  };
  const rawDetail =
    t.args.path ?? t.args.command ?? t.args.title ?? t.args.name ?? t.args.query ?? t.args.pattern;
  const detail =
    t.tool === 'apply_patch' && typeof rawDetail === 'string' && Array.isArray(t.args.edits)
      ? `${rawDetail} · ${t.args.edits.length} ${t.args.edits.length === 1 ? 'edit' : 'edits'}`
      : t.tool === 'search_files' && typeof rawDetail === 'string'
        ? `“${rawDetail}”`
        : rawDetail;
  return {
    name: names[t.tool] ?? t.tool.replaceAll('_', ' '),
    detail: typeof detail === 'string' ? detail : undefined,
  };
}
export function toolGroupLabel(tools: ToolActivity[]) {
  const active = [...tools]
    .reverse()
    .find((tool) => ['queued', 'running', 'approval', 'approved'].includes(tool.status));
  if (active) {
    const label = toolLabel(active);
    return active.status === 'approval'
      ? `Approval needed · ${label.name}`
      : `${label.name}${label.detail ? ` · ${label.detail}` : ''}`;
  }
  const failed = tools.filter((tool) =>
    ['failed', 'denied', 'stopped'].includes(tool.status),
  ).length;
  return `${tools.length} ${tools.length === 1 ? 'operation' : 'operations'}${failed ? ` · ${failed} needs attention` : ' completed'}`;
}
export function lineDiff(before: string, after: string) {
  const a = before.split('\n'),
    b = after.split('\n');
  let start = 0,
    end = 0;
  while (start < Math.min(a.length, b.length) && a[start] === b[start]) start++;
  while (
    end < Math.min(a.length - start, b.length - start) &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [
    ...a.slice(Math.max(0, start - 3), start).map((text) => ({ kind: 'context', text })),
    ...a.slice(start, a.length - end).map((text) => ({ kind: 'remove', text })),
    ...b.slice(start, b.length - end).map((text) => ({ kind: 'add', text })),
    ...b.slice(b.length - end, b.length - end + 3).map((text) => ({ kind: 'context', text })),
  ];
}
