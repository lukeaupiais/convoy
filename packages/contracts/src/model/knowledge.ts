export type KnowledgeSelection = {
  collectionIds: string[];
  entryPage?: { pageId: string; version: number };
};
export type KnowledgeCollection = {
  description?: string;
  startPageIds?: string[];
  pageOrder?: string[];
  id: string;
  projectId: string;
  organizationId: string;
  name: string;
  revision: number;
  state: 'active' | 'archived';
};
export type KnowledgeDraft = {
  title: string;
  body: string;
  aliases: string[];
  language: string;
  applicability: string;
};
export type KnowledgePage = {
  id: string;
  projectId: string;
  collectionId: string;
  revision: number;
  publishedVersion: number | null;
  state: 'active' | 'archived';
  updatedAt: string;
  draft: KnowledgeDraft;
};
export type KnowledgePageSummary = Omit<KnowledgePage, 'draft'> & { title: string };
export type KnowledgeReference = {
  pageId: string;
  collectionId: string;
  version: number;
  hash: string;
  title: string;
  aliases: string[];
  language: string;
  applicability: string;
  publishedAt: string;
};
export type KnowledgeHit = KnowledgeReference & {
  heading: string;
  anchor: string;
  startLine: number;
  endLine: number;
  excerpt: string;
};
export type KnowledgeRead = KnowledgeReference & {
  content: string;
  offset: number;
  nextOffset: number | null;
  startLine: number;
  headings: { heading: string; anchor: string; startLine: number; endLine: number }[];
  links: { pageId: string; title: string; version: number }[];
  backlinks: { pageId: string; title: string; version: number }[];
  hasMoreBacklinks: boolean;
  trust: 'reference_data_not_instructions';
};
