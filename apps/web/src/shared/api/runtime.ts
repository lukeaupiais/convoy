import { useEffect, useState } from 'react';
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

export function useRuntime(taskId?: number, overview = false, enabled = true) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const generation = contextGeneration;
      try {
        const value = await api<RuntimeState>(
          `/api/runtime${taskId ? `/${taskId}` : overview ? '?view=overview' : ''}`,
        );
        if (live && generation === contextGeneration) {
          setState(value);
          setError('');
        }
      } catch {
        if (live && generation === contextGeneration)
          setError(
            'Daemon unavailable. Run npm run server. Existing work may still be running; reconnect before retrying.',
          );
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    const contextChanged = () => {
      setState(null);
      setError('');
    };
    window.addEventListener('convoy-context-changed', contextChanged);
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener('convoy-context-changed', contextChanged);
    };
  }, [taskId, overview, enabled]);

  return { state, error };
}

export function owns(session?: Session) {
  return session?.lease?.client === client && session.lease.expiresAt > Date.now();
}
