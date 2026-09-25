import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, MoreHorizontal, X, Zap } from 'lucide-react';
import type {
  Board,
  BoardAutomationRelationship,
  BoardAutomationView,
  Project,
  WorkflowReference,
} from '../../shared/api/runtime';
import { relationshipEvent, relationshipSections } from './board-automation-view';
import './board-workflows.css';

type Props = {
  board: Board;
  columnId?: string;
  view?: BoardAutomationView;
  projects: Project[];
  error?: string;
  onOpen: (reference: WorkflowReference) => void;
};

function Relationship({
  row,
  board,
  projects,
  onOpen,
  showVersion,
  showName,
}: {
  row: BoardAutomationRelationship;
  board: Board;
  projects: Project[];
  onOpen: Props['onOpen'];
  showVersion: boolean;
  showName: boolean;
}) {
  const column = board.columns.find((value) => value.id === row.columnId);
  const project =
    row.projectId && board.projectIds.length > 1
      ? projects.find((value) => value.id === row.projectId)?.name
      : undefined;
  return (
    <button
      type="button"
      className="board-workflow-row"
      disabled={!row.available}
      title={`${row.name} · v${row.workflowVersion}${row.kind === 'start_rule' ? ` · revision ${row.ruleRevision}` : row.indirect ? ' · Via external mapping' : ''}`}
      aria-label={`Open ${row.workflowName ?? 'workflow'} v${row.workflowVersion}: ${relationshipEvent(row, column?.name)}`}
      onClick={() => onOpen(row)}
    >
      <span className="board-workflow-copy">
        <span>{relationshipEvent(row, column?.name)}</span>
        {(showName || project || showVersion) && (
          <small>
            {[
              showName ? row.name : undefined,
              project,
              showVersion ? `v${row.workflowVersion}` : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        )}
      </span>
      {row.unresolved && <small>Unresolved</small>}
      {!row.available ? (
        <small>Unavailable</small>
      ) : row.kind === 'start_rule' && !row.enabled ? (
        <small>Disabled</small>
      ) : null}
      {row.available && <ArrowUpRight size={13} aria-hidden="true" />}
    </button>
  );
}

function WorkflowGroup({
  group,
  expanded,
  board,
  projects,
  onOpen,
}: {
  group: ReturnType<typeof relationshipSections>[number];
  expanded: boolean;
  board: Board;
  projects: Project[];
  onOpen: Props['onOpen'];
}) {
  const [open, setOpen] = useState(expanded);
  const contentId = useId();
  const showVersion = new Set(group.rows.map((row) => row.workflowVersion)).size > 1;
  const label = (row: BoardAutomationRelationship) =>
    relationshipEvent(row, board.columns.find((column) => column.id === row.columnId)?.name);
  return (
    <div className="board-workflow-group">
      <button
        type="button"
        className="board-workflow-disclosure"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <strong>{group.title}</strong>
      </button>
      <div id={contentId} hidden={!open}>
        {(['start_rule', 'effect'] as const).map((kind) => (
          <section key={kind}>
            {group.rows.some((row) => row.kind === kind) && (
              <h4>{kind === 'start_rule' ? 'Triggers' : 'Effects'}</h4>
            )}
            {group.rows
              .filter((row) => row.kind === kind)
              .map((row) => (
                <Relationship
                  key={JSON.stringify([row.kind, row.workflowVersion, row.ruleId, row.nodeId])}
                  row={row}
                  board={board}
                  projects={projects}
                  onOpen={onOpen}
                  showVersion={showVersion}
                  showName={
                    group.rows.filter(
                      (other) =>
                        label(other) === label(row) &&
                        other.workflowVersion === row.workflowVersion &&
                        other.projectId === row.projectId,
                    ).length > 1
                  }
                />
              ))}
          </section>
        ))}
      </div>
    </div>
  );
}

export function BoardAutomationInspector({
  board,
  columnId,
  view,
  projects,
  error,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const column = board.columns.find((value) => value.id === columnId);
  const sections = view ? relationshipSections(view, columnId) : [];
  const hasRows = !error && sections.length > 0;
  function restoreFocus() {
    const button = trigger.current;
    if (button?.isConnected && button.getClientRects().length) button.focus();
    else
      (
        button?.closest('details')?.querySelector<HTMLElement>('summary') ??
        document.querySelector<HTMLElement>('[aria-label="Board view"]')
      )?.focus();
  }
  function close() {
    setOpen(false);
    restoreFocus();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const invoker = trigger.current;
    const update = () => {
      const rect = invoker?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 24);
      const top = Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 220));
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top,
        maxHeight: window.innerHeight - top - 12,
      });
    };
    update();
    heading.current?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !panel.current?.contains(event.target as Node) &&
        !invoker?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        const controls = Array.from(
          panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),summary') ?? [],
        ).filter((el) => el.getClientRects().length);
        if (
          (event.shiftKey &&
            (document.activeElement === heading.current ||
              document.activeElement === controls[0])) ||
          (!event.shiftKey && document.activeElement === controls.at(-1))
        ) {
          setOpen(false);
          restoreFocus();
        }
      }
    };
    document.addEventListener('pointerdown', outside);
    panel.current?.addEventListener('keydown', key);
    const currentPanel = panel.current;
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      currentPanel?.removeEventListener('keydown', key);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      const ownedFocus = currentPanel?.contains(document.activeElement);
      queueMicrotask(() => {
        if (ownedFocus && !invoker?.isConnected && document.activeElement === document.body) {
          document.querySelector<HTMLElement>('[aria-label="Board view"]')?.focus();
        }
      });
    };
  }, [open]);
  const button = (
    <button
      ref={trigger}
      type="button"
      className="board-workflow-trigger"
      aria-label={columnId ? `Automations for ${column?.name ?? 'column'}` : 'Automations'}
      title={columnId ? 'Automations' : 'Automations'}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      onClick={() => setOpen((value) => !value)}
    >
      {columnId ? hasRows ? <Zap size={15} /> : <>Automations</> : <Zap size={15} />}
    </button>
  );
  return (
    <>
      {columnId && !hasRows ? (
        <details className="board-workflow-menu">
          <summary aria-label={`Column options for ${column?.name ?? 'column'}`}>
            <MoreHorizontal size={15} />
          </summary>
          {button}
        </details>
      ) : (
        button
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-labelledby={`${id}-title`}
            className="board-workflow-popover"
            style={position}
          >
            <header>
              <h2 className="sr-only" ref={heading} tabIndex={-1} id={`${id}-title`}>
                {columnId ? `${column?.name ?? 'Column'} · Automations` : 'Automations'}
              </h2>
              <button type="button" aria-label="Close automations" onClick={close}>
                <X size={16} />
              </button>
            </header>
            {error ? (
              <p role="alert">Disconnected.</p>
            ) : !view ? (
              <p role="status">Unavailable.</p>
            ) : (
              <>
                {!hasRows && <p>{columnId ? 'No automations.' : 'No automations.'}</p>}
                <section>
                  {sections
                    .filter((group) => !group.project && !group.unresolved)
                    .map((group) => (
                      <WorkflowGroup
                        key={group.id}
                        group={group}
                        expanded={sections.filter((value) => !value.project && !value.unresolved).length === 1}
                        board={board}
                        projects={projects}
                        onOpen={(reference) => {
                          setOpen(false);
                          onOpen(reference);
                        }}
                      />
                    ))}
                  {sections.some((group) => group.project && !group.unresolved) && (
                    <details className="board-workflow-projects">
                      <summary>Project automations</summary>
                      {sections
                        .filter((group) => group.project && !group.unresolved)
                        .map((group) => (
                          <WorkflowGroup
                            key={group.id}
                            group={group}
                            expanded={sections.filter((value) => value.project && !value.unresolved).length === 1}
                            board={board}
                            projects={projects}
                            onOpen={(reference) => {
                              setOpen(false);
                              onOpen(reference);
                            }}
                          />
                        ))}
                    </details>
                  )}
                  {sections.some((group) => group.unresolved) && (
                    <details className="board-workflow-projects">
                      <summary>Unresolved</summary>
                      {sections.filter((group) => group.unresolved).map((group) => (
                        <WorkflowGroup key={group.id} group={group} expanded={false}
                          board={board} projects={projects} onOpen={(reference) => {
                            setOpen(false);
                            onOpen(reference);
                          }} />
                      ))}
                    </details>
                  )}
                </section>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
