import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT = 16 * 1024 * 1024;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

function run(command, args, { env, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const collect = target => chunk => {
      if (target === 'stdout') stdout = (stdout + chunk).slice(-65536);
      else stderr = (stderr + chunk).slice(-65536);
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { code, stdout, stderr }));
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Terminal supervisor operation timed out.')); }, timeoutMs);
    timer.unref?.();
  });
}

// A real terminal is deliberately separate from captured command execution.
// tmux owns PTY input, resize and attachment; this module owns identity,
// lifecycle, retained bytes and an opaque connection descriptor.
export class TerminalSupervisor {
  constructor({ tmux = 'tmux', quotaBytes = MAX_OUTPUT } = {}) {
    this.tmux = tmux; this.quotaBytes = quotaBytes; this.records = new Map(); this.closed = false;
    this.directory = mkdtempSync(join(tmpdir(), 'convoy-terminals-'));
    this.socket = join(this.directory, 'tmux.sock');
  }
  async available() {
    try { return (await run(this.tmux, ['-V'])).code === 0; } catch { return false; }
  }
  get(id, owner) {
    const record = this.records.get(id);
    if (!record || record.owner !== owner) throw new Error('Terminal does not belong to this execution.');
    return record;
  }
  async start(command, args, { cwd, env, owner, cols = 120, rows = 36, timeoutMs = 4 * 60 * 60 * 1000 } = {}) {
    if (this.closed) throw new Error('Terminal execution stopped.');
    if (!Number.isInteger(cols) || cols < 40 || cols > 500 || !Number.isInteger(rows) || rows < 10 || rows > 300) throw new Error('Invalid terminal dimensions.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 12 * 60 * 60 * 1000) throw new Error('Invalid terminal deadline.');
    if (!(await this.available())) throw new Error('Native terminal unavailable: tmux is not installed on this runner.');
    const terminalId = randomUUID(); const target = `convoy-${terminalId}`;
    const script = join(this.directory, `${terminalId}.sh`); const gate = join(this.directory, `${terminalId}.ready`); const output = join(this.directory, `${terminalId}.log`); const exitFile = join(this.directory, `${terminalId}.exit`);
    const exitTemp = `${exitFile}.tmp`;
    const body = `#!/bin/sh\nwhile [ ! -e ${quote(gate)} ]; do sleep 0.01; done\n${[command, ...args].map(quote).join(' ')}\ncode=$?\nprintf '%s' "$code" > ${quote(exitTemp)}\nmv ${quote(exitTemp)} ${quote(exitFile)}\nexit "$code"\n`;
    writeFileSync(script, body, { mode: 0o700, flag: 'wx' }); closeSync(openSync(output, 'wx', 0o600));
    const created = await run(this.tmux, ['-S', this.socket, 'new-session', '-d', '-s', target, '-x', String(cols), '-y', String(rows), '-c', cwd, script], { env });
    if (created.code !== 0) { try { unlinkSync(script); unlinkSync(output); } catch {} throw new Error(`Native terminal could not start: ${created.stderr.trim() || 'tmux failed'}`); }
    try {
      const piped = await run(this.tmux, ['-S', this.socket, 'pipe-pane', '-o', '-t', target, `exec cat >> ${quote(output)}`], { env });
      if (piped.code !== 0) throw new Error(piped.stderr.trim() || 'tmux output capture failed');
      writeFileSync(gate, '', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await run(this.tmux, ['-S', this.socket, 'kill-session', '-t', target], { env }).catch(() => {});
      try { unlinkSync(script); unlinkSync(gate); unlinkSync(output); } catch {}
      throw new Error(`Native terminal could not start safely: ${error.message}`);
    }
    const record = { terminalId, target, owner, cwd, env, script, gate, output, exitFile, state: 'running', reason: null, code: null, startedAt: Date.now() };
    record.timer = setTimeout(() => { void this.stop(terminalId, owner, 'deadline'); }, timeoutMs); record.timer.unref?.();
    this.records.set(terminalId, record);
    return this.snapshot(record);
  }
  snapshot(record) {
    let retainedBytes = 0; try { retainedBytes = statSync(record.output).size; } catch {}
    return { terminalId: record.terminalId, state: record.state, code: record.code, signal: record.signal, reason: record.reason, startedAt: record.startedAt, endedAt: record.endedAt,
      attached: record.attached ?? 0, retainedBytes, connection: { transport: 'tmux', socket: this.socket, target: record.target } };
  }
  async status(id, owner) {
    const record = this.get(id, owner);
    if (record.state !== 'running') return this.snapshot(record);
    const result = await run(this.tmux, ['-S', this.socket, 'list-panes', '-t', record.target, '-F', '#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{session_attached}'], { env: record.env }).catch(error => ({ code: 1, stderr: error.message }));
    if (result.code !== 0) {
      try { const code = Number(readFileSync(record.exitFile, 'utf8')); if (!Number.isInteger(code)) throw new Error(); record.state = 'exited'; record.code = code; }
      catch { record.state = 'lost'; record.reason = 'terminal_unavailable'; }
      record.endedAt = Date.now(); clearTimeout(record.timer); return this.snapshot(record);
    }
    const [dead, code, signal, attached] = result.stdout.trim().split('\t'); record.attached = Number(attached) || 0;
    if (dead === '1') { record.state = 'exited'; record.code = code === '' ? null : Number(code); record.signal = signal || null; record.endedAt = Date.now(); clearTimeout(record.timer); }
    if (statSync(record.output).size > this.quotaBytes) await this.stop(id, owner, 'output_quota');
    return this.snapshot(record);
  }
  async stop(id, owner, reason = 'cancelled') {
    const record = this.get(id, owner); if (record.state !== 'running') return this.snapshot(record);
    record.reason = reason;
    await run(this.tmux, ['-S', this.socket, 'kill-session', '-t', record.target], { env: record.env }).catch(() => {});
    record.state = 'exited'; record.code = null; record.endedAt = Date.now(); clearTimeout(record.timer);
    return this.snapshot(record);
  }
  read(id, owner, cursor = 0) {
    const record = this.get(id, owner); const size = statSync(record.output).size;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > size) throw new Error('Invalid terminal output cursor.');
    const length = Math.min(32768, size - cursor); const fd = openSync(record.output, 'r'); const buffer = Buffer.alloc(length);
    try { if (length) readSync(fd, buffer, 0, length, cursor); } finally { closeSync(fd); }
    // Retained terminal bytes are diagnostic only. Strip control codes before
    // returning them through structured clients; native attachment remains raw.
    const text = buffer.toString('utf8').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
    return { text, cursor: cursor + length, hasMore: cursor + length < size };
  }
  async close(reason = 'supervisor_closed') {
    if (this.closed) return; this.closed = true;
    await Promise.allSettled([...this.records.values()].filter(r => r.state === 'running').map(r => this.stop(r.terminalId, r.owner, reason)));
    rmSync(this.directory, { recursive: true, force: true });
  }
}
