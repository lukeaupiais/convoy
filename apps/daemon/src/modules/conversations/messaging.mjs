import { activeFlow } from './steering.mjs';

/** Durable message queue policy; model and scheduler work are injected ports. */
export function createConversationMessaging({
  conversations,
  steering,
  ensureAgentSessions,
  contextFiles,
  resolveModel,
  jobs,
  authorizeModel,
  canMessage,
  save,
  requestStop,
  resume,
  launch,
  continueInput,
}) {
  return {
    async command(session, command) {
      if (command.action === 'discardMessage') {
        steering.discard(session, command.requestId);
        await save();
        return;
      }
      if (command.action === 'resumeSession') {
        if (Object.hasOwn(session.steeringRequests ?? {}, command.requestId)) {
          steering.resumeRequest(session, command);
          return { existing: true };
        }
        if (
          !['interrupted', 'failed', 'paused', 'awaiting_submission'].includes(session.status) &&
          !(session.pendingMessages ?? []).some((message) => message.held)
        )
          throw new Error('Session is not stopped.');
        await resume(session, command.acknowledge === true, command);
        return;
      }
      ensureAgentSessions(session);
      const selectedModel = await resolveModel(session, command.model);
      const withAttachments = {
        ...command,
        attachments: await contextFiles.select(
          session,
          command.attachmentIds ?? [],
          selectedModel,
        ),
      };
      if (
        selectedModel?.input &&
        !selectedModel.input.includes('image') &&
        session.messages.some((message) => message.attachments?.some((file) => file.mime.startsWith('image/')))
      )
        throw new Error(
          'This conversation contains images. Keep an image-capable model or start a text-only conversation.',
        );
      if (Object.hasOwn(session.steeringRequests ?? {}, withAttachments.requestId)) {
        steering.enqueue(session, withAttachments);
        return { existing: true };
      }
      if (!canMessage(session))
        throw new Error('This workflow step needs its decision controls, not a chat message.');
      if (!selectedModel) throw new Error('Unknown provider model.');
      const running = jobs.has(session.id) || session.status === 'queued';
      if (running && withAttachments.model !== session.model)
        throw new Error('Keep the current model while the agent is working.');
      if (!running) await authorizeModel(session, command.model);
      const held =
        withAttachments.mode === 'interrupt' ||
        Boolean(session.stopRequested) ||
        ['interrupted', 'failed', 'paused'].includes(session.status) ||
        session.interruption?.needsReview === true ||
        session.assignment?.state === 'uncertain';
      if (!steering.enqueue(session, withAttachments, held)) return { existing: true };
      const conversation = conversations.current(session);
      if (conversation.title === 'New chat') {
        conversation.title = (
          withAttachments.text.trim() ||
          withAttachments.attachments[0]?.name ||
          'New chat'
        ).slice(0, 80);
        session.title = conversation.title;
      }
      if (!running) session.model = withAttachments.model;
      await save();
      if (withAttachments.mode === 'interrupt') await requestStop(session, true);
      else if (!running && !session.stopRequested) {
        if (held) {
          if (!session.interruption?.needsReview && session.assignment?.state !== 'uncertain')
            await resume(session);
        } else if (activeFlow(session)) await resume(session);
        else {
          session.status = 'running';
          if (!launch(session, continueInput)) {
            session.queuedInput = continueInput;
            session.status = 'queued';
          }
          await save();
        }
      }
      return { queued: true, requestId: withAttachments.requestId };
    },
  };
}
