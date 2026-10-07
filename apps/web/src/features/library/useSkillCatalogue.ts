import { useCallback, useEffect, useRef, useState } from 'react';
import { command } from '../../shared/api/runtime';
import type { SkillCatalogue, SkillScope } from '../../../../../packages/contracts/src';

export function useSkillCatalogue(context: {
  scope?: SkillScope;
  runnerId?: string;
  workspaceId?: string;
  workingDirectory?: string;
  projectId?: string;
  organizationId?: string;
  userId?: string;
}) {
  const [catalogue, setCatalogue] = useState<SkillCatalogue>({ roots: [], sources: [] });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const { scope, runnerId, workspaceId, projectId, organizationId, userId, workingDirectory } =
    context;
  const contextKey = JSON.stringify([
    scope,
    runnerId,
    workspaceId,
    projectId,
    organizationId,
    userId,
    workingDirectory,
  ]);
  const keyRef = useRef(contextKey);
  keyRef.current = contextKey;
  const [resolvedContext, setResolvedContext] = useState('');
  const refresh = useCallback(async () => {
    const response = await command('refreshSkills', {
      scope,
      runnerId,
      workspaceId,
      projectId,
      workingDirectory,
    });
    if (keyRef.current !== contextKey) return response.result;
    setResolvedContext(contextKey);
    setCatalogue(response.result);
    setError('');
    setLoading(false);
    return response.result;
  }, [
    scope,
    runnerId,
    workspaceId,
    projectId,
    organizationId,
    userId,
    workingDirectory,
    contextKey,
  ]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // Context changes must never leave a previous principal's catalogue on screen.
    setCatalogue({ roots: [], sources: [] });
    setLoading(true);
    const poll = async () => {
      try {
        const response = await command('catalogueSkills', {
          scope,
          runnerId,
          workspaceId,
          projectId,
          workingDirectory,
        });
        if (live) {
          setResolvedContext(contextKey);
          setCatalogue(response.result);
          setError('');
          setLoading(false);
        }
      } catch (e) {
        if (live) {
          setResolvedContext(contextKey);
          setError((e as Error).message);
          setCatalogue({ roots: [], sources: [] });
          setLoading(false);
        }
      }
      if (live) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [
    scope,
    runnerId,
    workspaceId,
    projectId,
    organizationId,
    userId,
    workingDirectory,
    contextKey,
  ]);
  return {
    catalogue: resolvedContext === contextKey ? catalogue : { roots: [], sources: [] },
    error: resolvedContext === contextKey ? error : '',
    loading: resolvedContext !== contextKey || loading,
    refresh,
  };
}
