import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, openSync, writeSync, readSync, closeSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Worker-owned processes. A caller chooses turn or session lifetime; neither
// implies recovery after this supervisor or its host exits.
export class CommandSupervisor {
  constructor({ quotaBytes = 16 * 1024 * 1024, graceMs = 1500 } = {}) {
    this.commands = new Map();
    this.launches = new Map();
    this.quotaBytes = quotaBytes;
    this.graceMs = graceMs;
    this.directory = mkdtempSync(join(tmpdir(), 'convoy-commands-'));
    this.closed = false;
  }
  start(
    command,
    args,
    { cwd, env, signal, timeoutMs = 600000, owner, input, launchId, lifetime = 'turn' } = {},
  ) {
    if (this.closed || signal?.aborted) throw new Error('Command execution stopped.');
    if (!['turn', 'session'].includes(lifetime)) throw new Error('Invalid command lifetime.');
    const signature = createHash('sha256')
      .update(JSON.stringify({ command, args, cwd, env, timeoutMs, owner, input, lifetime }))
      .digest('hex');
    if (launchId !== undefined) {
      if (!/^[a-f0-9-]{36}$/.test(launchId)) throw new Error('Invalid launch ID.');
      const existing = this.launches.get(launchId);
      if (existing) {
        if (existing.signature !== signature)
          throw new Error('Launch ID reused with different arguments.');
        return existing.commandId;
      }
    }
    if (this.commands.size >= 64) throw new Error('Turn command limit reached.');
    const maxTimeout = lifetime === 'session' ? 12 * 60 * 60 * 1000 : 900000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout)
      throw new Error('Invalid execution deadline.');
    const commandId = randomUUID();
    const fd = openSync(join(this.directory, commandId), 'wx+', 0o600);
    const record = {
      commandId,
      owner,
      lifetime,
      fd,
      entries: [],
      bytes: 0,
      state: 'running',
      code: null,
      startedAt: Date.now(),
      reason: null,
    };
    this.commands.set(commandId, record);
    if (launchId) this.launches.set(launchId, { commandId, signature });
    record.done = new Promise((resolve) => {
      record.resolve = resolve;
    });
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    record.child = child;
    const collect = (stream, text) => {
      if (!text || record.reason === 'output_quota' || record.reason === 'log_error') return;
      const bytes = Buffer.from(text);
      if (record.bytes + bytes.length > this.quotaBytes || record.entries.length >= 100000) {
        this.terminate(record, 'output_quota');
        return;
      }
      try {
        let written = 0;
        while (written < bytes.length)
          written += writeSync(fd, bytes, written, bytes.length - written, record.bytes + written);
        record.entries.push({ stream, offset: record.bytes, length: bytes.length });
        record.bytes += bytes.length;
      } catch {
        this.terminate(record, 'log_error');
      }
    };
    for (const stream of ['stdout', 'stderr']) {
      const decoder = new StringDecoder('utf8');
      child[stream].on('data', (chunk) => collect(stream, decoder.write(chunk)));
      child[stream].on('end', () => collect(stream, decoder.end()));
    }
    child.stdin.on('error', () => {});
    if (lifetime === 'turn' || input !== undefined) child.stdin.end(input);
    child.on('error', (error) => {
      record.error = error.message;
      record.reason = 'spawn_error';
    });
    const abort = () => this.terminate(record, 'cancelled');
    record.timer = setTimeout(() => this.terminate(record, 'deadline'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('close', (code, exitSignal) => {
      clearTimeout(record.timer);
      clearTimeout(record.killTimer);
      signal?.removeEventListener('abort', abort);
      // Sweep remaining members even if the shell exited before its children.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      record.state = 'exited';
      record.code = code;
      record.signal = exitSignal;
      record.endedAt = Date.now();
      record.resolve();
    });
    if (signal?.aborted) abort();
    return commandId;
  }
  get(id, owner) {
    const record = this.commands.get(id);
    if (!record || record.owner !== owner)
      throw new Error('Command does not belong to this execution.');
    return record;
  }
  terminate(record, reason) {
    if (record.state === 'exited' || record.reason) return;
    record.reason = reason;
    record.state = 'stopping';
    const kill = (signal) => {
      try {
        process.kill(-record.child.pid, signal);
      } catch {
        record.child.kill(signal);
      }
    };
    kill('SIGTERM');
    record.killTimer = setTimeout(() => kill('SIGKILL'), this.graceMs);
  }
  async stop(id, owner) {
    const record = this.get(id, owner);
    this.terminate(record, 'cancelled');
    return this.poll(id, owner);
  }
  async input(id, owner, value, close = false) {
    const record = this.get(id, owner);
    if (record.lifetime !== 'session' || record.state !== 'running' || !record.child.stdin.writable)
      throw new Error('Command input is no longer available.');
    if (
      typeof value !== 'string' ||
      !value ||
      Buffer.byteLength(value) > 8192 ||
      typeof close !== 'boolean'
    )
      throw new Error('Command input must be 1-8192 bytes.');
    await new Promise((resolve, reject) =>
      record.child.stdin.write(value, (error) => (error ? reject(error) : resolve())),
    );
    if (close) record.child.stdin.end();
    return { commandId: id, acceptedBytes: Buffer.byteLength(value), closed: close };
  }
  async poll(id, owner, { cursor = 0, waitMs = 0 } = {}) {
    const r = this.get(id, owner);
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      cursor > r.entries.length ||
      !Number.isInteger(waitMs) ||
      waitMs < 0 ||
      waitMs > 1000
    )
      throw new Error('Invalid command cursor or wait.');
    if (cursor === r.entries.length && r.state !== 'exited' && waitMs) {
      let timer;
      await Promise.race([
        r.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const chunks = [];
    let size = 0;
    while (cursor < r.entries.length && size < 32768) {
      const entry = r.entries[cursor++];
      const buffer = Buffer.alloc(entry.length);
      readSync(r.fd, buffer, 0, buffer.length, entry.offset);
      chunks.push({ stream: entry.stream, text: buffer.toString('utf8') });
      size += buffer.length;
    }
    return {
      commandId: id,
      lifetime: r.lifetime,
      state: r.state,
      code: r.code,
      signal: r.signal,
      reason: r.reason,
      error: r.error,
      stopped: !!r.reason,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      chunks,
      cursor,
      hasMore: cursor < r.entries.length,
      retainedBytes: r.bytes,
    };
  }
  release(id, owner) {
    const r = this.get(id, owner);
    if (r.state !== 'exited') throw new Error('A running command cannot be released.');
    closeSync(r.fd);
    this.commands.delete(id);
    for (const [launchId, launch] of this.launches)
      if (launch.commandId === id) this.launches.delete(launchId);
    try {
      unlinkSync(join(this.directory, id));
    } catch {}
    return { released: true };
  }
  async close(reason = 'supervisor_closed') {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.commands.values()) this.terminate(r, reason);
    await Promise.all([...this.commands.values()].map((r) => r.done));
    for (const r of this.commands.values()) closeSync(r.fd);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
