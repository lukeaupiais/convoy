import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexSubscriptionOAuth } from './codex-oauth.mjs';

export async function createAuth(directory, { oauth = createCodexSubscriptionOAuth() } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'auth.json');
  const sourceFile = join(directory, 'auth-source.json');
  let source = 'none'; let credential; let login; let refreshing;
  let device = { state: 'idle' };
  try { source = JSON.parse(await readFile(sourceFile, 'utf8')).source; } catch {}
  if (source !== 'owned') source = 'none';
  try { credential = JSON.parse(await readFile(file, 'utf8')); } catch {}
  async function persist() {
    await writeFile(file + '.tmp', JSON.stringify(credential), { mode: 0o600 }); await rename(file + '.tmp', file);
  }
  async function select(value) { source = value; await writeFile(sourceFile, JSON.stringify({ source }), { mode: 0o600 }); }
  return {
    async status() {
      let available = false;
      if (source === 'owned') available = Boolean(credential?.access && credential?.refresh);
      return { source, connected: available, expiresAt: source === 'owned' ? credential?.expires : undefined, device };
    },
    async token(signal) {
      if (source !== 'owned' || !credential) throw new Error('Connect a Codex subscription first.');
      if (credential.expires < Date.now() + 60000) {
        if (!refreshing) refreshing = oauth.refresh(credential, signal).then(async updated => { credential = updated; await persist(); }).finally(() => { refreshing = null; });
        try { await refreshing; } catch { throw new Error('Convoy login expired. Sign in again.'); }
      }
      return credential.access;
    },
    async login() {
      if (login) return this.status();
      if (refreshing) throw new Error('Authentication refresh is in progress.');
      login = new AbortController(); const controller = login;
      const timeout = setTimeout(() => controller.abort(), 600000);
      device = { state: 'starting' };
      void oauth.login({ signal: controller.signal, prompt: async p => { if (p.type === 'select') return 'device_code'; throw new Error('Unsupported login prompt'); }, notify: event => {
        if (event.type === 'device_code') device = { state: 'waiting', userCode: event.userCode, verificationUri: event.verificationUri };
      } }).then(async result => { credential = result; await persist(); await select('owned'); device = { state: 'complete' }; })
        .catch(error => { device = { state: 'failed', message: error.message || 'Device login did not complete. Enable device-code login in ChatGPT security settings.' }; })
        .finally(() => { clearTimeout(timeout); login = null; });
      return this.status();
    },
    async disconnect() {
      if (refreshing || login) { login?.abort(); throw new Error('Authentication is busy. Wait for cancellation before disconnecting.'); }
      await select('none'); credential = undefined; device = { state: 'idle' };
      try { await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return this.status();
    },
    close() { login?.abort(); },
  };
}
