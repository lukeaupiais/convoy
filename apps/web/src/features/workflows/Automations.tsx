import { useState } from 'react';
import {
  command,
  type RuntimeState,
  type AutomationRule,
  type WorkflowJsonSchema,
} from '../../shared/api/runtime';
import { parseActivityJsonEdit } from './workflow-authoring';
type Input = Omit<AutomationRule, 'id' | 'organizationId' | 'principal' | 'revision'> & {
  id?: string;
};
type ScheduleDraft = {
  name: string;
  projectId: string;
  workflowId: string;
  workflowVersion: number;
  runInput: Record<string, unknown>;
  kind: 'interval' | 'calendar';
  everySeconds: number;
  frequency: 'daily' | 'weekly' | 'monthly';
  localTime: string;
  timeZone: string;
  weekday: number;
  dayOfMonth: number;
  missedPolicy: 'skip' | 'coalesce_once' | 'catchUp';
  maxFirings: number;
};
function initialInput(schema: WorkflowJsonSchema) {
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === 'object') return {};
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer')
    return Math.max(
      schema.minimum ?? 0,
      schema.type === 'integer' ? Math.ceil(schema.minimum ?? 0) : 0,
    );
  if (schema.type === 'null') return null;
  return '';
}
function compatibleEventField(
  field: NonNullable<RuntimeState['workflowEventDescriptors']>[number]['payload'][number],
  schema: WorkflowJsonSchema,
) {
  return (
    (field.type === schema.type || (field.type === 'enum' && schema.type === 'string')) &&
    (!schema.enum ||
      (field.type === 'enum' && field.values?.every((value) => schema.enum?.includes(value))))
  );
}
export function Automations({ state }: { state: RuntimeState }) {
  const [editing, setEditing] = useState<Input | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [jsonInputDrafts, setJsonInputDrafts] = useState<Record<string, string>>({});
  const [jsonInputErrors, setJsonInputErrors] = useState<Record<string, string>>({});
  const capabilities = state.automationCapabilities;
  const project = state.projects.find((p) => p.id === editing?.projectId);
  const event = capabilities?.events.find((e) => e.id === editing?.when.event);
  const eventRef = event?.descriptorId ?? event?.id;
  const eventRevisions = (state.workflowEventDescriptors ?? []).filter(
    (descriptor) =>
      descriptor.id === eventRef || descriptor.aliases.includes(editing?.when.event ?? ''),
  );
  const selectedEventDescriptor =
    eventRevisions.find((descriptor) => descriptor.revision === editing?.when.eventRevision) ??
    eventRevisions.reduce<(typeof eventRevisions)[number] | undefined>(
      (latest, descriptor) =>
        !latest || descriptor.revision > latest.revision ? descriptor : latest,
      undefined,
    );
  const eventPayload = selectedEventDescriptor?.payload ?? event?.payload;
  const scheduleProject = state.projects.find((p) => p.id === scheduleDraft?.projectId);
  const workflows = state.workflows.filter(
    (w) =>
      w.organizationId === project?.organizationId &&
      (!w.projectId || w.projectId === project?.id) &&
      (!w.teamId || w.teamId === project?.teamId),
  );
  const selectedWorkflow = workflows.find(
    (value) =>
      value.id === editing?.then.workflowId && value.version === editing.then.workflowVersion,
  );
  const scheduleWorkflows = state.workflows.filter(
    (w) =>
      w.organizationId === scheduleProject?.organizationId &&
      (!w.projectId || w.projectId === scheduleProject?.id) &&
      (!w.teamId || w.teamId === scheduleProject?.teamId),
  );
  const selectedScheduleWorkflow = scheduleWorkflows.find(
    (value) =>
      value.id === scheduleDraft?.workflowId && value.version === scheduleDraft.workflowVersion,
  );
  const missingAutomationInputs = (selectedWorkflow?.runInputSchema?.required ?? []).some(
    (key) => !Object.hasOwn(editing?.then.inputBindings ?? {}, key),
  );
  const missingScheduleInputs = (selectedScheduleWorkflow?.runInputSchema?.required ?? []).some(
    (key) => !Object.hasOwn(scheduleDraft?.runInput ?? {}, key),
  );
  const hasInvalidJsonDraft = Object.values(jsonInputErrors).some(Boolean);
  function begin(rule?: AutomationRule) {
    setScheduleDraft(null);
    setRevision(rule?.revision ?? 0);
    setMessage('');
    setJsonInputDrafts({});
    setJsonInputErrors({});
    setEditing(
      rule
        ? {
            id: rule.id,
            name: rule.name,
            projectId: rule.projectId,
            when: structuredClone(rule.when),
            if: structuredClone(rule.if),
            then: structuredClone(rule.then),
            concurrency: rule.concurrency ? structuredClone(rule.concurrency) : undefined,
            enabled: rule.enabled,
          }
        : {
            name: '',
            projectId: state.projects[0]?.id ?? '',
            when: { event: '' },
            if: [],
            then: { action: 'start_workflow', workflowId: '', workflowVersion: 1 },
            enabled: false,
          },
    );
  }
  async function saveSchedule() {
    if (
      !scheduleDraft ||
      !scheduleProject ||
      !scheduleDraft.workflowId ||
      missingScheduleInputs ||
      hasInvalidJsonDraft
    )
      return;
    setSaving(true);
    setMessage('');
    try {
      await command('saveWorkflowSchedule', {
        name: scheduleDraft.name,
        projectId: scheduleDraft.projectId,
        workflowId: scheduleDraft.workflowId,
        workflowVersion: scheduleDraft.workflowVersion,
        runInput: scheduleDraft.runInput,
        schedule:
          scheduleDraft.kind === 'interval'
            ? {
                kind: 'interval',
                everySeconds: scheduleDraft.everySeconds,
                anchorAt: new Date().toISOString(),
              }
            : {
                kind: 'calendar',
                frequency: scheduleDraft.frequency,
                localTime: scheduleDraft.localTime,
                timeZone: scheduleDraft.timeZone,
                ...(scheduleDraft.frequency === 'weekly' ? { weekday: scheduleDraft.weekday } : {}),
                ...(scheduleDraft.frequency === 'monthly'
                  ? { dayOfMonth: scheduleDraft.dayOfMonth }
                  : {}),
              },
        missedFirePolicy:
          scheduleDraft.missedPolicy === 'catchUp'
            ? { catchUp: { maxFirings: scheduleDraft.maxFirings } }
            : scheduleDraft.missedPolicy,
        enabled: true,
      });
      setScheduleDraft(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
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
        <button onClick={() => begin()} disabled={!capabilities?.events.length}>
          New automation
        </button>
        <button
          onClick={() => {
            setEditing(null);
            setJsonInputDrafts({});
            setJsonInputErrors({});
            setScheduleDraft({
              name: '',
              projectId: state.projects[0]?.id ?? '',
              workflowId: '',
              workflowVersion: 1,
              runInput: {},
              kind: 'interval',
              everySeconds: 3600,
              frequency: 'daily',
              localTime: '09:00',
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              weekday: 1,
              dayOfMonth: 1,
              missedPolicy: 'coalesce_once',
              maxFirings: 3,
            });
          }}
          disabled={!state.projects.length}
        >
          New schedule
        </button>
      </header>
      {(state.workflowSchedules?.items ?? []).map((schedule) => (
        <div key={`${schedule.id}:${schedule.revision}`}>
          <strong>{schedule.name}</strong>
          <span>
            {' '}
            ·{' '}
            {schedule.enabled
              ? `Next ${new Date(schedule.nextFireAt).toLocaleString()}`
              : 'Disabled'}
          </span>
        </div>
      ))}
      {(state.automations ?? []).map((rule) => (
        <div key={rule.id}>
          <button onClick={() => begin(rule)}>{rule.name}</button>
          <span>
            {capabilities?.events.find((e) => e.id === rule.when.event)?.label ??
              'Unavailable event'}{' '}
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
              onChange={(e) => {
                setJsonInputDrafts({});
                setJsonInputErrors({});
                setEditing({
                  ...editing,
                  projectId: e.target.value,
                  when: { event: editing.when.event },
                  then: {
                    action: 'start_workflow',
                    workflowId: '',
                    workflowVersion: 1,
                    inputBindings: {},
                  },
                });
              }}
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
              onChange={(e) => {
                const selected = capabilities?.events.find((value) => value.id === e.target.value);
                setJsonInputDrafts({});
                setJsonInputErrors({});
                setEditing({
                  ...editing,
                  when: {
                    event: e.target.value as AutomationRule['when']['event'],
                    ...(selected?.revision ? { eventRevision: selected.revision } : {}),
                  },
                  if: [],
                  then: { ...editing.then, inputBindings: {} },
                });
              }}
            >
              <option value="">Choose event</option>
              {!event &&
                (editing.when.event ? (
                  <option value={editing.when.event}>Unavailable: {editing.when.event}</option>
                ) : null)}
              {capabilities?.events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>
          {eventRevisions.length > 1 && (
            <label>
              Event revision
              <select
                value={selectedEventDescriptor?.revision ?? event?.revision ?? ''}
                onChange={(e) => {
                  setJsonInputDrafts({});
                  setJsonInputErrors({});
                  setEditing({
                    ...editing,
                    when: { ...editing.when, eventRevision: Number(e.target.value) },
                    then: { ...editing.then, inputBindings: {} },
                  });
                }}
              >
                {eventRevisions
                  .sort((left, right) => right.revision - left.revision)
                  .map((descriptor) => (
                    <option
                      key={`${descriptor.id}:${descriptor.revision}`}
                      value={descriptor.revision}
                    >
                      v{descriptor.revision}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {event?.scope === 'resource' && (
            <fieldset>
              <legend>Resource</legend>
              <label>
                Resource kind
                <input
                  required
                  value={editing.when.resourceRef?.kind ?? ''}
                  pattern="[A-Za-z][A-Za-z0-9_.-]{0,79}"
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      when: {
                        ...editing.when,
                        ...(e.target.value || editing.when.resourceRef?.id
                          ? {
                              resourceRef: {
                                kind: e.target.value,
                                id: editing.when.resourceRef?.id ?? '',
                              },
                            }
                          : {}),
                      },
                    })
                  }
                />
              </label>
              <label>
                Resource ID
                <input
                  required
                  value={editing.when.resourceRef?.id ?? ''}
                  pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,119}"
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      when: {
                        ...editing.when,
                        ...(e.target.value || editing.when.resourceRef?.kind
                          ? {
                              resourceRef: {
                                kind: editing.when.resourceRef?.kind ?? '',
                                id: e.target.value,
                              },
                            }
                          : {}),
                      },
                    })
                  }
                />
              </label>
            </fieldset>
          )}
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
                        ...(editing.when.eventRevision
                          ? { eventRevision: editing.when.eventRevision }
                          : {}),
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
                  {(eventPayload?.map((field) => field.path) ?? event?.fields ?? []).map(
                    (field) => (
                      <option key={field}>{field}</option>
                    ),
                  )}
                </select>
              </label>
              <select
                aria-label="Predicate"
                value={condition.operator}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    if: editing.if.map((c, i) =>
                      i === index
                        ? {
                            ...c,
                            operator: e.target.value as AutomationRule['if'][number]['operator'],
                            value: undefined,
                          }
                        : c,
                    ),
                  })
                }
              >
                <option value="equals">equals</option>
                <option value="notEquals">does not equal</option>
                <option value="exists">exists</option>
                <option value="greaterThan">greater than</option>
                <option value="lessThan">less than</option>
              </select>
              {condition.operator !== 'exists' &&
              eventPayload?.find((field) => field.path === condition.field)?.type === 'enum' ? (
                <select
                  aria-label="Predicate value"
                  value={String(condition.value ?? '')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      if: editing.if.map((c, i) =>
                        i === index ? { ...c, value: e.target.value } : c,
                      ),
                    })
                  }
                >
                  <option value="">Choose value</option>
                  {eventPayload
                    .find((field) => field.path === condition.field)
                    ?.values?.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                </select>
              ) : condition.operator !== 'exists' &&
                eventPayload?.find((field) => field.path === condition.field)?.type ===
                  'boolean' ? (
                <select
                  aria-label="Predicate value"
                  value={String(condition.value ?? '')}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      if: editing.if.map((c, i) =>
                        i === index ? { ...c, value: e.target.value === 'true' } : c,
                      ),
                    })
                  }
                >
                  <option value="">Choose value</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                condition.operator !== 'exists' && (
                  <input
                    aria-label="Predicate value"
                    value={condition.value === undefined ? '' : String(condition.value)}
                    inputMode={
                      eventPayload?.find((field) => field.path === condition.field)?.type ===
                      'number'
                        ? 'decimal'
                        : 'text'
                    }
                    onChange={(e) => {
                      const fieldType = eventPayload?.find(
                        (field) => field.path === condition.field,
                      )?.type;
                      const value =
                        fieldType === 'number' && e.target.value !== ''
                          ? Number(e.target.value)
                          : e.target.value;
                      setEditing({
                        ...editing,
                        if: editing.if.map((c, i) => (i === index ? { ...c, value } : c)),
                      });
                    }}
                  />
                )
              )}
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
                if: [
                  ...editing.if,
                  {
                    field: eventPayload?.[0]?.path ?? event!.fields[0],
                    operator: 'equals',
                    value: '',
                  },
                ],
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
                setJsonInputDrafts({});
                setJsonInputErrors({});
                setEditing({
                  ...editing,
                  then: {
                    action: 'start_workflow',
                    workflowId,
                    workflowVersion,
                    inputBindings: {},
                  },
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
          {selectedWorkflow?.runInputSchema &&
            Object.entries(selectedWorkflow.runInputSchema.properties ?? {}).map(
              ([key, schema]) => {
                const binding = editing.then.inputBindings?.[key];
                const eventFields = (eventPayload ?? []).filter((field) =>
                  compatibleEventField(field, schema),
                );
                const source =
                  binding && 'from' in binding
                    ? `event:${binding.from.path.join('.')}`
                    : binding
                      ? 'constant'
                      : '';
                const setBinding = (
                  next: NonNullable<AutomationRule['then']['inputBindings']>[string] | undefined,
                ) => {
                  const inputBindings = { ...(editing.then.inputBindings ?? {}) };
                  if (next) inputBindings[key] = next;
                  else delete inputBindings[key];
                  setEditing({ ...editing, then: { ...editing.then, inputBindings } });
                  if (!next)
                    setJsonInputDrafts((value) => {
                      const draft = { ...value };
                      delete draft[`automation:${key}`];
                      return draft;
                    });
                  setJsonInputErrors((value) => {
                    const next = { ...value };
                    delete next[`automation:${key}`];
                    return next;
                  });
                };
                return (
                  <fieldset key={key}>
                    <label>
                      {key}
                      {selectedWorkflow.runInputSchema?.required?.includes(key) ? ' *' : ''}
                      <select
                        value={source}
                        onChange={(e) => {
                          setJsonInputDrafts((current) => {
                            const next = { ...current };
                            delete next[`automation:${key}`];
                            return next;
                          });
                          if (e.target.value === 'constant') {
                            const value = initialInput(schema);
                            setBinding({ value });
                            if (schema.type === 'object' || schema.type === 'array') {
                              const result = parseActivityJsonEdit(JSON.stringify(value), schema);
                              setJsonInputDrafts((current) => ({
                                ...current,
                                [`automation:${key}`]: JSON.stringify(value, null, 2),
                              }));
                              setJsonInputErrors((current) => ({
                                ...current,
                                [`automation:${key}`]: 'value' in result ? '' : result.error,
                              }));
                            }
                          } else if (e.target.value.startsWith('event:'))
                            setBinding({
                              from: {
                                kind: 'event_payload',
                                path: e.target.value.slice(6).split('.'),
                              },
                            });
                          else setBinding(undefined);
                        }}
                      >
                        <option value="">Unbound</option>
                        <option value="constant">Configured value</option>
                        {eventFields.map((field) => (
                          <option key={field.path} value={`event:${field.path}`}>
                            Event · {field.path}
                          </option>
                        ))}
                      </select>
                    </label>
                    {binding &&
                      'value' in binding &&
                      (schema.enum?.length ? (
                        <label>
                          Value
                          <select
                            value={JSON.stringify(binding.value)}
                            onChange={(e) =>
                              setBinding({
                                value: schema.enum?.find(
                                  (value) => JSON.stringify(value) === e.target.value,
                                ),
                              })
                            }
                          >
                            {schema.enum.map((value) => (
                              <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
                                {String(value)}
                              </option>
                            ))}
                          </select>
                        </label>
                      ) : schema.type === 'boolean' ? (
                        <label>
                          Value
                          <select
                            required={selectedWorkflow.runInputSchema?.required?.includes(key)}
                            value={String(binding.value)}
                            onChange={(e) => setBinding({ value: e.target.value === 'true' })}
                          >
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        </label>
                      ) : schema.type === 'object' || schema.type === 'array' ? (
                        <label>
                          Value
                          <textarea
                            aria-invalid={Boolean(jsonInputErrors[`automation:${key}`])}
                            value={
                              jsonInputDrafts[`automation:${key}`] ??
                              JSON.stringify(binding.value, null, 2)
                            }
                            onChange={(e) => {
                              const text = e.target.value;
                              const result = parseActivityJsonEdit(text, schema);
                              setJsonInputDrafts((value) => ({
                                ...value,
                                [`automation:${key}`]: text,
                              }));
                              setJsonInputErrors((value) => ({
                                ...value,
                                [`automation:${key}`]: 'value' in result ? '' : result.error,
                              }));
                              if ('value' in result) setBinding({ value: result.value });
                            }}
                          />
                          {jsonInputErrors[`automation:${key}`] && (
                            <span role="alert">{jsonInputErrors[`automation:${key}`]}</span>
                          )}
                        </label>
                      ) : schema.type === 'null' ? (
                        <label>
                          Value
                          <select
                            required={selectedWorkflow.runInputSchema?.required?.includes(key)}
                            value={String(binding.value === null)}
                            onChange={(e) =>
                              e.target.value === 'true'
                                ? setBinding({ value: null })
                                : setBinding(undefined)
                            }
                          >
                            <option value="false">Unset</option>
                            <option value="true">null</option>
                          </select>
                        </label>
                      ) : (
                        <label>
                          Value
                          <input
                            required={selectedWorkflow.runInputSchema?.required?.includes(key)}
                            type={
                              schema.type === 'integer' || schema.type === 'number'
                                ? 'number'
                                : 'text'
                            }
                            min={schema.minimum}
                            max={schema.maximum}
                            step={
                              schema.type === 'integer'
                                ? 1
                                : schema.type === 'number'
                                  ? 'any'
                                  : undefined
                            }
                            minLength={schema.minLength}
                            maxLength={schema.maxLength}
                            value={String(binding.value ?? '')}
                            onChange={(e) =>
                              setBinding({
                                value:
                                  schema.type === 'number' || schema.type === 'integer'
                                    ? Number(e.target.value)
                                    : e.target.value,
                              })
                            }
                          />
                        </label>
                      ))}
                  </fieldset>
                );
              },
            )}
          <label>
            Concurrency
            <select
              value={editing.concurrency?.policy ?? 'hold'}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  concurrency: {
                    policy: e.target.value as 'reject' | 'hold' | 'independent',
                    maxActiveRuns: editing.concurrency?.maxActiveRuns ?? 1,
                    ...(e.target.value === 'independent'
                      ? { overflowPolicy: editing.concurrency?.overflowPolicy ?? 'hold' }
                      : {}),
                  },
                })
              }
            >
              <option value="reject">Reject while active</option>
              <option value="hold">Hold while active</option>
              <option value="independent">Allow independent runs</option>
            </select>
          </label>
          {editing.concurrency?.policy === 'independent' && (
            <label>
              When full
              <select
                value={editing.concurrency.overflowPolicy ?? 'hold'}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    concurrency: {
                      ...editing.concurrency!,
                      overflowPolicy: e.target.value as 'reject' | 'hold',
                    },
                  })
                }
              >
                <option value="hold">Hold for explicit retry</option>
                <option value="reject">Record a conflict</option>
              </select>
            </label>
          )}
          <label>
            Maximum active runs
            <input
              type="number"
              min={1}
              max={100}
              value={editing.concurrency?.maxActiveRuns ?? 1}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  concurrency: {
                    policy: editing.concurrency?.policy ?? 'hold',
                    maxActiveRuns: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                  },
                })
              }
            />
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
            disabled={
              saving ||
              !event ||
              missingAutomationInputs ||
              hasInvalidJsonDraft ||
              editing.if.some(
                (c) =>
                  !(
                    eventPayload?.some((field) => field.path === c.field) ??
                    event.fields.includes(c.field)
                  ) ||
                  (c.operator !== 'exists' && c.value === undefined),
              )
            }
          >
            Save
          </button>
          <button type="button" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </form>
      )}
      {scheduleDraft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void saveSchedule();
          }}
        >
          <label>
            Name
            <input
              value={scheduleDraft.name}
              required
              maxLength={120}
              onChange={(e) => setScheduleDraft({ ...scheduleDraft, name: e.target.value })}
            />
          </label>
          <label>
            Project
            <select
              value={scheduleDraft.projectId}
              onChange={(e) => {
                setJsonInputDrafts({});
                setJsonInputErrors({});
                setScheduleDraft({
                  ...scheduleDraft,
                  projectId: e.target.value,
                  workflowId: '',
                  runInput: {},
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
            Workflow
            <select
              required
              value={JSON.stringify([scheduleDraft.workflowId, scheduleDraft.workflowVersion])}
              onChange={(e) => {
                const [workflowId, workflowVersion] = JSON.parse(e.target.value);
                setJsonInputDrafts({});
                setJsonInputErrors({});
                setScheduleDraft({ ...scheduleDraft, workflowId, workflowVersion, runInput: {} });
              }}
            >
              <option value={JSON.stringify(['', 1])}>Choose workflow</option>
              {scheduleWorkflows.map((w) => (
                <option key={`${w.id}:${w.version}`} value={JSON.stringify([w.id, w.version])}>
                  {w.name} · v{w.version}
                </option>
              ))}
            </select>
          </label>
          {selectedScheduleWorkflow?.runInputSchema &&
            Object.entries(selectedScheduleWorkflow.runInputSchema.properties ?? {}).map(
              ([key, schema]) => {
                const required =
                  selectedScheduleWorkflow.runInputSchema?.required?.includes(key) ?? false;
                const present = Object.hasOwn(scheduleDraft.runInput, key);
                const setScheduleValue = (value: unknown | undefined) => {
                  const runInput = { ...scheduleDraft.runInput };
                  if (value === undefined) delete runInput[key];
                  else runInput[key] = value;
                  setScheduleDraft({ ...scheduleDraft, runInput });
                  if (value === undefined)
                    setJsonInputDrafts((current) => {
                      const next = { ...current };
                      delete next[`schedule:${key}`];
                      return next;
                    });
                  setJsonInputErrors((current) => {
                    const next = { ...current };
                    delete next[`schedule:${key}`];
                    return next;
                  });
                };
                return (
                  <label key={key}>
                    {key}
                    {required ? ' *' : ''}
                    {schema.enum?.length ? (
                      <select
                        required={required}
                        value={present ? JSON.stringify(scheduleDraft.runInput[key]) : ''}
                        onChange={(e) =>
                          setScheduleValue(
                            e.target.value === ''
                              ? undefined
                              : schema.enum?.find(
                                  (value) => JSON.stringify(value) === e.target.value,
                                ),
                          )
                        }
                      >
                        <option value="">Unset</option>
                        {schema.enum.map((value) => (
                          <option key={JSON.stringify(value)} value={JSON.stringify(value)}>
                            {String(value)}
                          </option>
                        ))}
                      </select>
                    ) : schema.type === 'boolean' ? (
                      <select
                        required={required}
                        value={present ? String(scheduleDraft.runInput[key]) : ''}
                        onChange={(e) =>
                          setScheduleValue(
                            e.target.value === '' ? undefined : e.target.value === 'true',
                          )
                        }
                      >
                        <option value="">Unset</option>
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : schema.type === 'object' || schema.type === 'array' ? (
                      <>
                        <select
                          required={required}
                          aria-label={`${key} value state`}
                          value={present ? 'configured' : ''}
                          onChange={(e) => {
                            if (!e.target.value) {
                              setScheduleValue(undefined);
                              return;
                            }
                            const value = initialInput(schema);
                            setScheduleValue(value);
                            const result = parseActivityJsonEdit(JSON.stringify(value), schema);
                            setJsonInputDrafts((current) => ({
                              ...current,
                              [`schedule:${key}`]: JSON.stringify(value, null, 2),
                            }));
                            setJsonInputErrors((current) => ({
                              ...current,
                              [`schedule:${key}`]: 'value' in result ? '' : result.error,
                            }));
                          }}
                        >
                          <option value="">Unset</option>
                          <option value="configured">Configured value</option>
                        </select>
                        {present && (
                          <>
                            <textarea
                              required={required}
                              aria-invalid={Boolean(jsonInputErrors[`schedule:${key}`])}
                              value={
                                jsonInputDrafts[`schedule:${key}`] ??
                                JSON.stringify(scheduleDraft.runInput[key], null, 2)
                              }
                              onChange={(e) => {
                                const text = e.target.value;
                                const result = parseActivityJsonEdit(text, schema);
                                setJsonInputDrafts((current) => ({
                                  ...current,
                                  [`schedule:${key}`]: text,
                                }));
                                setJsonInputErrors((current) => ({
                                  ...current,
                                  [`schedule:${key}`]: 'value' in result ? '' : result.error,
                                }));
                                if ('value' in result) setScheduleValue(result.value);
                              }}
                            />
                            {jsonInputErrors[`schedule:${key}`] && (
                              <span role="alert">{jsonInputErrors[`schedule:${key}`]}</span>
                            )}
                          </>
                        )}
                      </>
                    ) : schema.type === 'null' ? (
                      <select
                        required={required}
                        value={present ? 'null' : ''}
                        onChange={(e) =>
                          setScheduleValue(e.target.value === 'null' ? null : undefined)
                        }
                      >
                        <option value="">Unset</option>
                        <option value="null">null</option>
                      </select>
                    ) : (
                      <input
                        required={required}
                        type={
                          schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'
                        }
                        min={schema.minimum}
                        max={schema.maximum}
                        step={
                          schema.type === 'integer'
                            ? 1
                            : schema.type === 'number'
                              ? 'any'
                              : undefined
                        }
                        minLength={schema.minLength}
                        maxLength={schema.maxLength}
                        value={present ? String(scheduleDraft.runInput[key]) : ''}
                        onChange={(e) =>
                          setScheduleValue(
                            e.target.value === ''
                              ? undefined
                              : schema.type === 'number' || schema.type === 'integer'
                                ? Number(e.target.value)
                                : e.target.value,
                          )
                        }
                      />
                    )}
                  </label>
                );
              },
            )}
          <label>
            Schedule
            <select
              value={scheduleDraft.kind}
              onChange={(e) =>
                setScheduleDraft({
                  ...scheduleDraft,
                  kind: e.target.value as ScheduleDraft['kind'],
                })
              }
            >
              <option value="interval">Interval</option>
              <option value="calendar">Calendar</option>
            </select>
          </label>
          {scheduleDraft.kind === 'interval' ? (
            <label>
              Run every (seconds)
              <input
                type="number"
                min={60}
                max={31536000}
                value={scheduleDraft.everySeconds}
                onChange={(e) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    everySeconds: Math.max(60, Math.min(31536000, Number(e.target.value) || 60)),
                  })
                }
              />
            </label>
          ) : (
            <>
              <label>
                Frequency
                <select
                  value={scheduleDraft.frequency}
                  onChange={(e) =>
                    setScheduleDraft({
                      ...scheduleDraft,
                      frequency: e.target.value as ScheduleDraft['frequency'],
                    })
                  }
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </label>
              <label>
                Local time
                <input
                  type="time"
                  required
                  value={scheduleDraft.localTime}
                  onChange={(e) =>
                    setScheduleDraft({ ...scheduleDraft, localTime: e.target.value })
                  }
                />
              </label>
              <label>
                IANA time zone
                <input
                  required
                  value={scheduleDraft.timeZone}
                  onChange={(e) => setScheduleDraft({ ...scheduleDraft, timeZone: e.target.value })}
                  placeholder="Europe/Lisbon"
                />
              </label>
              {scheduleDraft.frequency === 'weekly' && (
                <label>
                  Day of week
                  <select
                    value={scheduleDraft.weekday}
                    onChange={(e) =>
                      setScheduleDraft({ ...scheduleDraft, weekday: Number(e.target.value) })
                    }
                  >
                    {[
                      'Sunday',
                      'Monday',
                      'Tuesday',
                      'Wednesday',
                      'Thursday',
                      'Friday',
                      'Saturday',
                    ].map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {scheduleDraft.frequency === 'monthly' && (
                <label>
                  Day of month
                  <input
                    type="number"
                    min={1}
                    max={28}
                    value={scheduleDraft.dayOfMonth}
                    onChange={(e) =>
                      setScheduleDraft({
                        ...scheduleDraft,
                        dayOfMonth: Math.max(1, Math.min(28, Number(e.target.value) || 1)),
                      })
                    }
                  />
                </label>
              )}
            </>
          )}
          <label>
            Missed runs
            <select
              value={scheduleDraft.missedPolicy}
              onChange={(e) =>
                setScheduleDraft({
                  ...scheduleDraft,
                  missedPolicy: e.target.value as ScheduleDraft['missedPolicy'],
                })
              }
            >
              <option value="coalesce_once">Coalesce into one run</option>
              <option value="skip">Skip older slots</option>
              <option value="catchUp">Catch up in bounded batches</option>
            </select>
          </label>
          {scheduleDraft.missedPolicy === 'catchUp' && (
            <label>
              Maximum runs per pass
              <input
                type="number"
                min={1}
                max={100}
                value={scheduleDraft.maxFirings}
                onChange={(e) =>
                  setScheduleDraft({
                    ...scheduleDraft,
                    maxFirings: Math.max(1, Math.min(100, Number(e.target.value) || 1)),
                  })
                }
              />
            </label>
          )}
          <button
            disabled={
              saving || !scheduleDraft.workflowId || missingScheduleInputs || hasInvalidJsonDraft
            }
          >
            Save schedule
          </button>
          <button type="button" onClick={() => setScheduleDraft(null)}>
            Cancel
          </button>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
