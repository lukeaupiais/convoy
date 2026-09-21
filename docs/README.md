# Documentation

Start with the [architecture overview](architecture/README.md) for dependency
rules and module ownership. Use the terms defined by the owning modules and
shared contracts when changing code or UI copy.

- [Execution policy and runner authority](architecture/execution-access.md)
- [Model providers, organizations, and client access](architecture/model-providers-organizations-and-client-access.md)
- [Module command ownership](architecture/module-command-registry.md)
- [Provider boundary](architecture/provider-boundary.md)
- [Tool and approval contract](architecture/tool-harness.md)
- [Workflow selection and start automations](architecture/workflow-selection-and-automation-spec.md)
- [Extension contract](architecture/extensions.md)
- [Command execution](command-execution.md)
- [Portable local and SSH workers](portable-workers.md)

Architecture documents describe current boundaries and note unfinished work
where relevant. The nearest source README describes ownership within a directory;
tests verify behavior at the corresponding boundary.
