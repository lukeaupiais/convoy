import { useEffect, useState } from 'react';
import type { RuntimeState } from '../../shared/api/runtime';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowRuns } from './WorkflowRuns';
import './workflow-workspace.css';

type WorkflowPane = 'definitions' | 'runs';

export function WorkflowWorkspace({
  state,
  projectId,
  workflowRunId,
}: {
  state: RuntimeState;
  projectId?: string;
  workflowRunId?: string;
}) {
  const [pane, setPane] = useState<WorkflowPane>(() =>
    workflowRunId ? 'runs' : 'definitions',
  );
  useEffect(() => {
    if (workflowRunId) setPane('runs');
  }, [workflowRunId]);

  return (
    <section className="workflow-workspace" aria-label="Workflow workspace">
      <nav className="workflow-workspace-nav" aria-label="Workflow views">
        <button
          type="button"
          aria-pressed={pane === 'definitions'}
          onClick={() => setPane('definitions')}
        >
          Definitions
        </button>
        <button type="button" aria-pressed={pane === 'runs'} onClick={() => setPane('runs')}>
          Runs
        </button>
      </nav>
      <div className="workflow-workspace-panel">
        {pane === 'definitions' ? (
          <WorkflowEditor state={state} />
        ) : (
          <WorkflowRuns state={state} projectId={projectId} initialRunId={workflowRunId} />
        )}
      </div>
    </section>
  );
}
