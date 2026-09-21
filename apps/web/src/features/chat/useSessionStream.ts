import { useEffect, useState } from 'react';
import type { Session } from '../../shared/api/runtime';

export function useSessionStream(id: string, fallback?: Session) {
  const [live, setLive] = useState<Session | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting'>(
    'connecting',
  );
  useEffect(() => {
    setLive(null);
    setConnection('connecting');
    let active = true;
    const source = new EventSource(`/api/runtime/${encodeURIComponent(id)}/events`);
    source.addEventListener('session', (event) => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as Session;
        if (!active) return;
        setLive((previous) =>
          previous && (previous.streamVersion ?? 0) > (next.streamVersion ?? 0)
            ? { ...next, partial: previous.partial, streamVersion: previous.streamVersion }
            : next,
        );
        setConnection('live');
      } catch {
        source.close();
        setConnection('reconnecting');
      }
    });
    source.addEventListener('partial', (event) => {
      try {
        const update = JSON.parse((event as MessageEvent).data);
        if (!active) return;
        setLive((previous) =>
          !previous || update.id !== previous.id || update.version < (previous.streamVersion ?? 0)
            ? previous
            : {
                ...previous,
                partial: update.text,
                streamVersion: update.version,
                updatedAt: update.updatedAt,
              },
        );
      } catch {
        /* Next snapshot is authoritative. */
      }
    });
    source.onerror = () => {
      if (active) {
        setLive(null);
        setConnection('reconnecting');
      }
    };
    return () => {
      active = false;
      source.close();
    };
  }, [id]);
  return { session: live ?? fallback, connection };
}
