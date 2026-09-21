import { requiredText } from '../../shared/validation.mjs';

const commandActions = new Set([
  'readCommandOutput',
  'stopCommand',
  'openTerminal',
  'terminalStatus',
  'terminalConnection',
  'readTerminalOutput',
  'stopTerminal',
]);

/**
 * Owns the retained command and native-terminal lifecycle for a session.
 * Runtime policy still decides when a caller has a lease and may invoke it.
 */
export function createSessionExecution({
  commandLogs,
  runners,
  runnerFor,
  placement,
  extensionTool,
  event,
  save,
  isClosing,
  executionPolicy,
}) {
  const commandControls = new Map();
  const terminalControls = new Map();
  const terminalMonitors = new Map();

  function executionAccess(session, runner = runnerFor(session)) {
    const grant = session.executionGrant ?? executionPolicy.resolve(session, runner);
    if (grant.runnerId && grant.runnerId !== runner.id)
      throw new Error('Execution grant belongs to another runner. Reconcile the assignment first.');
    if (session.assignment?.policyDigest && session.assignment.policyDigest !== grant.digest)
      throw new Error('Execution grant no longer matches the assignment lease. Reconcile it first.');
    if (grant.envelope.isolation === 'none')
      throw new Error(`Execution profile ${grant.profileId} does not permit runner execution.`);
    if (grant.envelope.isolation === 'host' && runner.accessMode !== 'trusted')
      throw new Error('This execution profile requires a runner trusted for host access.');
    return {
      grant,
      accessMode: grant.envelope.isolation === 'host' ? 'trusted' : 'contained',
    };
  }

  function activeTerminal(session) {
    return (session.terminals ?? []).find((item) => item.state === 'running');
  }

  function concurrentWorkspaceExecution(session, startedAt, endedAt = Date.now(), exceptCommandId) {
    const overlaps = (item) =>
      item.startedAt <= endedAt && (!item.endedAt || item.endedAt >= startedAt);
    return (
      (session.terminals ?? []).some(overlaps) ||
      (session.commands ?? []).some((item) => item.commandId !== exceptCommandId && overlaps(item))
    );
  }

  function sessionTerminal(session, terminalId) {
    if (typeof terminalId !== 'string' || !/^[a-f0-9-]{36}$/.test(terminalId)) {
      throw new Error('Invalid terminal ID.');
    }
    const terminal = (session.terminals ?? []).find((item) => item.terminalId === terminalId);
    if (!terminal) {
      throw new Error(
        'Terminal does not belong to this conversation or its retained record expired.',
      );
    }
    return terminal;
  }

  async function recordTerminal(session, update) {
    session.terminals ??= [];
    let record = session.terminals.find((item) => item.terminalId === update.terminalId);
    const prior = record?.state;
    const changed =
      !record ||
      record.state !== update.state ||
      record.attached !== update.attached ||
      record.code !== update.code ||
      record.reason !== update.reason ||
      record.endedAt !== update.endedAt;
    if (!record) {
      while (session.terminals.length >= 10) session.terminals.shift();
      record = { terminalId: update.terminalId };
      session.terminals.push(record);
    }
    const { connection, ...snapshot } = update;
    Object.assign(record, snapshot);
    if (connection) {
      terminalControls.set(update.terminalId, {
        ...(terminalControls.get(update.terminalId) ?? {}),
        sessionId: session.id,
        connection,
      });
    }
    if (prior && prior === 'running' && update.state !== 'running') {
      event(session, update.state === 'lost' ? 'terminal_lost' : 'terminal_finished', {
        terminalId: update.terminalId,
        code: update.code,
        reason: update.reason,
      });
    }
    if (changed) await save();
    return record;
  }

  function monitorTerminal(session, terminalId) {
    if (terminalMonitors.has(terminalId)) return;
    const promise = (async () => {
      while (!isClosing()) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const update = await runners.execute(runnerFor(session), {
            action: 'terminal_status',
            workspace: session.workspace.path,
            terminalId,
          });
          await recordTerminal(session, update);
          if (update.state !== 'running') return;
        } catch (error) {
          const record = sessionTerminal(session, terminalId);
          record.state = 'lost';
          record.reason = 'terminal_connection_lost';
          record.endedAt = Date.now();
          terminalControls.delete(terminalId);
          event(session, 'terminal_lost', { terminalId, message: error.message });
          await save();
          return;
        }
      }
    })().finally(() => terminalMonitors.delete(terminalId));
    terminalMonitors.set(terminalId, promise);
  }

  function sessionCommand(session, commandId) {
    if (typeof commandId !== 'string' || !/^[a-f0-9-]{36}$/.test(commandId)) {
      throw new Error('Invalid command ID.');
    }
    const command = (session.commands ?? []).find((item) => item.commandId === commandId);
    if (!command) {
      throw new Error(
        'Command does not belong to this conversation or its retained record expired.',
      );
    }
    return command;
  }

  function commandStatus(session, commandId) {
    const command = sessionCommand(session, commandId);
    return {
      commandId: command.commandId,
      command: command.command,
      lifetime: command.lifetime,
      state: command.state,
      code: command.code,
      signal: command.signal,
      reason: command.reason,
      error: command.error,
      startedAt: command.startedAt,
      endedAt: command.endedAt,
      retainedBytes: command.retainedBytes,
      output: command.output,
      truncated: command.truncated,
    };
  }

  async function readCommandOutput(session, commandId, cursor = 0) {
    const command = sessionCommand(session, commandId);
    if (!command.retainedBytes) return { text: '', cursor: 0, hasMore: false, size: 0 };
    return commandLogs.read(commandId, cursor);
  }

  async function sendCommandInput(session, commandId, input, close = false) {
    const command = sessionCommand(session, commandId);
    const control = commandControls.get(commandId);
    if (command.state !== 'running' || !control || control.sessionId !== session.id)
      throw new Error('Command is no longer controllable. Its worker may have disconnected.');
    if (typeof input !== 'string' || !input.length || Buffer.byteLength(input) > 8192)
      throw new Error('Command input must be 1-8192 bytes.');
    return runners.execute(runnerFor(session), {
      action: 'command_input',
      workspace: session.workspace.path,
      commandId,
      input,
      close,
    });
  }

  async function stopCommand(session, commandId) {
    const command = sessionCommand(session, commandId);
    const control = commandControls.get(commandId);
    if (!['running', 'stopping'].includes(command.state)) return commandStatus(session, commandId);
    if (!control || control.sessionId !== session.id) {
      throw new Error('Command is no longer controllable. Its worker may have disconnected.');
    }
    await control.stop();
    for (
      let attempt = 0;
      attempt < 100 && ['running', 'stopping'].includes(command.state);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (['running', 'stopping'].includes(command.state)) {
      throw new Error(
        'Stop was requested but confirmed exit has not arrived. Inspect this command before retrying.',
      );
    }
    return commandStatus(session, commandId);
  }

  async function commandProgress(session, args, update, stop) {
    const prior = (session.commands ?? []).find(
      (item) => item.commandId === update.commandId,
    )?.state;
    session.commands ??= [];
    let record = session.commands.find((item) => item.commandId === update.commandId);
    if (record && record.cursor === update.cursor && record.state === update.state) return;
    if (!record) {
      while (session.commands.length >= 30) {
        const old = session.commands.shift();
        await commandLogs.remove(old.commandId);
        commandControls.delete(old.commandId);
      }
      record = {
        commandId: update.commandId,
        callId: session.inFlightTool?.callId,
        agentSessionId: session.currentAgentSessionId,
        command: args.command,
      };
      session.commands.push(record);
    }
    if (update.chunks?.length) await commandLogs.append(update.commandId, update.chunks);
    const { chunks, ...snapshot } = update;
    Object.assign(record, snapshot);
    if (['running', 'stopping'].includes(update.state)) {
      commandControls.set(update.commandId, { sessionId: session.id, stop });
    } else {
      commandControls.delete(update.commandId);
    }
    if (prior && !['exited', 'lost'].includes(prior) && ['exited', 'lost'].includes(update.state)) {
      event(session, update.state === 'lost' ? 'command_lost' : 'command_finished', {
        commandId: update.commandId,
        code: update.code,
        reason: update.reason,
      });
    }
    await save();
  }

  async function tool(session, name, args, signal, execute = runners.execute.bind(runners)) {
    let activeId;
    try {
      const extension = extensionTool?.(session, name);
      const access = executionAccess(session);
      return await execute(
        runnerFor(session),
        extension
          ? { action: 'extension', workspace: session.workspace.path, extension: extension.extension, adapter: extension.extension.adapter, tool: extension.id, args }
          : { action: 'tool', workspace: session.workspace.path, name, args, accessMode: access.accessMode },
        signal,
        async (update, stop) => {
          activeId = update.commandId;
          await commandProgress(session, args, update, stop);
        },
      );
    } catch (error) {
      if (
        runnerFor(session).kind === 'ssh' &&
        ['write_file', 'apply_patch', 'shell'].includes(name)
      ) {
        await placement.uncertain(
          session,
          'Remote mutation outcome is uncertain. Inspect the original runner before continuing.',
        );
      }
      throw error;
    } finally {
      if (activeId && name !== 'start_command') {
        commandControls.delete(activeId);
        const record = session.commands.find((command) => command.commandId === activeId);
        if (record && record.state !== 'exited') {
          record.state = 'lost';
          record.reason = 'connection_or_execution_failed';
        }
      }
    }
  }

  async function command(session, input) {
    switch (input.action) {
      case 'readCommandOutput':
        sessionCommand(session, input.commandId);
        return commandLogs.read(input.commandId, input.cursor ?? 0);
      case 'stopCommand':
        return stopCommand(session, input.commandId);
      case 'openTerminal': {
        if (!session.workspace || !session.runnerId)
          throw new Error('Assign a workspace before opening a terminal.');
        if (session.assignment?.state === 'uncertain')
          throw new Error('Reconcile the original runner before opening a terminal.');
        const runner = runnerFor(session);
        const access = executionAccess(session, runner);
        if (!access.grant.envelope.process.terminal)
          throw new Error(`Execution profile ${access.grant.profileId} does not permit terminals.`);
        if (!runner.capabilities?.terminal)
          throw new Error(
            'Native terminal unavailable on this runner. Bubblewrap and tmux are required.',
          );
        const existing = activeTerminal(session);
        if (existing) {
          const control = terminalControls.get(existing.terminalId);
          if (!control?.connection)
            throw new Error(
              'The existing terminal is no longer attachable. Stop or reconcile it first.',
            );
          const status = await runners.execute(runner, {
            action: 'terminal_status',
            workspace: session.workspace.path,
            terminalId: existing.terminalId,
          });
          await recordTerminal(session, status);
          if (status.state === 'running') return { ...status, connection: control.connection };
        }
        const terminalCommand =
          input.command === undefined ? undefined : requiredText(input.command, 4000);
        const result = await runners.execute(runner, {
          action: 'terminal_start',
          workspace: session.workspace.path,
          command: terminalCommand,
          cols: input.cols ?? 120,
          rows: input.rows ?? 36,
          timeoutMs: input.timeoutMs ?? 4 * 60 * 60 * 1000,
          accessMode: access.accessMode,
        });
        const connection = {
          ...result.connection,
          kind: runner.kind,
          ...(runner.kind === 'ssh' ? { host: runner.host } : {}),
        };
        await recordTerminal(session, {
          ...result,
          command: terminalCommand ?? 'interactive shell',
          connection,
        });
        event(session, 'terminal_started', { terminalId: result.terminalId, runnerId: runner.id });
        await save();
        monitorTerminal(session, result.terminalId);
        return { ...result, connection };
      }
      case 'terminalStatus': {
        const terminal = sessionTerminal(session, input.terminalId);
        if (terminal.state !== 'running') return terminal;
        const result = await runners.execute(runnerFor(session), {
          action: 'terminal_status',
          workspace: session.workspace.path,
          terminalId: terminal.terminalId,
        });
        await recordTerminal(session, result);
        return result;
      }
      case 'terminalConnection': {
        const terminal = sessionTerminal(session, input.terminalId);
        if (terminal.state !== 'running') throw new Error('Terminal is no longer running.');
        const control = terminalControls.get(terminal.terminalId);
        if (!control?.connection || control.sessionId !== session.id)
          throw new Error('Terminal connection is unavailable.');
        return { ...terminal, connection: control.connection };
      }
      case 'readTerminalOutput': {
        const terminal = sessionTerminal(session, input.terminalId);
        return runners.execute(runnerFor(session), {
          action: 'terminal_read',
          workspace: session.workspace.path,
          terminalId: terminal.terminalId,
          cursor: input.cursor ?? 0,
        });
      }
      case 'stopTerminal': {
        const terminal = sessionTerminal(session, input.terminalId);
        if (terminal.state !== 'running') return terminal;
        const result = await runners.execute(runnerFor(session), {
          action: 'terminal_stop',
          workspace: session.workspace.path,
          terminalId: terminal.terminalId,
        });
        await recordTerminal(session, result);
        terminalControls.delete(terminal.terminalId);
        return result;
      }
      default:
        throw new Error(`Unsupported session execution command: ${input.action}`);
    }
  }

  return {
    activeTerminal,
    concurrentWorkspaceExecution,
    commandStatus,
    readCommandOutput,
    sendCommandInput,
    tool,
    stopCommand,
    handles: (action) => commandActions.has(action),
    command,
    close: () => Promise.allSettled([...terminalMonitors.values()]),
  };
}
