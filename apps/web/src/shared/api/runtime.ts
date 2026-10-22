import { useEffect, useRef, useState } from 'react';
import type {
  CommandEnvelope,
  RuntimeAction,
  RuntimeCommandInputMap,
  RuntimeCommandResultMap,
  RuntimeState,
  Session,
} from '../../../../../packages/contracts/src';
import { newId } from '../lib/browser';

export type * from '../../../../../packages/contracts/src';

export const client = newId();
let contextGeneration = 0;

export class RuntimeApiError extends Error {
  readonly code?: string;
  readonly status?: number;
  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'RuntimeApiError';
    this.code = code;
    this.status = status;
  }
}

export async function api<T = unknown>(path: string, input?: object): Promise<T> {
  const response = await fetch(
    path,
    input
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Convoy-Client': client },
          body: JSON.stringify(input),
        }
      : { headers: { 'X-Convoy-Client': client } },
  );
  let value;
  try {
    value = await response.json();
  } catch (error) {
    if (!response.ok && response.status < 500 && response.status !== 409)
      throw new RuntimeApiError('Request failed.', undefined, response.status);
    throw error;
  }
  if (!response.ok)
    throw new RuntimeApiError(value?.error || 'Request failed', value?.code, response.status);
  return value as T;
}

export async function command<Action extends RuntimeAction>(
  action: Action,
  input: RuntimeCommandInputMap[Action],
) {
  if (action === 'claim') {
    const target = input as RuntimeCommandInputMap['claim'];
    const sessionId = target.sessionId ?? target.taskId;
    if (sessionId !== undefined) {
      const generation = contextGeneration;
      const snapshot = await api<RuntimeState>(`/api/runtime/${encodeURIComponent(String(sessionId))}`);
      const session = snapshot.sessions.find(value => String(value.id) === String(sessionId));
      if (session?.workflowRunId) {
        const run = (await command('getWorkflowRun', { workflowRunId: session.workflowRunId })).result;
        if (generation !== contextGeneration) throw new RuntimeApiError('Active context changed. Try again.');
        if (run.independent && !(run.lease?.ownedByCurrentCaller && run.lease.expiresAt > Date.now()))
          await command('claimWorkflowRun', { workflowRunId: run.id, label: target.label });
      }
      if (generation !== contextGeneration) throw new RuntimeApiError('Active context changed. Try again.');
    }
  }
  const fileMutation = [
    'saveSkillSource',
    'createSkillSource',
    'provisionSkillSnapshot',
    'saveStoredSkillToFolder',
  ].includes(action);
  let result: CommandEnvelope<RuntimeCommandResultMap[Action]>;
  try {
    result = await api<CommandEnvelope<RuntimeCommandResultMap[Action]>>('/api/runtime', {
      action,
      client,
      ...input,
    });
    if (fileMutation && result?.result == null)
      throw new RuntimeApiError(
        'Save outcome is uncertain. Inspect the destination before retrying.',
        'UNCERTAIN',
      );
  } catch (error) {
    // A lost or unreadable reply cannot establish whether the runner committed files.
    // Known rejections retain their normal handling; never replay an unknown outcome.
    if (
      fileMutation &&
      (!(error instanceof RuntimeApiError) ||
        (error.status !== undefined && error.status >= 500) ||
        (error.status === 409 && !['CONFLICT', 'UNCERTAIN'].includes(error.code ?? '')))
    )
      throw new RuntimeApiError(
        'Save outcome is uncertain. Inspect the destination before retrying.',
        'UNCERTAIN',
      );
    throw error;
  }
  if (action === 'selectActiveContext') {
    contextGeneration++;
    window.dispatchEvent(new Event('convoy-context-changed'));
  }
  return result;
}

export function useRuntime(taskId?: number, overview: boolean | 'attention' = false, enabled = true) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [loadedScope, setLoadedScope] = useState('');
  const [error, setError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const reload = useRef<(() => void) | null>(null);
  const scope = JSON.stringify([taskId ?? null, overview]);

  useEffect(() => {
    if (!enabled) {
      reload.current = null;
      setIsRefreshing(false);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    let request = 0;
    const load = async (reconnect = false) => {
      const currentRequest = ++request;
      const generation = contextGeneration;
      if (reconnect) setIsRefreshing(true);
      try {
        const value = await api<RuntimeState>(
          `/api/runtime${taskId ? `/${taskId}` : overview === 'attention' ? '?view=attention' : overview ? '?view=overview' : ''}`,
        );
        if (live && currentRequest === request && generation === contextGeneration) {
          setState(value);
          setLoadedScope(scope);
          setError('');
        }
      } catch {
        if (live && currentRequest === request && generation === contextGeneration)
          setError(
            'Connection lost. Existing work may still be running. Reconnect before sending another command.',
          );
      } finally {
        if (live && currentRequest === request) setIsRefreshing(false);
      }
      if (live && currentRequest === request) timer = setTimeout(() => void load(), 1000);
    };
    const reconnect = () => {
      clearTimeout(timer);
      void load(true);
    };
    reload.current = reconnect;
    const contextChanged = () => {
      clearTimeout(timer);
      request++;
      setState(null);
      setError('');
      setIsRefreshing(false);
      void load();
    };
    window.addEventListener('convoy-context-changed', contextChanged);
    void load();
    return () => {
      live = false;
      request++;
      clearTimeout(timer);
      if (reload.current === reconnect) reload.current = null;
      window.removeEventListener('convoy-context-changed', contextChanged);
    };
  }, [taskId, overview, enabled]);

  const refresh = () => reload.current?.();
  return {
    state,
    error,
    isStale: !enabled || !state || loadedScope !== scope || !!error || isRefreshing,
    isRefreshing,
    refresh,
  };
}

export function owns(session?: Session) {
  return session?.lease?.client === client && session.lease.expiresAt > Date.now();
}
