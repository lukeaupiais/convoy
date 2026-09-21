import { createCapabilities, migrateLibraryState } from './capabilities.mjs';
import { createInstructionLibrary } from './instructions.mjs';

const commands = [
  'validateSkill',
  'publishSkill',
  'publishExtension',
  'exportSkill',
  'publishProfile',
  'setProjectProfile',
  'setToolEnabled',
  'publishInstruction',
];
const sessionCommands = ['setCapabilityProfile'];

/**
 * The Library module owns published capability and instruction revisions.
 * Its command surface is registered with the control plane at composition;
 * callers never need to know whether a command is backed by skills, profiles,
 * or immutable instructions.
 */
export function createLibrary({
  state,
  save,
  catalog,
  parseSessionId,
  digest,
  scopeOrder,
  now,
  event,
}) {
  migrateLibraryState(state);
  const capabilities = createCapabilities({ state });
  const instructions = createInstructionLibrary({
    state,
    save,
    catalog,
    parseSessionId,
    digest,
    scopeOrder,
    now,
  });
  return {
    id: 'library',
    commands,
    sessionCommands,
    capabilities,
    snapshot({ scope } = {}) {
      return {
        capabilities: capabilities.snapshot(scope),
        instructions: state.instructions.filter(
          (instruction) =>
            !scope?.organizationId ||
            (instruction.organizationId ?? 'personal') === scope.organizationId,
        ),
        instructionOwners: state.instructionOwners,
      };
    },
    async command(command, { validateClient }) {
      validateClient(command.client);
      const result =
        command.action === 'publishInstruction'
          ? await instructions.publish(command)
          : capabilities.command(command);
      await save();
      return result;
    },
    async sessionCommand(session, command, { assertProfileChange }) {
      assertProfileChange(session);
      capabilities.pin(session, command.profile);
      event(session, 'profile_applied', {
        profile: session.capabilityProfile
          ? {
              id: session.capabilityProfile.id,
              version: session.capabilityProfile.version,
              hash: session.capabilityProfile.hash,
            }
          : null,
      });
      await save();
      return session.capabilityProfile;
    },
  };
}
