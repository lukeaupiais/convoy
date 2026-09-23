// This exact module runs locally or over SSH. No provider credentials are sent to runners.
import { spawn } from 'node:child_process';
import {
  realpath,
  lstat,
  readFile,
  writeFile,
  mkdir,
  readdir,
  rename,
  readlink,
  unlink,
} from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
const safeEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const sensitiveEnvironmentName =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:_|$)/i;
function trustedEnvironment() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)),
  );
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}
export function processRun(
  command,
  args,
  { cwd, signal, timeout = 60000, input, env = safeEnv } = {},
) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stopped = false;
    const kill = () => {
      stopped = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(kill, timeout);
    const collect = (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 64000) kill();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolveResult({ code, output: output.slice(0, 64000), stopped });
    });
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    child.stdin.end(input);
  });
}
async function checkedPath(root, path, writing = false) {
  if (
    typeof path !== 'string' ||
    !path ||
    isAbsolute(path) ||
    path.includes('\0') ||
    path
      .split(/[\\/]/)
      .some((p) => ['..', '.git', '.convoy', '.ssh', '.codex'].includes(p) || p.startsWith('.env'))
  )
    throw new Error(
      'Path must stay inside the assigned workspace; internal and credential paths are blocked.',
    );
  const base = await realpath(root);
  const target = resolve(base, path);
  if (!relative(base, target) || relative(base, target).startsWith('..'))
    throw new Error('Invalid workspace path.');
  let cursor = base;
  for (const part of relative(base, target).split('/')) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
        throw new Error('Symlinks and hardlinks are not allowed.');
    } catch (error) {
      if (!(writing && error.code === 'ENOENT')) throw error;
    }
  }
  return target;
}
function sandboxDirectoryArgs(path) {
  const directories = [];
  for (let cursor = dirname(path); cursor !== '/'; cursor = dirname(cursor)) {
    if (!['/tmp', '/usr', '/bin', '/lib', '/lib64', '/proc', '/dev'].includes(cursor))
      directories.unshift('--dir', cursor);
  }
  return directories;
}
async function gitMetadataSandboxArgs(root) {
  const dotGit = join(root, '.git');
  try {
    const info = await lstat(dotGit);
    if (info.isDirectory()) return ['--ro-bind', dotGit, '/workspace/.git'];
    if (!info.isFile()) return ['--ro-bind', '/dev/null', '/workspace/.git'];
    const match = /^gitdir:\s*(.+)\s*$/u.exec(await readFile(dotGit, 'utf8'));
    if (!match) return ['--ro-bind', '/dev/null', '/workspace/.git'];
    const gitDirectory = await realpath(resolve(root, match[1]));
    let commonDirectory = gitDirectory;
    try {
      commonDirectory = await realpath(
        resolve(gitDirectory, (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim()),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return [
      ...sandboxDirectoryArgs(commonDirectory),
      '--ro-bind',
      commonDirectory,
      commonDirectory,
    ];
  } catch {
    return ['--ro-bind', '/dev/null', '/workspace/.git'];
  }
}
async function sandboxArgs(root, command, interactive = false) {
  const args = [
    '--unshare-all',
    '--die-with-parent',
    ...(!interactive ? ['--new-session'] : []),
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/bin',
    '/bin',
  ];
  for (const path of ['/lib', '/lib64']) {
    try {
      await lstat(path);
      args.push('--ro-bind', path, path);
    } catch {}
  }
  args.push(
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--bind',
    root,
    '/workspace',
    '--chdir',
    '/workspace',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'TERM',
    'xterm-256color',
    '--setenv',
    'COLORTERM',
    'truecolor',
    '--setenv',
    'GIT_OPTIONAL_LOCKS',
    '0',
  );
  args.push(...(await gitMetadataSandboxArgs(root)));
  for (const name of ['.env', '.convoy', '.codex', '.ssh']) {
    try {
      const info = await lstat(join(root, name));
      args.push(
        info.isDirectory() ? '--tmpfs' : '--ro-bind',
        ...(info.isDirectory() ? [`/workspace/${name}`] : ['/dev/null', `/workspace/${name}`]),
      );
    } catch {}
  }
  args.push('/bin/sh', '-c', command);
  return args;
}
async function sandbox(root, command, signal, supervisor, timeoutMs, launchId, lifetime) {
  const args = await sandboxArgs(root, command);
  if (supervisor)
    return {
      commandId: supervisor.start('bwrap', args, {
        signal,
        env: safeEnv,
        owner: root,
        timeoutMs,
        launchId,
        lifetime,
      }),
    };
  const result = await processRun('bwrap', args, { signal });
  if (result.output.startsWith('bwrap:'))
    throw new Error(
      'Sandbox unavailable or denied. Shell execution is disabled; there is no unsandboxed fallback.',
    );
  return result;
}
function executionAccess(value = 'contained') {
  if (!['contained', 'trusted'].includes(value)) throw new Error('Invalid execution access mode.');
  return value;
}
async function executeCommand(
  root,
  command,
  signal,
  supervisor,
  timeoutMs,
  launchId,
  lifetime,
  accessMode,
) {
  if (executionAccess(accessMode) === 'contained')
    return sandbox(root, command, signal, supervisor, timeoutMs, launchId, lifetime);
  const env = trustedEnvironment();
  if (supervisor)
    return {
      commandId: supervisor.start('/bin/sh', ['-c', command], {
        cwd: root,
        env,
        signal,
        timeoutMs,
        owner: root,
        launchId,
        lifetime,
      }),
    };
  return processRun('/bin/sh', ['-c', command], { cwd: root, env, signal, timeout: timeoutMs });
}
const git = (root, args, signal) =>
  processRun(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.pager=cat',
      ...args,
    ],
    { cwd: root, signal },
  );
const runnerContracts = {
  probe: { required: ['repository'], optional: ['operationId', 'accessMode'] },
  provision: { required: ['repository', 'workspaceId'], optional: ['operationId'] },
  diff: { required: ['workspace'], optional: ['operationId', 'ignoreArtifact'] },
  tool: { required: ['workspace', 'name', 'args'], optional: ['operationId', 'accessMode'] },
  extension: {
    required: ['workspace', 'extension', 'adapter', 'tool', 'args'],
    optional: ['operationId'],
  },
  command_start: {
    required: ['workspace', 'command', 'launchId'],
    optional: ['operationId', 'timeoutMs', 'lifetime', 'accessMode'],
  },
  command_poll: {
    required: ['workspace', 'commandId'],
    optional: ['operationId', 'cursor', 'waitMs'],
  },
  command_stop: { required: ['workspace', 'commandId'], optional: ['operationId'] },
  command_release: { required: ['workspace', 'commandId'], optional: ['operationId'] },
  command_input: {
    required: ['workspace', 'commandId', 'input'],
    optional: ['operationId', 'close'],
  },
  terminal_start: {
    required: ['workspace'],
    optional: ['operationId', 'command', 'cols', 'rows', 'timeoutMs', 'accessMode'],
  },
  terminal_status: { required: ['workspace', 'terminalId'], optional: ['operationId'] },
  terminal_stop: { required: ['workspace', 'terminalId'], optional: ['operationId'] },
  terminal_read: { required: ['workspace', 'terminalId'], optional: ['operationId', 'cursor'] },
};
const runnerTools = new Set([
  'read_file',
  'list_files',
  'search_files',
  'inspect_repository',
  'write_file',
  'apply_patch',
  'shell',
  'start_command',
]);

const MAX_READ_BYTES = 10_000_000;
const DEFAULT_READ_LINES = 500;
const MAX_READ_LINES = 2_000;
const MAX_READ_PAGE_BYTES = 48_000;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum)
    throw new Error(`${label} must be ${minimum}-${maximum}.`);
  return resolved;
}

async function checkedScope(root, path = '.') {
  if (path === '.' || path === '') return realpath(root);
  return checkedPath(root, path);
}

function assertText(buffer, label) {
  if (buffer.includes(0)) throw new Error(`${label} appears to be binary.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8 text.`);
  }
}

function utf8Prefix(value, maximumBytes) {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let low = 0;
  let high = Math.min(value.length, maximumBytes);
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = middle > 0 && /[\uD800-\uDBFF]/.test(value[middle - 1]) ? middle - 1 : middle;
    if (Buffer.byteLength(value.slice(0, end)) <= maximumBytes) {
      best = Math.max(best, end);
      low = middle + 1;
    } else high = middle - 1;
  }
  return value.slice(0, best);
}

function globExpression(glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') {
        index++;
        pattern += '(?:.*/)?';
      } else pattern += '.*';
    } else if (character === '*') pattern += '[^/]*';
    else if (character === '?') pattern += '[^/]';
    else pattern += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(pattern + '$');
}

async function portableFiles(root, scope, glob, signal) {
  const matches = glob ? globExpression(glob) : null;
  const paths = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Cancelled');
      if (
        entry.isSymbolicLink() ||
        ['.git', '.convoy', '.codex', '.ssh', 'node_modules', 'dist'].includes(entry.name) ||
        entry.name.startsWith('.env')
      )
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const relativePath = relative(root, path);
        if (!matches || matches.test(relativePath)) paths.push(relativePath);
      }
      if (paths.length >= 10_000) return;
    }
  }
  await walk(scope);
  return paths.sort();
}

async function readPage(root, args) {
  const path = await checkedPath(root, args.path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > MAX_READ_BYTES)
    throw new Error('Read requires a regular file no larger than 10 MB.');
  const buffer = await readFile(path);
  const content = assertText(buffer, 'File');
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const offset = boundedInteger(args.offset, 1, 1, Math.max(1, lines.length + 1), 'Read offset');
  const limit = boundedInteger(args.limit, DEFAULT_READ_LINES, 1, MAX_READ_LINES, 'Read limit');
  const column = boundedInteger(args.column, 0, 0, 10_000_000, 'Read column');
  if (column && offset > lines.length) throw new Error('Read column is beyond the file.');
  if (column > (lines[offset - 1]?.length ?? 0)) throw new Error('Read column is beyond the line.');
  const selected = [];
  let bytes = 0;
  let endLine = offset - 1;
  let nextOffset = null;
  let nextColumn = null;
  for (let index = offset - 1; index < lines.length && selected.length < limit; index++) {
    const start = index === offset - 1 ? column : 0;
    const separatorBytes = selected.length ? 1 : 0;
    const available = MAX_READ_PAGE_BYTES - bytes - separatorBytes;
    const source = lines[index].slice(start);
    const part = utf8Prefix(source, available);
    if (selected.length) bytes++;
    selected.push(part);
    bytes += Buffer.byteLength(part);
    endLine = index + 1;
    if (part.length < source.length) {
      nextOffset = index + 1;
      nextColumn = start + part.length;
      break;
    }
    if (bytes >= MAX_READ_PAGE_BYTES) break;
  }
  if (nextOffset === null && endLine < lines.length) nextOffset = endLine + 1;
  const truncated = nextOffset !== null;
  return {
    text:
      selected.join('\n') + (!truncated && endsWithNewline && endLine === lines.length ? '\n' : ''),
    sha256: digest(buffer),
    startLine: offset,
    endLine,
    totalLines: lines.length,
    truncated,
    nextOffset,
    nextColumn,
  };
}

async function listFiles(root, args, signal) {
  const scope = await checkedScope(root, args.path);
  const scopeInfo = await lstat(scope);
  if (!scopeInfo.isDirectory()) throw new Error('List path must be a directory.');
  if (
    args.glob !== undefined &&
    (typeof args.glob !== 'string' || !args.glob || args.glob.length > 300)
  )
    throw new Error('Glob must be 1-300 characters.');
  const limit = boundedInteger(args.limit, 200, 1, 1_000, 'List limit');
  const command = ['--files', '--sort', 'path'];
  if (args.glob) command.push('--glob', args.glob);
  command.push(
    '--glob',
    '!.git/**',
    '--glob',
    '!.convoy/**',
    '--glob',
    '!.codex/**',
    '--glob',
    '!.ssh/**',
    '--glob',
    '!.env*',
    '--',
    relative(root, scope) || '.',
  );
  let result;
  try {
    result = await processRun('rg', command, { cwd: root, signal, timeout: 15_000 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const all = await portableFiles(root, scope, args.glob, signal);
    return {
      paths: all.slice(0, limit),
      truncated: all.length > limit || all.length >= 10_000,
      totalSeen: all.length,
      engine: 'portable',
    };
  }
  if (![0, 1].includes(result.code) && !result.stopped)
    throw new Error('Unable to list workspace files with ripgrep.');
  const all = result.output
    .split('\n')
    .filter(Boolean)
    .map((path) => path.replace(/^\.\//, ''))
    .sort();
  return {
    paths: all.slice(0, limit),
    truncated: result.stopped || all.length > limit,
    totalSeen: all.length,
    engine: 'ripgrep',
  };
}

async function searchFiles(root, args, signal) {
  if (typeof args.query !== 'string' || !args.query || args.query.length > 500)
    throw new Error('Search requires a query of 1-500 characters.');
  const scope = await checkedScope(root, args.path);
  const limit = boundedInteger(args.limit, 100, 1, 500, 'Search limit');
  const context = boundedInteger(args.context, 0, 0, 10, 'Search context');
  if (
    args.glob !== undefined &&
    (typeof args.glob !== 'string' || !args.glob || args.glob.length > 300)
  )
    throw new Error('Glob must be 1-300 characters.');
  if (args.regex !== undefined && typeof args.regex !== 'boolean')
    throw new Error('regex must be boolean.');
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean')
    throw new Error('caseSensitive must be boolean.');
  const command = [
    '--json',
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--max-count',
    String(limit),
  ];
  if (!args.regex) command.push('--fixed-strings');
  command.push(args.caseSensitive === false ? '--ignore-case' : '--case-sensitive');
  if (context)
    command.push('--before-context', String(context), '--after-context', String(context));
  if (args.glob) command.push('--glob', args.glob);
  command.push(
    '--glob',
    '!.git/**',
    '--glob',
    '!.convoy/**',
    '--glob',
    '!.codex/**',
    '--glob',
    '!.ssh/**',
    '--glob',
    '!.env*',
    '--regexp',
    args.query,
    '--',
    relative(root, scope) || '.',
  );
  let result;
  try {
    result = await processRun('rg', command, { cwd: root, signal, timeout: 20_000 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const files = (await lstat(scope)).isFile()
      ? [relative(root, scope)]
      : await portableFiles(root, scope, args.glob, signal);
    let matcher;
    try {
      matcher = args.regex ? new RegExp(args.query, args.caseSensitive === false ? 'i' : '') : null;
    } catch {
      throw new Error('Workspace search failed. Check the regular expression.');
    }
    const hits = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      const candidate = resolve(root, file);
      const info = await lstat(candidate);
      if (!info.isFile() || info.nlink > 1 || info.size > MAX_READ_BYTES) continue;
      const path = await checkedPath(root, file);
      let text;
      try {
        text = assertText(await readFile(path), 'File');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        if (hits.length >= limit) return;
        const matched = matcher
          ? matcher.test(line)
          : args.caseSensitive === false
            ? line.toLocaleLowerCase().includes(args.query.toLocaleLowerCase())
            : line.includes(args.query);
        if (matched)
          hits.push({
            path: file,
            line: index + 1,
            text: line.slice(0, 1_000),
            before: lines.slice(Math.max(0, index - context), index),
            after: lines.slice(index + 1, index + 1 + context),
          });
      });
    }
    return {
      hits,
      truncated: hits.length >= limit || files.length >= 10_000,
      engine: 'portable',
    };
  }
  if (![0, 1].includes(result.code) && !result.stopped)
    throw new Error('Workspace search failed. Check the regular expression.');
  const hits = [];
  const before = new Map();
  let current = null;
  for (const raw of result.output.split('\n')) {
    if (!raw) continue;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!['match', 'context'].includes(event.type)) continue;
    const path = event.data.path?.text?.replace(/^\.\//, '');
    const line = event.data.line_number;
    const text = (event.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 1_000);
    if (!path || !Number.isInteger(line)) continue;
    if (event.type === 'context') {
      if (current?.path === path && line > current.line && current.after.length < context)
        current.after.push(text);
      else before.set(path, [...(before.get(path) ?? []), text].slice(-context));
      continue;
    }
    current = { path, line, text, before: before.get(path) ?? [], after: [] };
    before.set(path, []);
    hits.push(current);
    if (hits.length >= limit) break;
  }
  return { hits, truncated: result.stopped || hits.length >= limit, engine: 'ripgrep' };
}

async function inspectRepository(root, args, signal) {
  if (!['status', 'diff', 'log'].includes(args.operation))
    throw new Error('Repository operation must be status, diff, or log.');
  const limit = boundedInteger(args.limit, 20, 1, 100, 'Git log limit');
  const command =
    args.operation === 'status'
      ? ['status', '--short', '--branch', '--untracked-files=all']
      : args.operation === 'diff'
        ? ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']
        : ['log', `-${limit}`, '--date=iso-strict', '--pretty=format:%h%x09%ad%x09%an%x09%s'];
  const result = await git(root, command, signal);
  if (result.code !== 0 && !result.stopped)
    throw new Error(`Unable to inspect Git ${args.operation}.`);
  return { operation: args.operation, output: result.output, truncated: result.stopped };
}

async function atomicWrite(path, content, mode, signal) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode, flag: 'wx' });
    if (signal?.aborted) throw new Error('Stopped before the file was changed.');
    await rename(temp, path);
  } finally {
    try {
      await unlink(temp);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function applyExactEdits(content, edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > 50)
    throw new Error('Patch requires 1–50 exact edits.');
  if (Buffer.byteLength(JSON.stringify(edits)) > 64000) throw new Error('Patch exceeds 64 KB.');
  let next = content;
  for (const edit of edits) {
    if (
      !edit ||
      typeof edit !== 'object' ||
      Array.isArray(edit) ||
      Object.keys(edit).some((key) => !['oldText', 'newText'].includes(key)) ||
      typeof edit.oldText !== 'string' ||
      !edit.oldText ||
      edit.oldText.length > 16000 ||
      typeof edit.newText !== 'string' ||
      edit.newText.length > 16000
    )
      throw new Error('Each patch edit requires bounded oldText and newText strings.');
    const at = next.indexOf(edit.oldText);
    if (at < 0)
      throw new Error(
        'Patch context was not found. Read the file again and generate a fresh patch.',
      );
    if (next.indexOf(edit.oldText, at + 1) >= 0)
      throw new Error('Patch context is ambiguous. Include more surrounding text.');
    next = next.slice(0, at) + edit.newText + next.slice(at + edit.oldText.length);
    if (Buffer.byteLength(next) > 64000) throw new Error('Patched file exceeds 64 KB.');
  }
  return next;
}

async function applyPatch(root, args, signal) {
  const operations = args.operations ?? [args];
  if (!Array.isArray(operations) || !operations.length || operations.length > 20)
    throw new Error('Patch requires 1-20 file operations.');
  if (Buffer.byteLength(JSON.stringify(operations)) > 64_000)
    throw new Error('Patch exceeds 64 KB.');
  const paths = new Set();
  const prepared = [];
  for (const operation of operations) {
    const kind = operation?.operation ?? 'update';
    if (
      !operation ||
      typeof operation !== 'object' ||
      Array.isArray(operation) ||
      Object.keys(operation).some(
        (key) => !['operation', 'path', 'to', 'content', 'expectedHash', 'edits'].includes(key),
      ) ||
      !['update', 'add', 'delete', 'move'].includes(kind)
    )
      throw new Error('Invalid patch operation.');
    const path = await checkedPath(root, operation.path, kind === 'add');
    if (paths.has(path)) throw new Error('Each file may appear only once in a patch.');
    paths.add(path);
    if (kind === 'add') {
      if (
        typeof operation.content !== 'string' ||
        operation.content.includes('\0') ||
        Buffer.byteLength(operation.content) > 64_000
      )
        throw new Error('Add requires text content no larger than 64 KB.');
      try {
        await lstat(path);
        throw new Error('Added file already exists. Read it before editing.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      prepared.push({
        operation: kind,
        path,
        relativePath: operation.path,
        next: operation.content,
        mode: 0o600,
        replacements: 0,
      });
      continue;
    }
    if (
      typeof operation.expectedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(operation.expectedHash)
    )
      throw new Error('Update, delete and move require the SHA-256 returned by read_file.');
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64_000)
      throw new Error('Patch requires regular files no larger than 64 KB.');
    const content = await readFile(path, 'utf8');
    if (digest(content) !== operation.expectedHash)
      throw new Error('File changed since it was read. Read it again before editing.');
    if (kind === 'delete') {
      prepared.push({
        operation: kind,
        path,
        relativePath: operation.path,
        previous: content,
        replacements: 0,
      });
      continue;
    }
    if (kind === 'move') {
      const to = await checkedPath(root, operation.to, true);
      if (paths.has(to)) throw new Error('Patch paths and move targets must be unique.');
      paths.add(to);
      try {
        await lstat(to);
        throw new Error('Move target already exists.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      prepared.push({
        operation: kind,
        path,
        relativePath: operation.path,
        to,
        relativeTo: operation.to,
        next: content,
        mode: info.mode & 0o777,
        replacements: 0,
      });
      continue;
    }
    const next = applyExactEdits(content, operation.edits);
    if (next === content) throw new Error('Patch would not change the file.');
    prepared.push({
      operation: kind,
      path,
      relativePath: operation.path,
      previous: content,
      next,
      mode: info.mode & 0o777,
      replacements: operation.edits.length,
    });
  }
  const files = [];
  for (const file of prepared) {
    if (signal?.aborted) throw new Error('Stopped before the file was changed.');
    if (file.operation === 'delete') await unlink(file.path);
    else if (file.operation === 'move') {
      await mkdir(dirname(file.to), { recursive: true });
      await writeFile(file.to, file.next, { mode: file.mode, flag: 'wx' });
      try {
        await unlink(file.path);
      } catch (error) {
        await unlink(file.to).catch(() => {});
        throw error;
      }
    } else {
      await mkdir(dirname(file.path), { recursive: true });
      await atomicWrite(file.path, file.next, file.mode, signal);
    }
    const before = file.previous ?? '';
    const after = file.next ?? '';
    const preview = [
      `--- ${file.operation === 'add' ? '/dev/null' : `a/${file.relativePath}`}`,
      `+++ ${file.operation === 'delete' ? '/dev/null' : `b/${file.relativeTo ?? file.relativePath}`}`,
      ...before
        .split('\n')
        .slice(0, 20)
        .map((line) => `-${line}`),
      ...after
        .split('\n')
        .slice(0, 20)
        .map((line) => `+${line}`),
    ].join('\n');
    files.push({
      operation: file.operation,
      path: file.relativePath,
      ...(file.relativeTo ? { to: file.relativeTo } : {}),
      ...(file.next !== undefined ? { sha256: digest(file.next) } : {}),
      replacements: file.replacements,
      bytes: Buffer.byteLength(after),
      diff: preview.slice(0, 12_000),
      diffTruncated: preview.length > 12_000,
    });
  }
  const result = {
    files,
    replacements: files.reduce((total, file) => total + file.replacements, 0),
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  };
  return args.operations ? result : { ...files[0], files };
}
export function validateRunnerRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new Error('Runner request must be an object.');
  const definition = runnerContracts[request.action];
  if (!definition) throw new Error('Unsupported runner operation.');
  const allowed = new Set(['action', ...definition.required, ...definition.optional]);
  const unknown = Object.keys(request).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unsupported field for ${request.action}: ${unknown}.`);
  const missing = definition.required.find((key) => request[key] === undefined);
  if (missing) throw new Error(`Missing field for ${request.action}: ${missing}.`);
  if (
    request.action === 'tool' &&
    (!runnerTools.has(request.name) ||
      !request.args ||
      typeof request.args !== 'object' ||
      Array.isArray(request.args))
  )
    throw new Error('Invalid runner tool request.');
  if (request.action === 'extension') {
    if (
      !request.extension ||
      typeof request.extension !== 'object' ||
      Array.isArray(request.extension) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.extension.id) ||
      typeof request.extension.revision !== 'string' ||
      typeof request.extension.hash !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9-]*[a-z0-9])?$/.test(request.adapter) ||
      typeof request.tool !== 'string' ||
      !request.tool ||
      !request.args ||
      typeof request.args !== 'object' ||
      Array.isArray(request.args)
    )
      throw new Error('Invalid extension request.');
  }
  return request;
}
export async function executeRunner(
  request,
  signal,
  supervisor,
  terminals,
  extensionAdapters = {},
) {
  validateRunnerRequest(request);
  const { action } = request;
  if (action === 'probe') {
    const accessMode = executionAccess(request.accessMode);
    const root = await realpath(request.repository);
    const check = await git(root, ['rev-parse', '--show-toplevel'], signal);
    if (check.code !== 0 || check.output.trim() !== root)
      throw new Error('Select the top-level directory of a Git repository.');
    let shell = false;
    try {
      shell =
        (
          await executeCommand(
            root,
            'true',
            signal,
            undefined,
            5000,
            undefined,
            undefined,
            accessMode,
          )
        ).code === 0;
    } catch {}
    let terminal = false;
    if (shell)
      try {
        terminal = (await processRun('tmux', ['-V'], { signal, timeout: 5000 })).code === 0;
      } catch {}
    return {
      repository: root,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      tools: [
        'read_file',
        'list_files',
        'search_files',
        'inspect_repository',
        'write_file',
        'apply_patch',
        ...(shell
          ? [
              'shell',
              'start_command',
              'command_status',
              'read_command_output',
              'send_command_input',
              'stop_command',
            ]
          : []),
      ],
      shell,
      terminal,
      accessMode,
      extensionAdapters: Object.keys(extensionAdapters).sort(),
    };
  }
  if (action === 'provision') {
    const root = await realpath(request.repository);
    if (!/^[a-z0-9-]{1,80}$/.test(request.workspaceId))
      throw new Error('Invalid workspace identifier.');
    const folder = join(root, '.convoy-worktrees');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if ((await realpath(folder)) !== folder)
      throw new Error('Workspace directory cannot be a symlink.');
    const path = join(folder, request.workspaceId);
    const branch = `convoy/${request.workspaceId}`;
    try {
      await lstat(path);
      const existing = await git(path, ['symbolic-ref', '--short', 'HEAD'], signal);
      const actualCommon = await git(
        path,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        signal,
      );
      const expectedCommon = await git(
        root,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        signal,
      );
      if (
        existing.code !== 0 ||
        existing.output.trim() !== branch ||
        actualCommon.output.trim() !== expectedCommon.output.trim()
      )
        throw new Error('Existing workspace does not match this task. Inspect it manually.');
      return { path, branch };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const result = await git(root, ['worktree', 'add', '-b', branch, path, 'HEAD'], signal);
    if (result.code !== 0)
      throw new Error(
        'Worktree creation failed. Check repository HEAD and permissions. No automatic cleanup was attempted.',
      );
    return { path, branch };
  }
  const root = await realpath(request.workspace);
  if (request.action.startsWith('terminal_')) {
    if (!terminals) throw new Error('Native terminal supervisor unavailable.');
    if (request.action === 'terminal_status') return terminals.status(request.terminalId, root);
    if (request.action === 'terminal_stop') return terminals.stop(request.terminalId, root);
    if (request.action === 'terminal_read')
      return terminals.read(request.terminalId, root, request.cursor ?? 0);
    if (request.action !== 'terminal_start') throw new Error('Unsupported terminal operation.');
    const command = request.command ?? 'exec /bin/sh -i';
    if (typeof command !== 'string' || !command.trim() || command.length > 4000)
      throw new Error('Invalid terminal command.');
    const accessMode = executionAccess(request.accessMode);
    const invocation =
      accessMode === 'trusted'
        ? { command: '/bin/sh', args: ['-c', command], env: trustedEnvironment() }
        : { command: 'bwrap', args: await sandboxArgs(root, command, true), env: safeEnv };
    return terminals.start(invocation.command, invocation.args, {
      cwd: root,
      env: invocation.env,
      owner: root,
      cols: request.cols,
      rows: request.rows,
      timeoutMs: request.timeoutMs,
    });
  }
  if (
    request.action === 'command_poll' ||
    request.action === 'command_stop' ||
    request.action === 'command_release' ||
    request.action === 'command_input'
  ) {
    if (!supervisor) throw new Error('Command supervisor unavailable.');
    if (request.action === 'command_stop') return supervisor.stop(request.commandId, root);
    if (request.action === 'command_release') return supervisor.release(request.commandId, root);
    if (request.action === 'command_input')
      return supervisor.input(request.commandId, root, request.input, request.close ?? false);
    return supervisor.poll(request.commandId, root, request);
  }
  if (request.action === 'command_start') {
    if (!supervisor) throw new Error('Command supervisor unavailable.');
    if (
      typeof request.command !== 'string' ||
      !request.command.trim() ||
      request.command.length > 4000
    )
      throw new Error('Invalid shell command.');
    return executeCommand(
      root,
      request.command,
      signal,
      supervisor,
      request.timeoutMs,
      request.launchId,
      request.lifetime,
      request.accessMode,
    );
  }
  if (action === 'diff') {
    const changes = await git(root, ['status', '--short', '--untracked-files=all'], signal);
    const diff = await git(
      root,
      ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.'],
      signal,
    );
    if (changes.code !== 0 || diff.code !== 0) throw new Error('Unable to inspect worktree.');
    // HEAD identifies clean tracked content. Hash only paths whose working-tree
    // content can differ from HEAD, so large repositories do not exhaust the
    // bounded command output or file-content budget just by being checked out.
    const head = await git(root, ['rev-parse', 'HEAD'], signal);
    const changed = await git(root, ['diff', '--name-only', '-z', 'HEAD', '--', '.'], signal);
    const untracked = await git(root, ['ls-files', '-o', '--exclude-standard', '-z'], signal);
    if ([head, changed, untracked].some(result => result.code !== 0 || result.stopped))
      throw new Error('Workspace fingerprint exceeded its safe limit.');
    const hash = createHash('sha256');
    hash.update(head.output.trim() + '\0');
    let bytes = 0;
    for (const name of [...new Set([...changed.output.split('\0'), ...untracked.output.split('\0')].filter(Boolean))].sort()) {
      if (name === request.ignoreArtifact) continue;
      const path = resolve(root, name);
      if (relative(root, path).startsWith('..')) throw new Error('Invalid Git path.');
      try {
        const info = await lstat(path);
        bytes += info.size;
        if (info.size > 10000000 || bytes > 100000000)
          throw new Error('Workspace fingerprint exceeds 100 MB.');
        hash.update(name + ':' + info.mode + ':');
        if (info.isSymbolicLink()) hash.update(await readlink(path));
        else if (info.isFile()) hash.update(await readFile(path));
      } catch (error) {
        if (error.code === 'ENOENT') hash.update(name + ':deleted');
        else throw error;
      }
    }
    return {
      status: changes.output,
      diff: diff.output,
      digest: hash.digest('hex'),
      truncated: changes.stopped || diff.stopped,
    };
  }
  if (action === 'extension') {
    const adapter = extensionAdapters[request.adapter];
    if (typeof adapter !== 'function')
      throw new Error('The pinned extension adapter is not installed on this runner.');
    // The adapter receives only the immutable revision, workspace, tool and
    // validated arguments; it never receives daemon/provider credentials.
    return adapter({
      extension: structuredClone(request.extension),
      tool: request.tool,
      args: structuredClone(request.args),
      workspace: root,
      signal,
    });
  }
  const { name, args } = request;
  if (name === 'read_file') return readPage(root, args);
  if (name === 'list_files') return listFiles(root, args, signal);
  if (name === 'search_files') return searchFiles(root, args, signal);
  if (name === 'inspect_repository') return inspectRepository(root, args, signal);
  if (name === 'write_file') {
    if (
      typeof args.content !== 'string' ||
      args.content.length > 32000 ||
      typeof args.expectedHash !== 'string'
    )
      throw new Error('Write requires content and expectedHash (empty for a new file).');
    const path = await checkedPath(root, args.path, true);
    let old = '';
    let mode = 0o600;
    try {
      old = digest(await readFile(path));
      mode = (await lstat(path)).mode & 0o777;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (old !== args.expectedHash)
      throw new Error('File changed since it was read. Read it again before editing.');
    await mkdir(dirname(path), { recursive: true });
    await checkedPath(root, args.path, true);
    await atomicWrite(path, args.content, mode, signal);
    return { path: args.path, sha256: digest(args.content) };
  }
  if (name === 'apply_patch') {
    return applyPatch(root, args, signal);
  }
  if (name === 'shell') {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 4000)
      throw new Error('Invalid shell command.');
    return executeCommand(
      root,
      args.command,
      signal,
      undefined,
      undefined,
      undefined,
      undefined,
      request.accessMode,
    );
  }
  throw new Error('Unsupported runner operation.');
}
