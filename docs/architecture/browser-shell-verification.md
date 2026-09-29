# Browser verification through the shell

A browser is an execution dependency, not a new Convoy tool. An agent can run
Playwright through `shell` in a `verify` runtime. Repository inspection alone
does not provide this capability: the `inspect` profile intentionally denies
network access and writable browser state.

## Project configuration

The project supplies a pinned runtime image containing Node, a pinned Playwright
package, its matching Chromium build and system dependencies. Install these when
building the image, not during an agent investigation. See the official
[Playwright Docker guide](https://playwright.dev/docs/docker).
An illustrative [base Dockerfile](../examples/browser-runtime/Dockerfile) supplies
these dependencies; publish the resulting immutable image ID, not its mutable tag.

The runtime definition provides:

- Startup for the actual application and disposable data services on private
  loopback, and readiness that verifies they work.
- Guidance identifying the application URL, synthetic login, allowed changes,
  dependency paths and evidence location. Never copy a production browser profile
  or production credentials into the image.
- Sufficient memory, scratch space, process allowance and command duration for
  the application and Chromium together.

`limits.sharedMemoryMb` optionally sizes private `/dev/shm` (1–1,024 MB, no
larger than `memoryMb`). Omission preserves the previous 1 MB limit. The runner
checks the actual size against the pinned definition; usage remains charged to
the container memory limit. Databases may need more than 1 MB even to initialize.
This does not grant host IPC or extra memory outside the declared envelope.

The workflow selects that runtime and the `verify` execution profile. Its
capability profile exposes the existing shell and file tools. Application routes,
fixtures and credentials remain project configuration; Convoy has no customer
or ticket-specific browser behavior.

## Command lifecycle

The container uses an init process to reap exited descendants. Managed application
services can create workers; cleanup distinguishes their descendants from new
unmanaged processes by process identity and ancestry. Init and the launcher do
not count as service owners, so orphaning an agent command does not authorize it.
A browser command
must still close all browser processes before it returns. Persistent CLI browser
daemons started by a command are not supported by this runtime: unmanaged live
processes close the generation. Use bounded Node/Playwright scripts with
`try/finally` and `await browser.close()`; persist browser storage state under
`/scratch` when a later command needs the same login.

For an interactive investigation across commands, project startup can launch a
managed Chromium service with a private loopback CDP endpoint and a profile under
`/scratch`. Shell scripts use `chromium.connectOverCDP`, reuse the default context
and page, then call `browser.close()` to disconnect the client. They must not close
the shared page/context or send the CDP `Browser.close` command. The managed page
retains login, navigation and unsaved form state across shell calls; the whole
browser is destroyed when the runtime ends. No host debugging port is exposed.
Startup receives a restricted environment. Set dependency locations explicitly
in its script (for the example image, `PLAYWRIGHT_BROWSERS_PATH=/opt/browsers` and
the absolute Playwright package path); do not rely on inherited image variables.

For an image installing Playwright at `/opt/browser/node_modules`, scripts can
use `require('/opt/browser/node_modules/playwright')`. Use a writable directory
under `/scratch` for browser temporary data and artifacts. No public egress,
host networking, Docker socket, elevated container capabilities or host IPC is
required to test the private application.

## Evidence and limits

Observe the UI, relevant network responses and state after reload. A mocked HTTP
response does not reproduce application behavior. Record the environment, inputs,
actions, observations and remaining uncertainty in a bounded JSON/text artifact.
The current runtime seals UTF-8 artifacts only; binary screenshot/trace capture
and model image viewing are separate, currently unimplemented capabilities.
DOM/accessibility snapshots and network observations can be inspected through
shell output. Do not claim visual screenshot inspection from text alone.

This configuration does not grant access to an existing external staging or
production deployment. Such access requires an explicit environment policy;
do not silently widen the private runtime to reach it.

## Regression check

`tests/runner/browser-runtime.test.mjs` uses an unrelated notebook application:
Playwright clicks Save, reloads, verifies state, closes the temporary browser and
seals observations through the normal supervised runtime. It also verifies that
separate shell clients retain unsaved form state in a managed browser, while the
application starts a new worker in response to a request. Run with
`CONVOY_BROWSER_TEST_IMAGE=sha256:<approved-image>` and
`CONVOY_REQUIRE_BROWSER=1`. The image must provide `require('playwright')` via
`NODE_PATH` and matching browsers via `PLAYWRIGHT_BROWSERS_PATH`.

## Recoverable command deadlines

The in-container GNU timeout owns the command process group and applies the
requested deadline, including subsecond durations. The host supervisor allows
up to two additional seconds for Docker to report termination; this does not
extend command execution. Runtime expiry still bounds the whole generation.
After command exit, the runner checks process identities and ancestry before
allowing another command. Clean command timeout preserves the managed app and
browser; escaped descendants or uncertain cleanup close the generation. The
host watchdog, explicit cancellation and disconnect remain fail-closed.

Use Playwright action deadlines shorter than shell deadlines. For example,
set the page default action timeout to 5 seconds and navigation timeout to 10
seconds within a 20-second shell command. Catch errors, report the current URL
and a bounded accessibility snapshot, and disconnect in finally. Snapshot
collection must have its own short timeout and error handler. Preserve the
shared page and context. The agent can then inspect the observed controls and
retry a locator without losing login or unsaved state.

The browser regression exercises both a missing locator with diagnostic output
and a hard command deadline, then verifies the unsaved form and application state
survive. The runtime regression also verifies group cleanup and rejection of
escaped processes. No application-specific process classification is introduced.
