# Shared web infrastructure

- `api` is the typed daemon boundary and the only place for raw runtime commands.
- `ui` contains genuinely reusable presentation primitives with no domain policy.
- `lib` contains small browser-specific helpers.
- `styles` contains global tokens, identity, layout, and responsive rules.

Do not turn this directory into a catch-all. Code used by only one feature stays
with that feature.
