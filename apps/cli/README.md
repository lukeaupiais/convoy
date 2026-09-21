# Native CLI

The CLI is another client of the daemon. It lists sessions, attaches a line-based
conversation REPL, and connects the user's real terminal to the assigned runner.
It must preserve the same lease, approval, workflow, and reconciliation rules as
the web UI.

Do not add a second local execution path here. Commands should go through the
daemon unless their sole purpose is interactive terminal transport.

## Client credentials

Client profiles contain deployment identity, the local device identifier, and
the last explicitly selected organization context. Access tokens and device
credentials are never written to `client-profiles.json` and there is no
plaintext fallback when an OS credential service is missing.

| Host    | Secure store                                     | Behavior                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | Secret Service through `secret-tool`             | The serialized credential is written on stdin and is not included in process arguments. A desktop Secret Service session is required.                                                                                                                                                                                              |
| macOS   | Login Keychain through `/usr/bin/security`       | The credential is base64-enveloped and supplied to the command's interactive stdin, never as a process argument.                                                                                                                                                                                                                   |
| Windows | DPAPI `CurrentUser` protected, device-local blob | Windows' built-in `cmdkey` cannot retrieve generic credentials, so Convoy uses DPAPI rather than claiming Credential Manager support. The opaque file is stored below `%LOCALAPPDATA%\\Convoy\\credentials`; its name is a digest of the credential reference, and inheritance is removed so only the current user SID has access. |

`CONVOY_TOKEN` and `CONVOY_DEVICE_CREDENTIAL` remain explicit process-scoped
overrides for automation. They are consumed from the environment and are not
persisted by the CLI. An unavailable keychain, DPAPI failure, malformed stored
value, or unsupported operating system fails closed.
