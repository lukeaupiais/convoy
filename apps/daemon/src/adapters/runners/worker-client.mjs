import { spawn } from 'node:child_process';
import { createRpc } from '../../../../../packages/runner/src/index.mjs';
export function connectWorker(deployment, handlers = {}, signal, disconnected = () => {}) {
  const child = spawn('ssh', [...deployment.args, deployment.command], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) } });
  child.stderr.resume();
  const rpc = createRpc(child.stdout, child.stdin, handlers, error => { child.kill(); disconnected(error); });
  child.on('error', error => rpc.close(error)); child.on('exit', () => rpc.close());
  const abort = () => { rpc.close(new Error('Stopped. Remote outcome may be uncertain; inspect before retrying.')); child.kill(); };
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  return { call: rpc.call, close() { signal?.removeEventListener('abort', abort); child.stdin.end(); child.kill(); rpc.close(); } };
}
