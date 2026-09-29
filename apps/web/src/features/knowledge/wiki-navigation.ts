export type WikiLocation = {
  projectId?: string;
  collectionId?: string;
  pageId?: string;
  version?: number;
  section?: string;
};
export function parseWikiLocation(hash: string): WikiLocation | null {
  if (!hash.startsWith('#wiki?')) return null;
  const p = new URLSearchParams(hash.slice(6));
  const version = Number(p.get('version'));
  return {
    projectId: p.get('project') || undefined,
    collectionId: p.get('collection') || undefined,
    pageId: p.get('page') || undefined,
    version: Number.isSafeInteger(version) && version > 0 ? version : undefined,
    section: p.get('section') || undefined,
  };
}
export function wikiHref(location: WikiLocation) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries({
    project: location.projectId,
    collection: location.collectionId,
    page: location.pageId,
    version: location.version,
    section: location.section,
  }))
    if (value !== undefined && value !== '') p.set(key, String(value));
  return '#wiki?' + p.toString();
}
