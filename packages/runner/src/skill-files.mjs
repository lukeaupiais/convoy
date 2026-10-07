import { createHash, randomUUID } from 'node:crypto';
import { processRun } from './runner-agent.mjs';
import { watch, constants } from 'node:fs';
import { lstat, stat, realpath, readdir, readFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve, relative, dirname, join, isAbsolute } from 'node:path';

const MAX_FILES = 256, MAX_BYTES = 4 * 1024 * 1024, MAX_DEPTH = 12, MAX_ENTRIES = 4096;
const locks = new Map();
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function safeRelative(path, empty = false) {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.' || (!part && path !== '')) || (!empty && !path) || path.length > 1024)
    fail('denied', 'Invalid relative skill path.');
  return path;
}
async function approvedPath(path, allowSymlinks) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('denied', 'An absolute registered path is required.');
  path = resolve(path); let ancestor = path;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT' || ancestor === dirname(ancestor)) throw error; ancestor = dirname(ancestor); }
  }
  const canonical = await realpath(ancestor);
  if (!allowSymlinks && canonical !== ancestor) fail('denied', 'Enable symlinks explicitly before registering or accessing an alias.');
  if (!(await stat(canonical)).isDirectory()) fail('denied', 'Registered path ancestor is not a directory.');
  return join(canonical, relative(ancestor, path));
}
async function approveRoot(root) {
  if (!root) fail('denied', 'A registered skill root is required.');
  const approvedCanonicalPath = await approvedPath(root.path, root.allowSymlinks === true);
  const approvedRepositoryPath = root.repositoryPath ? await approvedPath(root.repositoryPath, root.allowSymlinks === true) : undefined;
  if (approvedRepositoryPath && !inside(approvedRepositoryPath, approvedCanonicalPath)) fail('denied', 'Registered skill root escapes approved repository.');
  return { approvedCanonicalPath, ...(approvedRepositoryPath ? { approvedRepositoryPath } : {}) };
}
async function verifyRoot(root) {
  const observed = await approveRoot(root);
  if (root.approvedCanonicalPath && observed.approvedCanonicalPath !== root.approvedCanonicalPath)
    fail('denied', 'Registered root changed its approved canonical target; register the new location explicitly.');
  if (root.approvedRepositoryPath && observed.approvedRepositoryPath !== root.approvedRepositoryPath)
    fail('denied', 'Repository changed its approved canonical target; register the new location explicitly.');
  if (root.allowSymlinks && !root.approvedCanonicalPath) fail('denied', 'Symlink-enabled roots require an approved canonical target.');
  return observed;
}
async function authority(root) {
  await verifyRoot(root);
  const path = resolve(root.path), canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) fail('denied', 'Registered root is not a directory.');
  const targets = [canonical];
  if (root.allowSymlinks) for (const target of root.authorizedTargets ?? []) {
    const approved = resolve(target), actual = await realpath(target);
    if (actual !== approved) fail('denied', 'Additional registered targets must retain their explicit canonical path.');
    targets.push(actual);
  }
  return { path, canonical, targets, allowSymlinks: root.allowSymlinks === true };
}
async function checked(auth, path) {
  const information = await lstat(path);
  if (information.isSymbolicLink() && !auth.allowSymlinks) fail('unsupported_resource', 'Symlinks are not enabled for this root.');
  const canonical = await realpath(path);
  if (!auth.targets.some(root => inside(root, canonical))) fail('denied', 'Skill path escapes registered roots.');
  return { canonical, information: await stat(canonical) };
}
function signature(info) { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs ?? info.mtimeMs}:${info.ctimeNs ?? info.ctimeMs}`; }
function encode(path, bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {}
  return text !== undefined && !text.includes('\0') ? { path, encoding: 'utf8', content: text } : { path, encoding: 'base64', content: bytes.toString('base64') };
}
function bytes(file) {
  safeRelative(file.path);
  if (!['utf8', 'base64'].includes(file.encoding) || typeof file.content !== 'string' || file.content.length > MAX_BYTES * 2) fail('invalid', 'Invalid resource content.');
  const content = Buffer.from(file.content, file.encoding === 'utf8' ? 'utf8' : 'base64');
  if (file.encoding === 'base64' && content.toString('base64') !== file.content) fail('invalid', 'Binary content must use canonical base64.');
  return content;
}
export function skillPackageDigest(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const content = bytes(file), path = Buffer.from(file.path);
    hash.update(`${path.length}:`); hash.update(path); hash.update(`${content.length}:`); hash.update(content);
  }
  return hash.digest('hex');
}
async function capture(auth, relativeDirectory, signal) {
  safeRelative(relativeDirectory, true);
  const source = join(auth.path, relativeDirectory);
  for (let attempt = 0; attempt < 3; attempt++) {
    const files = [], observations = [], seen = new Set(); let total = 0;
    async function walk(path, prefix, depth) {
      signal?.throwIfAborted();
      if (depth > MAX_DEPTH) fail('unsupported_resource', 'Skill resource depth exceeds limit.');
      const item = await checked(auth, path);
      observations.push([path, item.canonical, signature(item.information)]);
      if (item.information.isDirectory()) {
        if (seen.has(item.canonical)) fail('unsupported_resource', 'Skill resources contain a symlink cycle.');
        seen.add(item.canonical);
        const entries = (await readdir(item.canonical)).sort();
        if (observations.length + entries.length > MAX_ENTRIES) fail('unsupported_resource', 'Skill resource entry limit exceeded.');
        for (const entry of entries) await walk(join(path, entry), prefix ? `${prefix}/${entry}` : entry, depth + 1);
        seen.delete(item.canonical);
      } else if (item.information.isFile()) {
        if (files.length >= MAX_FILES || total + item.information.size > MAX_BYTES) fail('unsupported_resource', 'Skill package exceeds capture limits.');
        const handle = await open(item.canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try {
          const buffer = Buffer.alloc(MAX_BYTES - total + 1);
          let length = 0;
          while (length < buffer.length) { const result = await handle.read(buffer, length, buffer.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
          content = buffer.subarray(0, length);
        } finally { await handle.close(); }
        total += content.length;
        if (total > MAX_BYTES) fail('unsupported_resource', 'Skill package exceeds capture limits.');
        files.push(encode(prefix, content));
      } else fail('unsupported_resource', 'Only regular files and directories are supported.');
    }
    await walk(source, '', 0);
    let stable = true;
    for (const [path, canonical, before] of observations) {
      try { const after = await checked(auth, path); if (after.canonical !== canonical || signature(after.information) !== before) stable = false; } catch { stable = false; }
    }
    if (!stable) continue;
    if (!files.some(file => file.path === 'SKILL.md' && file.encoding === 'utf8')) fail('invalid_metadata', 'A UTF-8 SKILL.md file is required.');
    return { relativeDirectory, canonicalPath: await realpath(source), digest: skillPackageDigest(files), files };
  }
  fail('unstable', 'Skill changed during capture; retry after edits settle.');
}
async function discover(auth, signal) {
  const packages = [], diagnostics = [], visited = new Set(); let entries = 0, packageBytes = 0;
  async function walk(path, rel, depth) {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH || ++entries > MAX_ENTRIES) fail('unsupported_resource', 'Discovery traversal limit exceeded.');
    try {
      const item = await checked(auth, path);
      if (!item.information.isDirectory() || visited.has(item.canonical)) return;
      visited.add(item.canonical);
      const names = await readdir(item.canonical);
      if (names.includes('SKILL.md')) {
        try { const item = await capture(auth, rel, signal); const size = item.files.reduce((sum,file)=>sum+bytes(file).length,0); if (packages.length >= 128 || packageBytes + size > MAX_BYTES) fail('unsupported_resource', 'Catalogue capture size exceeded; capture packages individually.'); packageBytes += size; packages.push(item); } catch (error) { diagnostics.push({ relativeDirectory: rel, code: error.code ?? 'unreadable', message: error.message }); }
        return;
      }
      for (const name of names.sort()) {
        if (name.startsWith('.convoy-skill-')) continue;
        const child = join(path, name);
        if ((await lstat(child)).isDirectory() || (await lstat(child)).isSymbolicLink()) await walk(child, rel ? `${rel}/${name}` : name, depth + 1);
      }
    } catch (error) { diagnostics.push({ relativeDirectory: rel, code: error.code ?? 'unreadable', message: error.message }); }
  }
  await walk(auth.path, '', 0);
  return { packages, diagnostics };
}
async function syncDirectory(path) { const handle = await open(path, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
async function save(root, request, signal) {
  safeRelative(request.relativePath);
  if (!Array.isArray(request.files) || !request.files.length || request.files.length > MAX_FILES) fail('invalid', 'Invalid skill package file count.');
  const paths = new Set(); let total = 0;
  for (const file of request.files) { total += bytes(file).length; if (paths.has(file.path)) fail('invalid','Duplicate resource path.'); paths.add(file.path); }
  if (total > MAX_BYTES || !request.files.some(file => file.path === 'SKILL.md' && file.encoding === 'utf8')) fail('invalid', 'Invalid or oversized skill package.');
  if (request.expectedDigest !== null && !/^[a-f0-9]{64}$/.test(request.expectedDigest ?? '')) fail('invalid', 'An exact expected digest or null create precondition is required.');
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(request.requestId ?? '')) fail('invalid', 'Stable mutation request ID required.');
  // Creation is authorized against the registered parent; never infer a home directory.
  await verifyRoot(root);
  await mkdir(root.path, { recursive: true, mode: 0o700 });
  const auth = await authority(root), target = join(auth.path, request.relativePath);
  const parent = dirname(target);
  let cursor = auth.path;
  for (const component of relative(auth.path, parent).split('/').filter(Boolean)) {
    const child = join(cursor, component);
    try { const found = await checked(auth, child); if (!found.information.isDirectory() || !inside(auth.canonical, found.canonical)) fail('denied', 'Write parent escapes registered root.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(child, { mode: 0o700 }); }
    cursor = child;
  }
  const parentCanonical = await realpath(parent);
  if (!inside(auth.canonical, parentCanonical)) fail('denied', 'Write destination escapes registered root.');
  const token = createHash('sha256').update(request.relativePath).digest('hex');
  const lockPath = join(auth.canonical, `.convoy-skill-${token}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') return { status: 'uncertain', message: 'A prior mutation requires inspection before retrying.', requestId: request.requestId };
    throw error;
  }
  const stage = join(parentCanonical, `.convoy-skill-${randomUUID()}.stage`), backup = stage + '.backup';
  let mutation = false, committed = false, success = false;
  try {
    await lock.writeFile(JSON.stringify({ requestId: request.requestId, relativePath: request.relativePath, expectedDigest: request.expectedDigest, stage, backup })); await lock.sync(); await syncDirectory(auth.canonical);
    let current;
    try { current = await capture(auth, request.relativePath, signal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((current?.digest ?? null) !== request.expectedDigest) return { status: 'conflict', digest: current?.digest ?? null };
    if (current && (await lstat(target)).isSymbolicLink()) fail('denied', 'Editing a symlink alias is unsupported; use the canonical registered destination.');
    await mkdir(stage, { mode: 0o700 });
    for (const file of request.files) {
      signal?.throwIfAborted(); const path = join(stage, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await open(path, 'wx', 0o600); try { await handle.writeFile(bytes(file)); await handle.sync(); } finally { await handle.close(); }
    }
    // Compare again immediately before the directory transaction.
    const refreshedAuth = await authority(root);
    if (refreshedAuth.canonical !== auth.canonical || await realpath(parent) !== parentCanonical) fail('denied', 'Registered path changed before save.');
    let latest;
    try { latest = await capture(auth, request.relativePath, signal); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if ((latest?.digest ?? null) !== request.expectedDigest) return { status: 'conflict', digest: latest?.digest ?? null };
    signal?.throwIfAborted(); mutation = true;
    if (latest) await rename(target, backup);
    await rename(stage, target); committed = true;
    const observed = await capture(auth, request.relativePath);
    if (observed.digest !== skillPackageDigest(request.files)) throw new Error('Saved content changed before verification.');
    if (latest) {
      const backedUp = await capture(auth, relative(auth.path, backup));
      if (backedUp.digest !== request.expectedDigest) throw new Error('External content changed during commit; preserved backup requires reconciliation.');
    }
    const directoryHandle = await open(parentCanonical, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    await rm(backup, { recursive: true, force: true }); success = true;
    return { status: 'saved', ...observed, requestId: request.requestId };
  } catch (error) {
    if (mutation) return { status: 'uncertain', message: error.message, requestId: request.requestId, committed };
    throw error;
  } finally {
    await lock.close();
    if (!mutation || success) { await rm(stage, { recursive: true, force: true }); await rm(lockPath, { force: true }); await syncDirectory(auth.canonical); }
  }
}
function configuredPaths(root) {
  const paths = root.skillRootPaths ?? ['.agents/skills'];
  if (!Array.isArray(paths) || !paths.length || paths.length > 8) fail('denied', 'Invalid configured skill root paths.');
  for (const path of paths) safeRelative(path);
  return paths;
}
function relevantRoot(root, relativePath) {
  safeRelative(relativePath);
  for (const suffix of configuredPaths(root)) {
    const marker = `${suffix}/`, index = relativePath.indexOf(marker);
    if (index >= 0 && (index === 0 || relativePath[index - 1] === '/')) {
      const boundary = relativePath.slice(0, index).replace(/\/$/, '');
      return { boundary, path: join(root.repositoryPath, boundary, suffix), skillRelative: relativePath.slice(index + marker.length) };
    }
  }
  fail('denied', 'Skill is outside configured repository skill roots.');
}
async function discoverRepository(root, signal) {
  if (!isAbsolute(root.repositoryPath)) fail('denied', 'Absolute authorized repository boundary required.');
  const auth = await authority({ ...root, path: root.repositoryPath, repositoryPath: undefined, approvedRepositoryPath: undefined, approvedCanonicalPath: root.approvedRepositoryPath }), packages = [], diagnostics = [], physical = new Set(); let count = 0, packageBytes = 0;
  const suffixes = configuredPaths(root);
  async function visit(directory, boundary, depth) {
    signal?.throwIfAborted();
    if (depth > MAX_DEPTH || ++count > MAX_ENTRIES) return diagnostics.push({ relativeDirectory: boundary, code: 'unsupported_resource', message: 'Repository root discovery traversal limit exceeded.' });
    const info = await checked(auth, directory);
    if (!info.information.isDirectory() || physical.has(info.canonical)) return;
    physical.add(info.canonical);
    for (const suffix of suffixes) {
      const skillRootPath = join(directory, suffix);
      const skillRoot = { ...root, repositoryPath: undefined, approvedRepositoryPath: undefined, path: skillRootPath, approvedCanonicalPath: resolve(skillRootPath) === resolve(root.path) ? root.approvedCanonicalPath : join(auth.canonical, boundary, suffix) };
      try { const item = await checked(auth, skillRoot.path); if (!item.information.isDirectory()) continue; }
      catch(error) { if (error.code !== 'ENOENT') diagnostics.push({ relativeDirectory: [boundary,suffix].filter(Boolean).join('/'), code: error.code ?? 'unreadable', message: error.message }); continue; }
      const found = await skillFiles({ operation: 'discover', root: skillRoot }, signal);
      for (const pkg of found.packages) {
        const size = pkg.files.reduce((sum,file)=>sum+bytes(file).length,0);
        if (packages.length >= 128 || packageBytes + size > MAX_BYTES) { diagnostics.push({ relativeDirectory: [boundary,suffix,pkg.relativeDirectory].filter(Boolean).join('/'), code: 'unsupported_resource', message: 'Catalogue capture size exceeded.' }); continue; }
        packageBytes += size;
        packages.push({ ...pkg, relativeDirectory: [boundary, suffix, pkg.relativeDirectory].filter(Boolean).join('/'), relevanceBoundary: boundary });
      }
      for (const diagnostic of found.diagnostics) if (diagnostic.code !== 'missing') diagnostics.push({ ...diagnostic, relativeDirectory: [boundary,suffix,diagnostic.relativeDirectory].filter(Boolean).join('/') });
    }
    for (const entry of (await readdir(directory)).sort()) {
      if (entry.startsWith('.') || ['node_modules','vendor','dist','build'].includes(entry)) continue;
      const child = join(directory,entry), item = await lstat(child);
      if (item.isDirectory() || item.isSymbolicLink()) try { await visit(child, boundary ? `${boundary}/${entry}` : entry, depth + 1); }
      catch(error) { diagnostics.push({ relativeDirectory: boundary ? `${boundary}/${entry}` : entry, code: error.code ?? 'unreadable', message: error.message }); }
    }
  }
  const base = root.discoveryBasePath ? resolve(root.repositoryPath, root.discoveryBasePath) : auth.path;
  if (!inside(auth.path, base)) fail('denied', 'Discovery boundary escapes authorized repository.');
  const baseCanonical = await realpath(base);
  const expectedBase = join(auth.canonical, relative(auth.path, base));
  if (baseCanonical !== expectedBase) fail('denied', 'Discovery boundary changed its approved canonical target.');
  await visit(base,relative(auth.path,base),0); return {packages,diagnostics};
}
async function inspectMutation(request, signal) {
  safeRelative(request.relativePath);
  await verifyRoot(request.root);
  try {await lstat(request.root.path);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    // No root-local journal can exist when its approved directory is absent.
    // Reconciliation observes absence; it never retries the interrupted write.
    return {status:'observed',current:null};
  }
  const auth = await authority(request.root);
  const token = createHash('sha256').update(request.relativePath).digest('hex');
  const lockPath = join(auth.canonical, `.convoy-skill-${token}.lock`);
  let pending;
  try {
    const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > 8192) fail('invalid', 'Mutation journal exceeds limit.');
      pending = JSON.parse(await handle.readFile('utf8'));
      if (pending.relativePath !== request.relativePath || !/^[a-zA-Z0-9-]{1,100}$/.test(pending.requestId ?? '')) fail('invalid', 'Invalid mutation journal.');
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let current;
  try { current = await capture(auth, request.relativePath, signal); } catch (error) { if (error.code !== 'ENOENT') return { status: 'uncertain', pending, diagnostic: error.message }; }
  // Resolving is an explicit command with the freshly inspected digest. Never replay a mutation.
  if (request.operation === 'reconcile' && pending) {
    if (request.requestId !== pending.requestId || request.expectedDigest !== (current?.digest ?? null)) return { status: 'conflict', pending, digest: current?.digest ?? null };
    // Retain stage/backup for inspection and explicit recovery; remove only the mutation gate.
    await rm(lockPath); await syncDirectory(auth.canonical);
  }
  return { status: pending && request.operation !== 'reconcile' ? 'uncertain' : 'observed', pending, current: current ?? null };
}
async function repositoryRevision(path, signal) {
  const result = await processRun('git', ['-C', path, 'rev-parse', '--verify', 'HEAD'], { signal, timeout: 5000 });
  const revision = result.output.trim();
  return result.code === 0 && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(revision) ? revision : undefined;
}
async function repositoryFiles(request, signal) {
    if (request.operation === 'discover') return discoverRepository(request.root, signal);
    const located = relevantRoot(request.root, request.relativePath);
    if (request.root.discoveryBasePath) {
      const base = resolve(request.root.repositoryPath, request.root.discoveryBasePath);
      if (!inside(base, located.path)) fail('denied', 'Skill is outside registered directory relevance.');
    }
    const repository = await authority({ ...request.root, path: request.root.repositoryPath, repositoryPath: undefined, approvedRepositoryPath: undefined, approvedCanonicalPath: request.root.approvedRepositoryPath });
    // Check existing ancestors against the approved repository before following a configured nested root.
    let ancestor = dirname(located.path);
    while (ancestor !== request.root.repositoryPath) {
      try { const canonical = await realpath(ancestor); if (!inside(repository.canonical, canonical)) fail('denied', 'Nested skill root escapes authorized repository.'); break; }
      catch(error) { if(error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
    }
    const result = await skillFiles({ ...request, root: { ...request.root, repositoryPath: undefined, approvedRepositoryPath: undefined, path: located.path, approvedCanonicalPath: resolve(located.path) === resolve(request.root.path) ? request.root.approvedCanonicalPath : join(repository.canonical, relative(request.root.repositoryPath, located.path)) }, relativePath: located.skillRelative }, signal);
    return { ...result, ...(result.relativeDirectory !== undefined ? { relativeDirectory: request.relativePath, relevanceBoundary: located.boundary } : {}) };
}
export async function skillFiles(request, signal) {
  signal?.throwIfAborted();
  if (!['approve','discover','capture','save','provision','inspect','reconcile'].includes(request?.operation)) fail('invalid', 'Unknown skill filesystem operation.');
  if (request.operation === 'approve') return approveRoot(request.root);
  if (request.root?.repositoryPath) {
    await verifyRoot(request.root);
    const readOnly = ['capture','discover','inspect'].includes(request.operation);
    for (let attempt = 0; attempt < (readOnly ? 3 : 1); attempt++) {
      const before = await repositoryRevision(request.root.repositoryPath, signal);
      const result = await repositoryFiles(request, signal);
      const after = await repositoryRevision(request.root.repositoryPath, signal);
      if (before === after) return { ...result, ...(after ? { repositoryRevision: after,
        ...(result.packages ? { packages: result.packages.map(pkg => ({ ...pkg, repositoryRevision: after })) } : {}) } : {}) };
      if (!readOnly) return { ...result, status: 'uncertain', requestId: request.requestId, message: 'Repository revision changed during mutation; inspect before retrying.' };
    }
    if (request.operation === 'discover') return { packages: [], diagnostics: [{ relativeDirectory: '', code: 'unstable', message: 'Repository revision changed during discovery.' }] };
    fail('unstable', 'Repository revision changed during capture.');
  }
  if (['inspect','reconcile'].includes(request.operation)) return inspectMutation(request, signal);
  if (['save','provision'].includes(request.operation)) {
    const key = `${request.root?.path}:${request.relativePath}`;
    if (locks.has(key)) return { status: 'conflict', message: 'Another save is in progress.' };
    const pending = save(request.root, request, signal); locks.set(key, pending);
    try { return await pending; } finally { locks.delete(key); }
  }
  try {
    const auth = await authority(request.root);
    return request.operation === 'discover' ? await discover(auth, signal) : await capture(auth, request.relativePath ?? '', signal);
  } catch (error) {
    if (request.operation === 'discover') return { packages: [], diagnostics: [{ relativeDirectory: '', code: error.code === 'ENOENT' ? 'missing' : error.code ?? 'unreadable', message: error.message }] };
    throw error;
  }
}
export function watchSkillRoots(roots, onChange, { debounceMs = 150, reconcileMs = 1500 } = {}) {
  let closed = false, timer; const watchers = [];
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => { if (!closed) void Promise.resolve(onChange()).catch(() => {}); }, debounceMs); timer.unref?.(); };
  // Watch parents as well as existing roots so new/deleted roots trigger refresh.
  for (const root of roots) for (const path of [dirname(root.path), root.path]) {
    try { const watcher = watch(path, changed); watcher.on('error', changed); watchers.push(watcher); } catch {}
  }
  const interval = setInterval(changed, Math.max(250, Math.min(reconcileMs, 30000))); interval.unref?.();
  return () => { closed = true; clearTimeout(timer); clearInterval(interval); for (const watcher of watchers) watcher.close(); };
}
