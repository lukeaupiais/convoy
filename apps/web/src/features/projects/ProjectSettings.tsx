import { useState } from 'react';
import { command } from '../../shared/api/runtime';
import type { Project, RuntimeState, RuntimeDefinitionInput } from '../../shared/api/runtime';
import { PlacementEditor } from './PlacementEditor';
import { ExecutionProfileEditor } from './ExecutionProfileEditor';
import './ticket-fields.css';
import { InstructionSettings, ProjectAgentProfile } from '../library';
export function ProjectSettings({
  state,
  project,
  onManageAgents,
}: {
  state: RuntimeState;
  project: Project;
  onManageAgents?: () => void;
}) {
  const [message, setMessage] = useState('');
  const [runtimeDraft, setRuntimeDraft] = useState('');
  const [revision, setRevision] = useState(project.revision);
  return (
    <div>
      <h1>Project settings</h1>
      <form
        className="runtime-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            const response = await command('saveProject', {
              id: project.id,
              revision,
              name: String(f.get('name') ?? ''),
              description: String(f.get('description') ?? ''),
              runtime: (() => {
                const d = state.runtimeDefinitions?.find(
                  (d) => d.projectId === project.id && `${d.id}@${d.version}` === f.get('runtime'),
                );
                return d ? { id: d.id, version: d.version, required: false } : null;
              })(),
            });
            setRevision(response.result.revision);
            setMessage('Project saved.');
          } catch (e) {
            setMessage((e as Error).message);
          }
        }}
      >
        <label>
          Name
          <input name="name" defaultValue={project.name} required />
        </label>
        <label className="ticket-description-field">
          Description
          <textarea name="description" defaultValue={project.description} />
        </label>
        <label>
          Default verification runtime
          <select
            name="runtime"
            defaultValue={project.runtime ? `${project.runtime.id}@${project.runtime.version}` : ''}
          >
            <option value="">Disabled</option>
            {(state.runtimeDefinitions ?? [])
              .filter((d) => d.projectId === project.id)
              .map((d) => (
                <option key={`${d.id}@${d.version}`} value={`${d.id}@${d.version}`}>
                  {d.name} · v{d.version}
                </option>
              ))}
          </select>
        </label>
        <button className="primary">Save project</button>
      </form>
      {message && <p role="status">{message}</p>}
      <details>
        <summary>Publish verification runtime</summary>
        <form
          className="runtime-form"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const definition = JSON.parse(runtimeDraft) as RuntimeDefinitionInput;
              const baseVersion = Math.max(
                0,
                ...(state.runtimeDefinitions ?? [])
                  .filter((d) => d.projectId === project.id && d.id === definition.id)
                  .map((d) => d.version),
              );
              await command('publishRuntimeDefinition', {
                projectId: project.id,
                definition,
                baseVersion,
              });
              setMessage('Runtime revision published. Select it for future runs.');
            } catch (error) {
              setMessage((error as Error).message);
            }
          }}
        >
          <label>
            Definition JSON
            <textarea
              value={runtimeDraft}
              onChange={(event) => setRuntimeDraft(event.target.value)}
              required
            />
          </label>
          <button type="submit">Publish revision</button>
        </form>
      </details>
      <ProjectAgentProfile state={state} projectId={project.id} onManage={onManageAgents} />
      <InstructionSettings
        key={`${project.id}-instructions`}
        state={state}
        projectId={project.id}
      />
      <h2>Default agent permissions</h2>
      <ExecutionProfileEditor key={`${project.id}-profile`} state={state} target={project} />
      <h2>Default placement</h2>
      <PlacementEditor key={project.id} state={state} target={project} />
    </div>
  );
}
