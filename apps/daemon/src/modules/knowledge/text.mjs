// Rebuildable lexical projection. No inferred relationships or generated text.
export const normalize = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export const terms = (text) => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];

export function sections(body) {
  const lines = body.split('\n');
  const result = [];
  const counts = new Map();
  let current = { heading: '', anchor: '', startLine: 1, lines: [] };
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
    }
    const heading = !fence && line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      if (current.lines.length) result.push(current);
      const slug = terms(heading[1]).join('-') || 'section';
      const n = counts.get(slug) ?? 0;
      counts.set(slug, n + 1);
      current = {
        heading: heading[1],
        anchor: slug + (n ? `-${n}` : ''),
        startLine: i + 1,
        lines: [],
      };
    }
    current.lines.push(line);
  }
  result.push(current);
  return result.map(({ lines: part, ...metadata }) => ({
    ...metadata,
    endLine: metadata.startLine + part.length - 1,
    text: part.join('\n'),
  }));
}

export function links(body) {
  let fence = '';
  const prose = body
    .split('\n')
    .filter((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
        return false;
      }
      return !fence && !/^(?: {4}|\t)/.test(line);
    })
    .join('\n')
    .replace(/(`+)[\s\S]*?\1/g, '');
  return [
    ...new Set(
      [...prose.matchAll(/(?<!\\)\]\(wiki:([a-zA-Z0-9-]+)(?:#[^\s)]*)?\)/g)].map(
        (match) => match[1],
      ),
    ),
  ];
}

export function rankSections(revisions, query) {
  const words = [...new Set(terms(query))];
  if (!words.length) return [];
  const docs = revisions.flatMap((revision) =>
    sections(revision.body).map((section) => ({ revision, section, tokens: terms(section.text) })),
  );
  const average = docs.reduce((sum, doc) => sum + doc.tokens.length, 0) / (docs.length || 1) || 1;
  const frequencies = new Map(
    words.map((word) => [word, docs.filter((doc) => doc.tokens.includes(word)).length]),
  );
  return docs
    .map((doc) => {
      let score = 0;
      for (const word of words) {
        const tf = doc.tokens.filter((token) => token === word).length;
        if (tf)
          score +=
            (Math.log(
              1 + (docs.length - frequencies.get(word) + 0.5) / (frequencies.get(word) + 0.5),
            ) *
              tf *
              2.2) /
            (tf + 1.2 * (0.25 + (0.75 * doc.tokens.length) / average));
        if (
          terms(
            doc.revision.title + ' ' + doc.revision.aliases.join(' ') + ' ' + doc.section.heading,
          ).includes(word)
        )
          score += 2;
      }
      return { ...doc, score };
    })
    .filter((doc) => doc.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.revision.pageId.localeCompare(b.revision.pageId) ||
        a.section.startLine - b.section.startLine,
    );
}
