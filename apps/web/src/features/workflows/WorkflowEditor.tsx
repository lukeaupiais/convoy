import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  GitBranch,
  MoreHorizontal,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { command, type RuntimeState, type WorkflowActivityBinding, type WorkflowActivityDescriptor, type WorkflowJsonSchema, type WorkflowStep } from '../../shared/api/runtime';
import { activityBindingSelectionValue, activityBindingSourceIsAvailable, activityBindingSourceKey, activityEnumOptionIndex, activityEnumValueAt, activityJsonEditKey, activityPermissionEditor, activityPinIsStale, activitySchemaPathLabel, activitySourceOptionKey, changedActivityPin, declaredObjectPaths, parseActivityJsonEdit, parseRunInputSchemaEdit } from './workflow-authoring';
import { ProfilePicker, profileRef } from '../library';
import { newId } from '../../shared/lib/browser';
import {
  actionInputDefaults,
  blankWorkflow,
  canAddPresentationBinding,
  displayValue,
  fresh,
  fromWorkflow,
  kindLabels,
  layout,
  insertWorkflowStage,
  outcomesFor,
  reorderWorkflowStages,
  toWorkflow,
  validateWorkflow,
  type ActionOperation,
  type BoardSummary,
  type Condition,
  type ConditionOperator,
  type ConditionSource,
  type ConditionValueType,
  type GraphEdge,
  type GraphNode,
  type GraphWorkflow,
  type NodeKind,
  type PresentationBinding,
  type SessionMode,
} from './workflow-codec';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowStages } from './WorkflowStages';
import { Automations } from './Automations';
import './workflow.css';
import './workflow-theme.css';

const kindIcon: Record<NodeKind, typeof Zap> = {
  agent: Zap,
  check: Check,
  approval: ShieldCheck,
  action: Sparkles,
  branch: GitBranch,
  wait: MoreHorizontal,
};

type WorkflowTemplate = 'team-delivery' | 'small-change' | 'bug-fix' | 'blank';
const legacyTicketWaitEvents = new Set([
  'ticket_message_received',
  'ticket_source_updated',
  'ticket_updated',
]);

function templateWorkflow(template: WorkflowTemplate): GraphWorkflow {
  if (template === 'blank') return blankWorkflow();
  const types: NodeKind[] =
    template === 'team-delivery'
      ? ['agent', 'approval', 'agent', 'check', 'approval']
      : template === 'bug-fix'
        ? ['agent', 'agent', 'check', 'approval']
        : ['agent', 'check', 'approval'];
  const names =
    template === 'team-delivery'
      ? ['Plan ticket', 'Approve plan', 'Implement ticket', 'Verify', 'Review changes']
      : template === 'bug-fix'
        ? ['Diagnose', 'Fix', 'Regression check', 'Review changes']
        : ['Implement', 'Verify', 'Review changes'];
  const nodes = types.map((type, index) => ({ ...fresh(type, index), name: names[index] }));
  if (template === 'team-delivery')
    nodes[0].artifact = { path: 'plan.md', headings: ['Approach', 'Acceptance criteria'] };
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: newId(),
    from: node.id,
    to: nodes[index + 1].id,
    outcome: outcomesFor(node)[0],
  }));
  const firstApproval = nodes.find((node) => node.type === 'approval');
  if (firstApproval && template === 'team-delivery')
    edges.push({
      id: newId(),
      from: firstApproval.id,
      to: nodes[0].id,
      outcome: 'changes_requested',
    });
  return fromWorkflow({
    id: newId(),
    name:
      template === 'team-delivery'
        ? 'Team delivery'
        : template === 'bug-fix'
          ? 'Bug fix'
          : 'Small change',
    version: 0,
    nodes,
    edges,
    entryNode: nodes[0].id,
    maxRevisions: 3,
  });
}

export function WorkflowEditor({ state }: { state: RuntimeState }) {
  const published = useMemo(
    () => [
      ...new Map(
        (state.workflows as unknown as GraphWorkflow[]).map((workflow) => [workflow.id, workflow]),
      ).values(),
    ],
    [state.workflows],
  );
  const runtimeDefinitions = (state.runtimeDefinitions ?? []).filter(
    (d) => d.projectId === state.activeContext?.projectId,
  );
  const draftRecords = state.workflowDrafts ?? {};
  const configuredPublished = published.find((workflow) => workflow.id === state.defaultWorkflowId) as GraphWorkflow | undefined;
  const initialSource = configuredPublished ?? undefined;
  const initialRecord = initialSource ? draftRecords[initialSource.id] : undefined;
  const [draft, setDraft] = useState<GraphWorkflow>(() =>
    fromWorkflow(
      (initialRecord?.workflow as unknown as GraphWorkflow | undefined) ??
        initialSource ??
        templateWorkflow('blank'),
    ),
  );
  const [runInputSchemaText, setRunInputSchemaText] = useState(() => JSON.stringify(draft.runInputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false }, null, 2));
  const [runInputSchemaError, setRunInputSchemaError] = useState<string | null>(null);
  const [activityJsonDrafts, setActivityJsonDrafts] = useState<Record<string, string>>({});
  const [activityJsonErrors, setActivityJsonErrors] = useState<Record<string, string>>({});
  const activeActivityJsonErrors = Object.entries(activityJsonErrors).filter(([key]) => {
    try {
      const [nodeId, activityId, revision] = JSON.parse(key) as [string, string, number, string];
      return draft.nodes.some(node => node.id === nodeId && node.activity?.id === activityId && node.activity.revision === revision);
    } catch { return false; }
  });
  const invalidAuthoring = Boolean(runInputSchemaError || activeActivityJsonErrors.length);
  useEffect(() => {
    setRunInputSchemaText(JSON.stringify(draft.runInputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false }, null, 2));
    setRunInputSchemaError(null);
  }, [draft.id]);
  const [revision, setRevision] = useState(initialRecord?.revision ?? 0);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: string; outcome: string } | null>(null);
  const [view, setView] = useState<'stages' | 'graph'>(() => draft.nodes.length ? 'stages' : 'graph');
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [makeDefault, setMakeDefault] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(toWorkflow(draft)));
  const [autoSaving, setAutoSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'pending' | 'error'>('saved');
  const [publishPending, setPublishPending] = useState(
    () => Boolean(initialRecord) || !initialSource,
  );
  const selected = draft.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdge = draft.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const snapshot = JSON.stringify(toWorkflow(draft));
  const draftOptions = [
    ...published.map((workflow) => ({
      id: workflow.id,
      label: `${workflow.name} · v${workflow.version ?? 0}`,
      draft: false,
    })),
    ...Object.entries(draftRecords).map(([id, value]) => ({
      id: `draft:${id}`,
      sourceId: id,
      label: `${String(value.workflow?.name ?? 'Untitled')} · draft`,
      draft: true,
    })),
  ];
  function patchNode(id: string, patch: Partial<GraphNode>) {
    const currentNode = draft.nodes.find(node => node.id === id);
    if (Object.hasOwn(patch, 'activity') && (currentNode?.activity?.id !== patch.activity?.id || currentNode?.activity?.revision !== patch.activity?.revision)) {
      const belongsToNode = (key: string) => {
        try { return (JSON.parse(key) as unknown[])[0] === id; } catch { return false; }
      };
      setActivityJsonDrafts(current => Object.fromEntries(Object.entries(current).filter(([key]) => !belongsToNode(key))));
      setActivityJsonErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !belongsToNode(key))));
    }
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    }));
  }
  function patchHumanTask(id: string, humanTask: WorkflowStep['humanTask'], rename?: { from: string; to: string }) {
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, humanTask } : node),
      edges: rename ? current.edges.map((edge) => edge.from === id && edge.outcome === rename.from ? { ...edge, outcome: rename.to } : edge) : current.edges,
    }));
  }
  function patchInput(id: string, key: string, value: string) {
    const node = draft.nodes.find((item) => item.id === id);
    if (node) patchNode(id, { input: { ...(node.input ?? {}), [key]: value } });
  }
  function recordActivityJsonEdit(key: string, text: string, error?: string) {
    setActivityJsonDrafts(current => ({ ...current, [key]: text }));
    setActivityJsonErrors(current => {
      const next = { ...current };
      if (error) next[key] = error; else delete next[key];
      return next;
    });
  }
  function clearActivityJsonEdit(key: string) {
    setActivityJsonDrafts(current => { const next = { ...current }; delete next[key]; return next; });
    setActivityJsonErrors(current => { const next = { ...current }; delete next[key]; return next; });
  }
  function addNode(type: NodeKind) {
    const node = fresh(type, draft.nodes.length);
    setDraft((current) => {
      const source = selectedId ? current.nodes.find((item) => item.id === selectedId) : undefined;
      const next = { ...node, x: source ? source.x + 340 : node.x, y: source?.y ?? node.y };
      const outcome = source
        ? outcomesFor(source).find(
            (value) =>
              !current.edges.some((edge) => edge.from === source.id && edge.outcome === value),
          )
        : undefined;
      return {
        ...current,
        nodes: [...current.nodes, next],
        edges:
          source && outcome
            ? [...current.edges, { id: newId(), from: source.id, to: next.id, outcome }]
            : current.edges,
        entryNode: current.entryNode || next.id,
      };
    });
    setSelectedId(node.id);
    setSelectedEdgeId(null);
    setPaletteOpen(false);
  }
  function insertStage(afterId: string | null, type: NodeKind) {
    const node = fresh(type, draft.nodes.length);
    setDraft((current) => insertWorkflowStage(current, afterId, node));
    setSelectedId(node.id);
    setSelectedEdgeId(null);
  }
  function reorderStages(ids: string[]) {
    setDraft((current) => {
      const reordered = reorderWorkflowStages(current, ids);
      return {
        ...reordered,
        nodes: layout(reordered.nodes, reordered.edges, reordered.entryNode),
      };
    });
  }
  function removeNode(id: string) {
    setDraft((current) => {
      const nodes = current.nodes.filter((node) => node.id !== id);
      return {
        ...current,
        nodes,
        edges: current.edges.filter((edge) => edge.from !== id && edge.to !== id),
        entryNode: current.entryNode === id ? nodes[0]?.id : current.entryNode,
      };
    });
    setSelectedId(null);
    setSelectedEdgeId(null);
    setConnecting(null);
  }
  function beginConnection(from: string, outcome?: string) {
    setMessageError(false);
    const node = draft.nodes.find((item) => item.id === from) ?? fresh();
    const selectedOutcome =
      outcome ??
      outcomesFor(node).find(
        (value) => !draft.edges.some((edge) => edge.from === from && edge.outcome === value),
      ) ??
      outcomesFor(node)[0];
    setConnecting({ from, outcome: selectedOutcome });
    setSelectedId(null);
    setSelectedEdgeId(null);
    setMessage(`Tap a node to route “${selectedOutcome}”.`);
  }
  function connect(to: string) {
    setMessageError(false);
    if (!connecting || connecting.from === to) {
      setConnecting(null);
      return;
    }
    if (
      draft.edges.some(
        (edge) => edge.from === connecting.from && edge.outcome === connecting.outcome,
      )
    ) {
      setMessage('That outcome already has a route. Edit the existing edge.');
      setConnecting(null);
      return;
    }
    setDraft((current) => ({
      ...current,
      edges: [
        ...current.edges,
        { id: newId(), from: connecting.from, to, outcome: connecting.outcome },
      ],
    }));
    setConnecting(null);
    setMessage('Route added.');
  }
  function updateEdge(id: string, patch: Partial<GraphEdge>) {
    setDraft((current) => ({
      ...current,
      edges: current.edges.map((edge) => (edge.id === id ? { ...edge, ...patch } : edge)),
    }));
  }
  function removeEdge(id: string) {
    setDraft((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) }));
    setSelectedEdgeId(null);
  }
  function autoLayout() {
    setDraft((current) => ({
      ...current,
      nodes: layout(current.nodes, current.edges, current.entryNode),
    }));
  }
  const [fitRequest, setFitRequest] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messageError, setMessageError] = useState(false);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedId(null);
        setSelectedEdgeId(null);
        setConnecting(null);
        setPaletteOpen(false);
        setSettingsOpen(false);
        setNewMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  function fitGraph() {
    setFitRequest((value) => value + 1);
  }
  function load(id: string) {
    setMessageError(false);
    const sourceId = id.replace(/^draft:/, '');
    const stored = draftRecords[sourceId];
    const source = stored?.workflow ?? published.find((workflow) => workflow.id === sourceId);
    if (source) {
      const next = fromWorkflow(source as unknown as GraphWorkflow);
      setDraft(next);
      setRunInputSchemaText(JSON.stringify(next.runInputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false }, null, 2));
      setRunInputSchemaError(null);
      setActivityJsonDrafts({});
      setActivityJsonErrors({});
      setSavedSnapshot(JSON.stringify(toWorkflow(next)));
      setSaveStatus('saved');
      setRevision(stored?.revision ?? 0);
      setPublishPending(Boolean(stored));
      setSelectedId(null);
      setSelectedEdgeId(null);
      if (!next.nodes.length) setView('graph');
      setMessage(stored ? 'Draft loaded.' : 'Published version loaded.');
    }
  }
  function newWorkflow(template: WorkflowTemplate) {
    setMessageError(false);
    setDraft(templateWorkflow(template));
    setRunInputSchemaText(JSON.stringify({ type: 'object', properties: {}, required: [], additionalProperties: false }, null, 2));
    setRunInputSchemaError(null);
    setActivityJsonDrafts({});
    setActivityJsonErrors({});
    setSavedSnapshot('');
    setSaveStatus('pending');
    setRevision(0);
    setPublishPending(true);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setNewMenuOpen(false);
    setView(template === 'blank' ? 'graph' : 'stages');
    setMessage('New workflow draft.');
  }
  async function publish() {
    if (invalidAuthoring) {
      setMessageError(true);
      setMessage(runInputSchemaError ?? activeActivityJsonErrors[0]?.[1] ?? 'Finish editing the invalid JSON value before saving.');
      return;
    }
    const value = toWorkflow(draft);
    const errors = validateWorkflow(draft);
    if (errors.length) {
      setMessageError(true);
      setMessage(errors.join(' '));
      return;
    }
    setWorking(true);
    setMessageError(false);
    setMessage('');
    try {
      await command('saveWorkflow', {
        workflow: value,
        baseVersion: draft.version ?? 0,
        makeDefault,
      });
      const next = { ...draft, version: (draft.version ?? 0) + 1 };
      setDraft(next);
      setSavedSnapshot(JSON.stringify(toWorkflow(next)));
      setSaveStatus('saved');
      setRevision(0);
      setPublishPending(false);
      setMessage('Published. Active runs remain pinned.');
    } catch (error) {
      setMessageError(true);
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    if (snapshot === savedSnapshot || autoSaving || working || invalidAuthoring) return;
    setPublishPending(true);
    setSaveStatus('pending');
    const timer = window.setTimeout(() => {
      const captured = snapshot;
      setAutoSaving(true);
      void command('saveWorkflowDraft', {
        workflow: toWorkflow(draft),
        revision,
      })
        .then(() => {
          setRevision((value) => value + 1);
          setSavedSnapshot(captured);
          setSaveStatus('saved');
        })
        .catch((error: Error) => {
          setSaveStatus('error');
          setMessageError(true);
          setMessage(error.message);
        })
        .finally(() => setAutoSaving(false));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [autoSaving, draft, invalidAuthoring, makeDefault, revision, savedSnapshot, snapshot, working]);

  return (
    <section className="workflow-studio" aria-label="Workflow studio">
      <header className="workflow-studio-heading">
        <div className="workflow-selector">
          <select
            aria-label="Select workflow or draft"
            value={draft.id}
            onChange={(event) => load(event.target.value)}
          >
            <option value={draft.id}>
              {draft.name || 'Untitled'}
              {draft.version ? ` · v${draft.version}` : ' · draft'}
            </option>
            {draftOptions
              .filter((option) => option.id !== draft.id)
              .map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
          </select>
          <button
            className="icon-button"
            aria-label="New workflow"
            aria-expanded={newMenuOpen}
            onClick={() => {
              setNewMenuOpen((value) => !value);
              setMoreMenuOpen(false);
            }}
          >
            <Plus size={17} />
          </button>
        </div>
        {saveStatus !== 'saved' && (
          <span className={`workflow-save-state ${saveStatus}`}>
            {saveStatus === 'error' ? 'Not saved' : 'Saving…'}
          </span>
        )}
        <div className="workflow-toolbar">
          <button
            className="icon-button"
            aria-label="Workflow options"
            aria-expanded={moreMenuOpen}
            onClick={() => {
              setMoreMenuOpen((value) => !value);
              setNewMenuOpen(false);
            }}
          >
            <MoreHorizontal size={18} />
          </button>
          <button
            className="primary"
            disabled={!publishPending || working || autoSaving || invalidAuthoring || snapshot !== savedSnapshot}
            onClick={() => void publish()}
          >
            {working ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </header>
      {newMenuOpen && (
        <div className="workflow-new-menu" role="menu" aria-label="New workflow">
          <button onClick={() => newWorkflow('team-delivery')}>Team delivery</button>
          <button onClick={() => newWorkflow('small-change')}>Small change</button>
          <button onClick={() => newWorkflow('bug-fix')}>Bug fix</button>
          <button onClick={() => newWorkflow('blank')}>Blank</button>
        </div>
      )}
      {moreMenuOpen && (
        <div className="workflow-more-menu" role="menu" aria-label="Workflow options">
          <button
            onClick={() => {
              setSettingsOpen((value) => !value);
              setMoreMenuOpen(false);
            }}
          >
            <Settings2 size={14} /> Settings
          </button>
          <button
            onClick={() => {
              setView((value) => (value === 'graph' ? 'stages' : 'graph'));
              setSelectedEdgeId(null);
              setMoreMenuOpen(false);
            }}
          >
            <GitBranch size={14} /> {view === 'graph' ? 'Stages' : 'Advanced graph'}
          </button>
          {view === 'stages' && (
            <button
              onClick={() => {
                setReordering((value) => !value);
                setMoreMenuOpen(false);
              }}
            >
              {reordering ? 'Done reordering' : 'Reorder'}
            </button>
          )}
          {view === 'graph' && (
            <>
              <button
                onClick={() => {
                  autoLayout();
                  setMoreMenuOpen(false);
                }}
              >
                Layout
              </button>
              <button
                onClick={() => {
                  fitGraph();
                  setMoreMenuOpen(false);
                }}
              >
                Fit graph
              </button>
            </>
          )}
        </div>
      )}
      {settingsOpen && (
        <div className="workflow-definition-settings">
          <label>
            Verification runtime
            <select
              value={
                draft.runtime === null
                  ? 'disabled'
                  : draft.runtime
                    ? `${draft.runtime.id}@${draft.runtime.version}`
                    : ''
              }
              onChange={(event) => {
                const selected = runtimeDefinitions.find(
                  (d) => `${d.id}@${d.version}` === event.target.value,
                );
                setDraft((current) => ({
                  ...current,
                  runtime:
                    event.target.value === 'disabled'
                      ? null
                      : selected
                        ? { id: selected.id, version: selected.version, required: false }
                        : undefined,
                }));
              }}
            >
              <option value="">Project default</option>
              <option value="disabled">Disabled</option>
              {runtimeDefinitions.map((d) => (
                <option key={`${d.projectId}:${d.id}@${d.version}`} value={`${d.id}@${d.version}`}>
                  {d.name} · v{d.version}
                </option>
              ))}
            </select>
          </label>
          {draft.runtime && (
            <label>
              <input
                type="checkbox"
                checked={draft.runtime.required}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    runtime: current.runtime
                      ? { ...current.runtime, required: event.target.checked }
                      : current.runtime,
                  }))
                }
              />
              Require runtime availability
            </label>
          )}
          <label>
            Capability profile
            <ProfilePicker
              state={state}
              value={
                draft.capabilityProfile
                  ? `${draft.capabilityProfile.id}@${draft.capabilityProfile.version}`
                  : ''
              }
              emptyLabel="Session / project default"
              onChange={(value) =>
                setDraft((current) => ({
                  ...current,
                  capabilityProfile: profileRef(state, value) ?? undefined,
                }))
              }
            />
          </label>
          <label>
            Name
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            Run input schema
            <textarea
              aria-label="Run input schema"
              value={runInputSchemaText}
              rows={5}
              onChange={(event) => {
                setRunInputSchemaText(event.target.value);
                const result = parseRunInputSchemaEdit(event.target.value);
                if ('error' in result) { setRunInputSchemaError(result.error); return; }
                setRunInputSchemaError(null);
                setDraft((current) => ({ ...current, runInputSchema: result.value as WorkflowJsonSchema }));
              }}
            />
            {runInputSchemaError && <span className="workflow-validation-error" role="alert">{runInputSchemaError}</span>}
          </label>
          <label>
            Entry
            <select
              value={draft.entryNode ?? ''}
              onChange={(event) =>
                setDraft((current) => ({ ...current, entryNode: event.target.value }))
              }
            >
              <option value="">Choose entry</option>
              {draft.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name || 'Untitled'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Revisions
            <input
              type="number"
              min="0"
              max="20"
              value={draft.maxRevisions}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxRevisions: Number(event.target.value) }))
              }
            />
          </label>
          <label className="default-check">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(event) => {
                setMakeDefault(event.target.checked);
                setPublishPending(true);
              }}
            />
            Use as default
          </label>
        </div>
      )}
      {view === 'stages' ? (
        <>
          <div className={`workflow-stage-shell ${selected ? 'has-inspector' : ''}`}>
            <WorkflowStages
              workflow={draft}
              selectedId={selectedId}
              reordering={reordering}
              onSelect={(id) => {
                setSelectedId(id);
                setSelectedEdgeId(null);
              }}
              onInsert={insertStage}
              onReorder={reorderStages}
            />
            {selected && (
              <NodeInspector
                key={selected.id}
                node={selected}
                workflow={draft}
                state={state}
                boards={state.boards}
                onPatch={patchNode}
                onPatchHumanTask={patchHumanTask}
                onPatchInput={patchInput}
                activityJsonDrafts={activityJsonDrafts}
                activityJsonErrors={activityJsonErrors}
                onActivityJsonEdit={recordActivityJsonEdit}
                onClearActivityJsonEdit={clearActivityJsonEdit}
                onConnect={beginConnection}
                onDelete={removeNode}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        </>
      ) : (
        <>
          <div
            className={`workflow-canvas-shell ${selected || selectedEdge ? 'has-inspector' : ''}`}
          >
            <select
              className="mobile-node-picker"
              aria-label={connecting ? 'Connect to node' : 'Inspect graph node'}
              value={selectedId ?? ''}
              onChange={(event) => {
                if (connecting) {
                  connect(event.target.value);
                  return;
                }
                const node = draft.nodes.find((item) => item.id === event.target.value);
                setSelectedId(node?.id ?? null);
                setSelectedEdgeId(null);
                setConnecting(null);
                if (node) {
                  setZoom(0.85);
                  setPan({ x: 24 - node.x * 0.85, y: 120 - node.y * 0.85 });
                }
              }}
            >
              <option value="">Inspect node…</option>
              {draft.nodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
            <div className={`node-palette ${paletteOpen ? 'open' : 'closed'}`}>
              <button
                className="palette-toggle"
                aria-expanded={paletteOpen}
                onClick={() => setPaletteOpen((value) => !value)}
              >
                <Plus size={16} />
                <span>Add</span>
                <ChevronDown size={13} />
              </button>
              {paletteOpen &&
                (Object.keys(kindLabels) as NodeKind[]).map((type) => {
                  const Icon = kindIcon[type];
                  return (
                    <button
                      className="palette-node"
                      key={type}
                      title={`Add ${kindLabels[type]}`}
                      onClick={() => addNode(type)}
                    >
                      <Icon size={16} />
                      <span>{kindLabels[type]}</span>
                    </button>
                  );
                })}
            </div>
            <WorkflowCanvas
              graph={draft}
              selectedId={selectedId}
              selectedEdgeId={selectedEdgeId}
              connecting={connecting}
              zoom={zoom}
              pan={pan}
              fitRequest={fitRequest}
              onZoom={(value) => setZoom(Math.max(0.05, Math.min(1.75, value)))}
              onPan={setPan}
              onNode={(id) =>
                connecting ? connect(id) : (setSelectedId(id), setSelectedEdgeId(null))
              }
              onEdge={(id) => {
                setSelectedEdgeId(id);
                setSelectedId(null);
              }}
              onBeginConnection={beginConnection}
              onMoveNode={(id, x, y) => patchNode(id, { x, y })}
            />
            {(selected || selectedEdge) && (
              <button
                className="inspector-backdrop"
                aria-label="Close inspector overlay"
                onClick={() => {
                  setSelectedId(null);
                  setSelectedEdgeId(null);
                }}
              />
            )}
            {selected && (
              <NodeInspector
                key={selected.id}
                node={selected}
                workflow={draft}
                state={state}
                boards={state.boards}
                onPatch={patchNode}
                onPatchHumanTask={patchHumanTask}
                onPatchInput={patchInput}
                activityJsonDrafts={activityJsonDrafts}
                activityJsonErrors={activityJsonErrors}
                onActivityJsonEdit={recordActivityJsonEdit}
                onClearActivityJsonEdit={clearActivityJsonEdit}
                onConnect={beginConnection}
                onDelete={removeNode}
                onClose={() => setSelectedId(null)}
              />
            )}
            {selectedEdge && (
              <EdgeInspector
                key={selectedEdge.id}
                edge={selectedEdge}
                graph={draft}
                onPatch={updateEdge}
                onDelete={removeEdge}
                onClose={() => setSelectedEdgeId(null)}
              />
            )}
          </div>
        </>
      )}
      {message && (
        <p
          className={`workflow-message ${messageError ? 'is-error' : ''}`}
          role={messageError ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
      <Automations state={state} />
    </section>
  );
}

function InspectorPanel({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const change = () => setMobile(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [mobile]);
  return (
    <aside
      ref={panel}
      className="node-inspector"
      role={mobile ? 'dialog' : undefined}
      aria-modal={mobile || undefined}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
        if (!mobile || event.key !== 'Tab') return;
        const items = [
          ...(panel.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]',
          ) ?? []),
        ].filter((item) => item.getClientRects().length);
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {children}
    </aside>
  );
}

function NodeInspector({
  node,
  workflow,
  state,
  boards,
  onPatch,
  onPatchHumanTask,
  onPatchInput,
  activityJsonDrafts,
  activityJsonErrors,
  onActivityJsonEdit,
  onClearActivityJsonEdit,
  onConnect,
  onDelete,
  onClose,
}: {
  node: GraphNode;
  workflow: GraphWorkflow;
  state: RuntimeState;
  boards: BoardSummary[];
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
  onPatchHumanTask: (id: string, task: WorkflowStep['humanTask'], rename?: { from: string; to: string }) => void;
  onPatchInput: (id: string, key: string, value: string) => void;
  activityJsonDrafts: Record<string, string>;
  activityJsonErrors: Record<string, string>;
  onActivityJsonEdit: (key: string, text: string, error?: string) => void;
  onClearActivityJsonEdit: (key: string) => void;
  onConnect: (id: string, outcome?: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const headings = node.artifact?.headings.join('\n') ?? '';
  const humanTask = node.humanTask ?? {
    outcomes: [
      { id: 'approved', label: node.decisionLabels?.approved ?? 'Approve', effect: 'approve_activity' as const },
      { id: 'changes_requested', label: node.decisionLabels?.changes_requested ?? 'Request changes' },
    ],
  };
  const patchTask = (next: NonNullable<WorkflowStep['humanTask']>, rename?: { from: string; to: string }) =>
    onPatchHumanTask(node.id, next, rename);
  const patchArtifact = (path: string, nextHeadings: string) =>
    onPatch(node.id, {
      artifact: path || nextHeadings ? { path, headings: nextHeadings.split('\n') } : undefined,
    });
  const patchPresentationBindings = (bindings: PresentationBinding[]) =>
    onPatch(node.id, { presentationBindings: bindings.length ? bindings : undefined });
  const presentationBindings = node.presentationBindings ?? [];
  const declaredDetailFields = [
    ...new Set(Object.values(node.submissionRequirements ?? {}).flatMap((rule) => rule.fields)),
  ];
  const usedDetailFields = new Set(
    presentationBindings
      .filter((binding) => binding.source === 'detail')
      .map((binding) => binding.field),
  );
  const availableDetailFields = declaredDetailFields.filter(
    (field) => !usedDetailFields.has(field),
  );
  const addPresentationBinding = () => {
    if (presentationBindings.length >= 12) return;
    if (!presentationBindings.some((binding) => binding.source === 'summary'))
      patchPresentationBindings([...presentationBindings, { source: 'summary' }]);
    else if (availableDetailFields.length)
      patchPresentationBindings([
        ...presentationBindings,
        { source: 'detail', field: availableDetailFields[0] },
      ]);
    else if (!presentationBindings.some((binding) => binding.source === 'artifact'))
      patchPresentationBindings([...presentationBindings, { source: 'artifact' }]);
  };
  return (
    <InspectorPanel label="Node inspector" onClose={onClose}>
      <div className="inspector-heading">
        <div>
          <span className="inspector-kicker">Node</span>
          <strong>{kindLabels[node.type]}</strong>
        </div>
        <button className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <label>
        Title
        <input
          value={node.name}
          onChange={(event) => onPatch(node.id, { name: event.target.value })}
        />
      </label>
      {['agent', 'approval', 'check'].includes(node.type) && (
        <label>
          {node.type === 'agent' ? 'Agent instructions' : 'Instructions'}
          <textarea
            rows={5}
            value={node.prompt}
            onChange={(event) => onPatch(node.id, { prompt: event.target.value })}
          />
        </label>
      )}
      {node.type === 'agent' && (
        <details className="agent-settings">
          <summary>Agent settings</summary>
          <label>
            Model
            <select
              value={node.model ?? ''}
              onChange={(event) => onPatch(node.id, { model: event.target.value || undefined })}
            >
              <option value="">Session default</option>
              {state.models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            Session
            <select
              value={node.session?.mode ?? 'continue'}
              onChange={(event) =>
                onPatch(node.id, {
                  session: { ...(node.session ?? {}), mode: event.target.value as SessionMode },
                })
              }
            >
              <option value="continue">Continue current</option>
              <option value="new">Start named session</option>
              <option value="reuse">Reuse named session</option>
            </select>
          </label>
          {node.session?.mode === 'new' && (
            <label>
              New session name
              <input
                value={node.session.name ?? ''}
                onChange={(event) =>
                  onPatch(node.id, {
                    session: {
                      ...(node.session ?? { mode: 'new' }),
                      mode: 'new',
                      name: event.target.value,
                    },
                  })
                }
              />
            </label>
          )}
          {node.session?.mode === 'reuse' && (
            <label>
              Reuse session name
              <input
                value={node.session.target ?? ''}
                onChange={(event) =>
                  onPatch(node.id, {
                    session: {
                      ...(node.session ?? { mode: 'reuse' }),
                      mode: 'reuse',
                      target: event.target.value,
                    },
                  })
                }
              />
            </label>
          )}
          <label>
            Tool permissions
            <select
              value={node.permissions ?? 'read-write'}
              onChange={(event) => onPatch(node.id, { permissions: event.target.value })}
            >
              <option value="none">None</option>
              <option value="read">Read only</option>
              <option value="read-write">Read and write</option>
              <option value="full">Read, write and shell</option>
            </select>
          </label>
          <label>
            Reasoning effort
            <select
              value={node.reasoningEffort ?? ''}
              onChange={(event) =>
                onPatch(node.id, {
                  reasoningEffort: (event.target.value ||
                    undefined) as GraphNode['reasoningEffort'],
                })
              }
            >
              <option value="">Provider default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label>
            Reserved finalization rounds
            <input
              type="number"
              min="0"
              max={Math.max(0, (node.maxRounds ?? 12) - 1)}
              value={node.finalizationRounds ?? 0}
              onChange={(event) =>
                onPatch(node.id, { finalizationRounds: Number(event.target.value) })
              }
            />
          </label>
          <details>
            <summary>Outcome submission requirements</summary>
            {Object.entries(node.submissionRequirements ?? {}).map(([outcome, rule]) => (
              <div key={outcome}>
                <strong>{outcome}</strong>
                <label>
                  Required fields
                  <input
                    value={rule.fields.join(', ')}
                    onBlur={(event) =>
                      onPatch(node.id, {
                        submissionRequirements: {
                          ...node.submissionRequirements,
                          [outcome]: {
                            ...rule,
                            fields: event.target.value
                              .split(',')
                              .map((v) => v.trim())
                              .filter(Boolean),
                          },
                        },
                      })
                    }
                    onChange={(event) =>
                      onPatch(node.id, {
                        submissionRequirements: {
                          ...node.submissionRequirements,
                          [outcome]: {
                            ...rule,
                            fields: event.target.value.split(',').map((v) => v.trim()),
                          },
                        },
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={rule.requireInvestigationAssessment ?? false}
                    onChange={(event) =>
                      onPatch(node.id, {
                        submissionRequirements: {
                          ...node.submissionRequirements,
                          [outcome]: {
                            ...rule,
                            requireInvestigationAssessment: event.target.checked,
                            ...(!event.target.checked ? { requireClaimEvidence: false } : {}),
                          },
                        },
                      })
                    }
                  />
                  Block unresolved material internal questions
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={rule.requireClaimEvidence ?? false}
                    onChange={(event) =>
                      onPatch(node.id, {
                        submissionRequirements: {
                          ...node.submissionRequirements,
                          [outcome]: {
                            ...rule,
                            requireClaimEvidence: event.target.checked,
                            ...(event.target.checked
                              ? { requireInvestigationAssessment: true }
                              : {}),
                          },
                        },
                      })
                    }
                  />
                  Require evidence and limits for resolved claims
                </label>
                <label>
                  Minimum source references
                  <input
                    type="number"
                    min="0"
                    max="8"
                    value={rule.minReferences}
                    onChange={(event) =>
                      onPatch(node.id, {
                        submissionRequirements: {
                          ...node.submissionRequirements,
                          [outcome]: { ...rule, minReferences: Number(event.target.value) },
                        },
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...node.submissionRequirements };
                    delete next[outcome];
                    onPatch(node.id, {
                      submissionRequirements: Object.keys(next).length ? next : undefined,
                    });
                  }}
                >
                  Remove {outcome}
                </button>
              </div>
            ))}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const outcome = String(new FormData(form).get('outcome') ?? '').trim();
                if (outcome && !Object.hasOwn(node.submissionRequirements ?? {}, outcome)) {
                  onPatch(node.id, {
                    submissionRequirements: {
                      ...node.submissionRequirements,
                      [outcome]: { fields: [], minReferences: 0 },
                    },
                  });
                  form.reset();
                }
              }}
            >
              <label>
                Outcome
                <input name="outcome" pattern="[a-zA-Z][a-zA-Z0-9_-]{0,63}" required />
              </label>
              <button type="submit">Add requirements</button>
            </form>
          </details>
          <label>
            Required summary headings
            <input
              value={(node.summaryHeadings ?? []).join(', ')}
              onChange={(event) =>
                onPatch(node.id, {
                  summaryHeadings: event.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <div className="inspector-two">
            <label>
              Max rounds
              <input
                type="number"
                min="1"
                max="100"
                value={node.maxRounds ?? 12}
                onChange={(event) => onPatch(node.id, { maxRounds: Number(event.target.value) })}
              />
            </label>
            <label>
              Advance
              <select
                value={node.advance ?? 'automatic'}
                onChange={(event) =>
                  onPatch(node.id, { advance: event.target.value as 'automatic' | 'manual' })
                }
              >
                <option value="automatic">Automatic</option>
                <option value="manual">Manual</option>
              </select>
            </label>
          </div>
          <label>
            Skills <span className="field-hint">names, comma separated</span>
            <input
              value={(node.skills ?? []).join(', ')}
              onChange={(event) =>
                onPatch(node.id, {
                  skills: event.target.value
                    .split(',')
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </details>
      )}
      {node.type !== 'agent' && node.type !== 'branch' && (
        <label>
          Advance
          <select
            value={node.advance ?? 'automatic'}
            onChange={(event) =>
              onPatch(node.id, { advance: event.target.value as 'automatic' | 'manual' })
            }
          >
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </select>
        </label>
      )}
      {node.type === 'approval' && (
        <details open={Boolean(node.humanTask)}>
          <summary>Human task</summary>
          {humanTask.outcomes.map((outcome, index) => (
            <fieldset key={`${outcome.id}-${index}`}>
              <label>
                Outcome ID
                <input value={outcome.id} maxLength={80} onChange={(event) => {
                  const id = event.target.value;
                  const outcomes = humanTask.outcomes.map((item, itemIndex) => itemIndex === index ? { ...item, id } : item);
                  patchTask({ ...humanTask, outcomes }, { from: outcome.id, to: id });
                }} />
              </label>
              <label>
                Label
                <input value={outcome.label} maxLength={80} onChange={(event) => {
                  const outcomes = humanTask.outcomes.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item);
                  patchTask({ ...humanTask, outcomes });
                }} />
              </label>
              <label>
                Effect
                <select value={outcome.effect ?? ''} onChange={(event) => {
                  const outcomes = humanTask.outcomes.map((item, itemIndex) => itemIndex === index
                    ? { ...item, ...(event.target.value ? { effect: 'approve_activity' as const } : { effect: undefined }) } : item);
                  patchTask({ ...humanTask, outcomes });
                }}>
                  <option value="">No effect authority</option>
                  <option value="approve_activity">Authorize prepared activity</option>
                </select>
              </label>
              {humanTask.outcomes.length > 2 && <button type="button" className="secondary" onClick={() => patchTask({ ...humanTask, outcomes: humanTask.outcomes.filter((_, itemIndex) => itemIndex !== index) })}>Remove outcome</button>}
            </fieldset>
          ))}
          <button type="button" className="secondary" disabled={humanTask.outcomes.length >= 8} onClick={() => patchTask({ ...humanTask, outcomes: [...humanTask.outcomes, { id: `outcome-${humanTask.outcomes.length + 1}`, label: 'New outcome' }] })}>Add outcome</button>
          <details>
            <summary>Response fields</summary>
            {(humanTask.form?.fields ?? []).map((field, index) => (
              <fieldset key={`${field.id}-${index}`}>
                <label>Field ID<input value={field.id} maxLength={80} onChange={(event) => {
                  const fields = [...(humanTask.form?.fields ?? [])]; fields[index] = { ...field, id: event.target.value };
                  patchTask({ ...humanTask, form: { fields } });
                }} /></label>
                <label>Label<input value={field.label} maxLength={100} onChange={(event) => {
                  const fields = [...(humanTask.form?.fields ?? [])]; fields[index] = { ...field, label: event.target.value };
                  patchTask({ ...humanTask, form: { fields } });
                }} /></label>
                <label>Type<select value={field.type} onChange={(event) => {
                  const fields = [...(humanTask.form?.fields ?? [])]; fields[index] = { id: field.id, label: field.label, type: event.target.value as typeof field.type, ...(field.required ? { required: true } : {}) };
                  patchTask({ ...humanTask, form: { fields } });
                }}>
                  <option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="choice">Choice</option><option value="date">Date</option>
                </select></label>
                <label>Required<input type="checkbox" checked={Boolean(field.required)} onChange={(event) => {
                  const fields = [...(humanTask.form?.fields ?? [])]; fields[index] = { ...field, required: event.target.checked || undefined };
                  patchTask({ ...humanTask, form: { fields } });
                }} /></label>
                {field.type === 'choice' && <label>Options<input value={(field.options ?? []).map((option) => `${option.value}:${option.label}`).join(', ')} onChange={(event) => {
                  const options = event.target.value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => { const [value, ...label] = item.split(':'); return { value, label: label.join(':') || value }; });
                  const fields = [...(humanTask.form?.fields ?? [])]; fields[index] = { ...field, options };
                  patchTask({ ...humanTask, form: { fields } });
                }} /></label>}
                <button type="button" className="secondary" onClick={() => patchTask({ ...humanTask, form: { fields: humanTask.form?.fields.filter((_, itemIndex) => itemIndex !== index) ?? [] } })}>Remove field</button>
              </fieldset>
            ))}
            <button type="button" className="secondary" disabled={(humanTask.form?.fields.length ?? 0) >= 32} onClick={() => patchTask({ ...humanTask, form: { fields: [...(humanTask.form?.fields ?? []), { id: `field-${(humanTask.form?.fields.length ?? 0) + 1}`, label: 'New field', type: 'text' }] } })}>Add field</button>
          </details>
          <label>Reviewer permission<select value={humanTask.reviewerPolicy?.permission ?? ''} onChange={(event) => patchTask({ ...humanTask, reviewerPolicy: { ...(humanTask.reviewerPolicy?.userIds ? { userIds: humanTask.reviewerPolicy.userIds } : {}), ...(event.target.value ? { permission: event.target.value as 'project.execute' | 'project.write' } : {}) } })}>
            <option value="">Default project execution permission</option><option value="project.execute">Project execution</option><option value="project.write">Project write</option>
          </select></label>
          <label>Reviewer user IDs<input value={(humanTask.reviewerPolicy?.userIds ?? []).join(', ')} onChange={(event) => {
            const userIds = event.target.value.split(',').map((value) => value.trim()).filter(Boolean);
            patchTask({ ...humanTask, reviewerPolicy: { ...(humanTask.reviewerPolicy?.permission ? { permission: humanTask.reviewerPolicy.permission } : {}), ...(userIds.length ? { userIds } : {}) } });
          }} /></label>
          <label>Deadline (minutes)<input type="number" min={1} max={525600} value={humanTask.dueAfterSeconds ? humanTask.dueAfterSeconds / 60 : ''} onChange={(event) => patchTask({ ...humanTask, dueAfterSeconds: event.target.value ? Number(event.target.value) * 60 : undefined })} /></label>
        </details>
      )}
      {(node.type === 'agent' || node.type === 'check' || node.type === 'approval') && (
        <details open={!!node.artifact}>
          <summary>Required document</summary>
          <label>
            Relative path
            <input
              value={node.artifact?.path ?? ''}
              placeholder="docs/brief.md"
              onChange={(event) => patchArtifact(event.target.value, headings)}
            />
          </label>
          <label>
            Required headings
            <textarea
              rows={3}
              value={headings}
              placeholder="Context\nAcceptance criteria\nVerification"
              onChange={(event) => patchArtifact(node.artifact?.path ?? '', event.target.value)}
            />
          </label>
        </details>
      )}
      {node.type === 'agent' && (
        <details open={presentationBindings.length > 0}>
          <summary>Material presentation</summary>
          {presentationBindings.map((binding, index) => (
            <div className="workflow-presentation-binding" key={`${binding.source}-${index}`}>
              <label>
                Material
                <select
                  value={binding.source}
                  onChange={(event) => {
                    const source = event.target.value as PresentationBinding['source'];
                    patchPresentationBindings(
                      presentationBindings.map((item, itemIndex) =>
                        itemIndex === index
                          ? {
                              ...item,
                              source,
                              ...(source === 'detail'
                                ? { field: availableDetailFields[0] ?? '' }
                                : { field: undefined }),
                            }
                          : item,
                      ),
                    );
                  }}
                >
                  <option
                    value="summary"
                    disabled={presentationBindings.some(
                      (item, itemIndex) => itemIndex !== index && item.source === 'summary',
                    )}
                  >
                    Summary
                  </option>
                  <option
                    value="detail"
                    disabled={binding.source !== 'detail' && availableDetailFields.length === 0}
                  >
                    Detail field
                  </option>
                  <option
                    value="artifact"
                    disabled={presentationBindings.some(
                      (item, itemIndex) => itemIndex !== index && item.source === 'artifact',
                    )}
                  >
                    Captured artifacts
                  </option>
                </select>
              </label>
              {binding.source === 'detail' && (
                <label>
                  Declared field
                  <select
                    value={binding.field ?? ''}
                    aria-label="Declared detail field"
                    onChange={(event) =>
                      patchPresentationBindings(
                        presentationBindings.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, field: event.target.value } : item,
                        ),
                      )
                    }
                  >
                    <option value="">Choose a field</option>
                    {declaredDetailFields
                      .filter((field) => !usedDetailFields.has(field) || field === binding.field)
                      .map((field) => (
                        <option key={field} value={field}>
                          {field}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                Display label <span className="field-hint">optional</span>
                <input
                  value={binding.label ?? ''}
                  maxLength={80}
                  placeholder={binding.source === 'summary' ? 'Summary' : 'Result'}
                  onChange={(event) =>
                    patchPresentationBindings(
                      presentationBindings.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <label className="workflow-primary-binding">
                <input
                  type="checkbox"
                  checked={Boolean(binding.primary)}
                  onChange={(event) =>
                    patchPresentationBindings(
                      presentationBindings.map((item, itemIndex) => ({
                        ...item,
                        primary:
                          itemIndex === index ? event.target.checked || undefined : undefined,
                      })),
                    )
                  }
                />
                Primary material
              </label>
              <button
                type="button"
                className="icon-button"
                aria-label="Remove material binding"
                onClick={() =>
                  patchPresentationBindings(
                    presentationBindings.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={!canAddPresentationBinding(presentationBindings, availableDetailFields)}
            onClick={addPresentationBinding}
          >
            <Plus size={14} /> Add material binding
          </button>
        </details>
      )}
      {node.type === 'check' && (
        <label>
          Exact check command
          <input
            value={node.checkCommand ?? ''}
            placeholder="npm test"
            onChange={(event) =>
              onPatch(node.id, { checkCommand: event.target.value, requiresCheck: true })
            }
          />
        </label>
      )}
      {node.type === 'branch' && <BranchFields node={node} onPatch={onPatch} />}{' '}
      {node.type === 'wait' && (
        <details open>
          <summary>Event to resume this workflow</summary>
          <label>
            Event
            <select
              value={node.waitFor?.event ?? 'ticket_message_received'}
              onChange={(event) => {
                const selectedEvent = event.target.value;
                const waitFor: NonNullable<GraphNode['waitFor']> = {
                  ...node.waitFor,
                  event: selectedEvent,
                };
                if (legacyTicketWaitEvents.has(selectedEvent))
                  waitFor.ticketSource = node.waitFor?.ticketSource ?? 'active_ticket';
                else if (legacyTicketWaitEvents.has(node.waitFor?.event ?? '')) {
                  delete waitFor.ticketSource;
                  delete waitFor.relationKind;
                  delete waitFor.status;
                }
                onPatch(node.id, { waitFor });
              }}
            >
              {node.waitFor?.event && !legacyTicketWaitEvents.has(node.waitFor.event) && (
                <option value={node.waitFor.event}>{node.waitFor.event}</option>
              )}
              <option value="ticket_message_received">Source message received</option>
              <option value="ticket_source_updated">Imported ticket updated</option>
              <option value="ticket_updated">Local ticket updated</option>
            </select>
          </label>
          {legacyTicketWaitEvents.has(node.waitFor?.event ?? 'ticket_message_received') && (
            <>
              <label>
                Ticket
                <select
                  value={node.waitFor?.ticketSource ?? 'active_ticket'}
                  onChange={(event) => onPatch(node.id, {
                    waitFor: { ...node.waitFor!, ticketSource: event.target.value as 'active_ticket' | 'related_ticket' },
                  })}
                >
                  <option value="active_ticket">Active ticket</option>
                  <option value="related_ticket">Related ticket</option>
                </select>
              </label>
              {node.waitFor?.ticketSource === 'related_ticket' && (
                <label>
                  Relation kind (optional)
                  <input
                    value={node.waitFor.relationKind ?? ''}
                    onChange={(event) =>
                      onPatch(node.id, {
                        waitFor: { ...node.waitFor!, relationKind: event.target.value || undefined },
                      })
                    }
                  />
                </label>
              )}
              <label>
                Required status (optional)
                <input
                  value={node.waitFor?.status ?? ''}
                  onChange={(event) => onPatch(node.id, {
                    waitFor: { ...node.waitFor!, status: event.target.value || undefined },
                  })}
                />
              </label>
            </>
          )}
        </details>
      )}
      {node.type === 'action' && (
        <ActionFields
          node={node}
          workflow={workflow}
          activities={state.workflowActivities ?? []}
          models={state.models}
          activityJsonDrafts={activityJsonDrafts}
          activityJsonErrors={activityJsonErrors}
          onActivityJsonEdit={onActivityJsonEdit}
          onClearActivityJsonEdit={onClearActivityJsonEdit}
          boards={boards}
          projects={state.projects}
          onPatch={onPatch}
          onPatchInput={onPatchInput}
        />
      )}
      <div className="inspector-actions">
        <select
          aria-label="Outcome to connect"
          defaultValue=""
          onChange={(event) => event.target.value && onConnect(node.id, event.target.value)}
        >
          <option value="">Connect…</option>
          {outcomesFor(node).map((outcome) => (
            <option key={outcome} value={outcome}>
              {outcome}
            </option>
          ))}
        </select>
        <button
          className="icon-button danger"
          aria-label="Delete node"
          onClick={() => onDelete(node.id)}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </InspectorPanel>
  );
}

function ActionFields({
  node,
  workflow,
  activities,
  models,
  activityJsonDrafts,
  activityJsonErrors,
  onActivityJsonEdit,
  onClearActivityJsonEdit,
  boards,
  projects,
  onPatch,
  onPatchInput,
}: {
  node: GraphNode;
  workflow: GraphWorkflow;
  activities: NonNullable<RuntimeState['workflowActivities']>;
  models: RuntimeState['models'];
  activityJsonDrafts: Record<string, string>;
  activityJsonErrors: Record<string, string>;
  onActivityJsonEdit: (key: string, text: string, error?: string) => void;
  onClearActivityJsonEdit: (key: string) => void;
  boards: BoardSummary[];
  projects: RuntimeState['projects'];
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
  onPatchInput: (id: string, key: string, value: string) => void;
}) {
  const operation = node.operation;
  const activity = activities.find((descriptor) => descriptor.ref.id === node.activity?.id && descriptor.ref.revision === node.activity?.revision);
  const activityPinStale = activityPinIsStale(node.activityDescriptorDigest, activity?.digest);
  const permissionEditor = !activityPinStale ? activityPermissionEditor(activity, node.permissions) : null;
  const setActivity = (key: string) => {
    const selected = activities.find((descriptor) => `${descriptor.ref.id}@${descriptor.ref.revision}` === key);
    if (!selected) { onPatch(node.id, { activity: undefined, activityDescriptorDigest: undefined, bindings: undefined, operation: undefined, input: undefined }); return; }
    if (!changedActivityPin(node.activity, selected.ref)) return;
    const bindings: Record<string, WorkflowActivityBinding> = {};
    for (const key of selected.inputSchema.required ?? []) {
      const schema = selected.inputSchema.properties?.[key];
      bindings[key] = { literal: schema?.type === 'string' ? '' : schema?.type === 'boolean' ? false : schema?.type === 'array' ? [] : schema?.type === 'object' ? {} : schema?.type === 'null' ? null : 0 };
    }
    onPatch(node.id, { activity: selected.ref, activityDescriptorDigest: undefined, bindings, operation: undefined, input: undefined });
  };
  if (!operation || node.activity) return (
    <details open>
      <summary>Activity</summary>
      <label>
        Registered activity
        <select value={node.activity ? `${node.activity.id}@${node.activity.revision}` : ''} onChange={(event) => setActivity(event.target.value)}>
          <option value="">Choose activity</option>
          {node.activity && !activity && <option value={`${node.activity.id}@${node.activity.revision}`} disabled>{node.activity.id}@{node.activity.revision} · unavailable</option>}
          {activities.map((descriptor) => {
            const selectedPinStale = descriptor.ref.id === node.activity?.id && descriptor.ref.revision === node.activity?.revision && activityPinIsStale(node.activityDescriptorDigest, descriptor.digest);
            return <option key={`${descriptor.ref.id}@${descriptor.ref.revision}`} value={`${descriptor.ref.id}@${descriptor.ref.revision}`} disabled={!descriptor.available || selectedPinStale}>
              {descriptor.presentation.label} · {descriptor.ref.id}@{descriptor.ref.revision}{selectedPinStale ? ' · pinned metadata changed' : descriptor.available ? '' : ' · unavailable'}
            </option>;
          })}
        </select>
      </label>
      {activityPinStale && <p role="status">Pinned activity metadata changed. Select another revision before publishing.</p>}
      {activity && !activityPinStale && activity.resources.location === 'agent' && <label>
        Model
        <select value={node.model ?? ''} onChange={event => onPatch(node.id, { model: event.target.value || undefined })}>
          <option value="">Session default</option>
          {node.model && !models.some(model => model.id === node.model) && <option value={node.model} disabled>{node.model} · unavailable</option>}
          {models.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}
        </select>
      </label>}
      {permissionEditor && <label>
        Tool permissions
        <select value={permissionEditor.value} onChange={event => onPatch(node.id, { permissions: event.target.value })}>
          {permissionEditor.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
        </select>
      </label>}
      {activity && !activityPinStale && <RegisteredActivityFields node={node} workflow={workflow} descriptor={activity} activities={activities}
        activityJsonDrafts={activityJsonDrafts} activityJsonErrors={activityJsonErrors}
        onActivityJsonEdit={onActivityJsonEdit} onClearActivityJsonEdit={onClearActivityJsonEdit} onPatch={onPatch} />}
      {node.activity && !activity && <p role="status">Pinned activity {node.activity.id}@{node.activity.revision} is unavailable.</p>}
    </details>
  );
  const input = node.input ?? {};
  const patch =
    input.patch && typeof input.patch === 'object' ? (input.patch as Record<string, unknown>) : {};
  const setOperation = (next: ActionOperation) =>
    onPatch(node.id, {
      operation: next,
      input: actionInputDefaults(next),
    });
  const projectField = (
    <label>
      Project
      <select
        value={displayValue(input.projectId)}
        onChange={(event) => onPatchInput(node.id, 'projectId', event.target.value)}
      >
        <option value="">Choose project</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
  const field = (key: string, label: string, placeholder = '') => {
    const value = operation === 'update_ticket' ? patch[key] : input[key];
    return (
      <label>
        {label}
        <input
          value={displayValue(value)}
          placeholder={placeholder}
          onChange={(event) =>
            operation === 'update_ticket'
              ? onPatch(node.id, {
                  input: { ...input, patch: { ...patch, [key]: event.target.value } },
                })
              : onPatchInput(node.id, key, event.target.value)
          }
        />
      </label>
    );
  };
  const board = boards.find((item) => item.id === input.boardId);
  return (
    <details open>
      <summary>Action</summary>
      <label>
        Operation
        <select
          value={operation}
          onChange={(event) => setOperation(event.target.value as ActionOperation)}
        >
          {![
            'inspect_changes',
            'create_ticket',
            'create_related_ticket',
            'update_ticket',
            'move_ticket',
            'set_external_status',
            'send_external_reply',
          ].includes(operation) && <option value={operation}>Unsupported: {operation}</option>}
          <option value="inspect_changes">Inspect changes</option>
          <option value="create_ticket">Create ticket</option>
          <option value="create_related_ticket">Create related ticket</option>
          <option value="update_ticket">Update ticket</option>
          <option value="move_ticket">Move ticket</option>
          <option value="send_external_reply">Send approved external reply</option>
          <option value="set_external_status">Set external status</option>
        </select>
      </label>
      {operation === 'create_ticket' && (
        <>
          {projectField}
          {field('title', 'Title', 'Follow-up work')}
          {field('description', 'Description')}
          {field('status', 'Status', 'Backlog')}
          {field('label', 'Label')}
          {field('agent', 'Agent', 'Unassigned')}
          {field('priority', 'Priority', 'Medium')}
        </>
      )}
      {operation === 'create_related_ticket' && (
        <>
          {field('title', 'Title')}
          {field('description', 'Description')}
          {field('kind', 'Relation kind', 'related')}
          <label>
            Board (optional)
            <select
              value={displayValue(input.boardId)}
              onChange={(event) => onPatchInput(node.id, 'boardId', event.target.value)}
            >
              <option value="">Project default</option>
              {boards.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {field('status', 'Status (optional)')}
        </>
      )}
      {operation === 'send_external_reply' && (
        <>
          {field('connectionId', 'Connection')}
          {field('sourceNodeId', 'Draft step')}
          {field('field', 'Submitted draft field')}
        </>
      )}
      {operation === 'set_external_status' && (
        <>
          {field('connectionId', 'Connection')}
          {field('status', 'Source status')}
          {field('evidenceReply', 'Reply evidence')}
        </>
      )}
      {operation === 'update_ticket' && (
        <>
          <label>
            Ticket selector
            <select
              value={displayValue(input.ticketSource ?? 'active_ticket')}
              onChange={(event) => onPatchInput(node.id, 'ticketSource', event.target.value)}
            >
              <option value="active_ticket">Active ticket</option>
              <option value="last_created">Last created ticket</option>
            </select>
          </label>
          {field('status', 'Status (optional)')}
          {field('title', 'Title (optional)')}
          {field('description', 'Description (optional)')}
          {field('label', 'Label (optional)')}
          {field('priority', 'Priority (optional)')}
        </>
      )}
      {operation === 'move_ticket' && (
        <>
          <label>
            Ticket selector
            <select
              value={displayValue(input.ticketSource ?? 'active_ticket')}
              onChange={(event) => onPatchInput(node.id, 'ticketSource', event.target.value)}
            >
              <option value="active_ticket">Active ticket</option>
              <option value="last_created">Last created ticket</option>
            </select>
          </label>
          <label>
            Board
            <select
              value={displayValue(input.boardId)}
              onChange={(event) => onPatchInput(node.id, 'boardId', event.target.value)}
            >
              <option value="">Choose board</option>
              {boards.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Column
            <select
              value={displayValue((input.placement as { columnId?: string } | undefined)?.columnId)}
              onChange={(event) =>
                onPatch(node.id, {
                  input: { ...input, placement: { columnId: event.target.value } },
                })
              }
            >
              <option value="">Choose column</option>
              {(board?.columns ?? []).map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          {field('swimlaneKey', 'Swimlane (optional)')}
        </>
      )}
    </details>
  );
}

function RegisteredActivityFields({
  node,
  workflow,
  descriptor,
  activities,
  activityJsonDrafts,
  activityJsonErrors,
  onActivityJsonEdit,
  onClearActivityJsonEdit,
  onPatch,
}: {
  node: GraphNode;
  workflow: GraphWorkflow;
  descriptor: WorkflowActivityDescriptor;
  activities: NonNullable<RuntimeState['workflowActivities']>;
  activityJsonDrafts: Record<string, string>;
  activityJsonErrors: Record<string, string>;
  onActivityJsonEdit: (key: string, text: string, error?: string) => void;
  onClearActivityJsonEdit: (key: string) => void;
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
}) {
  const bindings = node.bindings ?? {};
  const priorNodes = workflow.nodes.filter(candidate => {
    if (candidate.id === node.id) return false;
    const reachable = new Set([candidate.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of workflow.edges) if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; }
    }
    return reachable.has(node.id);
  });
  const sources: { key: string; label: string; binding: WorkflowActivityBinding }[] = [];
  for (const { path } of declaredObjectPaths(workflow.runInputSchema, 256)) {
    const binding: WorkflowActivityBinding = { from: { kind: 'run_input', path } };
    sources.push({ key: activitySourceOptionKey(binding), label: `Run input · ${activitySchemaPathLabel(path)}`, binding });
  }
  for (const sourceNode of priorNodes) {
    const ref = sourceNode.activity;
    const source = ref && activities.find(value => value.ref.id === ref.id && value.ref.revision === ref.revision);
    for (const { path } of declaredObjectPaths(source?.outputSchema, Math.max(0, 256 - sources.length))) {
      const binding: WorkflowActivityBinding = { from: { kind: 'activity_output', nodeId: sourceNode.id, path } };
      sources.push({ key: activitySourceOptionKey(binding), label: `${sourceNode.name} · ${activitySchemaPathLabel(path)}`, binding });
    }
  }
  const update = (key: string, value: WorkflowActivityBinding | undefined) => {
    const next = { ...bindings };
    if (value) next[key] = value; else delete next[key];
    onPatch(node.id, { bindings: next });
  };
  const literal = (key: string, schema: WorkflowJsonSchema, value: unknown) => {
    const set = (next: unknown) => update(key, { literal: next });
    if (schema.enum) return <select aria-label={`${key} value`} value={activityEnumOptionIndex(schema.enum, value)} onChange={event => set(activityEnumValueAt(schema.enum ?? [], event.target.value))}>
      <option value="">Choose</option>{schema.enum.map((item, index) => <option key={index} value={String(index)}>{item === null ? 'Null' : typeof item === 'object' ? JSON.stringify(item) : String(item)}</option>)}
    </select>;
    if (schema.type === 'boolean') return <select value={String(Boolean(value))} onChange={event => set(event.target.value === 'true')}><option value="true">True</option><option value="false">False</option></select>;
    if (schema.type === 'null') return <select aria-label={`${key} value`} value="null" onChange={() => set(null)}><option value="null">Null</option></select>;
    if (schema.type === 'number' || schema.type === 'integer') return <input type="number" value={typeof value === 'number' ? value : ''} min={schema.minimum} max={schema.maximum} step={schema.type === 'integer' ? 1 : 'any'} onChange={event => set(event.target.value === '' ? '' : Number(event.target.value))} />;
    if (schema.type === 'object' || schema.type === 'array') {
      const editKey = activityJsonEditKey(node.id, descriptor.ref, key);
      const text = activityJsonDrafts[editKey] ?? JSON.stringify(value ?? (schema.type === 'object' ? {} : []), null, 2);
      const error = activityJsonErrors[editKey];
      return <>
        <textarea aria-label={`${key} JSON value`} aria-invalid={Boolean(error)} aria-describedby={error ? `${editKey}-error` : undefined}
          value={text} rows={3} onChange={event => {
            const result = parseActivityJsonEdit(event.target.value, schema);
            if ('error' in result) { onActivityJsonEdit(editKey, event.target.value, result.error); return; }
            onActivityJsonEdit(editKey, event.target.value);
            set(result.value);
          }} />
        {error && <span className="workflow-validation-error" id={`${editKey}-error`} role="alert">{error}</span>}
      </>;
    }
    return <input value={typeof value === 'string' ? value : ''} maxLength={schema.maxLength} onChange={event => set(event.target.value)} />;
  };
  return <div className="workflow-activity-fields">
    {!descriptor.available && <p>This pinned activity revision is unavailable.</p>}
    {(descriptor.presentation.description || descriptor.effect || descriptor.resources.location) && <details>
      <summary>Activity details</summary>
      {descriptor.presentation.description && <p>{descriptor.presentation.description}</p>}
      <small>{descriptor.effect} · {descriptor.resources.location}</small>
    </details>}
    {Object.entries(descriptor.inputSchema.properties ?? {}).map(([key, schema]) => {
      const binding = bindings[key];
      const reference = binding && 'from' in binding ? binding.from : undefined;
      const sourceKey = activityBindingSourceKey(binding);
      const editKey = activityJsonEditKey(node.id, descriptor.ref, key);
      const sourceUnavailable = Boolean(reference && !activityBindingSourceIsAvailable(binding, sources.map(source => source.binding)));
      return <label key={key}>
        {key}{descriptor.inputSchema.required?.includes(key) ? ' · required' : ''}
        <select aria-label={`${key} binding source`} value={activityBindingSelectionValue(binding)} onChange={event => {
          onClearActivityJsonEdit(editKey);
          if (event.target.value === 'omit') update(key, undefined);
          else if (event.target.value === 'literal') update(key, { literal: schema.type === 'string' ? '' : schema.type === 'boolean' ? false : schema.type === 'array' ? [] : schema.type === 'object' ? {} : schema.type === 'null' ? null : 0 });
          else update(key, sources.find(source => source.key === event.target.value)?.binding);
        }}>
          {!descriptor.inputSchema.required?.includes(key)
            ? <option value="omit">Omit</option>
            : !binding && <option value="omit" disabled>Required value missing</option>}
          <option value="literal">Value</option>{sourceUnavailable && <option value={sourceKey} disabled>Configured source unavailable</option>}{sources.map(source => <option key={source.key} value={source.key}>{source.label}</option>)}
        </select>
        {binding && 'literal' in binding && literal(key, schema, binding.literal)}
      </label>;
    })}
  </div>;
}

function EdgeInspector({
  edge,
  graph,
  onPatch,
  onDelete,
  onClose,
}: {
  edge: GraphEdge;
  graph: GraphWorkflow;
  onPatch: (id: string, patch: Partial<GraphEdge>) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <InspectorPanel label="Edge inspector" onClose={onClose}>
      <div className="inspector-heading">
        <div>
          <span className="inspector-kicker">Route</span>
          <strong>{edge.outcome || 'Unnamed outcome'}</strong>
        </div>
        <button className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <label>
        From
        <select
          value={edge.from}
          onChange={(event) => onPatch(edge.id, { from: event.target.value })}
        >
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name || 'Untitled'}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select value={edge.to} onChange={(event) => onPatch(edge.id, { to: event.target.value })}>
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name || 'Untitled'}
            </option>
          ))}
        </select>
      </label>
      <label>
        Outcome
        <input
          value={edge.outcome}
          onChange={(event) => onPatch(edge.id, { outcome: event.target.value })}
        />
      </label>
      <button className="secondary danger-button" onClick={() => onDelete(edge.id)}>
        <Trash2 size={14} />
        Delete route
      </button>
    </InspectorPanel>
  );
}

function BranchFields({
  node,
  onPatch,
}: {
  node: GraphNode;
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
}) {
  const condition = node.condition ?? {
    source: 'ticket' as ConditionSource,
    field: '',
    operator: 'equals' as ConditionOperator,
    value: '',
    valueType: 'text' as ConditionValueType,
    trueOutcome: 'yes',
    falseOutcome: 'no',
  };
  const update = (patch: Partial<Condition>) =>
    onPatch(node.id, {
      condition: { ...condition, ...patch },
      outcomes: [
        patch.trueOutcome ?? condition.trueOutcome,
        patch.falseOutcome ?? condition.falseOutcome,
      ],
    });
  const changeOperator = (operator: ConditionOperator) =>
    update({
      operator,
      valueType:
        operator === 'exists'
          ? 'boolean'
          : condition.operator === 'exists'
            ? 'text'
            : condition.valueType,
      value:
        operator === 'exists' ? (condition.value === 'false' ? 'false' : 'true') : condition.value,
    });
  const changeValueType = (valueType: ConditionValueType) =>
    update({
      valueType,
      value:
        valueType === 'null'
          ? ''
          : valueType === 'boolean'
            ? condition.value === 'false'
              ? 'false'
              : 'true'
            : condition.value,
    });
  const valueControl =
    condition.valueType === 'null' ? (
      <span className="field-hint">Matches null.</span>
    ) : condition.valueType === 'boolean' ? (
      <select
        value={condition.value === 'false' ? 'false' : 'true'}
        onChange={(event) => update({ value: event.target.value })}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    ) : (
      <input
        type={condition.valueType === 'number' ? 'number' : 'text'}
        value={condition.value}
        onChange={(event) => update({ value: event.target.value })}
      />
    );
  return (
    <details open>
      <summary>Branch condition</summary>
      <div className="inspector-two">
        <label>
          Source
          <select
            value={condition.source}
            onChange={(event) => update({ source: event.target.value as ConditionSource })}
          >
            <option value="ticket">Ticket</option>
            <option value="submission">Submission</option>
            <option value="actionResult">Action result</option>
            <option value="context">Context</option>
          </select>
        </label>
        <label>
          Operator
          <select
            value={condition.operator}
            onChange={(event) => changeOperator(event.target.value as ConditionOperator)}
          >
            <option value="equals">Equals</option>
            <option value="notEquals">Does not equal</option>
            <option value="exists">Exists</option>
          </select>
        </label>
      </div>
      <label>
        Field path
        <input
          value={condition.field}
          placeholder="status"
          onChange={(event) => update({ field: event.target.value })}
        />
      </label>
      {condition.operator === 'exists' ? (
        <label>
          Must exist
          <select
            value={condition.value === 'false' ? 'false' : 'true'}
            onChange={(event) => update({ value: event.target.value, valueType: 'boolean' })}
          >
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </label>
      ) : (
        <>
          <label>
            Value type
            <select
              value={condition.valueType}
              onChange={(event) => changeValueType(event.target.value as ConditionValueType)}
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="null">Null</option>
            </select>
          </label>
          <label>Value{valueControl}</label>
        </>
      )}
      <div className="inspector-two">
        <label>
          True outcome
          <input
            value={condition.trueOutcome}
            onChange={(event) => update({ trueOutcome: event.target.value })}
          />
        </label>
        <label>
          False outcome
          <input
            value={condition.falseOutcome}
            onChange={(event) => update({ falseOutcome: event.target.value })}
          />
        </label>
      </div>
    </details>
  );
}
