# Knowledge

Owns wiki collections, drafts, published page revisions, archival and bounded
retrieval. Pages are reference data and never confer instruction or execution
authority. Canonical state uses the injected persistence lifecycle. Indexes and
links are derived from immutable Markdown revisions; snapshots omit bodies.

The control plane authorizes project access before commands and agent reads.
This module additionally restricts agent reads to selected, active collections
in the session project. No customer terminology or workflow policy belongs here.

Collection navigation metadata (description, starting-page IDs, page order) is
updated with `updateKnowledgeCollection` and an expected revision. References must
belong to the collection; starting pages must be published and active. Missing
metadata on existing records is valid. Navigation order affects operator listing,
not retrieval ranking or profile entry selection. Unlisted pages follow in title
order. Draft and archived pages remain excluded from reader listings.
