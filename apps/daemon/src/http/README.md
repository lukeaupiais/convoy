# HTTP boundary

Owns request limits, origin/host checks, deployment-session authentication,
serialization, status codes, SSE, and mapping runtime errors to safe client
responses. It resolves a user or workload principal through an injected identity
session port and passes that principal to the control plane; it does not decide
whether the principal may perform a command.

Keep endpoints thin and test protocol behavior in acceptance tests. A remotely
reachable daemon must require authenticated device sessions and an explicit host,
origin, and secure-cookie policy. Provider login under `/api/auth/*` is separate
from Convoy deployment login under `/auth/*` and must never establish a Convoy
principal.

When the desktop bootstrap supplies a built static directory, this boundary serves
only the UI entry point and Vite assets after the same host/origin checks. API
routes keep their existing authentication and command policy.
