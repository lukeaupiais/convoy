# Documentation

This directory contains maintained project documentation published with the
repository. Internal research, comparisons, implementation plans, assignments,
and review records belong in the ignored root `research/` directory. See
[Contributing](../CONTRIBUTING.md#documentation-and-internal-research) for the
publication rule.

## Running Convoy

- [Getting started](../README.md#get-it-running)
- [Desktop builds](desktop.md)
- [Portable local and SSH workers](portable-workers.md)
- [Deployment persistence, migration, and backup](architecture/persistence.md)
- [Command execution](command-execution.md)
- [Browser verification through the shell](architecture/browser-shell-verification.md)

## Architecture and contracts

Start with the [architecture overview](architecture/README.md) for dependency
rules and ownership. Source READMEs describe the boundaries within each directory.

- [Durable automation](architecture/durable-automation.md)
- [Workflow interaction and ticket workspaces](architecture/workflow-interaction.md)
- [Automations and workflow selection](architecture/workflow-selection-and-automation-spec.md)
- [Board automation visibility](architecture/board-workflow-visibility-spec.md)
- [Structured workflow submissions](architecture/structured-submissions.md)
- [Approved workflow replies](architecture/approved-workflow-replies.md)
- [Execution policy and runner authority](architecture/execution-access.md)
- [Module command ownership](architecture/module-command-registry.md)
- [Provider boundary](architecture/provider-boundary.md)
- [Prompt caching](architecture/prompt-caching.md)
- [Tool and approval contract](architecture/tool-harness.md)
- [Declarative extensions](architecture/extensions.md)
- [Wiki foundation](architecture/wiki-foundation.md)
- [Wiki reading and authoring interface](architecture/wiki-interface.md)

## Maintained specifications

These describe implemented foundations and their intended extensions. Read each
document's status and scope before treating a behavior as available. Proposed
sections are design requirements, not evidence of a shipped capability.

- [Model providers, organizations, and client access](architecture/model-providers-organizations-and-client-access.md)
- [Disposable verification runtimes](architecture/disposable-verification-runtime-spec.md)
- [Board integrations](board-integrations-spec.md)
- [Custom ticket sources](custom-ticket-source-spec.md)
- [Ticket sync bindings, project routing, and board projection](ticket-sync-bindings-spec.md)

Reusable configuration and browser resources live in `docs/examples/` and the
example files alongside these guides. Tests verify behavior at the corresponding
boundary; research notes and historical review records are not runtime contracts.
