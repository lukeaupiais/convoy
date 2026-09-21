/**
 * Runner-side validation port. A direct data channel is accepted only when a
 * live machine identity and a live user channel grant resolve to the same
 * organization, environment and runner.
 */
export function createRunnerChannelAuthorization({ enrollment, channelGrants }) {
  return {
    validate({ machineCredential, channelToken, expected = {} }) {
      const machine = enrollment.authenticate(machineCredential, {
        organizationId: expected.organizationId,
        runnerId: expected.runnerId,
        environmentId: expected.environmentId,
      });
      const grant = channelGrants.validate(channelToken, expected);
      if (
        grant.runnerId !== machine.principal.runnerId ||
        grant.organizationId !== machine.principal.organizationId ||
        grant.environmentId !== machine.principal.environmentId
      )
        throw new Error('Runner channel authorization is invalid.');
      return { principal: machine.principal, grant };
    },
  };
}
