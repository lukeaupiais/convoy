import { useId, useLayoutEffect, useRef, useState, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Circle, Flag, Search, UserRound, X } from 'lucide-react';
import './select.css';

// Keep the native form contract (including FormData and change handlers), while
// presenting a keyboard-operable picker outside scroll/overflow containers.
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<{ value: string; label: string; disabled: boolean }[]>([]);
  const [selected, setSelected] = useState('');
  const [label, setLabel] = useState('Select');
  const [position, setPosition] = useState({ left: 0, top: 0, width: 240, maxHeight: 360 });
  useLayoutEffect(() => {
    const el = native.current!;
    setOptions(
      Array.from(el.options).map((o) => ({
        value: o.value,
        label: o.text,
        disabled:
          o.disabled ||
          (o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled),
      })),
    );
    setSelected(el.value);
    const labelCopy = el.labels?.[0]?.cloneNode(true) as HTMLElement | undefined;
    labelCopy?.querySelectorAll('.select-control').forEach((node) => node.remove());
    setLabel(props['aria-label'] ?? labelCopy?.textContent?.trim() ?? props.name ?? 'Select');
  }, [props.children, props.value, props.defaultValue, props['aria-label'], props.name]);
  const current = options.find((o) => o.value === selected);
  const shown = options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()));
  const kind = /priority/i.test(label)
    ? 'priority'
    : /agent/i.test(label)
      ? 'agent'
      : /status|move (?:AG|CVY)-/i.test(label)
        ? 'status'
        : '';
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(value: string) {
    const el = native.current!;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    setSelected(el.value);
    close();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const r = trigger.current!.getBoundingClientRect();
      const width = Math.min(Math.max(r.width, 240), window.innerWidth - 24);
      const below = window.innerHeight - r.bottom - 16;
      const above = r.top - 16;
      const height = Math.min(
        (panel.current?.scrollHeight ?? 344) + 16,
        360,
        Math.max(below, above),
      );
      setPosition({
        left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)),
        top: below >= Math.min(360, above) ? r.bottom + 6 : Math.max(12, r.top - height - 6),
        width,
        maxHeight: height,
      });
    };
    update();
    const focus = requestAnimationFrame(() =>
      panel.current
        ?.querySelector<HTMLElement>('input, [aria-selected="true"], [role="option"]')
        ?.focus(),
    );
    const pointer = (e: PointerEvent) => {
      if (
        !panel.current?.contains(e.target as Node) &&
        !trigger.current?.contains(e.target as Node)
      )
        close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (e.key === 'Tab') {
        const nodes = Array.from(
          panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') ?? [],
        ).filter((n) => n.getClientRects().length);
        e.preventDefault();
        e.stopImmediatePropagation();
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        nodes[(index + (e.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus();
      }
      if (
        ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) &&
        !(e.target instanceof HTMLInputElement && ['Home', 'End'].includes(e.key))
      ) {
        const nodes = Array.from(
          panel.current?.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)') ?? [],
        );
        e.preventDefault();
        e.stopImmediatePropagation();
        const index = nodes.indexOf(document.activeElement as HTMLElement);
        nodes[
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? nodes.length - 1
              : (index + (e.key === 'ArrowUp' ? -1 : 1) + nodes.length) % nodes.length
        ]?.focus();
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      cancelAnimationFrame(focus);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  function mark(text: string) {
    return kind === 'priority' ? (
      <Flag size={13} />
    ) : kind === 'agent' ? (
      <UserRound size={14} />
    ) : kind === 'status' ? (
      <Circle
        size={11}
        className={`picker-status status-${text.toLowerCase().replaceAll(' ', '-')}`}
      />
    ) : null;
  }
  return (
    <span className={`select-control ${props.className ?? ''}`}>
      <select
        {...props}
        className="select-native"
        ref={native}
        tabIndex={-1}
        aria-hidden="true"
        onInvalid={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        onChange={(e) => {
          setSelected(e.target.value);
          props.onChange?.(e);
        }}
      />
      <button
        type="button"
        className="select-trigger"
        ref={trigger}
        disabled={props.disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setQuery('');
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setQuery('');
            setOpen(true);
          }
        }}
      >
        {mark(current?.label ?? '')}
        <span>{current?.label || 'Choose…'}</span>
        <ChevronDown size={13} />
      </button>
      {open &&
        createPortal(
          <>
            <div className="select-scrim" aria-hidden="true" />
            <div
              id={id}
              ref={panel}
              role="dialog"
              aria-label={label}
              className="select-popover"
              style={position}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="select-heading">
                <span>{label}</span>
                <button type="button" aria-label="Close selection" onClick={close}>
                  <X size={16} />
                </button>
              </div>
              {options.length > 5 && (
                <div className="select-search">
                  <Search size={14} />
                  <input
                    aria-label={`Search ${label}`}
                    placeholder="Search…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              )}
              <div role="listbox" aria-label={label} className="select-options">
                {shown.map((o, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === selected}
                    disabled={o.disabled}
                    key={`${o.value}-${index}`}
                    onClick={() => choose(o.value)}
                  >
                    {mark(o.label)}
                    <span>{o.label}</span>
                    {o.value === selected && <Check size={14} />}
                  </button>
                ))}
                {!shown.length && <p>No matches</p>}
              </div>
            </div>
          </>,
          trigger.current?.closest('[role="dialog"]') ?? document.body,
        )}
    </span>
  );
}
