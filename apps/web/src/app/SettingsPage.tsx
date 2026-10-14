import { useRuntime } from '../shared/api/runtime';
import { AgentSettings } from '../features/library';
import { EnvironmentSettings } from '../features/runners';
import { WorkflowReferenceView, WorkflowWorkspace } from '../features/workflows/index';
import type { WorkflowReference } from '../shared/api/runtime';
import { ProviderSettings } from '../features/providers';
import { IntegrationSettings } from '../features/integrations';

type SettingsView = 'Providers' | 'Integrations' | 'Runners' | 'Workflows' | 'Agents';

export function SettingsPage({
  view,
  projectId,
  workflowReference,
  workflowRunId,
  onCloseReference,
  onOpenConversation,
}: {
  view: SettingsView;
  projectId?: string;
  workflowReference?: WorkflowReference;
  workflowRunId?: string;
  onCloseReference?: () => void;
  onOpenConversation?: (id: string) => void;
}) {
  const { state, error, isStale } = useRuntime();
  return (
    <section className="runtime-page">
      {view !== 'Workflows' && <h1 className="sr-only">{view}</h1>}
      {error && <p role="alert">{error}</p>}
      {view === 'Workflows' && state && workflowReference && (
          <WorkflowReferenceView
            state={state}
            reference={workflowReference}
            onBack={() => onCloseReference?.()}
          />
      )}
      <fieldset disabled={isStale} style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}>
        {view === 'Runners' && state && <EnvironmentSettings state={state} />}{' '}
        {view === 'Providers' && state && <ProviderSettings state={state} />}{' '}
        {view === 'Integrations' && state && <IntegrationSettings state={state} />}{' '}
        {view === 'Workflows' && state && !workflowReference && (
          <WorkflowWorkspace
            state={state}
            projectId={projectId}
            workflowRunId={workflowRunId}
            onOpenConversation={onOpenConversation}
          />
        )}
        {view === 'Agents' && state && <AgentSettings state={state} />}
      </fieldset>
    </section>
  );
}
