import { useEffect, useRef } from 'react';
import {
  Check,
  GitBranch,
  Link2,
  Maximize2,
  ShieldCheck,
  Sparkles,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { newId } from '../../shared/lib/browser';
import { kindLabels, outcomesFor, type GraphWorkflow, type NodeKind } from './workflow-codec';

const kindIcon: Record<NodeKind, typeof Zap> = {
  agent: Zap,
  check: Check,
  approval: ShieldCheck,
  action: Sparkles,
  branch: GitBranch,
};

export function WorkflowCanvas({
  graph,
  selectedId,
  selectedEdgeId,
  connecting,
  zoom,
  pan,
  onZoom,
  onPan,
  onNode,
  onEdge,
  onBeginConnection,
  readOnly = false,
  currentId,
  visited = new Set<string>(),
  visitedEdges = new Set<string>(),
  onMoveNode = () => undefined,
  fitRequest = 0,
}: {
  graph: GraphWorkflow;
  selectedId: string | null;
  selectedEdgeId: string | null;
  connecting: { from: string; outcome: string } | null;
  zoom: number;
  pan: { x: number; y: number };
  onZoom: (value: number) => void;
  onPan: (value: { x: number; y: number }) => void;
  onNode: (id: string) => void;
  onEdge: (id: string) => void;
  onBeginConnection: (id: string, outcome?: string) => void;
  readOnly?: boolean;
  currentId?: string;
  visited?: Set<string>;
  visitedEdges?: Set<string>;
  onMoveNode?: (id: string, x: number, y: number) => void;
  fitRequest?: number;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    id?: string;
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const moved = useRef(false);
  const markerId = useRef(newId()).current;
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const width = Math.max(1100, ...graph.nodes.map((node) => node.x + 280));
  const height = Math.max(600, ...graph.nodes.map((node) => node.y + 180));
  function fit() {
    const view = viewport.current;
    if (!view || !graph.nodes.length || !view.clientWidth) return;
    const left = Math.min(...graph.nodes.map((node) => node.x));
    const top = Math.min(...graph.nodes.map((node) => node.y));
    const right = Math.max(...graph.nodes.map((node) => node.x + 230));
    const bottom = Math.max(...graph.nodes.map((node) => node.y + 104));
    const scale = Math.max(
      0.05,
      Math.min(
        1,
        (view.clientWidth - 48) / (right - left),
        (view.clientHeight - 88) / (bottom - top),
      ),
    );
    onZoom(scale);
    onPan({
      x: (view.clientWidth - (right - left) * scale) / 2 - left * scale,
      y: Math.max(60, (view.clientHeight - (bottom - top) * scale) / 2) - top * scale,
    });
  }
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useEffect(() => {
    const view = viewport.current;
    if (!view) return;
    const focusEntry = () => {
      const current = graphRef.current;
      const node =
        current.nodes.find((item) => item.id === (currentId || current.entryNode)) ??
        current.nodes[0];
      if (!node) return;
      onZoom(1);
      onPan({ x: 40 - node.x, y: Math.max(120, Math.min(220, view.clientHeight * 0.35)) - node.y });
    };
    focusEntry();
    let mobile = view.clientWidth < 600;
    const observer = new ResizeObserver(() => {
      const next = view.clientWidth < 600;
      if (next !== mobile) {
        mobile = next;
        focusEntry();
      }
    });
    observer.observe(view);
    return () => observer.disconnect();
  }, [graph.id]);
  useEffect(() => {
    if (fitRequest > 0) fit();
  }, [fitRequest]);
  function finishGesture() {
    gesture.current = null;
  }
  return (
    <div
      ref={viewport}
      className={readOnly ? 'workflow-canvas-viewport read-only' : 'workflow-canvas-viewport'}
      onPointerDown={(event) => {
        if (
          (event.target as Element).closest('.graph-node, .workflow-edge-group, .canvas-controls')
        )
          return;
        event.currentTarget.setPointerCapture(event.pointerId);
        moved.current = false;
        gesture.current = { x: pan.x, y: pan.y, startX: event.clientX, startY: event.clientY };
      }}
      onPointerMove={(event) => {
        const drag = gesture.current;
        if (!drag) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true;
        if (!moved.current) return;
        if (drag.id) onMoveNode(drag.id, drag.x + dx / zoom, drag.y + dy / zoom);
        else onPan({ x: drag.x + dx, y: drag.y + dy });
      }}
      onPointerUp={finishGesture}
      onPointerCancel={finishGesture}
    >
      <div className="canvas-controls">
        <button aria-label="Zoom out" onClick={() => onZoom(Math.max(0.05, zoom - 0.1))}>
          <ZoomOut size={15} />
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => onZoom(Math.min(1.75, zoom + 0.1))}>
          <ZoomIn size={15} />
        </button>
        <button aria-label="Fit graph" onClick={fit}>
          <Maximize2 size={15} />
        </button>
      </div>
      <div
        className="workflow-canvas-stage"
        style={{ width, height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <svg
          className="workflow-edges"
          width={width}
          height={height}
          aria-label="Workflow connections"
        >
          <defs>
            <marker
              id={markerId}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3.5"
              orient="auto"
            >
              <path d="M0,0 L8,3.5 L0,7 z" fill="#719486" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + 230;
            const y1 = from.y + 52;
            const x2 = to.x;
            const y2 = to.y + 52;
            const bend = Math.max(45, Math.abs(x2 - x1) / 2);
            const siblings = graph.edges.filter(
              (item) => item.from === edge.from && item.to === edge.to,
            );
            const offset =
              (siblings.findIndex((item) => item.id === edge.id) - (siblings.length - 1) / 2) * 56;
            const traversed = visitedEdges.has(`${edge.from}:${edge.outcome}:${edge.to}`);
            const path = `M ${x1} ${y1} C ${x1 + bend} ${y1 + offset}, ${x2 - bend} ${y2 + offset}, ${x2} ${y2}`;
            return (
              <g
                key={edge.id}
                role={readOnly ? undefined : 'button'}
                tabIndex={readOnly ? undefined : 0}
                aria-label={`Route ${edge.outcome} from ${from.name} to ${to.name}`}
                className={`workflow-edge-group ${selectedEdgeId === edge.id ? 'selected' : ''} ${traversed ? 'traversed' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!readOnly) onEdge(edge.id);
                }}
                onKeyDown={(event) => {
                  if (!readOnly && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onEdge(edge.id);
                  }
                }}
              >
                <path className="workflow-edge-hit" d={path} />
                <path className="workflow-edge" d={path} markerEnd={`url(#${markerId})`} />
                {(edge.outcome !== 'success' || selectedEdgeId === edge.id) && (
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 + offset * 0.75 - 8}
                    className="workflow-edge-label"
                  >
                    {edge.outcome.replaceAll('_', ' ')}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const Icon = kindIcon[node.type];
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              className={`graph-node node-${node.type} ${selectedId === node.id ? 'selected' : ''} ${connecting?.from === node.id ? 'connecting' : ''} ${currentId === node.id ? 'live-current' : ''} ${visited.has(node.id) ? 'live-visited' : ''}`}
              style={{ left: node.x, top: node.y }}
              role="button"
              aria-label={`${kindLabels[node.type]}: ${node.name}`}
              tabIndex={0}
              onClick={() => {
                if (moved.current) {
                  moved.current = false;
                  return;
                }
                onNode(node.id);
              }}
              onPointerDown={(event) => {
                moved.current = false;
                if (readOnly || connecting || (event.target as Element).closest('button')) return;
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                gesture.current = {
                  id: node.id,
                  x: node.x,
                  y: node.y,
                  startX: event.clientX,
                  startY: event.clientY,
                };
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onNode(node.id);
                }
              }}
            >
              <div className="graph-node-head">
                <Icon size={15} />
                <span>{kindLabels[node.type]}</span>
                {graph.entryNode === node.id && <em>Entry</em>}
              </div>
              <strong>{node.name || 'Untitled node'}</strong>
              {node.type === 'check' && <small>{node.checkCommand || 'Choose a command'}</small>}
              {!readOnly && selectedId === node.id && (
                <div className="node-route-actions">
                  {outcomesFor(node).map((outcome) => (
                    <button
                      key={outcome}
                      aria-label={`Connect ${outcome} from ${node.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onBeginConnection(node.id, outcome);
                      }}
                    >
                      <Link2 size={12} />
                      {outcome.replaceAll('_', ' ')}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!graph.nodes.length && (
          <div className="canvas-empty">
            <GitBranch size={28} />
            <strong>Add a node to begin</strong>
          </div>
        )}
      </div>
    </div>
  );
}
