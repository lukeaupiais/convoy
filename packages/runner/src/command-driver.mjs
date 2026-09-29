import { randomUUID } from 'node:crypto';

function preview(state, chunks) {
  for (const chunk of chunks) {
    state.head = (state.head + chunk.text).slice(0, 6000);
    state.output += chunk.text;
    state.total += Buffer.byteLength(chunk.text);
  }
  state.output = state.output.slice(-12000);
  if (/^[\uDC00-\uDFFF]/.test(state.output)) state.output = state.output.slice(1);
}
const boundaries = (text) => text.replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/g, '');
function publicResult(result, state) {
  const head = boundaries(state.head);
  const tail = boundaries(state.output.slice(-6000));
  const omittedBytes = Math.max(0, state.total - Buffer.byteLength(head + tail));
  const { chunks, hasMore, ...rest } = result;
  return {
    ...rest,
    output:
      state.total > Buffer.byteLength(state.output)
        ? `${head}\n\n[${omittedBytes} bytes omitted from preview; read retained output using read_command_output with commandId and cursor: 0.]\n\n${tail}`
        : state.output,
    ...(state.total > Buffer.byteLength(state.output)
      ? {
          outputRead: { commandId: result.commandId, cursor: 0 },
          recovery:
            'Read retained output in pages before command retention expires (latest 30 commands). Capture may be incomplete on output_quota, log_error or worker_disconnected; inspect the exit reason.',
        }
      : {}),
    truncated: state.total > Buffer.byteLength(state.output),
  };
}

// Foreground calls settle only after confirmed exit. Session calls yield a
// running handle, while a tracked monitor continues draining and reporting it.
export async function driveCommand(
  execute,
  request,
  progress = async () => {},
  track = () => {},
  signal,
) {
  const background = request.name === 'start_command';
  const lifetime = background ? 'session' : 'turn';
  const timeoutMs = request.args.timeoutMs ?? (background ? 4 * 60 * 60 * 1000 : 600000);
  const yieldMs = background ? (request.args.yieldMs ?? 1000) : Infinity;
  const { commandId } = await execute({
    action: 'command_start',
    launchId: randomUUID(),
    workspace: request.workspace,
    command: request.args.command,
    timeoutMs,
    lifetime,
    ...(request.accessMode ? { accessMode: request.accessMode } : {}),
  });
  let cursor = 0;
  const state = { output: '', head: '', total: 0 };
  const stop = () => execute({ action: 'command_stop', workspace: request.workspace, commandId });
  let detached = false;
  const abort = () => {
    if (!detached) void stop().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  async function poll(waitMs) {
    const result = await execute({
      action: 'command_poll',
      workspace: request.workspace,
      commandId,
      cursor,
      waitMs,
    });
    cursor = result.cursor;
    preview(state, result.chunks);
    await progress(
      { ...result, output: state.output, truncated: state.total > Buffer.byteLength(state.output) },
      stop,
    );
    return result;
  }
  async function finish(initial) {
    let result = initial;
    try {
      while (result.state !== 'exited' || result.hasMore) result = await poll(500);
      const final = publicResult(result, state);
      await execute({ action: 'command_release', workspace: request.workspace, commandId });
      return final;
    } catch (error) {
      await progress(
        {
          commandId,
          lifetime,
          state: 'lost',
          reason: 'worker_disconnected',
          error: error.message,
          cursor,
          chunks: [],
          output: state.output,
          truncated: state.total > Buffer.byteLength(state.output),
        },
        stop,
      ).catch(() => {});
      throw error;
    }
  }
  try {
    let result;
    const until = Date.now() + yieldMs;
    do {
      result = await poll(background ? Math.max(0, Math.min(500, until - Date.now())) : 500);
    } while (result.state !== 'exited' && (!background || Date.now() < until));
    if (!background || result.state === 'exited') return await finish(result);
    detached = true;
    signal?.removeEventListener('abort', abort);
    track(commandId, finish(result));
    return publicResult(result, state);
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    throw error;
  } finally {
    if (!detached) signal?.removeEventListener('abort', abort);
  }
}
