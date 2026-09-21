export type MessageBlock = {
  kind: 'paragraph' | 'heading' | 'code' | 'list';
  text: string;
  language?: string;
  ordered?: boolean;
};

// A deliberately small presentation format. Model output never becomes HTML.
export function messageBlocks(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MessageBlock[] = [];
  let index = 0;
  const boundary = (line: string) => /^\s*```|^#{1,6}\s|^\s*(?:[-*]|\d+\.)\s/.test(line);
  while (index < lines.length) {
    const line = lines[index++];
    if (!line.trim()) continue;
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const content: string[] = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
        content.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push({ kind: 'code', language: fence[1].trim(), text: content.join('\n') });
    } else if (/^#{1,6}\s/.test(line)) {
      blocks.push({ kind: 'heading', text: line.replace(/^#{1,6}\s+/, '') });
    } else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const content = [line.replace(pattern, '')];
      while (index < lines.length && pattern.test(lines[index]))
        content.push(lines[index++].replace(pattern, ''));
      blocks.push({ kind: 'list', ordered, text: content.join('\n') });
    } else {
      const content = [line];
      while (index < lines.length && lines[index].trim() && !boundary(lines[index]))
        content.push(lines[index++]);
      blocks.push({ kind: 'paragraph', text: content.join('\n') });
    }
  }
  return blocks;
}

export function safeMessageLink(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
