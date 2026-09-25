import type { BoardAutomationRelationship, BoardAutomationView } from '../../shared/api/runtime';

export function relationshipSections(view: BoardAutomationView, columnId?: string) {
  const groups = new Map<
    string,
    {
      id: string;
      title: string;
      project: boolean;
      unresolved: boolean;
      rows: BoardAutomationRelationship[];
    }
  >();
  for (const row of view.relationships) {
    if (columnId && (row.scope !== 'column' || row.columnId !== columnId)) continue;
    const project = row.scope === 'project';
    const unresolved = Boolean(row.unresolved);
    const id = JSON.stringify([project, unresolved, row.workflowId]);
    const group = groups.get(id) ?? {
      id,
      project,
      unresolved,
      title: row.workflowName ?? 'Unavailable workflow',
      rows: [],
    };
    group.rows.push(row);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function relationshipEvent(row: BoardAutomationRelationship, _columnName?: string) {
  return row.label;
}
