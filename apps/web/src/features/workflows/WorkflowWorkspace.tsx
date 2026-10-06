import { useEffect, useState } from 'react';
import type { RuntimeState } from '../../shared/api/runtime';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowRuns } from './WorkflowRuns';
import { Automations } from './Automations';
import { workflowOverview } from './workflow-runs';
import './workflow.css';
import './workflow-theme.css';
import './workflow-workspace.css';

type WorkflowPane = 'overview' | 'runs' | 'automations' | 'editor';
const runLabels: Record<string, string> = {
  waiting_gate: 'Waiting for review',
  awaiting_continue: 'Ready to continue',
  awaiting_submission: 'Waiting for submission',
  waiting_event: 'Waiting for event',
};

export function WorkflowWorkspace({
  state,
  projectId,
  workflowRunId,
  onOpenConversation,
}: {
  state: RuntimeState;
  projectId?: string;
  workflowRunId?: string;
  onOpenConversation?: (id: string) => void;
}) {
  const [pane, setPane] = useState<WorkflowPane>(() => (workflowRunId ? 'runs' : 'overview'));
  const [runId, setRunId] = useState(workflowRunId);
  const [editor, setEditor] = useState<{ id?: string; key: number }>();
  useEffect(() => {
    if (workflowRunId) {
      setRunId(workflowRunId);
      setPane('runs');
    }
  }, [workflowRunId]);
  const rows = projectId ? workflowOverview(state, projectId) : [];
  function edit(id?: string) {
    setEditor((previous) => ({ id, key: (previous?.key ?? 0) + 1 }));
    setPane('editor');
  }

  return (
    <section className="workflow-workspace" aria-label="Workflow workspace">
      <nav className="workflow-workspace-nav" aria-label="Workflow views">
        {(['overview', 'runs', 'automations'] as const).map((view) => (
          <button
            type="button"
            key={view}
            aria-pressed={pane === view}
            onClick={() => setPane(view)}
          >
            {view === 'overview' ? 'Overview' : view === 'runs' ? 'Runs' : 'Automations'}
          </button>
        ))}
        {editor && (
          <button type="button" aria-pressed={pane === 'editor'} onClick={() => setPane('editor')}>
            Editor
          </button>
        )}
        {pane === 'overview' && (
          <button
            type="button"
            className="workflow-create"
            disabled={!projectId}
            onClick={() => edit()}
          >
            New workflow
          </button>
        )}
      </nav>
      <div className="workflow-workspace-panel">
        {pane === 'overview' && (
          <div className="workflow-overview">
            {!projectId ? (
              <p>Select a project to view its workflows.</p>
            ) : rows.length === 0 ? (
              <p>No workflows in this project.</p>
            ) : (
              <ul className="workflow-overview-list">
                {rows.map(({ workflow, draft, latestRun }) => {
                  const session =
                    latestRun && !latestRun.independent
                      ? state.sessions.find((value) => value.id === latestRun.sessionId)
                      : undefined;
                  const canOpen =
                    latestRun && (latestRun.independent || (session && onOpenConversation));
                  const status = latestRun
                    ? (runLabels[latestRun.status] ?? latestRun.status.replaceAll('_', ' '))
                    : 'No runs';
                  return (
                    <li key={workflow.id} className="workflow-overview-row">
                      <div className="workflow-overview-name">
                        <strong>{workflow.name}</strong>
                        <span>
                          {workflow.version ? `v${workflow.version}` : 'Unpublished'}
                          {draft ? ' · Draft' : ''}
                        </span>
                      </div>
                      <div className="workflow-overview-run">
                        <span
                          className={`workflow-overview-status ${latestRun && ['failed', 'interrupted'].includes(latestRun.status) ? 'is-failed' : latestRun?.status === 'waiting_gate' ? 'is-waiting' : ''}`}
                        >
                          {status}
                        </span>
                        {latestRun && (
                          <time dateTime={latestRun.startedAt}>
                            {new Date(latestRun.startedAt).toLocaleString()}
                          </time>
                        )}
                      </div>
                      <div className="workflow-overview-actions">
                        {canOpen && (
                          <button
                            type="button"
                            onClick={() => {
                              if (latestRun.independent) {
                                setRunId(latestRun.id);
                                setPane('runs');
                              } else if (session)
                                onOpenConversation?.(session.conversationId ?? session.id);
                            }}
                          >
                            View run
                          </button>
                        )}
                        <button
                          type="button"
                          aria-label={`Edit ${workflow.name}`}
                          onClick={() => edit(workflow.id)}
                        >
                          Edit
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {pane === 'runs' && (
          <WorkflowRuns state={state} projectId={projectId} initialRunId={runId} />
        )}
        {pane === 'automations' && (
          <div className="workflow-automations-pane">
            <Automations state={state} />
          </div>
        )}
        {editor && (
          <div className="workflow-editor-pane" hidden={pane !== 'editor'}>
            <WorkflowEditor
              key={editor.key}
              state={state}
              initialWorkflowId={editor.id}
              createNew={!editor.id}
            />
          </div>
        )}
      </div>
    </section>
  );
}
