export { createPromptContext, instructionScopeOrder } from './prompt-context.mjs';

const sessionCommands = ['decide', 'answerQuestion'];
const commands = ['probeModel', 'removeApprovalRule'];

export function migrateAgentState(state) {
  state.modelChecks ??= {};
  state.approvalRules ??= [];
}

/** Lease-authorized human responses to a model turn's approval or question. */
export function createAgentModule({ state, agentTurns, probeModel }) {
  migrateAgentState(state);
  return {
    id: 'agents',
    commands,
    sessionCommands,
    async command(command, { validateClient }) {
      validateClient(command.client);
      if (command.action === 'probeModel') return probeModel(command.model);
      const before = state.approvalRules.length;
      state.approvalRules = state.approvalRules.filter((rule) => rule.id !== command.ruleId);
      if (state.approvalRules.length === before) throw new Error('Approval rule not found.');
      return undefined;
    },
    sessionCommand(session, command, context) {
      return command.action === 'decide'
        ? agentTurns.decide(session, command, context?.principal)
        : agentTurns.answer(session, command);
    },
  };
}
