const containsReference = (value, boardId, columnId = undefined) => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => containsReference(item, boardId, columnId));
  if (value.boardId === boardId && (columnId === undefined || value.columnId === columnId)) return true;
  return Object.values(value).some(item => containsReference(item, boardId, columnId));
};

/** Query all pinned and editable workflow definitions without leaking storage into Work. */
export function createWorkflowReferences(state) {
  const definitions = () => [
    ...(state.workflows ?? []),
    ...Object.values(state.workflowDrafts ?? {}).map(value => value.workflow),
    ...Object.values(state.sessions ?? {}).map(value => value.workflow),
    ...(state.automations ?? []),
  ];
  return {
    board: boardId => definitions().some(value => containsReference(value, boardId)),
    column: (boardId, columnId) => definitions().some(value => containsReference(value, boardId, columnId)),
  };
}
