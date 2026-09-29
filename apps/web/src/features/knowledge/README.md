# Wiki

Project knowledge authoring, publication, search and revision reading. The daemon
owns permissions and optimistic revisions. Bodies are fetched on demand rather
than included in runtime snapshots. Drafts stay separate from published views.
Export this feature through index.ts; keep its presentation here.

The default view reads published Markdown. Draft access is requested only when
editing or explicitly opening draft management. The reader assembles bounded
chunks of one immutable revision before rendering, so Markdown is never cut at a
transport page boundary. React Markdown + GFM render escaped content; raw HTML is
disabled and unsafe URL schemes are filtered. Wiki links resolve within project
scope; links to unavailable pages show an error rather than changing access.

`#wiki?project=…&collection=…&page=…&version=…&section=…` is the shareable UI
location. Omit version for latest publication. The application shell selects the
project; this feature owns article/collection/section navigation. Backend heading
anchors are matched by source line, preserving retrieval links and duplicates.

Collection settings store a plain-text introduction, selected published starting
pages, and explicit page order. These are navigation metadata, independent of
agent profile entry-page pins. Editing supports preview, link insertion, guarded
unsaved navigation, optimistic saves, and explicit publication. API authorization
remains authoritative for every command. Wiki code loads on demand.
