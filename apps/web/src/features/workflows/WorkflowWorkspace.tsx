import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, MoreHorizontal } from 'lucide-react';
import type { RuntimeState } from '../../shared/api/runtime';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';
import { WorkflowEditor } from './WorkflowEditor';
import { WorkflowRuns } from './WorkflowRuns';
import { Automations } from './Automations';
import { workflowOverview, workflowRunLabel, publishedWorkflowsForProject } from './workflow-runs';
import './workflow.css';
import './workflow-theme.css';
import './workflow-workspace.css';

type WorkflowPane = 'list' | 'workflow' | 'automations' | 'editor';

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
  const [pane, setPane] = useState<WorkflowPane>(workflowRunId ? 'workflow' : 'list');
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => state.workflowRuns?.find((run) => run.id === workflowRunId)?.workflowId,
  );
  const [runId, setRunId] = useState(workflowRunId);
  const [startOpen, setStartOpen] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; key: number }>();
  const menu = useDetailsPopover();
  const rows = projectId ? workflowOverview(state, projectId) : [];
  const canStart =
    projectId && selectedId
      ? publishedWorkflowsForProject(state, projectId).some((value) => value.id === selectedId)
      : false;
  useEffect(() => {
    setStartOpen(false);
  }, [pane, selectedId]);
  const selected = rows.find((row) => row.workflow.id === selectedId);
  const workflowChanged = useCallback((id: string) => {
    setEditor((previous) => (previous && previous.id !== id ? { ...previous, id } : previous));
    setSelectedId(id);
  }, []);
  function openRun(id: string) {
    setRunId(id);
    setSelectedId(state.workflowRuns?.find((run) => run.id === id)?.workflowId);
    setPane('workflow');
  }
  useEffect(() => {
    if (workflowRunId) openRun(workflowRunId);
  }, [workflowRunId]);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pane, selectedId, menu]);
  function edit(id?: string) {
    if (!id || !editor || editor.id !== id)
      setEditor((previous) => ({ id, key: (previous?.key ?? 0) + 1 }));
    setSelectedId(id);
    setPane('editor');
  }
  function back() {
    if ((pane === 'editor' || pane === 'automations') && selectedId) setPane('workflow');
    else {
      setPane('list');
      setSelectedId(undefined);
      setRunId(undefined);
    }
  }

  return (
    <section className="workflow-workspace" aria-label="Workflow workspace">
      <div className="workflow-workspace-nav">
        {pane !== 'list' && (
          <button
            className="workflow-back"
            type="button"
            onClick={back}
            aria-label={
              (pane === 'editor' || pane === 'automations') && selectedId
                ? '← Back to workflow'
                : '← Back to workflows'
            }
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>
              {(pane === 'editor' || pane === 'automations') && selectedId
                ? 'Back to workflow'
                : 'Back to workflows'}
            </span>
          </button>
        )}
        {pane === 'workflow' && (
          <strong className="workflow-context-name">
            {selected?.workflow.name ?? 'Workflow run'}
          </strong>
        )}
        {pane === 'workflow' && selected?.draft && (
          <span className="workflow-unsaved">Unpublished changes</span>
        )}
        {pane === 'list' && (
          <button
            className="workflow-create"
            disabled={!projectId}
            type="button"
            onClick={() => edit()}
          >
            New workflow
          </button>
        )}
        {pane === 'workflow' && (
          <button
            className="workflow-create"
            type="button"
            disabled={!canStart}
            onClick={() => setStartOpen((value) => !value)}
          >
            Run workflow
          </button>
        )}
        {(pane === 'list' || pane === 'workflow') && (
          <details className="workflow-actions-menu" ref={menu}>
            <summary aria-label="Workflow actions" title="Workflow actions">
              <MoreHorizontal size={18} />
            </summary>
            <div>
              {selectedId && (
                <button type="button" onClick={() => edit(selectedId)}>
                  Edit workflow
                </button>
              )}
              <button type="button" onClick={() => setPane('automations')}>
                Automations
              </button>
            </div>
          </details>
        )}
      </div>
      <div className="workflow-workspace-panel">
        {pane === 'list' && (
          <div className="workflow-overview">
            {!projectId ? (
              <p>Select a project to view its workflows.</p>
            ) : !rows.length ? (
              <p>No workflows in this project.</p>
            ) : (
              <ul className="workflow-overview-list">
                {rows.map(({ workflow, latestRun }) => (
                  <li key={workflow.id}>
                    <button
                      className="workflow-overview-entry"
                      type="button"
                      aria-label={`Open ${workflow.name}`}
                      onClick={() => {
                        setSelectedId(workflow.id);
                        setRunId(undefined);
                        setPane('workflow');
                      }}
                    >
                      <strong>{workflow.name}</strong>
                      <span
                        className={`workflow-overview-status ${latestRun && ['failed', 'interrupted'].includes(latestRun.status) ? 'is-failed' : latestRun?.status === 'waiting_gate' ? 'is-waiting' : ''}`}
                      >
                        {latestRun ? workflowRunLabel(latestRun.status) : 'No runs'}
                      </span>
                      {latestRun && (
                        <time dateTime={latestRun.startedAt}>
                          {new Date(latestRun.startedAt).toLocaleString()}
                        </time>
                      )}
                      <ArrowRight size={16} className="workflow-row-arrow" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {pane === 'workflow' && (
          <WorkflowRuns
            key={selectedId ?? 'run'}
            state={state}
            projectId={projectId}
            workflowId={selectedId}
            initialRunId={runId}
            onOpenConversation={onOpenConversation}
            onOpenRun={openRun}
            startOpen={startOpen}
            closeStart={() => setStartOpen(false)}
          />
        )}
        {pane === 'automations' && (
          <div className="workflow-automations-pane">
            <Automations
              key={`${projectId}:${selectedId}`}
              state={state}
              projectId={projectId}
              workflowId={selectedId}
            />
          </div>
        )}
        {editor && (
          <div className="workflow-editor-pane" hidden={pane !== 'editor'}>
            <WorkflowEditor
              key={editor.key}
              state={state}
              initialWorkflowId={editor.id}
              createNew={!editor.id}
              onWorkflowChange={workflowChanged}
            />
          </div>
        )}
      </div>
    </section>
  );
}
