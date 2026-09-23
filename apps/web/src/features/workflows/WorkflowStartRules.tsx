import { useState } from 'react';
import { command, type RuntimeState, type WorkflowStartRule } from '../../shared/api/runtime';

type RuleInput = Omit<
  WorkflowStartRule,
  'id' | 'organizationId' | 'principal' | 'revision' | 'migratedFrom'
> & { id?: string };

export function WorkflowStartRules({ state }: { state: RuntimeState }) {
  const rules = state.workflowStartRules ?? [];
  const [editing, setEditing] = useState<RuleInput | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const project = state.projects.find((value) => value.id === editing?.projectId);
  const board = state.boards.find((value) => value.id === editing?.boardId);
  const workflows = state.workflows.filter(
    (value) =>
      value.organizationId === project?.organizationId &&
      (!value.projectId || value.projectId === project?.id) &&
      (!value.teamId || value.teamId === project?.teamId),
  );
  function begin(rule?: WorkflowStartRule) {
    const firstProject = rule?.projectId ?? state.projects[0]?.id ?? '';
    const firstProjectValue = state.projects.find((item) => item.id === firstProject);
    const firstWorkflow = state.workflows.find(
      (value) =>
        value.organizationId === firstProjectValue?.organizationId &&
        (!value.projectId || value.projectId === firstProject) &&
        (!value.teamId || value.teamId === firstProjectValue?.teamId),
    );
    setEditing(
      rule
        ? {
            id: rule.id,
            name: rule.name,
            projectId: rule.projectId,
            event: rule.event,
            boardId: rule.boardId,
            columnId: rule.columnId,
            bindingId: rule.bindingId,
            workType: rule.workType,
            workflowId: rule.workflowId,
            workflowVersion: rule.workflowVersion,
            enabled: rule.enabled,
          }
        : {
            name: '',
            projectId: firstProject,
            event: 'ticket_created',
            workflowId: firstWorkflow?.id ?? '',
            workflowVersion: firstWorkflow?.version ?? 1,
            enabled: false,
          },
    );
    setRevision(rule?.revision ?? 0);
    setMessage('');
  }
  function update(patch: Partial<RuleInput>) {
    setEditing((value) => (value ? { ...value, ...patch } : value));
  }
  async function save() {
    if (!editing || !project) return;
    setSaving(true);
    setMessage('');
    try {
      await command('saveWorkflowStartRule', {
        organizationId: project.organizationId ?? 'personal',
        rule: editing,
        revision,
      });
      setEditing(null);
      setMessage('Start automation saved.');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="workflow-start-rules" aria-label="Start automations">
      <header>
        <h2>Start automations</h2>
        <button type="button" onClick={() => begin()} disabled={!state.projects.length}>
          New automation
        </button>
      </header>
      <p>
        When a project event matches, start one pinned workflow version. Multiple matches are held
        for review.
      </p>
      {rules.length === 0 && (
        <p>No start automations yet. Tickets can still start workflows manually.</p>
      )}
      <ul>
        {rules.map((rule) => {
          const latest = state.workflowTriggers?.filter((value) => value.ruleId === rule.id).at(-1);
          return (
            <li key={rule.id}>
              <button type="button" onClick={() => begin(rule)}>
                {rule.name}
              </button>
              <span>
                {state.projects.find((value) => value.id === rule.projectId)?.name ??
                  rule.projectId}{' '}
                · {rule.event.replaceAll('_', ' ')} · {rule.workflowId} v{rule.workflowVersion} ·{' '}
                {rule.enabled ? 'Enabled' : 'Disabled'}
              </span>
              {latest && (
                <span>
                  Last decision: {latest.status}
                  {latest.message ? ` · ${latest.message}` : ''}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {editing && (
        <div className="workflow-start-rule-editor">
          <h3>{editing.id ? 'Edit automation' : 'New automation'}</h3>
          <label>
            Name{' '}
            <input
              value={editing.name}
              maxLength={120}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label>
            Project{' '}
            <select
              value={editing.projectId}
              disabled={Boolean(editing.id)}
              onChange={(event) => {
                const selected = state.projects.find((value) => value.id === event.target.value);
                const first = state.workflows.find(
                  (value) =>
                    value.organizationId === selected?.organizationId &&
                    (!value.projectId || value.projectId === selected?.id) &&
                    (!value.teamId || value.teamId === selected?.teamId),
                );
                update({
                  projectId: event.target.value,
                  boardId: undefined,
                  columnId: undefined,
                  bindingId: undefined,
                  workType: undefined,
                  workflowId: first?.id ?? '',
                  workflowVersion: first?.version ?? 1,
                });
              }}
            >
              {state.projects.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            When{' '}
            <select
              value={editing.event}
              onChange={(event) =>
                update({
                  event: event.target.value as RuleInput['event'],
                  boardId: undefined,
                  columnId: undefined,
                  bindingId: undefined,
                })
              }
            >
              <option value="ticket_created">Ticket created</option>
              <option value="ticket_updated">Ticket updated</option>
              <option value="ticket_imported">Ticket imported</option>
              <option value="ticket_source_updated">Imported ticket updated</option>
              <option value="ticket_message_received">Customer message received</option>
              <option value="board_placement_changed">Board placement changed</option>
              <option value="ticket_moved">Ticket moved</option>
            </select>
          </label>
          {['ticket_imported', 'ticket_source_updated', 'ticket_message_received'].includes(editing.event) && (
            <label>
              Import binding{' '}
              <select value={editing.bindingId ?? ''} onChange={(event) => update({ bindingId: event.target.value || undefined })}>
                <option value="">Choose binding</option>
                {(state.ticketImportBindings ?? []).filter((value) => value.projectId === editing.projectId).map((value) => (
                  <option key={value.id} value={value.id}>{value.name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Work type (optional){' '}
            <input value={editing.workType ?? ''} onChange={(event) => update({ workType: event.target.value || undefined })} placeholder="development" />
          </label>
          {['ticket_moved', 'board_placement_changed'].includes(editing.event) && (
            <label>
              Board{' '}
              <select
                value={editing.boardId ?? ''}
                onChange={(event) =>
                  update({ boardId: event.target.value || undefined, columnId: undefined })
                }
              >
                <option value="">Any board</option>
                {state.boards
                  .filter((value) => value.projectIds.includes(editing.projectId))
                  .map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {editing.boardId &&
            ['ticket_moved', 'board_placement_changed'].includes(editing.event) && (
              <label>
                Entered column{' '}
                <select
                  value={editing.columnId ?? ''}
                  onChange={(event) => update({ columnId: event.target.value || undefined })}
                >
                  <option value="">Any placement change</option>
                  {board?.columns.map((value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          <label>
            Start workflow{' '}
            <select
              value={`${editing.workflowId}@${editing.workflowVersion}`}
              onChange={(event) => {
                const value = workflows.find(
                  (item) => `${item.id}@${item.version}` === event.target.value,
                );
                if (value) update({ workflowId: value.id, workflowVersion: value.version ?? 1 });
              }}
            >
              {workflows.map((value) => (
                <option key={`${value.id}@${value.version}`} value={`${value.id}@${value.version}`}>
                  {value.name} · v{value.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />{' '}
            Enabled
          </label>
          <div>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !editing.name.trim() || !editing.workflowId}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save automation'}
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
