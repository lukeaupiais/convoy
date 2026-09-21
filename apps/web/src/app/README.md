# Application shell

This directory owns bootstrapping, navigation, page composition, and global view
selection. It may import every web feature. It must not accumulate feature rules,
daemon policy, or reusable presentation primitives.

When `main.tsx` becomes difficult to scan, extract composition hooks or route
layouts here; keep domain behavior in its feature.
