# Web source

`app/` composes top-level pages and navigation. `features/` owns domain UI and
feature-scoped styles; cross-feature reusable controls live in `shared/`.
Workflow editor state is intentionally separate from the wire model and passes
through `features/workflows/workflow-codec.ts` when loading or publishing.

Dependency direction is `app -> features -> shared/contracts`. Feature-to-feature
imports are allowed only for an intentional product concept; move truly shared
behavior to `shared` instead of creating circular dependencies.

Components should receive domain data and callbacks, not know daemon storage
shape beyond the published contracts. Accessibility, keyboard behavior, compact
mobile layouts, and reconnect states are part of feature completeness.
