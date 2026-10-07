import { useState } from 'react';
import { command, type RuntimeState, type RuntimeCommandInputMap } from '../../shared/api/runtime';
import './capabilities.css';
function InstructionPublisher({
  state,
  working,
  publish,
  message,
}: {
  state: RuntimeState;
  working: boolean;
  publish: (input: RuntimeCommandInputMap['publishInstruction']) => void;
  message: (text: string) => void;
}) {
  const [scope, setScope] =
    useState<RuntimeCommandInputMap['publishInstruction']['scope']>('project');
  const [name, setName] = useState('AGENTS.md');
  const [target, setTarget] = useState('');
  const [content, setContent] = useState('');
  const targetHelp =
    scope === 'organization'
      ? `Defaults to ${state.instructionOwners?.organizationId ?? 'default'}`
      : scope === 'user'
        ? `Defaults to ${state.instructionOwners?.userId ?? 'local'}`
        : scope === 'project'
          ? 'Uses the selected project'
          : scope === 'task'
            ? 'Ticket number'
            : scope === 'environment'
              ? 'Environment or runner ID'
              : 'Reusable by name';
  return (
    <>
      <form
        className="runtime-form"
        onSubmit={(event) => {
          event.preventDefault();
          publish({ name, scope, target, content });
        }}
      >
        <label>
          Name
          <input
            name="name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Scope
          <select
            name="scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              setTarget('');
            }}
          >
            <option value="organization">Organization</option>
            <option value="user">User</option>
            <option value="project">Project</option>
            <option value="skill">Reusable skill</option>
            <option value="environment">Environment</option>
            <option value="task">Task</option>
          </select>
        </label>
        <label>
          Target <small>{targetHelp}</small>
          <input
            name="target"
            value={target}
            disabled={scope === 'project' || scope === 'skill'}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <label className="wide">
          Content
          <textarea
            name="content"
            required
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            aria-label="Instruction content"
          />
        </label>
        <label>
          Import file
          <input
            type="file"
            accept=".md,text/markdown,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              if (file.size > 20000) {
                message('Instruction files must be 20 KB or smaller.');
                return;
              }
              void file.text().then((value) => {
                setName(file.name);
                setContent(value);
              });
            }}
          />
        </label>
        <button className="primary" disabled={working}>
          Publish version
        </button>
        <button
          type="button"
          className="secondary"
          disabled={working}
          onClick={() => {
            try {
              const previous = JSON.parse(localStorage.getItem('convoy.instructions.v1') ?? 'null');
              if (!previous) throw new Error();
              setName('AGENTS.md');
              setScope('project');
              setContent(previous);
            } catch {
              message('No previous browser instruction draft found.');
            }
          }}
        >
          Load previous browser AGENTS.md
        </button>
      </form>
    </>
  );
}

export function InstructionSettings({
  state,
  projectId,
}: {
  state: RuntimeState;
  projectId: string;
}) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [otherScopes, setOtherScopes] = useState(false);
  async function publish(input: RuntimeCommandInputMap['publishInstruction']) {
    setWorking(true);
    setMessage('');
    try {
      await command('publishInstruction', { ...input, projectId });
      setMessage('Instructions saved.');
      setOpen(false);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const items = state.instructions.filter((item) =>
    otherScopes ? item.scope !== 'project' : item.scope === 'project' && item.target === projectId,
  );
  return (
    <section className="capability-library instruction-settings" aria-label="Instructions">
      <header className="library-toolbar">
        <h2>Instructions</h2>
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          New instruction
        </button>
      </header>
      {message && <p role="status">{message}</p>}
      <div hidden={open} className="capability-cards">
        {!items.length && <p>No {otherScopes ? 'shared' : 'project'} instructions yet.</p>}
        {[...items].reverse().map((item) => (
          <details key={item.id}>
            <summary>
              <strong>{item.name}</strong>
              <span className="library-description">
                {item.scope}
                {item.target ? ` · ${item.target}` : ''}
              </span>
            </summary>
            <small>
              Version {item.version} · {item.hash.slice(0, 12)}
            </small>
            <pre>{item.content}</pre>
          </details>
        ))}
      </div>
      <div className="capability-editor" hidden={!open}>
        <header className="library-editor-heading">
          <strong>New instruction</strong>
          <button type="button" className="secondary" onClick={() => setOpen(false)}>
            Close
          </button>
        </header>
        <InstructionPublisher
          state={state}
          working={working}
          publish={(input) => void publish(input)}
          message={setMessage}
        />
      </div>
      <button type="button" className="secondary" onClick={() => setOtherScopes((value) => !value)}>
        {otherScopes ? 'Project instructions' : 'Other scopes'}
      </button>
    </section>
  );
}
