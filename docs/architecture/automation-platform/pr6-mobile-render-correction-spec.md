# PR 6 mobile render-loop correction

## Reproduction

Use the isolated phone preview at 390×844 with touch emulation. Choose the
`Procurement preview` project, open Workflows → Runs, select the existing
`Vendor quote review` run, then claim and release control. Before the correction,
Chrome reports repeated `Maximum update depth exceeded` errors. The reported
flow is no-session and uses the configured human form.

## Finding

The React stack identifies `BoardStudio.tsx:124`, not the human task panel. A
project without a persisted board uses a fallback object created inline on each
render. The `useEffect` that copies `board` into the local draft depends on that
object and calls `setDraft(board)`. This produces a render/effect loop while the
board page is mounted. The hypothesis that task callback identities or lease
cleanup cause the loop was not supported by the stack; a separate disposable
human-run fixture did not reproduce it.

## Correction and proof

Memoize the board list and fallback by the current board collection and project
identity, so a local render reuses the same fallback object. Keep server board
collections as the source: new snapshots still produce a new collection and
allow legitimate board revisions to refresh the local draft. Do not change
board defaults, status semantics, or the human task component.

The regression seam is a real strict-mode browser render of a boardless project,
followed by the configured human run selection and claim/release actions. Verify
the console has no maximum-update-depth error, the form remains operable, and
the lease ends released. The product repository has no existing React DOM
component-test harness; a standalone disposable browser fixture is the useful
seam for this feedback loop. Keep all run/effect activity confined to the
isolated phone-preview sample data.
