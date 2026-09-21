# Agents

Owns deterministic model-facing context composition: instruction precedence,
stable prefix epochs, and untrusted runtime context. It does not call providers or
execute tools. Provider transport is injected by the control plane.

Approval decisions and answers to pending questions are lease-authorized Agent
session commands. The control plane supplies the session/lease gate; this module
forwards the response to the durable turn policy.
