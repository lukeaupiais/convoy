export type ArtifactMarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'code'; language: string; text: string };

const tableCells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

export function artifactMarkdownBlocks(text: string): ArtifactMarkdownBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ArtifactMarkdownBlock[] = [];
  let index = 0;
  const boundary = (line: string) => /^\s*```|^#{1,6}\s|^\s*(?:[-*]|\d+\.)\s/.test(line);
  const tableDivider = (line: string) =>
    /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  while (index < lines.length) {
    const line = lines[index++];
    if (!line.trim()) continue;
    const fence = line.match(/^\s*```([^`]*)$/);
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const list = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
    if (fence) {
      const content: string[] = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
        content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ kind: 'code', language: fence[1].trim(), text: content.join('\n') });
    } else if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
    } else if (list) {
      const ordered = /\d+\./.test(list[1]);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items = [line.replace(pattern, '')];
      while (index < lines.length && pattern.test(lines[index]))
        items.push(lines[index++].replace(pattern, ''));
      blocks.push({ kind: 'list', ordered, items });
    } else if (line.includes('|') && index < lines.length && tableDivider(lines[index])) {
      index++;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|'))
        rows.push(tableCells(lines[index++]));
      blocks.push({ kind: 'table', headers: tableCells(line), rows });
    } else {
      const content = [line];
      while (index < lines.length && lines[index].trim() && !boundary(lines[index]))
        content.push(lines[index++]);
      blocks.push({ kind: 'paragraph', text: content.join('\n') });
    }
  }
  return blocks;
}
