---
name: browser-ui-investigation
description: Investigate application behavior through an authorized browser UI using Playwright from the shell, with reusable session handling and evidence checks.
---
# Work through the browser
Use the runtime's declared browser connection, installed Node/Playwright path and writable scratch directory. This skill grants no access or permission to mutate data. Follow the current task and runtime boundaries.

Read `scripts/browser-session.cjs` with read_skill_resource once and copy it into writable scratch using shell. Skill resources are text, not installed files. Reuse this module for short Node scripts; keep connection, timeouts and error handling in one place. Copy the resource as provided rather than rewriting its internals. It passively records same-origin JSON responses from the UI actions you perform, prints a bounded preview, and writes a redacted evidence file beside the helper. These are observations, not conclusions; compare them with what the screen shows. Read the captured file selectively if the preview is truncated, and cite the file when it supports your finding. Authentication endpoints and credentials are excluded; capture is bounded and may omit responses. It does not send requests or change application behavior. Pass the declared module path and CDP endpoint explicitly. Use the existing page and preserve its state; do not close the shared page or context. If the runtime has a different browser lifecycle, follow its guidance instead of assuming CDP is available.

Example caller (replace placeholders from runtime guidance):
```js
const { withPage, snapshot } = require('/WRITABLE_SCRATCH/browser-session.cjs');
withPage({modulePath: 'DECLARED_PLAYWRIGHT_MODULE', cdpEndpoint: 'DECLARED_CDP_ENDPOINT'}, async page => {
  console.log(await snapshot(page.locator('body')));
  // Add actions using observed locators, and print their relevant results.
}).catch(error => { console.error(error.message); process.exitCode = 1; });
```
Give shell commands enough time for the bounded actions and recovery to finish. Batch a short sequence when its controls are known; inspect at uncertain transitions. Use current UI labels/roles. After a failed action, read the returned error and current state before retrying; do not blindly repeat or toggle the same control. If a save fails because required inputs are missing, resolve those prerequisites before interpreting the behavior under investigation.

Verify outcomes at the point of action: a click or enabled button is not proof of a completed transition. Capture the relevant values and status. If claiming a change persisted, reload or reopen AFTER the mutation and capture those same values/status again. Label any unexecuted path or unavailable original condition accurately.

Use selective snapshots around relevant controls to keep output small without dropping evidence needed for the conclusion. Use the working Node runtime and built-in fs to write evidence and the investigation record; do not assume another interpreter exists. A failed evidence write is recoverable with the available tools. Verify the file exists and contains the intended result before citing it.
