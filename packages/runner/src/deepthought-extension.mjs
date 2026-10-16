import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative } from 'node:path';

export const deepThoughtExtensionManifest = {
  id: 'deepthought',
  kind: 'executor',
  revision: 'sdk-0.2.1a1-adapter-2',
  execution: { location: 'runner', adapter: 'deepthought' },
  tools: [
    {
      id: 'query',
      name: 'code_intelligence',
      description:
        'Read local definitions, SCIP references or witnessed file dependencies. References are not proven calls. Indexes must already exist in the assigned working directory.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['operation'],
        properties: {
          operation: { type: 'string', enum: ['definitions', 'references', 'dependencies'] },
          symbol: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          file: { type: 'string', minLength: 1, maxLength: 500 },
          index: { type: 'string', minLength: 1, maxLength: 500 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        allOf: [
          {
            if: { properties: { operation: { const: 'references' } } },
            then: { properties: { symbol: {} }, required: ['symbol'] },
          },
          {
            if: { properties: { operation: { const: 'dependencies' } } },
            then: { properties: { file: {}, symbol: false }, required: ['file'] },
            else: { properties: { file: false } },
          },
        ],
      },
      approval: 'none',
    },
  ],
};
const expectedHash = createHash('sha256')
  .update(JSON.stringify(deepThoughtExtensionManifest))
  .digest('hex');
const within = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
};
const canonical = (value) =>
  typeof value === 'string' &&
  value.length <= 500 &&
  value.length > 0 &&
  !isAbsolute(value) &&
  !/[\\\x00-\x1f:]/.test(value) &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
function sandboxArgs(prefixes, root) {
  const argv = [
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--symlink',
    'usr/bin',
    '/bin',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
  ];
  for (const prefix of new Set(prefixes))
    if (prefix !== '/usr') argv.push('--ro-bind', prefix, prefix);
  argv.push(...(root ? ['--ro-bind', root, '/work'] : ['--dir', '/work']));
  return [
    ...argv,
    '--chdir',
    '/work',
    '--clearenv',
    '--setenv',
    'PATH',
    environment.PATH,
    '--setenv',
    'LANG',
    environment.LANG,
  ];
}
const bridge = String.raw`
import json, sys, os, stat, tempfile
from pathlib import Path
from deepthought import QueryRequest, analyze_repository, ingest_scip, compose_graph, query_graph
from deepthought import __version__
if __version__!='0.2.1a1':
    raise ValueError('Installed SDK no longer matches the pinned adapter')
a=json.load(sys.stdin)
root=Path('/work')
if 'index' in a:
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
    try:
        parts=a['index'].split('/')
        for part in parts[:-1]:
            next_directory=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory)
            directory=next_directory
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        with os.fdopen(fd,'rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValueError('Index must be a regular file')
            content=handle.read(10000001)
        if len(content)>10000000:
            raise ValueError('Index byte budget exceeded')
        with tempfile.NamedTemporaryFile(dir='/tmp') as captured:
            captured.write(content)
            captured.flush()
            source=ingest_scip(captured.name,repository_id='workspace',max_index_bytes=10000000)
    finally:
        os.close(directory)
else:
    source=analyze_repository(root, repository_id='workspace', max_files=200, max_file_bytes=1000000, max_total_bytes=10000000)
request=QueryRequest(a['operation'], 'workspace', symbol=a.get('symbol'), file=a.get('file'),
    limit=a.get('limit',20), max_output_bytes=a['max_output_bytes'])
print(query_graph(compose_graph([source]), request).to_json())
`;

function runProcess(command, argv, { signal, timeoutMs, maxOutputBytes, input } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('DeepThought query cancelled.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: '/',
      env: environment,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    let size = 0,
      error,
      stderrBytes = 0,
      force;
    const signalGroup = (signal) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (cause) {
        if (cause.code !== 'ESRCH') error ??= cause;
      }
    };
    const stop = (message) => {
      if (error) return;
      error = new Error(message);
      signalGroup('SIGTERM');
      force = setTimeout(() => {
        signalGroup('SIGKILL');
        // An exited leader can leave inherited pipes open in a descendant.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 250);
    };
    const abort = () => stop('DeepThought query cancelled.');
    const timer = setTimeout(() => stop('DeepThought query timed out.'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes)
        stop('DeepThought output limit exceeded; narrow the query or limit.');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 4000) stop('DeepThought error output limit exceeded.');
    });
    child.stdin.on('error', () => {});
    child.once('error', (cause) => {
      error ??= cause;
    });
    child.once('close', (code) => {
      signalGroup('SIGKILL');
      clearTimeout(timer);
      clearTimeout(force);
      signal?.removeEventListener('abort', abort);
      if (error) return reject(error);
      if (code !== 0)
        return reject(
          new Error(
            'DeepThought process failed; verify its separately provisioned SDK and isolated runtime.',
          ),
        );
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    child.stdin.end(input);
  });
}

async function assertRuntimeOutside(python, root) {
  const provisioned = await Promise.all([realpath(python), realpath(dirname(python))]);
  if ([python, ...provisioned].some((path) => within(root, path)))
    throw new Error(
      'DeepThought runtime must be provisioned outside the assigned working directory.',
    );
}

export async function createDeepThoughtAdapter({
  python,
  timeoutMs = 30000,
  maxOutputBytes = 32000,
  signal,
  workingDirectory,
} = {}) {
  if (process.platform !== 'linux' || typeof python !== 'string' || !isAbsolute(python))
    throw new Error('DeepThought requires a provisioned absolute Python path on Linux.');
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 32000
  )
    throw new Error('Invalid DeepThought process limits.');
  accessSync('/usr/bin/bwrap', constants.X_OK);
  let metadata;
  const loadRuntime = async (root, signal) => {
    await assertRuntimeOutside(python, root);
    const probe = await runProcess(
      python,
      [
        '-I',
        '-B',
        '-c',
        "import json,sys; from importlib.metadata import version; import deepthought; print(json.dumps({'version':version('deepthought-analysis-engine'),'prefixes':[sys.prefix,sys.base_prefix]}))",
      ],
      { signal, timeoutMs: 5000, maxOutputBytes: 16000 },
    );
    const checked = JSON.parse(probe);
    if (
      checked.version !== '0.2.1a1' ||
      !Array.isArray(checked.prefixes) ||
      checked.prefixes.some((p) => typeof p !== 'string' || !isAbsolute(p) || p === '/')
    )
      throw new Error('DeepThought adapter requires SDK 0.2.1a1 and bounded runtime prefixes.');
    await runProcess(
      '/usr/bin/bwrap',
      [
        ...sandboxArgs(checked.prefixes),
        '--',
        python,
        '-I',
        '-B',
        '-c',
        "from deepthought import QueryRequest, query_graph; import deepthought,socket,errno; s=socket.socket(); s.settimeout(1)\ntry: s.connect(('192.0.2.1',9))\nexcept OSError as e: assert e.errno in (errno.ENETUNREACH,errno.EHOSTUNREACH)\nelse: raise RuntimeError('Network isolation unavailable')\nassert deepthought.__version__=='0.2.1a1'",
      ],
      { signal, timeoutMs: 5000, maxOutputBytes: 4000 },
    );
    if (checked.prefixes.some((prefix) => within(root, prefix)))
      throw new Error(
        'DeepThought runtime must be provisioned outside the assigned working directory.',
      );
    return checked;
  };
  if (workingDirectory) metadata = await loadRuntime(await realpath(workingDirectory), signal);
  return async ({ extension, tool, args, workingDirectory, signal }) => {
    if (
      extension?.id !== 'deepthought' ||
      extension.revision !== deepThoughtExtensionManifest.revision ||
      extension.hash !== expectedHash ||
      tool !== 'extension.deepthought.query'
    )
      throw new Error(
        'DeepThought extension revision or tool does not match the installed adapter.',
      );
    if (
      !args ||
      Array.isArray(args) ||
      Object.keys(args).some(
        (k) => !['operation', 'symbol', 'index', 'file', 'limit'].includes(k),
      ) ||
      !['definitions', 'references', 'dependencies'].includes(args.operation)
    )
      throw new Error('Invalid DeepThought query.');
    if (
      args.symbol !== undefined &&
      (typeof args.symbol !== 'string' || !args.symbol.trim().length || args.symbol.length > 500)
    )
      throw new Error('Invalid DeepThought symbol.');
    for (const key of ['index', 'file'])
      if (args[key] !== undefined && !canonical(args[key]))
        throw new Error('DeepThought paths must be canonical working-directory-relative paths.');
    if (
      (args.operation === 'references' && !args.symbol) ||
      (args.operation === 'dependencies' && !args.file)
    )
      throw new Error('Reference queries require a symbol; dependencies require a file.');
    if (
      args.limit !== undefined &&
      (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)
    )
      throw new Error('DeepThought limit must be 1-100.');
    if (
      (args.operation === 'dependencies' && args.symbol !== undefined) ||
      (args.operation !== 'dependencies' && args.file !== undefined)
    )
      throw new Error(
        'DeepThought dependencies accept a file; definitions and references accept a symbol.',
      );
    if (signal?.aborted) throw new Error('DeepThought query cancelled.');
    const root = await realpath(workingDirectory);
    await assertRuntimeOutside(python, root);
    metadata ??= await loadRuntime(root, signal);
    if (metadata.prefixes.some((prefix) => within(root, prefix)))
      throw new Error(
        'DeepThought runtime must be provisioned outside the assigned working directory.',
      );
    const argv = [...sandboxArgs(metadata.prefixes, root), '--', python, '-I', '-B', '-c', bridge];
    const output = await runProcess('/usr/bin/bwrap', argv, {
      signal,
      timeoutMs,
      maxOutputBytes,
      input: JSON.stringify({
        ...args,
        // The SDK supports budgets of at least 1024 bytes. Smaller transport
        // limits remain independently enforced by runProcess.
        max_output_bytes: maxOutputBytes >= 1024 ? maxOutputBytes : 32000,
      }),
    });
    try {
      return JSON.parse(output);
    } catch {
      throw new Error('DeepThought returned invalid JSON.');
    }
  };
}

const installed = new Map();
export async function installedDeepThoughtAdapters(signal, workingDirectory) {
  if (signal?.aborted) throw new Error('DeepThought query cancelled.');
  const python = process.env.CONVOY_DEEPTHOUGHT_PYTHON;
  if (!python || !workingDirectory) return {};
  try {
    const root = await realpath(workingDirectory);
    await assertRuntimeOutside(python, root);
    const key = JSON.stringify([python, root]);
    if (!installed.has(key))
      installed.set(
        key,
        await createDeepThoughtAdapter({ python, signal, workingDirectory: root }),
      );
    return { deepthought: installed.get(key) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {}; // A missing/incompatible installation is not advertised.
  }
}
