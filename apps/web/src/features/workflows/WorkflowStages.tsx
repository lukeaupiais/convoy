import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  CornerUpLeft,
  GripVertical,
  Plus,
} from 'lucide-react';
import { useState } from 'react';
import {
  kindLabels,
  outcomesFor,
  workflowStageOrder,
  type GraphNode,
  type GraphWorkflow,
  type NodeKind,
} from './workflow-codec';

export function WorkflowStages({
  workflow,
  selectedId,
  reordering,
  onSelect,
  onInsert,
  onReorder,
}: {
  workflow: GraphWorkflow;
  selectedId: string | null;
  reordering: boolean;
  onSelect: (id: string) => void;
  onInsert: (afterId: string | null, type: NodeKind) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [insertAfter, setInsertAfter] = useState<string | null | undefined>(undefined);
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const { mainPath, otherRoutes } = workflowStageOrder(workflow);
  const orderedNodes = [...mainPath, ...otherRoutes];
  const positionById = new Map(orderedNodes.map((node, index) => [node.id, index]));
  const canReorder = reordering && otherRoutes.length === 0;

  function move(id: string, target: string) {
    if (id === target) return;
    const ids = orderedNodes.map((node) => node.id);
    const from = ids.indexOf(id);
    const to = ids.indexOf(target);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    onReorder(ids);
  }

  return (
    <div className="workflow-stage-editor">
      {otherRoutes.length > 0 && (
        <p className="workflow-stage-route-note">
          The main route is shown first. {otherRoutes.length} stage
          {otherRoutes.length === 1 ? '' : 's'} belong to alternate routes. Use Advanced graph to
          change connections or reorder this flow.
        </p>
      )}
      <ol className="workflow-stage-list" aria-label="Workflow flow">
        {orderedNodes.map((node, index) => {
          const primary = outcomesFor(node)[0];
          const output = stageOutput(node);
          const alternateRoutes = workflow.edges.filter(
            (edge) => edge.from === node.id && edge.outcome !== primary,
          );
          return (
            <li
              key={node.id}
              className={`${selectedId === node.id ? 'selected' : ''} ${output ? 'has-output' : ''}`}
              draggable={canReorder}
              onDragStart={() => setDragging(node.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragging) move(dragging, node.id);
                setDragging(null);
              }}
            >
              {index === mainPath.length && (
                <p className="workflow-stage-route-note">Alternate route stages</p>
              )}
              <div
                className={`workflow-stage-row ${output ? 'has-output' : ''} ${canReorder ? 'reordering' : ''}`}
              >
                {canReorder && (
                  <span className="workflow-stage-grip" aria-hidden="true">
                    <GripVertical size={15} />
                  </span>
                )}
                <span className="workflow-flow-node" aria-hidden="true" />
                <button className="workflow-stage-main" onClick={() => onSelect(node.id)}>
                  <strong>{node.name || 'Untitled stage'}</strong>
                  {output && <span>{output}</span>}
                </button>
                {canReorder && (
                  <span className="workflow-stage-moves">
                    <button
                      className="workflow-stage-move"
                      aria-label={`Move ${node.name} up`}
                      disabled={index === 0}
                      onClick={() => move(node.id, orderedNodes[index - 1]?.id)}
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      className="workflow-stage-move"
                      aria-label={`Move ${node.name} down`}
                      disabled={index === orderedNodes.length - 1}
                      onClick={() => move(node.id, orderedNodes[index + 1]?.id)}
                    >
                      <ArrowDown size={13} />
                    </button>
                  </span>
                )}
              </div>
              {alternateRoutes.length > 0 && (
                <div className="workflow-stage-routes">
                  {alternateRoutes.map((route) => (
                    <div className="workflow-flow-branch" key={route.id}>
                      <span>{routeLabel(route.outcome)}</span>
                      <strong>
                        {(positionById.get(route.to) ?? 0) <= index ? (
                          <CornerUpLeft size={12} />
                        ) : (
                          <CornerDownRight size={12} />
                        )}
                        {(positionById.get(route.to) ?? 0) <= index ? 'Return to' : 'Continue at'}{' '}
                        {byId.get(route.to)?.name ?? route.to}
                      </strong>
                    </div>
                  ))}
                </div>
              )}
              <div className="workflow-stage-insert">
                {insertAfter === node.id ? (
                  <div className="workflow-stage-types">
                    {(Object.keys(kindLabels) as NodeKind[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => {
                          onInsert(node.id, type);
                          setInsertAfter(undefined);
                        }}
                      >
                        {kindLabels[type]}
                      </button>
                    ))}
                  </div>
                ) : (
                  <button
                    aria-label={`Add step after ${node.name}`}
                    title="Add step"
                    onClick={() => setInsertAfter(node.id)}
                  >
                    <Plus size={13} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {workflow.nodes.length === 0 && (
        <button className="secondary" onClick={() => onInsert(null, 'agent')}>
          <Plus size={14} /> Add first step
        </button>
      )}
    </div>
  );
}

function routeLabel(outcome: string) {
  return outcome.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function stageOutput(node: GraphNode) {
  return node.artifact?.path ?? null;
}
