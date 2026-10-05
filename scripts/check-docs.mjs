#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const gitFiles = async (args) => (await execute('git', args, { cwd: root, encoding: 'utf8' }))
  .stdout.split('\0').filter(Boolean);
const tracked = await gitFiles(['ls-files', '-z']);
const errors = [];
const internal = (path) => /^(?:research\/|docs\/research\/|AGENTS\.md$|CONTEXT\.md$)/.test(path);

// Inspect the index as well as the working tree: ignore rules alone do not stop
// force-added files or files that were already tracked before a rule was added.
for (const path of tracked) {
  if (internal(path)) errors.push(`${path}: internal material must be removed from the Git index`);
}

function markdownUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [relative(root, path)] : [];
  });
}
const documents = [...new Set([
  ...tracked.filter((path) => path.endsWith('.md') && !internal(path) && existsSync(join(root, path))),
  ...markdownUnder(join(root, 'docs')).filter((path) => !internal(path)),
])];
const targets = new Map();
for (const path of documents) {
  if (path.startsWith('docs/') && /(?:^|\/)(?:[^/]*research[^/]*|pr\d+[^/]*|review-status)\.md$/i.test(path)) {
    errors.push(`${path}: research and PR working records belong in research/`);
  }
  const markdown = readFileSync(join(root, path), 'utf8')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  // Inline/image links and reference definitions; URL titles are optional.
  const links = [...markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*["'])?\s*\)|^\s*\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)];
  for (const link of links) {
    const url = (link[1] ?? link[2]).replace(/^<|>$/g, '');
    if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(url)) continue;
    let destination;
    try { destination = decodeURIComponent(url.split(/[?#]/, 1)[0]); }
    catch { errors.push(`${path}: invalid URL ${url}`); continue; }
    const target = relative(root, resolve(root, dirname(path), destination)).replaceAll('\\', '/');
    if (target === '..' || target.startsWith('../')) {
      errors.push(`${path}: link leaves the repository: ${url}`);
    } else if (!existsSync(join(root, target))) {
      errors.push(`${path}: missing link target ${url}`);
    } else {
      const sources = targets.get(target) ?? [];
      sources.push(`${path}: link depends on ignored local material: ${url}`);
      targets.set(target, sources);
    }
  }
}
if (targets.size) {
  let ignored;
  try {
    ignored = await new Promise((resolve, reject) => {
      const child = execFile('git', ['check-ignore', '--no-index', '-z', '--stdin'],
        { cwd: root, encoding: 'utf8' }, (error, stdout) => {
          if (error && error.code !== 1) reject(error);
          else resolve(stdout);
        });
      child.stdin.on('error', reject);
      child.stdin.end([...targets.keys()].join('\0') + '\0');
    });
  } catch (error) {
    throw new Error(`Could not check documentation ignore rules: ${error.message}`);
  }
  for (const target of ignored.split('\0').filter(Boolean)) errors.push(...targets.get(target));
}
if (errors.length) {
  console.error('Documentation check failed:');
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Documentation check passed: ${documents.length} Markdown files; no internal notes in the index or broken/ignored local links.`);
}
