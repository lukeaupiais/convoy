# Runner package

Provider-neutral machinery for agent loops, supervised commands, terminals, and
worker RPC. This package owns execution mechanics; daemon policy decides when an
operation is allowed and which runner receives it.

All long-running operations need explicit cancellation, bounded output, terminal
state, and disconnect semantics. A lost transport after mutation is not success.
Tests live in `tests/runner`.

## Local code intelligence

The optional `deepthought` extension adapter uses the separately provisioned
DeepThought SDK 0.2.4a1 on Linux. It does not install packages, execute indexers,
call models, or start a service. Configure `CONVOY_DEEPTHOUGHT_PYTHON` with an
absolute virtualenv Python path on each runner host, outside assigned workspaces.
Local and SSH workers use the same adapter and protocol; remote workers need
their own installation and environment configuration. Bubblewrap namespaces must
work before the adapter is advertised.

Publish the exported `deepThoughtExtensionManifest` through the Library's reviewed
`publishExtension` command, then pin its exact revision and hash in a capability
profile. Configuration alone does not grant a session the tool. The
`code_intelligence` tool accepts `definitions`, `references`, or `dependencies`.
References and dependencies require an existing working-directory-relative SCIP
`index`; references require an exact `symbol`, and dependencies require a `file`.
Without an index, only Python/TypeScript/TSX syntax definitions are available.

Queries run with the selected working directory mounted read-only, private
scratch space, no network and no inherited credentials or repository Python
configuration. Source and index reads, process time and output are bounded.
Results retain snapshot identity, capabilities, diagnostics, coverage and explicit
resolution states; dependency edges describe references, not calls. Match limits
and truncated candidate/witness lists are reported explicitly.

The adapter invokes the SDK's `query_graph` interface and returns query schema 1
without reshaping its query fields. It adds `engine_version` from the installed
SDK and a separate `source_consistency` record for the same source snapshot.
The sandbox captures its own analysis artifact in private scratch space and invokes
the SDK's `check-source` CLI with the assigned root/repository. This compares only
recorded Tree-sitter source bytes. A record can be unchanged, changed, or
unverified; retain its per-file reasons, cancellation state and coverage counts.
SCIP document hashes remain unverified. `workspace_freshness` always remains
`"unverified"`: additions, incomplete capture and changes after each sequential
comparison are outside this check. Neither record authorizes source navigation. Definition matches include graph identity and a
nested `definition` containing the symbol and source location. Reference targets
and dependency witnesses retain their identities, counts and truncation flags.
The runner's output limit covers the query, engine version, consistency record
and final newline together. The adapter reserves the evidence members' exact
UTF-8 size before asking the SDK to truncate query matches into the remaining
budget. An oversized consistency record or insufficient space for required query
metadata fails the request without dropping evidence. The checker uses the same
200-file, 1 MB/file and 10 MB total source limits as capture, with a 10 MB analysis
artifact limit. These bounds are not a hard memory bound. When the transport limit
is below the SDK's 1024-byte minimum, the bridge uses a 32,000-byte engine budget;
the runner still independently enforces the smaller transport limit. Input
confinement, process deadlines and cancellation remain runner responsibilities.

This changes the extension revision to `sdk-0.2.4a1-adapter-3`. Existing reviewed
profiles are not rewritten: publish and review the new manifest, update the
profile's exact revision/hash, and provision SDK 0.2.4a1 on the selected runner
before granting the new revision. The adapter rejects old revisions and SDKs. The dedicated integration workflow
installs immutable SDK commit `5e80a0074566e4d890a41f6d453f94cda44289d5`.
Both source and compiled workers are tested locally without Theia. The dedicated
workflow also runs a real loopback SSH server with disposable keys and home
storage. It uses strict host-key verification, the production worker uploader,
and a reviewed capability profile/session grant. Coverage includes source edits,
SCIP uncertainty, assignment/revision rejection, an unprovisioned remote runtime,
worker exit after connection termination, and graceful exit on SSH stdin EOF. This proves SSH protocol execution on one
machine; acceptance on a separately provisioned host remains a separate gate.

To run this acceptance locally after building the worker, set
`CONVOY_TEST_DEEPTHOUGHT_SSH=1`, `CONVOY_TEST_DEEPTHOUGHT_PYTHON` to the installed
SDK's absolute Python path, and `CONVOY_TEST_COMPILED_WORKER` to the built worker.
Run `node --test --test-timeout=60000 tests/acceptance/deepthought-ssh.test.mjs`.
OpenSSH client/server and functioning Bubblewrap are required; set
`CONVOY_TEST_SSHD` if the server is outside `/usr/sbin/sshd`. An explicit SSH opt-in
with missing prerequisites fails rather than skipping. The test starts only a
loopback listener and removes its temporary keys, worker copy and workspace.

Foreground and supervised shell commands accept up to 32,000 characters, so
ordinary multiline scripts and evidence writes fit in one operation. Oversized
commands report the measured length, limit and recovery. Execution grants,
sandboxing, timeouts and the daemon's aggregate argument bound still apply.

Disposable runtime operations serialize inside each worker while retaining the
durable lock against other workers and abandoned operations. Container creation,
start and readiness share the configured startup deadline, bounded by total
runtime lifetime. Interrupted creation is reconciled using the recorded name,
identity label, image and resource envelope; missing identity evidence remains
uncertain. Independent expiry is installed before container creation.

SDK runtime probes run only after a workspace is known and its configured and
canonical interpreter paths have been checked. Manually created adapters defer
probing until their first query unless `workingDirectory` is supplied to the
factory. Default runner discovery checks health before advertising the adapter.
