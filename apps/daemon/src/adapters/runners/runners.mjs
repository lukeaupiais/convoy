import { randomUUID } from 'node:crypto';
import {
  CommandSupervisor,
  TerminalSupervisor,
  driveCommand,
  executeRunner,
  runAgentLoop,
} from '../../../../../packages/runner/src/index.mjs';
import { createWorkerDeployment } from './worker-deployment.mjs';
import { connectWorker } from './worker-client.mjs';

export function createRunners({
  deployment = createWorkerDeployment(),
  connect = connectWorker,
  idleMs = 60000,
  extensionAdapters = {},
} = {}) {
  const local = new Map();
  const remote = new Map();
  const background = new Map();
  const terminals = new Map();
  let closing = false;
  const keyFor = (runner, workspace = '') =>
    `${runner.id ?? runner.host ?? runner.kind}:${workspace}`;
  const hasBackground = (key) =>
    [...background.values()].some((job) => job.key === key) ||
    [...terminals.values()].some((item) => item.key === key);
  function track(key, commandId, promise) {
    const job = { key, promise: Promise.resolve(promise) };
    background.set(commandId, job);
    job.promise
      .catch(() => {})
      .finally(() => {
        background.delete(commandId);
        scheduleIdle(key);
      });
  }
  function scheduleIdle(key) {
    const entry = local.get(key) ?? remote.get(key);
    if (!entry || entry.active || hasBackground(key) || closing) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entry.active || hasBackground(key)) return;
      if (local.get(key) === entry) {
        local.delete(key);
        void entry.supervisor.close('idle_cleanup');
      }
      if (remote.get(key) === entry) {
        remote.delete(key);
        entry.worker.close();
      }
    }, idleMs);
    entry.idleTimer.unref?.();
  }
  function localEntry(runner, workspace) {
    const key = keyFor(runner, workspace);
    let entry = local.get(key);
    if (!entry) {
      entry = {
        key,
        supervisor: new CommandSupervisor(),
        terminals: new TerminalSupervisor(),
        active: 0,
      };
      local.set(key, entry);
    }
    clearTimeout(entry.idleTimer);
    return entry;
  }
  async function remoteEntry(runner, workspace, signal) {
    const key = keyFor(runner, workspace);
    let entry = remote.get(key);
    if (entry && !entry.disconnected) {
      clearTimeout(entry.idleTimer);
      return entry;
    }
    const artifact = await deployment.ensure(runner.host, signal);
    entry = { key, handlers: null, active: 0, disconnected: false, artifact };
    const proxy = Object.fromEntries(
      ['prepare', 'generate', 'message', 'tool', 'afterRound'].map((method) => [
        method,
        (args) => {
          const handler = entry.handlers?.[method];
          if (!handler) throw new Error('No active agent owns this worker callback.');
          return handler(args);
        },
      ]),
    );
    entry.worker = connect(artifact, proxy, undefined, (error) => {
      entry.disconnected = true;
      clearTimeout(entry.idleTimer);
      if (remote.get(key) === entry) remote.delete(key);
      entry.handlers?.disconnected?.(error);
    });
    entry.hello = await entry.worker.call('hello');
    if (entry.hello.protocol !== 1 || !entry.hello.capabilities?.includes('session-commands-v1')) {
      entry.worker.close();
      throw new Error('Worker must be rebuilt for session command support.');
    }
    remote.set(key, entry);
    return entry;
  }
  async function remoteOperation(entry, request, signal) {
    if (entry.disconnected)
      throw new Error('Worker disconnected. Inspect session commands before retrying.');
    const operationId = randomUUID();
    let aborted = false;
    const abort = () => {
      aborted = true;
      void entry.worker.call('cancel_operation', { operationId }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await entry.worker.call('execute', { ...request, operationId });
      if (aborted)
        throw new Error(
          'Stopped. Remote operation completed during cancellation; inspect its result before retrying.',
        );
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async function ephemeral(runner, request, signal) {
    const artifact = await deployment.ensure(runner.host, signal);
    const worker = connect(artifact, {}, signal);
    const timer = setTimeout(() => worker.close(), 75000);
    try {
      const hello = await worker.call('hello');
      if (hello.protocol !== 1) throw new Error('Worker protocol mismatch.');
      const result = await worker.call('execute', { ...request, operationId: randomUUID() });
      return request.action === 'probe'
        ? { ...result, worker: { ...hello, sha256: artifact.sha256 } }
        : result;
    } finally {
      clearTimeout(timer);
      worker.close();
    }
  }
  const isCommandTool = (request) =>
    request.action === 'tool' && ['shell', 'start_command'].includes(request.name);
  const isCommandControl = (request) => request.action === 'command_input';
  const isTerminal = (request) =>
    ['terminal_start', 'terminal_status', 'terminal_stop', 'terminal_read'].includes(
      request.action,
    );
  const withExecutionAccess = (runner, request) => {
    if (!['probe', 'tool', 'command_start', 'terminal_start'].includes(request.action))
      return request;
    const requested = request.accessMode ?? runner.accessMode ?? 'contained';
    if (requested === 'trusted' && runner.accessMode !== 'trusted')
      throw new Error('Runner policy does not permit trusted host execution.');
    return { ...request, accessMode: requested };
  };
  function trackTerminal(key, request, result) {
    if (request.action === 'terminal_start' && result?.terminalId)
      terminals.set(result.terminalId, { key });
    if (request.terminalId && result?.state && result.state !== 'running')
      terminals.delete(request.terminalId);
  }
  const terminalResult = (runner, result) =>
    result?.connection
      ? {
          ...result,
          connection: {
            ...result.connection,
            kind: runner.kind,
            ...(runner.kind === 'ssh' ? { host: runner.host } : {}),
          },
        }
      : result;
  async function execute(runner, request, signal, progress) {
    request = withExecutionAccess(runner, request);
    if (runner.kind === 'local') {
      if (!isCommandTool(request) && !isCommandControl(request) && !isTerminal(request))
        return executeRunner(request, signal, undefined, undefined, extensionAdapters);
      const entry = localEntry(runner, request.workspace);
      entry.active++;
      try {
        if (isTerminal(request)) {
          const result = terminalResult(
            runner,
            await executeRunner(request, signal, entry.supervisor, entry.terminals, extensionAdapters),
          );
          trackTerminal(entry.key, request, result);
          return result;
        }
        if (isCommandControl(request))
          return executeRunner(request, signal, entry.supervisor, entry.terminals, extensionAdapters);
        return await driveCommand(
          (r) =>
            executeRunner(
              r,
              request.name === 'start_command' ? undefined : signal,
              entry.supervisor,
              entry.terminals, extensionAdapters,
            ),
          request,
          progress,
          (id, promise) => track(entry.key, id, promise),
          signal,
        );
      } finally {
        entry.active--;
        scheduleIdle(entry.key);
      }
    }
    if (runner.kind !== 'ssh') throw new Error('Unsupported runner.');
    if (!isCommandTool(request) && !isCommandControl(request) && !isTerminal(request))
      return ephemeral(runner, request, signal);
    const entry = await remoteEntry(runner, request.workspace, signal);
    entry.active++;
    try {
      if (isTerminal(request)) {
        const result = terminalResult(runner, await remoteOperation(entry, request, signal));
        trackTerminal(entry.key, request, result);
        return result;
      }
      if (isCommandControl(request)) return remoteOperation(entry, request, signal);
      const operationSignal = request.name === 'start_command' ? undefined : signal;
      return await driveCommand(
        (r) => remoteOperation(entry, r, operationSignal),
        request,
        progress,
        (id, promise) => track(entry.key, id, promise),
        signal,
      );
    } finally {
      entry.active--;
      scheduleIdle(entry.key);
    }
  }
  async function runAgent(runner, options, handlers, signal) {
    if (!runner || runner.kind === 'local') {
      const entry = runner && options.workspace ? localEntry(runner, options.workspace) : null;
      handlers.setExecutor?.((target, request, operationSignal = signal, progress) =>
        execute(target, request, operationSignal, progress),
      );
      if (entry) entry.active++;
      try {
        return await runAgentLoop(options, (method, args) => handlers[method](args));
      } finally {
        handlers.setExecutor?.(null);
        if (entry) {
          entry.active--;
          scheduleIdle(entry.key);
        }
      }
    }
    if (runner.kind !== 'ssh') throw new Error('Unsupported runner.');
    if (!options.workspace) throw new Error('Remote agent execution requires a workspace.');
    const entry = await remoteEntry(runner, options.workspace, signal);
    if (entry.handlers) throw new Error('Workspace worker already owns an agent turn.');
    const inFlight = new Set();
    const wireHandlers = Object.fromEntries(
      ['prepare', 'generate', 'message', 'tool', 'afterRound'].map((method) => [
        method,
        (args) => {
          if (signal?.aborted) throw new Error('Stopped');
          const pending = Promise.resolve().then(() => handlers[method](args));
          inFlight.add(pending);
          pending.then(
            () => inFlight.delete(pending),
            () => inFlight.delete(pending),
          );
          return pending;
        },
      ]),
    );
    wireHandlers.disconnected = () => handlers.disconnected?.();
    entry.handlers = wireHandlers;
    entry.active++;
    const executionId = randomUUID();
    const abort = () => {
      void entry.worker.call('cancel_run', { executionId }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await handlers.started?.({ ...entry.hello, sha256: entry.artifact.sha256, executionId });
      handlers.setExecutor?.((target, request, operationSignal = signal, progress) => {
        if (target.id !== runner.id) return execute(target, request, operationSignal, progress);
        request = withExecutionAccess(runner, request);
        const requestSignal = request.name === 'start_command' ? undefined : operationSignal;
        return isCommandTool(request)
          ? driveCommand(
              (r) => remoteOperation(entry, r, requestSignal),
              request,
              progress,
              (id, promise) => track(entry.key, id, promise),
              operationSignal,
            )
          : remoteOperation(entry, request, operationSignal);
      });
      return await entry.worker.call('run', { ...options, executionId });
    } catch (error) {
      if (inFlight.size) handlers.disconnected?.();
      await Promise.allSettled([...inFlight]);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      handlers.setExecutor?.(null);
      entry.handlers = null;
      entry.active--;
      scheduleIdle(entry.key);
    }
  }
  async function close() {
    if (closing) return;
    closing = true;
    const stopping = [];
    for (const entry of local.values()) {
      clearTimeout(entry.idleTimer);
      stopping.push(
        entry.supervisor.close('daemon_shutdown'),
        entry.terminals.close('daemon_shutdown'),
      );
    }
    for (const entry of remote.values()) {
      clearTimeout(entry.idleTimer);
      entry.worker.close();
    }
    await Promise.allSettled([...background.values()].map((job) => job.promise));
    await Promise.allSettled(stopping);
    local.clear();
    remote.clear();
    background.clear();
    terminals.clear();
  }
  return {
    execute,
    runAgent,
    close,
    backgroundCount: (runnerId) =>
      [...background.values()].filter((job) => job.key.startsWith(`${runnerId}:`)).length +
      [...terminals.values()].filter((item) => item.key.startsWith(`${runnerId}:`)).length,
  };
}
