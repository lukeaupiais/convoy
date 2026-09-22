import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validPath = (path) =>
  typeof path === 'string' && path && !isAbsolute(path) &&
  path.split(/[\\/]/).every((part) => part && part !== '.' && part !== '..');

async function assertStopped(directory) {
  let lock;
  try {
    lock = await readFile(join(directory, 'daemon.lock'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const pid = Number(lock);
  if (Number.isSafeInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      throw new Error('Stop the Convoy daemon before backing up or restoring this deployment.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  throw new Error('Remove the stale daemon.lock only after confirming the daemon is stopped.');
}

async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function filesUnder(root, parent = '') {
  const files = [];
  for (const name of await readdir(join(root, parent))) {
    if (parent === '' && name === 'daemon.lock') continue;
    const path = parent ? `${parent}/${name}` : name;
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error(`Deployment contains a symlink: ${path}`);
    if (info.isDirectory()) files.push(...await filesUnder(root, path));
    else if (info.isFile()) files.push(path);
    else throw new Error(`Deployment contains an unsupported entry: ${path}`);
  }
  return files.sort();
}

async function databaseGuard(connectionString, empty = false, expectedStoreId) {
  const client = new pg.Client({ connectionString });
  client.on('error', (error) => { client.backupFailure = error; });
  await client.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(112407421) AS acquired');
    if (!lock.rows[0]?.acquired)
      throw new Error('Stop the PostgreSQL Convoy coordinator before backup or restore.');
    if (empty) {
      const tables = await client.query("SELECT count(*)::integer AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
      if (tables.rows[0].total)
        throw new Error('Restore requires an empty PostgreSQL database.');
    } else {
      const state = await client.query("SELECT to_regclass('public.convoy_state_items') AS table_name");
      if (!state.rows[0].table_name)
        throw new Error('PostgreSQL database has no Convoy state.');
      if (expectedStoreId) {
        const identity = await client.query('SELECT id FROM convoy_storage_identity');
        if (identity.rows.length !== 1 || identity.rows[0].id !== expectedStoreId)
          throw new Error('PostgreSQL database does not match the deployment storage identity.');
      }
    }
    return client;
  } catch (error) { await client.end(); throw error; }
}

async function postgresTool(command, args, connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('PostgreSQL backup needs a postgres:// connection URL.');
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!databaseName) throw new Error('PostgreSQL connection URL needs a database name.');
  const environment = {
    ...process.env,
    PGHOST: url.searchParams.get('host') ?? url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: databaseName,
    ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode') } : {}),
  };
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk.toString().slice(0, 4096); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${errorText.trim()}`)));
  });
}

/** Capture an offline deployment, including its identity, credentials, and blobs. */
export async function backupDeployment(source, destination, { databaseUrl } = {}) {
  const root = resolve(source);
  const target = resolve(destination);
  if (root === target || target.startsWith(root + sep))
    throw new Error('The backup destination must be outside the deployment directory.');
  if (!(await lstat(root)).isDirectory()) throw new Error('Deployment path is not a directory.');
  await assertStopped(root);
  let storage;
  try { storage = JSON.parse(await readFile(join(root, 'runtime', 'storage.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Deployment storage identity is unreadable.'); }
  if (storage?.backend === 'postgres' && !databaseUrl)
    throw new Error('This PostgreSQL deployment needs CONVOY_DATABASE_URL for a complete backup.');
  if (storage?.backend === 'sqlite' && databaseUrl)
    throw new Error('This SQLite deployment must be backed up without CONVOY_DATABASE_URL.');
  if (storage && !['sqlite', 'postgres'].includes(storage.backend))
    throw new Error('Unknown deployment persistence backend.');
  try { await lstat(target); throw new Error('Backup destination already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = `${target}.tmp-${randomUUID()}`;
  const manifest = { format: 'convoy-offline-backup', version: 1, createdAt: new Date().toISOString(), files: [] };
  let database;
  try {
    if (databaseUrl) database = await databaseGuard(databaseUrl, false, storage?.storeId);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const path of await filesUnder(root)) {
      const from = join(root, path);
      const to = join(staging, 'data', path);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const bytes = await readFile(from);
      await writeFile(to, bytes, { mode: 0o600, flag: 'wx' });
      const file = await open(to, 'r');
      try { await file.sync(); } finally { await file.close(); }
      manifest.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
    }
    if (databaseUrl) {
      const dump = join(staging, 'database.pgcustom');
      await postgresTool('pg_dump', ['--format=custom', '--file', dump], databaseUrl);
      if (database.backupFailure) throw database.backupFailure;
      await database.query('SELECT 1');
      const bytes = await readFile(dump);
      manifest.database = { kind: 'postgres', bytes: bytes.length, sha256: digest(bytes) };
    }
    if (!manifest.database && !manifest.files.some((entry) => entry.path === 'runtime/state.json' || entry.path === 'runtime/state.sqlite'))
      throw new Error('Deployment has no recognized runtime state.');
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await syncDirectory(staging);
    await rename(staging, target);
    await syncDirectory(dirname(target));
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await database?.end();
  }
}

/** Restore into a new location; never overwrite an existing deployment. */
export async function restoreDeployment(source, destination, { databaseUrl } = {}) {
  const root = resolve(source);
  const target = resolve(destination);
  if (root === target || target.startsWith(root + sep))
    throw new Error('Restore destination must be outside the backup directory.');
  try { await lstat(target); throw new Error('Restore destination already exists.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'convoy-offline-backup' || manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('Unsupported Convoy backup manifest.');
  const listed = new Set();
  for (const entry of manifest.files) {
    if (!validPath(entry.path) || listed.has(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error('Backup manifest has an invalid file entry.');
    listed.add(entry.path);
  }
  if (!manifest.database && !listed.has('runtime/state.json') && !listed.has('runtime/state.sqlite'))
    throw new Error('Backup has no recognized runtime state.');
  let storage;
  if (listed.has('runtime/storage.json')) {
    storage = JSON.parse(await readFile(join(root, 'data', 'runtime', 'storage.json'), 'utf8'));
    if ((storage.backend === 'postgres') !== Boolean(manifest.database))
      throw new Error('Backup storage identity and database manifest disagree.');
  }
  if (manifest.database && (!databaseUrl || manifest.database.kind !== 'postgres' || !/^[a-f0-9]{64}$/.test(manifest.database.sha256)))
    throw new Error('PostgreSQL restore needs CONVOY_RESTORE_DATABASE_URL and a valid database manifest.');
  const actual = await filesUnder(join(root, 'data'));
  if (actual.length !== listed.size || actual.some((path) => !listed.has(path)))
    throw new Error('Backup file list does not match its manifest.');
  const staging = `${target}.tmp-${randomUUID()}`;
  let database;
  try {
    if (manifest.database) {
      const bytes = await readFile(join(root, 'database.pgcustom'));
      if (bytes.length !== manifest.database.bytes || digest(bytes) !== manifest.database.sha256)
        throw new Error('PostgreSQL backup integrity check failed.');
      database = await databaseGuard(databaseUrl, true);
    }
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const entry of manifest.files) {
      const bytes = await readFile(join(root, 'data', entry.path));
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
        throw new Error(`Backup integrity check failed: ${entry.path}`);
      const to = join(staging, entry.path);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await writeFile(to, bytes, { mode: 0o600, flag: 'wx' });
    }
    if (manifest.database)
      await postgresTool('pg_restore', ['--dbname', decodeURIComponent(new URL(databaseUrl).pathname.slice(1)), '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', join(root, 'database.pgcustom')], databaseUrl);
    if (database) {
      if (database.backupFailure) throw database.backupFailure;
      await database.query('SELECT 1');
      if (storage?.storeId) {
        const identity = await database.query('SELECT id FROM convoy_storage_identity');
        if (identity.rows.length !== 1 || identity.rows[0].id !== storage.storeId)
          throw new Error('Restored PostgreSQL database does not match deployment storage identity.');
      }
    }
    await syncDirectory(staging);
    await rename(staging, target);
    await syncDirectory(dirname(target));
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await database?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, source, destination] = process.argv.slice(2);
  if (!source || !destination || !['backup', 'restore'].includes(action)) {
    console.error('Usage: node scripts/convoy-backup.mjs <backup|restore> <source> <new-destination>');
    process.exitCode = 2;
  } else {
    try {
      const result = action === 'backup'
        ? await backupDeployment(source, destination, { databaseUrl: process.env.CONVOY_DATABASE_URL })
        : await restoreDeployment(source, destination, { databaseUrl: process.env.CONVOY_RESTORE_DATABASE_URL });
      console.log(`${action} complete: ${result.files.length} verified files`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
