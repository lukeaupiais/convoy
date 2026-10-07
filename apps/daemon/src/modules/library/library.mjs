import { createCapabilities, migrateLibraryState } from './capabilities.mjs';
import { createSkillSources } from './skill-sources.mjs';
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
  validateKnowledge,
  executionPolicy,
  save,
  catalog,
  parseSessionId,
  digest,
  scopeOrder,
  now,
  event,
}) {
  migrateLibraryState(state);
  const skillSources = createSkillSources({state});
  const capabilities = createCapabilities({ state, executionPolicy, validateKnowledge, skillSources });
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
    skillSources,
    snapshot({ scope } = {}) {
      return {
        capabilities: {...capabilities.snapshot(scope),skillCatalogue:skillSources.catalogue(scope),skillSnapshots:state.skillSnapshots.filter(s=>{try{skillSources.snapshot({snapshotId:s.id},scope);return true;}catch{return false;}}).map(({files,body,...s})=>s)},
        instructions: state.instructions.filter(
          (instruction) =>
            scope === undefined ||
            (!!scope.organizationId && (instruction.organizationId ?? 'personal') === scope.organizationId),
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
    async sessionCommand(session, command, { assertProfileChange, profileChanged }) {
      assertProfileChange(session);
      capabilities.pin(session, command.profile);
      profileChanged?.(session);
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
