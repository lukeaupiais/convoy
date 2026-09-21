import { randomUUID } from 'node:crypto';
import { requiredText } from '../../shared/validation.mjs';

/** Immutable, versioned instruction publication across Convoy scopes. */
export function createInstructionLibrary({
  state,
  save,
  catalog,
  parseSessionId,
  digest,
  scopeOrder,
  now = () => new Date().toISOString(),
}) {
  return {
    async publish(command) {
      if (!scopeOrder.includes(command.scope)) throw new Error('Invalid instruction scope.');
      const name = requiredText(command.name, 'Instruction name', 100);
      const content = requiredText(command.content, 'Instruction content', 20_000);
      const scope = command.scope;
      const target =
        scope === 'organization'
          ? requiredText(
              command.target || state.instructionOwners.organizationId,
              'Organization',
              100,
            )
          : scope === 'user'
            ? requiredText(command.target || state.instructionOwners.userId, 'User', 100)
            : scope === 'project'
              ? requiredText(
                  command.projectId || command.target || state.projects[0].id,
                  'Project',
                  100,
                )
              : ['task', 'environment'].includes(scope)
                ? requiredText(command.target, 'Instruction target', 100)
                : '';

      if (scope === 'project') catalog.project(target);
      if (scope === 'task') parseSessionId(target);
      if (
        scope === 'environment' &&
        !state.runners.some((runner) => runner.id === target) &&
        !state.environments.some((environment) => environment.id === target)
      )
        throw new Error('Environment target must be an environment or legacy runner ID.');

      const previous = state.instructions.filter(
        (instruction) =>
          instruction.name === name && instruction.scope === scope && instruction.target === target,
      );
      const revision = {
        id: randomUUID(),
        organizationId: command.organizationId ?? 'personal',
        ...(command.projectId ? { projectId: command.projectId } : {}),
        name,
        content,
        scope,
        target,
        source: name === 'AGENTS.md' ? 'AGENTS.md' : 'editor',
        hash: digest(content),
        version: previous.length + 1,
        at: now(),
      };
      state.instructions.push(revision);
      await save();
      return revision;
    },
  };
}
