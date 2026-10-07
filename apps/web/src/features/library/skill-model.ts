import type {
  SkillCatalogue,
  SkillSelection,
  SkillSource,
  SkillSourceInstance,
} from '../../../../../packages/contracts/src';

export const scopeLabel = (scope: string) => scope[0].toUpperCase() + scope.slice(1);
export function sourceInstance(
  source: SkillSource,
  runnerId?: string,
  workspaceId?: string,
): SkillSourceInstance | undefined {
  const matches = source.instances.filter(
    (instance) =>
      (!runnerId || instance.runnerId === runnerId) &&
      (!workspaceId || instance.workspaceId === workspaceId),
  );
  // Multiple worktrees are separate observations. Never choose one by polling order.
  return matches.length === 1 ? matches[0] : undefined;
}
export function sourceQualifier(source: SkillSource, catalogue: SkillCatalogue) {
  const root = catalogue.roots.find((value) => value.id === source.rootId);
  return `${scopeLabel(source.scope)} · ${root?.path ?? source.rootId}/${source.relativeDirectory}`;
}
export function selectionKey(selection: SkillSelection) {
  return selection.mode === 'source-current'
    ? `source:${selection.sourceId}`
    : `snapshot:${selection.snapshotId}:${selection.digest}`;
}
export function replaceSourceSelection(
  selections: SkillSelection[],
  sourceId: string,
  previous: SkillSelection | undefined,
  next?: SkillSelection,
) {
  const retained = selections.filter(
    (selection) =>
      selection !== previous &&
      !(selection.mode === 'source-current' && selection.sourceId === sourceId),
  );
  return next ? [...retained, next] : retained;
}
