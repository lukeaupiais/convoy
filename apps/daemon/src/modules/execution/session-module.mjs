const sessionCommands = [
  'readCommandOutput',
  'stopCommand',
  'openTerminal',
  'terminalStatus',
  'terminalConnection',
  'readTerminalOutput',
  'stopTerminal',
  'renewChannelGrant',
  'revokeChannelGrant',
];

/** Lease-authorized retained-command and native-terminal operations. */
export function createExecutionSessionModule({ sessionExecution, channelGrants }) {
  return {
    id: 'execution',
    sessionCommands,
    async sessionCommand(session, command, context) {
      if (command.action === 'renewChannelGrant')
        return channelGrants.renew({
          id: command.id,
          revision: command.revision,
          actor: context.principal,
          session,
          expiresInSeconds: command.expiresInSeconds,
        });
      if (command.action === 'revokeChannelGrant')
        return channelGrants.revokeForSession({
          id: command.id,
          revision: command.revision,
          actor: context.principal,
          session,
        });
      const result = await sessionExecution.command(session, command);
      if (!result?.connection) return result;
      const issued = await channelGrants.issue({
        actor: context.principal,
        session,
        audience: 'terminal',
        terminalId: result.terminalId,
        permissions: ['attach', 'input', 'resize', 'read'],
      });
      return {
        ...result,
        connection: { ...result.connection, accessGrant: issued },
      };
    },
  };
}
