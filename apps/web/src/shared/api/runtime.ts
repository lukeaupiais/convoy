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
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Request failed');
  return value as T;
}

export async function command<Action extends RuntimeAction>(
  action: Action,
  input: RuntimeCommandInputMap[Action],
) {
  const result = await api<CommandEnvelope<RuntimeCommandResultMap[Action]>>('/api/runtime', {
    action,
    client,
    ...input,
  });
  if (action === 'selectActiveContext') {
    contextGeneration++;
    window.dispatchEvent(new Event('convoy-context-changed'));
  }
  return result;
}

export function useRuntime(taskId?: number) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const generation = contextGeneration;
      try {
        const value = await api<RuntimeState>(`/api/runtime${taskId ? `/${taskId}` : ''}`);
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
  }, [taskId]);

  return { state, error };
}

export function owns(session?: Session) {
  return session?.lease?.client === client && session.lease.expiresAt > Date.now();
}
