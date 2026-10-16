# Runner package

Provider-neutral machinery for agent loops, supervised commands, terminals, and
worker RPC. This package owns execution mechanics; daemon policy decides when an
operation is allowed and which runner receives it.

All long-running operations need explicit cancellation, bounded output, terminal
state, and disconnect semantics. A lost transport after mutation is not success.
Tests live in `tests/runner`.

## Local code intelligence

The optional `deepthought` extension adapter uses the separately provisioned
DeepThought SDK 0.2.1a1 on Linux. It does not install packages, execute indexers,
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
without reshaping its results. Definition matches include graph identity and a
nested `definition` containing the symbol and source location. Reference targets
and dependency witnesses retain their identities, counts and truncation flags.
The SDK receives the runner's output budget when it is at least 1024 bytes;
smaller transport limits are enforced independently by the runner. Input
confinement, process deadlines and cancellation remain runner responsibilities.

This changes the extension revision to `sdk-0.2.1a1-adapter-2`. Existing reviewed
profiles are not rewritten: publish and review the new manifest, update the
profile's exact revision/hash, and provision SDK 0.2.1a1 on the selected runner
before granting the new revision. The adapter rejects old revisions and SDKs.

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
