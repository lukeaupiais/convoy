# Shared web infrastructure

- `api` is the typed daemon boundary and the only place for raw runtime commands.
- `ui` contains genuinely reusable presentation primitives with no domain policy.
- `lib` contains small browser-specific helpers.
- `styles` contains global tokens, identity, layout, and responsive rules.

`styles/tokens.css` is the only place that defines colour, type, spacing, and
shape values. Feature styles read its `--color-*`, `--text-*`, `--space-*`, and
`--radius-*` variables rather than hard-coding values. The older `--ink`,
`--surface`, and `--line` names remain as aliases while features migrate.

Do not turn this directory into a catch-all. Code used by only one feature stays
with that feature.
