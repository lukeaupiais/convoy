import { useEffect, useRef } from 'react';
import type { RuntimeState, WorkflowReference } from '../../shared/api/runtime';
import './board-workflows.css';

/** Inspect the exact publication; never load a draft or autosave on navigation. */
export function WorkflowReferenceView({
  state,
  reference,
  onBack,
}: {
  state: RuntimeState;
  reference: WorkflowReference;
  onBack: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = useRef<HTMLElement>(null);
  const workflow = state.workflows.find(
    (value) => value.id === reference.workflowId && value.version === reference.workflowVersion,
  );
  const rule = state.automations?.find((value) => value.id === reference.ruleId);
  useEffect(() => {
    heading.current?.focus();
    selected.current?.scrollIntoView({ block: 'nearest' });
  }, [reference]);
  return (
    <section className="workflow-reference">
      <header>
        <h2 ref={heading} tabIndex={-1}>
          {workflow ? `${workflow.name} · v${workflow.version}` : 'Workflow version unavailable'}
        </h2>
        <button type="button" onClick={onBack}>
          Workflows
        </button>
      </header>
      {workflow && (
        <>
          {reference.ruleId && (
            <article ref={reference.nodeId ? undefined : selected} data-selected="true">
              {rule ? (
                <>
                  <h3>{rule.name}</h3>
                  {reference.ruleRevision !== undefined &&
                    reference.ruleRevision !== rule.revision && (
                      <p>
                        Automation changed since inspection (previously revision{' '}
                        {reference.ruleRevision}).
                      </p>
                    )}
                  <p>
                    {state.projects.find((p) => p.id === rule.projectId)?.name}
                    {rule.when.bindingId &&
                      ` · ${state.ticketImportBindings?.find((b) => b.id === rule.when.bindingId)?.name ?? 'Unavailable source'}`}
                    {rule.when.boardId &&
                      ` · ${state.boards?.find((b) => b.id === rule.when.boardId)?.name ?? 'Unavailable board'}`}
                    {rule.when.columnId &&
                      ` · ${state.boards?.find((b) => b.id === rule.when.boardId)?.columns.find((c) => c.id === rule.when.columnId)?.name ?? 'Unavailable column'}`}
                  </p>
                  {rule.if.map((condition, index) => (
                    <p key={index}>
                      If {condition.field} = {String(condition.value)}
                    </p>
                  ))}
                  <p>
                    Revision {rule.revision} · {rule.enabled ? 'Enabled' : 'Disabled'}
                  </p>
                  <p>
                    {rule.when.event.replaceAll('_', ' ')} → {rule.then.workflowId} v
                    {rule.then.workflowVersion}
                  </p>
                  {(rule.then.workflowId !== workflow.id ||
                    rule.then.workflowVersion !== workflow.version) && (
                    <p>This automation now targets a different publication.</p>
                  )}
                </>
              ) : (
                <p>Start automation unavailable.</p>
              )}
            </article>
          )}
          {Object.values(state.boardAutomations ?? {})
            .flatMap((view) => view.relationships)
            .filter(
              (row) =>
                row.workflowId === workflow.id &&
                row.workflowVersion === workflow.version &&
                row.kind === 'effect' &&
                row.nodeId === reference.nodeId,
            )
            .map((row, index) => (
              <p key={index}>
                {row.label}
                {row.detail ? ` · ${row.detail}` : ''}
                {row.unresolved ? ' · Unresolved' : ''}
              </p>
            ))}
          {workflow.nodes.map((node) => (
            <article
              key={node.id}
              ref={node.id === reference.nodeId ? selected : undefined}
              data-selected={node.id === reference.nodeId}
            >
              <h3>{node.name}</h3>
              <p>
                {node.kind}
                {node.id === workflow.entryNode ? ' · Entry stage' : ''}
              </p>
              {node.prompt && <p>{node.prompt}</p>}
              {node.operation && <p>{node.operation.replaceAll('_', ' ')}</p>}
              {node.input && (
                <details>
                  <summary>Action configuration</summary>
                  <pre>{JSON.stringify(node.input, null, 2)}</pre>
                </details>
              )}
              {workflow.edges
                .filter((edge) => edge.from === node.id)
                .map((edge) => (
                  <p key={edge.id}>
                    {edge.outcome} →{' '}
                    {workflow.nodes.find((target) => target.id === edge.to)?.name ?? edge.to}
                  </p>
                ))}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
