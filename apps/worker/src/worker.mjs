import { hostname, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, open } from 'node:fs/promises';
import { CommandSupervisor, TerminalSupervisor, createRpc, executeRunner, runAgentLoop } from '../../../packages/runner/src/index.mjs';

const controller = new AbortController(); let active = false; let journal; let runController; let runExecutionId;
// A portable worker is a pipe-owned daemon. Keep the event loop alive even on
// Node versions that do not retain a referenced handle for piped stdin.
const keepAlive = setInterval(() => {}, 60_000);
const operations = new Map();
const supervisor = new CommandSupervisor();
const terminals = new TerminalSupervisor();
async function record(entry) {
  if (!journal) return;
  await journal.writeFile(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  await journal.sync();
}
const rpc = createRpc(process.stdin, process.stdout, {
  hello: async () => ({ protocol: 1, capabilities: ['command-lifecycle-v1', 'session-commands-v1', 'atomic-patch-v1', ...(await terminals.available() ? ['native-terminal-v1'] : [])], hostname: hostname(), platform: process.platform, arch: process.arch, pid: process.pid, execution: 'worker' }),
  execute: async request => {
    if (!/^[a-f0-9-]{36}$/.test(request.operationId ?? '')) throw new Error('Invalid operation ID.');
    if (operations.has(request.operationId)) throw new Error('Operation ID already active.');
    const operation = new AbortController(); operations.set(request.operationId, operation);
    if (request.action !== 'command_poll') await record({ type: 'operation_started', action: request.action, name: request.name });
    try {
      const result = await executeRunner(request, request.lifetime === 'session' ? undefined : operation.signal, supervisor, terminals);
      if (request.action !== 'command_poll') await record({ type: 'operation_finished', action: request.action, name: request.name });
      return result;
    } finally { operations.delete(request.operationId); }
  },
  cancel_operation: async ({ operationId }) => { operations.get(operationId)?.abort(); return { cancelled: operations.has(operationId) }; },
  cancel_run: async ({ executionId }) => { if (executionId === runExecutionId) runController?.abort(); return { cancelled: executionId === runExecutionId }; },
  run: async options => {
    if (active) throw new Error('Worker already owns an execution.');
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(options.executionId) || !Number.isInteger(options.maxRounds) || options.maxRounds < 1 || options.maxRounds > 100) throw new Error('Invalid execution.');
    active = true; runController = new AbortController(); runExecutionId = options.executionId;
    const directory = process.env.CONVOY_WORKER_STATE ?? join(homedir(), '.local', 'share', 'convoy', 'executions');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    journal = await open(join(directory, options.executionId + '.jsonl'), 'ax', 0o600);
    try {
      await record({ type: 'started', hostname: hostname(), pid: process.pid });
      await runAgentLoop(options, (method, args) => { if (runController.signal.aborted) throw new Error('Stopped'); return rpc.call(method, args); }, record);
      await record({ type: 'completed' });
      return { completed: true };
    } catch (error) { await record({ type: 'interrupted', message: error.message }); throw error; }
    finally { await journal.close(); journal = null; active = false; runController = null; runExecutionId = null; }
  },
}, shutdown);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  clearInterval(keepAlive);
  controller.abort(); runController?.abort(); for (const operation of operations.values()) operation.abort();
  // Allow TERM/KILL/reap to finish before exiting. No detached execution.
  await Promise.allSettled([supervisor.close(), terminals.close()]); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
