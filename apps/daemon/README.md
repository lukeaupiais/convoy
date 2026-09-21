# Daemon application

The daemon is Convoy's authoritative control plane. It owns durable state,
coordinates domains, enforces approvals and leases, streams changes, and delegates
execution through adapters. Browser and CLI clients are untrusted callers of the
same command boundary.

The daemon binds to loopback only. Provider credentials must not be copied to
workers. A disconnect after a possible mutation is an uncertainty boundary, not a
successful or safely retryable operation.
