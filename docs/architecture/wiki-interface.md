# Wiki reading and authoring interface

The wiki opens as a project knowledge base: collection navigation, rendered
articles, and heading contents. Editing is an explicit mode. Management actions
are under menus; identifiers and hashes are under article Details. This extends
the existing [wiki foundation](wiki-foundation.md).

## Boundaries

- Knowledge owns optimistic collection updates, page publication and authorized
  reads. Added collection fields are optional: description (4,000 characters),
  startPageIds (20), and pageOrder (1,000). updateKnowledgeCollection requires
  project.manage, validates references inside the owning collection, and changes
  one revision atomically. Older records need no data migration.
- The web knowledge feature owns presentation, editor state, navigation encoding,
  Markdown rendering and styles. The shell resolves the project from a wiki URL.
- Agent search/read tools and profile entry-page pins are unchanged. A collection
  starting page is an operator navigation choice, not an agent instruction.
- Support handbooks and equipment-maintenance collections use the same model.
  No project names, statuses, or workflow vocabulary select UI behavior.

## Reading

Stable hash URLs encode project, collection, page, optional exact revision, and
section. In-app links, direct opening, refresh and browser history use the same
representation. A revision notice links back to latest. Complete article Markdown
is assembled using bounded reads of the first returned immutable revision, with
hash/cursor consistency checks. Search spans the project by default and links to
the matching section and exact revision. Search offers more results up to the
existing 20-section API bound, then prompts refinement.

React Markdown and remark-gfm render headings, lists, tables, quotes, code and
links. Raw HTML is not executed and unsafe link protocols are filtered. External
image references are presented as links (attachments remain outside this slice).
Published heading anchors come from Knowledge, matched by source line; the UI
does not import the daemon parser. Backlinks and related pages remain visible
below each article. The public page list never requests draft access.

## Editing and navigation

The focused editor supports Markdown/preview, a searchable project page-link
picker, Save draft and Publish. Publishing first saves pending edits using the
expected revision. Conflict errors retain editor contents. Unsaved page edits
prompt before navigating away. Archived pages/collections have restore controls.
Collection settings choose introduction, starting pages, and navigation order.
The current browser view supports up to 1,000 page summaries and reports a limit
instead of silently presenting a truncated list. On phones, navigation is a
drawer and heading contents collapse above the article.

## Verification

Domain tests cover collection ordering, stale updates, invalid starting pages,
cross-collection references, and two unrelated project vocabularies. Acceptance
tests cover public listing without draft permission, manager-only collection
updates, unchanged agent retrieval, and metadata persistence across SQLite
restart. Browser checks exercise rendering, unsafe content, internal links,
search, deep-link refresh, history, long content, preview/draft publication,
unsaved changes, page-link insertion, archive/restore, collection ordering and
mobile layout. Test fixtures are isolated from live project data.

Renderer references: [react-markdown](https://github.com/remarkjs/react-markdown)
and [remark-gfm](https://github.com/remarkjs/remark-gfm).

### Verified result (2026-09-27, local time)

`npm run check:architecture` passed (203 source files); `npm run build`
passed. The main bundle retains its existing size warning; the wiki's 179 kB
JavaScript chunk is loaded separately. The following focused test files passed:

- tests/modules/knowledge.test.mjs
- tests/acceptance/knowledge.test.mjs
- tests/acceptance/command-authorization.test.mjs
- tests/web/wiki-navigation.test.mjs

Chromium exercised the listed reading, authoring and management flows. A real
unsaved-navigation failure was fixed by letting the application shell request
leave confirmation before dispatching a wiki route update. Dismissing the dialog
now preserves the draft and URL. Phone testing at 390 × 844 verified drawer
navigation, section links, reload, and no horizontal or article-surface overflow.
The actual local AFIO wiki was read through the existing same-Wi-Fi preview.

The local app was restarted against its original database; all 4 project IDs and
44 ticket IDs were preserved. AFIO's four page revisions and v8 support triggers
were unchanged. Its collection received an introduction, starting-page selection,
and page ordering through the new generic API. No support model evaluation,
customer communication, or development execution was triggered by this UI test.

Screenshots and CLI traces: /tmp/convoy-wiki-browser-artifacts/.
Final screenshots: afio-wiki-overview.png, afio-wiki-desktop.png,
afio-wiki-phone.png. Isolated preview had the pre-existing Google Fonts CSP
warning; the real Vite phone preview had no browser errors in the final checks.
