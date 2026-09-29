# Wiki foundation

Knowledge owns project-scoped collections, editable drafts, immutable published
Markdown revisions, archive state, and bounded retrieval. Library profiles select
collections and optionally an exact entry-page revision. Selection never grants
project access. The control plane checks the execution principal on every agent
knowledge request, including entry-page loading. Knowledge checks collection and
publication state again on every read. Revocation prevents new reads; it cannot
erase text already returned in conversation history.

The first implementation uses the existing durable state adapter, with unique
revision records. Page bodies are excluded from snapshots and read on demand.
This shares the existing single-coordinator memory limits: it is a bounded wiki
foundation, not an unbounded document service. Lexical section ranking is a pure,
rebuildable projection; SQLite and PostgreSQL persist the same canonical records.
No vector, extraction service, graph database or customer-specific rule is added.

Pages have stable UUIDs; `[label](wiki:PAGE_ID)` links support optional heading
anchors. Navigation resolves the currently published revision; evidence reads
specify the revision and return its hash, line range and headings. Drafts are
operator-only. Publishing and archiving require the current optimistic revision.
Profiles may reference at most eight collections in the same organization, and
an entry page must belong to a selected collection with at most 6000 characters.
Cross-project collections in a profile are inaccessible outside their project.

Agent tools expose bounded wiki search and revision reads, subject to profile
tool selection. They do not change repository search: that remains native CLI.
Entry content and tool output are reference data, not instruction authority.
The Wiki screen supports collection creation, draft editing, publication,
revision reading, search and archival. Existing profile UI selects knowledge.

## Using the foundation

1. Select a project and open **Wiki**. Create a collection, save a Markdown draft,
   and publish the saved draft. Editing a draft does not change published content.
2. In **Library → Profiles**, select the collection under **Knowledge**, optionally
   select a published entry page, and select `search_knowledge`/`read_knowledge`
   in the tools list. Leave workspace AGENTS.md loading disabled for profiles that
   do not need developer guidance.
3. Publish and apply that profile revision using the existing session, workflow,
   or project-default controls. Existing sessions retain their pinned profile.
4. Search returns published section references. Reads return the exact text,
   revision hash, heading metadata, visible outgoing links and bounded backlinks.
   Continue from `nextOffset` when a read is truncated.

Project readers can search and read published content. Project managers can edit,
publish, archive, and request draft listings/reads. Agent tools cannot author or
publish wiki content. The short entry page is reference context; further page
bodies enter context only when read. Tool results in durable dialogue retain the
revision/hash used. Profile references alone never authorize another project.

## Current limits

Retrieval ranks section text using BM25-style term scoring and title/alias/heading
boosts, computed from authorized published content. It is not a persistent FTS
index or a multilingual semantic retriever. Accent folding preserves Portuguese
lexical matching; it does not translate English queries. Search returns at most
20 hits, reads at most 12000 characters, and pages at most 64000 characters with
200 headings. No optimal retrieval quality or token savings are claimed.

The editor and reader display Markdown text. The internal link projection supports
inline `wiki:` links and excludes code examples; it is not a full CommonMark AST.
There is no attachment ingestion, collection export to runner files, automatic
knowledge authoring, or graph visualization in this slice. Bodies and revisions
remain in coordinator memory under the existing persistence model. PostgreSQL
uses the same keyed-record shape; this slice's restart test uses SQLite.

Tests cover unrelated product-support and equipment-maintenance collections,
revision immutability, stale writes, draft/archived exclusions, links, exact
references, bounds, Unicode search, profile pinning, principal authorization,
restart durability, and model-facing retrieval. Quality improvement on Luna is
a separate experiment; deterministic integration tests cannot establish it.

## Verification

Architecture and application build passed. The knowledge, capabilities and prompt
module tests and the knowledge, command-authorization and conversation acceptance
files passed. The knowledge acceptance flow uses a scripted model transport and
the actual runtime, authorization and SQLite persistence; it is not a Luna trial.

A separate Playwright run against an isolated daemon created a collection, saved
a synthetic maintenance page, published it, searched it and read v1 after daemon
restart and browser reload. Model calls and runner execution were disabled in
that preview. Evidence is under `/tmp/convoy-wiki-browser-artifacts/`, including
`wiki-final.png`. Existing bundle-size and Google Fonts CSP warnings remain.
No live workflow, customer project, or production deployment was changed.
