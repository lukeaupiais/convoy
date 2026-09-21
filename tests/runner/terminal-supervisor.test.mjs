import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalSupervisor } from '../../packages/runner/src/index.mjs';
import { CommandSupervisor } from '../../packages/runner/src/index.mjs';
import { executeRunner, processRun } from '../../packages/runner/src/index.mjs';

const waitFor = async (supervisor, id, owner, state) => {
  for (let i = 0; i < 100; i++) {
    const value = await supervisor.status(id, owner);
    if (value.state === state) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Terminal did not reach ${state}`);
};

test('native terminal has an opaque attach descriptor, retained output and confirmed exit', async t => {
  const terminals = new TerminalSupervisor(); t.after(() => terminals.close());
  if (!(await terminals.available())) { t.skip('tmux unavailable'); return; }
  const started = await terminals.start('/bin/sh', ['-c', 'printf terminal-ready; sleep 0.1; exit 7'], { owner: '/workspace', cwd: '/tmp' });
  assert.match(started.terminalId, /^[a-f0-9-]{36}$/);
  assert.equal(started.connection.transport, 'tmux'); assert.match(started.connection.target, /^convoy-/);
  await assert.rejects(terminals.status(started.terminalId, '/other'), /belong/);
  const exited = await waitFor(terminals, started.terminalId, '/workspace', 'exited');
  assert.equal(exited.code, 7);
  const output = terminals.read(started.terminalId, '/workspace'); assert.match(output.text, /terminal-ready/);
});

test('stopping a detached native terminal kills it without treating detach as stop', async t => {
  const terminals = new TerminalSupervisor(); t.after(() => terminals.close());
  if (!(await terminals.available())) { t.skip('tmux unavailable'); return; }
  const started = await terminals.start('/bin/sh', ['-c', 'printf started; sleep 100'], { owner: '/workspace', cwd: '/tmp' });
  assert.equal((await terminals.status(started.terminalId, '/workspace')).state, 'running');
  const stopped = await terminals.stop(started.terminalId, '/workspace');
  assert.equal(stopped.state, 'exited'); assert.equal(stopped.reason, 'cancelled');
});

test('sandboxed terminal accepts native PTY input and resize', async t => {
  const root = await mkdtemp(join(tmpdir(), 'convoy-terminal-runner-'));
  const commands = new CommandSupervisor(); const terminals = new TerminalSupervisor();
  t.after(() => Promise.allSettled([commands.close(), terminals.close()]));
  let started;
  try { started = await executeRunner({ action: 'terminal_start', workspace: root, command: 'read value; printf "input:%s size:" "$value"; stty size; sleep 100', cols: 80, rows: 20 }, undefined, commands, terminals); }
  catch { t.skip('Bubblewrap and tmux are required'); return; }
  const tmux = (...args) => processRun('tmux', ['-S', started.connection.socket, ...args]);
  assert.equal((await tmux('resize-window', '-t', started.connection.target, '-x', '91', '-y', '23')).code, 0);
  assert.equal((await tmux('send-keys', '-t', started.connection.target, 'hello', 'Enter')).code, 0);
  let output = '';
  for (let i = 0; i < 100 && !output.includes('23 91'); i++) { await new Promise(resolve => setTimeout(resolve, 20)); output = terminals.read(started.terminalId, root).text; }
  assert.match(output, /input:hello size:23 91/);
  assert.equal((await executeRunner({ action: 'terminal_stop', workspace: root, terminalId: started.terminalId }, undefined, commands, terminals)).reason, 'cancelled');
});
