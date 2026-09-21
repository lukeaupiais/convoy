# Shared daemon primitives

Only small, stable primitives used across several domain modules belong here.
`validation.mjs` currently owns common input validation. Prefer domain-local code
until reuse is proven; this directory must not become a miscellaneous utility bin.
