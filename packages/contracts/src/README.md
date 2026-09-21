# Contract source

Top-level files describe process-level messages; `model` describes reusable domain
read models. `index.ts` is the public surface. Keep all exports serializable and
free of React, Node runtime, persistence, or provider types.

Prefer action-keyed maps and discriminated unions over generic payload bags. They
keep callers precise while allowing the daemon to reject unknown or malformed
fields before dispatch.
