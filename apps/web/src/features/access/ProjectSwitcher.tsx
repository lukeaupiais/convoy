import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Plus } from 'lucide-react';
import type { ContextRef, RuntimeState } from '../../shared/api/runtime';
import './project-switcher.css';

export function ProjectSwitcher({
  state,
  projectId,
  selectContext,
  createProject,
  manageProject,
}: {
  state: RuntimeState;
  projectId?: string;
  selectContext: (context: ContextRef) => void;
  createProject: () => void;
  manageProject: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const project = state.projects.find((value) => value.id === projectId);
  const contexts = state.availableContexts?.length
    ? state.availableContexts
    : state.projects.map((value) => ({
        organizationId: value.organizationId,
        teamId: value.teamId,
        projectId: value.id,
      }));
  const choices = contexts
    .map((context) => ({
      context,
      project: state.projects.find((value) => value.id === context.projectId),
    }))
    .filter(
      (
        choice,
      ): choice is {
        context: (typeof contexts)[number];
        project: NonNullable<typeof choice.project>;
      } => Boolean(choice.project),
    )
    .filter((choice) => choice.project.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <details
      ref={menu}
      className="project-switcher"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary aria-label="Choose project">
        {project?.name ?? 'Choose project'} <ChevronDown size={14} />
      </summary>
      {open && (
        <div className="project-switcher-menu">
          <input
            autoFocus
            aria-label="Search projects"
            placeholder="Search projects…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="project-switcher-options">
            {choices.map(({ context, project: choice }) => (
              <button
                key={`${context.organizationId}:${choice.id}`}
                type="button"
                onClick={() => {
                  selectContext({
                    organizationId: context.organizationId,
                    ...(context.teamId ? { teamId: context.teamId } : {}),
                    projectId: choice.id,
                  });
                  setOpen(false);
                  setQuery('');
                }}
              >
                {choice.name}
                {choice.id === projectId && <Check size={14} />}
              </button>
            ))}
            {!choices.length && <span className="project-switcher-empty">No projects found</span>}
          </div>
          <div className="project-switcher-actions">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                createProject();
              }}
            >
              <Plus size={14} /> New project
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                manageProject();
              }}
            >
              Project settings
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
