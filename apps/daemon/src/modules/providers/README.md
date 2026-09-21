# Providers domain

This module owns provider connections, observed model offerings, logical model
routes, immutable provider grants, usage/outcome evidence, and domain-level
provider governance.

Provider protocol and credential I/O remain in adapters. The module accepts only
references and bounded evidence; it never stores plaintext credentials or calls
an upstream provider. Other daemon modules import the public surface from
`index.mjs`.
