import { useEffect } from 'react';
import { Bell } from 'lucide-react';
import { useRuntime, type RuntimeState } from '../../shared/api/runtime';
import { useDetailsPopover } from '../../shared/ui/useDetailsPopover';
import { attentionItems, type AttentionTarget } from './attention';
import './attention.css';

export function AttentionMenu({
  state,
  unavailable,
  loadGlobal,
  open,
}: {
  state: RuntimeState | null;
  unavailable: boolean;
  loadGlobal: boolean;
  open: (target: AttentionTarget) => void;
}) {
  const global = useRuntime(undefined, false, loadGlobal);
  const current = loadGlobal ? global.state : state;
  const disconnected = loadGlobal ? !!global.error : unavailable;
  const menu = useDetailsPopover();
  const items = current ? attentionItems(current) : [];
  const scope = JSON.stringify([
    current?.deployment?.id,
    current?.currentUser?.id,
    current?.activeContext?.id,
  ]);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [scope, menu]);
  return (
    <details className="attention-menu" ref={menu}>
      <summary
        aria-label={`Needs attention${items.length ? `, ${items.length} items` : ''}`}
        title="Needs attention"
      >
        <Bell size={18} aria-hidden="true" />
        {!!items.length && (
          <span className="attention-count" aria-hidden="true">
            {items.length}
          </span>
        )}
      </summary>
      <section className="attention-panel" aria-label="Needs attention">
        <header>
          <strong>Needs attention</strong>
        </header>
        {disconnected || !current ? (
          <p role="status">
            {disconnected ? 'Unable to refresh attention.' : 'Loading attention…'}
          </p>
        ) : (
          !items.length && <p>Nothing needs attention.</p>
        )}
        {!!items.length && (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (menu.current) {
                      menu.current.open = false;
                      menu.current.querySelector('summary')?.focus();
                    }
                    open(item.target);
                  }}
                >
                  <strong>{item.title}</strong>
                  <span>{item.status}</span>
                  <small>{item.reason}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </details>
  );
}
