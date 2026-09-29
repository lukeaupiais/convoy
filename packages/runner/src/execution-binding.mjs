import { constants } from 'node:fs';
import { open, rename, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// An enforcement marker, not another authority resolver: only placement writes
// it over the trusted worker channel. Git metadata is read-only to the agent.
async function directory(workspace) {
  const root = await open(
    await realpath(workspace),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let metadata;
  try {
    metadata = await open(
      `/proc/self/fd/${root.fd}/.git`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await metadata.stat();
    if (stat.isDirectory()) {
      const result = metadata;
      metadata = null;
      return result;
    }
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid worktree Git metadata.');
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await metadata.read(buffer, 0, buffer.length, 0);
    // Bubblewrap creates an empty mount target in legacy non-repository workspaces.
    if (bytesRead === 0) return null;
    const match =
      bytesRead <= 4096 &&
      /^gitdir:\s*(.+)\s*$/u.exec(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!match) throw new Error('Invalid worktree Git directory.');
    return await open(
      resolve(workspace, match[1]),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } finally {
    await metadata?.close();
    await root.close();
  }
}

async function read(directory) {
  let file;
  try {
    file = await open(
      `/proc/self/fd/${directory.fd}/execution-binding.json`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
      throw new Error('Invalid execution binding.');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Invalid execution binding.');
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    validate(value);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    await file?.close();
  }
}
function validate(binding) {
  if (
    binding?.version !== 1 ||
    !['inspect','verify'].includes(binding.profileId) ||
    !/^[a-f0-9-]{36}$/.test(binding.assignmentToken ?? '') ||
    !/^[a-f0-9]{64}$/.test(binding.policyDigest ?? '')
  )
    throw new Error('Invalid inspection assignment binding.');
}
export async function bindInspection(workspace, binding) {
  validate(binding);
  const dir = await directory(workspace);
  if (!dir) throw new Error('Inspection requires worktree Git metadata.');
  try {
    // Validate existing metadata before replacing it; never recover corruption
    // or an unsupported version by silently granting execution.
    await read(dir);
    const temporary = `/proc/self/fd/${dir.fd}/${randomUUID()}`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(binding));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, `/proc/self/fd/${dir.fd}/execution-binding.json`);
    await dir.sync();
  } finally {
    await dir.close();
  }
  return { bound: true };
}
export async function assertInspectionBinding(request) {
  if (
    !request.workspace ||
    !['tool', 'workspace_guidance', 'command_start', 'terminal_start', 'extension', 'verification', 'diff'].includes(
      request.action,
    )
  )
    return;
  let dir;
  try {
    dir = await directory(request.workspace);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let binding;
  try {
    binding = dir ? await read(dir) : null;
  } finally {
    await dir?.close();
  }
  if (!binding) {
    if (['inspect','verify'].includes(request.executionProfile ?? request.execution?.grant?.profileId))
      throw new Error('Inspection workspace has no bound assignment.');
    return;
  }
  if(request.action==='diff' && binding.profileId==='inspect' && !request.execution)return;
  const d = request.execution;
  if (
    !d ||
    d.assignmentToken !== binding.assignmentToken ||
    d.policyDigest !== binding.policyDigest ||
    d.grant?.profileId !== binding.profileId ||
    (request.executionProfile !== undefined && request.executionProfile !== binding.profileId)
  )
    throw new Error('Inspection descriptor does not match the bound assignment.');
}
