import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Build the hardened SSH argument prefix shared by daemon and native CLI. */
export async function sshArgs(host) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/.test(host ?? '')) {
    throw new Error('Invalid SSH alias.');
  }
  const config = process.env.CONVOY_SSH_CONFIG ?? join(homedir(), '.ssh', 'config');
  let configArgs = [];
  try {
    await access(config);
    configArgs = ['-F', config];
  } catch {
    if (process.env.CONVOY_SSH_CONFIG) {
      throw new Error('SSH configuration file unavailable.');
    }
  }
  return [
    ...configArgs,
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=3',
    host,
  ];
}
