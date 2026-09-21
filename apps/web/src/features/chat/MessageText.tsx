import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyText } from '../../shared/lib/browser';
import { messageBlocks, safeMessageLink } from './message-format';

function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    const href = link && safeMessageLink(link[2]);
    return href ? (
      <a key={i} href={href} target="_blank" rel="noopener noreferrer">
        {link![1]}
      </a>
    ) : (
      part
    );
  });
}
function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="message-code">
      <header>
        <span>{language || 'Code'}</span>
        <button
          type="button"
          aria-label="Copy code"
          onClick={async () => {
            try {
              await copyText(text);
              setCopied(true);
              setError('');
            } catch {
              setError('Select the code to copy it.');
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <pre>
        <code>{text}</code>
      </pre>
      {error && <small role="status">{error}</small>}
    </div>
  );
}
export function MessageText({ text }: { text: string }) {
  return (
    <div className="message-prose">
      {messageBlocks(text).map((block, i) => {
        if (block.kind === 'code')
          return <CodeBlock key={i} text={block.text} language={block.language} />;
        if (block.kind === 'heading') return <h3 key={i}>{inline(block.text)}</h3>;
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={i}>
              {block.text.split('\n').map((line, j) => (
                <li key={j}>{inline(line)}</li>
              ))}
            </List>
          );
        }
        return <p key={i}>{inline(block.text)}</p>;
      })}
    </div>
  );
}
