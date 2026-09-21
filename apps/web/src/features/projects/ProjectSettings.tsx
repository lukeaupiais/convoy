import { useState } from 'react';
import { command } from '../../shared/api/runtime';
import type { Project, RuntimeState } from '../../shared/api/runtime';
import { PlacementEditor } from './PlacementEditor';
import { ExecutionProfileEditor } from './ExecutionProfileEditor';
import './ticket-fields.css';
export function ProjectSettings({ state, project }: { state: RuntimeState; project: Project }) {
  const [message, setMessage] = useState('');
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
        <button className="primary">Save project</button>
      </form>
      {message && <p role="status">{message}</p>}
      <h2>Default agent permissions</h2>
      <ExecutionProfileEditor key={`${project.id}-profile`} state={state} target={project} />
      <h2>Default placement</h2>
      <PlacementEditor key={project.id} state={state} target={project} />
    </div>
  );
}
