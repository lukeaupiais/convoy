/**
 * Builds a complete session configuration before changing durable state.
 *
 * Configuration crosses execution, library, and workflow domains, so it is a
 * control-plane transaction plan rather than a fourth owner for their state.
 * Runner provisioning is intentionally the one post-plan external effect: a
 * disconnected provision remains an uncertainty boundary in Placement.
 */
export function createSessionConfiguration({
  engine,
  execution,
  workflows,
  refreshInstructions,
  event,
  save,
}) {
  function plan(session, command) {
    if (session.pendingMessages?.length || session.queuedInput)
      throw new Error('Deliver or remove queued messages before changing configuration.');
    if (engine.active(session))
      throw new Error('Cancel or complete the active workflow before changing its configuration.');
    if ((session.workspace || session.workspaceRequest) && command.runnerId !== session.runnerId)
      throw new Error(
        'An existing or pending task worktree cannot be moved to another runner. Inspect it or create a new task.',
      );
    const runner = command.runnerId ? execution.runnerSelection(session, command.runnerId) : null;
    const workflow = command.workflow ? workflows.selection(command.workflow, session) : null;
    return {
      runner,
      workflow,
      clearWorkflow: command.workflow === '',
      clearPlacement: command.runnerId === '' && !session.workspace && !session.workspaceRequest,
    };
  }

  async function apply(session, command) {
    const change = plan(session, command);
    if (change.runner) {
      session.placement = change.runner.placement;
      if (!session.workspace) {
        const result = await execution.prepare(session);
        if (result.reason) throw new Error(result.reason);
        await execution.release(session);
        event(session, 'workspace_created', { workspace: session.workspace });
      }
    }
    if (change.clearPlacement) delete session.placement;
    refreshInstructions(session);
    if (change.workflow) {
      session.workflow = change.workflow;
      session.step = 0;
    }
    if (change.clearWorkflow) {
      session.workflow = null;
      if (session.flow) {
        session.pastRuns ??= [];
        session.pastRuns.push(session.flow);
        session.flow = null;
      }
      session.status = 'idle';
    }
    event(session, 'configured', {
      instructionVersions: session.instructions.map((i) => `${i.scope}/${i.name}@${i.version}`),
      workflowVersion: session.workflow?.version,
    });
    await save();
  }

  return { plan, apply };
}
