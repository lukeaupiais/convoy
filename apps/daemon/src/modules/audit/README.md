# Security audit

Owns append-only, tenant-scoped security evidence. Records are normalized through
an allowlist, chained by digest, and exposed only through bounded organization
queries and exports. The module never accepts or projects provider credentials,
host credentials, request bodies, prompts, command environments, or raw errors.

Callers supply decisions and durable identifiers through the small `record` port.
Authentication and authorization stay with their owning domains; transport and
external log sinks belong in adapters.
