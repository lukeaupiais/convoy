# Web application

The React/Vite application presents daemon state and sends typed commands. It may
optimistically manage drafts and view state, but it never owns tickets, workflow
runs, approvals, leases, or runner assignment.

- `src/app` composes routes/navigation and top-level state.
- `src/features` contains cohesive user-facing capabilities.
- `src/shared` contains the daemon client, small UI primitives, and global styles.

Depend on `packages/contracts`, not daemon implementation. Keep feature-specific
styles beside their feature. Browser behavior tests live in `tests/web`; full
operator flows live in `tests/acceptance`.
