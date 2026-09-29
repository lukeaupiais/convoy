// Execution authority arrives only on the daemon-owned worker channel, never in
// model tool arguments. The descriptor preserves the grant across that channel.
import { createHash } from 'node:crypto';
export function validateExecutionDescriptor(request) {
  const d = request.execution;
  if (!d) {
    if (['inspect','verify'].includes(request.executionProfile))
      throw new Error('Inspection requires an execution descriptor.');
    return null; // Legacy requests retain their established contained/host mode.
  }
  const g = d.grant;
  if (
    d.version !== 1 ||
    !g ||
    g.version !== 1 ||
    !d.assignmentToken ||
    d.workspace !== request.workspace ||
    d.policyDigest !== g.digest ||
    typeof d.assignmentToken !== 'string' ||
    typeof g.digest !== 'string'
  )
    throw new Error('Invalid or mismatched execution descriptor.');
  const { digest, ...body } = g;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== digest)
    throw new Error('Execution grant digest mismatch.');
  if (request.executionProfile && request.executionProfile !== g.profileId)
    throw new Error('Execution profile mismatch.');
  const e = g.envelope;
  if (
    !e?.process ||
    !e.filesystem ||
    !e.network ||
    !e.credentials ||
    !['workspace', 'host', 'none'].includes(e.isolation)
  )
    throw new Error('Unsupported execution envelope.');
  if ((request.accessMode ?? 'contained') !== (e.isolation === 'host' ? 'trusted' : 'contained'))
    throw new Error('Execution access mode mismatch.');
  if (
    g.profileId === 'inspect' &&
    (e.isolation !== 'workspace' ||
      e.filesystem.workspace !== 'read-only' ||
      e.filesystem.extraRoots?.length !== 0 ||
      e.network.mode !== 'none' ||
      e.credentials.mode !== 'none' ||
      e.process.background !== false ||
      e.process.terminal !== false ||
      e.process.commands !== true)
  )
    throw new Error('Unsupported inspection envelope.');
  if (g.profileId === 'verify' && (e.network.mode !== 'private' || !g.runtime?.definition || e.filesystem.workspace !== 'read-only' || e.process.background || e.process.terminal)) throw new Error('Invalid verification envelope.');
  if(g.profileId==='verify' && ['extension','terminal_start'].includes(request.action))throw new Error('Operation cannot enforce the runtime boundary.');
  const name = request.name;
  if (
    e.isolation === 'none' ||
    (['write_file', 'apply_patch'].includes(name) &&
      !['read-write', 'host'].includes(e.filesystem.workspace) && g.profileId !== 'verify')
  )
    throw new Error('Execution envelope denies workspace mutation.');
  if (
    (['shell', 'start_command'].includes(name) || request.action === 'command_start') &&
    !e.process.commands
  )
    throw new Error('Execution envelope denies commands.');
  if (
    (name === 'start_command' ||
      (request.action === 'command_start' && request.lifetime === 'session')) &&
    !e.process.background
  )
    throw new Error('Execution envelope denies background commands.');
  if (request.action === 'terminal_start' && !e.process.terminal)
    throw new Error('Execution envelope denies terminals.');
  return d;
}
