import { createInterface, clearLine, clearScreenDown, cursorTo, moveCursor } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const commands = {
  '/help': 'Show commands and keyboard shortcuts',
  '/quit': 'Disconnect; leave agent work running',
  '/clear': 'Clear the terminal display',
  '/claim': 'Claim session control', '/release': 'Release session control',
  '/stop': 'Stop the current agent turn', '/resume': 'Continue a stopped turn',
  '/resume-reviewed': 'Continue after inspecting possible partial effects',
  '/approve': 'Approve the exact pending ID: /approve ID',
  '/deny': 'Deny the exact pending ID: /deny ID',
  '/answer': 'Answer the pending question: /answer TEXT',
  '/pending': 'Inspect queued messages and pending decisions',
  '/queue': 'Queue a message: /queue TEXT', '/interrupt': 'Interrupt with direction: /interrupt TEXT',
  '/discard': 'Remove a queued message: /discard ID',
  '/workflow': 'Inspect the pinned workflow and agent sessions',
  '/start-workflow': 'Start the configured workflow', '/pause': 'Pause the workflow',
  '/continue': 'Continue the current workflow step', '/cancel': 'Cancel the workflow',
  '/gate-approve': 'Approve the current captured workflow submission',
  '/changes': 'Request changes: /changes FEEDBACK', '/resubmit': 'Reopen the current submission',
  '/advance': 'Advance a manually controlled step', '/view': 'View one agent session: /view NAME or all',
  '/context': 'Inspect instructions and provenance', '/placement': 'Inspect runner placement',
  '/diff': 'Inspect workspace changes', '/details': 'Show the last tool result',
  '/reconcile-stopped': 'Confirm the original assignment stopped: /reconcile-stopped TOKEN',
};

export const terminalText = value => stripVTControlCharacters(String(value ?? ''))
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cellWidth(segment) {
  const point = segment.codePointAt(0);
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment) || point >= 0x1100 &&
    (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7af || point >= 0xf900 && point <= 0xfaff || point >= 0xff01 && point <= 0xff60) ? 2 : 1;
}
function cells(text) {
  return [...graphemes.segment(terminalText(text).replace(/\t/g, '  '))].reduce((sum, { segment }) => sum + cellWidth(segment), 0);
}
function wrap(text, width) {
  const rows = [];
  for (const line of terminalText(text).replace(/\t/g, '  ').split('\n')) {
    let row = '';
    let columns = 0;
    for (const { segment } of graphemes.segment(line)) {
      const size = cellWidth(segment);
      if (columns + size > width) { rows.push(row); row = ''; columns = 0; }
      row += segment; columns += size;
    }
    rows.push(row);
  }
  return rows;
}

// Readline measures tabs over the logical line, while a terminal clamps a tab
// at its right edge. Expand only the editor's display bytes; retain the original
// tabs in its input buffer and in the submitted message.
function expandEditorTabs(value, columns) {
  if (!value.includes('\t')) return value;
  let offset = 0;
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\s\S]/gu, char => {
    if (char.startsWith('\x1b')) return char;
    if (char === '\n' || char === '\r') { offset = 0; return char; }
    if (char === '\t') { const count = 8 - offset % 8; offset += count; return ' '.repeat(count); }
    if (!/\p{Mark}|[\u200d\ufe00-\ufe0f]/u.test(char)) {
      const size = cellWidth(char);
      if (size === 2 && (offset + 1) % columns === 0) offset++;
      offset += size;
    }
    return char;
  });
}

/** Terminal presentation and input only; the daemon owns execution and authority. */
export function createConversationRepl({ input = process.stdin, output = process.stdout, client, readOnly = false, sessionId }) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const editorOutput = terminal ? {
    get columns() { return output.columns; },
    on: (...args) => output.on(...args),
    removeListener: (...args) => output.removeListener(...args),
    write: (value, ...args) => output.write(expandEditorTabs(value, output.columns ?? 80), ...args),
  } : output;
  const rl = createInterface({ input, output: editorOutput, terminal, historySize: 200, removeHistoryDuplicates: true,
    completer(line) { const matches = Object.keys(commands).filter(command => command.startsWith(line)); return [matches, line]; },
  });
  rl.pause();
  let started = false;
  let closed = false;
  let quitting = false;
  let footerRows = 0;
  let footerLines = [];
  let inputRows = 1;
  let inputEmpty = true;
  let codeFence = false;
  let repaintQueued = false;
  let editQueued = false;
  let streamTimer;
  let streamBuffer = '';
  let activityTimer;
  let activitySince = 0;
  let working = false;
  let activeTool;
  let spinner = 0;
  let pasting = false;
  let paste = '';
  let submittedDraft;
  const color = terminal && !process.env.NO_COLOR;
  const paint = (text, code) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const muted = text => paint(text, '38;5;244');
  const accent = text => paint(text, '1;38;5;221');
  const width = () => Math.max(8, (output.columns ?? 80) - 1);
  const inline = text => text.replace(/`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g,
    (_all, code, bold, label, url) => code ? paint(code, '38;5;80') : bold ? paint(bold, '1') : paint(label, '4') + muted(` (${url})`));
  function markdownLine(line, commit) {
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const opening = !codeFence;
      if (commit) codeFence = opening;
      return muted(opening ? `  ┌ ${fence[1].trim() || 'code'}` : '  └');
    }
    if (codeFence) return muted('  │ ') + paint(line, '38;5;80');
    if (/^#{1,6} /.test(line)) return accent(line.replace(/^#{1,6} /, ''));
    return inline(line.replace(/^\s*[-*] /, '  • '));
  }
  function format(text, kind) {
    if (!terminal) return text;
    if (kind === 'message') return '\n' + format(text, 'user') + '\n';
    if (kind === 'user') return wrap(text, Math.max(4, width() - 4)).map((line, index) => {
      const content = ` ${index ? ' ' : '›'} ${line}`;
      return paint(content + ' '.repeat(Math.max(0, width() - cells(content))), '48;5;235;38;5;255');
    }).join('\n');
    if (kind === 'assistant') return '\n' + paint('● ', '38;5;80') + paint(text.trim(), '1');
    if (kind === 'activity' || kind === 'meta') return muted(text);
    if (kind === 'warning') return paint(text, '38;5;221');
    if (kind === 'markdown') return text.split('\n').map(line => markdownLine(line, true)).join('\n');
    return text;
  }
  let status = 'Connecting';
  let session;
  let sequence = 0;
  let view = 'all';
  let version = -1;
  let streaming = '';
  let tail = '';
  let assistantOpen = false;
  let pendingId;
  let questionId;
  let lastTool;
  let continuation = [];
  let queued = Promise.resolve();
  const localMessages = new Set();
  const sending = new Set();

  function draftHeight(text) {
    // Match readline's tab stops and physical rows without mutating the editor.
    const columns = Math.max(1, output.columns ?? 80);
    let offset = 3;
    let rows = 0;
    for (const char of text) {
      if (char === '\n') { rows += Math.ceil(offset / columns) || 1; offset = 0; }
      else if (char === '\t') offset += 8 - offset % 8;
      else if (!/\p{Mark}|[\u200d\ufe00-\ufe0f]/u.test(char)) {
        const size = cellWidth(char);
        if (size === 2 && (offset + 1) % columns === 0) offset++;
        offset += size;
      }
    }
    return rows + Math.floor(offset / columns) + 1;
  }
  function statusText() {
    const loading = working ? `${['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][spinner % 10]} ` : '';
    const elapsed = working ? ` · ${Math.floor((Date.now() - activitySince) / 1000)}s` : '';
    const separator = status.indexOf(' · ');
    const detail = separator < 0 ? status + elapsed : status.slice(0, separator) + elapsed + status.slice(separator);
    return (sending.size ? 'sending · ' : '') + loading + detail;
  }
  function paintStatus() {
    if (!terminal || !started || closed) return;
    const position = rl.getCursorPos();
    output.write('\x1b7');
    cursorTo(output, 0);
    moveCursor(output, 0, inputRows - position.rows + 1);
    clearLine(output, 0);
    output.write(muted(wrap(statusText(), Math.max(1, width() - 1))[0]));
    output.write('\x1b8');
  }
  function updateActivity() {
    const next = session?.status === 'running';
    if (next && !working) {
      activitySince = Date.now();
      if (terminal) activityTimer = setInterval(() => { spinner++; paintStatus(); }, 120);
      activityTimer?.unref();
    } else if (!next) { clearInterval(activityTimer); activityTimer = undefined; }
    working = next;
  }

  function eraseFooter() {
    if (!terminal || !started || closed) return null;
    const draft = rl.line;
    const position = rl.cursor;
    // Use readline's editing operations so wrapped input and its internal cursor
    // stay synchronized while asynchronous output arrives.
    if (rl.cursor) rl.write(null, { ctrl: true, name: 'u' });
    if (rl.line) rl.write(null, { ctrl: true, name: 'k' });
    cursorTo(output, 0);
    if (footerRows) moveCursor(output, 0, -footerRows);
    clearScreenDown(output);
    return { draft, position };
  }
  function footer(saved) {
    if (!terminal || !started || closed) return;
    const columns = width();
    const rows = tail ? wrap(tail, columns).slice(-8).map(line => markdownLine(line, false)) : [];
    if (rows.length) rows.push('');
    rows.push(muted('─'.repeat(columns)));
    for (const line of continuation.slice(-4)) rows.push(...wrap(line, Math.max(4, columns - 3)).map(line => muted('  ' + line)));
    output.write(rows.join('\n') + '\n');
    footerLines = rows;
    footerRows = rows.length;
    inputRows = draftHeight(saved?.draft ?? '');
    inputEmpty = !saved?.draft;
    // Reserve the composer and its two lower rows before drawing the cursor.
    // This keeps terminal scrolling from moving a saved cursor onto the status.
    output.write('\n'.repeat(inputRows + 2));
    moveCursor(output, 0, -(inputRows + 2));
    rl.setPrompt(paint(continuation.length ? ' … ' : ' ❯ ', '1;38;5;80'));
    rl.prompt();
    if (saved?.draft) {
      rl.line = saved.draft;
      rl.cursor = saved.position;
      rl.prompt(true);
    }
    const position = rl.getCursorPos();
    output.write('\x1b7');
    cursorTo(output, 0);
    moveCursor(output, 0, inputRows - position.rows);
    output.write(muted('─'.repeat(columns)) + '\n' + muted(wrap(statusText(), Math.max(1, columns - 1))[0]));
    output.write('\x1b8');
    if (!rl.line) {
      const placeholder = continuation.length ? 'Continue your message…' : 'Ask a question or describe a task…';
      output.write('\x1b7' + muted(wrap(placeholder, Math.max(1, columns - 3))[0]) + '\x1b8');
    }
  }
  function header(value, context) {
    if (!terminal) { write(value.title ?? 'Conversation'); return; }
    const columns = Math.max(8, Math.min(66, width()));
    const bodyWidth = columns - 4;
    const rows = [accent('CONVOY'), ...wrap('Ship. Ship a lot.', bodyWidth).map(muted), '', ...wrap(value.title ?? 'New conversation', bodyWidth).map(line => paint(line, '1')),
      ...wrap([value.model, context?.projectName].filter(Boolean).join(' · '), bodyWidth).map(muted)];
    const lines = rows.map(line => muted('│ ') + line + ' '.repeat(Math.max(0, bodyWidth - cells(line))) + muted(' │'));
    output.write('\n' + muted('╭' + '─'.repeat(columns - 2) + '╮') + '\n' + lines.join('\n') + '\n' + muted('╰' + '─'.repeat(columns - 2) + '╯') + '\n');
    if (sessionId) output.write(muted(`  ${sessionId}`) + '\n');
    if (value.workspace?.path) output.write(muted('  ' + terminalText(value.workspace.path)) + '\n');
    output.write('\n');
  }
  function panel(title, body, actions) {
    if (!terminal) { write(`\n${title}\n${body}\n${actions}`); return; }
    const columns = Math.max(8, Math.min(74, width()));
    const inner = Math.max(4, columns - 4);
    const lines = [title, '', body].flatMap(text => wrap(text, inner));
    write('\n' + '╭' + '─'.repeat(columns - 2) + '╮' + '\n' + lines.map(line => '│ ' + line + ' '.repeat(Math.max(0, inner - cells(line))) + ' │').join('\n') + '\n' + '╰' + '─'.repeat(columns - 2) + '╯', 'warning');
    write(actions, 'meta');
  }
  function write(value, kind = 'text') {
    if (streamBuffer) flushAssistant();
    const saved = eraseFooter();
    output.write(format(terminalText(value), kind) + '\n');
    footer(saved);
  }
  function redraw() { const saved = eraseFooter(); footer(saved); }
  function appendAssistant(text) {
    if (terminal) {
      streamBuffer += text;
      if (!streamTimer) { streamTimer = setTimeout(flushAssistant, 32); streamTimer.unref(); }
    } else renderAssistant(text);
  }
  function flushAssistant() {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    const text = streamBuffer;
    streamBuffer = '';
    if (text) renderAssistant(text);
  }
  function renderAssistant(text) {
    const safe = terminalText(text);
    if (!assistantOpen) { codeFence = false; write('\nConvoy', 'assistant'); assistantOpen = true; }
    tail += safe;
    if (!terminal) { output.write(safe); tail = ''; return; }
    const end = tail.lastIndexOf('\n');
    if (end !== -1) {
      const complete = tail.slice(0, end);
      tail = tail.slice(end + 1);
      write(complete, 'markdown');
    } else redraw();
  }
  function finishAssistant(text, interrupted = false) {
    if (streaming && text.startsWith(streaming)) appendAssistant(text.slice(streaming.length));
    else if (!streaming) appendAssistant(text);
    else { flushAssistant(); const unfinished = tail; tail = ''; if (unfinished) write(unfinished); codeFence = false; write('\nConvoy · corrected response', 'assistant'); write(text, 'markdown'); }
    flushAssistant();
    const remaining = tail;
    tail = '';
    if (terminal) write(remaining, 'markdown');
    else output.write('\n');
    if (interrupted) write('Response interrupted; retained text is unfinished.');
    streaming = '';
    assistantOpen = false;
  }
  function partial(update) {
    if (view !== 'all' && update.agentSessionId && update.agentSessionId !== view) return;
    if (typeof update.text !== 'string' || update.version < version) return;
    version = update.version ?? version;
    if (!update.text || update.text === streaming) return;
    if (update.text.startsWith(streaming)) appendAssistant(update.text.slice(streaming.length));
    else { clearTimeout(streamTimer); streamTimer = undefined; streamBuffer = ''; streaming = ''; tail = ''; appendAssistant(update.text); }
    streaming = update.text;
  }
  function observe(value, context) {
    if (!session) header(value, context);
    session = value;
    const owned = value.lease?.client === client && value.lease.expiresAt > Date.now();
    updateActivity();
    const events = value.events ?? [];
    if (sequence && events[0]?.seq > sequence + 1) write('Earlier activity was compacted; showing the retained history.');
    const fresh = events.filter(event => event.seq > sequence);
    if (fresh.length) flushAssistant();
    for (const event of fresh) {
      sequence = event.seq;
      if (view !== 'all' && event.agentSessionId && event.agentSessionId !== view) continue;
      if (event.type === 'user') {
        if (!localMessages.delete(event.requestId)) write(event.text ?? '', 'message');
      }
      else if (event.type === 'assistant' || event.type === 'assistant_interrupted') {
        finishAssistant(event.text ?? '', event.type === 'assistant_interrupted');
      } else if (event.type === 'tool_started') { activeTool = event.tool; write(`  ◦ ${event.tool.replaceAll('_', ' ')}…`, 'activity'); }
      else if (event.type === 'tool_result') {
        activeTool = undefined;
        lastTool = event;
        write(`  ${event.isError || event.output?.error ? '×' : '✓'} ${event.tool.replaceAll('_', ' ')}${event.output?.error ? ': ' + event.output.error : ''}`, event.isError || event.output?.error ? 'warning' : 'activity');
      } else if (['failed', 'interrupted', 'execution_interrupted', 'placement_error', 'workflow_error'].includes(event.type)) {
        write(`\n${event.message ?? event.type.replaceAll('_', ' ')}`, 'warning');
      } else if (['step_activated', 'step_completed'].includes(event.type)) write(`  ${event.type === 'step_activated' ? '◦' : '✓'} ${event.name ?? event.nodeId}`, 'activity');
    }
    if ((value.streamVersion ?? 0) >= version) partial({ text: value.partial ?? '', version: value.streamVersion ?? 0 });
    if (value.pending?.id && value.pending.id !== pendingId) {
      const pending = value.pending;
      const args = pending.args ?? {};
      const body = typeof args.command === 'string' ? '$ ' + args.command : Object.entries(args).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
      panel(`Approval required · ${pending.tool}`, body, `/approve ${pending.id}   /deny ${pending.id}`);
    }
    pendingId = value.pending?.id;
    if (value.pendingQuestion?.id && value.pendingQuestion.id !== questionId) panel('Question', value.pendingQuestion.question, '/answer YOUR ANSWER');
    questionId = value.pendingQuestion?.id;
    if (!working) activeTool = undefined;
    const tool = value.inFlightTool?.name ?? activeTool;
    const label = { idle: 'ready', running: tool ? `running ${tool.replaceAll('_', ' ')}…` : 'generating response…', queued: 'queued', waiting_approval: 'approval required', waiting_question: 'answer required',
      waiting_gate: 'review required', awaiting_review: value.flow ? 'review required' : 'ready' }[value.status] ?? value.status.replaceAll('_', ' ');
    const nextStatus = terminalText(`${label} · ${value.model ?? 'session model'}${readOnly ? ' · read only' : owned ? '' : ' · /claim for control'} · /help`).replace(/\s+/g, ' ');
    const statusChanged = nextStatus !== status;
    status = nextStatus;
    if (statusChanged && !terminal) write(`[${status}]`);
    if (statusChanged) redraw();
  }
  return {
    write, observe, partial,
    sending(text, requestId) {
      if (!terminal || readOnly) return;
      localMessages.add(requestId);
      sending.add(requestId);
      write(text, 'message');
    },
    sent(requestId) { if (sending.delete(requestId)) redraw(); },
    close() { quitting = true; flushAssistant(); clearInterval(activityTimer); rl.close(); },
    setView(id) { clearTimeout(streamTimer); streamTimer = undefined; streamBuffer = ''; activeTool = undefined; view = id; sequence = 0; version = -1; streaming = ''; tail = ''; assistantOpen = false; localMessages.clear(); },
    start({ submit, disconnect }) {
      started = true;
      function insert(text) {
        const saved = eraseFooter();
        footer({ draft: saved.draft.slice(0, saved.position) + text + saved.draft.slice(saved.position), position: saved.position + text.length });
      }
      const capture = (_text, key) => {
        if (key.name === 'paste-start') { pasting = true; paste = ''; }
        else if (key.name === 'paste-end' && pasting) {
          pasting = false;
          insert(terminalText(paste.replace(/\r\n?/g, '\n')));
          paste = '';
        } else if (pasting) paste += key.sequence ?? _text ?? '';
        else if (key.sequence === '\x1b[13;2u' || (['return', 'enter'].includes(key.name) && (key.shift || key.meta))) insert('\n');
        else {
          if (['return', 'enter'].includes(key.name)) submittedDraft = rl.line;
          return;
        }
        // Readline handles ordinary editing. Consume paste boundaries and the
        // newline shortcut before its Enter handler can submit a partial draft.
        key.name = 'escape';
      };
      if (terminal) { input.prependListener('keypress', capture); output.write('\x1b[?2004h'); }
      rl.on('SIGINT', () => {
        if (rl.line || continuation.length) {
          rl.write(null, { ctrl: true, name: 'u' }); rl.write(null, { ctrl: true, name: 'k' });
          continuation = []; redraw();
        } else if (session?.control?.busy || working || session?.status === 'queued') write('Agent work is still running. Use /stop to stop it or /quit to disconnect.');
        else rl.close();
      });
      rl.on('line', line => {
        // Some Node releases encode multiline history as reversed CR-separated
        // lines. Send the editor's original text, independently of that encoding.
        if (terminal && submittedDraft !== undefined) {
          line = submittedDraft;
          submittedDraft = undefined;
          if (rl.history?.length) rl.history[0] = line;
        }
        if (terminal) {
          const height = draftHeight(line);
          cursorTo(output, 0);
          moveCursor(output, 0, -(footerRows + height));
          clearScreenDown(output);
        }
        footerRows = 0;
        if (line.endsWith('\\')) { continuation.push(line.slice(0, -1)); redraw(); return; }
        const text = [...continuation, line].join('\n').trim();
        continuation = [];
        if (!text) { redraw(); return; }
        redraw();
        queued = queued.then(async () => {
          if (quitting) return;
          if (text === '/help') write(Object.entries(commands).map(([name, help]) => `${name.padEnd(20)} ${help}`).join('\n') + '\n\nTab completes commands · Up/Down recalls input · Enter sends\nShift+Enter or Alt+Enter adds a line · Pasted blocks wait for Enter\nEnd a line with \\ to continue · Ctrl+C clears a draft · Ctrl+D or /quit disconnects');
          else if (text === '/clear') { if (terminal) { output.write('\x1b[2J\x1b[H'); footerRows = 0; redraw(); } }
          else if (text === '/details') write(lastTool ? JSON.stringify(lastTool.output, null, 2).slice(0, 8000) : 'No tool results yet.');
          else await submit(text);
        }).catch(error => write(`Error: ${error.message}`)).finally(redraw);
      });
      const repaint = () => {
        if (repaintQueued || closed) return;
        repaintQueued = true;
        queueMicrotask(() => { repaintQueued = false; if (!closed) redraw(); });
      };
      // Readline already draws edits and cursor movement. Rebuild the frame only
      // when its height or placeholder changes, rather than rewriting the draft
      // and both borders for every keypress.
      const edit = () => {
        if (editQueued || closed) return;
        editQueued = true;
        queueMicrotask(() => {
          editQueued = false;
          if (closed) return;
          const rows = draftHeight(rl.line);
          if (rows !== inputRows || Boolean(!rl.line) !== inputEmpty) redraw();
        });
      };
      input.on('keypress', edit);
      const resize = () => {
        footerRows = footerLines.reduce((rows, line) => rows + Math.max(1, Math.ceil(cells(line) / Math.max(1, output.columns ?? 80))), 0);
        repaint();
      };
      output.on('resize', resize);
      rl.on('close', () => {
        closed = true;
        clearTimeout(streamTimer);
        streamTimer = undefined;
        streamBuffer = '';
        clearInterval(activityTimer);
        input.off('keypress', edit);
        input.off('keypress', capture);
        output.off('resize', resize);
        if (terminal) { output.write('\x1b[?2004l\x1b[0m'); cursorTo(output, 0); moveCursor(output, 0, inputRows + 2); output.write('\n'); }
        queued.finally(disconnect);
      });
      redraw();
      rl.resume();
    },
  };
}
