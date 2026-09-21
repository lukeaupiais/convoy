import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid,
  MessageSquare,
  Activity,
  Workflow,
  BookOpen,
  Folder,
  Server,
  Cable,
  Pin,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { ConvoyMark } from '../shared/ui/ConvoyMark';
type Props = {
  page: string;
  navigate: (page: string) => void;
  open: boolean;
  close: () => void;
  collapsed: boolean;
  toggle: () => void;
  pins: { id: number; title: string }[];
  inspect: (id: number) => void;
  unpin: (id: number) => void;
};
export function Sidebar({
  page,
  navigate,
  open,
  close,
  collapsed,
  toggle,
  pins,
  inspect,
  unpin,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const [small, setSmall] = useState(() => matchMedia('(max-width:800px)').matches);
  useEffect(() => {
    const media = matchMedia('(max-width:800px)');
    const update = () => setSmall(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!small || !open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key !== 'Tab') return;
      const nodes = [
        ...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href]') ?? []),
      ].filter((n) => n.getClientRects().length);
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
        e.preventDefault();
        nodes[0]?.focus();
      }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      previous?.focus();
    };
  }, [small, open]);
  const primary = [
    ['Project board', 'Board', LayoutGrid],
    ['Chat', 'Chat', MessageSquare],
    ['Sessions', 'Sessions', Activity],
    ['Workflows', 'Workflows', Workflow],
    ['Skills & instructions', 'Library', BookOpen],
  ] as const;
  const settings = [
    ['Project settings', 'Projects', Folder],
    ['Providers', 'Providers', Cable],
    ['Runners', 'Environments', Server],
  ] as const;
  return (
    <aside
      id="main-sidebar"
      ref={ref}
      className={`sidebar app-navigation ${open ? 'open' : ''}`}
      inert={small && !open}
      aria-label="Workspace sidebar"
    >
      <div className="sidebar-brand">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('Project board');
          }}
          aria-label="Convoy home"
        >
          <span className="brand-mark">
            <ConvoyMark />
          </span>
          <span className="brand-copy nav-label-text">
            <strong>Convoy</strong>
            <small>Ship. Ship a lot.</small>
          </span>
        </a>
        <button className="drawer-close" aria-label="Close navigation" onClick={close}>
          <X size={18} />
        </button>
      </div>
      <nav aria-label="Main navigation">
        {primary.map(([id, label, Icon]) => (
          <button
            key={id}
            title={label}
            aria-label={label}
            aria-current={page === id ? 'page' : undefined}
            onClick={() => navigate(id)}
          >
            <Icon size={17} />
            <span className="nav-label-text">{label}</span>
          </button>
        ))}
      </nav>
      {pins.length > 0 && (
        <section className="sidebar-pins" aria-label="Pinned tickets">
          <div className="nav-section-label">
            <Pin size={13} />
            <span className="nav-label-text">Pinned</span>
          </div>
          {pins.map((t) => (
            <div className="pinned-row" key={t.id}>
              <button
                title={`CVY-${t.id} · ${t.title}`}
                aria-label={`Open pinned ticket ${t.title}`}
                onClick={() => inspect(t.id)}
              >
                <Pin size={14} />
                <span className="nav-label-text">{t.title}</span>
              </button>
              <button
                className="unpin nav-label-text"
                aria-label={`Unpin ${t.title}`}
                onClick={() => unpin(t.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </section>
      )}
      <div className="navigation-bottom">
        <nav aria-label="Configuration">
          {settings.map(([id, label, Icon]) => (
            <button
              key={id}
              title={label}
              aria-label={label}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={17} />
              <span className="nav-label-text">{label}</span>
            </button>
          ))}
        </nav>
        <button
          className="collapse-sidebar"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggle}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className="nav-label-text">Collapse sidebar</span>
        </button>
      </div>
    </aside>
  );
}
