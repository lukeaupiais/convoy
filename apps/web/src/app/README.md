# Application shell

This directory owns bootstrapping, navigation, page composition, and global view
selection. It may import every web feature. It must not accumulate feature rules,
daemon policy, or reusable presentation primitives.

When `main.tsx` becomes difficult to scan, extract composition hooks or route
layouts here; keep domain behavior in its feature.

`routes.ts` maps each page to a shareable hash route (`#/board`, `#/chat/<id>`,
`#/workflows/runs/<id>`, `#/settings/<section>`), with an open ticket carried as
`?ticket=<id>`. The shell keeps the address bar in step with the visible page and
follows Back and Forward. Wiki links keep their own `#wiki?…` format.
