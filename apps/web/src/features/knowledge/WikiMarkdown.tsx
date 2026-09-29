import { createElement } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { KnowledgeRead } from '../../shared/api/runtime';
import { wikiHref, type WikiLocation } from './wiki-navigation';

export function WikiMarkdown({
  text,
  location,
  headings = [],
}: {
  text: string;
  location: WikiLocation;
  headings?: KnowledgeRead['headings'];
}) {
  const heading: Components['h2'] = ({ node, children }) => {
    const ref = headings.find((h) => h.startLine === node?.position?.start.line);
    return createElement(
      node?.tagName === 'h1' ? 'h2' : (node?.tagName ?? 'h2'),
      { id: ref ? `wiki-section-${ref.anchor}` : undefined },
      children,
      ref && (
        <a
          className="wiki-heading-link"
          aria-label={`Link to ${ref.heading}`}
          href={wikiHref({ ...location, section: ref.anchor })}
        >
          #
        </a>
      ),
    );
  };
  return (
    <div className="wiki-prose">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          /^wiki:[a-zA-Z0-9-]+(?:#[^\s]*)?$/.test(url) ? url : defaultUrlTransform(url)
        }
        components={{
          h1: heading,
          h2: heading,
          h3: heading,
          h4: heading,
          h5: heading,
          h6: heading,
          a: ({ href, children }) => {
            const match = href?.match(/^wiki:([a-zA-Z0-9-]+)(?:#(.*))?$/);
            const target = match
              ? wikiHref({ projectId: location.projectId, pageId: match[1], section: match[2] })
              : href?.startsWith('#')
                ? wikiHref({ ...location, section: href.slice(1) })
                : href;
            return (
              <a
                href={target}
                rel="noopener noreferrer"
                {...(/^https?:/.test(target ?? '') ? { target: '_blank' } : {})}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="wiki-table">
              <table>{children}</table>
            </div>
          ),
          img: ({ alt, src }) => (
            <a href={src} target="_blank" rel="noopener noreferrer">
              {alt || 'Image'}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
