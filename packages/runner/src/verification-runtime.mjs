import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The runner owns this adapter. No application, ticket or workflow policy lives here.
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value) => /^[a-f0-9-]{36}$/.test(value ?? '');
async function run(command, args, { input, timeout = 30000, maxBytes = 1000000, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const chunks = [];
    let bytes = 0,
      errorText = '',
      stopped = null;
    const stop = (reason) => {
      stopped ??= reason;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop(`deadline ${timeout}ms`), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) stop('output limit');
      else chunks.push(c);
    });
    child.stderr.on('data', (c) => {
      errorText = (errorText + c).slice(-4000);
    });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(chunks);
      if (code !== 0 || stopped)
        reject(
          new Error(
            `Runtime operation failed (${command} ${args[0] ?? ''}, ${stopped ?? code}): ${errorText}`,
          ),
        );
      else resolveResult(output);
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
const docker = (args, options) => run('/usr/bin/docker', args, options);
async function metadataPath(workspace) {
  const path = (
    await run('git', [
      '-C',
      workspace,
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'convoy-verification.json',
    ])
  )
    .toString()
    .trim();
  if (!path || !path.startsWith('/')) throw new Error('Invalid runtime metadata location.');
  return path;
}
async function load(workspace) {
  try {
    return JSON.parse(await readFile(await metadataPath(workspace), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function save(workspace, value) {
  const path = await metadataPath(workspace);
  const tmp = path + '.' + randomUUID();
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await rename(tmp, path);
}
// Durable mutual exclusion fences concurrent RPCs and fails closed after a
// worker crash. Recovery never guesses that an abandoned operation succeeded.
async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock owner.');
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const localOperations = new Map();
async function exclusive(workspace, fn, reconcile = false) {
  const lock = (await metadataPath(workspace)) + '.lock';
  // A command can exit while its launcher is still persisting activeCommand.
  // Serialize this worker's callbacks/RPCs; the durable lock still rejects
  // other workers and abandoned operations instead of guessing they completed.
  const previous = localOperations.get(lock);
  let release;
  const done = new Promise((resolve) => {
    release = resolve;
  });
  localOperations.set(lock, done);
  await previous;
  try {
    return await lockedOperation(lock, fn, reconcile);
  } finally {
    release();
    if (localOperations.get(lock) === done) localOperations.delete(lock);
  }
}
async function lockedOperation(lock, fn, reconcile) {
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!reconcile) throw new Error('Runtime operation is active or requires reconciliation.');
    const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
    if (!/^[0-9]+$/.test(owner.start ?? '')) throw new Error('Invalid lock owner identity.');
    if ((await processIdentity(owner.pid)) === owner.start)
      throw new Error('Runtime operation owner is still active.');
    const retired = lock + '.retired-' + randomUUID();
    await rename(lock, retired);
    try {
      await mkdir(lock, { mode: 0o700 });
    } finally {
      await rm(retired, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, start: await processIdentity(process.pid) }),
      { mode: 0o600 },
    );
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
async function processTable(record) {
  return (await docker(['top', record.container, '-eo', 'pid,ppid,lstart'], { maxBytes: 64000 }))
    .toString()
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => {
      const [pid, parent, ...started] = line.trim().split(/\s+/);
      return { pid, parent, identity: `${pid} ${started.join(' ')}` };
    });
}
function hasUnmanagedProcesses(before, after, initPid) {
  const baseline = new Set(before.map((p) => p.identity));
  // The init and launcher are not service owners: abandoned exec children can
  // be reparented there. Only an existing application process can own new work.
  const services = new Set(
    before
      .filter((p) => p.pid !== String(initPid) && p.parent !== String(initPid))
      .map((p) => p.identity),
  );
  const byPid = new Map(after.map((p) => [p.pid, p]));
  return after.some((process) => {
    if (baseline.has(process.identity)) return false;
    const seen = new Set();
    let parent = byPid.get(process.parent);
    while (parent && !seen.has(parent.pid)) {
      if (services.has(parent.identity)) return false;
      seen.add(parent.pid);
      parent = byPid.get(parent.parent);
    }
    return true;
  });
}
async function removeContainer(record) {
  const ids = (await docker(['ps', '-aq', '--filter', `name=^/${record.container}$`]))
    .toString()
    .trim();
  if (ids) {
    const observed = await inspect(record, { discover: !record.containerId });
    record.containerId = observed.Id;
    await docker(['rm', '--force', record.container]);
  } else if (record.containerCreationStarted && !record.containerId) {
    // Killing the Docker client does not prove the daemon cancelled create.
    // Keep this generation uncertain until its exact container can be reconciled.
    throw new Error('Runtime container creation outcome is unproven; reconcile before reuse.');
  }
  if ((await docker(['ps', '-aq', '--filter', `name=^/${record.container}$`])).toString().trim())
    throw new Error('Runtime teardown is unproven.');
  await run('systemctl', ['--user', 'stop', `${record.container}-expiry.timer`]).catch(() => {});
}
async function removeImage(record) {
  if (
    record.image &&
    (await docker(['image', 'ls', '--no-trunc', '--quiet']))
      .toString()
      .split('\n')
      .includes(record.image)
  )
    await docker(['image', 'rm', record.image]);
}
function assertBinding(record, execution) {
  if (
    !record ||
    record.policyDigest !== execution?.policyDigest ||
    record.assignmentToken !== execution?.assignmentToken ||
    record.definitionDigest !== execution?.grant?.runtime?.definition?.digest
  )
    throw new Error('Runtime assignment or definition mismatch. Reconcile before reuse.');
}
const helper = `import {readFile,lstat,realpath,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {dirname,resolve} from 'node:path';
const hash=b=>createHash('sha256').update(b).digest('hex');
const [action,encoded]=process.argv.slice(2);const a=JSON.parse(encoded);
const parts=(a.path??'').split('/');
if(!parts.length||parts.some(p=>!p||p==='..'||p==='.'||['.git','.ssh','.codex','.convoy'].includes(p)||p.startsWith('.env'))||a.path.includes('\\\\'))throw Error('Invalid runtime path');
const path=resolve(a.path.startsWith('scratch/')?'/':'/source',a.path);
if(!path.startsWith('/source/')&&!path.startsWith('/scratch/'))throw Error('Outside runtime');
let cursor='';for(const part of path.split('/').filter(Boolean)){cursor+='/'+part;try{const st=await lstat(cursor);if(st.isSymbolicLink()||(st.isFile()&&st.nlink!==1))throw Error('Link denied');}catch(e){if(e.code!=='ENOENT'||action!=='write')throw e;}}
if(action==='write'){if(!path.startsWith('/scratch/')||typeof a.content!=='string'||Buffer.byteLength(a.content)>32000)throw Error('Writes require bounded scratch path');let old='';try{old=hash(await readFile(path));}catch(e){if(e.code!=='ENOENT')throw e;}if(old!==a.expectedHash)throw Error('File changed');await mkdir(dirname(path),{recursive:true});await writeFile(path,a.content);console.log(JSON.stringify({path:a.path,sha256:hash(a.content)}));}
else {const st=await lstat(path);if(!st.isFile()||st.size>1000000)throw Error('Not a bounded regular file');const b=await readFile(path);const text=new TextDecoder('utf-8',{fatal:true}).decode(b);const lines=text.split('\\n');if(lines.at(-1)==='')lines.pop();const start=a.offset??1,limit=a.limit??200;if(!Number.isInteger(start)||start<1||!Number.isInteger(limit)||limit<1||limit>2000)throw Error('Invalid range');const end=Math.min(lines.length,start+limit-1);const page=lines.slice(start-1,end).join('\\n')+(end>=start?'\\n':'');if(Buffer.byteLength(page)>32000)throw Error('Narrow source range');console.log(JSON.stringify({path:a.path,text:page,sha256:hash(b),startLine:start,endLine:end,totalLines:lines.length,truncated:end<lines.length,nextColumn:null}));}
`;
const launcher = `import {spawn} from 'node:child_process';
const argv=JSON.parse(process.argv[2]);let child;
if(argv.length){child=spawn(argv[0],argv.slice(1),{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:'/scratch',TMPDIR:'/tmp',LANG:'C.UTF-8'}});let bytes=0;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{bytes+=b.length;if(bytes>1000000)process.exit(74);});child.on('error',()=>process.exit(70));child.on('exit',c=>process.exit(c??1));}
setInterval(()=>{},1000);process.on('SIGTERM',()=>{child?.kill('SIGTERM');setTimeout(()=>process.exit(0),500);});
`;
function limits(definition) {
  const l = definition.limits;
  return [
    '--init',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    `${l.memoryMb}m`,
    '--memory-swap',
    `${l.memoryMb}m`,
    '--cpus',
    String(l.cpus),
    '--pids-limit',
    String(l.pids),
    '--shm-size',
    `${l.sharedMemoryMb ?? 1}m`,
    '--tmpfs',
    `/scratch:rw,nosuid,nodev,size=${l.scratchMb}m,mode=1777`,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=16m,mode=1777',
    '--log-driver',
    'none',
    '--user',
    '1000:1000',
  ];
}
async function inspect(record, { discover = false } = {}) {
  const [value] = JSON.parse((await docker(['inspect', record.container])).toString());
  if (
    (!discover && value.Id !== record.containerId) ||
    value.Image !== record.image ||
    value.Config.Labels?.['convoy.runtime'] !== record.id ||
    value.HostConfig.NetworkMode !== 'none' ||
    value.HostConfig.Init !== true ||
    !value.HostConfig.ReadonlyRootfs ||
    value.HostConfig.Privileged ||
    value.Mounts.some((m) => m.Type !== 'tmpfs') ||
    value.Config.User !== '1000:1000' ||
    value.HostConfig.Memory !== record.definition.limits.memoryMb * 1048576 ||
    value.HostConfig.MemorySwap !== record.definition.limits.memoryMb * 1048576 ||
    value.HostConfig.ShmSize !== (record.definition.limits.sharedMemoryMb ?? 1) * 1048576 ||
    value.HostConfig.PidsLimit !== record.definition.limits.pids ||
    value.HostConfig.NanoCpus !== Math.round(record.definition.limits.cpus * 1e9) ||
    !value.HostConfig.CapDrop?.includes('ALL') ||
    value.HostConfig.CapAdd?.length ||
    !value.HostConfig.SecurityOpt?.includes('no-new-privileges')
  )
    throw new Error('Runtime container identity or enforcement changed.');
  return value;
}
export async function probeVerificationRuntime() {
  try {
    const info = JSON.parse(
      (await docker(['info', '--format', '{{json .}}'], { timeout: 5000 })).toString(),
    );
    if (info.CgroupVersion !== '2' || !info.MemoryLimit || !info.PidsLimit) return false;
    await run('systemd-run', ['--user', '--wait', '--pipe', '--quiet', '/usr/bin/true'], {
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
async function prepare(workspace, execution, signal) {
  const definition = execution?.grant?.runtime?.definition;
  if (execution?.grant?.profileId !== 'verify' || !definition || !uuid(execution.assignmentToken))
    throw new Error('Verification grant required.');
  const prior = await load(workspace);
  if (prior?.state === 'sealed') {
    if (prior.definitionDigest !== definition.digest)
      throw new Error('Sealed definition changed; explicit reset required.');
    prior.assignmentToken = execution.assignmentToken;
    prior.policyDigest = execution.policyDigest;
    await save(workspace, prior);
    return publicRecord(prior);
  }
  if (prior?.state === 'unavailable' && prior.assignmentToken === execution.assignmentToken) {
    assertBinding(prior, execution);
    return publicRecord(prior);
  }
  if (prior && !['destroyed', 'sealed'].includes(prior.state)) {
    assertBinding(prior, execution);
    if (prior.state === 'ready' && Date.now() < prior.expiresAt) {
      await inspect(prior);
      return publicRecord(prior);
    }
    throw new Error('Prior runtime is uncertain; reconcile it before retry.');
  }
  if (!(await probeVerificationRuntime()))
    throw new Error('Docker cgroup v2 and independent user-service supervision required.');
  const image = JSON.parse((await docker(['image', 'inspect', definition.image])).toString())[0];
  if (
    image.Id !== definition.image ||
    (image.Config.Volumes && Object.keys(image.Config.Volumes).length) ||
    image.Config.OnBuild?.length
  )
    throw new Error('Bundle must be immutable and declare no implicit volumes.');
  const head = (await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])).toString().trim();
  if (head !== definition.sourceCommit)
    throw new Error('Runtime source commit does not match assignment.');
  const id = randomUUID(),
    container = `convoy-verification-${id}`;
  const record = {
    id,
    container,
    state: 'preparing',
    generation: (prior?.generation ?? 0) + 1,
    policyDigest: execution.policyDigest,
    assignmentToken: execution.assignmentToken,
    definitionDigest: definition.digest,
    definition,
    sourceCommit: head,
    expiresAt: Date.now() + definition.limits.lifetimeSeconds * 1000,
    receipts: [],
    sealedFiles: {},
  };
  await save(workspace, record);
  const directory = await mkdtemp(join(tmpdir(), 'convoy-runtime-build-'));
  try {
    const archive = join(directory, 'source.tar');
    await run(
      '/bin/sh',
      [
        '-c',
        'ulimit -f 524288; exec "$@"',
        'bounded-archive',
        'git',
        '-C',
        workspace,
        'archive',
        '--format=tar',
        `--output=${archive}`,
        head,
      ],
      { signal, timeout: 30000 },
    );
    if ((await lstat(archive)).size > 512 * 1024 * 1024)
      throw new Error('Source archive exceeds preparation quota.');
    const archiveHash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) archiveHash.update(chunk);
    record.sourceDigest = archiveHash.digest('hex');
    await writeFile(join(directory, 'helper.mjs'), helper);
    await writeFile(join(directory, 'launcher.mjs'), launcher);
    await docker(['tag', definition.image, `convoy-runtime-bundle:${definition.image.slice(7)}`]);
    await writeFile(
      join(directory, 'Dockerfile'),
      `FROM convoy-runtime-bundle:${definition.image.slice(7)}\nUSER root\nADD source.tar /source/\nCOPY helper.mjs launcher.mjs /opt/convoy-runtime/\nWORKDIR /source\nUSER 1000:1000\n`,
    );
    const iid = join(directory, 'image-id');
    await docker(['build', '--network', 'none', '--pull=false', '--iidfile', iid, directory], {
      signal,
      timeout: 120000,
    });
    record.image = (await readFile(iid, 'utf8')).trim();
    await save(workspace, record);
    // Install expiry before create: a lost client response must not leave an
    // unowned container without independent cleanup.
    await run('systemd-run', [
      '--user',
      '--quiet',
      '--collect',
      `--unit=${container}-expiry`,
      `--on-active=${Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000))}s`,
      '--timer-property=AccuracySec=1s',
      `--property=ExecStopPost=/usr/bin/docker image rm ${record.image}`,
      '/usr/bin/docker',
      'rm',
      '--force',
      container,
    ]);
    const startupDeadline = Math.min(
      record.expiresAt,
      Date.now() + definition.limits.startupSeconds * 1000,
    );
    const startupOptions = () => {
      const timeout = startupDeadline - Date.now();
      if (timeout <= 0) throw new Error('Runtime startup deadline exceeded.');
      return { signal, timeout };
    };
    record.containerCreationStarted = true;
    await save(workspace, record);
    record.containerId = (
      await docker(
        [
          'create',
          '--name',
          container,
          '--label',
          `convoy.runtime=${id}`,
          '--label',
          `convoy.expires=${record.expiresAt}`,
          ...limits(definition),
          '--entrypoint',
          '/usr/local/bin/node',
          record.image,
          '/opt/convoy-runtime/launcher.mjs',
          JSON.stringify(definition.startup),
        ],
        startupOptions(),
      )
    )
      .toString()
      .trim();
    await save(workspace, record);
    if (Date.now() >= record.expiresAt)
      throw new Error('Runtime preparation exceeded its lifetime.');
    await docker(['start', container], startupOptions());
    await inspect(record);
    const readinessStarted = Date.now();
    const readinessOutput = await docker(
      ['exec', container, ...definition.readiness],
      startupOptions(),
    );
    record.readiness = {
      command: definition.readiness,
      code: 0,
      durationMs: Date.now() - readinessStarted,
      output: readinessOutput.toString().slice(0, 4000),
      outputDigest: sha(readinessOutput),
      outputTruncated: readinessOutput.length > 4000,
    };
    record.state = 'ready';
    await save(workspace, record);
    return publicRecord(record);
  } catch (error) {
    record.state = 'uncertain';
    record.error = error.message;
    await save(workspace, record);
    try {
      await removeContainer(record);
      await removeImage(record);
      record.state = 'destroyed';
      await save(workspace, record);
    } catch {}
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
function publicRecord(r) {
  return {
    id: r.id,
    generation: r.generation,
    state: r.state,
    expiresAt: r.expiresAt,
    sourceCommit: r.sourceCommit,
    sourceDigest: r.sourceDigest,
    bundle: r.definition.image,
    definitionDigest: r.definitionDigest,
    availability: r.availability ?? 'ready',
    setupError: r.error,
    fixtureDigest: r.definition.fixtureDigest,
    readiness: r.readiness,
    guidance: r.definition.guidance,
    limits: r.definition.limits,
  };
}
async function commandStart(workspace, execution, command, options, supervisor) {
  const r = await load(workspace);
  assertBinding(r, execution);
  if (r.state !== 'ready' || r.activeCommand || Date.now() >= r.expiresAt)
    throw new Error('Runtime is not ready or expired.');
  if (typeof command !== 'string' || !command.trim())
    throw new Error('Shell command must be a non-empty string.');
  if (command.length > 32000)
    throw new Error(`Shell command has ${command.length} characters; maximum is 32000. Split the script into smaller commands or write it in chunks and execute the file.`);
  const initialObservation = await inspect(r);
  const timeoutMs = Math.min(
    options.timeoutMs ?? r.definition.limits.commandSeconds * 1000,
    r.definition.limits.commandSeconds * 1000,
    r.expiresAt - Date.now(),
  );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid execution deadline.');
  // Workflow request budgets govern investigation; command deadlines and runtime
  // expiry bound execution. Receipts are an audit trail, not a second budget.
  const baseline = await processTable(r);
  const argv = [
    'exec',
    '--workdir',
    options.workingDirectory ? `/source/${options.workingDirectory}` : '/source',
    r.container,
    '/usr/bin/timeout',
    '--signal=KILL',
    String(timeoutMs / 1000),
    '/bin/sh',
    '-c',
    command,
  ];
  const onExit = ({ reason } = {}) =>
    exclusive(workspace, async () => {
      const current = await load(workspace);
      assertBinding(current, execution);
      const observation = await inspect(current);
      const escaped =
        observation.State.Running &&
        hasUnmanagedProcesses(baseline, await processTable(current), initialObservation.State.Pid);
      if (escaped || !observation.State.Running) {
        current.state = 'uncertain';
        await save(workspace, current);
        await removeContainer(current);
        if (reason) {
          await removeImage(current);
          current.state = 'destroyed';
          current.activeCommand = null;
          await save(workspace, current);
          return;
        }
        throw new Error('Command left unmanaged processes or runtime stopped; generation closed.');
      }
      current.activeCommand = null;
      await save(workspace, current);
    });
  const onTerminate = async () => {
    await docker(['kill', r.container]);
  };
  if (!supervisor) throw new Error('Runtime commands require the supervised command path.');
  const commandId = supervisor.start('/usr/bin/docker', argv, {
    env,
    owner: workspace,
    signal: options.signal,
    // The in-container timeout kills the command process group. Give Docker
    // time to report that exit before the host watchdog closes containment.
    // This grace is for cleanup, not additional command execution. The separate
    // runtime expiry timer remains authoritative even during cleanup.
    timeoutMs: Math.min(timeoutMs + 2000, 900000, r.expiresAt - Date.now()),
    launchId: options.launchId,
    lifetime: 'turn',
    onTerminate,
    onExit,
  });
  r.activeCommand = commandId;
  r.receipts.push({ commandId, command, startedAt: Date.now(), generation: r.generation });
  await save(workspace, r);
  return { commandId };
}
function capturedPage(captured, args) {
  const start = args.offset ?? 1,
    limit = args.limit ?? 200;
  if (
    !Number.isInteger(start) ||
    start < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 2000
  )
    throw new Error('Invalid range');
  const lines = captured.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const end = Math.min(lines.length, start + limit - 1);
  const text = lines.slice(start - 1, end).join('\n') + (end >= start ? '\n' : '');
  if (Buffer.byteLength(text) > 32000) throw new Error('Narrow source range');
  return {
    ...captured,
    text,
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated: end < lines.length,
    nextColumn: null,
  };
}
async function sourceFile(workspace, r, path) {
  if (
    typeof path !== 'string' ||
    path.length > 240 ||
    path.includes('\\') ||
    path
      .split('/')
      .some(
        (p) =>
          !p ||
          ['.', '..', '.git', '.ssh', '.convoy', '.codex'].includes(p) ||
          p.startsWith('.env'),
      )
  )
    throw new Error('Invalid source path.');
  const entry = (
    await run('git', ['-C', workspace, 'ls-tree', r.sourceCommit, '--', path])
  ).toString();
  if (!/^100(644|755) blob [a-f0-9]{40}\t/.test(entry))
    throw new Error('Expected a regular pinned source file.');
  const bytes = await run('git', ['-C', workspace, 'show', `${r.sourceCommit}:${path}`], {
    maxBytes: 1000000,
  });
  return {
    path,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    sha256: sha(bytes),
  };
}
async function tool(workspace, execution, name, args) {
  const r = await load(workspace);
  assertBinding(r, execution);
  if (!['read_file', 'write_file', 'inspect_repository'].includes(name))
    throw new Error('Tool is not supported by the verification runtime.');
  if (name === 'inspect_repository')
    return {
      ...publicRecord(r),
      note:
        r.availability === 'unavailable'
          ? 'Setup failed; only pinned source reads are available.'
          : 'Pinned immutable source at /source; use CLI for scoped navigation. Writable scratch: /scratch.',
    };
  if (r.state === 'unavailable') {
    if (name !== 'read_file')
      throw new Error('Optional runtime unavailable: only pinned source reads remain authorized.');
    return capturedPage(await sourceFile(workspace, r, args.path), args);
  }
  if (r.state === 'sealed') {
    const captured = r.sealedFiles[args.path];
    if (name !== 'read_file' || !captured)
      throw new Error('Sealed runtime only exposes captured evidence.');
    return capturedPage(captured, args);
  }
  if (r.state !== 'ready' || r.activeCommand || Date.now() >= r.expiresAt)
    throw new Error('Runtime is not ready.');
  await inspect(r);
  return JSON.parse(
    (
      await docker([
        'exec',
        r.container,
        '/usr/local/bin/node',
        '/opt/convoy-runtime/helper.mjs',
        name === 'write_file' ? 'write' : 'read',
        JSON.stringify(args),
      ])
    ).toString(),
  );
}
async function lifecycle(workspace, execution, operation, files = []) {
  const r = await load(workspace);
  assertBinding(r, execution);
  if (operation === 'status') return publicRecord(r);
  if (operation === 'destroy') {
    // Recheck even a historical destroyed record: older interrupted creates
    // could lose their returned ID while the Docker daemon finished creation.
    await removeContainer(r);
    await removeImage(r);
    r.state = 'destroyed';
    r.activeCommand = null;
    await save(workspace, r);
    return publicRecord(r);
  }
  if (operation !== 'seal') throw new Error('Unsupported runtime lifecycle operation.');
  if (r.state === 'sealed')
    return { ...publicRecord(r), receipts: r.receipts, files: r.sealedFiles };
  if (r.state === 'unavailable') {
    if (execution.grant.runtime.required) throw new Error('Required runtime evidence unavailable.');
    if (!Array.isArray(files) || files.length > 32)
      throw new Error('Evidence capture exceeds file quota.');
    for (const ref of files) r.sealedFiles[ref.path] = await sourceFile(workspace, r, ref.path);
    r.state = 'sealed';
    await save(workspace, r);
    return { ...publicRecord(r), receipts: [], files: r.sealedFiles };
  }
  if (r.state !== 'ready' || r.activeCommand || Date.now() >= r.expiresAt)
    throw new Error('Runtime cannot be sealed.');
  if (!Array.isArray(files) || files.length > 32)
    throw new Error('Evidence capture exceeds file quota.');
  r.state = 'sealing';
  await save(workspace, r);
  await docker(['pause', r.container]);
  const observation = await inspect(r);
  if (!observation.State.Paused) throw new Error('Runtime writers are not frozen.');
  // Copy regular evidence only after all writers have stopped. The bounded
  // extraction never follows archive links and does not trust model host paths.
  const directory = await mkdtemp(join(tmpdir(), 'convoy-runtime-evidence-'));
  try {
    for (const ref of files) {
      const path = ref.path;
      if (
        typeof path !== 'string' ||
        path.length > 240 ||
        path.includes('\\') ||
        path.split('/').some((x) => !x || ['.', '..', '.git'].includes(x) || x.startsWith('.env'))
      )
        throw new Error('Invalid evidence path.');
      const inside = path.startsWith('scratch/') ? '/' + path : '/source/' + path;
      const captureScript = `const fs=require('fs');const p='/proc/1/root'+process.argv[1];
        let c='/proc/1/root';for(const part of process.argv[1].split('/').filter(Boolean)){c+='/'+part;const s=fs.lstatSync(c);if(s.isSymbolicLink())throw Error('Link denied');}
        const st=fs.lstatSync(p);if(!st.isFile()||st.nlink!==1||st.size>1000000)throw Error('Not bounded regular evidence');process.stdout.write(fs.readFileSync(p));`;
      // Docker cp does not expose tmpfs mounts. A trusted, bounded capture process
      // joins only this frozen workload's PID namespace, never the host namespace.
      // Its ptrace capability permits reading /proc/1/root; no model code runs here.
      const bytes = await docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'SYS_PTRACE',
          '--security-opt',
          'no-new-privileges',
          '--memory',
          '128m',
          '--memory-swap',
          '128m',
          '--cpus',
          '0.5',
          '--pids-limit',
          '16',
          '--pid',
          `container:${r.container}`,
          '--user',
          '0:0',
          '--entrypoint',
          '/usr/bin/timeout',
          r.image,
          '--signal=KILL',
          '15',
          '/usr/local/bin/node',
          '-e',
          captureScript,
          inside,
        ],
        { maxBytes: 1000000 },
      );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      r.sealedFiles[path] = {
        path,
        text,
        sha256: sha(bytes),
        startLine: 1,
        endLine: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        totalLines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        truncated: false,
        nextColumn: null,
      };
    }
    await removeContainer(r);
    await removeImage(r);
    r.state = 'sealed';
    r.sealedAt = Date.now();
    await save(workspace, r);
    return { ...publicRecord(r), receipts: r.receipts, files: r.sealedFiles };
  } catch (error) {
    r.state = 'uncertain';
    r.error = error.message;
    await save(workspace, r);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const prepareVerificationRuntime = (workspace, execution, signal) =>
  exclusive(workspace, async () => {
    try {
      return await prepare(workspace, execution, signal);
    } catch (error) {
      const r = await load(workspace);
      // A readiness failure can downgrade only after this exact attempt's cleanup
      // has been proved. Corrupt/stale identity and transport uncertainty never do.
      if (
        execution.grant.runtime.required !== false ||
        signal?.aborted ||
        !r ||
        r.state !== 'destroyed'
      )
        throw error;
      assertBinding(r, execution);
      r.state = 'unavailable';
      r.availability = 'unavailable';
      r.error = error.message;
      await save(workspace, r);
      return publicRecord(r);
    }
  });
export const runtimeCommand = (workspace, ...args) =>
  exclusive(workspace, () => commandStart(workspace, ...args));
export const runtimeTool = (workspace, ...args) =>
  exclusive(workspace, () => tool(workspace, ...args));
export const runtimeLifecycle = (workspace, ...args) =>
  exclusive(workspace, () => lifecycle(workspace, ...args), args[1] === 'destroy');
