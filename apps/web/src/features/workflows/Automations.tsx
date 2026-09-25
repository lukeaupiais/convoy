import { useState } from 'react';
import { command, type RuntimeState, type AutomationRule } from '../../shared/api/runtime';
type Input = Omit<AutomationRule, 'id' | 'organizationId' | 'principal' | 'revision'> & {
  id?: string;
};
export function Automations({ state }: { state: RuntimeState }) {
  const [editing, setEditing] = useState<Input | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const capabilities = state.automationCapabilities;
  const project = state.projects.find((p) => p.id === editing?.projectId);
  const event = capabilities?.events.find((e) => e.id === editing?.when.event);
  const workflows = state.workflows.filter(
    (w) =>
      w.organizationId === project?.organizationId &&
      (!w.projectId || w.projectId === project?.id) &&
      (!w.teamId || w.teamId === project?.teamId),
  );
  function begin(rule?: AutomationRule) {
    setRevision(rule?.revision ?? 0);
    setMessage('');
    setEditing(
      rule
        ? {
            id: rule.id,
            name: rule.name,
            projectId: rule.projectId,
            when: structuredClone(rule.when),
            if: structuredClone(rule.if),
            then: structuredClone(rule.then),
            enabled: rule.enabled,
          }
        : {
            name: '',
            projectId: state.projects[0]?.id ?? '',
            when: { event: capabilities?.events[0]?.id ?? 'ticket_created' },
            if: [],
            then: { action: 'start_workflow', workflowId: '', workflowVersion: 1 },
            enabled: false,
          },
    );
  }
  async function save() {
    if (!editing || !project || !event) return;
    setSaving(true);
    setMessage('');
    try {
      await command('saveAutomation', {
        organizationId: project.organizationId ?? 'personal',
        rule: editing,
        revision,
      });
      setEditing(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="workflow-start-rules" aria-label="Automations">
      <header>
        <h2>Automations</h2>
        <button onClick={() => begin()} disabled={!capabilities}>
          New automation
        </button>
      </header>
      {(state.automations ?? []).map((rule) => (
        <div key={rule.id}>
          <button onClick={() => begin(rule)}>{rule.name}</button>
          <span>
            {capabilities?.events.find((e) => e.id === rule.when.event)?.label ??
              'Unsupported event'}{' '}
            →{' '}
            {state.workflows.find(
              (w) => w.id === rule.then.workflowId && w.version === rule.then.workflowVersion,
            )?.name ?? 'Unavailable workflow'}
          </span>
          {!rule.enabled && <small>Disabled</small>}
        </div>
      ))}
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Name
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              required
            />
          </label>
          <label>
            Project
            <select
              value={editing.projectId}
              disabled={Boolean(editing.id)}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  projectId: e.target.value,
                  when: { event: editing.when.event },
                  then: { action: 'start_workflow', workflowId: '', workflowVersion: 1 },
                })
              }
            >
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            When
            <select
              value={editing.when.event}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  when: { event: e.target.value as AutomationRule['when']['event'] },
                  if: [],
                })
              }
            >
              {!event && (
                <option value={editing.when.event}>Unsupported: {editing.when.event}</option>
              )}
              {capabilities?.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          {event?.scope === 'binding' && (
            <label>
              Source
              <select
                required
                value={editing.when.bindingId ?? ''}
                onChange={(e) =>
                  setEditing({ ...editing, when: { ...editing.when, bindingId: e.target.value } })
                }
              >
                <option value="">Choose source</option>
                {state.ticketImportBindings
                  ?.filter((b) => b.projectId === editing.projectId)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {event?.scope === 'board' && (
            <>
              <label>
                Board
                <select
                  value={editing.when.boardId ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      when: {
                        event: editing.when.event,
                        ...(e.target.value ? { boardId: e.target.value } : {}),
                      },
                    })
                  }
                >
                  <option value="">All boards</option>
                  {state.boards
                    ?.filter((b) => b.projectIds.includes(editing.projectId))
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </label>
              {editing.when.boardId && (
                <label>
                  Column
                  <select
                    value={editing.when.columnId ?? ''}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        when: { ...editing.when, columnId: e.target.value || undefined },
                      })
                    }
                  >
                    <option value="">Any column</option>
                    {state.boards
                      ?.find((b) => b.id === editing.when.boardId)
                      ?.columns.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </>
          )}
          {editing.if.map((condition, index) => (
            <div key={index}>
              <label>
                If
                <select
                  value={condition.field}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      if: editing.if.map((c, i) =>
                        i === index ? { ...c, field: e.target.value } : c,
                      ),
                    })
                  }
                >
                  {event?.fields.map((field) => (
                    <option key={field}>{field}</option>
                  ))}
                </select>
              </label>
              <input
                aria-label="Equals"
                value={String(condition.value)}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    if: editing.if.map((c, i) =>
                      i === index ? { ...c, value: e.target.value } : c,
                    ),
                  })
                }
              />
              <button
                type="button"
                aria-label="Remove condition"
                onClick={() =>
                  setEditing({ ...editing, if: editing.if.filter((_, i) => i !== index) })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={!event}
            onClick={() =>
              setEditing({
                ...editing,
                if: [...editing.if, { field: event!.fields[0], operator: 'equals', value: '' }],
              })
            }
          >
            Add condition
          </button>
          <label>
            Then
            <select
              required
              value={JSON.stringify([editing.then.workflowId, editing.then.workflowVersion])}
              onChange={(e) => {
                const [workflowId, workflowVersion] = JSON.parse(e.target.value);
                setEditing({
                  ...editing,
                  then: { action: 'start_workflow', workflowId, workflowVersion },
                });
              }}
            >
              <option value={JSON.stringify(['', 1])}>Start workflow</option>
              {workflows.map((w) => (
                <option key={`${w.id}:${w.version}`} value={JSON.stringify([w.id, w.version])}>
                  {w.name} · v{w.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            Enabled
          </label>
          <button
            disabled={saving || !event || editing.if.some((c) => !event.fields.includes(c.field))}
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
