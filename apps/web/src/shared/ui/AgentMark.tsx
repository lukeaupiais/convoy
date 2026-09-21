/** A stable visual signature shared by every surface displaying this agent. */
export function AgentMark({ id, active = false }: { id: string; active?: boolean }) {
  const hash = [...id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return (
    <svg
      className={`agent-mark ${active ? 'is-running' : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ color: `hsl(${150 + (hash % 35)} 28% 36%)` }}
    >
      <g transform={`rotate(${(hash % 4) * 90} 12 12)`}>
        <rect x="3" y="3" width="8" height="8" rx={hash % 2 ? 4 : 2} fill="currentColor" />
        <rect x="13" y="3" width="8" height="8" rx="4" fill="currentColor" opacity=".25" />
        <rect x="3" y="13" width="8" height="8" rx="4" fill="currentColor" opacity=".25" />
        <rect
          x="13"
          y="13"
          width="8"
          height="8"
          rx={hash % 2 ? 2 : 4}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </g>
    </svg>
  );
}
