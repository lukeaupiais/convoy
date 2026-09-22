import { useState } from 'react';
import {
  command,
  useRuntime,
  type RuntimeCommandInputMap,
  type RuntimeState,
} from '../shared/api/runtime';
import { CapabilityLibrary } from '../features/library/CapabilityLibrary';
import { EnvironmentSettings } from '../features/runners/EnvironmentSettings';
import { WorkflowEditor } from '../features/workflows/WorkflowEditor';
import { ProviderSettings } from '../features/providers';
import { IntegrationSettings } from '../features/integrations';

type SettingsView = 'Providers' | 'Integrations' | 'Runners' | 'Workflows' | 'Skills & instructions';

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
      <p className="muted">
        <strong>AGENTS.md</strong> is the portable project format. Convoy publishes an immutable
        copy so organization, user and project precedence stays explicit and inspectable.
      </p>
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
              const previous = JSON.parse(
                localStorage.getItem('convoy.instructions.v1') ?? 'null',
              );
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

export function SettingsPage({ view, projectId }: { view: SettingsView; projectId?: string }) {
  const { state, error } = useRuntime();
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  async function publishInstruction(input: RuntimeCommandInputMap['publishInstruction']) {
    setWorking(true);
    setMessage('');
    try {
      await command('publishInstruction', { ...input, projectId });
      setMessage('Saved on the daemon.');
    } catch (caught) {
      setMessage((caught as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="runtime-page">
      <h1 className="sr-only">{view}</h1>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {view === 'Runners' && state && <EnvironmentSettings state={state} />}{' '}
      {view === 'Providers' && state && <ProviderSettings state={state} />}{' '}
      {view === 'Integrations' && state && <IntegrationSettings state={state} />}{' '}
      {view === 'Workflows' && state && <WorkflowEditor state={state} />}
      {view === 'Skills & instructions' && state && (
        <CapabilityLibrary state={state} projectId={projectId}>
          <p className="muted">
            Published versions are immutable. Apply them to a task from Chat before starting a run.
            Browser-only drafts remain untouched.
          </p>
          <InstructionPublisher
            state={state}
            working={working}
            publish={(input) => void publishInstruction(input)}
            message={setMessage}
          />
          {[...state.instructions].reverse().map((instruction) => (
            <details className="runtime-details" key={instruction.id}>
              <summary>
                {instruction.scope}
                {instruction.target && ` ${instruction.target}`} · {instruction.name} v
                {instruction.version} · {instruction.hash.slice(0, 12)}
              </summary>
              <small>
                {instruction.source === 'AGENTS.md' ? 'AGENTS.md compatible' : 'Convoy instruction'}
              </small>
              <pre>{instruction.content}</pre>
            </details>
          ))}
        </CapabilityLibrary>
      )}
    </section>
  );
}
