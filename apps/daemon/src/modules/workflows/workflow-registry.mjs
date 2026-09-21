/** Versioned workflow publication and optimistic draft editing. */
export function createWorkflowRegistry({ state, save, normalize, validateBindings }) {
  return {
    async publish(command) {
      const value = {
        ...normalize(command.workflow),
        organizationId: command.organizationId,
        ...(command.teamId ? { teamId: command.teamId } : {}),
        ...(command.projectId ? { projectId: command.projectId } : {}),
      };
      validateBindings(value);
      const previous = state.workflows.filter((workflow) => workflow.id === value.id).at(-1);
      if (previous && previous.organizationId !== value.organizationId) {
        throw new Error('Workflow is not available.');
      }
      if (command.baseVersion !== undefined && command.baseVersion !== (previous?.version ?? 0))
        throw new Error('Workflow changed in another client. Reload before publishing.');
      value.version = (previous?.version ?? 0) + 1;
      state.workflows.push(value);
      delete state.workflowDrafts[value.id];
      if (command.makeDefault) {
        if (value.projectId) state.defaultWorkflowIds.projects[value.projectId] = value.id;
        else state.defaultWorkflowIds.organizations[value.organizationId] = value.id;
      }
      await save();
      return value;
    },

    async saveDraft(command) {
      const value = {
        ...structuredClone(command.workflow),
        organizationId: command.organizationId,
        ...(command.teamId ? { teamId: command.teamId } : {}),
        ...(command.projectId ? { projectId: command.projectId } : {}),
      };
      if (!value || !/^[\w-]{1,80}$/.test(value.id) || JSON.stringify(value).length > 100_000)
        throw new Error('Invalid draft.');
      const previous = state.workflowDrafts[value.id];
      if (previous && previous.workflow.organizationId !== value.organizationId) {
        throw new Error('Workflow is not available.');
      }
      if ((command.revision ?? 0) !== (previous?.revision ?? 0)) {
        throw new Error('Draft changed in another client. Reload first.');
      }
      const draft = {
        workflow: structuredClone(value),
        revision: (previous?.revision ?? 0) + 1,
      };
      state.workflowDrafts[value.id] = draft;
      await save();
      return draft;
    },
  };
}
