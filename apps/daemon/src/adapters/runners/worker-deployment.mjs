import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { processRun, sshArgs } from '../../../../../packages/runner/src/index.mjs';
export function createWorkerDeployment({ directory = new URL('../../../../../dist-worker/', import.meta.url).pathname, transport = processRun } = {}) {
  const pending = new Map();
  async function deploy(host, signal) {
    const args = await sshArgs(host);
    const remote = async (command, input) => {
      const result = await transport('ssh', [...args, command], { input, signal, timeout: 120000, env: { PATH: process.env.PATH, ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}) } });
      if (result.code !== 0 || result.stopped) throw new Error('Worker deployment failed. Check SSH access, executable user storage, disk space and sha256sum.');
      return result.output.trim();
    };
    const platform = await remote('uname -sm');
    const target = { 'Linux x86_64': 'linux-x64', 'Linux aarch64': 'linux-arm64' }[platform];
    if (!target) throw new Error(`Unsupported worker platform: ${platform}. Supported: Linux x64 and ARM64.`);
    let manifest, bytes;
    try { manifest = JSON.parse(await readFile(join(directory, `${target}.json`), 'utf8')); bytes = await readFile(join(directory, `convoy-worker-${target}`)); }
    catch { throw new Error(`Portable worker artifact missing for ${target}. Build the worker release on the coordinator first.`); }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (manifest.protocol !== 1 || manifest.platform !== target || manifest.sha256 !== sha256) throw new Error('Worker artifact checksum mismatch. Rebuild the release.');
    const setup = `set -eu; umask 077; dir="$HOME/.local/share/convoy/workers"; mkdir -p "$dir"; test ! -L "$dir"; file="$dir/${sha256}"; `;
    const check = `test -f "$file" && test ! -L "$file" && test "$(sha256sum "$file" | cut -d ' ' -f 1)" = '${sha256}'`;
    const status = await remote(setup + `if ${check}; then printf 'cached'; elif command -v gzip >/dev/null 2>&1; then printf 'upload-gzip'; else printf 'upload'; fi`);
    if (status !== 'cached') await remote(setup + `tmp=$(mktemp "$dir/.upload.XXXXXXXX"); trap 'rm -f "$tmp"' EXIT; ${status === 'upload-gzip' ? 'gzip -dc' : 'cat'} > "$tmp"; test "$(sha256sum "$tmp" | cut -d ' ' -f 1)" = '${sha256}'; chmod 700 "$tmp"; mv -f "$tmp" "$file"`, status === 'upload-gzip' ? await promisify(gzip)(bytes) : bytes);
    return { args, command: `exec "$HOME/.local/share/convoy/workers/${sha256}"`, sha256, platform: target, reused: status === 'cached' };
  }
  return { ensure(host, signal) {
    if (!pending.has(host)) pending.set(host, deploy(host, signal).finally(() => pending.delete(host)));
    return pending.get(host);
  } };
}
