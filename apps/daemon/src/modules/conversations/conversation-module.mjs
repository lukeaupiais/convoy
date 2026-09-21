const commands = ['createConversation'];
const sessionCommands = [
  'linkTicket',
  'requestExecution',
  'releaseTicket',
  'rememberContext',
  'sendMessage',
  'discardMessage',
  'resumeSession',
];

/** Conversation creation and ticket/context operations after lease authorization. */
export function createConversationModule({ conversations, messaging }) {
  return {
    id: 'conversations',
    commands,
    sessionCommands,
    snapshot({ scope } = {}) {
      const value = conversations.snapshot();
      if (!scope) return value;
      const projectIds = new Set(scope.projectIds);
      return {
        conversations: value.conversations.filter((conversation) =>
          projectIds.has(conversation.projectId),
        ),
      };
    },
    command(command) {
      return conversations.create(command);
    },
    sessionCommand(session, command) {
      if (['sendMessage', 'discardMessage', 'resumeSession'].includes(command.action))
        return messaging.command(session, command);
      return conversations.action(session, command);
    },
  };
}
