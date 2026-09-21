#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const sourceRoots = ['apps', 'packages'];
const sourceExtensions = new Set(['.js', '.mjs', '.ts', '.tsx']);
const errors = [];
const harnessPackages = [
  /^@earendil-works\/pi-ai(?:\/|$)/,
  /^@openai\/codex(?:\/|$)/,
  /^@opencode-ai\//,
  /^@anthropic-ai\/claude-code(?:\/|$)/,
];

async function filesUnder(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...(await filesUnder(child)));
    else output.push(child);
  }
  return output;
}

const sourceFiles = (await Promise.all(sourceRoots.map((path) => filesUnder(join(root, path)))))
  .flat()
  .filter((path) => sourceExtensions.has(extname(path)));
const sourceSet = new Set(sourceFiles.map(normalize));
const graph = new Map(sourceFiles.map((path) => [normalize(path), []]));

async function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = resolve(dirname(from), specifier);
  for (const path of [
    candidate,
    ...[...sourceExtensions].map((extension) => candidate + extension),
    ...[...sourceExtensions].map((extension) => join(candidate, `index${extension}`)),
  ]) {
    if (sourceSet.has(normalize(path))) return normalize(path);
  }
  try {
    if ((await stat(candidate)).isFile()) return normalize(candidate);
  } catch {
    /* A bundler may resolve an asset; it is outside this dependency graph. */
  }
  return null;
}

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
for (const file of sourceFiles) {
  const code = await readFile(file, 'utf8');
  for (const match of code.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    const from = relative(root, file).split(sep).join('/');
    if (
      from.startsWith('apps/daemon/src/adapters/') &&
      harnessPackages.some(pattern => pattern.test(specifier))
    ) {
      errors.push(`${from}: adapters may implement provider protocols but cannot embed another agent harness (${specifier})`);
    }
    if (from.startsWith('apps/daemon/src/modules/') && /^node:fs(?:\/|$)/.test(specifier)) {
      errors.push(
        `${from}: domain modules must receive filesystem persistence through an adapter (${specifier})`,
      );
    }
    const target = await resolveImport(file, specifier);
    if (!target) continue;
    graph.get(normalize(file)).push(target);
    const to = relative(root, target).split(sep).join('/');

    if (from.startsWith('packages/') && to.startsWith('apps/')) {
      errors.push(`${from}: packages cannot import application code (${to})`);
    }
    if (
      from.startsWith('apps/web/') &&
      /^(?:apps\/(?:daemon|worker)|packages\/runner)\//.test(to)
    ) {
      errors.push(`${from}: web may depend on contracts, not runtime implementation (${to})`);
    }
    if (
      from.startsWith('apps/daemon/src/modules/') &&
      /^apps\/daemon\/src\/(?:adapters|bootstrap|control-plane|http)\//.test(to)
    ) {
      errors.push(`${from}: domain modules cannot import outer daemon layers (${to})`);
    }
    if (
      from.startsWith('apps/daemon/src/http/') &&
      /^apps\/daemon\/src\/(?:adapters|bootstrap|control-plane|modules)\//.test(to)
    ) {
      errors.push(
        `${from}: HTTP is transport-only and must receive application ports from bootstrap (${to})`,
      );
    }
    if (
      from.startsWith('apps/daemon/src/control-plane/') &&
      /^apps\/daemon\/src\/(?:adapters|bootstrap|http)\//.test(to)
    ) {
      errors.push(
        `${from}: control-plane code must receive infrastructure ports from bootstrap (${to})`,
      );
    }
    if (
      !from.startsWith('packages/runner/src/') &&
      to.startsWith('packages/runner/src/') &&
      !to.endsWith('/index.mjs')
    ) {
      errors.push(`${from}: consume the runner package through src/index.mjs (${to})`);
    }
    const fromModule = /^apps\/daemon\/src\/modules\/([^/]+)\//.exec(from)?.[1];
    const targetModule = /^apps\/daemon\/src\/modules\/([^/]+)\//.exec(to)?.[1];
    if (fromModule && targetModule && fromModule !== targetModule && !to.endsWith('/index.mjs')) {
      errors.push(`${from}: import sibling module ${targetModule} through its index.mjs (${to})`);
    }
    const fromApp = /^apps\/([^/]+)\//.exec(from)?.[1];
    const targetApp = /^apps\/([^/]+)\//.exec(to)?.[1];
    if (fromApp && targetApp && fromApp !== targetApp) {
      errors.push(`${from}: applications cannot import another application (${to})`);
    }
    const fromFeature = /^apps\/web\/src\/features\/([^/]+)\//.exec(from)?.[1];
    const targetFeature = /^apps\/web\/src\/features\/([^/]+)\//.exec(to)?.[1];
    if (
      fromFeature &&
      targetFeature &&
      fromFeature !== targetFeature &&
      !to.endsWith('/index.ts')
    ) {
      errors.push(`${from}: import feature ${targetFeature} through its index.ts (${to})`);
    }
  }
}

const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const [name] of Object.entries({
  ...packageManifest.dependencies,
  ...packageManifest.devDependencies,
})) {
  if (harnessPackages.some(pattern => pattern.test(name))) {
    errors.push(`package.json: external agent harness dependency is forbidden (${name})`);
  }
}

const commandTypes = await readFile(join(root, 'packages/contracts/src/commands.ts'), 'utf8');
const commandMap =
  /export type RuntimeCommandInputMap = \{([\s\S]*?)\n\};/.exec(commandTypes)?.[1] ?? '';
const typedActions = new Set(
  [...commandMap.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]),
);
const commandValidation = await readFile(
  join(root, 'apps/daemon/src/control-plane/runtime-command-validation.mjs'),
  'utf8',
);
const validationMap =
  /export const runtimeCommandContracts = \{([\s\S]*?)\n\};/.exec(commandValidation)?.[1] ?? '';
const validatedActions = new Set(
  [...validationMap.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]),
);
for (const action of typedActions)
  if (!validatedActions.has(action))
    errors.push(`runtime command is typed but not validated: ${action}`);
for (const action of validatedActions)
  if (!typedActions.has(action))
    errors.push(`runtime command is validated but not typed: ${action}`);
if (!typedActions.size) errors.push('runtime command map could not be read');

for (const cssFile of (await filesUnder(join(root, 'apps/web/src/features'))).filter(
  (path) => extname(path) === '.css',
)) {
  const from = relative(root, cssFile).split(sep).join('/');
  const feature = /^apps\/web\/src\/features\/([^/]+)\//.exec(from)?.[1];
  const code = await readFile(cssFile, 'utf8');
  if (
    feature !== 'chat' &&
    /\.chat-(?:workspace|message|composer|transcript|empty|settings|options|run|pending|interruption|latest|stream|activity)/.test(
      code,
    )
  )
    errors.push(`${from}: chat presentation belongs to the chat feature`);
}

for (const cssFile of (await filesUnder(join(root, 'apps/web/src/shared/styles'))).filter(
  (path) => extname(path) === '.css',
)) {
  const from = relative(root, cssFile).split(sep).join('/');
  const code = await readFile(cssFile, 'utf8');
  for (const selector of ['board-studio', 'workflow-studio', 'chat-workspace']) {
    if (code.includes(`.${selector}`)) {
      errors.push(`${from}: .${selector} presentation belongs to its feature stylesheet`);
    }
  }
}

for (const file of sourceFiles) {
  const from = relative(root, file).split(sep).join('/');
  const code = await readFile(file, 'utf8');
  if (from.startsWith('packages/contracts/src/') && /\bany\b/.test(code))
    errors.push(`${from}: public contracts must not use any`);
  if (
    from === 'apps/daemon/src/control-plane/runtime.mjs' &&
    /conversationTools|pendingToolCalls|runAgentLoop/.test(code)
  ) {
    errors.push(`${from}: provider turns and tool execution belong in agent-execution.mjs`);
  }
}

const visiting = new Set();
const visited = new Set();
function visit(file, path = []) {
  if (visiting.has(file)) {
    const start = path.indexOf(file);
    const cycle = [...path.slice(start), file].map((item) => relative(root, item)).join(' -> ');
    errors.push(`dependency cycle: ${cycle}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency, [...path, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of graph.keys()) visit(file);

for (const legacy of ['src', 'server']) {
  try {
    if ((await stat(join(root, legacy))).isDirectory())
      errors.push(`legacy source root remains: ${legacy}/`);
  } catch {
    /* Expected. */
  }
}

const requiredReadmes = [
  'README.md',
  'apps/README.md',
  'apps/web/README.md',
  'apps/web/src/README.md',
  'apps/web/src/app/README.md',
  'apps/web/src/features/README.md',
  'apps/web/src/shared/README.md',
  'apps/daemon/README.md',
  'apps/daemon/src/README.md',
  'apps/daemon/src/bootstrap/README.md',
  'apps/daemon/src/http/README.md',
  'apps/daemon/src/control-plane/README.md',
  'apps/daemon/src/modules/README.md',
  'apps/daemon/src/adapters/README.md',
  'apps/daemon/src/shared/README.md',
  'apps/worker/README.md',
  'apps/cli/README.md',
  'packages/README.md',
  'packages/contracts/README.md',
  'packages/runner/README.md',
  'apps/worker/src/README.md',
  'apps/cli/src/README.md',
  'packages/contracts/src/README.md',
  'packages/runner/src/README.md',
  'tests/README.md',
  'docs/README.md',
  'docs/architecture/README.md',
  'scripts/README.md',
];
for (const readme of requiredReadmes) {
  try {
    await stat(join(root, readme));
  } catch {
    errors.push(`missing strategic documentation: ${readme}`);
  }
}

if (errors.length) {
  console.error(`Architecture check failed (${errors.length}):`);
  for (const error of [...new Set(errors)].sort()) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Architecture check passed: ${sourceFiles.length} source files, no forbidden dependencies or cycles.`,
  );
}
