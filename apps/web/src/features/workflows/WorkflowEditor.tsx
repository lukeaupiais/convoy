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
import { command, type RuntimeState } from '../../shared/api/runtime';
import { newId } from '../../shared/lib/browser';
import {
  actionInputDefaults,
  displayValue,
  fresh,
  fromWorkflow,
  kindLabels,
  layout,
  insertWorkflowStage,
  outcomesFor,
  reorderWorkflowStages,
  starter,
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

function templateWorkflow(template: WorkflowTemplate): GraphWorkflow {
  if (template === 'blank') {
    const first = fresh('agent', 0);
    first.name = 'First stage';
    return fromWorkflow({
      id: newId(),
      name: 'Untitled workflow',
      version: 0,
      nodes: [first],
      edges: [],
      entryNode: first.id,
      maxRevisions: 3,
    });
  }
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
  const draftRecords = state.workflowDrafts ?? {};
  const initialPublished = published.at(-1) as GraphWorkflow | undefined;
  const initialRecord = initialPublished ? draftRecords[initialPublished.id] : undefined;
  const [draft, setDraft] = useState<GraphWorkflow>(() =>
    fromWorkflow(
      (initialRecord?.workflow as unknown as GraphWorkflow | undefined) ??
        initialPublished ??
        starter(),
    ),
  );
  const [revision, setRevision] = useState(initialRecord?.revision ?? 0);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<{ from: string; outcome: string } | null>(null);
  const [view, setView] = useState<'stages' | 'graph'>('stages');
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
    () => Boolean(initialRecord) || !initialPublished,
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
    setDraft((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    }));
  }
  function patchInput(id: string, key: string, value: string) {
    const node = draft.nodes.find((item) => item.id === id);
    if (node) patchNode(id, { input: { ...(node.input ?? {}), [key]: value } });
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
      setSavedSnapshot(JSON.stringify(toWorkflow(next)));
      setSaveStatus('saved');
      setRevision(stored?.revision ?? 0);
      setPublishPending(Boolean(stored));
      setSelectedId(null);
      setSelectedEdgeId(null);
      setMessage(stored ? 'Draft loaded.' : 'Published version loaded.');
    }
  }
  function newWorkflow(template: WorkflowTemplate) {
    setMessageError(false);
    setDraft(templateWorkflow(template));
    setSavedSnapshot('');
    setSaveStatus('pending');
    setRevision(0);
    setPublishPending(true);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setNewMenuOpen(false);
    setView('stages');
    setMessage('New workflow draft.');
  }
  async function publish() {
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
    if (snapshot === savedSnapshot || autoSaving || working) return;
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
  }, [autoSaving, draft, makeDefault, revision, savedSnapshot, snapshot, working]);

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
            disabled={!publishPending || working || autoSaving || snapshot !== savedSnapshot}
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
            Name
            <input
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({ ...current, name: event.target.value }))
              }
            />
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
                state={state}
                boards={state.boards}
                onPatch={patchNode}
                onPatchInput={patchInput}
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
                state={state}
                boards={state.boards}
                onPatch={patchNode}
                onPatchInput={patchInput}
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
  state,
  boards,
  onPatch,
  onPatchInput,
  onConnect,
  onDelete,
  onClose,
}: {
  node: GraphNode;
  state: RuntimeState;
  boards: BoardSummary[];
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
  onPatchInput: (id: string, key: string, value: string) => void;
  onConnect: (id: string, outcome?: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const headings = node.artifact?.headings.join('\n') ?? '';
  const patchArtifact = (path: string, nextHeadings: string) =>
    onPatch(node.id, {
      artifact: path || nextHeadings ? { path, headings: nextHeadings.split('\n') } : undefined,
    });
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
      {node.type !== 'branch' && (
        <label>
          Agent instructions
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
          <div className="inspector-two">
            <label>
              Max rounds
              <input
                type="number"
                min="1"
                max="20"
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
          <label>Event
            <select value={node.waitFor?.event ?? 'ticket_message_received'} onChange={(event) => onPatch(node.id, { waitFor: { ...node.waitFor, event: event.target.value as NonNullable<GraphNode['waitFor']>['event'], ticketSource: node.waitFor?.ticketSource ?? 'active_ticket' } })}>
              <option value="ticket_message_received">Source message received</option>
              <option value="ticket_source_updated">Imported ticket updated</option>
              <option value="ticket_updated">Local ticket updated</option>
            </select>
          </label>
          <label>Ticket
            <select value={node.waitFor?.ticketSource ?? 'active_ticket'} onChange={(event) => onPatch(node.id, { waitFor: { event: node.waitFor?.event ?? 'ticket_message_received', ticketSource: event.target.value as NonNullable<GraphNode['waitFor']>['ticketSource'], status: node.waitFor?.status } })}>
              <option value="active_ticket">Active ticket</option>
              <option value="related_ticket">Related ticket</option>
            </select>
          </label>
          {node.waitFor?.ticketSource === 'related_ticket' && <label>Relation kind (optional)
            <input value={node.waitFor.relationKind ?? ''} onChange={(event) => onPatch(node.id, { waitFor: { ...node.waitFor!, relationKind: event.target.value || undefined } })} />
          </label>}
          <label>Required status (optional)
            <input value={node.waitFor?.status ?? ''} onChange={(event) => onPatch(node.id, { waitFor: { event: node.waitFor?.event ?? 'ticket_message_received', ticketSource: node.waitFor?.ticketSource ?? 'active_ticket', status: event.target.value || undefined } })} />
          </label>
        </details>
      )}
      {node.type === 'action' && (
        <ActionFields
          node={node}
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
  boards,
  projects,
  onPatch,
  onPatchInput,
}: {
  node: GraphNode;
  boards: BoardSummary[];
  projects: RuntimeState['projects'];
  onPatch: (id: string, patch: Partial<GraphNode>) => void;
  onPatchInput: (id: string, key: string, value: string) => void;
}) {
  const operation = node.operation ?? 'inspect_changes';
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
          {!['inspect_changes','create_ticket','create_related_ticket','update_ticket','move_ticket','set_external_status'].includes(operation) && <option value={operation}>Unsupported: {operation}</option>}
          <option value="inspect_changes">Inspect changes</option>
          <option value="create_ticket">Create ticket</option>
          <option value="create_related_ticket">Create related ticket</option>
          <option value="update_ticket">Update ticket</option>
          <option value="move_ticket">Move ticket</option>
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
          <label>Board (optional)
            <select value={displayValue(input.boardId)} onChange={(event) => onPatchInput(node.id, 'boardId', event.target.value)}>
              <option value="">Project default</option>
              {boards.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {field('status', 'Status (optional)')}
        </>
      )}
      {operation === 'set_external_status' && <>{field('connectionId', 'Connection')}{field('status', 'Source status')}{field('evidenceReply', 'Reply evidence')}</>}
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
              onChange={(event) => onPatch(node.id, { input: { ...input, placement: { columnId: event.target.value } } })}
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
      {operation === 'inspect_changes' && (
        <p className="field-hint">Uses the assigned workspace and records review evidence.</p>
      )}
    </details>
  );
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
