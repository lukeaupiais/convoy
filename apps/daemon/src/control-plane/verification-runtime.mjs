import { createHash } from 'node:crypto';
/** Cross-domain coordination; Execution owns selection, runners enforce resources. */
export function createVerificationCoordinator({
  execution,
  catalog,
  runners,
  runnerFor,
  commandLogs,
  save,
  event,
}) {
  const descriptor = (s) => ({
    version: 1,
    workspace: s.workspace.path,
    assignmentToken: s.assignment.token,
    policyDigest: s.assignment.policyDigest,
    grant: s.executionGrant,
  });
  const call = (s, operation, files, signal) =>
    runners.execute(
      runnerFor(s),
      {
        action: 'verification',
        workspace: s.workspace.path,
        execution: descriptor(s),
        operation,
        ...(files ? { files } : {}),
      },
      signal,
    );
  return {
    pin(s) {
      const selected = execution.verification.resolve(
        s.projectId,
        s.workflow?.runtime !== undefined
          ? s.workflow.runtime
          : catalog.project(s.projectId).runtime,
      );
      if (
        s.executionGrant &&
        JSON.stringify(s.executionGrant.runtime ?? null) !== JSON.stringify(selected)
      )
        throw new Error('Runtime selection differs from the assigned grant. Start new work.');
      if (
        selected &&
        (s.workflow?.nodes ?? []).some((n) => n.kind === 'agent' && n.permissions !== 'full')
      )
        throw new Error('Runtime selection requires explicitly full node permissions.');
      s.runtimeSelection = selected;
    },
    async prepare(s, signal) {
      if (s.executionGrant?.profileId !== 'verify') {
        if (s.runtimeSelection)
          throw new Error('Selected runtime needs the explicit verify execution profile.');
        return;
      }
      if (s.verificationRuntime?.state === 'destroyed' && !s.verificationResetRequested)
        throw new Error(
          'Runtime was torn down. Explicitly reset its generation before continuing.',
        );
      s.verificationRuntime = await call(s, 'prepare', undefined, signal);
      delete s.verificationResetRequested;
      event(s, 'verification_ready', { runtime: s.verificationRuntime });
      await save();
    },
    async seal(s, evidence, artifacts) {
      if (!s.runtimeSelection) return null;
      if (
        (s.commands ?? []).some((c) => c.state === 'running' || c.state === 'stopping') ||
        (s.terminals ?? []).some((t) => t.state === 'running')
      )
        throw new Error('Finish commands before sealing verification evidence.');
      const files = [
        ...new Set([...(evidence?.references ?? []).map((r) => r.path), ...artifacts]),
      ].map((path) => ({ path }));
      const result = await call(s, 'seal', files);
      const { files: _files, receipts: _receipts, ...runtime } = result;
      s.verificationRuntime = runtime;
      await save();
      for (const ref of evidence?.references ?? []) {
        if (result.files[ref.path]?.sha256 !== ref.sha256)
          throw new Error(
            'Source evidence changed during capture. Review the sealed evidence before resubmission.',
          );
      }
      const receipts = [];
      let remaining = 1000000;
      for (const r of result.receipts) {
        const command = (s.commands ?? []).find((c) => c.commandId === r.commandId);
        if (!command || command.state !== 'exited')
          throw new Error('Verification command evidence is missing or unfinished.');
        const hash = createHash('sha256');
        let output = '',
          cursor = 0,
          outputTruncated = false;
        if (command.retainedBytes) {
          let page;
          do {
            page = await commandLogs.read(r.commandId, cursor);
            cursor = page.cursor;
            hash.update(page.text);
            if (Buffer.byteLength(page.text) <= remaining) {
              output += page.text;
              remaining -= Buffer.byteLength(page.text);
            } else outputTruncated = true;
          } while (page.hasMore);
          if (cursor !== command.retainedBytes)
            throw new Error('Command output capture is incomplete.');
        }
        receipts.push({
          ...r,
          code: command.code,
          reason: command.reason,
          endedAt: command.endedAt,
          output,
          outputDigest: hash.digest('hex'),
          outputTruncated,
          retainedBytes: command.retainedBytes,
        });
      }
      const captured = { ...runtime, receipts };
      s.verificationRuntime = runtime;
      event(s, 'verification_sealed', { runtime });
      await save();
      return captured;
    },
    async reset(s, command) {
      if (
        s.executionGrant?.profileId !== 'verify' ||
        !s.verificationRuntime ||
        s.verificationRuntime.id !== command.runtimeId ||
        s.verificationRuntime.generation !== command.generation
      )
        throw new Error('Runtime generation changed. Reload before reset.');
      if (!['awaiting_submission', 'paused', 'interrupted', 'failed'].includes(s.status))
        throw new Error('Reset requires paused investigation without a pending review.');
      await call(s, 'destroy');
      s.verificationRuntime = { ...s.verificationRuntime, state: 'destroyed' };
      s.verificationResetRequested = true;
      event(s, 'verification_reset_requested', { runtime: s.verificationRuntime });
      await save();
      return s.verificationRuntime;
    },
    async readArtifacts(s, paths) {
      if (!s.runtimeSelection) return null;
      if (s.verificationRuntime?.state !== 'sealed')
        throw new Error('Review artifacts require sealed runtime evidence.');
      // Sealing is idempotent: the runner revalidates the assignment and returns
      // the immutable capture, without reopening the destroyed application.
      const result = await call(s, 'seal');
      const files = {};
      for (const path of paths) {
        const file = result.files[path];
        if (!file || typeof file.text !== 'string' || file.truncated ||
            createHash('sha256').update(file.text).digest('hex') !== file.sha256)
          throw new Error(`Sealed artifact unavailable or changed: ${path}.`);
        files[path] = file;
      }
      return files;
    },
    async release(s) {
      if (
        s.executionGrant?.profileId !== 'verify' ||
        !s.verificationRuntime ||
        s.verificationRuntime.state === 'sealed'
      )
        return;
      s.verificationRuntime = await call(s, 'destroy');
      await save();
    },
    descriptor,
  };
}
