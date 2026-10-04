/** Versioned workflow publication and optimistic draft editing. */
export function createWorkflowRegistry({ state, save, normalize, validateBindings }) {
  const sameOwnerScope = (left, right) =>
    (left.organizationId ?? 'personal') === (right.organizationId ?? 'personal') &&
    (left.teamId ?? null) === (right.teamId ?? null) && (left.projectId ?? null) === (right.projectId ?? null);
  const assertIdentityScope = (id, value) => {
    const published = state.workflows.filter(workflow => workflow.id === id);
    const draft = state.workflowDrafts?.[id]?.workflow;
    if ([...published, ...(draft ? [draft] : [])].some(existing => !sameOwnerScope(existing, value)))
      throw new Error('Workflow is not available.');
  };
  return {
    async publish(command) {
      const value = {
        ...normalize(command.workflow, { publishing: true }),
        organizationId: command.organizationId,
        ...(command.teamId ? { teamId: command.teamId } : {}),
        ...(command.projectId ? { projectId: command.projectId } : {}),
      };
      validateBindings(value);
      assertIdentityScope(value.id, value);
      const previous = state.workflows.filter(workflow => workflow.id === value.id && sameOwnerScope(workflow, value)).at(-1);
      const previousVersion = previous ? previous.version ?? 1 : 0;
      if (command.baseVersion !== undefined && command.baseVersion !== previousVersion)
        throw new Error('Workflow changed in another client. Reload before publishing.');
      value.version = previousVersion + 1;
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
      assertIdentityScope(value.id, value);
      const previous = state.workflowDrafts[value.id];
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
