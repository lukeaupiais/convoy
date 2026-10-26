# Native CLI

The CLI is another client of the daemon. It lists sessions, attaches a line-based
inline conversation REPL, and connects the user's real terminal to the assigned runner.
It must preserve the same lease, approval, workflow, and reconciliation rules as
the web UI.

## Start a conversation

With the daemon running, use `npm run chat` from the repository to create a
conversation in the active project and open the conversation REPL with control
already claimed. Type your first message directly; `/quit` disconnects and releases
control without stopping the agent.

```sh
npm run chat
npm run chat -- "Investigate the import failure"
npm run chat -- --title "Review the release" --project PROJECT_ID
```

The command uses the selected deployment profile and context, just like `attach`.
It prints the new session ID, so you can reconnect later with
`npm run attach -- chat-SESSION_ID`. Creation is not retried automatically when
the response is lost; inspect `npm run sessions` before creating another chat.

## Conversation REPL

Chat and attach share an inline terminal interface with normal scrollback.
A compact Convoy header identifies the conversation, model and project. User
messages are visually separated from assistant replies, Markdown headings and
code blocks are formatted, and approvals appear in distinct panels. Replies
stream above a framed input area with a status line below it. The composer
preserves its draft and cursor during updates and terminal resizing.
Streaming updates share a short render interval, with completed responses shown
immediately. While work is active, the status line shows an animated indicator
and elapsed time, identifying response generation or the current tool. It stops
animating when work finishes or a decision is required.
Typed edits update directly without repainting the whole composer. Submitted
messages appear immediately with a sending indicator while the daemon responds;
confirmation does not duplicate the message. If delivery cannot be confirmed,
inspect `/pending` before resending.
Tool activity is summarized. `/details` shows
the last tool result, while `/workflow`, `/pending` and `/context` provide
explicit inspection without dumping internal event records into conversation.

- **Tab** completes slash commands; **Up/Down** recalls input from this session.
- **Enter** sends; **Shift+Enter** adds a line in terminals that send a distinct
  key sequence. **Alt+Enter** also adds a line. End a line with `\` as a fallback.
- Bracketed paste keeps multi-line text in the editor until you press **Enter**,
  including text that contains slash commands. Newline shortcuts and paste
  handling apply to interactive terminals; piped input keeps its line protocol.
- **Ctrl+C** clears a draft. With empty input it disconnects an idle session;
  active work requires an explicit `/stop` or `/quit`.
- **Ctrl+D** or `/quit` disconnects and releases control without stopping work.
- `/help` lists all commands; `/clear` clears the display.

Approval prompts show the proposed action and exact `/approve ID` and `/deny ID`
commands. They never choose an outcome automatically. Read-only attachment keeps
message, approval and execution commands unavailable.

Live updates use the authenticated daemon event stream. A lost stream falls back
to reading recorded state and reconnects without replaying commands. Existing
leases and credentials apply to both transports. Redirects and updates for a
different session are refused. Non-interactive input/output remains plain text
without terminal escape sequences.

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
