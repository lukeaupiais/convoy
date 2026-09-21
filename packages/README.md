# Packages

Packages contain reusable code with no application bootstrap side effects.

- `contracts` defines stable data exchanged between application boundaries.
- `runner` implements provider-neutral execution and supervision mechanisms.

Packages never import from `apps`. Keep their APIs smaller than their
implementations and add direct tests under the matching `tests` group.
