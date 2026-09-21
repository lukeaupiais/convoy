type Props = { className?: string; title?: string };

/** Three small ships in formation: the product mark, kept geometric for tiny sizes. */
export function ConvoyMark({ className = '', title }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 36 36"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <g fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M18 4v12m0-10 7 8h-7M17 8l-5 6h5" strokeWidth="1.7" />
        <path d="M10 17h17l-3 5H14z" fill="currentColor" strokeWidth="1.2" />
        <path d="M7 15v7m0-6 4 5H7m-1-3-3 3h3M3 23h9l-2 3H5z" strokeWidth="1.25" />
        <path d="M29 17v6m0-5 4 4h-4m-1-2-3 3h3m-3 1h9l-2 3h-5z" strokeWidth="1.25" />
        <path d="M4 29c4 2 7 2 11 0s7-2 11 0 6 1 8 0" strokeWidth="1.35" />
        <path d="M10 32c3 1 6 1 9 0s6-1 9 0" strokeWidth="1" opacity=".55" />
      </g>
    </svg>
  );
}
