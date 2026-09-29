// Coordinates owned guidance state, runner access and existing context storage.
export function createGuidancePreparation({
  guidance,
  sessionExecution,
  contextFiles,
  save,
  event,
}) {
  return async function prepare(session, { force = false, signal, validate = () => {} } = {}) {
    const request = guidance.request(session, force);
    if (request) {
      await save();
      try {
        const captured = await sessionExecution.readGuidance(session, signal);
        validate();
        guidance.assertCurrent(session, request);
        let contentId;
        if (captured.status === 'loaded') {
          const file = await contextFiles.add(
            session,
            {
              name: 'AGENTS.md',
              mime: 'text/plain',
              data: Buffer.from(captured.content).toString('base64'),
            },
            { path: 'AGENTS.md', runnerId: session.runnerId, workspace: session.workspace.path },
            { exactUtf8Snapshot: true },
          );
          if (file.hash !== captured.hash) throw new Error('Guidance snapshot hash mismatch.');
          contentId = file.id;
        }
        validate();
        guidance.assertCurrent(session, request);
        guidance.complete(session, request, {
          status: captured.status,
          hash: captured.hash,
          contentId,
        });
      } catch (error) {
        validate();
        guidance.assertCurrent(session, request);
        guidance.complete(session, request, { status: 'error', error: error.message });
      }
      event(session, 'workspace_guidance_captured', { ...session.workspaceGuidance });
      await save();
    }
    const active = guidance.view(session);
    if (active.status === 'error')
      throw new Error(`Workspace guidance: ${active.error} Fix the file and refresh guidance.`);
    if (active.status !== 'loaded' || !active.contentId) return '';
    const { bytes } = await contextFiles.read(session, active.contentId);
    return bytes.toString('utf8');
  };
}
